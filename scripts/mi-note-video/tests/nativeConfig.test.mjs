import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPreflightBinding, assertProfileGrid, catalogCount, contract, motionFor, parseOptions, profileFor, warmNativeCapture } from '../native-config.mjs';

test('each approved motion works with both black capture profiles', () => {
  for (const profile of Object.keys(contract.profiles)) for (const motion of contract.motions) {
    const args = parseOptions(['--profile', profile, '--motion', motion, '--ids', '312', '--output', '/tmp/output', '--cache', '/tmp/cache', '--preflight', '/tmp/approved.json'], 'capture');
    assert.deepEqual(args.ids, [312]);
    assert.equal(args.profile, profile);
    assert.equal(args.motion, motion);
    const selected = profileFor(profile);
    assert.equal(selected.nativeSize, selected.deliverySize * 1.5);
    assert.equal(selected.captureScale, selected.nativeSize / 1080);
  }
  assert.equal(contract.scene.background, '#000000');
  assert.equal(contract.scene.shadow, 'none');
  assert.equal(motionFor('original'), undefined);
});

test('profile tile counts cannot silently switch capture methods', () => {
  assertProfileGrid(profileFor('sideways-1980'), { xs: [0], ys: [0] });
  assertProfileGrid(profileFor('upright-2160'), { xs: [0], ys: [0, 1470] });
  assert.throws(() => assertProfileGrid(profileFor('sideways-1980'), { xs: [0], ys: [0, 1470] }), /exactly 1/);
  assert.throws(() => assertProfileGrid(profileFor('upright-2160'), { xs: [0], ys: [0] }), /exactly 2/);
  assert.throws(() => assertProfileGrid(profileFor('upright-2160'), { xs: [0, 50], ys: [0, 1470] }), /exactly 2/);
});

test('the native CLI rejects other motions, profiles, batches and quality overrides', () => {
  const base = ['--id', '312', '--output', '/tmp/preflight'];
  for (const args of [['--motion', 'weighted-swing'], ['--profile', 'upright-1440'], ['--size', '1080'], ['--methods', 'c']]) {
    assert.throws(() => parseOptions([...base, ...args], 'preflight'));
  }
  assert.throws(() => parseOptions(['--id', '312,904', '--output', '/tmp/preflight'], 'preflight'), /one card/);
  assert.throws(() => parseOptions(['--id', String(catalogCount() + 1), '--output', '/tmp/preflight'], 'preflight'), /Card ID/);
  assert.equal(parseOptions([...base, '--verify-resume'], 'preflight').verifyResume, true);
});

test('a fresh native warmup is repeated in full after an interrupted attempt', async () => {
  const first = [];
  await assert.rejects(warmNativeCapture(async frame => {
    first.push(frame);
    if (first.length === 3) throw new Error('Interrupted');
    return { frame };
  }), /Interrupted/);
  assert.deepEqual(first, [0, 69, 138]);
  const resumed = [];
  let running = false;
  const result = await warmNativeCapture(async frame => {
    assert.equal(running, false);
    running = true;
    await Promise.resolve();
    resumed.push(frame);
    running = false;
    return { frame };
  });
  assert.deepEqual(resumed, [0, 69, 138, 207, 275, 0]);
  assert.deepEqual(result.map(value => value.frame), resumed);
});

test('capture preflight binding rejects another source root, release, runtime, or selection', () => {
  const current = { root: '/vm/releases/current', profile: 'upright-2160', motion: 'original', ids: [312],
    sourceHashes: { 'capture.mjs': 'a'.repeat(64) }, versions: { node: 'v24.22.0', python: { pillow: '12.3.0' } } };
  assertPreflightBinding(structuredClone(current), current);
  for (const [key, changed] of Object.entries({ root: '/vm/releases/another', profile: 'sideways-1980', motion: 'vertical-swing',
    ids: [904], sourceHashes: { 'capture.mjs': 'b'.repeat(64) }, versions: { ...current.versions, node: 'v24.23.0' } })) {
    assert.throws(() => assertPreflightBinding({ ...current, [key]: changed }, current), new RegExp(`Preflight ${key} differs`));
  }
  assert.throws(() => assertPreflightBinding(undefined, current), /Preflight root differs/);
});
