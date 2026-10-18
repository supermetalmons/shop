import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultOutputDirectory, nativeRunPaths, prepareNativeOutput as prepareOutput, pruneNativeIntermediates } from '../native-output.mjs';

const initialManifest = options => ({ version: 2, pid: process.pid, ids: options.cardIds, output: options.output, cards: {} });
const prepareNativeOutput = (options, paths, fileSystem) => prepareOutput(options, paths, initialManifest(options), fileSystem);

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-output-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, output: join(root, 'videos'), stateRoot: join(root, 'private', 'runs') };
}

test('native output defaults to one Movies directory and state binds output plus ordered selection', context => {
  const { root, output, stateRoot } = fixture(context);
  assert.equal(defaultOutputDirectory(), join(homedir(), 'Movies', 'Mi Note Native Renders'));
  const paths = nativeRunPaths({ output, cardIds: [17, 18] }, stateRoot);
  assert.deepEqual(nativeRunPaths({ output, cardIds: [17, 18] }, stateRoot), paths);
  assert.match(paths.stateDirectory.slice(stateRoot.length + 1), /^[a-f0-9]{64}$/);
  assert.equal(paths.manifestPath, join(paths.stateDirectory, 'native-run.json'));
  assert.notEqual(nativeRunPaths({ output, cardIds: [18, 17] }, stateRoot).stateDirectory, paths.stateDirectory);
  assert.notEqual(nativeRunPaths({ output: join(root, 'other-videos'), cardIds: [17, 18] }, stateRoot).stateDirectory, paths.stateDirectory);
  assert.equal(paths.stateDirectory.startsWith(output), false);
});

test('successive selections share the video directory while their run state stays separate', context => {
  const { output, stateRoot } = fixture(context);
  const first = { output, cardIds: [17], resume: false };
  const firstPaths = nativeRunPaths(first, stateRoot);
  prepareNativeOutput(first, firstPaths);
  writeFileSync(join(output, '17.mp4'), 'first verified video');
  writeFileSync(firstPaths.manifestPath, 'first receipt');
  const next = { output, cardIds: [18], resume: false };
  const nextPaths = nativeRunPaths(next, stateRoot);
  prepareNativeOutput(next, nextPaths);
  writeFileSync(join(output, '18.mp4'), 'second verified video');
  assert.notEqual(nextPaths.stateDirectory, firstPaths.stateDirectory);
  assert.equal(readFileSync(join(output, '17.mp4'), 'utf8'), 'first verified video');
  assert.equal(readFileSync(firstPaths.manifestPath, 'utf8'), 'first receipt');
  assert.equal(existsSync(join(output, 'native-run.json')), false);
  prepareNativeOutput({ ...first, resume: true }, firstPaths);
  assert.equal(readFileSync(firstPaths.manifestPath, 'utf8'), 'first receipt');
});

test('existing selected videos are rejected before any run state is created', context => {
  const { output, stateRoot } = fixture(context);
  mkdirSync(output);
  writeFileSync(join(output, '18.mp4'), 'keep this video');
  const options = { output, cardIds: [17, 18], resume: false };
  assert.throws(() => prepareNativeOutput(options, nativeRunPaths(options, stateRoot)), /will not be overwritten/);
  assert.equal(existsSync(stateRoot), false);
  assert.equal(readFileSync(join(output, '18.mp4'), 'utf8'), 'keep this video');
  symlinkSync(join(output, 'missing.mp4'), join(output, '17.mp4'));
  assert.throws(() => prepareNativeOutput(options, nativeRunPaths(options, stateRoot)), /already exists/);
  assert.equal(existsSync(stateRoot), false);
});

test('an existing selection requires resume and missing resume state is not created', context => {
  const { output, stateRoot } = fixture(context);
  const options = { output, cardIds: [17], resume: false };
  const paths = nativeRunPaths(options, stateRoot);
  prepareNativeOutput(options, paths);
  writeFileSync(paths.manifestPath, 'preserve run state');
  assert.throws(() => prepareNativeOutput(options, paths), /use resume/);
  assert.equal(readFileSync(paths.manifestPath, 'utf8'), 'preserve run state');
  prepareNativeOutput({ ...options, resume: true }, paths);
  const missing = nativeRunPaths({ output, cardIds: [19] }, join(stateRoot, 'not-created'));
  assert.throws(() => prepareNativeOutput({ output, cardIds: [19], resume: true }, missing), /state directory is missing/);
  assert.equal(existsSync(join(stateRoot, 'not-created')), false);
});

test('an initial write failure leaves no claimed run and the next attempt succeeds', context => {
  const { output, stateRoot } = fixture(context);
  const options = { output, cardIds: [17], resume: false }, paths = nativeRunPaths(options, stateRoot);
  assert.throws(() => prepareNativeOutput(options, paths, {
    writeManifest(path, content, flags) {
      writeFileSync(path, content.slice(0, 10), flags);
      throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    },
  }), { code: 'ENOSPC' });
  assert.equal(existsSync(paths.stateDirectory), false);
  assert.deepEqual(readdirSync(stateRoot), []);
  prepareNativeOutput(options, paths);
  assert.deepEqual(JSON.parse(readFileSync(paths.manifestPath, 'utf8')), initialManifest(options));
  prepareNativeOutput({ ...options, resume: true }, paths);
});

test('an abandoned empty run directory can be initialized safely', context => {
  const { output, stateRoot } = fixture(context);
  const options = { output, cardIds: [17], resume: false }, paths = nativeRunPaths(options, stateRoot);
  mkdirSync(paths.stateDirectory, { recursive: true });
  prepareNativeOutput(options, paths);
  assert.deepEqual(JSON.parse(readFileSync(paths.manifestPath, 'utf8')), initialManifest(options));
});

test('competing initializers cannot replace the winning manifest', context => {
  const { output, stateRoot } = fixture(context);
  const options = { output, cardIds: [17], resume: false }, paths = nativeRunPaths(options, stateRoot);
  const winner = { ...initialManifest(options), winner: true };
  assert.throws(() => prepareNativeOutput(options, paths, {
    writeManifest(path, content, flags) {
      writeFileSync(path, content, flags);
      prepareOutput(options, paths, winner);
    },
  }), /use resume/);
  assert.deepEqual(JSON.parse(readFileSync(paths.manifestPath, 'utf8')), winner);
  assert.deepEqual(readdirSync(stateRoot), [paths.stateDirectory.slice(stateRoot.length + 1)]);
});

test('output and state paths reject symbolic links without writing through them', context => {
  const { root, output, stateRoot } = fixture(context);
  const target = join(root, 'target');
  mkdirSync(target);
  symlinkSync(target, output);
  const options = { output, cardIds: [17], resume: false };
  assert.throws(() => prepareNativeOutput(options, nativeRunPaths(options, stateRoot)), /without symbolic links/);
  assert.equal(existsSync(stateRoot), false);
  const nested = { ...options, output: join(output, 'nested') };
  assert.throws(() => prepareNativeOutput(nested, nativeRunPaths(nested, stateRoot)), /without symbolic links/);
  assert.equal(existsSync(join(target, 'nested')), false);
  rmSync(output);
  symlinkSync(target, join(root, 'private'));
  assert.throws(() => prepareNativeOutput(options, nativeRunPaths(options, stateRoot)), /without symbolic links/);
  assert.equal(existsSync(join(target, 'runs')), false);
  rmSync(join(root, 'private'));
  mkdirSync(stateRoot, { recursive: true });
  const paths = nativeRunPaths(options, stateRoot);
  symlinkSync(target, paths.stateDirectory);
  assert.throws(() => prepareNativeOutput({ ...options, resume: true }, paths), /without symbolic links/);
});

test('completed cleanup removes only owned intermediates and retains verification receipts', context => {
  const { root } = fixture(context);
  const card = join(root, 'card');
  for (const name of ['native', 'prepared', 'proofs', 'certificate', 'other']) mkdirSync(join(card, name), { recursive: true });
  for (const name of ['.video.staged.mp4', 'native/0000.png', 'prepared/0000.png', 'proofs/before.png', 'certificate/0000.yuv', 'certificate/0275.yuv']) writeFileSync(join(card, name), 'intermediate');
  const retained = ['card.json', 'quality.json', 'geometry.json', 'certificate/certificate.json', 'certificate/decoded.framecrc', 'certificate/custom.yuv', 'other/0000.png'];
  for (const name of retained) writeFileSync(join(card, name), 'receipt');
  pruneNativeIntermediates(card);
  for (const name of ['.video.staged.mp4', 'native', 'prepared', 'proofs', 'certificate/0000.yuv', 'certificate/0275.yuv']) assert.equal(existsSync(join(card, name)), false);
  for (const name of retained) assert.equal(readFileSync(join(card, name), 'utf8'), 'receipt');
  pruneNativeIntermediates(card);
});

test('cleanup does not traverse symbolic links outside the card directory', context => {
  const { root } = fixture(context);
  const card = join(root, 'card'), target = join(root, 'outside');
  mkdirSync(card);
  mkdirSync(target);
  writeFileSync(join(target, '0000.yuv'), 'preserved');
  symlinkSync(target, join(card, 'native'));
  pruneNativeIntermediates(card);
  assert.equal(existsSync(join(card, 'native')), false);
  assert.equal(readFileSync(join(target, '0000.yuv'), 'utf8'), 'preserved');
  symlinkSync(target, join(card, 'certificate'));
  assert.throws(() => pruneNativeIntermediates(card), /without symbolic links/);
  assert.equal(readFileSync(join(target, '0000.yuv'), 'utf8'), 'preserved');
});
