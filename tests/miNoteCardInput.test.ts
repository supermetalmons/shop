import assert from 'node:assert/strict';
import test from 'node:test';
import { createMiNoteCardInput } from '../src/lib/miNoteCardInput.ts';
import { createMiNoteRevealState, reduceMiNoteReveal } from '../src/lib/miNoteCardReveal.ts';
import { getTouchstartGuardResult } from '../src/lib/mobileInteractionGuards.ts';

function pointer(overrides: Partial<PointerEvent> = {}) {
  return {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 100,
    preventDefault() {},
    ...overrides,
  };
}

test('four rapid mobile taps unseal even when synthetic clicks are suppressed globally', () => {
  let state = createMiNoteRevealState();
  const input = createMiNoteCardInput(() => { state = reduceMiNoteReveal(state, { type: 'activate' }); });
  let lastTouchStartTime: number | null = null;
  for (const [index, currentTime] of [1000, 1100, 1200, 1300].entries()) {
    const event = pointer();
    input.onPointerDown(event);
    const guard = getTouchstartGuardResult({ currentTime, isMobile: true, lastTouchStartTime, sameTarget: true });
    lastTouchStartTime = guard.nextLastTouchStartTime;
    input.onPointerUp(event);
    if (!guard.shouldPrevent) input.onClick({ detail: 1, preventDefault() {} });
    assert.equal(state.taps, index + 1);
    assert.equal(state.stage, index === 3 ? 'seal-peeling' : 'sealed');
  }
  state = reduceMiNoteReveal(state, { type: 'ready', ready: true });
  state = reduceMiNoteReveal(state, { type: 'seal-finished' });
  assert.equal(state.stage, 'interactive');
  assert.equal(state.folderPose, 1);
});

test('mouse, touch and pen activate on release exactly once with the release event', () => {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    const received: unknown[] = [];
    let preventedClicks = 0;
    let preventedReleases = 0;
    const input = createMiNoteCardInput(event => { received.push(event); });
    const event = pointer({ pointerType, preventDefault() { preventedReleases += 1; } });
    input.onPointerDown(event);
    input.onPointerUp(event);
    input.onClick({ detail: 1, preventDefault() { preventedClicks += 1; } });
    input.onClick({ detail: 2, preventDefault() { preventedClicks += 1; } });
    assert.deepEqual(received, [event], pointerType);
    assert.equal(preventedReleases, 1, pointerType);
    assert.equal(preventedClicks, 2, pointerType);
  }
});

test('five pixels remains a tap while larger movement suppresses activation for every pointer type', () => {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    let activations = 0;
    const input = createMiNoteCardInput(() => { activations += 1; });
    input.onPointerDown(pointer({ pointerType }));
    input.onPointerUp(pointer({ pointerType, clientX: 103, clientY: 104 }));
    assert.equal(activations, 1, pointerType);
    input.onPointerDown(pointer({ pointerType }));
    input.onPointerUp(pointer({ pointerType, clientX: 104, clientY: 104 }));
    input.onClick({ detail: 1, preventDefault() {} });
    assert.equal(activations, 1, pointerType);
  }
});

test('dragging beyond the threshold and back permanently suppresses the tap', () => {
  let activations = 0;
  const input = createMiNoteCardInput(() => { activations += 1; });
  input.onPointerDown(pointer({ pointerType: 'mouse' }));
  input.onPointerMove(pointer({ pointerType: 'mouse', clientX: 106 }));
  input.onPointerMove(pointer({ pointerType: 'mouse' }));
  input.onPointerUp(pointer({ pointerType: 'mouse' }));
  input.onClick({ detail: 1, preventDefault() {} });
  assert.equal(activations, 0);
});

test('gesture callbacks include release displacement and finish before activation', () => {
  const events: unknown[] = [];
  const input = createMiNoteCardInput(() => { events.push('activate'); }, {
    onStart() { events.push('start'); },
    onMove(_event, position) { events.push(['move', position]); },
    onEnd(_event, position) { events.push(['end', position]); },
  });
  input.onPointerDown(pointer());
  input.onPointerMove(pointer({ clientX: 102 }));
  input.onPointerUp(pointer({ clientX: 103, clientY: 104 }));
  assert.deepEqual(events, [
    'start',
    ['move', { startX: 100, startY: 100, deltaX: 2, deltaY: 0, moved: false }],
    ['move', { startX: 100, startY: 100, deltaX: 3, deltaY: 4, moved: false }],
    ['end', { startX: 100, startY: 100, deltaX: 3, deltaY: 4, moved: false, cancelled: false }],
    'activate',
  ]);
});

test('release-only displacement updates the live fold before snapping and suppresses activation', () => {
  let phase = 0;
  let snappedPose = 0;
  let activations = 0;
  const input = createMiNoteCardInput(() => { activations += 1; }, {
    onMove(_event, { deltaX }) { phase = -deltaX / 200; },
    onEnd() { snappedPose = Math.round(phase); },
  });
  input.onPointerDown(pointer({ pointerType: 'mouse', clientX: 300 }));
  input.onPointerUp(pointer({ pointerType: 'mouse', clientX: 140 }));
  assert.equal(phase, 0.8);
  assert.equal(snappedPose, 1);
  assert.equal(activations, 0);
});

test('cancelling from the final movement callback does not finish or activate twice', () => {
  let activations = 0;
  const endings: boolean[] = [];
  const input = createMiNoteCardInput(() => { activations += 1; }, {
    onMove() { input.cancel(); },
    onEnd(_event, { cancelled }) { endings.push(cancelled); },
  });
  input.onPointerDown(pointer());
  input.onPointerUp(pointer());
  assert.deepEqual(endings, [true]);
  assert.equal(activations, 0);
});

test('secondary, non-left and unrelated pointers cannot replace or finish the active pointer', () => {
  let activations = 0;
  let starts = 0;
  const input = createMiNoteCardInput(() => { activations += 1; }, { onStart() { starts += 1; } });
  input.onPointerDown(pointer({ isPrimary: false }));
  input.onPointerDown(pointer({ button: 2 }));
  input.onPointerUp(pointer());
  assert.equal(starts, 0);
  assert.equal(activations, 0);
  input.onPointerDown(pointer());
  input.onPointerDown(pointer({ pointerId: 2, isPrimary: false }));
  input.onPointerDown(pointer({ pointerId: 3 }));
  input.onPointerMove(pointer({ pointerId: 2, clientX: 300 }));
  input.onPointerUp(pointer({ isPrimary: false }));
  input.onPointerUp(pointer({ button: 2 }));
  input.onPointerUp(pointer({ pointerId: 3 }));
  input.onPointerCancel(pointer({ pointerId: 2 }));
  input.onLostPointerCapture(pointer({ pointerId: 3 }));
  assert.equal(starts, 1);
  assert.equal(activations, 0);
  input.onPointerUp(pointer());
  assert.equal(activations, 1);
});

test('cancellation and capture loss finish once using the last position without activating', () => {
  for (const finish of ['onPointerCancel', 'onLostPointerCapture', 'cancel'] as const) {
    let activations = 0;
    const endings: unknown[] = [];
    const input = createMiNoteCardInput(() => { activations += 1; }, {
      onEnd(_event, position) { endings.push(position); },
    });
    input.onPointerDown(pointer());
    input.onPointerMove(pointer({ clientX: 120, clientY: 90 }));
    if (finish === 'cancel') input.cancel();
    else input[finish](pointer({ clientX: 0, clientY: 0 }));
    input.onPointerCancel(pointer());
    input.onLostPointerCapture(pointer());
    input.onPointerUp(pointer());
    input.onClick({ detail: 1, preventDefault() {} });
    assert.deepEqual(endings, [{ startX: 100, startY: 100, deltaX: 20, deltaY: -10, moved: true, cancelled: true }], finish);
    assert.equal(activations, 0, finish);
    input.onPointerDown(pointer());
    input.onPointerUp(pointer());
    assert.equal(activations, 1, finish);
  }
});

test('normal capture release after pointer up does not cancel a completed gesture', () => {
  const cancelled: boolean[] = [];
  const input = createMiNoteCardInput(() => {}, {
    onEnd(_event, position) { cancelled.push(position.cancelled); },
  });
  input.onPointerDown(pointer());
  input.onPointerUp(pointer());
  input.onLostPointerCapture(pointer());
  assert.deepEqual(cancelled, [false]);
});

test('rejected starts do not activate or receive gesture callbacks', () => {
  let accept = false;
  let activations = 0;
  const gestures: string[] = [];
  const input = createMiNoteCardInput(() => { activations += 1; }, {
    onStart() { return accept; },
    onMove() { gestures.push('move'); },
    onEnd() { gestures.push('end'); },
  });
  input.onPointerDown(pointer());
  input.onPointerMove(pointer());
  input.onPointerUp(pointer());
  input.onClick({ detail: 1, preventDefault() {} });
  assert.equal(activations, 0);
  assert.deepEqual(gestures, []);
  accept = true;
  input.onPointerDown(pointer());
  input.onPointerUp(pointer());
  assert.equal(activations, 1);
});

test('keyboard clicks activate without a pointer event before and after physical interactions', () => {
  const activations: unknown[] = [];
  const input = createMiNoteCardInput(event => { activations.push(event); });
  input.onClick({ detail: 0, preventDefault() {} });
  const event = pointer();
  input.onPointerDown(event);
  input.onPointerUp(event);
  input.onClick({ detail: 0, preventDefault() {} });
  assert.deepEqual(activations, [undefined, event, undefined]);
});
