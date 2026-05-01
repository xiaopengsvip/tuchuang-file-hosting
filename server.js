import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import {
  DEFAULT_MAX_FILE_MB,
  PUBLIC_MAX_FILE_MB,
  ADMIN_MAX_FILE_MB,
  FILE_EXPIRY_DAYS,
  buildFileRecord,
  cleanupExpiredRecords,
  ensureLifecycleFields,
  touchRecord
} from './src/fileLifecycle.js';
import { sanitizePublicRecord } from './src/accessPolicy.js';
import { normalizeFileIndexNames, normalizeOriginalName } from './src/filenameEncoding.js';
import {
  DEFAULT_CHUNK_SIZE,
  buildUploadManifest,
  chunkFilename,
  getMissingChunks,
  getReceivedChunks,
  validateChunkIndex
} from './src/resumableUpload.js';
import {
  BYTES_PER_MB,
  getContentDispositionForMimeType,
  isDangerousInlineMimeType,
  safeTokenEquals
} from './src/uploadPolicy.js';
import { getPreviewKind } from './src/previewPolicy.js';
import { createUploadLogger, errorMessage, buildSimpleUploadAccessEvent } from './src/uploadLogger.js';
import { createIpRateLimiter } from './src/rateLimit.js';
import { createContentDb } from './src/contentDb.js';
import { applyUploadFeedPreference, isFeedPreferenceRequested } from './src/feedPolicy.js';
import {
  moderateUploadCandidate,
  moderationErrorPayload,
  readTextSampleForModeration
} from './src/contentModeration.js';
import {
  buildMediaModerationConfig,
  moderateMediaFile,
  publishQuarantinedFile
} from './src/mediaModeration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const PORT = Number(process.env.PORT || 8765);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const QUARANTINE_DIR = process.env.QUARANTINE_DIR || path.join(UPLOAD_DIR, '.quarantine');
const BASE_URL = process.env.BASE_URL || 'https://tuchuang.allapple.top';
const SHORT_BASE_URL = process.env.SHORT_BASE_URL || 'https://tc.allapple.top';
const ADMIN_TOKEN = process.env.TUCHUANG_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '';
const PUBLIC_UPLOAD_MAX_FILE_MB = Number(process.env.PUBLIC_MAX_FILE_MB || PUBLIC_MAX_FILE_MB || DEFAULT_MAX_FILE_MB);
const ADMIN_UPLOAD_MAX_FILE_MB = Number(process.env.ADMIN_MAX_FILE_MB || process.env.MAX_FILE_MB || ADMIN_MAX_FILE_MB);
const MAX_FILES = Number(process.env.MAX_FILES || 50);
const INDEX_FILE = process.env.INDEX_FILE || path.join(__dirname, 'file-index.json');
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const CHUNK_SESSION_TTL_MS = Number(process.env.CHUNK_SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const RESUMABLE_CHUNK_SIZE = Number(process.env.RESUMABLE_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
const RESUMABLE_CHUNK_MB = Math.ceil(RESUMABLE_CHUNK_SIZE / 1024 / 1024) + 1;
const CHUNK_DIR = process.env.CHUNK_DIR || path.join(UPLOAD_DIR, '.chunks');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'tuchuang.sqlite');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
fs.mkdirSync(CHUNK_DIR, { recursive: true });
const MEDIA_MODERATION_CONFIG = buildMediaModerationConfig(process.env);
const uploadLogger = createUploadLogger({ logDir: LOG_DIR });
const uploadLogRateLimit = createIpRateLimiter({ windowMs: 60 * 1000, max: 60, keyPrefix: 'upload-log' });

let fileIndex = {};
if (fs.existsSync(INDEX_FILE)) {
  try {
    fileIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch (e) {
    console.error('[Tuchuang] Failed to read file-index.json, starting empty:', e.message);
    fileIndex = {};
  }
}

function saveIndex() {
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fileIndex, null, 2));
  fs.renameSync(tmp, INDEX_FILE);
}

function safeName(name = 'file') {
  return String(name)
    .replace(/[\\/\0\r\n]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 180) || 'file';
}

function escapeHtml(input = '') {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requestToken(req) {
  return req.get('x-admin-token') || req.query.token || '';
}

function isAuthed(req) {
  if (!ADMIN_TOKEN) return false;
  return safeTokenEquals(requestToken(req), ADMIN_TOKEN);
}

function requireAdmin(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ success: false, error: 'ADMIN_TOKEN required' });
}

function getUploadLimit(req) {
  const tier = isAuthed(req) ? 'admin' : 'public';
  const maxFileMB = tier === 'admin' ? ADMIN_UPLOAD_MAX_FILE_MB : PUBLIC_UPLOAD_MAX_FILE_MB;
  return {
    tier,
    maxFileMB,
    maxFileGB: maxFileMB / 1024,
    maxFileBytes: maxFileMB * BYTES_PER_MB,
    publicMaxFileMB: PUBLIC_UPLOAD_MAX_FILE_MB,
    adminMaxFileMB: ADMIN_UPLOAD_MAX_FILE_MB
  };
}

function uploadFeedRequested(input = {}) {
  return isFeedPreferenceRequested(input.feedPreference ?? input.allowFeed ?? input.allow_feed ?? input.requestFeed);
}

function applyUploadFeedFields(record, { requested = false, isAdmin = false } = {}) {
  return applyUploadFeedPreference(record, { requested, isAdmin });
}

function addSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://tuchuang.allapple.top https://tc.allapple.top; media-src 'self' blob: https://tuchuang.allapple.top https://tc.allapple.top; connect-src 'self' https://cloudflareinsights.com; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
}

function sessionDir(uploadId) {
  return path.join(CHUNK_DIR, safeName(uploadId));
}

function manifestPath(uploadId) {
  return path.join(sessionDir(uploadId), 'manifest.json');
}

function readManifest(uploadId) {
  const file = manifestPath(uploadId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeManifest(manifest) {
  const dir = sessionDir(manifest.uploadId);
  fs.mkdirSync(dir, { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath(manifest.uploadId), JSON.stringify(manifest, null, 2));
}

function getUploadStatus(manifest) {
  const dir = sessionDir(manifest.uploadId);
  const receivedChunks = fs.existsSync(dir) ? getReceivedChunks(fs.readdirSync(dir)) : [];
  const missingChunks = getMissingChunks(manifest.totalChunks, receivedChunks);
  const uploadedBytes = receivedChunks.reduce((sum, index) => {
    const p = path.join(dir, chunkFilename(index));
    return sum + (fs.existsSync(p) ? fs.statSync(p).size : 0);
  }, 0);
  return {
    uploadId: manifest.uploadId,
    uploadTier: manifest.uploadTier || 'public',
    maxFileMB: manifest.maxFileMB,
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    receivedChunks,
    missingChunks,
    uploadedBytes,
    size: manifest.size,
    complete: Boolean(manifest.complete),
    file: manifest.file || null
  };
}

function removeChunkSession(uploadId) {
  fs.rmSync(sessionDir(uploadId), { recursive: true, force: true });
}

function removeUploadedChunks(uploadId) {
  const dir = sessionDir(uploadId);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (/^chunk-\d{6}\.part$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

function cleanupChunkSessions(now = Date.now()) {
  if (!fs.existsSync(CHUNK_DIR)) return { deleted: 0, kept: 0, errors: [] };
  const result = { deleted: 0, kept: 0, errors: [] };
  for (const entry of fs.readdirSync(CHUNK_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CHUNK_DIR, entry.name);
    const manifestFile = path.join(dir, 'manifest.json');
    try {
      const stat = fs.existsSync(manifestFile) ? fs.statSync(manifestFile) : fs.statSync(dir);
      const age = now - stat.mtimeMs;
      if (age >= CHUNK_SESSION_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        result.deleted += 1;
      } else {
        result.kept += 1;
      }
    } catch (err) {
      result.errors.push({ session: entry.name, error: err?.message || String(err) });
    }
  }
  return result;
}

function getRecordById(id) {
  const dbRecord = contentDb.getFileById(id);
  if (dbRecord) return dbRecord;
  const legacyRecord = Object.values(fileIndex).find(f => f.id === id || f.filename === id || f.storedName === id);
  return legacyRecord ? contentDb.upsertFile(legacyRecord) : null;
}

function publicRecord(record, req) {
  const host = req.get('host') || '';
  const currentBase = host ? `${req.protocol}://${host}` : '';
  const isTuchuangHost = host.includes('tuchuang.allapple.top');
  const isShortHost = host.includes('tc.allapple.top');
  const primaryBase = isTuchuangHost ? currentBase : BASE_URL;
  const shortBase = isShortHost ? currentBase : SHORT_BASE_URL;
  const previewBase = (isTuchuangHost || isShortHost) ? currentBase : primaryBase;
  const originalName = record.originalName || record.filename;
  return sanitizePublicRecord({
    ...record,
    previewUrl: `${previewBase}/preview/${encodeURIComponent(record.id)}`,
    url: `${primaryBase}/f/${encodeURIComponent(record.id)}/${encodeURIComponent(originalName)}`,
    directUrl: `${primaryBase}/raw/${encodeURIComponent(record.id)}`,
    shortUrl: `${shortBase}/s/${encodeURIComponent(record.id)}`,
    markdown: (record.mimeType || '').startsWith('image/')
      ? `![${originalName.replace(/]/g, '\\]')}](${primaryBase}/f/${encodeURIComponent(record.id)}/${encodeURIComponent(originalName)})`
      : `[${originalName.replace(/]/g, '\\]')}](${primaryBase}/f/${encodeURIComponent(record.id)}/${encodeURIComponent(originalName)})`,
    expireAfterIdleDays: FILE_EXPIRY_DAYS
  });
}

// migrate old records once at boot
let migrated = false;
for (const [key, rec] of Object.entries(fileIndex)) {
  if (!rec.id) {
    rec.id = path.basename(rec.filename || key, path.extname(rec.filename || key));
    migrated = true;
  }
  if (!rec.storedName) {
    rec.storedName = rec.filename || key;
    migrated = true;
  }
  const beforeLifecycle = JSON.stringify({
    lastAccessTime: rec.lastAccessTime,
    expiresAt: rec.expiresAt,
    accessCount: rec.accessCount,
    uploadDate: rec.uploadDate,
    uploadYear: rec.uploadYear,
    uploadMonth: rec.uploadMonth,
    uploadDay: rec.uploadDay
  });
  ensureLifecycleFields(rec);
  const afterLifecycle = JSON.stringify({
    lastAccessTime: rec.lastAccessTime,
    expiresAt: rec.expiresAt,
    accessCount: rec.accessCount,
    uploadDate: rec.uploadDate,
    uploadYear: rec.uploadYear,
    uploadMonth: rec.uploadMonth,
    uploadDay: rec.uploadDay
  });
  if (beforeLifecycle !== afterLifecycle) migrated = true;
}
const nameMigration = normalizeFileIndexNames(fileIndex);
if (nameMigration.changed > 0) {
  migrated = true;
  console.log(`[Tuchuang] Normalized ${nameMigration.changed} filename(s)`);
}

const contentDb = createContentDb({ filename: DB_FILE });
const dbImport = contentDb.importFileIndex(fileIndex);
if (dbImport.inserted > 0 || dbImport.updated > 0) {
  console.log(`[Tuchuang] Metadata DB migration: ${dbImport.inserted} inserted, ${dbImport.updated} updated, ${dbImport.skippedExisting || 0} preserved`);
}

function syncRecordToDb(record) {
  if (!record) return null;
  return contentDb.upsertFile(record);
}

function syncRecordToIndex(record) {
  if (!record) return null;
  const key = record.filename || record.storedName || record.id;
  fileIndex[key] = { ...fileIndex[key], ...record };
  return fileIndex[key];
}

function runExpiryCleanup(reason = 'scheduled') {
  const activeFiles = contentDb.allActiveFiles();
  const cleanupIndex = Object.fromEntries(
    activeFiles.map(record => [record.filename || record.storedName || record.id, { ...record }])
  );
  const before = new Map(Object.values(cleanupIndex).map(record => [record.filename || record.storedName || record.id, record.id || record.filename]));
  const result = cleanupExpiredRecords({ fileIndex: cleanupIndex, uploadDir: UPLOAD_DIR });
  if (result.deleted > 0) {
    for (const [key, id] of before.entries()) {
      if (!cleanupIndex[key]) contentDb.deleteFile(id);
    }
    console.log(`[Tuchuang] Deleted ${result.deleted} expired file(s) from DB metadata (${reason})`);
  }
  if (result.errors?.length) {
    console.error('[Tuchuang] Expiry cleanup errors:', result.errors);
  }
  return result;
}

const bootCleanup = runExpiryCleanup('boot');
const bootChunkCleanup = cleanupChunkSessions();
if (bootChunkCleanup.deleted > 0) console.log(`[Tuchuang] Deleted ${bootChunkCleanup.deleted} stale upload session(s) (boot)`);
if (migrated && bootCleanup.deleted === 0) saveIndex();

const cleanupTimer = setInterval(() => {
  runExpiryCleanup('interval');
  const chunkResult = cleanupChunkSessions();
  if (chunkResult.deleted > 0) console.log(`[Tuchuang] Deleted ${chunkResult.deleted} stale upload session(s) (interval)`);
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, QUARANTINE_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const ext = path.extname(safeName(file.originalname)).slice(0, 32);
    cb(null, `${id}${ext}`);
  }
});

function makeUpload(maxFileMB) {
  return multer({
    storage,
    limits: { fileSize: maxFileMB * BYTES_PER_MB, files: MAX_FILES }
  });
}

const publicUpload = makeUpload(PUBLIC_UPLOAD_MAX_FILE_MB);
const adminUpload = makeUpload(ADMIN_UPLOAD_MAX_FILE_MB);

function uploadArrayForRequest(req, res, next) {
  const limit = getUploadLimit(req);
  req.uploadLimit = limit;
  const middleware = limit.tier === 'admin' ? adminUpload : publicUpload;
  return middleware.array('files', MAX_FILES)(req, res, next);
}

function markSimpleUploadStart(req, res, next) {
  req.simpleUploadStartedAt = Date.now();
  next();
}

function logSimpleUploadAccess(req, { status, files = [], error } = {}) {
  const limit = req.uploadLimit || getUploadLimit(req);
  return uploadLogger.log(buildSimpleUploadAccessEvent({
    status,
    files,
    error,
    uploadTier: limit.tier,
    maxFileMB: limit.maxFileMB,
    startedAt: req.simpleUploadStartedAt,
    now: Date.now()
  }), req);
}

function cleanupStoredUploadFiles(files = []) {
  for (const file of files) {
    if (file?.path) fs.rmSync(file.path, { force: true });
  }
}

function rejectModeratedRequest(res, result, extra = {}) {
  return res.status(451).json({ ...moderationErrorPayload(result), ...extra });
}

function logModerationBlock(req, { flow, categories, originalName } = {}) {
  return uploadLogger.log({
    event: 'content_moderation_blocked',
    level: 'warn',
    flow,
    categories,
    originalName,
  }, req);
}

function logMediaModerationUnavailable(req, { flow, originalName, error } = {}) {
  return uploadLogger.log({
    event: 'media_moderation_unavailable',
    level: 'warn',
    flow,
    originalName,
    error,
  }, req);
}

async function moderateStoredCandidate(req, { filePath, originalName, filename = '', mimeType = '', fields = {}, flow = 'upload' } = {}) {
  const textResult = moderateUploadCandidate({
    originalName,
    filename,
    mimeType,
    fields,
    textSample: readTextSampleForModeration(filePath, { mimeType, originalName })
  });
  if (textResult.blocked) {
    logModerationBlock(req, { flow, categories: textResult.categories, originalName });
    return textResult;
  }

  const mediaResult = await moderateMediaFile({
    filePath,
    originalName,
    mimeType,
    config: MEDIA_MODERATION_CONFIG
  });
  if (mediaResult.unavailable) {
    logMediaModerationUnavailable(req, { flow, originalName, error: mediaResult.error });
  }
  if (mediaResult.blocked) {
    logModerationBlock(req, { flow, categories: mediaResult.categories, originalName });
    return mediaResult;
  }
  return null;
}

function publishAcceptedMulterFile(file) {
  const finalPath = publishQuarantinedFile({ quarantinePath: file.path, uploadDir: UPLOAD_DIR, storedName: file.filename });
  file.path = finalPath;
  file.destination = UPLOAD_DIR;
  return finalPath;
}

function isSimpleUploadRequest(req) {
  return req?.method === 'POST' && req?.path === '/api/upload';
}

app.use(addSecurityHeaders);
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'X-Admin-Token', 'Range'], methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  const dbStats = contentDb.stats();
  const limit = getUploadLimit(req);
  res.json({
    success: true,
    service: 'tuchuang-file-hosting',
    files: dbStats.totalFiles,
    metadataStore: 'sqlite',
    dbFile: path.basename(DB_FILE),
    uploadTier: limit.tier,
    maxFileMB: limit.maxFileMB,
    maxFileGB: limit.maxFileGB,
    publicMaxFileMB: PUBLIC_UPLOAD_MAX_FILE_MB,
    publicMaxFileGB: PUBLIC_UPLOAD_MAX_FILE_MB / 1024,
    adminMaxFileMB: ADMIN_UPLOAD_MAX_FILE_MB,
    adminMaxFileGB: ADMIN_UPLOAD_MAX_FILE_MB / 1024,
    maxFiles: MAX_FILES,
    maxFilesPerUpload: MAX_FILES,
    expireAfterIdleDays: FILE_EXPIRY_DAYS,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
    chunkSessionTtlMs: CHUNK_SESSION_TTL_MS,
    publicUpload: true,
    resumableUpload: true,
    resumableChunkSize: RESUMABLE_CHUNK_SIZE,
    uploadLogs: true,
    contentModeration: true,
    mediaModeration: {
      enabled: MEDIA_MODERATION_CONFIG.enabled,
      provider: 'local-nudenet',
      blockOnUnavailable: MEDIA_MODERATION_CONFIG.blockOnUnavailable,
      maxVideoFrames: MEDIA_MODERATION_CONFIG.maxVideoFrames,
      videoFrameIntervalSeconds: MEDIA_MODERATION_CONFIG.videoFrameIntervalSeconds
    },
    blockedCategories: ['sexual', 'gambling', 'drugs']
  });
});

app.post('/api/upload-logs', uploadLogRateLimit, (req, res) => {
  const entry = uploadLogger.log(req.body || {}, req);
  res.json({ success: true, logId: entry.id });
});

app.get('/api/upload-logs', requireAdmin, (req, res) => {
  res.json({ success: true, logs: uploadLogger.tail(req.query.limit || 100) });
});

app.post('/api/uploads/init', (req, res) => {
  const limit = getUploadLimit(req);
  const size = Number(req.body?.size || 0);
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ success: false, error: 'Invalid file size' });
  if (size > limit.maxFileBytes) {
    return res.status(413).json({ success: false, error: `File too large. Max ${limit.maxFileMB}MB`, uploadTier: limit.tier, maxFileMB: limit.maxFileMB });
  }

  const originalName = normalizeOriginalName(req.body?.originalName || req.body?.name || 'file');
  const mimeType = req.body?.mimeType || mime.lookup(originalName) || 'application/octet-stream';
  const moderation = moderateUploadCandidate({ originalName, mimeType, fields: req.body || {} });
  if (moderation.blocked) {
    logModerationBlock(req, { flow: 'resumable_init', categories: moderation.categories, originalName });
    return rejectModeratedRequest(res, moderation);
  }
  const manifest = buildUploadManifest({
    fingerprint: req.body?.fingerprint || `${originalName}:${size}:${req.body?.lastModified || ''}`,
    originalName,
    size,
    mimeType,
    chunkSize: req.body?.chunkSize || RESUMABLE_CHUNK_SIZE,
    lastModified: req.body?.lastModified
  });
  manifest.uploadTier = limit.tier;
  manifest.maxFileMB = limit.maxFileMB;
  manifest.feedRequested = uploadFeedRequested(req.body || {});
  manifest.feedRequestedByAdmin = limit.tier === 'admin';

  const existing = readManifest(manifest.uploadId);
  if (existing?.complete && existing.file) {
    const liveRecord = getRecordById(existing.file.id);
    const livePath = liveRecord ? path.join(UPLOAD_DIR, safeName(liveRecord.storedName || liveRecord.filename)) : '';
    if (liveRecord && fs.existsSync(livePath)) {
      return res.json({ success: true, ...getUploadStatus(existing), file: publicRecord(liveRecord, req) });
    }
    removeChunkSession(existing.uploadId);
  }
  const active = existing && !existing.complete ? {
    ...existing,
    uploadTier: existing.uploadTier || limit.tier,
    maxFileMB: existing.maxFileMB || limit.maxFileMB,
    feedRequested: existing.feedRequested || manifest.feedRequested,
    feedRequestedByAdmin: existing.feedRequestedByAdmin || manifest.feedRequestedByAdmin
  } : manifest;
  writeManifest(active);
  res.json({ success: true, ...getUploadStatus(active) });
});

app.get('/api/uploads/:uploadId/status', (req, res) => {
  const manifest = readManifest(req.params.uploadId);
  if (!manifest) return res.status(404).json({ success: false, error: 'Upload session not found' });
  res.json({ success: true, ...getUploadStatus(manifest) });
});

app.put('/api/uploads/:uploadId/chunks/:index', express.raw({ type: '*/*', limit: `${RESUMABLE_CHUNK_MB}mb` }), (req, res) => {
  const manifest = readManifest(req.params.uploadId);
  if (!manifest) return res.status(404).json({ success: false, error: 'Upload session not found' });
  if (manifest.complete) return res.json({ success: true, ...getUploadStatus(manifest) });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ success: false, error: 'Chunk body required' });

  const chunkIndex = Number(req.params.index);
  const validation = validateChunkIndex(manifest, chunkIndex, req.body.length);
  if (!validation.valid) return res.status(400).json({ success: false, error: validation.error });

  const dir = sessionDir(manifest.uploadId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${chunkFilename(chunkIndex)}.tmp`);
  const final = path.join(dir, chunkFilename(chunkIndex));
  fs.writeFileSync(tmp, req.body);
  fs.renameSync(tmp, final);
  writeManifest(manifest);
  res.json({ success: true, ...getUploadStatus(manifest) });
});

app.post('/api/uploads/:uploadId/complete', async (req, res, next) => {
  try {
  const manifest = readManifest(req.params.uploadId);
  if (!manifest) return res.status(404).json({ success: false, error: 'Upload session not found' });
  if (manifest.complete && manifest.file) return res.json({ success: true, file: publicRecord(manifest.file, req), ...getUploadStatus(manifest) });

  const status = getUploadStatus(manifest);
  if (status.missingChunks.length > 0) {
    return res.status(409).json({ success: false, error: 'Upload is incomplete', ...status });
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const ext = path.extname(safeName(manifest.originalName)).slice(0, 32);
  const storedName = `${id}${ext}`;
  const outputPath = path.join(QUARANTINE_DIR, storedName);
  const fd = fs.openSync(outputPath, 'wx');
  try {
    for (let i = 0; i < manifest.totalChunks; i += 1) {
      const chunkPath = path.join(sessionDir(manifest.uploadId), chunkFilename(i));
      fs.writeSync(fd, fs.readFileSync(chunkPath));
    }
  } finally {
    fs.closeSync(fd);
  }

  const completeModeration = await moderateStoredCandidate(req, {
    filePath: outputPath,
    originalName: manifest.originalName,
    filename: storedName,
    mimeType: manifest.mimeType || mime.lookup(manifest.originalName) || 'application/octet-stream',
    fields: manifest,
    flow: 'resumable_complete'
  });
  if (completeModeration) {
    fs.rmSync(outputPath, { force: true });
    removeChunkSession(manifest.uploadId);
    return rejectModeratedRequest(res, completeModeration);
  }

  const finalPath = publishQuarantinedFile({ quarantinePath: outputPath, uploadDir: UPLOAD_DIR, storedName });

  let record = buildFileRecord({
    id,
    originalName: manifest.originalName,
    filename: storedName,
    storedName,
    size: manifest.size,
    mimeType: manifest.mimeType || mime.lookup(manifest.originalName) || 'application/octet-stream',
    uploaderIp: req.ip
  });
  record.uploadTier = manifest.uploadTier || 'public';
  record = applyUploadFeedFields(record, {
    requested: manifest.feedRequested,
    isAdmin: Boolean(manifest.feedRequestedByAdmin || record.uploadTier === 'admin')
  });
  syncRecordToDb(record);

  manifest.complete = true;
  manifest.file = record;
  writeManifest(manifest);
  removeUploadedChunks(manifest.uploadId);
  res.json({ success: true, file: publicRecord(record, req) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', markSimpleUploadStart, uploadArrayForRequest, async (req, res, next) => {
  try {
  if (!req.files || req.files.length === 0) {
    const logEntry = logSimpleUploadAccess(req, { status: 400, error: 'No files uploaded' });
    return res.status(400).json({ success: false, error: 'No files uploaded', logId: logEntry.id });
  }

  const limit = req.uploadLimit || getUploadLimit(req);
  const feedRequested = uploadFeedRequested(req.body || {});
  for (const file of req.files) {
    const originalName = normalizeOriginalName(file.originalname || file.filename);
    const mimeType = file.mimetype || mime.lookup(originalName) || 'application/octet-stream';
    const moderation = await moderateStoredCandidate(req, {
      filePath: file.path,
      originalName,
      filename: file.filename,
      mimeType,
      fields: req.body || {},
      flow: 'simple_upload'
    });
    if (moderation) {
      cleanupStoredUploadFiles(req.files);
      const logEntry = logSimpleUploadAccess(req, { status: 451, files: req.files, error: 'content_moderation_blocked' });
      return rejectModeratedRequest(res, moderation, { logId: logEntry.id });
    }
  }
  const results = req.files.map(file => {
    publishAcceptedMulterFile(file);
    const id = path.basename(file.filename, path.extname(file.filename));
    const originalName = normalizeOriginalName(file.originalname || file.filename);
    let record = buildFileRecord({
      id,
      originalName,
      filename: file.filename,
      storedName: file.filename,
      size: file.size,
      mimeType: file.mimetype || mime.lookup(originalName) || 'application/octet-stream',
      uploaderIp: req.ip
    });
    record.uploadTier = limit.tier;
    record = applyUploadFeedFields(record, { requested: feedRequested, isAdmin: limit.tier === 'admin' });
    syncRecordToDb(record);
    return publicRecord(record, req);
  });

  const logEntry = logSimpleUploadAccess(req, { status: 200, files: req.files });
  res.json({ success: true, uploadTier: limit.tier, maxFileMB: limit.maxFileMB, logId: logEntry.id, files: results });
  } catch (err) {
    cleanupStoredUploadFiles(req.files || []);
    next(err);
  }
});

app.get('/api/files', (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const search = String(req.query.search || '').toLowerCase();
  const typeFilter = String(req.query.type || '');
  const sort = String(req.query.sort || 'latest');
  const result = contentDb.listFiles({ page, limit, search, type: typeFilter, sort });
  res.json({
    success: true,
    files: result.files.map(file => publicRecord(file, req)),
    pagination: result.pagination
  });
});

app.get('/api/feed/videos', (req, res) => {
  const result = contentDb.listFeedVideos({ limit: req.query.limit || 10, cursor: req.query.cursor || '' });
  res.json({
    success: true,
    videos: result.videos.map(file => publicRecord(file, req)),
    nextCursor: result.nextCursor
  });
});

app.get('/api/admin/feed/videos', requireAdmin, (req, res) => {
  const result = contentDb.listFeedManagementVideos({
    page: req.query.page || 1,
    limit: req.query.limit || 80,
    feedStatus: req.query.status || req.query.feedStatus || 'all',
    search: req.query.search || '',
  });
  res.json({
    success: true,
    files: result.files.map(file => publicRecord(file, req)),
    pagination: result.pagination,
    summary: result.summary,
  });
});

app.post('/api/admin/feed/batch', requireAdmin, (req, res) => {
  try {
    const result = contentDb.bulkUpdateFeed({ action: req.body?.action, ids: req.body?.ids || [] });
    res.json({ success: true, ...result, summary: contentDb.listFeedManagementVideos({ limit: 1 }).summary });
  } catch (err) {
    res.status(400).json({ success: false, error: err?.message || 'Invalid feed batch action' });
  }
});

app.patch('/api/files/:id/feed', requireAdmin, (req, res) => {
  const existing = contentDb.getFileById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'File not found' });
  const moderation = moderateUploadCandidate({ title: req.body?.title, description: req.body?.description, tags: req.body?.tags });
  if (moderation.blocked) {
    logModerationBlock(req, { flow: 'feed_metadata', categories: moderation.categories, originalName: existing.originalName });
    return rejectModeratedRequest(res, moderation);
  }
  const wantsFeed = req.body?.allowFeed === true || req.body?.allowFeed === 'true';
  if (wantsFeed && existing.mediaType !== 'video') {
    return res.status(400).json({ success: false, error: 'Only video files can enter feed' });
  }
  const updated = contentDb.updateFeedSettings(existing.id, {
    visibility: req.body?.visibility,
    allowFeed: req.body?.allowFeed,
    feedStatus: req.body?.feedStatus,
    title: req.body?.title,
    description: req.body?.description,
    tags: req.body?.tags,
  });
  if (!updated) return res.status(404).json({ success: false, error: 'File not found' });
  res.json({ success: true, file: publicRecord(updated, req) });
});

app.get('/api/notes', (req, res) => {
  const includePrivate = isAuthed(req);
  const result = contentDb.listNotes({ fileId: req.query.fileId || '', includePrivate, limit: req.query.limit || 50 });
  res.json({ success: true, notes: result.notes });
});

app.post('/api/notes', requireAdmin, (req, res) => {
  const fileId = String(req.body?.fileId || '');
  if (fileId && !contentDb.getFileById(fileId)) return res.status(404).json({ success: false, error: 'File not found' });
  const moderation = moderateUploadCandidate({ title: req.body?.title, description: req.body?.content, tags: req.body?.tags });
  if (moderation.blocked) {
    logModerationBlock(req, { flow: 'note', categories: moderation.categories, originalName: fileId });
    return rejectModeratedRequest(res, moderation);
  }
  const note = contentDb.createNote({
    fileId,
    title: req.body?.title || '',
    content: req.body?.content || '',
    contentFormat: req.body?.contentFormat || 'markdown',
    visibility: req.body?.visibility || 'private',
    pinned: req.body?.pinned === true,
    tags: req.body?.tags || [],
  });
  res.json({ success: true, note });
});

app.get('/api/notes/:id/history', requireAdmin, (req, res) => {
  const result = contentDb.listNoteHistory(req.params.id, { includeDeleted: true });
  res.json({ success: true, history: result.history });
});

app.patch('/api/notes/:id', requireAdmin, (req, res) => {
  const existing = contentDb.getNote(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'Note not found' });
  const moderation = moderateUploadCandidate({ title: req.body?.title, description: req.body?.content, tags: req.body?.tags });
  if (moderation.blocked) {
    logModerationBlock(req, { flow: 'note_update', categories: moderation.categories, originalName: req.params.id });
    return rejectModeratedRequest(res, moderation);
  }
  const note = contentDb.updateNote(req.params.id, {
    title: req.body?.title,
    content: req.body?.content,
    contentFormat: req.body?.contentFormat,
    visibility: req.body?.visibility,
    pinned: req.body?.pinned,
    tags: req.body?.tags,
  });
  if (!note) return res.status(404).json({ success: false, error: 'Note not found' });
  res.json({ success: true, note });
});

app.delete('/api/notes/:id', requireAdmin, (req, res) => {
  const deleted = contentDb.deleteNote(req.params.id);
  if (!deleted) return res.status(404).json({ success: false, error: 'Note not found' });
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  const dbStats = contentDb.stats();
  const limit = getUploadLimit(req);
  res.json({
    success: true,
    stats: {
      ...dbStats,
      uploadTier: limit.tier,
      maxFileMB: limit.maxFileMB,
      maxFileGB: limit.maxFileGB,
      publicMaxFileMB: PUBLIC_UPLOAD_MAX_FILE_MB,
      adminMaxFileMB: ADMIN_UPLOAD_MAX_FILE_MB,
      maxFiles: MAX_FILES,
      maxFilesPerUpload: MAX_FILES,
      expireAfterIdleDays: FILE_EXPIRY_DAYS,
      publicUpload: true
    }
  });
});

app.delete('/api/files/:id', requireAdmin, (req, res) => {
  const id = safeName(req.params.id);
  const record = getRecordById(id);
  if (!record) return res.status(404).json({ success: false, error: 'File not found' });
  const storedName = safeName(record.storedName || record.filename);
  const filePath = path.join(UPLOAD_DIR, storedName);
  contentDb.deleteFile(record.id || id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

function setFileHeaders(res, { mimeType, displayName, disposition, size, start, end, partial }) {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isDangerousInlineMimeType(mimeType)) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  if (partial) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
  } else {
    res.setHeader('Content-Length', size);
  }
}

function sendFileRecord(req, res, requestedDisposition = 'inline') {
  const record = getRecordById(req.params.id);
  if (!record) return res.status(404).send('File not found');
  const storedName = safeName(record.storedName || record.filename);
  const filePath = path.join(UPLOAD_DIR, storedName);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const mimeType = record.mimeType || mime.lookup(record.originalName) || 'application/octet-stream';
  const displayName = normalizeOriginalName(record.originalName || storedName);
  const disposition = getContentDispositionForMimeType(mimeType, requestedDisposition);
  const shouldRefreshAccess = req.query.previewEmbed !== '1';

  if (shouldRefreshAccess) {
    touchRecord(record);
    syncRecordToDb(record);
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    let start = match[1] === '' ? 0 : Number(match[1]);
    let end = match[2] === '' ? size - 1 : Number(match[2]);
    if (match[1] === '' && match[2] !== '') {
      const suffix = Number(match[2]);
      start = Math.max(size - suffix, 0);
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
      return res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    }
    setFileHeaders(res, { mimeType, displayName, disposition, size, start, end, partial: true });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  setFileHeaders(res, { mimeType, displayName, disposition, size, partial: false });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

app.get('/f/:id/:name?', (req, res) => sendFileRecord(req, res, req.query.download === '1' ? 'attachment' : 'inline'));
app.head('/f/:id/:name?', (req, res) => sendFileRecord(req, res, req.query.download === '1' ? 'attachment' : 'inline'));
app.get('/raw/:id', (req, res) => sendFileRecord(req, res, 'attachment'));
app.head('/raw/:id', (req, res) => sendFileRecord(req, res, 'attachment'));
app.get('/s/:id', (req, res) => {
  const record = getRecordById(req.params.id);
  if (!record) return res.status(404).send('File not found');
  res.redirect(302, `/f/${encodeURIComponent(record.id)}/${encodeURIComponent(record.originalName || record.filename)}`);
});

app.get('/preview/:id', (req, res) => {
  const record = getRecordById(req.params.id);
  if (!record) return res.status(404).send('File not found');
  const storedName = safeName(record.storedName || record.filename);
  const filePath = path.join(UPLOAD_DIR, storedName);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

  touchRecord(record);
  syncRecordToDb(record);

  const file = publicRecord(record, req);
  const kind = getPreviewKind(file);
  const safeTitle = escapeHtml(file.originalName || storedName);
  const isEmbedded = req.query.embed === '1';
  const fileUrl = `/f/${encodeURIComponent(record.id)}/${encodeURIComponent(record.originalName || record.filename)}`;
  const embeddedFileUrl = `${fileUrl}?previewEmbed=1`;
  const downloadUrl = `/raw/${encodeURIComponent(record.id)}`;
  const updatedExpiresAt = file.expiresAt ? new Date(file.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '未知';
  const updatedLastAccess = file.lastAccessTime ? new Date(file.lastAccessTime).toLocaleString('zh-CN', { hour12: false }) : '刚刚';
  const accessCount = Number(file.accessCount || 0);
  let body = '';

  if (kind === 'image') body = `<img class="preview-media" src="${embeddedFileUrl}" alt="${safeTitle}">`;
  else if (kind === 'video') body = `<video class="preview-media" src="${embeddedFileUrl}" controls playsinline preload="metadata"></video>`;
  else if (kind === 'audio') body = `<audio class="preview-audio" src="${embeddedFileUrl}" controls preload="metadata"></audio>`;
  else if (kind === 'pdf') body = `<iframe class="preview-frame" src="${embeddedFileUrl}" title="${safeTitle}"></iframe>`;
  else if (kind === 'text') {
    const text = fs.readFileSync(filePath, 'utf-8').slice(0, 1024 * 1024);
    body = `<pre class="preview-text">${escapeHtml(text)}</pre>`;
  } else if (kind === 'office') {
    const officeSourceUrl = `${req.protocol}://${req.get('host')}${embeddedFileUrl}`;
    const officeUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(officeSourceUrl)}`;
    body = `<iframe class="preview-frame" src="${officeUrl}" title="${safeTitle}"></iframe>`;
  } else {
    body = `<div class="preview-generic"><div class="preview-icon">📁</div><p>该格式无浏览器原生预览器，已保留原始文件，可直接打开或下载。</p></div>`;
  }

  const bodyClass = isEmbedded ? 'embed' : '';
  const headerMeta = `${escapeHtml(file.mimeType || 'application/octet-stream')} · ${file.size || 0} bytes · 访问 ${accessCount} 次 · 最近访问 ${escapeHtml(updatedLastAccess)} · 过期时间 ${escapeHtml(updatedExpiresAt)}（每次访问自动向后延期）`;
  const headerHtml = isEmbedded ? '' : `<header class="top"><div><div class="title">${safeTitle}</div><div class="meta">${headerMeta}</div></div><div class="actions"><a class="btn" href="${fileUrl}" target="_blank" rel="noreferrer">打开原文件</a><a class="btn" href="${downloadUrl}">下载</a></div></header>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' https://view.officeapps.live.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} - 在线预览</title><style>
    :root{color-scheme:dark;background:#07111f;color:#eaf6ff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#143b5b 0,#07111f 52%,#020711 100%);display:flex;flex-direction:column}.top{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 18px;background:rgba(7,17,31,.72);backdrop-filter:blur(18px);border-bottom:1px solid rgba(125,211,252,.22)}.title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{color:#9cc7df;font-size:12px}.actions{display:flex;gap:8px}.btn{color:#eaf6ff;text-decoration:none;border:1px solid rgba(125,211,252,.35);border-radius:999px;padding:8px 12px;background:rgba(14,165,233,.14)}.stage{flex:1;display:flex;align-items:center;justify-content:center;padding:18px;min-height:0}.preview-media{max-width:100%;max-height:calc(100vh - 96px);object-fit:contain;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.45)}.preview-audio{width:min(760px,92vw)}.preview-frame{width:100%;height:calc(100vh - 96px);border:0;border-radius:16px;background:white}.preview-text{width:min(1180px,94vw);max-height:calc(100vh - 120px);overflow:auto;white-space:pre-wrap;word-break:break-word;padding:20px;border-radius:16px;background:rgba(2,6,23,.72);border:1px solid rgba(125,211,252,.22)}.preview-generic{text-align:center;color:#bdd8e9}.preview-icon{font-size:72px;margin-bottom:16px}
  </style></head><body class="${bodyClass}">${headerHtml}<main class="stage">${body}</main></body></html>`);
});

// Honest API 404 before SPA fallback.
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'API route not found' }));

const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  const assetsDir = path.join(distDir, 'assets');
  if (fs.existsSync(assetsDir)) app.use('/assets', express.static(assetsDir, { maxAge: '1y', immutable: true }));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(distDir, 'favicon.svg')));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(distDir, 'favicon.svg')));
  app.get(['/manifest.json', '/sitemap.xml'], (req, res) => res.status(404).type('application/json').send(JSON.stringify({ success: false, error: 'Not found' })));
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => {
    const acceptsHtml = String(req.get('accept') || '').includes('text/html');
    if (req.path !== '/' && !acceptsHtml) return res.status(404).send('Not found');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  const limit = req.uploadLimit || getUploadLimit(req);
  if (isSimpleUploadRequest(req)) {
    let status = 500;
    let message = errorMessage(err) || 'Server error';
    const extra = {};
    if (err.code === 'LIMIT_FILE_SIZE') {
      status = 413;
      message = `File too large. Max ${limit.maxFileMB}MB`;
      extra.uploadTier = limit.tier;
      extra.maxFileMB = limit.maxFileMB;
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      status = 413;
      message = `Too many files. Max ${MAX_FILES}`;
    } else if (/Unexpected end of form/i.test(err?.message || '')) {
      status = 400;
      message = 'Malformed upload form or interrupted upload';
    }
    const logEntry = logSimpleUploadAccess(req, { status, files: req.files || [], error: message });
    if (status >= 500) console.error('[Tuchuang] Upload error:', errorMessage(err), `logId=${logEntry.id}`);
    return res.status(status).json({ success: false, error: message, ...extra, logId: logEntry.id });
  }

  const logEntry = uploadLogger.log({ event: 'server_error', level: 'error', path: req.originalUrl, error: err }, req);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: `File too large. Max ${limit.maxFileMB}MB`, uploadTier: limit.tier, maxFileMB: limit.maxFileMB, logId: logEntry.id });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ success: false, error: `Too many files. Max ${MAX_FILES}`, logId: logEntry.id });
  }
  if (/Unexpected end of form/i.test(err?.message || '')) {
    return res.status(400).json({ success: false, error: 'Malformed upload form or interrupted upload', logId: logEntry.id });
  }
  console.error('[Tuchuang] Error:', errorMessage(err), `logId=${logEntry.id}`);
  res.status(500).json({ success: false, error: errorMessage(err) || 'Server error', logId: logEntry.id });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Tuchuang] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[Tuchuang] Public URL: ${BASE_URL}`);
  console.log(`[Tuchuang] Short URL: ${SHORT_BASE_URL}`);
  console.log(`[Tuchuang] Upload dir: ${UPLOAD_DIR}`);
  console.log(`[Tuchuang] Public upload max: ${PUBLIC_UPLOAD_MAX_FILE_MB}MB`);
  console.log(`[Tuchuang] Admin upload max: ${ADMIN_UPLOAD_MAX_FILE_MB}MB`);
  console.log(`[Tuchuang] Admin API: ${ADMIN_TOKEN ? 'protected' : 'token missing'}`);
});
