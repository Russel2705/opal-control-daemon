#!/usr/bin/env bash
set -euo pipefail

CFG="/etc/zivpn/config.json"
SVC="zivpn.service"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 add|del <password>"
  exit 1
fi

ACTION="$1"
PASS="$2"

if [[ "$PASS" =~ [,[:space:]\"] ]]; then
  echo "Invalid password: must not contain comma/space/quotes"
  exit 2
fi

exec 9>/var/lock/zivpn-passwd.lock
flock -x 9

if [[ ! -f "$CFG" ]]; then
  echo "ERR: $CFG not found"
  exit 3
fi

# pastikan auth.config array
if ! jq -e '.auth.config and (.auth.config|type=="array")' "$CFG" >/dev/null 2>&1; then
  echo "ERR: auth.config not found or not array"
  exit 4
fi

case "$ACTION" in
  add)
    if jq -e --arg p "$PASS" '.auth.config | index($p) != null' "$CFG" >/dev/null; then
      echo "ERR_EXISTS"
      exit 10
    fi
    tmp="$(mktemp)"
    jq --arg p "$PASS" '.auth.config += [$p]' "$CFG" > "$tmp"
    mv "$tmp" "$CFG"
    ;;
  del)
    tmp="$(mktemp)"
    jq --arg p "$PASS" '.auth.config |= map(select(. != $p))' "$CFG" > "$tmp"
    mv "$tmp" "$CFG"
    ;;
  *)
    echo "Unknown action"
    exit 5
    ;;
esac

chmod 600 "$CFG"
systemctl restart "$SVC"
echo "OK"
