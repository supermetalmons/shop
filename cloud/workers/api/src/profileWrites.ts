import { z } from 'zod';
import nacl from 'tweetnacl';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';
import {
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasFulfillmentAddressAdminAccess,
  walletHasFulfillmentDropAccess,
} from '../../../../shared/fulfillmentAccess.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import { FULFILLMENT_STATUS_OPTIONS } from '../../../../shared/fulfillmentStatus.js';
import {
  normalizeOptionalFulfillmentTrackingCode,
  sanitizeFulfillmentTrackingCode,
} from '../../../../shared/fulfillmentTracking.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  decryptAddressCipherText,
  encryptAddressCipherText,
  parseAddressCipherPayload,
  serializeAddressCipherPayload,
} from '../../../../shared/addressCipher.js';
import {
  adoptOrPurchaseShipStationLabel,
  createShipStationLabelFromRate,
  getShipStationLabelById,
  isActiveShipStationLabel,
  listShipStationLabelsForShipment,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  storedFulfillmentShipStationLabel,
  ShipStationLabelProviderError,
  type ShipStationLabelResult,
  voidShipStationLabel,
} from '../../../../shared/shipstationLabels.js';
import {
  buildShipStationCustomsDeclaration,
  type ShipStationCustomsDeclaration,
} from '../../../../shared/shipstationCustoms.js';
import {
  buildShipStationPackages,
  createShipStationShipment,
  getShipStationShipmentByExternalId,
  getShipStationShipmentById,
  getShipStationShipmentRates,
  getShipStationRateById,
  parseShipStationShipFrom,
  parseShipStationShipTo,
  requestShipStationShipmentRates,
  shipStationExternalId,
  shipStationPackageContentDescription,
  shipStationPackageDetails,
  shipStationPackageProducts,
  shipStationMoneyMatches,
  shipStationProductsTotalWeightOunces,
  ShipStationAddressCorrectionProviderError,
  ShipStationRatesProviderError,
  updateShipStationShipment,
  type ShipStationAddress,
  type ShipStationCustoms,
  type ShipStationPackageProduct,
  type ShipStationRateResponse,
} from '../../../../shared/shipstationRates.js';
import {
  defaultShipStationPackage,
  normalizeShipStationPackage,
  parseShipStationPackage,
  SHIPSTATION_PACKAGE_RANGE_MESSAGE,
  type ShipStationPackageInput,
} from '../../../../shared/shipstationPackage.js';
import {
  createProfileAddressId,
  PROFILE_ADDRESS_ID_PATTERN,
} from '../../../../shared/profileD1.js';
import type {
  AddFulfillmentOrderToShipStationResponse,
  FulfillmentShipStationAddressCorrectionDetails,
  FulfillmentOrderAddress,
  FulfillmentShipStationLabel,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesResponse,
  PurchaseFulfillmentShipStationLabelResponse,
  ProfileAddress,
  ShipStationAddressPatch,
  UpdateFulfillmentAddressResponse,
  VoidFulfillmentShipStationLabelResponse,
} from '../../../../shared/contracts.js';
import {
  FirebaseIdTokenError,
} from './firebaseIdToken.js';
import {
  isStaffOnlyApiPath,
  isStaffRequestIdentity,
  resolveRequestWallet,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
  ProfileReadError,
  authenticatedFirestoreRequest,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  isRecord,
  readBoundedText,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';
import { saveD1ProfileAddress } from './profileD1.js';
import {
  resolveD1WalletSession,
} from './walletSessionD1.js';
import {
  BUYER_ORDER_SHIPPED_EMAIL_PENDING,
  BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
  createBuyerOrderShippedNotificationJob,
  decideBuyerOrderShippedNotification,
  type BuyerOrderShippedDecision,
} from './buyerOrderShipped.js';

export const PROFILE_ADDRESSES_PATH = '/profile/addresses';
export const FULFILLMENT_ORDER_STATUS_PATH = '/fulfillment/order-status';
export const FULFILLMENT_ORDER_ADDRESS_PATH = '/fulfillment/order-address';
export const FULFILLMENT_SHIPSTATION_LABEL_PATH = '/fulfillment/shipstation-label';
export const FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH = '/fulfillment/shipstation-label-purchase';
export const FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH = '/fulfillment/shipstation-label-void';
export const FULFILLMENT_SHIPSTATION_RATES_PATH = '/fulfillment/shipstation-rates';
export const FULFILLMENT_SHIPSTATION_SHIPMENT_PATH = '/fulfillment/shipstation-shipment';
export const PROFILE_WRITE_PATHS = new Set([
  PROFILE_ADDRESSES_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
  FULFILLMENT_SHIPSTATION_RATES_PATH,
  FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
]);

export type ProfileWritePath =
  | typeof PROFILE_ADDRESSES_PATH
  | typeof FULFILLMENT_ORDER_STATUS_PATH
  | typeof FULFILLMENT_ORDER_ADDRESS_PATH
  | typeof FULFILLMENT_SHIPSTATION_LABEL_PATH
  | typeof FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH
  | typeof FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH
  | typeof FULFILLMENT_SHIPSTATION_RATES_PATH
  | typeof FULFILLMENT_SHIPSTATION_SHIPMENT_PATH;

type ProfileWriteMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type ProfileWriteResult = {
  response: Response;
  metrics: ProfileWriteMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
};

type ProfileWriteDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  autoId: () => string;
  createNotificationJobId: () => string;
  error: (entry: Record<string, unknown>) => void;
  log: (entry: Record<string, unknown>) => void;
  nowMs: () => number;
  pauseForRatePoll: (signal: AbortSignal, delayMs: number) => Promise<void>;
  providerFetch: ProfileProviderFetch;
  resolveD1WalletSession: (
    db: D1Database | undefined,
    uid: string,
    signal: AbortSignal,
  ) => ReturnType<typeof resolveD1WalletSession>;
  saveProfileAddress: (
    db: D1Database | undefined,
    address: Parameters<typeof saveD1ProfileAddress>[1],
    signal: AbortSignal,
  ) => Promise<ProfileAddress>;
  timeoutMs: number;
  verifyIdToken: (
    authorization: string | null,
    providerFetch: ProfileProviderFetch,
    signal: AbortSignal,
    nowMs?: number,
  ) => Promise<RequestIdentity>;
  warn: (entry: Record<string, unknown>) => void;
};

type ProfileWriteEnv = Pick<Env, 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'> & Partial<Pick<Env,
  'ADDRESS_DECRYPTION_SECRET' | 'NOTIFICATION_EMAIL_QUEUE' | 'OPS_DB' | 'SHIPSTATION_API_KEY' | 'SHIPSTATION_SHIP_FROM'
>>;

const PROFILE_WRITE_TIMEOUT_MS = 15_000;
const SHIPSTATION_LABEL_OPERATION_TIMEOUT_MS = 45_000;
const SHIPSTATION_LABEL_PURCHASE_OPERATION_TIMEOUT_MS = 55_000;
const SHIPSTATION_LABEL_PURCHASE_CLEANUP_TIMEOUT_MS = 5_000;
const SHIPSTATION_LABEL_VOID_OPERATION_TIMEOUT_MS = 45_000;
const SHIPSTATION_LABEL_VOID_CLEANUP_TIMEOUT_MS = 5_000;
const SHIPSTATION_RATES_OPERATION_TIMEOUT_MS = 55_000;
const SHIPSTATION_SHIPMENT_OPERATION_TIMEOUT_MS = 55_000;
const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
const MAX_STATUS_REQUEST_BYTES = 4096;
const MAX_FULFILLMENT_ADDRESS_REQUEST_BYTES = 16 * 1024;
const MAX_SHIPSTATION_LABEL_REQUEST_BYTES = 2048;
const MAX_SHIPSTATION_LABEL_PURCHASE_REQUEST_BYTES = 4096;
const MAX_SHIPSTATION_LABEL_VOID_REQUEST_BYTES = 2048;
const MAX_SHIPSTATION_RATES_REQUEST_BYTES = 2048;
const MAX_SHIPSTATION_SHIPMENT_REQUEST_BYTES = 2048;
const SHIPSTATION_CLAIM_TTL_MS = 120_000;
const SHIPSTATION_RATE_REQUEST_TTL_MS = 10 * 60_000;
const FIRESTORE_MUTATION_ATTEMPTS = 3;
const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
const ADDRESS_ADMIN_WALLETS = new Set(FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES);
const SHIPPER_DROP_IDS_BY_WALLET = new Map(
  SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
);

const saveAddressSchema = z.object({
  id: z.string().regex(PROFILE_ADDRESS_ID_PATTERN).optional(),
  encrypted: z.string().max(4096),
  country: z.string().max(64),
  countryCode: z.string().max(32).optional(),
  hint: z.string().max(256),
  email: z.string().email().max(254).optional(),
}).strict();

const fulfillmentStatusSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  retryShippedEmail: z.boolean().optional(),
  status: z.union([z.enum(FULFILLMENT_STATUS_OPTIONS), z.literal(''), z.null()]),
  trackingCode: z.string().optional(),
}).strict();

const fulfillmentAddressSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full: z.string().trim().min(1).max(2048),
}).strict();

const shipStationLabelSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const shipStationLabelPurchaseSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rateId: z.string().trim().min(1).max(64),
  expectedTotal: z.object({
    currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/),
    amount: z.number().finite().nonnegative(),
  }).strict(),
  requestId: z.string().uuid(),
}).strict();

const shipStationLabelVoidSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  labelId: z.string().trim().min(1).max(64),
}).strict();

const shipStationRatesSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  package: z.object({
    length: z.number(),
    width: z.number(),
    height: z.number(),
    weight: z.number(),
  }).strict().optional(),
}).strict();

const shipStationAddressPatchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  address_line1: z.string().trim().min(1).max(50).optional(),
  address_line2: z.string().trim().max(50).optional(),
  address_line3: z.string().trim().max(50).optional(),
  city_locality: z.string().trim().min(1).max(50).optional(),
  state_province: z.string().trim().min(1).max(50).optional(),
  postal_code: z.string().trim().min(1).max(50).optional(),
  country_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

const shipStationShipmentSchema = shipStationRatesSchema.extend({
  addressPatch: shipStationAddressPatchSchema.optional(),
}).strict();

const defaultAccessTokenProvider = createGoogleAccessTokenProvider();

class ShipStationProfileError extends ProfileReadError {
  constructor(
    code: ConstructorParameters<typeof ProfileReadError>[0],
    status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(code, status, message);
  }
}

const defaultDependencies: ProfileWriteDependencies = {
  accessTokenProvider: defaultAccessTokenProvider,
  autoId: createProfileAddressId,
  createNotificationJobId: () => crypto.randomUUID(),
  error: (entry) => console.error(entry),
  log: (entry) => console.log(entry),
  nowMs: () => Date.now(),
  pauseForRatePoll,
  providerFetch: (input, init) => fetch(input, init),
  resolveD1WalletSession: (db, uid, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    return resolveD1WalletSession(db, uid, signal);
  },
  saveProfileAddress: (db, address, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    return saveD1ProfileAddress(db, address, signal);
  },
  timeoutMs: PROFILE_WRITE_TIMEOUT_MS,
  verifyIdToken: verifyRequestIdentity,
  warn: (entry) => console.warn(entry),
};

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

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined
        ? { details: error.details }
        : {}),
    },
  }, error.status);
}

async function parseExactRequestBody(
  request: Request,
  path: ProfileWritePath,
  signal: AbortSignal,
): Promise<
  | z.infer<typeof saveAddressSchema>
  | z.infer<typeof fulfillmentStatusSchema>
  | z.infer<typeof fulfillmentAddressSchema>
  | z.infer<typeof shipStationLabelSchema>
  | z.infer<typeof shipStationLabelPurchaseSchema>
  | z.infer<typeof shipStationLabelVoidSchema>
  | z.infer<typeof shipStationRatesSchema>
  | z.infer<typeof shipStationShipmentSchema>
> {
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const maxBytes = path === PROFILE_ADDRESSES_PATH
    ? MAX_SAVE_ADDRESS_BYTES
    : path === FULFILLMENT_ORDER_ADDRESS_PATH
      ? MAX_FULFILLMENT_ADDRESS_REQUEST_BYTES
      : path === FULFILLMENT_SHIPSTATION_LABEL_PATH
        ? MAX_SHIPSTATION_LABEL_REQUEST_BYTES
        : path === FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH
          ? MAX_SHIPSTATION_LABEL_PURCHASE_REQUEST_BYTES
        : path === FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH
          ? MAX_SHIPSTATION_LABEL_VOID_REQUEST_BYTES
        : path === FULFILLMENT_SHIPSTATION_RATES_PATH
          ? MAX_SHIPSTATION_RATES_REQUEST_BYTES
          : path === FULFILLMENT_SHIPSTATION_SHIPMENT_PATH
            ? MAX_SHIPSTATION_SHIPMENT_REQUEST_BYTES
        : MAX_STATUS_REQUEST_BYTES;
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  if (!request.body) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  const text = await readBoundedText(new Response(request.body), maxBytes, signal).catch(() => {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const result = path === PROFILE_ADDRESSES_PATH
    ? saveAddressSchema.safeParse(parsed)
    : path === FULFILLMENT_ORDER_STATUS_PATH
      ? fulfillmentStatusSchema.safeParse(parsed)
    : path === FULFILLMENT_ORDER_ADDRESS_PATH
      ? fulfillmentAddressSchema.safeParse(parsed)
      : path === FULFILLMENT_SHIPSTATION_LABEL_PATH
        ? shipStationLabelSchema.safeParse(parsed)
        : path === FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH
          ? shipStationLabelPurchaseSchema.safeParse(parsed)
        : path === FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH
          ? shipStationLabelVoidSchema.safeParse(parsed)
        : path === FULFILLMENT_SHIPSTATION_RATES_PATH
          ? shipStationRatesSchema.safeParse(parsed)
          : shipStationShipmentSchema.safeParse(parsed);
  if (!result.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  return result.data;
}

async function loadSessionWallet(args: {
  db: D1Database | undefined;
  resolveD1WalletSession: ProfileWriteDependencies['resolveD1WalletSession'];
  signal: AbortSignal;
  uid: string;
}): Promise<string> {
  try {
    const resolution = await args.resolveD1WalletSession(args.db, args.uid, args.signal);
    if ('reason' in resolution) {
      throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (error instanceof ProfileReadError || args.signal.aborted) throw error;
    throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  }
}

function supportedDropId(value: string): string {
  const dropId = normalizeDropId(value);
  if (!Object.hasOwn(DEPLOYMENT_DROPS, dropId)) {
    throw new ProfileReadError('invalid-argument', 400, `Unsupported dropId: ${dropId}`);
  }
  return dropId;
}

function firestoreString(value: string): { stringValue: string } {
  return { stringValue: value };
}

function documentName(path: string): string {
  return `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`;
}

async function commitWrites(
  common: {
    accessTokenProvider: GoogleAccessTokenProvider;
    nowMs: number;
    providerFetch: ProfileProviderFetch;
    serviceAccountJson: string;
    signal: AbortSignal;
  },
  writes: unknown[],
  surfaceWriteConflict = false,
): Promise<void> {
  await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify({ writes }),
    method: 'POST',
    surfaceWriteConflict,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
  });
}

async function saveAddress(
  body: z.infer<typeof saveAddressSchema>,
  wallet: string,
  db: D1Database | undefined,
  autoId: () => string,
  nowMs: number,
  signal: AbortSignal,
  persist: ProfileWriteDependencies['saveProfileAddress'],
): Promise<ProfileAddress> {
  const id = body.id || autoId();
  if (!PROFILE_ADDRESS_ID_PATTERN.test(id)) throw new ProfileReadError('internal', 500, 'Profile request failed.');
  const normalizedCountryCode = normalizeCountryCode(body.countryCode || body.country);
  const countryCode = normalizedCountryCode || body.countryCode;
  try {
    return await persist(db, {
      wallet,
      id,
      country: body.country,
      ...(countryCode ? { countryCode } : {}),
      encrypted: body.encrypted,
      hint: body.hint,
      ...(body.email ? { email: body.email } : {}),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    }, signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
}

type FulfillmentStatusResponse = {
  buyerOrderShippedEmailState?: 'pending' | 'queued';
  deliveryId: number;
  fulfillmentStatus: (typeof FULFILLMENT_STATUS_OPTIONS)[number] | '';
  fulfillmentTrackingCode?: string;
};

const BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD = 'buyerOrderShippedEmailState';
const BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD = 'buyerOrderShippedEmailJobId';
const BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD = 'buyerOrderShippedEmailIdempotencyKey';
const BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD = 'buyerOrderShippedEmailQueuedAt';

type FulfillmentStatusMutation = {
  decision: BuyerOrderShippedDecision;
  order: Record<string, unknown>;
  response: FulfillmentStatusResponse;
};

function orderAfterFulfillmentStatusUpdate(args: {
  dropId: string;
  fields: Record<string, unknown>;
  nextStatus: FulfillmentStatusResponse['fulfillmentStatus'];
  nextTrackingCode?: string;
  wallet: string;
}): Record<string, unknown> {
  const order: Record<string, unknown> = {
    ...args.fields,
    dropId: args.dropId,
    fulfillmentUpdatedBy: args.wallet,
  };
  if (args.nextStatus) order.fulfillmentStatus = args.nextStatus;
  else delete order.fulfillmentStatus;
  if (args.nextStatus === 'Shipped') {
    if (args.nextTrackingCode) order.fulfillmentTrackingCode = args.nextTrackingCode;
    else delete order.fulfillmentTrackingCode;
  }
  return order;
}

function markerFieldPaths(): string[] {
  return [
    BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD,
    BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD,
    BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD,
    BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD,
  ];
}

async function markBuyerOrderShippedEmailQueued(args: {
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  jobId: string;
}): Promise<boolean> {
  return mutateDeliveryOrder({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: (document) => {
      if (
        document.fields[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD] !== BUYER_ORDER_SHIPPED_EMAIL_PENDING ||
        document.fields[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD] !== args.jobId
      ) {
        return { value: false };
      }
      return {
        value: true,
        write: {
          update: {
            name: documentName(`drops/${args.dropId}/deliveryOrders/${args.deliveryId}`),
            fields: {
              [BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD]: firestoreString(BUYER_ORDER_SHIPPED_EMAIL_QUEUED),
              [BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD]: firestoreString(args.jobId),
            },
          },
          updateMask: {
            fieldPaths: [
              BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD,
              BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD,
            ],
          },
          updateTransforms: [{
            fieldPath: BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD,
            setToServerValue: 'REQUEST_TIME',
          }],
          currentDocument: { updateTime: document.updateTime },
        },
      };
    },
  });
}

async function updateFulfillmentStatus(
  body: z.infer<typeof fulfillmentStatusSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  env: ProfileWriteEnv,
  dependencies: Pick<
    ProfileWriteDependencies,
    'createNotificationJobId' | 'error' | 'log' | 'warn'
  >,
): Promise<FulfillmentStatusResponse> {
  const dropId = supportedDropId(body.dropId);
  if (!walletHasFulfillmentDropAccess(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment access denied.');
  }
  const mutation = await mutateDeliveryOrder({
    common,
    deliveryId: body.deliveryId,
    dropId,
    build: (document): { value: FulfillmentStatusMutation; write: Record<string, unknown> } => {
      const nextStatus = body.status || '';
      const currentTrackingCode = normalizeOptionalFulfillmentTrackingCode(
        document.fields.fulfillmentTrackingCode,
      );
      const nextTrackingCode = nextStatus === 'Shipped'
        ? sanitizeFulfillmentTrackingCode(body.trackingCode)
        : currentTrackingCode;
      const order = orderAfterFulfillmentStatusUpdate({
        dropId,
        fields: document.fields,
        nextStatus,
        nextTrackingCode,
        wallet,
      });
      const decision = decideBuyerOrderShippedNotification({
        before: document.fields,
        after: order,
        deliveryDocId: body.deliveryId,
        dropId,
        emailState: document.fields[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD],
        forceRetry: body.retryShippedEmail === true,
        idempotencyKey: document.fields[BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD],
        jobId: document.fields[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD],
        createJobId: dependencies.createNotificationJobId,
      });
      const updateFields: Record<string, unknown> = {
        dropId: firestoreString(dropId),
        fulfillmentUpdatedBy: firestoreString(wallet),
        ...(nextStatus ? { fulfillmentStatus: firestoreString(nextStatus) } : {}),
      };
      const updateMask = ['dropId', 'fulfillmentUpdatedBy', 'fulfillmentStatus'];
      if (nextStatus === 'Shipped') {
        updateMask.push('fulfillmentTrackingCode');
        if (nextTrackingCode) updateFields.fulfillmentTrackingCode = firestoreString(nextTrackingCode);
      }
      if (decision.kind === 'send') {
        updateFields[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD] = firestoreString(BUYER_ORDER_SHIPPED_EMAIL_PENDING);
        updateFields[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD] = firestoreString(decision.jobId);
        updateFields[BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD] = firestoreString(decision.idempotencyKey);
        updateMask.push(...markerFieldPaths());
        order[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD] = BUYER_ORDER_SHIPPED_EMAIL_PENDING;
        order[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD] = decision.jobId;
        order[BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD] = decision.idempotencyKey;
        delete order[BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD];
      } else if (decision.clearPending) {
        updateMask.push(...markerFieldPaths());
        delete order[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD];
        delete order[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD];
        delete order[BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD];
        delete order[BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD];
      }
      return {
        value: {
          decision,
          order,
          response: {
            ...(decision.kind === 'send'
              ? { buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_PENDING }
              : document.fields[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD] === BUYER_ORDER_SHIPPED_EMAIL_QUEUED
                ? { buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED }
                : {}),
            deliveryId: body.deliveryId,
            fulfillmentStatus: nextStatus,
            ...(nextTrackingCode ? { fulfillmentTrackingCode: nextTrackingCode } : {}),
          },
        },
        write: {
          update: {
            name: documentName(`drops/${dropId}/deliveryOrders/${body.deliveryId}`),
            fields: updateFields,
          },
          updateMask: { fieldPaths: updateMask },
          updateTransforms: [{ fieldPath: 'fulfillmentUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: { updateTime: document.updateTime },
        },
      };
    },
  });
  if (mutation.decision.kind === 'skip') {
    dependencies.log({
      event: 'buyer_order_shipped_notification_skipped',
      dropId,
      deliveryId: body.deliveryId,
      reason: mutation.decision.reason,
    });
    return mutation.response;
  }

  const jobContext = {
    dropId,
    deliveryId: mutation.decision.deliveryId,
    jobId: mutation.decision.jobId,
  };
  let job;
  try {
    job = await createBuyerOrderShippedNotificationJob({
      ...jobContext,
      idempotencyKey: mutation.decision.idempotencyKey,
      order: mutation.order,
    });
    if (!env.NOTIFICATION_EMAIL_QUEUE) throw new Error('Notification email queue binding is unavailable');
    await env.NOTIFICATION_EMAIL_QUEUE.send(job, { contentType: 'json' });
  } catch (error) {
    dependencies.error({
      event: 'buyer_order_shipped_notification_enqueue_failed',
      ...jobContext,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
    });
    throw new ProfileReadError(
      'unavailable',
      503,
      'Order status was saved, but the shipment email could not be queued. Retry saving the status.',
    );
  }
  dependencies.log({
    event: 'buyer_order_shipped_notification_queued',
    ...jobContext,
    kind: job.kind,
  });
  try {
    const marked = await markBuyerOrderShippedEmailQueued({
      common,
      deliveryId: body.deliveryId,
      dropId,
      jobId: mutation.decision.jobId,
    });
    if (marked) {
      return {
        ...mutation.response,
        buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
      };
    }
    dependencies.warn({
      event: 'buyer_order_shipped_notification_marker_finalization_failed',
      ...jobContext,
      reason: 'pending-marker-changed',
    });
  } catch (error) {
    dependencies.error({
      event: 'buyer_order_shipped_notification_marker_finalization_failed',
      ...jobContext,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
    });
  }
  return mutation.response;
}

type FirestoreWriteCommon = {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  pauseForRatePoll: (signal: AbortSignal, delayMs: number) => Promise<void>;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
};

type DeliveryOrderDocument = {
  fields: Record<string, unknown>;
  updateTime: string;
};

function firestoreTimestamp(milliseconds: number): { timestampValue: string } {
  const timestamp = new Date(milliseconds);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ProfileReadError('internal', 500, 'Profile request failed.');
  }
  return { timestampValue: timestamp.toISOString() };
}

function firestoreNumber(value: number): { integerValue: string } | { doubleValue: number } {
  return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
}

function firestoreMap(fields: Record<string, unknown>): { mapValue: { fields: Record<string, unknown> } } {
  return { mapValue: { fields } };
}

function firestoreMoney(value: { currency: string; amount: number }): ReturnType<typeof firestoreMap> {
  return firestoreMap({
    currency: firestoreString(value.currency),
    amount: firestoreNumber(value.amount),
  });
}

function firestorePackage(value: ShipStationPackageInput): ReturnType<typeof firestoreMap> {
  return firestoreMap({
    length: firestoreNumber(value.length),
    width: firestoreNumber(value.width),
    height: firestoreNumber(value.height),
    weight: firestoreNumber(value.weight),
  });
}

function firestoreRateQuotes(
  rates: GetFulfillmentShipStationRatesResponse['rates'],
): { arrayValue: { values: Array<ReturnType<typeof firestoreMap>> } } {
  return {
    arrayValue: {
      values: rates.map((rate) => firestoreMap({
        rateId: firestoreString(rate.rateId),
        shipmentId: firestoreString(rate.shipmentId),
        totalAmount: firestoreMoney(rate.totalAmount),
      })),
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function storedShipStationMoney(value: unknown): { currency: string; amount: number } | undefined {
  if (!isRecord(value)) return undefined;
  const currency = optionalString(value.currency)?.toLowerCase() ?? '';
  const amount = typeof value.amount === 'number' ? value.amount : Number.NaN;
  return /^[a-z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0
    ? { currency, amount }
    : undefined;
}

function storedShipStationRateQuotes(value: unknown): Array<{
  rateId: string;
  shipmentId: string;
  totalAmount: { currency: string; amount: number };
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const rateId = optionalString(entry.rateId);
    const shipmentId = optionalString(entry.shipmentId);
    const totalAmount = storedShipStationMoney(entry.totalAmount);
    return rateId && shipmentId && totalAmount ? [{ rateId, shipmentId, totalAmount }] : [];
  }).slice(0, 100);
}

async function loadDeliveryOrderDocument(
  common: FirestoreWriteCommon,
  dropId: string,
  deliveryId: number,
): Promise<DeliveryOrderDocument> {
  const orderPath = `drops/${dropId}/deliveryOrders/${deliveryId}`;
  const payload = await authenticatedFirestoreRequest({
    ...common,
    method: 'GET',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}/${orderPath}`,
  });
  if (payload === null) throw new ProfileReadError('not-found', 404, 'Delivery order not found');
  if (!isRecord(payload) || typeof payload.updateTime !== 'string' || !payload.updateTime) {
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  const fields = payload.fields === undefined ? {} : decodeFirestoreFields(payload.fields);
  if (!fields) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  return { fields, updateTime: payload.updateTime };
}

async function pauseForMutationRetry(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, 25 * (attempt + 1));
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function mutateDeliveryOrder<T>(args: {
  build: (document: DeliveryOrderDocument) => { value: T; write?: Record<string, unknown> };
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
}): Promise<T> {
  for (let attempt = 0; attempt < FIRESTORE_MUTATION_ATTEMPTS; attempt += 1) {
    const document = await loadDeliveryOrderDocument(args.common, args.dropId, args.deliveryId);
    const mutation = args.build(document);
    if (!mutation.write) return mutation.value;
    try {
      await commitWrites(args.common, [mutation.write], true);
      return mutation.value;
    } catch (error) {
      if (!(error instanceof FirestoreWriteConflict)) throw error;
      if (attempt + 1 >= FIRESTORE_MUTATION_ATTEMPTS) {
        throw new ProfileReadError('aborted', 409, 'The delivery order changed. Try again.');
      }
      await pauseForMutationRetry(args.common.signal, attempt);
    }
  }
  throw new ProfileReadError('aborted', 409, 'The delivery order changed. Try again.');
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encryptFulfillmentAddress(full: string, secretValue: string): { encrypted: string; hint: string } {
  const secret = decodeBase64(secretValue.trim());
  if (!secret || secret.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw new ProfileReadError(
      'unavailable',
      503,
      'ADDRESS_DECRYPTION_SECRET is not configured for Stripe fulfillment',
    );
  }
  try {
    const recipientPublicKey = nacl.box.keyPair.fromSecretKey(secret).publicKey;
    const encrypted = serializeAddressCipherPayload(
      encryptAddressCipherText(full, recipientPublicKey),
      encodeBase64,
    );
    return { encrypted, hint: addressCipherHint(full) };
  } catch {
    throw new ProfileReadError('unavailable', 503, 'Stripe checkout shipping address could not be encrypted');
  }
}

function decryptFulfillmentAddress(payload: string, secretValue: string): string | null {
  const secret = decodeBase64(secretValue.trim());
  if (!secret || secret.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw new ProfileReadError('unavailable', 503, 'Fulfillment address decryption is temporarily unavailable.');
  }
  const parts = parseAddressCipherPayload(payload, decodeBase64);
  return parts ? decryptAddressCipherText(parts, secret) : null;
}

function requireFulfillmentAccess(wallet: string, dropId: string): void {
  if (!walletHasFulfillmentDropAccess(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment access denied.');
  }
}

function rejectIrlShipStationOrder(order: Record<string, unknown>): void {
  if (order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) {
    throw new ProfileReadError('failed-precondition', 409, 'In-person redemption orders do not have a delivery address');
  }
}

function shipStationState(order: Record<string, unknown>): Record<string, unknown> {
  return isRecord(order.shipstation) ? order.shipstation : {};
}

function requireShipStationShipmentId(order: Record<string, unknown>): string {
  const shipmentId = optionalString(shipStationState(order).shipmentId);
  if (!shipmentId) {
    throw new ProfileReadError('failed-precondition', 409, 'Add this order to ShipStation before getting rates.');
  }
  return shipmentId;
}

type ShipStationRateMutationExpectation = {
  claimId: string | null;
  claimedBy: string | null;
  labelIdentity: string;
  purchaseIdentity: string;
  shipmentId: string;
};

function shipStationLabelIdentity(value: unknown): string {
  const label = storedFulfillmentShipStationLabel(value);
  return label ? JSON.stringify([
    label.labelId,
    label.shipmentId,
    label.status,
    label.rateId ?? null,
    label.trackingNumber ?? null,
    label.carrierId ?? null,
    label.carrierCode ?? null,
    label.carrierName ?? null,
    label.serviceCode ?? null,
    label.serviceName ?? null,
    label.shipmentCost?.currency ?? null,
    label.shipmentCost?.amount ?? null,
    label.insuranceCost?.currency ?? null,
    label.insuranceCost?.amount ?? null,
    label.totalCost?.currency ?? null,
    label.totalCost?.amount ?? null,
    label.purchasedAt ?? null,
    label.purchasedBy ?? null,
  ]) : '';
}

function shipStationPurchaseIdentity(shipstation: Record<string, unknown>): string {
  const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
  return `${optionalString(purchase.status) ?? ''}\n${optionalString(purchase.requestId) ?? ''}`;
}

function rateMutationExpectation(
  order: Record<string, unknown>,
  shipmentId: string,
  claim?: { claimId: string; wallet: string },
): ShipStationRateMutationExpectation {
  const shipstation = shipStationState(order);
  return {
    shipmentId,
    labelIdentity: shipStationLabelIdentity(shipstation.label),
    purchaseIdentity: shipStationPurchaseIdentity(shipstation),
    claimId: claim?.claimId ?? optionalString(shipstation.ratesClaimId) ?? null,
    claimedBy: claim?.wallet ?? optionalString(shipstation.ratesClaimedBy) ?? null,
  };
}

function requireRateMutationState(
  order: Record<string, unknown>,
  expected: ShipStationRateMutationExpectation,
): Record<string, unknown> {
  const shipstation = shipStationState(order);
  if (optionalString(shipstation.shipmentId) !== expected.shipmentId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
  }
  if (shipStationLabelIdentity(shipstation.label) !== expected.labelIdentity) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  if (shipStationPurchaseIdentity(shipstation) !== expected.purchaseIdentity) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label purchase changed. Check its status again.');
  }
  if (
    (optionalString(shipstation.ratesClaimId) ?? null) !== expected.claimId ||
    (optionalString(shipstation.ratesClaimedBy) ?? null) !== expected.claimedBy
  ) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation rate refresh claim changed. Try again.');
  }
  return shipstation;
}

async function updateFulfillmentAddress(
  body: z.infer<typeof fulfillmentAddressSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  addressSecret: string,
): Promise<UpdateFulfillmentAddressResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!walletHasFulfillmentAddressAdminAccess(wallet, ADDRESS_ADMIN_WALLETS)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment address admin access denied.');
  }
  const encryptedAddress = encryptFulfillmentAddress(body.full, addressSecret);
  const orderPath = `drops/${dropId}/deliveryOrders/${body.deliveryId}`;
  return mutateDeliveryOrder<UpdateFulfillmentAddressResponse>({
    common,
    dropId,
    deliveryId: body.deliveryId,
    build: ({ fields: order, updateTime }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId)) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'This order is already in ShipStation. Update its delivery address in ShipStation.',
        );
      }
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipstation.label))) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'This order already has a ShipStation label. Void it before changing the delivery address.',
        );
      }
      const labelPurchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
      const purchaseStatus = typeof labelPurchase.status === 'string' ? labelPurchase.status : '';
      if (purchaseStatus === 'purchasing' || purchaseStatus === 'unknown') {
        throw new ProfileReadError(
          'aborted',
          409,
          'Check the ShipStation label purchase status before editing this address.',
        );
      }
      const shipmentClaimedAt = typeof shipstation.claimedAt === 'number' ? shipstation.claimedAt : 0;
      if (shipmentClaimedAt && common.nowMs - shipmentClaimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This order is being added to ShipStation. Try editing the address again in a moment.',
        );
      }
      const ratesClaimedAt = typeof shipstation.ratesClaimedAt === 'number' ? shipstation.ratesClaimedAt : 0;
      if (ratesClaimedAt && common.nowMs - ratesClaimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'ShipStation rates are being refreshed. Try editing the address again in a moment.',
        );
      }
      const snapshot = isRecord(order.addressSnapshot) ? order.addressSnapshot : {};
      const address: FulfillmentOrderAddress = {
        full: body.full,
        encrypted: encryptedAddress.encrypted,
        hint: encryptedAddress.hint,
        ...(typeof snapshot.label === 'string' ? { label: snapshot.label } : {}),
        ...(typeof snapshot.email === 'string' ? { email: snapshot.email } : {}),
        ...(typeof snapshot.phone === 'string' ? { phone: snapshot.phone } : {}),
        ...(typeof snapshot.country === 'string' ? { country: snapshot.country } : {}),
        ...(typeof snapshot.countryCode === 'string' ? { countryCode: snapshot.countryCode } : {}),
      };
      return {
        value: { deliveryId: body.deliveryId, address },
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              addressSnapshot: firestoreMap({
                encrypted: firestoreString(encryptedAddress.encrypted),
                hint: firestoreString(encryptedAddress.hint),
              }),
              fulfillmentAddressUpdatedBy: firestoreString(wallet),
            },
          },
          updateMask: {
            fieldPaths: [
              'addressSnapshot.encrypted',
              'addressSnapshot.hint',
              'fulfillmentAddressUpdatedBy',
              'shipstation.rateQuotes',
              'shipstation.ratesClaimId',
              'shipstation.ratesClaimedAt',
              'shipstation.ratesClaimedBy',
            ],
          },
          updateTransforms: [{ fieldPath: 'fulfillmentAddressUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

type ShipStationShipmentClaim =
  | { alreadyAdded: true; shipmentId: string; addedAt?: number }
  | { alreadyAdded: false; claimId: string; order: Record<string, unknown> };

function fulfillmentShipmentItemCounts(order: Record<string, unknown>): { boxCount: number; looseItemCount: number } {
  const items = Array.isArray(order.items) ? order.items : [];
  let boxCount = 0;
  let looseItemCount = 0;
  for (const item of items) {
    if (!isRecord(item) || (item.kind !== 'box' && item.kind !== 'dude')) continue;
    const refId = Math.floor(Number(item.refId));
    if (!Number.isFinite(refId) || refId <= 0) continue;
    if (item.kind === 'box') boxCount += 1;
    else looseItemCount += 1;
  }
  return { boxCount, looseItemCount };
}

function fulfillmentShipmentUnitCount(order: Record<string, unknown>): number {
  const counts = fulfillmentShipmentItemCounts(order);
  return counts.boxCount + counts.looseItemCount;
}

function requireShipStationCustomsDeclaration(
  dropId: string,
  order: Record<string, unknown>,
): ShipStationCustomsDeclaration {
  const counts = fulfillmentShipmentItemCounts(order);
  const declaration = buildShipStationCustomsDeclaration(dropId, counts.boxCount, counts.looseItemCount);
  if (!declaration) {
    throw new ProfileReadError(
      'failed-precondition',
      409,
      'International customs data is unavailable for this product.',
    );
  }
  return declaration;
}

function requireShipStationPackageWeight(
  parcel: ShipStationPackageInput,
  requiredWeightOunces: number,
): void {
  if (!Number.isFinite(requiredWeightOunces) || parcel.weight + 0.005 >= requiredWeightOunces) return;
  throw new ProfileReadError(
    'failed-precondition',
    409,
    `Package weight must be at least ${requiredWeightOunces} oz for the customs items in this shipment.`,
  );
}

async function claimFulfillmentShipStationShipment(args: {
  claimId: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  onWriteAttempt: () => void;
  wallet: string;
}): Promise<ShipStationShipmentClaim> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  return mutateDeliveryOrder<ShipStationShipmentClaim>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      const shipmentId = optionalString(shipstation.shipmentId);
      if (shipmentId) {
        const addedAt = typeof shipstation.createdAt === 'number' ? shipstation.createdAt : undefined;
        return { value: { alreadyAdded: true, shipmentId, ...(addedAt ? { addedAt } : {}) } };
      }
      const claimedAt = typeof shipstation.claimedAt === 'number' ? shipstation.claimedAt : 0;
      if (claimedAt && args.common.nowMs - claimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This order is already being added to ShipStation. Try again in a moment.',
        );
      }
      args.onWriteAttempt();
      return {
        value: { alreadyAdded: false, claimId: args.claimId, order },
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              dropId: firestoreString(args.dropId),
              shipstation: firestoreMap({
                claimId: firestoreString(args.claimId),
                claimedBy: firestoreString(args.wallet),
              }),
            },
          },
          updateMask: {
            fieldPaths: ['dropId', 'shipstation.claimId', 'shipstation.claimedBy', 'shipstation.claimFenceId'],
          },
          updateTransforms: [{ fieldPath: 'shipstation.claimedAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

function shipStationShipmentFailureMessage(error: unknown): string {
  if (error instanceof ShipStationRatesProviderError || error instanceof ProfileReadError) {
    return error.message.slice(0, 500);
  }
  return 'Failed to add the order to ShipStation';
}

async function transitionFulfillmentShipStationShipmentClaim(args: {
  claimId: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  errorMessage: string;
  retain: boolean;
  wallet: string;
}): Promise<void> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      const shipstation = shipStationState(order);
      const currentClaimId = optionalString(shipstation.claimId);
      const currentClaimedBy = optionalString(shipstation.claimedBy);
      if (currentClaimId !== args.claimId || currentClaimedBy !== args.wallet) return { value: undefined };
      const fields = args.retain
        ? {
            claimId: firestoreString(args.claimId),
            claimedBy: firestoreString(args.wallet),
            lastError: firestoreString(args.errorMessage),
          }
        : {
            claimFenceId: firestoreString(args.claimId),
            lastError: firestoreString(args.errorMessage),
          };
      return {
        value: undefined,
        write: {
          update: {
            name: documentName(orderPath),
            fields: { shipstation: firestoreMap(fields) },
          },
          updateMask: {
            fieldPaths: args.retain
              ? [
                  'shipstation.claimId',
                  'shipstation.claimedBy',
                  'shipstation.claimFenceId',
                  'shipstation.lastError',
                ]
              : [
                  'shipstation.claimId',
                  'shipstation.claimedAt',
                  'shipstation.claimedBy',
                  'shipstation.claimFenceId',
                  'shipstation.lastError',
                ],
          },
          updateTransforms: [
            ...(args.retain ? [{ fieldPath: 'shipstation.claimedAt', setToServerValue: 'REQUEST_TIME' }] : []),
            { fieldPath: 'shipstation.lastErrorAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

async function safelyTransitionFulfillmentShipStationShipmentClaim(args: {
  claimId: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  errorMessage: string;
  retain: boolean;
  wallet: string;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Claim cleanup timed out', 'TimeoutError')),
    3_000,
  );
  try {
    await transitionFulfillmentShipStationShipmentClaim({
      ...args,
      common: { ...args.common, signal: controller.signal },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'fulfillment_shipstation_shipment_claim_transition_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      retain: args.retain,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function persistFulfillmentShipStationShipment(args: {
  claimId: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  externalShipmentId: string;
  packageCount: number;
  shipmentId: string;
  storedPackage?: ShipStationPackageInput;
  wallet: string;
}): Promise<void> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      const shipstation = shipStationState(order);
      if (
        optionalString(shipstation.claimId) !== args.claimId ||
        optionalString(shipstation.claimedBy) !== args.wallet
      ) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment claim changed. Try again.');
      }
      const currentShipmentId = optionalString(shipstation.shipmentId);
      if (currentShipmentId && currentShipmentId !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      return {
        value: undefined,
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              dropId: firestoreString(args.dropId),
              shipstation: firestoreMap({
                shipmentId: firestoreString(args.shipmentId),
                externalShipmentId: firestoreString(args.externalShipmentId),
                shipmentNumber: firestoreString(String(args.deliveryId)),
                createdBy: firestoreString(args.wallet),
                ...(args.storedPackage ? { package: firestorePackage(args.storedPackage) } : {}),
                packageCount: firestoreNumber(args.packageCount),
              }),
            },
          },
          updateMask: {
            fieldPaths: [
              'dropId',
              'shipstation.shipmentId',
              'shipstation.externalShipmentId',
              'shipstation.shipmentNumber',
              'shipstation.createdBy',
              ...(args.storedPackage ? ['shipstation.package'] : []),
              'shipstation.packageCount',
              'shipstation.claimId',
              'shipstation.claimedAt',
              'shipstation.claimedBy',
              'shipstation.claimFenceId',
              'shipstation.lastError',
              'shipstation.lastErrorAt',
            ],
          },
          updateTransforms: [{ fieldPath: 'shipstation.createdAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

function applyShipStationAddressPatch(
  address: ShipStationAddress,
  patch?: ShipStationAddressPatch,
): ShipStationAddress {
  if (!patch) return address;
  const next = { ...address };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.address_line1 !== undefined) next.address_line1 = patch.address_line1;
  if (patch.address_line2 !== undefined) {
    if (patch.address_line2) next.address_line2 = patch.address_line2;
    else delete next.address_line2;
  }
  if (patch.address_line3 !== undefined) {
    if (patch.address_line3) next.address_line3 = patch.address_line3;
    else delete next.address_line3;
  }
  if (patch.city_locality !== undefined) next.city_locality = patch.city_locality;
  if (patch.state_province !== undefined) next.state_province = patch.state_province;
  if (patch.postal_code !== undefined) next.postal_code = patch.postal_code;
  if (patch.country_code !== undefined) next.country_code = patch.country_code;
  return next;
}

async function addFulfillmentOrderToShipStation(
  body: z.infer<typeof shipStationShipmentSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  env: ProfileWriteEnv,
): Promise<AddFulfillmentOrderToShipStationResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  const packageOverride = body.package ? normalizeShipStationPackage(body.package) : null;
  if (body.package && !packageOverride) {
    throw new ProfileReadError('invalid-argument', 400, SHIPSTATION_PACKAGE_RANGE_MESSAGE);
  }
  const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
  if (!apiKey) throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  const shipFromSecret = typeof env.SHIPSTATION_SHIP_FROM === 'string' ? env.SHIPSTATION_SHIP_FROM.trim() : '';
  let shipFrom: ReturnType<typeof parseShipStationShipFrom>;
  try {
    shipFrom = parseShipStationShipFrom(shipFromSecret);
  } catch (error) {
    if (error instanceof ShipStationRatesProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
  const addressSecret = typeof env.ADDRESS_DECRYPTION_SECRET === 'string' ? env.ADDRESS_DECRYPTION_SECRET : '';
  const claimId = crypto.randomUUID();
  let claimWriteAttempted = false;
  let postAttempted = false;
  let shipmentCreated = false;
  try {
    const claim = await claimFulfillmentShipStationShipment({
      claimId,
      common,
      deliveryId: body.deliveryId,
      dropId,
      onWriteAttempt: () => { claimWriteAttempted = true; },
      wallet,
    });
    if (claim.alreadyAdded) {
      return {
        deliveryId: body.deliveryId,
        shipmentId: claim.shipmentId,
        alreadyAdded: true,
        ...(claim.addedAt ? { shipstationAddedAt: claim.addedAt } : {}),
      };
    }
    const externalShipmentId = shipStationExternalId(dropId, body.deliveryId);
    const existing = await getShipStationShipmentByExternalId(apiKey, externalShipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    let shipment = existing;
    let appliedPackage = existing ? shipStationPackageDetails(existing).package : undefined;
    if (!shipment) {
      const addressSnapshot = isRecord(claim.order.addressSnapshot) ? claim.order.addressSnapshot : {};
      const encrypted = optionalString(addressSnapshot.encrypted) ?? '';
      const full = encrypted ? decryptFulfillmentAddress(encrypted, addressSecret) : null;
      const parsed = parseShipStationShipTo(
        full,
        typeof addressSnapshot.countryCode === 'string' ? addressSnapshot.countryCode : undefined,
      );
      if (!parsed.ok || !parsed.shipTo) {
        const reason = parsed.reason || 'Could not read the delivery address';
        throw new ProfileReadError('failed-precondition', 409, `${reason}. Edit the delivery address and try again.`);
      }
      const unitCount = fulfillmentShipmentUnitCount(claim.order);
      const email = optionalString(addressSnapshot.email);
      const phone = optionalString(addressSnapshot.phone);
      const shipTo = applyShipStationAddressPatch({
        ...parsed.shipTo,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      }, body.addressPatch);
      const international = shipFrom.country_code !== shipTo.country_code;
      const customsDeclaration = international
        ? requireShipStationCustomsDeclaration(dropId, claim.order)
        : undefined;
      const defaultPackage = defaultShipStationPackage(unitCount);
      appliedPackage = packageOverride ?? (
        customsDeclaration && defaultPackage.weight < customsDeclaration.minimumPackageWeightOunces
          ? { ...defaultPackage, weight: customsDeclaration.minimumPackageWeightOunces }
          : defaultPackage
      );
      if (customsDeclaration) {
        requireShipStationPackageWeight(appliedPackage, customsDeclaration.totalNetWeightOunces);
      }
      postAttempted = true;
      shipment = await createShipStationShipment(apiKey, {
        external_shipment_id: externalShipmentId,
        shipment_number: String(body.deliveryId),
        ship_to: shipTo,
        ship_from: shipFrom,
        packages: buildShipStationPackages(unitCount, appliedPackage, customsDeclaration ? {
          contentDescription: customsDeclaration.contentDescription,
          products: [customsDeclaration.product],
        } : {}),
        ...(customsDeclaration ? {
          customs: {
            contents: 'merchandise',
            non_delivery: 'return_to_sender',
            terms_of_trade_code: 'dap',
          },
        } : {}),
      }, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      shipmentCreated = true;
    }
    const shipmentId = optionalString(shipment.shipment_id);
    if (!shipmentId) throw new ShipStationRatesProviderError('internal', 'ShipStation did not return a shipment id');
    const packageDetails = shipStationPackageDetails(shipment);
    const storedPackage = appliedPackage ?? packageDetails.package;
    await persistFulfillmentShipStationShipment({
      claimId,
      common,
      deliveryId: body.deliveryId,
      dropId,
      externalShipmentId,
      packageCount: packageDetails.packageCount || 1,
      shipmentId,
      ...(storedPackage ? { storedPackage } : {}),
      wallet,
    });
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      alreadyAdded: Boolean(existing),
      shipstationAddedAt: common.nowMs,
    };
  } catch (error) {
    const failureCode = error instanceof ShipStationRatesProviderError || error instanceof ProfileReadError
      ? error.code
      : 'internal';
    const mayHaveCreated = shipmentCreated || (postAttempted && (
      failureCode === 'deadline-exceeded' ||
      failureCode === 'unavailable' ||
      failureCode === 'internal'
    ));
    if (claimWriteAttempted) {
      await safelyTransitionFulfillmentShipStationShipmentClaim({
        claimId,
        common,
        deliveryId: body.deliveryId,
        dropId,
        errorMessage: shipStationShipmentFailureMessage(error),
        retain: mayHaveCreated,
        wallet,
      });
    }
    if (mayHaveCreated) {
      throw new ShipStationProfileError(
        'aborted',
        409,
        'ShipStation did not confirm the shipment. It may still have been created — check ShipStation, or try again in a couple of minutes.',
      );
    }
    if (error instanceof ShipStationRatesProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
}

function labelDocumentFields(
  label: FulfillmentShipStationLabel,
  wallet: string,
): Record<string, unknown> {
  if (!label.purchasedAt) throw new ProfileReadError('internal', 500, 'Profile request failed.');
  return {
    labelId: firestoreString(label.labelId),
    shipmentId: firestoreString(label.shipmentId),
    status: firestoreString(label.status),
    ...(label.rateId ? { rateId: firestoreString(label.rateId) } : {}),
    ...(label.trackingNumber ? { trackingNumber: firestoreString(label.trackingNumber) } : {}),
    ...(label.carrierId ? { carrierId: firestoreString(label.carrierId) } : {}),
    ...(label.carrierCode ? { carrierCode: firestoreString(label.carrierCode) } : {}),
    ...(label.carrierName ? { carrierName: firestoreString(label.carrierName) } : {}),
    ...(label.serviceCode ? { serviceCode: firestoreString(label.serviceCode) } : {}),
    ...(label.serviceName ? { serviceName: firestoreString(label.serviceName) } : {}),
    ...(label.shipmentCost ? { shipmentCost: firestoreMoney(label.shipmentCost) } : {}),
    ...(label.insuranceCost ? { insuranceCost: firestoreMoney(label.insuranceCost) } : {}),
    ...(label.totalCost ? { totalCost: firestoreMoney(label.totalCost) } : {}),
    ...(label.purchasedBy ? { purchasedBy: firestoreString(label.purchasedBy) } : {}),
    purchasedAt: firestoreTimestamp(label.purchasedAt),
    recordedBy: firestoreString(wallet),
  };
}

async function persistFulfillmentShipStationLabel(args: {
  common: FirestoreWriteCommon;
  confirmedPurchase?: boolean;
  deliveryId: number;
  dropId: string;
  expectedCurrentLabel?: FulfillmentShipStationLabel | null;
  expectedPurchaseRequestId?: string;
  expectedRateMutation?: ShipStationRateMutationExpectation;
  fallbackLabel?: Partial<FulfillmentShipStationLabel>;
  result: ShipStationLabelResult;
  wallet: string;
}): Promise<FulfillmentShipStationLabel> {
  const label: FulfillmentShipStationLabel = {
    ...args.fallbackLabel,
    ...args.result.label,
    purchasedAt: args.result.label.purchasedAt || args.fallbackLabel?.purchasedAt || args.common.nowMs,
  };
  const labelFields = labelDocumentFields(label, args.wallet);
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  return mutateDeliveryOrder({
    common: args.common,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    build: ({ fields: order, updateTime }) => {
      const shipstation = shipStationState(order);
      if (args.expectedRateMutation) requireRateMutationState(order, args.expectedRateMutation);
      if (optionalString(shipstation.shipmentId) !== label.shipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const currentLabel = storedFulfillmentShipStationLabel(shipstation.label);
      const currentLabelIdentity = shipStationLabelIdentity(currentLabel);
      if (
        args.expectedPurchaseRequestId
        && currentLabel
        && isActiveShipStationLabel(currentLabel)
        && currentLabelIdentity !== shipStationLabelIdentity(label)
      ) {
        return { value: currentLabel };
      }
      if (args.expectedPurchaseRequestId) {
        const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
        if (!shouldTransitionShipStationPurchaseState(purchase, args.expectedPurchaseRequestId, false)) {
          throw new ProfileReadError('aborted', 409, 'The ShipStation label purchase changed. Check its status again.');
        }
      }
      if (
        args.expectedCurrentLabel !== undefined
        && currentLabelIdentity !== shipStationLabelIdentity(args.expectedCurrentLabel)
        && currentLabelIdentity !== shipStationLabelIdentity(label)
      ) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
      }
      const trackingCodeUpdate = shipStationTrackingCodeUpdate(
        normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
        currentLabel,
        label,
      );
      const fields: Record<string, unknown> = {
        dropId: firestoreString(args.dropId),
        shipstation: firestoreMap({ label: firestoreMap(labelFields) }),
        ...(trackingCodeUpdate ? { fulfillmentTrackingCode: firestoreString(trackingCodeUpdate) } : {}),
      };
      const updateMask = [
        'dropId',
        'shipstation.label',
        'shipstation.rateQuotes',
      ];
      if (args.expectedRateMutation) {
        updateMask.push(
          'shipstation.ratesClaimId',
          'shipstation.ratesClaimedAt',
          'shipstation.ratesClaimedBy',
        );
      }
      if (trackingCodeUpdate !== undefined) updateMask.push('fulfillmentTrackingCode');
      if (shouldClearShipStationPurchaseState(label, args.confirmedPurchase)) {
        updateMask.push('shipstation.labelPurchase');
      }
      return {
        value: label,
        write: {
          update: { name: documentName(orderPath), fields },
          updateMask: { fieldPaths: updateMask },
          currentDocument: { updateTime },
        },
      };
    },
  });
}

async function transitionShipStationPurchaseState(args: {
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  expectedRequestId?: string;
  expectedShipmentId: string;
  wallet: string;
}): Promise<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  return mutateDeliveryOrder<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }>({
    common: args.common,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    build: ({ fields: order, updateTime }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.expectedShipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const label = storedFulfillmentShipStationLabel(shipstation.label);
      if (isActiveShipStationLabel(label)) return { value: { label, purchaseUnknown: false } };
      const purchase = shipstation.labelPurchase;
      const status = isRecord(purchase) && typeof purchase.status === 'string' ? purchase.status : '';
      if (!shouldTransitionShipStationPurchaseState(purchase, args.expectedRequestId, false)) {
        return { value: { purchaseUnknown: status === 'purchasing' || status === 'unknown' } };
      }
      return {
        value: { purchaseUnknown: true },
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              shipstation: firestoreMap({
                labelPurchase: firestoreMap({
                  status: firestoreString('unknown'),
                  checkedBy: firestoreString(args.wallet),
                }),
              }),
            },
          },
          updateMask: {
            fieldPaths: ['shipstation.labelPurchase.status', 'shipstation.labelPurchase.checkedBy'],
          },
          updateTransforms: [
            { fieldPath: 'shipstation.labelPurchase.checkedAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

function profileErrorForShipStation(
  error: ShipStationLabelProviderError | ShipStationRatesProviderError,
): ProfileReadError {
  const details: FulfillmentShipStationAddressCorrectionDetails | undefined =
    error instanceof ShipStationAddressCorrectionProviderError
      ? { kind: 'shipstation-address-correction', fields: error.fields }
      : undefined;
  if (error.code === 'deadline-exceeded') return new ShipStationProfileError(error.code, 504, error.message);
  if (error.code === 'resource-exhausted') return new ShipStationProfileError(error.code, 429, error.message);
  if (error.code === 'failed-precondition') return new ShipStationProfileError(error.code, 409, error.message, details);
  if (error.code === 'internal') return new ShipStationProfileError('unavailable', 502, error.message);
  return new ShipStationProfileError(error.code, 502, error.message);
}

type ReconciledShipStationLabel = {
  active?: FulfillmentShipStationLabel;
  downloadUrl?: string;
  inactive?: FulfillmentShipStationLabel;
};

function regressesVoidedShipStationLabel(
  current: FulfillmentShipStationLabel | undefined,
  next: FulfillmentShipStationLabel,
): boolean {
  return current?.status === 'voided' && current.labelId === next.labelId && next.status !== 'voided';
}

async function reconcileFulfillmentShipStationLabel(args: {
  apiKey: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  expectedPurchaseRequestId?: string;
  expectedRateMutation?: ShipStationRateMutationExpectation;
  order: Record<string, unknown>;
  refreshInactiveStoredLabel: boolean;
  shipmentId: string;
  wallet: string;
}): Promise<ReconciledShipStationLabel> {
  const storedLabel = storedFulfillmentShipStationLabel(shipStationState(args.order).label);
  let inactive: FulfillmentShipStationLabel | undefined;
  try {
    if (storedLabel?.labelId && (args.refreshInactiveStoredLabel || isActiveShipStationLabel(storedLabel))) {
      const result = await getShipStationLabelById(args.apiKey, storedLabel.labelId, {
        fetch: args.common.providerFetch,
        signal: args.common.signal,
      });
      if (regressesVoidedShipStationLabel(storedLabel, result.label)) {
        inactive = storedLabel;
      } else {
        const label = await persistFulfillmentShipStationLabel({
          common: args.common,
          deliveryId: args.deliveryId,
          dropId: args.dropId,
          expectedCurrentLabel: storedLabel,
          ...(args.expectedPurchaseRequestId ? { expectedPurchaseRequestId: args.expectedPurchaseRequestId } : {}),
          ...(args.expectedRateMutation ? { expectedRateMutation: args.expectedRateMutation } : {}),
          fallbackLabel: storedLabel,
          result,
          wallet: args.wallet,
        });
        if (isActiveShipStationLabel(label)) {
          return { active: label, ...(result.downloadUrl ? { downloadUrl: result.downloadUrl } : {}) };
        }
        inactive = label;
      }
    }
    const adopted = (await listShipStationLabelsForShipment(args.apiKey, args.shipmentId, {
      fetch: args.common.providerFetch,
      signal: args.common.signal,
    })).find((candidate) => !regressesVoidedShipStationLabel(inactive ?? storedLabel, candidate.label));
    if (adopted) {
      const label = await persistFulfillmentShipStationLabel({
        common: args.common,
        deliveryId: args.deliveryId,
        dropId: args.dropId,
        expectedCurrentLabel: inactive ?? storedLabel ?? null,
        ...(args.expectedPurchaseRequestId ? { expectedPurchaseRequestId: args.expectedPurchaseRequestId } : {}),
        ...(args.expectedRateMutation ? { expectedRateMutation: args.expectedRateMutation } : {}),
        result: adopted,
        wallet: args.wallet,
      });
      return { active: label, ...(adopted.downloadUrl ? { downloadUrl: adopted.downloadUrl } : {}) };
    }
    return { ...(inactive ? { inactive } : {}) };
  } catch (error) {
    if (error instanceof ShipStationLabelProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
}

async function getFulfillmentShipStationLabel(
  body: z.infer<typeof shipStationLabelSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  apiKey: string,
): Promise<GetFulfillmentShipStationLabelResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!apiKey) {
    throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  }
  const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
  const order = initial.fields;
  rejectIrlShipStationOrder(order);
  const shipmentId = requireShipStationShipmentId(order);
  const reconciled = await reconcileFulfillmentShipStationLabel({
    apiKey,
    common,
    deliveryId: body.deliveryId,
    dropId,
    order,
    refreshInactiveStoredLabel: true,
    shipmentId,
    wallet,
  });
  if (reconciled.active) {
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label: reconciled.active,
      ...(reconciled.downloadUrl ? { labelDownloadUrl: reconciled.downloadUrl } : {}),
    };
  }
  const purchase = shipStationState(order).labelPurchase;
  const purchaseStatus = isRecord(purchase) && typeof purchase.status === 'string' ? purchase.status : '';
  const purchaseRequestId = isRecord(purchase) && typeof purchase.requestId === 'string'
    ? purchase.requestId
    : undefined;
  const resolvedPurchase = purchaseStatus === 'purchasing'
    ? await transitionShipStationPurchaseState({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expectedRequestId: purchaseRequestId,
        expectedShipmentId: shipmentId,
        wallet,
      })
    : { purchaseUnknown: purchaseStatus === 'unknown' };
  return {
    deliveryId: body.deliveryId,
    shipmentId,
    ...(resolvedPurchase.label ? { label: resolvedPurchase.label } : reconciled.inactive ? { label: reconciled.inactive } : {}),
    ...(resolvedPurchase.purchaseUnknown ? { purchaseUnknown: true } : {}),
  };
}

function expectedFulfillmentShipStationLabelForVoid(
  order: Record<string, unknown>,
  shipmentId: string,
  labelId: string,
): FulfillmentShipStationLabel {
  const label = storedFulfillmentShipStationLabel(shipStationState(order).label);
  if (!label || label.labelId !== labelId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  if (label.shipmentId !== shipmentId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
  }
  return label;
}

async function persistVoidedFulfillmentShipStationLabel(args: {
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  label: FulfillmentShipStationLabel;
  wallet: string;
}): Promise<FulfillmentShipStationLabel & { status: 'voided' }> {
  const result = await persistFulfillmentShipStationLabel({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    expectedCurrentLabel: args.label,
    fallbackLabel: args.label,
    result: { label: { ...args.label, status: 'voided' } },
    wallet: args.wallet,
  });
  if (result.status !== 'voided') {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  return { ...result, status: 'voided' };
}

function shipStationLabelVoidFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ShipStationLabelProviderError || error instanceof ProfileReadError) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: 'internal', message: 'Failed to void the ShipStation label' };
}

async function recoverAmbiguousFulfillmentShipStationLabelVoid(args: {
  apiKey: string;
  body: z.infer<typeof shipStationLabelVoidSchema>;
  common: FirestoreWriteCommon;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<VoidFulfillmentShipStationLabelResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Label void cleanup timed out', 'TimeoutError')),
    SHIPSTATION_LABEL_VOID_CLEANUP_TIMEOUT_MS,
  );
  const common = { ...args.common, signal: controller.signal };
  try {
    try {
      const current = await loadDeliveryOrderDocument(common, args.dropId, args.body.deliveryId);
      const currentLabel = expectedFulfillmentShipStationLabelForVoid(
        current.fields,
        args.shipmentId,
        args.body.labelId,
      );
      if (currentLabel.status === 'voided') {
        return {
          deliveryId: args.body.deliveryId,
          shipmentId: args.shipmentId,
          label: { ...currentLabel, status: 'voided' },
        };
      }
      const providerResult = await getShipStationLabelById(args.apiKey, args.body.labelId, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      if (
        providerResult.label.shipmentId !== args.shipmentId ||
        providerResult.label.status !== 'voided'
      ) return undefined;
      const label = await persistVoidedFulfillmentShipStationLabel({
        common,
        deliveryId: args.body.deliveryId,
        dropId: args.dropId,
        label: currentLabel,
        wallet: args.wallet,
      });
      return { deliveryId: args.body.deliveryId, shipmentId: args.shipmentId, label };
    } catch (error) {
      const failure = shipStationLabelVoidFailure(error);
      console.error(JSON.stringify({
        event: 'fulfillment_shipstation_label_void_reconcile_failed',
        dropId: args.dropId,
        deliveryId: args.body.deliveryId,
        code: failure.code,
      }));
      return undefined;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function voidFulfillmentShipStationLabel(
  body: z.infer<typeof shipStationLabelVoidSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  apiKey: string,
): Promise<VoidFulfillmentShipStationLabelResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!apiKey) {
    throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  }
  const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
  rejectIrlShipStationOrder(initial.fields);
  const shipmentId = requireShipStationShipmentId(initial.fields);
  const initialLabel = expectedFulfillmentShipStationLabelForVoid(initial.fields, shipmentId, body.labelId);
  if (initialLabel.status === 'voided') {
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label: { ...initialLabel, status: 'voided' },
    };
  }
  if (initialLabel.status === 'processing') {
    throw new ProfileReadError('failed-precondition', 409, 'Wait for this ShipStation label to finish processing before voiding it.');
  }
  if (initialLabel.status !== 'completed') {
    throw new ProfileReadError('failed-precondition', 409, 'Only completed ShipStation labels can be voided.');
  }
  let voidAccepted = false;
  try {
    await voidShipStationLabel(apiKey, body.labelId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    voidAccepted = true;
    const label = await persistVoidedFulfillmentShipStationLabel({
      common,
      deliveryId: body.deliveryId,
      dropId,
      label: initialLabel,
      wallet,
    });
    return { deliveryId: body.deliveryId, shipmentId, label };
  } catch (error) {
    const failure = shipStationLabelVoidFailure(error);
    const ambiguous = voidAccepted || (
      error instanceof ShipStationLabelProviderError &&
      ['deadline-exceeded', 'unavailable', 'internal'].includes(error.code)
    );
    if (ambiguous) {
      const recovered = await recoverAmbiguousFulfillmentShipStationLabelVoid({
        apiKey,
        body,
        common,
        dropId,
        shipmentId,
        wallet,
      });
      if (recovered) return recovered;
      throw new ProfileReadError(
        'aborted',
        409,
        'ShipStation did not confirm the label void. Check its status before trying again.',
      );
    }
    if (error instanceof ShipStationLabelProviderError) throw profileErrorForShipStation(error);
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('internal', 500, failure.message);
  }
}

type ShipStationLabelPurchaseClaim =
  | { alreadyPurchased: true; label: FulfillmentShipStationLabel }
  | { alreadyPurchased: false };

async function claimFulfillmentShipStationLabelPurchase(args: {
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: FirestoreWriteCommon;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<ShipStationLabelPurchaseClaim> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.body.deliveryId}`;
  return mutateDeliveryOrder<ShipStationLabelPurchaseClaim>({
    common: args.common,
    deliveryId: args.body.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      const currentLabel = storedFulfillmentShipStationLabel(shipstation.label);
      if (currentLabel && isActiveShipStationLabel(currentLabel)) {
        return { value: { alreadyPurchased: true, label: currentLabel } };
      }
      const quotedRate = storedShipStationRateQuotes(shipstation.rateQuotes)
        .find((candidate) => candidate.rateId === args.body.rateId);
      if (!quotedRate || quotedRate.shipmentId !== args.shipmentId) {
        throw new ProfileReadError('failed-precondition', 409, 'Refresh rates before purchasing this label.');
      }
      if (!shipStationMoneyMatches(args.body.expectedTotal, quotedRate.totalAmount)) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'The selected quote changed. Refresh rates before purchasing.',
        );
      }
      const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
      const status = optionalString(purchase.status) ?? '';
      const previousRequestId = optionalString(purchase.requestId) ?? '';
      if (status === 'purchasing' || status === 'unknown') {
        throw new ProfileReadError(
          'aborted',
          409,
          'A label purchase may already be in progress. Check purchase status before retrying.',
        );
      }
      if (status === 'failed' && previousRequestId === args.body.requestId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This label purchase request was already handled. Review the purchase again.',
        );
      }
      return {
        value: { alreadyPurchased: false },
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              shipstation: firestoreMap({
                labelPurchase: firestoreMap({
                  status: firestoreString('purchasing'),
                  requestId: firestoreString(args.body.requestId),
                  rateId: firestoreString(args.body.rateId),
                  expectedTotal: firestoreMoney(args.body.expectedTotal),
                  claimedBy: firestoreString(args.wallet),
                }),
              }),
            },
          },
          updateMask: {
            fieldPaths: [
              'shipstation.labelPurchase.status',
              'shipstation.labelPurchase.requestId',
              'shipstation.labelPurchase.rateId',
              'shipstation.labelPurchase.expectedTotal',
              'shipstation.labelPurchase.claimedBy',
              'shipstation.labelPurchase.lastError',
              'shipstation.labelPurchase.lastErrorAt',
              'shipstation.labelPurchase.lastErrorBy',
              'shipstation.labelPurchase.checkedAt',
              'shipstation.labelPurchase.checkedBy',
            ],
          },
          updateTransforms: [
            { fieldPath: 'shipstation.labelPurchase.claimedAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

function shipStationLabelPurchaseFailure(error: unknown): { code: string; message: string } {
  if (
    error instanceof ShipStationLabelProviderError
    || error instanceof ShipStationRatesProviderError
    || error instanceof ProfileReadError
  ) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: 'internal', message: 'Failed to purchase the ShipStation label' };
}

async function transitionFulfillmentShipStationLabelPurchase(args: {
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: FirestoreWriteCommon;
  dropId: string;
  message: string;
  nextStatus: 'unknown' | 'failed';
  shipmentId: string;
  wallet: string;
}): Promise<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.body.deliveryId}`;
  return mutateDeliveryOrder<{ label?: FulfillmentShipStationLabel; purchaseUnknown: boolean }>({
    common: args.common,
    deliveryId: args.body.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      const label = storedFulfillmentShipStationLabel(shipstation.label);
      if (isActiveShipStationLabel(label)) return { value: { label, purchaseUnknown: false } };
      const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
      const status = optionalString(purchase.status) ?? '';
      if (!shouldTransitionShipStationPurchaseState(purchase, args.body.requestId, false)) {
        return { value: { purchaseUnknown: status === 'purchasing' || status === 'unknown' } };
      }
      return {
        value: { purchaseUnknown: args.nextStatus === 'unknown' },
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              shipstation: firestoreMap({
                labelPurchase: firestoreMap({
                  status: firestoreString(args.nextStatus),
                  requestId: firestoreString(args.body.requestId),
                  rateId: firestoreString(args.body.rateId),
                  expectedTotal: firestoreMoney(args.body.expectedTotal),
                  lastError: firestoreString(args.message.slice(0, 500)),
                  lastErrorBy: firestoreString(args.wallet),
                }),
              }),
            },
          },
          updateMask: {
            fieldPaths: [
              'shipstation.labelPurchase.status',
              'shipstation.labelPurchase.requestId',
              'shipstation.labelPurchase.rateId',
              'shipstation.labelPurchase.expectedTotal',
              'shipstation.labelPurchase.lastError',
              'shipstation.labelPurchase.lastErrorBy',
            ],
          },
          updateTransforms: [
            { fieldPath: 'shipstation.labelPurchase.lastErrorAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

async function recoverAmbiguousFulfillmentShipStationLabelPurchase(args: {
  apiKey: string;
  body: z.infer<typeof shipStationLabelPurchaseSchema>;
  common: FirestoreWriteCommon;
  dropId: string;
  message: string;
  shipmentId: string;
  wallet: string;
}): Promise<PurchaseFulfillmentShipStationLabelResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Label purchase cleanup timed out', 'TimeoutError')),
    SHIPSTATION_LABEL_PURCHASE_CLEANUP_TIMEOUT_MS,
  );
  const common = { ...args.common, signal: controller.signal };
  try {
    try {
      const current = await loadDeliveryOrderDocument(common, args.dropId, args.body.deliveryId);
      const recovered = await reconcileFulfillmentShipStationLabel({
        apiKey: args.apiKey,
        common,
        deliveryId: args.body.deliveryId,
        dropId: args.dropId,
        expectedPurchaseRequestId: args.body.requestId,
        order: current.fields,
        refreshInactiveStoredLabel: false,
        shipmentId: args.shipmentId,
        wallet: args.wallet,
      });
      if (recovered.active) {
        return {
          deliveryId: args.body.deliveryId,
          shipmentId: args.shipmentId,
          label: recovered.active,
          ...(recovered.downloadUrl ? { labelDownloadUrl: recovered.downloadUrl } : {}),
          alreadyPurchased: false,
        };
      }
    } catch (error) {
      const failure = shipStationLabelPurchaseFailure(error);
      console.error(JSON.stringify({
        event: 'fulfillment_shipstation_label_purchase_reconcile_failed',
        dropId: args.dropId,
        deliveryId: args.body.deliveryId,
        code: failure.code,
      }));
    }
    try {
      const failureState = await transitionFulfillmentShipStationLabelPurchase({
        body: args.body,
        common,
        dropId: args.dropId,
        message: args.message,
        nextStatus: 'unknown',
        shipmentId: args.shipmentId,
        wallet: args.wallet,
      });
      if (failureState.label) {
        return {
          deliveryId: args.body.deliveryId,
          shipmentId: args.shipmentId,
          label: failureState.label,
          alreadyPurchased: true,
        };
      }
    } catch (error) {
      const failure = shipStationLabelPurchaseFailure(error);
      console.error(JSON.stringify({
        event: 'fulfillment_shipstation_label_purchase_cleanup_failed',
        dropId: args.dropId,
        deliveryId: args.body.deliveryId,
        code: failure.code,
      }));
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function purchaseFulfillmentShipStationLabel(
  body: z.infer<typeof shipStationLabelPurchaseSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  apiKey: string,
): Promise<PurchaseFulfillmentShipStationLabelResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!apiKey) {
    throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  }
  const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
  rejectIrlShipStationOrder(initial.fields);
  const shipmentId = requireShipStationShipmentId(initial.fields);
  const reconciled = await reconcileFulfillmentShipStationLabel({
    apiKey,
    common,
    deliveryId: body.deliveryId,
    dropId,
    order: initial.fields,
    refreshInactiveStoredLabel: false,
    shipmentId,
    wallet,
  });
  if (reconciled.active) {
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label: reconciled.active,
      ...(reconciled.downloadUrl ? { labelDownloadUrl: reconciled.downloadUrl } : {}),
      alreadyPurchased: true,
    };
  }
  let claimAcquired = false;
  let purchaseAttempted = false;
  let purchaseAccepted = false;
  try {
    const claim = await claimFulfillmentShipStationLabelPurchase({ body, common, dropId, shipmentId, wallet });
    if (claim.alreadyPurchased) {
      const result = await getShipStationLabelById(apiKey, claim.label.labelId, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      const label = await persistFulfillmentShipStationLabel({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expectedCurrentLabel: claim.label,
        fallbackLabel: claim.label,
        result,
        wallet,
      });
      if (!isActiveShipStationLabel(label)) {
        throw new ProfileReadError(
          'failed-precondition',
          409,
          'The existing ShipStation label is no longer active. Refresh rates before purchasing.',
        );
      }
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        label,
        ...(result.downloadUrl ? { labelDownloadUrl: result.downloadUrl } : {}),
        alreadyPurchased: true,
      };
    }
    claimAcquired = true;
    const selectedRate = await getShipStationRateById(apiKey, body.rateId, shipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    if (selectedRate.shipmentId !== shipmentId) {
      throw new ProfileReadError('permission-denied', 403, 'The selected rate does not belong to this shipment.');
    }
    if (!shipStationMoneyMatches(body.expectedTotal, selectedRate.totalAmount)) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'The selected rate changed. Refresh rates before purchasing.',
      );
    }
    let labelAppearedBeforePurchase: FulfillmentShipStationLabel | undefined;
    const resolution = await adoptOrPurchaseShipStationLabel(
      async () => (await listShipStationLabelsForShipment(apiKey, shipmentId, {
        fetch: common.providerFetch,
        signal: common.signal,
      }))[0] ?? null,
      async () => {
        const current = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
        const currentShipstation = shipStationState(current.fields);
        if (optionalString(currentShipstation.shipmentId) !== shipmentId) {
          throw new ProfileReadError(
            'aborted',
            409,
            'The ShipStation shipment changed. Refresh the order and try again.',
          );
        }
        const currentLabel = storedFulfillmentShipStationLabel(currentShipstation.label);
        if (currentLabel && isActiveShipStationLabel(currentLabel)) {
          labelAppearedBeforePurchase = currentLabel;
          return getShipStationLabelById(apiKey, currentLabel.labelId, {
            fetch: common.providerFetch,
            signal: common.signal,
          });
        }
        const currentPurchase = isRecord(currentShipstation.labelPurchase)
          ? currentShipstation.labelPurchase
          : {};
        if (!shouldTransitionShipStationPurchaseState(currentPurchase, body.requestId, false)) {
          throw new ProfileReadError(
            'aborted',
            409,
            'The ShipStation label purchase changed. Check its status again.',
          );
        }
        purchaseAttempted = true;
        const result = await createShipStationLabelFromRate(apiKey, body.rateId, {
          fetch: common.providerFetch,
          signal: common.signal,
        });
        purchaseAccepted = true;
        return result;
      },
    );
    if (resolution.result.label.shipmentId !== shipmentId) {
      throw new ProfileReadError('internal', 500, 'ShipStation returned a label for the wrong shipment');
    }
    const fallbackLabel = resolution.alreadyPurchased
      ? undefined
      : labelAppearedBeforePurchase ?? {
          rateId: body.rateId,
          purchasedBy: wallet,
          carrierId: selectedRate.carrierId,
          carrierCode: selectedRate.carrierCode,
          carrierName: selectedRate.carrierName,
          serviceCode: selectedRate.serviceCode,
          serviceName: selectedRate.serviceName,
        };
    const label = await persistFulfillmentShipStationLabel({
      common,
      confirmedPurchase: !resolution.alreadyPurchased && labelAppearedBeforePurchase === undefined,
      deliveryId: body.deliveryId,
      dropId,
      expectedPurchaseRequestId: body.requestId,
      ...(fallbackLabel ? { fallbackLabel } : {}),
      result: resolution.result,
      wallet,
    });
    if (labelAppearedBeforePurchase && !isActiveShipStationLabel(label)) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'The existing ShipStation label is no longer active. Refresh rates before purchasing.',
      );
    }
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      label,
      ...(label.labelId === resolution.result.label.labelId && resolution.result.downloadUrl
        ? { labelDownloadUrl: resolution.result.downloadUrl }
        : {}),
      alreadyPurchased: resolution.alreadyPurchased
        || labelAppearedBeforePurchase !== undefined
        || label.labelId !== resolution.result.label.labelId,
    };
  } catch (error) {
    if (!claimAcquired) throw error;
    const failure = shipStationLabelPurchaseFailure(error);
    const ambiguous = purchaseAccepted || (
      purchaseAttempted
      && ['deadline-exceeded', 'unavailable', 'internal', 'unknown'].includes(failure.code)
    );
    if (ambiguous) {
      const recovered = await recoverAmbiguousFulfillmentShipStationLabelPurchase({
        apiKey,
        body,
        common,
        dropId,
        message: failure.message,
        shipmentId,
        wallet,
      });
      if (recovered) return recovered;
      throw new ProfileReadError(
        'aborted',
        409,
        'ShipStation did not confirm the label purchase. Check purchase status or open ShipStation before retrying.',
      );
    }
    const failureState = await transitionFulfillmentShipStationLabelPurchase({
      body,
      common,
      dropId,
      message: failure.message,
      nextStatus: 'failed',
      shipmentId,
      wallet,
    });
    if (failureState.label) {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        label: failureState.label,
        alreadyPurchased: true,
      };
    }
    if (error instanceof ShipStationLabelProviderError || error instanceof ShipStationRatesProviderError) {
      throw profileErrorForShipStation(error);
    }
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('internal', 500, 'Failed to purchase the ShipStation label');
  }
}

type PendingShipStationRateRequest = {
  requestId: string;
  createdAt?: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Number.isFinite(value) ? value : null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) return 'null';
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function shipStationRateInputHash(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storedPendingShipStationRateRequest(
  value: unknown,
  shipmentId: string,
  parcel: ShipStationPackageInput,
  inputHash: string,
  nowMs: number,
): PendingShipStationRateRequest | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = optionalString(value.requestId);
  const storedShipmentId = optionalString(value.shipmentId);
  const storedPackage = parseShipStationPackage(value.package);
  const requestedAt = typeof value.requestedAt === 'number' ? value.requestedAt : 0;
  if (
    !requestId ||
    storedShipmentId !== shipmentId ||
    !storedPackage ||
    !requestedAt ||
    optionalString(value.inputHash) !== inputHash ||
    nowMs - requestedAt >= SHIPSTATION_RATE_REQUEST_TTL_MS ||
    storedPackage.length !== parcel.length ||
    storedPackage.width !== parcel.width ||
    storedPackage.height !== parcel.height ||
    storedPackage.weight !== parcel.weight
  ) return undefined;
  const createdAt = optionalString(value.createdAt);
  return { requestId, ...(createdAt ? { createdAt } : {}) };
}

function orderShipStationPackage(order: Record<string, unknown>): ShipStationPackageInput | undefined {
  return parseShipStationPackage(shipStationState(order).package) ?? undefined;
}

function orderShipStationPackageCount(order: Record<string, unknown>): number {
  const packageCount = Math.floor(Number(shipStationState(order).packageCount) || 0);
  return Math.max(0, packageCount);
}

async function persistUnsupportedShipStationPackageCount(args: {
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  packageCount: number;
}): Promise<void> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      requireRateMutationState(order, args.expected);
      return {
        value: undefined,
        write: {
          update: {
            name: documentName(orderPath),
            fields: { shipstation: firestoreMap({ packageCount: firestoreNumber(args.packageCount) }) },
          },
          updateMask: {
            fieldPaths: [
              'shipstation.packageCount',
              'shipstation.package',
              'shipstation.rateQuotes',
              'shipstation.rateRequest',
              'shipstation.ratesClaimId',
              'shipstation.ratesClaimedAt',
              'shipstation.ratesClaimedBy',
            ],
          },
          currentDocument: { updateTime },
        },
      };
    },
  });
}

async function pauseForRatePoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function persistPendingShipStationRateRequest(args: {
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  inputHash: string;
  package: ShipStationPackageInput;
  request: PendingShipStationRateRequest;
  shipmentId: string;
}): Promise<void> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      requireRateMutationState(order, args.expected);
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipStationState(order).label))) {
        throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
      }
      return {
        value: undefined,
        write: {
          update: {
            name: documentName(orderPath),
            fields: {
              shipstation: firestoreMap({
                rateRequest: firestoreMap({
                  requestId: firestoreString(args.request.requestId),
                  ...(args.request.createdAt ? { createdAt: firestoreString(args.request.createdAt) } : {}),
                  shipmentId: firestoreString(args.shipmentId),
                  inputHash: firestoreString(args.inputHash),
                  package: firestorePackage(args.package),
                }),
              }),
            },
          },
          updateMask: {
            fieldPaths: [
              'shipstation.rateRequest.requestId',
              'shipstation.rateRequest.createdAt',
              'shipstation.rateRequest.shipmentId',
              'shipstation.rateRequest.inputHash',
              'shipstation.rateRequest.package',
            ],
          },
          updateTransforms: [
            { fieldPath: 'shipstation.rateRequest.requestedAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { updateTime },
        },
      };
    },
  });
}

async function getCompletedShipStationRates(args: {
  apiKey: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  inputHash: string;
  package: ShipStationPackageInput;
  pendingRequest?: PendingShipStationRateRequest;
  shipmentId: string;
}): Promise<Pick<GetFulfillmentShipStationRatesResponse, 'invalidRates' | 'rates'>> {
  const options = { fetch: args.common.providerFetch, signal: args.common.signal };
  let response: ShipStationRateResponse = args.pendingRequest
    ? await getShipStationShipmentRates(args.apiKey, args.shipmentId, args.pendingRequest, options)
    : await requestShipStationShipmentRates(args.apiKey, args.shipmentId, options);
  let expectedRequest = args.pendingRequest;
  if (!expectedRequest && response.status === 'working') {
    if (!response.rateRequestId) {
      throw new ShipStationRatesProviderError('internal', 'ShipStation did not identify the pending rate request.');
    }
    expectedRequest = {
      requestId: response.rateRequestId,
      ...(response.createdAt ? { createdAt: response.createdAt } : {}),
    };
    await persistPendingShipStationRateRequest({
      common: args.common,
      deliveryId: args.deliveryId,
      dropId: args.dropId,
      expected: args.expected,
      inputHash: args.inputHash,
      package: args.package,
      request: expectedRequest,
      shipmentId: args.shipmentId,
    });
  }
  for (const delayMs of [400, 800, 1200]) {
    if (response.status !== 'working') break;
    if (!expectedRequest) {
      throw new ShipStationRatesProviderError('internal', 'ShipStation did not identify the pending rate request.');
    }
    await args.common.pauseForRatePoll(args.common.signal, delayMs);
    response = await getShipStationShipmentRates(args.apiKey, args.shipmentId, expectedRequest, options);
  }
  if (response.status === 'working') {
    throw new ShipStationRatesProviderError('unavailable', 'ShipStation is still calculating rates. Try again in a moment.');
  }
  return {
    rates: response.rates.filter((rate) => rate.shipmentId === args.shipmentId),
    invalidRates: response.invalidRates,
  };
}

async function releaseShipStationRatesClaim(args: {
  claimId: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<void> {
  const orderPath = `drops/${args.dropId}/deliveryOrders/${args.deliveryId}`;
  return mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order, updateTime }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) return { value: undefined };
      const currentClaimId = optionalString(shipstation.ratesClaimId);
      if (currentClaimId && (
        currentClaimId !== args.claimId || optionalString(shipstation.ratesClaimedBy) !== args.wallet
      )) {
        return { value: undefined };
      }
      if (!currentClaimId && optionalString(shipstation.ratesClaimFenceId) === args.claimId) {
        return { value: undefined };
      }
      const fieldPaths = currentClaimId
        ? [
            'shipstation.ratesClaimId',
            'shipstation.ratesClaimedAt',
            'shipstation.ratesClaimedBy',
            'shipstation.ratesClaimFenceId',
          ]
        : ['shipstation.ratesClaimFenceId'];
      return {
        value: undefined,
        write: {
          update: {
            name: documentName(orderPath),
            fields: currentClaimId
              ? {}
              : { shipstation: firestoreMap({ ratesClaimFenceId: firestoreString(args.claimId) }) },
          },
          updateMask: { fieldPaths },
          currentDocument: { updateTime },
        },
      };
    },
  });
}

async function safelyReleaseShipStationRatesClaim(args: {
  claimId: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Claim cleanup timed out', 'TimeoutError')),
    3_000,
  );
  try {
    await releaseShipStationRatesClaim({
      ...args,
      common: { ...args.common, signal: controller.signal },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'fulfillment_shipstation_rates_claim_release_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function getFulfillmentShipStationRates(
  body: z.infer<typeof shipStationRatesSchema>,
  wallet: string,
  common: FirestoreWriteCommon,
  env: ProfileWriteEnv,
): Promise<GetFulfillmentShipStationRatesResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  const packageOverride = body.package ? normalizeShipStationPackage(body.package) : null;
  if (body.package && !packageOverride) {
    throw new ProfileReadError('invalid-argument', 400, SHIPSTATION_PACKAGE_RANGE_MESSAGE);
  }
  const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
  if (!apiKey) throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  const shipFromSecret = typeof env.SHIPSTATION_SHIP_FROM === 'string' ? env.SHIPSTATION_SHIP_FROM.trim() : '';
  const claimId = crypto.randomUUID();
  let shipmentId = '';
  let claimWriteAttempted = false;
  try {
    const shipFrom = parseShipStationShipFrom(shipFromSecret);
    const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
    let order = initial.fields;
    rejectIrlShipStationOrder(order);
    shipmentId = requireShipStationShipmentId(order);
    const reconciled = await reconcileFulfillmentShipStationLabel({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      order,
      refreshInactiveStoredLabel: false,
      shipmentId,
      wallet,
    });
    if (reconciled.active) {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        ...(orderShipStationPackage(order) ? { package: orderShipStationPackage(order) } : {}),
        packageCount: orderShipStationPackageCount(order),
        rates: [],
        invalidRates: [],
        label: reconciled.active,
        ...(reconciled.downloadUrl ? { labelDownloadUrl: reconciled.downloadUrl } : {}),
      };
    }
    order = (await loadDeliveryOrderDocument(common, dropId, body.deliveryId)).fields;
    if (requireShipStationShipmentId(order) !== shipmentId) {
      throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
    }
    const purchase = shipStationState(order).labelPurchase;
    const purchaseStatus = isRecord(purchase) ? optionalString(purchase.status) : undefined;
    if (purchaseStatus === 'purchasing' || purchaseStatus === 'unknown') {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        ...(orderShipStationPackage(order) ? { package: orderShipStationPackage(order) } : {}),
        packageCount: orderShipStationPackageCount(order),
        rates: [],
        invalidRates: [],
        purchaseUnknown: true,
      };
    }
    const initialExpectation = rateMutationExpectation(order, shipmentId);
    const orderPath = `drops/${dropId}/deliveryOrders/${body.deliveryId}`;
    const claimedOrder = await mutateDeliveryOrder<Record<string, unknown>>({
      common,
      deliveryId: body.deliveryId,
      dropId,
      build: ({ fields: currentOrder, updateTime }) => {
        const currentShipstation = requireRateMutationState(currentOrder, initialExpectation);
        const currentPurchase = isRecord(currentShipstation.labelPurchase) ? currentShipstation.labelPurchase : {};
        const currentPurchaseStatus = optionalString(currentPurchase.status);
        if (currentPurchaseStatus === 'purchasing' || currentPurchaseStatus === 'unknown') {
          throw new ProfileReadError('aborted', 409, 'A label purchase may already be in progress. Check purchase status first.');
        }
        if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(currentShipstation.label))) {
          throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
        }
        const claimedAt = typeof currentShipstation.ratesClaimedAt === 'number'
          ? currentShipstation.ratesClaimedAt
          : 0;
        if (claimedAt && common.nowMs - claimedAt < SHIPSTATION_CLAIM_TTL_MS) {
          throw new ProfileReadError('aborted', 409, 'Rates are already being refreshed for this shipment. Try again in a moment.');
        }
        claimWriteAttempted = true;
        return {
          value: currentOrder,
          write: {
            update: {
              name: documentName(orderPath),
              fields: {
                shipstation: firestoreMap({
                  ratesClaimId: firestoreString(claimId),
                  ratesClaimedBy: firestoreString(wallet),
                }),
              },
            },
            updateMask: {
              fieldPaths: [
                'shipstation.rateQuotes',
                'shipstation.ratesClaimId',
                'shipstation.ratesClaimedBy',
                'shipstation.ratesClaimFenceId',
              ],
            },
            updateTransforms: [{ fieldPath: 'shipstation.ratesClaimedAt', setToServerValue: 'REQUEST_TIME' }],
            currentDocument: { updateTime },
          },
        };
      },
    });
    const claimedExpectation = rateMutationExpectation(claimedOrder, shipmentId, { claimId, wallet });
    const shipment = await getShipStationShipmentById(apiKey, shipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    const currentPackageDetails = shipStationPackageDetails(shipment);
    if (currentPackageDetails.packageCount !== 1) {
      await persistUnsupportedShipStationPackageCount({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expected: claimedExpectation,
        packageCount: currentPackageDetails.packageCount,
      });
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        packageCount: currentPackageDetails.packageCount,
        rates: [],
        invalidRates: [],
      };
    }
    const storedOrderPackage = orderShipStationPackage(claimedOrder);
    const resolvedPackage = packageOverride ?? currentPackageDetails.package ?? storedOrderPackage;
    if (!resolvedPackage) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'ShipStation package measurements are unavailable for this shipment.',
      );
    }
    const sourcePackage = shipment.packages[0];
    const international = shipFrom.country_code !== shipment.ship_to.country_code;
    let customs: ShipStationCustoms | undefined;
    let products: ShipStationPackageProduct[] | undefined;
    let contentDescription: string | undefined;
    let repairedShipment = Boolean(!packageOverride && !currentPackageDetails.package && storedOrderPackage);
    if (international) {
      const currentProducts = shipStationPackageProducts(sourcePackage);
      const currentContentDescription = shipStationPackageContentDescription(sourcePackage);
      const declaration = !shipment.customs || !currentProducts || !currentContentDescription
        ? requireShipStationCustomsDeclaration(dropId, claimedOrder)
        : undefined;
      customs = shipment.customs ?? {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      };
      products = currentProducts ?? [declaration!.product];
      contentDescription = currentContentDescription ?? declaration!.contentDescription;
      repairedShipment ||= !shipment.customs || !currentProducts || !currentContentDescription;
      requireShipStationPackageWeight(resolvedPackage, shipStationProductsTotalWeightOunces(products));
    }
    const rateInput = {
      ship_to: shipment.ship_to,
      ship_from: shipFrom,
      packages: buildShipStationPackages(1, resolvedPackage, {
        sourcePackage,
        ...(products ? { products } : {}),
        ...(contentDescription ? { contentDescription } : {}),
      }),
      ...(customs ? { customs } : {}),
    };
    const inputHash = await shipStationRateInputHash(rateInput);
    const updatedShipment = await updateShipStationShipment(
      apiKey,
      shipmentId,
      rateInput,
      { fetch: common.providerFetch, signal: common.signal },
    );
    const updatedPackageDetails = shipStationPackageDetails(updatedShipment);
    if (updatedPackageDetails.packageCount !== 1) {
      await persistUnsupportedShipStationPackageCount({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expected: claimedExpectation,
        packageCount: updatedPackageDetails.packageCount,
      });
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        packageCount: updatedPackageDetails.packageCount,
        rates: [],
        invalidRates: [],
      };
    }
    const storedPackage = packageOverride ?? updatedPackageDetails.package ?? resolvedPackage;
    await mutateDeliveryOrder<void>({
      common,
      deliveryId: body.deliveryId,
      dropId,
      build: ({ fields: currentOrder, updateTime }) => {
        requireRateMutationState(currentOrder, claimedExpectation);
        return {
          value: undefined,
          write: {
            update: {
              name: documentName(orderPath),
              fields: {
                shipstation: firestoreMap({
                  package: firestorePackage(storedPackage),
                  packageCount: firestoreNumber(1),
                }),
              },
            },
            updateMask: { fieldPaths: ['shipstation.package', 'shipstation.packageCount'] },
            currentDocument: { updateTime },
          },
        };
      },
    });
    const adoptedAfterUpdate = await reconcileFulfillmentShipStationLabel({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      expectedRateMutation: claimedExpectation,
      order: claimedOrder,
      refreshInactiveStoredLabel: false,
      shipmentId,
      wallet,
    });
    if (adoptedAfterUpdate.active) {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        package: storedPackage,
        packageCount: 1,
        rates: [],
        invalidRates: [],
        label: adoptedAfterUpdate.active,
        ...(adoptedAfterUpdate.downloadUrl ? { labelDownloadUrl: adoptedAfterUpdate.downloadUrl } : {}),
      };
    }
    const pendingRateRequest = repairedShipment
      ? undefined
      : storedPendingShipStationRateRequest(
          shipStationState(claimedOrder).rateRequest,
          shipmentId,
          storedPackage,
          inputHash,
          common.nowMs,
        );
    const rateResponse = await getCompletedShipStationRates({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      expected: claimedExpectation,
      inputHash,
      package: storedPackage,
      ...(pendingRateRequest ? { pendingRequest: pendingRateRequest } : {}),
      shipmentId,
    });
    await mutateDeliveryOrder<void>({
      common,
      deliveryId: body.deliveryId,
      dropId,
      build: ({ fields: currentOrder, updateTime }) => {
        requireRateMutationState(currentOrder, claimedExpectation);
        if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipStationState(currentOrder).label))) {
          throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
        }
        return {
          value: undefined,
          write: {
            update: {
              name: documentName(orderPath),
              fields: {
                shipstation: firestoreMap({
                  package: firestorePackage(storedPackage),
                  packageCount: firestoreNumber(1),
                  rateQuotes: firestoreRateQuotes(rateResponse.rates),
                  ratesUpdatedBy: firestoreString(wallet),
                }),
              },
            },
            updateMask: {
              fieldPaths: [
                'shipstation.package',
                'shipstation.packageCount',
                'shipstation.rateQuotes',
                'shipstation.rateRequest',
                'shipstation.ratesUpdatedBy',
                'shipstation.ratesClaimId',
                'shipstation.ratesClaimedAt',
                'shipstation.ratesClaimedBy',
              ],
            },
            updateTransforms: [{ fieldPath: 'shipstation.ratesUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
            currentDocument: { updateTime },
          },
        };
      },
    });
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      package: storedPackage,
      packageCount: 1,
      rates: rateResponse.rates,
      invalidRates: rateResponse.invalidRates,
    };
  } catch (error) {
    if (claimWriteAttempted && shipmentId) {
      await safelyReleaseShipStationRatesClaim({
        claimId,
        common,
        deliveryId: body.deliveryId,
        dropId,
        shipmentId,
        wallet,
      });
    }
    if (error instanceof ShipStationRatesProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
}

export async function handleProfileWriteRequest(
  request: Request,
  env: ProfileWriteEnv,
  path: ProfileWritePath,
  overrides: Partial<ProfileWriteDependencies> = {},
): Promise<ProfileWriteResult> {
  const dependencies = {
    ...defaultDependencies,
    ...(path === FULFILLMENT_SHIPSTATION_LABEL_PATH ? { timeoutMs: SHIPSTATION_LABEL_OPERATION_TIMEOUT_MS } : {}),
    ...(path === FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH
      ? { timeoutMs: SHIPSTATION_LABEL_PURCHASE_OPERATION_TIMEOUT_MS }
      : {}),
    ...(path === FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH
      ? { timeoutMs: SHIPSTATION_LABEL_VOID_OPERATION_TIMEOUT_MS }
      : {}),
    ...(path === FULFILLMENT_SHIPSTATION_RATES_PATH ? { timeoutMs: SHIPSTATION_RATES_OPERATION_TIMEOUT_MS } : {}),
    ...(path === FULFILLMENT_SHIPSTATION_SHIPMENT_PATH ? { timeoutMs: SHIPSTATION_SHIPMENT_OPERATION_TIMEOUT_MS } : {}),
    ...overrides,
  };
  const metrics: ProfileWriteMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
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
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response, metrics, authOutcome: 'rejected' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Profile request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: RequestIdentity | undefined;
  try {
    const requestBody = await parseExactRequestBody(request, path, controller.signal);
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    if (isStaffOnlyApiPath(path) && !isStaffRequestIdentity(identity)) {
      throw new ProfileReadError('unauthenticated', 401, 'Staff wallet authentication is required.');
    }
    const serviceAccountJson = typeof env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON === 'string'
      ? env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON
      : '';
    if (!serviceAccountJson) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
    const common = {
      accessTokenProvider: dependencies.accessTokenProvider,
      nowMs: dependencies.nowMs(),
      pauseForRatePoll: dependencies.pauseForRatePoll,
      providerFetch: trackedFetch,
      serviceAccountJson,
      signal: controller.signal,
    };
    const wallet = await resolveRequestWallet(identity, (uid) => loadSessionWallet({
      db: env.OPS_DB,
      resolveD1WalletSession: dependencies.resolveD1WalletSession,
      signal: controller.signal,
      uid,
    }));
    let payload: unknown;
    if (path === PROFILE_ADDRESSES_PATH) {
      payload = await saveAddress(
        requestBody as z.infer<typeof saveAddressSchema>,
        wallet,
        env.OPS_DB,
        dependencies.autoId,
        dependencies.nowMs(),
        controller.signal,
        dependencies.saveProfileAddress,
      );
    } else if (path === FULFILLMENT_ORDER_STATUS_PATH) {
      payload = await updateFulfillmentStatus(
        requestBody as z.infer<typeof fulfillmentStatusSchema>,
        wallet,
        common,
        env,
        dependencies,
      );
    } else if (path === FULFILLMENT_ORDER_ADDRESS_PATH) {
      const addressSecret = typeof env.ADDRESS_DECRYPTION_SECRET === 'string'
        ? env.ADDRESS_DECRYPTION_SECRET
        : '';
      payload = await updateFulfillmentAddress(
        requestBody as z.infer<typeof fulfillmentAddressSchema>,
        wallet,
        common,
        addressSecret,
      );
    } else if (path === FULFILLMENT_SHIPSTATION_LABEL_PATH) {
      const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
      payload = await getFulfillmentShipStationLabel(
        requestBody as z.infer<typeof shipStationLabelSchema>,
        wallet,
        common,
        apiKey,
      );
    } else if (path === FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH) {
      const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
      payload = await purchaseFulfillmentShipStationLabel(
        requestBody as z.infer<typeof shipStationLabelPurchaseSchema>,
        wallet,
        common,
        apiKey,
      );
    } else if (path === FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH) {
      const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
      payload = await voidFulfillmentShipStationLabel(
        requestBody as z.infer<typeof shipStationLabelVoidSchema>,
        wallet,
        common,
        apiKey,
      );
    } else if (path === FULFILLMENT_SHIPSTATION_RATES_PATH) {
      payload = await getFulfillmentShipStationRates(
        requestBody as z.infer<typeof shipStationRatesSchema>,
        wallet,
        common,
        env,
      );
    } else {
      payload = await addFulfillmentOrderToShipStation(
        requestBody as z.infer<typeof shipStationShipmentSchema>,
        wallet,
        common,
        env,
      );
    }
    return { response: jsonResponse(payload, 200), metrics, authOutcome: 'accepted' };
  } catch (error) {
    let profileError: ProfileReadError;
    let authOutcome: ProfileWriteResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (error instanceof ProfileReadError) {
      profileError = error;
      if (error instanceof ShipStationProfileError) {
        authOutcome = 'provider-failure';
      } else if (
        error.code === 'unauthenticated' ||
        error.code === 'permission-denied' ||
        error.code === 'invalid-argument' ||
        error.code === 'not-found' ||
        error.code === 'aborted' ||
        error.code === 'failed-precondition'
      ) {
        authOutcome = 'rejected';
      }
    } else if (error instanceof FirebaseIdTokenError) {
      if (error.kind === 'invalid-token') {
        profileError = new ProfileReadError('unauthenticated', 401, 'Authentication is required.');
        authOutcome = 'rejected';
      } else if (error.kind === 'provider-timeout') {
        profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
      } else {
        profileError = new ProfileReadError('unavailable', 502, 'Authentication is temporarily unavailable.');
      }
    } else if (controller.signal.aborted) {
      profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
    } else {
      profileError = new ProfileReadError('internal', 500, 'Profile request failed.');
    }
    return { response: errorResponse(profileError), metrics, authOutcome };
  } finally {
    clearTimeout(timeout);
  }
}

export const profileWriteTestHooks = {
  firestoreAutoId: createProfileAddressId,
  shipStationRateInputHash,
};
