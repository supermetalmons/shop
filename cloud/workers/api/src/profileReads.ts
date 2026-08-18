import { SignJWT, importPKCS8 } from 'jose';
import {
  deliveryOrderSummarySortAt,
  parseDeliveryOrderSummary,
  PROFILE_SHIPMENT_STATUSES,
} from '../../../../functions/src/shared/deliveryOrderSummary.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  walletHasAdminAccess,
} from '../../../../functions/src/shared/fulfillmentAccess.js';
import type {
  DeliveryOrderSummary,
  GetAdminProfileViewResponse,
  GetProfileStateResponse,
  GetProfileShipmentsRequest,
  GetProfileShipmentsResponse,
  ProfileStateProfile,
  ProfileStateSection,
} from '../../../../functions/src/shared/contracts.js';
import { normalizeDropId } from '../../../../functions/src/shared/deploymentCore.js';
import { parseCanonicalPositiveInteger } from '../../../../functions/src/shared/positiveInteger.js';
import { isBase58Bytes } from '../../../../functions/src/shared/solanaRpcProxy.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdTokenFetch,
  type FirebaseIdentity,
} from './firebaseIdToken.js';

export const PROFILE_SHIPMENTS_PATH = '/profile/shipments';
export const PROFILE_STATE_PATH = '/profile/state';
export const ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH = '/profile/anonymous-stripe-delivery-history';
export const ADMIN_PROFILE_PATH = '/admin/profile';
export const PROFILE_READ_PATHS = new Set([
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  ADMIN_PROFILE_PATH,
]);

const PROFILE_CORS_ALLOW_HEADERS = 'Content-Type, Authorization';
const PROFILE_CORS_ALLOW_METHODS = 'POST, OPTIONS';

const FIRESTORE_PROJECT_ID = 'mons-shop';
const FIRESTORE_DOCUMENTS_BASE_URL =
  `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents`;
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const MAX_PROFILE_REQUEST_BYTES = 1024;
const MAX_FIRESTORE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_METADATA_BYTES = 64 * 1024;
const PROFILE_READ_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
const DELIVERY_ORDER_SUMMARY_FIELDS = [
  'dropId',
  'deliveryId',
  'source',
  'status',
  'stripeCheckoutSessionId',
  'createdAt',
  'processingAt',
  'processedAt',
  'items',
  'fulfillmentStatus',
  'fulfillmentTrackingCode',
  'fulfillmentUpdatedAt',
] as const;
const PROFILE_SHIPMENT_FIELDS = [
  'dropId',
  'deliveryId',
  'status',
  'stripeCheckoutSessionId',
  'createdAt',
  'processingAt',
  'processedAt',
  'items',
  'fulfillmentStatus',
  'fulfillmentTrackingCode',
  'fulfillmentUpdatedAt',
  'sortAt',
] as const;

export type ProfileReadPath =
  | typeof PROFILE_SHIPMENTS_PATH
  | typeof PROFILE_STATE_PATH
  | typeof ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH
  | typeof ADMIN_PROFILE_PATH;

type ProfileReadMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type ProfileReadResult = {
  response: Response;
  metrics: ProfileReadMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  profileStateSections?: {
    profile: 'ready' | 'error' | 'not-applicable';
    shipments: 'ready' | 'error' | 'not-applicable';
  };
};

export type ProfileProviderFetch = FirebaseIdTokenFetch;

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

export class ProfileReadError extends Error {
  constructor(
    readonly code:
      | 'invalid-argument'
      | 'unauthenticated'
      | 'permission-denied'
      | 'deadline-exceeded'
      | 'unavailable'
      | 'internal',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileReadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isAllowedProfileOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.protocol === 'https:' && (url.hostname === 'mons.shop' || url.hostname === 'www.mons.shop')) return true;
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) return true;
  if (url.protocol !== 'https:') return false;
  const match = url.hostname.match(/^([^.]+)-mons-shop\.lil-org\.workers\.dev$/);
  return match?.[1] === 'candidate' || /^[0-9a-f]{8}$/i.test(match?.[1] || '');
}

function profileCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': PROFILE_CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': PROFILE_CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

export function handleProfileCorsPreflight(request: Request): Response {
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedProfileOrigin(origin)) {
    return errorResponse(new ProfileReadError('permission-denied', 403, 'Origin is not allowed.'));
  }
  return new Response(null, {
    status: 204,
    headers: { ...profileCorsHeaders(origin), 'Cache-Control': 'no-store' },
  });
}

export function isProfileRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || isAllowedProfileOrigin(origin);
}

export function applyProfileCors(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  if (!isAllowedProfileOrigin(origin)) {
    return errorResponse(new ProfileReadError('permission-denied', 403, 'Origin is not allowed.'));
  }
  for (const [key, value] of Object.entries(profileCorsHeaders(origin))) response.headers.set(key, value);
  return response;
}

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, error.status);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

async function readBoundedText(
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

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
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

const defaultAccessTokenProvider = createGoogleAccessTokenProvider();

type ProfileReadDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdToken: (
    authorization: string | null,
    providerFetch: ProfileProviderFetch,
    signal: AbortSignal,
    nowMs?: number,
  ) => Promise<FirebaseIdentity>;
};

const defaultDependencies: ProfileReadDependencies = {
  accessTokenProvider: defaultAccessTokenProvider,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: PROFILE_READ_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
};

function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (typeof value.booleanValue === 'boolean') return value.booleanValue;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.timestampValue === 'string') {
    const milliseconds = Date.parse(value.timestampValue);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  if (typeof value.integerValue === 'string' && /^-?\d+$/.test(value.integerValue)) {
    const integer = Number(value.integerValue);
    return Number.isSafeInteger(integer) ? integer : undefined;
  }
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (isRecord(value.arrayValue)) {
    const values = value.arrayValue.values;
    if (values === undefined) return [];
    if (!Array.isArray(values)) return undefined;
    const decoded = values.map(decodeFirestoreValue);
    return decoded.some((entry) => entry === undefined) ? undefined : decoded;
  }
  if (isRecord(value.mapValue)) {
    const fields = value.mapValue.fields;
    if (fields === undefined) return {};
    if (!isRecord(fields)) return undefined;
    const decoded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(fields)) {
      const decodedEntry = decodeFirestoreValue(entry);
      if (decodedEntry === undefined) return undefined;
      decoded[key] = decodedEntry;
    }
    return decoded;
  }
  return undefined;
}

function decodeFirestoreFields(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const decodedEntry = decodeFirestoreValue(entry);
    if (decodedEntry === undefined) return null;
    decoded[key] = decodedEntry;
  }
  return decoded;
}

function documentIdentity(name: unknown): { dropId: string; deliveryId: number } | null {
  if (typeof name !== 'string') return null;
  const match = name.match(/\/documents\/drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
  if (!match) return null;
  const dropId = normalizeDropId(match[1]);
  const deliveryId = parseCanonicalPositiveInteger(match[2]);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) || deliveryId === null) return null;
  return { dropId, deliveryId };
}

function deliveryOrderSummaryFromDocument(document: unknown): DeliveryOrderSummary | null {
  if (!isRecord(document)) return null;
  const identity = documentIdentity(document.name);
  const fields = decodeFirestoreFields(document.fields);
  if (!identity || !fields || fields.source === 'admin_irl_redeem') return null;
  const storedDropId = typeof fields.dropId === 'string' && fields.dropId
    ? normalizeDropId(fields.dropId)
    : identity.dropId;
  const storedDeliveryId = Number.isSafeInteger(fields.deliveryId) ? Number(fields.deliveryId) : identity.deliveryId;
  if (storedDropId !== identity.dropId || storedDeliveryId !== identity.deliveryId) return null;
  return parseDeliveryOrderSummary({ ...fields, dropId: identity.dropId, deliveryId: identity.deliveryId });
}

function profileShipmentSummaryFromDocument(document: unknown): DeliveryOrderSummary | null {
  if (!isRecord(document)) return null;
  const fields = decodeFirestoreFields(document.fields);
  return fields ? parseDeliveryOrderSummary(fields) : null;
}

function queryDocuments(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  return value.flatMap((entry) => isRecord(entry) && isRecord(entry.document) ? [entry.document] : []);
}

async function parseExactRequestBody(
  request: Request,
  path: ProfileReadPath,
  signal: AbortSignal,
): Promise<Partial<GetProfileShipmentsRequest>> {
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROFILE_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  if (!request.body) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  const response = new Response(request.body);
  const text = await readBoundedText(response, MAX_PROFILE_REQUEST_BYTES, signal)
    .catch(() => {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  if (!isRecord(parsed)) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  if (path === ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH || path === PROFILE_STATE_PATH) {
    if (Object.keys(parsed).length !== 0) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    return {};
  }
  if (Object.keys(parsed).length !== 1 || typeof parsed.ownerWallet !== 'string' || !isBase58Bytes(parsed.ownerWallet, 32)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address.');
  }
  return { ownerWallet: parsed.ownerWallet };
}

function firestoreString(value: string): Record<string, unknown> {
  return { stringValue: value };
}

function fieldSelection(fields: readonly string[]): { fields: Array<{ fieldPath: string }> } {
  return { fields: fields.map((fieldPath) => ({ fieldPath })) };
}

function deliveryHistoryQuery(owner: string): Record<string, unknown> {
  return {
    structuredQuery: {
      select: fieldSelection(DELIVERY_ORDER_SUMMARY_FIELDS),
      from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'owner' }, op: 'EQUAL', value: firestoreString(owner) } },
            {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'IN',
                value: { arrayValue: { values: PROFILE_SHIPMENT_STATUSES.map(firestoreString) } },
              },
            },
          ],
        },
      },
    },
  };
}

function profileShipmentsQuery(): Record<string, unknown> {
  return {
    structuredQuery: {
      select: fieldSelection(PROFILE_SHIPMENT_FIELDS),
      from: [{ collectionId: 'shipments' }],
      orderBy: [{ field: { fieldPath: 'sortAt' }, direction: 'DESCENDING' }],
    },
  };
}

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

async function authenticatedFirestoreRequest(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  body?: string;
  method: 'GET' | 'POST';
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
  url: string;
}): Promise<unknown | null> {
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
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    }
    return readBoundedJson(response, MAX_FIRESTORE_RESPONSE_BYTES, args.signal);
  }
  throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
}

function optionalSessionWallet(value: unknown, uid: string): string | null {
  if (value === null) {
    if (isBase58Bytes(uid, 32)) return uid;
    return null;
  }
  if (!isRecord(value)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  const fields = decodeFirestoreFields(value.fields);
  const wallet = fields?.wallet;
  if (typeof wallet !== 'string' || !isBase58Bytes(wallet, 32)) {
    throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  }
  return wallet;
}

async function loadOptionalSessionWallet(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
  uid: string;
}): Promise<string | null> {
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/authSessions/${encodeURIComponent(args.uid)}`);
  url.searchParams.append('mask.fieldPaths', 'wallet');
  const document = await authenticatedFirestoreRequest({
    ...args,
    method: 'GET',
    url: url.toString(),
  });
  return optionalSessionWallet(document, args.uid);
}

async function loadSessionWallet(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
  uid: string;
}): Promise<string> {
  const wallet = await loadOptionalSessionWallet(args);
  if (!wallet) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  return wallet;
}

async function loadDeliveryHistory(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  owner: string;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
}): Promise<DeliveryOrderSummary[]> {
  const payload = await authenticatedFirestoreRequest({
    ...args,
    body: JSON.stringify(deliveryHistoryQuery(args.owner)),
    method: 'POST',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}:runQuery`,
  });
  const orders = queryDocuments(payload)
    .map(deliveryOrderSummaryFromDocument)
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
  orders.sort((left, right) => deliveryOrderSummarySortAt(right) - deliveryOrderSummarySortAt(left));
  return orders;
}

async function loadAdminProfile(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
}): Promise<GetAdminProfileViewResponse> {
  const profileUrl = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/profiles/${encodeURIComponent(args.ownerWallet)}`);
  profileUrl.searchParams.append('mask.fieldPaths', 'email');
  const [profileDocument, shipmentPayload] = await Promise.all([
    authenticatedFirestoreRequest({ ...args, method: 'GET', url: profileUrl.toString() }),
    authenticatedFirestoreRequest({
      ...args,
      body: JSON.stringify(profileShipmentsQuery()),
      method: 'POST',
      url: `${FIRESTORE_DOCUMENTS_BASE_URL}/profiles/${encodeURIComponent(args.ownerWallet)}:runQuery`,
    }),
  ]);
  const profileFields = isRecord(profileDocument) ? decodeFirestoreFields(profileDocument.fields) : null;
  const email = typeof profileFields?.email === 'string' && profileFields.email.trim()
    ? profileFields.email.trim()
    : undefined;
  const orders = queryDocuments(shipmentPayload)
    .map(profileShipmentSummaryFromDocument)
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
  return {
    profile: {
      wallet: args.ownerWallet,
      ...(email ? { email } : {}),
      orders,
    },
  };
}

async function loadProfileStateProfile(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
}): Promise<ProfileStateProfile> {
  const profileUrl = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/profiles/${encodeURIComponent(args.ownerWallet)}`);
  profileUrl.searchParams.append('mask.fieldPaths', 'email');
  const profileDocument = await authenticatedFirestoreRequest({ ...args, method: 'GET', url: profileUrl.toString() });
  const profileFields = isRecord(profileDocument) ? decodeFirestoreFields(profileDocument.fields) : null;
  const email = typeof profileFields?.email === 'string' && profileFields.email.trim()
    ? profileFields.email.trim()
    : undefined;
  return { wallet: args.ownerWallet, ...(email ? { email } : {}) };
}

function profileStateSection<T>(
  result: PromiseSettledResult<T>,
  signal: AbortSignal,
): ProfileStateSection<T> {
  if (result.status === 'fulfilled') return { status: 'ready', value: result.value };
  if (signal.aborted) {
    return {
      status: 'error',
      error: { code: 'deadline-exceeded', message: 'Profile request timed out.' },
    };
  }
  if (
    result.reason instanceof ProfileReadError &&
    (result.reason.code === 'deadline-exceeded' || result.reason.code === 'unavailable')
  ) {
    return {
      status: 'error',
      error: { code: result.reason.code, message: result.reason.message },
    };
  }
  throw result.reason;
}

export async function handleProfileReadRequest(
  request: Request,
  env: Pick<Env, 'FIRESTORE_SERVICE_ACCOUNT_JSON'>,
  path: ProfileReadPath,
  overrides: Partial<ProfileReadDependencies> = {},
): Promise<ProfileReadResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: ProfileReadMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await dependencies.providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new ProfileReadError('invalid-argument', 405, 'Method not allowed.'));
    response.headers.set('Allow', PROFILE_CORS_ALLOW_METHODS);
    return {
      response,
      metrics,
      authOutcome: 'rejected',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Profile request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: FirebaseIdentity;
  try {
    const requestBody = await parseExactRequestBody(request, path, controller.signal);
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    const serviceAccountJson = typeof env.FIRESTORE_SERVICE_ACCOUNT_JSON === 'string'
      ? env.FIRESTORE_SERVICE_ACCOUNT_JSON
      : '';
    if (!serviceAccountJson) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
    const common = {
      accessTokenProvider: dependencies.accessTokenProvider,
      nowMs: dependencies.nowMs(),
      providerFetch: trackedFetch,
      serviceAccountJson,
      signal: controller.signal,
    };
    if (path === ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH) {
      const orders = await loadDeliveryHistory({ ...common, owner: `firebase:${identity.uid}` });
      return { response: jsonResponse({ orders }, 200), metrics, authOutcome: 'accepted' };
    }
    if (path === PROFILE_STATE_PATH) {
      const wallet = await loadOptionalSessionWallet({ ...common, uid: identity.uid });
      if (!wallet) {
        const response: GetProfileStateResponse = {
          responseMode: 'profile-state',
          sessionWallet: null,
          profile: null,
          shipments: null,
        };
        return {
          response: jsonResponse(response, 200),
          metrics,
          authOutcome: 'accepted',
          profileStateSections: { profile: 'not-applicable', shipments: 'not-applicable' },
        };
      }
      const [profileResult, shipmentsResult] = await Promise.allSettled([
        loadProfileStateProfile({ ...common, ownerWallet: wallet }),
        loadDeliveryHistory({ ...common, owner: wallet }),
      ]);
      const profile = profileStateSection(profileResult, controller.signal);
      const shipments = profileStateSection(shipmentsResult, controller.signal);
      const response: GetProfileStateResponse = {
        responseMode: 'profile-state',
        sessionWallet: wallet,
        profile,
        shipments,
      };
      return {
        response: jsonResponse(response, 200),
        metrics,
        authOutcome: 'accepted',
        profileStateSections: { profile: profile.status, shipments: shipments.status },
      };
    }
    const ownerWallet = requestBody.ownerWallet!;
    const wallet = await loadSessionWallet({ ...common, uid: identity.uid });
    if (path === PROFILE_SHIPMENTS_PATH) {
      if (wallet !== ownerWallet) throw new ProfileReadError('unauthenticated', 401, 'Wallet session changed. Sign in again.');
      const orders = await loadDeliveryHistory({ ...common, owner: ownerWallet });
      const response: GetProfileShipmentsResponse = { responseMode: 'shipments', wallet, orders };
      return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted' };
    }
    if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
      throw new ProfileReadError('permission-denied', 403, 'Admin access denied.');
    }
    return {
      response: jsonResponse(await loadAdminProfile({ ...common, ownerWallet }), 200),
      metrics,
      authOutcome: 'accepted',
    };
  } catch (error) {
    let profileError: ProfileReadError;
    let authOutcome: ProfileReadResult['authOutcome'] = identity! ? 'provider-failure' : 'rejected';
    if (error instanceof ProfileReadError) {
      profileError = error;
      if (error.code === 'unauthenticated' || error.code === 'permission-denied' || error.code === 'invalid-argument') {
        authOutcome = 'rejected';
      }
    } else if (error instanceof FirebaseIdTokenError) {
      if (error.kind === 'invalid-token') {
        profileError = new ProfileReadError('unauthenticated', 401, 'Authentication is required.');
        authOutcome = 'rejected';
      } else if (error.kind === 'provider-timeout') {
        profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
        authOutcome = 'provider-failure';
      } else {
        profileError = new ProfileReadError('unavailable', 502, 'Authentication is temporarily unavailable.');
        authOutcome = 'provider-failure';
      }
    } else if (controller.signal.aborted) {
      profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
      authOutcome = identity! ? 'provider-failure' : 'rejected';
    } else {
      profileError = new ProfileReadError('internal', 500, 'Profile request failed.');
      authOutcome = identity! ? 'provider-failure' : 'rejected';
    }
    return { response: errorResponse(profileError), metrics, authOutcome };
  } finally {
    clearTimeout(timeout);
  }
}
