import type { PreorderAvailabilityResponse, PreorderCancelRequest, PreorderOrder, PreorderPrepareRequest, PreorderPrepareResponse, PreorderStatusResponse, PreorderSubmitRequest } from '../../shared/preorders.ts';
import { getPreorderConfig, isPreorderCardId, PREORDER_CARD_COUNT } from '../../shared/preorders.ts';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { callProfileApi, type AuthenticatedApiCall } from '../api/transport';
import { monsApiOrigin } from './monsApiOrigin';

type ApiDependencies = {
  fetch: typeof fetch;
  publicOrigin: () => string;
  authenticatedCall: AuthenticatedApiCall;
};

const defaultDependencies: ApiDependencies = {
  fetch: (input, init) => fetch(input, init),
  publicOrigin: monsApiOrigin,
  authenticatedCall: callProfileApi,
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalidResponse(): Error {
  return new Error('Preorder API returned an invalid response.');
}

function parseOrder(value: unknown, preorderId: string): PreorderOrder {
  const config = getPreorderConfig(preorderId);
  if (!config || !record(value) || value.preorderId !== preorderId ||
    typeof value.orderId !== 'string' || !value.orderId || value.orderId.length > 128 ||
    typeof value.buyer !== 'string' || !isBase58Bytes(value.buyer, 32) ||
    !Array.isArray(value.cardIds) || value.cardIds.length < 1 || value.cardIds.length > config.maxItems ||
    !value.cardIds.every(isPreorderCardId) || new Set(value.cardIds).size !== value.cardIds.length ||
    !Array.isArray(value.assets) || value.assets.length !== value.cardIds.length ||
    !value.assets.every((asset) => record(asset) && isPreorderCardId(asset.id) &&
      (value.cardIds as number[]).includes(asset.id) && typeof asset.address === 'string' && isBase58Bytes(asset.address, 32)) ||
    new Set(value.assets.map((asset) => (asset as { id: number }).id)).size !== value.assets.length ||
    new Set(value.assets.map((asset) => (asset as { address: string }).address)).size !== value.assets.length ||
    !['prepared', 'submitted', 'succeeded', 'failed', 'expired', 'cancelled'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) <= 0 ||
    (value.signature !== null && (typeof value.signature !== 'string' || !isBase58Bytes(value.signature, 64)))
  ) throw invalidResponse();
  return value as unknown as PreorderOrder;
}

export function createPreorderApi(overrides: Partial<ApiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  async function request(action: 'availability' | 'prepare' | 'submit' | 'cancel' | 'status', query: Record<string, string> | null, body?: unknown): Promise<unknown> {
    if (action !== 'availability') return dependencies.authenticatedCall(`/preorders/${action}`, body, undefined, { replaySafe: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      const suffix = query ? `?${new URLSearchParams(query)}` : '';
      const origin = dependencies.publicOrigin();
      const response = await dependencies.fetch(`${origin}/preorders/${action}${suffix}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = record(payload) ? payload.error : null;
        const message = record(error) && typeof error.message === 'string' ? error.message
          : typeof error === 'string' ? error.replaceAll('-', ' ') : 'Preorder request failed.';
        throw new Error(message);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
  function orderResult(payload: unknown, preorderId: string, orderId?: string, allowNull = true): PreorderStatusResponse {
    if (!record(payload) || !Object.hasOwn(payload, 'order')) throw invalidResponse();
    if (payload.order === null) {
      if (!allowNull) throw invalidResponse();
      return { order: null };
    }
    const order = parseOrder(payload.order, preorderId);
    if (orderId && order.orderId !== orderId) throw invalidResponse();
    return { order };
  }
  return {
    async availability(preorderId: string): Promise<PreorderAvailabilityResponse> {
      const payload = await request('availability', { preorderId });
      if (!record(payload) || payload.preorderId !== preorderId || !Array.isArray(payload.items) ||
        payload.items.length !== PREORDER_CARD_COUNT || !payload.items.every((item) => record(item) && isPreorderCardId(item.id) &&
          ['available', 'reserved', 'preordered'].includes(String(item.status))) ||
        new Set(payload.items.map((item) => (item as { id: number }).id)).size !== payload.items.length
      ) throw invalidResponse();
      return payload as unknown as PreorderAvailabilityResponse;
    },
    async prepare(input: PreorderPrepareRequest): Promise<PreorderPrepareResponse> {
      const payload = await request('prepare', null, input);
      if (!record(payload) || (payload.transactionBase64 !== null &&
        (typeof payload.transactionBase64 !== 'string' || !payload.transactionBase64 || payload.transactionBase64.length > 4096))) throw invalidResponse();
      const order = parseOrder(payload.order, input.preorderId);
      if (order.buyer !== input.buyer || order.cardIds.length !== input.cardIds.length ||
        !order.cardIds.every((id) => input.cardIds.includes(id))) throw invalidResponse();
      return { order, transactionBase64: payload.transactionBase64 as string | null };
    },
    async submit(input: PreorderSubmitRequest): Promise<PreorderStatusResponse> {
      return orderResult(await request('submit', null, input), input.preorderId, input.orderId, false);
    },
    async cancel(input: PreorderCancelRequest): Promise<PreorderStatusResponse> {
      return orderResult(await request('cancel', null, input), input.preorderId, input.orderId, false);
    },
    async status(preorderId: string, orderId?: string): Promise<PreorderStatusResponse> {
      return orderResult(await request('status', null, { preorderId, ...(orderId ? { orderId } : {}) }), preorderId, orderId);
    },
  };
}
