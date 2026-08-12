const CLEAR_CARD_RECOVERABLE_HIT_VARIANTS = 5;
const CLEAR_CARD_PERSISTENT_HITS_TO_BREAK = 4;

export type ClearCardGatedHitState = {
  recoverableHits: number;
  persistentHits: number;
};

export type ClearCardGatedHitResult = {
  state: ClearCardGatedHitState;
  effect: 'recoverable' | 'persistent' | 'break';
  hitIndex: number;
};

export type ClearCardRevealRequestState = 'idle' | 'pending' | 'sent';

export function isClearCardFreeMovementEnabled(
  viewerOnly: boolean,
  displayStage: 'pack' | 'breaking' | 'revealed',
): boolean {
  return viewerOnly || displayStage === 'revealed';
}

export function isClearCardImpactPointer({
  isPrimary,
  button,
}: {
  isPrimary: boolean;
  button: number;
}): boolean {
  return isPrimary && button === 0;
}

export function isClearCardInteractionPoint(
  { clientX, clientY }: { clientX: number; clientY: number },
  { left, top, right, bottom }: { left: number; top: number; right: number; bottom: number },
): boolean {
  return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
}

export function isClearCardFallbackImagePoint(
  { clientX, clientY }: { clientX: number; clientY: number },
  {
    left,
    top,
    width,
    height,
  }: { left: number; top: number; width: number; height: number },
  {
    naturalWidth,
    naturalHeight,
  }: { naturalWidth: number; naturalHeight: number },
): boolean {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    width <= 0 ||
    height <= 0 ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return false;
  }
  const scale = Math.min(width / naturalWidth, height / naturalHeight);
  const renderedWidth = naturalWidth * scale;
  const renderedHeight = naturalHeight * scale;
  const renderedLeft = left + (width - renderedWidth) / 2;
  const renderedTop = top + (height - renderedHeight) / 2;
  return isClearCardInteractionPoint(
    { clientX, clientY },
    {
      left: renderedLeft,
      top: renderedTop,
      right: renderedLeft + renderedWidth,
      bottom: renderedTop + renderedHeight,
    },
  );
}

export function shouldProtectClearCardOverlayClick(
  objectHit: boolean | undefined,
  fallbackHit = false,
): boolean {
  return objectHit === true || fallbackHit;
}

export function canStartClearCardPointerInteraction({
  withinBounds,
  objectHit,
}: {
  withinBounds: boolean;
  objectHit: boolean | undefined;
}): boolean {
  return withinBounds || objectHit === true;
}

export function isClearCardImpactKey({
  key,
  repeat,
  altKey,
  ctrlKey,
  metaKey,
}: {
  key: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  if (repeat || altKey || ctrlKey || metaKey) return false;
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

export function createClearCardRevealRequestState(hasKnownCard = false): ClearCardRevealRequestState {
  return hasKnownCard ? 'sent' : 'idle';
}

export function beginClearCardRevealRequest(state: ClearCardRevealRequestState): {
  state: ClearCardRevealRequestState;
  shouldRequest: boolean;
} {
  return state === 'idle'
    ? { state: 'pending', shouldRequest: true }
    : { state, shouldRequest: false };
}

export function settleClearCardRevealRequest(
  status: 'resolved' | 'retry' | void,
): ClearCardRevealRequestState {
  return status === 'resolved' ? 'sent' : 'idle';
}

export function createClearCardGatedHitState(): ClearCardGatedHitState {
  return { recoverableHits: 0, persistentHits: 0 };
}

export function advanceClearCardGatedHit(
  state: Readonly<ClearCardGatedHitState>,
  revealReady: boolean,
): ClearCardGatedHitResult {
  if (!revealReady) {
    const recoverableHits = state.recoverableHits + 1;
    return {
      state: { recoverableHits, persistentHits: state.persistentHits },
      effect: 'recoverable',
      hitIndex: ((recoverableHits - 1) % CLEAR_CARD_RECOVERABLE_HIT_VARIANTS) + 1,
    };
  }

  const persistentHits = state.persistentHits + 1;
  return {
    state: { recoverableHits: state.recoverableHits, persistentHits },
    effect: persistentHits >= CLEAR_CARD_PERSISTENT_HITS_TO_BREAK ? 'break' : 'persistent',
    hitIndex: CLEAR_CARD_RECOVERABLE_HIT_VARIANTS + persistentHits,
  };
}
