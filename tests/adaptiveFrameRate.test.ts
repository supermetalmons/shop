import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAdaptiveFrameRateMonitor,
  resolveMedianFrameInterval,
  resolveAdaptiveSlowFrameThreshold,
} from '../src/lib/adaptiveFrameRate';

function addIntervals(intervals: number[]) {
  const monitor = createAdaptiveFrameRateMonitor();
  let now = 0;
  monitor.addFrame(now);
  return intervals.map((interval) => {
    now += interval;
    return monitor.addFrame(now);
  });
}

test('adaptive frame-rate monitor enables fallback after sustained slow frames', () => {
  const decisions = addIntervals([30, 30, 30, 30, 30, 30, 16, 16, 16, 16]);
  assert.equal(decisions.at(-1), 'throttle');
});

test('adaptive frame-rate monitor ignores occasional slow frames', () => {
  const decisions = addIntervals([30, 16, 30, 16, 30, 16, 30, 16, 30, 16]);
  assert.equal(decisions.at(-1), 'healthy');
});

test('adaptive frame-rate monitor waits for a complete sample window', () => {
  const decisions = addIntervals([30, 30, 30, 30, 30, 30, 16, 16, 16, 16]);
  assert.ok(decisions.slice(0, -1).every((decision) => decision === 'sampling'));
  assert.equal(decisions.at(-1), 'throttle');
});

test('adaptive frame-rate monitor ignores long scheduling gaps', () => {
  const decisions = addIntervals([30, 30, 30, 30, 30, 16, 16, 16, 16, 200, 16]);
  assert.equal(decisions[9], 'sampling');
  assert.equal(decisions[10], 'healthy');
});

test('adaptive frame-rate monitor throttles after repeated long frames', () => {
  const decisions = addIntervals([120, 120]);
  assert.deepEqual(decisions, ['sampling', 'throttle']);
});

test('adaptive threshold follows slower native display cadence', () => {
  assert.equal(resolveAdaptiveSlowFrameThreshold(1_000 / 60), 25);
  assert.equal(resolveAdaptiveSlowFrameThreshold(25), 37.5);

  const calibratedMonitor = createAdaptiveFrameRateMonitor({
    slowFrameThresholdMs: resolveAdaptiveSlowFrameThreshold(25),
  });
  let now = 0;
  calibratedMonitor.addFrame(now);
  const calibratedDecisions = Array.from({ length: 10 }, () => {
    now += 25;
    return calibratedMonitor.addFrame(now);
  });
  assert.equal(calibratedDecisions.at(-1), 'healthy');
});

test('display cadence uses the median instead of one fast interval', () => {
  const displayFrameInterval = resolveMedianFrameInterval([16, 25, 25, 25, 25, 25, 25, 25]);
  assert.equal(displayFrameInterval, 25);
  assert.equal(resolveAdaptiveSlowFrameThreshold(displayFrameInterval), 37.5);
});
