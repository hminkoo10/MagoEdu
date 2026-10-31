#!/usr/bin/env bash
# 마고에듀 통합 클라우드 서버 - 새 버전 적용 (GitHub Actions 자동 배포가 SSH 로 실행)
#
#   sudo magoedu-cloud-deploy <배포본.tar.gz> [sha256]
#
# 1) 배포본 확인(SHA-256, 파일, 문법)  2) DB 백업  3) 프로그램 폴더 교체  4) 서버 다시 켜기
# 5) 새 버전이 제대로 켜졌는지 확인 — 안 되면 바로 예전 버전으로 되돌리고 실패로 끝낸다.
# 데이터(/var/lib/magoedu-cloud)와 설정(/etc/magoedu-cloud.env)은 건드리지 않는다.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/magoedu-cloud}"
DATA_DIR="${DATA_DIR:-/var/lib/magoedu-cloud}"
ENV_FILE="${ENV_FILE:-/etc/magoedu-cloud.env}"
SERVICE="${SERVICE:-magoedu-cloud}"
SERVICE_USER="${SERVICE_USER:-magoedu}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
DEPLOY_BIN="${DEPLOY_BIN:-/usr/local/sbin/magoedu-cloud-deploy}"
LOCK_FILE="${LOCK_FILE:-/run/lock/magoedu-cloud-deploy.lock}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-40}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

say() { echo "[배포] $*"; }
fail() { echo "[배포] 실패: $*" >&2; exit 1; }

TARBALL="${1:-}"
WANT_SHA="${2:-}"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || fail "배포본 파일이 없어요: ${TARBALL:-(없음)}"
command -v node >/dev/null || fail "node 가 없어요."
[ -f "$APP_DIR/package.json" ] || fail "$APP_DIR 에 서버가 설치되어 있지 않아요. 먼저 install.sh 를 실행해 주세요."

# 한 번에 하나만
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -w 120 9 || fail "다른 배포가 진행 중이에요."

# ---------------------------------------------------------------- 1) 확인
if [ -n "$WANT_SHA" ]; then
  GOT_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
  [ "$GOT_SHA" = "$WANT_SHA" ] || fail "배포본이 올리던 중 바뀌었어요 (SHA-256 불일치)."
fi

NEW_DIR="${APP_DIR}.new"
PREV_DIR="${APP_DIR}.prev"
rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
tar -xzf "$TARBALL" -C "$NEW_DIR" --strip-components=1 --no-same-owner
for f in package.json src/index.js src/app.js; do
  [ -f "$NEW_DIR/$f" ] || { rm -rf "$NEW_DIR"; fail "배포본에 $f 가 없어요."; }
done
while IFS= read -r -d '' js; do
  node --check "$js" || { rm -rf "$NEW_DIR"; fail "문법 오류: ${js#"$NEW_DIR"/}"; }
done < <(find "$NEW_DIR/src" -name '*.js' -print0)
chown -R root:root "$NEW_DIR" 2>/dev/null || true
chmod -R u=rwX,go=rX "$NEW_DIR"

OLD_VER="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo '?')"
NEW_VER="$(node -p "require('$NEW_DIR/package.json').version")"
NEW_BUILD="$(node -p "try { require('$NEW_DIR/build.json').commit || '' } catch { '' }")"
say "지금 $OLD_VER → 새 버전 $NEW_VER ${NEW_BUILD:+(${NEW_BUILD:0:7})}"

# ---------------------------------------------------------------- 2) DB 백업 (켜져 있어도 안전한 VACUUM INTO)
if [ -f "$DATA_DIR/magoedu.db" ]; then
  mkdir -p "$DATA_DIR/backups"
  BACKUP="$DATA_DIR/backups/magoedu-$(date +%Y%m%d-%H%M%S)-v$OLD_VER.db"
  node --disable-warning=ExperimentalWarning -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    db.prepare('VACUUM INTO ?').run(process.argv[2]);
    db.close();
  " "$DATA_DIR/magoedu.db" "$BACKUP" || fail "DB 백업에 실패해서 멈췄어요."
  if id "$SERVICE_USER" >/dev/null 2>&1; then chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/backups"; fi
  chmod 600 "$BACKUP"
  # 오래된 백업 정리
  ls -1t "$DATA_DIR"/backups/magoedu-*.db 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
  say "DB 백업: $BACKUP"
fi

# ---------------------------------------------------------------- 3) 교체
rm -rf "$PREV_DIR"
mv "$APP_DIR" "$PREV_DIR"
mv "$NEW_DIR" "$APP_DIR"

UNITS_CHANGED=0
if [ -d "$SYSTEMD_DIR" ] && [ -f "$APP_DIR/deploy/$SERVICE.service" ]; then
  if ! cmp -s "$APP_DIR/deploy/$SERVICE.service" "$SYSTEMD_DIR/$SERVICE.service"; then
    install -m 644 "$APP_DIR/deploy/$SERVICE.service" "$SYSTEMD_DIR/$SERVICE.service"
    UNITS_CHANGED=1
  fi
fi
[ "$UNITS_CHANGED" = 1 ] && "$SYSTEMCTL" daemon-reload 9>&-

# ---------------------------------------------------------------- 4) 다시 켜기 + 5) 확인
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'" || true; }
PORT="$(envval PORT)"
HOST="$(envval HOST)"
case "${HOST:-0.0.0.0}" in 0.0.0.0 | :: | "") HOST=127.0.0.1 ;; esac
HEALTH_URL="${HEALTH_URL:-http://$HOST:${PORT:-8470}/api/meta}"

healthy() {
  local i body
  for ((i = 0; i < HEALTH_TIMEOUT; i++)); do
    body="$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null || true)"
    if [ -n "$body" ] && node -e "
      const m = JSON.parse(process.argv[1]);
      const ok = m.version === process.argv[2] && (!process.argv[3] || (m.build && m.build.commit === process.argv[3]));
      process.exit(ok ? 0 : 1);
    " "$body" "$1" "$2" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

say "서버를 다시 켜요"
"$SYSTEMCTL" restart "$SERVICE" 9>&- || true
if healthy "$NEW_VER" "$NEW_BUILD"; then
  # 다음 배포 때 쓸 수 있게 이 스크립트도 새 버전으로
  if [ -f "$APP_DIR/deploy/deploy.sh" ] && [ -d "$(dirname "$DEPLOY_BIN")" ]; then
    install -m 755 "$APP_DIR/deploy/deploy.sh" "$DEPLOY_BIN"
  fi
  say "완료: $NEW_VER ${NEW_BUILD:+(${NEW_BUILD:0:7}) }정상 동작 중"
  exit 0
fi

# ---------------------------------------------------------------- 되돌리기
echo "[배포] 새 버전이 제대로 켜지지 않아 예전 버전($OLD_VER)으로 되돌려요." >&2
if command -v journalctl >/dev/null 2>&1 && [ "$SYSTEMCTL" = systemctl ]; then
  journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
fi
rm -rf "${APP_DIR}.failed"
mv "$APP_DIR" "${APP_DIR}.failed"
mv "$PREV_DIR" "$APP_DIR"
if [ "$UNITS_CHANGED" = 1 ] && [ -f "$APP_DIR/deploy/$SERVICE.service" ]; then
  install -m 644 "$APP_DIR/deploy/$SERVICE.service" "$SYSTEMD_DIR/$SERVICE.service"
  "$SYSTEMCTL" daemon-reload 9>&-
fi
"$SYSTEMCTL" restart "$SERVICE" 9>&- || true
if healthy "$OLD_VER" ""; then
  fail "새 버전 $NEW_VER 이(가) 켜지지 않아 예전 버전 $OLD_VER 으로 되돌렸어요. (실패한 파일: ${APP_DIR}.failed)"
fi
fail "되돌린 예전 버전도 켜지지 않아요. 서버를 직접 확인해 주세요: systemctl status $SERVICE"
