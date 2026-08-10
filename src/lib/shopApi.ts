import {
  isExactShopApiErrorResponse,
  isExactShopInventoryResponse,
  isExactShopPendingOpenBoxesResponse,
  type ShopExpectedAssetIds,
  type ShopInventoryRequest,
  type ShopInventoryItem,
  type ShopPendingOpenBoxesRequest,
} from '../../functions/src/shared/shopApi.ts';
import type { InventoryItem, PendingOpenBox } from '../types';
import {
  normalizeBoxDisplayImage,
  normalizeCertificateDisplayImage,
  normalizeFigureDisplayImage,
} from './dropContent';
import { monsApiOrigin } from './monsApiOrigin';

const CLIENT_TIMEOUT_MS = 70_000;

export type DropFetchOptions = {
  includeDevnet?: boolean;
  signal?: AbortSignal;
};

export type InventoryFetchOptions = DropFetchOptions & {
  expectedAssetIds?: ShopExpectedAssetIds;
};

async function postShopApi(
  pathname: '/inventory' | '/pending-open-boxes',
  requestBody: ShopInventoryRequest | ShopPendingOpenBoxesRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), CLIENT_TIMEOUT_MS);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetch(`${monsApiOrigin()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new Error('Shop API returned malformed JSON', { cause: error });
    }
    if (!response.ok) {
      const code = isExactShopApiErrorResponse(payload) ? payload.error : `http-${response.status}`;
      throw new Error(`Shop API request failed: ${code}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function normalizeInventoryItem(item: ShopInventoryItem): InventoryItem {
  const image = item.kind === 'dude'
    ? normalizeFigureDisplayImage(item.dropId, item.rawImage, item.dudeId)
    : item.kind === 'certificate'
      ? normalizeCertificateDisplayImage({
        dropId: item.dropId,
        imageRaw: item.rawImage,
        figureId: item.dudeId,
        boxId: item.boxId,
      })
      : normalizeBoxDisplayImage({ dropId: item.dropId, imageRaw: item.rawImage, boxId: item.boxId });
  return {
    id: item.id,
    dropId: item.dropId,
    name: item.name,
    kind: item.kind,
    image,
    ...(item.boxId ? { boxId: item.boxId } : {}),
    ...(item.dudeId != null ? { dudeId: item.dudeId } : {}),
  };
}

export async function fetchInventory(owner: string, options: InventoryFetchOptions = {}): Promise<InventoryItem[]> {
  const expectedAssetIds = options.expectedAssetIds;
  const hasExpectedAssetIds = Boolean(
    expectedAssetIds?.['mainnet-beta']?.length || expectedAssetIds?.devnet?.length,
  );
  const requestBody: ShopInventoryRequest = {
    owner,
    ...(options.includeDevnet === true ? { includeDevnet: true } : {}),
    ...(hasExpectedAssetIds ? { expectedAssetIds } : {}),
  };
  const payload = await postShopApi(
    '/inventory',
    requestBody,
    options.signal,
  );
  if (!isExactShopInventoryResponse(payload)) throw new Error('Shop API returned an invalid inventory response');
  return payload.items.map(normalizeInventoryItem);
}

export async function fetchPendingOpenBoxes(owner: string, options: DropFetchOptions = {}): Promise<PendingOpenBox[]> {
  const payload = await postShopApi(
    '/pending-open-boxes',
    options.includeDevnet === true ? { owner, includeDevnet: true } : { owner },
    options.signal,
  );
  if (!isExactShopPendingOpenBoxesResponse(payload)) throw new Error('Shop API returned an invalid pending-open response');
  return payload.items;
}
