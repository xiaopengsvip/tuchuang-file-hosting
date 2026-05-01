# API Reference

Base URL:

- Production short domain: `https://tc.allapple.top`
- Production main domain: `https://tuchuang.allapple.top`
- Local: `http://127.0.0.1:8765`

Admin-only endpoints require:

```http
X-Admin-Token: <ADMIN_TOKEN>
```

External storage API endpoints require one of these headers:

```http
Authorization: Bearer <STORAGE_API_KEY>
X-API-Key: <STORAGE_API_KEY>
X-Storage-Token: <STORAGE_API_KEY>
```

`STORAGE_API_KEYS` supports comma/newline separated keys. If no dedicated storage key is configured, the server falls back to `ADMIN_TOKEN` for storage API auth.

## Health

### GET /health

Returns service status, upload limits, feature flags and moderation settings.

Example:

```bash
curl https://tc.allapple.top/health
```

## Upload

### POST /api/upload

Simple multipart upload.

Request:

```bash
curl -X POST https://tc.allapple.top/api/upload \
  -F "files=@./example.png"
```

Admin upload with larger limit:

```bash
curl -X POST https://tc.allapple.top/api/upload \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -F "files=@./large-video.mp4"
```

Optional form fields for video feed opt-in:

- `allowFeed=true`
- `requestFeed=true`
- `feedPreference=true`

For public uploads, feed status stays pending/hidden until admin approval. Admin uploads can request feed metadata directly.

Response includes `files[]`, each item containing URLs such as:

- `url`: main public file URL
- `directUrl`: forced download/raw URL
- `shortUrl`: short URL
- `previewUrl`: station preview page
- `markdown`: Markdown syntax for images/files

### POST /api/uploads/init

Initialize a resumable upload session.

Body example:

```json
{
  "originalName": "video.mp4",
  "size": 104857600,
  "mimeType": "video/mp4",
  "lastModified": 1710000000000,
  "fingerprint": "video.mp4:104857600:1710000000000"
}
```

Returns `uploadId`, `chunkSize`, `totalChunks`, `receivedChunks`, `missingChunks`.

### GET /api/uploads/:uploadId/status

Returns current resumable upload progress.

### PUT /api/uploads/:uploadId/chunks/:index

Uploads a binary chunk. The request body is raw bytes.

```bash
curl -X PUT "https://tc.allapple.top/api/uploads/$UPLOAD_ID/chunks/0" \
  --data-binary @chunk-000000.part
```

### POST /api/uploads/:uploadId/complete

Merges uploaded chunks, runs moderation, writes metadata and returns the final file record.

## External storage API

These endpoints are intended for trusted external systems such as a video website. They use storage API key auth and return player-friendly URLs.

### GET /api/storage/health

Protected storage API health check. Returns feature availability, max file size and route hints.

```bash
curl https://tc.allapple.top/api/storage/health \
  -H "Authorization: Bearer $STORAGE_API_KEY"
```

### POST /api/storage/upload

Protected multipart upload. Accepts either `file` or `files` field names.

```bash
curl -X POST https://tc.allapple.top/api/storage/upload \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  -F "file=@./video.mp4" \
  -F "title=示例视频" \
  -F "description=视频网站存储测试" \
  -F "tags=demo,video" \
  -F "publish=true"
```

Optional metadata fields:

- `title`: display title, max 180 chars.
- `description`: max 2000 chars.
- `tags`: comma-separated string or JSON array.
- `visibility`: `private`, `unlisted`, `public`.
- `publish=true`: for video files, sets `visibility=public`, `allowFeed=true`, `feedStatus=approved` so the video website can publish immediately.
- `feedStatus`: optional override for video feed status: `hidden`, `pending`, `approved`, `rejected`.

Response includes `files[]` with:

- `id`
- `kind`
- `playUrl`: URL suitable for `<video src>` / player playback. Supports Range requests.
- `viewUrl`: station preview URL.
- `embedUrl`: preview URL with `?embed=1`.
- `downloadUrl`: forced download/raw URL.
- `shortUrl`
- `deleteApi`: API path to delete this object.

### GET /api/storage/files

Protected management list.

Parameters:

- `page`: default `1`
- `limit`: default `50`, max `200`
- `search`: keyword search
- `type`: `image`, `video`, `audio`, `document`, `other`
- `sort`: `latest`, `access`, `expiring`, `largest`, `recommended`
- `includeDeleted`: `true` to include soft-deleted metadata

```bash
curl "https://tc.allapple.top/api/storage/files?type=video&limit=20" \
  -H "Authorization: Bearer $STORAGE_API_KEY"
```

### GET /api/storage/files/:id

Protected detail lookup for one stored file.

### DELETE /api/storage/files/:id

Protected delete. Soft-deletes metadata in SQLite and removes the physical file from `uploads/` if it exists.

```bash
curl -X DELETE "https://tc.allapple.top/api/storage/files/$ID" \
  -H "Authorization: Bearer $STORAGE_API_KEY"
```

### GET /api/storage/stats

Protected storage statistics and active API upload limit.

## Files

### GET /api/files

Query files.

Parameters:

- `page`: default `1`
- `limit`: default `50`, max `200`
- `search`: keyword search
- `type`: `image`, `video`, `audio`, `document`, `other`
- `sort`: `latest`, `access`, `expiring`, `largest`, `recommended`

Example:

```bash
curl "https://tc.allapple.top/api/files?type=image&sort=latest&limit=20"
```

### DELETE /api/files/:id

Admin-only. Marks metadata deleted and removes the stored file.

```bash
curl -X DELETE "https://tc.allapple.top/api/files/$ID" \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

## Preview and public file URLs

### GET /s/:id

Short URL. Redirects to `/f/:id/:name`.

### GET /f/:id/:name?

Inline file response where safe. Supports HTTP `Range` for media playback.

### HEAD /f/:id/:name?

Metadata-only version of `/f`.

### GET /raw/:id

Forced attachment/download response.

### HEAD /raw/:id

Metadata-only version of `/raw`.

### GET /preview/:id

Standalone preview page. Supports `?embed=1` for embedding inside the app modal.

## Stats and logs

### GET /api/stats

Returns file counts, total size and upload limits.

### POST /api/upload-logs

Writes a client-side upload event log. Rate-limited per IP.

### GET /api/upload-logs

Admin-only. Returns tail of upload logs.

Parameters:

- `limit`: default `100`

## Video feed

### GET /api/feed/videos

Public video feed. Only approved public video records are returned.

Parameters:

- `limit`: default determined by server, accepts small page sizes
- `cursor`: ISO timestamp cursor from previous response

### GET /api/admin/feed/videos

Admin-only feed management list.

Parameters:

- `page`
- `limit`
- `status` / `feedStatus`: `all`, `hidden`, `pending`, `approved`, `rejected`
- `search`

### PATCH /api/files/:id/feed

Admin-only. Updates a file's feed metadata.

Body example:

```json
{
  "visibility": "public",
  "allowFeed": true,
  "feedStatus": "approved",
  "title": "Demo Video",
  "description": "A short demo",
  "tags": ["demo", "video"]
}
```

Only video files can enter the public feed.

### POST /api/admin/feed/batch

Admin-only. Batch updates feed records.

Body example:

```json
{
  "action": "approve",
  "ids": ["abc123", "def456"]
}
```

Supported actions:

- `approve`
- `hide`
- `reject`
- `clear-approved`

## Notes

### GET /api/notes

Returns public notes. If admin token is provided, private notes are included.

Parameters:

- `fileId`: optional file id filter
- `limit`: default `50`

### POST /api/notes

Admin-only. Creates a note.

Body example:

```json
{
  "fileId": "abc123",
  "title": "说明",
  "content": "这是一段 Markdown 说明。",
  "contentFormat": "markdown",
  "visibility": "private",
  "pinned": false,
  "tags": ["说明"]
}
```

### PATCH /api/notes/:id

Admin-only. Updates a note and creates a revision record.

### GET /api/notes/:id/history

Admin-only. Returns note revisions.

### DELETE /api/notes/:id

Admin-only. Soft deletes a note.

## Error format

Most API errors use:

```json
{
  "success": false,
  "error": "message",
  "logId": "optional-log-id"
}
```

Moderation rejection returns HTTP 451 and includes:

```json
{
  "success": false,
  "error": "上传被拒绝：...",
  "moderation": {
    "blocked": true,
    "categories": ["sexual"],
    "categoryLabels": ["色情低俗"]
  }
}
```
