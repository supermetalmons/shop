export const CRATE_MINIMUM_HITS = 3;
const CRATE_LID_DURATION_MS = 650;
const CRATE_ITEM_DURATION_MS = 900;
const CRATE_ITEM_STAGGER_MS = 24;
const CRATE_MAX_STAGGER_MS = 600;
export const CRATE_OPEN_DURATION_MS = 2150;
export const CRATE_REDUCED_DURATION_MS = 300;

export type CrateFlowState = {
  readonly stage: 'sealed' | 'waiting' | 'opening' | 'revealed';
  readonly hitCount: number;
  readonly ready: boolean;
  readonly reducedMotion: boolean;
  readonly phaseStartedAtMs: number;
  readonly pausedAtMs: number | null;
  readonly suspended: boolean;
  readonly lastTimeMs: number;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const eventTime = (state: CrateFlowState, nowMs: number) => Math.max(state.lastTimeMs, Number.isFinite(nowMs) ? nowMs : state.lastTimeMs);
const duration = (state: CrateFlowState) => state.reducedMotion ? CRATE_REDUCED_DURATION_MS : CRATE_OPEN_DURATION_MS;

export function createCrateFlow({ reducedMotion = false }: { reducedMotion?: boolean } = {}): CrateFlowState {
  return { stage: 'sealed', hitCount: 0, ready: false, reducedMotion, phaseStartedAtMs: 0, pausedAtMs: null, suspended: false, lastTimeMs: 0 };
}

function synchronizePause(state: CrateFlowState, nowMs: number): CrateFlowState {
  const pause = state.suspended || state.stage === 'opening' && !state.ready;
  if (pause && state.pausedAtMs === null) return { ...state, pausedAtMs: nowMs };
  if (!pause && state.pausedAtMs !== null) return { ...state, pausedAtMs: null,
    phaseStartedAtMs: state.phaseStartedAtMs + (state.stage === 'opening' ? nowMs - state.pausedAtMs : 0) };
  return state;
}

export function advanceCrateFlow(state: CrateFlowState, nowMs: number): CrateFlowState {
  const now = eventTime(state, nowMs);
  let current = synchronizePause({ ...state, lastTimeMs: now }, now);
  if (current.pausedAtMs !== null) return current;
  if (current.stage === 'waiting' && current.ready) current = { ...current, stage: 'opening', phaseStartedAtMs: now };
  if (current.stage === 'opening' && now - current.phaseStartedAtMs >= duration(current)) {
    current = { ...current, stage: 'revealed' };
  }
  return current;
}

export function hitCrateFlow(state: CrateFlowState, nowMs: number): CrateFlowState {
  const current = advanceCrateFlow(state, nowMs);
  if (current.suspended || current.stage === 'opening' || current.stage === 'revealed') return current;
  const hitCount = Math.min(CRATE_MINIMUM_HITS, current.hitCount + 1);
  return advanceCrateFlow({ ...current, hitCount, stage: hitCount === CRATE_MINIMUM_HITS ? 'waiting' : 'sealed' }, nowMs);
}

export function readyCrateFlow(state: CrateFlowState, ready: boolean, nowMs: number): CrateFlowState {
  const current = advanceCrateFlow(state, nowMs);
  return advanceCrateFlow({ ...current, ready }, nowMs);
}

export function pauseCrateFlow(state: CrateFlowState, paused: boolean, nowMs: number): CrateFlowState {
  const current = advanceCrateFlow(state, nowMs);
  return advanceCrateFlow({ ...current, suspended: paused }, nowMs);
}

export function sampleCrateFlow(state: CrateFlowState, nowMs: number): { opening: number; complete: boolean } {
  const current = advanceCrateFlow(state, nowMs);
  if (current.stage === 'revealed') return { opening: 1, complete: true };
  if (current.stage !== 'opening') return { opening: 0, complete: false };
  const elapsed = (current.pausedAtMs ?? current.lastTimeMs) - current.phaseStartedAtMs;
  return { opening: smooth(elapsed / duration(current)), complete: false };
}

export function crateOpeningDuration(count: number, reducedMotion = false): number {
  if (reducedMotion) return CRATE_REDUCED_DURATION_MS;
  return CRATE_LID_DURATION_MS + CRATE_ITEM_DURATION_MS + Math.min(CRATE_MAX_STAGGER_MS, Math.max(0, count - 1) * CRATE_ITEM_STAGGER_MS);
}

export function sampleCrateOpening(elapsedMs: number, count: number, reducedMotion = false): {
  lid: number;
  items: readonly number[];
  crateOpacity: number;
  complete: boolean;
} {
  const itemCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const total = crateOpeningDuration(itemCount, reducedMotion);
  if (reducedMotion) {
    const progress = smooth(elapsed / total);
    return { lid: progress, items: Array.from({ length: itemCount }, () => progress), crateOpacity: 1 - progress, complete: elapsed >= total };
  }
  const stagger = Math.min(CRATE_ITEM_STAGGER_MS, CRATE_MAX_STAGGER_MS / Math.max(1, itemCount - 1));
  const lastClear = CRATE_LID_DURATION_MS + stagger * Math.max(0, itemCount - 1) + 450;
  return {
    lid: smooth(elapsed / CRATE_LID_DURATION_MS),
    items: Array.from({ length: itemCount }, (_, index) => smooth((elapsed - CRATE_LID_DURATION_MS - stagger * index) / CRATE_ITEM_DURATION_MS)),
    crateOpacity: 1 - smooth((elapsed - lastClear) / (total - lastClear)),
    complete: elapsed >= total,
  };
}
