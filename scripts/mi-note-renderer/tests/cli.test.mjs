import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseOptions, validateRunPaths } from '../cli.mjs';
import { ROOT, TOOL_DIRECTORY } from '../run-state.mjs';

const execute = promisify(execFile);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-note-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  const cache = path.join(directory, 'cache');
  return { directory, output, cache, options: parseOptions(['--output', output, '--cache', cache]) };
}

function existingRun(output, cache, fingerprint = 'test-run') {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'run-config.json'), JSON.stringify({ output, cache, runFingerprint: fingerprint }));
  fs.writeFileSync(path.join(cache, 'checkpoint.json'), JSON.stringify({ runFingerprint: fingerprint }));
}

test('CLI defaults bind cache to the absolute output and honor the Python override', () => {
  const options = parseOptions(['--output', 'renderer-samples/example'], { cwd: ROOT, env: { MI_NOTE_RENDER_PYTHON: '/custom/python' } });
  assert.equal(options.output, path.join(ROOT, 'renderer-samples', 'example'));
  assert.match(options.cache, /\/\.cache\/mi-note-renderer\/[a-f0-9]{16}$/);
  assert.equal(options.python, '/custom/python');
  assert.equal(options.vitePort, 5174);
  assert.equal(options.baseUrl, 'http://localhost:5174');
  assert.equal(options.stopAfter, Infinity);
  assert.equal(options.stopAfterStartup, false);
  assert.equal(options.resume, false);
  assert.equal(options.publishOnly, false);
  assert.equal(parseOptions(['--output', options.output], { env: {} }).cache, options.cache);
  assert.equal(parseOptions(['--output', options.output, '--python', '/explicit/python']).python, '/explicit/python');
  assert.equal(parseOptions(['--output', options.output, '--python', './venv/bin/python'], { cwd: ROOT }).python, path.join(ROOT, 'venv/bin/python'));
  assert.equal(parseOptions(['--output', options.output], { cwd: ROOT, env: { MI_NOTE_RENDER_PYTHON: './venv/bin/python' } }).python, path.join(ROOT, 'venv/bin/python'));
  assert.equal(parseOptions(['--output', options.output, '--vite-port=5210', '--stop-after=20']).baseUrl, 'http://localhost:5210');
});

test('CLI rejects ambiguous, invalid, and incompatible flags', () => {
  assert.throws(() => parseOptions([]), /output is required/);
  for (const args of [
    ['--output'], ['--output', 'elsewhere'], ['--unknown'], ['--resume=false'],
    ['--stop-after', '0'], ['--stop-after', '1431'], ['--stop-after', '1.5'],
    ['--vite-port', '0'], ['--vite-port', '65536'], ['--python='],
    ['--publish-only', '--stop-after', '20'], ['--publish-only', '--stop-after-startup'],
    ['--stop-after', '20', '--stop-after-startup'],
  ]) assert.throws(() => parseOptions(['--output', '/tmp/example', ...args]), args.join(' '));
});

test('fresh runs reject occupied paths, existing archives, source aliases, and overlap', t => {
  const { directory, output, cache, options } = fixture(t);
  assert.equal(validateRunPaths(options).output, fs.realpathSync(directory) + '/output');
  assert.throws(() => validateRunPaths({ ...options, output: ROOT }), /contain the repository/);
  assert.throws(() => validateRunPaths({ ...options, output: path.join(ROOT, 'src', 'generated') }), /must be below/);
  assert.throws(() => validateRunPaths({ ...options, cache: output }), /overlap/);
  assert.throws(() => validateRunPaths({ ...options, cache: path.join(output, 'cache') }), /overlap/);
  assert.throws(() => validateRunPaths({ ...options, cache: `${output}.zip` }), /overlap/);
  const alias = path.join(directory, 'source-alias');
  fs.symlinkSync(path.join(ROOT, 'src'), alias);
  assert.throws(() => validateRunPaths({ ...options, output: path.join(alias, 'generated') }), /must be below/);
  for (const suffix of ['.zip', '.zip.partial', '.zip.json']) {
    fs.writeFileSync(`${output}${suffix}`, 'existing archive');
    assert.throws(() => validateRunPaths(options), /existing archive/);
    fs.unlinkSync(`${output}${suffix}`);
  }
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, '1.png'), 'existing output');
  assert.throws(() => validateRunPaths(options), /must be empty/);
  fs.unlinkSync(path.join(output, '1.png'));
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'evidence.json'), '{}');
  assert.throws(() => validateRunPaths(options), /must be empty/);
});

test('resume and publish-only require matching bound run configuration and checkpoint', t => {
  const { output, cache, options } = fixture(t);
  assert.throws(() => validateRunPaths({ ...options, resume: true }), /existing output and cache/);
  fs.mkdirSync(output);
  fs.mkdirSync(cache);
  assert.throws(() => validateRunPaths({ ...options, resume: true }), /requires run-config/);
  existingRun(output, cache);
  assert.equal(validateRunPaths({ ...options, resume: true }).cache, fs.realpathSync(cache));
  assert.equal(validateRunPaths({ ...options, publishOnly: true }).output, fs.realpathSync(output));
  fs.writeFileSync(path.join(cache, 'checkpoint.json'), JSON.stringify({ runFingerprint: 'another-run' }));
  assert.throws(() => validateRunPaths({ ...options, resume: true }), /fingerprint/);
  existingRun(output, cache);
  fs.writeFileSync(path.join(cache, 'run-config.json'), JSON.stringify({ output: cache, cache, runFingerprint: 'test-run' }));
  assert.throws(() => validateRunPaths({ ...options, publishOnly: true }), /output does not match/);
});

test('help does not require output, Python, or capture startup', async () => {
  const result = await execute(process.execPath, [path.join(TOOL_DIRECTORY, 'cli.mjs'), '--help'], {
    env: { ...process.env, MI_NOTE_RENDER_PYTHON: '/missing/python' },
  });
  assert.match(result.stdout, /--publish-only/);
  assert.match(result.stdout, /--stop-after-startup/);
});

test('publish-only invokes just the Python version check and publisher', async t => {
  const { directory, output, cache } = fixture(t);
  existingRun(output, cache);
  const audit = path.join(directory, 'python-calls.jsonl');
  const python = path.join(directory, 'fake-python');
  fs.writeFileSync(python, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MI_NOTE_CLI_TEST_AUDIT, JSON.stringify(args) + '\\n');
if (args[0] === '-c') {
  console.log(JSON.stringify({ python: '3.12.0', pillow: '12.3.0', numpy: '2.3.5' }));
} else if (!args[0].endsWith('/publish_collection.py')) {
  throw new Error('Unexpected Python task: ' + args[0]);
} else {
  const cache = args[args.indexOf('--cache') + 1];
  const lock = JSON.parse(fs.readFileSync(cache + '/.run.lock', 'utf8'));
  if (lock.pid !== process.ppid) throw new Error('Publisher does not hold the run lock');
  if (process.env.MI_NOTE_CLI_TEST_FAIL_PUBLISH) process.exit(1);
}
`, { mode: 0o755 });
  await execute(process.execPath, [path.join(TOOL_DIRECTORY, 'cli.mjs'), '--output', output,
    '--cache', cache, '--python', python, '--publish-only'], {
    env: { ...process.env, MI_NOTE_CLI_TEST_AUDIT: audit },
  });
  const calls = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '-c');
  assert.deepEqual(calls[1], [path.join(TOOL_DIRECTORY, 'publish_collection.py'),
    '--output', fs.realpathSync(output), '--cache', fs.realpathSync(cache)]);
  assert.deepEqual(fs.readdirSync(output), []);
  assert.deepEqual(fs.readdirSync(cache).sort(), ['checkpoint.json', 'run-config.json']);
  await assert.rejects(execute(process.execPath, [path.join(TOOL_DIRECTORY, 'cli.mjs'), '--output', output,
    '--cache', cache, '--python', python, '--publish-only'], {
    env: { ...process.env, MI_NOTE_CLI_TEST_AUDIT: audit, MI_NOTE_CLI_TEST_FAIL_PUBLISH: '1' },
  }), /publish_collection.py failed/);
  assert.deepEqual(fs.readdirSync(cache).sort(), ['checkpoint.json', 'run-config.json']);
});
