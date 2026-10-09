import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {
  atomicJson, fileHash, newCheckpoint, verifyCompleted, assertRun, runFingerprint,
  assertGeometry, PRESET, assetFingerprint, CARD_IDS, requireSpace, acquireRunLock,
} from '../run-state.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-note-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }));
  const output = path.join(directory, 'output');
  const cache = path.join(directory, 'cache');
  for (const folder of [cache, path.join(output, 'qa'), path.join(output, 'thumbnails')]) fs.mkdirSync(folder, { recursive: true });
  const config = { runFingerprint: 'fingerprint', expectedIccSha256: 'icc' };
  const state = newCheckpoint(config.runFingerprint);
  const png = path.join(output, '1.png');
  const qa = path.join(output, 'qa', '1.json');
  const thumb = path.join(output, 'thumbnails', '1.png');
  fs.writeFileSync(png, 'verified-image');
  fs.writeFileSync(thumb, 'verified-thumbnail');
  const report = { id: 1, qaPassed: true, runFingerprint: config.runFingerprint,
    fileSha256: fileHash(png), decodedRgbaSha256: 'decoded', iccSha256: config.expectedIccSha256 };
  atomicJson(qa, report);
  state.completed[1] = { ...report, qaSha256: fileHash(qa), thumbnailSha256: fileHash(thumb) };
  state.commitOrder = [1];
  state.controls = [{ label: 'startup-460', passed: true }];
  state.finalControlsComplete = true;
  return { directory, output, cache, config, state, png, qa, thumb };
}

test('resume retains verified files and checkpoints', t => {
  const f = fixture(t);
  assert.deepEqual(verifyCompleted(f.state, f.config, f.output, f.cache), []);
  assert.equal(f.state.resumeVerification.verifiedCompleted, 1);
  assert.ok(fs.existsSync(f.png));
  assert.equal(f.state.controls.length, 1);
});

for (const target of ['png', 'qa', 'thumb']) {
  test(`resume quarantines corrupted ${target} and invalidates control gates`, t => {
    const f = fixture(t);
    fs.appendFileSync(f[target], 'corrupt');
    assert.deepEqual(verifyCompleted(f.state, f.config, f.output, f.cache), [1]);
    assert.deepEqual(f.state.completed, {});
    assert.deepEqual(f.state.commitOrder, []);
    assert.deepEqual(f.state.controls, []);
    assert.equal(f.state.finalControlsComplete, false);
    assert.equal(f.state.lastControlCount, 0);
    const [quarantine] = fs.readdirSync(path.join(f.cache, 'quarantine'));
    assert.equal(fs.readdirSync(path.join(f.cache, 'quarantine', quarantine)).length, 3);
    assert.equal(fs.existsSync(f.png), false);
  });
}

test('malformed checkpoint state is rejected before moving files', t => {
  const f = fixture(t);
  f.state.commitOrder.push(1);
  assert.throws(() => verifyCompleted(f.state, f.config, f.output, f.cache), /commit order/);
  assert.ok(fs.existsSync(f.png));
  f.state.runFingerprint = 'changed';
  assert.throws(() => verifyCompleted(f.state, f.config, f.output, f.cache), /fingerprint/);
});

test('source, profile, geometry and runtime changes cannot reuse a run', () => {
  const original = { sourceHashes: { 'src/example.ts': 'source' }, settings: PRESET,
    assetFingerprint: 'assets', expectedIccSha256: 'native-icc', runtime: { python: '3.12.14' } };
  const config = { ...original, runFingerprint: runFingerprint(original) };
  assert.doesNotThrow(() => assertRun(config, original));
  for (const field of ['sourceHashes', 'settings', 'assetFingerprint', 'expectedIccSha256', 'runtime']) {
    assert.throws(() => assertRun(config, { ...original, [field]: 'changed' }), /SOURCE_DRIFT/);
  }
  assert.throws(() => assertRun({ ...config, runFingerprint: 'corrupt' }, original), /SOURCE_DRIFT/);
  assert.doesNotThrow(() => assertGeometry({ innerWidth: 1024, innerHeight: 686, dpr: 2.5 }));
  assert.throws(() => assertGeometry({ innerWidth: 1024, innerHeight: 686, dpr: 2 }), /GEOMETRY/);
});

test('asset identifiers are frozen while preflight timestamps may change', () => {
  const make = () => ({ complete: true, summary: { assetsPassed: 4290 }, anomalies: [],
    cards: CARD_IDS.map(id => ({ id, assets: Object.fromEntries(['front', 'foil', 'mask'].map(kind => [kind,
      { url: `https://example.test/${kind}/${id}`, etag: 'etag', dimensions: [2000, 2800], totalBytes: 100 }])) })) });
  const original = make();
  const current = make();
  current.updatedAt = 'later';
  assert.equal(assetFingerprint(original), assetFingerprint(current));
  current.cards[827].assets.front.etag = 'changed';
  assert.notEqual(assetFingerprint(original), assetFingerprint(current));
  current.cards.pop();
  assert.throws(() => assetFingerprint(current), /incomplete/);
});

test('scratch allocation must leave the 10 GiB reserve intact', t => {
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 10 * 1024 ** 3 + 10, bsize: 1 }));
  assert.doesNotThrow(() => requireSpace('.'));
  assert.throws(() => requireSpace('.', 11), /DISK:/);
});

test('one process owns a run cache and release cannot remove another owner', t => {
  const f = fixture(t);
  const release = acquireRunLock(f.cache);
  assert.throws(() => acquireRunLock(f.cache), /in use/);
  release();
  const releaseAgain = acquireRunLock(f.cache);
  const file = path.join(f.cache, '.run.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'different' }));
  releaseAgain();
  assert.ok(fs.existsSync(file));
});

test('a dead process lock permits resume', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cache, '.run.lock'), JSON.stringify({ pid: 123456, token: 'stale' }));
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const release = acquireRunLock(f.cache);
  release();
  assert.equal(fs.existsSync(path.join(f.cache, '.run.lock')), false);
});
