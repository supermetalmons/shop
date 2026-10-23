const DOGE_FOIL_HIT_DURATION_MS = 300;
const DOGE_FOIL_TEAR_DURATION_MS = 500;
const DOGE_FOIL_DISCARD_START_MS = DOGE_FOIL_TEAR_DURATION_MS + 420;
const DOGE_FOIL_DISCARD_DURATION_MS = 380;
const DOGE_FOIL_OPEN_DURATION_MS = DOGE_FOIL_DISCARD_START_MS + DOGE_FOIL_DISCARD_DURATION_MS;

const MINIMUM_HITS = 3;
const REDUCED_HIT_DURATION_MS = 180;
const REDUCED_OPEN_DURATION_MS = 260;

export type DogeFoilFlowStage = 'sealed' | 'hit' | 'waiting' | 'opening' | 'revealed';

export interface DogeFoilFlowState {
  readonly stage: DogeFoilFlowStage;
  readonly hitCount: number;
  readonly variant: number;
  readonly hitX: number;
  readonly hitY: number;
  readonly ready: boolean;
  readonly reducedMotion: boolean;
  readonly phaseStartedAtMs: number;
  readonly pausedAtMs: number | null;
}

export interface DogeFoilPose {
  hit: number;
  hitX: number;
  hitY: number;
  variant: number;
  tear: number;
  discard: number;
  cardInteractive: boolean;
}

export function createDogeFoilFlow(options: { reducedMotion?: boolean } = {}): DogeFoilFlowState {
  return {
    stage: 'sealed',
    hitCount: 0,
    variant: 0,
    hitX: 0,
    hitY: 0,
    ready: false,
    reducedMotion: options.reducedMotion ?? false,
    phaseStartedAtMs: 0,
    pausedAtMs: null,
  };
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smooth(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function discardEase(value: number) {
  const x = clamp(value);
  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const t = (low + high) / 2;
    const curveX = 3 * (1 - t) ** 2 * t * 0.55 + 3 * (1 - t) * t * t + t ** 3;
    if (curveX < x) low = t;
    else high = t;
  }
  if (x === 0 || x === 1) return x;
  const t = (low + high) / 2;
  return 3 * (1 - t) * t * t * 0.45 + t ** 3;
}

function eventTime(state: DogeFoilFlowState, nowMs: number) {
  return Math.max(state.phaseStartedAtMs, state.pausedAtMs ?? 0, Number.isFinite(nowMs) ? nowMs : 0);
}

function hitDuration(state: DogeFoilFlowState) {
  return state.reducedMotion ? REDUCED_HIT_DURATION_MS : DOGE_FOIL_HIT_DURATION_MS;
}

function openDuration(state: DogeFoilFlowState) {
  return state.reducedMotion ? REDUCED_OPEN_DURATION_MS : DOGE_FOIL_OPEN_DURATION_MS;
}

export function advanceDogeFoilFlow(state: DogeFoilFlowState, nowMs: number): DogeFoilFlowState {
  const now = eventTime(state, nowMs);
  let current = state;
  if (current.stage === 'hit' && now >= current.phaseStartedAtMs + hitDuration(current)) {
    current = {
      ...current,
      stage: current.hitCount >= MINIMUM_HITS ? 'waiting' : 'sealed',
      phaseStartedAtMs: current.phaseStartedAtMs + hitDuration(current),
    };
  }
  if (current.stage === 'waiting' && current.ready) {
    current = { ...current, stage: 'opening' };
  }
  if (current.stage === 'opening' && current.ready && now >= current.phaseStartedAtMs + openDuration(current)) {
    current = {
      ...current,
      stage: 'revealed',
      phaseStartedAtMs: current.phaseStartedAtMs + openDuration(current),
    };
  }
  return current;
}

export function hitDogeFoilFlow(state: DogeFoilFlowState, nowMs: number, x = 0, y = 0): DogeFoilFlowState {
  const current = advanceDogeFoilFlow(state, nowMs);
  if (current.stage !== 'sealed' && current.stage !== 'waiting') return current;
  return {
    ...current,
    stage: 'hit',
    hitCount: current.hitCount + 1,
    variant: current.hitCount % 3,
    hitX: Number.isFinite(x) ? clamp(x, -1, 1) : 0,
    hitY: Number.isFinite(y) ? clamp(y, -1, 1) : 0,
    phaseStartedAtMs: eventTime(current, nowMs),
  };
}

export function readyDogeFoilFlow(state: DogeFoilFlowState, ready: boolean, nowMs: number): DogeFoilFlowState {
  const now = eventTime(state, nowMs);
  if (state.ready === ready) return advanceDogeFoilFlow(state, now);
  let current: DogeFoilFlowState = { ...state, ready };
  if (state.stage === 'opening') {
    current = ready
      ? { ...current, phaseStartedAtMs: state.phaseStartedAtMs + now - (state.pausedAtMs ?? now), pausedAtMs: null }
      : { ...current, pausedAtMs: Math.min(now, state.phaseStartedAtMs + openDuration(state)) };
  } else if (ready) {
    current = advanceDogeFoilFlow({ ...state, ready: false }, now);
    current = { ...current, ready: true };
    if (current.stage === 'waiting') current = { ...current, phaseStartedAtMs: now };
  }
  return advanceDogeFoilFlow(current, now);
}

export function sampleDogeFoilFlow(state: DogeFoilFlowState, nowMs: number): DogeFoilPose {
  const current = advanceDogeFoilFlow(state, nowMs);
  const now = current.pausedAtMs ?? eventTime(current, nowMs);
  const pose: DogeFoilPose = {
    hit: 0,
    hitX: current.hitX,
    hitY: current.hitY,
    variant: current.variant,
    tear: 0,
    discard: 0,
    cardInteractive: current.stage === 'revealed' && current.ready,
  };
  if (current.stage === 'hit') {
    const progress = clamp((now - current.phaseStartedAtMs) / hitDuration(current));
    pose.hit = (progress < 0.2 ? smooth(progress / 0.2) : 1 - smooth((progress - 0.2) / 0.8))
      * (current.reducedMotion ? 0.3 : 1);
  } else if (current.stage === 'opening' || current.stage === 'revealed') {
    const elapsed = current.stage === 'revealed'
      ? DOGE_FOIL_OPEN_DURATION_MS
      : (now - current.phaseStartedAtMs) * DOGE_FOIL_OPEN_DURATION_MS / openDuration(current);
    pose.tear = smooth(elapsed / DOGE_FOIL_TEAR_DURATION_MS);
    pose.discard = discardEase((elapsed - DOGE_FOIL_DISCARD_START_MS) / DOGE_FOIL_DISCARD_DURATION_MS);
  }
  return pose;
}
