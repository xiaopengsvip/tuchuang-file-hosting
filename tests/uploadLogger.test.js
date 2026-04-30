import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createUploadLogger, buildSimpleUploadAccessEvent } from '../src/uploadLogger.js';

test('upload logger writes sanitized jsonl events and returns recent entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuchuang-upload-log-'));
  const logger = createUploadLogger({ logDir: dir });
  const entry = logger.log({
    event: 'client_upload_failure',
    level: 'error',
    fileName: 'demo.mov',
    error: 'Network error',
    token: 'should-not-be-written',
    details: { authorization: 'secret', status: 413 }
  }, {
    method: 'POST',
    originalUrl: '/api/upload-logs',
    ip: '127.0.0.1',
    get: (name) => ({ 'user-agent': 'node-test', 'content-length': '10' }[name])
  });

  assert.ok(entry.id);
  assert.equal(entry.event, 'client_upload_failure');
  assert.equal(entry.token, undefined);
  assert.equal(entry.details.authorization, undefined);
  assert.equal(entry.details.status, 413);
  assert.equal(entry.request.userAgent, 'node-test');

  const logs = logger.tail(1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, entry.id);
  assert.equal(logs[0].error, 'Network error');
});

test('buildSimpleUploadAccessEvent summarizes successful simple uploads', () => {
  const event = buildSimpleUploadAccessEvent({
    status: 200,
    uploadTier: 'public',
    maxFileMB: 1024,
    startedAt: 1000,
    now: 1550,
    files: [{
      originalname: 'YY资产财报.xlsx',
      filename: 'abc123.xlsx',
      size: 7799,
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }]
  });

  assert.equal(event.event, 'simple_upload_success');
  assert.equal(event.level, 'info');
  assert.equal(event.phase, 'simple_upload');
  assert.equal(event.status, 200);
  assert.equal(event.uploadTier, 'public');
  assert.equal(event.maxFileMB, 1024);
  assert.equal(event.fileCount, 1);
  assert.equal(event.totalSize, 7799);
  assert.equal(event.durationMs, 550);
  assert.deepEqual(event.files, [{
    originalName: 'YY资产财报.xlsx',
    storedName: 'abc123.xlsx',
    size: 7799,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }]);
});

test('buildSimpleUploadAccessEvent summarizes failed simple uploads', () => {
  const event = buildSimpleUploadAccessEvent({
    status: 400,
    uploadTier: 'public',
    maxFileMB: 1024,
    startedAt: 1000,
    now: 1200,
    error: new Error('Malformed upload form or interrupted upload')
  });

  assert.equal(event.event, 'simple_upload_failed');
  assert.equal(event.level, 'error');
  assert.equal(event.phase, 'simple_upload');
  assert.equal(event.status, 400);
  assert.equal(event.fileCount, 0);
  assert.equal(event.totalSize, 0);
  assert.equal(event.durationMs, 200);
  assert.equal(event.error, 'Malformed upload form or interrupted upload');
});
