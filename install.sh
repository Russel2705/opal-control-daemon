#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="/etc/opal-daemon.env"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"
DATA_DIR_DEFAULT="/var/lib/opal-daemon"

log() { echo -e "\n==> $*"; }

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: Jalankan sebagai root. Contoh: sudo bash install.sh"
    exit 1
  fi
}

detect_arch() {
  local a
  a="$(uname -m)"
  case "$a" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "$a" ;;
  esac
}

install_base_packages() {
  log "Install paket dasar"
  apt update -y
  apt install -y curl git jq ca-certificates build-essential
}

install_node20_if_missing() {
  if command -v node >/dev/null 2>&1; then
    log "Node sudah ada: $(node -v)"
    return
  fi
  log "Install Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
  node -v
}

install_zivpn_by_arch() {
  local arch="$1"
  local url
  if [[ "$arch" == "amd64" ]]; then
    url="https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi.sh"
    log "Install udp-zivpn (AMD/x86_64) via zi.sh"
  else
    url="https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi2.sh"
    log "Install udp-zivpn (ARM) via zi2.sh"
  fi

  curl -fsSL "$url" -o /tmp/zivpn-install.sh
  chmod +x /tmp/zivpn-install.sh
  bash /tmp/zivpn-install.sh
}

zivpn_binary_ok() {
  local arch="$1"

  [[ -x /usr/local/bin/zivpn ]] || return 1
  file /usr/local/bin/zivpn | grep -qi "ELF" || return 1

  if [[ "$arch" == "amd64" ]]; then
    file /usr/local/bin/zivpn | grep -qiE "x86-64|x86_64" || return 1
  elif [[ "$arch" == "arm64" ]]; then
    file /usr/local/bin/zivpn | grep -qiE "aarch64|ARM aarch64" || return 1
  fi

  return 0
}

ensure_zivpn_ok() {
  local arch="$1"

  log "Pastikan ZiVPN ter-install & binary sesuai arsitektur"
  if zivpn_binary_ok "$arch"; then
    echo "zivpn binary OK"
  else
    echo "zivpn binary TIDAK OK / mismatch → reinstall"
    systemctl stop zivpn.service 2>/dev/null || true
    rm -f /usr/local/bin/zivpn
    install_zivpn_by_arch "$arch"
  fi

  log "Start zivpn.service"
  systemctl daemon-reload || true
  systemctl enable --now zivpn.service || true
  systemctl restart zivpn.service || true
  sleep 1

  if ! systemctl is-active --quiet zivpn.service; then
    echo "ERROR: zivpn.service tidak running"
    systemctl status zivpn.service --no-pager || true
    journalctl -u zivpn.service -n 80 --no-pager || true
    exit 1
  fi

  # cek listen UDP
  if ! ss -lunp | grep -qi zivpn; then
    echo "WARNING: zivpn tidak terlihat listen di UDP (ss -lunp)."
    echo "Cek port listen di /etc/zivpn/config.json"
  else
    echo "OK: zivpn terlihat listen (UDP)"
  fi
}

install_zivpn_pass_manager() {
  log "Install zivpn-passwd-manager"
  if [[ ! -f "$APP_DIR/scripts/zivpn-passwd-manager.sh" ]]; then
    echo "ERROR: scripts/zivpn-passwd-manager.sh tidak ditemukan di repo."
    exit 1
  fi
  install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" /usr/local/bin/zivpn-passwd-manager
}

ensure_env_file() {
  log "Setup ENV: $ENV_FILE"

  if [[ -f "$ENV_FILE" ]]; then
    echo "ENV sudah ada, tidak dibuat ulang."
    return
  fi

  echo "ENV belum ada → buat baru."
  read -rp "MODE (free/paid) [paid]: " MODE
  MODE="${MODE:-paid}"

  read -s -p "BOT_TOKEN: " BOT_TOKEN; echo
  read -rp "OWNER_ID (angka): " OWNER_ID
  read -rp "ADMIN_IDS (pisah koma, boleh kosong): " ADMIN_IDS

  read -rp "FREE_ACCESS (public/private) [public]: " FREE_ACCESS
  FREE_ACCESS="${FREE_ACCESS:-public}"

  read -rp "TRIAL_HOURS (jam) [3]: " TRIAL_HOURS
  TRIAL_HOURS="${TRIAL_HOURS:-3}"

  PAKASIR_PROJECT=""
  PAKASIR_API_KEY=""
  WEBHOOK_TOKEN=""

  if [[ "$MODE" == "paid" ]]; then
    read -rp "PAKASIR_PROJECT (slug): " PAKASIR_PROJECT
    read -s -p "PAKASIR_API_KEY: " PAKASIR_API_KEY; echo
    read -rp "WEBHOOK_TOKEN (random string): " WEBHOOK_TOKEN
  fi

  cat > "$ENV_FILE" <<EOF
MODE=$MODE
BOT_TOKEN=$BOT_TOKEN
OWNER_ID=$OWNER_ID
ADMIN_IDS=$ADMIN_IDS

DB_DIR=$DATA_DIR_DEFAULT

PAKASIR_PROJECT=$PAKASIR_PROJECT
PAKASIR_API_KEY=$PAKASIR_API_KEY
WEBHOOK_PATH=/pakasir/webhook
PORT=9000
WEBHOOK_TOKEN=$WEBHOOK_TOKEN
TOPUP_MIN=10000

FREE_ACCESS=$FREE_ACCESS
TRIAL_HOURS=$TRIAL_HOURS

ZIVPN_PASS_MGR=/usr/local/bin/zivpn-passwd-manager
NODE_ENV=production
NODE_OPTIONS=--dns-result-order=ipv4first
EOF

  chmod 600 "$ENV_FILE"
  echo "OK: ENV dibuat."
}

ensure_data_dir() {
  log "Buat data dir: $DATA_DIR_DEFAULT"
  mkdir -p "$DATA_DIR_DEFAULT"
  chmod 755 "$DATA_DIR_DEFAULT"
}

install_node_deps() {
  log "Install dependency Node.js"
  cd "$APP_DIR"
  npm install --omit=dev
}

install_systemd_service() {
  log "Install systemd service: opal-daemon"

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
  systemctl restart opal-daemon
  sleep 1

  if ! systemctl is-active --quiet opal-daemon; then
    echo "ERROR: opal-daemon tidak running"
    systemctl status opal-daemon --no-pager || true
    journalctl -u opal-daemon -n 80 --no-pager || true
    exit 1
  fi
}

main() {
  require_root
  log "Opal install 시작 (dir: $APP_DIR)"
  local arch
  arch="$(detect_arch)"
  log "Detected arch: $arch"

  install_base_packages
  install_node20_if_missing

  # Pastikan ZiVPN OK (auto-fix exec format error)
  ensure_zivpn_ok "$arch"

  # Install passwd manager
  install_zivpn_pass_manager

  # Env + data dir
  ensure_env_file
  ensure_data_dir

  # Node deps + service
  install_node_deps
  install_systemd_service

  log "Selesai ✅"
  echo "Cek bot: systemctl status opal-daemon --no-pager"
  echo "Cek log: journalctl -u opal-daemon -f"
  echo "Cek zivpn: systemctl status zivpn.service --no-pager"
}

main "$@"
