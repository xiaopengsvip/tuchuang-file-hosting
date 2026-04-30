const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
  return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function isResumablePhase(phase = '') {
  return ['init', 'chunk_upload', 'complete'].includes(String(phase));
}

export function getFriendlyUploadError(error, { phase = '', maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const raw = String(error?.message || error || '未知错误');
  if (/Network error|Failed to fetch|NetworkError/i.test(raw)) {
    if (phase === 'simple_upload') {
      return {
        message: '网络中断，上传未完成',
        hint: '请刷新页面后重新选择该文件上传；小文件普通上传需要从头重试。'
      };
    }
    if (isResumablePhase(phase)) {
      return {
        message: '网络中断，上传未完成',
        hint: '请检查网络后重新选择同一文件；大文件会自动跳过已上传分片继续上传。'
      };
    }
    return {
      message: '网络中断，上传未完成',
      hint: '请检查网络后重试；如果是大文件，重新选择同一文件可继续断点续传。'
    };
  }
  if (/too large|413|Payload Too Large/i.test(raw)) {
    return { message: '文件超过服务限制', hint: `当前单文件最大 ${formatSize(maxFileBytes)}，请压缩或拆分后重试。` };
  }
  if (/incomplete|missing/i.test(raw)) {
    return { message: '分片尚未完整上传', hint: '请重新选择同一文件继续上传，系统会从缺失分片开始续传。' };
  }
  if (/timeout|超时/i.test(raw)) {
    return { message: '上传超时', hint: '请保持页面打开并重试；如果持续失败，日志编号可用于排查。' };
  }
  return { message: `上传失败：${raw}`, hint: '请稍后重试；如果重复出现，请把日志编号提供给管理员排查。' };
}

export function getSameSitePreviewUrl(file, apiBase = '') {
  if (!file) return '';
  const id = file.id || file.filename;
  if (id) return `${apiBase}/preview/${encodeURIComponent(id)}`;
  return '';
}

export function getDirectViewUrl(file, apiBase = '') {
  if (!file) return '';
  if (file.previewUrl) return file.previewUrl;
  return getSameSitePreviewUrl(file, apiBase) || file.url || file.shortUrl || file.directUrl || '';
}
