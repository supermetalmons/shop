const DEFAULT_SLOW_FRAME_THRESHOLD_MS = 25;
const DEFAULT_SAMPLE_SIZE = 10;
const DEFAULT_SLOW_FRAME_LIMIT = 6;
const DEFAULT_MAX_FRAME_INTERVAL_MS = 100;
const DEFAULT_CONSECUTIVE_LONG_FRAME_LIMIT = 2;
const MIN_EXPECTED_FRAME_INTERVAL_MS = 1_000 / 60;
const SLOW_FRAME_INTERVAL_MULTIPLIER = 1.5;

type AdaptiveFrameRateMonitorOptions = {
  slowFrameThresholdMs?: number;
  sampleSize?: number;
  slowFrameLimit?: number;
  maxFrameIntervalMs?: number;
  consecutiveLongFrameLimit?: number;
};

export type AdaptiveFrameRateMonitor = {
  addFrame: (frameTimeMs: number) => 'sampling' | 'healthy' | 'throttle';
};

export function resolveMedianFrameInterval(frameIntervalsMs: readonly number[]) {
  const sortedIntervals = frameIntervalsMs
    .filter((intervalMs) => Number.isFinite(intervalMs) && intervalMs > 0)
    .sort((left, right) => left - right);
  if (!sortedIntervals.length) return MIN_EXPECTED_FRAME_INTERVAL_MS;
  const middleIndex = Math.floor(sortedIntervals.length / 2);
  if (sortedIntervals.length % 2 === 1) return sortedIntervals[middleIndex]!;
  return (sortedIntervals[middleIndex - 1]! + sortedIntervals[middleIndex]!) / 2;
}

export function resolveAdaptiveSlowFrameThreshold(displayFrameIntervalMs: number) {
  const expectedFrameIntervalMs =
    Number.isFinite(displayFrameIntervalMs) && displayFrameIntervalMs > 0
      ? Math.max(displayFrameIntervalMs, MIN_EXPECTED_FRAME_INTERVAL_MS)
      : MIN_EXPECTED_FRAME_INTERVAL_MS;
  return Math.max(
    DEFAULT_SLOW_FRAME_THRESHOLD_MS,
    expectedFrameIntervalMs * SLOW_FRAME_INTERVAL_MULTIPLIER,
  );
}

export function createAdaptiveFrameRateMonitor(
  options: AdaptiveFrameRateMonitorOptions = {},
): AdaptiveFrameRateMonitor {
  const slowFrameThresholdMs =
    options.slowFrameThresholdMs ?? DEFAULT_SLOW_FRAME_THRESHOLD_MS;
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const slowFrameLimit = options.slowFrameLimit ?? DEFAULT_SLOW_FRAME_LIMIT;
  const maxFrameIntervalMs =
    options.maxFrameIntervalMs ?? DEFAULT_MAX_FRAME_INTERVAL_MS;
  const consecutiveLongFrameLimit =
    options.consecutiveLongFrameLimit ?? DEFAULT_CONSECUTIVE_LONG_FRAME_LIMIT;
  const slowFrames: boolean[] = [];
  let previousFrameTimeMs: number | null = null;
  let consecutiveLongFrames = 0;

  return {
    addFrame(frameTimeMs) {
      const previousTime = previousFrameTimeMs;
      previousFrameTimeMs = frameTimeMs;
      if (previousTime === null) return 'sampling';

      const intervalMs = frameTimeMs - previousTime;
      if (intervalMs <= 0) return 'sampling';
      if (intervalMs > maxFrameIntervalMs) {
        consecutiveLongFrames += 1;
        return consecutiveLongFrames >= consecutiveLongFrameLimit ? 'throttle' : 'sampling';
      }
      consecutiveLongFrames = 0;

      slowFrames.push(intervalMs >= slowFrameThresholdMs);
      if (slowFrames.length < sampleSize) return 'sampling';
      return slowFrames.filter(Boolean).length >= slowFrameLimit ? 'throttle' : 'healthy';
    },
  };
}
