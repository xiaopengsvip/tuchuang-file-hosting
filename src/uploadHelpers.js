const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

function toArray(value) {
  return Array.from(value || []);
}

function extensionForMime(type = '') {
  if (EXT_BY_MIME[type]) return EXT_BY_MIME[type];
  const subtype = String(type).split('/')[1] || 'bin';
  return subtype.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'bin';
}

function defaultMakeFile(file, name) {
  if (typeof File !== 'undefined' && file instanceof Blob) {
    return new File([file], name, { type: file.type || 'application/octet-stream', lastModified: Date.now() });
  }
  return { ...file, name };
}

function ensureClipboardName(file, index, makeFile = defaultMakeFile) {
  if (!file) return file;
  if (file.name) return file;
  const ext = extensionForMime(file.type);
  return makeFile(file, `clipboard-upload-${index + 1}.${ext}`);
}

export function getClipboardUploadFiles(clipboardData, { makeFile = defaultMakeFile } = {}) {
  if (!clipboardData) return [];

  const directFiles = toArray(clipboardData.files).filter(file => file && Number(file.size) >= 0);
  if (directFiles.length > 0) {
    return directFiles.map((file, index) => ensureClipboardName(file, index, makeFile));
  }

  const files = [];
  for (const item of toArray(clipboardData.items)) {
    if (!item || item.kind !== 'file' || typeof item.getAsFile !== 'function') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  return files.map((file, index) => ensureClipboardName(file, index, makeFile));
}

export function uploadResultKey(file) {
  return file?.id || file?.filename || file?.url || file?.shortUrl || '';
}

export function mergeUploadedResults(existing = [], incoming = [], limit = 24) {
  const byKey = new Map();
  for (const file of [...incoming, ...existing]) {
    const key = uploadResultKey(file);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, file);
  }
  return Array.from(byKey.values()).slice(0, limit);
}

export function isPreviewableImage(file) {
  return String(file?.mimeType || file?.type || '').startsWith('image/');
}

export function buildFileFingerprint(file) {
  return `${file?.name || 'file'}:${Number(file?.size || 0)}:${Number(file?.lastModified || 0)}`;
}

export function shouldUseResumableUpload(file, thresholdBytes = 32 * 1024 * 1024) {
  return Number(file?.size || 0) > Number(thresholdBytes || 0);
}

export function getFileChunks(file, chunkSize) {
  const size = Number(file?.size || 0);
  const step = Math.max(Number(chunkSize || 0), 1);
  const total = Math.max(Math.ceil(size / step), 1);
  return Array.from({ length: total }, (_, index) => {
    const start = index * step;
    const end = Math.min(start + step, size);
    return {
      index,
      start,
      end,
      blob: typeof file?.slice === 'function' ? file.slice(start, end) : null
    };
  });
}
