import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { environmentMatches, nativeEnvironment, runtimeVersions, verifyRuntimeInventory } from '../native-runtime.mjs';

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-runtime-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/tool'), 'preserved executable');
  symlinkSync('tool', join(root, 'bin/link'));
  const contract = { node: '24.22.0' };
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ version: 1, contract,
    files: { 'bin/tool': { sha256: digest(join(root, 'bin/tool')) }, 'bin/link': { symlink: 'tool' } } }));
  return { root, options: { contract, receiptHash: digest(join(root, 'runtime.json')) } };
}

test('runtime versions invoke only explicit pinned executables', () => {
  const paths = { node: '/pinned/node', python: '/pinned/python', ffmpeg: '/pinned/ffmpeg', ffprobe: '/pinned/ffprobe' };
  const calls = [];
  const versions = runtimeVersions(paths, (command, args) => {
    calls.push({ command, args });
    if (command === paths.node) return 'v24.22.0';
    if (command === paths.python) return JSON.stringify({ python: '3.12.14', pillow: '12.3.0', numpy: '2.3.5', littlecms: '2.19' });
    if (command === paths.ffmpeg) return 'ffmpeg version 8.1.2 fixture';
    if (command === paths.ffprobe) return 'ffprobe version 8.1.2 fixture';
    throw new Error('Unexpected executable: ' + command);
  });
  assert.deepEqual(calls.map(call => call.command), Object.values(paths));
  assert.equal(calls[1].args[0], '-B');
  assert.equal(versions.ffmpeg, 'ffmpeg version 8.1.2 fixture');
  assert.equal(Object.hasOwn(versions, 'safariDriver'), false);
});

test('native child environment excludes alternate Python, Node, and dynamic libraries', () => {
  const paths = { node: '/pinned/node/bin/node', python: '/pinned/python/bin/python', ffmpeg: '/pinned/media/bin/ffmpeg', ffprobe: '/pinned/media/bin/ffprobe' };
  const input = { HOME: '/home/user', PATH: '/other/bin', PYTHONPATH: '/other/python', PYTHONHOME: '/other/home',
    PYTHONUSERBASE: '/other/user', PYTHONSTARTUP: '/other/startup', NODE_OPTIONS: '--require=/other/preload', NODE_PATH: '/other/modules',
    DYLD_LIBRARY_PATH: '/other/libs', DYLD_INSERT_LIBRARIES: '/other/injected', MI_NOTE_FFMPEG: '/other/ffmpeg' };
  const env = nativeEnvironment(paths, input);
  for (const name of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'NODE_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']) assert.equal(Object.hasOwn(env, name), false);
  assert.equal(env.HOME, input.HOME);
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.MI_NOTE_FFMPEG, paths.ffmpeg);
  assert.equal(env.MI_NOTE_FFPROBE, paths.ffprobe);
  assert.equal(env.PATH, '/pinned/node/bin:/pinned/python/bin:/pinned/media/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(environmentMatches(input, env), false);
  assert.equal(environmentMatches(env, nativeEnvironment(paths, env)), true);
});

test('runtime receipt ignores only untracked Finder files and Python cache exclusions', context => {
  const { root, options } = fixture(context);
  mkdirSync(join(root, '__pycache__'));
  writeFileSync(join(root, '__pycache__/generated.pyc'), 'cache');
  writeFileSync(join(root, 'bin/generated.pyc'), 'cache');
  writeFileSync(join(root, 'bin/.DS_Store'), 'finder');
  const result = verifyRuntimeInventory(root, options);
  assert.equal(result.verifiedEntries, 2);
  assert.deepEqual(result.ignoredFinderFiles, ['bin/.DS_Store']);
  writeFileSync(join(root, 'bin/unexpected'), 'not allowed');
  assert.throws(() => verifyRuntimeInventory(root, options), /files differ/);
});

test('runtime verification rejects changed and missing preserved files', context => {
  const { root, options } = fixture(context);
  writeFileSync(join(root, 'bin/tool'), 'changed executable');
  assert.throws(() => verifyRuntimeInventory(root, options), /files differ/);
  rmSync(join(root, 'bin/link'));
  rmSync(join(root, 'bin/tool'));
  assert.throws(() => verifyRuntimeInventory(root, options), /files differ/);
});

test('runtime receipt and symlink escape cannot be silently substituted', context => {
  const { root, options } = fixture(context);
  rmSync(join(root, 'bin/link'));
  symlinkSync('/etc/hosts', join(root, 'bin/link'));
  assert.throws(() => verifyRuntimeInventory(root, options), /link escapes/);
  writeFileSync(join(root, 'runtime.json'), '{}');
  assert.throws(() => verifyRuntimeInventory(root, options), /receipt changed/);
});
