import {
  createAdaptiveFrameRateMonitor,
  resolveMedianFrameInterval,
  resolveAdaptiveSlowFrameThreshold,
} from '../lib/adaptiveFrameRate';
import type { ClearCardThreeViewerProps } from './types';

const INTERACTION_FRAME_INTERVAL_MS = 1_000 / 30;
const ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY =
  'mons.clear-card.interaction-throttle-required.v1';
const ADAPTIVE_THROTTLE_REPROBE_MS = 60_000;
const DISPLAY_CADENCE_SAMPLE_SIZE = 8;
const DISPLAY_CADENCE_MAX_ATTEMPTS = 24;
const DISPLAY_CADENCE_MAX_INTERVAL_MS = 100;

export function createClearCardFrameLoop(options: {
  interactionFrameRateMode: NonNullable<ClearCardThreeViewerProps['interactionFrameRateMode']>;
  canRequestRender: () => boolean;
  canRender: () => boolean;
  isSnapBackActive: () => boolean;
  render: (deltaSeconds: number) => boolean;
  onIdle: () => void;
}) {
  const { interactionFrameRateMode } = options;
  let disposed = false;
  let initializationFrameId: number | null = null;
  let frameId: number | null = null;
  let displayCadenceFrameId: number | null = null;
  let lastFrameTime = 0;
  let lastInteractionFrameTime = 0;
  let interactionActive = false;
  let interactionProbeActive = false;
  let interactionThrottleActive = false;
  let interactionThrottleReleasePending = false;
  let adaptiveInteractionThrottleRequired = false;
  let adaptiveThrottleActivatedAt = 0;
  let displayFrameIntervalMs = 1_000 / 60;
  let adaptiveFrameRateMonitor = createAdaptiveFrameRateMonitor();

  const renderFrame = (now: number) => {
    frameId = null;
    if (
      disposed ||
      !options.canRender()
    ) {
      return;
    }
    if (interactionThrottleReleasePending && !options.isSnapBackActive()) {
      interactionThrottleReleasePending = false;
      interactionActive = false;
      interactionProbeActive = false;
      setInteractionThrottle(false);
      startDisplayCadenceCalibration();
    }
    if (
      interactionThrottleActive &&
      lastInteractionFrameTime > 0 &&
      now - lastInteractionFrameTime < INTERACTION_FRAME_INTERVAL_MS
    ) {
      frameId = window.requestAnimationFrame(renderFrame);
      return;
    }
    if (interactionThrottleActive) lastInteractionFrameTime = now;
    if (interactionProbeActive) {
      const decision = adaptiveFrameRateMonitor.addFrame(now);
      if (decision !== 'sampling') interactionProbeActive = false;
      if (decision === 'throttle') {
        adaptiveInteractionThrottleRequired = true;
        adaptiveThrottleActivatedAt = Date.now();
        try {
          window.sessionStorage.setItem(
            ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY,
            String(adaptiveThrottleActivatedAt),
          );
        } catch { }
        setInteractionThrottle(true);
      }
    }

    const deltaSeconds = lastFrameTime
      ? Math.min((now - lastFrameTime) / 1_000, 1 / 30)
      : 1 / 60;
    lastFrameTime = now;
    const continuing = options.render(deltaSeconds);
    if (continuing || interactionThrottleReleasePending || interactionProbeActive) {
      if (frameId === null) frameId = window.requestAnimationFrame(renderFrame);
    } else {
      options.onIdle();
      lastFrameTime = 0;
    }
  };

  const requestRender = () => {
    if (disposed || !options.canRequestRender() || frameId !== null) return;
    lastFrameTime = 0;
    frameId = window.requestAnimationFrame(renderFrame);
  };

  const setInteractionThrottle = (active: boolean) => {
    if (interactionFrameRateMode === 'unrestricted' || interactionThrottleActive === active) {
      return;
    }
    interactionThrottleActive = active;
    lastInteractionFrameTime = 0;
  };

  const stopDisplayCadenceCalibration = () => {
    if (displayCadenceFrameId === null) return;
    window.cancelAnimationFrame(displayCadenceFrameId);
    displayCadenceFrameId = null;
  };

  const startDisplayCadenceCalibration = () => {
    if (interactionFrameRateMode !== 'adaptive' || disposed || interactionActive) return;
    stopDisplayCadenceCalibration();
    let previousFrameTime: number | null = null;
    const frameIntervals: number[] = [];
    let attemptCount = 0;

    const sampleDisplayCadence = (now: number) => {
      displayCadenceFrameId = null;
      if (disposed || interactionActive) return;
      attemptCount += 1;
      if (previousFrameTime !== null) {
        const intervalMs = now - previousFrameTime;
        if (intervalMs > 0 && intervalMs <= DISPLAY_CADENCE_MAX_INTERVAL_MS) {
          frameIntervals.push(intervalMs);
        }
      }
      previousFrameTime = now;
      if (frameIntervals.length >= DISPLAY_CADENCE_SAMPLE_SIZE) {
        displayFrameIntervalMs = resolveMedianFrameInterval(frameIntervals);
        return;
      }
      if (attemptCount >= DISPLAY_CADENCE_MAX_ATTEMPTS) return;
      displayCadenceFrameId = window.requestAnimationFrame(sampleDisplayCadence);
    };

    displayCadenceFrameId = window.requestAnimationFrame(sampleDisplayCadence);
  };

  const startAdaptiveInteractionProbe = () => {
    interactionProbeActive =
      interactionFrameRateMode === 'adaptive' && !adaptiveInteractionThrottleRequired;
    if (!interactionProbeActive) return;
    adaptiveFrameRateMonitor = createAdaptiveFrameRateMonitor({
      slowFrameThresholdMs: resolveAdaptiveSlowFrameThreshold(displayFrameIntervalMs),
    });
  };

  const beginInteractionThrottle = () => {
    if (interactionFrameRateMode === 'unrestricted') return;
    if (interactionActive) {
      interactionThrottleReleasePending = false;
      return;
    }
    stopDisplayCadenceCalibration();
    interactionActive = true;
    interactionThrottleReleasePending = false;
    if (interactionFrameRateMode === 'adaptive' && adaptiveInteractionThrottleRequired) {
      const throttleAge = Date.now() - adaptiveThrottleActivatedAt;
      if (throttleAge < 0 || throttleAge >= ADAPTIVE_THROTTLE_REPROBE_MS) {
        adaptiveInteractionThrottleRequired = false;
        adaptiveThrottleActivatedAt = 0;
        try {
          window.sessionStorage.removeItem(ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY);
        } catch { }
      }
    }
    startAdaptiveInteractionProbe();
    setInteractionThrottle(
      interactionFrameRateMode === 'throttled' || adaptiveInteractionThrottleRequired,
    );
    requestRender();
  };

  const releaseInteractionThrottle = () => {
    if (!interactionActive) return;
    if (!interactionProbeActive) startAdaptiveInteractionProbe();
    interactionThrottleReleasePending = true;
    requestRender();
  };

  const restoreAdaptiveThrottle = () => {
    if (interactionFrameRateMode === 'adaptive') {
      try {
        const storedActivationTime = Number(
          window.sessionStorage.getItem(ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY),
        );
        const throttleAge = Date.now() - storedActivationTime;
        if (
          Number.isFinite(storedActivationTime) &&
          storedActivationTime > 0 &&
          throttleAge >= 0 &&
          throttleAge < ADAPTIVE_THROTTLE_REPROBE_MS
        ) {
          adaptiveInteractionThrottleRequired = true;
          adaptiveThrottleActivatedAt = storedActivationTime;
        } else {
          window.sessionStorage.removeItem(ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY);
        }
      } catch {
        adaptiveInteractionThrottleRequired = false;
        adaptiveThrottleActivatedAt = 0;
      }
    }
  };

  const stop = () => {
    stopDisplayCadenceCalibration();
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  return {
    requestRender,
    beginInteraction: beginInteractionThrottle,
    releaseInteraction: releaseInteractionThrottle,
    startCalibration: startDisplayCadenceCalibration,
    scheduleInitialization(initialize: () => void) {
      initializationFrameId = window.requestAnimationFrame(() => {
        initializationFrameId = null;
        if (disposed) return;
        restoreAdaptiveThrottle();
        initialize();
      });
    },
    stop,
    dispose() {
      disposed = true;
      if (initializationFrameId !== null) {
        window.cancelAnimationFrame(initializationFrameId);
        initializationFrameId = null;
      }
      stop();
    },
  };
}
