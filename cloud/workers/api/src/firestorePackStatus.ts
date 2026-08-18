import type { PackStatusBreakdown } from '../../../../functions/src/shared/contracts.js';
import {
  isPackStatusSupportedDropId,
  normalizePackStatusBreakdown,
} from '../../../../functions/src/shared/packStatus.js';
import { shopDropById } from '../../../../functions/src/shared/shopDomain.js';

export const FIRESTORE_PACK_STATUS_CACHE_TTL_SECONDS = 15;
export const FIRESTORE_PACK_STATUS_MAX_RESPONSE_BYTES = 16 * 1024;
export const FIRESTORE_PACK_STATUS_TIMEOUT_MS = 10_000;

const FIRESTORE_DOCUMENT_BASE_URL =
  'https://firestore.googleapis.com/v1/projects/mons-shop/databases/(default)/documents';
const FIRESTORE_PACK_STATUS_FIELDS = [
  'version',
  'dropId',
  'totalInitialSupply',
  'totalCards',
  'cardsPerPack',
  'unsealedOnline',
  'redeemedIrlNormal',
  'redeemedIrlStripe',
  'redeemedUnsealedCards',
] as const;

export type FirestorePackStatusFetch = typeof fetch;

export type FirestorePackStatusResult =
  | { ok: true; packStatus: PackStatusBreakdown | null; cacheStatus?: string }
  | { ok: false; error: 'provider-timeout' | 'provider-unavailable'; cacheStatus?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firestoreInteger(value: unknown): number | null {
  if (!isRecord(value) || typeof value.integerValue !== 'string' || !/^-?\d+$/.test(value.integerValue)) {
    return null;
  }
  const parsed = Number(value.integerValue);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function firestoreString(value: unknown): string | null {
  return isRecord(value) && typeof value.stringValue === 'string' ? value.stringValue : null;
}

function packStatusFromFirestoreDocument(value: unknown, dropId: string): PackStatusBreakdown | null {
  if (!isRecord(value) || !isRecord(value.fields)) return null;
  const fields = value.fields;
  const raw = {
    version: firestoreInteger(fields.version),
    dropId: firestoreString(fields.dropId),
    totalInitialSupply: firestoreInteger(fields.totalInitialSupply),
    totalCards: firestoreInteger(fields.totalCards),
    cardsPerPack: firestoreInteger(fields.cardsPerPack),
    unsealedOnline: firestoreInteger(fields.unsealedOnline),
    redeemedIrlNormal: firestoreInteger(fields.redeemedIrlNormal),
    redeemedIrlStripe: firestoreInteger(fields.redeemedIrlStripe),
    redeemedUnsealedCards: firestoreInteger(fields.redeemedUnsealedCards),
  };
  if (Object.values(raw).some((entry) => entry === null)) return null;
  const drop = shopDropById(dropId);
  return normalizePackStatusBreakdown(raw, dropId, drop?.itemsPerBox);
}

function firestorePackStatusUrl(dropId: string): URL {
  const url = new URL(`${FIRESTORE_DOCUMENT_BASE_URL}/drops/${dropId}/meta/packStatus`);
  for (const field of FIRESTORE_PACK_STATUS_FIELDS) url.searchParams.append('mask.fieldPaths', field);
  return url;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (String(response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    await cancelResponseBody(response);
    throw new Error('invalid-content-type');
  }
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > FIRESTORE_PACK_STATUS_MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error('response-too-large');
  }
  if (!response.body) throw new Error('missing-response-body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > FIRESTORE_PACK_STATUS_MAX_RESPONSE_BYTES) throw new Error('response-too-large');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function isPackStatusRouteDropId(dropId: string): boolean {
  const drop = shopDropById(dropId);
  return isPackStatusSupportedDropId(dropId) && drop?.solanaCluster === 'mainnet-beta';
}

export async function fetchFirestorePackStatus(
  dropId: string,
  providerFetch: FirestorePackStatusFetch,
  timeoutMs = FIRESTORE_PACK_STATUS_TIMEOUT_MS,
): Promise<FirestorePackStatusResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Firestore request timed out', 'TimeoutError')),
    timeoutMs,
  );
  let cacheStatus: string | undefined;
  try {
    const response = await providerFetch(firestorePackStatusUrl(dropId), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: {
          '200-299': FIRESTORE_PACK_STATUS_CACHE_TTL_SECONDS,
          '300-399': 0,
          '400-403': 0,
          '404': FIRESTORE_PACK_STATUS_CACHE_TTL_SECONDS,
          '405-499': 0,
          '500-599': 0,
        },
      },
    });
    cacheStatus = response.headers.get('CF-Cache-Status') || undefined;
    if (response.status === 404) {
      await cancelResponseBody(response);
      return { ok: true, packStatus: null, ...(cacheStatus ? { cacheStatus } : {}) };
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return { ok: false, error: 'provider-unavailable', ...(cacheStatus ? { cacheStatus } : {}) };
    }
    const packStatus = packStatusFromFirestoreDocument(
      await readBoundedJson(response, controller.signal),
      dropId,
    );
    if (!packStatus) {
      return { ok: false, error: 'provider-unavailable', ...(cacheStatus ? { cacheStatus } : {}) };
    }
    return { ok: true, packStatus, ...(cacheStatus ? { cacheStatus } : {}) };
  } catch (error) {
    console.error({
      event: 'firestore_pack_status_fetch_error',
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError' },
    });
    return {
      ok: false,
      error: controller.signal.aborted ? 'provider-timeout' : 'provider-unavailable',
      ...(cacheStatus ? { cacheStatus } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}
