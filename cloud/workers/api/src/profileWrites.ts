import { setFulfillmentAddress } from './fulfillmentAddressStore.js';
import { z } from 'zod';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import {
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  walletHasFulfillmentAddressAdminAccess,
} from '../../../../shared/fulfillmentAccess.js';
import { FULFILLMENT_STATUS_OPTIONS } from '../../../../shared/fulfillmentStatus.js';
import {
  createProfileAddressId,
  PROFILE_ADDRESS_ID_PATTERN,
} from '../../../../shared/profileD1.js';
import type {
  ProfileAddress,
  UpdateFulfillmentAddressResponse,
} from '../../../../shared/contracts.js';
import {
  type RequestAuthContext,
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
import { classifyAuthenticatedRequestError, requestIdentityErrorDetails, withAuthenticatedRequest } from './authenticatedRequest.js';
import {
  ProfileReadError,
} from './dataAccess.js';
import {
  apiErrorBody,
  httpStatusForApiErrorCode,
  jsonResponse,
} from './httpResponse.js';
import { rethrowDeferredWorkRegistrationError } from './deferredWork.js';
import {
  D1CommerceRepository,
} from './commerceRepository.js';
import {
  type CommerceWriteCommon,
} from './profileWriteCommerce.js';
import { saveD1ProfileAddress } from './profileD1.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import {
  BUYER_ORDER_SHIPPED_EMAIL_QUEUED,
} from './buyerOrderShipped.js';
import { publishBuyerOrderShippedNotification } from './buyerOrderShippedOutbox.js';
import {
  setDeliveryOrderFulfillment,
  type DeliveryOrderFulfillmentResponse,
} from './deliveryOrderCommerce.js';
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

async function updateFulfillmentStatus(
  body: z.infer<typeof fulfillmentStatusSchema>,
  wallet: string,
  common: CommerceWriteCommon,
  env: ProfileWriteEnv,
  dependencies: Pick<
    ProfileWriteDependencies,
    'createNotificationJobId' | 'error' | 'log' | 'warn' | 'nowMs'
  >,
): Promise<DeliveryOrderFulfillmentResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  const mutation = await setDeliveryOrderFulfillment({
    common,
    createNotificationJobId: dependencies.createNotificationJobId,
    deliveryId: body.deliveryId,
    dropId,
    retryShippedEmail: body.retryShippedEmail,
    status: body.status,
    trackingCode: body.trackingCode,
    wallet,
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
  try {
    if (!env.NOTIFICATION_EMAIL_QUEUE) throw new Error('Notification email queue binding is unavailable');
    const queued = await publishBuyerOrderShippedNotification({
      repository: common.repository,
      parentPath: `drops/${dropId}/deliveryOrders/${body.deliveryId}`,
      queue: env.NOTIFICATION_EMAIL_QUEUE,
      signal: common.signal,
      nowMs: dependencies.nowMs,
    });
    if (queued) {
      dependencies.log({ event: 'buyer_order_shipped_notification_queued', ...jobContext, kind: 'buyer_order_shipped' });
      return { ...mutation.response, buyerOrderShippedEmailState: BUYER_ORDER_SHIPPED_EMAIL_QUEUED };
    }
  } catch (error) {
    dependencies.error({
      event: 'buyer_order_shipped_notification_enqueue_failed',
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
  return setFulfillmentAddress({
    common,
    dropId,
    deliveryId: body.deliveryId,
    full: body.full,
    ...encryptedAddress,
    wallet,
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
  authContext: RequestAuthContext = {},
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
    authContext,
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
      const { error: classified, authOutcome } = classifyAuthenticatedRequestError(error, {
        authenticated: Boolean(identity),
        timedOut: deadline.timedOut(),
        timeoutPrecedence: 'after-known-errors',
        timeoutMessage: 'Profile request timed out.',
        internalMessage: 'Profile request failed.',
        mapDomainError: (failure) => {
          if (failure instanceof ProfileReadError) {
            return {
              error: failure,
              authOutcome: failure instanceof ShipStationProfileError ? 'provider-failure'
                : ['unauthenticated', 'permission-denied', 'invalid-argument', 'not-found', 'aborted', 'failed-precondition'].includes(failure.code)
                  ? 'rejected' : identity ? 'provider-failure' : 'rejected',
            };
          }
          if (failure instanceof RequestIdentityError) {
            return {
              error: requestIdentityErrorDetails(failure, { code: 'deadline-exceeded', message: 'Profile request timed out.' }),
              authOutcome: failure.kind === 'invalid-token' ? 'rejected' : identity ? 'provider-failure' : 'rejected',
            };
          }
          return undefined;
        },
      });
      const profileError = classified instanceof ProfileReadError ? classified : new ProfileReadError(
        classified.code, httpStatusForApiErrorCode(classified.code, 502), classified.message, classified.details,
      );
      return { response: errorResponse(profileError), metrics, authOutcome };
    }
  });
}
