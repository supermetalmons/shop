import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { StreamProcessing } from '../stream-processing.mjs';
import { runCaptureOverlap } from '../capture-overlap.mjs';
import { recoverNativeCapture } from '../captureRecovery.mjs';

const source = readFileSync(new URL('../capture.mjs', import.meta.url), 'utf8');
const declaration = (name, next) => {
  const start = source.indexOf(`  const ${name} = `);
  const end = source.indexOf(`  const ${next} = `, start);
  assert.ok(start >= 0 && end > start, `Missing capture declaration: ${name}`);
  return source.slice(start, end);
};

function fixture(context, failedFrame, { failurePhase = 'complete', failureMessage = 'Safari MCP exited' } = {}) {
  const files = new Map();
  const workers = [];
  const processing = new Map();
  const savedFrames = new Map([[1, new Map()]]);
  const manifest = { nativeFrames: {}, nativeProofs: {}, videos: [], captures: [] };
  const hash = path => createHash('sha256').update(files.get(path)).digest('hex');
  let failed = false;
  const failFrame = (frame, label, phase) => {
    if (!failed && /^\d{4}$/.test(label) && frame === failedFrame && phase === failurePhase) {
      failed = true;
      throw new Error(failureMessage);
    }
  };
  let rest = 'first session';
  const initial = { viewport: { width: 16, height: 16 }, dpr: 1 };
  class Worker {
    constructor() {
      this.frames = [];
      this.committedAtStart = savedFrames.get(1).size;
      workers.push(this);
    }

    request(operation, args) {
      if (operation === 'init') {
        this.beforeSha256 = args.beforeSha256;
        return Promise.resolve({ ready: true });
      }
      assert.equal(operation, 'frame');
      assert.equal(manifest.nativeFrames[`1:${args.frame}`].sha256, args.sha256);
      if (args.frame === 0) assert.equal(args.sha256, this.beforeSha256);
      this.frames.push(args.frame);
      return Promise.resolve({ frame: args.frame, sourceSha256: args.sha256, preparedSha256: 'a'.repeat(64) });
    }

    async close() {}
  }
  class Stream extends StreamProcessing {
    constructor(worker, config, options) { super(worker, config, { ...options, frameCount: 3 }); }
  }
  const bindings = {
    processing, manifest, savedFrames, hash, join, randomUUID, FrameWorker: Worker, StreamProcessing: Stream,
    runCaptureOverlap, recoverNativeCapture,
    captures: new Map(), savedGeometry: new Map(), activeChildren: new Set(),
    cache: '/fixture/capture', output: '/fixture/output', root: '/fixture/source', runId: 'fixture',
    options: { python: 'fixture', nft2Tilt: true, singleViewportCapture: true },
    profile: { rotationDegrees: 90 }, preset: { frames: 3 }, captureScale: 1, capturedSize: 16, deliverySize: 16,
    gutterPixels: 0, harnessPath: '/', motionLoop: undefined, profileSampleInterval: 60,
    safari: { tabs: [], createTab: async () => ({ handle: randomUUID() }), call: async () => {} },
    checkActive: () => {}, assertSources: () => {}, focusCaptureSafari: async () => {}, delay: async () => {},
    safariWait: async () => {}, safariAction: async () => {}, remountCard: async () => initial,
    assertSnapshot: () => {}, physicalInteger: Math.round, assertProfileGrid: () => {}, singleViewportScroll: () => {},
    existsSync: path => files.has(path), knownStaticReference: () => ({ path: '/fixture/static.png' }),
    warmNativeCapture: async () => {}, saveManifest: () => {}, staticBounds: () => [0, 0, 16, 16],
    stopProcessingChildren: () => {}, repeatCheck: 'fixture', run: async () => JSON.stringify({ checks: [{ equal: true, iccEqual: true }] }),
    writeFileSync: (path, value) => files.set(path, value), appendFileSync: () => {}, console: { log: () => {} },
    captureJoinedFrame: async ({ frame, label, file }) => {
      failFrame(frame, label, 'complete');
      files.set(file, `${rest}:frame-${frame}`);
      const stitchReport = `${file}.json`;
      files.set(stitchReport, 'stitch report');
      return { stitchReport, stitched: { icc: { sha256: 'b'.repeat(64) }, metadata: stitchReport }, snapshot: initial };
    },
    captureFrameTiles: async args => { failFrame(args.frame, args.label, 'acquire'); return args; },
    stitchCapturedFrame: args => bindings.captureJoinedFrame(args),
  };
  const createCapture = () => Function(...Object.keys(bindings), `
    let safariAuxiliary, staticReference, aborted;
    ${declaration('processingFor', 'finishProcessing')}
    ${declaration('captureSafari', 'processCard')}
    return captureSafari;
  `)(...Object.values(bindings));
  let capture = createCapture();
  context.after(async () => {
    await Promise.all([...processing.values()].map(entry => entry.stream.close()));
  });
  return { capture: () => capture([1]), workers, manifest, savedFrames, changeRest: value => { rest = value; },
    restartProcess: async () => {
      await Promise.all([...processing.values()].map(entry => entry.stream.close()));
      processing.clear();
      workers.length = 0;
      capture = createCapture();
    } };
}

test('a zero-frame Safari retry starts processing with its newly calibrated rest baseline', async context => {
  const { capture, workers, manifest, savedFrames, changeRest } = fixture(context, 0);
  await assert.rejects(capture(), /Safari MCP exited/);
  const firstBaseline = manifest.nativeProofs[1].before.sha256;
  assert.equal(savedFrames.get(1).size, 0);
  assert.equal(workers.length, 0);
  changeRest('second session');
  await capture();
  assert.notEqual(manifest.nativeProofs[1].before.sha256, firstBaseline);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].committedAtStart, 1);
  assert.equal(workers[0].beforeSha256, manifest.nativeProofs[1].before.sha256);
  assert.deepEqual(workers[0].frames, [0, 1, 2]);
});

test('a Safari retry with committed frames preserves the processor and replays the prefix once', async context => {
  const { capture, workers, manifest, savedFrames } = fixture(context, 1);
  await assert.rejects(capture(), /Safari MCP exited/);
  const before = manifest.nativeProofs[1].before.sha256;
  assert.equal(savedFrames.get(1).size, 1);
  assert.equal(workers.length, 1);
  await capture();
  assert.equal(manifest.nativeProofs[1].before.sha256, before);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].frames, [0, 1, 2]);
});

test('a fresh process replays saved frames against their original baseline before appending captures', async context => {
  const { capture, workers, manifest, restartProcess } = fixture(context, 1);
  await assert.rejects(capture(), /Safari MCP exited/);
  const before = manifest.nativeProofs[1].before.sha256;
  await restartProcess();
  await capture();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].committedAtStart, 1);
  assert.equal(workers[0].beforeSha256, before);
  assert.deepEqual(workers[0].frames, [0, 1, 2]);
});

for (const [failurePhase, failureMessage] of [
  ['acquire', 'Rejected native PNG header'],
  ['complete', 'Tile overlap/seam QA failed'],
  ['complete', 'Static exterior QA failed'],
]) {
  test(`${failureMessage} requires a fresh session and replays only the committed prefix`, async context => {
    const { capture, workers, manifest, savedFrames } = fixture(context, 1, { failurePhase, failureMessage });
    await assert.rejects(capture(), error => /^Native rest reference mismatch:/.test(error.message)
      && error.cause.message === failureMessage);
    const before = manifest.nativeProofs[1].before.sha256;
    assert.deepEqual([...savedFrames.get(1).keys()], [0]);
    assert.deepEqual(Object.keys(manifest.nativeFrames), ['1:0']);
    assert.deepEqual(workers[0].frames, [0]);
    assert.equal(manifest.nativeProofs[1].after, undefined);
    assert.deepEqual(manifest.captures, []);
    await capture();
    assert.equal(manifest.nativeProofs[1].before.sha256, before);
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0].frames, [0, 1, 2]);
  });
}
