import type { NotificationOutboxRecord } from '../../../../shared/notificationOutbox.js';
import type { ShipmentPageRequest } from '../../../../shared/shipmentHistory.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasAdminAccess,
  walletCanViewSensitiveFulfillmentAddress,
  walletHasFulfillmentDropAccess,
} from '../../../../shared/fulfillmentAccess.js';
import type {
  FulfillmentManualReviewCheckout,
  FulfillmentManualReviewCursor,
  FulfillmentManualReviewPage,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  GetAdminProfileViewResponse,
} from '../../../../shared/contracts.js';
import {
  DEFAULT_MANUAL_REVIEW_LIMIT,
  MAX_MANUAL_REVIEW_LIMIT,
  isFulfillmentManualReviewCursor,
  manualReviewDocumentCursor,
} from '../../../../shared/fulfillmentManualReviewPagination.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  decryptAddressCipherText,
  parseAddressCipherPayload,
} from '../../../../shared/addressCipher.js';
import { isBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { fulfillmentOrderSummaryFromDocument, fulfillmentStripeSessionId } from './deliveryOrderProfileViews.js';
import { stripeCheckoutManualReviewSessionId, stripeCheckoutManualReviewSummary } from './stripeCheckout/readModel.js';
import { STRIPE_API_BASE_URL, STRIPE_API_VERSION, stripeKeysForMode } from './stripeProviderConfig.js';
import { loadStripeChargebackSessionIds } from './stripeChargebackStore.js';
import {
  type RequestAuthContext,
  isStaffRequestIdentity,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  cancelResponseBody,
  readBoundedResponseJson,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import { isRequestCancellationError, raceReadWithSignal } from './boundedRequest.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { jsonResponse } from './httpResponse.js';
import { D1CommerceRepository, type CommerceDocumentRecord } from './commerceRepository.js';
import {
  PROFILE_READ_TIMEOUT_MS,
  exactKeys,
  loadProfileEmail,
  loadShipments,
  parseShipmentsPage,
  profileReadFailure,
  readMethodNotAllowed,
  readProfileRequestBody,
  type ReadRequestDependencies,
  type ReadRequestResult,
} from './profileReadSupport.js';

export const ADMIN_PROFILE_PATH = '/admin/profile';
export const ADMIN_DELIVERY_ORDER_OWNERS_PATH = '/admin/delivery-order-owners';
export const FULFILLMENT_ORDERS_PATH = '/fulfillment/orders';
export const FULFILLMENT_MANUAL_REVIEW_PATH = '/fulfillment/manual-review-checkouts';

export type StaffReadPath =
  | typeof ADMIN_PROFILE_PATH
  | typeof ADMIN_DELIVERY_ORDER_OWNERS_PATH
  | typeof FULFILLMENT_ORDERS_PATH
  | typeof FULFILLMENT_MANUAL_REVIEW_PATH;

export const STAFF_READ_PATHS = new Set<StaffReadPath>([
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
]);

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

type StaffReadDependencies = ReadRequestDependencies & {
  createCommerceRepository: (
    db: D1Database,
  ) => Pick<D1CommerceRepository,
    'queryDeliveryHistory' | 'queryShipmentHistoryPage' | 'queryFulfillmentOrders' |
    'queryManualReviewCheckouts' | 'queryDeliveryOrderOwners' | 'notificationOutbox'>;
  loadStripeChargebackSessionIds: typeof loadStripeChargebackSessionIds;
};

type StaffReadEnv = Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env,
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'OPS_DB'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_SECRET_KEY_LIVE'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
>>;

const defaultDependencies: StaffReadDependencies = {
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  loadProfileEmail,
  loadStripeChargebackSessionIds,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: PROFILE_READ_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

type ParsedStaffReadRequest =
  | { path: typeof ADMIN_PROFILE_PATH; ownerWallet: string; shipmentsPage?: ShipmentPageRequest }
  | { path: typeof ADMIN_DELIVERY_ORDER_OWNERS_PATH; cursor?: string; pageSize?: number }
  | { path: typeof FULFILLMENT_ORDERS_PATH; dropId: string; limit: number; cursor: FulfillmentOrdersCursor | null }
  | { path: typeof FULFILLMENT_MANUAL_REVIEW_PATH; dropId: string; limit: number; cursor?: FulfillmentManualReviewCursor | null };

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

async function parseStaffReadRequest(
  request: Request,
  path: StaffReadPath,
  signal: AbortSignal,
): Promise<ParsedStaffReadRequest> {
  const parsed = await readProfileRequestBody(request, signal);
  const shipmentsPage = parseShipmentsPage(parsed);
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
    return { path, ...(typeof cursor === 'string' ? { cursor } : {}), ...(pageSize === undefined ? {} : { pageSize: Number(pageSize) }) };
  }
  if (path === FULFILLMENT_ORDERS_PATH) {
    if (!exactKeys(parsed, ['dropId', 'limit', 'cursor'])) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    const limit = parsed.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > FULFILLMENT_ORDER_LIMIT)) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid limit.');
    }
    return {
      path,
      dropId: supportedDropId(parsed.dropId),
      limit: limit === undefined ? FULFILLMENT_ORDER_LIMIT : Number(limit),
      cursor: fulfillmentCursor(parsed.cursor),
    };
  }
  if (path === FULFILLMENT_MANUAL_REVIEW_PATH) {
    if (!exactKeys(parsed, ['dropId', 'limit', 'cursor'])) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    const dropId = supportedDropId(parsed.dropId);
    const limit = parsed.limit ?? DEFAULT_MANUAL_REVIEW_LIMIT;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_MANUAL_REVIEW_LIMIT || parsed.limit === null) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid limit.');
    }
    const cursor = parsed.cursor;
    if (cursor !== undefined && cursor !== null && !isFulfillmentManualReviewCursor(cursor, dropId)) {
      throw new ProfileReadError('invalid-argument', 400, 'Invalid cursor.');
    }
    return { path, dropId, limit: Number(limit), cursor };
  }
  if (!exactKeys(parsed, ['ownerWallet', 'shipmentsPage']) || typeof parsed.ownerWallet !== 'string' || !isBase58Bytes(parsed.ownerWallet, 32)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address.');
  }
  return { path, ownerWallet: parsed.ownerWallet, ...(shipmentsPage ? { shipmentsPage } : {}) };
}

async function loadAdminProfile(args: {
  db: D1Database | undefined;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
}, profileEmailLoader: typeof loadProfileEmail, ordersLoader: () => ReturnType<typeof loadShipments>): Promise<GetAdminProfileViewResponse> {
  const [email, shipments] = await Promise.all([
    profileEmailLoader(args),
    ordersLoader(),
  ]);
  return {
    profile: {
      wallet: args.ownerWallet,
      ...(email ? { email } : {}),
      orders: shipments.orders,
    },
    ...(shipments.nextCursor !== undefined ? { nextCursor: shipments.nextCursor } : {}),
  };
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
    startAfterOwner = candidates[candidates.length - 1];
    const remainingBatchCount = DELIVERY_ORDER_OWNER_SCAN_BATCH_LIMIT - batchCount;
    if (remainingBatchCount > 0) {
      queryLimit = Math.ceil((candidateLimit - candidateCount) / remainingBatchCount);
    }
  }
  const hasMore = owners.length > pageSize;
  const page = hasMore ? owners.slice(0, pageSize) : owners;
  const nextCursor = hasMore ? encodeOwnersCursor(page[page.length - 1]) : null;
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
  chargebackSessionIds: ReadonlySet<string>;
  shippedOutboxes: ReadonlyMap<string, NotificationOutboxRecord>;
}): { orders: FulfillmentOrder[]; nextCursor: FulfillmentOrdersCursor | null } {
  const hasMore = args.documents.length > args.limit;
  const page = hasMore ? args.documents.slice(0, args.limit) : args.documents;
  const decryptAddress = addressDecryptor(args.addressSecret);
  const orders = page.flatMap((document) => {
    const order = fulfillmentOrderSummaryFromDocument(document, {
      canViewSensitiveAddress: args.canViewSensitiveAddress,
      decryptAddress,
      dropId: args.dropId,
      chargebackSessionIds: args.chargebackSessionIds,
      shippedOutbox: args.shippedOutboxes.get(document.key.path),
    });
    return order ? [order] : [];
  });
  return { orders, nextCursor: hasMore && page.length ? timestampCursor(page[page.length - 1]) : null };
}

async function loadFulfillmentOrders(args: {
  addressSecret: string;
  canViewSensitiveAddress: boolean;
  cursor: FulfillmentOrdersCursor | null;
  dropId: string;
  limit: number;
  repository: Pick<D1CommerceRepository, 'queryFulfillmentOrders' | 'notificationOutbox'>;
  db: D1Database;
  loadStripeChargebackSessionIds: typeof loadStripeChargebackSessionIds;
  signal: AbortSignal;
}): Promise<{ orders: FulfillmentOrder[]; nextCursor: FulfillmentOrdersCursor | null }> {
  const documents = await args.repository.queryFulfillmentOrders({
    dropId: args.dropId,
    limit: args.limit + 1,
    ...(args.cursor ? {
      startAfter: {
        processedAt: args.cursor.processedAt,
        documentPath: `drops/${args.dropId}/deliveryOrders/${args.cursor.id}`,
      },
    } : {}),
  });
  args.signal.throwIfAborted();
  const sessionIds = [...new Set(documents.slice(0, args.limit).flatMap((document) => {
    const sessionId = fulfillmentStripeSessionId(document, args.dropId);
    return sessionId ? [sessionId] : [];
  }))];
  const chargebackSessionIds = sessionIds.length
    ? await args.loadStripeChargebackSessionIds(args.db, args.dropId, sessionIds)
    : new Set<string>();
  const shippedOutboxes = new Map((await args.repository.notificationOutbox.getMany(
    documents.slice(0, args.limit).map((document) => document.key.path), 'shipped',
  )).map((record) => [record.parentPath, record]));
  return fulfillmentOrdersFromDocuments({ ...args, documents, chargebackSessionIds, shippedOutboxes });
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
  nextCursor: FulfillmentManualReviewCursor | null;
}): Promise<FulfillmentManualReviewPage> {
  const mode = DEPLOYMENT_DROPS[args.dropId]?.solanaCluster === 'mainnet-beta' ? 'live' : 'test';
  const keys = stripeKeysForMode(args.env, mode);
  const summaries = new Array<FulfillmentManualReviewCheckout | null>(args.documents.length).fill(null);
  let nextIndex = 0;
  const hydrate = async (document: CommerceDocumentRecord): Promise<FulfillmentManualReviewCheckout | null> => {
    args.request.signal.throwIfAborted();
    const sessionId = stripeCheckoutManualReviewSessionId(document);
    if (sessionId === null) return null;
    let session: unknown = null;
    try {
      if (!args.signal.aborted) session = await fetchStripeSession(sessionId, keys, args.providerFetch, args.signal);
    } catch (error) {
      if (isRequestCancellationError(args.request, error)) throw error;
    }
    return stripeCheckoutManualReviewSummary({
      canViewSensitiveAddress: args.canViewSensitiveAddress,
      document,
      dropId: args.dropId,
      session,
      sessionId,
    });
  };
  await Promise.all(Array.from({ length: Math.min(4, args.documents.length) }, async () => {
    while (nextIndex < args.documents.length) {
      const index = nextIndex++;
      summaries[index] = await hydrate(args.documents[index]);
    }
  }));
  const checkouts = summaries.filter((value): value is FulfillmentManualReviewCheckout => Boolean(value));
  return { checkouts, nextCursor: args.nextCursor };
}

async function loadManualReviewDocuments(args: {
  dropId: string;
  limit: number;
  cursor?: FulfillmentManualReviewCursor | null;
  repository: Pick<D1CommerceRepository, 'queryManualReviewCheckouts'>;
}): Promise<CommerceDocumentRecord[]> {
  return args.repository.queryManualReviewCheckouts({
    dropId: args.dropId,
    limit: args.limit + 1,
    ...(args.cursor ? { startAfter: args.cursor } : {}),
  });
}

export async function handleStaffReadRequest(
  request: Request,
  env: StaffReadEnv,
  path: StaffReadPath,
  authContext: RequestAuthContext = {},
  overrides: Partial<StaffReadDependencies> = {},
): Promise<ReadRequestResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') return readMethodNotAllowed(request);
  return withAuthenticatedRequest<ReadRequestResult>(request, {
    authContext,
    opsDb: env.OPS_DB,
    timeoutMessage: 'Profile request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    const boundedRead = <T>(operation: Promise<T>) => raceReadWithSignal(operation, deadline.signal);
    let identity: RequestIdentity | undefined;
    try {
      const requestBody = await parseStaffReadRequest(request, path, deadline.signal);
      identity = await authenticate();
      if (!isStaffRequestIdentity(identity)) {
        throw new ProfileReadError('unauthenticated', 401, 'Staff wallet authentication is required.');
      }
      const common = {
        repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
        nowMs: dependencies.nowMs(),
        providerFetch: trackedFetch,
        signal: deadline.signal,
      };
      const wallet = await boundedRead(Promise.resolve(identity.wallet));
      if (requestBody.path === ADMIN_DELIVERY_ORDER_OWNERS_PATH) {
        if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
          throw new ProfileReadError('permission-denied', 403, 'Admin access denied.');
        }
        return {
          response: jsonResponse(await boundedRead(loadDeliveryOrderOwners({
            ...common,
            cursor: requestBody.cursor,
            pageSize: requestBody.pageSize,
          })), 200),
          metrics,
          authOutcome: 'accepted',
        };
      }
      if (requestBody.path === FULFILLMENT_ORDERS_PATH) {
        const access = fulfillmentAccess(wallet, requestBody.dropId);
        const addressSecret = typeof env.ADDRESS_DECRYPTION_SECRET === 'string' ? env.ADDRESS_DECRYPTION_SECRET : '';
        return {
          response: jsonResponse(await boundedRead(loadFulfillmentOrders({
            ...common,
            db: env.COMMERCE_DB,
            loadStripeChargebackSessionIds: dependencies.loadStripeChargebackSessionIds,
            addressSecret,
            canViewSensitiveAddress: access.canViewSensitiveAddress,
            cursor: requestBody.cursor,
            dropId: requestBody.dropId,
            limit: requestBody.limit,
          })), 200),
          metrics,
          authOutcome: 'accepted',
        };
      }
      if (requestBody.path === FULFILLMENT_MANUAL_REVIEW_PATH) {
        const { dropId, limit, cursor } = requestBody;
        const access = fulfillmentAccess(wallet, dropId);
        const documents = await boundedRead(loadManualReviewDocuments({
          ...common, dropId, limit, cursor,
        }));
        const page = documents.slice(0, limit);
        const result = await manualReviewFromDocuments({
          canViewSensitiveAddress: access.canViewSensitiveAddress,
          documents: page,
          nextCursor: documents.length > limit ? manualReviewDocumentCursor(dropId, page[page.length - 1]) : null,
          dropId,
          env,
          providerFetch: trackedFetch,
          request,
          signal: deadline.signal,
        });
        return {
          response: jsonResponse(result, 200),
          metrics,
          authOutcome: 'accepted',
        };
      }
      if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
        throw new ProfileReadError('permission-denied', 403, 'Admin access denied.');
      }
      const { ownerWallet, shipmentsPage } = requestBody;
      return {
        response: jsonResponse(await boundedRead(loadAdminProfile(
          { ...common, db: env.OPS_DB, ownerWallet },
          dependencies.loadProfileEmail,
          () => loadShipments({ ...common, owner: ownerWallet, shipmentsPage }),
        )), 200),
        metrics,
        authOutcome: 'accepted',
      };
    } catch (error) {
      return profileReadFailure(error, request, identity, deadline, metrics);
    }
  });
}

export const staffReadTestHooks = {
  loadDeliveryOrderOwners,
};
