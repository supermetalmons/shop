import { randomInt } from 'crypto';
import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
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
  generateStripeReceiptClaimCode,
  isStripeOffchainFulfillmentSession,
  normalizeStripeCheckoutReturnUrl,
  normalizeStripeCheckoutQuantity,
  resolveMintSelectionVariantIndex,
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_SHIPPING_COUNTRY,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  requireStripeReceiptClaimCode,
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
import {
  isStripeApiKeyForMode,
  isStripeCredentialError,
  stripeApiKeyKindForLog,
  stripeClientForKey,
  stripeCredentialErrorSummary,
  type StripeApiMode,
} from './client.js';
import { toMillisMaybe } from '../time.js';

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
  automatic_tax?: unknown;
  amount_subtotal?: unknown;
  amount_total?: unknown;
  total_details?: unknown;
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
      variantKey?: string;
      processingAttemptId: string;
    }
  | {
      started: false;
      reason: StripeCheckoutFulfillmentStartSkippedReason;
    };

export type StripeCheckoutFulfillmentStartSkippedReason =
  | 'already_fulfilled'
  | 'processing'
  | 'not_pending'
  | 'failed';

export type StripeCheckoutFulfillmentSkippedReason =
  | StripeCheckoutFulfillmentStartSkippedReason
  | 'stale_processing_attempt';

export type StripeCheckoutFulfillmentProcessResult =
  | {
      status: 'fulfilled';
      dropId: string;
      sessionId: string;
      deliveryId?: number;
      metadataId?: number;
      metadataIds?: number[];
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
    stripeCheckoutEnabled?: boolean;
    stripeLiveUnitAmountCents?: number;
    stripeProductTaxCode?: string;
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

export type StripeCheckoutKind = 'size_variant' | 'standard_pack';

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
  requireStripeCheckoutAvailable: (params: {
    dropRuntime: Runtime;
    cfg: Config;
    checkoutKind: StripeCheckoutKind;
    variantKey?: string;
    quantity: number;
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

type StripeOffchainDeliveryOrderMarker = {
  deliveryId: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
};
type StripeOffchainDeliveryOrderDraft = Omit<StripeOffchainDeliveryOrderDocumentInput, 'deliveryId'>;
type StripeOffchainDeliveryOrderResult =
  | { checkoutStatus: 'fulfilled'; deliveryId: number }
  | { checkoutStatus: 'already_fulfilled'; deliveryId?: number }
  | { checkoutStatus: 'stale_processing_attempt' };

const STRIPE_CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9_:-]{4,256}$/;
const STRIPE_MANUAL_REFUND_REASON = 'fulfillment_failed_after_payment';
export const STRIPE_CHECKOUT_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS = 2;
const STRIPE_CHECKOUT_FULFILLMENT_RETRY_DELAY_MS = 1_000;
const RETRYABLE_STRIPE_FULFILLMENT_CODES = new Set([
  'aborted',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'unavailable',
]);
const RETRYABLE_GRPC_STATUS_CODES = new Set([4, 8, 10, 13, 14]);

function stripeCheckoutPath(dropId: string, sessionId: string): string {
  return `${dropRootPath(dropId)}/stripeCheckouts/${requireStripeCheckoutSessionId(sessionId)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function createStripeCheckoutProcessingAttemptId(nowMs: number): string {
  return `${nowMs.toString(36)}:${randomInt(0, 2 ** 32).toString(36)}`;
}

function isStripeCheckoutProcessingLeaseExpired(checkoutData: any, nowMs: number): boolean {
  const leaseExpiresAt = toMillisMaybe(checkoutData?.processingLeaseExpiresAt);
  if (leaseExpiresAt !== undefined) return leaseExpiresAt <= nowMs;

  const processingStartedAt = toMillisMaybe(checkoutData?.processingStartedAt);
  if (processingStartedAt === undefined) return false;
  return nowMs - processingStartedAt >= STRIPE_CHECKOUT_PROCESSING_LEASE_MS;
}

function errorStatusCode(err: unknown): number | null {
  const anyErr = err as any;
  const candidates = [anyErr?.statusCode, anyErr?.status, anyErr?.response?.status, anyErr?.raw?.statusCode];
  for (const candidate of candidates) {
    const statusCode = Number(candidate);
    if (Number.isFinite(statusCode) && statusCode > 0) return Math.floor(statusCode);
  }
  return null;
}

function errorCodeValues(err: unknown): Array<string | number> {
  const anyErr = err as any;
  return [anyErr?.code, anyErr?.details?.code, anyErr?.cause?.code].filter((value) => value != null);
}

function looksLikeTransientProviderMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('deadline exceeded') ||
    m.includes('fetch failed') ||
    m.includes('socket hang up') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('service unavailable') ||
    m.includes('gateway timeout') ||
    (m.includes('rpc') && m.includes('error'))
  );
}

export function isRetryableStripeCheckoutFulfillmentError(err: unknown): boolean {
  const statusCode = errorStatusCode(err);
  if (statusCode === 408 || statusCode === 409 || statusCode === 429) return true;
  if (statusCode != null && statusCode >= 500) return true;

  for (const code of errorCodeValues(err)) {
    if (typeof code === 'number' && RETRYABLE_GRPC_STATUS_CODES.has(code)) return true;
    const normalized = String(code).trim().toLowerCase().replace(/_/g, '-');
    if (RETRYABLE_STRIPE_FULFILLMENT_CODES.has(normalized)) return true;
    const numericCode = Number(normalized);
    if (Number.isFinite(numericCode) && RETRYABLE_GRPC_STATUS_CODES.has(numericCode)) return true;
  }

  const message = err instanceof Error ? err.message : String(err || '');
  return looksLikeTransientProviderMessage(message);
}

class StaleStripeCheckoutProcessingAttemptError extends Error {
  constructor() {
    super('Stripe checkout fulfillment attempt no longer owns the processing lease');
    this.name = 'StaleStripeCheckoutProcessingAttemptError';
  }
}

class StripeCheckoutProcessingAttemptOwnershipCheckError extends Error {
  readonly cause?: unknown;

  constructor(cause: unknown) {
    super('Could not verify Stripe checkout fulfillment processing lease ownership');
    this.name = 'StripeCheckoutProcessingAttemptOwnershipCheckError';
    this.cause = cause;
  }
}

async function recordStripeCheckoutRetryableFulfillmentError(params: {
  checkoutRef: DocumentReference;
  summarizeError: (err: unknown) => unknown;
  err: unknown;
  attempt: number;
  retryDelayMs: number;
  processingAttemptId?: string;
}): Promise<'recorded' | 'stale'> {
  const update = {
    lastRetryableFulfillmentError: params.summarizeError(params.err),
    lastRetryableFulfillmentErrorAt: FieldValue.serverTimestamp(),
    lastRetryableFulfillmentAttempt: params.attempt,
    nextFulfillmentRetryAt: Timestamp.fromMillis(Date.now() + params.retryDelayMs),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!params.processingAttemptId) {
    await params.checkoutRef.update(update).catch(() => undefined);
    return 'recorded';
  }

  return params.checkoutRef.firestore
    .runTransaction(async (tx) => {
      const snap = await tx.get(params.checkoutRef);
      const checkout = snap.exists ? (snap.data() as any) : null;
      const currentAttemptId = typeof checkout?.processingAttemptId === 'string' ? checkout.processingAttemptId : '';
      if (currentAttemptId !== params.processingAttemptId) return 'stale' as const;
      tx.update(params.checkoutRef, update);
      return 'recorded' as const;
    })
    .catch((err) => {
      throw new StripeCheckoutProcessingAttemptOwnershipCheckError(err);
    });
}

export async function runStripeCheckoutFulfillmentWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  params: {
    checkoutRef: DocumentReference;
    summarizeError: (err: unknown) => unknown;
    maxAttempts?: number;
    retryDelayMs?: number;
    processingAttemptId?: string;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(Number(params.maxAttempts ?? STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS)));
  const retryDelayMs = Math.max(0, Math.floor(Number(params.retryDelayMs ?? STRIPE_CHECKOUT_FULFILLMENT_RETRY_DELAY_MS)));
  let attempt = 1;

  while (true) {
    try {
      return await operation(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableStripeCheckoutFulfillmentError(err)) throw err;

      const retryRecordStatus = await recordStripeCheckoutRetryableFulfillmentError({
        checkoutRef: params.checkoutRef,
        summarizeError: params.summarizeError,
        err,
        attempt,
        retryDelayMs,
        processingAttemptId: params.processingAttemptId,
      });
      if (retryRecordStatus === 'stale') throw new StaleStripeCheckoutProcessingAttemptError();
      await sleep(retryDelayMs);
      attempt += 1;
    }
  }
}

export function stripeTestApiKey(apiKeys: readonly string[]): string {
  return stripeApiKeyForMode(apiKeys, 'test');
}

export function stripeApiKeysForMode(apiKeys: readonly string[], mode: StripeApiMode): string[] {
  const keys = Array.from(
    new Set(apiKeys.map((value) => String(value || '').trim()).filter((value) => isStripeApiKeyForMode(value, mode))),
  );
  if (keys.length === 0) throw new HttpsError('failed-precondition', `Stripe ${mode} key is not configured.`);
  return keys;
}

export function stripeApiKeyForMode(apiKeys: readonly string[], mode: StripeApiMode): string {
  return stripeApiKeysForMode(apiKeys, mode)[0];
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

const STRIPE_PRODUCT_TAX_CODE_RE = /^txcd_\d{8}$/;

export function stripeCheckoutProductTaxCodeForDrop(dropRuntime: StripeCheckoutDropRuntime): string {
  if (dropRuntime.config.stripeCheckoutEnabled !== true) {
    throw new HttpsError('failed-precondition', 'Stripe checkout is not enabled for this drop.');
  }
  const taxCode = String(dropRuntime.config.stripeProductTaxCode || '').trim();
  if (!taxCode) {
    throw new HttpsError('failed-precondition', 'Stripe product tax code is not configured for this drop.');
  }
  if (!STRIPE_PRODUCT_TAX_CODE_RE.test(taxCode)) {
    throw new HttpsError('failed-precondition', 'Stripe product tax code is invalid for this drop.');
  }
  return taxCode;
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

const STRIPE_SHIPPING_ALLOWED_COUNTRIES = [STRIPE_CHECKOUT_SHIPPING_COUNTRY] satisfies readonly StripeAllowedCountry[];

export function stripeCheckoutShippingParams(): Pick<
  Stripe.Checkout.SessionCreateParams,
  'shipping_address_collection'
> {
  return {
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

function normalizeSizeStripeVariantKey(
  dropRuntime: StripeCheckoutDropRuntime,
  variantKey: string | undefined,
): string | undefined {
  const value = String(variantKey || '').trim();
  if (!value) return undefined;
  const selection = dropRuntime.config.mintSelection;
  if (selection?.kind !== 'size') {
    throw new HttpsError('failed-precondition', 'Stripe checkout requires size variant minting.');
  }
  try {
    return selection.options[resolveMintSelectionVariantIndex(selection, value)].key;
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid variantKey');
  }
}

export function stripeCheckoutKindForDrop(dropRuntime: StripeCheckoutDropRuntime): StripeCheckoutKind {
  const itemsPerBox = Math.floor(Number(dropRuntime.itemsPerBox));
  const hasSizeSelection = dropRuntime.config.mintSelection?.kind === 'size';
  if (itemsPerBox === 0 && hasSizeSelection) return 'size_variant';
  if (itemsPerBox > 0 && !dropRuntime.config.mintSelection) return 'standard_pack';
  throw new HttpsError(
    'failed-precondition',
    'Stripe checkout is only enabled for direct-delivery size drops or standard pack drops.',
  );
}

function normalizeStripeCheckoutVariantKey(
  dropRuntime: StripeCheckoutDropRuntime,
  rawVariantKey: string | undefined,
  checkoutKind: StripeCheckoutKind,
): string | undefined {
  const raw = String(rawVariantKey || '').trim();
  if (checkoutKind === 'standard_pack') {
    if (raw) throw new HttpsError('invalid-argument', 'variantKey is only supported for size Stripe checkout.');
    return undefined;
  }

  const variantKey = normalizeSizeStripeVariantKey(dropRuntime, raw);
  if (!variantKey) throw new HttpsError('invalid-argument', 'variantKey is required for Stripe checkout.');
  return variantKey;
}

function itemNameWithCollectionCasing(itemName: string, collectionSuffix: string): string {
  if (!collectionSuffix || collectionSuffix[0] !== collectionSuffix[0].toUpperCase()) return itemName;
  return `${itemName.slice(0, 1).toUpperCase()}${itemName.slice(1)}`;
}

function stripeCheckoutBaseProductName(dropRuntime: StripeCheckoutDropRuntime): string {
  const collectionName = String(dropRuntime.config.collectionName || dropRuntime.dropId).trim();
  const itemName = String(dropRuntime.config.namePrefix || 'item').trim();
  if (!itemName) return collectionName;

  const normalizedCollection = collectionName.toLowerCase();
  const normalizedItemName = itemName.toLowerCase();
  const pluralSuffixes = [
    `${normalizedItemName}s`,
    ...(normalizedItemName.endsWith('y') ? [`${normalizedItemName.slice(0, -1)}ies`] : []),
  ];
  for (const suffix of pluralSuffixes) {
    if (!normalizedCollection.endsWith(suffix)) continue;
    const collectionSuffix = collectionName.slice(collectionName.length - suffix.length);
    const singularItemName = itemNameWithCollectionCasing(itemName, collectionSuffix);
    return `${collectionName.slice(0, collectionName.length - suffix.length)}${singularItemName}`.trim();
  }
  if (normalizedCollection.endsWith(normalizedItemName)) return collectionName;
  return `${collectionName} ${itemName}`;
}

export function stripeCheckoutProductName(
  dropRuntime: StripeCheckoutDropRuntime,
  variantKey: string | undefined,
  mode: StripeApiMode,
): string {
  const baseName = stripeCheckoutBaseProductName(dropRuntime);
  const variantSuffix = variantKey ? ` ${variantKey}` : '';
  const modePrefix = mode === 'test' ? 'test ' : '';
  return `${modePrefix}${baseName}${variantSuffix}`.slice(0, 200);
}

async function createStripeCheckoutSession(
  params: Stripe.Checkout.SessionCreateParams,
  apiKeys: readonly string[],
  mode: StripeApiMode,
): Promise<StripeCheckoutSessionResponse> {
  const keys = stripeApiKeysForMode(apiKeys, mode);
  let lastCredentialError: unknown;
  for (const apiKey of keys) {
    try {
      const stripe = await stripeClientForKey(apiKey, mode);
      const session = await stripe.checkout.sessions.create(params);
      if (typeof session.id !== 'string' || typeof session.url !== 'string') {
        throw new HttpsError('unavailable', 'Stripe response did not include a checkout URL');
      }
      if (Boolean(session.livemode) !== (mode === 'live')) {
        throw new HttpsError('failed-precondition', 'Stripe response mode does not match the configured drop mode');
      }
      return { id: session.id, url: session.url, livemode: Boolean(session.livemode) };
    } catch (err) {
      if (!isStripeCredentialError(err)) throw err;
      lastCredentialError = err;
    }
  }
  throw new HttpsError('failed-precondition', `Stripe ${mode} key was rejected by Stripe.`, {
    mode,
    configuredKeyKinds: keys.map(stripeApiKeyKindForLog),
    stripeError: stripeCredentialErrorSummary(lastCredentialError),
  });
}

async function fetchStripeCheckoutLineItems(stripe: Stripe, session: Stripe.Checkout.Session) {
  if (!session.id) throw new HttpsError('failed-precondition', 'Stripe checkout session id is missing');
  return stripe.checkout.sessions.listLineItems(session.id, { limit: 10, expand: ['data.price'] });
}

async function fetchStripeCheckoutSession(sessionId: string, apiKeys: readonly string[], mode: StripeApiMode): Promise<{
  session: Stripe.Checkout.Session;
  stripe: Stripe;
}> {
  const normalizedSessionId = requireStripeCheckoutSessionId(sessionId);
  const keys = stripeApiKeysForMode(apiKeys, mode);
  let lastCredentialError: unknown;
  for (const apiKey of keys) {
    try {
      const stripe = await stripeClientForKey(apiKey, mode);
      return { session: await stripe.checkout.sessions.retrieve(normalizedSessionId), stripe };
    } catch (err) {
      if (!isStripeCredentialError(err)) throw err;
      lastCredentialError = err;
    }
  }
  throw new HttpsError('failed-precondition', `Stripe ${mode} key was rejected by Stripe.`, {
    mode,
    configuredKeyKinds: keys.map(stripeApiKeyKindForLog),
    stripeError: stripeCredentialErrorSummary(lastCredentialError),
  });
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
  if (session.automatic_tax !== undefined) snapshot.automatic_tax = session.automatic_tax;
  if (session.amount_subtotal !== undefined) snapshot.amount_subtotal = session.amount_subtotal;
  if (session.amount_total !== undefined) snapshot.amount_total = session.amount_total;
  if (session.total_details !== undefined) snapshot.total_details = session.total_details;
  if (session.currency !== undefined) snapshot.currency = session.currency;
  return snapshot;
}

function requireStripeCheckoutFulfillmentContext<Runtime extends StripeCheckoutDropRuntime>(
  session: Stripe.Checkout.Session,
  deps: DropRuntimeDeps<Runtime>,
): { dropId: string; sessionId: string; dropRuntime: Runtime; checkoutKind: StripeCheckoutKind; variantKey?: string } {
  const sessionId = requireStripeCheckoutSessionId(session.id);
  if (!isStripeOffchainFulfillmentSession(session)) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session is not app-created off-chain fulfillment', {
      sessionId,
    });
  }

  const dropIdRaw = session.metadata?.dropId;
  const variantKeyRaw = session.metadata?.variantKey;
  if (!dropIdRaw) {
    throw new HttpsError('failed-precondition', 'Stripe checkout session is missing off-chain fulfillment metadata', {
      sessionId,
    });
  }

  const dropId = deps.requireDropId(dropIdRaw);
  const dropRuntime = deps.getDropRuntime(dropId);
  const checkoutKind = stripeCheckoutKindForDrop(dropRuntime);
  const variantKey = normalizeStripeCheckoutVariantKey(dropRuntime, variantKeyRaw, checkoutKind);
  return { dropId, sessionId, dropRuntime, checkoutKind, ...(variantKey ? { variantKey } : {}) };
}

function requireAppCreatedStripeCheckoutDocumentData(params: {
  dropId: string;
  variantKey?: string;
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
  variantKey?: string;
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

function stripeCheckoutFailureStateClearUpdate(): Record<string, unknown> {
  return {
    lastFulfillmentError: FieldValue.delete(),
    lastRetryableFulfillmentAttempt: FieldValue.delete(),
    lastRetryableFulfillmentError: FieldValue.delete(),
    lastRetryableFulfillmentErrorAt: FieldValue.delete(),
    manualRefundReviewRequired: FieldValue.delete(),
    manualRefundReviewReason: FieldValue.delete(),
    nextFulfillmentRetryAt: FieldValue.delete(),
    failedAt: FieldValue.delete(),
  };
}

function stripeCheckoutProcessingStateClearUpdate(): Record<string, unknown> {
  return {
    processingAttemptId: FieldValue.delete(),
    processingLeaseExpiresAt: FieldValue.delete(),
  };
}

function stripeCheckoutFulfillmentClearUpdate(): Record<string, unknown> {
  return {
    ...stripeCheckoutFailureStateClearUpdate(),
    ...stripeCheckoutProcessingStateClearUpdate(),
  };
}

function stripeCheckoutFulfilledUpdate(params: {
  deliveryId: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
}): Record<string, unknown> {
  const metadataIds = normalizedMetadataIds(params.metadataIds, params.metadataId);
  const metadataId = metadataIds.length === 1 ? metadataIds[0] : undefined;
  return {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    deliveryId: params.deliveryId,
    ...(metadataId ? { metadataId } : metadataIds.length > 1 ? { metadataId: FieldValue.delete() } : {}),
    ...(metadataIds.length ? { metadataIds, quantity: metadataIds.length } : {}),
    ...(typeof params.receiptTx === 'string' || params.receiptTx === null ? { receiptTx: params.receiptTx } : {}),
    fulfilledAt: FieldValue.serverTimestamp(),
    ...stripeCheckoutFulfillmentClearUpdate(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export type StripeCheckoutFulfillmentSuccessMarkResult =
  | { status: 'fulfilled' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

type StripeCheckoutProcessingAttemptWriteStatus = 'current' | 'already_fulfilled' | 'stale_processing_attempt';

function stripeCheckoutProcessingAttemptWriteStatus(
  checkout: any,
  processingAttemptId: string | undefined,
): StripeCheckoutProcessingAttemptWriteStatus {
  const checkoutStatus = typeof checkout?.status === 'string' ? checkout.status : '';
  if (checkoutStatus === STRIPE_CHECKOUT_STATUS.FULFILLED) return 'already_fulfilled';
  if (!processingAttemptId) return 'current';
  const currentAttemptId = typeof checkout?.processingAttemptId === 'string' ? checkout.processingAttemptId : '';
  return currentAttemptId === processingAttemptId ? 'current' : 'stale_processing_attempt';
}

function stripeCheckoutFulfilledWriteStatus(
  checkout: any,
  processingAttemptId: string | undefined,
): StripeCheckoutFulfillmentSuccessMarkResult['status'] {
  const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, processingAttemptId);
  return writeStatus === 'current' ? 'fulfilled' : writeStatus;
}

export async function markStripeCheckoutFulfillmentFulfilled(
  checkoutRef: DocumentReference,
  params: {
    deliveryId: number;
    metadataId?: number;
    metadataIds?: number[];
    receiptTx?: string | null;
    processingAttemptId?: string;
  },
): Promise<StripeCheckoutFulfillmentSuccessMarkResult> {
  const update = stripeCheckoutFulfilledUpdate(params);
  if (!params.processingAttemptId) {
    await checkoutRef.update(update);
    return { status: 'fulfilled' };
  }

  return checkoutRef.firestore
    .runTransaction(async (tx) => {
      const checkoutSnap = await tx.get(checkoutRef);
      const checkout = checkoutSnap.exists ? (checkoutSnap.data() as any) : null;
      const status = stripeCheckoutFulfilledWriteStatus(checkout, params.processingAttemptId);
      if (status === 'already_fulfilled') return { status: 'already_fulfilled' as const };
      if (status === 'stale_processing_attempt') return { status: 'stale_processing_attempt' as const };
      tx.update(checkoutRef, update);
      return { status: 'fulfilled' as const };
    })
    .catch((err) => {
      throw new StripeCheckoutProcessingAttemptOwnershipCheckError(err);
    });
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

function normalizedPositiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((candidate) => Math.floor(Number(candidate)))
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0 && candidate <= 0xffff_ffff);
}

function normalizedMetadataIds(metadataIds: unknown, metadataId: unknown): number[] {
  const explicitMetadataIds = normalizedPositiveIntegers(metadataIds);
  if (explicitMetadataIds.length) return explicitMetadataIds;
  const legacyMetadataId = positiveInteger(metadataId);
  return legacyMetadataId ? [legacyMetadataId] : [];
}

function receiptTxMaybe(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  return undefined;
}

function readStripeOffchainDeliveryOrderMarker(marker: { get(fieldPath: string): unknown }): StripeOffchainDeliveryOrderMarker | null {
  const deliveryId = Math.floor(Number(marker.get('deliveryId')));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;
  const metadataId = positiveInteger(marker.get('metadataId'));
  const metadataIds = normalizedMetadataIds(marker.get('metadataIds'), metadataId);
  const receiptTx = receiptTxMaybe(marker.get('receiptTx'));
  return {
    deliveryId,
    ...(metadataId ? { metadataId } : {}),
    ...(metadataIds.length ? { metadataIds } : {}),
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

function generateUniqueStripeReceiptClaimCodes(quantity: number): string[] {
  const normalizedQuantity = normalizeStripeCheckoutQuantity(quantity);
  const codes = new Set<string>();
  while (codes.size < normalizedQuantity) {
    codes.add(requireStripeReceiptClaimCode(generateStripeReceiptClaimCode()));
  }
  return [...codes];
}

export async function createOrGetStripeOffchainDeliveryOrder(params: {
  db: Firestore;
  order: StripeOffchainDeliveryOrderDraft;
  checkoutRef: DocumentReference;
  isAlreadyExistsError: (err: unknown) => boolean;
  processingAttemptId?: string;
}): Promise<StripeOffchainDeliveryOrderResult> {
  const { db, order, checkoutRef } = params;
  const { dropId, orderHashHex } = order;
  const metadataIds = normalizedMetadataIds(order.metadataIds, order.metadataId);
  const quantity = normalizeStripeCheckoutQuantity(metadataIds.length);
  const markerRef = db.doc(`${dropRootPath(dropId)}/offchainOrders/${orderHashHex}`);
  const MAX_DELIVERY_ID_ATTEMPTS = 16;
  const MAX_CLAIM_CODE_ATTEMPTS = 40;
  const maxAttempts = MAX_DELIVERY_ID_ATTEMPTS * MAX_CLAIM_CODE_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const orderRef = db.doc(dropDeliveryOrderPath(dropId, candidate));
    const claimCodes = generateUniqueStripeReceiptClaimCodes(quantity);
    const claimRefs = claimCodes.map((claimCode) => db.doc(`claimCodes/${claimCode}`));

    try {
      const result = await db.runTransaction(async (tx) => {
        const marker = await tx.get(markerRef);
        const checkoutSnap = params.processingAttemptId ? await tx.get(checkoutRef) : null;
        const checkout = checkoutSnap?.exists ? (checkoutSnap.data() as any) : null;
        const checkoutStatus = stripeCheckoutFulfilledWriteStatus(checkout, params.processingAttemptId);
        if (marker.exists) {
          const existingOrder = readStripeOffchainDeliveryOrderMarker(marker);
          if (existingOrder) {
            if (checkoutStatus === 'stale_processing_attempt') {
              return { checkoutStatus };
            }
            if (checkoutStatus === 'fulfilled') {
              tx.update(
                checkoutRef,
                stripeCheckoutFulfilledUpdate({
                  deliveryId: existingOrder.deliveryId,
                  metadataId: existingOrder.metadataId,
                  metadataIds: existingOrder.metadataIds,
                  receiptTx: existingOrder.receiptTx,
                }),
              );
            }
            return { deliveryId: existingOrder.deliveryId, checkoutStatus };
          }
        }

        if (checkoutStatus === 'stale_processing_attempt') {
          return { checkoutStatus };
        }
        if (checkoutStatus === 'already_fulfilled') {
          const deliveryId = positiveInteger(checkout?.deliveryId);
          return deliveryId ? { deliveryId, checkoutStatus } : { checkoutStatus };
        }

        const stripeReceiptClaims = metadataIds.map((boxId, index) => ({
          code: requireStripeReceiptClaimCode(claimCodes[index]),
          boxId,
          status: 'unclaimed',
        }));
        const deliveryOrder = {
          ...order,
          deliveryId: candidate,
          metadataIds,
          stripeReceiptClaims,
        };
        tx.create(orderRef, {
          ...buildStripeOffchainDeliveryOrderDocument(deliveryOrder),
          processedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.create(markerRef, {
          ...buildStripeOffchainOrderMarkerDocument(deliveryOrder),
          createdAt: FieldValue.serverTimestamp(),
        });
        stripeReceiptClaims.forEach((claim, index) => {
          tx.create(claimRefs[index], {
            version: 1,
            namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
            code: claim.code,
            dropId,
            deliveryId: candidate,
            owner: order.owner,
            ...(order.ownerKind ? { ownerKind: order.ownerKind } : {}),
            ...(order.firebaseUid ? { firebaseUid: order.firebaseUid } : {}),
            receiptOwner: order.receiptOwner,
            boxId: claim.boxId,
            ...(order.variantKey ? { variantKey: order.variantKey } : {}),
            offchainOrderHash: order.orderHashHex,
            stripeCheckoutSessionId: order.stripeSession.id,
            status: 'unclaimed',
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        if (checkoutStatus === 'fulfilled') {
          tx.update(
            checkoutRef,
            stripeCheckoutFulfilledUpdate({
              deliveryId: candidate,
              ...(metadataIds.length === 1 ? { metadataId: metadataIds[0] } : {}),
              metadataIds,
              receiptTx: order.receiptTx,
            }),
          );
        }
        return { deliveryId: candidate, checkoutStatus };
      });
      return result;
    } catch (err) {
      if (params.isAlreadyExistsError(err)) continue;
      throw err;
    }
  }

  throw new HttpsError('unavailable', 'Failed to allocate off-chain delivery id or receipt claim code (try again)');
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
  expectedVariantKey?: string;
  processingAttemptId?: string;
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
}): Promise<{
  dropId: string;
  deliveryId?: number;
  metadataId?: number;
  metadataIds?: number[];
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
  const checkoutKind = stripeCheckoutKindForDrop(dropRuntime);
  const variantKey = normalizeStripeCheckoutVariantKey(dropRuntime, params.expectedVariantKey, checkoutKind);
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
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError('unavailable', 'Receipt cNFT tree is not configured', { dropId });
  }

  const variantIndex =
    checkoutKind === 'size_variant'
      ? resolveMintSelectionVariantIndex(dropRuntime.config.mintSelection, variantKey || '')
      : 0;
  const orderHash = stripeCheckoutSessionOrderHash(sessionId, Boolean(session.livemode));
  const orderHashHex = orderHash.toString('hex');
  const existingOrder = await fetchStripeOffchainDeliveryOrderMarker({ db, dropId, orderHashHex });
  if (existingOrder) {
    const markResult = await markStripeCheckoutFulfillmentFulfilled(checkout.ref, {
      deliveryId: existingOrder.deliveryId,
      metadataId: existingOrder.metadataId,
      metadataIds: existingOrder.metadataIds,
      receiptTx: existingOrder.receiptTx,
      processingAttemptId: params.processingAttemptId,
    });
    if (markResult.status === 'stale_processing_attempt') {
      throw new StaleStripeCheckoutProcessingAttemptError();
    }
    return {
      dropId,
      deliveryId: existingOrder.deliveryId,
      metadataId: existingOrder.metadataId,
      metadataIds: existingOrder.metadataIds,
      receiptTx: existingOrder.receiptTx ?? null,
    };
  }

  const lineItems = await fetchStripeCheckoutLineItems(stripe, session);
  try {
    validateStripeCheckoutContract({
      session,
      lineItems,
      expectedUnitAmountCents: checkout.unitAmountCents,
      expectedQuantity: checkout.quantity,
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
        quantity: checkout.quantity,
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
  if (record.quantity !== checkout.quantity) {
    throw new HttpsError('failed-precondition', 'Admin order record quantity mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedQuantity: checkout.quantity,
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
  const metadataIds = Array.from({ length: checkout.quantity }, (_, index) => metadataId + index);

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
      metadataIds,
      ...(variantKey ? { variantKey } : {}),
      stripeSession: session,
      receiptTx,
      addressSnapshot,
    },
    checkoutRef: checkout.ref,
    isAlreadyExistsError: deps.isAlreadyExistsError,
    processingAttemptId: params.processingAttemptId,
  });
  if (order.checkoutStatus === 'stale_processing_attempt') {
    throw new StaleStripeCheckoutProcessingAttemptError();
  }

  return {
    dropId,
    ...(order.deliveryId ? { deliveryId: order.deliveryId } : {}),
    metadataId,
    metadataIds,
    receiptTx,
  };
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
  nowMs?: number;
}): Promise<StripeCheckoutFulfillmentStart> {
  const { dropId, sessionId, checkoutRef } = params;
  const nowMs = Math.floor(Number(params.nowMs ?? Date.now()));
  const processingAttemptId = createStripeCheckoutProcessingAttemptId(nowMs);
  return checkoutRef.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(checkoutRef);
    if (!snap.exists) return { started: false, reason: 'not_pending' };
    const checkoutData = snap.data() as any;
    const status = typeof checkoutData?.status === 'string' ? checkoutData.status : '';
    if (status === STRIPE_CHECKOUT_STATUS.FULFILLED) return { started: false, reason: 'already_fulfilled' };
    if (status === STRIPE_CHECKOUT_STATUS.PROCESSING && !isStripeCheckoutProcessingLeaseExpired(checkoutData, nowMs)) {
      return { started: false, reason: 'processing' };
    }
    if (status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED) return { started: false, reason: 'failed' };
    if (status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING && status !== STRIPE_CHECKOUT_STATUS.PROCESSING) {
      return { started: false, reason: 'not_pending' };
    }

    const variantKey = String(checkoutData?.variantKey || '').trim();
    const checkout = requireAppCreatedStripeCheckoutSnapshot({
      dropId,
      ...(variantKey ? { variantKey } : {}),
      sessionId,
      expectedLivemode: params.expectedLivemode,
      ref: checkoutRef,
      snap,
    });

    tx.update(checkoutRef, {
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingStartedAt: FieldValue.serverTimestamp(),
      processingAttemptCount: FieldValue.increment(1),
      ...stripeCheckoutFailureStateClearUpdate(),
      processingAttemptId,
      processingLeaseExpiresAt: Timestamp.fromMillis(nowMs + STRIPE_CHECKOUT_PROCESSING_LEASE_MS),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { started: true, checkoutRef, checkout, ...(variantKey ? { variantKey } : {}), processingAttemptId };
  });
}

export type StripeCheckoutFulfillmentFailureMarkResult =
  | { status: 'failed' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

export async function markStripeCheckoutFulfillmentFailed(
  checkoutRef: DocumentReference,
  err: unknown,
  params: {
    summarizeError: (err: unknown) => unknown;
    sessionIdentity?: { dropId: string; sessionId: string };
    processingAttemptId?: string;
  },
): Promise<StripeCheckoutFulfillmentFailureMarkResult> {
  const error = params.summarizeError(err);
  const identityUpdate = params.sessionIdentity
    ? { dropId: params.sessionIdentity.dropId, sessionId: params.sessionIdentity.sessionId }
    : {};
  return checkoutRef.firestore.runTransaction(async (tx) => {
    const checkoutSnap = await tx.get(checkoutRef);
    const checkout = checkoutSnap.exists ? (checkoutSnap.data() as any) : null;
    const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, params.processingAttemptId);
    if (writeStatus === 'already_fulfilled') {
      return { status: 'already_fulfilled' as const };
    }
    if (writeStatus === 'stale_processing_attempt') {
      return { status: 'stale_processing_attempt' as const };
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
        nextFulfillmentRetryAt: FieldValue.delete(),
        ...stripeCheckoutProcessingStateClearUpdate(),
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
    if (isRetryableStripeCheckoutFulfillmentError(err)) {
      throw err;
    }
    const markResult = await markStripeCheckoutFulfillmentFailed(checkoutRef, err, {
      summarizeError: deps.summarizeError,
      sessionIdentity: { dropId, sessionId },
    });
    if (markResult.status !== 'failed') {
      return { status: 'ignored', dropId, sessionId, reason: markResult.status };
    }
    return { status: 'failed', dropId, sessionId, error: deps.summarizeError(err) };
  }

  if (started.started === false) {
    if (started.reason === 'processing') {
      throw new HttpsError('aborted', 'Stripe checkout fulfillment processing lease is still active', {
        dropId,
        sessionId,
      });
    }
    return { status: 'ignored', dropId, sessionId, reason: started.reason };
  }

  try {
    let checkoutSessionResult: Awaited<ReturnType<typeof fetchStripeCheckoutSession>> | undefined;
    const result = await runStripeCheckoutFulfillmentWithRetry(
      async () => {
        if (!checkoutSessionResult) {
          checkoutSessionResult = await fetchStripeCheckoutSession(sessionId, params.apiKeys, mode);
        }
        const { session, stripe } = checkoutSessionResult;
        return fulfillStripeCheckoutSession({
          db,
          session,
          stripe,
          checkout: started.checkout,
          expectedDropId: dropId,
          expectedSessionId: sessionId,
          expectedVariantKey: started.variantKey,
          processingAttemptId: started.processingAttemptId,
          deps,
        });
      },
      {
        checkoutRef: started.checkoutRef,
        summarizeError: deps.summarizeError,
        processingAttemptId: started.processingAttemptId,
      },
    );
    return { status: 'fulfilled', sessionId, ...result };
  } catch (err) {
    if (err instanceof StripeCheckoutProcessingAttemptOwnershipCheckError) {
      throw err;
    }
    if (err instanceof StaleStripeCheckoutProcessingAttemptError) {
      return { status: 'ignored', dropId, sessionId, reason: 'stale_processing_attempt' };
    }
    const markResult = await markStripeCheckoutFulfillmentFailed(started.checkoutRef, err, {
      summarizeError: deps.summarizeError,
      sessionIdentity: { dropId, sessionId },
      processingAttemptId: started.processingAttemptId,
    });
    if (markResult.status !== 'failed') {
      return { status: 'ignored', dropId, sessionId, reason: markResult.status };
    }
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
    quantity: z.union([z.number(), z.string()]).optional(),
    returnUrl: z.string().url().max(2048).optional(),
  });
  const {
    dropId: requestDropId,
    variantKey: rawVariantKey,
    quantity: rawQuantity,
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
  const checkoutKind = stripeCheckoutKindForDrop(dropRuntime);
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError('failed-precondition', 'Stripe checkout requires a configured receipt cNFT tree.');
  }

  const variantKey = normalizeStripeCheckoutVariantKey(dropRuntime, rawVariantKey, checkoutKind);
  let quantity: number;
  try {
    quantity = normalizeStripeCheckoutQuantity(rawQuantity);
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof Error ? err.message : String(err));
  }
  const successUrl = checkoutReturnUrl(params.request, returnUrl, 'success');
  const cancelUrl = checkoutReturnUrl(params.request, returnUrl, 'cancel');
  const productTaxCode = stripeCheckoutProductTaxCodeForDrop(dropRuntime);
  const unitAmountCents = stripeCheckoutUnitAmountCentsForDrop(dropRuntime);
  const cfg = await deps.fetchCheckoutConfig({
    dropRuntime,
    conn: deps.connection(dropRuntime),
    context: 'getAccountInfo:boxMinterConfig:stripeCheckout',
  });
  deps.requireStripeCheckoutAvailable({ dropRuntime, cfg, checkoutKind, variantKey, quantity });
  deps.requireStripeCheckoutCollectionMatchesConfig(dropRuntime, cfg);
  deps.requireStripeCheckoutFulfillmentPrerequisites(cfg);

  const session = await createStripeCheckoutSession(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      automatic_tax: { enabled: true },
      billing_address_collection: 'auto',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: `${params.uid}:${dropId}:${Date.now()}`.slice(0, 200),
      line_items: [
        {
          quantity,
          price_data: {
            currency: STRIPE_OFFCHAIN_CURRENCY,
            unit_amount: unitAmountCents,
            tax_behavior: 'exclusive',
            product_data: { name: stripeCheckoutProductName(dropRuntime, variantKey, mode), tax_code: productTaxCode },
          },
        },
      ],
      metadata: buildStripeCheckoutSessionMetadata({ dropId, uid: params.uid, variantKey, quantity }),
      ...stripeCheckoutShippingParams(),
    },
    params.apiKeys,
    mode,
  );
  await params.db.doc(stripeCheckoutPath(dropId, session.id)).set(
    buildStripeCheckoutDocument({
      dropId,
      sessionId: session.id,
      uid: params.uid,
      ...(variantKey ? { variantKey } : {}),
      unitAmountCents,
      quantity,
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
