import {
  deliveryOrderSummarySortAt,
  parseDeliveryOrderSummary,
  PROFILE_SHIPMENT_STATUSES,
} from '../../../../functions/src/shared/deliveryOrderSummary.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasAdminAccess,
  walletCanViewSensitiveFulfillmentAddress,
  walletHasFulfillmentDropAccess,
} from '../../../../functions/src/shared/fulfillmentAccess.js';
import {
  fulfillmentOrderFromRecord,
  isManualReviewCheckout,
  manualReviewCheckoutFromRecord,
} from '../../../../functions/src/shared/fulfillmentReadModel.js';
import type {
  DeliveryOrderSummary,
  FulfillmentManualReviewCheckout,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  GetAdminProfileViewResponse,
  GetProfileStateResponse,
  GetProfileShipmentsResponse,
  ProfileStateProfile,
  ProfileStateSection,
} from '../../../../functions/src/shared/contracts.js';
import { normalizeDropId } from '../../../../functions/src/shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../functions/src/shared/deploymentRegistry.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  decryptAddressCipherText,
  parseAddressCipherPayload,
} from '../../../../functions/src/shared/addressCipher.js';
import { parseCanonicalPositiveInteger } from '../../../../functions/src/shared/positiveInteger.js';
import { isBase58Bytes } from '../../../../functions/src/shared/solanaRpcProxy.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
import {
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  ProfileReadError,
  authenticatedFirestoreRequest,
  cancelResponseBody,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  firestoreString,
  isRecord,
  readBoundedJson,
  readBoundedText,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export {
  ProfileReadError,
  createGoogleAccessTokenProvider,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export const PROFILE_SHIPMENTS_PATH = '/profile/shipments';
export const PROFILE_STATE_PATH = '/profile/state';
export const ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH = '/profile/anonymous-stripe-delivery-history';
export const ADMIN_PROFILE_PATH = '/admin/profile';
export const ADMIN_DELIVERY_ORDER_OWNERS_PATH = '/admin/delivery-order-owners';
export const FULFILLMENT_ORDERS_PATH = '/fulfillment/orders';
export const FULFILLMENT_MANUAL_REVIEW_PATH = '/fulfillment/manual-review-checkouts';
export const PROFILE_READ_PATHS = new Set([
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
]);

const PROFILE_CORS_ALLOW_HEADERS = 'Content-Type, Authorization';
const PROFILE_CORS_ALLOW_METHODS = 'POST, OPTIONS';

const MAX_PROFILE_REQUEST_BYTES = 4096;
const PROFILE_READ_TIMEOUT_MS = 15_000;
const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
const SHIPPER_DROP_IDS_BY_WALLET = new Map(
  SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
);
const FULFILLMENT_ORDER_LIMIT = 1000;
const DELIVERY_ORDER_OWNER_PAGE_SIZE = 200;
const MAX_DELIVERY_ORDER_OWNER_PAGE_SIZE = 500;
const MAX_STRIPE_RESPONSE_BYTES = 512 * 1024;
const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2026-07-29.dahlia';
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
const FULFILLMENT_ORDER_FIELDS = [
  'deliveryId', 'owner', 'source', 'status', 'createdAt', 'processedAt', 'fulfillmentStatus',
  'fulfillmentTrackingCode', 'fulfillmentUpdatedAt', 'fulfillmentInternalStatus', 'shipstation',
  'addressSnapshot', 'items', 'irlClaims', 'stripeReceiptClaimsByBoxId', 'stripeReceiptClaims',
  'stripeReceiptClaim', 'adminIrlRedeem',
] as const;
const MANUAL_REVIEW_FIELDS = [
  'manualRefundReviewRequired', 'status', 'sessionId', 'stripeSessionSummary', 'quantity', 'owner',
  'firebaseUid', 'uid', 'manualRefundReviewReason', 'lastFulfillmentError', 'createdAt', 'failedAt',
] as const;

export type ProfileReadPath =
  | typeof PROFILE_SHIPMENTS_PATH
  | typeof PROFILE_STATE_PATH
  | typeof ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH
  | typeof ADMIN_PROFILE_PATH
  | typeof ADMIN_DELIVERY_ORDER_OWNERS_PATH
  | typeof FULFILLMENT_ORDERS_PATH
  | typeof FULFILLMENT_MANUAL_REVIEW_PATH;

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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

type ProfileReadEnv = Pick<Env, 'FIRESTORE_SERVICE_ACCOUNT_JSON'> & Partial<Pick<Env,
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_SECRET_KEY_LIVE'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
>>;

const defaultDependencies: ProfileReadDependencies = {
  accessTokenProvider: defaultAccessTokenProvider,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: PROFILE_READ_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
};

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

function queryDocuments(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  return value.flatMap((entry) => isRecord(entry) && isRecord(entry.document) ? [entry.document] : []);
}

type ParsedReadRequest = {
  ownerWallet?: string;
  cursor?: string | FulfillmentOrdersCursor | null;
  pageSize?: number;
  limit?: number;
  dropId?: string;
};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function supportedDropId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProfileReadError('invalid-argument', 400, 'dropId is required.');
  }
  const dropId = normalizeDropId(value);
  if (!Object.hasOwn(DEPLOYMENT_DROPS, dropId)) {
    throw new ProfileReadError('invalid-argument', 400, `Unsupported dropId: ${dropId}`);
  }
  return dropId;
}

function fulfillmentCursor(value: unknown): FulfillmentOrdersCursor | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ['processedAt', 'id'])) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  }
  const processedAt = value.processedAt;
  if (!isRecord(processedAt) || !exactKeys(processedAt, ['seconds', 'nanos'])) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  }
  if (
    !Number.isSafeInteger(processedAt.seconds) || Number(processedAt.seconds) < 0 ||
    !Number.isInteger(processedAt.nanos) || Number(processedAt.nanos) < 0 || Number(processedAt.nanos) > 999_999_999 ||
    typeof value.id !== 'string' || !value.id || value.id.length > 128
  ) throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  return {
    processedAt: { seconds: Number(processedAt.seconds), nanos: Number(processedAt.nanos) },
    id: value.id,
  };
}

async function parseExactRequestBody(
  request: Request,
  path: ProfileReadPath,
  signal: AbortSignal,
): Promise<ParsedReadRequest> {
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
  if (path === ADMIN_DELIVERY_ORDER_OWNERS_PATH) {
    if (!exactKeys(parsed, ['cursor', 'pageSize'])) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    const cursor = parsed.cursor;
    const pageSize = parsed.pageSize;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2000)) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
    }
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > MAX_DELIVERY_ORDER_OWNER_PAGE_SIZE)) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid page size.');
    }
    return { ...(typeof cursor === 'string' ? { cursor } : {}), ...(pageSize === undefined ? {} : { pageSize: Number(pageSize) }) };
  }
  if (path === FULFILLMENT_ORDERS_PATH) {
    if (!exactKeys(parsed, ['dropId', 'limit', 'cursor'])) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    const limit = parsed.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > FULFILLMENT_ORDER_LIMIT)) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid limit.');
    }
    return {
      dropId: supportedDropId(parsed.dropId),
      limit: limit === undefined ? FULFILLMENT_ORDER_LIMIT : Number(limit),
      cursor: fulfillmentCursor(parsed.cursor),
    };
  }
  if (path === FULFILLMENT_MANUAL_REVIEW_PATH) {
    if (!exactKeys(parsed, ['dropId'])) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    return { dropId: supportedDropId(parsed.dropId) };
  }
  if (Object.keys(parsed).length !== 1 || typeof parsed.ownerWallet !== 'string' || !isBase58Bytes(parsed.ownerWallet, 32)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address.');
  }
  return { ownerWallet: parsed.ownerWallet };
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

function deliveryOrderOwnersQuery(cursorPath: string | null, limit: number): Record<string, unknown> {
  const query: Record<string, unknown> = {
    select: fieldSelection(['owner']),
    from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit,
  };
  if (cursorPath) {
    query.startAt = {
      values: [{ referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${cursorPath}` }],
      before: false,
    };
  }
  return { structuredQuery: query };
}

function timestampValue(cursor: FulfillmentOrdersCursor['processedAt']): string {
  const date = new Date(cursor.seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  return `${date.toISOString().slice(0, 19)}.${String(cursor.nanos).padStart(9, '0')}Z`;
}

function fulfillmentOrdersQuery(
  dropId: string,
  limit: number,
  cursor: FulfillmentOrdersCursor | null,
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    select: fieldSelection(FULFILLMENT_ORDER_FIELDS),
    from: [{ collectionId: 'deliveryOrders' }],
    where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: firestoreString('ready_to_ship') } },
    orderBy: [
      { field: { fieldPath: 'processedAt' }, direction: 'DESCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
    ],
    limit: limit + 1,
  };
  if (cursor) {
    query.startAt = {
      values: [
        { timestampValue: timestampValue(cursor.processedAt) },
        { referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}drops/${dropId}/deliveryOrders/${cursor.id}` },
      ],
      before: false,
    };
  }
  return { structuredQuery: query };
}

function manualReviewQuery(): Record<string, unknown> {
  return {
    structuredQuery: {
      select: fieldSelection(MANUAL_REVIEW_FIELDS),
      from: [{ collectionId: 'stripeCheckouts' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'manualRefundReviewRequired' },
          op: 'EQUAL',
          value: { booleanValue: true },
        },
      },
    },
  };
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
  const [profileDocument, orders] = await Promise.all([
    authenticatedFirestoreRequest({ ...args, method: 'GET', url: profileUrl.toString() }),
    loadDeliveryHistory({ ...args, owner: args.ownerWallet }),
  ]);
  const profileFields = isRecord(profileDocument) ? decodeFirestoreFields(profileDocument.fields) : null;
  const email = typeof profileFields?.email === 'string' && profileFields.email.trim()
    ? profileFields.email.trim()
    : undefined;
  return {
    profile: {
      wallet: args.ownerWallet,
      ...(email ? { email } : {}),
      orders,
    },
  };
}

function encodeOwnersCursor(path: string): string {
  return btoa(JSON.stringify({ path })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeOwnersCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 2000) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as unknown;
    const path = typeof parsed === 'string' ? parsed : isRecord(parsed) ? parsed.path : undefined;
    if (typeof path !== 'string' || !/^drops\/[^/]+\/deliveryOrders\/[1-9]\d*$/.test(path)) throw new Error('path');
    return path;
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  }
}

function documentPath(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return value.name.startsWith(FIRESTORE_DOCUMENT_NAME_PREFIX)
    ? value.name.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length)
    : null;
}

async function loadDeliveryOrderOwners(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  cursor?: string;
  nowMs: number;
  pageSize?: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
}): Promise<{ owners: string[]; nextCursor: string | null; hasMore: boolean }> {
  const owners: string[] = [];
  const seen = new Set<string>();
  let cursorPath = decodeOwnersCursor(args.cursor);
  const pageSize = args.pageSize ?? DELIVERY_ORDER_OWNER_PAGE_SIZE;
  const fetchLimit = Math.min(Math.max(pageSize * 3, pageSize + 1), MAX_DELIVERY_ORDER_OWNER_PAGE_SIZE);
  let hasMore = false;
  while (owners.length < pageSize) {
    const payload = await authenticatedFirestoreRequest({
      ...args,
      body: JSON.stringify(deliveryOrderOwnersQuery(cursorPath, fetchLimit)),
      method: 'POST',
      url: `${FIRESTORE_DOCUMENTS_BASE_URL}:runQuery`,
    });
    const documents = queryDocuments(payload);
    if (!documents.length) {
      cursorPath = null;
      hasMore = false;
      break;
    }
    let processed = -1;
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const path = documentPath(document);
      if (!path) continue;
      cursorPath = path;
      processed = index;
      const fields = decodeFirestoreFields(isRecord(document) ? document.fields : undefined);
      const owner = typeof fields?.owner === 'string' ? fields.owner.trim() : '';
      if (!isBase58Bytes(owner, 32) || seen.has(owner)) continue;
      seen.add(owner);
      owners.push(owner);
      if (owners.length >= pageSize) break;
    }
    if (processed < 0 || !cursorPath) {
      cursorPath = null;
      hasMore = false;
      break;
    }
    const endedEarly = processed < documents.length - 1;
    if (owners.length >= pageSize) {
      hasMore = endedEarly || documents.length === fetchLimit;
      break;
    }
    if (documents.length < fetchLimit) {
      cursorPath = null;
      hasMore = false;
      break;
    }
    hasMore = true;
  }
  const nextCursor = hasMore && cursorPath ? encodeOwnersCursor(cursorPath) : null;
  return { owners, nextCursor, hasMore: Boolean(nextCursor) };
}

function fulfillmentAccess(wallet: string, dropId: string): { canViewSensitiveAddress: boolean } {
  if (!walletHasFulfillmentDropAccess(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment access denied.');
  }
  return {
    canViewSensitiveAddress: walletCanViewSensitiveFulfillmentAddress(
      wallet,
      dropId,
      ADMIN_WALLETS,
      SHIPPER_DROP_IDS_BY_WALLET,
    ),
  };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function addressDecryptor(secretValue: string): (payload: string) => string | null {
  const secret = decodeBase64(secretValue.trim());
  if (!secret || secret.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) return () => null;
  return (payload) => {
    const parts = parseAddressCipherPayload(payload, decodeBase64);
    return parts ? decryptAddressCipherText(parts, secret) : null;
  };
}

function fulfillmentDocumentIdentity(document: unknown, dropId: string): { id: string; fields: Record<string, unknown> } | null {
  if (!isRecord(document)) return null;
  const path = documentPath(document);
  const prefix = `drops/${dropId}/deliveryOrders/`;
  if (!path?.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  if (!id || id.includes('/')) return null;
  const fields = decodeFirestoreFields(document.fields);
  return fields ? { id, fields } : null;
}

function timestampCursor(document: unknown): FulfillmentOrdersCursor | null {
  if (!isRecord(document)) return null;
  const path = documentPath(document);
  const id = path?.split('/').at(-1);
  const fields = isRecord(document.fields) ? document.fields : null;
  const processedAt = fields && isRecord(fields.processedAt) ? fields.processedAt.timestampValue : undefined;
  if (!id || typeof processedAt !== 'string') return null;
  const milliseconds = Date.parse(processedAt);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = processedAt.match(/\.(\d{1,9})Z$/)?.[1] || '';
  return {
    processedAt: {
      seconds: Math.floor(milliseconds / 1000),
      nanos: Number(fraction.padEnd(9, '0')) || 0,
    },
    id,
  };
}

async function loadFulfillmentOrders(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  addressSecret: string;
  canViewSensitiveAddress: boolean;
  cursor: FulfillmentOrdersCursor | null;
  dropId: string;
  limit: number;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
}): Promise<{ orders: FulfillmentOrder[]; nextCursor: FulfillmentOrdersCursor | null }> {
  const payload = await authenticatedFirestoreRequest({
    ...args,
    body: JSON.stringify(fulfillmentOrdersQuery(args.dropId, args.limit, args.cursor)),
    method: 'POST',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}/drops/${encodeURIComponent(args.dropId)}:runQuery`,
  });
  const documents = queryDocuments(payload);
  const hasMore = documents.length > args.limit;
  const page = hasMore ? documents.slice(0, args.limit) : documents;
  const decryptAddress = addressDecryptor(args.addressSecret);
  const orders = page.flatMap((document) => {
    const parsed = fulfillmentDocumentIdentity(document, args.dropId);
    if (!parsed) return [];
    const order = fulfillmentOrderFromRecord(parsed.id, parsed.fields, {
      canViewSensitiveAddress: args.canViewSensitiveAddress,
      decryptAddress,
      dropId: args.dropId,
    });
    return order ? [order] : [];
  });
  return { orders, nextCursor: hasMore && page.length ? timestampCursor(page.at(-1)) : null };
}

function stripeKeys(env: Partial<Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_RESTRICTED_KEY' | 'STRIPE_SECRET_KEY_LIVE' | 'STRIPE_RESTRICTED_KEY_LIVE'>>, mode: 'test' | 'live'): string[] {
  const values = mode === 'test'
    ? [env.STRIPE_SECRET_KEY, env.STRIPE_RESTRICTED_KEY]
    : [env.STRIPE_SECRET_KEY_LIVE, env.STRIPE_RESTRICTED_KEY_LIVE];
  const pattern = mode === 'test' ? /^(sk|rk)_test_/ : /^(sk|rk)_live_/;
  return [...new Set(values.map((value) => String(value || '').trim()).filter((value) => pattern.test(value)))];
}

async function fetchStripeSession(
  sessionId: string,
  keys: string[],
  providerFetch: ProfileProviderFetch,
  signal: AbortSignal,
): Promise<unknown> {
  if (!/^[A-Za-z0-9_:-]{4,256}$/.test(sessionId)) throw new Error('invalid-session');
  let lastCredentialFailure = false;
  for (const key of keys) {
    const response = await providerFetch(`${STRIPE_API_BASE_URL}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
      redirect: 'manual',
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      lastCredentialFailure = true;
      await cancelResponseBody(response);
      continue;
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error('stripe-unavailable');
    }
    return readBoundedJson(response, MAX_STRIPE_RESPONSE_BYTES, signal);
  }
  throw new Error(lastCredentialFailure ? 'stripe-credentials' : 'stripe-not-configured');
}

async function loadManualReviewCheckouts(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  canViewSensitiveAddress: boolean;
  dropId: string;
  env: Partial<Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_RESTRICTED_KEY' | 'STRIPE_SECRET_KEY_LIVE' | 'STRIPE_RESTRICTED_KEY_LIVE'>>;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
}): Promise<{ checkouts: FulfillmentManualReviewCheckout[] }> {
  const payload = await authenticatedFirestoreRequest({
    ...args,
    body: JSON.stringify(manualReviewQuery()),
    method: 'POST',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}/drops/${encodeURIComponent(args.dropId)}:runQuery`,
  });
  const mode = DEPLOYMENT_DROPS[args.dropId]?.solanaCluster === 'mainnet-beta' ? 'live' : 'test';
  const keys = stripeKeys(args.env, mode);
  const summaries = await Promise.all(queryDocuments(payload).map(async (document) => {
    if (!isRecord(document)) return null;
    const fields = decodeFirestoreFields(document.fields);
    if (!fields || !isManualReviewCheckout(fields)) return null;
    const path = documentPath(document);
    const sessionId = optionalString(fields.sessionId) || path?.split('/').at(-1) || '';
    if (!/^[A-Za-z0-9_:-]{4,256}$/.test(sessionId)) return null;
    let session: unknown = null;
    try {
      session = await fetchStripeSession(sessionId, keys, args.providerFetch, args.signal);
    } catch {}
    return manualReviewCheckoutFromRecord({
      canViewSensitiveAddress: args.canViewSensitiveAddress,
      checkout: fields,
      dropId: args.dropId,
      session,
      sessionId,
    });
  }));
  const checkouts = summaries.filter((value): value is FulfillmentManualReviewCheckout => Boolean(value));
  checkouts.sort((left, right) =>
    (right.failedAt || right.createdAt || 0) - (left.failedAt || left.createdAt || 0) ||
    right.sessionId.localeCompare(left.sessionId));
  return { checkouts };
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
  env: ProfileReadEnv,
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
    if (path === ADMIN_DELIVERY_ORDER_OWNERS_PATH) {
      const wallet = await loadSessionWallet({ ...common, uid: identity.uid });
      if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
        throw new ProfileReadError('permission-denied', 403, 'Admin access denied.');
      }
      return {
        response: jsonResponse(await loadDeliveryOrderOwners({
          ...common,
          cursor: typeof requestBody.cursor === 'string' ? requestBody.cursor : undefined,
          pageSize: requestBody.pageSize,
        }), 200),
        metrics,
        authOutcome: 'accepted',
      };
    }
    if (path === FULFILLMENT_ORDERS_PATH || path === FULFILLMENT_MANUAL_REVIEW_PATH) {
      const dropId = requestBody.dropId!;
      const wallet = await loadSessionWallet({ ...common, uid: identity.uid });
      const access = fulfillmentAccess(wallet, dropId);
      if (path === FULFILLMENT_ORDERS_PATH) {
        const addressSecret = typeof env.ADDRESS_DECRYPTION_SECRET === 'string' ? env.ADDRESS_DECRYPTION_SECRET : '';
        return {
          response: jsonResponse(await loadFulfillmentOrders({
            ...common,
            addressSecret,
            canViewSensitiveAddress: access.canViewSensitiveAddress,
            cursor: requestBody.cursor && typeof requestBody.cursor === 'object'
              ? requestBody.cursor as FulfillmentOrdersCursor
              : null,
            dropId,
            limit: requestBody.limit ?? FULFILLMENT_ORDER_LIMIT,
          }), 200),
          metrics,
          authOutcome: 'accepted',
        };
      }
      return {
        response: jsonResponse(await loadManualReviewCheckouts({
          ...common,
          canViewSensitiveAddress: access.canViewSensitiveAddress,
          dropId,
          env,
        }), 200),
        metrics,
        authOutcome: 'accepted',
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
