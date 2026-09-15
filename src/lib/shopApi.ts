import {
  isExactShopApiErrorResponse,
  isExactShopInventoryResponse,
  isExactShopPackStatusResponse,
  isExactShopPendingOpenBoxesResponse,
  type ShopExpectedAssetIds,
  type ShopInventoryRequest,
  type ShopInventoryItem,
  type ShopPendingOpenBoxesRequest,
} from '../../shared/shopApi.ts';
import type { PackStatusBreakdown } from '../../shared/contracts.ts';
import {
  isExactMiNoteCardsEvent,
  MAX_MI_NOTE_STREAM_BYTES,
  MAX_MI_NOTE_TOKEN_IDS,
  MI_NOTE_CARDS_API_PATH,
  MI_NOTE_CONTRACT_ADDRESSES,
  type MiNoteCardsOutcome,
  type MiNoteContractAddress,
} from '../../shared/miNoteCards.ts';
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

async function requestShopApi(
  pathname: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), CLIENT_TIMEOUT_MS);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetch(`${monsApiOrigin()}${pathname}`, {
      ...init,
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

async function postShopApi(
  pathname: '/inventory' | '/pending-open-boxes',
  requestBody: ShopInventoryRequest | ShopPendingOpenBoxesRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestShopApi(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  }, signal);
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

export async function fetchPackStatus(dropId: string, signal?: AbortSignal): Promise<PackStatusBreakdown | null> {
  const payload = await requestShopApi(`/pack-status/${encodeURIComponent(dropId)}`, { method: 'GET' }, signal);
  if (!isExactShopPackStatusResponse(payload) || (payload.packStatus !== null && payload.packStatus.dropId !== dropId)) {
    throw new Error('Shop API returned an invalid pack-status response');
  }
  return payload.packStatus;
}

export async function fetchMiNoteHoldings(
  address: string,
  onOutcome: (outcome: MiNoteCardsOutcome) => void,
  signal?: AbortSignal,
): Promise<void> {
  const invalidResponse = () => new Error('Shop API returned an invalid Mi Note cards response');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAborted: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abortRead = () => {
    rejectAborted(controller.signal.reason);
    void reader?.cancel(controller.signal.reason).catch(() => {});
  };
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), CLIENT_TIMEOUT_MS);
  controller.signal.addEventListener('abort', abortRead, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const response = await Promise.race([
      fetch(`${monsApiOrigin()}${MI_NOTE_CARDS_API_PATH}?address=${encodeURIComponent(address)}`, {
        method: 'GET',
        headers: { Accept: 'application/x-ndjson' },
        cache: 'no-store',
        signal: controller.signal,
      }).then((result) => {
        if (controller.signal.aborted) {
          void result.body?.cancel(controller.signal.reason).catch(() => {});
          throw controller.signal.reason;
        }
        return result;
      }),
      aborted,
    ]);
    if (!response.body) throw invalidResponse();
    reader = response.body.getReader();
    if (response.ok && response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson') {
      throw invalidResponse();
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const contracts = new Set<MiNoteContractAddress>();
    let bytes = 0;
    let totalIds = 0;
    let pending = '';
    let done = false;
    const consumeLine = (line: string) => {
      if (line.trim() === '') return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw invalidResponse(); }
      if (done || !isExactMiNoteCardsEvent(event)) throw invalidResponse();
      if (event.type === 'done') {
        if (contracts.size !== MI_NOTE_CONTRACT_ADDRESSES.length) throw invalidResponse();
        done = true;
        return;
      }
      if (contracts.has(event.contractAddress)) throw invalidResponse();
      if (event.type === 'collection') totalIds += event.tokenIds.length;
      if (totalIds > MAX_MI_NOTE_TOKEN_IDS) throw invalidResponse();
      contracts.add(event.contractAddress);
      controller.signal.throwIfAborted();
      onOutcome(event);
    };
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      controller.signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_MI_NOTE_STREAM_BYTES) throw invalidResponse();
      pending += decoder.decode(chunk.value, { stream: true });
      if (!response.ok) continue;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (!response.ok) {
      let payload: unknown;
      try { payload = JSON.parse(pending); } catch {}
      const code = isExactShopApiErrorResponse(payload) ? payload.error : `http-${response.status}`;
      throw new Error(`Shop API request failed: ${code}`);
    }
    if (pending) consumeLine(pending);
    if (!done) throw invalidResponse();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', abortRead);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
