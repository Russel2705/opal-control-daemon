#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/opal-control-daemon"
APP_USER="opal"
APP_GROUP="opal"

ENV_FILE="/etc/opal-daemon.env"
DB_DIR="/var/lib/opal-daemon"
DB_PATH="$DB_DIR/app.db"

PASS_MGR="/usr/local/bin/zivpn-passwd-manager"
SUDOERS_FILE="/etc/sudoers.d/opal-daemon"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"

NGINX_SITE="/etc/nginx/sites-available/opal-daemon"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/opal-daemon"

ask_env_if_missing() {
  if [[ -f "$ENV_FILE" ]]; then
    echo "==> Env sudah ada: $ENV_FILE (skip input)"
    return
  fi

  echo "==> Setup awal (env akan dibuat otomatis)."
  echo "Pilih mode:"
  echo "1) PAID  (saldo + TopUp Pakasir + webhook)"
  echo "2) FREE  (tanpa payment, tanpa saldo/topup)"
  read -rp "Pilih (1/2) [1]: " opt
  opt="${opt:-1}"
  MODE="paid"
  [[ "$opt" == "2" ]] && MODE="free"

  read -rp "Domain/Host (contoh id.xstrore1.cloud): " ZIVPN_HOST

  read -rp "Nama Server (contoh 🟦 🇲🇨ID SERVER): " SERVER_TITLE
  read -rp "Quota GB [150]: " QUOTA_GB; QUOTA_GB="${QUOTA_GB:-150}"
  read -rp "IP Limit [2]: " IP_LIMIT; IP_LIMIT="${IP_LIMIT:-2}"
  read -rp "MAX_ACTIVE slot [20]: " MAX_ACTIVE; MAX_ACTIVE="${MAX_ACTIVE:-20}"

  read -rp "ADMIN_ID Telegram (angka) [0]: " ADMIN_ID; ADMIN_ID="${ADMIN_ID:-0}"
  read -s -p "BOT_TOKEN: " BOT_TOKEN; echo

  # FREE access control
  FREE_ACCESS="public"
  FREE_REQUIRE_CHANNEL=""
  if [[ "$MODE" == "free" ]]; then
    echo "FREE akses:"
    echo "1) Public (semua bisa pakai)"
    echo "2) Private (hanya allowlist)"
    read -rp "Pilih (1/2) [1]: " fa
    fa="${fa:-1}"
    [[ "$fa" == "2" ]] && FREE_ACCESS="private"

    read -rp "Wajib join channel? isi @channel atau kosong: " FREE_REQUIRE_CHANNEL
  fi

  CERT_EMAIL=""
  PRICE_1=0; PRICE_14=0; PRICE_30=0
  DISPLAY_PRICE_PER_DAY=0; DISPLAY_PRICE_PER_MONTH=0
  PAKASIR_SLUG=""; PAKASIR_API_KEY=""

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
  fi

  cat > "$ENV_FILE" <<EOF
MODE=$MODE
CERT_EMAIL=$CERT_EMAIL

BOT_TOKEN=$BOT_TOKEN
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

TZ=Asia/Jakarta
NODE_ENV=production
EOF

  chmod 600 "$ENV_FILE"
  echo "==> Env dibuat: $ENV_FILE"
}

get_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true
}

echo "==> Install packages"
apt update -y
apt install -y curl git jq ca-certificates

echo "==> Install Node.js"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "==> Create service user"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --system --group "$APP_USER"
fi

echo "==> Ensure directories"
mkdir -p "$DB_DIR"
chown -R "$APP_USER:$APP_GROUP" "$DB_DIR"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR" || true

ask_env_if_missing

MODE="$(get_env MODE)"
MODE="${MODE:-paid}"
MODE="$(echo "$MODE" | tr '[:upper:]' '[:lower:]')"
DOMAIN="$(get_env ZIVPN_HOST)"
CERT_EMAIL="$(get_env CERT_EMAIL)"

if [[ "$MODE" == "paid" ]]; then
  apt install -y nginx certbot python3-certbot-nginx
fi

echo "==> (Optional) Install ZiVPN core (zahidbd2/udp-zivpn) if missing"
if ! systemctl list-unit-files | grep -q '^zivpn\.service'; then
  arch="$(uname -m)"
  if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
    wget -q -O /tmp/zi.sh https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi.sh
    chmod +x /tmp/zi.sh
    /tmp/zi.sh
  else
    bash <(curl -fsSL https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi2.sh)
  fi
fi

echo "==> Detect password field key in /etc/zivpn/config.json"
KEY="config"
if [[ -f /etc/zivpn/config.json ]]; then
  if jq -e 'has("config")' /etc/zivpn/config.json >/dev/null 2>&1; then
    KEY="config"
  elif jq -e 'has("password")' /etc/zivpn/config.json >/dev/null 2>&1; then
    KEY="password"
  elif jq -e 'has("pass")' /etc/zivpn/config.json >/dev/null 2>&1; then
    KEY="pass"
  fi
fi
mkdir -p /etc/zivpn
echo "$KEY" > /etc/zivpn/password_field
chmod 600 /etc/zivpn/password_field

echo "==> Install password manager"
install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" "$PASS_MGR"

echo "==> Restrict sudo for password manager"
cat > "$SUDOERS_FILE" <<EOF
$APP_USER ALL=(root) NOPASSWD: $PASS_MGR
EOF
chmod 440 "$SUDOERS_FILE"

echo "==> Install Node dependencies"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "==> Install systemd service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Opal Control Daemon (Node.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now opal-daemon

if [[ "$MODE" == "paid" ]]; then
  if [[ -z "${CERT_EMAIL:-}" ]]; then
    echo "ERROR: MODE=paid tapi CERT_EMAIL kosong"
    exit 1
  fi

  echo "==> Configure Nginx for webhook"
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

  echo "✅ PAID siap. Webhook: https://$DOMAIN/pakasir/webhook"
else
  echo "✅ FREE siap. Akses: $(get_env FREE_ACCESS)"
fi

echo "Cek: systemctl status opal-daemon"
echo "Log: journalctl -u opal-daemon -f"