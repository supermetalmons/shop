import { z } from 'zod';
import { normalizeCountryCode } from '../../../../functions/src/shared/countryNormalization.js';
import { normalizeDropId } from '../../../../functions/src/shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../functions/src/shared/deploymentRegistry.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasFulfillmentDropAccess,
} from '../../../../functions/src/shared/fulfillmentAccess.js';
import { FULFILLMENT_STATUS_OPTIONS } from '../../../../functions/src/shared/fulfillmentStatus.js';
import {
  normalizeOptionalFulfillmentTrackingCode,
  sanitizeFulfillmentTrackingCode,
} from '../../../../functions/src/shared/fulfillmentTracking.js';
import { isBase58Bytes } from '../../../../functions/src/shared/solanaRpcProxy.js';
import type { ProfileAddress } from '../../../../functions/src/shared/contracts.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  ProfileReadError,
  authenticatedFirestoreRequest,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  isRecord,
  readBoundedText,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export const PROFILE_ADDRESSES_PATH = '/profile/addresses';
export const FULFILLMENT_ORDER_STATUS_PATH = '/fulfillment/order-status';
export const PROFILE_WRITE_PATHS = new Set([
  PROFILE_ADDRESSES_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
]);

export type ProfileWritePath =
  | typeof PROFILE_ADDRESSES_PATH
  | typeof FULFILLMENT_ORDER_STATUS_PATH;

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

type ProfileWriteEnv = Pick<Env, 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'>;

const PROFILE_WRITE_TIMEOUT_MS = 15_000;
const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
const MAX_STATUS_REQUEST_BYTES = 4096;
const AUTO_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const AUTO_ID_LENGTH = 20;
const AUTO_ID_RANDOM_LIMIT = 248;
const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
const SHIPPER_DROP_IDS_BY_WALLET = new Map(
  SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
);

const saveAddressSchema = z.object({
  encrypted: z.string().max(4096),
  country: z.string().max(64),
  countryCode: z.string().max(32).optional(),
  hint: z.string().max(256),
  email: z.string().email().max(254).optional(),
}).strict();

const fulfillmentStatusSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.union([z.enum(FULFILLMENT_STATUS_OPTIONS), z.literal(''), z.null()]),
  trackingCode: z.string().optional(),
}).strict();

const defaultAccessTokenProvider = createGoogleAccessTokenProvider();

function firestoreAutoId(): string {
  let id = '';
  while (id.length < AUTO_ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(AUTO_ID_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= AUTO_ID_RANDOM_LIMIT) continue;
      id += AUTO_ID_ALPHABET[byte % AUTO_ID_ALPHABET.length];
      if (id.length === AUTO_ID_LENGTH) break;
    }
  }
  return id;
}

const defaultDependencies: ProfileWriteDependencies = {
  accessTokenProvider: defaultAccessTokenProvider,
  autoId: firestoreAutoId,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: PROFILE_WRITE_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
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
  return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, error.status);
}

async function parseExactRequestBody(
  request: Request,
  path: ProfileWritePath,
  signal: AbortSignal,
): Promise<z.infer<typeof saveAddressSchema> | z.infer<typeof fulfillmentStatusSchema>> {
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const maxBytes = path === PROFILE_ADDRESSES_PATH ? MAX_SAVE_ADDRESS_BYTES : MAX_STATUS_REQUEST_BYTES;
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
    : fulfillmentStatusSchema.safeParse(parsed);
  if (!result.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  return result.data;
}

function optionalSessionWallet(value: unknown, uid: string): string | null {
  if (value === null) return isBase58Bytes(uid, 32) ? uid : null;
  if (!isRecord(value)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  const fields = decodeFirestoreFields(value.fields);
  const wallet = fields?.wallet;
  if (typeof wallet !== 'string' || !isBase58Bytes(wallet, 32)) {
    throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  }
  return wallet;
}

async function loadSessionWallet(args: {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
  uid: string;
}): Promise<string> {
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/authSessions/${encodeURIComponent(args.uid)}`);
  url.searchParams.append('mask.fieldPaths', 'wallet');
  const document = await authenticatedFirestoreRequest({
    ...args,
    method: 'GET',
    url: url.toString(),
  });
  const wallet = optionalSessionWallet(document, args.uid);
  if (!wallet) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  return wallet;
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
): Promise<void> {
  await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify({ writes }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
  });
}

async function saveAddress(
  body: z.infer<typeof saveAddressSchema>,
  wallet: string,
  common: {
    accessTokenProvider: GoogleAccessTokenProvider;
    nowMs: number;
    providerFetch: ProfileProviderFetch;
    serviceAccountJson: string;
    signal: AbortSignal;
  },
  autoId: () => string,
): Promise<ProfileAddress> {
  const id = autoId();
  if (!/^[A-Za-z0-9]{20}$/.test(id)) throw new ProfileReadError('internal', 500, 'Profile request failed.');
  const normalizedCountryCode = normalizeCountryCode(body.countryCode || body.country);
  const countryCode = normalizedCountryCode || body.countryCode;
  const addressFields: Record<string, unknown> = {
    encrypted: firestoreString(body.encrypted),
    country: firestoreString(body.country),
    hint: firestoreString(body.hint),
    id: firestoreString(id),
    ...(countryCode ? { countryCode: firestoreString(countryCode) } : {}),
    ...(body.email ? { email: firestoreString(body.email) } : {}),
  };
  const profileFields: Record<string, unknown> = {
    wallet: firestoreString(wallet),
    ...(body.email ? { email: firestoreString(body.email) } : {}),
  };
  await commitWrites(common, [
    {
      update: {
        name: documentName(`profiles/${wallet}/addresses/${id}`),
        fields: addressFields,
      },
      updateMask: { fieldPaths: Object.keys(addressFields) },
      updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
    },
    {
      update: {
        name: documentName(`profiles/${wallet}`),
        fields: profileFields,
      },
      updateMask: { fieldPaths: Object.keys(profileFields) },
    },
  ]);
  return {
    id,
    country: body.country,
    ...(countryCode ? { countryCode } : {}),
    encrypted: body.encrypted,
    hint: body.hint,
    ...(body.email ? { email: body.email } : {}),
  };
}

async function updateFulfillmentStatus(
  body: z.infer<typeof fulfillmentStatusSchema>,
  wallet: string,
  common: {
    accessTokenProvider: GoogleAccessTokenProvider;
    nowMs: number;
    providerFetch: ProfileProviderFetch;
    serviceAccountJson: string;
    signal: AbortSignal;
  },
): Promise<{
  deliveryId: number;
  fulfillmentStatus: (typeof FULFILLMENT_STATUS_OPTIONS)[number] | '';
  fulfillmentTrackingCode?: string;
}> {
  const dropId = supportedDropId(body.dropId);
  if (!walletHasFulfillmentDropAccess(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment access denied.');
  }
  const orderPath = `drops/${dropId}/deliveryOrders/${body.deliveryId}`;
  const orderUrl = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${orderPath}`);
  orderUrl.searchParams.append('mask.fieldPaths', 'fulfillmentTrackingCode');
  const orderDocument = await authenticatedFirestoreRequest({
    ...common,
    method: 'GET',
    url: orderUrl.toString(),
  });
  if (orderDocument === null) throw new ProfileReadError('not-found', 404, 'Delivery order not found.');
  if (!isRecord(orderDocument)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  const orderFields = orderDocument.fields === undefined ? {} : decodeFirestoreFields(orderDocument.fields);
  if (!orderFields) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  const nextStatus = body.status || '';
  let nextTrackingCode = normalizeOptionalFulfillmentTrackingCode(orderFields.fulfillmentTrackingCode);
  const updateFields: Record<string, unknown> = {
    dropId: firestoreString(dropId),
    fulfillmentUpdatedBy: firestoreString(wallet),
    ...(nextStatus ? { fulfillmentStatus: firestoreString(nextStatus) } : {}),
  };
  const updateMask = ['dropId', 'fulfillmentUpdatedBy', 'fulfillmentStatus'];
  if (nextStatus === 'Shipped') {
    nextTrackingCode = sanitizeFulfillmentTrackingCode(body.trackingCode);
    updateMask.push('fulfillmentTrackingCode');
    if (nextTrackingCode) updateFields.fulfillmentTrackingCode = firestoreString(nextTrackingCode);
  }
  await commitWrites(common, [{
    update: {
      name: documentName(orderPath),
      fields: updateFields,
    },
    updateMask: { fieldPaths: updateMask },
    updateTransforms: [{ fieldPath: 'fulfillmentUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { exists: true },
  }]);
  return {
    deliveryId: body.deliveryId,
    fulfillmentStatus: nextStatus,
    ...(nextTrackingCode ? { fulfillmentTrackingCode: nextTrackingCode } : {}),
  };
}

export async function handleProfileWriteRequest(
  request: Request,
  env: ProfileWriteEnv,
  path: ProfileWritePath,
  overrides: Partial<ProfileWriteDependencies> = {},
): Promise<ProfileWriteResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
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
  let identity: FirebaseIdentity | undefined;
  try {
    const requestBody = await parseExactRequestBody(request, path, controller.signal);
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    const serviceAccountJson = typeof env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON === 'string'
      ? env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON
      : '';
    if (!serviceAccountJson) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
    const common = {
      accessTokenProvider: dependencies.accessTokenProvider,
      nowMs: dependencies.nowMs(),
      providerFetch: trackedFetch,
      serviceAccountJson,
      signal: controller.signal,
    };
    const wallet = await loadSessionWallet({ ...common, uid: identity.uid });
    const payload = path === PROFILE_ADDRESSES_PATH
      ? await saveAddress(requestBody as z.infer<typeof saveAddressSchema>, wallet, common, dependencies.autoId)
      : await updateFulfillmentStatus(requestBody as z.infer<typeof fulfillmentStatusSchema>, wallet, common);
    return { response: jsonResponse(payload, 200), metrics, authOutcome: 'accepted' };
  } catch (error) {
    let profileError: ProfileReadError;
    let authOutcome: ProfileWriteResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (error instanceof ProfileReadError) {
      profileError = error;
      if (error.code === 'unauthenticated' || error.code === 'permission-denied' || error.code === 'invalid-argument' || error.code === 'not-found') {
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
  firestoreAutoId,
};
