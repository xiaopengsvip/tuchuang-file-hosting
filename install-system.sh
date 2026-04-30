#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/home/ubuntu/work/tuchuang-file-hosting

sudo cp /tmp/tuchuang-file-hosting.service /etc/systemd/system/tuchuang-file-hosting.service
sudo systemctl daemon-reload
sudo systemctl enable --now tuchuang-file-hosting.service

sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)
sudo cp /tmp/Caddyfile.tuchuang /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

systemctl --no-pager --lines=20 status tuchuang-file-hosting.service
curl -sS http://127.0.0.1:8765/health
curl -sS -I -H 'Host: tuchuang.allapple.top' http://127.0.0.1/
curl -sS -I -H 'Host: tc.allapple.top' http://127.0.0.1/
