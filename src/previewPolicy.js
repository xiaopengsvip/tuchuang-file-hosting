const OFFICE_MIME_MARKERS = [
  'msword',
  'officedocument',
  'ms-excel',
  'ms-powerpoint',
  'opendocument',
];

export function getPreviewKind(file = {}) {
  const mimeType = String(file.mimeType || file.type || '').toLowerCase();
  const name = String(file.originalName || file.filename || file.name || '').toLowerCase();

  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (OFFICE_MIME_MARKERS.some(marker => mimeType.includes(marker)) || /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(name)) return 'office';
  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('javascript')) return 'text';
  return 'generic';
}

export function supportsNativePreview(file = {}) {
  return ['image', 'video', 'audio', 'pdf', 'text'].includes(getPreviewKind(file));
}

export function buildPreviewUrl(file = {}) {
  return file.url || file.directUrl || file.shortUrl || '';
}
