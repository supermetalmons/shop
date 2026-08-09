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
