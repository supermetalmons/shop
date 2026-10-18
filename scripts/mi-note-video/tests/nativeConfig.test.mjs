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

test('version 2 resume binds selection, presentation, source, runtime, app, output, and retention', () => {
  const identity = { version: 2, ids: [17], presentation: 'offscreen', sourceHashes: { 'scene.ts': 'a'.repeat(64) },
    runtime: { receiptSha256: 'b'.repeat(64) }, app: { sha256: 'c'.repeat(64) },
    output: '/render/current', stateDirectory: '/private/state', retention: 'receipts' };
  const manifest = { ...structuredClone(identity), pid: 123, cards: {} };
  assertResumeIdentity(manifest, identity);
  for (const [key, value] of Object.entries({ ids: [18], presentation: 'foreground', sourceHashes: {}, runtime: {}, app: {}, output: '/elsewhere', stateDirectory: '/other-state', retention: 'all-frames' })) {
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

function completedFixture(context) {
  const root = fixture(context);
  const evidenceDirectory = join(root, 'evidence', '17');
  mkdirSync(evidenceDirectory, { recursive: true });
  const output = join(root, 'videos');
  mkdirSync(output);
  const videoPath = join(output, '17.mp4');
  writeFileSync(videoPath, 'verified video fixture');
  const video = { path: videoPath, sha256: hashFile(videoPath) };
  const summary = { id: 17, status: 'complete', evidenceDirectory, frameCount: 276, qualityPassed: true, fullyDecoded: true, video };
  const stream = { nb_read_frames: '276' };
  const certificatePath = join(evidenceDirectory, 'certificate', 'certificate.json');
  mkdirSync(join(evidenceDirectory, 'certificate'));
  const certificate = { version: 1, kind: 'mi-note-video-decode', videoSha256: video.sha256,
    videoBytes: readFileSync(videoPath).length, fullyDecoded: true, decodedFrames: 276, stream };
  writeFileSync(certificatePath, JSON.stringify(certificate));
  const detail = { id: 17, status: 'complete', evidenceDirectory, video,
    frames: Array.from({ length: 276 }, (_, frame) => ({ frame, pose: { cardId: 17, frame }, sha256: 'a'.repeat(64),
      path: join(evidenceDirectory, 'native', `${String(frame).padStart(4, '0')}.png`) })),
    result: { qualityReport: { passed: true }, video: { fullyDecoded: true, output: videoPath, sha256: video.sha256,
      bytes: certificate.videoBytes, stream, decodeCertificate: { path: certificatePath, sha256: hashFile(certificatePath) } } } };
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
  return { root, evidenceDirectory, output, videoPath, video, summary, detail, certificatePath, certificate };
}

test('completed-card resume rejects another card, missing canonical video, and changed contents', context => {
  const { root, evidenceDirectory, output, videoPath, summary, detail } = completedFixture(context);
  assert.equal(verifyCompletedCard(output, 17, summary, root).id, 17);
  assert.throws(() => verifyCompletedCard(output, 17, summary, output), /summary binding/);
  const otherVideo = join(output, '18.mp4');
  writeFileSync(otherVideo, 'another valid video fixture');
  assert.throws(() => verifyCompletedCard(output, 17, { ...summary, id: 18, video: { path: otherVideo, sha256: hashFile(otherVideo) } }, root), /summary binding/);
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify({ ...detail, id: 18 }));
  assert.throws(() => verifyCompletedCard(output, 17, summary, root), /detail binding/);
  const wrongPose = structuredClone(detail);
  wrongPose.frames[1].pose.frame = 2;
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(wrongPose));
  assert.throws(() => verifyCompletedCard(output, 17, summary, root), /detail binding/);
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
  writeFileSync(videoPath, 'changed');
  assert.throws(() => verifyCompletedCard(output, 17, summary, root), /checksum differs/);
  rmSync(videoPath);
  assert.throws(() => verifyCompletedCard(output, 17, summary, root), /canonical regular output/);
});

test('publication recovery accepts only matching publishing or completed detail receipts', context => {
  const { root, evidenceDirectory, output, summary, detail } = completedFixture(context);
  summary.status = 'publishing';
  for (const status of ['publishing', 'complete']) {
    detail.status = status;
    writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
    assert.equal(verifyCompletedCard(output, 17, summary, root, { allowPublishing: true }).status, status);
    assert.throws(() => verifyCompletedCard(output, 17, summary, root), /summary binding/);
  }
  for (const status of ['verifying', 'capturing', undefined]) {
    assert.throws(() => verifyCompletedCard(output, 17, { ...summary, status }, root, { allowPublishing: true }), /summary binding/);
  }
  assert.throws(() => verifyCompletedCard(output, 17, undefined, root, { allowPublishing: true }), /summary binding/);
  detail.status = 'verifying';
  writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
  assert.throws(() => verifyCompletedCard(output, 17, summary, root, { allowPublishing: true }), /detail binding/);
});

test('publication recovery rejects changed result, frame, and decode certificate bindings', context => {
  for (const invalid of ['frame-hash', 'frame-path', 'output', 'sha256', 'quality', 'decode', 'certificate-hash', 'certificate-path', 'certificate-flags']) {
    const { root, evidenceDirectory, output, summary, detail, certificatePath, certificate } = completedFixture(context);
    summary.status = detail.status = 'publishing';
    if (invalid === 'frame-hash') detail.frames[0].sha256 = 'invalid';
    if (invalid === 'frame-path') detail.frames[0].path = '/elsewhere.png';
    if (invalid === 'output') detail.result.video.output = '/elsewhere.mp4';
    if (invalid === 'sha256') detail.result.video.sha256 = 'b'.repeat(64);
    if (invalid === 'quality') detail.result.qualityReport.passed = false;
    if (invalid === 'decode') detail.result.video.fullyDecoded = false;
    if (invalid === 'certificate-hash') detail.result.video.decodeCertificate.sha256 = 'b'.repeat(64);
    if (invalid === 'certificate-path') detail.result.video.decodeCertificate.path = '/elsewhere.json';
    if (invalid === 'certificate-flags') {
      certificate.fullyDecoded = false;
      writeFileSync(certificatePath, JSON.stringify(certificate));
      detail.result.video.decodeCertificate.sha256 = hashFile(certificatePath);
    }
    writeFileSync(join(evidenceDirectory, 'card.json'), JSON.stringify(detail));
    assert.throws(() => verifyCompletedCard(output, 17, summary, root, { allowPublishing: true }), /binding|certificate differs/);
  }
});
