export const DEFAULT_BACKGROUND_BLUR_RADIUS = 18;

export type BackgroundBlurState = {
  open: boolean;
  active: boolean;
  radius?: number;
};

export type ResolvedBackgroundBlurState = {
  open: boolean;
  active: boolean;
  radius: number;
};

function normalizeRadius(radius: number | undefined): number {
  if (radius === undefined || !Number.isFinite(radius) || radius < 0) {
    return DEFAULT_BACKGROUND_BLUR_RADIUS;
  }
  return radius;
}

export function normalizeBackgroundBlurState(
  state: BackgroundBlurState,
): ResolvedBackgroundBlurState {
  return {
    open: state.open || state.active,
    active: state.active,
    radius: normalizeRadius(state.radius),
  };
}

export function combineBackgroundBlurStates(
  states: Iterable<BackgroundBlurState>,
): ResolvedBackgroundBlurState {
  let open = false;
  let active = false;
  let activeRadius: number | undefined;

  for (const request of states) {
    const state = normalizeBackgroundBlurState(request);
    open ||= state.open;
    if (!state.active) continue;
    active = true;
    activeRadius =
      activeRadius === undefined ? state.radius : Math.max(activeRadius, state.radius);
  }

  return {
    open,
    active,
    radius: activeRadius ?? DEFAULT_BACKGROUND_BLUR_RADIUS,
  };
}

export function sameBackgroundBlurState(
  left: ResolvedBackgroundBlurState,
  right: ResolvedBackgroundBlurState,
): boolean {
  return (
    left.open === right.open &&
    left.active === right.active &&
    left.radius === right.radius
  );
}

export function shouldRestoreBackgroundFocus({
  activeElementIsRestorable,
  activeElementIsInBackground,
}: {
  activeElementIsRestorable: boolean;
  activeElementIsInBackground: boolean;
}): boolean {
  return !activeElementIsRestorable || activeElementIsInBackground;
}
