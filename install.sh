#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/opal-control-daemon"
ENV_FILE="/etc/opal-daemon.env"
DB_DIR="/var/lib/opal-daemon"
DB_PATH="$DB_DIR/app.db"

PASS_MGR="/usr/local/bin/zivpn-passwd-manager"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"
NGINX_SITE="/etc/nginx/sites-available/opal-daemon"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/opal-daemon"

echo "==> Install base packages"
apt update -y
apt install -y curl git jq ca-certificates build-essential python3 make g++

echo "==> Install Node.js 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

mkdir -p "$DB_DIR"
chmod 755 "$DB_DIR"

ask_env_if_missing() {
  if [[ -f "$ENV_FILE" ]]; then
    echo "==> Env exists: $ENV_FILE (skip input)"
    return
  fi

  echo "Pilih mode:"
  echo "1) PAID  (saldo + TopUp Pakasir + webhook)"
  echo "2) FREE  (tanpa payment, tanpa saldo/topup)"
  read -rp "Pilih (1/2) [1]: " opt
  opt="${opt:-1}"
  MODE="paid"
  [[ "$opt" == "2" ]] && MODE="free"

  read -rp "Domain/Host ZiVPN (contoh id.xstrore1.cloud): " ZIVPN_HOST

  read -rp "Nama Server (contoh 🟦 🇲🇨ID SERVER): " SERVER_TITLE
  read -rp "Quota GB [150]: " QUOTA_GB; QUOTA_GB="${QUOTA_GB:-150}"
  read -rp "IP Limit [2]: " IP_LIMIT; IP_LIMIT="${IP_LIMIT:-2}"
  read -rp "MAX_ACTIVE slot [20]: " MAX_ACTIVE; MAX_ACTIVE="${MAX_ACTIVE:-20}"

  echo "OWNER/ADMIN:"
  read -rp "OWNER_ID Telegram (angka) [0]: " OWNER_ID; OWNER_ID="${OWNER_ID:-0}"
  read -rp "ADMIN_IDS (pisah koma) [0]: " ADMIN_IDS; ADMIN_IDS="${ADMIN_IDS:-0}"

  read -rp "ADMIN_ID lama (opsional) [0]: " ADMIN_ID; ADMIN_ID="${ADMIN_ID:-0}"
  read -s -p "BOT_TOKEN: " BOT_TOKEN; echo

  FREE_ACCESS="public"
  FREE_REQUIRE_CHANNEL=""
  if [[ "$MODE" == "free" ]]; then
    echo "FREE akses:"
    echo "1) Public"
    echo "2) Private (allowlist)"
    read -rp "Pilih (1/2) [1]: " fa
    fa="${fa:-1}"
    [[ "$fa" == "2" ]] && FREE_ACCESS="private"
    read -rp "Wajib join channel? isi @channel atau kosong: " FREE_REQUIRE_CHANNEL
  fi

  CERT_EMAIL=""
  PRICE_1=0; PRICE_14=0; PRICE_30=0
  DISPLAY_PRICE_PER_DAY=0; DISPLAY_PRICE_PER_MONTH=0
  PAKASIR_SLUG=""; PAKASIR_API_KEY=""

  TRIAL_ENABLED="true"
  TRIAL_DAYS=1
  TRIAL_ONCE_PER_USER="true"
  TRIAL_PASSWORD_MODE="auto"
  TRIAL_PREFIX="TR"
  TRIAL_MAX_DAILY=50

  if [[ "$MODE" == "paid" ]]; then
    read -rp "CERT_EMAIL (Let's Encrypt): " CERT_EMAIL
    read -rp "Harga paket 1 hari (Rp): " PRICE_1
    read -rp "Harga paket 14 hari (Rp): " PRICE_14
    read -rp "Harga paket 30 hari (Rp): " PRICE_30

    read -rp "Tampilan Harga/Hari (Rp) [0=ikut paket 1 hari]: " DISPLAY_PRICE_PER_DAY
    DISPLAY_PRICE_PER_DAY="${DISPLAY_PRICE_PER_DAY:-0}"
    read -rp "Tampilan Harga/Bulan (Rp) [0=ikut paket 30 hari]: " DISPLAY_PRICE_PER_MONTH
    DISPLAY_PRICE_PER_MONTH="${DISPLAY_PRICE_PER_MONTH:-0}"

    read -rp "PAKASIR_SLUG: " PAKASIR_SLUG
    read -s -p "PAKASIR_API_KEY: " PAKASIR_API_KEY; echo

    echo "Trial:"
    read -rp "TRIAL_ENABLED (true/false) [true]: " TRIAL_ENABLED; TRIAL_ENABLED="${TRIAL_ENABLED:-true}"
    read -rp "TRIAL_DAYS [1]: " TRIAL_DAYS; TRIAL_DAYS="${TRIAL_DAYS:-1}"
    read -rp "TRIAL_MAX_DAILY [50]: " TRIAL_MAX_DAILY; TRIAL_MAX_DAILY="${TRIAL_MAX_DAILY:-50}"
  fi

  cat > "$ENV_FILE" <<EOF
MODE=$MODE

BOT_TOKEN=$BOT_TOKEN
OWNER_ID=$OWNER_ID
ADMIN_IDS=$ADMIN_IDS
ADMIN_ID=$ADMIN_ID

DB_PATH=$DB_PATH

ZIVPN_HOST=$ZIVPN_HOST
MAX_ACTIVE=$MAX_ACTIVE

SERVER_TITLE=$SERVER_TITLE
QUOTA_GB=$QUOTA_GB
IP_LIMIT=$IP_LIMIT
DISPLAY_PRICE_PER_DAY=$DISPLAY_PRICE_PER_DAY
DISPLAY_PRICE_PER_MONTH=$DISPLAY_PRICE_PER_MONTH

FREE_ACCESS=$FREE_ACCESS
FREE_REQUIRE_CHANNEL=$FREE_REQUIRE_CHANNEL

PRICE_1=$PRICE_1
PRICE_14=$PRICE_14
PRICE_30=$PRICE_30

PAKASIR_SLUG=$PAKASIR_SLUG
PAKASIR_API_KEY=$PAKASIR_API_KEY
WEBHOOK_PATH=/pakasir/webhook
PORT=9000

CERT_EMAIL=$CERT_EMAIL

TRIAL_ENABLED=$TRIAL_ENABLED
TRIAL_DAYS=$TRIAL_DAYS
TRIAL_ONCE_PER_USER=$TRIAL_ONCE_PER_USER
TRIAL_PASSWORD_MODE=$TRIAL_PASSWORD_MODE
TRIAL_PREFIX=$TRIAL_PREFIX
TRIAL_MAX_DAILY=$TRIAL_MAX_DAILY

TZ=Asia/Jakarta
NODE_ENV=production
EOF

  chmod 600 "$ENV_FILE"
  echo "==> Env created: $ENV_FILE"
}

get_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true
}

ask_env_if_missing

MODE="$(get_env MODE)"; MODE="${MODE:-paid}"
MODE="$(echo "$MODE" | tr '[:upper:]' '[:lower:]')"

DOMAIN="$(get_env ZIVPN_HOST)"
CERT_EMAIL="$(get_env CERT_EMAIL)"

echo "==> Ensure ZiVPN exists (zahidbd2/udp-zivpn)"
if ! systemctl list-unit-files | grep -q '^zivpn\.service'; then
  echo "==> Installing udp-zivpn..."
  wget -q -O /tmp/zi.sh https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi.sh || true
  if [[ -f /tmp/zi.sh ]]; then
    chmod +x /tmp/zi.sh
    /tmp/zi.sh
  else
    bash <(curl -fsSL https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi2.sh)
  fi
fi

echo "==> Check /etc/zivpn/config.json has auth.config"
if [[ ! -f /etc/zivpn/config.json ]]; then
  echo "ERROR: /etc/zivpn/config.json not found"
  exit 1
fi

if ! jq -e '.auth.config and (.auth.config|type=="array")' /etc/zivpn/config.json >/dev/null 2>&1; then
  echo "ERROR: /etc/zivpn/config.json does not contain auth.config as array"
  echo "Silakan cek format config zivpn dulu."
  exit 1
fi

echo "==> Install password manager"
install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" "$PASS_MGR"

echo "==> Install Node dependencies"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Install systemd service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Opal Control Daemon (Node.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now opal-daemon

if [[ "$MODE" == "paid" ]]; then
  echo "==> Install Nginx + Certbot"
  apt install -y nginx certbot python3-certbot-nginx

  if [[ -z "${CERT_EMAIL:-}" ]]; then
    echo "ERROR: MODE=paid but CERT_EMAIL empty"
    exit 1
  fi

  echo "==> Configure Nginx for Pakasir webhook"
  cat > "$NGINX_SITE" <<EOF
server {
  listen 80;
  server_name $DOMAIN;

  location /pakasir/webhook {
    proxy_pass http://127.0.0.1:9000/pakasir/webhook;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  }
}
EOF

  ln -sf "$NGINX_SITE" "$NGINX_SITE_ENABLED"
  nginx -t
  systemctl reload nginx

  echo "==> Issue SSL certificate"
  certbot --nginx -d "$DOMAIN" -m "$CERT_EMAIL" --agree-tos --no-eff-email -n

  echo "✅ PAID ready. Webhook: https://$DOMAIN/pakasir/webhook"
else
  echo "✅ FREE ready. Access: $(get_env FREE_ACCESS)"
fi

echo "Cek: systemctl status opal-daemon"
echo "Log: journalctl -u opal-daemon -f"
