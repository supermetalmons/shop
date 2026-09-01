import {
  deliveryOrderSummarySortAt,
  parseDeliveryOrderSummary,
  PROFILE_SHIPMENT_STATUSES,
} from '../../../../shared/deliveryOrderSummary.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasAdminAccess,
  walletCanViewSensitiveFulfillmentAddress,
  walletHasFulfillmentDropAccess,
} from '../../../../shared/fulfillmentAccess.js';
import {
  fulfillmentOrderFromRecord,
  isManualReviewCheckout,
  manualReviewCheckoutFromRecord,
} from '../../../../shared/fulfillmentReadModel.js';
import {
  STRIPE_CHECKOUT_OPERATION_HEADER,
  STRIPE_CHECKOUT_RETRY_HEADER,
  type DeliveryOrderSummary,
  type FulfillmentManualReviewCheckout,
  type FulfillmentOrder,
  type FulfillmentOrdersCursor,
  type GetAdminProfileViewResponse,
  type GetProfileStateResponse,
  type GetProfileShipmentsResponse,
  type ProfileStateProfile,
  type ProfileStateSection,
} from '../../../../shared/contracts.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  decryptAddressCipherText,
  parseAddressCipherPayload,
} from '../../../../shared/addressCipher.js';
import { parseCanonicalPositiveInteger } from '../../../../shared/positiveInteger.js';
import { isBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { stripeCheckoutAnonymousOwnerId } from '../../../../shared/stripeCheckoutSession.js';
import {
  RequestIdentityError,
  isStaffOnlyApiPath,
  isStaffRequestIdentity,
  resolveRequestWallet,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  cancelResponseBody,
  readBoundedResponseJson,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  readBoundedRequestJson,
} from './boundedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { apiErrorBody, jsonResponse } from './httpResponse.js';
import {
  D1CommerceRepository,
  type CommerceDocumentRecord,
} from './commerceRepository.js';
import {
  loadD1Profile,
} from './profileD1.js';
import {
  resolveD1AuthWalletBinding,
} from './authWalletBindingD1.js';

export {
  type ProfileProviderFetch,
} from './boundedResponse.js';
export { ProfileReadError } from './dataAccess.js';

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

const PROFILE_CORS_ALLOW_HEADERS = `Content-Type, Authorization, X-Mons-CSRF, ${STRIPE_CHECKOUT_OPERATION_HEADER}`;
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
const DELIVERY_ORDER_OWNER_SCAN_BATCH_LIMIT = 4;
const MIN_DELIVERY_ORDER_OWNER_SCAN_CANDIDATES = 2048;
const DELIVERY_ORDER_OWNER_SCAN_MULTIPLIER = 4;
const MAX_STRIPE_RESPONSE_BYTES = 512 * 1024;
const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2026-07-29.dahlia';
const FULFILLMENT_ORDER_FIELDS = [
  'deliveryId', 'owner', 'source', 'status', 'createdAt', 'processedAt', 'fulfillmentStatus',
  'fulfillmentTrackingCode', 'fulfillmentUpdatedAt', 'fulfillmentInternalStatus', 'shipstation',
  'addressSnapshot', 'items', 'irlClaims', 'stripeReceiptClaimsByBoxId', 'stripeReceiptClaims',
  'stripeReceiptClaim', 'adminIrlRedeem',
] as const;
const MANUAL_REVIEW_FIELDS = [
  'manualRefundReviewRequired', 'status', 'sessionId', 'stripeSessionSummary', 'quantity', 'owner',
  'ownerKind', 'authSubject', 'uid', 'manualRefundReviewReason', 'lastFulfillmentError',
  'createdAt', 'failedAt',
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

function selectedFields(data: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => Object.hasOwn(data, field) ? [[field, data[field]]] : []));
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
    'Access-Control-Expose-Headers': STRIPE_CHECKOUT_RETRY_HEADER,
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

export function handleProfileCorsPreflight(
  request: Request,
  isAllowedOrigin: (origin: string) => boolean = isAllowedProfileOrigin,
): Response {
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin)) {
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
  return jsonResponse(apiErrorBody(error), error.status);
}


type ProfileReadDependencies = {
  createCommerceRepository: (
    db: D1Database,
  ) => Pick<D1CommerceRepository, 'query' | 'queryDeliveryOrderOwners'>;
  loadProfileEmail: typeof loadProfileEmail;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  resolveD1AuthWalletBinding: (
    db: D1Database | undefined,
    uid: string,
    signal: AbortSignal,
  ) => ReturnType<typeof resolveD1AuthWalletBinding>;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

type ProfileReadEnv = Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env,
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'OPS_DB'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_SECRET_KEY_LIVE'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
>>;

const defaultDependencies: ProfileReadDependencies = {
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  loadProfileEmail,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  resolveD1AuthWalletBinding: (db, uid, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    return resolveD1AuthWalletBinding(db, uid, signal);
  },
  timeoutMs: PROFILE_READ_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

function documentIdentity(document: CommerceDocumentRecord): { dropId: string; deliveryId: number } | null {
  const dropId = normalizeDropId(document.key.dropId || '');
  const deliveryId = parseCanonicalPositiveInteger(document.key.documentId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) || deliveryId === null) return null;
  return { dropId, deliveryId };
}

function deliveryOrderSummaryFromDocument(document: CommerceDocumentRecord): DeliveryOrderSummary | null {
  const identity = documentIdentity(document);
  const fields = document.data;
  if (!identity || fields.source === 'admin_irl_redeem') return null;
  const storedDropId = typeof fields.dropId === 'string' && fields.dropId
    ? normalizeDropId(fields.dropId)
    : identity.dropId;
  const storedDeliveryId = Number.isSafeInteger(fields.deliveryId) ? Number(fields.deliveryId) : identity.deliveryId;
  if (storedDropId !== identity.dropId || storedDeliveryId !== identity.deliveryId) return null;
  return parseDeliveryOrderSummary({ ...fields, dropId: identity.dropId, deliveryId: identity.deliveryId });
}

function deliveryHistoryFromDocuments(documents: readonly CommerceDocumentRecord[]): DeliveryOrderSummary[] {
  const orders = documents
    .map(deliveryOrderSummaryFromDocument)
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
  orders.sort((left, right) => deliveryOrderSummarySortAt(right) - deliveryOrderSummarySortAt(left));
  return orders;
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
  const parsed = await readBoundedRequestJson(request, {
    maxBytes: MAX_PROFILE_REQUEST_BYTES,
    signal,
    createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid request.'),
  });
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

async function loadOptionalSessionWallet(args: {
  db: D1Database | undefined;
  resolveD1AuthWalletBinding: ProfileReadDependencies['resolveD1AuthWalletBinding'];
  signal: AbortSignal;
  uid: string;
}): Promise<string | null> {
  try {
    const resolution = await args.resolveD1AuthWalletBinding(args.db, args.uid, args.signal);
    if ('reason' in resolution) {
      if (resolution.reason === 'missing-binding') return null;
      throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(args.signal, error)) throw args.signal.reason;
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  }
}

async function loadSessionWallet(args: {
  db: D1Database | undefined;
  resolveD1AuthWalletBinding: ProfileReadDependencies['resolveD1AuthWalletBinding'];
  signal: AbortSignal;
  uid: string;
}): Promise<string> {
  const wallet = await loadOptionalSessionWallet(args);
  if (!wallet) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  return wallet;
}

async function loadDeliveryHistory(args: {
  owners: readonly string[];
  repository: Pick<D1CommerceRepository, 'query'>;
}): Promise<DeliveryOrderSummary[]> {
  const documents = await args.repository.query({
    filters: [
      { field: 'owner', op: 'in', value: args.owners },
      { field: 'status', op: 'in', value: PROFILE_SHIPMENT_STATUSES },
    ],
    kind: 'delivery_order',
  });
  return deliveryHistoryFromDocuments(documents);
}

async function loadAdminProfile(args: {
  db: D1Database | undefined;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
}, profileEmailLoader: typeof loadProfileEmail, ordersLoader: () => Promise<DeliveryOrderSummary[]>): Promise<GetAdminProfileViewResponse> {
  const [email, orders] = await Promise.all([
    profileEmailLoader(args),
    ordersLoader(),
  ]);
  return {
    profile: {
      wallet: args.ownerWallet,
      ...(email ? { email } : {}),
      orders,
    },
  };
}

async function loadProfileEmail(args: {
  db: D1Database | undefined;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.db) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  let stored;
  try {
    stored = await loadD1Profile(args.db, args.ownerWallet, args.signal);
  } catch (error) {
    if (isSignalCancellationError(args.signal, error)) throw args.signal.reason;
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  return stored?.email;
}

function encodeOwnersCursor(afterOwner: string): string {
  return btoa(JSON.stringify({ v: 1, afterOwner })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeOwnersCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (
      !isRecord(parsed) ||
      !exactKeys(parsed, ['v', 'afterOwner']) ||
      parsed.v !== 1 ||
      typeof parsed.afterOwner !== 'string' ||
      !isBase58Bytes(parsed.afterOwner, 32)
    ) throw new Error('cursor');
    return parsed.afterOwner;
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
  }
}

async function loadDeliveryOrderOwners(args: {
  cursor?: string;
  pageSize?: number;
  repository: Pick<D1CommerceRepository, 'queryDeliveryOrderOwners'>;
  signal: AbortSignal;
}): Promise<{ owners: string[]; nextCursor: string | null; hasMore: boolean }> {
  const pageSize = args.pageSize ?? DELIVERY_ORDER_OWNER_PAGE_SIZE;
  const targetCount = pageSize + 1;
  const candidateLimit = Math.max(
    MIN_DELIVERY_ORDER_OWNER_SCAN_CANDIDATES,
    targetCount * DELIVERY_ORDER_OWNER_SCAN_MULTIPLIER,
  );
  const owners: string[] = [];
  let startAfterOwner = decodeOwnersCursor(args.cursor);
  let batchCount = 0;
  let candidateCount = 0;
  let queryLimit = targetCount;
  while (owners.length < targetCount) {
    if (args.signal.aborted) throw args.signal.reason;
    if (
      batchCount >= DELIVERY_ORDER_OWNER_SCAN_BATCH_LIMIT ||
      candidateCount >= candidateLimit
    ) {
      throw new ProfileReadError('unavailable', 503, 'Delivery-order owners are temporarily unavailable.');
    }
    queryLimit = Math.min(queryLimit, candidateLimit - candidateCount);
    batchCount += 1;
    const candidates = await args.repository.queryDeliveryOrderOwners({
      limit: queryLimit,
      ...(startAfterOwner ? { startAfterOwner } : {}),
    });
    if (args.signal.aborted) throw args.signal.reason;
    candidateCount += candidates.length;
    if (!candidates.length) break;
    for (const owner of candidates) {
      if (isBase58Bytes(owner, 32)) owners.push(owner);
      if (owners.length >= targetCount) break;
    }
    if (candidates.length < queryLimit || owners.length >= targetCount) break;
    startAfterOwner = candidates[candidates.length - 1]!;
    const remainingBatchCount = DELIVERY_ORDER_OWNER_SCAN_BATCH_LIMIT - batchCount;
    if (remainingBatchCount > 0) {
      queryLimit = Math.ceil((candidateLimit - candidateCount) / remainingBatchCount);
    }
  }
  const hasMore = owners.length > pageSize;
  const page = hasMore ? owners.slice(0, pageSize) : owners;
  const nextCursor = hasMore ? encodeOwnersCursor(page[page.length - 1]!) : null;
  return { owners: page, nextCursor, hasMore };
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

function fulfillmentDocumentIdentity(
  document: CommerceDocumentRecord,
  dropId: string,
): { id: string; fields: Record<string, unknown> } | null {
  if (document.key.kind !== 'delivery_order' || document.key.dropId !== dropId) return null;
  return { id: document.key.documentId, fields: selectedFields(document.data, FULFILLMENT_ORDER_FIELDS) };
}

function timestampCursor(document: CommerceDocumentRecord): FulfillmentOrdersCursor | null {
  return document.processedAt
    ? { processedAt: document.processedAt, id: document.key.documentId }
    : null;
}

function fulfillmentOrdersFromDocuments(args: {
  addressSecret: string;
  canViewSensitiveAddress: boolean;
  documents: readonly CommerceDocumentRecord[];
  dropId: string;
  limit: number;
}): { orders: FulfillmentOrder[]; nextCursor: FulfillmentOrdersCursor | null } {
  const hasMore = args.documents.length > args.limit;
  const page = hasMore ? args.documents.slice(0, args.limit) : args.documents;
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
  return { orders, nextCursor: hasMore && page.length ? timestampCursor(page[page.length - 1]!) : null };
}

async function loadFulfillmentOrders(args: {
  addressSecret: string;
  canViewSensitiveAddress: boolean;
  cursor: FulfillmentOrdersCursor | null;
  dropId: string;
  limit: number;
  repository: Pick<D1CommerceRepository, 'query'>;
}): Promise<{ orders: FulfillmentOrder[]; nextCursor: FulfillmentOrdersCursor | null }> {
  const documents = await args.repository.query({
    dropId: args.dropId,
    filters: [{ field: 'status', op: 'equal', value: 'ready_to_ship' }],
    kind: 'delivery_order',
    limit: args.limit + 1,
    orderBy: [
      { field: 'processedAt', direction: 'desc' },
      { field: 'documentPath', direction: 'desc' },
    ],
    ...(args.cursor ? {
      startAfter: [
        args.cursor.processedAt,
        `drops/${args.dropId}/deliveryOrders/${args.cursor.id}`,
      ],
    } : {}),
  });
  return fulfillmentOrdersFromDocuments({ ...args, documents });
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
    return readBoundedResponseJson(response, {
      maxBytes: MAX_STRIPE_RESPONSE_BYTES,
      signal,
      contentType: 'require-json',
      createError: () => new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.'),
    });
  }
  throw new Error(lastCredentialFailure ? 'stripe-credentials' : 'stripe-not-configured');
}

async function manualReviewFromDocuments(args: {
  canViewSensitiveAddress: boolean;
  documents: readonly CommerceDocumentRecord[];
  dropId: string;
  env: Partial<Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_RESTRICTED_KEY' | 'STRIPE_SECRET_KEY_LIVE' | 'STRIPE_RESTRICTED_KEY_LIVE'>>;
  providerFetch: ProfileProviderFetch;
  request: Request;
  signal: AbortSignal;
}): Promise<{ checkouts: FulfillmentManualReviewCheckout[] }> {
  const mode = DEPLOYMENT_DROPS[args.dropId]?.solanaCluster === 'mainnet-beta' ? 'live' : 'test';
  const keys = stripeKeys(args.env, mode);
  const summaries = await Promise.all(args.documents.map(async (document) => {
    const fields = selectedFields(document.data, MANUAL_REVIEW_FIELDS);
    if (!isManualReviewCheckout(fields)) return null;
    const sessionId = optionalString(fields.sessionId) || document.key.documentId;
    if (!/^[A-Za-z0-9_:-]{4,256}$/.test(sessionId)) return null;
    let session: unknown = null;
    try {
      session = await fetchStripeSession(sessionId, keys, args.providerFetch, args.signal);
    } catch (error) {
      if (isRequestCancellationError(args.request, error)) throw error;
    }
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

async function loadManualReviewDocuments(args: {
  dropId: string;
  repository: Pick<D1CommerceRepository, 'query'>;
}): Promise<CommerceDocumentRecord[]> {
  return args.repository.query({
    dropId: args.dropId,
    filters: [{ field: 'manualRefundReviewRequired', op: 'equal', value: true }],
    kind: 'stripe_checkout',
    orderBy: [{ field: 'documentPath', direction: 'asc' }],
  });
}

async function loadProfileStateProfile(args: {
  db: D1Database | undefined;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
}, profileEmailLoader: typeof loadProfileEmail): Promise<ProfileStateProfile> {
  const email = await profileEmailLoader(args);
  return { wallet: args.ownerWallet, ...(email ? { email } : {}) };
}

function profileStateSection<T>(
  result: PromiseSettledResult<T>,
  request: Request,
  timeoutSignal: AbortSignal,
): ProfileStateSection<T> {
  if (result.status === 'fulfilled') return { status: 'ready', value: result.value };
  if (isRequestCancellationError(request, result.reason)) throw result.reason;
  if (
    result.reason instanceof ProfileReadError &&
    (result.reason.code === 'deadline-exceeded' || result.reason.code === 'unavailable')
  ) {
    return {
      status: 'error',
      error: { code: result.reason.code, message: result.reason.message },
    };
  }
  if (isSignalCancellationError(timeoutSignal, result.reason)) {
    return {
      status: 'error',
      error: { code: 'deadline-exceeded', message: 'Profile request timed out.' },
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
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs,
    timeoutMessage: 'Profile request timed out',
  });
  const boundedRead = <T>(operation: Promise<T>) => raceReadWithSignal(operation, deadline.signal);
  let identity: RequestIdentity;
  try {
    const requestBody = await parseExactRequestBody(request, path, deadline.signal);
    identity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      deadline.signal,
      dependencies.nowMs(),
    );
    if (isStaffOnlyApiPath(path) && !isStaffRequestIdentity(identity)) {
      throw new ProfileReadError('unauthenticated', 401, 'Staff wallet authentication is required.');
    }
    const common = {
      repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
      nowMs: dependencies.nowMs(),
      providerFetch: trackedFetch,
      signal: deadline.signal,
    };
    const sessionCommon = {
      db: env.OPS_DB,
      resolveD1AuthWalletBinding: dependencies.resolveD1AuthWalletBinding,
      signal: deadline.signal,
    };
    if (path === ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH) {
      const owners = identity.kind === 'staff-wallet'
        ? [identity.wallet]
        : [stripeCheckoutAnonymousOwnerId(identity.authSubject)];
      const orders = await boundedRead(loadDeliveryHistory({ ...common, owners }));
      return { response: jsonResponse({ orders }, 200), metrics, authOutcome: 'accepted' };
    }
    if (path === PROFILE_STATE_PATH) {
      const wallet = await boundedRead(resolveRequestWallet(
        identity,
        (uid) => loadOptionalSessionWallet({ ...sessionCommon, uid }),
      ));
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
        boundedRead(loadProfileStateProfile(
          { ...common, db: env.OPS_DB, ownerWallet: wallet },
          dependencies.loadProfileEmail,
        )),
        boundedRead(loadDeliveryHistory({ ...common, owners: [wallet] })),
      ]);
      const profile = profileStateSection(profileResult, request, deadline.timeoutSignal);
      const shipments = profileStateSection(shipmentsResult, request, deadline.timeoutSignal);
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
      const wallet = await boundedRead(resolveRequestWallet(
        identity,
        (uid) => loadSessionWallet({ ...sessionCommon, uid }),
      ));
      if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
        throw new ProfileReadError('permission-denied', 403, 'Admin access denied.');
      }
      return {
        response: jsonResponse(await boundedRead(loadDeliveryOrderOwners({
          ...common,
          cursor: typeof requestBody.cursor === 'string' ? requestBody.cursor : undefined,
          pageSize: requestBody.pageSize,
        })), 200),
        metrics,
        authOutcome: 'accepted',
      };
    }
    if (path === FULFILLMENT_ORDERS_PATH || path === FULFILLMENT_MANUAL_REVIEW_PATH) {
      const dropId = requestBody.dropId!;
      const wallet = await boundedRead(resolveRequestWallet(
        identity,
        (uid) => loadSessionWallet({ ...sessionCommon, uid }),
      ));
      const access = fulfillmentAccess(wallet, dropId);
      if (path === FULFILLMENT_ORDERS_PATH) {
        const addressSecret = typeof env.ADDRESS_DECRYPTION_SECRET === 'string' ? env.ADDRESS_DECRYPTION_SECRET : '';
        return {
          response: jsonResponse(await boundedRead(loadFulfillmentOrders({
            ...common,
            addressSecret,
            canViewSensitiveAddress: access.canViewSensitiveAddress,
            cursor: requestBody.cursor && typeof requestBody.cursor === 'object'
              ? requestBody.cursor as FulfillmentOrdersCursor
              : null,
            dropId,
            limit: requestBody.limit ?? FULFILLMENT_ORDER_LIMIT,
          })), 200),
          metrics,
          authOutcome: 'accepted',
        };
      }
      return {
        response: jsonResponse(await (async () => {
          const documents = await boundedRead(loadManualReviewDocuments({ ...common, dropId }));
          return manualReviewFromDocuments({
            canViewSensitiveAddress: access.canViewSensitiveAddress,
            documents,
            dropId,
            env,
            providerFetch: trackedFetch,
            request,
            signal: deadline.signal,
          });
        })(), 200),
        metrics,
        authOutcome: 'accepted',
      };
    }
    const ownerWallet = requestBody.ownerWallet!;
    const wallet = await boundedRead(resolveRequestWallet(
      identity,
      (uid) => loadSessionWallet({ ...sessionCommon, uid }),
    ));
    if (path === PROFILE_SHIPMENTS_PATH) {
      if (wallet !== ownerWallet) throw new ProfileReadError('unauthenticated', 401, 'Wallet session changed. Sign in again.');
      const orders = await boundedRead(loadDeliveryHistory({ ...common, owners: [ownerWallet] }));
      const response: GetProfileShipmentsResponse = { responseMode: 'shipments', wallet, orders };
      return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted' };
    }
    if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
      throw new ProfileReadError('permission-denied', 403, 'Admin access denied.');
    }
    return {
      response: jsonResponse(await boundedRead(loadAdminProfile(
        { ...common, db: env.OPS_DB, ownerWallet },
        dependencies.loadProfileEmail,
        () => loadDeliveryHistory({ ...common, owners: [ownerWallet] }),
      )), 200),
      metrics,
      authOutcome: 'accepted',
    };
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    let profileError: ProfileReadError;
    let authOutcome: ProfileReadResult['authOutcome'] = identity! ? 'provider-failure' : 'rejected';
    if (error instanceof ProfileReadError) {
      profileError = error;
      if (error.code === 'unauthenticated' || error.code === 'permission-denied' || error.code === 'invalid-argument') {
        authOutcome = 'rejected';
      }
    } else if (error instanceof RequestIdentityError) {
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
    } else if (deadline.timedOut()) {
      profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
      authOutcome = identity! ? 'provider-failure' : 'rejected';
    } else {
      profileError = new ProfileReadError('internal', 500, 'Profile request failed.');
      authOutcome = identity! ? 'provider-failure' : 'rejected';
    }
    return { response: errorResponse(profileError), metrics, authOutcome };
  } finally {
    deadline.dispose();
  }
}

export const profileReadTestHooks = {
  loadDeliveryOrderOwners,
  loadProfileEmail,
};
