import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CRATE_OPEN_DURATION_MS, CRATE_REDUCED_DURATION_MS, advanceCrateFlow, crateOpeningDuration,
  createCrateFlow, hitCrateFlow, pauseCrateFlow, readyCrateFlow, sampleCrateFlow, sampleCrateOpening,
} from '../src/ethereum/crate/crateFlow.ts';

test('three hits before readiness wait, then open automatically exactly once', () => {
  let state = createCrateFlow();
  for (const time of [10, 20, 30]) state = hitCrateFlow(state, time);
  assert.equal(state.stage, 'waiting');
  assert.equal(state.hitCount, 3);
  for (let index = 0; index < 100; index++) state = hitCrateFlow(state, 40 + index);
  assert.equal(state.hitCount, 3);
  state = readyCrateFlow(state, true, 5000);
  assert.equal(state.stage, 'opening');
  assert.equal(state.phaseStartedAtMs, 5000);
  state = hitCrateFlow(state, 5010);
  assert.equal(state.phaseStartedAtMs, 5000);
  state = readyCrateFlow(state, true, 5500);
  assert.equal(state.phaseStartedAtMs, 5000);
  state = advanceCrateFlow(state, 5000 + CRATE_OPEN_DURATION_MS);
  assert.equal(state.stage, 'revealed');
  assert.equal(hitCrateFlow(state, 10000).stage, 'revealed');
});

test('readiness arriving first still requires three distinct crate hits', () => {
  let state = readyCrateFlow(createCrateFlow(), true, 10);
  assert.equal(state.stage, 'sealed');
  state = hitCrateFlow(state, 20);
  state = hitCrateFlow(state, 21);
  assert.equal(state.stage, 'sealed');
  assert.equal(sampleCrateFlow(state, 3000).opening, 0);
  state = hitCrateFlow(state, 22);
  assert.equal(state.stage, 'opening');
  assert.equal(state.phaseStartedAtMs, 22);
});

test('suspension freezes opening time and ignores hits', () => {
  let state = readyCrateFlow(createCrateFlow(), true, 0);
  state = hitCrateFlow(hitCrateFlow(hitCrateFlow(state, 0), 1), 2);
  state = pauseCrateFlow(state, true, 502);
  const frozen = sampleCrateFlow(state, 502).opening;
  assert.equal(sampleCrateFlow(state, 8000).opening, frozen);
  assert.equal(hitCrateFlow(state, 8000).hitCount, 3);
  state = pauseCrateFlow(state, false, 8502);
  assert.equal(state.phaseStartedAtMs, 8002);
  assert.equal(sampleCrateFlow(state, 8502).opening, frozen);
  assert.equal(advanceCrateFlow(state, 8002 + CRATE_OPEN_DURATION_MS).stage, 'revealed');
});

test('readiness cannot start a suspended crate and readiness loss pauses an opening', () => {
  let state = createCrateFlow();
  for (let index = 0; index < 3; index++) state = hitCrateFlow(state, index);
  state = pauseCrateFlow(state, true, 100);
  state = readyCrateFlow(state, true, 200);
  assert.equal(state.stage, 'waiting');
  state = pauseCrateFlow(state, false, 1000);
  assert.equal(state.stage, 'opening');
  assert.equal(state.phaseStartedAtMs, 1000);
  state = readyCrateFlow(state, false, 1200);
  const frozen = sampleCrateFlow(state, 4000).opening;
  state = pauseCrateFlow(state, true, 5000);
  state = readyCrateFlow(state, true, 6000);
  assert.equal(sampleCrateFlow(state, 7000).opening, frozen);
  state = pauseCrateFlow(state, false, 8000);
  assert.equal(sampleCrateFlow(state, 8000).opening, frozen);
});

test('a fresh session does not inherit hits or readiness and invalid times cannot reverse progress', () => {
  let state = readyCrateFlow(createCrateFlow(), true, 10);
  for (let index = 0; index < 3; index++) state = hitCrateFlow(state, 20 + index);
  state = advanceCrateFlow(state, 500);
  const progress = sampleCrateFlow(state, 500).opening;
  assert.equal(sampleCrateFlow(state, Number.NaN).opening, progress);
  assert.equal(sampleCrateFlow(state, -100).opening, progress);
  const fresh = createCrateFlow();
  assert.equal(fresh.hitCount, 0);
  assert.equal(fresh.ready, false);
});

test('reduced motion preserves the gate and completes a short transition', () => {
  let state = readyCrateFlow(createCrateFlow({ reducedMotion: true }), true, 0);
  state = hitCrateFlow(hitCrateFlow(hitCrateFlow(state, 10), 20), 30);
  assert.equal(advanceCrateFlow(state, 30 + CRATE_REDUCED_DURATION_MS - 1).stage, 'opening');
  assert.equal(advanceCrateFlow(state, 30 + CRATE_REDUCED_DURATION_MS).stage, 'revealed');
});

for (const count of [20, 31]) test(`${count} items stay inside until lid clearance and complete within the bounded duration`, () => {
  assert.deepEqual(sampleCrateOpening(0, count).items, Array(count).fill(0));
  const lidReady = sampleCrateOpening(650, count);
  assert.equal(lidReady.lid, 1);
  assert.ok(lidReady.items.every(progress => progress === 0));
  assert.equal(lidReady.crateOpacity, 1);
  const emerging = sampleCrateOpening(1000, count);
  assert.ok(emerging.items[0] > emerging.items.at(-1)!);
  assert.equal(emerging.crateOpacity, 1);
  const total = crateOpeningDuration(count);
  assert.ok(total <= CRATE_OPEN_DURATION_MS);
  const fading = sampleCrateOpening(total - 449, count);
  assert.ok(fading.crateOpacity < 1);
  assert.ok(fading.items.every(progress => progress > 0.42), 'Every item must clear the rim before the crate stops occluding it.');
  assert.equal(sampleCrateOpening(total - 1, count).complete, false);
  const complete = sampleCrateOpening(total, count);
  assert.equal(complete.complete, true);
  assert.equal(complete.crateOpacity, 0);
  assert.ok(complete.items.every(progress => progress === 1));
});

test('reduced emergence has no per-item flying stagger', () => {
  const pose = sampleCrateOpening(150, 31, true);
  assert.ok(pose.items.every(progress => progress === 0.5));
  assert.equal(pose.crateOpacity, 0.5);
  assert.equal(sampleCrateOpening(300, 31, true).complete, true);
});
