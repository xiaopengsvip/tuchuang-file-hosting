import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const VALID_VISIBILITY = new Set(['private', 'unlisted', 'public']);
const VALID_FEED_STATUS = new Set(['hidden', 'pending', 'approved', 'rejected']);
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

  function importFileIndex(fileIndex = {}) {
    let inserted = 0;
    let updated = 0;
    const tx = sqlite.prepare('SELECT COUNT(*) AS count FROM files WHERE id = ?');
    for (const [key, record] of Object.entries(fileIndex || {})) {
      const normalized = normalizeRecord({ filename: key, ...record });
      const exists = Number(tx.get(normalized.id)?.count || 0) > 0;
      upsertFile(normalized);
      if (exists) updated += 1;
      else inserted += 1;
    }
    return { inserted, updated };
  }

  function getFileById(id) {
    const row = sqlite.prepare('SELECT * FROM files WHERE id = ? OR filename = ? OR stored_name = ? LIMIT 1').get(id, id, id);
    return rowToFile(row);
  }

  function listFiles({ page = 1, limit = 50, search = '', type = '', includeDeleted = false } = {}) {
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
    const rows = sqlite.prepare(`SELECT * FROM files ${where} ORDER BY upload_time DESC LIMIT ? OFFSET ?`).all(...params, safeLimit, offset);
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
    return getNote(id);
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

  function deleteNote(id) {
    const result = sqlite.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at = ?').run(nowIso(), nowIso(), id, '');
    return Number(result.changes || 0) > 0;
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
        SUM(CASE WHEN allow_feed = 1 AND feed_status = 'approved' AND media_type = 'video' THEN 1 ELSE 0 END) AS feedVideoCount
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
    createNote,
    getNote,
    listNotes,
    deleteNote,
    stats,
    close: () => sqlite.close(),
  };
}

export { mediaTypeFromMime, normalizeRecord };
