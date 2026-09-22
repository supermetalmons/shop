import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listFulfillmentManualReviewCheckouts } from '../api/fulfillment';
import type { FulfillmentManualReviewCheckout, FulfillmentManualReviewCursor } from '../types';
import { DEFAULT_MANUAL_REVIEW_LIMIT } from '../../shared/fulfillmentManualReviewPagination';
import { dedupeManualReviewCheckouts, sortManualReviewCheckouts } from './manualReview';

type ReviewState = {
  generation: number;
  checkouts: FulfillmentManualReviewCheckout[];
  cursors: Record<string, FulfillmentManualReviewCursor | null>;
  errors: Record<string, string>;
  loading: boolean;
};

export function useFulfillmentManualReview(
  options: { walletAddress: string; enabled: boolean; dropIds: readonly string[] },
  list = listFulfillmentManualReviewCheckouts,
) {
  const [state, setState] = useState<ReviewState>({ generation: 0, checkouts: [], cursors: {}, errors: {}, loading: false });
  const generationRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const dropIdsKey = JSON.stringify(options.dropIds);
  const dropIds = useMemo<string[]>(() => JSON.parse(dropIdsKey), [dropIdsKey]);
  const canLoad = options.enabled && Boolean(options.walletAddress) && dropIds.length > 0;

  const loadPages = useCallback(async (
    generation: number,
    requests: { dropId: string; cursor: FulfillmentManualReviewCursor | null }[],
  ) => {
    pendingRef.current = generation;
    setState((previous) => ({ ...previous, loading: true }));
    const results = await Promise.allSettled(requests.map(({ dropId, cursor }) => list({
      dropId, cursor, limit: DEFAULT_MANUAL_REVIEW_LIMIT,
    })));
    if (generationRef.current !== generation) return;
    setState((previous) => {
      const cursors = { ...previous.cursors };
      const errors = { ...previous.errors };
      const checkouts = [...previous.checkouts];
      results.forEach((result, index) => {
        const { dropId } = requests[index];
        if (result.status === 'fulfilled') {
          checkouts.push(...result.value.checkouts);
          cursors[dropId] = result.value.nextCursor;
          delete errors[dropId];
        } else {
          errors[dropId] = result.reason instanceof Error ? result.reason.message : 'Failed to load manual-review checkouts';
        }
      });
      return {
        generation,
        checkouts: sortManualReviewCheckouts(dedupeManualReviewCheckouts(checkouts)),
        cursors, errors, loading: false,
      };
    });
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn('[mons] failed to load fulfillment manual-review checkouts', { dropId: requests[index].dropId, error: result.reason });
      }
    });
  }, [list]);

  useLayoutEffect(() => {
    const generation = ++generationRef.current;
    pendingRef.current = null;
    setState({ generation, checkouts: [], cursors: {}, errors: {}, loading: canLoad });
    if (canLoad) void loadPages(generation, dropIds.map((dropId) => ({ dropId, cursor: null })));
    return () => { generationRef.current += 1; pendingRef.current = null; };
  }, [canLoad, dropIds, loadPages, options.walletAddress]);

  useLayoutEffect(() => {
    if (state.generation === generationRef.current && !state.loading) pendingRef.current = null;
  }, [state]);

  const hasMore = dropIds.some((dropId) => Boolean(state.cursors[dropId]));
  const error = Object.values(state.errors)[0] || null;
  const loadMore = useCallback(async () => {
    if (!canLoad || generationRef.current !== state.generation || pendingRef.current !== null || state.loading) return;
    const requests = dropIds.filter((dropId) => state.errors[dropId] || state.cursors[dropId])
      .map((dropId) => ({ dropId, cursor: state.cursors[dropId] ?? null }));
    if (requests.length) await loadPages(state.generation, requests);
  }, [canLoad, dropIds, loadPages, state]);

  return {
    manualReviewCheckouts: state.checkouts,
    manualReviewHasMore: hasMore,
    manualReviewLoading: state.loading,
    manualReviewError: error,
    loadMoreManualReview: loadMore,
  };
}
