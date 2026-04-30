import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getClipboardUploadFiles, mergeUploadedResults, isPreviewableImage, buildFileFingerprint, shouldUseResumableUpload, getFileChunks } from './uploadHelpers.js';
import { getFriendlyUploadError, getDirectViewUrl, getSameSitePreviewUrl } from './uploadUi.js';
import { getPreviewKind, buildPreviewUrl } from './previewPolicy.js';
import { buildFeedSettingsPayload, getFeedBadge, normalizeNoteDraft, isVideoFile, buildUploadFeedPreference } from './contentPlatformUi.js';

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

function getFileExt(name) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toUpperCase() : '';
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
  return (
    <div className={`lifecycle-meta ${compact ? 'compact' : ''}`}>
      <span>👁 {accessCountText(file)}</span>
      <span>⏰ 过期：{formatDateTime(file.expiresAt)}</span>
      <span>🕘 最近访问：{formatDateTime(file.lastAccessTime)}</span>
      <span>访问或预览会自动向后延期 {idleDays} 天</span>
    </div>
  );
}

function PreviewModal({ file, onClose, onCopy, onDelete, onOpenExternal }) {
  if (!file) return null;

  const sameSitePreviewUrl = getSameSitePreviewUrl(file, API_BASE) || getDirectViewUrl(file, API_BASE);
  const previewUrl = sameSitePreviewUrl ? `${sameSitePreviewUrl}${sameSitePreviewUrl.includes('?') ? '&' : '?'}embed=1` : '';
  const externalPreviewUrl = getDirectViewUrl(file, API_BASE) || sameSitePreviewUrl;
  const originalUrl = file.url || file.directUrl || file.shortUrl || externalPreviewUrl;
  const kind = getPreviewKind(file);
  const title = file.originalName || file.filename || '文件预览';

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${title} 本站预览`}>
      <div className="modal-content modal-content-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-toolbar">
          <div className="modal-title-block">
            <div className="modal-filename" title={title}>{title}</div>
            <div className="modal-subtitle">
              默认本站查看 · {formatSize(file.size || 0)} · {accessCountText(file)} · 过期 {formatDateTime(file.expiresAt)} · 访问/预览自动延期
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-copy" onClick={() => onCopy(file.shortUrl || file.url)}>🔗 复制短链</button>
            <button className="btn btn-copy" onClick={() => onCopy(file.markdown || file.url)}>MD</button>
            <button className="btn btn-open" onClick={() => onOpenExternal(file)}>↗ 跳转预览</button>
            <button className="btn btn-open" onClick={() => window.open(originalUrl, '_blank', 'noopener,noreferrer')}>原文件</button>
            <button className="btn btn-delete" onClick={() => { onDelete(file.id); onClose(); }}>🗑 删除</button>
            <button className="modal-close" onClick={onClose} aria-label="关闭预览">✕</button>
          </div>
        </div>
        <iframe className="modal-preview-frame" src={previewUrl} title={title} />
      </div>
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
                <div className="upload-result-name" title={file.originalName || file.filename}>{file.originalName || file.filename}</div>
                <div className="upload-result-meta">
                  <span>{formatSize(file.size || 0)}</span>
                  <span>上传 {file.uploadDate || formatDate(file.uploadTime)}</span>
                  <span>{accessCountText(file)}</span>
                  <span>过期 {formatDateTime(file.expiresAt)}</span>
                </div>
                <FileLifecycleMeta file={file} compact />
                {isVideoFile(file) && <div className={`feed-status-pill ${file.allowFeed && file.feedStatus === 'approved' ? 'active' : ''}`}>🎬 {getFeedBadge(file)}</div>}
                <div className="link-row">
                  <input className="link-input" readOnly value={link || ''} onFocus={e => e.target.select()} />
                  <button className="btn btn-copy" onClick={() => onCopy(link)}>复制链接</button>
                </div>
                <div className="upload-result-actions">
                  <button className="btn btn-open" onClick={openResult}>👁 本站查看</button>
                  <button className="btn btn-open" onClick={() => onOpenDirectView(file)}>↗ 跳转预览</button>
                  <button className="btn btn-copy" onClick={() => onCopy(file.url)}>长链</button>
                  <button className="btn btn-copy" onClick={() => onCopy(file.markdown || file.url)}>Markdown</button>
                  <button className="btn btn-open" onClick={() => window.open(file.url || link, '_blank')}>↗ 原文件</button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FeedSection({ videos, loading, onRefresh, onOpenSiteView, onOpenDirectView }) {
  return (
    <section className="content-panel glass feed-panel">
      <div className="panel-header">
        <div>
          <div className="section-title">🎬 视频推荐区</div>
          <div className="section-subtitle">只展示已明确允许进入推荐区的视频；默认上传不会自动公开到这里。</div>
        </div>
        <button className="btn btn-open" onClick={onRefresh} disabled={loading}>{loading ? '刷新中...' : '刷新推荐'}</button>
      </div>
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

function NotesSection({ notes, loading, adminMode, noteDraft, setNoteDraft, onCreateNote, onRefresh }) {
  return (
    <section className="content-panel glass notes-panel">
      <div className="panel-header">
        <div>
          <div className="section-title">📝 笔记</div>
          <div className="section-subtitle">MVP 支持公开/私有 Markdown 笔记；发布和查看私有笔记需要管理员 Token。</div>
        </div>
        <button className="btn btn-open" onClick={onRefresh} disabled={loading}>{loading ? '刷新中...' : '刷新笔记'}</button>
      </div>
      {adminMode ? (
        <div className="note-editor">
          <input className="settings-input" placeholder="笔记标题" value={noteDraft.title} onChange={e => setNoteDraft(prev => ({ ...prev, title: e.target.value }))} />
          <textarea className="settings-input note-textarea" placeholder="写一点说明、剪辑想法或文件备注，支持 Markdown" value={noteDraft.content} onChange={e => setNoteDraft(prev => ({ ...prev, content: e.target.value }))} />
          <input className="settings-input" placeholder="标签，用英文逗号分隔" value={noteDraft.tagsText} onChange={e => setNoteDraft(prev => ({ ...prev, tagsText: e.target.value }))} />
          <label className="note-public-toggle"><input type="checkbox" checked={noteDraft.publicNote} onChange={e => setNoteDraft(prev => ({ ...prev, publicNote: e.target.checked }))} /> 公开展示</label>
          <button className="btn btn-copy" onClick={onCreateNote}>发布笔记</button>
        </div>
      ) : (
        <div className="settings-log-empty">保存管理员 Token 后可以创建私有/公开笔记。</div>
      )}
      {loading ? <div className="empty-state compact"><div className="loading-spinner" /><div className="empty-text">加载笔记...</div></div> : null}
      {!loading && !notes.length ? <div className="empty-state compact"><div className="empty-icon">📒</div><div className="empty-text">暂无笔记</div></div> : null}
      {!loading && notes.length ? (
        <div className="note-list">
          {notes.map(note => (
            <article key={note.id} className="note-card">
              <div className="note-card-top"><strong>{note.title || '未命名笔记'}</strong><span>{note.visibility === 'public' ? '公开' : '私有'}</span></div>
              <p>{note.content}</p>
              {Array.isArray(note.tags) && note.tags.length ? <div className="feed-tags">{note.tags.map(tag => <span key={tag}>{tag}</span>)}</div> : null}
              <div className="feed-meta">{formatDate(note.createdAt)}</div>
            </article>
          ))}
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
  const [page, setPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [uploadError, setUploadError] = useState(null);
  const [uploadFeedRequested, setUploadFeedRequested] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [uploadResults, setUploadResults] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);
  const [copiedUrl, setCopiedUrl] = useState('');
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
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState({ title: '', content: '', tagsText: '', publicNote: false });
  const fileInputRef = useRef(null);
  const searchTimerRef = useRef(null);
  const maxFileMB = publicConfig.maxFileMB || stats.maxFileMB || DEFAULT_MAX_FILE_MB;
  const expireAfterIdleDays = publicConfig.expireAfterIdleDays || stats.expireAfterIdleDays || DEFAULT_EXPIRE_AFTER_IDLE_DAYS;
  const maxFileBytes = maxFileMB * 1024 * 1024;
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
      const params = new URLSearchParams({ page, limit: 30, search, type: filter });
      const res = await fetch(`${API_BASE}/api/files?${params}`, { headers: authHeaders() });
      if (res.status === 401) {
        setNeedToken(true);
        setFiles([]);
        return;
      }
      const data = await res.json();
      if (data.success) {
        setNeedToken(false);
        setFiles(data.files);
        setPagination(data.pagination);
      }
    } catch (e) {
      addToast('加载文件列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search, filter, authHeaders, addToast]);

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
    if (activeView === 'feed') fetchFeedVideos();
    if (activeView === 'notes') fetchNotes();
  }, [activeView, fetchFeedVideos, fetchNotes]);
  useEffect(() => {
    if (settingsOpen && adminToken) fetchUploadLogs();
  }, [settingsOpen, adminToken, fetchUploadLogs]);

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
      addToast(`检测到剪贴板文件，开始上传 ${files.length} 个`, 'info');
      handleUpload(files);
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addToast, handleUpload]);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
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

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/files/${id}`, { method: 'DELETE', headers: authHeaders() });
      if (res.status === 401) {
        setNeedToken(true);
        addToast('请输入管理员 Token 后再删除', 'error');
        return;
      }
      addToast('文件已删除', 'info');
      fetchFiles();
      fetchStats();
      if (activeView === 'feed') fetchFeedVideos();
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
      addToast(enable ? '已允许该视频进入推荐区' : '已从推荐区隐藏', 'success');
      fetchStats();
      fetchFeedVideos();
    } catch (e) {
      addToast(`推荐区更新失败：${e.message || e}`, 'error');
    }
  };

  const handleCreateNote = async () => {
    if (!adminToken) {
      setNeedToken(true);
      addToast('保存管理员 Token 后才能发布笔记', 'error');
      return;
    }
    const payload = normalizeNoteDraft(noteDraft);
    if (!payload.title || !payload.content) {
      addToast('请填写笔记标题和内容', 'error');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/notes`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedToken(true);
        addToast('管理员 Token 无效，无法发布笔记', 'error');
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      setNoteDraft({ title: '', content: '', tagsText: '', publicNote: false });
      addToast('笔记已发布', 'success');
      fetchNotes();
    } catch (e) {
      addToast(`发布笔记失败：${e.message || e}`, 'error');
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
    setLogsError('');
    addToast('已清除管理员 Token，恢复访客模式', 'info');
  };

  return (
    <div className="app-container">
      <ToastContainer toasts={toasts} />

      {/* Header */}
      <header className="header glass">
        <div className="header-brand">
          <div className="header-logo">☁️</div>
          <div>
            <div className="header-title">图床</div>
            <div className="header-subtitle">Public 1GB/file · Admin 10GB/file · Original Upload · 7-day idle expiry</div>
          </div>
        </div>
        <div className="header-right">
          <div className="header-stats">
            <div className="stat-item">
              <div className="stat-value">{stats.totalFiles}</div>
              <div className="stat-label">文件</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{formatSize(stats.totalSize)}</div>
              <div className="stat-label">存储</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{stats.imageCount}</div>
              <div className="stat-label">图片</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{Number(stats.totalAccessCount || 0).toLocaleString('zh-CN')}</div>
              <div className="stat-label">访问</div>
            </div>
          </div>
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

      <nav className="view-switch glass" aria-label="内容视图切换">
        {[
          { key: 'files', label: '☁️ 文件上传' },
          { key: 'feed', label: `🎬 视频推荐 ${stats.feedVideoCount ? `(${stats.feedVideoCount})` : ''}` },
          { key: 'notes', label: '📝 笔记' },
        ].map(item => (
          <button key={item.key} className={`view-tab ${activeView === item.key ? 'active' : ''}`} onClick={() => setActiveView(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>

      {activeView === 'feed' && (
        <FeedSection
          videos={feedVideos}
          loading={feedLoading}
          onRefresh={fetchFeedVideos}
          onOpenSiteView={handleOpenSiteView}
          onOpenDirectView={handleOpenDirectView}
        />
      )}

      {activeView === 'notes' && (
        <NotesSection
          notes={notes}
          loading={notesLoading}
          adminMode={adminMode}
          noteDraft={noteDraft}
          setNoteDraft={setNoteDraft}
          onCreateNote={handleCreateNote}
          onRefresh={fetchNotes}
        />
      )}

      {activeView === 'files' && (<>

      {/* Upload Zone */}
      <div
        className={`upload-zone glass ${dragging ? 'dragging' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="upload-icon">{uploading ? '⏳' : '☁️'}</div>
        <div className="upload-title">
          {uploading ? `${uploadStatusText || '上传中...'} ${uploadProgress}%` : '拖拽文件到此处、点击选择，或直接 Ctrl/⌘+V 粘贴上传'}
        </div>
        <div className="upload-subtitle">{adminMode ? '管理员 Token 已启用' : '访客默认'}：单文件最大 {formatSize(maxFileBytes)}；图片/视频/音频按原始文件上传不压缩；大文件自动分片断点续传；无访问 {expireAfterIdleDays} 天自动过期，访问或预览会把具体过期时间自动向后延期</div>
        <label className="upload-feed-toggle" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={uploadFeedRequested}
            onChange={e => setUploadFeedRequested(e.target.checked)}
          />
          <span>允许本次上传的视频申请进入推荐区</span>
          <small>{adminMode ? '管理员上传会直接推荐；非视频自动忽略。' : '访客上传会进入待审核；审核通过后才会公开推荐。'}</small>
        </label>
        <div className="upload-formats">
          {['PNG', 'JPG', 'GIF', 'WebP', 'SVG', 'MP4', 'MP3', 'PDF', 'ZIP', 'DOC'].map(f => (
            <span key={f} className="format-tag">{f}</span>
          ))}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { handleUpload(e.target.files); e.target.value = ''; }}
        />
      </div>

      {/* Upload Progress */}
      {uploading && (
        <div className="upload-progress glass">
          <div className="progress-header">
            <span className="progress-title">{uploadStatusText || '正在上传...'}</span>
            <span style={{ color: 'var(--cyan)', fontSize: 14 }}>{uploadProgress}%</span>
          </div>
          <div className="progress-bar-bg">
            <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {uploadError && !uploading && (
        <div className="upload-error-card glass" role="alert">
          <div className="upload-error-icon">⚠️</div>
          <div className="upload-error-main">
            <div className="upload-error-title">{uploadError.message}</div>
            <div className="upload-error-hint">{uploadError.hint}</div>
            <div className="upload-error-meta">
              {uploadError.context?.fileName && <span>文件：{uploadError.context.fileName}</span>}
              {uploadError.context?.phase && <span>阶段：{uploadError.context.phase}</span>}
              {uploadError.logId && <span>日志编号：{uploadError.logId}</span>}
            </div>
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

      {/* Toolbar */}
      <div className="toolbar">
        <input
          className="search-box"
          placeholder="🔍 搜索文件名..."
          onChange={(e) => handleSearch(e.target.value)}
        />
        <div className="filter-tabs">
          {[
            { key: '', label: '全部' },
            { key: 'image', label: '🖼️ 图片' },
            { key: 'video', label: '🎬 视频' },
            { key: 'document', label: '📄 文档' },
            { key: 'other', label: '📁 其他' },
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
      </div>

      <div className="listing-header">
        <div>
          <div className="section-title">全部已上传</div>
          <div className="section-subtitle">公开展示当前未过期文件，共 {pagination.total || files.length} 个；卡片展示访问量和具体过期时间，访问/预览会自动续期</div>
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
            const isCopied = copiedUrl === (file.shortUrl || file.url);
            const openFile = () => handleOpenSiteView(file);
            const handlePreviewKeyDown = (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openFile();
              }
            };
            return (
              <div key={file.filename} className="file-card glass glass-hover">
                <div
                  className="file-preview preview-click-target"
                  onClick={openFile}
                  onKeyDown={handlePreviewKeyDown}
                  role="button"
                  tabIndex={0}
                  title="点击在本站查看内容"
                >
                  {isImage ? (
                    <img
                      src={previewSource}
                      alt={file.originalName}
                      loading="lazy"
                    />
                  ) : isVideo ? (
                    <video src={previewSource} muted playsInline preload="metadata" />
                  ) : (
                    <div className="file-type-icon">{getFileTypeIcon(file.mimeType)}</div>
                  )}
                  <span className="file-type-badge">
                    {getFileExt(file.originalName) || 'FILE'}
                  </span>
                </div>
                <div className="file-info">
                  <div className="file-name" title={file.originalName}>{file.originalName}</div>
                  <div className="file-meta">
                    <span>{formatSize(file.size)}</span>
                    <span>上传 {file.uploadDate || formatDate(file.uploadTime)}</span>
                    <span>{accessCountText(file)}</span>
                  </div>
                  <FileLifecycleMeta file={file} compact />
                  {isVideoFile(file) && <div className={`feed-status-pill ${file.allowFeed && file.feedStatus === 'approved' ? 'active' : ''}`}>🎬 {getFeedBadge(file)}</div>}
                </div>
                <div className="file-actions">
                  <button
                    className={`btn btn-copy ${isCopied ? 'copied' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleCopy(file.shortUrl || file.url); }}
                  >
                    {isCopied ? '✓ 已复制' : '🔗 复制短链'}
                  </button>
                  <button
                    className="btn btn-open"
                    onClick={(e) => { e.stopPropagation(); handleOpenSiteView(file); }}
                  >
                    👁 本站查看
                  </button>
                  <button
                    className="btn btn-open"
                    onClick={(e) => { e.stopPropagation(); handleOpenDirectView(file); }}
                  >
                    ↗ 跳转
                  </button>
                  {isVideoFile(file) && (
                    <button
                      className="btn btn-copy"
                      onClick={(e) => { e.stopPropagation(); handleToggleFeed(file, !(file.allowFeed && file.feedStatus === 'approved')); }}
                    >
                      {file.allowFeed && file.feedStatus === 'approved' ? '🙈 取消推荐' : '🎬 进推荐'}
                    </button>
                  )}
                  <button
                    className="btn btn-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(file.id); }}
                  >
                    🗑
                  </button>
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
      />

    </div>
  );
}
