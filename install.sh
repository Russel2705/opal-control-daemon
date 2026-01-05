#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/opal-zivpn-bot"
ENV_FILE="/etc/opal-daemon.env"
DB_DIR="/var/lib/opal-daemon"
PASS_MGR="/usr/local/bin/zivpn-passwd-manager"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"

apt update -y
apt install -y curl git jq ca-certificates build-essential python3 make g++

# Node 20
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

mkdir -p "$DB_DIR"
chmod 755 "$DB_DIR"

# Clone/update repo (kalau user jalankan install.sh dari repo, biasanya sudah ada)
if [[ ! -d "$APP_DIR" ]]; then
  echo "ERROR: $APP_DIR tidak ada. Clone dulu repo ke /opt/opal-zivpn-bot"
  exit 1
fi

# Buat env jika belum ada
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Pilih mode:"
  echo "1) PAID (TopUp Pakasir + QRIS)"
  echo "2) FREE (tanpa payment)"
  read -rp "Pilih (1/2) [1]: " opt
  opt="${opt:-1}"
  MODE="paid"
  [[ "$opt" == "2" ]] && MODE="free"

  read -s -p "BOT_TOKEN: " BOT_TOKEN; echo
  read -rp "OWNER_ID (telegram id angka): " OWNER_ID
  read -rp "ADMIN_IDS (pisah koma, boleh sama dengan owner): " ADMIN_IDS

  PAKASIR_SLUG=""
  PAKASIR_API_KEY=""
  WEBHOOK_TOKEN=""

  if [[ "$MODE" == "paid" ]]; then
    read -rp "PAKASIR_SLUG: " PAKASIR_SLUG
    read -s -p "PAKASIR_API_KEY: " PAKASIR_API_KEY; echo
    read -rp "WEBHOOK_TOKEN (random, contoh: abcd1234): " WEBHOOK_TOKEN
  fi

  cat > "$ENV_FILE" <<EOF
MODE=$MODE
BOT_TOKEN=$BOT_TOKEN
OWNER_ID=$OWNER_ID
ADMIN_IDS=$ADMIN_IDS

DB_PATH=$DB_DIR/app.db

PAKASIR_SLUG=$PAKASIR_SLUG
PAKASIR_API_KEY=$PAKASIR_API_KEY
WEBHOOK_PATH=/pakasir/webhook
PORT=9000
WEBHOOK_TOKEN=$WEBHOOK_TOKEN

TRIAL_ENABLED=true
TRIAL_DAYS=1
TRIAL_ONCE_PER_USER=true
TRIAL_MAX_DAILY=50
TRIAL_PASSWORD_MODE=auto
TRIAL_PREFIX=TR

TZ=Asia/Jakarta
NODE_ENV=production
EOF

  chmod 600 "$ENV_FILE"
  echo "✅ Env dibuat: $ENV_FILE"
else
  echo "✅ Env sudah ada: $ENV_FILE"
fi

# Pastikan udp-zivpn ada
if ! systemctl list-unit-files | grep -q '^zivpn\.service'; then
  echo "==> Installing udp-zivpn (zahid repo)..."
  bash <(curl -fsSL https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi2.sh)
fi

# Cek config zivpn
if [[ ! -f /etc/zivpn/config.json ]]; then
  echo "ERROR: /etc/zivpn/config.json not found"
  exit 1
fi
if ! jq -e '.auth.config and (.auth.config|type=="array")' /etc/zivpn/config.json >/dev/null 2>&1; then
  echo "ERROR: /etc/zivpn/config.json tidak punya auth.config array"
  echo "Silakan cek format config zivpn dulu."
  exit 1
fi

# Install password manager
install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" "$PASS_MGR"

# Install deps
cd "$APP_DIR"
npm install --omit=dev

# Install systemd
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Opal ZiVPN Bot (Node.js)
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

echo "✅ Done."
echo "Cek status: systemctl status opal-daemon"
echo "Lihat log : journalctl -u opal-daemon -f"
