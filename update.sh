#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/opal-control-daemon"

cd "$APP_DIR"
git pull
npm install --omit=dev
systemctl restart opal-daemon
echo "✅ Updated & restarted (opal-daemon)."
