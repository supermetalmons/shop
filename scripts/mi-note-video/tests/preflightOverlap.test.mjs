import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runCaptureOverlap } from '../capture-overlap.mjs';
import { frameScrollAction } from '../frame-scroll-action.mjs';

const source = readFileSync(new URL('../preflight.mjs', import.meta.url), 'utf8');
const section = (first, next) => {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `Missing preflight section: ${first}`);
  return source.slice(start, end);
};
const declarations = [
  section('async function wait(', 'async function remount('),
  section('async function acquireCapture(', 'async function selectTab('),
  section('async function warm(', 'function validateApproval('),
].join('\n');
const check = (condition, message) => { if (!condition) throw new Error(message); };

function fixture({ rotation = 0, inspect, stitch, screenshot, operation, compareResults = [], staleResult = false } = {}) {
  const events = [];
  const saved = new Map();
  const unfinished = new Set();
  const acquired = [];
  const completed = [];
  const committed = [];
  const window = {};
  const dimensions = { width: 3328, height: 2120 };
  const initial = { documentPixels: { width: 3328, height: 3300 } };
  let interrupted, actionNumber = 0, activeOperations = 0, maximum = 0;
  const state = { ready: true, paintReady: true, cardId: 39, frame: 0, nativePixels: true,
    viewport: { visibility: 'visible' }, scrollPixels: { x: 0, y: 0 }, stageRect: { x: 16, y: 16 } };
  const snapshot = () => structuredClone(state);
  const checkActive = () => { if (interrupted) throw interrupted; };
  window.miNoteCaptureComparison = {
    snapshot,
    async setFrame(frame) {
      events.push(['setFrame', frame]);
      state.frame = frame;
      state.paintReady = false;
      await setImmediate();
      state.paintReady = true;
      return snapshot();
    },
    async setScrollPixels(x, y) {
      events.push(['setScrollPixels', x, y]);
      state.scrollPixels = { x, y };
      state.stageRect = { x: (32 - x) / 2, y: (32 - y) / 2 };
      state.paintReady = false;
      await setImmediate();
      state.paintReady = true;
      return snapshot();
    },
  };
  const safari = {
    async evaluate(expression) {
      events.push(['evaluate', expression.includes('void(async') ? 'action' : 'poll']);
      const value = Function('window', expression)(window);
      if (staleResult && value?.actionResult) value.actionResult = { ...value.actionResult, token: 'stale' };
      return value;
    },
    async call(method, args) {
      events.push([method, method === 'screenshot' ? args.savePath : args]);
      await setImmediate();
      if (method === 'screenshot') {
        assert.equal(args.full_page, false);
        assert.equal(state.paintReady, true);
        await screenshot?.({ path: args.savePath, snapshot: snapshot(), events, interrupt: error => { interrupted = error; } });
      }
    },
  };
  const imageHelper = async (name, args, checkCapture = checkActive) => {
    checkActive();
    checkCapture();
    activeOperations += 1;
    assert.equal(activeOperations, 1, 'Image operations must remain serial');
    events.push(['image-start', name, args.input || args.output]);
    try {
      for (let tick = 0; tick < (name === 'stitch' ? 8 : 1); tick += 1) await setImmediate();
      await operation?.({ name, args, events, interrupt: error => { interrupted = error; } });
      checkActive();
      checkCapture();
      if (name === 'inspect') return inspect?.(args) || { ...dimensions, icc: { sha256: 'icc' } };
      if (name === 'stitch') return stitch || { passed: true, iccPreservedByteForByte: true, metadata: args.metadata };
      if (name === 'prepare') return { path: args.output, passed: true };
      assert.fail(`Unexpected image operation: ${name}`);
    } finally {
      activeOperations -= 1;
      events.push(['image-end', name, args.input || args.output]);
    }
  };
  const bindings = {
    join, check, checkActive, safari, frameScrollAction,
    randomUUID: () => `action-${++actionNumber}`, delay: () => setImmediate(),
    viewport: dimensions, captureScale: 3, nativeSize: 3240, deliverySize: 2160,
    nativeScrollQuantum: () => 6,
    tileAxisPositions: ({ viewport }) => viewport === dimensions.width ? [0] : [0, 1182],
    integer: Math.round, validatingProfile: true, profile: { id: 'fixture' },
    assertProfileGrid: (_, grid) => assert.equal(grid.ys.length, rotation === 90 ? 1 : 2),
    tab: 'owned-tab',
    chooseLandscapeViewport: pose => {
      events.push(['choose-scroll', pose.frame]);
      return { scroll: { x: 0, y: 120 + pose.frame * 6 }, protectedBounds: [1, 2, 3, 4] };
    },
    assertSnapshot: (value, id, frame, actualRotation, scroll) => {
      checkActive();
      assert.equal(actualRotation, rotation);
      assert.equal(value.cardId, id);
      assert.equal(value.frame, frame);
      assert.equal(value.ready, true);
      assert.equal(value.paintReady, true);
      if (scroll) assert.deepEqual(value.scrollPixels, scroll);
      events.push(['assert', frame, scroll ? 'scrolled' : 'pose']);
    },
    staticReference: { path: '/reference.png', sha256: 'reference-hash' },
    excludedBounds: () => [10, 20, 30, 40], imageHelper,
    hash: path => `hash:${path}`,
    save: (path, value) => { assert.equal(saved.has(path), false); saved.set(path, structuredClone(value)); },
    compare: async (first, second) => {
      events.push(['compare', first, second]);
      await setImmediate();
      return { passed: compareResults.length ? compareResults.shift() : true };
    },
    warmupFrames: () => [0, 69, 138, 207, 275, 0],
    runCaptureOverlap: callbacks => runCaptureOverlap({ ...callbacks,
      acquire: async (entry, options) => {
        unfinished.add(entry.label);
        maximum = Math.max(maximum, unfinished.size);
        acquired.push(entry.frame);
        return callbacks.acquire(entry, options);
      },
      complete: async (entry, value) => {
        const result = await callbacks.complete(entry, value);
        completed.push(entry.frame);
        return result;
      },
      commit: async (entry, value) => {
        await callbacks.commit(entry, value);
        committed.push(entry.frame);
        unfinished.delete(entry.label);
      },
    }),
  };
  const api = Function(...Object.keys(bindings), `let nativeIcc; ${declarations}
    return { acquireCapture, completeCapture, capture, captureSequence, warm, calibrate, action,
      changeContext: () => { viewport = { width: 1, height: 1 }; validatingProfile = false; staticReference = null; } };`)(...Object.values(bindings));
  return { ...api, events, saved, initial, acquired, completed, committed, unfinished,
    stats: () => ({ maximum, activeOperations }), interrupt: error => { interrupted = error; } };
}

test('preflight acquisition preserves row-major browser order and defers all image work', async () => {
  for (const rotation of [0, 90]) {
    const run = fixture({ rotation });
    const acquired = await run.acquireCapture(39, 7, '0007', rotation, '/capture', run.initial);
    const browser = run.events.filter(([name]) => ['switch_tab', 'setFrame', 'setScrollPixels', 'screenshot'].includes(name));
    const rows = rotation === 90 ? [162] : [0, 1182];
    assert.deepEqual(browser, rows.flatMap((y, row) => [
      ['switch_tab', 'owned-tab'], ['setFrame', 7], ['setScrollPixels', 0, y], ['screenshot', `/capture/0007-${row}-0.png`],
    ]));
    assert.equal(run.events.some(([name]) => name === 'image-start'), false);
    assert.deepEqual(acquired.tiles.map(({ row, col }) => [row, col]), rows.map((_, row) => [row, 0]));
    run.changeContext();
    const result = await run.completeCapture(acquired);
    assert.deepEqual(Object.keys(result), ['id', 'frame', 'path', 'sha256', 'metadata', 'stitchReport', 'selection']);
    const metadata = run.saved.get(result.metadata);
    assert.equal(metadata.profile, 'fixture');
    assert.equal(metadata.rows, rows.length);
    for (const tile of metadata.tiles) {
      assert.deepEqual(Object.keys(tile), ['path', 'sha256', 'row', 'col', 'originX', 'originY', 'viewportWidth', 'viewportHeight', 'iccSha256', 'snapshot']);
      assert.equal(tile.iccSha256, 'icc');
      assert.equal(tile.viewportWidth, 3328);
      assert.equal(tile.viewportHeight, 2120);
      assert.equal(Object.hasOwn(tile.snapshot, 'actionResult'), false);
    }
    if (rotation === 90) assert.deepEqual(metadata.backgroundReference,
      { path: '/reference.png', sha256: 'reference-hash', excludedBounds: [10, 20, 30, 40] });
  }
});

test('preflight action results are token-bound and never enter saved snapshots', async () => {
  const run = fixture({ staleResult: true });
  await assert.rejects(run.acquireCapture(39, 0, '0000', 0, '/capture', run.initial), /missing or stale/);
  assert.equal(run.events.some(([name]) => name === 'screenshot'), false);
});

test('preflight overlaps exactly six warmups with bounded serial processing', async () => {
  const run = fixture();
  const result = await run.warm(39, 0, '/capture', run.initial);
  const frames = [0, 69, 138, 207, 275, 0];
  assert.deepEqual(result.map(sample => sample.frame), frames);
  assert.deepEqual(run.acquired, frames);
  assert.deepEqual(run.completed, frames);
  assert.deepEqual(run.committed, frames);
  assert.equal(run.stats().maximum, 2);
  assert.equal(run.stats().activeOperations, 0);
  assert.equal(run.unfinished.size, 0);
  const stitchStart = run.events.findIndex(event => event[0] === 'image-start' && event[1] === 'stitch');
  const stitchEnd = run.events.findIndex(event => event[0] === 'image-end' && event[1] === 'stitch');
  assert.ok(run.events.slice(stitchStart + 1, stitchEnd).some(event => event[0] === 'screenshot' && event[1].includes('warmup-1')));
  assert.equal(run.events.some(event => event[0] === 'image-start' && event[1] === 'prepare'), false);
});

test('preflight commits all five prepared samples in their original report order', async () => {
  const run = fixture({ rotation: 90 });
  const frames = [0, 69, 138, 207, 275];
  const samples = [];
  const result = await run.captureSequence(39, frames.map(frame => ({ frame, label: String(frame).padStart(4, '0') })),
    90, '/capture', run.initial, { prepare: true, results: samples });
  assert.equal(result, samples);
  assert.deepEqual(samples.map(sample => sample.frame), frames);
  assert.deepEqual(samples.map(sample => sample.prepared.path), frames.map(frame => `/capture/${String(frame).padStart(4, '0')}-p3-2160.png`));
  assert.deepEqual(run.committed, frames);
  assert.equal(run.stats().maximum, 2);
  assert.equal(run.stats().activeOperations, 0);
});

test('preflight rejects invalid native geometry or ICC without committing the failing frame', async () => {
  for (const invalid of [{ width: 1, height: 2120, icc: { sha256: 'icc' } }, { width: 3328, height: 2120, icc: { sha256: 'changed' } }]) {
    const run = fixture({ inspect: ({ input }) => input.includes('/0001-') ? invalid : undefined });
    const samples = [];
    await assert.rejects(run.captureSequence(39, [0, 1, 2, 3].map(frame => ({ frame, label: `000${frame}` })),
      0, '/capture', run.initial, { results: samples }), /geometry or ICC|display ICC changed/);
    assert.deepEqual(samples.map(sample => sample.frame), [0]);
    assert.deepEqual(run.committed, [0]);
    assert.equal(run.acquired.includes(3), false);
    assert.equal(run.stats().activeOperations, 0);
    const count = run.events.length;
    await setImmediate();
    assert.equal(run.events.length, count);
  }
});

test('preflight waits for earlier image work after speculative acquisition fails', async () => {
  const failure = new Error('Screenshot failed');
  const run = fixture({ screenshot: ({ path }) => { if (path.includes('/0001-')) throw failure; } });
  const samples = [];
  await assert.rejects(run.captureSequence(39, [0, 1, 2].map(frame => ({ frame, label: `000${frame}` })),
    0, '/capture', run.initial, { prepare: true, results: samples }), error => error === failure);
  assert.deepEqual(samples.map(sample => sample.frame), [0]);
  assert.deepEqual(run.committed, [0]);
  assert.equal(run.stats().activeOperations, 0);
  assert.equal(run.acquired.includes(2), false);
});

test('preflight requires stitch success and byte-exact ICC preservation before committing', async () => {
  for (const stitch of [{ passed: false, iccPreservedByteForByte: true }, { passed: true, iccPreservedByteForByte: false }]) {
    const run = fixture({ stitch });
    await assert.rejects(run.captureSequence(39, [0, 1, 2].map(frame => ({ frame, label: `000${frame}` })),
      0, '/capture', run.initial), /Native stitch or lossless transpose failed/);
    assert.deepEqual(run.committed, []);
    assert.equal(run.stats().activeOperations, 0);
    assert.equal(run.saved.has('/capture/0000-stitch.json'), false);
    assert.equal(run.acquired.includes(2), false);
  }
});

test('preflight gives earlier processing failure priority and settles both branches', async () => {
  const failure = new Error('Native stitch or lossless transpose failed');
  const later = new Error('Screenshot failed');
  const run = fixture({
    screenshot: ({ path }) => { if (path.includes('/0001-')) throw later; },
    operation: ({ name }) => { if (name === 'stitch') throw failure; },
  });
  await assert.rejects(run.captureSequence(39, [0, 1, 2].map(frame => ({ frame, label: `000${frame}` })),
    0, '/capture', run.initial), error => error === failure);
  assert.deepEqual(run.committed, []);
  assert.equal(run.stats().activeOperations, 0);
  const count = run.events.length;
  await setImmediate();
  assert.equal(run.events.length, count);
});

test('preflight interruption settles capture and processing before returning', async () => {
  const failure = new Error('Interrupted by SIGTERM');
  const run = fixture({ screenshot: ({ path, interrupt }) => { if (path.includes('/0001-')) interrupt(failure); } });
  await assert.rejects(run.captureSequence(39, [0, 1, 2].map(frame => ({ frame, label: `000${frame}` })),
    0, '/capture', run.initial), error => error === failure);
  assert.deepEqual(run.committed, []);
  assert.equal(run.stats().activeOperations, 0);
  const count = run.events.length;
  await setImmediate();
  assert.equal(run.events.length, count);
});

test('preflight calibration retains sequential comparison decisions and required exact controls', async () => {
  for (const baseline of [undefined, '/baseline.png']) {
    const run = fixture({ compareResults: [false, true, true] });
    const result = await run.calibrate(39, 0, '/capture', run.initial, baseline);
    assert.equal(result.controls.length, 3);
    const comparisons = run.events.filter(([name]) => name === 'compare');
    assert.equal(comparisons.length, baseline ? 3 : 2);
    assert.deepEqual(result.controls.map(control => control.repeat?.passed), baseline ? [false, true, true] : [undefined, false, true]);
    assert.equal(result.baseline, baseline || '/capture/start-control-2.png');
    assert.deepEqual(run.acquired, []);
    for (let index = 0; index < run.events.length; index += 1) {
      if (run.events[index][0] !== 'compare') continue;
      const previous = run.events.slice(0, index).filter(event => event[0] === 'image-end').at(-1);
      assert.equal(previous[1], 'stitch');
    }
  }
});
