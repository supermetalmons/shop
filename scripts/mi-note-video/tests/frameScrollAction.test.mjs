import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { frameScrollAction } from '../frame-scroll-action.mjs';

const source = readFileSync(new URL('../capture.mjs', import.meta.url), 'utf8');
const declaration = (name, next) => {
  const start = source.indexOf(`  const ${name} = `);
  const end = source.indexOf(`  const ${next} = `, start);
  assert.ok(start >= 0 && end > start, `Missing capture declaration: ${name}`);
  return source.slice(start, end);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};
const pose = () => ({ ready: true, paintReady: true, cardId: 39, frame: 7, nativePixels: true,
  viewport: { visibility: 'visible' }, scrollPixels: { x: 0, y: 0 }, marker: 'pose' });
const actionExpression = (pollMilliseconds = 30) => frameScrollAction({ cardId: 39, frame: 7, scroll: { x: 0, y: 1800 }, pollMilliseconds });
const execute = (api, timer = () => assert.fail('Ready poses must not add a wait')) => Function('window', 'setTimeout', `return ${actionExpression()};`)({ miNoteCaptureComparison: api }, timer);

test('frame/scroll batching awaits both existing paint operations in order and retains both snapshots', async () => {
  const framePaint = deferred();
  const scrollPaint = deferred();
  const events = [];
  const initial = pose();
  const final = { ...initial, scrollPixels: { x: 0, y: 1800 }, marker: 'scrolled' };
  let completed = false;
  const result = execute({
    setFrame: async frame => { events.push(['frame', frame]); await framePaint.promise; return initial; },
    setScrollPixels: async (x, y) => { events.push(['scroll', x, y]); await scrollPaint.promise; return final; },
  }).then(value => { completed = true; return value; });
  assert.deepEqual(events, [['frame', 7]]);
  assert.equal(completed, false);
  framePaint.resolve();
  await setImmediate();
  assert.deepEqual(events, [['frame', 7], ['scroll', 0, 1800]]);
  assert.equal(completed, false);
  scrollPaint.resolve();
  assert.deepEqual(await result, { pose: initial, scrolled: final });
});

test('transient intermediate readiness waits recover before scroll or screenshot', async () => {
  const cases = [null, ...[
    { ready: false }, { paintReady: false }, { cardId: 40 }, { frame: 8 }, { nativePixels: false },
    { nativePixels: 1 }, { nativePixels: 'true' }, { viewport: { visibility: 'hidden' } },
  ].map(change => ({ ...pose(), ...change }))];
  for (const invalid of cases) {
    const events = [];
    const pending = [];
    const ready = pose();
    const capture = execute({
      setFrame: async () => { events.push('frame'); return invalid; },
      snapshot: () => { events.push('snapshot'); return ready; },
      setScrollPixels: async () => { events.push('scroll'); return { ...ready, marker: 'scrolled' }; },
    }, (resolve, milliseconds) => { assert.equal(milliseconds, 30); pending.push(resolve); })
      .then(result => { events.push('screenshot'); return result; });
    await setImmediate();
    assert.deepEqual(events, ['frame']);
    assert.equal(pending.length, 1);
    pending.shift()();
    assert.equal((await capture).pose, ready);
    assert.deepEqual(events, ['frame', 'snapshot', 'scroll', 'screenshot']);
  }
});

test('hard pose errors propagate before scroll, including errors seen during readiness polling', async () => {
  for (const key of ['error', 'asyncError']) for (const duringPolling of [false, true]) {
    const failed = { ...pose(), [key]: 'asset or action failure' };
    const events = [];
    await assert.rejects(execute({
      setFrame: async () => duringPolling ? { ...pose(), ready: false } : failed,
      snapshot: () => { events.push('snapshot'); return failed; },
      setScrollPixels: async () => assert.fail('Failed poses must not scroll'),
    }, resolve => resolve()), /asset or action failure/);
    assert.deepEqual(events, duringPolling ? ['snapshot'] : []);
  }
});

test('readiness polling uses the requested interval and rejects a replaced capture harness', async () => {
  const pending = [];
  const browser = { miNoteCaptureComparison: {
    setFrame: async () => ({ ...pose(), viewport: { visibility: 'hidden' } }),
    snapshot: () => assert.fail('Replaced harness must not be read'),
    setScrollPixels: async () => assert.fail('Replaced harness must not scroll'),
  } };
  const result = Function('window', 'setTimeout', `return ${actionExpression(50)};`)(browser,
    (resolve, milliseconds) => { assert.equal(milliseconds, 50); pending.push(resolve); });
  await setImmediate();
  assert.equal(pending.length, 1);
  browser.miNoteCaptureComparison = { snapshot: () => pose() };
  const rejected = assert.rejects(result, /Capture tab changed/);
  pending.shift()();
  await rejected;
});

test('frame and scroll failures propagate without completing a batch', async () => {
  for (const failurePhase of ['frame', 'scroll']) {
    const failure = new Error(`${failurePhase} paint failed`);
    const events = [];
    await assert.rejects(execute({
      setFrame: async () => { events.push('frame'); if (failurePhase === 'frame') throw failure; return pose(); },
      setScrollPixels: async () => { events.push('scroll'); throw failure; },
    }), error => error === failure);
    assert.deepEqual(events, failurePhase === 'frame' ? ['frame'] : ['frame', 'scroll']);
  }
});

test('frame/scroll expressions reject invalid coordinates and identifiers before browser execution', () => {
  for (const value of [
    { cardId: 0, frame: 7, scroll: { x: 0, y: 1 } },
    { cardId: 39, frame: -1, scroll: { x: 0, y: 1 } },
    { cardId: 39, frame: '7);throw 1', scroll: { x: 0, y: 1 } },
    { cardId: 39, frame: 7, scroll: { x: 0.5, y: 1 } },
    { cardId: 39, frame: 7, scroll: { x: 0, y: -1 } },
    { cardId: 39, frame: 7, scroll: null },
    { cardId: 39, frame: 7, scroll: { x: 0, y: 1 }, pollMilliseconds: 0 },
  ]) assert.throws(() => frameScrollAction(value), /requires a card, frame/);
});

function pollingFixture({ staleFirstResult = false, interruptAfterLaunch = false } = {}) {
  const final = { ...pose(), scrollPixels: { x: 0, y: 1800 } };
  const browser = { __comparisonActionResult: { actionId: 'previous', value: 'previous' },
    miNoteCaptureComparison: { snapshot: () => final } };
  const diagnostics = [];
  let polls = 0;
  let waits = 0;
  let launched = false;
  let capturedAtLaunch;
  const interrupted = new Error('Acquisition cancelled');
  const safari = { evaluate: async expression => {
    const result = Function('window', 'location', 'document', expression)(browser,
      { origin: 'http://localhost:5179', pathname: '/scripts/mi-note-video/index.html' },
      { readyState: 'complete', visibilityState: 'visible' });
    if (expression.startsWith('if(!window.miNoteCaptureComparison)')) {
      launched = true;
      capturedAtLaunch = browser.__comparisonActionResult;
    } else {
      polls += 1;
      if (staleFirstResult && polls === 1) return { ...result, completedAction: 'current',
        actionResult: { actionId: 'previous', value: 'incorrect' } };
    }
    return result;
  } };
  const bindings = {
    safari, randomUUID: () => 'current', checkActive: () => {}, join, cache: '/fixture',
    writeFileSync: (...args) => diagnostics.push(args), console: { log: () => {}, error: () => {} },
    delay: async () => { waits += 1; await setImmediate(); },
  };
  const action = Function(...Object.keys(bindings), `${declaration('safariSnapshot', 'settleDisplayedImage')}return safariAction;`)(...Object.values(bindings));
  return { run: includeActionResult => action('({pose:"new pose",scrolled:"new scroll"})', 39, 7,
    state => state.scrollPixels.y === 1800, () => { if (launched && interruptAfterLaunch) throw interrupted; }, includeActionResult),
  state: () => ({ polls, waits, diagnostics, capturedAtLaunch }), interrupted };
}

test('capture rejects stale batched results and strips transport results from saved snapshots', async () => {
  const fixture = pollingFixture({ staleFirstResult: true });
  const result = await fixture.run(true);
  assert.deepEqual(result.result, { pose: 'new pose', scrolled: 'new scroll' });
  assert.equal(result.snapshot.completedAction, 'current');
  assert.equal(Object.hasOwn(result.snapshot, 'actionResult'), false);
  assert.equal(Object.hasOwn(result.snapshot, 'result'), false);
  assert.equal(fixture.state().capturedAtLaunch, null);
  assert.equal(fixture.state().polls, 2);
  assert.equal(fixture.state().waits, 1);
  assert.deepEqual(fixture.state().diagnostics, []);
});

test('ordinary capture actions retain the existing snapshot shape', async () => {
  const fixture = pollingFixture();
  const result = await fixture.run(false);
  assert.equal(result.cardId, 39);
  assert.equal(result.completedAction, 'current');
  assert.equal(Object.hasOwn(result, 'actionResult'), false);
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
  assert.equal(fixture.state().capturedAtLaunch, null);
});

test('cancellation after a batched launch stops before its first polling request', async () => {
  const fixture = pollingFixture({ interruptAfterLaunch: true });
  await assert.rejects(fixture.run(true), error => error === fixture.interrupted);
  assert.equal(fixture.state().polls, 0);
});

test('permanent intermediate unreadiness remains bounded by the existing visible and hidden deadlines', async () => {
  for (const visibility of ['visible', 'hidden']) {
    let milliseconds = 0;
    let scrolls = 0;
    const timers = [];
    const diagnostics = [];
    const state = { ...pose(), ready: false, paintReady: false, viewport: { visibility } };
    const browser = { miNoteCaptureComparison: {
      setFrame: async () => state,
      snapshot: () => state,
      setScrollPixels: async () => { scrolls += 1; return state; },
    } };
    const bindings = {
      safari: { evaluate: async expression => Function('window', 'location', 'document', 'setTimeout', expression)(browser,
        { origin: 'http://localhost:5179', pathname: '/scripts/mi-note-video/index.html' },
        { readyState: 'complete', visibilityState: visibility }, resolve => timers.push(resolve)) },
      randomUUID: () => 'current', checkActive: () => {}, join, cache: '/fixture',
      writeFileSync: (path, value) => diagnostics.push(JSON.parse(value)), console: { log: () => {}, error: () => {} },
      Date: { now: () => milliseconds },
      delay: async () => { milliseconds += 60000; timers.shift()?.(); await setImmediate(); },
    };
    const action = Function(...Object.keys(bindings), `${declaration('safariSnapshot', 'settleDisplayedImage')}return safariAction;`)(...Object.values(bindings));
    await assert.rejects(action(actionExpression(), 39, 7, () => true, () => {}, true), /did not become ready/);
    assert.equal(milliseconds, visibility === 'hidden' ? 120000 : 60000);
    assert.equal(scrolls, 0);
    assert.equal(diagnostics.length, visibility === 'hidden' ? 2 : 1);
    for (const diagnostic of diagnostics) assert.equal(Object.hasOwn(diagnostic.snapshot || diagnostic.lastSnapshot, 'actionResult'), false);
    browser.miNoteCaptureComparison = undefined;
    for (const resolve of timers.splice(0)) resolve();
    await setImmediate();
    assert.equal(browser.__comparisonAsyncError, 'Capture tab changed');
  }
});
