import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMediaModerationConfig,
  isVisualModerationCandidate,
  moderateMediaFile,
  publishQuarantinedFile,
} from '../src/mediaModeration.js';

test('visual moderation candidates include images and videos only', () => {
  assert.equal(isVisualModerationCandidate({ mimeType: 'image/png', originalName: 'a.png' }), true);
  assert.equal(isVisualModerationCandidate({ mimeType: 'video/mp4', originalName: 'a.mp4' }), true);
  assert.equal(isVisualModerationCandidate({ mimeType: 'text/plain', originalName: 'a.txt' }), false);
  assert.equal(isVisualModerationCandidate({ mimeType: '', originalName: 'photo.jpg' }), true);
});

test('media moderation config defaults to local scanner with bounded video frame sampling', () => {
  const config = buildMediaModerationConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.blockOnUnavailable, false);
  assert.equal(config.maxVideoFrames > 0, true);
  assert.equal(config.videoFrameIntervalSeconds >= 3, true);
  assert.match(config.scannerArgs.join(' '), /local-media-moderation\.py/);
});

test('media moderation blocks when local scanner reports sexual visual content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-media-mod-'));
  const scanner = path.join(dir, 'scanner.mjs');
  const image = path.join(dir, 'image.jpg');
  fs.writeFileSync(image, 'fake image');
  fs.writeFileSync(scanner, `
    const payload = { available: true, blocked: true, categories: ['sexual'], categoryLabels: ['色情低俗'], frames: [{ path: process.argv.at(-1), score: 0.98 }] };
    console.log(JSON.stringify(payload));
  `);
  try {
    const result = await moderateMediaFile({
      filePath: image,
      originalName: 'normal.jpg',
      mimeType: 'image/jpeg',
      config: { enabled: true, scannerCommand: process.execPath, scannerArgs: [scanner], blockOnUnavailable: false }
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.categories, ['sexual']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('media moderation can fail closed when scanner is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-media-mod-'));
  const image = path.join(dir, 'image.jpg');
  fs.writeFileSync(image, 'fake image');
  try {
    const openResult = await moderateMediaFile({
      filePath: image,
      originalName: 'normal.jpg',
      mimeType: 'image/jpeg',
      config: { enabled: true, scannerCommand: '/not/a/scanner', scannerArgs: [], blockOnUnavailable: false }
    });
    assert.equal(openResult.allowed, true);
    assert.equal(openResult.unavailable, true);

    const closedResult = await moderateMediaFile({
      filePath: image,
      originalName: 'normal.jpg',
      mimeType: 'image/jpeg',
      config: { enabled: true, scannerCommand: '/not/a/scanner', scannerArgs: [], blockOnUnavailable: true }
    });
    assert.equal(closedResult.allowed, false);
    assert.equal(closedResult.unavailable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishQuarantinedFile moves accepted uploads from quarantine into public upload storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-quarantine-'));
  const quarantineFile = path.join(dir, 'quarantine', 'abc.jpg');
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(path.dirname(quarantineFile), { recursive: true });
  fs.writeFileSync(quarantineFile, 'accepted');
  try {
    const finalPath = publishQuarantinedFile({ quarantinePath: quarantineFile, uploadDir, storedName: 'abc.jpg' });
    assert.equal(fs.existsSync(quarantineFile), false);
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'accepted');
    assert.equal(path.dirname(finalPath), uploadDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
