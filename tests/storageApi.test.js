import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStorageMetadataPatch,
  buildStorageRecordResponse,
  extractStorageApiToken,
  isStorageApiAuthorized,
  parseStorageApiKeys,
  routeRequiresStorageApi
} from '../src/storageApi.js';

test('storage API keys are parsed from dedicated env and can fall back to admin token', () => {
  assert.deepEqual(parseStorageApiKeys({ STORAGE_API_KEYS: ' key-a, key-b\nkey-c ', STORAGE_API_TOKEN: 'one-off' }), ['key-a', 'key-b', 'key-c', 'one-off']);
  assert.deepEqual(parseStorageApiKeys({}, { fallbackToken: 'admin-token' }), ['admin-token']);
  assert.deepEqual(parseStorageApiKeys({ STORAGE_API_KEYS: '  ' }, { fallbackToken: '' }), []);
});

test('storage API auth accepts bearer, x-api-key, and x-storage-token headers only when keys match', () => {
  const keys = ['storage-secret'];
  assert.equal(extractStorageApiToken({ authorization: 'Bearer storage-secret' }), 'storage-secret');
  assert.equal(extractStorageApiToken({ 'x-api-key': 'storage-secret' }), 'storage-secret');
  assert.equal(extractStorageApiToken({ 'x-storage-token': 'storage-secret' }), 'storage-secret');
  assert.equal(isStorageApiAuthorized('storage-secret', keys), true);
  assert.equal(isStorageApiAuthorized('wrong', keys), false);
  assert.equal(isStorageApiAuthorized('', keys), false);
  assert.equal(isStorageApiAuthorized('storage-secret', []), false);
});

test('storage routes are explicitly protected by storage API auth', () => {
  assert.equal(routeRequiresStorageApi('GET', '/api/storage/files'), true);
  assert.equal(routeRequiresStorageApi('POST', '/api/storage/upload'), true);
  assert.equal(routeRequiresStorageApi('DELETE', '/api/storage/files/abc123'), true);
  assert.equal(routeRequiresStorageApi('GET', '/api/files'), false);
});

test('storage metadata can publish trusted video uploads while keeping non-video uploads hidden', () => {
  const videoPatch = buildStorageMetadataPatch({ publish: 'true', title: ' Demo ', tags: 'a, b, c' }, { mediaType: 'video/mp4' });
  assert.equal(videoPatch.visibility, 'public');
  assert.equal(videoPatch.allowFeed, true);
  assert.equal(videoPatch.feedStatus, 'approved');
  assert.equal(videoPatch.title, 'Demo');
  assert.deepEqual(videoPatch.tags, ['a', 'b', 'c']);

  const imagePatch = buildStorageMetadataPatch({ publish: 'true', visibility: 'public' }, { mediaType: 'image/png' });
  assert.equal(imagePatch.visibility, 'public');
  assert.equal(imagePatch.allowFeed, false);
  assert.equal(imagePatch.feedStatus, 'hidden');
});

test('storage response exposes stable video-site integration URLs without uploader IP', () => {
  const response = buildStorageRecordResponse({
    id: 'abc123',
    originalName: 'clip.mp4',
    filename: 'abc123.mp4',
    storedName: 'abc123.mp4',
    mimeType: 'video/mp4',
    mediaType: 'video',
    size: 1234,
    uploaderIp: '127.0.0.1',
    url: 'https://tc.test/f/abc123/clip.mp4',
    directUrl: 'https://tc.test/raw/abc123',
    shortUrl: 'https://tc.test/s/abc123',
    previewUrl: 'https://tc.test/preview/abc123',
  });
  assert.equal(response.id, 'abc123');
  assert.equal(response.kind, 'video');
  assert.equal(response.downloadUrl, 'https://tc.test/raw/abc123');
  assert.equal(response.playUrl, 'https://tc.test/f/abc123/clip.mp4');
  assert.equal(response.embedUrl, 'https://tc.test/preview/abc123?embed=1');
  assert.equal(response.deleteApi, '/api/storage/files/abc123');
  assert.equal('uploaderIp' in response, false);
});
