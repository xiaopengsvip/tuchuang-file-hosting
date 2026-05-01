import { normalizePathname } from './accessPolicy.js';
import { safeTokenEquals } from './uploadPolicy.js';

const VALID_VISIBILITY = new Set(['private', 'unlisted', 'public']);
const VALID_FEED_STATUS = new Set(['hidden', 'pending', 'approved', 'rejected']);

function splitKeys(value = '') {
  return String(value || '')
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function parseStorageApiKeys(env = {}, { fallbackToken = '' } = {}) {
  const keys = [
    ...splitKeys(env.STORAGE_API_KEYS),
    ...splitKeys(env.STORAGE_API_TOKEN),
    ...splitKeys(env.STORAGE_API_KEY),
  ];
  if (keys.length === 0 && fallbackToken) keys.push(String(fallbackToken));
  return [...new Set(keys)].filter(Boolean);
}

export function extractStorageApiToken(headers = {}) {
  const normalized = new Map(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
  const auth = String(normalized.get('authorization') || '').trim();
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(normalized.get('x-api-key') || normalized.get('x-storage-token') || normalized.get('x-admin-token') || '').trim();
}

export function isStorageApiAuthorized(token = '', keys = []) {
  if (!token || !Array.isArray(keys) || keys.length === 0) return false;
  return keys.some(key => safeTokenEquals(token, key));
}

export function routeRequiresStorageApi(method = 'GET', url = '/') {
  return normalizePathname(url).startsWith('/api/storage/');
}

function normalizeVisibility(value = '', fallback = 'unlisted') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_VISIBILITY.has(normalized) ? normalized : fallback;
}

function normalizeFeedStatus(value = '', fallback = 'hidden') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_FEED_STATUS.has(normalized) ? normalized : fallback;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on', 'public', 'publish', 'approved'].includes(String(value).trim().toLowerCase());
}

function normalizeTags(input) {
  if (Array.isArray(input)) return input.map(tag => String(tag).trim()).filter(Boolean).slice(0, 20);
  const raw = String(input || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeTags(parsed);
    } catch {}
  }
  return raw.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20);
}

function mediaTypeFromInput({ mediaType = '', mimeType = '' } = {}) {
  const explicit = String(mediaType || '').toLowerCase();
  if (['video', 'image', 'audio', 'document', 'other'].includes(explicit)) return explicit;
  const mt = String(mimeType || explicit || '').toLowerCase();
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.includes('pdf') || mt.includes('document') || mt.includes('text') || mt.includes('sheet') || mt.includes('presentation')) return 'document';
  return 'other';
}

export function buildStorageMetadataPatch(input = {}, file = {}) {
  const mediaType = mediaTypeFromInput({ ...file, mimeType: file.mimeType || file.mimetype });
  const publishRequested = truthyFlag(input.publish ?? input.public ?? input.approveFeed ?? input.allowFeed ?? input.feed);
  const visibility = normalizeVisibility(input.visibility, publishRequested ? 'public' : 'unlisted');
  const wantsFeed = mediaType === 'video' && (publishRequested || truthyFlag(input.allowFeed));
  const feedStatus = wantsFeed
    ? normalizeFeedStatus(input.feedStatus, 'approved')
    : 'hidden';

  return {
    visibility,
    allowFeed: wantsFeed,
    feedStatus,
    title: String(input.title || input.name || '').trim().slice(0, 180),
    description: String(input.description || '').trim().slice(0, 2000),
    tags: normalizeTags(input.tags),
    mediaType,
  };
}

function appendEmbed(url = '') {
  if (!url) return '';
  return `${url}${url.includes('?') ? '&' : '?'}embed=1`;
}

export function buildStorageRecordResponse(record = {}) {
  const { uploaderIp, ...safeRecord } = record || {};
  const kind = safeRecord.mediaType || mediaTypeFromInput(safeRecord);
  const directUrl = safeRecord.directUrl || '';
  const fileUrl = safeRecord.url || directUrl || '';
  const previewUrl = safeRecord.previewUrl || '';
  return {
    ...safeRecord,
    kind,
    playUrl: fileUrl,
    viewUrl: previewUrl || fileUrl,
    embedUrl: appendEmbed(previewUrl || fileUrl),
    downloadUrl: directUrl || fileUrl,
    deleteApi: safeRecord.id ? `/api/storage/files/${encodeURIComponent(safeRecord.id)}` : '',
  };
}
