import type { PreorderAvailabilityResponse, PreorderCancelRequest, PreorderOrder, PreorderPrepareRequest, PreorderPrepareResponse, PreorderRecoveryResponse, PreorderStatusResponse, PreorderSubmitRequest } from '../../shared/preorders.ts';
import { getPreorderConfig, isPreorderCardId, PREORDER_CARD_COUNT } from '../../shared/preorders.ts';
import { MI_NOTE_SESSION_HEADER, type MiNoteEthereumSession } from '../../shared/miNoteAuth';
import { normalizeMiNoteAddress } from '../../shared/miNoteCards';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { callProfileApi, profileApiTimeoutMs, ProfileApiError, type AuthenticatedApiCall } from '../api/transport';
import { AUTHENTICATED_API_ORIGIN } from './authenticatedApiOrigin';
import { readMiNoteResponse } from './miNoteResponse';

type ApiDependencies = {
  fetch: typeof fetch;
  publicOrigin: () => string;
  authenticatedCall: AuthenticatedApiCall;
};

const defaultDependencies: ApiDependencies = {
  fetch: (input, init) => fetch(input, init),
  publicOrigin: () => AUTHENTICATED_API_ORIGIN,
  authenticatedCall: callProfileApi,
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalidResponse(): Error {
  return new Error('Preorder API returned an invalid response.');
}

export function parsePreorderOrder(value: unknown, preorderId: string): PreorderOrder {
  const config = getPreorderConfig(preorderId);
  if (!config || !record(value) || value.preorderId !== preorderId ||
    typeof value.orderId !== 'string' || !value.orderId || value.orderId.length > 128 ||
    (value.ethereumAddress !== null && normalizeMiNoteAddress(value.ethereumAddress) !== value.ethereumAddress) ||
    typeof value.buyer !== 'string' || !isBase58Bytes(value.buyer, 32) ||
    !Array.isArray(value.cardIds) || value.cardIds.length < 1 || value.cardIds.length > config.maxItems ||
    !value.cardIds.every(isPreorderCardId) || new Set(value.cardIds).size !== value.cardIds.length ||
    !Array.isArray(value.assets) || value.assets.length !== value.cardIds.length ||
    !value.assets.every((asset) => record(asset) && isPreorderCardId(asset.id) &&
      (value.cardIds as number[]).includes(asset.id) && typeof asset.address === 'string' && isBase58Bytes(asset.address, 32)) ||
    new Set(value.assets.map((asset) => (asset as { id: number }).id)).size !== value.assets.length ||
    new Set(value.assets.map((asset) => (asset as { address: string }).address)).size !== value.assets.length ||
    !['prepared', 'submitted', 'succeeded', 'failed', 'expired', 'cancelled'].includes(String(value.status)) ||
    (value.confirmedSlot != null && (!Number.isSafeInteger(value.confirmedSlot) || Number(value.confirmedSlot) < 0 ||
      !['submitted', 'succeeded', 'failed', 'expired'].includes(String(value.status)) || value.signature === null)) ||
    !Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) <= 0 ||
    (value.signature !== null && (typeof value.signature !== 'string' || !isBase58Bytes(value.signature, 64)))
  ) throw invalidResponse();
  return value as unknown as PreorderOrder;
}

export function createPreorderApi(overrides: Partial<ApiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  async function request(action: 'availability' | 'prepare' | 'submit' | 'cancel' | 'status', query: Record<string, string> | null, body?: unknown, session?: MiNoteEthereumSession, signedIn = false): Promise<unknown> {
    const headers: Record<string, string> = session ? { [MI_NOTE_SESSION_HEADER]: session.token } : {};
    if (action !== 'availability') return dependencies.authenticatedCall(`/preorders/${action}`, body, undefined, { replaySafe: true, headers });
    if (signedIn) {
      try { return await dependencies.authenticatedCall('/preorders/availability', query, undefined, { replaySafe: true, headers }); }
      catch (error) { if (!(error instanceof ProfileApiError) || error.status !== 401) throw error; }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), profileApiTimeoutMs('/preorders/availability'));
    try {
      const suffix = query ? `?${new URLSearchParams(query)}` : '';
      const origin = dependencies.publicOrigin();
      const response = await dependencies.fetch(`${origin}/preorders/${action}${suffix}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        headers,
        signal: controller.signal,
      });
      const payload = await readMiNoteResponse(response, controller.signal, 128 * 1024);
      if (!response.ok) {
        const error = record(payload) ? payload.error : null;
        const message = record(error) && typeof error.message === 'string' ? error.message
          : typeof error === 'string' ? error.replaceAll('-', ' ') : 'Preorder request failed.';
        throw new ProfileApiError({ message, status: response.status, code: record(error) && typeof error.code === 'string' ? error.code : 'unavailable' });
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
    const order = parsePreorderOrder(payload.order, preorderId);
    if (orderId && order.orderId !== orderId) throw invalidResponse();
    return { order };
  }
  const api = {
    async availability(preorderId: string, session: MiNoteEthereumSession, signedIn = false): Promise<PreorderAvailabilityResponse> {
      const payload = await request('availability', { preorderId }, undefined, session, signedIn);
      if (!record(payload) || payload.preorderId !== preorderId || !Array.isArray(payload.items) ||
        payload.ethereumAddress !== session.address || !['success', 'partial'].includes(String(payload.ownershipStatus)) ||
        typeof payload.requiresAdminSignIn !== 'boolean' || payload.items.length > PREORDER_CARD_COUNT || !payload.items.every((item) => record(item) && isPreorderCardId(item.id) &&
          ['available', 'reserved', 'preordered'].includes(String(item.status))) ||
        new Set(payload.items.map((item) => (item as { id: number }).id)).size !== payload.items.length
      ) throw invalidResponse();
      return payload as unknown as PreorderAvailabilityResponse;
    },
    async prepare(input: PreorderPrepareRequest, session: MiNoteEthereumSession): Promise<PreorderPrepareResponse> {
      const payload = await request('prepare', null, input, session);
      if (!record(payload) || (payload.transactionBase64 !== null &&
        (typeof payload.transactionBase64 !== 'string' || !payload.transactionBase64 || payload.transactionBase64.length > 4096))) throw invalidResponse();
      const order = parsePreorderOrder(payload.order, input.preorderId);
      if (order.buyer !== input.buyer || order.ethereumAddress !== session.address || order.cardIds.length !== input.cardIds.length ||
        !order.cardIds.every((id) => input.cardIds.includes(id))) throw invalidResponse();
      return { order, transactionBase64: payload.transactionBase64 as string | null };
    },
    async submit(input: PreorderSubmitRequest, session: MiNoteEthereumSession): Promise<PreorderStatusResponse> {
      return orderResult(await request('submit', null, input, session), input.preorderId, input.orderId, false);
    },
    async cancel(input: PreorderCancelRequest): Promise<PreorderStatusResponse> {
      return orderResult(await request('cancel', null, input), input.preorderId, input.orderId, false);
    },
    async status(preorderId: string, orderId?: string): Promise<PreorderStatusResponse> {
      return orderResult(await request('status', null, { preorderId, ...(orderId ? { orderId } : {}) }), preorderId, orderId);
    },
    async recoveries(preorderId: string, recoveryCursor?: string): Promise<PreorderRecoveryResponse> {
      const payload = await request('status', null, { preorderId, includeRecoveries: true, ...(recoveryCursor ? { recoveryCursor } : {}) });
      const result = orderResult(payload, preorderId);
      if (!record(payload) || !Array.isArray(payload.recoveries) || payload.recoveries.length > 20 ||
        !(payload.nextRecoveryCursor === null || typeof payload.nextRecoveryCursor === 'string' && payload.nextRecoveryCursor.length > 0 && payload.nextRecoveryCursor.length <= 1024)) throw invalidResponse();
      const recoveries = payload.recoveries.map(value => parsePreorderOrder(value, preorderId));
      if (recoveries.some(order => order.status !== 'submitted' || order.confirmedSlot == null) ||
        new Set(recoveries.map(order => order.orderId)).size !== recoveries.length ||
        result.order && (result.order.status !== 'prepared' && result.order.status !== 'submitted' || result.order.confirmedSlot != null)) throw invalidResponse();
      return { ...result, recoveries, nextRecoveryCursor: payload.nextRecoveryCursor as string | null };
    },
  };
  return api as Omit<typeof api, 'recoveries'> & Partial<Pick<typeof api, 'recoveries'>>;
}
