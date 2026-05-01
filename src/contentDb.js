import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const VALID_VISIBILITY = new Set(['private', 'unlisted', 'public']);
const VALID_FEED_STATUS = new Set(['hidden', 'pending', 'approved', 'rejected']);
const VALID_FEED_MANAGEMENT_STATUS = new Set(['all', 'hidden', 'pending', 'approved', 'rejected']);
const VALID_FEED_BATCH_ACTION = new Set(['approve', 'hide', 'reject', 'clear-approved']);
const VALID_NOTE_VISIBILITY = new Set(['private', 'public']);

function nowIso() {
  return new Date().toISOString();
}

function boolInt(value) {
  return value ? 1 : 0;
}

function fromBoolInt(value) {
  return Boolean(Number(value || 0));
}

function normalizeVisibility(value, fallback = 'unlisted') {
  const normalized = String(value || '').toLowerCase();
  return VALID_VISIBILITY.has(normalized) ? normalized : fallback;
}

function normalizeFeedStatus(value, fallback = 'hidden') {
  const normalized = String(value || '').toLowerCase();
  return VALID_FEED_STATUS.has(normalized) ? normalized : fallback;
}

function normalizeNoteVisibility(value, fallback = 'private') {
  const normalized = String(value || '').toLowerCase();
  return VALID_NOTE_VISIBILITY.has(normalized) ? normalized : fallback;
}

function normalizeFeedManagementStatus(value) {
  const normalized = String(value || 'all').trim().toLowerCase();
  return VALID_FEED_MANAGEMENT_STATUS.has(normalized) ? normalized : 'all';
}

function normalizeFeedBatchAction(value) {
  const normalized = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  const aliases = {
    clearapproved: 'clear-approved',
    'clear-all': 'clear-approved',
    'cancel-all': 'clear-approved',
    'cancel-approved': 'clear-approved',
    cancel: 'hide',
    remove: 'hide',
    disable: 'hide',
  };
  const action = aliases[normalized] || normalized;
  return VALID_FEED_BATCH_ACTION.has(action) ? action : '';
}

function normalizeIdList(ids = []) {
  const input = Array.isArray(ids) ? ids : [ids];
  return [...new Set(input.map(id => String(id || '').trim()).filter(Boolean))].slice(0, 500);
}

function mediaTypeFromMime(mimeType = '') {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.includes('pdf') || mt.includes('document') || mt.includes('text') || mt.includes('sheet') || mt.includes('presentation')) return 'document';
  return 'other';
}

function stringifyTags(tags) {
  if (Array.isArray(tags)) return JSON.stringify(tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 20));
  if (typeof tags === 'string') {
    const parsed = tags.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20);
    return JSON.stringify(parsed);
  }
  return JSON.stringify([]);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseRawRecord(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRecord(record = {}) {
  const id = String(record.id || path.basename(record.filename || record.storedName || crypto.randomUUID(), path.extname(record.filename || record.storedName || ''))).slice(0, 80);
  const filename = String(record.filename || record.storedName || `${id}`).slice(0, 240);
  const storedName = String(record.storedName || filename).slice(0, 240);
  const mimeType = String(record.mimeType || record.mimetype || 'application/octet-stream');
  const uploadTime = record.uploadTime || record.createdAt || nowIso();
  const lastAccessTime = record.lastAccessTime || uploadTime;
  const visibility = normalizeVisibility(record.visibility, 'unlisted');
  const allowFeed = Boolean(record.allowFeed || record.allow_feed);
  const feedStatus = normalizeFeedStatus(record.feedStatus || record.feed_status, allowFeed ? 'pending' : 'hidden');
  const tags = Array.isArray(record.tags) ? record.tags : parseJsonArray(record.tagsJson || record.tags_json);

  return {
    id,
    originalName: String(record.originalName || record.original_name || filename),
    filename,
    storedName,
    storagePath: record.storagePath || record.storage_path || '',
    size: Number(record.size || 0),
    mimeType,
    mediaType: record.mediaType || record.media_type || mediaTypeFromMime(mimeType),
    uploadTier: record.uploadTier || record.upload_tier || 'public',
    uploaderIp: record.uploaderIp || record.uploader_ip || '',
    visibility,
    allowFeed,
    feedStatus,
    status: record.status || 'active',
    title: record.title || '',
    description: record.description || '',
    tags,
    posterPath: record.posterPath || record.poster_path || '',
    durationSeconds: Number(record.durationSeconds || record.duration_seconds || 0),
    width: Number(record.width || 0),
    height: Number(record.height || 0),
    uploadTime,
    uploadDate: record.uploadDate || record.upload_date || (String(uploadTime).split('T')[0] || ''),
    uploadYear: Number(record.uploadYear || record.upload_year || 0),
    uploadMonth: Number(record.uploadMonth || record.upload_month || 0),
    uploadDay: Number(record.uploadDay || record.upload_day || 0),
    lastAccessTime,
    expiresAt: record.expiresAt || record.expires_at || '',
    accessCount: Number(record.accessCount || record.access_count || 0),
    createdAt: record.createdAt || record.created_at || uploadTime,
    updatedAt: record.updatedAt || record.updated_at || nowIso(),
    rawRecord: { ...record },
  };
}

function rowToFile(row) {
  if (!row) return null;
  const raw = parseRawRecord(row.raw_record);
  return {
    ...raw,
    id: row.id,
    originalName: row.original_name,
    filename: row.filename,
    storedName: row.stored_name,
    storagePath: row.storage_path || '',
    size: Number(row.size || 0),
    mimeType: row.mime_type,
    mediaType: row.media_type,
    uploadTier: row.upload_tier,
    uploaderIp: row.uploader_ip || raw.uploaderIp,
    visibility: row.visibility,
    allowFeed: fromBoolInt(row.allow_feed),
    feedStatus: row.feed_status,
    status: row.status,
    title: row.title || '',
    description: row.description || '',
    tags: parseJsonArray(row.tags_json),
    posterPath: row.poster_path || '',
    durationSeconds: Number(row.duration_seconds || 0),
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    uploadTime: row.upload_time,
    uploadDate: row.upload_date || raw.uploadDate,
    uploadYear: Number(row.upload_year || raw.uploadYear || 0),
    uploadMonth: Number(row.upload_month || raw.uploadMonth || 0),
    uploadDay: Number(row.upload_day || raw.uploadDay || 0),
    lastAccessTime: row.last_access_time,
    expiresAt: row.expires_at,
    accessCount: Number(row.access_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    fileId: row.file_id || '',
    title: row.title || '',
    content: row.content || '',
    contentFormat: row.content_format || 'markdown',
    visibility: row.visibility || 'private',
    pinned: fromBoolInt(row.pinned),
    tags: parseJsonArray(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || '',
  };
}

function rowToNoteRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    noteId: row.note_id,
    revision: Number(row.revision || 0),
    action: row.action || 'updated',
    fileId: row.file_id || '',
    title: row.title || '',
    content: row.content || '',
    contentFormat: row.content_format || 'markdown',
    visibility: row.visibility || 'private',
    pinned: fromBoolInt(row.pinned),
    tags: parseJsonArray(row.tags_json),
    createdAt: row.created_at,
    noteCreatedAt: row.note_created_at || '',
    noteUpdatedAt: row.note_updated_at || '',
    deletedAt: row.deleted_at || '',
  };
}

function ensureParentDir(filename) {
  if (!filename || filename === ':memory:') return;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

export function createContentDb({ filename = ':memory:' } = {}) {
  ensureParentDir(filename);
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      stored_name TEXT NOT NULL,
      storage_path TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      mime_type TEXT DEFAULT 'application/octet-stream',
      media_type TEXT DEFAULT 'other',
      upload_tier TEXT DEFAULT 'public',
      uploader_ip TEXT DEFAULT '',
      visibility TEXT DEFAULT 'unlisted',
      allow_feed INTEGER DEFAULT 0,
      feed_status TEXT DEFAULT 'hidden',
      status TEXT DEFAULT 'active',
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      tags_json TEXT DEFAULT '[]',
      poster_path TEXT DEFAULT '',
      duration_seconds REAL DEFAULT 0,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      upload_time TEXT DEFAULT '',
      upload_date TEXT DEFAULT '',
      upload_year INTEGER DEFAULT 0,
      upload_month INTEGER DEFAULT 0,
      upload_day INTEGER DEFAULT 0,
      last_access_time TEXT DEFAULT '',
      expires_at TEXT DEFAULT '',
      access_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      raw_record TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_files_upload_time ON files(upload_time DESC);
    CREATE INDEX IF NOT EXISTS idx_files_media_feed ON files(media_type, allow_feed, feed_status, status, upload_time DESC);
    CREATE INDEX IF NOT EXISTS idx_files_visibility ON files(visibility, status);
    CREATE INDEX IF NOT EXISTS idx_files_stored_name ON files(stored_name);
    CREATE INDEX IF NOT EXISTS idx_files_admin_feed ON files(status, media_type, feed_status, allow_feed, visibility, upload_time DESC);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      file_id TEXT DEFAULT NULL,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      content_format TEXT DEFAULT 'markdown',
      visibility TEXT DEFAULT 'private',
      pinned INTEGER DEFAULT 0,
      tags_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      deleted_at TEXT DEFAULT '',
      FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_file ON notes(file_id, visibility, created_at DESC);

    CREATE TABLE IF NOT EXISTS note_revisions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      action TEXT DEFAULT 'updated',
      file_id TEXT DEFAULT NULL,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      content_format TEXT DEFAULT 'markdown',
      visibility TEXT DEFAULT 'private',
      pinned INTEGER DEFAULT 0,
      tags_json TEXT DEFAULT '[]',
      note_created_at TEXT DEFAULT '',
      note_updated_at TEXT DEFAULT '',
      deleted_at TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      UNIQUE(note_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions(note_id, revision ASC);
  `);

  const upsertStmt = sqlite.prepare(`
    INSERT INTO files (
      id, original_name, filename, stored_name, storage_path, size, mime_type, media_type,
      upload_tier, uploader_ip, visibility, allow_feed, feed_status, status, title, description,
      tags_json, poster_path, duration_seconds, width, height, upload_time, upload_date,
      upload_year, upload_month, upload_day, last_access_time, expires_at, access_count,
      created_at, updated_at, raw_record
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      original_name=excluded.original_name,
      filename=excluded.filename,
      stored_name=excluded.stored_name,
      storage_path=excluded.storage_path,
      size=excluded.size,
      mime_type=excluded.mime_type,
      media_type=excluded.media_type,
      upload_tier=excluded.upload_tier,
      uploader_ip=excluded.uploader_ip,
      visibility=excluded.visibility,
      allow_feed=excluded.allow_feed,
      feed_status=excluded.feed_status,
      status=excluded.status,
      title=excluded.title,
      description=excluded.description,
      tags_json=excluded.tags_json,
      poster_path=excluded.poster_path,
      duration_seconds=excluded.duration_seconds,
      width=excluded.width,
      height=excluded.height,
      upload_time=excluded.upload_time,
      upload_date=excluded.upload_date,
      upload_year=excluded.upload_year,
      upload_month=excluded.upload_month,
      upload_day=excluded.upload_day,
      last_access_time=excluded.last_access_time,
      expires_at=excluded.expires_at,
      access_count=excluded.access_count,
      updated_at=excluded.updated_at,
      raw_record=excluded.raw_record
  `);

  function upsertFile(record = {}) {
    const normalized = normalizeRecord(record);
    const rawRecord = {
      ...normalized.rawRecord,
      visibility: normalized.visibility,
      allowFeed: normalized.allowFeed,
      feedStatus: normalized.feedStatus,
      status: normalized.status,
      title: normalized.title,
      description: normalized.description,
      tags: normalized.tags,
      mediaType: normalized.mediaType,
    };
    upsertStmt.run(
      normalized.id,
      normalized.originalName,
      normalized.filename,
      normalized.storedName,
      normalized.storagePath,
      normalized.size,
      normalized.mimeType,
      normalized.mediaType,
      normalized.uploadTier,
      normalized.uploaderIp,
      normalized.visibility,
      boolInt(normalized.allowFeed),
      normalized.feedStatus,
      normalized.status,
      normalized.title,
      normalized.description,
      stringifyTags(normalized.tags),
      normalized.posterPath,
      normalized.durationSeconds,
      normalized.width,
      normalized.height,
      normalized.uploadTime,
      normalized.uploadDate,
      normalized.uploadYear,
      normalized.uploadMonth,
      normalized.uploadDay,
      normalized.lastAccessTime,
      normalized.expiresAt,
      normalized.accessCount,
      normalized.createdAt,
      normalized.updatedAt,
      JSON.stringify(rawRecord)
    );
    return getFileById(normalized.id);
  }

  function importFileIndex(fileIndex = {}, { overwriteExisting = false } = {}) {
    let inserted = 0;
    let updated = 0;
    let skippedExisting = 0;
    const existsStmt = sqlite.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?');
    for (const [key, record] of Object.entries(fileIndex || {})) {
      const normalized = normalizeRecord({ filename: key, ...record });
      const exists = Number(existsStmt.get(normalized.id)?.count || 0) > 0;
      if (exists && !overwriteExisting) {
        skippedExisting += 1;
        continue;
      }
      upsertFile(normalized);
      if (exists) updated += 1;
      else inserted += 1;
    }
    return { inserted, updated, skippedExisting };
  }

  function getFileById(id) {
    const row = sqlite.prepare('SELECT * FROM files WHERE id = ? OR filename = ? OR stored_name = ? LIMIT 1').get(id, id, id);
    return rowToFile(row);
  }

  function listFiles({ page = 1, limit = 50, search = '', type = '', sort = 'latest', includeDeleted = false } = {}) {
    const conditions = [];
    const params = [];
    if (!includeDeleted) conditions.push("status = 'active'");
    if (search) {
      conditions.push('(LOWER(original_name) LIKE ? OR LOWER(id) LIKE ? OR LOWER(filename) LIKE ?)');
      const like = `%${String(search).toLowerCase()}%`;
      params.push(like, like, like);
    }
    if (type) {
      if (type === 'image') conditions.push("media_type = 'image'");
      else if (type === 'video') conditions.push("media_type = 'video'");
      else if (type === 'audio') conditions.push("media_type = 'audio'");
      else if (type === 'document') conditions.push("media_type = 'document'");
      else if (type === 'other') conditions.push("media_type = 'other'");
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safePage = Math.max(Number(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const total = Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM files ${where}`).get(...params).total || 0);
    const sortOrders = {
      latest: 'upload_time DESC',
      access: 'access_count DESC, upload_time DESC',
      expiring: "CASE WHEN expires_at IS NULL OR expires_at = '' THEN 1 ELSE 0 END ASC, expires_at ASC, upload_time DESC",
      largest: 'size DESC, upload_time DESC',
      recommended: "CASE WHEN allow_feed = 1 AND feed_status = 'approved' AND visibility = 'public' THEN 0 WHEN allow_feed = 1 THEN 1 ELSE 2 END ASC, upload_time DESC",
    };
    const orderBy = sortOrders[String(sort || 'latest')] || sortOrders.latest;
    const rows = sqlite.prepare(`SELECT * FROM files ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, safeLimit, offset);
    return {
      files: rows.map(rowToFile),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.max(Math.ceil(total / safeLimit), 1) },
    };
  }

  function allActiveFiles() {
    return sqlite.prepare("SELECT * FROM files WHERE status = 'active' ORDER BY upload_time DESC").all().map(rowToFile);
  }

  function updateFeedSettings(id, settings = {}) {
    const existing = getFileById(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      visibility: normalizeVisibility(settings.visibility, existing.visibility || 'unlisted'),
      allowFeed: settings.allowFeed === undefined ? existing.allowFeed : Boolean(settings.allowFeed),
      feedStatus: normalizeFeedStatus(settings.feedStatus, existing.feedStatus || 'hidden'),
      title: settings.title === undefined ? existing.title : String(settings.title || '').slice(0, 180),
      description: settings.description === undefined ? existing.description : String(settings.description || '').slice(0, 2000),
      tags: settings.tags === undefined ? existing.tags : (Array.isArray(settings.tags) ? settings.tags : String(settings.tags || '').split(',')),
      updatedAt: nowIso(),
    };
    if (!updated.allowFeed) updated.feedStatus = 'hidden';
    return upsertFile(updated);
  }

  function touchFile(id, patch = {}) {
    const existing = getFileById(id);
    if (!existing) return null;
    return upsertFile({ ...existing, ...patch, updatedAt: nowIso() });
  }

  function deleteFile(id) {
    const existing = getFileById(id);
    if (!existing) return false;
    sqlite.prepare("UPDATE files SET status = 'deleted', updated_at = ? WHERE id = ?").run(nowIso(), existing.id);
    return true;
  }

  function hardDeleteFile(id) {
    const existing = getFileById(id);
    if (!existing) return false;
    sqlite.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
    return true;
  }

  function listFeedVideos({ limit = 10, cursor = '' } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const params = [];
    let cursorSql = '';
    if (cursor) {
      cursorSql = 'AND upload_time < ?';
      params.push(cursor);
    }
    const rows = sqlite.prepare(`
      SELECT * FROM files
      WHERE status = 'active'
        AND media_type = 'video'
        AND allow_feed = 1
        AND feed_status = 'approved'
        AND visibility = 'public'
        AND (expires_at = '' OR expires_at > datetime('now'))
        ${cursorSql}
      ORDER BY upload_time DESC
      LIMIT ?
    `).all(...params, safeLimit);
    const videos = rows.map(rowToFile);
    const nextCursor = videos.length === safeLimit ? videos[videos.length - 1].uploadTime : '';
    return { videos, nextCursor };
  }

  function appendFeedManagementStatusCondition(conditions, params, feedStatus) {
    if (feedStatus === 'approved') conditions.push("allow_feed = 1 AND feed_status = 'approved' AND visibility = 'public'");
    else if (feedStatus === 'pending') conditions.push("allow_feed = 1 AND feed_status = 'pending'");
    else if (feedStatus === 'rejected') conditions.push("feed_status = 'rejected'");
    else if (feedStatus === 'hidden') conditions.push("(allow_feed = 0 OR feed_status = 'hidden')");
  }

  function buildFeedManagementBase({ search = '' } = {}) {
    const conditions = ["status = 'active'", "media_type = 'video'"];
    const params = [];
    if (search) {
      conditions.push('(LOWER(original_name) LIKE ? OR LOWER(id) LIKE ? OR LOWER(filename) LIKE ? OR LOWER(title) LIKE ?)');
      const like = `%${String(search).toLowerCase()}%`;
      params.push(like, like, like, like);
    }
    return { conditions, params };
  }

  function listFeedManagementVideos({ page = 1, limit = 80, feedStatus = 'all', search = '' } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 200);
    const safePage = Math.max(Number(page) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const normalizedStatus = normalizeFeedManagementStatus(feedStatus);
    const base = buildFeedManagementBase({ search });
    const summaryWhere = `WHERE ${base.conditions.join(' AND ')}`;
    const summaryRow = sqlite.prepare(`
      SELECT
        COUNT(*) AS totalVideos,
        SUM(CASE WHEN allow_feed = 1 AND feed_status = 'approved' AND visibility = 'public' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN allow_feed = 1 AND feed_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN feed_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN allow_feed = 0 OR feed_status = 'hidden' THEN 1 ELSE 0 END) AS hidden
      FROM files ${summaryWhere}
    `).get(...base.params);

    const listConditions = [...base.conditions];
    const listParams = [...base.params];
    appendFeedManagementStatusCondition(listConditions, listParams, normalizedStatus);
    const where = `WHERE ${listConditions.join(' AND ')}`;
    const total = Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM files ${where}`).get(...listParams).total || 0);
    const rows = sqlite.prepare(`SELECT * FROM files ${where} ORDER BY upload_time DESC LIMIT ? OFFSET ?`).all(...listParams, safeLimit, offset);

    return {
      files: rows.map(rowToFile),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.max(Math.ceil(total / safeLimit), 1) },
      summary: {
        totalVideos: Number(summaryRow.totalVideos || 0),
        approved: Number(summaryRow.approved || 0),
        pending: Number(summaryRow.pending || 0),
        rejected: Number(summaryRow.rejected || 0),
        hidden: Number(summaryRow.hidden || 0),
      },
    };
  }

  function bulkUpdateFeed({ action = '', ids = [] } = {}) {
    const normalizedAction = normalizeFeedBatchAction(action);
    if (!normalizedAction) throw new Error('Invalid feed batch action');
    const now = nowIso();
    let sql = '';
    let params = [];

    if (normalizedAction === 'clear-approved') {
      sql = `
        UPDATE files
        SET visibility = 'unlisted', allow_feed = 0, feed_status = 'hidden', updated_at = ?
        WHERE status = 'active'
          AND media_type = 'video'
          AND allow_feed = 1
          AND feed_status = 'approved'
      `;
      params = [now];
    } else {
      const normalizedIds = normalizeIdList(ids);
      if (normalizedIds.length === 0) return { action: normalizedAction, matched: 0, updated: 0 };
      const placeholders = normalizedIds.map(() => '?').join(', ');
      const sets = {
        approve: "visibility = 'public', allow_feed = 1, feed_status = 'approved'",
        hide: "visibility = 'unlisted', allow_feed = 0, feed_status = 'hidden'",
        reject: "visibility = 'unlisted', allow_feed = 1, feed_status = 'rejected'",
      };
      sql = `
        UPDATE files
        SET ${sets[normalizedAction]}, updated_at = ?
        WHERE status = 'active'
          AND media_type = 'video'
          AND id IN (${placeholders})
      `;
      params = [now, ...normalizedIds];
    }

    const result = sqlite.prepare(sql).run(...params);
    return { action: normalizedAction, matched: Number(result.changes || 0), updated: Number(result.changes || 0) };
  }

  function appendNoteRevision(note, action = 'updated') {
    if (!note?.id) return null;
    const row = sqlite.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM note_revisions WHERE note_id = ?').get(note.id);
    const revision = Number(row?.revision || 1);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const iso = nowIso();
    sqlite.prepare(`
      INSERT INTO note_revisions (
        id, note_id, revision, action, file_id, title, content, content_format,
        visibility, pinned, tags_json, note_created_at, note_updated_at, deleted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      note.id,
      revision,
      String(action || 'updated'),
      note.fileId ? String(note.fileId) : null,
      String(note.title || '').slice(0, 180),
      String(note.content || '').slice(0, 20000),
      String(note.contentFormat || 'markdown'),
      normalizeNoteVisibility(note.visibility),
      boolInt(note.pinned),
      stringifyTags(note.tags),
      note.createdAt || '',
      note.updatedAt || '',
      note.deletedAt || '',
      iso
    );
    return rowToNoteRevision(sqlite.prepare('SELECT * FROM note_revisions WHERE id = ?').get(id));
  }

  function createNote({ fileId = '', title = '', content = '', contentFormat = 'markdown', visibility = 'private', pinned = false, tags = [] } = {}) {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const iso = nowIso();
    sqlite.prepare(`
      INSERT INTO notes (id, file_id, title, content, content_format, visibility, pinned, tags_json, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    `).run(
      id,
      fileId ? String(fileId) : null,
      String(title || '').slice(0, 180),
      String(content || '').slice(0, 20000),
      String(contentFormat || 'markdown'),
      normalizeNoteVisibility(visibility),
      boolInt(pinned),
      stringifyTags(tags),
      iso,
      iso
    );
    const note = getNote(id);
    appendNoteRevision(note, 'created');
    return note;
  }

  function getNote(id) {
    return rowToNote(sqlite.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at = ?').get(id, ''));
  }

  function listNotes({ fileId = '', includePrivate = false, limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const conditions = ["deleted_at = ''"];
    const params = [];
    if (fileId) {
      conditions.push('file_id = ?');
      params.push(fileId);
    }
    if (!includePrivate) conditions.push("visibility = 'public'");
    const rows = sqlite.prepare(`SELECT * FROM notes WHERE ${conditions.join(' AND ')} ORDER BY pinned DESC, created_at DESC LIMIT ?`).all(...params, safeLimit);
    return { notes: rows.map(rowToNote) };
  }

  function updateNote(id, patch = {}) {
    const existing = getNote(id);
    if (!existing) return null;
    const updatedAt = nowIso();
    const next = {
      ...existing,
      title: patch.title === undefined ? existing.title : String(patch.title || '').slice(0, 180),
      content: patch.content === undefined ? existing.content : String(patch.content || '').slice(0, 20000),
      contentFormat: patch.contentFormat === undefined ? existing.contentFormat : String(patch.contentFormat || 'markdown'),
      visibility: patch.visibility === undefined ? existing.visibility : normalizeNoteVisibility(patch.visibility),
      pinned: patch.pinned === undefined ? existing.pinned : Boolean(patch.pinned),
      tags: patch.tags === undefined ? existing.tags : (Array.isArray(patch.tags) ? patch.tags : String(patch.tags || '').split(',')),
      updatedAt,
    };
    sqlite.prepare(`
      UPDATE notes
      SET title = ?, content = ?, content_format = ?, visibility = ?, pinned = ?, tags_json = ?, updated_at = ?
      WHERE id = ? AND deleted_at = ''
    `).run(
      next.title,
      next.content,
      next.contentFormat,
      next.visibility,
      boolInt(next.pinned),
      stringifyTags(next.tags),
      updatedAt,
      existing.id
    );
    const updated = getNote(existing.id);
    appendNoteRevision(updated, 'updated');
    return updated;
  }

  function listNoteHistory(id, { includeDeleted = false } = {}) {
    const rows = sqlite.prepare('SELECT * FROM note_revisions WHERE note_id = ? ORDER BY revision ASC').all(id);
    const history = rows.map(rowToNoteRevision).filter(Boolean);
    if (!includeDeleted) return { history: history.filter(item => item.action !== 'deleted') };
    return { history };
  }

  function deleteNote(id) {
    const existing = getNote(id);
    if (!existing) return false;
    const deletedAt = nowIso();
    const result = sqlite.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at = ?').run(deletedAt, deletedAt, id, '');
    const deleted = Number(result.changes || 0) > 0;
    if (deleted) appendNoteRevision({ ...existing, updatedAt: deletedAt, deletedAt }, 'deleted');
    return deleted;
  }

  function stats() {
    const row = sqlite.prepare(`
      SELECT
        COUNT(*) AS totalFiles,
        COALESCE(SUM(size), 0) AS totalSize,
        COALESCE(SUM(access_count), 0) AS totalAccessCount,
        SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS imageCount,
        SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videoCount,
        SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END) AS audioCount,
        SUM(CASE WHEN allow_feed = 1 AND feed_status = 'approved' AND visibility = 'public' AND media_type = 'video' THEN 1 ELSE 0 END) AS feedVideoCount
      FROM files
      WHERE status = 'active'
    `).get();
    const totalFiles = Number(row.totalFiles || 0);
    const imageCount = Number(row.imageCount || 0);
    const videoCount = Number(row.videoCount || 0);
    const audioCount = Number(row.audioCount || 0);
    return {
      totalFiles,
      totalSize: Number(row.totalSize || 0),
      totalAccessCount: Number(row.totalAccessCount || 0),
      imageCount,
      videoCount,
      audioCount,
      otherCount: totalFiles - imageCount - videoCount - audioCount,
      feedVideoCount: Number(row.feedVideoCount || 0),
    };
  }

  return {
    sqlite,
    importFileIndex,
    upsertFile,
    getFileById,
    listFiles,
    allActiveFiles,
    updateFeedSettings,
    touchFile,
    deleteFile,
    hardDeleteFile,
    listFeedVideos,
    listFeedManagementVideos,
    bulkUpdateFeed,
    createNote,
    getNote,
    listNotes,
    updateNote,
    listNoteHistory,
    deleteNote,
    stats,
    close: () => sqlite.close(),
  };
}

export { mediaTypeFromMime, normalizeRecord };
