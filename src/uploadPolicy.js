import crypto from 'crypto';

export const PUBLIC_MAX_FILE_MB = 1024;
export const ADMIN_MAX_FILE_MB = 10240;
export const BYTES_PER_MB = 1024 * 1024;

const DANGEROUS_INLINE_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/xml',
  'text/xml',
]);

export function safeTokenEquals(input = '', expected = '') {
  const left = Buffer.from(String(input || ''));
  const right = Buffer.from(String(expected || ''));
  if (left.length !== right.length) return false;
  if (right.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

export function getUploadTierForToken(token = '', adminToken = '') {
  return safeTokenEquals(token, adminToken) ? 'admin' : 'public';
}

export function maxFileMBForTier(tier = 'public') {
  return tier === 'admin' ? ADMIN_MAX_FILE_MB : PUBLIC_MAX_FILE_MB;
}

export function getUploadLimitForToken(token = '', adminToken = '') {
  const tier = getUploadTierForToken(token, adminToken);
  const maxFileMB = maxFileMBForTier(tier);
  return {
    tier,
    maxFileMB,
    maxFileBytes: maxFileMB * BYTES_PER_MB,
  };
}

export function isDangerousInlineMimeType(mimeType = '') {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return DANGEROUS_INLINE_MIME_TYPES.has(normalized);
}

export function getContentDispositionForMimeType(mimeType = '', requested = 'inline') {
  if (requested === 'attachment') return 'attachment';
  return isDangerousInlineMimeType(mimeType) ? 'attachment' : 'inline';
}
