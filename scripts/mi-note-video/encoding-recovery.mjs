import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const preparedWorkingFramePattern = /^(?:\d{4}\.png|\.\d{4}\.[a-f0-9]{32}\.pending\.png)$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const regular = path => {
  requireValue(realpathSync(dirname(path)) === dirname(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Expected a regular encoding recovery file: ${path}`);
  return lstatSync(path);
};
const verify = (path, entry) => {
  requireValue(regular(path).size === entry.bytes && hash(path) === entry.sha256, `Encoding recovery bytes changed: ${path}`);
};
const atomicJson = (path, value) => {
  const pending = join(dirname(path), `.journal-${randomUUID()}.pending.json`);
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const descriptor = openSync(pending, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(pending, path);
};

export function recoverInterruptedEncodes({ output, cache, ownerId, id, committed, allowFinal, checkOnly = false, onMove = () => {} }) {
  output = resolve(output);
  cache = resolve(cache);
  requireValue(realpathSync(output) === output && realpathSync(cache) === cache, 'Encoding recovery paths must not traverse symbolic links.');
  const ownerPath = join(cache, '.capture-owner.json');
  regular(ownerPath);
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  requireValue(ownerId && owner.ownerId === ownerId && owner.cache === cache && owner.output === output
    && JSON.stringify(owner.ids) === JSON.stringify([id]), 'Encoding recovery cache ownership differs.');
  const classify = name => name === `${id}.mp4` ? 'uncommitted-final'
    : new RegExp(`^\\.${id}\\.[a-f0-9]{32}\\.pending\\.mp4$`).test(name) ? 'pending-encode' : null;
  if (committed) {
    requireValue(committed.id === id && committed.output === join(output, `${id}.mp4`), 'Committed video identity differs.');
    verify(committed.output, committed);
  }
  const recoveryRoot = join(cache, 'encoding-recovery');
  const records = [];
  const unfinishedSources = new Set();
  if (existsSync(recoveryRoot)) {
    requireValue(realpathSync(recoveryRoot) === recoveryRoot && lstatSync(recoveryRoot).isDirectory(), 'Encoding recovery directory is not a real directory.');
    for (const name of readdirSync(recoveryRoot)) {
      const directory = join(recoveryRoot, name);
      requireValue(uuidPattern.test(name) && realpathSync(directory) === directory && lstatSync(directory).isDirectory(), 'Unexpected encoding recovery entry.');
      const path = join(directory, 'recovery.json');
      if (!existsSync(path)) {
        requireValue(readdirSync(directory).every(file => /^\.journal-[a-f0-9-]{36}\.pending\.json$/.test(file)
          && lstatSync(join(directory, file)).isFile() && !lstatSync(join(directory, file)).isSymbolicLink()), 'Unjournaled encoding recovery data requires inspection.');
        continue;
      }
      regular(path);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      requireValue(record.version === 1 && record.ownerId === ownerId && record.id === id && record.output === output && record.cache === cache
        && record.directory === directory && typeof record.complete === 'boolean' && Array.isArray(record.entries) && record.entries.length > 0,
      'Encoding recovery journal identity differs.');
      const sources = new Set();
      for (const entry of record.entries) {
        const file = basename(entry.source || '');
        requireValue(entry.source === join(output, file) && entry.destination === join(directory, file)
          && classify(file) === entry.kind && entry.kind !== null && /^[a-f0-9]{64}$/.test(entry.sha256 || '')
          && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && !sources.has(entry.source), 'Invalid encoding recovery journal entry.');
        sources.add(entry.source);
        if (record.complete) {
          verify(entry.destination, entry);
          continue;
        }
        requireValue(!unfinishedSources.has(entry.source), 'Duplicate unfinished encoding recovery.');
        unfinishedSources.add(entry.source);
        if (entry.kind === 'uncommitted-final') requireValue(allowFinal && !committed, 'Uncommitted final video lacks verified native evidence.');
        const atSource = existsSync(entry.source);
        const atDestination = existsSync(entry.destination);
        requireValue(atSource !== atDestination, 'Encoding recovery has conflicting or missing copies.');
        verify(atSource ? entry.source : entry.destination, entry);
      }
      records.push({ path, record });
    }
  }
  const candidates = [];
  for (const name of readdirSync(output).filter(name => name.endsWith('.mp4'))) {
    const source = join(output, name);
    if (committed && source === committed.output) continue;
    const kind = classify(name);
    requireValue(kind, `Unrecognized uncommitted video requires inspection: ${name}`);
    regular(source);
    if (kind === 'uncommitted-final') requireValue(allowFinal && !committed, 'Uncommitted final video lacks verified native evidence.');
    if (unfinishedSources.has(source)) continue;
    candidates.push({ source, kind, sha256: hash(source), bytes: lstatSync(source).size });
  }
  if (checkOnly) return {
    checkOnly: true,
    journals: records.map(({ path, record }) => ({ path, ...record })),
    pending: [...records.filter(({ record }) => !record.complete).flatMap(({ record }) => record.entries), ...candidates],
  };
  if (candidates.length) {
    mkdirSync(recoveryRoot, { recursive: true });
    requireValue(realpathSync(recoveryRoot) === recoveryRoot, 'Encoding recovery directory changed.');
    const directory = join(recoveryRoot, randomUUID());
    mkdirSync(directory);
    const record = { version: 1, ownerId, id, output, cache, directory, complete: false, createdAt: new Date().toISOString(),
      entries: candidates.map(entry => ({ ...entry, destination: join(directory, basename(entry.source)) })) };
    const path = join(directory, 'recovery.json');
    atomicJson(path, record);
    records.push({ path, record });
  }
  for (const { path, record } of records) {
    if (record.complete) continue;
    for (const entry of record.entries) {
      if (existsSync(entry.source)) {
        requireValue(!existsSync(entry.destination), 'Encoding recovery destination already exists.');
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
  return { checkOnly: false, journals: records.map(({ path, record }) => ({ path, ...record })), pending: [] };
}
