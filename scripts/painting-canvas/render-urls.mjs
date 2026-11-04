import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, closeSync, constants, createWriteStream, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'npm run render:canvases:urls -- --url-template "https://example.org/{id}.png" --first 1 --last 100 --output directory';
const batchSize = 20;
const checksum = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function options() {
  const { values } = parseArgs({ options: {
    'url-template': { type: 'string' }, first: { type: 'string' }, last: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  const template = values['url-template'];
  const ids = [values.first, values.last];
  if (!template || template.split('{id}').length !== 2 || !values.output ||
      !ids.every(id => /^\d+$/.test(id) && Number.isSafeInteger(Number(id))) || Number(values.first) > Number(values.last)) {
    throw new Error(usage);
  }
  const urlFor = id => new URL(template.replace('{id}', String(id)));
  const first = Number(values.first), last = Number(values.last);
  const source = urlFor(first);
  const extension = extname(source.pathname).toLowerCase();
  if (!['http:', 'https:'].includes(source.protocol) || !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    throw new Error('Expected an HTTP(S) URL for a PNG, JPEG, or WebP image.');
  }
  return { first, last, output: resolve(values.output), urlFor, extension };
}

function hasImageHeader(path) {
  const header = Buffer.alloc(20);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    if (extname(path) === '.webp' && header.readUInt32LE(4) + 8 !== fstatSync(fd).size) return false;
  } finally { closeSync(fd); }
  switch (extname(path)) {
    case '.png': return header.toString('hex', 0, 8) === '89504e470d0a1a0a' && header.toString('latin1', 12, 16) === 'IHDR';
    case '.webp': return header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(header.toString('latin1', 12, 16));
    default: return header.readUIntBE(0, 3) === 0xffd8ff;
  }
}

async function download(sample, signal) {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
    try {
      const response = await fetch(sample.url, { signal: timeout });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(response.body, createWriteStream(sample.path, { flags: 'wx' }), { signal: timeout });
      if (!hasImageHeader(sample.path)) throw new Error(`Invalid ${extname(sample.path)} image header`);
      return;
    } catch (error) {
      rmSync(sample.path, { force: true });
      signal.throwIfAborted();
      if (attempt === 3) throw new Error(`Download failed for ID ${sample.id}: ${error.message}`);
      console.error(`Retrying download ${sample.id}: ${error.message}`);
      await delay(1000 * attempt, undefined, { signal });
    }
  }
}

async function prepare(samples, signal) {
  const queue = samples.values();
  const controller = new AbortController();
  const stop = AbortSignal.any([signal, controller.signal]);
  const workers = Array.from({ length: Math.min(4, samples.length) }, async () => {
    try {
      for (const sample of queue) await download(sample, stop);
    } catch (error) { controller.abort(error); }
  });
  await Promise.all(workers);
  stop.throwIfAborted();
  return samples;
}

async function render(args, directory, signal, lock, onRecord) {
  signal.throwIfAborted();
  const child = spawn('npm', ['run', '--silent', 'render:canvases', '--', ...args, '--output', directory],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit', lock], detached: true });
  const closed = once(child, 'close').catch(error => [null, error]);
  const stop = () => { if (child.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  } };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (onRecord && line.startsWith('CANVAS_RESULT ')) onRecord(JSON.parse(line.slice('CANVAS_RESULT '.length)));
    }
    const [code, reason] = await closed;
    signal.throwIfAborted();
    if (reason instanceof Error) throw reason;
    if (code !== 0) {
      const log = join(directory, 'render.log');
      const details = lstatSync(log, { throwIfNoEntry: false }) ? readFileSync(log, 'utf8').trimEnd().split('\n').slice(-12).join('\n') : '';
      throw new Error(`Canvas renderer exited (${code ?? reason}).\n${details}`);
    }
  } finally {
    stop();
    await closed;
    signal.removeEventListener('abort', stop);
  }
}

const journalHeader = '{"type":"painting-canvas-url-checkpoint","version":1}';
const journalName = 'canvas-checkpoint.jsonl';

function sameFile(a, b) {
  return b && a.dev === b.dev && a.ino === b.ino;
}

function assertCheckpoint(output, checkpoint) {
  const opened = fstatSync(checkpoint, { bigint: true });
  const current = lstatSync(join(output, journalName), { bigint: true, throwIfNoEntry: false });
  if (!sameFile(opened, current)) throw new Error('Checkpoint moved or replaced during the run.');
  if (!opened.isFile() || opened.nlink !== 1n) throw new Error('The checkpoint must be a regular, unlinked file.');
}

function openCheckpoint(output, work) {
  const path = join(output, journalName);
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    const seed = join(work, 'checkpoint.init');
    writeFileSync(seed, journalHeader + '\n', { flag: 'wx', flush: true });
    try { linkSync(seed, path); }
    finally { rmSync(seed); }
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assertCheckpoint(output, fd);
    if (fstatSync(fd).size === 0) {
      appendFileSync(fd, journalHeader + '\n', { flush: true });
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function pendingSamples({ first, last, output, urlFor, extension }, checkpoint, work) {
  assertCheckpoint(output, checkpoint);
  const records = new Map(), intents = new Map();
  const contents = readFileSync(join(output, journalName), 'utf8');
  const lines = contents.split('\n'), tail = lines.pop();
  const marked = lines[0] === journalHeader;
  if (marked) lines.shift();
  for (const line of lines.filter(Boolean)) {
    const row = JSON.parse(line);
    const record = row.published ? intents.get(row.published) : row;
    if (!record || !Number.isSafeInteger(record.id) || record.id < 0 || typeof record.url !== 'string' ||
        !/^https?:\/\//.test(record.url) || !/^[0-9a-f]{64}$/.test(record.source_sha256) ||
        !/^[0-9a-f]{64}$/.test(record.output_sha256)) {
      throw new Error('Invalid record in canvas-checkpoint.jsonl.');
    }
    if (row.pending) {
      intents.set(row.pending, row);
    } else {
      const prior = records.get(record.id);
      if (prior && (prior.url !== record.url || prior.output_sha256 !== record.output_sha256)) {
        throw new Error(`Conflicting checkpoint records for ID ${record.id}.`);
      }
      records.set(record.id, record);
    }
  }
  if (!marked && !records.size && !intents.size) throw new Error('Unrecognized canvas-checkpoint.jsonl; use a fresh output directory.');
  if (tail) {
    const journalPrefixes = ['{"pending":', '{"published":'];
    if (!journalPrefixes.some(prefix => tail.startsWith(prefix) || prefix.startsWith(tail))) {
      throw new Error('Incomplete line in canvas-checkpoint.jsonl.');
    }
    assertCheckpoint(output, checkpoint);
    ftruncateSync(checkpoint, Buffer.byteLength(contents.slice(0, -tail.length)));
  }
  const pending = [];
  for (let id = first; id <= last; id++) {
    const url = urlFor(id).href, target = join(output, `${id}.webp`);
    const file = lstatSync(target, { throwIfNoEntry: false });
    const identity = file && `${id}:${file.dev}:${file.ino}`;
    const record = records.get(id) ?? intents.get(identity);
    if (record) {
      if (!file) throw new Error(`Missing checkpointed output: ${target}. If moved, narrow the range with --first / --last.`);
      if (!file.isFile() || record.url !== url || checksum(target) !== record.output_sha256) {
        throw new Error(`Checkpoint conflict for ID ${id}: source URL or output file differs.`);
      }
      if (!records.has(id)) {
        assertCheckpoint(output, checkpoint);
        appendFileSync(checkpoint, JSON.stringify({ published: identity }) + '\n');
      }
    } else {
      if (file) throw new Error(`Uncheckpointed output already exists: ${target}`);
      pending.push({ id, url, target, path: join(work, `${id}${extension}`) });
    }
  }
  return pending;
}

function lockOutput(output) {
  if (process.platform !== 'darwin') throw new Error('The canvas renderer requires macOS.');
  // Darwin's O_EXLOCK is not exported by Node. The kernel releases it when the last holder exits.
  const O_EXLOCK = 0x20;
  try {
    return openSync(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | O_EXLOCK);
  } catch (error) {
    if (error.code === 'EAGAIN') throw new Error(`Another batch holds the output lock: ${output}`);
    throw error;
  }
}

function removeWorkspace(work, expectedOwner) {
  const dir = lstatSync(work, { throwIfNoEntry: false });
  if (!dir) return;
  const marker = join(work, 'owner');
  const owner = `canvas-url-work-v1:${dir.dev}:${dir.ino}`;
  if ((expectedOwner && expectedOwner !== owner) || !dir.isDirectory() || !lstatSync(marker, { throwIfNoEntry: false })?.isFile() ||
      readFileSync(marker, 'utf8') !== owner) {
    throw new Error(`Unrecognized work directory: ${work}`);
  }
  const processes = execFileSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (processes.includes(work + '/')) throw new Error(`A renderer may still be using ${work}. Retry after it exits.`);
  rmSync(work, { recursive: true });
}

async function main() {
  const config = options();
  if (!config) return;
  mkdirSync(config.output, { recursive: true });
  config.output = realpathSync(config.output);
  const { first, last, output } = config;
  const lock = lockOutput(output);
  const work = join(output, '.canvas-url-work');
  let workOwner;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('URL batch interrupted. Rerun the command to resume.'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  process.on('SIGHUP', cancel);
  let checkpoint, prefetched;
  try {
    removeWorkspace(work);
    const seed = mkdtempSync(join(output, '.canvas-url-init-'));
    try {
      const dir = lstatSync(seed);
      const owner = `canvas-url-work-v1:${dir.dev}:${dir.ino}`;
      writeFileSync(join(seed, 'owner'), owner, { flush: true });
      renameSync(seed, work);
      workOwner = owner;
    } finally { rmSync(seed, { recursive: true, force: true }); }
    checkpoint = openCheckpoint(output, work);
    const samples = pendingSamples(config, checkpoint, work);
    const total = last - first + 1;
    let done = total - samples.length;
    console.log(`${done}/${total} already verified. Checking the A Light reference.`);
    await render(['--verify'], join(work, 'verification'), controller.signal, lock);
    const prefetch = index => prepare(samples.slice(index, index + batchSize), controller.signal)
      .then(batch => ({ batch }), error => ({ error }));
    prefetched = prefetch(0);
    for (let index = 0; index < samples.length; index += batchSize) {
      const { batch, error } = await prefetched;
      if (error) throw error;
      prefetched = prefetch(index + batchSize);
      const manifest = join(work, 'manifest.json'), stage = join(work, 'renders');
      writeFileSync(manifest, JSON.stringify({ samples: batch.map(({ id, path }) => ({ id, path })) }));
      const remaining = new Map(batch.map(sample => [sample.id, sample]));
      await render(['--manifest', manifest], stage, controller.signal, lock, record => {
        const sample = remaining.get(Number(record.id));
        if (!sample || record.output !== join(stage, `${sample.id}.webp`) || checksum(record.output) !== record.output_sha256) {
          throw new Error(`Unexpected or invalid render for ID ${record.id}.`);
        }
        const staged = lstatSync(record.output);
        const identity = `${sample.id}:${staged.dev}:${staged.ino}`;
        assertCheckpoint(output, checkpoint);
        appendFileSync(checkpoint, JSON.stringify({ pending: identity, id: sample.id, url: sample.url,
          source_sha256: record.source_sha256, output_sha256: record.output_sha256 }) + '\n');
        fsyncSync(checkpoint);
        linkSync(record.output, sample.target);
        appendFileSync(checkpoint, JSON.stringify({ published: identity }) + '\n');
        rmSync(record.output); rmSync(sample.path);
        remaining.delete(sample.id);
        console.log(`${++done}/${total} verified: ${sample.target}`);
      });
      if (remaining.size) throw new Error(`Renderer did not finish IDs ${[...remaining.keys()].join(', ')}.`);
      rmSync(stage, { recursive: true });
    }
    if (pendingSamples(config, checkpoint, work).length) throw new Error('The requested output range is incomplete.');
    console.log(`Finished IDs ${first}–${last}: ${output}`);
  } finally {
    controller.abort();
    await prefetched;
    if (checkpoint !== undefined) closeSync(checkpoint);
    try { if (workOwner) removeWorkspace(work, workOwner); } finally { closeSync(lock); }
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    process.off('SIGHUP', cancel);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
