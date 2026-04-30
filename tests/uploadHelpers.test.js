import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getClipboardUploadFiles,
  mergeUploadedResults,
  isPreviewableImage,
  buildFileFingerprint,
  shouldUseResumableUpload,
  getFileChunks,
} from '../src/uploadHelpers.js';

test('clipboard helper extracts pasted files and gives unnamed images a useful filename', () => {
  const unnamedImage = { name: '', type: 'image/png', size: 12, marker: 'image' };
  const namedFile = { name: 'report.pdf', type: 'application/pdf', size: 34, marker: 'pdf' };
  const clipboardData = {
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => unnamedImage },
      { kind: 'file', getAsFile: () => namedFile },
    ],
  };

  const files = getClipboardUploadFiles(clipboardData, {
    makeFile: (file, name) => ({ ...file, name, renamed: true }),
  });

  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'clipboard-upload-1.png');
  assert.equal(files[0].renamed, true);
  assert.equal(files[1].name, 'report.pdf');
});

test('clipboard helper prefers clipboardData.files when available', () => {
  const file = { name: 'paste.txt', type: 'text/plain', size: 5 };
  const clipboardData = {
    files: [file],
    items: [{ kind: 'file', getAsFile: () => ({ name: 'ignored.png', type: 'image/png', size: 8 }) }],
  };

  assert.deepEqual(getClipboardUploadFiles(clipboardData), [file]);
});

test('uploaded result merge puts newest files first and avoids duplicate cards', () => {
  const existing = [{ id: 'old', filename: 'old.png', url: 'https://old' }];
  const incoming = [
    { id: 'new', filename: 'new.png', url: 'https://new' },
    { id: 'old', filename: 'old.png', url: 'https://old-updated' },
  ];

  const merged = mergeUploadedResults(existing, incoming);

  assert.deepEqual(merged.map(f => f.id), ['new', 'old']);
  assert.equal(merged[1].url, 'https://old-updated');
});

test('image preview helper detects uploaded images by mime type', () => {
  assert.equal(isPreviewableImage({ mimeType: 'image/png' }), true);
  assert.equal(isPreviewableImage({ mimeType: 'application/pdf' }), false);
});

test('resumable upload helpers build stable fingerprints and split files into chunks', () => {
  const file = {
    name: 'large-video.mp4',
    size: 10,
    type: 'video/mp4',
    lastModified: 12345,
    slice: (start, end) => ({ start, end, size: end - start })
  };

  assert.equal(buildFileFingerprint(file), 'large-video.mp4:10:12345');
  assert.equal(shouldUseResumableUpload({ size: 1024 * 1024 * 33 }, 32 * 1024 * 1024), true);
  assert.equal(shouldUseResumableUpload({ size: 1024 }, 32 * 1024 * 1024), false);

  const chunks = getFileChunks(file, 4);
  assert.deepEqual(chunks.map(c => ({ index: c.index, start: c.start, end: c.end, size: c.blob.size })), [
    { index: 0, start: 0, end: 4, size: 4 },
    { index: 1, start: 4, end: 8, size: 4 },
    { index: 2, start: 8, end: 10, size: 2 },
  ]);
});
