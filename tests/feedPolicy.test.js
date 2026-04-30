import test from 'node:test';
import assert from 'node:assert/strict';

import { applyUploadFeedPreference, isFeedPreferenceRequested } from '../src/feedPolicy.js';

test('feed preference parser accepts explicit upload opt-in values only', () => {
  assert.equal(isFeedPreferenceRequested(true), true);
  assert.equal(isFeedPreferenceRequested('true'), true);
  assert.equal(isFeedPreferenceRequested('1'), true);
  assert.equal(isFeedPreferenceRequested('request'), true);
  assert.equal(isFeedPreferenceRequested('on'), true);
  assert.equal(isFeedPreferenceRequested(false), false);
  assert.equal(isFeedPreferenceRequested(''), false);
  assert.equal(isFeedPreferenceRequested('false'), false);
});

test('public video upload opt-in becomes pending and does not auto-approve', () => {
  const record = applyUploadFeedPreference(
    { id: 'v1', mimeType: 'video/mp4', originalName: 'demo.mp4' },
    { requested: true, isAdmin: false }
  );

  assert.equal(record.visibility, 'public');
  assert.equal(record.allowFeed, true);
  assert.equal(record.feedStatus, 'pending');
  assert.equal(record.title, 'demo.mp4');
});

test('admin video upload opt-in is approved immediately', () => {
  const record = applyUploadFeedPreference(
    { id: 'v1', mimeType: 'video/mp4', originalName: 'admin.mp4' },
    { requested: true, isAdmin: true }
  );

  assert.equal(record.visibility, 'public');
  assert.equal(record.allowFeed, true);
  assert.equal(record.feedStatus, 'approved');
  assert.equal(record.title, 'admin.mp4');
});

test('non-video upload opt-in is ignored safely', () => {
  const record = applyUploadFeedPreference(
    { id: 'i1', mimeType: 'image/png', originalName: 'image.png' },
    { requested: true, isAdmin: true }
  );

  assert.equal(record.visibility, 'unlisted');
  assert.equal(record.allowFeed, false);
  assert.equal(record.feedStatus, 'hidden');
});

test('no upload opt-in keeps safe hidden defaults', () => {
  const record = applyUploadFeedPreference(
    { id: 'v1', mimeType: 'video/mp4', originalName: 'hidden.mp4' },
    { requested: false, isAdmin: true }
  );

  assert.equal(record.visibility, 'unlisted');
  assert.equal(record.allowFeed, false);
  assert.equal(record.feedStatus, 'hidden');
});
