#!/usr/bin/env bash
set -euo pipefail

CONF="/etc/zivpn/config.json"

need_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root"
    exit 1
  fi
}

need_jq() {
  command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found"; exit 1; }
}

valid_pass() {
  local p="$1"
  # 3-32 chars, no spaces, no comma
  [[ ${#p} -ge 3 && ${#p} -le 32 ]] || return 1
  [[ "$p" != *" "* ]] || return 1
  [[ "$p" != *","* ]] || return 1
  return 0
}

ensure_conf() {
  [[ -f "$CONF" ]] || { echo "ERROR: $CONF not found"; exit 1; }
  jq -e '.auth.config and (.auth.config|type=="array")' "$CONF" >/dev/null || {
    echo "ERROR: $CONF missing .auth.config array"
    exit 1
  }
}

cmd="${1:-}"
pass="${2:-}"

need_root
need_jq
ensure_conf

case "$cmd" in
  check)
    valid_pass "$pass" || { echo "INVALID"; exit 2; }
    if jq -e --arg p "$pass" '.auth.config | index($p) != null' "$CONF" >/dev/null; then
      echo "EXISTS"
      exit 0
    else
      echo "NOT_FOUND"
      exit 1
    fi
    ;;

  add)
    valid_pass "$pass" || { echo "INVALID"; exit 2; }
    if jq -e --arg p "$pass" '.auth.config | index($p) != null' "$CONF" >/dev/null; then
      echo "EXISTS"
      exit 3
    fi
    tmp="$(mktemp)"
    jq --arg p "$pass" '.auth.config += [$p]' "$CONF" > "$tmp"
    mv "$tmp" "$CONF"
    systemctl restart zivpn.service >/dev/null 2>&1 || true
    echo "ADDED"
    ;;

  del)
    valid_pass "$pass" || { echo "INVALID"; exit 2; }
    tmp="$(mktemp)"
    jq --arg p "$pass" '.auth.config |= map(select(. != $p))' "$CONF" > "$tmp"
    mv "$tmp" "$CONF"
    systemctl restart zivpn.service >/dev/null 2>&1 || true
    echo "DELETED"
    ;;

  *)
    echo "Usage: $0 {check|add|del} <password>"
    exit 1
    ;;
esac
