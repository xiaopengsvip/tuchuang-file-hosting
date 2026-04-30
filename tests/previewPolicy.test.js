import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPreviewKind,
  supportsNativePreview,
  buildPreviewUrl,
} from '../src/previewPolicy.js';

test('preview policy uses original uploaded file URLs without compression for media', () => {
  const image = { id: 'img1', url: 'https://files.example/f/img1/photo.jpg', mimeType: 'image/jpeg' };
  const video = { id: 'vid1', url: 'https://files.example/f/vid1/movie.mp4', mimeType: 'video/mp4' };

  assert.equal(getPreviewKind(image), 'image');
  assert.equal(getPreviewKind(video), 'video');
  assert.equal(buildPreviewUrl(image), image.url);
  assert.equal(buildPreviewUrl(video), video.url);
});

test('preview policy supports browser-native and safe text previews for common file types', () => {
  assert.equal(getPreviewKind({ mimeType: 'audio/wav' }), 'audio');
  assert.equal(getPreviewKind({ mimeType: 'application/pdf' }), 'pdf');
  assert.equal(getPreviewKind({ mimeType: 'text/plain' }), 'text');
  assert.equal(getPreviewKind({ mimeType: 'application/json' }), 'text');
  assert.equal(getPreviewKind({ mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'office');
  assert.equal(getPreviewKind({ mimeType: 'application/octet-stream' }), 'generic');

  assert.equal(supportsNativePreview({ mimeType: 'image/png' }), true);
  assert.equal(supportsNativePreview({ mimeType: 'video/mp4' }), true);
  assert.equal(supportsNativePreview({ mimeType: 'audio/mpeg' }), true);
  assert.equal(supportsNativePreview({ mimeType: 'application/pdf' }), true);
  assert.equal(supportsNativePreview({ mimeType: 'application/zip' }), false);
});
