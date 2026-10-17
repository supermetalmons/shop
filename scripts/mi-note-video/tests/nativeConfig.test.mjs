import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeBackend, assertPreflightBinding, assertProfileGrid, catalogCount, contract, motionFor, nativeBackend, parseOptions, profileFor, warmNativeCapture } from '../native-config.mjs';

test('native rendering explicitly distinguishes physical Mac and VM backends', () => {
  assert.equal(nativeBackend(), 'vm');
  for (const backend of ['host', 'vm']) assert.equal(nativeBackend(backend), backend);
  for (const backend of ['', 'auto', 'linux', null, true]) assert.throws(() => nativeBackend(backend), /Unsupported native rendering backend/);
  const host = { platform: 'darwin', model: 'Mac14,5' };
  const vm = { platform: 'darwin', model: 'VirtualMac2,1' };
  assert.equal(assertNativeBackend('host', host), 'host');
  assert.equal(assertNativeBackend('vm', vm), 'vm');
  assert.throws(() => assertNativeBackend('host', vm), /physical Mac hardware/);
  assert.throws(() => assertNativeBackend('vm', host), /configured macOS VM/);
  for (const backend of ['host', 'vm']) {
    assert.throws(() => assertNativeBackend(backend, { platform: 'linux', model: 'VirtualMac2,1' }), /requires macOS/);
    assert.throws(() => assertNativeBackend(backend, { platform: 'darwin', model: '' }), /identify the Mac hardware/);
  }
});

test('native backend defaults to the legacy VM and reads only an explicit backend override', () => {
  const previous = process.env.MI_NOTE_RENDER_BACKEND;
  try {
    delete process.env.MI_NOTE_RENDER_BACKEND;
    assert.equal(assertNativeBackend(undefined, { platform: 'darwin', model: 'VirtualMac2,1' }), 'vm');
    assert.throws(() => assertNativeBackend(undefined, { platform: 'darwin', model: 'Mac14,5' }), /configured macOS VM/);
    process.env.MI_NOTE_RENDER_BACKEND = 'host';
    assert.equal(assertNativeBackend(undefined, { platform: 'darwin', model: 'Mac14,5' }), 'host');
    process.env.MI_NOTE_RENDER_BACKEND = 'auto';
    assert.throws(() => assertNativeBackend(undefined, { platform: 'darwin', model: 'Mac14,5' }), /Unsupported native rendering backend/);
  } finally {
    if (previous === undefined) delete process.env.MI_NOTE_RENDER_BACKEND;
    else process.env.MI_NOTE_RENDER_BACKEND = previous;
  }
});

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

test('preflight backend binding preserves legacy VM identities and rejects cross-backend reuse', () => {
  const legacy = { root: '/vm/releases/current', profile: 'upright-2160', motion: 'breathing-swing', ids: [166],
    sourceHashes: {}, versions: {} };
  assertPreflightBinding(legacy, { ...legacy, backend: 'vm' });
  assertPreflightBinding({ ...legacy, backend: 'vm' }, legacy);
  assertPreflightBinding({ ...legacy, backend: 'host' }, { ...legacy, backend: 'host' });
  assert.throws(() => assertPreflightBinding(legacy, { ...legacy, backend: 'host' }), /Preflight backend differs/);
  assert.throws(() => assertPreflightBinding({ ...legacy, backend: 'host' }, legacy), /Preflight backend differs/);
});
