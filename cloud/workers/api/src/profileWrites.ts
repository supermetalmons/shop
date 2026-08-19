import { z } from 'zod';
import nacl from 'tweetnacl';
import { normalizeCountryCode } from '../../../../functions/src/shared/countryNormalization.js';
import { normalizeDropId } from '../../../../functions/src/shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../functions/src/shared/deploymentRegistry.js';
import {
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasFulfillmentAddressAdminAccess,
  walletHasFulfillmentDropAccess,
} from '../../../../functions/src/shared/fulfillmentAccess.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../functions/src/shared/fulfillmentSources.js';
import { FULFILLMENT_STATUS_OPTIONS } from '../../../../functions/src/shared/fulfillmentStatus.js';
import {
  normalizeOptionalFulfillmentTrackingCode,
  sanitizeFulfillmentTrackingCode,
} from '../../../../functions/src/shared/fulfillmentTracking.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  encryptAddressCipherText,
  serializeAddressCipherPayload,
} from '../../../../functions/src/shared/addressCipher.js';
import {
  getShipStationLabelById,
  isActiveShipStationLabel,
  listShipStationLabelsForShipment,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  storedFulfillmentShipStationLabel,
  ShipStationLabelProviderError,
  type ShipStationLabelResult,
} from '../../../../functions/src/shared/shipstationLabels.js';
import {
  buildShipStationPackages,
  getShipStationShipmentById,
  getShipStationShipmentRates,
  parseShipStationShipFrom,
  requestShipStationShipmentRates,
  shipStationPackageDetails,
  ShipStationRatesProviderError,
  updateShipStationShipment,
  type ShipStationRateResponse,
} from '../../../../functions/src/shared/shipstationRates.js';
import {
  normalizeShipStationPackage,
  parseShipStationPackage,
  SHIPSTATION_PACKAGE_RANGE_MESSAGE,
  type ShipStationPackageInput,
} from '../../../../functions/src/shared/shipstationPackage.js';
import { isBase58Bytes } from '../../../../functions/src/shared/solanaRpcProxy.js';
import type {
  FulfillmentOrderAddress,
  FulfillmentShipStationLabel,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesResponse,
  ProfileAddress,
  UpdateFulfillmentAddressResponse,
} from '../../../../functions/src/shared/contracts.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
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

export const PROFILE_ADDRESSES_PATH = '/profile/addresses';
export const FULFILLMENT_ORDER_STATUS_PATH = '/fulfillment/order-status';
export const FULFILLMENT_ORDER_ADDRESS_PATH = '/fulfillment/order-address';
export const FULFILLMENT_SHIPSTATION_LABEL_PATH = '/fulfillment/shipstation-label';
export const FULFILLMENT_SHIPSTATION_RATES_PATH = '/fulfillment/shipstation-rates';
export const PROFILE_WRITE_PATHS = new Set([
  PROFILE_ADDRESSES_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
  FULFILLMENT_SHIPSTATION_RATES_PATH,
]);

export type ProfileWritePath =
  | typeof PROFILE_ADDRESSES_PATH
  | typeof FULFILLMENT_ORDER_STATUS_PATH
  | typeof FULFILLMENT_ORDER_ADDRESS_PATH
  | typeof FULFILLMENT_SHIPSTATION_LABEL_PATH
  | typeof FULFILLMENT_SHIPSTATION_RATES_PATH;

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
  pauseForRatePoll: (signal: AbortSignal, delayMs: number) => Promise<void>;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdToken: (
    authorization: string | null,
    providerFetch: ProfileProviderFetch,
    signal: AbortSignal,
    nowMs?: number,
  ) => Promise<FirebaseIdentity>;
};

type ProfileWriteEnv = Pick<Env, 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'> & Partial<Pick<Env,
  'ADDRESS_DECRYPTION_SECRET' | 'SHIPSTATION_API_KEY' | 'SHIPSTATION_SHIP_FROM'
>>;

const PROFILE_WRITE_TIMEOUT_MS = 15_000;
const SHIPSTATION_LABEL_OPERATION_TIMEOUT_MS = 45_000;
const SHIPSTATION_RATES_OPERATION_TIMEOUT_MS = 55_000;
const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
const MAX_STATUS_REQUEST_BYTES = 4096;
const MAX_FULFILLMENT_ADDRESS_REQUEST_BYTES = 16 * 1024;
const MAX_SHIPSTATION_LABEL_REQUEST_BYTES = 2048;
const MAX_SHIPSTATION_RATES_REQUEST_BYTES = 2048;
const SHIPSTATION_CLAIM_TTL_MS = 120_000;
const SHIPSTATION_RATE_REQUEST_TTL_MS = 10 * 60_000;
const FIRESTORE_MUTATION_ATTEMPTS = 3;
const AUTO_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const AUTO_ID_LENGTH = 20;
const AUTO_ID_RANDOM_LIMIT = 248;
const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
const ADDRESS_ADMIN_WALLETS = new Set(FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES);
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

const fulfillmentAddressSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full: z.string().trim().min(1).max(2048),
}).strict();

const shipStationLabelSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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

const defaultAccessTokenProvider = createGoogleAccessTokenProvider();

class ShipStationProfileError extends ProfileReadError {}

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
  pauseForRatePoll,
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
): Promise<
  | z.infer<typeof saveAddressSchema>
  | z.infer<typeof fulfillmentStatusSchema>
  | z.infer<typeof fulfillmentAddressSchema>
  | z.infer<typeof shipStationLabelSchema>
  | z.infer<typeof shipStationRatesSchema>
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
        : path === FULFILLMENT_SHIPSTATION_RATES_PATH
          ? MAX_SHIPSTATION_RATES_REQUEST_BYTES
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
        : shipStationRatesSchema.safeParse(parsed);
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
  deliveryId: number;
  dropId: string;
  expectedCurrentLabel?: FulfillmentShipStationLabel | null;
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
      if (shouldClearShipStationPurchaseState(label)) updateMask.push('shipstation.labelPurchase');
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
  if (error.code === 'deadline-exceeded') return new ShipStationProfileError(error.code, 504, error.message);
  if (error.code === 'resource-exhausted') return new ShipStationProfileError(error.code, 429, error.message);
  if (error.code === 'failed-precondition') return new ShipStationProfileError(error.code, 409, error.message);
  if (error.code === 'internal') return new ShipStationProfileError('unavailable', 502, error.message);
  return new ShipStationProfileError(error.code, 502, error.message);
}

type ReconciledShipStationLabel = {
  active?: FulfillmentShipStationLabel;
  downloadUrl?: string;
  inactive?: FulfillmentShipStationLabel;
};

async function reconcileFulfillmentShipStationLabel(args: {
  apiKey: string;
  common: FirestoreWriteCommon;
  deliveryId: number;
  dropId: string;
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
      const label = await persistFulfillmentShipStationLabel({
        common: args.common,
        deliveryId: args.deliveryId,
        dropId: args.dropId,
        expectedCurrentLabel: storedLabel,
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
    const adopted = (await listShipStationLabelsForShipment(args.apiKey, args.shipmentId, {
      fetch: args.common.providerFetch,
      signal: args.common.signal,
    }))[0];
    if (adopted) {
      const label = await persistFulfillmentShipStationLabel({
        common: args.common,
        deliveryId: args.deliveryId,
        dropId: args.dropId,
        expectedCurrentLabel: inactive ?? storedLabel ?? null,
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

type PendingShipStationRateRequest = {
  requestId: string;
  createdAt?: string;
};

function storedPendingShipStationRateRequest(
  value: unknown,
  shipmentId: string,
  parcel: ShipStationPackageInput,
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
    const resolvedPackage = packageOverride ?? currentPackageDetails.package;
    if (!resolvedPackage) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'ShipStation package measurements are unavailable for this shipment.',
      );
    }
    const updatedShipment = await updateShipStationShipment(apiKey, shipmentId, {
      ship_from: shipFrom,
      ...(packageOverride ? { packages: buildShipStationPackages(1, packageOverride) } : {}),
    }, { fetch: common.providerFetch, signal: common.signal });
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
    const pendingRateRequest = storedPendingShipStationRateRequest(
      shipStationState(claimedOrder).rateRequest,
      shipmentId,
      storedPackage,
      common.nowMs,
    );
    const rateResponse = await getCompletedShipStationRates({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      expected: claimedExpectation,
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
    ...(path === FULFILLMENT_SHIPSTATION_RATES_PATH ? { timeoutMs: SHIPSTATION_RATES_OPERATION_TIMEOUT_MS } : {}),
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
      pauseForRatePoll: dependencies.pauseForRatePoll,
      providerFetch: trackedFetch,
      serviceAccountJson,
      signal: controller.signal,
    };
    const wallet = await loadSessionWallet({ ...common, uid: identity.uid });
    let payload: unknown;
    if (path === PROFILE_ADDRESSES_PATH) {
      payload = await saveAddress(
        requestBody as z.infer<typeof saveAddressSchema>,
        wallet,
        common,
        dependencies.autoId,
      );
    } else if (path === FULFILLMENT_ORDER_STATUS_PATH) {
      payload = await updateFulfillmentStatus(
        requestBody as z.infer<typeof fulfillmentStatusSchema>,
        wallet,
        common,
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
    } else {
      payload = await getFulfillmentShipStationRates(
        requestBody as z.infer<typeof shipStationRatesSchema>,
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
  firestoreAutoId,
};
