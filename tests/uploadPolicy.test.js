import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_MAX_FILE_MB,
  ADMIN_MAX_FILE_MB,
  getUploadLimitForToken,
  getUploadTierForToken,
  isDangerousInlineMimeType,
  getContentDispositionForMimeType,
} from '../src/uploadPolicy.js';

test('default public users are limited to 1GB and admin token can upload 10GB', () => {
  assert.equal(PUBLIC_MAX_FILE_MB, 1024);
  assert.equal(ADMIN_MAX_FILE_MB, 10240);
  assert.deepEqual(getUploadLimitForToken('', 'secret'), {
    tier: 'public',
    maxFileMB: 1024,
    maxFileBytes: 1024 * 1024 * 1024,
  });
  assert.deepEqual(getUploadLimitForToken('secret', 'secret'), {
    tier: 'admin',
    maxFileMB: 10240,
    maxFileBytes: 10240 * 1024 * 1024,
  });
});

test('admin token comparison is exact and empty admin token never upgrades public visitors', () => {
  assert.equal(getUploadTierForToken('wrong', 'secret'), 'public');
  assert.equal(getUploadTierForToken('', ''), 'public');
  assert.equal(getUploadTierForToken('anything', ''), 'public');
});

test('dangerous browser-executable file types are forced to attachment downloads', () => {
  for (const mimeType of ['text/html', 'image/svg+xml', 'text/javascript', 'application/javascript', 'application/xml']) {
    assert.equal(isDangerousInlineMimeType(mimeType), true, mimeType);
    assert.equal(getContentDispositionForMimeType(mimeType, 'inline'), 'attachment');
  }

  for (const mimeType of ['image/png', 'image/jpeg', 'video/mp4', 'audio/wav', 'application/pdf', 'text/plain']) {
    assert.equal(isDangerousInlineMimeType(mimeType), false, mimeType);
    assert.equal(getContentDispositionForMimeType(mimeType, 'inline'), 'inline');
  }
});
