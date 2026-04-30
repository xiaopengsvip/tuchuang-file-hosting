import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fixMojibakeFilename,
  hasMojibakeFilename,
  normalizeOriginalName,
  normalizeFileIndexNames,
} from '../src/filenameEncoding.js';

test('fixMojibakeFilename decodes UTF-8 filenames that were read as latin1', () => {
  assert.equal(fixMojibakeFilename('3D å»ºæ¨¡å\u009b¾ç\u0089\u0087å\u0088¶ä½\u009c.mp4'), '3D 建模图片制作.mp4');
  assert.equal(fixMojibakeFilename('è®°å¿\u0086ç¢\u008eç\u0089\u0087ä¸\u008eé\u0087\u008då\u0090¯ä¹\u008bè·¯.png'), '记忆碎片与重启之路.png');
});

test('fixMojibakeFilename preserves normal ascii and already valid unicode filenames', () => {
  assert.equal(fixMojibakeFilename('everettlogo.jpg'), 'everettlogo.jpg');
  assert.equal(fixMojibakeFilename('背景 2.jpg'), '背景 2.jpg');
  assert.equal(fixMojibakeFilename('café.jpg'), 'café.jpg');
});

test('normalizeOriginalName also strips dangerous path/control characters after decoding', () => {
  assert.equal(normalizeOriginalName('../è\u0083\u008cæ\u0099¯ 2.jpg\n'), '.._背景 2.jpg');
});

test('normalizeFileIndexNames mutates only records with mojibake names', () => {
  const fileIndex = {
    'bad.png': { originalName: 'æ\u0095\u0088æ\u009e\u009cå\u009b¾.png' },
    'good.jpg': { originalName: '背景 2.jpg' },
  };

  const result = normalizeFileIndexNames(fileIndex);

  assert.equal(result.changed, 1);
  assert.equal(fileIndex['bad.png'].originalName, '效果图.png');
  assert.equal(fileIndex['good.jpg'].originalName, '背景 2.jpg');
  assert.equal(hasMojibakeFilename(fileIndex['bad.png'].originalName), false);
});
