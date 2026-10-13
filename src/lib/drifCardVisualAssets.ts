import type { DrifCardConfig } from '../drifCards.ts';
import { createDrifCardVisualAssetsCache } from './drifCardVisualAssetsCache.ts';

export const drifCardVisualAssetsCache = createDrifCardVisualAssetsCache();

export function preloadDrifCardVisualAssets(card: DrifCardConfig) {
  drifCardVisualAssetsCache.preload(card);
}
