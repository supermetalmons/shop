import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const nativePendingFramePattern = /^\.(\d{4})\.[a-f0-9]{32}\.pending\.png$/;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const regular = path => {
  requireValue(realpathSync(dirname(path)) === dirname(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Expected a regular native frame: ${path}`);
  return lstatSync(path);
};
const verify = (path, entry) => requireValue(regular(path).size === entry.bytes && hash(path) === entry.sha256, `Preserved native frame changed: ${path}`);
const atomicJson = (path, value) => {
  const pending = join(dirname(path), `.journal-${randomUUID()}.pending.json`);
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(pending, path);
};

export function recoverUncommittedFrames({ output, cache, ownerId, id, frameCount, nativeFrames, incomplete, compacted,
  checkOnly = false, onMove = () => {} }) {
  output = resolve(output);
  cache = resolve(cache);
  const raw = join(cache, 'raw', `${id}c`);
  requireValue(realpathSync(cache) === cache && realpathSync(raw) === raw, 'Native frame recovery paths must not traverse symbolic links.');
  const ownerPath = join(cache, '.capture-owner.json');
  regular(ownerPath);
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  requireValue(ownerId && owner.ownerId === ownerId && owner.output === output && owner.cache === cache
    && JSON.stringify(owner.ids) === JSON.stringify([id]), 'Native frame recovery ownership differs.');
  if (!compacted) for (const [key, record] of Object.entries(nativeFrames)) {
    requireValue(record && record.id === id && Number.isInteger(record.frame) && record.frame >= 0 && record.frame < frameCount
      && key === `${id}:${record.frame}` && record.path === join(raw, `${String(record.frame).padStart(4, '0')}.png`)
      && /^[a-f0-9]{64}$/.test(record.sha256 || ''), 'Committed native frame checkpoint is invalid.');
    regular(record.path);
    requireValue(hash(record.path) === record.sha256, `Committed native frame changed: ${record.path}`);
  }
  const recoveryRoot = join(cache, 'frame-recovery');
  const journals = [];
  const unfinished = new Set();
  if (existsSync(recoveryRoot)) {
    requireValue(realpathSync(recoveryRoot) === recoveryRoot && lstatSync(recoveryRoot).isDirectory(), 'Invalid native frame recovery directory.');
    for (const name of readdirSync(recoveryRoot)) {
      const directory = join(recoveryRoot, name);
      requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)
        && realpathSync(directory) === directory && lstatSync(directory).isDirectory(), 'Unexpected native frame recovery entry.');
      const path = join(directory, 'recovery.json');
      if (!existsSync(path)) {
        requireValue(readdirSync(directory).every(file => /^\.journal-[a-f0-9-]{36}\.pending\.json$/.test(file)
          && lstatSync(join(directory, file)).isFile() && !lstatSync(join(directory, file)).isSymbolicLink()), 'Unjournaled native frame recovery requires inspection.');
        continue;
      }
      regular(path);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      requireValue(record.version === 1 && record.ownerId === ownerId && record.id === id && record.raw === raw && record.directory === directory
        && typeof record.complete === 'boolean' && Array.isArray(record.entries) && record.entries.length > 0, 'Native frame recovery journal identity differs.');
      const seen = new Set();
      for (const entry of record.entries) {
        const filename = `${String(entry.frame).padStart(4, '0')}.png`;
        requireValue(Number.isInteger(entry.frame) && entry.frame >= 0 && entry.frame < frameCount
          && entry.source === join(raw, filename) && entry.destination === join(directory, filename)
          && /^[a-f0-9]{64}$/.test(entry.sha256 || '') && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && !seen.has(entry.frame),
        'Invalid native frame recovery entry.');
        seen.add(entry.frame);
        if (record.complete) { verify(entry.destination, entry); continue; }
        requireValue(incomplete && !compacted && !Object.hasOwn(nativeFrames, `${id}:${entry.frame}`) && !unfinished.has(entry.source),
          'Recovery would replace a committed or completed native frame.');
        unfinished.add(entry.source);
        requireValue(existsSync(entry.source) !== existsSync(entry.destination), 'Native frame recovery has conflicting or missing copies.');
        verify(existsSync(entry.source) ? entry.source : entry.destination, entry);
      }
      journals.push({ path, record });
    }
  }
  const candidates = [];
  for (const name of readdirSync(raw)) {
    const source = join(raw, name);
    regular(source);
    const pending = name.match(nativePendingFramePattern);
    if (pending && Number(pending[1]) < frameCount) continue;
    requireValue(/^\d{4}\.png$/.test(name) && Number(name.slice(0, 4)) < frameCount, `Unknown native frame name: ${name}`);
    const frame = Number(name.slice(0, 4));
    if (Object.hasOwn(nativeFrames, `${id}:${frame}`)) continue;
    requireValue(incomplete && !compacted, 'Completed capture has a native frame without a committed checkpoint.');
    if (!unfinished.has(source)) candidates.push({ frame, source, sha256: hash(source), bytes: lstatSync(source).size });
  }
  if (checkOnly) return { checkOnly: true, journals: journals.map(({ path, record }) => ({ path, ...record })),
    pending: [...journals.filter(({ record }) => !record.complete).flatMap(({ record }) => record.entries), ...candidates] };
  if (candidates.length) {
    mkdirSync(recoveryRoot, { recursive: true });
    requireValue(realpathSync(recoveryRoot) === recoveryRoot, 'Native frame recovery directory changed.');
    const directory = join(recoveryRoot, randomUUID());
    mkdirSync(directory);
    const record = { version: 1, ownerId, id, raw, directory, complete: false, createdAt: new Date().toISOString(),
      entries: candidates.map(entry => ({ ...entry, destination: join(directory, basename(entry.source)) })) };
    const path = join(directory, 'recovery.json');
    atomicJson(path, record);
    journals.push({ path, record });
  }
  for (const { path, record } of journals) {
    if (record.complete) continue;
    for (const entry of record.entries) {
      if (existsSync(entry.source)) {
        requireValue(!existsSync(entry.destination), 'Native frame recovery destination already exists.');
        verify(entry.source, entry);
        renameSync(entry.source, entry.destination);
        verify(entry.destination, entry);
        onMove(entry);
      } else verify(entry.destination, entry);
    }
    record.complete = true;
    record.finishedAt = new Date().toISOString();
    atomicJson(path, record);
  }
  return { checkOnly: false, journals: journals.map(({ path, record }) => ({ path, ...record })), pending: [] };
}
