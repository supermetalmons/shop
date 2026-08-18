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
import { isBase58Bytes } from '../../../../functions/src/shared/solanaRpcProxy.js';
import type {
  FulfillmentOrderAddress,
  FulfillmentShipStationLabel,
  GetFulfillmentShipStationLabelResponse,
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
export const PROFILE_WRITE_PATHS = new Set([
  PROFILE_ADDRESSES_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
]);

export type ProfileWritePath =
  | typeof PROFILE_ADDRESSES_PATH
  | typeof FULFILLMENT_ORDER_STATUS_PATH
  | typeof FULFILLMENT_ORDER_ADDRESS_PATH
  | typeof FULFILLMENT_SHIPSTATION_LABEL_PATH;

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

type ProfileWriteEnv = Pick<Env, 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'> & Partial<Pick<Env,
  'ADDRESS_DECRYPTION_SECRET' | 'SHIPSTATION_API_KEY'
>>;

const PROFILE_WRITE_TIMEOUT_MS = 15_000;
const SHIPSTATION_LABEL_OPERATION_TIMEOUT_MS = 45_000;
const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
const MAX_STATUS_REQUEST_BYTES = 4096;
const MAX_FULFILLMENT_ADDRESS_REQUEST_BYTES = 16 * 1024;
const MAX_SHIPSTATION_LABEL_REQUEST_BYTES = 2048;
const SHIPSTATION_CLAIM_TTL_MS = 120_000;
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
        : shipStationLabelSchema.safeParse(parsed);
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
  expectedCurrentLabelId?: string | null;
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
      if (optionalString(shipstation.shipmentId) !== label.shipmentId) {
        throw new ProfileReadError(
          'aborted',
          409,
          'The ShipStation shipment changed. Refresh the order and try again.',
        );
      }
      const currentLabel = storedFulfillmentShipStationLabel(shipstation.label);
      const currentLabelId = currentLabel?.labelId ?? null;
      if (
        args.expectedCurrentLabelId !== undefined
        && currentLabelId !== args.expectedCurrentLabelId
        && currentLabelId !== label.labelId
      ) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
      }
      if (args.fallbackLabel?.labelId && currentLabel?.labelId !== args.fallbackLabel.labelId) {
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
        'shipstation.ratesClaimedAt',
        'shipstation.ratesClaimedBy',
      ];
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

function profileErrorForShipStation(error: ShipStationLabelProviderError): ProfileReadError {
  if (error.code === 'deadline-exceeded') return new ShipStationProfileError(error.code, 504, error.message);
  if (error.code === 'resource-exhausted') return new ShipStationProfileError(error.code, 429, error.message);
  if (error.code === 'failed-precondition') return new ShipStationProfileError(error.code, 409, error.message);
  if (error.code === 'internal') return new ShipStationProfileError(error.code, 500, error.message);
  return new ShipStationProfileError(error.code, 502, error.message);
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
  const storedLabel = storedFulfillmentShipStationLabel(shipStationState(order).label);
  let inactiveLabel: FulfillmentShipStationLabel | undefined;
  try {
    if (storedLabel?.labelId) {
      const result = await getShipStationLabelById(apiKey, storedLabel.labelId, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      const label = await persistFulfillmentShipStationLabel({
        common,
        deliveryId: body.deliveryId,
        dropId,
        fallbackLabel: storedLabel,
        result,
        wallet,
      });
      if (isActiveShipStationLabel(label)) {
        return {
          deliveryId: body.deliveryId,
          shipmentId,
          label,
          ...(result.downloadUrl ? { labelDownloadUrl: result.downloadUrl } : {}),
        };
      }
      inactiveLabel = label;
    }
    const adopted = (await listShipStationLabelsForShipment(apiKey, shipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    }))[0];
    if (adopted) {
      const label = await persistFulfillmentShipStationLabel({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expectedCurrentLabelId: inactiveLabel?.labelId ?? null,
        result: adopted,
        wallet,
      });
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        label,
        ...(adopted.downloadUrl ? { labelDownloadUrl: adopted.downloadUrl } : {}),
      };
    }
  } catch (error) {
    if (error instanceof ShipStationLabelProviderError) throw profileErrorForShipStation(error);
    throw error;
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
    ...(resolvedPurchase.label ? { label: resolvedPurchase.label } : inactiveLabel ? { label: inactiveLabel } : {}),
    ...(resolvedPurchase.purchaseUnknown ? { purchaseUnknown: true } : {}),
  };
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
    } else {
      const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
      payload = await getFulfillmentShipStationLabel(
        requestBody as z.infer<typeof shipStationLabelSchema>,
        wallet,
        common,
        apiKey,
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
