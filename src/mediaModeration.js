import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SCANNER_SCRIPT = path.join(__dirname, '..', 'scripts', 'local-media-moderation.py');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.flv']);

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function mediaKind({ mimeType = '', originalName = '' } = {}) {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return '';
}

export function isVisualModerationCandidate(input = {}) {
  return Boolean(mediaKind(input));
}

export function buildMediaModerationConfig(env = process.env) {
  const script = env.MEDIA_MODERATION_SCRIPT || DEFAULT_SCANNER_SCRIPT;
  return {
    enabled: env.MEDIA_MODERATION_ENABLED === undefined ? true : boolFromEnv(env.MEDIA_MODERATION_ENABLED, true),
    blockOnUnavailable: boolFromEnv(env.MEDIA_MODERATION_BLOCK_ON_UNAVAILABLE, false),
    scannerCommand: env.MEDIA_MODERATION_SCANNER_COMMAND || env.MEDIA_MODERATION_PYTHON || 'python3',
    scannerArgs: env.MEDIA_MODERATION_SCANNER_ARGS ? env.MEDIA_MODERATION_SCANNER_ARGS.split(/\s+/).filter(Boolean) : [script],
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    maxVideoFrames: positiveInt(env.MEDIA_MODERATION_MAX_VIDEO_FRAMES, 12),
    videoFrameIntervalSeconds: positiveInt(env.MEDIA_MODERATION_VIDEO_FRAME_INTERVAL_SECONDS, 5),
    timeoutMs: positiveInt(env.MEDIA_MODERATION_TIMEOUT_MS, 120000),
    workDir: env.MEDIA_MODERATION_WORK_DIR || os.tmpdir(),
  };
}

function execFileJson(command, args, { timeoutMs = 120000, maxBuffer = 1024 * 1024 * 8 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        return resolve({ available: false, blocked: false, categories: [], error: error.code || error.message || String(error), stderr: String(stderr || '').slice(0, 500) });
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : { available: false, blocked: false, categories: [] });
      } catch (err) {
        resolve({ available: false, blocked: false, categories: [], error: 'invalid_scanner_json', stderr: String(stderr || stdout || '').slice(0, 500) });
      }
    });
  });
}

function normalizeScannerResult(result = {}, { blockOnUnavailable = false } = {}) {
  const available = result.available !== false;
  const categories = Array.isArray(result.categories) ? [...new Set(result.categories.map(String).filter(Boolean))] : [];
  const unavailable = !available;
  const blocked = unavailable ? Boolean(blockOnUnavailable) : Boolean(result.blocked || categories.length > 0);
  return {
    allowed: !blocked,
    blocked,
    unavailable,
    categories: unavailable && blocked ? ['media-scanner-unavailable'] : categories,
    categoryLabels: Array.isArray(result.categoryLabels) ? result.categoryLabels : undefined,
    provider: result.provider || 'local-media-moderation',
    details: result.details || result.frames || [],
    error: result.error || '',
  };
}

async function runScanner(paths, config) {
  if (!paths.length) return normalizeScannerResult({ available: false, error: 'no_media_samples' }, config);
  const result = await execFileJson(config.scannerCommand, [...(config.scannerArgs || []), ...paths], { timeoutMs: config.timeoutMs });
  return normalizeScannerResult(result, config);
}

async function extractVideoFrames(filePath, config) {
  const dir = fs.mkdtempSync(path.join(config.workDir || os.tmpdir(), 'tc-video-frames-'));
  const outputPattern = path.join(dir, 'frame-%03d.jpg');
  const interval = positiveInt(config.videoFrameIntervalSeconds, 5);
  const maxFrames = positiveInt(config.maxVideoFrames, 12);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', filePath,
    '-vf', `fps=1/${interval},scale=480:-1`,
    '-frames:v', String(maxFrames),
    outputPattern,
  ];
  const result = await new Promise(resolve => {
    execFile(config.ffmpegPath || 'ffmpeg', args, { timeout: config.timeoutMs || 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
  if (result.error) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { frames: [], cleanupDir: '', error: result.error.code || result.error.message || String(result.error) };
  }
  const frames = fs.readdirSync(dir)
    .filter(name => /\.jpe?g$/i.test(name))
    .sort()
    .map(name => path.join(dir, name));
  return { frames, cleanupDir: dir, error: '' };
}

export async function moderateMediaFile({ filePath, originalName = '', mimeType = '', config = buildMediaModerationConfig() } = {}) {
  const kind = mediaKind({ mimeType, originalName });
  if (!config.enabled || !kind) {
    return { allowed: true, blocked: false, skipped: true, categories: [] };
  }

  if (kind === 'image') {
    return runScanner([filePath], config);
  }

  const extraction = await extractVideoFrames(filePath, config);
  if (extraction.error || extraction.frames.length === 0) {
    return normalizeScannerResult({ available: false, error: extraction.error || 'no_video_frames' }, config);
  }
  try {
    return await runScanner(extraction.frames, config);
  } finally {
    if (extraction.cleanupDir) fs.rmSync(extraction.cleanupDir, { recursive: true, force: true });
  }
}

export function publishQuarantinedFile({ quarantinePath, uploadDir, storedName }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const finalPath = path.join(uploadDir, storedName);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  try {
    fs.renameSync(quarantinePath, finalPath);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(quarantinePath, finalPath);
    fs.rmSync(quarantinePath, { force: true });
  }
  return finalPath;
}
