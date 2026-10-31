#!/usr/bin/env bash
# 마고에듀 통합 클라우드 서버 설치·업데이트 (리눅스, systemd)
#
#   git clone https://github.com/hminkoo10/MagoEdu.git
#   cd MagoEdu/server/deploy
#   sudo ./install.sh
#
# 다시 실행하면 업데이트예요: 프로그램 파일만 바꾸고 서버를 다시 켜요. 데이터와 설정은 그대로 남아요.
#   프로그램: /opt/magoedu-cloud
#   데이터:   /var/lib/magoedu-cloud   (백업은 이 폴더만)
#   설정:     /etc/magoedu-cloud.env
set -euo pipefail

APP_DIR=/opt/magoedu-cloud
DATA_DIR=/var/lib/magoedu-cloud
ENV_FILE=/etc/magoedu-cloud.env
SERVICE=magoedu-cloud
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

# 서버 전용 계정
if ! id magoedu >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin magoedu
fi
install -d -m 750 -o magoedu -g magoedu "$DATA_DIR"

# 프로그램 파일
install -d -m 755 "$APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public"
cp -r "$SRC/src" "$SRC/public" "$APP_DIR/"
cp "$SRC/package.json" "$SRC/catalog.default.json" "$APP_DIR/"
chown -R root:root "$APP_DIR"

# 설정 파일 (처음 한 번만)
if [ ! -f "$ENV_FILE" ]; then
  sed -e "s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#" "$SRC/.env.example" > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  chown root:magoedu "$ENV_FILE"
  echo "설정 파일을 만들었어요: $ENV_FILE"
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  install -m 644 "$SRC/deploy/magoedu-cloud.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  sleep 2
  systemctl --no-pager --lines=0 status "$SERVICE" || true
else
  echo "systemd 가 없어서 서비스 등록은 건너뛰었어요. 직접 켜기:"
  echo "  sudo -u magoedu env \$(grep -v '^#' $ENV_FILE | xargs) node --disable-warning=ExperimentalWarning $APP_DIR/src/index.js"
fi

echo
if [ -f "$DATA_DIR/INITIAL_ADMIN_PASSWORD.txt" ]; then
  echo "처음 운영자 계정:"
  sed -n '3,4p' "$DATA_DIR/INITIAL_ADMIN_PASSWORD.txt"
  echo "(처음 로그인하면 비밀번호를 새로 정하고, 이 파일은 자동으로 지워져요)"
fi
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
echo "주소: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-8470}"
