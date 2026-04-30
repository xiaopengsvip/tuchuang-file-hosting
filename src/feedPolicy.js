export function isFeedPreferenceRequested(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on', 'request', 'requested'].includes(normalized);
}

export function isVideoMime(mimeType = '') {
  return String(mimeType || '').toLowerCase().startsWith('video/');
}

export function applyUploadFeedPreference(record = {}, { requested = false, isAdmin = false } = {}) {
  const wantsFeed = isFeedPreferenceRequested(requested);
  const isVideo = isVideoMime(record.mimeType || record.mimetype);
  const defaults = {
    visibility: 'unlisted',
    allowFeed: false,
    feedStatus: 'hidden',
  };

  if (!wantsFeed || !isVideo) {
    return { ...record, ...defaults };
  }

  return {
    ...record,
    visibility: 'public',
    allowFeed: true,
    feedStatus: isAdmin ? 'approved' : 'pending',
    title: String(record.title || record.originalName || record.filename || '未命名视频').trim().slice(0, 180),
  };
}
