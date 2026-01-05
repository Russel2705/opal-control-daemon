#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="/etc/opal-daemon.env"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"

echo "==> App dir: $APP_DIR"

apt update -y
apt install -y curl git jq ca-certificates build-essential

# Node 20
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

# Install udp-zivpn if missing
if ! systemctl list-unit-files | grep -q '^zivpn\.service'; then
  echo "==> Installing udp-zivpn..."
  bash <(curl -fsSL https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi2.sh)
fi

# Install zivpn password manager
install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" /usr/local/bin/zivpn-passwd-manager

# Create env on first install
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Membuat $ENV_FILE"
  read -rp "MODE (free/paid) [paid]: " MODE
  MODE="${MODE:-paid}"

  read -s -p "BOT_TOKEN: " BOT_TOKEN; echo
  read -rp "OWNER_ID (angka): " OWNER_ID
  read -rp "ADMIN_IDS (pisah koma, boleh kosong): " ADMIN_IDS

  read -rp "FREE_ACCESS (public/private) [public]: " FREE_ACCESS
  FREE_ACCESS="${FREE_ACCESS:-public}"

  PAKASIR_PROJECT=""
  PAKASIR_API_KEY=""
  WEBHOOK_TOKEN=""

  if [[ "$MODE" == "paid" ]]; then
    echo "Pakasir docs: webhook payload + API transactioncreate/qris + transactiondetail ada di docs resmi. :contentReference[oaicite:4]{index=4}"
    read -rp "PAKASIR_PROJECT (slug): " PAKASIR_PROJECT
    read -s -p "PAKASIR_API_KEY: " PAKASIR_API_KEY; echo
    read -rp "WEBHOOK_TOKEN (random): " WEBHOOK_TOKEN
  fi

  cat > "$ENV_FILE" <<EOF
MODE=$MODE
BOT_TOKEN=$BOT_TOKEN
OWNER_ID=$OWNER_ID
ADMIN_IDS=$ADMIN_IDS

DB_DIR=/var/lib/opal-daemon

PAKASIR_PROJECT=$PAKASIR_PROJECT
PAKASIR_API_KEY=$PAKASIR_API_KEY
WEBHOOK_PATH=/pakasir/webhook
PORT=9000
WEBHOOK_TOKEN=$WEBHOOK_TOKEN
TOPUP_MIN=10000

FREE_ACCESS=$FREE_ACCESS

ZIVPN_PASS_MGR=/usr/local/bin/zivpn-passwd-manager
NODE_ENV=production
NODE_OPTIONS=--dns-result-order=ipv4first
EOF

  chmod 600 "$ENV_FILE"
else
  echo "==> ENV sudah ada: $ENV_FILE"
fi

# Prepare data dir
mkdir -p /var/lib/opal-daemon
chmod 755 /var/lib/opal-daemon

# Install deps
cd "$APP_DIR"
npm install --omit=dev

# systemd
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

echo "✅ Installed."
echo "Cek status: systemctl status opal-daemon"
echo "Log realtime: journalctl -u opal-daemon -f"
