import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateDogeCardStackFlow,
  advanceDogeCardStackFlow,
  createDogeCardStackFlow,
  sampleDogeCardStackFlow,
  type DogeCardStackLayout,
  type DogeCardStackState,
} from '../src/dogeDay2026/cardStackFlow.ts';

const layout: DogeCardStackLayout = {
  viewportWidth: 1200,
  viewportHeight: 900,
  cardWidthPx: 280,
  cardCenterY: 420,
};

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should equal ${expected}`);
}

function revealThird() {
  let state = createDogeCardStackFlow({ count: 3 });
  state = advanceDogeCardStackFlow(activateDogeCardStackFlow(state, 100), 660);
  return advanceDogeCardStackFlow(activateDogeCardStackFlow(state, 1000), 1560);
}

test('three activations inspect each card then leave all three in their original row order', () => {
  const initial = createDogeCardStackFlow({ count: 3 });
  const first = activateDogeCardStackFlow(initial, 100);
  assert.equal(first.stage, 'cycling');
  assert.equal(first.activeIndex, 0);
  assert.equal(advanceDogeCardStackFlow(first, 659), first);
  const second = advanceDogeCardStackFlow(first, 660);
  assert.equal(second.stage, 'stack');
  assert.equal(second.activeIndex, 1);
  assert.deepEqual(second.order, [1, 2, 0]);
  const third = revealThird();
  assert.equal(third.activeIndex, 2);
  assert.deepEqual(third.order, [2, 0, 1]);
  const spreading = activateDogeCardStackFlow(third, 2000);
  assert.equal(spreading.stage, 'spreading');
  assert.equal(advanceDogeCardStackFlow(spreading, 2559), spreading);
  const row = advanceDogeCardStackFlow(spreading, 2560);
  assert.equal(row.stage, 'row');
  assert.equal(activateDogeCardStackFlow(row, 3000), row);
  const poses = sampleDogeCardStackFlow(row, 3000, layout);
  assert.deepEqual(poses.map(pose => pose.index), [0, 1, 2]);
  assert.ok(poses[0].x < poses[1].x && poses[1].x < poses[2].x);
  assert.ok(poses.every(pose => pose.interactive));
});

test('two-card packs cycle once then spread the pair in original order', () => {
  for (const reducedMotion of [false, true]) {
    const initial = createDogeCardStackFlow({ count: 2, reducedMotion });
    assert.deepEqual(initial.order, [0, 1]);
    const cycling = activateDogeCardStackFlow(initial, 100);
    if (!reducedMotion) {
      assert.equal(cycling.stage, 'cycling');
      assert.equal(activateDogeCardStackFlow(cycling, 400), cycling);
    }
    const second = advanceDogeCardStackFlow(cycling, 660);
    assert.equal(second.stage, 'stack');
    assert.equal(second.activeIndex, 1);
    assert.deepEqual(second.order, [1, 0]);
    const spreading = activateDogeCardStackFlow(second, 1000);
    if (!reducedMotion) {
      assert.equal(spreading.stage, 'spreading');
      assert.equal(activateDogeCardStackFlow(spreading, 1200), spreading);
    }
    const row = advanceDogeCardStackFlow(spreading, 1560);
    assert.equal(row.stage, 'row');
    assert.equal(activateDogeCardStackFlow(row, 2000), row);
    for (const viewport of [layout, { viewportWidth: 390, viewportHeight: 844, cardWidthPx: 197, cardCenterY: 385 }]) {
      const poses = sampleDogeCardStackFlow(row, 2000, viewport);
      assert.deepEqual(poses.map(pose => pose.index), [0, 1]);
      assert.ok(poses.every(pose => pose.interactive));
      close(poses[0].x, -poses[1].x);
      assert.ok(poses[0].x < 0 && poses[1].x > 0);
      for (const pose of poses) {
        const width = pose.scale * viewport.cardWidthPx;
        const centerX = viewport.viewportWidth / 2 + pose.x * viewport.cardWidthPx / 2;
        assert.ok(width <= viewport.viewportWidth * 0.36 + 0.5);
        assert.ok(centerX - width / 2 >= 0 && centerX + width / 2 <= viewport.viewportWidth);
      }
    }
  }
});

test('rapid taps during either motion cannot skip cards or restart an animation', () => {
  const cycling = activateDogeCardStackFlow(createDogeCardStackFlow({ count: 3 }), 100);
  for (const now of [100, 200, 341, 659]) {
    assert.equal(activateDogeCardStackFlow(cycling, now), cycling);
    assert.ok(sampleDogeCardStackFlow(cycling, now, layout).every(pose => !pose.interactive));
  }
  const spreading = activateDogeCardStackFlow(revealThird(), 2000);
  for (const now of [2000, 2200, 2559]) {
    assert.equal(activateDogeCardStackFlow(spreading, now), spreading);
    assert.ok(sampleDogeCardStackFlow(spreading, now, layout).every(pose => !pose.interactive));
  }
});

test('outgoing cards clear the stack before returning behind it while remaining cards settle forward', () => {
  const initial = createDogeCardStackFlow({ count: 3 });
  const before = sampleDogeCardStackFlow(initial, 0, layout);
  close(before[1].x, 2 * 0.028);
  close(before[1].y, -2.8 * 0.017);
  close(before[2].scale, 0.984);
  close(before[2].rotationZ, -2.2 * Math.PI / 180);
  assert.ok(before[0].z > before[1].z && before[1].z > before[2].z);
  const cycling = activateDogeCardStackFlow(initial, 100);
  assert.deepEqual(sampleDogeCardStackFlow(cycling, 100, layout).map(({ interactive: _, ...pose }) => pose),
    before.map(({ interactive: _, ...pose }) => pose));
  const outgoing = sampleDogeCardStackFlow(cycling, 340, layout);
  assert.ok(outgoing[0].x < -2);
  assert.ok(outgoing[0].z > outgoing[1].z);
  const returning = sampleDogeCardStackFlow(cycling, 341, layout);
  close(returning[0].x, -2 - 32 * 2 / layout.cardWidthPx);
  close(returning[0].y, 2.8 * 0.02);
  assert.ok(returning[0].z < returning[2].z);
  const settled = sampleDogeCardStackFlow(cycling, 660, layout);
  close(settled[1].x, 0);
  close(settled[1].z, 0);
  close(settled[0].x, 2 * 0.053);
  close(settled[0].scale, 0.984);
  assert.deepEqual(settled.map(pose => pose.interactive), [false, true, false]);
});

test('final row remains centered, readable and inside desktop and mobile viewports after resize', () => {
  const row = advanceDogeCardStackFlow(activateDogeCardStackFlow(revealThird(), 2000), 2560);
  for (const viewport of [
    layout,
    { viewportWidth: 390, viewportHeight: 844, cardWidthPx: 197, cardCenterY: 385 },
    { viewportWidth: 844, viewportHeight: 390, cardWidthPx: 115, cardCenterY: 180 },
  ]) {
    const poses = sampleDogeCardStackFlow(row, 3000, viewport);
    const worldPerPixel = 2 / viewport.cardWidthPx;
    close(poses[0].x, -poses[2].x);
    close(poses[1].x, 0);
    for (const pose of poses) {
      const width = pose.scale * viewport.cardWidthPx;
      const height = width * 1.4;
      const centerX = viewport.viewportWidth / 2 + pose.x / worldPerPixel;
      const centerY = viewport.cardCenterY - pose.y / worldPerPixel;
      assert.ok(width <= viewport.viewportWidth * 0.21 + 0.5);
      assert.ok(pose.scale <= 1);
      assert.ok(centerX - width / 2 >= 0);
      assert.ok(centerX + width / 2 <= viewport.viewportWidth);
      assert.ok(centerY - height / 2 >= 0);
      assert.ok(centerY + height / 2 <= viewport.viewportHeight);
    }
  }
});

test('reduced motion commits the same progression immediately including a mid-animation preference change', () => {
  let state = createDogeCardStackFlow({ count: 3, reducedMotion: true });
  for (let index = 1; index < 3; index += 1) {
    state = activateDogeCardStackFlow(state, index * 100);
    assert.equal(state.stage, 'stack');
    assert.equal(state.activeIndex, index);
  }
  state = activateDogeCardStackFlow(state, 300);
  assert.equal(state.stage, 'row');
  assert.ok(sampleDogeCardStackFlow(state, 300, layout).every(pose => pose.interactive));
  const cycling = activateDogeCardStackFlow(createDogeCardStackFlow({ count: 3 }), 100);
  const snapped = advanceDogeCardStackFlow({ ...cycling, reducedMotion: true }, 200);
  assert.equal(snapped.stage, 'stack');
  assert.equal(snapped.activeIndex, 1);
});

test('single-card sessions retain the original pose and resets are independent of previous progress', () => {
  const single = createDogeCardStackFlow({ count: 1 });
  assert.equal(activateDogeCardStackFlow(single, 500), single);
  const [pose] = sampleDogeCardStackFlow(single, 500, layout);
  assert.equal(pose.index, 0);
  close(pose.x, 0);
  close(pose.y, 0);
  close(pose.z, 0);
  assert.equal(pose.scale, 1);
  assert.equal(pose.interactive, true);
  const initial = Object.freeze(createDogeCardStackFlow({ count: 3 }));
  Object.freeze(initial.order);
  const cycling: DogeCardStackState = Object.freeze(activateDogeCardStackFlow(initial, 1000));
  assert.equal(advanceDogeCardStackFlow(cycling, -1000), cycling);
  assert.equal(advanceDogeCardStackFlow(cycling, Number.NaN), cycling);
  advanceDogeCardStackFlow(cycling, 1560);
  assert.deepEqual(createDogeCardStackFlow({ count: 3 }), initial);
});
