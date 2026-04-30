export function isVideoFile(file = {}) {
  return String(file.mimeType || '').toLowerCase().startsWith('video/');
}

export function buildFeedSettingsPayload(file = {}, enable = false) {
  if (!enable) {
    return {
      visibility: 'unlisted',
      allowFeed: false,
      feedStatus: 'hidden',
    };
  }
  return {
    visibility: 'public',
    allowFeed: true,
    feedStatus: 'approved',
    title: String(file.title || file.originalName || file.filename || '未命名视频').trim().slice(0, 180),
  };
}

export function getFeedBadge(file = {}) {
  if (!isVideoFile(file)) return '非视频';
  if (file.allowFeed && file.feedStatus === 'approved') return '推荐中';
  if (file.allowFeed && file.feedStatus === 'pending') return '待审核';
  if (file.feedStatus === 'rejected') return '已拒绝';
  return '未进推荐';
}

export function normalizeNoteDraft({ title = '', content = '', tagsText = '', publicNote = false } = {}) {
  return {
    title: String(title || '').trim().slice(0, 180),
    content: String(content || '').trim().slice(0, 20000),
    contentFormat: 'markdown',
    visibility: publicNote ? 'public' : 'private',
    tags: String(tagsText || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20),
  };
}

export function buildUploadFeedPreference(enabled = false) {
  return enabled ? 'request' : '';
}
