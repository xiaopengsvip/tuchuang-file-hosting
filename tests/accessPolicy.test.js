import test from 'node:test';
import assert from 'node:assert/strict';

import {
  routeRequiresAdmin,
  sanitizePublicRecord,
} from '../src/accessPolicy.js';

test('file listing and stats are public so all uploaded files can be displayed', () => {
  assert.equal(routeRequiresAdmin('GET', '/api/files'), false);
  assert.equal(routeRequiresAdmin('GET', '/api/files?page=1&limit=30'), false);
  assert.equal(routeRequiresAdmin('GET', '/api/stats'), false);
});

test('mutating file management routes still require admin access', () => {
  assert.equal(routeRequiresAdmin('DELETE', '/api/files/demo123'), true);
  assert.equal(routeRequiresAdmin('PATCH', '/api/files/demo123/feed'), true);
  assert.equal(routeRequiresAdmin('POST', '/api/notes'), true);
  assert.equal(routeRequiresAdmin('DELETE', '/api/notes/note123'), true);
  assert.equal(routeRequiresAdmin('POST', '/api/upload'), false);
  assert.equal(routeRequiresAdmin('GET', '/api/feed/videos'), false);
  assert.equal(routeRequiresAdmin('GET', '/api/admin/feed/videos'), true);
  assert.equal(routeRequiresAdmin('POST', '/api/admin/feed/batch'), true);
});

test('public file records do not expose uploader IP addresses but keep lifecycle counters', () => {
  const publicRecord = sanitizePublicRecord({
    id: 'demo123',
    filename: 'demo123.png',
    originalName: 'demo.png',
    uploaderIp: '203.0.113.10',
    size: 123,
    accessCount: 7,
    lastAccessTime: '2026-04-30T12:00:00.000Z',
    expiresAt: '2026-05-07T12:00:00.000Z',
  });

  assert.equal(publicRecord.uploaderIp, undefined);
  assert.equal(publicRecord.id, 'demo123');
  assert.equal(publicRecord.originalName, 'demo.png');
  assert.equal(publicRecord.accessCount, 7);
  assert.equal(publicRecord.lastAccessTime, '2026-04-30T12:00:00.000Z');
  assert.equal(publicRecord.expiresAt, '2026-05-07T12:00:00.000Z');
});
