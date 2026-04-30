import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function buildSimpleUploadAccessEvent({
  status,
  files = [],
  uploadTier,
  maxFileMB,
  startedAt,
  now = Date.now(),
  error
} = {}) {
  const normalizedFiles = (files || []).slice(0, 30).map(file => ({
    originalName: file.originalName || file.originalname || file.name || file.filename || '',
    storedName: file.storedName || file.filename || '',
    size: Number(file.size || 0),
    mimeType: file.mimeType || file.mimetype || file.type || 'application/octet-stream'
  }));
  const failed = Number(status) >= 400;
  const event = {
    event: failed ? 'simple_upload_failed' : 'simple_upload_success',
    level: failed ? 'error' : 'info',
    phase: 'simple_upload',
    status: Number(status) || (failed ? 500 : 200),
    uploadTier,
    maxFileMB,
    fileCount: normalizedFiles.length,
    totalSize: normalizedFiles.reduce((sum, file) => sum + file.size, 0),
    files: normalizedFiles
  };
  if (Number.isFinite(Number(startedAt))) {
    event.durationMs = Math.max(0, Math.round(Number(now) - Number(startedAt)));
  }
  if (error) event.error = errorMessage(error);
  return event;
}

export function createUploadLogger({ logDir, logFile } = {}) {
  const dir = logDir || path.join(process.cwd(), 'logs');
  const file = logFile || path.join(dir, 'upload-events.jsonl');
  fs.mkdirSync(dir, { recursive: true });

  function sanitize(value, depth = 0) {
    if (value == null) return value;
    if (depth > 4) return '[truncated]';
    if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
    if (typeof value === 'string') return value.slice(0, 1000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitize(item, depth + 1));
    if (typeof value === 'object') {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 50)) {
        if (/token|authorization|cookie|password|secret/i.test(key)) continue;
        output[key] = sanitize(item, depth + 1);
      }
      return output;
    }
    return String(value).slice(0, 1000);
  }

  function requestContext(req) {
    if (!req) return {};
    return sanitize({
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      userAgent: req.get?.('user-agent'),
      referer: req.get?.('referer'),
      contentLength: req.get?.('content-length')
    });
  }

  function log(event, req) {
    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      level: event?.level || 'info',
      event: event?.event || 'upload_event',
      ...sanitize(event || {}),
      request: requestContext(req)
    };
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[Tuchuang] Failed to write upload log:', err.message);
    }
    return entry;
  }

  function tail(limit = 100) {
    if (!fs.existsSync(file)) return [];
    const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-max).map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    }).reverse();
  }

  return { file, log, tail };
}

export function errorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || error.code || String(error);
}
