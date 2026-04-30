import fs from 'fs';
import path from 'path';
import { PUBLIC_MAX_FILE_MB, ADMIN_MAX_FILE_MB } from './uploadPolicy.js';

export { PUBLIC_MAX_FILE_MB, ADMIN_MAX_FILE_MB };
export const DEFAULT_MAX_FILE_MB = PUBLIC_MAX_FILE_MB;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const FILE_EXPIRY_DAYS = 7;
export const FILE_EXPIRY_MS = FILE_EXPIRY_DAYS * DAY_MS;

function asDate(value) {
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function expiresAtFor(now = new Date()) {
  const base = asDate(now) || new Date();
  return new Date(base.getTime() + FILE_EXPIRY_MS).toISOString();
}

export function uploadDateParts(now = new Date()) {
  const base = asDate(now) || new Date();
  const [date] = base.toISOString().split('T');
  const [year, month, day] = date.split('-').map(Number);
  return { uploadDate: date, uploadYear: year, uploadMonth: month, uploadDay: day };
}

export function buildFileRecord({
  id,
  originalName,
  filename,
  storedName = filename,
  size,
  mimeType,
  uploaderIp,
  now = new Date(),
}) {
  const base = asDate(now) || new Date();
  const iso = base.toISOString();
  const dateParts = uploadDateParts(base);
  return {
    id,
    originalName,
    filename,
    storedName,
    size,
    mimeType,
    uploadTime: iso,
    ...dateParts,
    lastAccessTime: iso,
    expiresAt: expiresAtFor(base),
    accessCount: 0,
    uploaderIp,
  };
}

export function ensureLifecycleFields(record, now = new Date()) {
  if (!record || typeof record !== 'object') return record;
  const fallback = record.lastAccessTime || record.uploadTime || asDate(now)?.toISOString() || new Date().toISOString();
  if (!record.lastAccessTime) record.lastAccessTime = fallback;
  if (!record.expiresAt) record.expiresAt = expiresAtFor(record.lastAccessTime);
  if (!record.uploadDate || !record.uploadYear || !record.uploadMonth || !record.uploadDay) {
    Object.assign(record, uploadDateParts(record.uploadTime || fallback));
  }
  if (!Number.isFinite(Number(record.accessCount))) record.accessCount = 0;
  return record;
}

export function touchRecord(record, now = new Date()) {
  if (!record || typeof record !== 'object') return record;
  const base = asDate(now) || new Date();
  record.lastAccessTime = base.toISOString();
  record.expiresAt = expiresAtFor(base);
  record.accessCount = (Number(record.accessCount) || 0) + 1;
  return record;
}

export function isExpiredRecord(record, now = new Date()) {
  ensureLifecycleFields(record, now);
  const base = asDate(now) || new Date();
  const lastAccess = asDate(record.lastAccessTime || record.uploadTime);
  if (!lastAccess) return false;
  return base.getTime() - lastAccess.getTime() >= FILE_EXPIRY_MS;
}

export function cleanupExpiredRecords({ fileIndex, uploadDir, now = new Date(), unlink = fs.unlinkSync } = {}) {
  if (!fileIndex || typeof fileIndex !== 'object') {
    return { deleted: 0, kept: 0, errors: [] };
  }

  const errors = [];
  let deleted = 0;
  let kept = 0;

  for (const [key, record] of Object.entries(fileIndex)) {
    ensureLifecycleFields(record, now);
    if (!isExpiredRecord(record, now)) {
      kept += 1;
      continue;
    }

    const storedName = path.basename(String(record.storedName || record.filename || key));
    const filePath = uploadDir && storedName ? path.join(uploadDir, storedName) : null;

    try {
      if (filePath && fs.existsSync(filePath)) unlink(filePath);
      delete fileIndex[key];
      deleted += 1;
    } catch (err) {
      errors.push({ key, filePath, error: err?.message || String(err) });
      kept += 1;
    }
  }

  return { deleted, kept, errors };
}
