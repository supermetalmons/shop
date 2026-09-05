import { randomInt } from 'crypto';
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
import type { MintSelectionConfig, SolanaCluster } from '../dropConfig.js';
import type { DropFamily, DropSalesMode } from '../../../../../shared/deploymentCore.js';
import {
  buildStripeOffchainAddressSnapshot,
  buildStripeOffchainDeliveryOrderDocument,
  buildStripeOffchainOrderMarkerDocument,
  decodeAdminDeliveryOrderRecord,
  deriveAdminOrderPda,
  encodeAdminDeliverVariantOrderArgs,
  generateUniqueStripeReceiptClaimCodes,
  isStripeOffchainFulfillmentSession,
  normalizeStripeCheckoutQuantity,
  resolveMintSelectionVariantIndex,
  STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
  STRIPE_CHECKOUT_OWNER_KIND_WALLET,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  requireStripeReceiptClaimCode,
  stripeCheckoutSessionOrderHash,
  stripeFulfillmentAddressFromSession,
  validateStripeCheckoutContract,
  validateStripeCheckoutDocumentData,
  type DecodedAdminDeliveryOrderRecord,
  type StripeAddressEncryptionResult,
  type StripeCheckoutDocumentData,
  type StripeOffchainDeliveryOrderDocumentInput,
} from './contract.js';
import {
  isStripeApiKeyForMode,
  isStripeCredentialError,
  stripeApiKeyKindForLog,
  stripeClientForKey,
  stripeCredentialErrorSummary,
  type StripeApiMode,
} from './provider.js';
import type {
  StripeCheckoutManualReviewAddress,
} from '../../../../../shared/contracts.js';
import {
  classifyStripeCheckoutKind,
  stripeCheckoutModeForCluster,
  type StripeCheckoutKind as SharedStripeCheckoutKind,
} from '../../../../../shared/stripeCheckoutCore.js';
import { normalizeStripeCheckoutIdentity } from '../../../../../shared/checkoutIdentity.js';
import { toMillisMaybe } from '../time.js';
import { StripeCheckoutFulfillmentError } from './errors.js';
import { createStripeTerminalNotificationOutboxFields } from './notificationOutboxState.js';
import {
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
} from '../commerceRepository.js';
import { commerceTimestamp, runCommerceTransaction } from '../commerceTransactions.js';
import { stripeCheckoutWriteData, type StripeCheckoutCommerceContext } from './commerce.js';

type StripeCheckoutDocumentRecord = {
  key: CommerceDocumentKey<'stripe_checkout'>;
  checkout: any;
} & StripeCheckoutDocumentData;

export type StripeCheckoutManualReviewSummary = {
  dropId: string;
  sessionId: string;
  owner: string;
  authSubject?: string;
  quantity?: number;
  amountTotal?: number;
  currency?: string;
  createdAt?: number;
  failedAt?: number;
  manualRefundReviewReason?: string;
  errorMessage?: string;
  address: StripeCheckoutManualReviewAddress;
};

export type StripeCheckoutFulfillmentStart =
  | {
      started: true;
      checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
      checkout: StripeCheckoutDocumentRecord;
      variantKey?: string;
      processingAttemptId: string;
    }
  | {
      started: false;
      reason: StripeCheckoutFulfillmentStartSkippedReason;
    };

type StripeCheckoutFulfillmentStartSkippedReason =
  | 'already_fulfilled'
  | 'processing'
  | 'not_pending'
  | 'failed';

type StripeCheckoutFulfillmentSkippedReason =
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
  maxSupply?: number;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  receiptsMerkleTreeStr?: string;
  config: {
    collectionName?: string;
    displayName?: string;
    dropFamily: DropFamily;
    namePrefix?: string;
    mintSelection?: MintSelectionConfig;
    salesMode?: DropSalesMode;
    stripeCheckoutEnabled?: boolean;
    stripeLiveUnitAmountCents?: number;
    stripeProductTaxCode?: string;
  };
};

export type StripeCheckoutPackStatusRuntime = Pick<
  StripeCheckoutDropRuntime,
  'dropId' | 'cluster' | 'itemsPerBox' | 'maxSupply'
>;

type StripeCheckoutPackStatusCounter<Runtime extends StripeCheckoutPackStatusRuntime> = (params: {
  dropRuntime: Runtime;
  orderHashHex: string;
  quantity: number;
  deliveryId: number;
  checkoutSessionId: string;
}) => Promise<void>;

type StripeCheckoutPackStatusRepair<Runtime extends StripeCheckoutPackStatusRuntime> = (params: {
  dropRuntime: Runtime;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  sessionId: string;
}) => Promise<void>;

export class StripeCheckoutPackStatusProjectionError extends Error {
  constructor(readonly cause: unknown) {
    super('Stripe checkout pack-status projection failed');
    this.name = 'StripeCheckoutPackStatusProjectionError';
  }
}

export type StripeCheckoutOnchainConfig = {
  admin: PublicKey;
  coreCollection: PublicKey;
};

type StripeCheckoutPrograms = {
  bubblegumProgramId: PublicKey;
  mplNoopProgramId: PublicKey;
  mplAccountCompressionProgramId: PublicKey;
  mplCoreProgramId: PublicKey;
  mplCoreCpiSigner: PublicKey;
};

export type StripeCheckoutKind = SharedStripeCheckoutKind;

type DropRuntimeDeps<Runtime extends StripeCheckoutDropRuntime> = {
  requireDropId: (rawDropId: unknown) => string;
  getDropRuntime: (dropId: string) => Runtime;
};

export type StripeCheckoutFlowDeps<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
> = DropRuntimeDeps<Runtime> & {
  connection: (dropRuntime: Runtime) => Connection;
  ensureOnchainCoreConfig: (dropRuntime: Runtime) => Promise<Config>;
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
  signal?: AbortSignal;
  resolveWalletOwner?: (authSubject: string) => Promise<string | null>;
  countPackStatus?: StripeCheckoutPackStatusCounter<Runtime>;
  repairPackStatus?: StripeCheckoutPackStatusRepair<Runtime>;
  logPackStatusError?: (entry: Record<string, unknown>) => void;
};

type StripeOffchainDeliveryOrderMarker = {
  deliveryId: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
};
type StripeOffchainDeliveryOrderDraft = Omit<StripeOffchainDeliveryOrderDocumentInput, 'deliveryId'>;
type StripeOffchainDeliveryOrderResult =
  | { checkoutStatus: 'fulfilled'; deliveryId: number; created?: boolean }
  | { checkoutStatus: 'already_fulfilled'; deliveryId?: number }
  | { checkoutStatus: 'stale_processing_attempt' };

const STRIPE_CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9_:-]{4,256}$/;
const STRIPE_MANUAL_REFUND_REASON = 'fulfillment_failed_after_payment';
export const STRIPE_CHECKOUT_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS = 2;
const STRIPE_CHECKOUT_FULFILLMENT_RETRY_DELAY_MS = 1_000;
const STRIPE_CHECKOUT_PROVIDER_TIMEOUT_MS = 30_000;
const STRIPE_CHECKOUT_PROVIDER_MAX_NETWORK_RETRIES = 0;
const STRIPE_CHECKOUT_PROVIDER_REQUEST_OPTIONS: Stripe.RequestOptions = {
  maxNetworkRetries: STRIPE_CHECKOUT_PROVIDER_MAX_NETWORK_RETRIES,
  timeout: STRIPE_CHECKOUT_PROVIDER_TIMEOUT_MS,
};
const RETRYABLE_STRIPE_FULFILLMENT_CODES = new Set([
  'aborted',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'unavailable',
]);
const RETRYABLE_GRPC_STATUS_CODES = new Set([4, 8, 10, 13, 14]);

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
  return [
    anyErr?.code,
    anyErr?.details?.code,
    anyErr?.cause?.code,
    typeof anyErr?.status === 'string' ? anyErr.status : undefined,
    typeof anyErr?.details?.status === 'string' ? anyErr.details.status : undefined,
    typeof anyErr?.cause?.status === 'string' ? anyErr.cause.status : undefined,
  ].filter((value) => value != null);
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
  const errorType = String((err as any)?.type || (err as any)?.rawType || '');
  if (errorType === 'StripeConnectionError') return true;

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
  commerce: StripeCheckoutCommerceContext;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  summarizeError: (err: unknown) => unknown;
  err: unknown;
  attempt: number;
  retryDelayMs: number;
  processingAttemptId?: string;
}): Promise<'recorded' | 'stale'> {
  const update = {
    lastRetryableFulfillmentError: params.summarizeError(params.err),
    lastRetryableFulfillmentErrorAt: commerceFieldValue.serverTimestamp(),
    lastRetryableFulfillmentAttempt: params.attempt,
    nextFulfillmentRetryAt: commerceTimestamp(Date.now() + params.retryDelayMs),
    updatedAt: commerceFieldValue.serverTimestamp(),
  };

  if (!params.processingAttemptId) {
    await runCommerceTransaction(params.commerce, async (tx) => {
      await tx.update(params.checkoutKey, stripeCheckoutWriteData(update));
    }, { shouldRetry: (error) => error.code === 'aborted' }).catch(() => undefined);
    return 'recorded';
  }

  return runCommerceTransaction(params.commerce, async (tx) => {
    const record = await tx.get(params.checkoutKey);
    const checkout = record?.data ?? null;
    const currentAttemptId = typeof checkout?.processingAttemptId === 'string' ? checkout.processingAttemptId : '';
    if (currentAttemptId !== params.processingAttemptId) return 'stale' as const;
    await tx.update(params.checkoutKey, stripeCheckoutWriteData(update));
    return 'recorded' as const;
  }, { shouldRetry: (error) => error.code === 'aborted' }).catch((err) => {
    throw new StripeCheckoutProcessingAttemptOwnershipCheckError(err);
  });
}

export async function runStripeCheckoutFulfillmentWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  params: {
    commerce: StripeCheckoutCommerceContext;
    checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
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
        commerce: params.commerce,
        checkoutKey: params.checkoutKey,
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
  if (keys.length === 0) throw new StripeCheckoutFulfillmentError('failed-precondition', `Stripe ${mode} key is not configured.`);
  return keys;
}

export function stripeApiKeyForMode(apiKeys: readonly string[], mode: StripeApiMode): string {
  return stripeApiKeysForMode(apiKeys, mode)[0];
}

export function stripeApiModeForCluster(cluster: SolanaCluster): StripeApiMode {
  const mode = stripeCheckoutModeForCluster(cluster);
  if (mode) return mode;
  throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout is only enabled for devnet and mainnet drops.');
}

function requireStripeCheckoutSessionId(rawSessionId: unknown): string {
  const sessionId = String(rawSessionId || '').trim();
  if (!STRIPE_CHECKOUT_SESSION_ID_RE.test(sessionId)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout session id is invalid');
  }
  return sessionId;
}

function normalizeSizeStripeVariantKey(
  dropRuntime: StripeCheckoutDropRuntime,
  variantKey: string | undefined,
): string | undefined {
  const value = String(variantKey || '').trim();
  if (!value) return undefined;
  const selection = dropRuntime.config.mintSelection;
  if (selection?.kind !== 'size') {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout requires size variant minting.');
  }
  try {
    return selection.options[resolveMintSelectionVariantIndex(selection, value)].key;
  } catch {
    throw new StripeCheckoutFulfillmentError('invalid-argument', 'Invalid variantKey');
  }
}

export function stripeCheckoutKindForDrop(dropRuntime: StripeCheckoutDropRuntime): StripeCheckoutKind {
  const checkoutKind = classifyStripeCheckoutKind({
    itemsPerBox: dropRuntime.itemsPerBox,
    mintSelection: dropRuntime.config.mintSelection,
    salesMode: dropRuntime.config.salesMode,
  });
  if (checkoutKind) return checkoutKind;
  throw new StripeCheckoutFulfillmentError(
    'failed-precondition',
    'Stripe checkout is only enabled for direct-delivery size drops, receipt-only drops, or standard pack drops.',
  );
}

function normalizeStripeCheckoutVariantKey(
  dropRuntime: StripeCheckoutDropRuntime,
  rawVariantKey: string | undefined,
  checkoutKind: StripeCheckoutKind,
): string | undefined {
  const raw = String(rawVariantKey || '').trim();
  if (checkoutKind !== 'size_variant') {
    if (raw) throw new StripeCheckoutFulfillmentError('invalid-argument', 'variantKey is only supported for size Stripe checkout.');
    return undefined;
  }

  const variantKey = normalizeSizeStripeVariantKey(dropRuntime, raw);
  if (!variantKey) throw new StripeCheckoutFulfillmentError('invalid-argument', 'variantKey is required for Stripe checkout.');
  return variantKey;
}

async function fetchStripeCheckoutLineItems(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  signal?: AbortSignal,
) {
  if (!session.id) throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout session id is missing');
  signal?.throwIfAborted();
  const lineItems = await stripe.checkout.sessions.listLineItems(
    session.id,
    { limit: 10, expand: ['data.price'] },
    STRIPE_CHECKOUT_PROVIDER_REQUEST_OPTIONS,
  );
  signal?.throwIfAborted();
  return lineItems;
}

async function fetchStripeCheckoutSession(
  sessionId: string,
  apiKeys: readonly string[],
  mode: StripeApiMode,
  signal?: AbortSignal,
): Promise<{
  session: Stripe.Checkout.Session;
  stripe: Stripe;
}> {
  const normalizedSessionId = requireStripeCheckoutSessionId(sessionId);
  const keys = stripeApiKeysForMode(apiKeys, mode);
  let lastCredentialError: unknown;
  for (const apiKey of keys) {
    try {
      signal?.throwIfAborted();
      const stripe = await stripeClientForKey(apiKey, mode);
      signal?.throwIfAborted();
      const session = await stripe.checkout.sessions.retrieve(
        normalizedSessionId,
        {},
        STRIPE_CHECKOUT_PROVIDER_REQUEST_OPTIONS,
      );
      signal?.throwIfAborted();
      return { session, stripe };
    } catch (err) {
      if (!isStripeCredentialError(err)) throw err;
      lastCredentialError = err;
    }
  }
  throw new StripeCheckoutFulfillmentError('failed-precondition', `Stripe ${mode} key was rejected by Stripe.`, {
    mode,
    configuredKeyKinds: keys.map(stripeApiKeyKindForLog),
    stripeError: stripeCredentialErrorSummary(lastCredentialError),
  });
}

function requireStripeOffchainAddressSnapshot(params: {
  session: Stripe.Checkout.Session;
  encryptAddress: (plaintext: string) => StripeAddressEncryptionResult | null;
  normalizeCountryCode: (country?: string) => string;
  dropFamily: DropFamily;
}): Record<string, unknown> {
  try {
    return buildStripeOffchainAddressSnapshot(params);
  } catch (err) {
    if (err instanceof StripeCheckoutFulfillmentError) throw err;
    throw new StripeCheckoutFulfillmentError('failed-precondition', err instanceof Error ? err.message : String(err), {
      sessionId: params.session.id,
    });
  }
}

function normalizedManualReviewString(value: unknown): string {
  return String(value || '').trim();
}

function manualReviewPositiveInteger(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function manualReviewNonNegativeInteger(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function manualReviewCurrency(value: unknown): string | undefined {
  const currency = normalizedManualReviewString(value).toLowerCase();
  return /^[a-z]{3}$/.test(currency) ? currency : undefined;
}

function truncateManualReviewText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function firstManualReviewErrorLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ? truncateManualReviewText(line) : undefined;
}

function stripeCheckoutManualReviewErrorMessage(checkout: any): string | undefined {
  const error = checkout?.lastFulfillmentError;
  const candidates = [
    error?.message,
    error?.details?.lastError,
    error?.lastError,
    checkout?.manualRefundReviewReason,
  ];
  for (const candidate of candidates) {
    const message = firstManualReviewErrorLine(candidate);
    if (message) return message;
  }
  return undefined;
}

function stripeCheckoutManualReviewAddress(args: {
  session?: Stripe.Checkout.Session | null;
  canViewSensitiveAddress: boolean;
}): StripeCheckoutManualReviewAddress {
  const parsed = stripeFulfillmentAddressFromSession(args.session);
  if (!parsed) return { full: null };
  const country = normalizedManualReviewString(parsed.country);
  const countryCode = normalizedManualReviewString(parsed.countryCode).toUpperCase();
  if (!args.canViewSensitiveAddress) {
    return {
      full: '***',
      ...(country ? { country } : {}),
      ...(countryCode ? { countryCode } : {}),
    };
  }
  return {
    full: parsed.formatted || null,
    ...(parsed.email ? { email: parsed.email } : {}),
    ...(country ? { country } : {}),
    ...(countryCode ? { countryCode } : {}),
  };
}

export function isStripeCheckoutManualReviewCandidate(checkout: any): boolean {
  return checkout?.manualRefundReviewRequired === true && checkout?.status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED;
}

export function buildStripeCheckoutManualReviewSummary(args: {
  dropId: string;
  sessionId: string;
  checkout: any;
  session?: Stripe.Checkout.Session | null;
  canViewSensitiveAddress: boolean;
}): StripeCheckoutManualReviewSummary | null {
  const { checkout } = args;
  if (!isStripeCheckoutManualReviewCandidate(checkout)) return null;
  const sessionSummary = checkout?.stripeSessionSummary || {};
  const quantity = manualReviewPositiveInteger(checkout?.quantity ?? sessionSummary?.metadata?.quantity ?? args.session?.metadata?.quantity);
  const amountTotal = manualReviewNonNegativeInteger(args.session?.amount_total ?? sessionSummary?.amount_total);
  const currency = manualReviewCurrency(args.session?.currency ?? sessionSummary?.currency);
  let owner = normalizedManualReviewString(checkout?.owner);
  let authSubject = '';
  try {
    const identity = normalizeStripeCheckoutIdentity(checkout);
    owner = identity.owner;
    authSubject = 'authSubject' in identity ? identity.authSubject : '';
  } catch {
    authSubject = '';
  }
  const manualRefundReviewReason = normalizedManualReviewString(checkout?.manualRefundReviewReason);
  const errorMessage = stripeCheckoutManualReviewErrorMessage(checkout);
  const createdAt = toMillisMaybe(checkout?.createdAt);
  const failedAt = toMillisMaybe(checkout?.failedAt);

  return {
    dropId: args.dropId,
    sessionId: requireStripeCheckoutSessionId(args.sessionId),
    owner,
    ...(authSubject ? { authSubject } : {}),
    ...(quantity ? { quantity } : {}),
    ...(amountTotal !== undefined ? { amountTotal } : {}),
    ...(currency ? { currency } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(failedAt !== undefined ? { failedAt } : {}),
    ...(manualRefundReviewReason ? { manualRefundReviewReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    address: stripeCheckoutManualReviewAddress({
      session: args.session,
      canViewSensitiveAddress: args.canViewSensitiveAddress,
    }),
  };
}

function requireStripeCheckoutFulfillmentContext<Runtime extends StripeCheckoutDropRuntime>(
  session: Stripe.Checkout.Session,
  deps: DropRuntimeDeps<Runtime>,
): { dropId: string; sessionId: string; dropRuntime: Runtime; checkoutKind: StripeCheckoutKind; variantKey?: string } {
  const sessionId = requireStripeCheckoutSessionId(session.id);
  if (!isStripeOffchainFulfillmentSession(session)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout session is not app-created off-chain fulfillment', {
      sessionId,
    });
  }

  const dropIdRaw = session.metadata?.dropId;
  const variantKeyRaw = session.metadata?.variantKey;
  if (!dropIdRaw) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout session is missing off-chain fulfillment metadata', {
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
    throw new StripeCheckoutFulfillmentError('failed-precondition', err instanceof Error ? err.message : String(err), {
      dropId: params.dropId,
      sessionId: params.sessionId,
    });
  }
}

function requireAppCreatedStripeCheckoutRecord(params: {
  dropId: string;
  variantKey?: string;
  sessionId: string;
  expectedLivemode?: boolean;
  key: CommerceDocumentKey<'stripe_checkout'>;
  record: CommerceDocumentRecord | null;
}): StripeCheckoutDocumentRecord {
  if (!params.record) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout session was not created by this app', {
      dropId: params.dropId,
      sessionId: params.sessionId,
    });
  }
  const checkout = params.record.data;
  const checkoutData = requireAppCreatedStripeCheckoutDocumentData({
    dropId: params.dropId,
    variantKey: params.variantKey,
    sessionId: params.sessionId,
    expectedLivemode: params.expectedLivemode,
    checkout,
  });
  return { key: params.key, checkout, ...checkoutData };
}

function stripeCheckoutFailureStateClearUpdate(): Record<string, unknown> {
  return {
    lastFulfillmentError: commerceFieldValue.delete(),
    lastRetryableFulfillmentAttempt: commerceFieldValue.delete(),
    lastRetryableFulfillmentError: commerceFieldValue.delete(),
    lastRetryableFulfillmentErrorAt: commerceFieldValue.delete(),
    manualRefundReviewRequired: commerceFieldValue.delete(),
    manualRefundReviewReason: commerceFieldValue.delete(),
    nextFulfillmentRetryAt: commerceFieldValue.delete(),
    failedAt: commerceFieldValue.delete(),
  };
}

function stripeCheckoutProcessingStateClearUpdate(): Record<string, unknown> {
  return {
    processingAttemptId: commerceFieldValue.delete(),
    processingLeaseExpiresAt: commerceFieldValue.delete(),
  };
}

function stripeCheckoutFulfillmentClearUpdate(): Record<string, unknown> {
  return {
    ...stripeCheckoutFailureStateClearUpdate(),
    ...stripeCheckoutProcessingStateClearUpdate(),
  };
}

export type StripeCheckoutFulfillmentCompletionFields = {
  fulfillmentCompletedBy: string;
  fulfillmentCompletedAt: unknown;
};

function stripeCheckoutFulfilledUpdate(params: {
  before: Record<string, unknown> | null;
  deliveryId: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
  fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
}): Record<string, unknown> {
  const metadataIds = normalizedMetadataIds(params.metadataIds, params.metadataId);
  const metadataId = metadataIds.length === 1 ? metadataIds[0] : undefined;
  return {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    ...createStripeTerminalNotificationOutboxFields(params.before, 'fulfilled'),
    deliveryId: params.deliveryId,
    ...(metadataId ? { metadataId } : metadataIds.length > 1 ? { metadataId: commerceFieldValue.delete() } : {}),
    ...(metadataIds.length ? { metadataIds, quantity: metadataIds.length } : {}),
    ...(typeof params.receiptTx === 'string' || params.receiptTx === null ? { receiptTx: params.receiptTx } : {}),
    ...params.fulfillmentCompletionFields,
    fulfilledAt: commerceFieldValue.serverTimestamp(),
    ...stripeCheckoutFulfillmentClearUpdate(),
    updatedAt: commerceFieldValue.serverTimestamp(),
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
  commerce: StripeCheckoutCommerceContext,
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>,
  params: {
    deliveryId: number;
    metadataId?: number;
    metadataIds?: number[];
    receiptTx?: string | null;
    processingAttemptId?: string;
    fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
  },
): Promise<StripeCheckoutFulfillmentSuccessMarkResult> {
  return runCommerceTransaction(commerce, async (tx) => {
    const record = await tx.get(checkoutKey);
    const checkout = record?.data ?? null;
    if (params.processingAttemptId) {
      const status = stripeCheckoutFulfilledWriteStatus(checkout, params.processingAttemptId);
      if (status === 'already_fulfilled') return { status: 'already_fulfilled' as const };
      if (status === 'stale_processing_attempt') return { status: 'stale_processing_attempt' as const };
    }
    await tx.update(checkoutKey, stripeCheckoutWriteData(stripeCheckoutFulfilledUpdate({ ...params, before: checkout })));
    return { status: 'fulfilled' as const };
  }, { shouldRetry: (error) => error.code === 'aborted' }).catch((err) => {
    if (!params.processingAttemptId) throw err;
    throw new StripeCheckoutProcessingAttemptOwnershipCheckError(err);
  });
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

function readStripeOffchainDeliveryOrderMarker(marker: Record<string, unknown>): StripeOffchainDeliveryOrderMarker | null {
  const deliveryId = Math.floor(Number(marker.deliveryId));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;
  const metadataId = positiveInteger(marker.metadataId);
  const metadataIds = normalizedMetadataIds(marker.metadataIds, metadataId);
  const receiptTx = receiptTxMaybe(marker.receiptTx);
  return {
    deliveryId,
    ...(metadataId ? { metadataId } : {}),
    ...(metadataIds.length ? { metadataIds } : {}),
    ...(typeof receiptTx === 'string' || receiptTx === null ? { receiptTx } : {}),
  };
}

async function fetchStripeOffchainDeliveryOrderMarker(params: {
  commerce: StripeCheckoutCommerceContext;
  dropId: string;
  orderHashHex: string;
}): Promise<StripeOffchainDeliveryOrderMarker | null> {
  params.commerce.signal?.throwIfAborted();
  const marker = await params.commerce.repository.get(commerceKeys.offchainOrder(params.dropId, params.orderHashHex));
  params.commerce.signal?.throwIfAborted();
  return marker ? readStripeOffchainDeliveryOrderMarker(marker.data) : null;
}

export async function createOrGetStripeOffchainDeliveryOrder<Runtime extends StripeCheckoutPackStatusRuntime = StripeCheckoutPackStatusRuntime>(params: {
  commerce: StripeCheckoutCommerceContext;
  dropRuntime?: Runtime;
  order: StripeOffchainDeliveryOrderDraft;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  isAlreadyExistsError: (err: unknown) => boolean;
  processingAttemptId?: string;
  fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
  countPackStatus?: StripeCheckoutPackStatusCounter<Runtime>;
  logPackStatusError?: (entry: Record<string, unknown>) => void;
}): Promise<StripeOffchainDeliveryOrderResult> {
  const { commerce, order, checkoutKey } = params;
  const { dropId, orderHashHex } = order;
  if (params.dropRuntime && params.dropRuntime.dropId !== dropId) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout drop runtime does not match the delivery order drop.', {
      orderDropId: dropId,
      runtimeDropId: params.dropRuntime.dropId,
    });
  }
  const metadataIds = normalizedMetadataIds(order.metadataIds, order.metadataId);
  const quantity = normalizeStripeCheckoutQuantity(metadataIds.length);
  const markerKey = commerceKeys.offchainOrder(dropId, orderHashHex);
  const MAX_DELIVERY_ID_ATTEMPTS = 16;
  const MAX_CLAIM_CODE_ATTEMPTS = 40;
  const maxAttempts = MAX_DELIVERY_ID_ATTEMPTS * MAX_CLAIM_CODE_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const orderKey = commerceKeys.deliveryOrder(dropId, String(candidate));
    const claimCodes = generateUniqueStripeReceiptClaimCodes(quantity);
    const claimKeys = claimCodes.map((claimCode) => commerceKeys.claimCode(claimCode));

    try {
      const operation = () => runCommerceTransaction(commerce, async (tx) => {
        const [marker, checkoutSnap] = await tx.getMany([markerKey, checkoutKey]);
        const checkout = checkoutSnap?.data ?? null;
        const checkoutStatus = stripeCheckoutFulfilledWriteStatus(
          params.processingAttemptId ? checkout : null,
          params.processingAttemptId,
        );
        if (marker) {
          const existingOrder = readStripeOffchainDeliveryOrderMarker(marker.data);
          if (existingOrder) {
            if (checkoutStatus === 'stale_processing_attempt') {
              return { checkoutStatus };
            }
            if (checkoutStatus === 'fulfilled') {
              await tx.update(
                checkoutKey,
                stripeCheckoutWriteData(stripeCheckoutFulfilledUpdate({
                  before: checkout,
                  deliveryId: existingOrder.deliveryId,
                  metadataId: existingOrder.metadataId,
                  metadataIds: existingOrder.metadataIds,
                  receiptTx: existingOrder.receiptTx,
                  fulfillmentCompletionFields: params.fulfillmentCompletionFields,
                })),
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
        await tx.getMany([orderKey, ...claimKeys]);
        await tx.create(orderKey, stripeCheckoutWriteData({
          ...buildStripeOffchainDeliveryOrderDocument(deliveryOrder),
          processedAt: commerceFieldValue.serverTimestamp(),
          createdAt: commerceFieldValue.serverTimestamp(),
        }));
        await tx.create(markerKey, stripeCheckoutWriteData({
          ...buildStripeOffchainOrderMarkerDocument(deliveryOrder),
          createdAt: commerceFieldValue.serverTimestamp(),
        }));
        for (const [index, claim] of stripeReceiptClaims.entries()) {
          await tx.create(claimKeys[index], stripeCheckoutWriteData({
            version: 1,
            namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
            code: claim.code,
            dropId,
            deliveryId: candidate,
            owner: order.owner,
            ownerKind: order.ownerKind,
            ...(order.authSubject ? { authSubject: order.authSubject } : {}),
            receiptOwner: order.receiptOwner,
            boxId: claim.boxId,
            ...(order.variantKey ? { variantKey: order.variantKey } : {}),
            offchainOrderHash: order.orderHashHex,
            stripeCheckoutSessionId: order.stripeSession.id,
            status: 'unclaimed',
            createdAt: commerceFieldValue.serverTimestamp(),
          }));
        }
        if (checkoutStatus === 'fulfilled') {
          await tx.update(
            checkoutKey,
            stripeCheckoutWriteData({
              ...stripeCheckoutFulfilledUpdate({
                before: checkout,
                deliveryId: candidate,
                ...(metadataIds.length === 1 ? { metadataId: metadataIds[0] } : {}),
                metadataIds,
                receiptTx: order.receiptTx,
                fulfillmentCompletionFields: params.fulfillmentCompletionFields,
              }),
            }),
          );
        }
        return { deliveryId: candidate, checkoutStatus, created: true };
      }, { shouldRetry: (error) => error.code === 'aborted' });
      const result = await operation();
      if (
        params.dropRuntime &&
        params.countPackStatus &&
        (result.checkoutStatus === 'fulfilled' || result.checkoutStatus === 'already_fulfilled') &&
        result.deliveryId
      ) {
        try {
          await params.countPackStatus({
            dropRuntime: params.dropRuntime,
            orderHashHex,
            quantity,
            deliveryId: result.deliveryId,
            checkoutSessionId: String(order.stripeSession.id || ''),
          });
        } catch (err) {
          params.logPackStatusError?.({
            event: 'stripe_checkout_pack_status_count_failed',
            dropId,
            orderHashHex,
            deliveryId: result.deliveryId,
            error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
          });
          throw new StripeCheckoutPackStatusProjectionError(err);
        }
      }
      return result;
    } catch (err) {
      if (params.isAlreadyExistsError(err)) continue;
      throw err;
    }
  }

  throw new StripeCheckoutFulfillmentError('unavailable', 'Failed to allocate off-chain delivery id or receipt claim code (try again)');
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
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order PDA has an unexpected owner', {
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
  commerce: StripeCheckoutCommerceContext;
  session: Stripe.Checkout.Session;
  stripe: Stripe;
  checkout: StripeCheckoutDocumentRecord;
  expectedDropId: string;
  expectedSessionId: string;
  expectedVariantKey?: string;
  processingAttemptId?: string;
  fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
}): Promise<{
  dropId: string;
  deliveryId?: number;
  metadataId?: number;
  metadataIds?: number[];
  receiptTx?: string | null;
}> {
  const { commerce, session, stripe, checkout, deps } = params;
  const sessionId = requireStripeCheckoutSessionId(session.id);
  if (sessionId !== params.expectedSessionId) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Fetched Stripe checkout session id does not match the pending fulfillment', {
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
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout metadata does not match the pending fulfillment', {
      sessionId,
      expectedDropId: dropId,
      actualDropId: metadataContext.dropId,
      expectedVariantKey: variantKey,
      actualVariantKey: metadataContext.variantKey,
    });
  }
  if (Boolean(session.livemode) !== expectedLivemode || checkout.livemode !== expectedLivemode) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Stripe checkout mode does not match the drop cluster', {
      dropId,
      sessionId,
      cluster: dropRuntime.cluster,
      sessionLivemode: Boolean(session.livemode),
      checkoutLivemode: checkout.livemode,
    });
  }
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new StripeCheckoutFulfillmentError('unavailable', 'Receipt cNFT tree is not configured', { dropId });
  }

  const variantIndex =
    checkoutKind === 'size_variant'
      ? resolveMintSelectionVariantIndex(dropRuntime.config.mintSelection, variantKey || '')
      : 0;
  const orderHash = stripeCheckoutSessionOrderHash(sessionId, Boolean(session.livemode));
  const orderHashHex = orderHash.toString('hex');
  const existingOrder = await fetchStripeOffchainDeliveryOrderMarker({ commerce, dropId, orderHashHex });
  if (existingOrder) {
    const markResult = await markStripeCheckoutFulfillmentFulfilled(commerce, checkout.key, {
      deliveryId: existingOrder.deliveryId,
      metadataId: existingOrder.metadataId,
      metadataIds: existingOrder.metadataIds,
      receiptTx: existingOrder.receiptTx,
      processingAttemptId: params.processingAttemptId,
      fulfillmentCompletionFields: params.fulfillmentCompletionFields,
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

  const lineItems = await fetchStripeCheckoutLineItems(stripe, session, deps.signal);
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
    throw new StripeCheckoutFulfillmentError('failed-precondition', err instanceof Error ? err.message : String(err), {
      sessionId: session.id,
    });
  }
  const addressSnapshot = requireStripeOffchainAddressSnapshot({
    session,
    encryptAddress: deps.encryptAddress,
    normalizeCountryCode: deps.normalizeCountryCode,
    dropFamily: dropRuntime.config.dropFamily,
  });
  const conn = deps.connection(dropRuntime);

  const cfg = await deps.ensureOnchainCoreConfig(dropRuntime);
  const signer = deps.cosigner();
  if (!signer.publicKey.equals(cfg.admin)) {
    throw new StripeCheckoutFulfillmentError('unavailable', 'COSIGNER_SECRET does not match on-chain admin', {
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
      'getLatestBlockhash:stripeCheckoutFulfillment',
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
    throw new StripeCheckoutFulfillmentError('unavailable', 'Admin order record was not created', {
      adminOrderPda: adminOrderPda.toBase58(),
      dropId,
    });
  }
  if (!record.orderHash.equals(orderHash)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record hash mismatch', { dropId, adminOrderPda: adminOrderPda.toBase58() });
  }
  if (record.variantIndex !== variantIndex) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record variant mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedVariantIndex: variantIndex,
      actualVariantIndex: record.variantIndex,
    });
  }
  if (record.quantity !== checkout.quantity) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record quantity mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedQuantity: checkout.quantity,
      actualQuantity: record.quantity,
    });
  }
  if (record.bump !== orderBump) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record bump mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedBump: orderBump,
      actualBump: record.bump,
    });
  }
  if (!record.receiptOwner.equals(receiptOwner)) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record receipt owner mismatch', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      expectedOwner: receiptOwner.toBase58(),
      actualOwner: record.receiptOwner.toBase58(),
    });
  }
  if (record.firstMetadataId < 1) {
    throw new StripeCheckoutFulfillmentError('failed-precondition', 'Admin order record metadata id is invalid', {
      dropId,
      adminOrderPda: adminOrderPda.toBase58(),
      firstMetadataId: record.firstMetadataId,
    });
  }
  const metadataId = record.firstMetadataId;
  const metadataIds = Array.from({ length: checkout.quantity }, (_, index) => metadataId + index);
  const authSubject = checkout.ownerKind === STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS
    ? checkout.authSubject
    : undefined;
  const walletOwner = !authSubject || !deps.resolveWalletOwner
    ? null
    : await deps.resolveWalletOwner(authSubject);

  const order = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    dropRuntime,
    order: {
      dropId,
      orderHashHex,
      owner: walletOwner || checkout.owner,
      ownerKind: walletOwner ? STRIPE_CHECKOUT_OWNER_KIND_WALLET : checkout.ownerKind,
      ...(authSubject ? { authSubject } : {}),
      receiptOwner: receiptOwner.toBase58(),
      metadataId,
      metadataIds,
      ...(variantKey ? { variantKey } : {}),
      stripeSession: session,
      receiptTx,
      addressSnapshot,
    },
    checkoutKey: checkout.key,
    isAlreadyExistsError: deps.isAlreadyExistsError,
    processingAttemptId: params.processingAttemptId,
    fulfillmentCompletionFields: params.fulfillmentCompletionFields,
    countPackStatus: deps.countPackStatus,
    logPackStatusError: deps.logPackStatusError,
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

export async function startStripeCheckoutFulfillmentDocument(params: {
  commerce: StripeCheckoutCommerceContext;
  dropId: string;
  sessionId: string;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  expectedLivemode?: boolean;
  nowMs?: number;
}): Promise<StripeCheckoutFulfillmentStart> {
  const { commerce, dropId, sessionId, checkoutKey } = params;
  const nowMs = Math.floor(Number(params.nowMs ?? Date.now()));
  const processingAttemptId = createStripeCheckoutProcessingAttemptId(nowMs);
  return runCommerceTransaction(commerce, async (tx) => {
    const snap = await tx.get(checkoutKey);
    if (!snap) return { started: false, reason: 'not_pending' };
    const checkoutData = snap.data;
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
    const checkout = requireAppCreatedStripeCheckoutRecord({
      dropId,
      ...(variantKey ? { variantKey } : {}),
      sessionId,
      expectedLivemode: params.expectedLivemode,
      key: checkoutKey,
      record: snap,
    });

    await tx.update(checkoutKey, stripeCheckoutWriteData({
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingStartedAt: commerceFieldValue.serverTimestamp(),
      processingAttemptCount: commerceFieldValue.increment(1),
      ...stripeCheckoutFailureStateClearUpdate(),
      processingAttemptId,
      processingLeaseExpiresAt: commerceTimestamp(nowMs + STRIPE_CHECKOUT_PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    }));
    return { started: true, checkoutKey, checkout, ...(variantKey ? { variantKey } : {}), processingAttemptId };
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

export type StripeCheckoutFulfillmentFailureMarkResult =
  | { status: 'failed' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

export type StripeCheckoutFulfillmentRetryReleaseResult =
  | { status: 'released' }
  | { status: 'already_fulfilled' }
  | { status: 'stale_processing_attempt' };

export async function releaseStripeCheckoutFulfillmentForRetry(
  commerce: StripeCheckoutCommerceContext,
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>,
  err: unknown,
  params: {
    summarizeError: (err: unknown) => unknown;
    processingAttemptId: string;
  },
): Promise<StripeCheckoutFulfillmentRetryReleaseResult> {
  return runCommerceTransaction(commerce, async (tx) => {
    const checkoutSnap = await tx.get(checkoutKey);
    const checkout = checkoutSnap?.data ?? null;
    const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, params.processingAttemptId);
    if (writeStatus !== 'current') return { status: writeStatus };
    await tx.update(checkoutKey, stripeCheckoutWriteData({
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      lastRetryableFulfillmentAttempt: STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS,
      lastRetryableFulfillmentError: params.summarizeError(err),
      lastRetryableFulfillmentErrorAt: commerceFieldValue.serverTimestamp(),
      nextFulfillmentRetryAt: commerceFieldValue.delete(),
      processingStartedAt: commerceFieldValue.delete(),
      ...stripeCheckoutProcessingStateClearUpdate(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    }));
    return { status: 'released' as const };
  }, { shouldRetry: (error) => error.code === 'aborted' }).catch((error) => {
    throw new StripeCheckoutProcessingAttemptOwnershipCheckError(error);
  });
}

export async function markStripeCheckoutFulfillmentFailed(
  commerce: StripeCheckoutCommerceContext,
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>,
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
  return runCommerceTransaction(commerce, async (tx) => {
    const checkoutSnap = await tx.get(checkoutKey);
    const checkout = checkoutSnap?.data ?? null;
    const writeStatus = stripeCheckoutProcessingAttemptWriteStatus(checkout, params.processingAttemptId);
    if (writeStatus === 'already_fulfilled') {
      return { status: 'already_fulfilled' as const };
    }
    if (writeStatus === 'stale_processing_attempt') {
      return { status: 'stale_processing_attempt' as const };
    }

    await tx.set(
      checkoutKey,
      stripeCheckoutWriteData({
        ...identityUpdate,
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
        ...createStripeTerminalNotificationOutboxFields(checkout, 'manual_review'),
        failedAt: commerceFieldValue.serverTimestamp(),
        lastFulfillmentError: error,
        manualRefundReviewRequired: true,
        manualRefundReviewReason: STRIPE_MANUAL_REFUND_REASON,
        nextFulfillmentRetryAt: commerceFieldValue.delete(),
        ...stripeCheckoutProcessingStateClearUpdate(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      }),
      { merge: true },
    );
    return { status: 'failed' as const };
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

export async function processStripeCheckoutFulfillmentDocument<
  Runtime extends StripeCheckoutDropRuntime,
  Config extends StripeCheckoutOnchainConfig,
>(params: {
  commerce: StripeCheckoutCommerceContext;
  dropId: string;
  sessionId: string;
  checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
  apiKeys: readonly string[];
  deps: StripeCheckoutFlowDeps<Runtime, Config>;
  treatRetryableFailureAsTerminal?: boolean;
  fulfillmentCompletionFields?: StripeCheckoutFulfillmentCompletionFields;
}): Promise<StripeCheckoutFulfillmentProcessResult> {
  const { commerce, dropId, sessionId, checkoutKey, deps } = params;
  const dropRuntime = deps.getDropRuntime(dropId);
  const mode = stripeApiModeForCluster(dropRuntime.cluster);
  const expectedLivemode = mode === 'live';

  let started: StripeCheckoutFulfillmentStart;
  try {
    started = await startStripeCheckoutFulfillmentDocument({ commerce, dropId, sessionId, checkoutKey, expectedLivemode });
  } catch (err) {
    if (isRetryableStripeCheckoutFulfillmentError(err) && !params.treatRetryableFailureAsTerminal) {
      throw err;
    }
    const markResult = await markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, err, {
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
      throw new StripeCheckoutFulfillmentError('aborted', 'Stripe checkout fulfillment processing lease is still active', {
        dropId,
        sessionId,
      });
    }
    if (started.reason === 'already_fulfilled' && deps.repairPackStatus) {
      await deps.repairPackStatus({ dropRuntime, checkoutKey, sessionId });
    }
    return { status: 'ignored', dropId, sessionId, reason: started.reason };
  }

  try {
    let checkoutSessionResult: Awaited<ReturnType<typeof fetchStripeCheckoutSession>> | undefined;
    const result = await runStripeCheckoutFulfillmentWithRetry(
      async () => {
        if (!checkoutSessionResult) {
          checkoutSessionResult = await fetchStripeCheckoutSession(sessionId, params.apiKeys, mode, deps.signal);
        }
        const { session, stripe } = checkoutSessionResult;
        return fulfillStripeCheckoutSession({
          commerce,
          session,
          stripe,
          checkout: started.checkout,
          expectedDropId: dropId,
          expectedSessionId: sessionId,
          expectedVariantKey: started.variantKey,
          processingAttemptId: started.processingAttemptId,
          fulfillmentCompletionFields: params.fulfillmentCompletionFields,
          deps,
        });
      },
      {
        commerce,
        checkoutKey: started.checkoutKey,
        summarizeError: deps.summarizeError,
        processingAttemptId: started.processingAttemptId,
      },
    );
    return { status: 'fulfilled', sessionId, ...result };
  } catch (err) {
    if (err instanceof StripeCheckoutPackStatusProjectionError) throw err;
    if (err instanceof StripeCheckoutProcessingAttemptOwnershipCheckError) {
      throw err;
    }
    if (err instanceof StaleStripeCheckoutProcessingAttemptError) {
      return { status: 'ignored', dropId, sessionId, reason: 'stale_processing_attempt' };
    }
    if (isRetryableStripeCheckoutFulfillmentError(err) && !params.treatRetryableFailureAsTerminal) {
      const releaseResult = await releaseStripeCheckoutFulfillmentForRetry(commerce, started.checkoutKey, err, {
        summarizeError: deps.summarizeError,
        processingAttemptId: started.processingAttemptId,
      });
      if (releaseResult.status !== 'released') {
        return { status: 'ignored', dropId, sessionId, reason: releaseResult.status };
      }
      throw err;
    }
    const markResult = await markStripeCheckoutFulfillmentFailed(commerce, started.checkoutKey, err, {
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
