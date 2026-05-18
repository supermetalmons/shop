import { randomInt } from 'crypto';
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { MintSelectionConfig, SolanaCluster } from '../config/deployment.js';
import { dropDeliveryOrderPath, dropRootPath } from '../dropPaths.js';
import {
  buildStripeCheckoutDocument,
  buildStripeCheckoutSessionMetadata,
  buildStripeOffchainAddressSnapshot,
  buildStripeOffchainDeliveryOrderDocument,
  buildStripeOffchainOrderMarkerDocument,
  decodeAdminDeliveryOrderRecord,
  deriveAdminOrderPda,
  encodeAdminDeliverVariantOrderArgs,
  isStripeOffchainFulfillmentSession,
  normalizeStripeCheckoutReturnUrl,
  resolveMintSelectionVariantIndex,
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
  STRIPE_OFFCHAIN_CURRENCY,
  stripeCheckoutOwnerId,
  stripeCheckoutSessionOrderHash,
  validateStripeCheckoutContract,
  validateStripeCheckoutDocumentData,
  type DecodedAdminDeliveryOrderRecord,
  type StripeAddressEncryptionResult,
  type StripeCheckoutDocumentData,
  type StripeOffchainDeliveryOrderDocumentInput,
} from './contract.js';
import { parseRequest } from '../request.js';
import { isStripeApiKeyForMode, stripeClientForKey, type StripeApiMode } from './client.js';

export type StripeCheckoutSessionResponse = {
  id: string;
  url: string;
  livemode: boolean;
};

export type StripeCheckoutSessionSnapshot = {
  id: string;
  livemode: boolean;
  mode?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  metadata?: Record<string, string>;
};

export type StripeCheckoutDocumentRecord = {
  ref: DocumentReference;
  checkout: any;
} & StripeCheckoutDocumentData;

export type StripeCheckoutFulfillmentEnqueueReason =
  | 'not_app_fulfillment'
  | 'already_fulfilled'
  | 'already_pending';

export type StripeCheckoutFulfillmentEnqueueResult =
  | {
      ignored: true;
      queued?: false;
      reason: StripeCheckoutFulfillmentEnqueueReason;
      dropId?: string;
      sessionId?: string;
      deliveryId?: number;
      checkoutPath?: string;
      awaitingPayment?: undefined;
    }
  | {
      queued: true;
      ignored?: false;
      dropId: string;
      sessionId: string;
      checkoutPath: string;
      deliveryId?: undefined;
      reason?: undefined;
      awaitingPayment?: undefined;
    };

export type StripeWebhookHandlingResult =
  | StripeCheckoutFulfillmentEnqueueResult
  | { ignored: true; reason: 'unsupported_event'; queued?: false }
  | { awaitingPayment: true; ignored?: false; queued?: false; sessionId?: string };

export type StripeCheckoutFulfillmentStart =
  | {
      started: true;
      checkoutRef: DocumentReference;
      checkout: StripeCheckoutDocumentRecord;
      variantKey: string;
    }
  | {
      started: false;
      reason: StripeCheckoutFulfillmentSkippedReason;
    };

export type StripeCheckoutFulfillmentSkippedReason = 'already_fulfilled' | 'processing' | 'not_pending' | 'failed';

export type StripeCheckoutFulfillmentProcessResult =
  | {
      status: 'fulfilled';
      dropId: string;
      sessionId: string;
      deliveryId?: number;
      metadataId?: number;
      receiptTx?: string | null;
    }
  | {
      status: 'failed';
      dropId: string;
      sessionId: string;
      error: unknown;
    }
  | {
      status: 'ignored';
      dropId: string;
      sessionId: string;
      reason: StripeCheckoutFulfillmentSkippedReason;
    };

export type StripeCheckoutDropRuntime = {
  dropId: string;
  cluster: SolanaCluster;
  itemsPerBox: number;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  receiptsMerkleTreeStr?: string;
  config: {
    collectionName?: string;
    namePrefix?: string;
    mintSelection?: MintSelectionConfig;
    stripeLiveUnitAmountCents?: number;
  };
};

export type StripeCheckoutOnchainConfig = {
  admin: PublicKey;
  coreCollection: PublicKey;
};

export type StripeCheckoutPrograms = {
  bubblegumProgramId: PublicKey;
  mplNoopProgramId: PublicKey;
  mplAccountCompressionProgramId: PublicKey;
  mplCoreProgramId: PublicKey;
  mplCoreCpiSigner: PublicKey;
};

type DropRuntimeDeps<Runtime extends StripeCheckoutDropRuntime> = {
  requireDropId: (rawDropId: unknown) => string;
  getDropRuntime: (dropId: string) => Runtime;
};

export type StripeCheckoutFlowDeps<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
> = DropRuntimeDeps<Runtime> & {
  connection: (dropRuntime: Runtime) => Connection;
  fetchCheckoutConfig: (params: { dropRuntime: Runtime; conn: Connection; context: string }) => Promise<Config>;
  ensureOnchainCoreConfig: (dropRuntime: Runtime) => Promise<Config>;
  requireStripeCheckoutVariantAvailable: (params: {
    dropRuntime: Runtime;
    cfg: Config;
    variantKey: string;
  }) => void;
  requireStripeCheckoutFulfillmentPrerequisites: (cfg: Config) => void;
  requireStripeCheckoutCollectionMatchesConfig: (
    dropRuntime: Runtime,
    cfg: Config,
    code?: 'failed-precondition' | 'unavailable',
  ) => void;
  cosigner: () => Keypair;
  encryptAddress: (plaintext: string) => StripeAddressEncryptionResult | null;
  normalizeCountryCode: (country?: string) => string;
  buildTx: (
    instructions: TransactionInstruction[],
    payer: PublicKey,
    blockhash: string,
    signers: Keypair[],
  ) => VersionedTransaction;
  sendAndConfirmSignedTx: (
    conn: Connection,
    tx: VersionedTransaction,
    label: string,
    opts?: { sendTimeoutMs?: number; confirmTimeoutMs?: number },
  ) => Promise<string>;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  isAlreadyExistsError: (err: unknown) => boolean;
  summarizeError: (err: unknown) => unknown;
  programs: StripeCheckoutPrograms;
  rpcTimeoutMs: number;
  txSendTimeoutMs: number;
  txConfirmTimeoutMs: number;
};

type StripeOffchainDeliveryOrderMarker = { deliveryId: number; metadataId?: number; receiptTx?: string | null };
type StripeOffchainDeliveryOrderDraft = Omit<StripeOffchainDeliveryOrderDocumentInput, 'deliveryId'>;

const STRIPE_CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9_:-]{4,256}$/;
const STRIPE_MANUAL_REFUND_REASON = 'fulfillment_failed_after_payment';

function stripeCheckoutPath(dropId: string, sessionId: string): string {
  return `${dropRootPath(dropId)}/stripeCheckouts/${requireStripeCheckoutSessionId(sessionId)}`;
}

export function stripeTestApiKey(apiKeys: readonly string[]): string {
  return stripeApiKeyForMode(apiKeys, 'test');
}

export function stripeApiKeyForMode(apiKeys: readonly string[], mode: StripeApiMode): string {
  const key = apiKeys.map((value) => String(value || '').trim()).find((value) => isStripeApiKeyForMode(value, mode));
  if (!key) throw new HttpsError('failed-precondition', `Stripe ${mode} key is not configured.`);
  return key;
}

function stripeApiModeForCluster(cluster: SolanaCluster): StripeApiMode {
  if (cluster === 'devnet') return 'test';
  if (cluster === 'mainnet-beta') return 'live';
  throw new HttpsError('failed-precondition', 'Stripe checkout is only enabled for devnet and mainnet drops.');
}

function requireStripeUnitAmountCents(value: unknown, label: string): number {
  const parsed = Math.floor(Number(value));
  if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 99_999_999) return parsed;
  throw new HttpsError('failed-precondition', `${label} must be an integer from 50 to 99999999.`);
}

export function stripeCheckoutUnitAmountCentsForDrop(dropRuntime: StripeCheckoutDropRuntime): number {
  const mode = stripeApiModeForCluster(dropRuntime.cluster);
  if (mode === 'live') {
    const configured = dropRuntime.config.stripeLiveUnitAmountCents;
    if (configured == null) {
      throw new HttpsError('failed-precondition', 'Stripe live unit amount is not configured for this drop.');
    }
    return requireStripeUnitAmountCents(configured, 'Stripe live unit amount');
  }

  const parsed = Math.floor(Number(process.env.STRIPE_TEST_UNIT_AMOUNT_CENTS));
  if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 99_999_999) return parsed;
  return 100;
}

export function requireStripeCheckoutSessionId(rawSessionId: unknown): string {
  const sessionId = String(rawSessionId || '').trim();
  if (!STRIPE_CHECKOUT_SESSION_ID_RE.test(sessionId)) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session id is invalid');
  }
  return sessionId;
}

type StripeAllowedCountry = NonNullable<Stripe.Checkout.Session['shipping_address_collection']>['allowed_countries'][number];

const STRIPE_SHIPPING_ALLOWED_COUNTRIES = [
  'AR',
  'AM',
  'AU',
  'AT',
  'BE',
  'BR',
  'BG',
  'CA',
  'CL',
  'CN',
  'CO',
  'CR',
  'HR',
  'CY',
  'CZ',
  'DK',
  'DO',
  'EG',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HK',
  'HU',
  'IS',
  'IN',
  'ID',
  'IE',
  'IL',
  'IT',
  'JP',
  'KE',
  'LV',
  'LT',
  'LU',
  'MY',
  'MX',
  'MA',
  'NL',
  'NZ',
  'NG',
  'NO',
  'PK',
  'PE',
  'PH',
  'PL',
  'PT',
  'RO',
  'SA',
  'SG',
  'SK',
  'SI',
  'ZA',
  'KR',
  'ES',
  'SE',
  'CH',
  'TW',
  'TH',
  'TR',
  'UA',
  'AE',
  'GB',
  'US',
  'VN',
] satisfies readonly StripeAllowedCountry[];

export function stripeCheckoutShippingParams(): Pick<
  Stripe.Checkout.SessionCreateParams,
  'phone_number_collection' | 'shipping_address_collection'
> {
  return {
    phone_number_collection: { enabled: true },
    shipping_address_collection: {
      allowed_countries: [...STRIPE_SHIPPING_ALLOWED_COUNTRIES],
    },
  };
}

function requestOrigin(request: CallableRequest<any>): string {
  const rawOrigin = request.rawRequest?.headers?.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  return typeof origin === 'string' ? origin.trim() : '';
}

function stripeCheckoutReturnUrlAllowedOrigins(): string[] {
  return String(process.env.STRIPE_RETURN_URL_ALLOWED_ORIGINS || '')
    .split(/[,\s]+/)
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function checkoutReturnUrl(
  request: CallableRequest<any>,
  rawReturnUrl: string | undefined,
  status: 'success' | 'cancel',
): string {
  try {
    return normalizeStripeCheckoutReturnUrl({
      requestOrigin: requestOrigin(request),
      rawReturnUrl,
      status,
      allowedOrigins: stripeCheckoutReturnUrlAllowedOrigins(),
    });
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof Error ? err.message : String(err));
  }
}

function normalizeStripeVariantKey(
  dropRuntime: StripeCheckoutDropRuntime,
  variantKey: string | undefined,
): string | undefined {
  const value = String(variantKey || '').trim();
  if (!value) return undefined;
  const selection = dropRuntime.config.mintSelection;
  if (selection?.kind === 'size') {
    try {
      return selection.options[resolveMintSelectionVariantIndex(selection, value)].key;
    } catch {
      throw new HttpsError('invalid-argument', 'Invalid variantKey');
    }
  }
  return value.slice(0, 64);
}

function stripeCheckoutProductName(dropRuntime: StripeCheckoutDropRuntime, variantKey: string | undefined, mode: StripeApiMode): string {
  const collectionName = dropRuntime.config.collectionName || dropRuntime.dropId;
  const itemName = dropRuntime.config.namePrefix || 'item';
  const variantSuffix = variantKey ? ` ${variantKey}` : '';
  const modePrefix = mode === 'test' ? 'test ' : '';
  return `${collectionName} ${modePrefix}${itemName}${variantSuffix}`.slice(0, 200);
}

async function createStripeCheckoutSession(
  params: Stripe.Checkout.SessionCreateParams,
  apiKey: string,
  mode: StripeApiMode,
): Promise<StripeCheckoutSessionResponse> {
  const stripe = await stripeClientForKey(apiKey, mode);
  const session = await stripe.checkout.sessions.create(params);
  if (typeof session.id !== 'string' || typeof session.url !== 'string') {
    throw new HttpsError('unavailable', 'Stripe response did not include a checkout URL');
  }
  if (Boolean(session.livemode) !== (mode === 'live')) {
    throw new HttpsError('failed-precondition', 'Stripe response mode does not match the configured drop mode');
  }
  return { id: session.id, url: session.url, livemode: Boolean(session.livemode) };
}

async function fetchStripeCheckoutLineItems(stripe: Stripe, session: Stripe.Checkout.Session) {
  if (!session.id) throw new HttpsError('failed-precondition', 'Stripe checkout session id is missing');
  return stripe.checkout.sessions.listLineItems(session.id, { limit: 10, expand: ['data.price'] });
}

async function fetchStripeCheckoutSession(sessionId: string, apiKey: string, mode: StripeApiMode): Promise<{
  session: Stripe.Checkout.Session;
  stripe: Stripe;
}> {
  const normalizedSessionId = requireStripeCheckoutSessionId(sessionId);
  const stripe = await stripeClientForKey(apiKey, mode);
  return { session: await stripe.checkout.sessions.retrieve(normalizedSessionId), stripe };
}

export function stripeWebhookRawBody(req: any): Buffer {
  const rawBody = req?.rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  if (Buffer.isBuffer(req?.body)) return req.body;
  if (typeof req?.body === 'string') return Buffer.from(req.body, 'utf8');
  throw new HttpsError('invalid-argument', 'Missing raw request body for Stripe webhook signature verification');
}

export function stripeWebhookSignature(req: any): string {
  const raw = req?.headers?.['stripe-signature'];
  const signature = Array.isArray(raw) ? raw[0] : raw;
  if (typeof signature !== 'string' || !signature.trim()) {
    throw new HttpsError('invalid-argument', 'Missing Stripe-Signature header');
  }
  return signature;
}

function requireStripeOffchainAddressSnapshot(params: {
  session: Stripe.Checkout.Session;
  encryptAddress: (plaintext: string) => StripeAddressEncryptionResult | null;
  normalizeCountryCode: (country?: string) => string;
}): Record<string, unknown> {
  try {
    return buildStripeOffchainAddressSnapshot(params);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('failed-precondition', err instanceof Error ? err.message : String(err), {
      sessionId: params.session.id,
    });
  }
}

function stripeCheckoutSessionSnapshot(session: Stripe.Checkout.Session): StripeCheckoutSessionSnapshot {
  const sessionId = requireStripeCheckoutSessionId(session.id);
  const metadata: Record<string, string> = {};
  Object.entries(session.metadata || {}).forEach(([key, value]) => {
    if (typeof value === 'string') metadata[key] = value;
  });

  const snapshot: StripeCheckoutSessionSnapshot = {
    id: sessionId,
    livemode: Boolean(session.livemode),
    metadata,
  };
  if (session.mode !== undefined) snapshot.mode = session.mode;
  if (session.payment_status !== undefined) snapshot.payment_status = session.payment_status;
  if (session.amount_total !== undefined) snapshot.amount_total = session.amount_total;
  if (session.currency !== undefined) snapshot.currency = session.currency;
  return snapshot;
}

function requireStripeCheckoutFulfillmentContext<Runtime extends StripeCheckoutDropRuntime>(
  session: Stripe.Checkout.Session,
  deps: DropRuntimeDeps<Runtime>,
): { dropId: string; sessionId: string; dropRuntime: Runtime; variantKey: string } {
  const sessionId = requireStripeCheckoutSessionId(session.id);
  if (!isStripeOffchainFulfillmentSession(session)) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session is not app-created off-chain fulfillment', {
      sessionId,
    });
  }

  const dropIdRaw = session.metadata?.dropId;
  const variantKeyRaw = session.metadata?.variantKey;
  if (!dropIdRaw || !variantKeyRaw) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session is missing off-chain fulfillment metadata', {
      sessionId,
    });
  }

  const dropId = deps.requireDropId(dropIdRaw);
  const dropRuntime = deps.getDropRuntime(dropId);
  const variantKey = normalizeStripeVariantKey(dropRuntime, variantKeyRaw);
  if (!variantKey) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session is missing variantKey', { dropId, sessionId });
  }
  return { dropId, sessionId, dropRuntime, variantKey };
}

function requireAppCreatedStripeCheckoutDocumentData(params: {
  dropId: string;
  variantKey: string;
  sessionId: string;
  expectedLivemode?: boolean;
  checkout: any;
}): StripeCheckoutDocumentData {
  try {
    return validateStripeCheckoutDocumentData(params);
  } catch (err) {
    throw new HttpsError('failed-precondition', err instanceof Error ? err.message : String(err), {
      dropId: params.dropId,
      sessionId: params.sessionId,
    });
  }
}

function requireAppCreatedStripeCheckoutSnapshot(params: {
  dropId: string;
  variantKey: string;
  sessionId: string;
  expectedLivemode?: boolean;
  ref: DocumentReference;
  snap: DocumentSnapshot;
}): StripeCheckoutDocumentRecord {
  if (!params.snap.exists) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session was not created by this app', {
      dropId: params.dropId,
      sessionId: params.sessionId,
    });
  }
  const checkout = params.snap.data() as any;
  const checkoutData = requireAppCreatedStripeCheckoutDocumentData({
    dropId: params.dropId,
    variantKey: params.variantKey,
    sessionId: params.sessionId,
    expectedLivemode: params.expectedLivemode,
    checkout,
  });
  return { ref: params.ref, checkout, ...checkoutData };
}

function stripeCheckoutFulfillmentClearUpdate(): Record<string, unknown> {
  return {
    lastFulfillmentError: FieldValue.delete(),
    manualRefundReviewRequired: FieldValue.delete(),
    manualRefundReviewReason: FieldValue.delete(),
    failedAt: FieldValue.delete(),
  };
}

function stripeCheckoutFulfilledUpdate(params: {
  deliveryId: number;
  metadataId?: number;
  receiptTx?: string | null;
}): Record<string, unknown> {
  const metadataId = Math.floor(Number(params.metadataId));
  return {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    deliveryId: params.deliveryId,
    ...(Number.isFinite(metadataId) && metadataId > 0 ? { metadataId } : {}),
    ...(typeof params.receiptTx === 'string' || params.receiptTx === null ? { receiptTx: params.receiptTx } : {}),
    fulfilledAt: FieldValue.serverTimestamp(),
    ...stripeCheckoutFulfillmentClearUpdate(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function stripeCheckoutWebhookSeenUpdate(event: Stripe.Event): Record<string, unknown> {
  return {
    lastStripeWebhookEventId: event.id,
    stripeWebhookEventIds: FieldValue.arrayUnion(event.id),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function receiptTxMaybe(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  return undefined;
}

function readStripeOffchainDeliveryOrderMarker(marker: { get(fieldPath: string): unknown }): StripeOffchainDeliveryOrderMarker | null {
  const deliveryId = Math.floor(Number(marker.get('deliveryId')));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;
  const metadataId = Math.floor(Number(marker.get('metadataId')));
  const receiptTx = receiptTxMaybe(marker.get('receiptTx'));
  return {
    deliveryId,
    ...(Number.isFinite(metadataId) && metadataId > 0 ? { metadataId } : {}),
    ...(typeof receiptTx === 'string' || receiptTx === null ? { receiptTx } : {}),
  };
}

async function fetchStripeOffchainDeliveryOrderMarker(params: {
  db: Firestore;
  dropId: string;
  orderHashHex: string;
}): Promise<StripeOffchainDeliveryOrderMarker | null> {
  const marker = await params.db.doc(`${dropRootPath(params.dropId)}/offchainOrders/${params.orderHashHex}`).get();
  return marker.exists ? readStripeOffchainDeliveryOrderMarker(marker) : null;
}

async function createOrGetStripeOffchainDeliveryOrder(params: {
  db: Firestore;
  order: StripeOffchainDeliveryOrderDraft;
  checkoutRef: DocumentReference;
  isAlreadyExistsError: (err: unknown) => boolean;
}): Promise<{ deliveryId: number }> {
  const { db, order, checkoutRef } = params;
  const { dropId, orderHashHex } = order;
  const markerRef = db.doc(`${dropRootPath(dropId)}/offchainOrders/${orderHashHex}`);
  const MAX_DELIVERY_ID_ATTEMPTS = 16;

  for (let attempt = 0; attempt < MAX_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const orderRef = db.doc(dropDeliveryOrderPath(dropId, candidate));

    try {
      const deliveryId = await db.runTransaction(async (tx) => {
        const marker = await tx.get(markerRef);
        if (marker.exists) {
          const existingOrder = readStripeOffchainDeliveryOrderMarker(marker);
          if (existingOrder) {
            tx.update(
              checkoutRef,
              stripeCheckoutFulfilledUpdate({
                deliveryId: existingOrder.deliveryId,
                metadataId: existingOrder.metadataId,
                receiptTx: existingOrder.receiptTx,
              }),
            );
            return existingOrder.deliveryId;
          }
        }

        const deliveryOrder = { ...order, deliveryId: candidate };
        tx.create(orderRef, {
          ...buildStripeOffchainDeliveryOrderDocument(deliveryOrder),
          processedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.create(markerRef, {
          ...buildStripeOffchainOrderMarkerDocument(deliveryOrder),
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.update(
          checkoutRef,
          stripeCheckoutFulfilledUpdate({
            deliveryId: candidate,
            metadataId: order.metadataId,
            receiptTx: order.receiptTx,
          }),
        );
        return candidate;
      });
      return { deliveryId };
    } catch (err) {
      if (params.isAlreadyExistsError(err)) continue;
      throw err;
    }
  }

  throw new HttpsError('unavailable', 'Failed to allocate off-chain delivery id (try again)');
}

async function fetchAdminDeliveryOrderRecord(params: {
  conn: Connection;
  dropRuntime: StripeCheckoutDropRuntime;
  adminOrderPda: PublicKey;
  context: string;
  deps: Pick<StripeCheckoutFlowDeps<StripeCheckoutDropRuntime, StripeCheckoutOnchainConfig>, 'withTimeout' | 'rpcTimeoutMs'>;
}): Promise<DecodedAdminDeliveryOrderRecord | null> {
  const { conn, dropRuntime, adminOrderPda, context, deps } = params;
  const info = await deps.withTimeout(conn.getAccountInfo(adminOrderPda, { commitment: 'confirmed' }), deps.rpcTimeoutMs, context);
  if (!info) return null;
  if (!info.owner.equals(dropRuntime.boxMinterProgramId)) {
    if (info.owner.equals(SystemProgram.programId) && info.data.length === 0) {
      return null;
    }
    throw new HttpsError('failed-precondition', 'Admin order PDA has an unexpected owner', {
      adminOrderPda: adminOrderPda.toBase58(),
      owner: info.owner.toBase58(),
      expectedOwner: dropRuntime.boxMinterProgramId.toBase58(),
    });
  }
  return decodeAdminDeliveryOrderRecord(Buffer.from(info.data));
}

async function fulfillStripeCheckoutSession<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
>(params: {
  db: Firestore;
  session: Stripe.Checkout.Session;
  stripe: Stripe;
  checkout: StripeCheckoutDocumentRecord;
  expectedDropId: string;
  expectedSessionId: string;
  expectedVariantKey: string;
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
}): Promise<{
  dropId: string;
  deliveryId?: number;
  metadataId?: number;
  receiptTx?: string | null;
}> {
  const { db, session, stripe, checkout, deps } = params;
  const sessionId = requireStripeCheckoutSessionId(session.id);
  if (sessionId !== params.expectedSessionId) {
    throw new HttpsError('failed-precondition', 'Fetched Stripe checkout session id does not match the pending fulfillment', {
      expectedSessionId: params.expectedSessionId,
      actualSessionId: sessionId,
    });
  }
  const metadataContext = requireStripeCheckoutFulfillmentContext(session, deps);
  const dropId = deps.requireDropId(params.expectedDropId);
  const dropRuntime = deps.getDropRuntime(dropId);
  const mode = stripeApiModeForCluster(dropRuntime.cluster);
  const expectedLivemode = mode === 'live';
  const variantKey = normalizeStripeVariantKey(dropRuntime, params.expectedVariantKey);
  if (!variantKey) {
    throw new HttpsError('failed-precondition', 'Stripe checkout fulfillment is missing variantKey', {
      dropId,
      sessionId,
    });
  }
  if (metadataContext.dropId !== dropId || metadataContext.variantKey !== variantKey) {
    throw new HttpsError('failed-precondition', 'Stripe checkout metadata does not match the pending fulfillment', {
      sessionId,
      expectedDropId: dropId,
      actualDropId: metadataContext.dropId,
      expectedVariantKey: variantKey,
      actualVariantKey: metadataContext.variantKey,
    });
  }
  if (Boolean(session.livemode) !== expectedLivemode || checkout.livemode !== expectedLivemode) {
    throw new HttpsError('failed-precondition', 'Stripe checkout mode does not match the drop cluster', {
      dropId,
      sessionId,
      cluster: dropRuntime.cluster,
      sessionLivemode: Boolean(session.livemode),
      checkoutLivemode: checkout.livemode,
    });
  }
  if (Math.floor(Number(dropRuntime.itemsPerBox)) !== 0) {
    throw new HttpsError('failed-precondition', 'Off-chain variant fulfillment requires a direct-delivery drop', { dropId });
  }
  if (dropRuntime.config.mintSelection?.kind !== 'size') {
    throw new HttpsError('failed-precondition', 'Off-chain variant fulfillment requires a size-variant drop', { dropId });
  }
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError('unavailable', 'Receipt cNFT tree is not configured', { dropId });
  }

  const variantIndex = resolveMintSelectionVariantIndex(dropRuntime.config.mintSelection, variantKey);
  const orderHash = stripeCheckoutSessionOrderHash(sessionId, Boolean(session.livemode));
  const orderHashHex = orderHash.toString('hex');
  const existingOrder = await fetchStripeOffchainDeliveryOrderMarker({ db, dropId, orderHashHex });
  if (existingOrder) {
    await checkout.ref.update(
      stripeCheckoutFulfilledUpdate({
        deliveryId: existingOrder.deliveryId,
        metadataId: existingOrder.metadataId,
        receiptTx: existingOrder.receiptTx,
      }),
    );
    return {
      dropId,
      deliveryId: existingOrder.deliveryId,
      metadataId: existingOrder.metadataId,
      receiptTx: existingOrder.receiptTx ?? null,
    };
  }

  const lineItems = await fetchStripeCheckoutLineItems(stripe, session);
  try {
    validateStripeCheckoutContract({
      session,
      lineItems,
      expectedUnitAmountCents: checkout.unitAmountCents,
      expectedCurrency: STRIPE_OFFCHAIN_CURRENCY,
      expectedLivemode,
    });
  } catch (err) {
    throw new HttpsError('failed-precondition', err instanceof Error ? err.message : String(err), {
      sessionId: session.id,
    });
  }
  const addressSnapshot = requireStripeOffchainAddressSnapshot({
    session,
    encryptAddress: deps.encryptAddress,
    normalizeCountryCode: deps.normalizeCountryCode,
  });
  const conn = deps.connection(dropRuntime);

  const cfg = await deps.ensureOnchainCoreConfig(dropRuntime);
  const signer = deps.cosigner();
  if (!signer.publicKey.equals(cfg.admin)) {
    throw new HttpsError('unavailable', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfg.admin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  deps.requireStripeCheckoutCollectionMatchesConfig(dropRuntime, cfg, 'unavailable');

  const receiptOwner = cfg.admin;
  const [adminOrderPda, orderBump] = deriveAdminOrderPda(dropRuntime.boxMinterProgramId, dropRuntime.boxMinterConfigPda, orderHash);
  let record = await fetchAdminDeliveryOrderRecord({
    conn,
    dropRuntime,
    adminOrderPda,
    context: 'getAccountInfo:adminOrder',
    deps,
  });
  let receiptTx: string | null = null;

  if (!record) {
    const treeConfig = PublicKey.findProgramAddressSync([dropRuntime.receiptsMerkleTree.toBuffer()], deps.programs.bubblegumProgramId)[0];
    const ix = new TransactionInstruction({
      programId: dropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: receiptOwner, isSigner: false, isWritable: false },
        { pubkey: adminOrderPda, isSigner: false, isWritable: true },
        { pubkey: dropRuntime.receiptsMerkleTree, isSigner: false, isWritable: true },
        { pubkey: treeConfig, isSigner: false, isWritable: true },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
        { pubkey: deps.programs.bubblegumProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplNoopProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplAccountCompressionProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: deps.programs.mplCoreCpiSigner, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAdminDeliverVariantOrderArgs({
        orderHash,
        variantIndex,
        quantity: STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
      }),
    });
    const { blockhash } = await deps.withTimeout(
      conn.getLatestBlockhash('confirmed'),
      deps.rpcTimeoutMs,
      'getLatestBlockhash:stripeWebhook',
    );
    const tx = deps.buildTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix], signer.publicKey, blockhash, [signer]);
    try {
      receiptTx = await deps.sendAndConfirmSignedTx(conn, tx, 'adminDeliverVariantOrder', {
        sendTimeoutMs: deps.txSendTimeoutMs,
        confirmTimeoutMs: deps.txConfirmTimeoutMs,
      });
    } catch (err) {
      const maybeRecord = await fetchAdminDeliveryOrderRecord({
        conn,
        dropRuntime,
        adminOrderPda,
        context: 'getAccountInfo:adminOrderAfterError',
        deps,
      }).catch(() => null);
      if (!maybeRecord) throw err;
      record = maybeRecord;
    }
  }

  if (!record) {
    record = await fetchAdminDeliveryOrderRecord({
      conn,
      dropRuntime,
      adminOrderPda,
      context: 'getAccountInfo:adminOrderAfterSend',
      deps,
    });
  }
  if (!record) {
    throw new HttpsError('unavailable', 'Admin order record was not created', {
      adminOrderPda: adminOrderPda.toBase58(),
      dropId,
    });
  }
  if (!record.orderHash.equals(orderHash)) {
    throw new HttpsError('failed-precondition', 'Admin order record hash mismatch', { dropId, adminOrderPda: adminOrderPda.toBase58() });
  }
  if (record.variantIndex !== variantIndex) {
    throw new HttpsError('failed-precondition', 'Admin order record variant mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedVariantIndex: variantIndex,
      actualVariantIndex: record.variantIndex,
    });
  }
  if (record.quantity !== STRIPE_OFFCHAIN_CHECKOUT_QUANTITY) {
    throw new HttpsError('failed-precondition', 'Admin order record quantity mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedQuantity: STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
      actualQuantity: record.quantity,
    });
  }
  if (record.bump !== orderBump) {
    throw new HttpsError('failed-precondition', 'Admin order record bump mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedBump: orderBump,
      actualBump: record.bump,
    });
  }
  if (!record.receiptOwner.equals(receiptOwner)) {
    throw new HttpsError('failed-precondition', 'Admin order record receipt owner mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedOwner: receiptOwner.toBase58(),
      actualOwner: record.receiptOwner.toBase58(),
    });
  }
  if (record.firstMetadataId < 1) {
    throw new HttpsError('failed-precondition', 'Admin order record metadata id is invalid', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      firstMetadataId: record.firstMetadataId,
    });
  }
  const metadataId = record.firstMetadataId;

  const order = await createOrGetStripeOffchainDeliveryOrder({
    db,
    order: {
      dropId,
      orderHashHex,
      owner: stripeCheckoutOwnerId(checkout.uid),
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
      firebaseUid: checkout.uid,
      receiptOwner: receiptOwner.toBase58(),
      metadataId,
      variantKey,
      stripeSession: session,
      receiptTx,
      addressSnapshot,
    },
    checkoutRef: checkout.ref,
    isAlreadyExistsError: deps.isAlreadyExistsError,
  });

  return { dropId, deliveryId: order.deliveryId, metadataId, receiptTx };
}

export async function enqueueStripeCheckoutFulfillment<Runtime extends StripeCheckoutDropRuntime>(params: {
  db: Firestore;
  event: Stripe.Event;
  session: Stripe.Checkout.Session;
  requireDropId: (rawDropId: unknown) => string;
  getDropRuntime: (dropId: string) => Runtime;
}): Promise<StripeCheckoutFulfillmentEnqueueResult> {
  const { db, event, session } = params;
  const sessionId = requireStripeCheckoutSessionId(session.id);
  if (!isStripeOffchainFulfillmentSession(session)) {
    return { ignored: true, reason: 'not_app_fulfillment', sessionId };
  }

  const context = requireStripeCheckoutFulfillmentContext(session, params);
  const { dropId, variantKey } = context;
  const expectedLivemode = stripeApiModeForCluster(context.dropRuntime.cluster) === 'live';
  if (Boolean(session.livemode) !== expectedLivemode) {
    throw new HttpsError('failed-precondition', 'Stripe checkout mode does not match the drop cluster', {
      dropId,
      sessionId,
      cluster: context.dropRuntime.cluster,
      sessionLivemode: Boolean(session.livemode),
      expectedLivemode,
    });
  }
  const checkoutRef = db.doc(stripeCheckoutPath(dropId, sessionId));

  return db.runTransaction(async (tx) => {
    const checkoutSnap = await tx.get(checkoutRef);
    const checkout = requireAppCreatedStripeCheckoutSnapshot({
      dropId,
      variantKey,
      sessionId,
      expectedLivemode,
      ref: checkoutRef,
      snap: checkoutSnap,
    });
    if (checkout.status === STRIPE_CHECKOUT_STATUS.FULFILLED) {
      tx.update(checkoutRef, stripeCheckoutWebhookSeenUpdate(event));
      return {
        ignored: true,
        reason: 'already_fulfilled',
        dropId,
        sessionId,
        ...(checkout.deliveryId ? { deliveryId: checkout.deliveryId } : {}),
      };
    }
    if (
      checkout.status !== STRIPE_CHECKOUT_STATUS.CREATED &&
      checkout.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED
    ) {
      tx.update(checkoutRef, stripeCheckoutWebhookSeenUpdate(event));
      return { ignored: true, reason: 'already_pending', dropId, sessionId, checkoutPath: checkoutRef.path };
    }

    tx.update(checkoutRef, {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      paymentStatus: session.payment_status || null,
      stripeSessionSummary: stripeCheckoutSessionSnapshot(session),
      ...stripeCheckoutWebhookSeenUpdate(event),
      lastStripeWebhookEventType: event.type,
      fulfillmentRequestedAt: FieldValue.serverTimestamp(),
      processingStartedAt: FieldValue.delete(),
      ...stripeCheckoutFulfillmentClearUpdate(),
    });
    return { queued: true, dropId, sessionId, checkoutPath: checkoutRef.path };
  });
}

export async function handleStripeWebhookEvent<Runtime extends StripeCheckoutDropRuntime>(params: {
  db: Firestore;
  event: Stripe.Event;
  requireDropId: (rawDropId: unknown) => string;
  getDropRuntime: (dropId: string) => Runtime;
}): Promise<StripeWebhookHandlingResult> {
  const { event } = params;
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return { ignored: true, reason: 'unsupported_event' };
  }
  const session = event.data.object as Stripe.Checkout.Session;
  const appFulfillmentMode = isStripeOffchainFulfillmentSession(session);
  if (event.type === 'checkout.session.completed' && session.payment_status !== 'paid') {
    if (!appFulfillmentMode) return { ignored: true, reason: 'not_app_fulfillment', sessionId: session.id };
    return { awaitingPayment: true, sessionId: session.id };
  }
  return enqueueStripeCheckoutFulfillment({ ...params, session });
}

export async function startStripeCheckoutFulfillmentDocument(params: {
  dropId: string;
  sessionId: string;
  checkoutRef: DocumentReference;
  expectedLivemode?: boolean;
}): Promise<StripeCheckoutFulfillmentStart> {
  const { dropId, sessionId, checkoutRef } = params;
  return checkoutRef.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(checkoutRef);
    if (!snap.exists) return { started: false, reason: 'not_pending' };
    const checkoutData = snap.data() as any;
    const status = typeof checkoutData?.status === 'string' ? checkoutData.status : '';
    if (status === STRIPE_CHECKOUT_STATUS.FULFILLED) return { started: false, reason: 'already_fulfilled' };
    if (status === STRIPE_CHECKOUT_STATUS.PROCESSING) return { started: false, reason: 'processing' };
    if (status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED) return { started: false, reason: 'failed' };
    if (status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING) return { started: false, reason: 'not_pending' };

    const variantKey = String(checkoutData?.variantKey || '').trim();
    if (!variantKey) {
      throw new HttpsError('failed-precondition', 'Stripe checkout fulfillment is missing variantKey', {
        dropId,
        sessionId,
      });
    }
    const checkout = requireAppCreatedStripeCheckoutSnapshot({
      dropId,
      variantKey,
      sessionId,
      expectedLivemode: params.expectedLivemode,
      ref: checkoutRef,
      snap,
    });

    tx.update(checkoutRef, {
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastFulfillmentError: FieldValue.delete(),
      manualRefundReviewRequired: FieldValue.delete(),
      manualRefundReviewReason: FieldValue.delete(),
      failedAt: FieldValue.delete(),
    });
    return { started: true, checkoutRef, checkout, variantKey };
  });
}

export async function markStripeCheckoutFulfillmentFailed(
  checkoutRef: DocumentReference,
  err: unknown,
  params: {
    summarizeError: (err: unknown) => unknown;
    sessionIdentity?: { dropId: string; sessionId: string };
  },
): Promise<{ status: 'failed' | 'already_fulfilled' }> {
  const error = params.summarizeError(err);
  const identityUpdate = params.sessionIdentity
    ? { dropId: params.sessionIdentity.dropId, sessionId: params.sessionIdentity.sessionId }
    : {};
  return checkoutRef.firestore.runTransaction(async (tx) => {
    const checkoutSnap = await tx.get(checkoutRef);
    const checkout = checkoutSnap.exists ? (checkoutSnap.data() as any) : null;
    const checkoutStatus = typeof checkout?.status === 'string' ? checkout.status : '';

    if (checkoutStatus === STRIPE_CHECKOUT_STATUS.FULFILLED) {
      return { status: 'already_fulfilled' as const };
    }

    tx.set(
      checkoutRef,
      {
        ...identityUpdate,
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
        failedAt: FieldValue.serverTimestamp(),
        lastFulfillmentError: error,
        manualRefundReviewRequired: true,
        manualRefundReviewReason: STRIPE_MANUAL_REFUND_REASON,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { status: 'failed' as const };
  });
}

export async function processStripeCheckoutFulfillmentDocument<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
>(params: {
  db: Firestore;
  dropId: string;
  sessionId: string;
  checkoutRef: DocumentReference;
  apiKeys: readonly string[];
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
}): Promise<StripeCheckoutFulfillmentProcessResult> {
  const { db, dropId, sessionId, checkoutRef, deps } = params;
  const dropRuntime = deps.getDropRuntime(dropId);
  const mode = stripeApiModeForCluster(dropRuntime.cluster);
  const expectedLivemode = mode === 'live';

  let started: StripeCheckoutFulfillmentStart;
  try {
    started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef, expectedLivemode });
  } catch (err) {
    await markStripeCheckoutFulfillmentFailed(checkoutRef, err, {
      summarizeError: deps.summarizeError,
      sessionIdentity: { dropId, sessionId },
    });
    return { status: 'failed', dropId, sessionId, error: deps.summarizeError(err) };
  }

  if (started.started === false) {
    return { status: 'ignored', dropId, sessionId, reason: started.reason };
  }

  try {
    const apiKey = stripeApiKeyForMode(params.apiKeys, mode);
    const { session, stripe } = await fetchStripeCheckoutSession(sessionId, apiKey, mode);
    const result = await fulfillStripeCheckoutSession({
      db,
      session,
      stripe,
      checkout: started.checkout,
      expectedDropId: dropId,
      expectedSessionId: sessionId,
      expectedVariantKey: started.variantKey,
      deps,
    });
    return { status: 'fulfilled', sessionId, ...result };
  } catch (err) {
    await markStripeCheckoutFulfillmentFailed(started.checkoutRef, err, {
      summarizeError: deps.summarizeError,
      sessionIdentity: { dropId, sessionId },
    });
    return { status: 'failed', dropId, sessionId, error: deps.summarizeError(err) };
  }
}

export async function createStripeCheckoutSessionForRequest<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
>(params: {
  db: Firestore;
  request: CallableRequest<any>;
  uid: string;
  apiKeys: readonly string[];
  allowedMode?: StripeApiMode;
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
}): Promise<StripeCheckoutSessionResponse> {
  const schema = z.object({
    dropId: z.string().min(1).max(64),
    variantKey: z.string().min(1).max(64).optional(),
    returnUrl: z.string().url().max(2048).optional(),
  });
  const {
    dropId: requestDropId,
    variantKey: rawVariantKey,
    returnUrl,
  } = parseRequest(schema, params.request.data);
  const { deps } = params;
  const dropId = deps.requireDropId(requestDropId);
  const dropRuntime = deps.getDropRuntime(dropId);
  const mode = stripeApiModeForCluster(dropRuntime.cluster);
  if (params.allowedMode && params.allowedMode !== mode) {
    const clusterLabel = params.allowedMode === 'test' ? 'devnet' : 'mainnet';
    throw new HttpsError(
      'failed-precondition',
      `Stripe ${params.allowedMode} checkout is only enabled for ${clusterLabel} drops.`,
    );
  }
  if (Math.floor(Number(dropRuntime.itemsPerBox)) !== 0 || dropRuntime.config.mintSelection?.kind !== 'size') {
    throw new HttpsError('failed-precondition', 'Stripe checkout is only enabled for direct-delivery size drops.');
  }
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError('failed-precondition', 'Stripe checkout requires a configured receipt cNFT tree.');
  }

  const apiKey = stripeApiKeyForMode(params.apiKeys, mode);
  const variantKey = normalizeStripeVariantKey(dropRuntime, rawVariantKey);
  if (!variantKey) {
    throw new HttpsError('invalid-argument', 'variantKey is required for Stripe checkout.');
  }
  const successUrl = checkoutReturnUrl(params.request, returnUrl, 'success');
  const cancelUrl = checkoutReturnUrl(params.request, returnUrl, 'cancel');
  const unitAmountCents = stripeCheckoutUnitAmountCentsForDrop(dropRuntime);
  const cfg = await deps.fetchCheckoutConfig({
    dropRuntime,
    conn: deps.connection(dropRuntime),
    context: 'getAccountInfo:boxMinterConfig:stripeCheckout',
  });
  deps.requireStripeCheckoutVariantAvailable({ dropRuntime, cfg, variantKey });
  deps.requireStripeCheckoutCollectionMatchesConfig(dropRuntime, cfg);
  deps.requireStripeCheckoutFulfillmentPrerequisites(cfg);

  const session = await createStripeCheckoutSession(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: `${params.uid}:${dropId}:${Date.now()}`.slice(0, 200),
      line_items: [
        {
          quantity: STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
          price_data: {
            currency: STRIPE_OFFCHAIN_CURRENCY,
            unit_amount: unitAmountCents,
            product_data: { name: stripeCheckoutProductName(dropRuntime, variantKey, mode) },
          },
        },
      ],
      metadata: buildStripeCheckoutSessionMetadata({ dropId, uid: params.uid, variantKey }),
      ...stripeCheckoutShippingParams(),
    },
    apiKey,
    mode,
  );
  await params.db.doc(stripeCheckoutPath(dropId, session.id)).set(
    buildStripeCheckoutDocument({
      dropId,
      sessionId: session.id,
      uid: params.uid,
      variantKey,
      unitAmountCents,
      livemode: session.livemode,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );
  return session;
}

export async function createTestStripeCheckoutSessionForRequest<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
>(params: {
  db: Firestore;
  request: CallableRequest<any>;
  uid: string;
  apiKeys: readonly string[];
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
}): Promise<StripeCheckoutSessionResponse> {
  return createStripeCheckoutSessionForRequest({ ...params, allowedMode: 'test' });
}
