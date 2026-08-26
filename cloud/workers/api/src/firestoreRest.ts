import { SignJWT, importPKCS8 } from 'jose';
import {
  FIRESTORE_PROJECT_ID,
  FirestoreWriteConflict,
  ProfileReadError,
  isRecord,
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

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const MAX_FIRESTORE_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_METADATA_BYTES = 64 * 1024;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export type ProfileProviderFetch = typeof fetch;

type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
  projectId: string;
};

type CachedAccessToken = {
  clientEmail: string;
  token: string;
  expiresAtMs: number;
};

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

function parseServiceAccount(value: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  }
  if (!isRecord(parsed)) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
  const privateKey = rawPrivateKey ? `${rawPrivateKey.trimEnd()}\n` : '';
  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  if (
    !clientEmail.endsWith('.iam.gserviceaccount.com') ||
    clientEmail.length > 320 ||
    projectId !== FIRESTORE_PROJECT_ID ||
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !privateKey.endsWith('-----END PRIVATE KEY-----\n') ||
    privateKey.length > 32 * 1024
  ) {
    throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  }
  return { clientEmail, privateKey, projectId };
}

export function createGoogleAccessTokenProvider() {
  let cache: CachedAccessToken | null = null;

  return {
    invalidate(): void {
      cache = null;
    },
    async get(
      serviceAccountJson: string,
      providerFetch: ProfileProviderFetch,
      signal: AbortSignal,
      nowMs = Date.now(),
    ): Promise<string> {
      const serviceAccount = parseServiceAccount(serviceAccountJson);
      if (
        cache?.clientEmail === serviceAccount.clientEmail &&
        cache.expiresAtMs - ACCESS_TOKEN_REFRESH_SKEW_MS > nowMs
      ) {
        return cache.token;
      }
      let key: Awaited<ReturnType<typeof importPKCS8>>;
      try {
        key = await importPKCS8(serviceAccount.privateKey, 'RS256');
      } catch {
        throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
      }
      const issuedAt = Math.floor(nowMs / 1000);
      let assertion: string;
      try {
        assertion = await new SignJWT({ scope: GOOGLE_DATASTORE_SCOPE })
          .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
          .setIssuer(serviceAccount.clientEmail)
          .setSubject(serviceAccount.clientEmail)
          .setAudience(GOOGLE_OAUTH_TOKEN_URL)
          .setIssuedAt(issuedAt)
          .setExpirationTime(issuedAt + 3600)
          .sign(key);
      } catch {
        throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
      }
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await providerFetch(GOOGLE_OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion,
            }).toString(),
            redirect: 'manual',
            signal,
          });
        } catch {
          if (signal.aborted) {
            throw new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
          }
          if (attempt === 0) continue;
          throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
        }
        if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt === 0) {
          await cancelResponseBody(response);
          response = undefined;
          continue;
        }
        break;
      }
      if (!response?.ok) {
        if (response) await cancelResponseBody(response);
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      }
      const payload = await readBoundedJson(response, MAX_PROVIDER_METADATA_BYTES, signal);
      if (!isRecord(payload)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      const token = typeof payload.access_token === 'string' ? payload.access_token : '';
      const tokenType = typeof payload.token_type === 'string' ? payload.token_type : '';
      const expiresIn = Number(payload.expires_in);
      if (!token || token.length > 16 * 1024 || tokenType.toLowerCase() !== 'bearer' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      }
      cache = {
        clientEmail: serviceAccount.clientEmail,
        token,
        expiresAtMs: nowMs + Math.min(3600, Math.floor(expiresIn)) * 1000,
      };
      return token;
    },
  };
}

export type GoogleAccessTokenProvider = ReturnType<typeof createGoogleAccessTokenProvider>;

async function pauseForRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, 100);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function authenticatedFirestoreRequest(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  body?: string;
  commerceDb?: D1Database;
  method: 'GET' | 'POST';
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
  surfaceWriteConflict?: boolean;
  url: string;
}): Promise<unknown | null> {
  if (args.commerceDb) {
    const control = await loadCommerceAuthorityControl(args.commerceDb);
    if (control.state === 'd1') {
      return new D1CommerceDocumentStore(args.commerceDb).request(args);
    }
    if (
      control.state === 'paused' &&
      args.method === 'POST' &&
      (args.url.endsWith('/documents:beginTransaction') || args.url.endsWith('/documents:commit'))
    ) throw new CommerceMaintenanceError();
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await args.accessTokenProvider.get(
      args.serviceAccountJson,
      args.providerFetch,
      args.signal,
      args.nowMs,
    );
    let response: Response;
    try {
      response = await args.providerFetch(args.url, {
        method: args.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(args.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(args.body ? { body: args.body } : {}),
        redirect: 'manual',
        signal: args.signal,
      });
    } catch {
      if (args.signal.aborted) throw args.signal.reason;
      if (attempt === 0) {
        await pauseForRetry(args.signal);
        continue;
      }
      throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    }
    if (response.status === 404 && args.method === 'GET') {
      await cancelResponseBody(response);
      return null;
    }
    if (response.status === 401 && attempt === 0) {
      await cancelResponseBody(response);
      args.accessTokenProvider.invalidate();
      continue;
    }
    if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt === 0) {
      await cancelResponseBody(response);
      await pauseForRetry(args.signal);
      continue;
    }
    if (args.surfaceWriteConflict && (response.status === 400 || response.status === 409)) {
      const payload = await readBoundedJson(response, MAX_FIRESTORE_RESPONSE_BYTES, args.signal);
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      if (
        error.status === 'ABORTED' ||
        error.status === 'ALREADY_EXISTS' ||
        error.status === 'FAILED_PRECONDITION'
      ) {
        throw new FirestoreWriteConflict(error.status);
      }
      throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    }
    return readBoundedJson(response, MAX_FIRESTORE_RESPONSE_BYTES, args.signal);
  }
  throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
}

export function firestoreString(value: string): Record<string, unknown> {
  return { stringValue: value };
}
