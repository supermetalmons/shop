const DOGE_CARD_STACK_CYCLE_DURATION_MS = 560;
const DOGE_CARD_STACK_CYCLE_OUT_DURATION_MS = 241;
const DOGE_CARD_STACK_CYCLE_IN_DURATION_MS = 319;
const DOGE_CARD_STACK_SPREAD_DURATION_MS = 560;

const CARD_WIDTH = 2;
const CARD_HEIGHT = 2.8;
const STACK_SETTLE_DURATION_MS = 420;
const STACK_DEPTH = 0.025;

export type DogeCardStackStage = 'stack' | 'cycling' | 'spreading' | 'row';

export interface DogeCardStackState {
  readonly stage: DogeCardStackStage;
  readonly count: 1 | 2 | 3;
  readonly activeIndex: number;
  readonly order: readonly number[];
  readonly phaseStartedAtMs: number;
  readonly reducedMotion: boolean;
}

export interface DogeCardStackLayout {
  viewportWidth: number;
  viewportHeight: number;
  cardWidthPx: number;
  cardCenterY: number;
}

export interface DogeCardStackPose {
  index: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  rotationZ: number;
  interactive: boolean;
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function eventTime(state: DogeCardStackState, nowMs: number) {
  return Math.max(state.phaseStartedAtMs, finite(nowMs, 0));
}

function bezier(value: number, x1: number, y1: number, x2: number, y2: number) {
  const x = clamp(value);
  if (x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 16; index += 1) {
    const t = (low + high) / 2;
    const curveX = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
    if (curveX < x) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
}

function stackPose(index: number, depth: number): DogeCardStackPose {
  const offsets = [
    { x: 0, y: 0, scale: 1, degrees: 0 },
    { x: 0.028, y: 0.017, scale: 0.992, degrees: 1.1 },
    { x: 0.053, y: 0.033, scale: 0.984, degrees: 2.2 },
  ][depth];
  return {
    index,
    x: offsets.x * CARD_WIDTH,
    y: depth === 0 ? 0 : -offsets.y * CARD_HEIGHT,
    z: depth === 0 ? 0 : -depth * STACK_DEPTH,
    scale: offsets.scale,
    rotationZ: depth === 0 ? 0 : -offsets.degrees * Math.PI / 180,
    interactive: false,
  };
}

function mixPose(from: DogeCardStackPose, to: DogeCardStackPose, progress: number): DogeCardStackPose {
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return {
    index: from.index,
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    z: mix(from.z, to.z),
    scale: mix(from.scale, to.scale),
    rotationZ: mix(from.rotationZ, to.rotationZ),
    interactive: false,
  };
}

function normalizeLayout(layout: DogeCardStackLayout) {
  const viewportWidth = Math.max(1, finite(layout.viewportWidth, 1));
  const viewportHeight = Math.max(1, finite(layout.viewportHeight, 1));
  return {
    viewportWidth,
    viewportHeight,
    cardWidthPx: Math.max(1, finite(layout.cardWidthPx, 1)),
    cardCenterY: finite(layout.cardCenterY, viewportHeight / 2),
  };
}

function rowPoses(layout: DogeCardStackLayout, count: 1 | 2 | 3): DogeCardStackPose[] {
  const { viewportWidth, viewportHeight, cardWidthPx, cardCenterY } = layout;
  const cardHeightPx = cardWidthPx * CARD_HEIGHT / CARD_WIDTH;
  const gutterX = Math.round(clamp(viewportWidth * 0.075, 18, 72));
  const gutterY = Math.round(clamp(viewportHeight * 0.07, 18, 56));
  const gap = Math.round(clamp(viewportWidth * 0.028, 10, 26));
  const availableWidth = Math.max(1, viewportWidth - gutterX * 2);
  const availableHeight = Math.max(1, viewportHeight - gutterY * 2);
  const maxWidthRatio = { 1: 0.62, 2: 0.36, 3: 0.21 }[count];
  const scale = clamp(Math.min(
    1,
    (availableWidth - gap * (count - 1)) / (cardWidthPx * count),
    Math.min(availableHeight, viewportHeight * 0.72) / cardHeightPx,
    viewportWidth * maxWidthRatio / cardWidthPx,
  ), 0.18, 1);
  const rowWidth = Math.max(1, Math.round(cardWidthPx * scale));
  const rowHeight = rowWidth * CARD_HEIGHT / CARD_WIDTH;
  const totalWidth = rowWidth * count + gap * (count - 1);
  const rowLeft = Math.max(gutterX, Math.min(viewportWidth - gutterX - totalWidth, (viewportWidth - totalWidth) / 2));
  const rowTop = Math.max(gutterY, Math.min(viewportHeight - gutterY - rowHeight, cardCenterY - rowHeight / 2));
  const worldPerPixel = CARD_WIDTH / cardWidthPx;
  return Array.from({ length: count }, (_, index) => ({
    index,
    x: (rowLeft + rowWidth / 2 + index * (rowWidth + gap) - viewportWidth / 2) * worldPerPixel,
    y: (cardCenterY - rowTop - rowHeight / 2) * worldPerPixel,
    z: 0,
    scale: rowWidth / cardWidthPx,
    rotationZ: 0,
    interactive: true,
  }));
}

export function createDogeCardStackFlow(options: { count: 1 | 2 | 3; reducedMotion?: boolean }): DogeCardStackState {
  return {
    stage: 'stack',
    count: options.count,
    activeIndex: 0,
    order: Array.from({ length: options.count }, (_, index) => index),
    phaseStartedAtMs: 0,
    reducedMotion: options.reducedMotion ?? false,
  };
}

export function advanceDogeCardStackFlow(state: DogeCardStackState, nowMs: number): DogeCardStackState {
  if (state.stage !== 'cycling' && state.stage !== 'spreading') return state;
  const duration = state.reducedMotion ? 0 : state.stage === 'cycling'
    ? DOGE_CARD_STACK_CYCLE_DURATION_MS
    : DOGE_CARD_STACK_SPREAD_DURATION_MS;
  if (eventTime(state, nowMs) < state.phaseStartedAtMs + duration) return state;
  if (state.stage === 'spreading') {
    return { ...state, stage: 'row', phaseStartedAtMs: state.phaseStartedAtMs + duration };
  }
  const order = [...state.order.slice(1), state.order[0]];
  return {
    ...state,
    stage: 'stack',
    activeIndex: order[0],
    order,
    phaseStartedAtMs: state.phaseStartedAtMs + duration,
  };
}

export function activateDogeCardStackFlow(state: DogeCardStackState, nowMs: number): DogeCardStackState {
  const current = advanceDogeCardStackFlow(state, nowMs);
  if (current.stage !== 'stack' || current.count === 1) return current;
  return advanceDogeCardStackFlow({
    ...current,
    stage: current.activeIndex === current.count - 1 ? 'spreading' : 'cycling',
    phaseStartedAtMs: eventTime(current, nowMs),
  }, nowMs);
}

export function sampleDogeCardStackFlow(
  state: DogeCardStackState,
  nowMs: number,
  layout: DogeCardStackLayout,
): readonly DogeCardStackPose[] {
  const current = advanceDogeCardStackFlow(state, nowMs);
  const normalizedLayout = normalizeLayout(layout);
  if (current.stage === 'row') return rowPoses(normalizedLayout, current.count);
  const elapsed = eventTime(current, nowMs) - current.phaseStartedAtMs;
  const row = current.stage === 'spreading' ? rowPoses(normalizedLayout, current.count) : null;
  return Array.from({ length: current.count }, (_, index) => {
    const depth = current.order.indexOf(index);
    const rest = stackPose(index, depth);
    if (row) return mixPose(rest, row[index], bezier(elapsed / DOGE_CARD_STACK_SPREAD_DURATION_MS, 0.2, 0.8, 0.2, 1));
    if (current.stage !== 'cycling') return { ...rest, interactive: depth === 0 };
    if (depth > 0) {
      return mixPose(rest, stackPose(index, depth - 1), bezier(elapsed / STACK_SETTLE_DURATION_MS, 0.16, 1, 0.3, 1));
    }
    const worldPerPixel = CARD_WIDTH / normalizedLayout.cardWidthPx;
    const gap = clamp(Math.min(normalizedLayout.viewportWidth, normalizedLayout.viewportHeight) * 0.04, 12, 32);
    const outside: DogeCardStackPose = {
      index,
      x: -CARD_WIDTH - gap * worldPerPixel,
      y: CARD_HEIGHT * 0.02,
      z: STACK_DEPTH,
      scale: 0.996,
      rotationZ: 7 * Math.PI / 180,
      interactive: false,
    };
    if (elapsed < DOGE_CARD_STACK_CYCLE_OUT_DURATION_MS) {
      return mixPose(rest, outside, bezier(elapsed / DOGE_CARD_STACK_CYCLE_OUT_DURATION_MS, 0.18, 0.86, 0.3, 1));
    }
    const back = stackPose(index, current.count - 1);
    return mixPose(
      { ...outside, z: back.z },
      back,
      bezier((elapsed - DOGE_CARD_STACK_CYCLE_OUT_DURATION_MS) / DOGE_CARD_STACK_CYCLE_IN_DURATION_MS, 0.18, 0.86, 0.3, 1),
    );
  });
}
