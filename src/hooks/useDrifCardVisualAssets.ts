import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getDrifCardVisualAssetSources, type DrifCardConfig } from '../drifCards.ts';
import { drifCardVisualAssetsCache } from '../lib/drifCardVisualAssets.ts';

export function useDrifCardVisualAssets(
  card: DrifCardConfig | undefined,
  cache = drifCardVisualAssetsCache,
) {
  const key = card ? JSON.stringify(getDrifCardVisualAssetSources(card)) : null;
  const currentCard = useMemo(() => card, [key]);
  const subscribe = useCallback((listener: () => void) => cache.subscribe(currentCard, listener), [cache, currentCard]);
  const getSnapshot = useCallback(() => cache.getSnapshot(currentCard), [cache, currentCard]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
