const MOJIBAKE_HINT_RE = /[\u0080-\u009f\u00c0-\u00ff]/;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const REPLACEMENT_RE = /\ufffd/;

function canRoundtripAsLatin1(value) {
  for (const ch of value) {
    if (ch.codePointAt(0) > 0xff) return false;
  }
  return true;
}

function mojibakeScore(value) {
  let score = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code >= 0x80 && code <= 0x9f) score += 3;
    if (code >= 0xc0 && code <= 0xff) score += 1;
  }
  return score;
}

export function hasMojibakeFilename(name = '') {
  const value = String(name || '');
  return canRoundtripAsLatin1(value) && MOJIBAKE_HINT_RE.test(value) && mojibakeScore(value) >= 2;
}

export function fixMojibakeFilename(name = '') {
  const value = String(name || '');
  if (!hasMojibakeFilename(value)) return value;

  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  if (!decoded || REPLACEMENT_RE.test(decoded)) return value;

  const decodedScore = mojibakeScore(decoded);
  const originalScore = mojibakeScore(value);
  const looksClearlyBetter = decodedScore < originalScore && (CJK_RE.test(decoded) || originalScore >= 4);

  return looksClearlyBetter ? decoded : value;
}

export function sanitizeOriginalName(name = 'file') {
  return String(name || 'file')
    .trim()
    .replace(/[\\/\0\r\n]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .slice(0, 180) || 'file';
}

export function normalizeOriginalName(name = 'file') {
  return sanitizeOriginalName(fixMojibakeFilename(name));
}

export function normalizeFileIndexNames(fileIndex = {}) {
  let changed = 0;
  for (const record of Object.values(fileIndex || {})) {
    if (!record || typeof record !== 'object') continue;
    const current = record.originalName || record.filename || record.storedName || 'file';
    const normalized = normalizeOriginalName(current);
    if (normalized !== record.originalName) {
      record.originalName = normalized;
      changed += 1;
    }
  }
  return { changed };
}
