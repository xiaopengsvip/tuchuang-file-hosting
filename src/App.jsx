import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getClipboardUploadFiles, mergeUploadedResults, isPreviewableImage, buildFileFingerprint, shouldUseResumableUpload, getFileChunks } from './uploadHelpers.js';
import { getFriendlyUploadError, getDirectViewUrl, getSameSitePreviewUrl } from './uploadUi.js';
import { getPreviewKind, buildPreviewUrl } from './previewPolicy.js';
import { buildFeedSettingsPayload, getFeedBadge, normalizeNoteDraft, isVideoFile, buildUploadFeedPreference, buildFeedBatchPayload } from './contentPlatformUi.js';

const API_BASE = '';
const DEFAULT_MAX_FILE_MB = 1024;
const DEFAULT_EXPIRE_AFTER_IDLE_DAYS = 7;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
  return d.toLocaleDateString('zh-CN');
}

function formatDateTime(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

function formatCompactDateTime(iso) {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

function accessCountText(file = {}) {
  return `${Number(file.accessCount || 0).toLocaleString('zh-CN')} 次访问`;
}

function getFileTypeIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return '📦';
  if (mimeType.includes('text')) return '📝';
  if (mimeType.includes('sheet') || mimeType.includes('excel') || mimeType.includes('csv')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📄';
  return '📁';
}

function getFileExt(name = '') {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toUpperCase() : '';
}

function compactMiddle(input = '', maxLength = 72) {
  const text = String(input || '');
  if (text.length <= maxLength) return text;
  const keepStart = Math.max(18, Math.floor(maxLength * 0.52));
  const keepEnd = Math.max(12, maxLength - keepStart - 1);
  return `${text.slice(0, keepStart)}…${text.slice(-keepEnd)}`;
}

function appendQueryParam(url = '', key, value) {
  if (!url) return '';
  return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function sortFilesForView(files = [], sort = 'latest') {
  const timeValue = (value) => {
    const ms = value ? new Date(value).getTime() : 0;
    return Number.isFinite(ms) ? ms : 0;
  };
  const recommendedRank = (file = {}) => {
    if (file.allowFeed && file.feedStatus === 'approved' && file.visibility === 'public') return 0;
    if (file.allowFeed) return 1;
    return 2;
  };
  const list = Array.isArray(files) ? [...files] : [];
  const comparators = {
    latest: (a, b) => timeValue(b.uploadTime) - timeValue(a.uploadTime),
    access: (a, b) => Number(b.accessCount || 0) - Number(a.accessCount || 0) || timeValue(b.uploadTime) - timeValue(a.uploadTime),
    expiring: (a, b) => {
      const aExpires = timeValue(a.expiresAt) || Number.POSITIVE_INFINITY;
      const bExpires = timeValue(b.expiresAt) || Number.POSITIVE_INFINITY;
      return aExpires - bExpires || timeValue(b.uploadTime) - timeValue(a.uploadTime);
    },
    largest: (a, b) => Number(b.size || 0) - Number(a.size || 0) || timeValue(b.uploadTime) - timeValue(a.uploadTime),
    recommended: (a, b) => recommendedRank(a) - recommendedRank(b) || timeValue(b.uploadTime) - timeValue(a.uploadTime),
  };
  return list.sort(comparators[sort] || comparators.latest);
}

function videoElementFromPreview(event) {
  return event.currentTarget?.querySelector?.('video.hover-preview-video') || null;
}

function handleVideoPreviewEnter(event) {
  const video = videoElementFromPreview(event);
  if (!video) return;
  video.muted = true;
  video.playsInline = true;
  video.dataset.hoverPreview = 'playing';
  const playPromise = video.play();
  if (playPromise?.catch) playPromise.catch(() => {});
}

function handleVideoPreviewLeave(event) {
  const video = videoElementFromPreview(event);
  if (!video) return;
  video.dataset.hoverPreview = 'paused';
  video.pause();
  try {
    if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = 0;
  } catch (e) {}
}

function getMorePanelProfile(file = {}, previewKind = 'generic') {
  const ext = getFileExt(file.originalName || file.filename || 'FILE') || 'FILE';
  const profiles = {
    image: {
      className: 'image',
      icon: '🖼️',
      eyebrow: 'IMAGE VIEW',
      title: '原图视角',
      description: '适合看细节、复制 Markdown 图片语法，或打开未压缩原始图片。',
      previewAction: '大图预览',
      accent: ext
    },
    video: {
      className: 'video',
      icon: '🎬',
      eyebrow: 'VIDEO VIEW',
      title: '播放视角',
      description: '适合站内播放、悬停预览和推荐区管理，保留原视频清晰度。',
      previewAction: '站内播放',
      accent: ext
    },
    audio: {
      className: 'audio',
      icon: '🎧',
      eyebrow: 'AUDIO VIEW',
      title: '音频视角',
      description: '适合快速试听、复制分享链接，或打开浏览器原生音频控件。',
      previewAction: '试听音频',
      accent: ext
    },
    pdf: {
      className: 'document',
      icon: '📕',
      eyebrow: 'PDF VIEW',
      title: '文档视角',
      description: '适合在站内翻阅 PDF，同时保留原文件打开和下载入口。',
      previewAction: '预览文档',
      accent: ext
    },
    office: {
      className: 'document',
      icon: '📊',
      eyebrow: 'OFFICE VIEW',
      title: '表格/文档视角',
      description: '适合通过 Office 预览器查看内容，也可以直接打开原始文件。',
      previewAction: '预览文档',
      accent: ext
    },
    text: {
      className: 'text',
      icon: '📝',
      eyebrow: 'TEXT VIEW',
      title: '文本视角',
      description: '适合查看代码、日志或文本片段，预览内容会进行安全转义。',
      previewAction: '查看文本',
      accent: ext
    },
    generic: {
      className: 'generic',
      icon: '📦',
      eyebrow: 'FILE VIEW',
      title: '文件视角',
      description: '该类型以原文件为主，适合复制链接、打开或下载保存。',
      previewAction: '查看文件',
      accent: ext
    }
  };
  return profiles[previewKind] || profiles.generic;
}

// Toast component
function ToastContainer({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
      ))}
    </div>
  );
}

function FileLifecycleMeta({ file, compact = false }) {
  if (!file) return null;
  const idleDays = file.expireAfterIdleDays || DEFAULT_EXPIRE_AFTER_IDLE_DAYS;
  if (compact) {
    return (
      <div className="lifecycle-meta compact" title={`最近访问：${formatDateTime(file.lastAccessTime)}；访问或预览会自动向后延期 ${idleDays} 天`}>
        <span>👁 {accessCountText(file)}</span>
        <span>⏳ {formatCompactDateTime(file.expiresAt)} 过期</span>
      </div>
    );
  }
  return (
    <div className="lifecycle-meta">
      <span>👁 {accessCountText(file)}</span>
      <span>⏰ 过期：{formatDateTime(file.expiresAt)}</span>
      <span>🕘 最近访问：{formatDateTime(file.lastAccessTime)}</span>
      <span>访问或预览会自动向后延期 {idleDays} 天</span>
    </div>
  );
}

function PreviewModal({ file, onClose, onCopy, onDelete, onOpenExternal, adminMode = false }) {
  if (!file) return null;

  const sameSitePreviewUrl = getSameSitePreviewUrl(file, API_BASE) || getDirectViewUrl(file, API_BASE);
  const previewUrl = sameSitePreviewUrl ? `${sameSitePreviewUrl}${sameSitePreviewUrl.includes('?') ? '&' : '?'}embed=1` : '';
  const externalPreviewUrl = getDirectViewUrl(file, API_BASE) || sameSitePreviewUrl;
  const originalUrl = file.url || file.directUrl || file.shortUrl || externalPreviewUrl;
  const kind = getPreviewKind(file);
  const title = file.originalName || file.filename || '文件预览';
  const nativeMediaUrl = ['image', 'video', 'audio'].includes(kind)
    ? appendQueryParam(
      file.id ? `${API_BASE}/f/${encodeURIComponent(file.id)}/${encodeURIComponent(title)}` : (buildPreviewUrl(file) || originalUrl),
      'previewEmbed',
      '1'
    )
    : '';
  const displayTitle = compactMiddle(title, 76);

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${title} 本站预览`}>
      <div className="modal-content modal-content-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-toolbar">
          <div className="modal-title-block">
            <div className="modal-filename" title={title}>{displayTitle}</div>
            <div className="modal-subtitle modal-subtitle-chips">
              <span>默认本站查看</span>
              <span>{formatSize(file.size || 0)}</span>
              <span>{accessCountText(file)}</span>
              <span>过期 {formatCompactDateTime(file.expiresAt)}</span>
              <span>访问/预览自动延期</span>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-copy" onClick={() => onCopy(file.shortUrl || file.url)}>复制</button>
            <button className="btn btn-copy" onClick={() => onCopy(file.markdown || file.url)}>MD</button>
            <button className="btn btn-open" onClick={() => onOpenExternal(file)}>预览</button>
            <button className="btn btn-open" onClick={() => window.open(originalUrl, '_blank', 'noopener,noreferrer')}>原文件</button>
            {adminMode ? <button className="btn btn-delete" onClick={() => { onDelete(file.id, title); onClose(); }}>删除</button> : null}
            <button className="modal-close" onClick={onClose} aria-label="关闭预览">✕</button>
          </div>
        </div>
        {kind === 'image' ? (
          <div className="modal-preview-stage modal-preview-image-stage">
            <img className="modal-preview-image" src={nativeMediaUrl} alt={title} />
          </div>
        ) : kind === 'video' ? (
          <div className="modal-preview-stage modal-preview-video-stage">
            <video className="modal-preview-video" src={nativeMediaUrl} controls playsInline preload="metadata" />
          </div>
        ) : kind === 'audio' ? (
          <div className="modal-preview-stage modal-preview-audio-stage">
            <div className="modal-audio-card">
              <div className="modal-audio-icon">🎵</div>
              <div className="modal-audio-title" title={title}>{displayTitle}</div>
              <audio className="modal-preview-audio" src={nativeMediaUrl} controls preload="metadata" />
            </div>
          </div>
        ) : (
          <iframe className="modal-preview-frame" src={previewUrl} title={title} />
        )}
      </div>
    </div>
  );
}

function FileEditModal({ file, saving = false, onClose, onSave }) {
  const [draft, setDraft] = useState({ title: '', description: '', tagsText: '' });

  useEffect(() => {
    if (!file) return;
    setDraft({
      title: file.title || file.originalName || file.filename || '',
      description: file.description || '',
      tagsText: Array.isArray(file.tags) ? file.tags.join(', ') : ''
    });
  }, [file]);

  if (!file) return null;

  const submit = (event) => {
    event.preventDefault();
    onSave({
      title: draft.title.trim(),
      description: draft.description.trim(),
      tags: draft.tagsText.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20),
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="编辑视频信息">
      <form className="edit-modal-content glass" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="settings-header">
          <div>
            <div className="settings-title">编辑视频信息</div>
            <div className="settings-subtitle" title={file.originalName || file.filename}>{compactMiddle(file.originalName || file.filename || '视频文件', 54)}</div>
          </div>
          <button type="button" className="modal-close settings-close" onClick={onClose} aria-label="关闭编辑">✕</button>
        </div>
        <label className="edit-field">
          <span>显示标题</span>
          <input className="settings-input" value={draft.title} maxLength={180} onChange={e => setDraft(prev => ({ ...prev, title: e.target.value }))} placeholder="例如 IMG_0385.MOV" />
        </label>
        <label className="edit-field">
          <span>说明</span>
          <textarea className="settings-input note-textarea" value={draft.description} maxLength={1000} onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))} placeholder="可选：视频说明、用途或备注" />
        </label>
        <label className="edit-field">
          <span>标签</span>
          <input className="settings-input" value={draft.tagsText} onChange={e => setDraft(prev => ({ ...prev, tagsText: e.target.value }))} placeholder="用英文逗号分隔，例如 会议, 素材" />
        </label>
        <div className="edit-modal-actions">
          <button type="button" className="btn btn-open" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="btn btn-copy" disabled={saving}>{saving ? '保存中...' : '保存信息'}</button>
        </div>
      </form>
    </div>
  );
}

function SettingsPanel({
  open,
  onClose,
  adminToken,
  setAdminToken,
  adminMode,
  maxFileBytes,
  publicConfig,
  onSaveToken,
  onClearToken,
  logs,
  logsLoading,
  logsError,
  onRefreshLogs,
}) {
  if (!open) return null;

  const modeText = adminMode ? '管理员模式：10GB/文件' : '访客模式：1GB/文件';
  const logCount = logs?.length || 0;

  return (
    <div className="settings-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="站点设置与日志">
      <section className="settings-panel glass" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <div>
            <div className="settings-title">⚙️ 站点设置</div>
            <div className="settings-subtitle">Token、查看方式、上传日志集中管理</div>
          </div>
          <button className="modal-close settings-close" onClick={onClose} aria-label="关闭设置">✕</button>
        </div>

        <div className="settings-grid">
          <section className="settings-section settings-section-main">
            <div className="settings-section-title">管理员 Token</div>
            <div className="settings-section-desc">保存后启用 10GB 上传、删除与日志查看；Token 只保存在本机浏览器。</div>
            <div className="settings-token-row">
              <input
                className="settings-input"
                type="password"
                placeholder="输入管理员 Token"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSaveToken()}
              />
              <button className="btn btn-copy" onClick={onSaveToken}>保存</button>
              <button className="btn btn-delete" onClick={onClearToken}>清除</button>
            </div>
            <div className={`settings-mode-card ${adminMode ? 'admin' : ''}`}>
              <span>{adminMode ? '✅' : '👤'}</span>
              <div>
                <div className="settings-mode-title">{modeText}</div>
                <div className="settings-mode-desc">当前单文件最大 {formatSize(maxFileBytes)} · 公共 {publicConfig.publicMaxFileMB || 1024}MB / 管理员 {publicConfig.adminMaxFileMB || 10240}MB</div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">查看与跳转</div>
            <div className="settings-section-desc">封面默认在本站浮窗查看；文件卡和预览浮窗保留“跳转预览 / 原文件”入口。</div>
            <div className="settings-feature-list">
              <span>👁 本站默认查看</span>
              <span>↗ 新窗口跳转预览</span>
              <span>📎 原文件直达</span>
            </div>
          </section>
        </div>

        <section className="settings-section settings-logs-section">
          <div className="settings-logs-header">
            <div>
              <div className="settings-section-title">上传日志</div>
              <div className="settings-section-desc">最近上传、失败和客户端错误日志；需要管理员 Token。</div>
            </div>
            <button className="btn btn-open" onClick={() => onRefreshLogs()} disabled={logsLoading}>{logsLoading ? '刷新中...' : `刷新日志${logCount ? `（${logCount}）` : ''}`}</button>
          </div>

          {logsError ? <div className="settings-log-empty error">{logsError}</div> : null}
          {!logsError && logsLoading ? <div className="settings-log-empty">正在加载日志...</div> : null}
          {!logsError && !logsLoading && !logCount ? <div className="settings-log-empty">暂无日志，或尚未保存管理员 Token。</div> : null}

          {!logsError && !logsLoading && logCount > 0 && (
            <div className="settings-log-list">
              {logs.slice(0, 80).map(log => (
                <article key={log.id || `${log.ts}-${log.event}`} className={`settings-log-item ${log.level === 'error' ? 'error' : ''}`}>
                  <div className="settings-log-topline">
                    <span className="settings-log-event">{log.event || 'upload_event'}</span>
                    <span className="settings-log-time">{log.ts ? formatDate(log.ts) : '未知时间'}</span>
                  </div>
                  <div className="settings-log-meta">
                    {log.status && <span>状态 {log.status}</span>}
                    {log.uploadTier && <span>{log.uploadTier}</span>}
                    {Number.isFinite(Number(log.fileCount)) && <span>{log.fileCount} 个文件</span>}
                    {Number.isFinite(Number(log.totalSize)) && Number(log.totalSize) > 0 && <span>{formatSize(log.totalSize)}</span>}
                    {log.durationMs && <span>{log.durationMs}ms</span>}
                    {log.request?.path && <span>{log.request.path}</span>}
                  </div>
                  {log.error && <div className="settings-log-error">{String(log.error).slice(0, 180)}</div>}
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

function UploadResults({ files, onCopy, onClear, onOpenSiteView, onOpenDirectView }) {
  if (!files.length) return null;

  return (
    <section className="upload-results glass">
      <div className="upload-results-header">
        <div>
          <div className="section-title">刚刚上传成功</div>
          <div className="section-subtitle">支持直接查看/预览，直链、短链已经生成，可直接复制分享</div>
        </div>
        <button className="btn btn-copy" onClick={onClear}>清空结果</button>
      </div>

      <div className="upload-result-list">
        {files.map(file => {
          const link = file.shortUrl || file.url || file.directUrl;
          const image = isPreviewableImage(file);
          const openResult = () => onOpenSiteView(file);
          const handleResultKeyDown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openResult();
            }
          };
          return (
            <article key={file.id || file.filename || link} className="upload-result-card">
              <div
                className="upload-result-preview preview-click-target"
                onClick={openResult}
                onKeyDown={handleResultKeyDown}
                role="button"
                tabIndex={0}
                title="点击在本站查看内容"
              >
                {image ? (
                  <img src={file.url || file.directUrl} alt={file.originalName || file.filename} loading="lazy" />
                ) : (
                  <div className="file-type-icon">{getFileTypeIcon(file.mimeType)}</div>
                )}
              </div>
              <div className="upload-result-info">
                <div className="upload-result-topline">
                  <div className="upload-result-name" title={file.originalName || file.filename}>{file.originalName || file.filename}</div>
                  <span className="result-success-badge">已就绪</span>
                </div>
                <div className="upload-result-meta">
                  <span>{formatSize(file.size || 0)}</span>
                  <span>上传 {file.uploadDate || formatDate(file.uploadTime)}</span>
                </div>
                <FileLifecycleMeta file={file} compact />
                {isVideoFile(file) && <div className={`feed-status-pill ${file.allowFeed && file.feedStatus === 'approved' ? 'active' : ''}`}>🎬 {getFeedBadge(file)}</div>}
                <div className="link-row compact-link-row">
                  <span className="link-row-label">短链</span>
                  <input className="link-input" readOnly value={link || ''} onFocus={e => e.target.select()} />
                  <button className="btn btn-copy" onClick={() => onCopy(link)}>复制</button>
                </div>
                <div className="upload-result-actions">
                  <button className="btn btn-open" onClick={openResult}>👁 本站</button>
                  <button className="btn btn-open" onClick={() => onOpenDirectView(file)}>↗ 预览</button>
                  <button className="btn btn-copy" onClick={() => onCopy(file.url)}>长链</button>
                  <button className="btn btn-copy" onClick={() => onCopy(file.markdown || file.url)}>MD</button>
                  <button className="btn btn-open" onClick={() => window.open(file.url || link, '_blank')}>原文件</button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FeedSection({
  videos,
  loading,
  adminMode,
  feedManageItems,
  feedManageSummary,
  feedManageLoading,
  feedManageStatus,
  selectedFeedIds,
  onRefresh,
  onOpenSiteView,
  onOpenDirectView,
  onFetchFeedManage,
  onSetFeedManageStatus,
  onToggleFeedSelect,
  onFeedBatchAction,
}) {
  const selectedCount = selectedFeedIds.length;
  return (
    <section className="content-panel glass feed-panel">
      <div className="panel-header">
        <div>
          <div className="section-title">🎬 视频推荐区</div>
          <div className="section-subtitle">只展示已明确允许进入推荐区的视频；默认上传不会自动公开到这里。</div>
        </div>
        <button className="btn btn-open" onClick={onRefresh} disabled={loading}>{loading ? '刷新中...' : '刷新推荐'}</button>
      </div>
      {adminMode ? (
        <div className="feed-admin-panel">
          <div className="feed-admin-header">
            <div>
              <div className="feed-admin-title">推荐区后台批量管理</div>
              <div className="feed-admin-subtitle">
                已推荐 {feedManageSummary.approved || 0} · 待审核 {feedManageSummary.pending || 0} · 已拒绝 {feedManageSummary.rejected || 0} · 未推荐 {feedManageSummary.hidden || 0}
              </div>
            </div>
            <div className="feed-admin-actions">
              <select className="feed-admin-select" value={feedManageStatus} onChange={(e) => onSetFeedManageStatus(e.target.value)}>
                <option value="all">全部视频</option>
                <option value="approved">推荐中</option>
                <option value="pending">待审核</option>
                <option value="hidden">未推荐</option>
                <option value="rejected">已拒绝</option>
              </select>
              <button className="btn btn-open" onClick={onFetchFeedManage} disabled={feedManageLoading}>{feedManageLoading ? '加载中...' : '刷新后台'}</button>
              <button className="btn btn-delete" onClick={() => onFeedBatchAction('clear-approved')} disabled={feedManageLoading || !(feedManageSummary.approved > 0)}>一键取消全部推荐</button>
            </div>
          </div>
          <div className="feed-admin-batch-actions">
            <button className="btn btn-copy" onClick={() => onFeedBatchAction('approve')} disabled={!selectedCount}>选中进推荐</button>
            <button className="btn btn-open" onClick={() => onFeedBatchAction('hide')} disabled={!selectedCount}>选中取消推荐</button>
            <button className="btn btn-delete" onClick={() => onFeedBatchAction('reject')} disabled={!selectedCount}>选中拒绝</button>
            <span>已选 {selectedCount} 个视频</span>
          </div>
          {feedManageLoading ? <div className="settings-log-empty">正在加载推荐后台...</div> : null}
          {!feedManageLoading && !feedManageItems.length ? <div className="settings-log-empty">当前筛选下暂无视频。</div> : null}
          {!feedManageLoading && feedManageItems.length > 0 ? (
            <div className="feed-admin-list">
              {feedManageItems.map(item => (
                <label key={item.id} className="feed-admin-item">
                  <input type="checkbox" checked={selectedFeedIds.includes(item.id)} onChange={() => onToggleFeedSelect(item.id)} />
                  <span className={`feed-status-pill ${item.allowFeed && item.feedStatus === 'approved' ? 'active' : ''}`}>{getFeedBadge(item)}</span>
                  <span className="feed-admin-name" title={item.originalName || item.filename}>{item.title || item.originalName || item.filename}</span>
                  <span className="feed-admin-meta">{formatSize(item.size || 0)} · {formatDate(item.uploadTime)}</span>
                  <button type="button" className="btn btn-open" onClick={(e) => { e.preventDefault(); onOpenSiteView(item); }}>预览</button>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {loading ? <div className="empty-state compact"><div className="loading-spinner" /><div className="empty-text">加载视频推荐...</div></div> : null}
      {!loading && !videos.length ? (
        <div className="empty-state compact">
          <div className="empty-icon">🎞️</div>
          <div className="empty-text">暂无推荐视频</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>管理员可在视频文件卡片中点击“进推荐”后出现在这里。</div>
        </div>
      ) : null}
      {!loading && videos.length > 0 ? (
        <div className="feed-reel">
          {videos.map(video => {
            const source = buildPreviewUrl(video) || video.url;
            return (
              <article key={video.id} className="feed-card">
                <video className="feed-video" src={source} controls playsInline preload="metadata" />
                <div className="feed-card-info">
                  <div className="feed-title">{video.title || video.originalName}</div>
                  <div className="feed-meta">{formatSize(video.size || 0)} · {accessCountText(video)} · {formatDate(video.uploadTime)}</div>
                  {video.description ? <div className="feed-desc">{video.description}</div> : null}
                  {Array.isArray(video.tags) && video.tags.length ? <div className="feed-tags">{video.tags.map(tag => <span key={tag}>{tag}</span>)}</div> : null}
                  <div className="feed-actions">
                    <button className="btn btn-open" onClick={() => onOpenSiteView(video)}>👁 详情预览</button>
                    <button className="btn btn-copy" onClick={() => onOpenDirectView(video)}>↗ 原文件</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function NotesSection({
  notes,
  loading,
  adminMode,
  noteDraft,
  setNoteDraft,
  editingNoteId,
  noteHistories,
  historyLoadingId,
  onSaveNote,
  onCancelEdit,
  onEditNote,
  onDeleteNote,
  onShowHistory,
  onRefresh
}) {
  const editing = Boolean(editingNoteId);
  return (
    <section className="content-panel glass notes-panel">
      <div className="panel-header">
        <div>
          <div className="section-title">📝 笔记</div>
          <div className="section-subtitle">支持公开/私有笔记、重编辑、软删除和历史版本；发布/编辑/删除需要管理员 Token。</div>
        </div>
        <button className="btn btn-open" onClick={onRefresh} disabled={loading}>{loading ? '刷新中...' : '刷新笔记'}</button>
      </div>
      {adminMode ? (
        <div className={`note-editor ${editing ? 'editing' : ''}`}>
          <div className="note-editor-mode">{editing ? '正在编辑已有笔记，保存后会自动写入历史版本' : '新建笔记'}</div>
          <input className="settings-input" placeholder="笔记标题" value={noteDraft.title} onChange={e => setNoteDraft(prev => ({ ...prev, title: e.target.value }))} />
          <textarea className="settings-input note-textarea" placeholder="写一点说明、剪辑想法或文件备注，支持 Markdown" value={noteDraft.content} onChange={e => setNoteDraft(prev => ({ ...prev, content: e.target.value }))} />
          <input className="settings-input" placeholder="标签，用英文逗号分隔" value={noteDraft.tagsText} onChange={e => setNoteDraft(prev => ({ ...prev, tagsText: e.target.value }))} />
          <label className="note-public-toggle"><input type="checkbox" checked={noteDraft.publicNote} onChange={e => setNoteDraft(prev => ({ ...prev, publicNote: e.target.checked }))} /> 公开展示</label>
          <div className="note-editor-actions">
            <button className="btn btn-copy" onClick={onSaveNote}>{editing ? '保存修改' : '发布笔记'}</button>
            {editing ? <button className="btn btn-open" onClick={onCancelEdit}>取消编辑</button> : null}
          </div>
        </div>
      ) : (
        <div className="settings-log-empty">保存管理员 Token 后可以创建、编辑、删除并查看笔记历史。</div>
      )}
      {loading ? <div className="empty-state compact"><div className="loading-spinner" /><div className="empty-text">加载笔记...</div></div> : null}
      {!loading && !notes.length ? <div className="empty-state compact"><div className="empty-icon">📒</div><div className="empty-text">暂无笔记</div></div> : null}
      {!loading && notes.length ? (
        <div className="note-list">
          {notes.map(note => {
            const history = noteHistories[note.id] || [];
            return (
              <article key={note.id} className="note-card">
                <div className="note-card-top"><strong>{note.title || '未命名笔记'}</strong><span>{note.visibility === 'public' ? '公开' : '私有'}</span></div>
                <p>{note.content}</p>
                {Array.isArray(note.tags) && note.tags.length ? <div className="feed-tags">{note.tags.map(tag => <span key={tag}>{tag}</span>)}</div> : null}
                <div className="feed-meta">创建 {formatDate(note.createdAt)} · 更新 {formatDate(note.updatedAt || note.createdAt)}</div>
                {adminMode ? (
                  <div className="note-actions">
                    <button className="btn btn-copy" onClick={() => onEditNote(note)}>重编辑</button>
                    <button className="btn btn-open" onClick={() => onShowHistory(note.id)} disabled={historyLoadingId === note.id}>{historyLoadingId === note.id ? '加载历史...' : `历史${history.length ? `(${history.length})` : ''}`}</button>
                    <button className="btn btn-delete" onClick={() => onDeleteNote(note.id)}>删除</button>
                  </div>
                ) : null}
                {history.length > 0 ? (
                  <div className="note-history-list">
                    {history.map(item => (
                      <div key={item.id || `${note.id}-${item.revision}`} className={`note-history-item ${item.action}`}>
                        <div><strong>版本 {item.revision}</strong> · {item.action === 'created' ? '创建' : item.action === 'deleted' ? '删除' : '修改'} · {formatDateTime(item.createdAt)}</div>
                        <div className="note-history-title">{item.title || '未命名笔记'} · {item.visibility === 'public' ? '公开' : '私有'}</div>
                        <div className="note-history-content">{item.content}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [stats, setStats] = useState({ totalFiles: 0, totalSize: 0, totalAccessCount: 0, imageCount: 0, videoCount: 0, otherCount: 0, maxFileMB: DEFAULT_MAX_FILE_MB, expireAfterIdleDays: DEFAULT_EXPIRE_AFTER_IDLE_DAYS, uploadTier: 'public' });
  const [publicConfig, setPublicConfig] = useState({ maxFileMB: DEFAULT_MAX_FILE_MB, publicMaxFileMB: 1024, adminMaxFileMB: 10240, uploadTier: 'public', expireAfterIdleDays: DEFAULT_EXPIRE_AFTER_IDLE_DAYS, publicUpload: true, resumableUpload: true, resumableChunkSize: 8 * 1024 * 1024 });
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('latest');
  const [page, setPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [uploadError, setUploadError] = useState(null);
  const [uploadFeedRequested, setUploadFeedRequested] = useState(false);
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [uploadResults, setUploadResults] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);
  const [copiedUrl, setCopiedUrl] = useState('');
  const [openMoreId, setOpenMoreId] = useState('');
  const [editingFile, setEditingFile] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('tuchuang_admin_token') || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadLogs, setUploadLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [needToken, setNeedToken] = useState(false);
  const [activeView, setActiveView] = useState('files');
  const [feedVideos, setFeedVideos] = useState([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedManageItems, setFeedManageItems] = useState([]);
  const [feedManageSummary, setFeedManageSummary] = useState({ totalVideos: 0, approved: 0, pending: 0, rejected: 0, hidden: 0 });
  const [feedManageLoading, setFeedManageLoading] = useState(false);
  const [feedManageStatus, setFeedManageStatus] = useState('all');
  const [selectedFeedIds, setSelectedFeedIds] = useState([]);
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState({ title: '', content: '', tagsText: '', publicNote: false });
  const [editingNoteId, setEditingNoteId] = useState('');
  const [noteHistories, setNoteHistories] = useState({});
  const [historyLoadingId, setHistoryLoadingId] = useState('');
  const fileInputRef = useRef(null);
  const searchTimerRef = useRef(null);
  const maxFileMB = publicConfig.maxFileMB || stats.maxFileMB || DEFAULT_MAX_FILE_MB;
  const expireAfterIdleDays = publicConfig.expireAfterIdleDays || stats.expireAfterIdleDays || DEFAULT_EXPIRE_AFTER_IDLE_DAYS;
  const maxFileBytes = maxFileMB * 1024 * 1024;
  const uploadLimitText = maxFileMB >= 1024 ? `${Number(maxFileMB / 1024).toLocaleString('zh-CN')}GB` : `${maxFileMB}MB`;
  const uploadTier = publicConfig.uploadTier || stats.uploadTier || 'public';
  const adminMode = uploadTier === 'admin';
  const authHeaders = useCallback((extra = {}) => ({ ...(adminToken ? { 'X-Admin-Token': adminToken } : {}), ...extra }), [adminToken]);

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const friendlyUploadError = useCallback((error, context = {}) => (
    getFriendlyUploadError(error, { ...context, maxFileBytes })
  ), [maxFileBytes]);

  const reportUploadFailure = useCallback(async (payload) => {
    try {
      const res = await fetch(`${API_BASE}/api/upload-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'error', event: 'client_upload_failure', ...payload })
      });
      const data = await res.json().catch(() => ({}));
      return data.logId || payload.logId || '';
    } catch (e) {
      return payload.logId || '';
    }
  }, []);

  const fetchPublicConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/health`, { headers: authHeaders() });
      const data = await res.json();
      if (data.success) {
        setPublicConfig({
          maxFileMB: data.maxFileMB || DEFAULT_MAX_FILE_MB,
          publicMaxFileMB: data.publicMaxFileMB || 1024,
          adminMaxFileMB: data.adminMaxFileMB || 10240,
          uploadTier: data.uploadTier || 'public',
          expireAfterIdleDays: data.expireAfterIdleDays || DEFAULT_EXPIRE_AFTER_IDLE_DAYS,
          publicUpload: data.publicUpload !== false,
          resumableUpload: data.resumableUpload !== false,
          resumableChunkSize: data.resumableChunkSize || 8 * 1024 * 1024,
        });
      }
    } catch (e) {
      // Keep built-in public upload defaults if health is temporarily unavailable.
    }
  }, [authHeaders]);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 200, search, type: filter, sort });
      const res = await fetch(`${API_BASE}/api/files?${params}`, { headers: authHeaders() });
      if (res.status === 401) {
        setNeedToken(true);
        setFiles([]);
        return;
      }
      const data = await res.json();
      if (data.success) {
        setNeedToken(false);
        setFiles(sortFilesForView(data.files, sort));
        setPagination(data.pagination);
      }
    } catch (e) {
      addToast('加载文件列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search, filter, sort, authHeaders, addToast]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/stats`, { headers: authHeaders() });
      if (res.status === 401) return setNeedToken(true);
      const data = await res.json();
      if (data.success) setStats(data.stats);
    } catch (e) {}
  }, [authHeaders]);

  const fetchFeedVideos = useCallback(async () => {
    setFeedLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/feed/videos?limit=20`);
      const data = await res.json().catch(() => ({}));
      if (data.success) setFeedVideos(Array.isArray(data.videos) ? data.videos : []);
    } catch (e) {
      addToast('加载视频推荐失败', 'error');
    } finally {
      setFeedLoading(false);
    }
  }, [addToast]);

  const fetchFeedManage = useCallback(async () => {
    if (!adminToken) {
      setFeedManageItems([]);
      setSelectedFeedIds([]);
      return;
    }
    setFeedManageLoading(true);
    try {
      const params = new URLSearchParams({ limit: 80, status: feedManageStatus });
      const res = await fetch(`${API_BASE}/api/admin/feed/videos?${params}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法加载推荐后台', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      const items = Array.isArray(data.files) ? data.files : [];
      setFeedManageItems(items);
      setFeedManageSummary(data.summary || { totalVideos: 0, approved: 0, pending: 0, rejected: 0, hidden: 0 });
      setSelectedFeedIds(prev => prev.filter(id => items.some(item => item.id === id)));
    } catch (e) {
      addToast(`推荐后台加载失败：${e.message || e}`, 'error');
    } finally {
      setFeedManageLoading(false);
    }
  }, [adminToken, authHeaders, feedManageStatus, addToast]);

  const fetchNotes = useCallback(async () => {
    setNotesLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/notes?limit=80`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (data.success) setNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch (e) {
      addToast('加载笔记失败', 'error');
    } finally {
      setNotesLoading(false);
    }
  }, [authHeaders, addToast]);

  const refreshFileRecord = useCallback(async (fileId) => {
    if (!fileId) return;
    try {
      const params = new URLSearchParams({ page: 1, limit: 1, search: fileId, type: '' });
      const res = await fetch(`${API_BASE}/api/files?${params}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      const updated = Array.isArray(data.files) ? data.files.find(item => item.id === fileId || item.filename === fileId) : null;
      if (!updated) return;
      const mergeOne = item => ((item.id === updated.id || item.filename === updated.filename) ? { ...item, ...updated } : item);
      setFiles(prev => prev.map(mergeOne));
      setUploadResults(prev => prev.map(mergeOne));
      setPreviewFile(prev => (prev && (prev.id === updated.id || prev.filename === updated.filename) ? { ...prev, ...updated } : prev));
      fetchStats();
    } catch (e) {}
  }, [authHeaders, fetchStats]);

  const fetchUploadLogs = useCallback(async (tokenOverride = adminToken) => {
    const token = String(tokenOverride || '').trim();
    if (!token) {
      setUploadLogs([]);
      setLogsError('请先在设置里保存管理员 Token 后查看日志');
      return;
    }
    setLogsLoading(true);
    setLogsError('');
    try {
      const res = await fetch(`${API_BASE}/api/upload-logs?limit=80`, { headers: { 'X-Admin-Token': token } });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        setUploadLogs([]);
        setLogsError('管理员 Token 无效或未保存，无法查看日志');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      setUploadLogs(Array.isArray(data.logs) ? data.logs : []);
    } catch (e) {
      setUploadLogs([]);
      setLogsError(`日志加载失败：${e.message || e}`);
    } finally {
      setLogsLoading(false);
    }
  }, [adminToken]);

  useEffect(() => { fetchPublicConfig(); }, [fetchPublicConfig]);
  useEffect(() => { fetchFiles(); }, [fetchFiles]);
  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => {
    if (activeView === 'feed') {
      fetchFeedVideos();
      if (adminMode) fetchFeedManage();
    }
    if (activeView === 'notes') fetchNotes();
  }, [activeView, adminMode, fetchFeedVideos, fetchFeedManage, fetchNotes]);
  useEffect(() => {
    if (settingsOpen && adminToken) fetchUploadLogs();
  }, [settingsOpen, adminToken, fetchUploadLogs]);
  useEffect(() => {
    if (!openMoreId) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpenMoreId('');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openMoreId]);

  const handleSearch = (value) => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 300);
  };

  const handleUpload = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const selectedFiles = Array.from(fileList);
    setUploadPanelOpen(true);
    const uploadFeedPreference = buildUploadFeedPreference(uploadFeedRequested);
    const oversized = selectedFiles.filter(file => file.size > maxFileBytes);
    if (oversized.length > 0) {
      addToast(`单文件最大 ${formatSize(maxFileBytes)}，超限：${oversized[0].name}`, 'error');
      return;
    }

    const uploadJson = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.logId = data.logId;
        throw err;
      }
      return data;
    };

    const uploadChunk = (uploadId, chunk, onProgress) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      });
      xhr.onload = () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else {
          const err = new Error(payload?.error || `Chunk upload failed (${xhr.status})`);
          err.status = xhr.status;
          err.logId = payload?.logId;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.open('PUT', `${API_BASE}/api/uploads/${encodeURIComponent(uploadId)}/chunks/${chunk.index}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (adminToken) xhr.setRequestHeader('X-Admin-Token', adminToken);
      xhr.send(chunk.blob);
    });

    const uploadSimpleBatch = (batchFiles, baseLoaded, totalBytes) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const batchBytes = batchFiles.reduce((sum, file) => sum + file.size, 0);
      xhr.upload.addEventListener('progress', (e) => {
        const loaded = baseLoaded + (e.lengthComputable ? e.loaded : 0);
        setUploadProgress(Math.min(99, Math.round((loaded / totalBytes) * 100)));
      });
      xhr.onload = () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status === 200) resolve({ payload, loadedBytes: batchBytes });
        else {
          const err = new Error(payload?.error || `Upload failed (${xhr.status})`);
          err.status = xhr.status;
          err.logId = payload?.logId;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      const formData = new FormData();
      for (const file of batchFiles) formData.append('files', file);
      if (uploadFeedPreference) formData.append('feedPreference', uploadFeedPreference);
      xhr.open('POST', `${API_BASE}/api/upload`);
      if (adminToken) xhr.setRequestHeader('X-Admin-Token', adminToken);
      xhr.send(formData);
    });

    setUploading(true);
    setUploadProgress(0);
    setUploadStatusText('准备上传...');
    setUploadError(null);

    const failureContext = { phase: 'prepare', fileName: '', size: 0, uploadId: '', chunkIndex: null };

    try {
      const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0) || 1;
      let completedBytes = 0;
      const uploadedFiles = [];
      const chunkSize = publicConfig.resumableChunkSize || 8 * 1024 * 1024;
      const resumableThreshold = 32 * 1024 * 1024;
      const simpleFiles = selectedFiles.filter(file => !(publicConfig.resumableUpload && shouldUseResumableUpload(file, resumableThreshold)));
      const resumableFiles = selectedFiles.filter(file => publicConfig.resumableUpload && shouldUseResumableUpload(file, resumableThreshold));

      if (simpleFiles.length) {
        failureContext.phase = 'simple_upload';
        failureContext.fileName = simpleFiles.map(file => file.name).join(', ');
        failureContext.size = simpleFiles.reduce((sum, file) => sum + file.size, 0);
        setUploadStatusText(`普通上传 ${simpleFiles.length} 个小文件...`);
        const result = await uploadSimpleBatch(simpleFiles, completedBytes, totalBytes);
        completedBytes += result.loadedBytes;
        uploadedFiles.push(...(result.payload?.files || []));
      }

      for (const file of resumableFiles) {
        failureContext.phase = 'init';
        failureContext.fileName = file.name;
        failureContext.size = file.size;
        failureContext.uploadId = '';
        failureContext.chunkIndex = null;
        setUploadStatusText(`断点续传：初始化 ${file.name}`);
        const init = await uploadJson(`${API_BASE}/api/uploads/init`, {
          originalName: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          lastModified: file.lastModified || 0,
          fingerprint: buildFileFingerprint(file),
          chunkSize,
          feedPreference: uploadFeedPreference
        });

        if (init.file) {
          uploadedFiles.push(init.file);
          completedBytes += file.size;
          setUploadProgress(Math.round((completedBytes / totalBytes) * 100));
          continue;
        }

        const received = new Set(init.receivedChunks || []);
        failureContext.uploadId = init.uploadId;
        const chunks = getFileChunks(file, init.chunkSize || chunkSize);
        let fileLoaded = (init.uploadedBytes || 0);
        for (const chunk of chunks) {
          if (received.has(chunk.index)) continue;
          failureContext.phase = 'chunk_upload';
          failureContext.chunkIndex = chunk.index;
          setUploadStatusText(`断点续传：${file.name} 分片 ${chunk.index + 1}/${chunks.length}`);
          let lastChunkLoaded = 0;
          await uploadChunk(init.uploadId, chunk, (chunkLoaded) => {
            const delta = Math.max(chunkLoaded - lastChunkLoaded, 0);
            lastChunkLoaded = chunkLoaded;
            const loaded = completedBytes + fileLoaded + delta;
            setUploadProgress(Math.min(99, Math.round((loaded / totalBytes) * 100)));
          });
          fileLoaded += chunk.blob.size;
        }

        failureContext.phase = 'complete';
        failureContext.chunkIndex = null;
        setUploadStatusText(`断点续传：合并 ${file.name}`);
        const complete = await uploadJson(`${API_BASE}/api/uploads/${encodeURIComponent(init.uploadId)}/complete`, {});
        if (complete.file) uploadedFiles.push(complete.file);
        completedBytes += file.size;
        setUploadProgress(Math.round((completedBytes / totalBytes) * 100));
      }

      if (uploadedFiles.length) {
        setUploadResults(prev => mergeUploadedResults(prev, uploadedFiles));
        addToast(`成功上传 ${uploadedFiles.length} 个文件，链接已生成`, 'success');
        fetchFiles();
        fetchStats();
      }
    } catch (e) {
      const friendly = friendlyUploadError(e, failureContext);
      const serverLogId = e.logId || '';
      const clientLogId = await reportUploadFailure({
        ...failureContext,
        progress: uploadProgress,
        error: e.message || String(e),
        logId: serverLogId,
        details: { status: e.status, serverLogId }
      });
      const logId = serverLogId || clientLogId;
      setUploadError({ ...friendly, raw: e.message || String(e), logId, context: { ...failureContext } });
      addToast(`${friendly.message}${logId ? `（日志 ${logId.slice(0, 8)}）` : ''}`, 'error');
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadStatusText('');
    }
  }, [addToast, adminToken, authHeaders, fetchFiles, fetchStats, friendlyUploadError, maxFileBytes, publicConfig.resumableChunkSize, publicConfig.resumableUpload, reportUploadFailure, uploadFeedRequested, uploadProgress]);

  useEffect(() => {
    const onPaste = (event) => {
      const files = getClipboardUploadFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      setUploadPanelOpen(true);
      addToast(`检测到剪贴板文件，开始上传 ${files.length} 个`, 'info');
      handleUpload(files);
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addToast, handleUpload]);

  useEffect(() => {
    const hasFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    const onDragOver = (event) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDrop = (event) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      setDragging(false);
      setUploadPanelOpen(true);
      handleUpload(event.dataTransfer.files);
    };
    const onDragLeave = (event) => {
      if (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) {
        setDragging(false);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragleave', onDragLeave);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragleave', onDragLeave);
    };
  }, [handleUpload]);

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation?.();
    setDragging(false);
    setUploadPanelOpen(true);
    handleUpload(e.dataTransfer.files);
  };

  const handleCopy = async (url) => {
    if (!url) {
      addToast('没有可复制的链接', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      addToast('链接已复制到剪贴板', 'success');
      setTimeout(() => setCopiedUrl(''), 2000);
    } catch (e) {
      // Fallback
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedUrl(url);
      addToast('链接已复制', 'success');
      setTimeout(() => setCopiedUrl(''), 2000);
    }
  };

  const handleOpenSiteView = useCallback((file) => {
    if (!file) {
      addToast('没有可查看的文件', 'error');
      return;
    }
    setPreviewFile(file);
    window.setTimeout(() => refreshFileRecord(file.id || file.filename), 900);
  }, [addToast, refreshFileRecord]);

  const handleOpenDirectView = useCallback((file) => {
    const target = getDirectViewUrl(file, API_BASE) || file?.url || file?.shortUrl || file?.directUrl;
    if (!target) {
      addToast('没有可查看的链接', 'error');
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => refreshFileRecord(file.id || file.filename), 1200);
  }, [addToast, refreshFileRecord]);

  const handleDelete = async (id, name = '') => {
    const confirmed = typeof window === 'undefined' || window.confirm(`确定要删除该文件吗？\n${name ? `文件：${name}\n` : ''}删除后可能无法恢复。`);
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_BASE}/api/files/${id}`, { method: 'DELETE', headers: authHeaders() });
      if (res.status === 401) {
        setNeedToken(true);
        addToast('请输入管理员 Token 后再删除', 'error');
        return;
      }
      setOpenMoreId('');
      addToast('文件已删除', 'info');
      fetchFiles();
      fetchStats();
      if (activeView === 'feed') {
        fetchFeedVideos();
        fetchFeedManage();
      }
    } catch (e) {
      addToast('删除失败', 'error');
    }
  };

  const handleToggleFeed = async (file, enable) => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能调整推荐区', 'error');
      return;
    }
    if (enable && !isVideoFile(file)) {
      addToast('只有视频文件能进入推荐区', 'error');
      return;
    }
    try {
      const payload = buildFeedSettingsPayload(file, enable);
      const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(file.id)}/feed`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法调整推荐区', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      const updated = data.file;
      setFiles(prev => prev.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
      setUploadResults(prev => prev.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
      setPreviewFile(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
      setOpenMoreId('');
      addToast(enable ? '已允许该视频进入推荐区' : '已从推荐区隐藏', 'success');
      fetchStats();
      fetchFeedVideos();
      fetchFeedManage();
    } catch (e) {
      addToast(`推荐区更新失败：${e.message || e}`, 'error');
    }
  };

  const handleOpenEditFile = (file) => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能编辑视频信息', 'error');
      return;
    }
    setOpenMoreId('');
    setEditingFile(file);
  };

  const handleSaveFileInfo = async (draft) => {
    if (!editingFile) return;
    setEditSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(editingFile.id)}/feed`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(draft)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法保存信息', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      const updated = data.file;
      setFiles(prev => prev.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
      setUploadResults(prev => prev.map(item => (item.id === updated.id ? { ...item, ...updated } : item)));
      setPreviewFile(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
      setEditingFile(null);
      addToast('视频信息已保存', 'success');
      fetchFeedVideos();
      fetchFeedManage();
    } catch (e) {
      addToast(`保存信息失败：${e.message || e}`, 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const handleToggleFeedSelect = (id) => {
    setSelectedFeedIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };

  const handleFeedBatchAction = async (action) => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能批量管理推荐区', 'error');
      return;
    }
    const payload = buildFeedBatchPayload(action, selectedFeedIds);
    if (payload.action !== 'clear-approved' && (!payload.ids || payload.ids.length === 0)) {
      addToast('请先选择要批量处理的视频', 'error');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/admin/feed/batch`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法批量管理推荐区', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      setSelectedFeedIds([]);
      setFeedManageSummary(data.summary || feedManageSummary);
      addToast(payload.action === 'clear-approved' ? `已一键取消 ${data.updated || 0} 个推荐视频` : `已批量更新 ${data.updated || 0} 个视频`, 'success');
      fetchFeedVideos();
      fetchFeedManage();
      fetchFiles();
      fetchStats();
    } catch (e) {
      addToast(`批量管理失败：${e.message || e}`, 'error');
    }
  };

  const resetNoteEditor = useCallback(() => {
    setEditingNoteId('');
    setNoteDraft({ title: '', content: '', tagsText: '', publicNote: false });
  }, []);

  const handleSaveNote = async () => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能保存笔记', 'error');
      return;
    }
    const payload = normalizeNoteDraft(noteDraft);
    if (!payload.title || !payload.content) {
      addToast('请填写笔记标题和内容', 'error');
      return;
    }
    const editing = Boolean(editingNoteId);
    try {
      const res = await fetch(`${API_BASE}/api/notes${editing ? `/${encodeURIComponent(editingNoteId)}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法保存笔记', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      const saved = data.note;
      resetNoteEditor();
      addToast(editing ? '笔记已保存，历史版本已记录' : '笔记已发布', 'success');
      fetchNotes();
      if (editing && saved?.id) setNoteHistories(prev => ({ ...prev, [saved.id]: [] }));
    } catch (e) {
      addToast(`保存笔记失败：${e.message || e}`, 'error');
    }
  };

  const handleEditNote = (note) => {
    setEditingNoteId(note.id);
    setNoteDraft({
      title: note.title || '',
      content: note.content || '',
      tagsText: Array.isArray(note.tags) ? note.tags.join(', ') : '',
      publicNote: note.visibility === 'public'
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteNote = async (id) => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能删除笔记', 'error');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法删除笔记', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      if (editingNoteId === id) resetNoteEditor();
      setNoteHistories(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      addToast('笔记已删除，删除动作已写入历史', 'success');
      fetchNotes();
    } catch (e) {
      addToast(`删除笔记失败：${e.message || e}`, 'error');
    }
  };

  const handleShowNoteHistory = async (id) => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能查看笔记历史', 'error');
      return;
    }
    if (noteHistories[id]?.length) {
      setNoteHistories(prev => ({ ...prev, [id]: [] }));
      return;
    }
    setHistoryLoadingId(id);
    try {
      const res = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(id)}/history`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法查看笔记历史', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      setNoteHistories(prev => ({ ...prev, [id]: Array.isArray(data.history) ? data.history : [] }));
    } catch (e) {
      addToast(`加载笔记历史失败：${e.message || e}`, 'error');
    } finally {
      setHistoryLoadingId('');
    }
  };

  const saveToken = () => {
    const token = adminToken.trim();
    if (!token) {
      addToast('请输入管理员 Token，或使用清除恢复访客模式', 'error');
      return;
    }
    localStorage.setItem('tuchuang_admin_token', token);
    setAdminToken(token);
    setNeedToken(false);
    addToast('管理 Token 已保存，将尝试启用 10GB 上传、删除与日志能力', 'success');
    fetchPublicConfig();
    fetchFiles();
    fetchStats();
    fetchUploadLogs(token);
  };

  const clearToken = () => {
    localStorage.removeItem('tuchuang_admin_token');
    setAdminToken('');
    setNeedToken(false);
    setUploadLogs([]);
    setFeedManageItems([]);
    setSelectedFeedIds([]);
    setEditingNoteId('');
    setNoteHistories({});
    setHistoryLoadingId('');
    setLogsError('');
    addToast('已清除管理员 Token，恢复访客模式', 'info');
  };

  return (
    <div className="app-container" onClick={() => { if (openMoreId) setOpenMoreId(''); }}>
      <ToastContainer toasts={toasts} />

      {/* Header */}
      <header className="header glass hero-shell">
        <div className="header-brand">
          <div className="header-logo" aria-hidden="true">☁️</div>
          <div className="header-copy">
            <div className="header-kicker">ALLAPPLE FILE CLOUD</div>
            <div className="header-title-row">
              <div className="header-title">图床运营台</div>
              <span className={`mode-badge ${adminMode ? 'admin' : ''}`}>{adminMode ? '管理员模式' : '访客模式'}</span>
            </div>
            <div className="header-subtitle">原图原视频直传 · 大文件断点续传 · 访问自动续期 {expireAfterIdleDays} 天</div>
          </div>
        </div>
        <div className="header-right">
          <nav className="header-nav" aria-label="内容视图切换">
            {[
              { key: 'files', label: '文件上传' },
              { key: 'feed', label: `视频推荐${stats.feedVideoCount ? ` ${stats.feedVideoCount}` : ''}` },
              { key: 'notes', label: '笔记' },
            ].map(item => (
              <button key={item.key} className={`view-tab header-tab ${activeView === item.key ? 'active' : ''}`} onClick={() => setActiveView(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>
          {adminMode && (
            <div className="header-stats compact-stats" aria-label="当前图床统计">
              <span>{stats.totalFiles} 文件</span>
              <span>{formatSize(stats.totalSize)}</span>
              <span>{stats.imageCount} 图片</span>
              <span>{Number(stats.totalAccessCount || 0).toLocaleString('zh-CN')} 访问</span>
            </div>
          )}
          <button
            className={`settings-gear ${adminMode ? 'active' : ''}`}
            onClick={() => setSettingsOpen(true)}
            aria-label="打开站点设置和日志"
            title="设置 / Token / 日志"
          >
            <span className="settings-gear-icon">⚙</span>
            {adminMode && <span className="settings-gear-dot" />}
          </button>
        </div>
      </header>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        adminToken={adminToken}
        setAdminToken={setAdminToken}
        adminMode={adminMode}
        maxFileBytes={maxFileBytes}
        publicConfig={publicConfig}
        onSaveToken={saveToken}
        onClearToken={clearToken}
        logs={uploadLogs}
        logsLoading={logsLoading}
        logsError={logsError}
        onRefreshLogs={fetchUploadLogs}
      />


      <div className={`floating-upload-dock ${uploadPanelOpen ? 'expanded' : 'collapsed'} ${dragging ? 'dragging' : ''}`} onClick={(e) => e.stopPropagation()}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="floating-file-input"
          onChange={(e) => { handleUpload(e.target.files); e.target.value = ''; }}
        />
        {uploadPanelOpen ? (
          <section className="floating-upload-panel glass" aria-label="上传文件面板">
            <div className="floating-upload-header">
              <div>
                <div className="floating-upload-title">上传文件</div>
                <div className="floating-upload-subtitle">{adminMode ? '管理员通道 · 最高 10GB' : '访客模式 · 公开上传'}</div>
              </div>
              <div className="floating-upload-window-actions">
                <button className="floating-window-btn" onClick={() => setUploadPanelOpen(false)} aria-label="最小化上传面板">_</button>
                <button className="floating-window-btn" onClick={() => setUploadPanelOpen(false)} aria-label="关闭上传面板">×</button>
              </div>
            </div>

            <div
              className={`floating-upload-drop ${dragging ? 'dragging' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
              onDragLeave={(e) => { e.stopPropagation(); setDragging(false); }}
              onDrop={handleDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              aria-label="拖拽文件到这里，或点击上传"
            >
              <div className="floating-upload-drop-icon" aria-hidden="true">{uploading ? '⏳' : '⬆'}</div>
              <div className="floating-upload-drop-copy">
                <strong>{uploading ? (uploadStatusText || '正在上传...') : '拖拽文件到这里'}</strong>
                <span>或点击上传 / Ctrl+V 粘贴</span>
              </div>
            </div>

            <div className="floating-upload-rules">
              <span>原图原视频直传</span>
              <span>单文件 {uploadLimitText}</span>
              <span>8MB 分片</span>
              <span>{expireAfterIdleDays} 天过期</span>
            </div>

            <div className="floating-upload-options">
              <label
                className="upload-feed-toggle floating-feed-toggle"
                title={adminMode ? '管理员上传视频会直接推荐；非视频自动忽略。' : '访客上传视频需审核，通过后公开推荐。'}
              >
                <input
                  type="checkbox"
                  checked={uploadFeedRequested}
                  onChange={e => setUploadFeedRequested(e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
                <span className="upload-feed-text">
                  <strong>{adminMode ? '加入推荐' : '申请推荐'}</strong>
                  <small>{adminMode ? '视频直接推荐' : '访客需审核'}</small>
                </span>
              </label>
              <span className="floating-format-hint" title="支持 PNG、JPG、GIF、WebP、SVG、MP4、MP3、PDF、ZIP、DOC 等格式">支持 PNG / JPG / MP4 / PDF 等格式</span>
            </div>

            {uploading && (
              <div className="floating-upload-progress">
                <div className="progress-header">
                  <span className="progress-title">{uploadStatusText || '正在上传...'}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="progress-bar-bg">
                  <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            )}

            {uploadError && !uploading && (
              <div className="floating-upload-error" role="alert">
                <div>
                  <strong>{uploadError.message}</strong>
                  <span>{uploadError.hint}</span>
                  {uploadError.logId && <small>日志编号：{uploadError.logId}</small>}
                </div>
                <button className="btn btn-copy" onClick={() => setUploadError(null)}>知道了</button>
              </div>
            )}

            <UploadResults
              files={uploadResults}
              onCopy={handleCopy}
              onClear={() => setUploadResults([])}
              onOpenSiteView={handleOpenSiteView}
              onOpenDirectView={handleOpenDirectView}
            />
          </section>
        ) : (
          <button
            className={`floating-upload-button glass ${uploading ? 'uploading' : ''} ${uploadResults.length && !uploading ? 'done' : ''}`}
            onClick={() => setUploadPanelOpen(true)}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
            onDragLeave={(e) => { e.stopPropagation(); setDragging(false); }}
            onDrop={handleDrop}
            aria-label="打开上传文件浮窗"
          >
            <span className="floating-upload-icon" aria-hidden="true">⬆</span>
            <span className="floating-upload-label">{uploading ? '上传中' : uploadResults.length ? '上传成功' : '上传文件'}</span>
            <span className="floating-upload-status">{uploading ? `${uploadProgress}%` : uploadResults.length ? `${uploadResults.length} 个文件` : '点击 / 拖拽'}</span>
            {uploading && <span className="floating-upload-mini-progress"><i style={{ width: `${uploadProgress}%` }} /></span>}
          </button>
        )}
      </div>

      {activeView === 'feed' && (
        <FeedSection
          videos={feedVideos}
          loading={feedLoading}
          adminMode={adminMode}
          feedManageItems={feedManageItems}
          feedManageSummary={feedManageSummary}
          feedManageLoading={feedManageLoading}
          feedManageStatus={feedManageStatus}
          selectedFeedIds={selectedFeedIds}
          onRefresh={fetchFeedVideos}
          onOpenSiteView={handleOpenSiteView}
          onOpenDirectView={handleOpenDirectView}
          onFetchFeedManage={fetchFeedManage}
          onSetFeedManageStatus={setFeedManageStatus}
          onToggleFeedSelect={handleToggleFeedSelect}
          onFeedBatchAction={handleFeedBatchAction}
        />
      )}

      {activeView === 'notes' && (
        <NotesSection
          notes={notes}
          loading={notesLoading}
          adminMode={adminMode}
          noteDraft={noteDraft}
          setNoteDraft={setNoteDraft}
          editingNoteId={editingNoteId}
          noteHistories={noteHistories}
          historyLoadingId={historyLoadingId}
          onSaveNote={handleSaveNote}
          onCancelEdit={resetNoteEditor}
          onEditNote={handleEditNote}
          onDeleteNote={handleDeleteNote}
          onShowHistory={handleShowNoteHistory}
          onRefresh={fetchNotes}
        />
      )}

      {activeView === 'files' && (<>

      <div className="files-toolbar-panel glass">
        <div className="toolbar compact-toolbar files-toolbar">
          <input
            className="search-box"
            placeholder="搜索文件名..."
            onChange={(e) => handleSearch(e.target.value)}
          />
          <div className="filter-tabs">
            {[
              { key: '', label: '全部' },
              { key: 'image', label: '图片' },
              { key: 'video', label: '视频' },
              { key: 'document', label: '文档' },
              { key: 'other', label: '其他' },
            ].map(tab => (
              <button
                key={tab.key}
                className={`filter-tab ${filter === tab.key ? 'active' : ''}`}
                onClick={() => { setFilter(tab.key); setPage(1); }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <label className="sort-control">
            <span>排序</span>
            <select
              className="sort-select"
              value={sort}
              onChange={(e) => { setSort(e.target.value); setPage(1); }}
              aria-label="文件排序"
            >
              <option value="latest">最新上传</option>
              <option value="access">访问最多</option>
              <option value="expiring">即将到期</option>
              <option value="largest">文件最大</option>
              <option value="recommended">推荐优先</option>
            </select>
          </label>
        </div>
      </div>

      <div className="listing-header">
        <div>
          <div className="section-title">全部已上传</div>
          <div className="section-subtitle">共 {pagination.total || files.length} 个公开文件 · 仅展示未过期内容 · 访问后自动续期</div>
        </div>
      </div>

      {/* File Grid */}
      {loading ? (
        <div className="empty-state">
          <div className="loading-spinner" />
          <div className="empty-text" style={{ marginTop: 16 }}>加载中...</div>
        </div>
      ) : files.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <div className="empty-text">还没有上传任何文件</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>拖拽文件到上方区域开始上传</div>
        </div>
      ) : (
        <div className="file-grid">
          {files.map(file => {
            const previewKind = getPreviewKind(file);
            const isImage = previewKind === 'image' || isPreviewableImage(file);
            const isVideo = previewKind === 'video';
            const previewSource = buildPreviewUrl(file) || file.url;
            const copyTarget = file.shortUrl || file.url;
            const isCopied = copiedUrl === copyTarget;
            const fileKey = file.id || file.filename;
            const displayName = file.title || file.originalName || file.filename || '未命名文件';
            const showStatus = isVideo && (adminMode || (file.allowFeed && file.feedStatus === 'approved'));
            const statusActive = file.allowFeed && file.feedStatus === 'approved';
            const statusText = adminMode ? getFeedBadge(file) : '推荐中';
            const moreProfile = getMorePanelProfile(file, previewKind);
            const markdownTarget = file.markdown || (copyTarget ? (isImage ? `![${displayName}](${copyTarget})` : `[${displayName}](${copyTarget})`) : '');
            const moreOpen = openMoreId === fileKey;
            const openFile = () => {
              setOpenMoreId('');
              handleOpenSiteView(file);
            };
            const handlePreviewKeyDown = (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openFile();
              }
            };
            return (
              <div key={file.filename} className={`file-card glass glass-hover ${isVideo ? 'video-card' : ''}`}>
                <div
                  className="file-preview preview-click-target"
                  onClick={openFile}
                  onMouseEnter={isVideo ? handleVideoPreviewEnter : undefined}
                  onMouseLeave={isVideo ? handleVideoPreviewLeave : undefined}
                  onKeyDown={handlePreviewKeyDown}
                  role="button"
                  tabIndex={0}
                  title={isVideo ? '悬停自动预览，点击在本站查看视频' : '点击在本站查看内容'}
                >
                  {isImage ? (
                    <img
                      src={previewSource}
                      alt={displayName}
                      loading="lazy"
                    />
                  ) : isVideo ? (
                    <video className="hover-preview-video" src={previewSource} muted playsInline loop preload="metadata" />
                  ) : (
                    <div className="file-type-icon">{getFileTypeIcon(file.mimeType)}</div>
                  )}
                  <span className="file-type-badge">
                    {getFileExt(file.originalName || file.filename) || 'FILE'}
                  </span>
                  {isVideo ? <span className="video-play-badge" aria-hidden="true">▶</span> : null}
                </div>
                <div className="file-info">
                  <div className="file-title-row">
                    <div className="file-name" title={displayName}>{displayName}</div>
                    {showStatus ? <span className={`file-status-pill ${statusActive ? 'active' : ''}`}>{statusText}</span> : null}
                  </div>
                  <div className="file-compact-meta" aria-label="文件大小、访问次数和到期时间">
                    <span>📦 {formatSize(file.size || 0)}</span>
                    <span>👁 {Number(file.accessCount || 0).toLocaleString('zh-CN')}</span>
                    <span>🕒 {formatCompactDateTime(file.expiresAt)} 到期</span>
                  </div>
                </div>
                <div className="file-actions-shell" onClick={(e) => e.stopPropagation()}>
                  <div className="file-actions file-main-actions">
                    <button
                      className="btn btn-open"
                      onClick={openFile}
                    >
                      查看
                    </button>
                    <button
                      className={`btn btn-copy ${isCopied ? 'copied' : ''}`}
                      onClick={() => { handleCopy(copyTarget); setOpenMoreId(''); }}
                    >
                      {isCopied ? '已复制' : '复制链接'}
                    </button>
                    <button
                      className="btn btn-open"
                      aria-expanded={moreOpen}
                      onClick={() => setOpenMoreId(prev => (prev === fileKey ? '' : fileKey))}
                    >
                      更多
                    </button>
                  </div>
                  {moreOpen ? (
                    <div className={`file-more-panel more-${moreProfile.className}`} role="dialog" aria-label={`${displayName} 更多视角和操作`}>
                      <div className="file-more-card">
                        <div className="file-more-head">
                          <span className="file-more-icon" aria-hidden="true">{moreProfile.icon}</span>
                          <div className="file-more-heading">
                            <div className="file-more-kicker">{moreProfile.eyebrow}</div>
                            <div className="file-more-title">{moreProfile.title}</div>
                          </div>
                          <button className="file-more-close" onClick={() => setOpenMoreId('')} aria-label="关闭更多浮窗">×</button>
                        </div>
                        <p className="file-more-desc">{moreProfile.description}</p>
                        <div className="file-more-metrics" aria-label="当前文件概览">
                          <span>{moreProfile.accent}</span>
                          <span>{formatSize(file.size || 0)}</span>
                          <span>{Number(file.accessCount || 0).toLocaleString('zh-CN')} 次</span>
                        </div>
                      </div>
                      <div className="file-more-actions">
                        <button className="more-panel-action" onClick={openFile}>{moreProfile.previewAction}</button>
                        <button className="more-panel-action" onClick={() => { setOpenMoreId(''); handleOpenDirectView(file); }}>打开原文件</button>
                        <button className="more-panel-action" onClick={() => { handleCopy(file.url || file.directUrl || copyTarget); setOpenMoreId(''); }}>复制直链</button>
                        {markdownTarget ? <button className="more-panel-action" onClick={() => { handleCopy(markdownTarget); setOpenMoreId(''); }}>复制 Markdown</button> : null}
                        {adminMode && isVideo ? <button className="more-panel-action" onClick={() => handleOpenEditFile(file)}>编辑信息</button> : null}
                        {adminMode && isVideo ? (
                          <button className="more-panel-action" onClick={() => handleToggleFeed(file, !statusActive)}>
                            {statusActive ? '取消推荐' : '设为推荐'}
                          </button>
                        ) : null}
                        {adminMode ? <button className="more-panel-action danger" onClick={() => handleDelete(file.id, displayName)}>删除文件</button> : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="pagination">
          <button
            className="page-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            ← 上一页
          </button>
          {Array.from({ length: Math.min(pagination.totalPages, 7) }, (_, i) => {
            let p;
            if (pagination.totalPages <= 7) {
              p = i + 1;
            } else if (page <= 4) {
              p = i + 1;
            } else if (page >= pagination.totalPages - 3) {
              p = pagination.totalPages - 6 + i;
            } else {
              p = page - 3 + i;
            }
            return (
              <button
                key={p}
                className={`page-btn ${page === p ? 'active' : ''}`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            );
          })}
          <button
            className="page-btn"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            下一页 →
          </button>
        </div>
      )}
      </>)}

      <PreviewModal
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        onCopy={handleCopy}
        onDelete={handleDelete}
        onOpenExternal={handleOpenDirectView}
        adminMode={adminMode}
      />

      <FileEditModal
        file={editingFile}
        saving={editSaving}
        onClose={() => setEditingFile(null)}
        onSave={handleSaveFileInfo}
      />

    </div>
  );
}
