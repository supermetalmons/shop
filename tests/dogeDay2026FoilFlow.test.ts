import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceDogeFoilFlow,
  createDogeFoilFlow,
  hitDogeFoilFlow,
  readyDogeFoilFlow,
  sampleDogeFoilFlow,
  type DogeFoilFlowState,
} from '../src/dogeDay2026/foilPackFlow.ts';

const DOGE_FOIL_HIT_DURATION_MS = 300;
const DOGE_FOIL_OPEN_DURATION_MS = 1300;

function hitAndRecover(state: DogeFoilFlowState, nowMs: number) {
  return advanceDogeFoilFlow(hitDogeFoilFlow(state, nowMs), nowMs + DOGE_FOIL_HIT_DURATION_MS);
}

function waitingFlow() {
  let state = createDogeFoilFlow();
  for (let index = 0; index < 3; index += 1) state = hitAndRecover(state, index * 1000);
  return state;
}

test('early readiness waits for three complete reversible hits', () => {
  let state = readyDogeFoilFlow(createDogeFoilFlow(), true, 0);
  for (let index = 0; index < 3; index += 1) {
    const start = index * 1000;
    state = hitDogeFoilFlow(state, start);
    assert.equal(state.variant, index);
    assert.equal(state.hitCount, index + 1);
    assert.equal(sampleDogeFoilFlow(state, start).hit, 0);
    assert.equal(sampleDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS * 0.2).hit, 1);
    assert.equal(advanceDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS - 1).stage, 'hit');
    state = advanceDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS);
    assert.equal(sampleDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS).hit, 0);
    assert.equal(state.stage, index < 2 ? 'sealed' : 'opening');
  }
  assert.equal(state.phaseStartedAtMs, 2300);
});

test('late readiness starts the final sequence from its beginning', () => {
  const waiting = waitingFlow();
  assert.equal(waiting.stage, 'waiting');
  assert.equal(advanceDogeFoilFlow(waiting, 100_000), waiting);
  const opening = readyDogeFoilFlow(waiting, true, 100_000);
  assert.equal(opening.stage, 'opening');
  assert.equal(opening.phaseStartedAtMs, 100_000);
  assert.equal(sampleDogeFoilFlow(opening, 100_000).tear, 0);
});

test('hits recover to the sealed pose and cycle variants while assets are unavailable', () => {
  let state = createDogeFoilFlow();
  for (let index = 0; index < 8; index += 1) {
    const start = index * 1000;
    state = hitDogeFoilFlow(state, start, index % 2 ? -0.75 : 0.75, 0.4);
    assert.equal(state.variant, index % 3);
    assert.equal(state.hitCount, index + 1);
    assert.equal(hitDogeFoilFlow(state, start + 50), state);
    const hit = sampleDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS * 0.2);
    const recovery = sampleDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS * 0.6);
    assert.ok(recovery.hit > 0 && recovery.hit < hit.hit);
    state = advanceDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS);
    const rest = sampleDogeFoilFlow(state, start + DOGE_FOIL_HIT_DURATION_MS);
    assert.equal(rest.hit, 0);
    assert.equal(rest.tear, 0);
    assert.equal(rest.discard, 0);
    assert.equal(rest.cardInteractive, false);
  }
});

test('readiness during a later hit waits for that hit to finish recovering', () => {
  let state = hitDogeFoilFlow(waitingFlow(), 4000);
  state = readyDogeFoilFlow(state, true, 4120);
  assert.equal(state.stage, 'hit');
  assert.equal(advanceDogeFoilFlow(state, 4299).stage, 'hit');
  const opening = advanceDogeFoilFlow(state, 4300);
  assert.equal(opening.stage, 'opening');
  assert.equal(opening.phaseStartedAtMs, 4300);
  assert.equal(sampleDogeFoilFlow(opening, 4300).tear, 0);
});

test('revoking readiness before recovery prevents opening', () => {
  let state = hitDogeFoilFlow(waitingFlow(), 4000);
  state = readyDogeFoilFlow(state, true, 4100);
  state = readyDogeFoilFlow(state, false, 4299);
  assert.equal(state.stage, 'hit');
  state = advanceDogeFoilFlow(state, 4300);
  assert.equal(state.stage, 'waiting');
  assert.equal(sampleDogeFoilFlow(state, 10_000).tear, 0);
});

test('final sequence tears, holds for 420 ms, then accelerates the pack down before allowing interaction', () => {
  const start = 4000;
  const state = readyDogeFoilFlow(waitingFlow(), true, start);
  const tearing = sampleDogeFoilFlow(state, start + 250);
  assert.equal(tearing.tear, 0.5);
  assert.equal(tearing.discard, 0);
  assert.ok(sampleDogeFoilFlow(state, start + 499).tear < 1);
  for (const elapsed of [500, 710, 919, 920]) {
    const held = sampleDogeFoilFlow(state, start + elapsed);
    assert.equal(held.tear, 1);
    assert.equal(held.discard, 0);
    assert.equal(held.cardInteractive, false);
  }
  const discardAt = (elapsed: number) => sampleDogeFoilFlow(state, start + 920 + elapsed).discard;
  assert.ok(discardAt(1) > 0);
  const firstQuarter = discardAt(95);
  const midpoint = discardAt(190);
  const lastQuarter = discardAt(285);
  assert.ok(firstQuarter > 0 && firstQuarter < midpoint);
  assert.ok(midpoint < 0.5 && midpoint < lastQuarter && lastQuarter < 1);
  assert.ok(lastQuarter - midpoint > midpoint - firstQuarter);
  assert.ok(1 - lastQuarter > lastQuarter - midpoint);
  assert.equal(advanceDogeFoilFlow(state, start + 1299).stage, 'opening');
  assert.equal(sampleDogeFoilFlow(state, start + 1299).cardInteractive, false);
  const revealed = advanceDogeFoilFlow(state, start + DOGE_FOIL_OPEN_DURATION_MS);
  assert.equal(revealed.stage, 'revealed');
  assert.deepEqual(sampleDogeFoilFlow(revealed, start + DOGE_FOIL_OPEN_DURATION_MS), {
    hit: 0, hitX: 0, hitY: 0, variant: 2, tear: 1, discard: 1, cardInteractive: true,
  });
  assert.equal(advanceDogeFoilFlow(revealed, 100_000), revealed);
  assert.equal(hitDogeFoilFlow(revealed, 100_000), revealed);
  assert.equal(readyDogeFoilFlow(revealed, true, 100_000), revealed);
});

test('lost readiness freezes an opening and resuming preserves its pose and remaining duration', () => {
  const opening = readyDogeFoilFlow(waitingFlow(), true, 4000);
  const before = sampleDogeFoilFlow(opening, 5000);
  const paused = readyDogeFoilFlow(opening, false, 5000);
  assert.equal(paused.stage, 'opening');
  assert.deepEqual(sampleDogeFoilFlow(paused, 100_000), before);
  const resumed = readyDogeFoilFlow(paused, true, 100_000);
  assert.deepEqual(sampleDogeFoilFlow(resumed, 100_000), before);
  assert.equal(advanceDogeFoilFlow(resumed, 100_299).stage, 'opening');
  assert.equal(advanceDogeFoilFlow(resumed, 100_300).stage, 'revealed');
});

test('reduced motion shortens recovery and reveal while preserving the same readiness gate', () => {
  let state = createDogeFoilFlow({ reducedMotion: true });
  for (let index = 0; index < 3; index += 1) {
    state = hitDogeFoilFlow(state, index * 200);
    assert.equal(sampleDogeFoilFlow(state, index * 200 + 36).hit, 0.3);
    state = advanceDogeFoilFlow(state, index * 200 + 180);
  }
  assert.equal(state.stage, 'waiting');
  state = readyDogeFoilFlow(state, true, 1000);
  assert.equal(advanceDogeFoilFlow(state, 1259).stage, 'opening');
  assert.equal(advanceDogeFoilFlow(state, 1260).stage, 'revealed');
});

test('flow state is immutable, stale events cannot rewind a phase, and reset creates an independent session', () => {
  const initial = Object.freeze(createDogeFoilFlow());
  const hit = Object.freeze(hitDogeFoilFlow(initial, 1000, 9, -9));
  assert.equal(hit.hitX, 1);
  assert.equal(hit.hitY, -1);
  assert.equal(sampleDogeFoilFlow(hit, -1000).hit, 0);
  const waiting = waitingFlow();
  const opening = Object.freeze(readyDogeFoilFlow(waiting, true, 4000));
  const paused = Object.freeze(readyDogeFoilFlow(opening, false, 4500));
  const resumed = readyDogeFoilFlow(paused, true, 4400);
  assert.deepEqual(sampleDogeFoilFlow(resumed, 4500), sampleDogeFoilFlow(paused, 4500));
  const reset = createDogeFoilFlow();
  assert.deepEqual(reset, initial);
  advanceDogeFoilFlow(opening, 100_000);
  readyDogeFoilFlow(opening, true, 100_000);
  assert.deepEqual(reset, initial);
  assert.equal(initial.hitCount, 0);
  assert.equal(hit.hitCount, 1);
  const invalid = hitDogeFoilFlow(reset, Number.NaN, Number.NaN, Number.POSITIVE_INFINITY);
  assert.equal(invalid.phaseStartedAtMs, 0);
  assert.equal(invalid.hitX, 0);
  assert.equal(invalid.hitY, 0);
});
