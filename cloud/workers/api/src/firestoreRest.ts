import {
  ProfileReadError,
} from './firestoreContract.js';
import {
  CommerceMaintenanceError,
  D1CommerceDocumentStore,
  loadCommerceAuthorityControl,
} from './commerceDocumentStore.js';

export {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  decodeFirestoreFields,
  FirestoreWriteConflict,
  ProfileReadError,
  isRecord,
} from './firestoreContract.js';

export type ProfileProviderFetch = typeof fetch;

export type CommerceDocumentRequest = {
  body?: string;
  commerceDb: D1Database;
  method: 'GET' | 'POST';
  nowMs: number;
  url: string;
};

export type CommerceDocumentRequester = (args: CommerceDocumentRequest) => Promise<unknown | null>;

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

export async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  if (!response.body) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
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
      if (size > maxBytes) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = String(response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await cancelResponseBody(response);
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  try {
    return JSON.parse(await readBoundedText(response, maxBytes, signal));
  } catch (error) {
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
}

export async function commerceDocumentRequest(args: CommerceDocumentRequest): Promise<unknown | null> {
  const control = await loadCommerceAuthorityControl(args.commerceDb);
  if (control.state !== 'd1') throw new CommerceMaintenanceError();
  return new D1CommerceDocumentStore(args.commerceDb).request(args);
}

export function firestoreString(value: string): Record<string, unknown> {
  return { stringValue: value };
}
