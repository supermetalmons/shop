import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { listFulfillmentManualReviewCheckouts, listFulfillmentOrders } from '../api/fulfillment';
import type { FulfillmentManualReviewCheckout, FulfillmentOrder, FulfillmentOrdersCursor } from '../types';
import { dedupeManualReviewCheckouts, sortManualReviewCheckouts } from './manualReview';
import { dedupeOrdersByKey, fulfillmentOrderKey, sortFulfillmentOrders } from './orders';

const FULFILLMENT_ORDER_REQUEST_LIMIT = 1000;
const defaultFulfillmentApi = { listFulfillmentOrders, listFulfillmentManualReviewCheckouts };

type CursorsByDropId = Record<string, FulfillmentOrdersCursor | null>;
type OrderUpdater = (order: FulfillmentOrder) => FulfillmentOrder;

type FulfillmentOrdersState = {
  generation: number;
  orders: FulfillmentOrder[];
  orderPageKeys: string[][];
  cursorsByDropId: CursorsByDropId;
  manualReviewCheckouts: FulfillmentManualReviewCheckout[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  ordersError: string | null;
};

type FulfillmentOrdersAction =
  | { type: 'reset'; generation: number; enabled: boolean }
  | {
      type: 'initialLoaded';
      orders: FulfillmentOrder[];
      cursorsByDropId: CursorsByDropId;
      manualReviewCheckouts: FulfillmentManualReviewCheckout[];
    }
  | { type: 'moreStarted' }
  | { type: 'moreLoaded'; orders: FulfillmentOrder[]; cursorsByDropId: CursorsByDropId }
  | { type: 'failed'; error: string }
  | { type: 'updateOrder'; key: string; update: OrderUpdater }
  | { type: 'setError'; error: string | null };

function createFulfillmentOrdersState(generation = 0, enabled = false): FulfillmentOrdersState {
  return {
    generation,
    orders: [],
    orderPageKeys: [],
    cursorsByDropId: {},
    manualReviewCheckouts: [],
    loading: enabled,
    loadingMore: false,
    hasMore: enabled,
    ordersError: null,
  };
}

function fulfillmentOrdersReducer(state: FulfillmentOrdersState, action: FulfillmentOrdersAction): FulfillmentOrdersState {
  switch (action.type) {
    case 'reset':
      return createFulfillmentOrdersState(action.generation, action.enabled);
    case 'initialLoaded':
      return {
        ...state,
        orders: action.orders,
        orderPageKeys: action.orders.length ? [action.orders.map(fulfillmentOrderKey)] : [],
        cursorsByDropId: action.cursorsByDropId,
        manualReviewCheckouts: action.manualReviewCheckouts,
        hasMore: Object.values(action.cursorsByDropId).some(Boolean),
        loading: false,
      };
    case 'moreStarted':
      return { ...state, loadingMore: true, ordersError: null };
    case 'moreLoaded':
      return {
        ...state,
        orders: state.orders.concat(action.orders),
        orderPageKeys: action.orders.length
          ? state.orderPageKeys.concat([action.orders.map(fulfillmentOrderKey)])
          : state.orderPageKeys,
        cursorsByDropId: action.cursorsByDropId,
        hasMore: Object.values(action.cursorsByDropId).some(Boolean),
        loadingMore: false,
      };
    case 'failed':
      return { ...state, ordersError: action.error, loading: false, loadingMore: false };
    case 'updateOrder':
      return {
        ...state,
        orders: state.orders.map((order) => fulfillmentOrderKey(order) === action.key ? action.update(order) : order),
      };
    case 'setError':
      return { ...state, ordersError: action.error };
  }
}

type FulfillmentOrdersOptions = {
  walletAddress: string;
  enabled: boolean;
  dropIds: readonly string[];
  onReset: () => void;
};

export function useFulfillmentOrders(
  { walletAddress, enabled, dropIds, onReset }: FulfillmentOrdersOptions,
  api = defaultFulfillmentApi,
) {
  const [state, dispatch] = useReducer(fulfillmentOrdersReducer, undefined, createFulfillmentOrdersState);
  const generationRef = useRef(0);
  const paginationPendingRef = useRef(false);
  const dropIdsKey = JSON.stringify(dropIds);
  const selectedDropIds = useMemo<string[]>(() => JSON.parse(dropIdsKey), [dropIdsKey]);
  const canLoad = enabled && Boolean(walletAddress) && selectedDropIds.length > 0;
  const isCurrentScope = useCallback(
    () => canLoad && generationRef.current === state.generation,
    [canLoad, state.generation],
  );

  useLayoutEffect(() => {
    if (!state.loadingMore) paginationPendingRef.current = false;
  }, [state]);

  useLayoutEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    paginationPendingRef.current = false;
    dispatch({ type: 'reset', generation, enabled: canLoad });
    onReset();

    const loadInitial = async () => {
      try {
        const responses = await Promise.all(selectedDropIds.map(async (dropId) => {
          const [ordersResponse, manualReviewResponse] = await Promise.all([
            api.listFulfillmentOrders({ limit: FULFILLMENT_ORDER_REQUEST_LIMIT, cursor: null, dropId }),
            api.listFulfillmentManualReviewCheckouts({ dropId }).catch((error) => {
              if (isCurrent()) {
                console.warn('[mons] failed to load fulfillment manual-review checkouts', { dropId, error });
              }
              return { checkouts: [] as FulfillmentManualReviewCheckout[] };
            }),
          ]);
          return {
            dropId,
            orders: Array.isArray(ordersResponse.orders) ? ordersResponse.orders : [],
            nextCursor: ordersResponse.nextCursor || null,
            checkouts: Array.isArray(manualReviewResponse.checkouts) ? manualReviewResponse.checkouts : [],
          };
        }));
        if (!isCurrent()) return;
        const orders = sortFulfillmentOrders(dedupeOrdersByKey(responses.flatMap((response) => response.orders)));
        const cursorsByDropId = Object.fromEntries(responses.map((response) => [response.dropId, response.nextCursor]));
        const manualReviewCheckouts = sortManualReviewCheckouts(
          dedupeManualReviewCheckouts(responses.flatMap((response) => response.checkouts)),
        );
        dispatch({ type: 'initialLoaded', orders, cursorsByDropId, manualReviewCheckouts });
      } catch (error) {
        if (!isCurrent()) return;
        console.error(error);
        dispatch({ type: 'failed', error: error instanceof Error ? error.message : 'Failed to load orders' });
      }
    };

    if (canLoad) void loadInitial();
    return () => {
      generationRef.current += 1;
      paginationPendingRef.current = false;
    };
  }, [api, canLoad, enabled, onReset, selectedDropIds, walletAddress]);

  const loadMore = useCallback(async () => {
    if (!isCurrentScope() || paginationPendingRef.current || state.loading || state.loadingMore || !state.hasMore) return;
    const dropIdsWithMore = selectedDropIds.filter((dropId) => state.cursorsByDropId[dropId]);
    if (!dropIdsWithMore.length) {
      dispatch({ type: 'moreLoaded', orders: [], cursorsByDropId: state.cursorsByDropId });
      return;
    }
    paginationPendingRef.current = true;
    dispatch({ type: 'moreStarted' });
    const existingOrderKeys = new Set(state.orders.map(fulfillmentOrderKey));
    try {
      const responses = await Promise.all(dropIdsWithMore.map(async (dropId) => {
        const response = await api.listFulfillmentOrders({
          limit: FULFILLMENT_ORDER_REQUEST_LIMIT,
          cursor: state.cursorsByDropId[dropId],
          dropId,
        });
        return {
          dropId,
          orders: Array.isArray(response.orders) ? response.orders : [],
          nextCursor: response.nextCursor || null,
        };
      }));
      if (!isCurrentScope()) return;
      const cursorsByDropId = { ...state.cursorsByDropId };
      responses.forEach((response) => { cursorsByDropId[response.dropId] = response.nextCursor; });
      const orders = sortFulfillmentOrders(dedupeOrdersByKey(responses.flatMap((response) => response.orders), existingOrderKeys));
      dispatch({ type: 'moreLoaded', orders, cursorsByDropId });
    } catch (error) {
      if (!isCurrentScope()) return;
      console.error(error);
      dispatch({ type: 'failed', error: error instanceof Error ? error.message : 'Failed to load more orders' });
    }
  }, [api, isCurrentScope, selectedDropIds, state]);

  const updateOrder = useCallback((key: string, update: OrderUpdater) => {
    if (isCurrentScope()) dispatch({ type: 'updateOrder', key, update });
  }, [isCurrentScope]);
  const setOrdersError = useCallback((error: string | null) => {
    if (isCurrentScope()) dispatch({ type: 'setError', error });
  }, [isCurrentScope]);

  return {
    scopeVersion: state.generation,
    orders: state.orders,
    orderPageKeys: state.orderPageKeys,
    manualReviewCheckouts: state.manualReviewCheckouts,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    ordersError: state.ordersError,
    loadMore,
    updateOrder,
    setOrdersError,
    isCurrentScope,
  };
}
