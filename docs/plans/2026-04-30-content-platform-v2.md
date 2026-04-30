# Tuchuang Content Platform v2 Implementation Plan

> **For Hermes:** Use test-driven-development for each production change. Use subagent-driven-development for future expansion beyond this MVP.

**Goal:** Convert the current JSON-indexed file host into a database-backed content platform foundation with explicit video-feed opt-in and notes support.

**Architecture:** Keep uploaded binaries in `uploads/` and add SQLite metadata in `data/tuchuang.sqlite`. Preserve `file-index.json` as a compatibility backup while new APIs read/write database-backed metadata. Add explicit `visibility`, `allowFeed`, and `feedStatus` fields so uploaded videos are never placed in the刷视频推荐区 unless the owner/admin allows it.

**Tech Stack:** Node 24, Express, built-in `node:sqlite` (`DatabaseSync`), React/Vite frontend, Node test runner.

---

## Task 1: Add SQLite metadata module

**Objective:** Add a reusable metadata store that can import existing `file-index.json` records, preserve old record shape, and expose files/notes/feed helpers.

**Files:**
- Create: `src/contentDb.js`
- Create: `tests/contentDb.test.js`

**Tests first:**
- Import JSON records into an in-memory SQLite database.
- Verify old files default to `visibility='unlisted'`, `allowFeed=false`, `feedStatus='hidden'`.
- Verify only video files with `allowFeed=true` and `feedStatus='approved'` appear in feed.
- Verify notes can be created/listed for a file.

## Task 2: Wire database into server while preserving JSON fallback

**Objective:** Make `server.js` initialize DB at boot, migrate `file-index.json`, and keep `fileIndex` synchronized for rollback.

**Files:**
- Modify: `server.js`
- Test via existing suite and endpoint probes.

**Key details:**
- DB path: `process.env.DB_FILE || path.join(__dirname, 'data', 'tuchuang.sqlite')`.
- On boot: create schema, import JSON records if DB has no files.
- Keep `fileIndex` as in-memory compatibility mirror and save JSON after mutations.
- After new uploads, insert/update DB and JSON.
- After access/touch/delete, update DB and JSON.

## Task 3: Add feed visibility/update APIs

**Objective:** Add explicit authorization fields and admin-controlled feed opt-in.

**Files:**
- Modify: `server.js`
- Modify: `src/accessPolicy.js` tests if needed.

**Endpoints:**
- `GET /api/feed/videos?limit=10&cursor=<iso>` public; only approved video-feed files.
- `PATCH /api/files/:id/feed` admin-only; body `{ visibility, allowFeed, feedStatus, title, description, tags }`.

**Safety defaults:**
- Existing files: `unlisted`, not in feed.
- Newly uploaded files: `unlisted`, `allowFeed=false`, `feedStatus='hidden'`.
- Admin can approve selected videos.

## Task 4: Add notes APIs

**Objective:** Allow creating notes attached to a file or standalone.

**Files:**
- Modify: `server.js`

**Endpoints:**
- `GET /api/notes?fileId=<id>` public returns public notes only unless admin.
- `POST /api/notes` admin for now; body `{ fileId, title, content, visibility, tags }`.
- `DELETE /api/notes/:id` admin.

**MVP security:**
- No open anonymous note posting yet.
- Notes default to `private` unless explicitly `public`.

## Task 5: Add frontend MVP controls

**Objective:** Surface a video-feed section, notes section, and admin feed toggle without disrupting upload flow.

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/index.css`

**UI:**
- Add top nav buttons: 文件 / 视频推荐 / 笔记.
- 文件 card for videos shows feed status and admin-only “允许/取消推荐” action.
- 视频推荐区 shows approved feed videos with vertical cards and autoplay-friendly `video` tags.
- 笔记 section lists public notes and allows admin note creation.

## Task 6: Verify and deploy safely

**Objective:** Prove changes before touching production process.

**Commands:**
- `npm test`
- `npm run build`
- Start isolated temp server if needed: use alternate `PORT`, `UPLOAD_DIR`, `INDEX_FILE`, `DB_FILE`, `LOG_DIR`.
- Probe `/health`, `/api/feed/videos`, `/api/notes`.

**Deployment:**
- Frontend build writes to `dist/` and may be served immediately.
- Backend changes require a process restart. Restart only after tests pass and DB backup exists.

**Rollback:**
- Keep `file-index.json` intact.
- New DB file is additive in `data/tuchuang.sqlite`.
- If server restart fails, revert code or set `DB_FILE` aside and run previous commit.
