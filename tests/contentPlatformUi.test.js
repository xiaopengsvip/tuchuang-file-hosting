import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFeedSettingsPayload, getFeedBadge, normalizeNoteDraft, buildUploadFeedPreference } from '../src/contentPlatformUi.js';

test('buildFeedSettingsPayload explicitly approves video feed opt-in and hides opt-out', () => {
  assert.deepEqual(buildFeedSettingsPayload({ mimeType: 'video/mp4', originalName: 'demo.mp4' }, true), {
    visibility: 'public',
    allowFeed: true,
    feedStatus: 'approved',
    title: 'demo.mp4',
  });
  assert.deepEqual(buildFeedSettingsPayload({ title: '旧标题' }, false), {
    visibility: 'unlisted',
    allowFeed: false,
    feedStatus: 'hidden',
  });
});

test('getFeedBadge describes safe defaults and approved recommendation state', () => {
  assert.equal(getFeedBadge({ mimeType: 'video/mp4' }), '未进推荐');
  assert.equal(getFeedBadge({ mimeType: 'video/mp4', allowFeed: true, feedStatus: 'pending' }), '待审核');
  assert.equal(getFeedBadge({ mimeType: 'video/mp4', allowFeed: true, feedStatus: 'approved' }), '推荐中');
  assert.equal(getFeedBadge({ mimeType: 'image/png' }), '非视频');
});

test('normalizeNoteDraft trims title/content and defaults notes to private markdown', () => {
  assert.deepEqual(normalizeNoteDraft({ title: '  标题  ', content: '  内容  ', tagsText: 'a, b,, c', publicNote: true }), {
    title: '标题',
    content: '内容',
    contentFormat: 'markdown',
    visibility: 'public',
    tags: ['a', 'b', 'c'],
  });
});

test('buildUploadFeedPreference sends an explicit opt-in marker only when enabled', () => {
  assert.equal(buildUploadFeedPreference(true), 'request');
  assert.equal(buildUploadFeedPreference(false), '');
});
