import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  moderateUploadCandidate,
  moderationErrorPayload,
  readTextSampleForModeration,
} from '../src/contentModeration.js';

test('moderation blocks upload metadata that is suspected pornography, gambling, or drug content', () => {
  const sexual = moderateUploadCandidate({ originalName: '成人内容-宣传图.jpg', mimeType: 'image/jpeg' });
  assert.equal(sexual.allowed, false);
  assert.deepEqual(sexual.categories, ['sexual']);

  const gambling = moderateUploadCandidate({ originalName: 'daily-report.pdf', textFields: ['百家乐下注活动'] });
  assert.equal(gambling.allowed, false);
  assert.deepEqual(gambling.categories, ['gambling']);

  const drugs = moderateUploadCandidate({ originalName: '吸毒教程.txt', mimeType: 'text/plain' });
  assert.equal(drugs.allowed, false);
  assert.deepEqual(drugs.categories, ['drugs']);
});

test('moderation catches spaced and full-width obfuscation while allowing normal business files', () => {
  const obfuscated = moderateUploadCandidate({ originalName: '博 彩 推 广.png', textFields: ['ＢＡＣＣＡＲＡＴ 下注'] });
  assert.equal(obfuscated.allowed, false);
  assert.deepEqual(obfuscated.categories, ['gambling']);

  const safe = moderateUploadCandidate({
    originalName: '运营中心日报-2026.pdf',
    mimeType: 'application/pdf',
    textFields: ['生产运营中心日报，包含设备告警和能耗统计。'],
  });
  assert.equal(safe.allowed, true);
  assert.deepEqual(safe.categories, []);
});

test('moderation can scan bounded text samples from uploaded text files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-moderation-'));
  const file = path.join(dir, 'normal-name.txt');
  fs.writeFileSync(file, '这是一段诱导吸毒的违规文本内容');
  try {
    const textSample = readTextSampleForModeration(file, { mimeType: 'text/plain', originalName: 'normal-name.txt' });
    const result = moderateUploadCandidate({ originalName: 'normal-name.txt', mimeType: 'text/plain', textSample });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.categories, ['drugs']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('moderation error payload hides raw matched terms and returns stable category labels', () => {
  const result = moderateUploadCandidate({ originalName: 'casino-bet.txt' });
  const payload = moderationErrorPayload(result);
  assert.equal(payload.success, false);
  assert.equal(payload.error.includes('上传被拒绝'), true);
  assert.deepEqual(payload.moderation.categories, ['gambling']);
  assert.equal('matches' in payload.moderation, false);
});
