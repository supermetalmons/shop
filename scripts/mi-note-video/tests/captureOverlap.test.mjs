import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runCaptureOverlap } from '../capture-overlap.mjs';

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

test('split tile acquisition preserves browser calls, paint predicates, and row-major tile order', async () => {
  for (const singleViewportCapture of [false, true]) {
    const trace = [];
    const initial = { dpr: 2, stageRect: { x: -16, y: -32 } };
    const dimensions = { width: 3200, height: 2200 };
    const bindings = {
      join, cache: '/capture', nativeRecoveryMilliseconds: 120000, nativeIcc: 'icc',
      randomUUID: () => 'uuid', existsSync: () => false, checkActive: () => {},
      options: { singleViewportCapture, landscapeBlackCapture: false },
      savedFrames: new Map([[1, new Map([[0, {}]])]]), profile: { id: 'fixture', rotationDegrees: 0 },
      captureScale: 3, capturedSize: 3240, physicalInteger: Math.round,
      mkdirSync: () => {}, writeFileSync: () => {}, renameSync: () => {}, hash: () => 'hash',
      knownStaticReference: () => ({ path: '/reference', sha256: 'reference' }), staticBounds: () => [0, 0, 10, 10],
      safari: { call: async (method, args) => { trace.push([method, method === 'screenshot' ? args.full_page : args]); } },
      safariAction: async (expression, id, frame, predicate, check) => {
        check();
        const scroll = expression.includes('setScrollPixels') ? expression.match(/\((\d+),(\d+)\)/).slice(1).map(Number) : [0, 0];
        const snapshot = { ...initial, scrollPixels: { x: scroll[0], y: scroll[1] } };
        assert.equal(predicate(snapshot), true);
        trace.push(['action', expression, id, frame]);
        return snapshot;
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
      ['action', 'window.miNoteCaptureComparison.setFrame(7)', 1, 7],
      ['action', `window.miNoteCaptureComparison.setScrollPixels(${singleViewportCapture ? 64 : 0},${singleViewportCapture ? 128 : y})`, 1, 7],
      ['screenshot', false],
    ]);
    assert.deepEqual(trace, expected);
    assert.deepEqual(result.records.map(({ row, col }) => [row, col]), grid.ys.map((_, row) => [row, 0]));
  }
});
