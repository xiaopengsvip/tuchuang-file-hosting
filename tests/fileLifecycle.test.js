import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PUBLIC_MAX_FILE_MB,
  ADMIN_MAX_FILE_MB,
  FILE_EXPIRY_MS,
  buildFileRecord,
  touchRecord,
  cleanupExpiredRecords,
} from '../src/fileLifecycle.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeTempUploadDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tuchuang-lifecycle-'));
}

test('service defaults allow public uploads up to 1GB, admin uploads up to 10GB, and expire after 7 idle days', () => {
  assert.equal(PUBLIC_MAX_FILE_MB, 1024);
  assert.equal(ADMIN_MAX_FILE_MB, 10240);
  assert.equal(FILE_EXPIRY_MS, 7 * DAY_MS);
});

test('new upload records start their idle-expiry clock at upload time', () => {
  const now = new Date('2026-04-30T00:00:00.000Z');
  const record = buildFileRecord({
    id: 'abc123',
    originalName: 'demo.txt',
    filename: 'abc123.txt',
    size: 123,
    mimeType: 'text/plain',
    uploaderIp: '127.0.0.1',
    now,
  });

  assert.equal(record.lastAccessTime, now.toISOString());
  assert.equal(record.expiresAt, new Date(now.getTime() + FILE_EXPIRY_MS).toISOString());
  assert.equal(record.uploadDate, '2026-04-30');
  assert.equal(record.uploadYear, 2026);
  assert.equal(record.uploadMonth, 4);
  assert.equal(record.uploadDay, 30);
});

test('accessing a file refreshes last access time and pushes expiry out by seven days', () => {
  const record = {
    id: 'abc123',
    originalName: 'demo.txt',
    filename: 'abc123.txt',
    storedName: 'abc123.txt',
    uploadTime: '2026-04-20T00:00:00.000Z',
    lastAccessTime: '2026-04-25T00:00:00.000Z',
  };
  const now = new Date('2026-04-30T12:34:56.000Z');

  touchRecord(record, now);

  assert.equal(record.lastAccessTime, now.toISOString());
  assert.equal(record.expiresAt, new Date(now.getTime() + FILE_EXPIRY_MS).toISOString());
  assert.equal(record.accessCount, 1);
});

test('cleanup deletes files idle for at least seven days and keeps recently accessed files', () => {
  const uploadDir = makeTempUploadDir();
  const oldPath = path.join(uploadDir, 'old.txt');
  const recentPath = path.join(uploadDir, 'recent.txt');
  fs.writeFileSync(oldPath, 'old');
  fs.writeFileSync(recentPath, 'recent');

  const now = new Date('2026-04-30T00:00:00.000Z');
  const fileIndex = {
    'old.txt': {
      id: 'old',
      filename: 'old.txt',
      storedName: 'old.txt',
      uploadTime: new Date(now.getTime() - 10 * DAY_MS).toISOString(),
      lastAccessTime: new Date(now.getTime() - 8 * DAY_MS).toISOString(),
    },
    'recent.txt': {
      id: 'recent',
      filename: 'recent.txt',
      storedName: 'recent.txt',
      uploadTime: new Date(now.getTime() - 20 * DAY_MS).toISOString(),
      lastAccessTime: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
    },
  };

  const result = cleanupExpiredRecords({ fileIndex, uploadDir, now });

  assert.equal(result.deleted, 1);
  assert.equal(result.kept, 1);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(recentPath), true);
  assert.equal(fileIndex['old.txt'], undefined);
  assert.ok(fileIndex['recent.txt']);
});
