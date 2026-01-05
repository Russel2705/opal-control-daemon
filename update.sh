#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/opal-control-daemon"
APP_USER="opal"

cd "$APP_DIR"
sudo -u "$APP_USER" git pull
sudo -u "$APP_USER" npm install --omit=dev
systemctl restart opal-daemon
echo "✅ Updated & restarted (opal-daemon)."