#!/usr/bin/env bash
set -euo pipefail

CFG="/etc/zivpn/config.json"
SVC="zivpn.service"

KEYFILE="/etc/zivpn/password_field"
KEY="config"
if [[ -f "$KEYFILE" ]]; then
  KEY="$(tr -d '[:space:]' < "$KEYFILE")"
fi

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

OLD="$(jq -r --arg k "$KEY" '.[$k] // ""' "$CFG")"
IFS=',' read -r -a ARR <<< "${OLD:-}"

exists() {
  local x
  for x in "${ARR[@]}"; do
    [[ "$x" == "$1" ]] && return 0
  done
  return 1
}

case "$ACTION" in
  add)
    if exists "$PASS"; then
      echo "ERR_EXISTS"
      exit 10
    fi
    ARR+=("$PASS")
    ;;
  del)
    NEW=()
    for x in "${ARR[@]}"; do
      [[ "$x" == "$PASS" ]] || NEW+=("$x")
    done
    ARR=("${NEW[@]}")
    ;;
  *)
    echo "Unknown action: $ACTION"
    exit 3
    ;;
esac

NEW_STR="$(IFS=','; echo "${ARR[*]}")"

tmp="$(mktemp)"
jq --arg k "$KEY" --arg v "$NEW_STR" '.[$k] = $v' "$CFG" > "$tmp"
mv "$tmp" "$CFG"
chmod 600 "$CFG"

systemctl restart "$SVC"
echo "OK"