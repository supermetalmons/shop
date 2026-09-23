import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  getAdminProfileView,
  getAnonymousStripeDeliveryHistory,
  getProfileShipments,
} from '../api/profile';
import {
  DEFAULT_SHIPMENT_PAGE_LIMIT,
  type ShipmentHistoryCursor,
  type ShipmentHistoryPage,
  type ShipmentPageRequest,
} from '../../shared/shipmentHistory.ts';

export type ShipmentHistoryIdentity = {
  authSubject: string;
  sessionWallet: string | null;
  scope: 'wallet' | 'admin' | 'anonymous';
  owner: string;
};

type ShipmentHistoryOptions = {
  identity: ShipmentHistoryIdentity | null;
  initialPage?: ShipmentHistoryPage;
  revision: number;
};

async function loadShipmentPage(identity: ShipmentHistoryIdentity, page: ShipmentPageRequest): Promise<ShipmentHistoryPage> {
  if (identity.scope === 'wallet') return getProfileShipments(identity.owner, page);
  if (identity.scope === 'admin') {
    const response = await getAdminProfileView(identity.owner, page);
    return { orders: response.profile.orders ?? [], nextCursor: response.nextCursor ?? null };
  }
  const response = await getAnonymousStripeDeliveryHistory(page);
  return { orders: response.orders, nextCursor: response.nextCursor ?? null };
}

const DEFAULT_RUNTIME = { loadPage: loadShipmentPage };

export function useShipmentHistory(
  { identity, initialPage, revision }: ShipmentHistoryOptions,
  runtime: typeof DEFAULT_RUNTIME = DEFAULT_RUNTIME,
) {
  const client = useQueryClient();
  const key = JSON.stringify(identity ? [identity.authSubject, identity.sessionWallet, identity.scope, identity.owner] : null);
  const queryKey = useMemo(() => ['shipmentHistory', key] as const, [key]);
  const seeded = useRef<{ key: string; revision: number } | null>(null);
  const refreshRun = useRef<{ key: string; pending: boolean } | null>(null);
  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(identity && initialPage),
    initialPageParam: null as ShipmentHistoryCursor | null,
    initialData: initialPage ? { pages: [initialPage], pageParams: [null] } : undefined,
    queryFn: async ({ pageParam, signal }) => {
      signal.throwIfAborted();
      if (!identity) throw new Error('Shipment history identity is unavailable');
      const page = await runtime.loadPage(identity, { limit: DEFAULT_SHIPMENT_PAGE_LIMIT, cursor: pageParam });
      signal.throwIfAborted();
      if (page.nextCursor && pageParam && (
        page.nextCursor.sortAtMs > pageParam.sortAtMs ||
        (page.nextCursor.sortAtMs === pageParam.sortAtMs && page.nextCursor.documentPath >= pageParam.documentPath)
      )) throw new Error('Shipment history cursor did not advance');
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { refetch } = query;

  const refreshRetainedPages = useCallback(() => {
    if (refreshRun.current?.key === key) {
      refreshRun.current.pending = true;
      return;
    }
    const run = { key, pending: true };
    refreshRun.current = run;
    void (async () => {
      try {
        if (client.getQueryState(queryKey)?.fetchStatus !== 'idle') {
          await refetch({ cancelRefetch: false });
        }
        while (refreshRun.current === run && run.pending) {
          run.pending = false;
          await refetch({ cancelRefetch: false });
        }
      } finally {
        if (refreshRun.current === run) refreshRun.current = null;
      }
    })();
  }, [client, key, queryKey, refetch]);

  useEffect(() => {
    if (!identity || !initialPage || (seeded.current?.key === key && seeded.current.revision === revision)) return;
    const firstSeed = seeded.current?.key !== key;
    seeded.current = { key, revision };
    const cached = client.getQueryData<InfiniteData<ShipmentHistoryPage, ShipmentHistoryCursor | null>>(queryKey);
    if (!cached || (firstSeed && cached.pages.length <= 1)) {
      void client.cancelQueries({ queryKey, exact: true }).then(() => {
        if (seeded.current?.key !== key || seeded.current.revision !== revision) return;
        client.setQueryData(queryKey, { pages: [initialPage], pageParams: [null] });
      });
    } else if (cached.pages.length <= 1 && !refreshRun.current &&
      (client.getQueryState(queryKey)?.fetchStatus ?? 'idle') === 'idle') {
      client.setQueryData(queryKey, { pages: [initialPage], pageParams: [null] });
    } else {
      refreshRetainedPages();
    }
  }, [client, identity, initialPage, key, queryKey, refreshRetainedPages, revision]);

  useEffect(() => () => {
    seeded.current = null;
    refreshRun.current = null;
    void client.cancelQueries({ queryKey, exact: true });
    client.removeQueries({ queryKey, exact: true });
  }, [client, queryKey]);

  const orders = useMemo(() => {
    const unique = new Map<string, ShipmentHistoryPage['orders'][number]>();
    for (const page of query.data?.pages ?? []) {
      for (const order of page.orders) {
        const id = JSON.stringify([order.dropId, order.deliveryId]);
        if (!unique.has(id)) unique.set(id, order);
      }
    }
    return [...unique.values()];
  }, [query.data]);
  const loadingRef = useRef<string | null>(null);
  const fetchMore = useCallback(async () => {
    if (loadingRef.current === key || query.isFetching || !query.hasNextPage || !identity) return;
    loadingRef.current = key;
    try {
      await query.fetchNextPage({ cancelRefetch: false });
    } finally {
      if (loadingRef.current === key) loadingRef.current = null;
    }
  }, [identity, key, query.fetchNextPage, query.hasNextPage, query.isFetching]);
  const retry = useCallback(async () => {
    if (query.isFetchNextPageError) await fetchMore();
    else await refetch({ cancelRefetch: false });
  }, [fetchMore, query.isFetchNextPageError, refetch]);

  return {
    orders: identity ? orders : [],
    hasMore: Boolean(identity && query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    fetching: query.isFetching,
    error: query.error,
    fetchMore,
    retry,
  };
}
