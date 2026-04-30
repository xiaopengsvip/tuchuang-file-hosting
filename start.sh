#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/work/tuchuang-file-hosting
set -a
source /home/ubuntu/work/tuchuang-file-hosting/.env
set +a
exec /usr/local/bin/node /home/ubuntu/work/tuchuang-file-hosting/server.js
