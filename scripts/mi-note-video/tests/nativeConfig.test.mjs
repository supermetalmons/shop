import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNativeHost, assertResumeIdentity, catalogCount, hashFile, renderingSourceHashes, nativeSourceFiles, sourceRoot, verifyCompletedCard } from '../native-config.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mi-note-source-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/mi-note-video'), { recursive: true });
  mkdirSync(join(root, 'src'));
  return root;
}

test('native rendering requires a physical Mac without a backend selector', () => {
  assert.equal(assertNativeHost({ platform: 'darwin', model: 'Mac14,5' }), 'Mac14,5');
  assert.throws(() => assertNativeHost({ platform: 'darwin', model: 'VirtualMac2,1' }), /physical Mac/);
  assert.throws(() => assertNativeHost({ platform: 'linux', model: 'Mac14,5' }), /requires macOS/);
  assert.throws(() => assertNativeHost({ platform: 'darwin', model: '' }), /identify the Mac/);
});

test('native fingerprints follow imported scene dependencies and ignore unrelated files', context => {
  const root = fixture(context), engine = join(root, 'scripts/mi-note-video');
  writeFileSync(join(engine, 'entry.mjs'), "import '../../src/scene';\n");
  writeFileSync(join(root, 'src/scene.ts'), "import './scene.css';\nexport const frame = 1;\n");
  writeFileSync(join(root, 'src/scene.css'), 'body{background:black}');
  writeFileSync(join(engine, 'obsolete-controller.py'), 'ignored');
  const first = renderingSourceHashes(root, ['entry.mjs']);
  assert.deepEqual(Object.keys(first), ['scripts/mi-note-video/entry.mjs', 'src/scene.css', 'src/scene.ts']);
  writeFileSync(join(engine, 'obsolete-controller.py'), 'still ignored');
  assert.deepEqual(renderingSourceHashes(root, ['entry.mjs']), first);
  writeFileSync(join(root, 'src/scene.css'), 'body{background:white}');
  assert.notEqual(renderingSourceHashes(root, ['entry.mjs'])['src/scene.css'], first['src/scene.css']);
});

test('native source closure rejects missing files and external symbolic links', context => {
  const root = fixture(context), engine = join(root, 'scripts/mi-note-video');
  writeFileSync(join(engine, 'entry.mjs'), "import './missing.mjs';");
  assert.throws(() => renderingSourceHashes(root, ['entry.mjs']), /Missing local/);
  symlinkSync(join(here, 'nativeConfig.test.mjs'), join(engine, 'missing.mjs'));
  assert.throws(() => renderingSourceHashes(root, ['entry.mjs']), /regular rendering dependency/);
});

test('native inventory binds Swift, build, launcher, Python processing, pins, and the real scene', () => {
  const hashes = renderingSourceHashes();
  for (const name of nativeSourceFiles) assert.match(hashes[`scripts/mi-note-video/${name}`], /^[a-f0-9]{64}$/);
  for (const name of ['src/components/DrifEffectCard.tsx', 'src/drif.css', 'src/lib/miNoteCards.ts', 'shared/mediaMap.ts']) assert.match(hashes[name], /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(hashes).some(name => /safari|vm\.py|guest-runner|catalog\.py/.test(name)), false);
  assert.equal(catalogCount(), 1430);
  assert.equal(resolve(sourceRoot), resolve(here, '../../..'));
});

test('version 2 resume binds selection, source, runtime, app, output, and retention', () => {
  const identity = { version: 2, ids: [17], sourceHashes: { 'scene.ts': 'a'.repeat(64) },
    runtime: { receiptSha256: 'b'.repeat(64) }, app: { sha256: 'c'.repeat(64) },
    output: '/render/current', retention: 'controls' };
  const manifest = { ...structuredClone(identity), pid: 123, cards: {} };
  assertResumeIdentity(manifest, identity);
  for (const [key, value] of Object.entries({ ids: [18], sourceHashes: {}, runtime: {}, app: {}, output: '/elsewhere', retention: 'all-frames' })) {
    assert.throws(() => assertResumeIdentity({ ...manifest, [key]: value }, identity), new RegExp(`resume ${key} differs`));
  }
  assert.throws(() => assertResumeIdentity({ ...manifest, version: 1 }, identity), /version 2/);
  assert.throws(() => assertResumeIdentity({ ...manifest, pid: -1 }, identity), /process identity/);
});

test('native runtime and launcher have no browser-driver dependency', () => {
  for (const name of ['native-config.mjs', 'native-runtime.mjs', 'cli.mjs', 'native-render.mjs']) {
    const source = readFileSync(join(here, '..', name), 'utf8');
    assert.doesNotMatch(source, /safaridriver|from ['"].*(?:safari|vm|backends)\.(?:mjs|py)/i);
  }
});

test('completed-card resume rejects another card, missing canonical video, and changed contents', context => {
  const root = fixture(context);
  const evidenceDirectory = join(root, 'evidence', '17');
  mkdirSync(evidenceDirectory, { recursive: true });
  const videoPath = join(root, '17.mp4');
  writeFileSync(videoPath, 'verified video fixture');
  const video = { path: videoPath, sha256: hashFile(videoPath) };
  const summary = { id: 17, status: 'complete', evidenceDirectory, frameCount: 276, qualityPassed: true, fullyDecoded: true, video };
  const detail = { id: 17, status: 'complete', evidenceDirectory, video,
    frames: Array.from({ length: 276 }, (_, frame) => ({ frame, pose: { cardId: 17, frame } })),
    result: { qualityReport: { passed: true }, video: { fullyDecoded: true } } };
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
  assert.equal(verifyCompletedCard(root, 17, summary).id, 17);
  const otherVideo = join(root, '18.mp4');
  writeFileSync(otherVideo, 'another valid video fixture');
  assert.throws(() => verifyCompletedCard(root, 17, { ...summary, id: 18, video: { path: otherVideo, sha256: hashFile(otherVideo) } }), /summary binding/);
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify({ ...detail, id: 18 }));
  assert.throws(() => verifyCompletedCard(root, 17, summary), /detail binding/);
  const wrongPose = structuredClone(detail);
  wrongPose.frames[1].pose.frame = 2;
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(wrongPose));
  assert.throws(() => verifyCompletedCard(root, 17, summary), /detail binding/);
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
  writeFileSync(videoPath, 'changed');
  assert.throws(() => verifyCompletedCard(root, 17, summary), /checksum differs/);
  rmSync(videoPath);
  assert.throws(() => verifyCompletedCard(root, 17, summary), /canonical regular output/);
});
