#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="/etc/opal-daemon.env"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"
DATA_DIR="/var/lib/opal-daemon"

log() { echo -e "\n==> $*"; }

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: Jalankan sebagai root"
    exit 1
  fi
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

stop_old_bot() {
  log "Stop bot lama (jika ada)"
  systemctl stop opal-daemon 2>/dev/null || true
}

ensure_env_exists() {
  if [[ -f "$ENV_FILE" ]]; then
    log "ENV sudah ada, skip."
    return
  fi

  echo "ERROR: $ENV_FILE tidak ditemukan."
  echo "Silakan restore env dulu sebelum jalankan script ini."
  exit 1
}

ensure_data_dir() {
  log "Pastikan data dir ada"
  mkdir -p "$DATA_DIR"
  chmod 755 "$DATA_DIR"
}

install_node_deps() {
  log "Install dependency bot"
  cd "$APP_DIR"
  npm install --omit=dev
}

install_zivpn_pass_manager() {
  if [[ -f "$APP_DIR/scripts/zivpn-passwd-manager.sh" ]]; then
    log "Install zivpn-passwd-manager"
    install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" /usr/local/bin/zivpn-passwd-manager
  else
    log "WARNING: scripts/zivpn-passwd-manager.sh tidak ditemukan (skip)"
  fi
}

install_systemd_service() {
  log "Install service opal-daemon"

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
  systemctl enable opal-daemon
  systemctl restart opal-daemon
  sleep 1

  if ! systemctl is-active --quiet opal-daemon; then
    echo "ERROR: Bot gagal start"
    systemctl status opal-daemon --no-pager
    journalctl -u opal-daemon -n 50 --no-pager
    exit 1
  fi

  echo "OK: Bot running"
}

main() {
  require_root
  log "Install BOT ONLY mulai..."

  install_node20_if_missing
  stop_old_bot
  ensure_env_exists
  ensure_data_dir
  install_node_deps
  install_zivpn_pass_manager
  install_systemd_service

  log "Selesai ✅"
  echo "Cek status: systemctl status opal-daemon --no-pager"
}

main "$@"
