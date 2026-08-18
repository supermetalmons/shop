import { onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, FIREBASE_FUNCTIONS_REGION, firebaseApp } from './firebase';
import {
  AddFulfillmentOrderToShipStationRequest,
  AddFulfillmentOrderToShipStationResponse,
  AdminIrlRedeemFinalizeResult,
  AdminIrlRedeemPreparedTxResponse,
  DeliveryOrderSummary,
  DeliverySelection,
  FulfillmentManualReviewCheckout,
  FulfillmentStatus,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  GetAdminProfileViewRequest,
  GetAdminProfileViewResponse,
  GetProfileShipmentsRequest,
  GetProfileShipmentsResponse,
  GetFulfillmentShipStationLabelRequest,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesRequest,
  GetFulfillmentShipStationRatesResponse,
  IssueReceiptsResult,
  PackStatusBreakdown,
  PackStatusDisplayLabels,
  PreparedTxResponse,
  Profile,
  ProfileAddress,
  PurchaseFulfillmentShipStationLabelRequest,
  PurchaseFulfillmentShipStationLabelResponse,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
  ShipStationPackageInput,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
  StripeReceiptClaimResult,
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
} from '../../functions/src/shared/packStatus.ts';
import { summarizePayloadShape } from '../../functions/src/shared/logSummaries.ts';
import { parseDeliveryOrderSummary } from '../../functions/src/shared/deliveryOrderSummary.ts';
import { fetchPackStatus } from './shopApi';
import { monsApiOrigin } from './monsApiOrigin';

export type {
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
} from '../types';

const region = FIREBASE_FUNCTIONS_REGION;
const functionsInstance = firebaseApp ? getFunctions(firebaseApp, region) : undefined;

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

const DEBUG_FUNCTIONS =
  import.meta.env?.DEV ||
  (typeof window !== 'undefined' && window.localStorage?.getItem('monsDebugFunctions') === '1');

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

async function callFunction<Req, Res>(name: string, data?: Req): Promise<Res> {
  if (!functionsInstance) throw new Error('Firebase client is not configured');
  await ensureAuthenticated();
  const callable = httpsCallable<Req, Res>(functionsInstance, name);
  const startedAt = Date.now();
  const callId = DEBUG_FUNCTIONS ? makeCallId() : undefined;
  const basePayload = (data ?? ({} as Req)) as any;
  const payload =
    DEBUG_FUNCTIONS && basePayload && typeof basePayload === 'object' && !Array.isArray(basePayload)
      ? ({ ...basePayload, __debug: { callId, fn: name, ts: new Date().toISOString() } } as Req)
      : (basePayload as Req);

  if (DEBUG_FUNCTIONS) {
    console.info(`[mons/functions] → ${name}`, { callId, payload: summarizePayloadShape(payload) });
  }

  try {
    const result = await callable(payload);
    if (DEBUG_FUNCTIONS) {
      console.info(`[mons/functions] ← ${name}`, {
        callId,
        ms: Date.now() - startedAt,
        data: summarizePayloadShape(result.data),
      });
    }
    return result.data;
  } catch (err) {
    // Always log callable failures on the client; they're rare and essential for debugging prod issues.
    console.error(`[mons/functions] ✖ ${name}`, {
      ...(callId ? { callId } : {}),
      ms: Date.now() - startedAt,
      error: summarizeError(err),
    });
    throw err;
  }
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

async function authenticatedUserToken(forceRefresh: boolean): Promise<string> {
  const uid = await ensureAuthenticated();
  const user = auth?.currentUser;
  if (!user || user.uid !== uid) throw new ProfileApiError({ code: 'unauthenticated', message: 'Authentication is required.' });
  return user.getIdToken(forceRefresh);
}

type ProfileApiClientDependencies = {
  fetch: typeof fetch;
  getToken: (forceRefresh: boolean) => Promise<string>;
  origin: () => string;
  timeoutMs: number;
};

const defaultProfileApiDependencies: ProfileApiClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  getToken: authenticatedUserToken,
  origin: monsApiOrigin,
  timeoutMs: 20_000,
};

async function requestProfileApi<Req>(
  pathname: '/profile/shipments' | '/profile/anonymous-stripe-delivery-history' | '/admin/profile',
  data: Req,
  dependencies: ProfileApiClientDependencies,
): Promise<unknown> {
  const startedAt = Date.now();
  const callId = DEBUG_FUNCTIONS ? makeCallId() : undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await dependencies.getToken(attempt > 0);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      dependencies.timeoutMs,
    );
    try {
      if (DEBUG_FUNCTIONS) {
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
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new ProfileApiError({ code: 'unavailable', message: 'Profile API returned malformed JSON.', details: error });
      }
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new ProfileApiError(profileApiErrorPayload(payload, response.status));
      if (DEBUG_FUNCTIONS) {
        console.info(`[mons/api] ← ${pathname}`, {
          callId,
          ms: Date.now() - startedAt,
          data: summarizePayloadShape(payload),
        });
      }
      return payload;
    } catch (error) {
      if (attempt === 0 && error instanceof ProfileApiError && error.code === 'unauthenticated') continue;
      console.error(`[mons/api] ✖ ${pathname}`, {
        ...(callId ? { callId } : {}),
        ms: Date.now() - startedAt,
        error: summarizeError(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new ProfileApiError({ code: 'unauthenticated', message: 'Authentication is required.' });
}

async function callProfileApi<Req>(
  pathname: '/profile/shipments' | '/profile/anonymous-stripe-delivery-history' | '/admin/profile',
  data: Req,
): Promise<unknown> {
  return requestProfileApi(pathname, data, defaultProfileApiDependencies);
}

function profileOrders(value: unknown): DeliveryOrderSummary[] | null {
  if (!Array.isArray(value)) return null;
  const orders = value.map(parseDeliveryOrderSummary);
  return orders.every((order): order is DeliveryOrderSummary => order !== null) ? orders : null;
}

export { fetchPendingOpenBoxes } from './shopApi';
export type { DropFetchOptions } from './shopApi';

export async function revealDudes(
  owner: string,
  boxAssetId: string,
  dropId: string,
): Promise<{ signature: string; dudeIds: number[] }> {
  return callFunction<{ owner: string; boxAssetId: string; dropId: string }, { signature: string; dudeIds: number[] }>('revealDudes', {
    owner,
    boxAssetId,
    dropId,
  });
}

export async function saveEncryptedAddress(
  encrypted: string,
  country: string,
  hint: string,
  email?: string,
  countryCode?: string,
): Promise<ProfileAddress> {
  return callFunction<
    { encrypted: string; country: string; countryCode?: string; hint: string; email?: string },
    ProfileAddress
  >('saveAddress', { encrypted, country, countryCode, hint, email });
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

export async function createStripeCheckoutSession(args: StripeCheckoutSessionRequest): Promise<StripeCheckoutSessionResponse> {
  return callFunction<StripeCheckoutSessionRequest, StripeCheckoutSessionResponse>(
    'createStripeCheckoutSession',
    stripeCheckoutSessionPayload(args),
  );
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
  const resp = await callFunction<
    { limit?: number; cursor?: FulfillmentOrdersCursor | null; dropId: string },
    { orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }
  >('listFulfillmentOrders', {
    limit: args.limit,
    cursor: args.cursor || undefined,
    dropId: args.dropId,
  });
  return {
    ...resp,
    orders: (Array.isArray(resp.orders) ? resp.orders : []).map((order) => ({
      ...order,
      dropId: order.dropId || args.dropId,
    })),
  };
}

export async function listFulfillmentManualReviewCheckouts(args: {
  dropId: string;
}): Promise<{ checkouts: FulfillmentManualReviewCheckout[] }> {
  const resp = await callFunction<
    { dropId: string },
    { checkouts: FulfillmentManualReviewCheckout[] }
  >('listFulfillmentManualReviewCheckouts', { dropId: args.dropId });
  return {
    checkouts: (Array.isArray(resp.checkouts) ? resp.checkouts : []).map((checkout) => ({
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
): Promise<{ deliveryId: number; fulfillmentStatus: FulfillmentStatus | ''; fulfillmentTrackingCode?: string }> {
  return callFunction<
    { deliveryId: number; status: FulfillmentStatus | '' | null; dropId: string; trackingCode?: string },
    { deliveryId: number; fulfillmentStatus: FulfillmentStatus | ''; fulfillmentTrackingCode?: string }
  >('updateFulfillmentStatus', { deliveryId, status, dropId, ...(trackingCode != null ? { trackingCode } : {}) });
}

export async function updateFulfillmentAddress(
  deliveryId: number,
  full: string,
  dropId: string,
): Promise<{ deliveryId: number; address: FulfillmentOrder['address'] }> {
  return callFunction<
    { deliveryId: number; full: string; dropId: string },
    { deliveryId: number; address: FulfillmentOrder['address'] }
  >('updateFulfillmentAddress', { deliveryId, full, dropId });
}

export async function addFulfillmentOrderToShipStation(
  deliveryId: number,
  dropId: string,
  packageInput?: ShipStationPackageInput,
): Promise<AddFulfillmentOrderToShipStationResponse> {
  return callFunction<AddFulfillmentOrderToShipStationRequest, AddFulfillmentOrderToShipStationResponse>(
    'addFulfillmentOrderToShipStation',
    { deliveryId, dropId, ...(packageInput ? { package: packageInput } : {}) },
  );
}

export async function getFulfillmentShipStationRates(
  deliveryId: number,
  dropId: string,
  packageInput?: ShipStationPackageInput,
): Promise<GetFulfillmentShipStationRatesResponse> {
  return callFunction<GetFulfillmentShipStationRatesRequest, GetFulfillmentShipStationRatesResponse>(
    'getFulfillmentShipStationRates',
    { deliveryId, dropId, ...(packageInput ? { package: packageInput } : {}) },
  );
}

export async function purchaseFulfillmentShipStationLabel(
  args: PurchaseFulfillmentShipStationLabelRequest,
): Promise<PurchaseFulfillmentShipStationLabelResponse> {
  return callFunction<PurchaseFulfillmentShipStationLabelRequest, PurchaseFulfillmentShipStationLabelResponse>(
    'purchaseFulfillmentShipStationLabel',
    args,
  );
}

export async function getFulfillmentShipStationLabel(
  deliveryId: number,
  dropId: string,
): Promise<GetFulfillmentShipStationLabelResponse> {
  return callFunction<GetFulfillmentShipStationLabelRequest, GetFulfillmentShipStationLabelResponse>(
    'getFulfillmentShipStationLabel',
    { deliveryId, dropId },
  );
}

export async function requestDeliveryTx(
  owner: string,
  selection: DeliverySelection,
  dropId: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; dropId: string } & DeliverySelection, PreparedTxResponse>('prepareDeliveryTx', {
    owner,
    ...selection,
    dropId,
  });
}

export async function prepareReceiptTransferTx(args: {
  owner: string;
  dropId: string;
  receiptAssetId: string;
  destination: string;
}): Promise<PreparedTxResponse> {
  return callFunction<
    { owner: string; dropId: string; receiptAssetId: string; destination: string },
    PreparedTxResponse
  >('prepareReceiptTransferTx', args);
}

export async function prepareAdminIrlRedeemTx(args: {
  owner: string;
  dropId: string;
  itemIds: string[];
}): Promise<AdminIrlRedeemPreparedTxResponse> {
  return callFunction<
    { owner: string; dropId: string; itemIds: string[] },
    AdminIrlRedeemPreparedTxResponse
  >('prepareAdminIrlRedeemTx', args);
}

export async function finalizeAdminIrlRedeem(args: {
  requestId: string;
  dropId: string;
  transferSignature: string;
}): Promise<AdminIrlRedeemFinalizeResult> {
  return callFunction<
    { requestId: string; dropId: string; transferSignature: string },
    AdminIrlRedeemFinalizeResult
  >('finalizeAdminIrlRedeem', args);
}

export async function issueReceipts(
  owner: string,
  deliveryId: number,
  signature: string,
  dropId: string,
): Promise<IssueReceiptsResult> {
  return callFunction<{ owner: string; deliveryId: number; signature: string; dropId: string }, IssueReceiptsResult>(
    'issueReceipts',
    { owner, deliveryId, signature, dropId },
  );
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
  return callFunction<RecoverDeliveryOrdersArgs, RecoverDeliveryOrdersResult>('recoverMyDeliveryOrders', payload);
}

export async function requestClaimTx(
  owner: string,
  code: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; code: string }, PreparedTxResponse>('prepareIrlClaimTx', { owner, code });
}

export async function claimStripeReceipt(args: { code: string; recipient: string }): Promise<StripeReceiptClaimResult> {
  return callFunction<{ code: string; recipient: string }, StripeReceiptClaimResult>('claimStripeReceipt', {
    code: args.code,
    recipient: args.recipient,
  });
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
  options: { responseMode: 'session' },
): Promise<{ wallet: string }>;
export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
  options?: { mergeStripeDeliveryOrders?: boolean },
): Promise<{ profile: Profile }>;
export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
  options?: { responseMode?: 'session'; mergeStripeDeliveryOrders?: boolean },
): Promise<{ wallet: string } | { profile: Profile }> {
  type SolanaAuthRequest = {
    wallet: string;
    message: string;
    signature: number[];
    responseMode?: 'session';
    mergeStripeDeliveryOrders?: boolean;
  };
  const payload: SolanaAuthRequest = {
    wallet,
    message,
    signature: Array.from(signature),
  };
  if (options?.responseMode === 'session') {
    payload.responseMode = 'session';
  }
  if (options?.mergeStripeDeliveryOrders) {
    payload.mergeStripeDeliveryOrders = true;
  }
  return callFunction<SolanaAuthRequest, { wallet: string } | { profile: Profile }>('solanaAuth', payload);
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
  return callFunction<ReconcileProfileStateRequest, ReconcileProfileStateResponse>('reconcileProfileState', payload);
}

export async function loadProfileShipmentsFromServer(ownerWallet: string): Promise<DeliveryOrderSummary[]> {
  const request: GetProfileShipmentsRequest = { ownerWallet };
  const response: unknown = await callProfileApi('/profile/shipments', request);
  const payload = response && typeof response === 'object'
    ? (response as Partial<GetProfileShipmentsResponse>)
    : null;
  const orders = profileOrders(payload?.orders);
  if (
    payload?.responseMode === 'shipments' &&
    payload.wallet === ownerWallet &&
    orders
  ) {
    return orders;
  }
  throw new Error('Invalid shipment history response');
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
  return callFunction<
    { cursor?: string; pageSize?: number },
    { owners: string[]; nextCursor: string | null; hasMore: boolean }
  >('listDeliveryOrderOwners', payload);
}

export const profileApiTestHooks = {
  profileApiErrorPayload,
  profileOrders,
  requestProfileApi,
};
