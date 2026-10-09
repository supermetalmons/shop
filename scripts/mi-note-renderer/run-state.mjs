import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TOOL_DIRECTORY, '../..');
export const CARD_IDS = Array.from({ length: 1430 }, (_, index) => index + 1);
export const CONTROL_IDS = [1, 166, 167, 460, 500, 1000, 1284, 1401, 1408, 1430, 100, 300, 600, 700, 800, 900, 1100, 1200, 1300, 1420];
export const PRESET = Object.freeze({
  width: 2000, height: 2800, windowWidth: 1280, windowHeight: 1000,
  innerWidth: 1024, innerHeight: 686, dpr: 2.5,
  screenshotWidth: 2560, screenshotHeight: 1716, documentHeightPixels: 2936,
  tileOriginsY: [-64, 1156], bottomScrollCss: 488, gutter: 64, edgeGuard: 64,
  recompositionTolerance: 2, pairReadinessAttempts: 5,
  opacity: '0.99', pointerX: '50%', pointerY: '50%', rotation: '0deg', shadow: 'none',
});
export const now = () => new Date().toISOString();
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function fileHash(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!size) return hash.digest('hex');
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

export function requireSpace(directory, additionalBytes = 0) {
  const stat = fs.statfsSync(directory);
  const free = stat.bavail * stat.bsize;
  if (free < 10 * 1024 ** 3 + additionalBytes) throw new Error(`DISK: insufficient space to retain 10 GiB in ${directory}`);
  return free;
}

export function moveDurably(source, destination) {
  requireSpace(path.dirname(destination), fs.statSync(source).size);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.copyFileSync(source, temporary);
  const descriptor = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  syncDirectory(path.dirname(destination));
  fs.unlinkSync(source);
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'tests') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(mjs|py|ts|tsx|css|html|txt|json)$/.test(entry.name) ? [file] : [];
  });
}

export function currentSourceHashes(root = ROOT, toolDirectory = TOOL_DIRECTORY) {
  const files = [
    ...sourceFiles(toolDirectory),
    ...sourceFiles(path.join(root, 'src')),
    ...['package.json', 'package-lock.json', 'vite.config.ts'].map(file => path.join(root, file)),
  ];
  return Object.fromEntries([...new Set(files)].sort().map(file => [path.relative(root, file), fileHash(file)]));
}

export function assertSources(config, root = ROOT) {
  for (const [file, hash] of Object.entries(config.sourceHashes)) {
    if (fileHash(path.join(root, file)) !== hash) throw new Error(`SOURCE_DRIFT: ${file}`);
  }
}

export function assetFingerprint(preflight) {
  if (!preflight.complete || preflight.summary?.assetsPassed !== 4290 || preflight.anomalies?.length !== 0 ||
      JSON.stringify(preflight.cards?.map(card => card.id)) !== JSON.stringify(CARD_IDS)) {
    throw new Error('Asset preflight is incomplete or contains anomalies');
  }
  return digest(JSON.stringify(preflight.cards.map(card => ({
    id: card.id,
    assets: Object.fromEntries(Object.entries(card.assets).map(([key, asset]) => [key, {
      url: asset.url, etag: asset.etag, dimensions: asset.dimensions, totalBytes: asset.totalBytes,
    }])),
  }))));
}

export function runFingerprint(config) {
  return digest(JSON.stringify({
    sourceHashes: config.sourceHashes, settings: config.settings, assetFingerprint: config.assetFingerprint,
    expectedIccSha256: config.expectedIccSha256, runtime: config.runtime,
  }));
}

export function assertRun(config, current) {
  if (config.runFingerprint !== runFingerprint(config) || config.runFingerprint !== runFingerprint(current)) {
    throw new Error('SOURCE_DRIFT: run fingerprint differs; use a new output/cache for changed inputs');
  }
}

export function newCheckpoint(fingerprint) {
  return {
    schemaVersion: 1, runFingerprint: fingerprint, startedAt: now(), status: 'initializing',
    completed: {}, commitOrder: [], controls: [], failures: [], attempts: {},
    startupControlsComplete: false, finalControlsComplete: false, lastControlCount: 0,
  };
}

export function verifyCompleted(state, config, output, cache) {
  if (state.runFingerprint !== config.runFingerprint) throw new Error('Checkpoint run fingerprint differs');
  if (!Array.isArray(state.commitOrder) || new Set(state.commitOrder).size !== state.commitOrder.length ||
      state.commitOrder.length !== Object.keys(state.completed).length ||
      state.commitOrder.some(id => !Number.isInteger(id) || !state.completed[id]) ||
      !Number.isInteger(state.lastControlCount) || state.lastControlCount < 0 || state.lastControlCount > state.commitOrder.length) {
    throw new Error('Invalid checkpoint commit order or control boundary');
  }
  const repairs = [];
  for (const [id, entry] of Object.entries(state.completed)) {
    if (!CARD_IDS.includes(Number(id)) || String(Number(id)) !== id) throw new Error(`Invalid checkpoint card ID: ${id}`);
    const png = path.join(output, `${id}.png`);
    const qa = path.join(output, 'qa', `${id}.json`);
    const thumb = path.join(output, 'thumbnails', `${id}.png`);
    let valid = false;
    try {
      const report = readJson(qa);
      valid = report.id === Number(id) && report.qaPassed === true && report.runFingerprint === config.runFingerprint &&
        report.fileSha256 === entry.fileSha256 && report.decodedRgbaSha256 === entry.decodedRgbaSha256 &&
        report.iccSha256 === config.expectedIccSha256 && fileHash(png) === entry.fileSha256 &&
        fileHash(qa) === entry.qaSha256 && fileHash(thumb) === entry.thumbnailSha256;
    } catch {}
    if (!valid) {
      const quarantine = path.join(cache, 'quarantine', `${Date.now()}-${id}`);
      fs.mkdirSync(quarantine, { recursive: true });
      for (const file of [png, qa, thumb]) {
        if (fs.existsSync(file)) moveDurably(file, path.join(quarantine, `${path.basename(path.dirname(file))}-${path.basename(file)}`));
      }
      delete state.completed[id];
      state.commitOrder = state.commitOrder.filter(value => value !== Number(id));
      repairs.push(Number(id));
    }
  }
  if (repairs.length) {
    state.controls = [];
    state.finalControlsComplete = false;
    state.lastControlCount = 0;
    state.startupControlsComplete = false;
  }
  state.resumeVerification = { at: now(), verifiedCompleted: Object.keys(state.completed).length, invalidatedIds: repairs };
  return repairs;
}

export function assertGeometry(snapshot) {
  if (snapshot.innerWidth !== PRESET.innerWidth || snapshot.innerHeight !== PRESET.innerHeight || snapshot.dpr !== PRESET.dpr) {
    throw new Error(`GEOMETRY: expected 1024×686 at DPR 2.5, got ${JSON.stringify(snapshot)}`);
  }
}

export function acquireRunLock(cache) {
  const file = path.join(cache, '.run.lock');
  const owner = JSON.stringify({ pid: process.pid, token: crypto.randomUUID(), startedAt: now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try { descriptor = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = fs.readFileSync(file, 'utf8');
      const record = JSON.parse(previous);
      if (!Number.isInteger(record.pid) || record.pid <= 0) throw new Error(`Invalid run lock: ${file}`);
      try { process.kill(record.pid, 0); }
      catch (probe) {
        if (probe.code !== 'ESRCH') throw probe;
        if (fs.readFileSync(file, 'utf8') === previous) fs.unlinkSync(file);
        continue;
      }
      throw new Error(`Renderer cache is in use by process ${record.pid}: ${cache}`);
    }
    try { fs.writeFileSync(descriptor, owner); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    return () => {
      try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  throw new Error(`Unable to acquire renderer cache lock: ${cache}`);
}
