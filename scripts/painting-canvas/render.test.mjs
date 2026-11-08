import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCatalogSources } from './render.mjs';

const script = fileURLToPath(new URL('./render.mjs', import.meta.url));
const artwork = fileURLToPath(new URL('./reference/artwork.webp', import.meta.url));
const approved = fileURLToPath(new URL('./reference/approved.png', import.meta.url));

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'started.json');
  const blender = join(directory, 'blender.cjs');
  writeFileSync(blender, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), output = args[args.indexOf('--output') + 1];
const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : args.includes('--verify') ? 'png' : 'webp';
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args));
fs.writeFileSync(path.join(output, '1.' + format), 'replacement');
fs.writeFileSync(path.join(output, 'render-report.json'), JSON.stringify({status:'complete',records:[]}));
console.log('CANVAS_READY');
`, { mode: 0o755 });
  return { directory, marker, blender };
}

function run(blender, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args, '--blender', blender], { encoding: 'utf8', ...options });
}

test('relative Blender overrides resolve from the caller directory', t => {
  const { directory, marker } = workspace(t);
  const output = join(directory, 'rendered');
  const result = run('./blender.cjs', ['--verify', '--output', output], { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(args[args.indexOf('--output') + 1], output);
});

for (const [format, signal, expectedCode] of [
  ['png', 'SIGINT', 130], ['png', 'SIGTERM', 143], ['webp', 'SIGINT', 130], ['webp', 'SIGTERM', 143],
]) {
  test(`${format}: ${signal} cancels the batch and preserves only completed records`, { timeout: 10000 }, async t => {
    const { directory, marker, blender } = workspace(t);
    const output = join(directory, 'rendered');
    const observed = join(directory, 'cancel-observed.json');
    writeFileSync(blender, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
const output = value('--output'), work = value('--work-dir'), cancel = value('--cancel-file');
const record = {id:'first',output:path.join(output,'first.${format}')};
fs.writeFileSync(record.output,'completed image');
fs.writeFileSync(path.join(work,'normalized.png'),'temporary pixels');
fs.writeFileSync(path.join(output,'render-report.json'),JSON.stringify({status:'rendering',records:[]}));
console.log('CANVAS_READY');
console.log('CANVAS_RESULT '+JSON.stringify(record));
if (${JSON.stringify(signal)} === 'SIGINT') process.on('SIGINT',()=>{
  fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({marker:fs.readFileSync(cancel,'utf8'),work}));
  fs.writeFileSync(path.join(output,'render-report.json'),JSON.stringify({status:'complete',records:[],verification:{passed:true}}));
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(marker)},'ready');
setInterval(()=>{},1000);
`, { mode: 0o755 });
    const child = spawn(process.execPath, [script, '--input', artwork, '--format', format,
      '--output', output, '--blender', blender],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    const completion = new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept); });
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'Mock Blender did not become ready');
    child.kill(signal);
    const code = await completion;
    assert.equal(code, expectedCode, stderr);
    assert.doesNotMatch(stdout, /Finished/);
    assert.match(stderr, /cancelled/);
    const report = JSON.parse(readFileSync(join(output, 'render-report.json'), 'utf8'));
    assert.equal(report.status, 'cancelled');
    assert.equal(report.verification, undefined);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].id, 'first');
    assert.equal(readFileSync(join(output, `first.${format}`), 'utf8'), 'completed image');
    assert.equal(readdirSync(output).some(name => name.startsWith('.canvas-work-')), false);
    if (signal === 'SIGINT') assert.equal(JSON.parse(readFileSync(observed, 'utf8')).marker, signal);
  });
}

test('export options reach headless Blender', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'rendered');
  const options = ['--format', 'webp', '--transparent', '--quality', '85', '--max-side', '1400'];
  const result = run(blender, ['--input', artwork, '--output', output, ...options]);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ok(args.includes('-b'));
  assert.ok(args.includes('--transparent'));
  for (const [key, value] of [['--format', 'webp'], ['--quality', '85'], ['--max-side', '1400']]) {
    assert.equal(args[args.indexOf(key) + 1], value);
  }
  assert.ok(existsSync(join(output, '1.webp')));
});

test('invalid export options fail before output creation or Blender startup', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'rendered');
  for (const options of [
    ['--format', 'jpeg'], ['--format', 'png', '--quality', '85'], ['--format', 'webp', '--quality', '-1'],
    ['--format', 'webp', '--quality', '101'], ['--format', 'webp', '--quality', '85.5'],
    ['--max-side', '0'], ['--max-side', '-2'], ['--max-side', '1.2'],
    ['--max-side', '1e3'], ['--max-side', '9007199254740992'],
  ]) {
    const result = run(blender, ['--input', artwork, '--output', output, ...options]);
    assert.equal(result.status, 1, options.join(' '));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(output), false);
  }
});

test('painting IDs outside the current CDN catalog fail before downloading', t => {
  const { directory, marker, blender } = workspace(t);
  const preload = join(directory, 'no-download.mjs');
  writeFileSync(preload, "globalThis.fetch = () => { throw new Error('Unexpected download'); };\n");
  for (const id of ['0', '30991', '85556']) {
    const output = join(directory, id);
    const result = spawnSync(process.execPath, ['--import', preload, script, '--ids', id,
      '--output', output, '--blender', blender], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside 1–30990/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(output), false);
  }
});

test('each export option is rejected with verification, including default-valued options', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'rendered');
  for (const options of [['--format', 'png'], ['--transparent'], ['--quality', '85'], ['--max-side', '1400']]) {
    const result = run(blender, ['--verify', '--output', output, ...options]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be combined with --verify/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(output), false);
  }
});

test('default WebP output requires explicit overwrite and preserves the PNG', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'existing');
  const source = join(directory, '1.png');
  copyFileSync(approved, source);
  mkdirSync(output);
  writeFileSync(join(output, '1.webp'), 'previous WebP');
  writeFileSync(join(output, '1.png'), 'previous PNG');
  const options = ['--input', source, '--output', output];
  const denied = run(blender, options);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Output already exists:.*1\.webp/);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(output, '1.webp'), 'utf8'), 'previous WebP');
  const replaced = run(blender, [...options, '--overwrite']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(readFileSync(join(output, '1.webp'), 'utf8'), 'replacement');
  assert.equal(readFileSync(join(output, '1.png'), 'utf8'), 'previous PNG');
});

test('explicit PNG output requires overwrite when a high-resolution PNG exists', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'existing');
  const source = join(directory, '1.png');
  copyFileSync(approved, source);
  mkdirSync(output);
  writeFileSync(join(output, '1.png'), 'previous PNG');
  const options = ['--input', source, '--format', 'png', '--output', output];
  const denied = run(blender, options);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Output already exists:.*1\.png/);
  assert.equal(existsSync(marker), false);
  const replaced = run(blender, [...options, '--overwrite']);
  assert.equal(replaced.status, 0, replaced.stderr);
  const args = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(args[args.indexOf('--format') + 1], 'png');
  assert.equal(args.includes('--max-side'), false);
  assert.equal(args.includes('--transparent'), false);
  assert.equal(readFileSync(join(output, '1.png'), 'utf8'), 'replacement');
});

test('custom verification output preserves existing artwork without --overwrite', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'existing');
  mkdirSync(output);
  writeFileSync(join(output, '1.png'), 'keep this artwork');
  const result = run(blender, ['--verify', '--output', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Output already exists:.*1\.png/);
  assert.equal(readFileSync(join(output, '1.png'), 'utf8'), 'keep this artwork');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(output), ['1.png']);
});

test('custom verification replacement requires explicit --overwrite', t => {
  const { directory, marker, blender } = workspace(t);
  const output = join(directory, 'existing');
  mkdirSync(output);
  writeFileSync(join(output, '1.png'), 'old render');
  const result = run(blender, ['--verify', '--output', output, '--overwrite']);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ok(args.includes('--overwrite'));
  assert.ok(args.includes('-b'));
  assert.equal(readFileSync(join(output, '1.png'), 'utf8'), 'replacement');
});

test('case-only output IDs are rejected before Blender or output creation', t => {
  const { directory, marker, blender } = workspace(t);
  mkdirSync(join(directory, 'one'));
  mkdirSync(join(directory, 'two'));
  const first = join(directory, 'one', 'Art.png');
  const second = join(directory, 'two', 'art.png');
  copyFileSync(approved, first);
  copyFileSync(approved, second);
  const output = join(directory, 'rendered');
  const result = run(blender, ['--input', first, '--input', second, '--output', output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate artwork IDs/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(output), false);
});

for (const [name, link] of [['symbolic', symlinkSync], ['hard', linkSync]]) {
  test(`an existing ${name}-linked render log cannot overwrite source data`, t => {
    const { directory, marker, blender } = workspace(t);
    const source = join(directory, 'source.png');
    const output = join(directory, 'rendered');
    copyFileSync(approved, source);
    mkdirSync(output);
    link(source, join(output, 'render.log'));
    const before = readFileSync(source);
    const result = run(blender, ['--input', source, '--output', output, '--overwrite']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to write a linked render log/);
    assert.deepEqual(readFileSync(source), before);
    assert.equal(existsSync(marker), false);
  });
}

test('a download failure aborts in-flight requests and does not schedule the rest', async t => {
  const { directory } = workspace(t);
  const samples = Array.from({ length: 12 }, (_, index) => ({ id: index + 1,
    path: join(directory, 'sources', `${index + 1}.webp`), source_url: `https://example.test/${index + 1}` }));
  const requested = [], aborted = [];
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    const id = Number(new URL(url).pathname.slice(1));
    requested.push(id);
    if (id === 1) return Promise.resolve(new Response('', { status: 503 }));
    return new Promise((resolve, reject) => {
      const abort = () => { aborted.push(id); reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  });
  await assert.rejects(prepareCatalogSources(samples), /Artwork 1 download failed: HTTP 503/);
  assert.deepEqual(requested, [1, 2, 3, 4]);
  assert.deepEqual(aborted.sort(), [2, 3, 4]);
  assert.deepEqual(readdirSync(join(directory, 'sources')), []);
});

test('PNG and WebP downloads are cached without pending files', async t => {
  const { directory } = workspace(t);
  const data = [readFileSync(artwork), readFileSync(approved)];
  const samples = ['webp', 'png'].map((extension, index) => ({ id: index + 1,
    path: join(directory, 'sources', `${index + 1}.${extension}`), source_url: `https://example.test/${index + 1}` }));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    requests++;
    return new Response(data[Number(new URL(url).pathname.slice(1)) - 1]);
  });
  await prepareCatalogSources(samples);
  await prepareCatalogSources(samples);
  assert.equal(requests, 2);
  assert.deepEqual(readdirSync(join(directory, 'sources')).sort(), ['1.webp', '2.png']);
  for (const [index, sample] of samples.entries()) assert.deepEqual(readFileSync(sample.path), data[index]);
});

test('invalid image signatures are never published and a bad cache is refreshed', async t => {
  const { directory } = workspace(t);
  const png = readFileSync(approved);
  const badDimensions = Buffer.from(png);
  badDimensions.writeUInt32BE(0, 16);
  const sample = { id: 1, path: join(directory, 'source.png'), source_url: 'https://example.test/1.png' };
  let upstream;
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(upstream));
  for (const invalid of [Buffer.from('<html>not an image</html>'), png.subarray(0, 20), badDimensions]) {
    upstream = invalid;
    await assert.rejects(prepareCatalogSources([sample]), /did not return a PNG or WebP image/);
    assert.equal(existsSync(sample.path), false);
    assert.equal(readdirSync(directory).some(name => name.includes('.pending-')), false);
  }
  writeFileSync(sample.path, '<html>stale error response</html>');
  upstream = png;
  await prepareCatalogSources([sample]);
  assert.deepEqual(readFileSync(sample.path), png);
  assert.equal(fetch.mock.callCount(), 4);
});

test('numbered paintings download CDN PNGs without reusing the WIP cache', t => {
  const { directory, marker, blender } = workspace(t);
  const runnerDirectory = join(directory, 'scripts', 'painting-canvas');
  mkdirSync(runnerDirectory, { recursive: true });
  const runner = join(runnerDirectory, 'render.mjs');
  copyFileSync(script, runner);
  const sources = join(directory, '.cache', 'painting-canvas', 'sources');
  mkdirSync(sources, { recursive: true });
  copyFileSync(artwork, join(sources, '30990.webp'));
  const requests = join(directory, 'requests.txt');
  const preload = join(directory, 'fetch.mjs');
  writeFileSync(preload, `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
globalThis.fetch = async url => {
  assert.equal(url, 'https://cdn.lil.org/nft/111k/paintings/30990.png');
  appendFileSync(${JSON.stringify(requests)}, url + '\\n');
  return new Response(readFileSync(${JSON.stringify(approved)}));
};
`);
  writeFileSync(blender, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync(value('--manifest')));
fs.writeFileSync(path.join(value('--output'), 'render-report.json'), JSON.stringify({status:'complete',records:[]}));
console.log('CANVAS_READY');
`, { mode: 0o755 });
  for (const output of ['first', 'second']) {
    const result = spawnSync(process.execPath, ['--import', preload, runner, '--ids', '30990',
      '--output', join(directory, output), '--blender', blender], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const sample = JSON.parse(readFileSync(marker, 'utf8')).samples[0];
  assert.equal(sample.path, realpathSync(join(sources, 'cdn-lil-111k', '30990.png')));
  assert.equal(sample.source_url, 'https://cdn.lil.org/nft/111k/paintings/30990.png');
  assert.deepEqual(readFileSync(sample.path), readFileSync(approved));
  assert.deepEqual(readFileSync(join(sources, '30990.webp')), readFileSync(artwork));
  assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1);
});
