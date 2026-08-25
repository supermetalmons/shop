import { onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import { auth } from './firebase';
import {
  AddFulfillmentOrderToShipStationRequest,
  AddFulfillmentOrderToShipStationResponse,
  AdminIrlRedeemFinalizeResult,
  AdminIrlRedeemPreparedTxResponse,
  DeliveryOrderSummary,
  DeliverySelection,
  FulfillmentManualReviewCheckout,
  FulfillmentShipStationAddressCorrectionDetails,
  FulfillmentStatus,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  GetAdminProfileViewRequest,
  GetAdminProfileViewResponse,
  GetProfileStateResponse,
  GetFulfillmentShipStationLabelRequest,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesRequest,
  GetFulfillmentShipStationRatesResponse,
  IssueReceiptsResult,
  PackStatusBreakdown,
  PackStatusDisplayLabels,
  PrepareDeliveryRequest,
  PrepareDeliveryResponse,
  PrepareIrlClaimRequest,
  PrepareIrlClaimResponse,
  PrepareReceiptTransferRequest,
  PrepareReceiptTransferResponse,
  PreparedTxResponse,
  Profile,
  ProfileAddress,
  SaveProfileAddressRequest,
  ProfileStateProfile,
  ProfileStateSection,
  PurchaseFulfillmentShipStationLabelRequest,
  PurchaseFulfillmentShipStationLabelResponse,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
  RevealDudesResponse,
  RevealDudesSubmissionUnknownDetails,
  SHIPSTATION_EDITABLE_ADDRESS_FIELDS,
  ShipStationAddressPatch,
  ShipStationEditableAddressField,
  ShipStationPackageInput,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
  StripeReceiptClaimResult,
  UpdateFulfillmentAddressRequest,
  UpdateFulfillmentAddressResponse,
  VoidFulfillmentShipStationLabelRequest,
  VoidFulfillmentShipStationLabelResponse,
} from '../types';
import { dropAssetLabel } from './dropLabels';
import {
  FRONTEND_DROPS,
  normalizeDropId,
  type FrontendDeploymentConfig,
} from '../config/deployment';
import {
  isPackStatusSupportedDropId,
  normalizePackStatusAmount,
} from '../../shared/packStatus.ts';
import { summarizePayloadShape } from '../../shared/logSummaries.ts';
import { parseDeliveryOrderSummary } from '../../shared/deliveryOrderSummary.ts';
import { parseShipStationPackage } from '../../shared/shipstationPackage.ts';
import { isStripeReceiptClaimCode } from '../../shared/stripeReceiptClaims.ts';
import {
  isBase58Bytes,
  isNonZeroBase58Bytes,
} from '../../shared/solanaRpcProxy.ts';
import { createProfileAddressId } from '../../shared/profileD1.ts';
import { fetchPackStatus } from './shopApi';
import { monsApiOrigin } from './monsApiOrigin';
import { ensureStaffWalletSession } from './staffWalletSession';

export type {
  PrepareDeliveryRequest,
  PrepareDeliveryResponse,
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
  RevealDudesResponse,
  RevealDudesSubmissionUnknownDetails,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
} from '../types';

let authReadyPromise: Promise<string> | null = null;
let authStateReadyPromise: Promise<void> | null = null;

async function waitForAuthStateReady(localAuth: Auth): Promise<void> {
  // If a user is already present, we’re ready.
  if (localAuth.currentUser) return;
  if (!authStateReadyPromise) {
    authStateReadyPromise = new Promise<void>((resolve) => {
      const unsubscribe = onAuthStateChanged(localAuth, () => {
        unsubscribe();
        resolve();
      });
    }).finally(() => {
      authStateReadyPromise = null;
    });
  }
  return authStateReadyPromise;
}

export async function ensureAuthenticated(): Promise<string> {
  const staffSession = await ensureStaffWalletSession();
  if (staffSession) return staffSession.wallet;
  const localAuth = auth;
  if (!localAuth) throw new Error('Firebase client is not configured');

  // IMPORTANT: On page load, Firebase restores persisted auth asynchronously.
  // If we call signInAnonymously() before that completes, we can create a *new* anon user each reload,
  // which breaks our wallet-session mapping and makes users re-sign with Solana unnecessarily.
  await waitForAuthStateReady(localAuth);
  const user = localAuth.currentUser;
  if (user) return user.uid;

  if (!authReadyPromise) {
    authReadyPromise = signInAnonymously(localAuth)
      .then((credential) => credential.user.uid)
      .finally(() => {
        authReadyPromise = null;
      });
  }
  return authReadyPromise;
}

const DEBUG_API =
  import.meta.env?.DEV ||
  (typeof window !== 'undefined' && window.localStorage?.getItem('monsDebugApi') === '1');

function summarizeError(err: unknown) {
  const anyErr = err as any;
  if (anyErr && typeof anyErr === 'object') {
    return {
      name: anyErr.name,
      code: anyErr.code,
      message: anyErr.message,
      details: anyErr.details,
      stack: anyErr.stack,
    };
  }
  return { message: String(err) };
}

function makeCallId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type ProfileApiErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

class ProfileApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(payload: ProfileApiErrorPayload) {
    super(payload.message);
    this.name = 'ProfileApiError';
    this.code = payload.code;
    this.details = payload.details;
  }
}

function profileApiErrorPayload(value: unknown, status: number): ProfileApiErrorPayload {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code;
      const message = (error as Record<string, unknown>).message;
      const details = (error as Record<string, unknown>).details;
      if (typeof code === 'string' && code && typeof message === 'string' && message) {
        return { code, message, ...(details === undefined ? {} : { details }) };
      }
    }
  }
  return { code: status >= 500 ? 'unavailable' : `http-${status}`, message: 'Profile API request failed.' };
}

function parseFulfillmentShipStationAddressCorrectionDetails(
  value: unknown,
): FulfillmentShipStationAddressCorrectionDetails | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'fields'])) return null;
  if (value.kind !== 'shipstation-address-correction' || !Array.isArray(value.fields) || !value.fields.length) {
    return null;
  }
  const supported = new Set<string>(SHIPSTATION_EDITABLE_ADDRESS_FIELDS);
  if (!value.fields.every((field) => typeof field === 'string' && supported.has(field))) return null;
  const fields = value.fields as ShipStationEditableAddressField[];
  if (new Set(fields).size !== fields.length) return null;
  const canonical = SHIPSTATION_EDITABLE_ADDRESS_FIELDS.filter((field) => fields.includes(field));
  if (canonical.some((field, index) => fields[index] !== field)) return null;
  return { kind: 'shipstation-address-correction', fields: [...fields] };
}

export function fulfillmentShipStationAddressCorrectionDetails(
  error: unknown,
): FulfillmentShipStationAddressCorrectionDetails | null {
  if (!(error instanceof ProfileApiError) || error.code !== 'failed-precondition') return null;
  return parseFulfillmentShipStationAddressCorrectionDetails(error.details);
}

type AuthenticatedUserCredential = {
  authSubject: string;
  token: string;
};

async function authenticatedUserCredential(forceRefresh: boolean): Promise<AuthenticatedUserCredential> {
  const staffSession = await ensureStaffWalletSession(forceRefresh);
  if (staffSession) return { authSubject: staffSession.wallet, token: staffSession.token };
  const uid = await ensureAuthenticated();
  const user = auth?.currentUser;
  if (!user || user.uid !== uid) throw new ProfileApiError({ code: 'unauthenticated', message: 'Authentication is required.' });
  return { authSubject: uid, token: await user.getIdToken(forceRefresh) };
}

export async function authenticatedUserToken(forceRefresh: boolean): Promise<string> {
  return (await authenticatedUserCredential(forceRefresh)).token;
}

type ProfileApiClientDependencies = {
  fetch: typeof fetch;
  getToken: (forceRefresh: boolean) => Promise<string | AuthenticatedUserCredential>;
  origin: () => string;
  timeoutMs: number;
};

type AuthenticatedApiPath =
  | '/auth/solana'
  | '/admin/irl-redeem/finalize'
  | '/admin/irl-redeem/prepare'
  | '/boxes/reveal'
  | '/checkout/session'
  | '/claims/irl/prepare'
  | '/receipts/stripe/claim'
  | '/delivery/prepare'
  | '/delivery/receipts/issue'
  | '/delivery/receipts/recover'
  | '/receipts/transfer/prepare'
  | '/profile/reconcile'
  | '/profile/state'
  | '/profile/shipments'
  | '/profile/anonymous-stripe-delivery-history'
  | '/profile/addresses'
  | '/admin/profile'
  | '/admin/delivery-order-owners'
  | '/fulfillment/orders'
  | '/fulfillment/order-address'
  | '/fulfillment/order-status'
  | '/fulfillment/manual-review-checkouts'
  | '/fulfillment/shipstation-label'
  | '/fulfillment/shipstation-label-purchase'
  | '/fulfillment/shipstation-label-void'
  | '/fulfillment/shipstation-rates'
  | '/fulfillment/shipstation-shipment';

const defaultProfileApiDependencies: ProfileApiClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  getToken: authenticatedUserCredential,
  origin: monsApiOrigin,
  timeoutMs: 20_000,
};

const STRIPE_CHECKOUT_SESSION_API_TIMEOUT_MS = 35_000;
const PROFILE_RECONCILE_API_TIMEOUT_MS = 65_000;
const IRL_CLAIM_PREPARE_API_TIMEOUT_MS = 65_000;
const ADMIN_IRL_REDEEM_PREPARE_API_TIMEOUT_MS = 65_000;
const ADMIN_IRL_REDEEM_FINALIZE_API_TIMEOUT_MS = 550_000;
const REVEAL_DUDES_API_TIMEOUT_MS = 65_000;
const DELIVERY_PREPARE_API_TIMEOUT_MS = 65_000;
const DELIVERY_RECEIPTS_API_TIMEOUT_MS = 65_000;
const RECEIPT_TRANSFER_PREPARE_API_TIMEOUT_MS = 65_000;
const STRIPE_RECEIPT_CLAIM_API_TIMEOUT_MS = 190_000;
const PROFILE_D1_WRITE_API_TIMEOUT_MS = 80_000;
const SHIPSTATION_LABEL_API_TIMEOUT_MS = 50_000;
const SHIPSTATION_LABEL_PURCHASE_API_TIMEOUT_MS = 65_000;
const SHIPSTATION_LABEL_VOID_API_TIMEOUT_MS = 65_000;
const SHIPSTATION_RATES_API_TIMEOUT_MS = 65_000;
const SHIPSTATION_SHIPMENT_API_TIMEOUT_MS = 65_000;

function profileApiTimeoutMs(pathname: AuthenticatedApiPath): number {
  if (pathname === '/auth/solana' || pathname === '/profile/addresses') return PROFILE_D1_WRITE_API_TIMEOUT_MS;
  if (pathname === '/profile/reconcile') return PROFILE_RECONCILE_API_TIMEOUT_MS;
  if (pathname === '/claims/irl/prepare') return IRL_CLAIM_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/admin/irl-redeem/prepare') return ADMIN_IRL_REDEEM_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/admin/irl-redeem/finalize') return ADMIN_IRL_REDEEM_FINALIZE_API_TIMEOUT_MS;
  if (pathname === '/boxes/reveal') return REVEAL_DUDES_API_TIMEOUT_MS;
  if (pathname === '/delivery/prepare') return DELIVERY_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/delivery/receipts/issue' || pathname === '/delivery/receipts/recover') {
    return DELIVERY_RECEIPTS_API_TIMEOUT_MS;
  }
  if (pathname === '/receipts/transfer/prepare') return RECEIPT_TRANSFER_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/receipts/stripe/claim') return STRIPE_RECEIPT_CLAIM_API_TIMEOUT_MS;
  if (pathname === '/checkout/session') return STRIPE_CHECKOUT_SESSION_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-label') return SHIPSTATION_LABEL_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-label-purchase') return SHIPSTATION_LABEL_PURCHASE_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-label-void') return SHIPSTATION_LABEL_VOID_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-rates') return SHIPSTATION_RATES_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-shipment') return SHIPSTATION_SHIPMENT_API_TIMEOUT_MS;
  return defaultProfileApiDependencies.timeoutMs;
}

function profileApiDeadlineError(): ProfileApiError {
  return new ProfileApiError({ code: 'deadline-exceeded', message: 'Profile API request timed out.' });
}

async function waitForProfileApiValue<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function requestProfileApi<Req>(
  pathname: AuthenticatedApiPath,
  data: Req,
  dependencies: ProfileApiClientDependencies,
  credentialCapture?: { authSubject?: string },
): Promise<unknown> {
  const startedAt = Date.now();
  const callId = DEBUG_API ? makeCallId() : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const credential = await waitForProfileApiValue(dependencies.getToken(attempt > 0), controller.signal);
        const token = typeof credential === 'string' ? credential : credential.token;
        if (typeof credential !== 'string' && credentialCapture) {
          credentialCapture.authSubject = credential.authSubject;
        }
        if (DEBUG_API) {
          console.info(`[mons/api] → ${pathname}`, { callId, payload: summarizePayloadShape(data) });
        }
        const response = await dependencies.fetch(`${dependencies.origin()}${pathname}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
          cache: 'no-store',
          signal: controller.signal,
        });
        let payload: unknown;
        try {
          payload = await waitForProfileApiValue(response.json(), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new ProfileApiError({ code: 'unavailable', message: 'Profile API returned malformed JSON.', details: error });
        }
        if (response.status === 401 && attempt === 0) continue;
        if (!response.ok) throw new ProfileApiError(profileApiErrorPayload(payload, response.status));
        if (DEBUG_API) {
          console.info(`[mons/api] ← ${pathname}`, {
            callId,
            ms: Date.now() - startedAt,
            data: summarizePayloadShape(payload),
          });
        }
        return payload;
      } catch (error) {
        const normalizedError = controller.signal.aborted ? profileApiDeadlineError() : error;
        if (attempt === 0 && normalizedError instanceof ProfileApiError && normalizedError.code === 'unauthenticated') {
          continue;
        }
        console.error(`[mons/api] ✖ ${pathname}`, {
          ...(callId ? { callId } : {}),
          ms: Date.now() - startedAt,
          error: summarizeError(normalizedError),
        });
        throw normalizedError;
      }
    }
    throw new ProfileApiError({ code: 'unauthenticated', message: 'Authentication is required.' });
  } finally {
    clearTimeout(timeout);
  }
}

async function callProfileApi<Req>(
  pathname: AuthenticatedApiPath,
  data: Req,
  credentialCapture?: { authSubject?: string },
): Promise<unknown> {
  return requestProfileApi(pathname, data, {
    ...defaultProfileApiDependencies,
    timeoutMs: profileApiTimeoutMs(pathname),
  }, credentialCapture);
}

function profileOrders(value: unknown): DeliveryOrderSummary[] | null {
  if (!Array.isArray(value)) return null;
  const orders = value.map(parseDeliveryOrderSummary);
  return orders.every((order): order is DeliveryOrderSummary => order !== null) ? orders : null;
}

function exactProfileOrders(value: unknown): DeliveryOrderSummary[] | null {
  if (!Array.isArray(value)) return null;
  const required = ['dropId', 'deliveryId', 'status', 'items'] as const;
  const optional = [
    'stripeCheckoutSessionId',
    'createdAt',
    'processingAt',
    'processedAt',
    'fulfillmentStatus',
    'fulfillmentTrackingCode',
    'fulfillmentUpdatedAt',
  ] as const;
  const allowed = new Set<string>([...required, ...optional]);
  const orders: DeliveryOrderSummary[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (!required.every((key) => Object.hasOwn(entry, key))) return null;
    if (!Object.keys(entry).every((key) => allowed.has(key))) return null;
    if (!Array.isArray(entry.items) || !entry.items.every((item) =>
      isRecord(item) && hasExactKeys(item, ['kind', 'refId'])
    )) return null;
    const order = parseDeliveryOrderSummary(entry);
    if (!order) return null;
    orders.push(order);
  }
  return orders;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function hasExactRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function parseProfileAddress(value: unknown): ProfileAddress | null {
  if (!isRecord(value)) return null;
  const required = ['id', 'country', 'hint', 'encrypted'] as const;
  const optional = ['countryCode', 'email'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    typeof value.id !== 'string' || !/^[A-Za-z0-9]{20}$/.test(value.id) ||
    typeof value.country !== 'string' || value.country.length > 64 ||
    typeof value.hint !== 'string' || value.hint.length > 256 ||
    typeof value.encrypted !== 'string' || value.encrypted.length > 4096 ||
    (value.countryCode !== undefined && (typeof value.countryCode !== 'string' || value.countryCode.length > 32)) ||
    (value.email !== undefined && (typeof value.email !== 'string' || !value.email || value.email.length > 254))
  ) return null;
  return {
    id: value.id,
    country: value.country,
    hint: value.hint,
    encrypted: value.encrypted,
    ...(typeof value.countryCode === 'string' ? { countryCode: value.countryCode } : {}),
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
  };
}

function parseFulfillmentStatusUpdate(value: unknown): {
  buyerOrderShippedEmailState?: 'pending' | 'queued';
  deliveryId: number;
  fulfillmentStatus: FulfillmentStatus | '';
  fulfillmentTrackingCode?: string;
} | null {
  if (!isRecord(value)) return null;
  if (!hasExactRequiredAndOptionalKeys(
    value,
    ['deliveryId', 'fulfillmentStatus'],
    ['buyerOrderShippedEmailState', 'fulfillmentTrackingCode'],
  )) return null;
  if (!Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0) return null;
  if (value.fulfillmentStatus !== '' && value.fulfillmentStatus !== 'Preparing' && value.fulfillmentStatus !== 'Shipped') return null;
  if (
    value.fulfillmentTrackingCode !== undefined &&
    (
      typeof value.fulfillmentTrackingCode !== 'string' ||
      !value.fulfillmentTrackingCode ||
      value.fulfillmentTrackingCode.trim() !== value.fulfillmentTrackingCode
    )
  ) return null;
  if (
    value.buyerOrderShippedEmailState !== undefined &&
    value.buyerOrderShippedEmailState !== 'pending' &&
    value.buyerOrderShippedEmailState !== 'queued'
  ) return null;
  return {
    ...(value.buyerOrderShippedEmailState === 'pending' || value.buyerOrderShippedEmailState === 'queued'
      ? { buyerOrderShippedEmailState: value.buyerOrderShippedEmailState }
      : {}),
    deliveryId: Number(value.deliveryId),
    fulfillmentStatus: value.fulfillmentStatus,
    ...(typeof value.fulfillmentTrackingCode === 'string'
      ? { fulfillmentTrackingCode: value.fulfillmentTrackingCode }
      : {}),
  };
}

const MAX_ENCRYPTED_FULFILLMENT_ADDRESS_LENGTH = 12 * 1024;

function parseUpdateFulfillmentAddress(value: unknown): UpdateFulfillmentAddressResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['deliveryId', 'address'])) return null;
  if (!Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 || !isRecord(value.address)) return null;
  const address = value.address;
  const required = ['full', 'encrypted', 'hint'] as const;
  const optional = ['label', 'email', 'phone', 'country', 'countryCode'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(address, key))) return null;
  if (!Object.keys(address).every((key) => allowed.has(key))) return null;
  if (
    typeof address.full !== 'string' || !address.full || address.full.length > 2048 ||
    typeof address.encrypted !== 'string' || !address.encrypted ||
    address.encrypted.length > MAX_ENCRYPTED_FULFILLMENT_ADDRESS_LENGTH ||
    typeof address.hint !== 'string' || address.hint.length > 256 ||
    optional.some((key) => address[key] !== undefined && typeof address[key] !== 'string')
  ) return null;
  return {
    deliveryId: Number(value.deliveryId),
    address: {
      full: address.full,
      encrypted: address.encrypted,
      hint: address.hint,
      ...(typeof address.label === 'string' ? { label: address.label } : {}),
      ...(typeof address.email === 'string' ? { email: address.email } : {}),
      ...(typeof address.phone === 'string' ? { phone: address.phone } : {}),
      ...(typeof address.country === 'string' ? { country: address.country } : {}),
      ...(typeof address.countryCode === 'string' ? { countryCode: address.countryCode } : {}),
    },
  };
}

function parseShipStationMoney(value: unknown): { currency: string; amount: number } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['currency', 'amount'])) return null;
  if (
    typeof value.currency !== 'string' || !/^[a-z]{3}$/.test(value.currency) ||
    typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0
  ) return null;
  return { currency: value.currency, amount: value.amount };
}

function parseShipStationPackageResponse(value: unknown): ShipStationPackageInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ['length', 'width', 'height', 'weight'])) return null;
  return parseShipStationPackage(value);
}

function parseFulfillmentShipStationLabel(value: unknown): NonNullable<GetFulfillmentShipStationLabelResponse['label']> | null {
  if (!isRecord(value)) return null;
  const required = ['labelId', 'shipmentId', 'status'] as const;
  const optionalStrings = [
    'rateId',
    'trackingNumber',
    'carrierId',
    'carrierCode',
    'carrierName',
    'serviceCode',
    'serviceName',
    'purchasedBy',
  ] as const;
  const optional = [...optionalStrings, 'shipmentCost', 'insuranceCost', 'totalCost', 'purchasedAt'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    typeof value.labelId !== 'string' || !value.labelId ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    (value.status !== 'processing' && value.status !== 'completed' && value.status !== 'error' && value.status !== 'voided') ||
    optionalStrings.some((key) => value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) ||
    (value.purchasedAt !== undefined && (typeof value.purchasedAt !== 'number' || !Number.isFinite(value.purchasedAt)))
  ) return null;
  const shipmentCost = value.shipmentCost === undefined ? undefined : parseShipStationMoney(value.shipmentCost);
  const insuranceCost = value.insuranceCost === undefined ? undefined : parseShipStationMoney(value.insuranceCost);
  const totalCost = value.totalCost === undefined ? undefined : parseShipStationMoney(value.totalCost);
  if (
    (value.shipmentCost !== undefined && !shipmentCost) ||
    (value.insuranceCost !== undefined && !insuranceCost) ||
    (value.totalCost !== undefined && !totalCost)
  ) return null;
  return {
    labelId: value.labelId,
    shipmentId: value.shipmentId,
    status: value.status,
    ...(typeof value.rateId === 'string' ? { rateId: value.rateId } : {}),
    ...(typeof value.trackingNumber === 'string' ? { trackingNumber: value.trackingNumber } : {}),
    ...(typeof value.carrierId === 'string' ? { carrierId: value.carrierId } : {}),
    ...(typeof value.carrierCode === 'string' ? { carrierCode: value.carrierCode } : {}),
    ...(typeof value.carrierName === 'string' ? { carrierName: value.carrierName } : {}),
    ...(typeof value.serviceCode === 'string' ? { serviceCode: value.serviceCode } : {}),
    ...(typeof value.serviceName === 'string' ? { serviceName: value.serviceName } : {}),
    ...(shipmentCost ? { shipmentCost } : {}),
    ...(insuranceCost ? { insuranceCost } : {}),
    ...(totalCost ? { totalCost } : {}),
    ...(typeof value.purchasedAt === 'number' ? { purchasedAt: value.purchasedAt } : {}),
    ...(typeof value.purchasedBy === 'string' ? { purchasedBy: value.purchasedBy } : {}),
  };
}

function parseAddFulfillmentOrderToShipStation(
  value: unknown,
): AddFulfillmentOrderToShipStationResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'alreadyAdded'] as const;
  const allowed = new Set<string>([...required, 'shipstationAddedAt']);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    typeof value.alreadyAdded !== 'boolean' ||
    (value.shipstationAddedAt !== undefined && (
      typeof value.shipstationAddedAt !== 'number' ||
      !Number.isFinite(value.shipstationAddedAt) ||
      value.shipstationAddedAt <= 0
    ))
  ) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    alreadyAdded: value.alreadyAdded,
    ...(typeof value.shipstationAddedAt === 'number'
      ? { shipstationAddedAt: value.shipstationAddedAt }
      : {}),
  };
}

function parseGetFulfillmentShipStationLabel(value: unknown): GetFulfillmentShipStationLabelResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId'] as const;
  const optional = ['label', 'labelDownloadUrl', 'purchaseUnknown'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    (value.labelDownloadUrl !== undefined &&
      (typeof value.labelDownloadUrl !== 'string' || !/^https:\/\//i.test(value.labelDownloadUrl))) ||
    (value.purchaseUnknown !== undefined && typeof value.purchaseUnknown !== 'boolean')
  ) return null;
  const label = value.label === undefined ? undefined : parseFulfillmentShipStationLabel(value.label);
  if (value.label !== undefined && (!label || label.shipmentId !== value.shipmentId)) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    ...(label ? { label } : {}),
    ...(typeof value.labelDownloadUrl === 'string' ? { labelDownloadUrl: value.labelDownloadUrl } : {}),
    ...(typeof value.purchaseUnknown === 'boolean' ? { purchaseUnknown: value.purchaseUnknown } : {}),
  };
}

function parsePurchaseFulfillmentShipStationLabel(
  value: unknown,
): PurchaseFulfillmentShipStationLabelResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'label', 'alreadyPurchased'] as const;
  const allowed = new Set<string>([...required, 'labelDownloadUrl']);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    typeof value.alreadyPurchased !== 'boolean' ||
    (value.labelDownloadUrl !== undefined && (
      typeof value.labelDownloadUrl !== 'string' || !/^https:\/\//i.test(value.labelDownloadUrl)
    ))
  ) return null;
  const label = parseFulfillmentShipStationLabel(value.label);
  if (!label || label.shipmentId !== value.shipmentId) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    label,
    ...(typeof value.labelDownloadUrl === 'string' ? { labelDownloadUrl: value.labelDownloadUrl } : {}),
    alreadyPurchased: value.alreadyPurchased,
  };
}

function parseVoidFulfillmentShipStationLabel(
  value: unknown,
): VoidFulfillmentShipStationLabelResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'label'] as const;
  if (!hasExactKeys(value, required)) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId
  ) return null;
  const label = parseFulfillmentShipStationLabel(value.label);
  if (!label || label.shipmentId !== value.shipmentId || label.status !== 'voided') return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    label: { ...label, status: 'voided' },
  };
}

function parseFulfillmentShipStationRate(
  value: unknown,
): GetFulfillmentShipStationRatesResponse['rates'][number] | null {
  if (!isRecord(value)) return null;
  const requiredStrings = [
    'rateId',
    'shipmentId',
    'carrierId',
    'carrierCode',
    'carrierName',
    'serviceCode',
    'serviceName',
  ] as const;
  const requiredMoney = [
    'shippingAmount',
    'insuranceAmount',
    'confirmationAmount',
    'otherAmount',
    'totalAmount',
  ] as const;
  const optionalStrings = [
    'carrierNickname',
    'packageType',
    'rateType',
    'carrierDeliveryDays',
    'shipDate',
    'estimatedDeliveryDate',
  ] as const;
  const optional = [
    ...optionalStrings,
    'zone',
    'negotiatedRate',
    'trackable',
    'taxAmount',
    'deliveryDays',
  ] as const;
  const allowed = new Set<string>([
    ...requiredStrings,
    ...requiredMoney,
    ...optional,
    'guaranteedService',
    'warningMessages',
  ]);
  if (!requiredStrings.every((key) => Object.hasOwn(value, key))) return null;
  if (!requiredMoney.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.hasOwn(value, 'guaranteedService') || !Object.hasOwn(value, 'warningMessages')) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    requiredStrings.some((key) => typeof value[key] !== 'string') ||
    typeof value.rateId !== 'string' || !value.rateId ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    optionalStrings.some((key) => value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) ||
    typeof value.guaranteedService !== 'boolean' ||
    !Array.isArray(value.warningMessages) ||
    !value.warningMessages.every((message) => typeof message === 'string') ||
    (value.zone !== undefined && (!Number.isSafeInteger(value.zone) || Number(value.zone) < 0)) ||
    (value.deliveryDays !== undefined && (!Number.isSafeInteger(value.deliveryDays) || Number(value.deliveryDays) < 0)) ||
    (value.negotiatedRate !== undefined && typeof value.negotiatedRate !== 'boolean') ||
    (value.trackable !== undefined && typeof value.trackable !== 'boolean')
  ) return null;
  const shippingAmount = parseShipStationMoney(value.shippingAmount);
  const insuranceAmount = parseShipStationMoney(value.insuranceAmount);
  const confirmationAmount = parseShipStationMoney(value.confirmationAmount);
  const otherAmount = parseShipStationMoney(value.otherAmount);
  const totalAmount = parseShipStationMoney(value.totalAmount);
  const taxAmount = value.taxAmount === undefined ? undefined : parseShipStationMoney(value.taxAmount);
  if (!shippingAmount || !insuranceAmount || !confirmationAmount || !otherAmount || !totalAmount) return null;
  if (value.taxAmount !== undefined && !taxAmount) return null;
  const currencies = [shippingAmount, insuranceAmount, confirmationAmount, otherAmount, totalAmount, taxAmount]
    .filter((amount): amount is NonNullable<typeof amount> => Boolean(amount))
    .map((amount) => amount.currency);
  if (currencies.some((currency) => currency !== currencies[0])) return null;
  return {
    rateId: value.rateId,
    shipmentId: value.shipmentId,
    carrierId: value.carrierId as string,
    carrierCode: value.carrierCode as string,
    carrierName: value.carrierName as string,
    ...(typeof value.carrierNickname === 'string' ? { carrierNickname: value.carrierNickname } : {}),
    serviceCode: value.serviceCode as string,
    serviceName: value.serviceName as string,
    ...(typeof value.packageType === 'string' ? { packageType: value.packageType } : {}),
    ...(typeof value.rateType === 'string' ? { rateType: value.rateType } : {}),
    ...(typeof value.zone === 'number' ? { zone: value.zone } : {}),
    ...(typeof value.carrierDeliveryDays === 'string' ? { carrierDeliveryDays: value.carrierDeliveryDays } : {}),
    ...(typeof value.shipDate === 'string' ? { shipDate: value.shipDate } : {}),
    ...(typeof value.negotiatedRate === 'boolean' ? { negotiatedRate: value.negotiatedRate } : {}),
    ...(typeof value.trackable === 'boolean' ? { trackable: value.trackable } : {}),
    shippingAmount,
    insuranceAmount,
    confirmationAmount,
    otherAmount,
    ...(taxAmount ? { taxAmount } : {}),
    totalAmount,
    ...(typeof value.deliveryDays === 'number' ? { deliveryDays: value.deliveryDays } : {}),
    ...(typeof value.estimatedDeliveryDate === 'string'
      ? { estimatedDeliveryDate: value.estimatedDeliveryDate }
      : {}),
    guaranteedService: value.guaranteedService,
    warningMessages: value.warningMessages,
  };
}

function parseFulfillmentShipStationInvalidRate(
  value: unknown,
): GetFulfillmentShipStationRatesResponse['invalidRates'][number] | null {
  if (!isRecord(value)) return null;
  const required = ['carrierId', 'carrierCode', 'carrierName', 'serviceCode', 'serviceName', 'errorMessages'] as const;
  const allowed = new Set<string>([...required, 'responseIssue']);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    typeof value.carrierId !== 'string' ||
    typeof value.carrierCode !== 'string' ||
    typeof value.carrierName !== 'string' || !value.carrierName ||
    typeof value.serviceCode !== 'string' ||
    typeof value.serviceName !== 'string' || !value.serviceName ||
    !Array.isArray(value.errorMessages) ||
    !value.errorMessages.length ||
    !value.errorMessages.every((message) => typeof message === 'string' && Boolean(message)) ||
    (value.responseIssue !== undefined && value.responseIssue !== true)
  ) return null;
  return {
    carrierId: value.carrierId,
    carrierCode: value.carrierCode,
    carrierName: value.carrierName,
    serviceCode: value.serviceCode,
    serviceName: value.serviceName,
    errorMessages: value.errorMessages,
    ...(value.responseIssue === true ? { responseIssue: true } : {}),
  };
}

function parseGetFulfillmentShipStationRates(value: unknown): GetFulfillmentShipStationRatesResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'packageCount', 'rates', 'invalidRates'] as const;
  const optional = ['package', 'label', 'labelDownloadUrl', 'purchaseUnknown'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    !Number.isSafeInteger(value.packageCount) || Number(value.packageCount) < 0 ||
    !Array.isArray(value.rates) ||
    !Array.isArray(value.invalidRates) ||
    (value.labelDownloadUrl !== undefined &&
      (typeof value.labelDownloadUrl !== 'string' || !/^https:\/\//i.test(value.labelDownloadUrl))) ||
    (value.purchaseUnknown !== undefined && typeof value.purchaseUnknown !== 'boolean')
  ) return null;
  const packageInput = value.package === undefined ? undefined : parseShipStationPackageResponse(value.package);
  if (value.package !== undefined && !packageInput) return null;
  const rates = value.rates.map(parseFulfillmentShipStationRate);
  const invalidRates = value.invalidRates.map(parseFulfillmentShipStationInvalidRate);
  if (!rates.every((rate): rate is NonNullable<typeof rate> => rate !== null)) return null;
  if (!invalidRates.every((rate): rate is NonNullable<typeof rate> => rate !== null)) return null;
  if (rates.some((rate) => rate.shipmentId !== value.shipmentId)) return null;
  const label = value.label === undefined ? undefined : parseFulfillmentShipStationLabel(value.label);
  if (value.label !== undefined && (!label || label.shipmentId !== value.shipmentId)) return null;
  if (value.labelDownloadUrl !== undefined && !label) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    ...(packageInput ? { package: packageInput } : {}),
    packageCount: Number(value.packageCount),
    rates,
    invalidRates,
    ...(label ? { label } : {}),
    ...(typeof value.labelDownloadUrl === 'string' ? { labelDownloadUrl: value.labelDownloadUrl } : {}),
    ...(typeof value.purchaseUnknown === 'boolean' ? { purchaseUnknown: value.purchaseUnknown } : {}),
  };
}

function profileStateErrorSection(value: unknown): ProfileStateSection<never> | null {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'error']) || value.status !== 'error') return null;
  const error = value.error;
  if (!isRecord(error) || !hasExactKeys(error, ['code', 'message'])) return null;
  if (
    (error.code !== 'deadline-exceeded' && error.code !== 'unavailable') ||
    typeof error.message !== 'string' ||
    !error.message
  ) return null;
  return { status: 'error', error: { code: error.code, message: error.message } };
}

function profileStateProfileSection(
  value: unknown,
  sessionWallet: string,
): ProfileStateSection<ProfileStateProfile> | null {
  const error = profileStateErrorSection(value);
  if (error) return error;
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'value']) || value.status !== 'ready') return null;
  const profile = value.value;
  if (!isRecord(profile)) return null;
  const keys = Object.keys(profile).sort().join(',');
  if (keys !== 'wallet' && keys !== 'email,wallet') return null;
  if (profile.wallet !== sessionWallet) return null;
  if (
    profile.email !== undefined &&
    (
      typeof profile.email !== 'string' ||
      !profile.email ||
      profile.email.length > 254 ||
      profile.email.trim() !== profile.email
    )
  ) return null;
  return {
    status: 'ready',
    value: {
      wallet: sessionWallet,
      ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
    },
  };
}

function profileStateShipmentsSection(
  value: unknown,
): ProfileStateSection<DeliveryOrderSummary[]> | null {
  const error = profileStateErrorSection(value);
  if (error) return error;
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'value']) || value.status !== 'ready') return null;
  const orders = exactProfileOrders(value.value);
  return orders ? { status: 'ready', value: orders } : null;
}

function parseProfileState(value: unknown): GetProfileStateResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'responseMode',
    'sessionWallet',
    'profile',
    'shipments',
  ])) return null;
  if (value.responseMode !== 'profile-state') return null;
  if (value.sessionWallet === null) {
    return value.profile === null && value.shipments === null
      ? {
          responseMode: 'profile-state',
          sessionWallet: null,
          profile: null,
          shipments: null,
        }
      : null;
  }
  if (typeof value.sessionWallet !== 'string' || !isBase58Bytes(value.sessionWallet, 32)) return null;
  const profile = profileStateProfileSection(value.profile, value.sessionWallet);
  const shipments = profileStateShipmentsSection(value.shipments);
  if (!profile || !shipments) return null;
  return {
    responseMode: 'profile-state',
    sessionWallet: value.sessionWallet,
    profile,
    shipments,
  };
}

export { fetchPendingOpenBoxes } from './shopApi';
export type { DropFetchOptions } from './shopApi';

function parseRevealDudesResponse(
  value: unknown,
  dropId: string,
): RevealDudesResponse | null {
  const drop = FRONTEND_DROPS[dropId];
  if (
    !drop ||
    !isRecord(value) ||
    !hasExactKeys(value, ['signature', 'dudeIds']) ||
    typeof value.signature !== 'string' ||
    !isNonZeroBase58Bytes(value.signature, 64) ||
    !Array.isArray(value.dudeIds) ||
    value.dudeIds.length !== drop.itemsPerBox
  ) return null;
  const maxDudeId = drop.maxSupply * drop.itemsPerBox;
  const dudeIds: number[] = [];
  for (const id of value.dudeIds) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > maxDudeId) return null;
    dudeIds.push(id);
  }
  if (new Set(dudeIds).size !== dudeIds.length) return null;
  return { signature: value.signature, dudeIds };
}

function parseRevealDudesSubmissionUnknownDetails(
  value: unknown,
  dropId: string,
): RevealDudesSubmissionUnknownDetails | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, ['kind', 'submission']) ||
    value.kind !== 'reveal-submission-unknown' ||
    !isRecord(value.submission) ||
    !hasExactKeys(value.submission, ['signature', 'recentBlockhash', 'dudeIds']) ||
    typeof value.submission.recentBlockhash !== 'string' ||
    !isNonZeroBase58Bytes(value.submission.recentBlockhash, 32)
  ) return null;
  const parsed = parseRevealDudesResponse({
    signature: value.submission.signature,
    dudeIds: value.submission.dudeIds,
  }, dropId);
  if (!parsed) return null;
  return {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: parsed.signature,
      recentBlockhash: value.submission.recentBlockhash,
      dudeIds: parsed.dudeIds,
    },
  };
}

export function revealDudesSubmissionUnknownDetails(
  error: unknown,
  dropId: string,
): RevealDudesSubmissionUnknownDetails | null {
  if (!(error instanceof ProfileApiError)) return null;
  return parseRevealDudesSubmissionUnknownDetails(error.details, dropId);
}

export async function revealDudes(
  owner: string,
  boxAssetId: string,
  dropId: string,
): Promise<RevealDudesResponse> {
  const normalizedDropId = normalizeDropId(dropId);
  const response = await callProfileApi('/boxes/reveal', {
    owner,
    boxAssetId,
    dropId: normalizedDropId,
  });
  const parsed = parseRevealDudesResponse(response, normalizedDropId);
  if (!parsed) throw new Error('Invalid reveal response');
  return parsed;
}

export async function saveEncryptedAddress(
  encrypted: string,
  country: string,
  hint: string,
  email?: string,
  countryCode?: string,
): Promise<ProfileAddress> {
  const request: SaveProfileAddressRequest = {
    id: createProfileAddressId(),
    encrypted,
    country,
    countryCode,
    hint,
    email,
  };
  const response = await saveProfileAddressRequest(request, (pathname, data) => callProfileApi(pathname, data));
  const address = parseProfileAddress(response);
  if (!address) throw new Error('Invalid saved address response');
  return address;
}

type ProfileApiCaller = (pathname: AuthenticatedApiPath, data: unknown) => Promise<unknown>;

function retryableProfileAddressError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'deadline-exceeded' || code === 'unavailable';
}

async function saveProfileAddressRequest(
  request: SaveProfileAddressRequest,
  call: ProfileApiCaller,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await call('/profile/addresses', request);
    } catch (error) {
      if (attempt > 0 || !retryableProfileAddressError(error)) throw error;
    }
  }
  throw new Error('Profile address retry failed');
}

function stripeCheckoutRequestQuantity(quantity: StripeCheckoutSessionRequest['quantity']): number | undefined {
  if (quantity === undefined) return undefined;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Stripe checkout quantity must be a positive integer');
  }
  return quantity;
}

function stripeCheckoutSessionPayload(args: StripeCheckoutSessionRequest): StripeCheckoutSessionRequest {
  const payload: StripeCheckoutSessionRequest = {
    dropId: args.dropId,
  };
  if (typeof args.variantKey === 'string' && args.variantKey.trim()) {
    payload.variantKey = args.variantKey.trim();
  }
  const quantity = stripeCheckoutRequestQuantity(args.quantity);
  if (quantity !== undefined) {
    payload.quantity = quantity;
  }
  if (typeof args.returnUrl === 'string' && args.returnUrl.trim()) {
    payload.returnUrl = args.returnUrl.trim();
  }
  return payload;
}

function parseStripeCheckoutSessionResponse(value: unknown): StripeCheckoutSessionResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'url', 'livemode'])) return null;
  if (
    typeof value.id !== 'string' || !/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(value.id) ||
    typeof value.url !== 'string' || !value.url ||
    typeof value.livemode !== 'boolean'
  ) return null;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { id: value.id, url: value.url, livemode: value.livemode };
}

export async function createStripeCheckoutSession(
  args: StripeCheckoutSessionRequest,
): Promise<StripeCheckoutSessionResponse & { authSubject: string }> {
  const credential: { authSubject?: string } = {};
  const response = await callProfileApi('/checkout/session', stripeCheckoutSessionPayload(args), credential);
  const session = parseStripeCheckoutSessionResponse(response);
  if (!session || !credential.authSubject) throw new Error('Invalid Stripe checkout session response');
  return { ...session, authSubject: credential.authSubject };
}

function packStatusFrontendDropForDropId(dropId: string): FrontendDeploymentConfig | null {
  const normalizedDropId = normalizeDropId(dropId);
  const drop = FRONTEND_DROPS[normalizedDropId];
  if (
    !isPackStatusSupportedDropId(normalizedDropId) ||
    !drop ||
    drop.solanaCluster !== 'mainnet-beta' ||
    normalizePackStatusAmount(drop.itemsPerBox) <= 0
  ) {
    return null;
  }
  return drop;
}

export function packStatusDisplayLabelsForDropId(dropId: string | undefined): PackStatusDisplayLabels | null {
  if (!dropId) return null;
  const normalizedDropId = normalizeDropId(dropId);
  const drop = FRONTEND_DROPS[normalizedDropId];
  if (!drop || !packStatusFrontendDropForDropId(normalizedDropId)) return null;
  return {
    itemColumnLabel: dropAssetLabel(drop, 'figure', 2, { capitalize: true }),
    ariaLabel: `${dropAssetLabel(drop, 'figure', 1, { capitalize: true })} status`,
  };
}

export function supportsFrontendPackStatus(dropId: string | undefined): boolean {
  return Boolean(dropId && packStatusFrontendDropForDropId(dropId));
}

export async function getDropPackStatus(dropId: string): Promise<PackStatusBreakdown | null> {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) throw new Error('dropId is required');
  return fetchPackStatus(normalizedDropId);
}

export async function listFulfillmentOrders(args: {
  limit?: number;
  cursor?: FulfillmentOrdersCursor | null;
  dropId: string;
}): Promise<{ orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }> {
  const response = await callProfileApi('/fulfillment/orders', {
    limit: args.limit,
    cursor: args.cursor || undefined,
    dropId: args.dropId,
  });
  if (!isRecord(response) || !Array.isArray(response.orders)) throw new Error('Invalid fulfillment orders response');
  const orders = response.orders.filter((order): order is FulfillmentOrder =>
    isRecord(order) &&
    typeof order.dropId === 'string' &&
    Number.isSafeInteger(order.deliveryId) && Number(order.deliveryId) > 0 &&
    typeof order.owner === 'string' &&
    typeof order.status === 'string' &&
    (order.buyerOrderShippedEmailState === undefined ||
      order.buyerOrderShippedEmailState === 'pending' ||
      order.buyerOrderShippedEmailState === 'queued') &&
    isRecord(order.address) &&
    Array.isArray(order.boxes) &&
    Array.isArray(order.looseDudes));
  if (orders.length !== response.orders.length) throw new Error('Invalid fulfillment orders response');
  const cursor = response.nextCursor;
  if (cursor !== undefined && cursor !== null && (
    !isRecord(cursor) || !isRecord(cursor.processedAt) ||
    !Number.isSafeInteger(cursor.processedAt.seconds) ||
    !Number.isInteger(cursor.processedAt.nanos) ||
    typeof cursor.id !== 'string'
  )) throw new Error('Invalid fulfillment orders response');
  return {
    orders: orders.map((order) => ({
      ...order,
      dropId: order.dropId || args.dropId,
    })),
    nextCursor: cursor as FulfillmentOrdersCursor | null | undefined,
  };
}

export async function listFulfillmentManualReviewCheckouts(args: {
  dropId: string;
}): Promise<{ checkouts: FulfillmentManualReviewCheckout[] }> {
  const response = await callProfileApi('/fulfillment/manual-review-checkouts', { dropId: args.dropId });
  if (!isRecord(response) || !Array.isArray(response.checkouts)) {
    throw new Error('Invalid fulfillment manual-review response');
  }
  const checkouts = response.checkouts.filter((checkout): checkout is FulfillmentManualReviewCheckout =>
    isRecord(checkout) &&
    typeof checkout.dropId === 'string' &&
    typeof checkout.sessionId === 'string' &&
    typeof checkout.owner === 'string' &&
    isRecord(checkout.address));
  if (checkouts.length !== response.checkouts.length) throw new Error('Invalid fulfillment manual-review response');
  return {
    checkouts: checkouts.map((checkout) => ({
      ...checkout,
      dropId: checkout.dropId || args.dropId,
      address: checkout.address || {},
    })),
  };
}

export async function updateFulfillmentStatus(
  deliveryId: number,
  status: FulfillmentStatus | '' | null,
  dropId: string,
  trackingCode?: string,
  options: { retryShippedEmail?: boolean } = {},
): Promise<{
  buyerOrderShippedEmailState?: 'pending' | 'queued';
  deliveryId: number;
  fulfillmentStatus: FulfillmentStatus | '';
  fulfillmentTrackingCode?: string;
}> {
  const response = await callProfileApi('/fulfillment/order-status', {
    deliveryId,
    status,
    dropId,
    ...(options.retryShippedEmail === true ? { retryShippedEmail: true } : {}),
    ...(trackingCode != null ? { trackingCode } : {}),
  });
  const result = parseFulfillmentStatusUpdate(response);
  if (!result) throw new Error('Invalid fulfillment status response');
  return result;
}

export async function updateFulfillmentAddress(
  deliveryId: number,
  full: string,
  dropId: string,
): Promise<UpdateFulfillmentAddressResponse> {
  const response = await callProfileApi<UpdateFulfillmentAddressRequest>(
    '/fulfillment/order-address',
    { deliveryId, full, dropId },
  );
  const result = parseUpdateFulfillmentAddress(response);
  if (!result) throw new Error('Invalid fulfillment address response');
  return result;
}

function addFulfillmentOrderToShipStationRequestPayload(
  deliveryId: number,
  dropId: string,
  packageInput?: ShipStationPackageInput,
  addressPatch?: ShipStationAddressPatch,
): AddFulfillmentOrderToShipStationRequest {
  return {
    deliveryId,
    dropId,
    ...(packageInput ? { package: packageInput } : {}),
    ...(addressPatch ? { addressPatch } : {}),
  };
}

export async function addFulfillmentOrderToShipStation(
  deliveryId: number,
  dropId: string,
  packageInput?: ShipStationPackageInput,
  addressPatch?: ShipStationAddressPatch,
): Promise<AddFulfillmentOrderToShipStationResponse> {
  const response = await callProfileApi<AddFulfillmentOrderToShipStationRequest>(
    '/fulfillment/shipstation-shipment',
    addFulfillmentOrderToShipStationRequestPayload(deliveryId, dropId, packageInput, addressPatch),
  );
  const result = parseAddFulfillmentOrderToShipStation(response);
  if (!result) throw new Error('Invalid fulfillment ShipStation shipment response');
  return result;
}

export async function getFulfillmentShipStationRates(
  deliveryId: number,
  dropId: string,
  packageInput?: ShipStationPackageInput,
): Promise<GetFulfillmentShipStationRatesResponse> {
  const response = await callProfileApi<GetFulfillmentShipStationRatesRequest>(
    '/fulfillment/shipstation-rates',
    { deliveryId, dropId, ...(packageInput ? { package: packageInput } : {}) },
  );
  const result = parseGetFulfillmentShipStationRates(response);
  if (!result) throw new Error('Invalid fulfillment ShipStation rates response');
  return result;
}

export async function purchaseFulfillmentShipStationLabel(
  args: PurchaseFulfillmentShipStationLabelRequest,
): Promise<PurchaseFulfillmentShipStationLabelResponse> {
  const response = await callProfileApi<PurchaseFulfillmentShipStationLabelRequest>(
    '/fulfillment/shipstation-label-purchase',
    args,
  );
  const result = parsePurchaseFulfillmentShipStationLabel(response);
  if (!result) throw new Error('Invalid fulfillment ShipStation label purchase response');
  return result;
}

export async function getFulfillmentShipStationLabel(
  deliveryId: number,
  dropId: string,
): Promise<GetFulfillmentShipStationLabelResponse> {
  const response = await callProfileApi<GetFulfillmentShipStationLabelRequest>(
    '/fulfillment/shipstation-label',
    { deliveryId, dropId },
  );
  const result = parseGetFulfillmentShipStationLabel(response);
  if (!result) throw new Error('Invalid fulfillment ShipStation label response');
  return result;
}

export async function voidFulfillmentShipStationLabel(
  args: VoidFulfillmentShipStationLabelRequest,
): Promise<VoidFulfillmentShipStationLabelResponse> {
  const response = await callProfileApi<VoidFulfillmentShipStationLabelRequest>(
    '/fulfillment/shipstation-label-void',
    args,
  );
  const result = parseVoidFulfillmentShipStationLabel(response);
  if (!result) throw new Error('Invalid fulfillment ShipStation label void response');
  return result;
}

export async function requestDeliveryTx(
  owner: string,
  selection: DeliverySelection,
  dropId: string,
): Promise<PrepareDeliveryResponse> {
  const response = await callProfileApi<PrepareDeliveryRequest>('/delivery/prepare', {
    owner,
    dropId,
    itemIds: selection.itemIds,
    addressId: selection.addressId,
  });
  const parsed = parseDeliveryPrepareResponse(response);
  if (!parsed) throw new Error('Invalid delivery preparation response');
  return parsed;
}

function parseDeliveryPrepareResponse(response: unknown): PrepareDeliveryResponse | null {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, ['encodedTx', 'blockhashContextSlot', 'deliveryLamports', 'deliveryId']) ||
    typeof response.encodedTx !== 'string' ||
    response.encodedTx.length === 0 ||
    response.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.encodedTx) ||
    !Number.isSafeInteger(response.blockhashContextSlot) ||
    Number(response.blockhashContextSlot) < 0 ||
    !Number.isSafeInteger(response.deliveryLamports) ||
    Number(response.deliveryLamports) < 0 ||
    !Number.isSafeInteger(response.deliveryId) ||
    Number(response.deliveryId) < 1 ||
    Number(response.deliveryId) >= 2 ** 31
  ) return null;
  return {
    encodedTx: response.encodedTx,
    blockhashContextSlot: Number(response.blockhashContextSlot),
    deliveryLamports: Number(response.deliveryLamports),
    deliveryId: Number(response.deliveryId),
  };
}

export async function prepareReceiptTransferTx(args: {
  owner: string;
  dropId: string;
  receiptAssetId: string;
  destination: string;
}): Promise<PreparedTxResponse> {
  const response = await callProfileApi<PrepareReceiptTransferRequest>('/receipts/transfer/prepare', args);
  const parsed = parseReceiptTransferPrepareResponse(response);
  if (!parsed) throw new Error('Invalid receipt transfer transaction response');
  return parsed;
}

function parseReceiptTransferPrepareResponse(response: unknown): PrepareReceiptTransferResponse | null {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, ['encodedTx', 'dropId', 'certificateId']) ||
    typeof response.encodedTx !== 'string' ||
    response.encodedTx.length === 0 ||
    response.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.encodedTx) ||
    typeof response.dropId !== 'string' ||
    normalizeDropId(response.dropId) !== response.dropId ||
    !FRONTEND_DROPS[response.dropId] ||
    typeof response.certificateId !== 'string' ||
    !isBase58Bytes(response.certificateId, 32)
  ) {
    return null;
  }
  return {
    encodedTx: response.encodedTx,
    dropId: response.dropId,
    certificateId: response.certificateId,
  };
}

function parseAdminIrlRedeemPrepareResponse(value: unknown): AdminIrlRedeemPreparedTxResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['encodedTx', 'requestId', 'dropId', 'adminWallet', 'itemCount', 'targetKind']) ||
    typeof value.encodedTx !== 'string' ||
    value.encodedTx.length === 0 ||
    value.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encodedTx) ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9]{20}$/.test(value.requestId) ||
    typeof value.dropId !== 'string' ||
    normalizeDropId(value.dropId) !== value.dropId ||
    !FRONTEND_DROPS[value.dropId] ||
    typeof value.adminWallet !== 'string' ||
    !isBase58Bytes(value.adminWallet, 32) ||
    !Number.isSafeInteger(value.itemCount) ||
    Number(value.itemCount) < 1 ||
    Number(value.itemCount) > 32 ||
    (value.targetKind !== 'pack' && value.targetKind !== 'card_receipt') ||
    (value.targetKind === 'card_receipt' && value.itemCount !== 1)
  ) return null;
  return {
    encodedTx: value.encodedTx,
    requestId: value.requestId,
    dropId: value.dropId,
    adminWallet: value.adminWallet,
    itemCount: Number(value.itemCount),
    targetKind: value.targetKind,
  };
}

export async function prepareAdminIrlRedeemTx(args: {
  owner: string;
  dropId: string;
  itemIds: string[];
}): Promise<AdminIrlRedeemPreparedTxResponse> {
  const dropId = normalizeDropId(args.dropId);
  const response = await callProfileApi('/admin/irl-redeem/prepare', { ...args, dropId });
  const parsed = parseAdminIrlRedeemPrepareResponse(response);
  if (!parsed || parsed.dropId !== dropId || parsed.itemCount !== args.itemIds.length) {
    throw new Error('Invalid Admin IRL redeem preparation response');
  }
  return parsed;
}

function parseIssueReceiptsResult(value: unknown): IssueReceiptsResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['processed', 'deliveryId', 'receiptsMinted', 'receiptTxs', 'closeDeliveryTx']) ||
    value.processed !== true ||
    !Number.isSafeInteger(value.deliveryId) ||
    Number(value.deliveryId) < 1 ||
    Number(value.deliveryId) > 0xffff_ffff ||
    !Number.isSafeInteger(value.receiptsMinted) ||
    Number(value.receiptsMinted) < 0 ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => typeof signature === 'string' && isNonZeroBase58Bytes(signature, 64)) ||
    (value.closeDeliveryTx !== null && (
      typeof value.closeDeliveryTx !== 'string' ||
      !isNonZeroBase58Bytes(value.closeDeliveryTx, 64)
    ))
  ) return null;
  return {
    processed: true,
    deliveryId: Number(value.deliveryId),
    receiptsMinted: Number(value.receiptsMinted),
    receiptTxs: value.receiptTxs as string[],
    closeDeliveryTx: value.closeDeliveryTx as string | null,
  };
}

const DELIVERY_RECOVERY_OUTCOMES = new Set([
  'recovered',
  'failed',
  'lease_active',
  'attempt_capped',
  'not_eligible',
  'missing_delivery',
  'not_found',
  'skipped_status',
]);

function parseRecoverDeliveryOrdersResult(value: unknown): RecoverDeliveryOrdersResult | null {
  if (
    !isRecord(value) ||
    !hasExactRequiredAndOptionalKeys(
      value,
      ['attempted', 'recovered', 'remainingProcessing', 'walletRecovery', 'results'],
      ['nextCheckAt'],
    ) ||
    !Number.isSafeInteger(value.attempted) || Number(value.attempted) < 0 ||
    !Number.isSafeInteger(value.recovered) || Number(value.recovered) < 0 ||
    !Number.isSafeInteger(value.remainingProcessing) || Number(value.remainingProcessing) < 0 ||
    (value.nextCheckAt !== undefined && (!Number.isFinite(value.nextCheckAt) || Number(value.nextCheckAt) < 0)) ||
    !isRecord(value.walletRecovery) ||
    !hasExactKeys(value.walletRecovery, ['remainingProcessing', 'nextCheckAt']) ||
    !Number.isSafeInteger(value.walletRecovery.remainingProcessing) ||
    Number(value.walletRecovery.remainingProcessing) < 0 ||
    (value.walletRecovery.nextCheckAt !== null && (
      !Number.isFinite(value.walletRecovery.nextCheckAt) ||
      Number(value.walletRecovery.nextCheckAt) < 0
    )) ||
    !Array.isArray(value.results)
  ) return null;
  for (const result of value.results) {
    if (
      !isRecord(result) ||
      !hasExactRequiredAndOptionalKeys(
        result,
        ['dropId', 'deliveryId', 'statusBefore', 'outcome', 'verification'],
        ['message', 'errorCode'],
      ) ||
      typeof result.dropId !== 'string' || normalizeDropId(result.dropId) !== result.dropId ||
      !FRONTEND_DROPS[result.dropId] ||
      !Number.isSafeInteger(result.deliveryId) || Number(result.deliveryId) < 1 ||
      Number(result.deliveryId) > 0xffff_ffff ||
      typeof result.statusBefore !== 'string' || !result.statusBefore || result.statusBefore.length > 64 ||
      typeof result.outcome !== 'string' || !DELIVERY_RECOVERY_OUTCOMES.has(result.outcome) ||
      result.verification !== 'delivery_pda' ||
      (result.message !== undefined && (typeof result.message !== 'string' || result.message.length > 300)) ||
      (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || result.errorCode.length > 64))
    ) return null;
  }
  if (
    value.remainingProcessing !== value.walletRecovery.remainingProcessing ||
    (value.nextCheckAt === undefined
      ? value.walletRecovery.nextCheckAt !== null
      : value.nextCheckAt !== value.walletRecovery.nextCheckAt)
  ) return null;
  return value as RecoverDeliveryOrdersResult;
}

function parseAdminIrlRedeemFinalizeResult(value: unknown): AdminIrlRedeemFinalizeResult | null {
  if (
    !isRecord(value) ||
    !hasExactRequiredAndOptionalKeys(
      value,
      ['processed', 'dropId', 'requestId', 'receiptTxs', 'claimCodes', 'boxes', 'cards'],
      ['deliveryId'],
    ) ||
    value.processed !== true ||
    typeof value.dropId !== 'string' || normalizeDropId(value.dropId) !== value.dropId || !FRONTEND_DROPS[value.dropId] ||
    typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) ||
    (value.deliveryId !== undefined && (!Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) < 1)) ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => isNonZeroBase58Bytes(signature, 64)) ||
    new Set(value.receiptTxs).size !== value.receiptTxs.length ||
    !Array.isArray(value.claimCodes) ||
    !value.claimCodes.every(isStripeReceiptClaimCode) ||
    new Set(value.claimCodes).size !== value.claimCodes.length ||
    !Array.isArray(value.boxes) ||
    !Array.isArray(value.cards)
  ) return null;
  for (const box of value.boxes) {
    if (
      !isRecord(box) ||
      !hasExactRequiredAndOptionalKeys(box, ['boxId'], ['receiptAssetId', 'claimCode', 'dudeIds']) ||
      !Number.isSafeInteger(box.boxId) || Number(box.boxId) < 1 || Number(box.boxId) > 0xffff_ffff ||
      (box.receiptAssetId !== undefined && !isBase58Bytes(box.receiptAssetId, 32)) ||
      (box.claimCode !== undefined && !isStripeReceiptClaimCode(box.claimCode)) ||
      (box.dudeIds !== undefined && (
        !Array.isArray(box.dudeIds) ||
        !box.dudeIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0 && Number(id) <= 0xffff) ||
        new Set(box.dudeIds).size !== box.dudeIds.length
      ))
    ) return null;
  }
  for (const card of value.cards) {
    if (
      !isRecord(card) ||
      !hasExactRequiredAndOptionalKeys(card, ['figureId', 'receiptAssetId'], ['claimCode']) ||
      !Number.isSafeInteger(card.figureId) || Number(card.figureId) < 1 || Number(card.figureId) > 0xffff_ffff ||
      !isBase58Bytes(card.receiptAssetId, 32) ||
      (card.claimCode !== undefined && !isStripeReceiptClaimCode(card.claimCode))
    ) return null;
  }
  return value as AdminIrlRedeemFinalizeResult;
}

export async function finalizeAdminIrlRedeem(args: {
  requestId: string;
  dropId: string;
  transferSignature: string;
}): Promise<AdminIrlRedeemFinalizeResult> {
  const response = await callProfileApi('/admin/irl-redeem/finalize', args);
  const parsed = parseAdminIrlRedeemFinalizeResult(response);
  if (!parsed) throw new Error('Invalid Admin IRL redeem finalization response');
  return parsed;
}

export async function issueReceipts(
  owner: string,
  deliveryId: number,
  signature: string,
  dropId: string,
): Promise<IssueReceiptsResult> {
  const response = await callProfileApi('/delivery/receipts/issue', {
    owner,
    deliveryId,
    signature,
    dropId,
  });
  const parsed = parseIssueReceiptsResult(response);
  if (!parsed || parsed.deliveryId !== deliveryId) throw new Error('Invalid receipt issuance response');
  return parsed;
}

export async function recoverMyDeliveryOrders(args?: RecoverDeliveryOrdersArgs): Promise<RecoverDeliveryOrdersResult> {
  const payload: RecoverDeliveryOrdersArgs = {};
  if (typeof args?.dropId === 'string' && args.dropId.trim()) {
    payload.dropId = args.dropId.trim().toLowerCase();
  }
  if (typeof args?.deliveryId === 'number' && Number.isFinite(args.deliveryId)) {
    payload.deliveryId = Math.floor(args.deliveryId);
  }
  if (args?.force === true) {
    payload.force = true;
  }
  const response = await callProfileApi('/delivery/receipts/recover', payload);
  const parsed = parseRecoverDeliveryOrdersResult(response);
  if (!parsed) throw new Error('Invalid delivery recovery response');
  return parsed;
}

function parseIrlClaimPrepareResponse(response: unknown): PrepareIrlClaimResponse | null {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, [
      'encodedTx',
      'blockhashContextSlot',
      'dropId',
      'certificates',
      'certificateId',
      'message',
    ]) ||
    typeof response.dropId !== 'string'
  ) {
    return null;
  }
  const drop = FRONTEND_DROPS[response.dropId];
  if (
    typeof response.encodedTx !== 'string' ||
    response.encodedTx.length === 0 ||
    response.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.encodedTx) ||
    !Number.isSafeInteger(response.blockhashContextSlot) ||
    Number(response.blockhashContextSlot) < 0 ||
    normalizeDropId(response.dropId) !== response.dropId ||
    !drop ||
    !Array.isArray(response.certificates) ||
    response.certificates.length === 0 ||
    response.certificates.length !== drop.itemsPerBox ||
    !response.certificates.every((id) =>
      Number.isSafeInteger(id) &&
      Number(id) > 0 &&
      Number(id) <= drop.maxSupply * drop.itemsPerBox
    ) ||
    new Set(response.certificates).size !== response.certificates.length ||
    typeof response.certificateId !== 'string' ||
    !isBase58Bytes(response.certificateId, 32) ||
    typeof response.message !== 'string' ||
    response.message.length === 0 ||
    response.message.length > 512
  ) {
    return null;
  }
  return {
    encodedTx: response.encodedTx,
    blockhashContextSlot: Number(response.blockhashContextSlot),
    dropId: response.dropId,
    certificates: response.certificates as number[],
    certificateId: response.certificateId,
    message: response.message,
  };
}

export async function requestClaimTx(
  owner: string,
  code: string,
): Promise<PrepareIrlClaimResponse> {
  const response = await callProfileApi<PrepareIrlClaimRequest>('/claims/irl/prepare', { owner, code });
  const parsed = parseIrlClaimPrepareResponse(response);
  if (!parsed) throw new Error('Invalid IRL claim transaction response');
  return parsed;
}

function parseStripeReceiptClaimResponse(value: unknown): StripeReceiptClaimResult | null {
  if (!isRecord(value) || !hasExactRequiredAndOptionalKeys(
    value,
    ['processed', 'dropId', 'deliveryId', 'receiptsTransferred', 'receiptTxs'],
    ['receiptKind', 'figureIds', 'receiptAssetIds'],
  )) return null;
  if (
    value.processed !== true ||
    typeof value.dropId !== 'string' ||
    normalizeDropId(value.dropId) !== value.dropId ||
    !FRONTEND_DROPS[value.dropId] ||
    !Number.isSafeInteger(value.deliveryId) ||
    Number(value.deliveryId) < 1 ||
    !Number.isSafeInteger(value.receiptsTransferred) ||
    Number(value.receiptsTransferred) < 1 ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => typeof signature === 'string' && isBase58Bytes(signature, 64)) ||
    (value.receiptKind !== undefined && value.receiptKind !== 'box' && value.receiptKind !== 'figure') ||
    (value.figureIds !== undefined && (
      !Array.isArray(value.figureIds) ||
      !value.figureIds.every((figureId) => Number.isSafeInteger(figureId) && Number(figureId) > 0) ||
      new Set(value.figureIds).size !== value.figureIds.length
    )) ||
    (value.receiptAssetIds !== undefined && (
      !Array.isArray(value.receiptAssetIds) ||
      !value.receiptAssetIds.every((assetId) => typeof assetId === 'string' && isBase58Bytes(assetId, 32)) ||
      new Set(value.receiptAssetIds).size !== value.receiptAssetIds.length
    ))
  ) return null;
  return {
    processed: true,
    dropId: value.dropId,
    deliveryId: Number(value.deliveryId),
    receiptsTransferred: Number(value.receiptsTransferred),
    receiptTxs: value.receiptTxs as string[],
    ...(value.receiptKind ? { receiptKind: value.receiptKind as 'box' | 'figure' } : {}),
    ...(value.figureIds ? { figureIds: value.figureIds as number[] } : {}),
    ...(value.receiptAssetIds ? { receiptAssetIds: value.receiptAssetIds as string[] } : {}),
  };
}

export async function claimStripeReceipt(args: { code: string; recipient: string }): Promise<StripeReceiptClaimResult> {
  const response = await callProfileApi('/receipts/stripe/claim', {
    code: args.code,
    recipient: args.recipient,
  });
  const parsed = parseStripeReceiptClaimResponse(response);
  if (!parsed) throw new Error('Invalid Stripe receipt claim response');
  return parsed;
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
): Promise<{ wallet: string }> {
  const response = await callProfileApi('/auth/solana', {
    wallet,
    message,
    signature: Array.from(signature),
  });
  if (!isRecord(response) || !hasExactKeys(response, ['wallet']) || !isBase58Bytes(response.wallet, 32)) {
    throw new Error('Invalid wallet session response');
  }
  return { wallet: String(response.wallet) };
}

export async function reconcileProfileState(
  options?: ReconcileProfileStateRequest,
): Promise<ReconcileProfileStateResponse> {
  const payload: ReconcileProfileStateRequest = {};
  if (options?.mergeStripeDeliveryOrders === true) {
    payload.mergeStripeDeliveryOrders = true;
  }
  if (typeof options?.includeDeliveryRecovery === 'boolean') {
    payload.includeDeliveryRecovery = options.includeDeliveryRecovery;
  }
  const response = await callProfileApi('/profile/reconcile', payload);
  if (!isRecord(response) || !hasExactRequiredAndOptionalKeys(
    response,
    ['mergedStripeDeliveryOrders'],
    ['deliveryRecovery'],
  )) {
    throw new Error('Invalid profile reconciliation response');
  }
  if (
    !Number.isSafeInteger(response.mergedStripeDeliveryOrders) ||
    Number(response.mergedStripeDeliveryOrders) < 0
  ) {
    throw new Error('Invalid profile reconciliation response');
  }
  let deliveryRecovery: ReconcileProfileStateResponse['deliveryRecovery'];
  if (response.deliveryRecovery !== undefined) {
    if (
      !isRecord(response.deliveryRecovery) ||
      !hasExactKeys(response.deliveryRecovery, ['nextCheckAt']) ||
      typeof response.deliveryRecovery.nextCheckAt !== 'number' ||
      !Number.isFinite(response.deliveryRecovery.nextCheckAt)
    ) {
      throw new Error('Invalid profile reconciliation response');
    }
    deliveryRecovery = { nextCheckAt: response.deliveryRecovery.nextCheckAt };
  }
  return {
    mergedStripeDeliveryOrders: Number(response.mergedStripeDeliveryOrders),
    ...(deliveryRecovery ? { deliveryRecovery } : {}),
  };
}

export async function loadProfileStateFromServer(): Promise<GetProfileStateResponse> {
  const response = await callProfileApi('/profile/state', {});
  const state = parseProfileState(response);
  if (!state) throw new Error('Invalid profile state response');
  return state;
}

export async function getAdminProfileView(ownerWallet: string): Promise<GetAdminProfileViewResponse> {
  const response = await callProfileApi<GetAdminProfileViewRequest>('/admin/profile', { ownerWallet });
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid admin profile response');
  const profile = (response as Record<string, unknown>).profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid admin profile response');
  const wallet = (profile as Record<string, unknown>).wallet;
  const email = (profile as Record<string, unknown>).email;
  const orders = profileOrders((profile as Record<string, unknown>).orders);
  if (wallet !== ownerWallet || (email !== undefined && typeof email !== 'string') || !orders) {
    throw new Error('Invalid admin profile response');
  }
  const normalizedEmail = typeof email === 'string' && email ? email : undefined;
  return { profile: { wallet, ...(normalizedEmail ? { email: normalizedEmail } : {}), orders } };
}

export async function getAnonymousStripeDeliveryHistory(): Promise<{ orders: Profile['orders'] }> {
  const response: unknown = await callProfileApi('/profile/anonymous-stripe-delivery-history', {});
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid anonymous Stripe delivery history response');
  }
  const orders = profileOrders((response as Record<string, unknown>).orders);
  if (!orders) throw new Error('Invalid anonymous Stripe delivery history response');
  return { orders };
}

export async function listDeliveryOrderOwners(
  options?: { cursor?: string; pageSize?: number },
): Promise<{ owners: string[]; nextCursor: string | null; hasMore: boolean }> {
  const payload: { cursor?: string; pageSize?: number } = {};
  if (typeof options?.cursor === 'string' && options.cursor) {
    payload.cursor = options.cursor;
  }
  if (typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize)) {
    payload.pageSize = options.pageSize;
  }
  const response = await callProfileApi('/admin/delivery-order-owners', payload);
  if (
    !isRecord(response) ||
    !Array.isArray(response.owners) ||
    !response.owners.every((owner) => typeof owner === 'string' && isBase58Bytes(owner, 32)) ||
    (response.nextCursor !== null && typeof response.nextCursor !== 'string') ||
    typeof response.hasMore !== 'boolean'
  ) throw new Error('Invalid delivery order owners response');
  return {
    owners: response.owners as string[],
    nextCursor: response.nextCursor as string | null,
    hasMore: response.hasMore,
  };
}

export const profileApiTestHooks = {
  addFulfillmentOrderToShipStationRequestPayload,
  parseAddFulfillmentOrderToShipStation,
  parseGetFulfillmentShipStationLabel,
  parseGetFulfillmentShipStationRates,
  parsePurchaseFulfillmentShipStationLabel,
  parseVoidFulfillmentShipStationLabel,
  parseFulfillmentStatusUpdate,
  parseFulfillmentShipStationAddressCorrectionDetails,
  parseDeliveryPrepareResponse,
  parseAdminIrlRedeemFinalizeResult,
  parseIssueReceiptsResult,
  parseRecoverDeliveryOrdersResult,
  parseAdminIrlRedeemPrepareResponse,
  parseIrlClaimPrepareResponse,
  parseStripeReceiptClaimResponse,
  parseReceiptTransferPrepareResponse,
  parseRevealDudesResponse,
  parseRevealDudesSubmissionUnknownDetails,
  revealDudesSubmissionUnknownDetails,
  parseProfileAddress,
  parseProfileState,
  parseStripeCheckoutSessionResponse,
  parseUpdateFulfillmentAddress,
  profileApiTimeoutMs,
  profileApiErrorPayload,
  profileOrders,
  requestProfileApi,
  saveProfileAddressRequest,
};
