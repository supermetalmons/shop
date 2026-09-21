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
  stripeCheckoutSessionOrderHash,
  stripeFulfillmentAddressFromSession,
  validateStripeCheckoutContract,
  type DecodedAdminDeliveryOrderRecord,
  type StripeAddressEncryptionResult,
} from './contract.js';
import {
  isStripeCredentialError,
  selectStripeApiKeys,
  stripeApiKeyKindForLog,
  stripeCredentialErrorSummary,
  type StripeApiMode,
} from '../stripeProviderConfig.js';
import { stripeClientForKey } from './provider.js';
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
import { StripeCheckoutFulfillmentError, StripeCheckoutProcessingAttemptOwnershipCheckError } from './errors.js';
import { isSignalCancellationError, sleepWithSignal } from '../boundedRequest.js';
import type { CommerceDocumentKey } from '../commerceRepository.js';
import type { StripeCheckoutCommerceContext, ValidatedStripeCheckoutRecord } from './commerce.js';
import {
  fetchStripeOffchainDeliveryOrderMarker,
  markStripeCheckoutFulfillmentFailed,
  markStripeCheckoutFulfillmentFulfilled,
  normalizedMetadataIds,
  publishStripeOffchainDeliveryOrder,
  recordStripeCheckoutRetryableFulfillmentError,
  releaseStripeCheckoutFulfillmentForRetry,
  startStripeCheckoutFulfillmentDocument,
  STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS,
  type StripeCheckoutFulfillmentCompletionFields,
  type StripeCheckoutFulfillmentStart,
  type StripeCheckoutFulfillmentStartSkippedReason,
  type StripeOffchainDeliveryOrderDraft,
  type StripeOffchainDeliveryOrderResult,
} from './store.js';
export {
  markStripeCheckoutFulfillmentFailed,
  markStripeCheckoutFulfillmentFulfilled,
  releaseStripeCheckoutFulfillmentForRetry,
  startStripeCheckoutFulfillmentDocument,
  type StripeCheckoutFulfillmentCompletionFields,
} from './store.js';
export { STRIPE_CHECKOUT_PROCESSING_LEASE_MS } from './contract.js';

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
  runRpc: <T>(
    dropRuntime: Runtime,
    operation: (connection: Connection) => Promise<T>,
    timeoutMs: number,
    label: string,
  ) => Promise<T>;
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
    dropRuntime: Runtime,
    tx: VersionedTransaction,
    label: string,
    opts?: { sendTimeoutMs?: number; confirmTimeoutMs?: number },
  ) => Promise<string>;
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

const STRIPE_CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9_:-]{4,256}$/;
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

function normalizeFulfillmentCancellation(error: unknown, signal?: AbortSignal): unknown {
  if (!signal || !isSignalCancellationError(signal, error)) return error;
  if (error instanceof StripeCheckoutFulfillmentError) return error;
  const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  const cancellation = new StripeCheckoutFulfillmentError(
    timedOut ? 'deadline-exceeded' : 'aborted',
    timedOut ? 'Stripe checkout fulfillment timed out' : 'Stripe checkout fulfillment was cancelled',
  );
  Object.defineProperty(cancellation, 'cause', { value: signal.reason });
  return cancellation;
}

class StaleStripeCheckoutProcessingAttemptError extends Error {
  constructor() {
    super('Stripe checkout fulfillment attempt no longer owns the processing lease');
    this.name = 'StaleStripeCheckoutProcessingAttemptError';
  }
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
    signal?: AbortSignal;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(Number(params.maxAttempts ?? STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS)));
  const retryDelayMs = Math.max(0, Math.floor(Number(params.retryDelayMs ?? STRIPE_CHECKOUT_FULFILLMENT_RETRY_DELAY_MS)));
  const signal = params.signal || new AbortController().signal;
  let attempt = 1;

  while (true) {
    signal.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (err) {
      if (signal.aborted || attempt >= maxAttempts || !isRetryableStripeCheckoutFulfillmentError(err)) throw err;

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
      try {
        await sleepWithSignal(retryDelayMs, signal);
      } catch (error) {
        if (isSignalCancellationError(signal, error)) throw err;
        throw error;
      }
      attempt += 1;
    }
  }
}

export function stripeTestApiKey(apiKeys: readonly string[]): string {
  return stripeApiKeyForMode(apiKeys, 'test');
}

export function stripeApiKeysForMode(apiKeys: readonly string[], mode: StripeApiMode): string[] {
  const keys = selectStripeApiKeys(apiKeys, mode);
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
  const MAX_DELIVERY_ID_ATTEMPTS = 16;
  const MAX_CLAIM_CODE_ATTEMPTS = 40;
  const maxAttempts = MAX_DELIVERY_ID_ATTEMPTS * MAX_CLAIM_CODE_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const claimCodes = generateUniqueStripeReceiptClaimCodes(quantity);

    try {
      const result = await publishStripeOffchainDeliveryOrder({
        commerce,
        order,
        checkoutKey,
        deliveryId: candidate,
        claimCodes,
        processingAttemptId: params.processingAttemptId,
        fulfillmentCompletionFields: params.fulfillmentCompletionFields,
      });
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

async function fetchAdminDeliveryOrderRecord<Runtime extends StripeCheckoutDropRuntime>(params: {
  dropRuntime: Runtime;
  adminOrderPda: PublicKey;
  context: string;
  deps: Pick<StripeCheckoutFlowDeps<Runtime, StripeCheckoutOnchainConfig>, 'runRpc' | 'rpcTimeoutMs'>;
}): Promise<DecodedAdminDeliveryOrderRecord | null> {
  const { dropRuntime, adminOrderPda, context, deps } = params;
  const info = await deps.runRpc(
    dropRuntime,
    async (connection) => (await connection.getAccountInfoAndContext(
      adminOrderPda,
      { commitment: 'confirmed' },
    )).value,
    deps.rpcTimeoutMs,
    context,
  );
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
  checkout: ValidatedStripeCheckoutRecord;
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
    const { blockhash } = await deps.runRpc(
      dropRuntime,
      async (connection) => (await connection.getLatestBlockhashAndContext('confirmed')).value,
      deps.rpcTimeoutMs,
      'getLatestBlockhash:stripeCheckoutFulfillment',
    );
    const tx = deps.buildTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix], signer.publicKey, blockhash, [signer]);
    try {
      receiptTx = await deps.sendAndConfirmSignedTx(dropRuntime, tx, 'adminDeliverVariantOrder', {
        sendTimeoutMs: deps.txSendTimeoutMs,
        confirmTimeoutMs: deps.txConfirmTimeoutMs,
      });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      const maybeRecord = await fetchAdminDeliveryOrderRecord({
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
    deps.signal?.throwIfAborted();
    started = await startStripeCheckoutFulfillmentDocument({ commerce, dropId, sessionId, checkoutKey, expectedLivemode });
  } catch (error) {
    const err = normalizeFulfillmentCancellation(error, deps.signal);
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
        signal: deps.signal,
      },
    );
    return { status: 'fulfilled', sessionId, ...result };
  } catch (error) {
    const err = normalizeFulfillmentCancellation(error, deps.signal);
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
