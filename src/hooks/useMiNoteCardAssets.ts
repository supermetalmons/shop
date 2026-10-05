import { useCallback, useEffect, useMemo, useState } from 'react';
import { drifCardIdentityKey, type DrifCardConfig } from '../drifCards.ts';
import { loadMiNoteCardAssets, type MiNoteCardAssetResidency } from '../lib/miNoteCardAssets.ts';

type MiNoteCardAssetState = {
  key: string;
  attempt: number;
  ready: boolean;
  error: Error | null;
};

export function useMiNoteCardAssets(
  cards: readonly DrifCardConfig[],
  loadAssets = loadMiNoteCardAssets,
) {
  const key = JSON.stringify(cards.map(drifCardIdentityKey));
  const currentCards = useMemo(() => [...cards], [key]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<MiNoteCardAssetState>({ key, attempt, ready: false, error: null });
  const retry = useCallback(() => { setAttempt((current) => current + 1); }, []);

  useEffect(() => {
    const controller = new AbortController();
    let residency: MiNoteCardAssetResidency | null = null;
    setState({ key, attempt, ready: false, error: null });
    if (currentCards.length > 0) {
      void loadAssets(currentCards, { signal: controller.signal }).then(
        (loaded) => {
          if (controller.signal.aborted) {
            loaded.release();
            return;
          }
          residency = loaded;
          setState({ key, attempt, ready: true, error: null });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            key,
            attempt,
            ready: false,
            error: error instanceof Error ? error : new Error('Unable to preload card assets.'),
          });
        },
      );
    }
    return () => {
      controller.abort();
      residency?.release();
    };
  }, [attempt, currentCards, key, loadAssets]);

  const current = state.key === key && state.attempt === attempt;
  return { ready: current && state.ready, error: current ? state.error : null, retry };
}
