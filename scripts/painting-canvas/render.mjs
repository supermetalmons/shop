import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { finished } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const supportedExtensions = new Set(['.webp', '.png', '.jpg', '.jpeg']);
const help = `Render artwork with the approved A Light canvas setup, entirely headlessly.

Usage:
  node scripts/painting-canvas/render.mjs --ids 1,3,7 --output output/canvas
  node scripts/painting-canvas/render.mjs --input /path/to/artwork.webp
  node scripts/painting-canvas/render.mjs --input /path/to/images --output output/canvas
  node scripts/painting-canvas/render.mjs --manifest /path/to/samples.json
  node scripts/painting-canvas/render.mjs --verify

Choose exactly one input mode: --ids, --input, --manifest, or --verify.
  --ids         Comma-separated 111k painting asset IDs, from 1 through 85556.
  --input       Local image or directory; may be repeated. Directories are not recursive.
  --manifest    JSON {"samples":[{"id":"name","path":"image.webp"}]}.
                Relative image paths resolve against the manifest directory.
  --verify      Reproduce and compare the approved reference image.
  --output      Destination directory; defaults to this repository's output/canvas.
  --overwrite   Replace existing outputs in the destination.
  --blender     Blender executable; defaults to BLENDER_BIN or the installed Mac app.
  --help        Show this help.

The look and rendering quality are fixed to the approved preset.
Default verification replaces its results in .cache/painting-canvas/verification.
Custom verification destinations require --overwrite to replace existing files.
`;

function checkedId(id) {
  if (!['number', 'string'].includes(typeof id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(id))) {
    throw new Error(`Invalid artwork ID: ${String(id)}`);
  }
  return id;
}

function localSample(id, path, dimensions = {}) {
  checkedId(id);
  if (!statSync(path).isFile()) throw new Error(`Not an image file: ${path}`);
  if (!supportedExtensions.has(extname(path).toLowerCase())) throw new Error(`Unsupported image type: ${path}`);
  for (const key of ['width', 'height']) {
    if (dimensions[key] !== undefined && (!Number.isSafeInteger(dimensions[key]) || dimensions[key] <= 0)) {
      throw new Error(`Invalid ${key} for artwork ${id}`);
    }
  }
  return { id, path, ...dimensions };
}

function fileId(path) {
  return basename(path, extname(path)).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128) || 'artwork';
}

function hasWebpHeader(data) {
  return data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
}

function writeReport(path, report) {
  const pending = `${path}.pending-${process.pid}`;
  writeFileSync(pending, JSON.stringify(report, null, 2) + '\n');
  renameSync(pending, path);
}

export async function prepareCatalogSources(samples) {
  mkdirSync(dirname(samples[0].path), { recursive: true });
  const controller = new AbortController();
  let next = 0;
  await Promise.allSettled(Array.from({ length: Math.min(4, samples.length) }, async () => {
    while (!controller.signal.aborted && next < samples.length) {
      const sample = samples[next++];
      try {
        if (existsSync(sample.path) && hasWebpHeader(readFileSync(sample.path))) continue;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
        const response = await fetch(sample.source_url, { signal });
        if (!response.ok) throw new Error(`Artwork ${sample.id} download failed: HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        controller.signal.throwIfAborted();
        if (!hasWebpHeader(data)) throw new Error(`Artwork ${sample.id} did not return a WebP image`);
        const pending = `${sample.path}.pending-${process.pid}`;
        try {
          writeFileSync(pending, data);
          renameSync(pending, sample.path);
        } finally {
          rmSync(pending, { force: true });
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
  }));
  controller.signal.throwIfAborted();
}

async function main() {
  const { values } = parseArgs({ options: {
    ids: { type: 'string' }, input: { type: 'string', multiple: true }, manifest: { type: 'string' },
    verify: { type: 'boolean', default: false }, output: { type: 'string' }, overwrite: { type: 'boolean', default: false },
    blender: { type: 'string' }, help: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(help); return; }
  const modeCount = Number(values.ids !== undefined) + Number(values.input !== undefined)
    + Number(values.manifest !== undefined) + Number(values.verify);
  if (modeCount !== 1) throw new Error('Choose exactly one of --ids, --input, --manifest, or --verify. Use --help for examples.');
  const output = resolve(values.output ?? join(root, values.verify ? '.cache/painting-canvas/verification' : 'output/canvas'));
  const overwrite = values.overwrite || (values.verify && values.output === undefined);
  const requestedBlender = values.blender ?? process.env.BLENDER_BIN ?? '/Applications/Blender.app/Contents/MacOS/Blender';
  const blender = requestedBlender.includes('/') ? resolve(requestedBlender) : requestedBlender;
  const samples = [];
  if (values.ids !== undefined) {
    for (const value of values.ids.split(',')) {
      if (!/^\d+$/.test(value.trim())) throw new Error(`Invalid painting ID: ${value}`);
      const id = Number(value.trim());
      if (!Number.isSafeInteger(id) || id < 1 || id > 85556) throw new Error(`Painting ID ${id} is outside 1–85556`);
      samples.push({ id, path: join(root, '.cache/painting-canvas/sources', `${id}.webp`),
        source_url: `https://wip.lil.org/111k/paintings/${id}.webp` });
    }
  } else if (values.input) {
    for (const input of values.input) {
      const path = resolve(input);
      const files = statSync(path).isDirectory()
        ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase()))
          .map(entry => join(path, entry.name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        : [path];
      for (const file of files) samples.push(localSample(fileId(file), file));
    }
  } else if (values.manifest) {
    const path = resolve(values.manifest);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(manifest.samples)) throw new Error('Manifest must contain a samples array');
    for (const sample of manifest.samples) {
      if (!sample || typeof sample.path !== 'string' || !sample.path) throw new Error('Each sample needs an id and image path');
      const dimensions = Object.fromEntries(['width', 'height'].filter(key => sample[key] !== undefined).map(key => [key, sample[key]]));
      samples.push(localSample(sample.id, resolve(dirname(path), sample.path), dimensions));
    }
  }
  if (!values.verify && !samples.length) throw new Error('No images found to render');
  const ids = values.verify
    ? [String(checkedId(JSON.parse(readFileSync(join(root, 'scripts/painting-canvas/reference/record.json'), 'utf8')).id))]
    : samples.map(sample => String(sample.id));
  if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw new Error('Duplicate artwork IDs would overwrite each other; use filenames or manifest IDs that differ beyond letter case');
  if (!overwrite) {
    for (const name of [...ids.map(id => `${id}.png`), 'render-report.json', 'render.log']) {
      if (existsSync(join(output, name))) throw new Error(`Output already exists: ${join(output, name)}. Choose another --output or use --overwrite.`);
    }
  }
  const logPath = join(output, 'render.log');
  const existingLog = lstatSync(logPath, { throwIfNoEntry: false });
  if (existingLog && (existingLog.isSymbolicLink() || existingLog.nlink > 1)) {
    throw new Error(`Refusing to write a linked render log: ${logPath}`);
  }
  if (values.ids !== undefined) await prepareCatalogSources(samples);
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(output, '.canvas-work-'));
  const manifestPath = join(temporary, 'samples.json');
  const cancelPath = join(temporary, 'cancel');
  writeFileSync(manifestPath, JSON.stringify({ samples }, null, 2) + '\n');
  const childArgs = ['-b', '--factory-startup', '--python-exit-code', '1', '--python',
    join(root, 'scripts/painting-canvas/render.py'), '--',
    ...(values.verify ? ['--verify'] : ['--manifest', manifestPath]), '--output', output,
    '--cancel-file', cancelPath, '--work-dir', temporary,
    ...(overwrite ? ['--overwrite'] : [])];
  const log = createWriteStream(logPath, { flags: overwrite ? 'w' : 'wx' });
  const started = performance.now();
  const completedRecords = [];
  let startupSeconds, pending = '', child, cancelled;
  const onSignal = signal => {
    if (!cancelled) {
      cancelled = signal;
      try { writeFileSync(cancelPath, signal); }
      catch (error) {
        console.error(`Cannot write cancellation marker: ${error.message}`);
        child?.kill('SIGTERM');
        return;
      }
    }
    child?.kill(signal);
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    child = spawn(blender, childArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const completed = new Promise((accept, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => accept({ code, signal }));
      log.on('error', error => { child.kill('SIGTERM'); reject(error); });
    });
    child.stdout.on('data', data => {
      log.write(data);
      pending += data.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line === 'CANVAS_READY') startupSeconds = (performance.now() - started) / 1000;
        if (line.startsWith('CANVAS_RESULT ')) {
          try { completedRecords.push(JSON.parse(line.slice('CANVAS_RESULT '.length))); }
          catch {}
          console.log(line);
        }
      }
    });
    child.stderr.on('data', data => log.write(data));
    const { code, signal } = await completed;
    const wallSeconds = (performance.now() - started) / 1000;
    const reportPath = join(output, 'render-report.json');
    if (cancelled) {
      let report = {};
      try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
      catch {}
      Object.assign(report, { status: 'cancelled', error: `Cancelled by ${cancelled}`,
        records: completedRecords, startup_seconds: startupSeconds, process_wall_seconds: wallSeconds });
      delete report.verification;
      writeReport(reportPath, report);
      process.exitCode = cancelled === 'SIGINT' ? 130 : 143;
      console.error(`Canvas rendering cancelled (${cancelled}).`);
      return;
    }
    if (code !== 0) throw new Error(`Blender failed (${signal ?? code}); inspect ${logPath}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.startup_seconds = startupSeconds;
    report.process_wall_seconds = wallSeconds;
    writeReport(reportPath, report);
    console.log(`Finished ${values.verify ? 'reference verification' : `${samples.length} canvas render${samples.length === 1 ? '' : 's'}`}: ${output}`);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    log.end();
    await finished(log).catch(() => {});
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
