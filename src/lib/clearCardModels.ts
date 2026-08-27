import {
  CLEAR_CARDS_CARD_MODEL_BASE_URL,
  CLEAR_CARDS_PACK_MODEL_URL,
} from '../config/dropMediaDefaults';

export const DEFAULT_CLEAR_PACK_MODEL_URL = CLEAR_CARDS_PACK_MODEL_URL;
export const CLEAR_CARD_MODEL_COUNT = 192;

export type ClearCardModelLoadDecision = 'idle' | 'defer' | 'load';

export function clearCardModelLoadDecision({
  modelUrl,
  hasPackModel,
  packReady,
}: {
  modelUrl: string | undefined;
  hasPackModel: boolean;
  packReady: boolean;
}): ClearCardModelLoadDecision {
  if (!modelUrl) return 'idle';
  return hasPackModel && !packReady ? 'defer' : 'load';
}

export function clearCardModelUrl(cardId: unknown): string | undefined {
  if (typeof cardId !== 'number') return undefined;
  const normalizedCardId = cardId;
  if (!Number.isInteger(normalizedCardId)) return undefined;
  if (normalizedCardId < 1 || normalizedCardId > CLEAR_CARD_MODEL_COUNT) return undefined;
  return `${CLEAR_CARDS_CARD_MODEL_BASE_URL}/${normalizedCardId}.glb`;
}

export function clearCardModelIdFromRevealResult(revealedIds: unknown): number | undefined {
  if (!Array.isArray(revealedIds) || revealedIds.length !== 1) return undefined;
  const cardId = revealedIds[0];
  return typeof cardId === 'number' && clearCardModelUrl(cardId) ? cardId : undefined;
}
