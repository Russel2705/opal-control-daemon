#!/usr/bin/env bash
set -euo pipefail
cd /opt/opal-control-daemon
git pull
npm install --omit=dev
systemctl restart opal-daemon
echo "✅ Updated & restarted"
