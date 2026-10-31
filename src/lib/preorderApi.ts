import type { PreorderCancelRequest, PreorderOrder, PreorderRecoveryResponse, PreorderStatusResponse } from '../../shared/preorders.ts';
import { getPreorderConfig, isPreorderCardId } from '../../shared/preorders.ts';
import { normalizeMiNoteAddress } from '../../shared/miNoteCards';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { callProfileApi, type AuthenticatedApiCall } from '../api/transport';

type ApiDependencies = { authenticatedCall: AuthenticatedApiCall };

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
  const authenticatedCall = overrides.authenticatedCall ?? callProfileApi;
  const request = (path: '/preorders/status' | '/preorders/cancel', body: unknown) =>
    authenticatedCall(path, body, undefined, { replaySafe: true });
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
    async cancel(input: PreorderCancelRequest): Promise<PreorderStatusResponse> {
      return orderResult(await request('/preorders/cancel', input), input.preorderId, input.orderId, false);
    },
    async status(preorderId: string, orderId?: string): Promise<PreorderStatusResponse> {
      return orderResult(await request('/preorders/status', { preorderId, ...(orderId ? { orderId } : {}) }), preorderId, orderId);
    },
    async recoveries(preorderId: string, recoveryCursor?: string): Promise<PreorderRecoveryResponse> {
      const payload = await request('/preorders/status', { preorderId, includeRecoveries: true, ...(recoveryCursor ? { recoveryCursor } : {}) });
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
  return api;
}
