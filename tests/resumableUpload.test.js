import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHUNK_SIZE,
  buildUploadManifest,
  getChunkPlan,
  getReceivedChunks,
  validateChunkIndex,
  getMissingChunks
} from '../src/resumableUpload.js';

test('buildUploadManifest creates deterministic resumable upload id and chunk metadata', () => {
  const input = {
    fingerprint: 'movie.mp4:10485761:1710000000000',
    originalName: 'movie.mp4',
    size: 10 * 1024 * 1024 + 1,
    mimeType: 'video/mp4',
    chunkSize: 4 * 1024 * 1024
  };

  const first = buildUploadManifest(input, { now: '2026-04-30T00:00:00.000Z' });
  const second = buildUploadManifest(input, { now: '2026-04-30T00:00:05.000Z' });

  assert.equal(first.uploadId, second.uploadId);
  assert.equal(first.originalName, 'movie.mp4');
  assert.equal(first.totalChunks, 3);
  assert.equal(first.chunkSize, 4 * 1024 * 1024);
  assert.equal(first.size, 10 * 1024 * 1024 + 1);
  assert.equal(first.mimeType, 'video/mp4');
  assert.equal(first.complete, false);
});

test('getChunkPlan returns exact byte ranges for final short chunk', () => {
  const plan = getChunkPlan({ size: 10, chunkSize: 4 });
  assert.deepEqual(plan, [
    { index: 0, start: 0, end: 3, size: 4 },
    { index: 1, start: 4, end: 7, size: 4 },
    { index: 2, start: 8, end: 9, size: 2 }
  ]);
});

test('getReceivedChunks and getMissingChunks normalize unordered uploaded chunk files', () => {
  const received = getReceivedChunks(['chunk-000002.part', 'notes.txt', 'chunk-000000.part']);
  assert.deepEqual(received, [0, 2]);
  assert.deepEqual(getMissingChunks(4, received), [1, 3]);
});

test('validateChunkIndex rejects out-of-range chunks and oversize chunks', () => {
  const manifest = buildUploadManifest({
    fingerprint: 'demo.bin:9:1',
    originalName: 'demo.bin',
    size: 9,
    mimeType: 'application/octet-stream',
    chunkSize: 4
  });

  assert.equal(validateChunkIndex(manifest, 0, 4).valid, true);
  assert.equal(validateChunkIndex(manifest, 2, 1).valid, true);
  assert.match(validateChunkIndex(manifest, 3, 1).error, /out of range/i);
  assert.match(validateChunkIndex(manifest, 2, 4).error, /expected 1 bytes/i);
});

assert.equal(DEFAULT_CHUNK_SIZE, 8 * 1024 * 1024);
