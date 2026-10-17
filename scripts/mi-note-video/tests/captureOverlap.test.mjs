import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runCaptureOverlap } from '../capture-overlap.mjs';
import { frameScrollAction } from '../frame-scroll-action.mjs';

const source = readFileSync(new URL('../capture.mjs', import.meta.url), 'utf8');
const declaration = (name, next) => {
  const start = source.indexOf(`  const ${name} = `);
  const end = source.indexOf(`  const ${next} = `, start);
  assert.ok(start >= 0 && end > start, `Missing capture declaration: ${name}`);
  return source.slice(start, end);
};

test('capture overlaps the next acquisition with serial QA and holds at most two unfinished frames', async () => {
  const unfinished = new Set();
  const acquired = [];
  const completed = [];
  const committed = [];
  let acquiring = false;
  let completing;
  let overlap = 0;
  let maximum = 0;
  await runCaptureOverlap({ frames: [1, 2, 3, 4],
    acquire: async (frame, { check }) => {
      check();
      assert.equal(acquiring, false);
      acquiring = true;
      unfinished.add(frame);
      maximum = Math.max(maximum, unfinished.size);
      if (completing !== undefined) {
        assert.equal(completing, frame - 1);
        overlap += 1;
      }
      acquired.push(frame);
      await setImmediate();
      check();
      acquiring = false;
      return { frame };
    },
    complete: async (frame, acquired) => {
      assert.equal(completing, undefined);
      assert.deepEqual(acquired, { frame });
      completing = frame;
      await setImmediate();
      completed.push(frame);
      completing = undefined;
      return { frame, passed: true };
    },
    commit: async (frame, result) => {
      assert.deepEqual(result, { frame, passed: true });
      assert.equal(frame, committed.length + 1);
      committed.push(frame);
      unfinished.delete(frame);
    } });
  assert.deepEqual(acquired, [1, 2, 3, 4]);
  assert.deepEqual(completed, acquired);
  assert.deepEqual(committed, acquired);
  assert.equal(maximum, 2);
  assert.equal(overlap, 3);
  assert.equal(unfinished.size, 0);
});

test('failed QA cancels and drains the speculative acquisition before returning its original failure', async () => {
  const failure = new Error('Static exterior QA failed');
  const committed = [];
  const completed = [];
  const acquired = [];
  let speculativeStopped = false;
  let speculativeActive = false;
  await assert.rejects(runCaptureOverlap({ frames: [1, 2, 3, 4],
    acquire: async (frame, { check }) => {
      acquired.push(frame);
      if (frame === 3) {
        speculativeActive = true;
        try {
          await setImmediate();
          check();
          assert.fail('Acquisition must stop at its next browser boundary');
        } finally {
          speculativeActive = false;
          speculativeStopped = true;
        }
      }
      return frame;
    },
    complete: async frame => {
      completed.push(frame);
      if (frame === 2) throw failure;
      return frame;
    },
    commit: async frame => { committed.push(frame); } }), error => error === failure);
  assert.equal(speculativeActive, false);
  assert.equal(speculativeStopped, true);
  assert.deepEqual(acquired, [1, 2, 3]);
  assert.deepEqual(completed, [1, 2]);
  assert.deepEqual(committed, [1]);
});

test('an acquisition failure retains only the already validated prefix', async () => {
  const failure = new Error('Rejected native PNG header');
  const events = [];
  await assert.rejects(runCaptureOverlap({ frames: [1, 2, 3],
    acquire: async frame => {
      events.push(`acquire-${frame}`);
      if (frame === 2) throw failure;
      return frame;
    },
    complete: async frame => {
      await setImmediate();
      events.push(`complete-${frame}`);
      return frame;
    },
    commit: async frame => { events.push(`commit-${frame}`); } }), error => error === failure);
  assert.deepEqual(events, ['acquire-1', 'acquire-2', 'complete-1', 'commit-1']);
});

test('simultaneous failures report the earlier frame and never checkpoint the speculative frame', async () => {
  const prior = new Error('Tile overlap/seam QA failed');
  const later = new Error('Safari MCP exited');
  let acquisitionSettled = false;
  await assert.rejects(runCaptureOverlap({ frames: [1, 2],
    acquire: async frame => {
      if (frame === 2) {
        await setImmediate();
        acquisitionSettled = true;
        throw later;
      }
      return frame;
    },
    complete: async () => { throw prior; },
    commit: async () => { assert.fail('Failed QA cannot commit'); } }), error => error === prior);
  assert.equal(acquisitionSettled, true);
});

test('checkpoint failure leaves the next tile set unprocessed and stops further admission', async () => {
  const failure = new Error('Checkpoint failed');
  const acquired = [];
  const completed = [];
  await assert.rejects(runCaptureOverlap({ frames: [1, 2, 3],
    acquire: async frame => { acquired.push(frame); return frame; },
    complete: async frame => { completed.push(frame); return frame; },
    commit: async () => { throw failure; } }), error => error === failure);
  assert.deepEqual(acquired, [1, 2]);
  assert.deepEqual(completed, [1]);
});

test('interruption drains both sides without committing a completed but uncheckpointed frame', async () => {
  const failure = new Error('Interrupted');
  let interrupted = false;
  let completed = false;
  let acquisitionStopped = false;
  await assert.rejects(runCaptureOverlap({ frames: [1, 2, 3],
    check: () => { if (interrupted) throw failure; },
    acquire: async (frame, { check }) => {
      if (frame === 2) {
        interrupted = true;
        try { check(); } finally { acquisitionStopped = true; }
      }
      return frame;
    },
    complete: async frame => { await setImmediate(); completed = true; return frame; },
    commit: async () => { assert.fail('Interrupted capture cannot commit'); } }), error => error === failure);
  assert.equal(completed, true);
  assert.equal(acquisitionStopped, true);
});

test('empty and single-frame queues finish without acquiring a speculative extra frame', async () => {
  for (const frames of [[], [275]]) {
    const events = [];
    await runCaptureOverlap({ frames,
      acquire: async frame => { events.push(['acquire', frame]); return frame; },
      complete: async frame => { events.push(['complete', frame]); return frame; },
      commit: async frame => { events.push(['commit', frame]); } });
    assert.deepEqual(events, frames.length ? [['acquire', 275], ['complete', 275], ['commit', 275]] : []);
  }
});

test('upright tiles batch frame and scroll while sideways preserves two actions and row-major order', async () => {
  for (const singleViewportCapture of [false, true]) {
    const trace = [];
    const initial = { dpr: 2, stageRect: { x: -16, y: -32 } };
    const dimensions = { width: 3200, height: 2200 };
    const bindings = {
      join, frameScrollAction, cache: '/capture', nativeRecoveryMilliseconds: 120000, nativeIcc: 'icc',
      randomUUID: () => 'uuid', existsSync: () => false, checkActive: () => {},
      options: { singleViewportCapture, landscapeBlackCapture: false },
      savedFrames: new Map([[1, new Map([[0, {}]])]]), profile: { id: 'fixture', rotationDegrees: 0 },
      captureScale: 3, capturedSize: 3240, physicalInteger: Math.round,
      mkdirSync: () => {}, writeFileSync: () => {}, renameSync: () => {}, hash: () => 'hash',
      knownStaticReference: () => ({ path: '/reference', sha256: 'reference' }), staticBounds: () => [0, 0, 10, 10],
      safari: { call: async (method, args) => { trace.push([method, method === 'screenshot' ? args.full_page : args]); } },
      safariAction: async (expression, id, frame, predicate, check, includeActionResult = false) => {
        check();
        const scroll = expression.includes('setScrollPixels') ? expression.match(/\((\d+),(\d+)\)/).slice(1).map(Number) : [0, 0];
        const snapshot = { ...initial, scrollPixels: { x: scroll[0], y: scroll[1] } };
        assert.equal(predicate(snapshot), true);
        trace.push(['action', expression, id, frame]);
        return includeActionResult ? { snapshot, result: { pose: initial, scrolled: snapshot } } : snapshot;
      },
      singleViewportScroll: () => ({ x: 64, y: 128 }), assertSnapshot: () => {},
      readPngDimensions: () => dimensions,
    };
    const acquire = Function(...Object.keys(bindings), `${declaration('safariScreenshot', 'captureFrameTiles')}
      ${declaration('captureFrameTiles', 'stitchCapturedFrame')}
      return captureFrameTiles;`)(...Object.values(bindings));
    const grid = singleViewportCapture ? { xs: [0], ys: [0] } : { xs: [0], ys: [0, 1800] };
    const result = await acquire({ tab: 'owned-tab', id: 1, frame: 7, label: '0007', file: '/raw/0007.png',
      initial, grid, screenshotDimensions: dimensions, captureRunId: 'fixture', deferRecovery: true });
    const expected = grid.ys.flatMap(y => [
      ['switch_tab', 'owned-tab'],
      ...(singleViewportCapture ? [
        ['action', 'window.miNoteCaptureComparison.setFrame(7)', 1, 7],
        ['action', 'window.miNoteCaptureComparison.setScrollPixels(64,128)', 1, 7],
      ] : [['action', frameScrollAction({ cardId: 1, frame: 7, scroll: { x: 0, y } }), 1, 7]]),
      ['screenshot', false],
    ]);
    assert.deepEqual(trace, expected);
    assert.deepEqual(result.records.map(({ row, col }) => [row, col]), grid.ys.map((_, row) => [row, 0]));
    for (const record of result.records) assert.equal(Object.hasOwn(record.snapshot, 'result'), false);
  }
});

function screenshotFixture({ invalidSnapshot, cancelAfterValidation = false, rejectedHeader = false, deferRecovery = false } = {}) {
  const events = [];
  const dimensions = { width: 3200, height: 2200 };
  const scroll = { x: 0, y: 1800 };
  const initial = { marker: 'initial' };
  const snapshots = { pose: { marker: 'pose' }, scrolled: { marker: 'scrolled' },
    final: { marker: 'final', scrollPixels: scroll } };
  const failure = new Error('Capture snapshot failed validation');
  const cancelled = new Error('Acquisition cancelled');
  let validations = 0;
  let captures = 0;
  const bindings = {
    join, frameScrollAction, cache: '/capture', nativeRecoveryMilliseconds: 120000,
    randomUUID: () => 'uuid', existsSync: () => false, checkActive: () => {},
    options: { singleViewportCapture: false }, savedFrames: new Map([[39, new Map()]]),
    safari: { call: async (method, args) => { events.push([method, args]); if (method === 'screenshot') captures += 1; } },
    safariAction: async (expression, id, frame, predicate, check, includeActionResult) => {
      check();
      assert.equal(includeActionResult, true);
      assert.equal(expression, frameScrollAction({ cardId: 39, frame: 7, scroll }));
      assert.equal(predicate(snapshots.final), true);
      events.push(['action']);
      return { snapshot: snapshots.final, result: { pose: snapshots.pose, scrolled: snapshots.scrolled } };
    },
    assertSnapshot: (snapshot, id, frame, baseline, expectedScroll) => {
      events.push(['validate', snapshot?.marker]);
      assert.equal(id, 39);
      assert.equal(frame, 7);
      assert.equal(baseline, initial);
      assert.deepEqual(expectedScroll, snapshot === snapshots.pose ? undefined : scroll);
      validations += 1;
      if (snapshot?.marker === invalidSnapshot) throw failure;
    },
    readPngDimensions: () => rejectedHeader && captures === 1 ? { width: 10, height: 10 } : dimensions,
    renameSync: (...args) => events.push(['rename', ...args]),
    appendFileSync: (...args) => events.push(['rejected', ...args]),
    console: { log: () => {}, error: () => {} }, delay: async value => events.push(['delay', value]),
    recoverNativeCapture: async (context, remount) => { events.push(['recover', context]); await remount(); },
    remountCard: async (...args) => events.push(['remount', ...args]),
  };
  const capture = Function(...Object.keys(bindings), `${declaration('safariScreenshot', 'captureFrameTiles')}return safariScreenshot;`)(...Object.values(bindings));
  return { events, failure, cancelled, capture: () => capture({ tab: 'owned-tab', id: 39, frame: 7,
    row: 1, col: 0, scroll, file: '/tile.png', initial, expectedDimensions: dimensions, deferRecovery,
    checkCapture: () => { if (cancelAfterValidation && validations >= 3) throw cancelled; } }) };
}

test('batched upright capture validates the intermediate, scrolled, and final snapshots before screenshot', async () => {
  for (const invalidSnapshot of ['pose', 'scrolled', 'final']) {
    const fixture = screenshotFixture({ invalidSnapshot });
    await assert.rejects(fixture.capture(), error => error === fixture.failure);
    assert.equal(fixture.events.some(([event]) => event === 'screenshot'), false);
    assert.equal(fixture.events.some(([event]) => event === 'rename'), false);
  }
});

test('batched upright capture checks cancellation again after validation and before screenshot', async () => {
  const fixture = screenshotFixture({ cancelAfterValidation: true });
  await assert.rejects(fixture.capture(), error => error === fixture.cancelled);
  assert.deepEqual(fixture.events.map(([event]) => event), ['switch_tab', 'action', 'validate', 'validate', 'validate']);
});

test('rejected native PNGs retain owned-tab reselection, recovery, and the full repeated batch', async () => {
  const fixture = screenshotFixture({ rejectedHeader: true });
  const result = await fixture.capture();
  assert.equal(result.captureAttempts, 2);
  assert.deepEqual(fixture.events.map(([event]) => event), [
    'switch_tab', 'action', 'validate', 'validate', 'validate', 'screenshot', 'rejected',
    'switch_tab', 'delay', 'recover', 'remount', 'action', 'validate', 'validate', 'validate', 'screenshot', 'rename',
  ]);
  assert.match(fixture.events.find(([event]) => event === 'recover')[1].cause.message, /Rejected native PNG header/);
});

test('speculative acquisition defers header recovery and does not start another frame/scroll batch', async () => {
  const fixture = screenshotFixture({ rejectedHeader: true, deferRecovery: true });
  await assert.rejects(fixture.capture(), /Rejected native PNG header/);
  assert.deepEqual(fixture.events.map(([event]) => event), [
    'switch_tab', 'action', 'validate', 'validate', 'validate', 'screenshot', 'rejected', 'switch_tab', 'delay',
  ]);
});

test('static-check requests keep the original protocol unless the caller explicitly opts in', async () => {
  const requests = [];
  const bindings = {
    join, cache: '/capture', runId: 'run', randomUUID: () => 'uuid', capturedSize: 3240,
    options: { landscapeBlackCapture: false, nft2Tilt: true }, captureScale: 3,
    knownStaticReference: () => ({ path: '/reference.png', sha256: 'reference' }),
    staticBounds: () => [10, 20, 30, 40], writeFileSync: () => {},
    imageHelper: async (...args) => { requests.push(args); return { passed: true }; },
  };
  const checkStatic = Function(...Object.keys(bindings), `${declaration('checkStatic', 'auditNative')}return checkStatic;`)(...Object.values(bindings));
  await checkStatic(['/raw/0007.png'], {}, '0007');
  await checkStatic(['/raw/0007.png'], {}, 'arbitrary-label', true);
  await checkStatic(['/proof.png'], {}, 'control', false);
  assert.equal(requests.length, 3);
  assert.equal(Object.hasOwn(requests[0][1], 'fastStaticCheck'), false);
  assert.equal(requests[1][1].fastStaticCheck, true);
  assert.equal(Object.hasOwn(requests[2][1], 'fastStaticCheck'), false);
  for (const [operation, args, options] of requests) {
    assert.equal(operation, 'static-check');
    assert.equal(args.referenceSha256, 'reference');
    assert.deepEqual(args.bounds, [10, 20, 30, 40]);
    assert.equal(args.expansionPixels, 240);
    assert.equal(options.timeoutMilliseconds, 122000);
  }
});

test('warmup, controls, and frame zero use original static checks while explicit steady frames opt in', async () => {
  const checks = [];
  const bindings = {
    join, cache: '/capture', nativeIcc: 'icc', deliverySize: 2160, deliverySpaces: ['p3'], writeFileSync: () => {},
    imageHelper: async () => ({ passed: true, icc: { sha256: 'icc' }, metadata: '/metadata.json' }),
    checkStatic: async (...args) => { checks.push(args); return { passed: true }; },
  };
  const stitch = Function(...Object.keys(bindings), `${declaration('stitchCapturedFrame', 'captureJoinedFrame')}return stitchCapturedFrame;`)(...Object.values(bindings));
  const base = { id: 40, frame: 0, file: '/frame.png', initial: {}, captureRunId: 'run', attempt: 1,
    metadataPath: '/metadata.json', records: [{ snapshot: {} }] };
  for (const label of ['raster-warmup-0', 'before', '0000', 'after-calibration-1', 'after']) await stitch({ ...base, label });
  await stitch({ ...base, frame: 1, label: '0001', fastStaticCheck: true });
  assert.deepEqual(checks.map(args => args[3]), [false, false, false, false, false, true]);
});

test('only steady output frames one onward opt in through the overlap completion call', async () => {
  const start = source.indexOf('await runCaptureOverlap({ frames:');
  const tail = 'commit: commitFrame });';
  const end = source.indexOf(tail, start) + tail.length;
  assert.ok(start >= 0 && end > start);
  const acquired = [];
  const completed = [];
  const committed = [];
  const bindings = {
    join, runCaptureOverlap, preset: { frames: 4 }, checkActive: () => {}, id: 40, tab: 'owned', initial: {},
    grid: { xs: [0], ys: [0, 1800] }, screenshotDimensions: { width: 3200, height: 2200 }, raw: '/raw',
    savedFrames: new Map([[40, new Map([[0, {}]])]]),
    captureFrameTiles: async args => { acquired.push(args); return args; },
    stitchCapturedFrame: async args => { completed.push(args); return args; },
    commitFrame: async frame => { committed.push(frame); },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await AsyncFunction(...Object.keys(bindings), source.slice(start, end))(...Object.values(bindings));
  assert.deepEqual(acquired.map(item => item.frame), [1, 2, 3]);
  assert.deepEqual(completed.map(item => [item.frame, item.fastStaticCheck]), [[1, true], [2, true], [3, true]]);
  assert.deepEqual(committed, [1, 2, 3]);
  assert.equal(acquired.some(item => Object.hasOwn(item, 'fastStaticCheck')), false);
});
