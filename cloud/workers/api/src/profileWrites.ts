import { z } from 'zod';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import {
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  walletHasFulfillmentAddressAdminAccess,
} from '../../../../shared/fulfillmentAccess.js';
import { FULFILLMENT_STATUS_OPTIONS } from '../../../../shared/fulfillmentStatus.js';
import {
  normalizeOptionalFulfillmentTrackingCode,
  sanitizeFulfillmentTrackingCode,
} from '../../../../shared/fulfillmentTracking.js';
import {
  isActiveShipStationLabel,
  storedFulfillmentShipStationLabel,
} from '../../../../shared/shipstationLabels.js';
import {
  createProfileAddressId,
  PROFILE_ADDRESS_ID_PATTERN,
} from '../../../../shared/profileD1.js';
import type {
  FulfillmentOrderAddress,
  ProfileAddress,
  UpdateFulfillmentAddressResponse,
} from '../../../../shared/contracts.js';
import {
  RequestIdentityError,
  isStaffOnlyApiPath,
  isStaffRequestIdentity,
  resolveRequestWallet,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import {
  isRecord,
  ProfileReadError,
} from './dataAccess.js';
import {
  apiErrorBody,
  jsonResponse,
} from './httpResponse.js';
import { rethrowDeferredWorkRegistrationError } from './deferredWork.js';
import {
  D1CommerceRepository,
  commerceFieldValue,
  type CommerceUpdateValue,
} from './commerceRepository.js';
import {
  mutateDeliveryOrder,
  type CommerceWriteCommon,
} from './profileWriteCommerce.js';
import { optionalString } from './profileWriteRates.js';
import { saveD1ProfileAddress } from './profileD1.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import {
  BUYER_ORDER_SHIPPED_EMAIL_PENDING,
  BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
  createBuyerOrderShippedNotificationJob,
  decideBuyerOrderShippedNotification,
  type BuyerOrderShippedDecision,
} from './buyerOrderShipped.js';
import {
  type ProfileWriteDependencies,
  type ProfileWriteEnv,
  defineProfileWriteOperation,
} from './profileWriteOperation.js';
import {
  pauseForRatePoll,
  shipStationRateOperations,
} from './shipstation/rates.js';
import {
  supportedDropId,
  requireFulfillmentAccess,
  encryptFulfillmentAddress,
  rejectIrlShipStationOrder,
  shipStationState,
  SHIPSTATION_CLAIM_TTL_MS,
  ShipStationProfileError,
} from './shipstation/common.js';
import { shipStationLabelOperations } from './shipstation/labels.js';
import { shipStationShipmentOperations } from './shipstation/shipments.js';

export const PROFILE_ADDRESSES_PATH = '/profile/addresses';
const FULFILLMENT_ORDER_STATUS_PATH = '/fulfillment/order-status';
const FULFILLMENT_ORDER_ADDRESS_PATH = '/fulfillment/order-address';

type ProfileWriteMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type ProfileWriteResult = {
  response: Response;
  metrics: ProfileWriteMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
};

const PROFILE_WRITE_TIMEOUT_MS = 15_000;
const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
const MAX_STATUS_REQUEST_BYTES = 4096;
const MAX_FULFILLMENT_ADDRESS_REQUEST_BYTES = 16 * 1024;
const ADDRESS_ADMIN_WALLETS = new Set(FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES);
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

const defaultDependencies: ProfileWriteDependencies = {
  autoId: createProfileAddressId,
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  createNotificationJobId: () => crypto.randomUUID(),
  defer: () => undefined,
  error: (entry) => console.error(entry),
  log: (entry) => console.log(entry),
  nowMs: () => Date.now(),
  pauseForRatePoll,
  providerFetch: (input, init) => fetch(input, init),
  resolveD1AuthWalletBinding: (db, uid, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    return resolveD1AuthWalletBinding(db, uid, signal);
  },
  saveProfileAddress: (db, address, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    return saveD1ProfileAddress(db, address, signal);
  },
  timeoutMs: PROFILE_WRITE_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
  warn: (entry) => console.warn(entry),
};

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse(apiErrorBody(error), error.status);
}

async function loadSessionWallet(args: {
  db: D1Database | undefined;
  resolveD1AuthWalletBinding: ProfileWriteDependencies['resolveD1AuthWalletBinding'];
  signal: AbortSignal;
  uid: string;
}): Promise<string> {
  try {
    const resolution = await args.resolveD1AuthWalletBinding(args.db, args.uid, args.signal);
    if ('reason' in resolution) {
      throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(args.signal, error)) throw args.signal.reason;
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  }
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
  } catch (error) {
    if (isSignalCancellationError(signal, error)) throw signal.reason;
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
  common: CommerceWriteCommon;
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
        updates: {
          [BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD]: BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
          [BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD]: args.jobId,
          [BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}

async function updateFulfillmentStatus(
  body: z.infer<typeof fulfillmentStatusSchema>,
  wallet: string,
  common: CommerceWriteCommon,
  env: ProfileWriteEnv,
  dependencies: Pick<
    ProfileWriteDependencies,
    'createNotificationJobId' | 'error' | 'log' | 'warn'
  >,
): Promise<FulfillmentStatusResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  const mutation = await mutateDeliveryOrder({
    common,
    deliveryId: body.deliveryId,
    dropId,
    build: (document): { value: FulfillmentStatusMutation; updates: Record<string, CommerceUpdateValue> } => {
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
      const updates: Record<string, CommerceUpdateValue> = {
        dropId,
        fulfillmentUpdatedBy: wallet,
        fulfillmentStatus: nextStatus || commerceFieldValue.delete(),
        fulfillmentUpdatedAt: commerceFieldValue.serverTimestamp(),
      };
      if (nextStatus === 'Shipped') {
        updates.fulfillmentTrackingCode = nextTrackingCode || commerceFieldValue.delete();
      }
      if (decision.kind === 'send') {
        updates[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD] = BUYER_ORDER_SHIPPED_EMAIL_PENDING;
        updates[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD] = decision.jobId;
        updates[BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD] = decision.idempotencyKey;
        updates[BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD] = commerceFieldValue.delete();
        order[BUYER_ORDER_SHIPPED_EMAIL_STATE_FIELD] = BUYER_ORDER_SHIPPED_EMAIL_PENDING;
        order[BUYER_ORDER_SHIPPED_EMAIL_JOB_ID_FIELD] = decision.jobId;
        order[BUYER_ORDER_SHIPPED_EMAIL_IDEMPOTENCY_KEY_FIELD] = decision.idempotencyKey;
        delete order[BUYER_ORDER_SHIPPED_EMAIL_QUEUED_AT_FIELD];
      } else if (decision.clearPending) {
        for (const field of markerFieldPaths()) updates[field] = commerceFieldValue.delete();
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
        updates,
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

async function updateFulfillmentAddress(
  body: z.infer<typeof fulfillmentAddressSchema>,
  wallet: string,
  common: CommerceWriteCommon,
  addressSecret: string,
): Promise<UpdateFulfillmentAddressResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  if (!walletHasFulfillmentAddressAdminAccess(wallet, ADDRESS_ADMIN_WALLETS)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment address admin access denied.');
  }
  const encryptedAddress = encryptFulfillmentAddress(body.full, addressSecret);
  return mutateDeliveryOrder<UpdateFulfillmentAddressResponse>({
    common,
    dropId,
    deliveryId: body.deliveryId,
    build: ({ fields: order }) => {
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
        updates: {
          'addressSnapshot.encrypted': encryptedAddress.encrypted,
          'addressSnapshot.hint': encryptedAddress.hint,
          fulfillmentAddressUpdatedBy: wallet,
          fulfillmentAddressUpdatedAt: commerceFieldValue.serverTimestamp(),
          'shipstation.rateQuotes': commerceFieldValue.delete(),
          'shipstation.ratesClaimId': commerceFieldValue.delete(),
          'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
          'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
        },
      };
    },
  });
}

const profileWriteOperationDefinitions = [
  defineProfileWriteOperation({
    path: PROFILE_ADDRESSES_PATH,
    schema: saveAddressSchema,
    maxBytes: MAX_SAVE_ADDRESS_BYTES,
    timeoutMs: PROFILE_WRITE_TIMEOUT_MS,
    handler: (body, { wallet, common, env, dependencies }) => saveAddress(
      body,
      wallet,
      env.OPS_DB,
      dependencies.autoId,
      dependencies.nowMs(),
      common.signal,
      dependencies.saveProfileAddress,
    ),
  }),
  defineProfileWriteOperation({
    path: FULFILLMENT_ORDER_STATUS_PATH,
    schema: fulfillmentStatusSchema,
    maxBytes: MAX_STATUS_REQUEST_BYTES,
    timeoutMs: PROFILE_WRITE_TIMEOUT_MS,
    handler: (body, { wallet, common, env, dependencies }) => updateFulfillmentStatus(
      body, wallet, common, env, dependencies,
    ),
  }),
  defineProfileWriteOperation({
    path: FULFILLMENT_ORDER_ADDRESS_PATH,
    schema: fulfillmentAddressSchema,
    maxBytes: MAX_FULFILLMENT_ADDRESS_REQUEST_BYTES,
    timeoutMs: PROFILE_WRITE_TIMEOUT_MS,
    handler: (body, { wallet, common, env }) => updateFulfillmentAddress(
      body, wallet, common,
      typeof env.ADDRESS_DECRYPTION_SECRET === 'string' ? env.ADDRESS_DECRYPTION_SECRET : '',
    ),
  }),
  ...shipStationLabelOperations,
  ...shipStationRateOperations,
  ...shipStationShipmentOperations,
];

export type ProfileWritePath = (typeof profileWriteOperationDefinitions)[number]['path'];
const profileWriteOperations = new Map(profileWriteOperationDefinitions.map((operation) => [operation.path, operation]));
export const PROFILE_WRITE_PATHS = new Set<string>(profileWriteOperations.keys());

export async function handleProfileWriteRequest(
  request: Request,
  env: ProfileWriteEnv,
  path: ProfileWritePath,
  overrides: Partial<ProfileWriteDependencies> = {},
): Promise<ProfileWriteResult> {
  const route = profileWriteOperations.get(path)!;
  const dependencies = { ...defaultDependencies, timeoutMs: route.timeoutMs, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new ProfileReadError('invalid-argument', 405, 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response, metrics: { upstreamCalls: 0, providerDurationMs: 0 }, authOutcome: 'rejected' };
  }
  return withAuthenticatedRequest<ProfileWriteResult>(request, {
    opsDb: env.OPS_DB,
    timeoutMessage: 'Profile request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    let identity: RequestIdentity | undefined;
    try {
      const operation = await route.prepare(request, deadline.signal);
      identity = await authenticate();
      if (isStaffOnlyApiPath(path) && !isStaffRequestIdentity(identity)) {
        throw new ProfileReadError('unauthenticated', 401, 'Staff wallet authentication is required.');
      }
      const common = {
        nowMs: dependencies.nowMs(),
        pauseForRatePoll: dependencies.pauseForRatePoll,
        providerFetch: trackedFetch,
        repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
        requestSignal: request.signal,
        signal: deadline.signal,
      };
      const wallet = await raceReadWithSignal(resolveRequestWallet(identity, (uid) => loadSessionWallet({
        db: env.OPS_DB,
        resolveD1AuthWalletBinding: dependencies.resolveD1AuthWalletBinding,
        signal: deadline.signal,
        uid,
      })), deadline.signal);
      const payload = await runCriticalRequestOperation(() => Promise.resolve().then(() => {
        deadline.signal.throwIfAborted();
        return operation({ wallet, common, env, dependencies });
      }), {
        deadline,
        defer: dependencies.defer,
      });
      return { response: jsonResponse(payload, 200), metrics, authOutcome: 'accepted' };
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isRequestCancellationError(request, error)) throw error;
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
      } else if (error instanceof RequestIdentityError) {
        if (error.kind === 'invalid-token') {
          profileError = new ProfileReadError('unauthenticated', 401, 'Authentication is required.');
          authOutcome = 'rejected';
        } else if (error.kind === 'provider-timeout') {
          profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
        } else {
          profileError = new ProfileReadError('unavailable', 502, 'Authentication is temporarily unavailable.');
        }
      } else if (deadline.timedOut()) {
        profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
      } else {
        profileError = new ProfileReadError('internal', 500, 'Profile request failed.');
      }
      return { response: errorResponse(profileError), metrics, authOutcome };
    }
  });
}
