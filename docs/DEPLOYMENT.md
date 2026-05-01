# Deployment Guide

This project is designed to run as a local Node.js service behind a reverse proxy such as Caddy or Nginx.

Production example:

- Node service: `127.0.0.1:8765`
- Public domains: `tuchuang.allapple.top`, `tc.allapple.top`
- Runtime directory: `/home/ubuntu/work/tuchuang-file-hosting`

## 1. Prepare runtime

Install Node.js 24+ and dependencies:

```bash
cd /home/ubuntu/work/tuchuang-file-hosting
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```env
ADMIN_TOKEN=<strong-random-token>
STORAGE_API_KEYS=<strong-random-storage-api-key>
BASE_URL=https://tuchuang.allapple.top
SHORT_BASE_URL=https://tc.allapple.top
```

Generate a strong token:

```bash
openssl rand -hex 32
```

Create runtime directories:

```bash
mkdir -p uploads data logs backups
```

Build frontend:

```bash
npm test
npm run build
```

## 2. Run manually for verification

```bash
PORT=8765 npm start
```

In another terminal:

```bash
curl -sS http://127.0.0.1:8765/health
curl -sS -I http://127.0.0.1:8765/
```

The server intentionally binds to `127.0.0.1`; expose it through a reverse proxy instead of binding the app directly to the public network.

## 3. systemd service example

Create `/etc/systemd/system/tuchuang-file-hosting.service`:

```ini
[Unit]
Description=Tuchuang File Hosting
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/work/tuchuang-file-hosting
EnvironmentFile=/home/ubuntu/work/tuchuang-file-hosting/.env
ExecStart=/usr/local/bin/node /home/ubuntu/work/tuchuang-file-hosting/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/home/ubuntu/work/tuchuang-file-hosting/uploads /home/ubuntu/work/tuchuang-file-hosting/data /home/ubuntu/work/tuchuang-file-hosting/logs /home/ubuntu/work/tuchuang-file-hosting/file-index.json

[Install]
WantedBy=multi-user.target
```

If Node is installed somewhere else, update `ExecStart`:

```bash
command -v node
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tuchuang-file-hosting.service
sudo systemctl status tuchuang-file-hosting.service --no-pager --lines=50
```

Restart after code changes:

```bash
sudo systemctl restart tuchuang-file-hosting.service
```

View logs:

```bash
journalctl -u tuchuang-file-hosting.service -f
```

## 4. Caddy reverse proxy example

Append a site block to `/etc/caddy/Caddyfile`:

```caddyfile
tuchuang.allapple.top, tc.allapple.top {
    encode zstd gzip

    request_body {
        max_size 11GB
    }

    reverse_proxy 127.0.0.1:8765
}
```

Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Verify host routing locally:

```bash
curl -sS -I -H 'Host: tc.allapple.top' http://127.0.0.1/
curl -sS https://tc.allapple.top/health
```

## 5. Optional media moderation setup

The app can call `scripts/local-media-moderation.py`. If NudeNet is unavailable, uploads are allowed by default unless `MEDIA_MODERATION_BLOCK_ON_UNAVAILABLE=true`.

Recommended isolated Python environment:

```bash
python3 -m venv .venv-media-moderation
. .venv-media-moderation/bin/activate
pip install --upgrade pip
pip install nudenet
```

Install ffmpeg for video frame extraction:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

Then set `.env`:

```env
MEDIA_MODERATION_ENABLED=true
MEDIA_MODERATION_PYTHON=/home/ubuntu/work/tuchuang-file-hosting/.venv-media-moderation/bin/python
FFMPEG_PATH=/usr/bin/ffmpeg
```

## 6. Backup and restore

Runtime data is not tracked in Git. Back up before upgrades or restarts that change schema.

Backup SQLite safely:

```bash
mkdir -p backups
sqlite3 data/tuchuang.sqlite ".backup 'backups/tuchuang-$(date +%Y%m%d%H%M%S).sqlite'"
```

Backup uploads:

```bash
tar -czf "backups/uploads-$(date +%Y%m%d%H%M%S).tar.gz" uploads
```

Restore example:

```bash
sudo systemctl stop tuchuang-file-hosting.service
cp backups/tuchuang-YYYYMMDDHHMMSS.sqlite data/tuchuang.sqlite
# restore uploads tarball if needed
sudo systemctl start tuchuang-file-hosting.service
```

## 7. Deployment checklist

Before pushing/restarting production:

```bash
npm test
npm run build
curl -sS http://127.0.0.1:8765/health
```

After restart:

```bash
systemctl --no-pager --lines=30 status tuchuang-file-hosting.service
curl -sS https://tc.allapple.top/health
curl -sS -I https://tc.allapple.top/
```

## 8. GitHub repository policy

Commit source, tests, docs and build assets if the deployment relies on `dist/`.

Do not commit:

- `.env`
- `uploads/`
- `data/`
- `logs/`
- `file-index.json`
- backups and certificates
- local test scratch directories such as `.tmp-e2e/`
