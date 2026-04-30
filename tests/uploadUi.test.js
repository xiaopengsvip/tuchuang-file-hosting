import test from 'node:test';
import assert from 'node:assert/strict';
import { getFriendlyUploadError, getDirectViewUrl, getSameSitePreviewUrl } from '../src/uploadUi.js';

test('simple upload network errors tell users to retry from the beginning, not resume chunks', () => {
  const copy = getFriendlyUploadError(new Error('Network error'), {
    phase: 'simple_upload',
    maxFileBytes: 1024 * 1024 * 1024
  });

  assert.equal(copy.message, '网络中断，上传未完成');
  assert.match(copy.hint, /重新选择该文件上传/);
  assert.match(copy.hint, /从头重试/);
  assert.doesNotMatch(copy.hint, /跳过已上传分片|断点续传/);
});

test('resumable upload network errors keep the resume hint', () => {
  const copy = getFriendlyUploadError(new Error('Network error'), {
    phase: 'chunk_upload',
    maxFileBytes: 1024 * 1024 * 1024
  });

  assert.equal(copy.message, '网络中断，上传未完成');
  assert.match(copy.hint, /重新选择同一文件/);
  assert.match(copy.hint, /跳过已上传分片/);
});

test('direct view URL prefers preview route for newly uploaded files', () => {
  assert.equal(
    getDirectViewUrl({ id: 'abc123', originalName: 'YY资产财报.xlsx' }),
    '/preview/abc123'
  );
  assert.equal(
    getDirectViewUrl({ id: 'abc123', previewUrl: 'https://tc.allapple.top/preview/abc123', url: 'https://tc.allapple.top/f/abc123/file.xlsx' }),
    'https://tc.allapple.top/preview/abc123'
  );
});

test('same-site preview URL stays relative so in-page preview is not cross-origin blocked', () => {
  assert.equal(
    getSameSitePreviewUrl({ id: 'abc123', previewUrl: 'https://tuchuang.allapple.top/preview/abc123' }),
    '/preview/abc123'
  );
  assert.equal(
    getSameSitePreviewUrl({ filename: 'abc123.png' }, ''),
    '/preview/abc123.png'
  );
});
