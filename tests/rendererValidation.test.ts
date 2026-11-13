import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runRendererChecks } from '../scripts/test-renderers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const directories = ['scripts/painting-canvas', 'scripts/egg-render', 'scripts/video-frames'];

function rendererTestFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? rendererTestFiles(path)
      : /\.test\.(mjs|py|swift)$|^test_.*\.py$/.test(entry.name) ? [path] : [];
  });
}

test('renderer tiers execute every suite once and keep native tools outside portable validation', async () => {
  const commands: Record<string, Array<{ command: string; args: string[] }>> = { portable: [], native: [] };
  for (const tier of ['portable', 'native']) {
    await runRendererChecks(tier, { root, platform: 'darwin', env: {}, run: (command, args) => {
      commands[tier].push({ command, args });
    } });
  }
  const files = directories.flatMap(rendererTestFiles).sort();
  const invoked = Object.values(commands).flat().flatMap(call => call.args.filter(arg => files.includes(arg))).sort();
  assert.deepEqual(invoked, files);
  assert.ok(commands.portable.every(call => call.command === process.execPath || call.command === 'python3'));
  assert.ok(commands.portable.filter(call => call.command === 'python3').every(call => call.args[1] === 'scripts/shared/runPythonTests.py'));
  assert.equal(commands.native.filter(call => call.args.includes('test:mi-note-videos')).length, 1);
  for (const command of ['render:video-frames', 'render:canvases']) {
    assert.ok(commands.native.some(call => call.args.includes(command) && call.args.includes('--verify')));
  }
  const egg = commands.native.find(call => call.args.includes('scripts/egg-render/batch.test.py'))!;
  assert.ok(egg.args.includes('-b'));
  assert.ok(egg.args.includes('--python-exit-code'));
});

test('unregistered renderer suites fail coverage instead of silently escaping validation', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'renderer-validation-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const file of directories.flatMap(rendererTestFiles)) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    writeFileSync(join(fixture, file), '');
  }
  writeFileSync(join(fixture, 'scripts/painting-canvas/new.test.mjs'), '');
  await assert.rejects(runRendererChecks('portable', { root: fixture, run: () => assert.fail('must not run') }), /unregistered.*new\.test\.mjs/);
});

test('native prerequisite failures are explicit and canvas reproduction scratch is removed after failure', async () => {
  await assert.rejects(runRendererChecks('native', { root, platform: 'linux', run: () => assert.fail('must not run') }), /require macOS/);
  let scratch = '';
  await assert.rejects(runRendererChecks('native', { root, platform: 'darwin', env: {}, run: (_command, args) => {
    if (args.includes('render:canvases')) {
      scratch = args[args.indexOf('--output') + 1];
      writeFileSync(join(scratch, 'interrupted.png'), 'partial render');
      throw new Error('reproduction failed');
    }
  } }), /reproduction failed/);
  assert.ok(scratch);
  assert.equal(existsSync(scratch), false);
});

test('Python suite runner rejects empty, skipped and failing suites', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'renderer-python-tests-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const [name, source, expected] of [
    ['empty', '', /No Python tests/],
    ['skipped', "import unittest\n@unittest.skip('unavailable')\nclass Check(unittest.TestCase):\n def test_case(self): pass\n", /does not permit skipped tests/],
    ['failed', 'import unittest\nclass Check(unittest.TestCase):\n def test_case(self): self.fail("broken")\n', /broken/],
  ] as const) {
    const path = join(fixture, `${name}.py`);
    writeFileSync(path, source);
    const result = spawnSync(process.env.PYTHON || 'python3', ['-B', 'scripts/shared/runPythonTests.py', path], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
  }
});
