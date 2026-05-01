import fs from 'fs';
import path from 'path';

export const MODERATION_CATEGORY_LABELS = {
  sexual: '色情低俗',
  gambling: '赌博博彩',
  drugs: '吸毒涉毒',
  'media-scanner-unavailable': '媒体审核服务不可用',
};

const CATEGORY_ORDER = ['sexual', 'gambling', 'drugs'];

const CATEGORY_TERMS = {
  sexual: [
    '色情',
    '涉黄',
    '成人内容',
    '成人视频',
    '成人影片',
    '黄色视频',
    '裸聊',
    '裸照',
    '约炮',
    '三级片',
    'porn',
    'porno',
    'pornhub',
    'xxxvideo',
    'adultvideo',
  ],
  gambling: [
    '赌博',
    '博彩',
    '下注',
    '百家乐',
    '六合彩',
    '时时彩',
    '老虎机',
    '娱乐城',
    '现金网',
    '盘口',
    '赌盘',
    'casino',
    'baccarat',
    'betting',
    'sportsbook',
  ],
  drugs: [
    '吸毒',
    '涉毒',
    '毒品',
    '冰毒',
    '海洛因',
    '大麻',
    '可卡因',
    '摇头丸',
    'k粉',
    '笑气',
    'meth',
    'heroin',
    'cocaine',
    'cannabis',
    'marijuana',
  ],
};

const TEXT_SAMPLE_BYTES = 64 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.htm',
  '.svg', '.js', '.mjs', '.cjs', '.css', '.log', '.srt', '.vtt'
]);

function toHalfWidth(input = '') {
  return String(input).replace(/[\u3000\uff01-\uff5e]/g, char => {
    if (char === '\u3000') return ' ';
    return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
  });
}

export function normalizeModerationText(input = '') {
  return toHalfWidth(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .trim();
}

function compactModerationText(input = '') {
  return normalizeModerationText(input).replace(/[\s\p{P}\p{S}_-]+/gu, '');
}

function collectTextFields(candidate = {}) {
  const fields = [];
  const add = value => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) return value.forEach(add);
    if (typeof value === 'object') return Object.values(value).forEach(add);
    const text = String(value).trim();
    if (text) fields.push(text);
  };

  add(candidate.originalName);
  add(candidate.filename);
  add(candidate.title);
  add(candidate.description);
  add(candidate.tags);
  add(candidate.textFields);
  add(candidate.fields);
  add(candidate.textSample);
  return fields;
}

function scanModerationCategories(textFields = []) {
  const categories = new Set();
  const matches = [];

  for (const text of textFields) {
    const normalized = normalizeModerationText(text);
    const compact = compactModerationText(text);
    if (!normalized && !compact) continue;

    for (const category of CATEGORY_ORDER) {
      for (const term of CATEGORY_TERMS[category]) {
        const normalizedTerm = normalizeModerationText(term);
        const compactTerm = compactModerationText(term);
        if ((normalizedTerm && normalized.includes(normalizedTerm)) || (compactTerm && compact.includes(compactTerm))) {
          categories.add(category);
          matches.push({ category, term });
          break;
        }
      }
    }
  }

  return {
    categories: CATEGORY_ORDER.filter(category => categories.has(category)),
    matches,
  };
}

export function moderateUploadCandidate(candidate = {}) {
  const { categories, matches } = scanModerationCategories(collectTextFields(candidate));
  return {
    allowed: categories.length === 0,
    blocked: categories.length > 0,
    categories,
    categoryLabels: categories.map(category => MODERATION_CATEGORY_LABELS[category] || category),
    matches,
  };
}

export function moderationErrorPayload(result = {}) {
  const categories = Array.isArray(result.categories) ? result.categories : [];
  const labels = Array.isArray(result.categoryLabels) && result.categoryLabels.length
    ? result.categoryLabels
    : categories.map(category => MODERATION_CATEGORY_LABELS[category] || category);
  return {
    success: false,
    error: `上传被拒绝：文件名、文本内容或描述疑似包含${labels.join('、') || '违规'}内容，禁止上传。`,
    moderation: {
      blocked: true,
      categories,
      categoryLabels: labels,
    },
  };
}

export function isTextLikeForModeration({ mimeType = '', originalName = '' } = {}) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  if (normalizedMime.startsWith('text/')) return true;
  if (/\b(json|xml|javascript|ecmascript|x-www-form-urlencoded)\b/i.test(normalizedMime)) return true;
  return TEXT_EXTENSIONS.has(path.extname(String(originalName || '')).toLowerCase());
}

export function readTextSampleForModeration(filePath, { mimeType = '', originalName = '' } = {}) {
  if (!filePath || !isTextLikeForModeration({ mimeType, originalName })) return '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, TEXT_SAMPLE_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
