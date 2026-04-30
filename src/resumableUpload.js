import crypto from 'crypto';

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

export function normalizeChunkSize(value, fallback = DEFAULT_CHUNK_SIZE) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_CHUNK_SIZE);
}

export function buildUploadId(fingerprint) {
  return crypto.createHash('sha256').update(String(fingerprint || '')).digest('hex').slice(0, 24);
}

export function buildUploadManifest(input, options = {}) {
  const originalName = String(input.originalName || input.name || 'file');
  const size = Number(input.size || 0);
  const chunkSize = normalizeChunkSize(input.chunkSize);
  const fingerprint = String(input.fingerprint || `${originalName}:${size}:${input.lastModified || ''}`);
  const totalChunks = Math.max(Math.ceil(size / chunkSize), 1);
  const now = options.now || new Date().toISOString();

  return {
    uploadId: buildUploadId(fingerprint),
    fingerprint,
    originalName,
    size,
    mimeType: input.mimeType || 'application/octet-stream',
    chunkSize,
    totalChunks,
    createdAt: now,
    updatedAt: now,
    complete: false
  };
}

export function getChunkPlan({ size, chunkSize }) {
  const total = Math.max(Math.ceil(Number(size || 0) / Number(chunkSize || DEFAULT_CHUNK_SIZE)), 1);
  return Array.from({ length: total }, (_, index) => {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, size) - 1;
    return { index, start, end, size: Math.max(end - start + 1, 0) };
  });
}

export function chunkFilename(index) {
  return `chunk-${String(index).padStart(6, '0')}.part`;
}

export function getReceivedChunks(names) {
  return [...new Set((names || [])
    .map(name => /^chunk-(\d{6})\.part$/.exec(String(name)))
    .filter(Boolean)
    .map(match => Number(match[1])))]
    .sort((a, b) => a - b);
}

export function getMissingChunks(totalChunks, receivedChunks) {
  const received = new Set(receivedChunks || []);
  return Array.from({ length: totalChunks }, (_, index) => index).filter(index => !received.has(index));
}

export function validateChunkIndex(manifest, index, byteLength) {
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.totalChunks) {
    return { valid: false, error: `Chunk index out of range: ${index}` };
  }
  const plan = getChunkPlan({ size: manifest.size, chunkSize: manifest.chunkSize })[chunkIndex];
  if (Number(byteLength) !== plan.size) {
    return { valid: false, error: `Chunk ${chunkIndex} expected ${plan.size} bytes, got ${byteLength}` };
  }
  return { valid: true, plan };
}
