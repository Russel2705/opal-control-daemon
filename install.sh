#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="/etc/opal-daemon.env"
SERVICE_FILE="/etc/systemd/system/opal-daemon.service"
DATA_DIR_DEFAULT="/var/lib/opal-daemon"

# ZiVPN (temen style)
ZIVPN_BIN="/usr/local/bin/zivpn"
ZIVPN_CFG_DIR="/etc/zivpn"
ZIVPN_CONFIG="$ZIVPN_CFG_DIR/config.json"

# UDPGW
UDPGW_BIN="/usr/local/bin/udpgw"
UDPGW_CFG_DIR="/etc/udpgw"
UDPGW_PORT_DEFAULT="7300"
UDPGW_SERVICE_FILE="/etc/systemd/system/udpgw.service"

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
    *)
      echo "ERROR: arch $a tidak didukung"
      exit 1
      ;;
  esac
}

install_base_packages() {
  log "Update & install paket kebutuhan"
  export DEBIAN_FRONTEND=noninteractive
  apt update -y
  apt upgrade -y
  apt install -y curl wget git jq ca-certificates build-essential file iproute2 \
    golang openssl iptables-persistent netfilter-persistent
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

stop_services() {
  log "Stop service lama (kalau ada)"
  systemctl stop zivpn.service 2>/dev/null || true
  systemctl stop udpgw.service 2>/dev/null || true
  systemctl stop opal-daemon 2>/dev/null || true
}

# ===================== ZiVPN (release binary + config + cert) =====================

download_zivpn_release() {
  local arch="$1"
  local url

  log "Download ZiVPN release binary ($arch)"
  if [[ "$arch" == "amd64" ]]; then
    url="https://github.com/zahidbd2/udp-zivpn/releases/download/udp-zivpn_1.4.9/udp-zivpn-linux-amd64"
  else
    url="https://github.com/zahidbd2/udp-zivpn/releases/download/udp-zivpn_1.4.9/udp-zivpn-linux-arm64"
  fi

  wget -q --show-progress "$url" -O "$ZIVPN_BIN"
  chmod +x "$ZIVPN_BIN"
}

ensure_zivpn_config_and_cert() {
  log "Setup config & sertifikat ZiVPN"
  mkdir -p "$ZIVPN_CFG_DIR"

  if [[ ! -f "$ZIVPN_CONFIG" ]]; then
    wget -q "https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/config.json" -O "$ZIVPN_CONFIG"
  fi

  # cert
  if [[ ! -f "$ZIVPN_CFG_DIR/zivpn.key" || ! -f "$ZIVPN_CFG_DIR/zivpn.crt" ]]; then
    openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
      -subj "/C=ID/ST=ID/L=ID/O=ZiVPN/OU=VPN/CN=zivpn-server" \
      -keyout "$ZIVPN_CFG_DIR/zivpn.key" \
      -out "$ZIVPN_CFG_DIR/zivpn.crt" 2>/dev/null
  fi
}

configure_zivpn_passwords_optional() {
  log "Opsional: set password ZiVPN (di config.json)"
  echo "Isi password dipisah koma (contoh: zi,zi123). Kosong = default 'zi'"
  read -rp "Passwords: " input_config || true

  local arr=()
  if [[ -n "${input_config:-}" ]]; then
    IFS=',' read -r -a arr <<< "$input_config"
  else
    arr=("zi")
  fi

  # trim spasi
  local cleaned=()
  for p in "${arr[@]}"; do
    p="$(echo "$p" | xargs)"
    [[ -n "$p" ]] && cleaned+=("$p")
  done
  [[ "${#cleaned[@]}" -eq 0 ]] && cleaned=("zi")

  # build JSON array
  local json="["
  local first=1
  for p in "${cleaned[@]}"; do
    if [[ $first -eq 1 ]]; then
      json+="\"$p\""
      first=0
    else
      json+=", \"$p\""
    fi
  done
  json+="]"

  # ganti field "config": ...
  # (sesuai script temen)
  sed -i "s/\"config\":.*/\"config\": $json/" "$ZIVPN_CONFIG" || true
  echo "OK: Password ZiVPN diset: $json"
}

install_zivpn_service() {
  log "Install systemd service: zivpn"
  cat > /etc/systemd/system/zivpn.service <<EOF
[Unit]
Description=Zivpn UDP Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$ZIVPN_CFG_DIR
ExecStart=$ZIVPN_BIN server -c $ZIVPN_CFG_DIR/config.json
Restart=always
RestartSec=3
Environment=ZIVPN_LOG_LEVEL=info
LimitNOFILE=65535
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now zivpn.service
  systemctl restart zivpn.service
  sleep 1

  if ! systemctl is-active --quiet zivpn.service; then
    echo "ERROR: zivpn.service tidak running"
    systemctl status zivpn.service --no-pager || true
    journalctl -u zivpn.service -n 80 --no-pager || true
    exit 1
  fi

  if ! ss -lunp | grep -qi zivpn; then
    echo "WARNING: zivpn tidak terlihat listen di UDP (ss -lunp). Cek $ZIVPN_CONFIG"
  else
    echo "OK: zivpn terlihat listen (UDP)"
  fi
}

# ===================== UDPGW (build source + config + service) =====================

build_udpgw() {
  log "Build UDPGW dari source (mukswilly/udpgw)"
  if [[ -x "$UDPGW_BIN" ]]; then
    echo "udpgw sudah ada: $UDPGW_BIN (skip build)"
    return
  fi

  local TMP_DIR
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  cd "$TMP_DIR"
  git clone https://github.com/mukswilly/udpgw.git
  cd udpgw
  [[ -d "cmd" ]] && cd cmd

  export CGO_ENABLED=0
  go build -ldflags="-s -w" -o udpgw
  install -m 0755 udpgw "$UDPGW_BIN"
  echo "OK: udpgw terpasang di $UDPGW_BIN"
}

configure_udpgw() {
  local port="$1"
  log "Config UDPGW JSON (port $port)"
  mkdir -p "$UDPGW_CFG_DIR"
  cat > "$UDPGW_CFG_DIR/udpgw.json" <<EOF
{
  "LogLevel": "info",
  "LogFilename": "",
  "HostID": "opal-udpgw",
  "UdpgwPort": $port,
  "DNSResolverIPAddress": "8.8.8.8"
}
EOF
}

install_udpgw_service() {
  log "Install systemd service: udpgw"
  cat > "$UDPGW_SERVICE_FILE" <<EOF
[Unit]
Description=UDPGW Golang Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$UDPGW_CFG_DIR
ExecStart=$UDPGW_BIN run -config udpgw.json
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now udpgw.service
  systemctl restart udpgw.service
  sleep 1

  if ! systemctl is-active --quiet udpgw.service; then
    echo "ERROR: udpgw.service tidak running"
    systemctl status udpgw.service --no-pager || true
    journalctl -u udpgw.service -n 80 --no-pager || true
    exit 1
  fi
}

setup_firewall_split_range() {
  log "Firewall NAT split range (exclude 7100-7500 biar UDPGW 7300 aman)"

  local IFACE
  IFACE="$(ip -4 route ls | grep default | grep -Po '(?<=dev )(\S+)' | head -1 || true)"
  if [[ -z "${IFACE:-}" ]]; then
    echo "WARN: tidak bisa detect interface utama, skip NAT rule."
    return
  fi

  # bersihin rule lama
  iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :5667 2>/dev/null || true
  iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 6000:7099  -j DNAT --to-destination :5667 2>/dev/null || true
  iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 7501:19999 -j DNAT --to-destination :5667 2>/dev/null || true

  # tambah rule baru
  iptables -t nat -A PREROUTING -i "$IFACE" -p udp --dport 6000:7099  -j DNAT --to-destination :5667
  iptables -t nat -A PREROUTING -i "$IFACE" -p udp --dport 7501:19999 -j DNAT --to-destination :5667

  # allow port udpgw
  if command -v ufw >/dev/null 2>&1; then
    ufw allow 6000:19999/udp >/dev/null || true
    ufw allow 5667/udp >/dev/null || true
    ufw allow 7300/udp >/dev/null || true
  fi

  netfilter-persistent save >/dev/null 2>&1 || echo "WARN: gagal simpan iptables secara persistent."
}

# ===================== Bot ENV + service (punya bapak) =====================

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

  read -rp "UDPGW_PORT [${UDPGW_PORT_DEFAULT}]: " UDPGW_PORT
  UDPGW_PORT="${UDPGW_PORT:-$UDPGW_PORT_DEFAULT}"

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
TOPUP_MIN=1000

FREE_ACCESS=$FREE_ACCESS
TRIAL_HOURS=$TRIAL_HOURS

UDPGW_PORT=$UDPGW_PORT

ZIVPN_PASS_MGR=/usr/local/bin/zivpn-passwd-manager
NODE_ENV=production
NODE_OPTIONS=--dns-result-order=ipv4first
EOF

  chmod 600 "$ENV_FILE"
  echo "OK: ENV dibuat."
}

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
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

install_zivpn_pass_manager() {
  log "Install zivpn-passwd-manager"
  if [[ ! -f "$APP_DIR/scripts/zivpn-passwd-manager.sh" ]]; then
    echo "ERROR: scripts/zivpn-passwd-manager.sh tidak ditemukan di repo."
    exit 1
  fi
  install -m 0755 "$APP_DIR/scripts/zivpn-passwd-manager.sh" /usr/local/bin/zivpn-passwd-manager
}

install_systemd_service() {
  log "Install systemd service: opal-daemon (bot)"

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
  log "Opal install (Bot + ZiVPN + UDPGW) mulai..."
  local arch
  arch="$(detect_arch)"
  log "Detected arch: $arch"

  install_base_packages
  install_node20_if_missing
  stop_services

  # ZiVPN (temen style)
  download_zivpn_release "$arch"
  ensure_zivpn_config_and_cert
  configure_zivpn_passwords_optional
  install_zivpn_service

  # UDPGW
  ensure_env_file
  local udpgw_port
  udpgw_port="$(read_env_value UDPGW_PORT)"
  udpgw_port="${udpgw_port:-$UDPGW_PORT_DEFAULT}"
  build_udpgw
  configure_udpgw "$udpgw_port"
  install_udpgw_service

  # Firewall split
  setup_firewall_split_range

  # Bot
  install_zivpn_pass_manager
  ensure_data_dir
  install_node_deps
  install_systemd_service

  log "Selesai ✅"
  echo "======================================="
  echo " ZiVPN  : 5667/udp (cek config.json)"
  echo " UDPGW  : ${udpgw_port}/udp"
  echo " UDP NAT: 6000-7099 & 7501-19999 -> :5667"
  echo "======================================="
  echo "Cek bot  : systemctl status opal-daemon --no-pager"
  echo "Cek zivpn: systemctl status zivpn.service --no-pager"
  echo "Cek udpgw: systemctl status udpgw.service --no-pager"
  echo "Cek port : ss -lunp | egrep 'zivpn|:5667|:${udpgw_port}'"
}

main "$@"
