#!/usr/bin/env bash
# 마고에듀 통합 클라우드 서버 설치 (Ubuntu) — 처음 한 번만 실행하면 돼요.
#
#   sudo bash install.sh --domain mago.milky.kr --setup-deploy
#
#   --domain 주소     HTTPS 로 열기 (Caddy 를 설치하고 인증서를 알아서 받아요)
#   --setup-deploy    GitHub Actions 자동 배포 준비: 배포용 계정과 키를 만들고,
#                     GitHub 에 넣을 값(DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS)을 화면에 보여 줘요
#   --deploy-user 이름  배포용 계정 이름 (기본 deploy)
#   --deploy-key "공개 키"  직접 만든 키를 쓰고 싶을 때 (이때는 키를 만들지 않아요)
#
# 다시 실행해도 데이터·설정은 그대로예요. 그 뒤의 업데이트는 GitHub Actions 가 자동으로 해요.
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
KEY_FILE=/root/magoedu-deploy-key
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOMAIN=""
SETUP_DEPLOY=0
DEPLOY_USER="deploy"
DEPLOY_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --setup-deploy) SETUP_DEPLOY=1; shift ;;
    --deploy-user) DEPLOY_USER="${2:-}"; SETUP_DEPLOY=1; shift 2 ;;
    --deploy-key) DEPLOY_KEY="${2:-}"; SETUP_DEPLOY=1; shift 2 ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $1  (도움말: bash install.sh --help)" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "관리자 권한이 필요해요. 앞에 sudo 를 붙여 주세요: sudo bash $0 $*" >&2
  exit 1
fi
if [ ! -f "$SRC/src/index.js" ]; then
  echo "서버 파일을 찾지 못했어요 ($SRC). 저장소의 server/deploy/install.sh 를 실행해 주세요." >&2
  exit 1
fi

# ---------------------------------------------------------------- 필요한 것
step "필요한 프로그램 확인"
export DEBIAN_FRONTEND=noninteractive
need_apt=()
for pkg in curl tar; do command -v "$pkg" >/dev/null 2>&1 || need_apt+=("$pkg"); done
command -v flock >/dev/null 2>&1 || need_apt+=(util-linux)
if [ "${#need_apt[@]}" -gt 0 ]; then
  apt-get update -qq && apt-get install -y -qq "${need_apt[@]}"
fi
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  info "Node.js 22 를 설치해요 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node_ok || { echo "Node.js 22.13 이상을 설치하지 못했어요. 지금: $(node -v 2>/dev/null || echo 없음)" >&2; exit 1; }
info "Node.js $(node -v)"

# ---------------------------------------------------------------- 서버 설치
step "서버 설치"
if ! id magoedu >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin magoedu
fi
install -d -m 750 -o magoedu -g magoedu "$DATA_DIR"
install -d -m 755 "$APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/deploy" "$APP_DIR/web"
cp -r "$SRC/src" "$SRC/public" "$SRC/deploy" "$APP_DIR/"
# 웹 화면: 배포본이면 web/, 저장소에서 설치하면 launcher/src/renderer
if [ -f "$SRC/web/index.html" ]; then
  cp -r "$SRC/web" "$APP_DIR/web"
elif [ -f "$SRC/../launcher/src/renderer/index.html" ]; then
  cp -r "$SRC/../launcher/src/renderer" "$APP_DIR/web"
fi
cp "$SRC/package.json" "$SRC/catalog.default.json" "$SRC/.env.example" "$APP_DIR/"
if [ -f "$SRC/build.json" ]; then cp "$SRC/build.json" "$APP_DIR/"; fi
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"
install -m 755 "$SRC/deploy/deploy.sh" "$DEPLOY_BIN"
info "프로그램: $APP_DIR · 데이터: $DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  sed -e "s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#" "$SRC/.env.example" > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  chown root:magoedu "$ENV_FILE"
  info "설정 파일: $ENV_FILE"
fi

PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '"' || true)"
PORT="${PORT:-8470}"

set_env() { # 설정 파일의 값 바꾸기 (없으면 추가)
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

# ---------------------------------------------------------------- HTTPS (Caddy)
if [ -n "$DOMAIN" ]; then
  step "HTTPS 설정 (https://$DOMAIN)"
  if ! command -v caddy >/dev/null 2>&1; then
    info "Caddy 를 설치해요"
    apt-get update -qq >/dev/null 2>&1 || true
    if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy
    fi
  fi
  CADDYFILE=/etc/caddy/Caddyfile
  BLOCK="$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}"
  if [ ! -f "$CADDYFILE" ] || grep -q '/usr/share/caddy' "$CADDYFILE"; then
    # 설치할 때 들어 있던 기본 화면 설정은 바꿔 씀
    [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak"
    printf '# 마고에듀 통합 클라우드\n%s\n' "$BLOCK" > "$CADDYFILE"
  elif ! grep -qF "$DOMAIN {" "$CADDYFILE"; then
    cp "$CADDYFILE" "$CADDYFILE.bak"
    printf '\n# 마고에듀 통합 클라우드\n%s\n' "$BLOCK" >> "$CADDYFILE"
  fi
  set_env HOST 127.0.0.1
  set_env TRUST_PROXY 1
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow OpenSSH >/dev/null
    info "방화벽(ufw)에서 80, 443, SSH 를 열었어요"
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  info "DNS 에서 $DOMAIN 의 A 레코드가 이 서버 IP 를 가리키면 인증서가 자동으로 붙어요."
fi

# ---------------------------------------------------------------- 서비스 켜기
step "서버 켜기"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  install -m 644 "$SRC/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  for _ in $(seq 1 20); do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/api/meta" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/meta" >/dev/null 2>&1; then
    info "서버가 켜졌어요 (컴퓨터를 켜면 자동으로 켜져요)"
  else
    info "서버가 아직 켜지지 않았어요. 확인: journalctl -u $SERVICE -n 50"
  fi
else
  info "systemd 가 없어서 서비스 등록은 건너뛰었어요."
fi

# ---------------------------------------------------------------- 자동 배포 준비
SECRET_KEY=""
if [ "$SETUP_DEPLOY" = 1 ]; then
  step "자동 배포 준비 (계정: $DEPLOY_USER)"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
    info "배포용 계정을 만들었어요: $DEPLOY_USER"
  fi
  if [ -z "$DEPLOY_KEY" ]; then
    if [ ! -f "$KEY_FILE" ]; then
      ssh-keygen -q -t ed25519 -N "" -C "magoedu-deploy" -f "$KEY_FILE"
      chmod 600 "$KEY_FILE"
    fi
    DEPLOY_KEY="$(cat "$KEY_FILE.pub")"
    SECRET_KEY="$(cat "$KEY_FILE")"
  fi
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  group="$(id -gn "$DEPLOY_USER")"
  install -d -m 700 -o "$DEPLOY_USER" -g "$group" "$home/.ssh"
  touch "$home/.ssh/authorized_keys"
  grep -qxF "$DEPLOY_KEY" "$home/.ssh/authorized_keys" || echo "$DEPLOY_KEY" >> "$home/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$group" "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"
  tmp="$(mktemp)"
  echo "$DEPLOY_USER ALL=(root) NOPASSWD: $DEPLOY_BIN" > "$tmp"
  if visudo -cf "$tmp" >/dev/null; then
    install -m 440 "$tmp" "$SUDOERS"
  else
    echo "sudoers 설정을 만들지 못했어요." >&2
  fi
  rm -f "$tmp"
  info "$DEPLOY_USER 계정은 서버 배포 명령 하나만 관리자 권한으로 실행할 수 있어요."
fi

# ---------------------------------------------------------------- 정리해서 보여 주기
echo
echo "==================================================================="
echo " 마고에듀 통합 클라우드 서버 설치 완료"
echo "==================================================================="
if [ -n "$DOMAIN" ]; then
  echo " 주소: https://$DOMAIN"
else
  echo " 주소: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
fi
if [ -f "$DATA_DIR/INITIAL_ADMIN_PASSWORD.txt" ]; then
  echo
  echo " 처음 운영자 계정 (처음 로그인하면 비밀번호를 새로 정해요)"
  sed -n '3,4p' "$DATA_DIR/INITIAL_ADMIN_PASSWORD.txt" | sed 's/^/   /'
fi

if [ "$SETUP_DEPLOY" = 1 ]; then
  ssh_port="$( (sshd -T 2>/dev/null || true) | awk '$1=="port"{print $2; exit}')"
  ssh_port="${ssh_port:-22}"
  host="${DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
  [ "$ssh_port" = 22 ] && kh_host="$host" || kh_host="[$host]:$ssh_port"
  echo
  echo "-------------------------------------------------------------------"
  echo " GitHub 자동 배포 설정"
  echo " GitHub 의 MagoEdu 저장소 → Settings → Secrets and variables → Actions"
  echo " → New repository secret 으로 아래 값을 넣어 주세요."
  echo "-------------------------------------------------------------------"
  if [ -n "$SECRET_KEY" ]; then
    echo
    echo " ① 이름: DEPLOY_SSH_KEY   (GitHub 가 이 서버에 들어올 때 쓰는 열쇠)"
    echo "    값: 아래 BEGIN 줄부터 END 줄까지 전부"
    echo
    echo "$SECRET_KEY"
  fi
  echo
  echo " ② 이름: DEPLOY_KNOWN_HOSTS   (GitHub 가 ‘진짜 이 서버가 맞는지’ 확인하는 지문)"
  echo "    값: 아래 줄 전부"
  echo
  for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
    [ -f "$f" ] && echo "$kh_host $(awk '{print $1" "$2}' "$f")"
  done
  if [ "$host" != "mago.milky.kr" ]; then
    echo
    echo " ③ 이름: DEPLOY_HOST   값: $host"
  fi
  if [ "$ssh_port" != 22 ]; then
    echo " ④ 이름: DEPLOY_PORT   값: $ssh_port"
  fi
  if [ -n "$SECRET_KEY" ]; then
    echo
    echo " 위 열쇠는 $KEY_FILE 에도 있어요. GitHub 에 넣은 뒤에는 지워도 돼요:"
    echo "   sudo rm $KEY_FILE $KEY_FILE.pub"
  fi
fi
echo
