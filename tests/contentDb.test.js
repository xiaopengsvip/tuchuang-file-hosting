import test from 'node:test';
import assert from 'node:assert/strict';

import { createContentDb } from '../src/contentDb.js';

function sampleRecords() {
  return {
    'vid1.mp4': {
      id: 'vid1',
      originalName: '公开视频.mp4',
      filename: 'vid1.mp4',
      storedName: 'vid1.mp4',
      size: 2048,
      mimeType: 'video/mp4',
      uploadTime: '2026-04-30T00:00:00.000Z',
      uploadDate: '2026-04-30',
      uploadYear: 2026,
      uploadMonth: 4,
      uploadDay: 30,
      lastAccessTime: '2026-04-30T01:00:00.000Z',
      expiresAt: '2026-05-07T01:00:00.000Z',
      accessCount: 3,
      uploadTier: 'admin',
    },
    'img1.png': {
      id: 'img1',
      originalName: '图片.png',
      filename: 'img1.png',
      storedName: 'img1.png',
      size: 1024,
      mimeType: 'image/png',
      uploadTime: '2026-04-29T00:00:00.000Z',
      lastAccessTime: '2026-04-29T00:00:00.000Z',
      expiresAt: '2026-05-06T00:00:00.000Z',
      accessCount: 1,
    },
  };
}

test('imports existing file-index records with safe feed defaults', () => {
  const db = createContentDb({ filename: ':memory:' });

  const result = db.importFileIndex(sampleRecords());
  const files = db.listFiles({ limit: 10 }).files;

  assert.equal(result.inserted, 2);
  assert.equal(files.length, 2);
  const video = files.find(file => file.id === 'vid1');
  assert.equal(video.visibility, 'unlisted');
  assert.equal(video.allowFeed, false);
  assert.equal(video.feedStatus, 'hidden');
  assert.equal(video.mediaType, 'video');
  assert.equal(video.originalName, '公开视频.mp4');
});

test('file listing supports compact toolbar sort modes', () => {
  const db = createContentDb({ filename: ':memory:' });
  db.importFileIndex(sampleRecords());
  db.updateFeedSettings('vid1', { visibility: 'public', allowFeed: true, feedStatus: 'approved' });
  db.upsertFile({
    id: 'big1',
    originalName: '大文件.zip',
    filename: 'big1.zip',
    storedName: 'big1.zip',
    size: 999999,
    mimeType: 'application/zip',
    uploadTime: '2026-04-28T00:00:00.000Z',
    lastAccessTime: '2026-04-28T00:00:00.000Z',
    expiresAt: '2026-05-09T00:00:00.000Z',
    accessCount: 0,
  });
  db.upsertFile({
    id: 'soon1',
    originalName: '快过期.pdf',
    filename: 'soon1.pdf',
    storedName: 'soon1.pdf',
    size: 512,
    mimeType: 'application/pdf',
    uploadTime: '2026-04-27T00:00:00.000Z',
    lastAccessTime: '2026-04-27T00:00:00.000Z',
    expiresAt: '2026-05-01T00:00:00.000Z',
    accessCount: 99,
  });

  assert.equal(db.listFiles({ limit: 10, sort: 'latest' }).files[0].id, 'vid1');
  assert.equal(db.listFiles({ limit: 10, sort: 'access' }).files[0].id, 'soon1');
  assert.equal(db.listFiles({ limit: 10, sort: 'expiring' }).files[0].id, 'soon1');
  assert.equal(db.listFiles({ limit: 10, sort: 'largest' }).files[0].id, 'big1');
  assert.equal(db.listFiles({ limit: 10, sort: 'recommended' }).files[0].id, 'vid1');
});

test('legacy JSON import only fills missing DB rows and never overwrites DB feed edits', () => {
  const db = createContentDb({ filename: ':memory:' });
  db.importFileIndex(sampleRecords());
  db.updateFeedSettings('vid1', {
    visibility: 'public',
    allowFeed: true,
    feedStatus: 'approved',
    title: '数据库里的推荐标题',
  });

  const rerun = db.importFileIndex(sampleRecords());
  const video = db.getFileById('vid1');

  assert.equal(rerun.inserted, 0);
  assert.equal(rerun.updated, 0);
  assert.equal(rerun.skippedExisting, 2);
  assert.equal(video.visibility, 'public');
  assert.equal(video.allowFeed, true);
  assert.equal(video.feedStatus, 'approved');
  assert.equal(video.title, '数据库里的推荐标题');
});

test('video feed only returns explicitly approved video records', () => {
  const db = createContentDb({ filename: ':memory:' });
  db.importFileIndex(sampleRecords());

  assert.equal(db.listFeedVideos({ limit: 10 }).videos.length, 0);

  db.updateFeedSettings('vid1', {
    visibility: 'public',
    allowFeed: true,
    feedStatus: 'approved',
    title: '推荐公开视频',
    description: '允许进入刷视频推荐区',
    tags: ['测试', '视频'],
  });
  db.updateFeedSettings('img1', {
    visibility: 'public',
    allowFeed: true,
    feedStatus: 'approved',
  });

  const feed = db.listFeedVideos({ limit: 10 }).videos;
  assert.equal(feed.length, 1);
  assert.equal(feed[0].id, 'vid1');
  assert.equal(feed[0].title, '推荐公开视频');
  assert.deepEqual(feed[0].tags, ['测试', '视频']);
});

test('feed management listing returns video-only rows with status summary', () => {
  const db = createContentDb({ filename: ':memory:' });
  db.importFileIndex(sampleRecords());
  db.updateFeedSettings('vid1', { visibility: 'public', allowFeed: true, feedStatus: 'pending' });
  db.upsertFile({
    id: 'vid2',
    originalName: '已推荐.mp4',
    filename: 'vid2.mp4',
    storedName: 'vid2.mp4',
    mimeType: 'video/mp4',
    uploadTime: '2026-04-30T02:00:00.000Z',
    visibility: 'public',
    allowFeed: true,
    feedStatus: 'approved',
  });

  const pending = db.listFeedManagementVideos({ feedStatus: 'pending', limit: 10 });
  const all = db.listFeedManagementVideos({ feedStatus: 'all', limit: 10 });

  assert.deepEqual(pending.files.map(file => file.id), ['vid1']);
  assert.equal(all.summary.totalVideos, 2);
  assert.equal(all.summary.pending, 1);
  assert.equal(all.summary.approved, 1);
  assert.equal(all.summary.hidden, 0);
  assert.equal(all.summary.rejected, 0);
  assert.equal(all.files.every(file => file.mediaType === 'video'), true);
});

test('bulk feed actions approve selected videos and clear all approved recommendations', () => {
  const db = createContentDb({ filename: ':memory:' });
  db.importFileIndex(sampleRecords());
  db.upsertFile({
    id: 'vid2',
    originalName: '第二个视频.mp4',
    filename: 'vid2.mp4',
    storedName: 'vid2.mp4',
    mimeType: 'video/mp4',
    uploadTime: '2026-04-30T02:00:00.000Z',
  });

  const approved = db.bulkUpdateFeed({ action: 'approve', ids: ['vid1', 'vid2', 'img1'] });
  assert.equal(approved.updated, 2);
  assert.equal(db.listFeedVideos({ limit: 10 }).videos.length, 2);

  const cleared = db.bulkUpdateFeed({ action: 'clear-approved' });
  assert.equal(cleared.updated, 2);
  assert.equal(db.listFeedVideos({ limit: 10 }).videos.length, 0);
  assert.equal(db.getFileById('vid1').allowFeed, false);
  assert.equal(db.getFileById('vid1').feedStatus, 'hidden');
  assert.equal(db.getFileById('img1').feedStatus, 'hidden');
});

test('creates and lists public/private notes for files', () => {
  const db = createContentDb({ filename: ':memory:' });
  db.importFileIndex(sampleRecords());

  const privateNote = db.createNote({ fileId: 'vid1', title: '私有剪辑思路', content: '只给管理员看' });
  const publicNote = db.createNote({ fileId: 'vid1', title: '公开说明', content: '公开视频说明', visibility: 'public', tags: ['说明'] });

  assert.ok(privateNote.id);
  assert.ok(publicNote.id);
  assert.equal(db.listNotes({ fileId: 'vid1', includePrivate: false }).notes.length, 1);
  assert.equal(db.listNotes({ fileId: 'vid1', includePrivate: true }).notes.length, 2);
  assert.deepEqual(db.listNotes({ fileId: 'vid1', includePrivate: false }).notes[0].tags, ['说明']);
});

test('creates standalone notes without requiring a file record', () => {
  const db = createContentDb({ filename: ':memory:' });

  const note = db.createNote({ title: '独立笔记', content: '不绑定文件', visibility: 'public' });

  assert.ok(note.id);
  assert.equal(note.fileId, '');
  assert.equal(db.listNotes({ includePrivate: false }).notes.length, 1);
});
