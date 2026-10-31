#!/usr/bin/env bash
# 마고에듀 통합 클라우드 서버 설치 (Ubuntu, systemd) — 처음 한 번만
#
#   git clone https://github.com/hminkoo10/MagoEdu.git
#   cd MagoEdu/server/deploy
#   sudo ./install.sh
#
# GitHub Actions 자동 배포까지 쓰려면 배포용 계정과 공개 키를 같이 넣어요 (README 의 ‘자동 배포’ 참고):
#   sudo ./install.sh --deploy-user deploy --deploy-key "ssh-ed25519 AAAA... magoedu-deploy"
#
# 그 뒤로는 main 에 올리면 Actions 가 알아서 배포해요. (다시 실행해도 데이터·설정은 그대로)
#   프로그램: /opt/magoedu-cloud
#   데이터:   /var/lib/magoedu-cloud   (백업은 이 폴더만)
#   설정:     /etc/magoedu-cloud.env
set -euo pipefail

APP_DIR=/opt/magoedu-cloud
DATA_DIR=/var/lib/magoedu-cloud
ENV_FILE=/etc/magoedu-cloud.env
SERVICE=magoedu-cloud
DEPLOY_BIN=/usr/local/sbin/magoedu-cloud-deploy
SUDOERS=/etc/sudoers.d/magoedu-cloud-deploy
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEPLOY_USER=""
DEPLOY_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-user) DEPLOY_USER="${2:-}"; shift 2 ;;
    --deploy-key) DEPLOY_KEY="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "관리자 권한이 필요해요: sudo ./install.sh" >&2
  exit 1
fi

# Node.js 22.13 이상
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 없어요. 먼저 설치해 주세요 (README 참고)." >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js 22.13 이상이 필요해요. 지금: $(node -v)" >&2
  exit 1
fi
for cmd in curl tar flock sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd 가 필요해요: sudo apt-get install -y curl tar util-linux coreutils" >&2; exit 1; }
done

# 서버 전용 계정
if ! id magoedu >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin magoedu
fi
install -d -m 750 -o magoedu -g magoedu "$DATA_DIR"

# 프로그램 파일
install -d -m 755 "$APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/deploy"
cp -r "$SRC/src" "$SRC/public" "$SRC/deploy" "$APP_DIR/"
cp "$SRC/package.json" "$SRC/catalog.default.json" "$SRC/.env.example" "$APP_DIR/"
[ -f "$SRC/build.json" ] && cp "$SRC/build.json" "$APP_DIR/"
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"
install -m 755 "$SRC/deploy/deploy.sh" "$DEPLOY_BIN"

# 설정 파일 (처음 한 번만)
if [ ! -f "$ENV_FILE" ]; then
  sed -e "s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#" "$SRC/.env.example" > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  chown root:magoedu "$ENV_FILE"
  echo "설정 파일을 만들었어요: $ENV_FILE"
fi

# 자동 배포용 계정: magoedu-cloud-deploy 만 관리자 권한으로 실행할 수 있게
if [ -n "$DEPLOY_USER" ]; then
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
    echo "배포용 계정을 만들었어요: $DEPLOY_USER"
  fi
  if [ -n "$DEPLOY_KEY" ]; then
    home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
    install -d -m 700 -o "$DEPLOY_USER" -g "$(id -gn "$DEPLOY_USER")" "$home/.ssh"
    touch "$home/.ssh/authorized_keys"
    grep -qxF "$DEPLOY_KEY" "$home/.ssh/authorized_keys" || echo "$DEPLOY_KEY" >> "$home/.ssh/authorized_keys"
    chown "$DEPLOY_USER:$(id -gn "$DEPLOY_USER")" "$home/.ssh/authorized_keys"
    chmod 600 "$home/.ssh/authorized_keys"
    echo "배포용 공개 키를 넣었어요."
  fi
  tmp="$(mktemp)"
  echo "$DEPLOY_USER ALL=(root) NOPASSWD: $DEPLOY_BIN" > "$tmp"
  if visudo -cf "$tmp" >/dev/null; then
    install -m 440 "$tmp" "$SUDOERS"
    echo "$DEPLOY_USER 계정은 $DEPLOY_BIN 만 관리자 권한으로 실행할 수 있어요."
  else
    echo "sudoers 설정을 만들지 못했어요." >&2
  fi
  rm -f "$tmp"
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  install -m 644 "$SRC/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  sleep 2
  systemctl --no-pager --lines=0 status "$SERVICE" || true
else
  echo "systemd 가 없어서 서비스 등록은 건너뛰었어요."
fi

echo
if [ -f "$DATA_DIR/INITIAL_ADMIN_PASSWORD.txt" ]; then
  echo "처음 운영자 계정:"
  sed -n '3,4p' "$DATA_DIR/INITIAL_ADMIN_PASSWORD.txt"
  echo "(처음 로그인하면 비밀번호를 새로 정하고, 이 파일은 자동으로 지워져요)"
fi
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
echo "주소: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8470}"
