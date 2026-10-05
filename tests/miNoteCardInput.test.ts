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

test('two rapid mobile taps queue opening even when the second synthetic click is suppressed globally', () => {
  let state = createMiNoteRevealState();
  const input = createMiNoteCardInput(() => { state = reduceMiNoteReveal(state, { type: 'activate' }); });
  let lastTouchStartTime: number | null = null;
  for (const currentTime of [1000, 1100]) {
    const event = pointer();
    input.onPointerDown(event);
    const guard = getTouchstartGuardResult({ currentTime, isMobile: true, lastTouchStartTime, sameTarget: true });
    lastTouchStartTime = guard.nextLastTouchStartTime;
    input.onPointerUp(event);
    if (!guard.shouldPrevent) input.onClick({ detail: 1, preventDefault() {} });
    assert.equal(state.openRequested, currentTime === 1100);
  }
  assert.equal(state.stage, 'seal-falling');
  state = reduceMiNoteReveal(state, { type: 'ready', ready: true });
  state = reduceMiNoteReveal(state, { type: 'seal-finished' });
  assert.equal(state.stage, 'opening');
});

test('touch and pen activate once while their synthesized clicks are ignored', () => {
  for (const pointerType of ['touch', 'pen']) {
    let activations = 0;
    let preventedClicks = 0;
    const input = createMiNoteCardInput(() => { activations += 1; });
    const event = pointer({ pointerType });
    input.onPointerDown(event);
    input.onPointerUp(event);
    input.onClick({ detail: 1, preventDefault() { preventedClicks += 1; } });
    assert.equal(activations, 1);
    assert.equal(preventedClicks, 1);
  }
});

test('dragged, cancelled, secondary and unrelated pointers do not activate', () => {
  for (const finish of ['drag', 'release-drag', 'cancel', 'secondary', 'unrelated']) {
    let activations = 0;
    const input = createMiNoteCardInput(() => { activations += 1; });
    input.onPointerDown(pointer());
    if (finish === 'drag') input.onPointerMove(pointer({ clientX: 113 }));
    if (finish === 'cancel') input.onPointerCancel(pointer());
    input.onPointerUp(pointer({
      ...(finish === 'release-drag' ? { clientY: 113 } : {}),
      ...(finish === 'secondary' ? { isPrimary: false } : {}),
      ...(finish === 'unrelated' ? { pointerId: 2 } : {}),
    }));
    input.onClick({ detail: 1, preventDefault() {} });
    assert.equal(activations, 0, finish);
  }
});

test('mouse and keyboard clicks remain available after a touch without a synthesized click', () => {
  let activations = 0;
  const input = createMiNoteCardInput(() => { activations += 1; });
  input.onPointerDown(pointer());
  input.onPointerUp(pointer());
  input.onClick({ detail: 0, preventDefault() {} });
  assert.equal(activations, 2);
  input.onPointerDown(pointer({ pointerType: 'mouse' }));
  input.onPointerUp(pointer({ pointerType: 'mouse' }));
  assert.equal(activations, 2);
  input.onClick({ detail: 1, preventDefault() {} });
  assert.equal(activations, 3);
});
