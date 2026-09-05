import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  type VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  MAX_U32,
  TX_SEND_TIMEOUT_MS,
  TX_CONFIRM_TIMEOUT_MS,
  buildTransaction,
  closeDeliveryInstruction,
  createConnection,
  decodeCosigner,
  deriveDeliveryPda,
  fetchOnchainConfig,
  hasConfirmedSignatureCommitment,
  looksLikeAccountInUseError,
  looksLikeBlockhashError,
  looksLikeRateLimitOrRpcError,
  mintReceiptsInstruction,
  mplCoreBurnInstruction,
  sendAndConfirmSignedTransaction,
  transactionErrorLogs,
  transactionErrorMessage,
  unknownTransactionSubmissionError,
  waitForSignature,
  type DeliveryRuntime,
  type ProviderContext,
} from './deliveryReceiptOnchain.js';
import {
  DeliveryReceiptError,
  mapProviderError,
  summarizeDeliveryReceiptError as summarizeError,
} from './deliveryReceiptErrors.js';
import { transactionAccountKeys } from './receiptTransferVerification.js';
import {
  API_DROPS,
  getApiDrop,
} from './dropConfig.js';
import {
  IRL_CLAIM_CODE_DIGITS,
  IRL_CLAIM_CODE_NAMESPACE,
  normalizeIrlClaimCode,
} from './claimCodes.js';
import {
  dropBoxAssignmentPath,
  dropDeliveryOrderPath,
} from './dropPaths.js';
import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import {
  DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS,
  DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
  buildRecoverDeliveryOrdersResult,
  buildWalletDeliveryRecoveryState,
  nextPreparedDeliveryRecoveryDelayMs,
  preparedDeliveryRecoveryNextCheckMs,
  processingDeliveryRecoveryNextCheckMs,
} from '../../../../shared/deliveryRecovery.js';
import {
  PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
  PACK_STATUS_PROJECTION_PENDING,
  PACK_STATUS_PROJECTION_STATE_FIELD,
} from '../../../../shared/deliveryPackStatusProjectionReconciliation.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import type {
  DeliveryRecoveryOutcome,
  IssueReceiptsResult,
  RecoverDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult,
  WalletDeliveryRecoveryState,
} from '../../../../shared/contracts.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import {
  isAdminIrlRedeemDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../../../../shared/fulfillmentSources.js';
import {
  countDeliveryOrderBoxItems,
  countDeliveryOrderDudeItems,
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
  type PackStatusEvent,
} from '../../../../shared/packStatus.js';
import {
  isBase58Bytes,
  isNonZeroBase58Bytes,
} from '../../../../shared/solanaRpcProxy.js';
import { RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  isSignalCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
  sleepWithSignal,
} from './boundedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  isCommerceDeleteField,
  type CommerceDocumentData,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
  type CommerceJsonValue,
  type CommerceUnitOfWork,
} from './commerceRepository.js';
import {
  CommerceDudeAssignmentError,
  assignCommerceDudes,
  normalizeCommerceDudeIds,
} from './commerceDudeAssignments.js';
import {
  beginCommerceTransaction as beginTransaction,
  commitCommerceWrites as commitWrites,
  commerceDocument,
  commerceRepository as repository,
  commerceTimestamp,
  createCommerceWrite as createWrite,
  readCommerceDocument as readDocument,
  retryCommerceConflicts,
  rollbackCommerceTransaction as rollbackTransactionBestEffort,
  runCommerceWriteTransaction,
  updateCommerceWrite as updateWrite,
  type CommerceDocument,
  type CommerceDocumentContext,
  type CommerceWrite,
} from './commerceTransactions.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import { createReadyToShipNotificationOutbox } from './readyToShipNotifications.js';
import {
  publishReadyToShipNotifications,
  ReadyToShipNotificationEnqueueError,
} from './readyToShipNotificationOutbox.js';
import { applyPackStatusProjection } from './packStatusProjection.js';
import {
  registerDeferredWork,
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';

export const DELIVERY_RECEIPTS_ISSUE_PATH = '/delivery/receipts/issue';
export const DELIVERY_RECEIPTS_RECOVER_PATH = '/delivery/receipts/recover';

const REQUEST_MAX_BYTES = 4096;
const HANDLER_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PACK_STATUS_TIMEOUT_MS = 10_000;
const PENDING_READY_NOTIFICATION_QUERY_PAGE_SIZE = 8;
const PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE = 4;
const PACK_STATUS_PROJECTION_RECONCILIATION_CONCURRENCY = 2;
const PACK_STATUS_PROJECTION_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;
const PACK_STATUS_PROJECTION_COMPLETED = 'completed';
const PACK_STATUS_PROJECTION_FAILED = 'failed';
const PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD = 'packStatusProjectionFailureCount';
const PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD = 'packStatusProjectionCompletedAt';
const PACK_STATUS_PROJECTION_FAILED_AT_FIELD = 'packStatusProjectionFailedAt';
const PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD = 'packStatusProjectionLastErrorCode';
const TX_MAX_SEND_ATTEMPTS = 3;
const DELIVERY_RECOVERY_LEASE_MS = 90_000;
const DELIVERY_AMBIGUOUS_SUBMISSION_LEASE_MS = 4 * 60_000;
const RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD = 'receiptRecovery.pendingSubmission';
const MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL = 2;
const MAX_PREPARED_DELIVERY_RECOVERY_CHECKS = DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const CANONICAL_DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACCOUNT_DELIVERY_RECORD = Buffer.from('2b0f869afad50393', 'hex');
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');

const deliveryIdSchema = z.number().int().min(1).max(MAX_U32);
const dropIdSchema = z.string().min(1).max(64).refine((value) =>
  CANONICAL_DROP_ID_PATTERN.test(value) && normalizeDropId(value) === value);

const issueSchema = z.object({
  owner: z.string().min(32).max(64),
  deliveryId: deliveryIdSchema,
  signature: z.string().min(64).max(128),
  dropId: dropIdSchema,
}).strict();

const recoverSchema = z.object({
  dropId: dropIdSchema.optional(),
  deliveryId: deliveryIdSchema.optional(),
  force: z.boolean().optional(),
}).strict();

type IssueRequest = z.infer<typeof issueSchema>;
type RecoverRequest = z.infer<typeof recoverSchema>;

type DeliveryReceiptsEnv = Pick<
  Env,
  'COSIGNER_SECRET' | 'HELIUS_API_KEY' | 'NOTIFICATION_EMAIL_QUEUE' | 'OPS_DB'
> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;

class ReceiptBatchRetryExhaustedError extends DeliveryReceiptError {
  constructor(lastError: unknown) {
    super('unavailable', 'Unable to issue receipts. Retry later.', {
      lastError: transactionErrorMessage(lastError),
    });
    this.name = 'ReceiptBatchRetryExhaustedError';
  }
}

class DeliveryPackStatusProjectionInvalidError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeliveryPackStatusProjectionInvalidError';
  }
}

type CommerceContext = CommerceDocumentContext & {
  providerFetch: ProfileProviderFetch;
  dataDb?: D1Database;
  [key: string]: unknown;
};

type DeliveryOrderDocument = CommerceDocument;

type VerifiedReceiptIssuanceTarget = {
  verification: 'signature' | 'delivery_pda';
  signature: string | null;
  expectedDeliveryPda: PublicKey;
  expectedDeliveryBump: number;
  targetAssetIds: string[];
};

type RetryIssueReceiptsArgs = {
  ownerWallet: string;
  deliveryId: number;
  dropId: string;
} & ({ verification: 'signature'; signature: string } | { verification: 'delivery_pda' });

type ReceiptIssueResult = {
  processed: true;
  deliveryId: number;
  receiptsMinted: number;
  receiptTxs: string[];
  closeDeliveryTx: string | null;
};

type PendingReceiptSubmission = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  assetIds: string[];
};

type ReceiptSubmissionOutcome = 'confirmed' | 'expired' | 'unresolved';

type ReceiptSubmissionLifecycle = {
  prepare(pending: PendingReceiptSubmission): Promise<void>;
  reconcile(pending: PendingReceiptSubmission): Promise<ReceiptSubmissionOutcome>;
  settle(pending: PendingReceiptSubmission, outcome: Exclude<ReceiptSubmissionOutcome, 'unresolved'>): Promise<void>;
};

type DeliveryRequestMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type DeliveryReceiptRequestResult = {
  response: Response;
  metrics: DeliveryRequestMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  deliveryId?: number;
  verification?: 'signature' | 'delivery_pda';
  attempted?: number;
  recovered?: number;
};

type DeliveryReceiptDependencies = {
  issue: (
    body: IssueRequest,
    identity: RequestIdentity,
    env: DeliveryReceiptsEnv,
    commerce: CommerceContext,
    provider: ProviderContext,
    waitUntil: DeferredWork,
  ) => Promise<ReceiptIssueResult>;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  recover: (
    body: RecoverRequest,
    identity: RequestIdentity,
    env: DeliveryReceiptsEnv,
    commerce: CommerceContext,
    provider: ProviderContext,
    waitUntil: DeferredWork,
  ) => Promise<RecoverDeliveryOrdersResult>;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

function errorResponse(error: DeliveryReceiptError): Response {
  return jsonResponse({
    error: {
      code: error.code,
      message: error.message,
    },
  }, httpStatusForApiErrorCode(error.code, 503), {
    headers: { 'Timing-Allow-Origin': '*' },
  });
}

async function readRequestBody(
  request: Request,
  signal: AbortSignal,
  kind: 'issue' | 'recover',
): Promise<IssueRequest | RecoverRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new DeliveryReceiptError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Delivery receipt request is too large.'
          : 'Invalid delivery receipt request.',
    ),
  });
  const parsed = kind === 'issue' ? issueSchema.safeParse(value) : recoverSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery receipt request.');
  }
  return parsed.data;
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('non-canonical');
    return key;
  } catch {
    throw new DeliveryReceiptError('invalid-argument', `Invalid ${label}.`);
  }
}

function configuredPublicKey(value: string | undefined, label: string, required = true): PublicKey {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return PublicKey.default;
    throw new DeliveryReceiptError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new DeliveryReceiptError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof DeliveryReceiptError) throw error;
    throw new DeliveryReceiptError('failed-precondition', `${label} is invalid.`);
  }
}

function runtimeForDrop(rawDropId: string): DeliveryRuntime {
  const dropId = normalizeDropId(rawDropId);
  const config = getApiDrop(dropId);
  if (!config) throw new DeliveryReceiptError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const itemsPerBox = Number(config.itemsPerBox);
  const maxSupply = Number(config.maxSupply);
  const maxDudeId = itemsPerBox * maxSupply;
  if (
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox) ||
    !Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery drop configuration is invalid.', { dropId });
  }
  const boxMinterProgramId = configuredPublicKey(config.boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');
  const boxMinterConfigPda = configuredPublicKey(config.boxMinterConfigPda, 'BOX_MINTER_CONFIG_PDA', false);
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda: boxMinterConfigPda.equals(PublicKey.default)
      ? PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0]
      : boxMinterConfigPda,
    collectionMint: configuredPublicKey(config.collectionMint, 'COLLECTION_MINT'),
    receiptsMerkleTree: configuredPublicKey(config.receiptsMerkleTree, 'RECEIPTS_MERKLE_TREE'),
    itemsPerBox,
    maxSupply,
    maxDudeId,
  };
}

function commerceString(value: string): string {
  return value;
}

function commerceInteger(value: number): number {
  return Math.floor(value);
}

function commerceValue<T>(value: T): T {
  return value;
}

async function loadBoundWallet(
  context: CommerceContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new DeliveryReceiptError('unavailable', 'Receipt data is temporarily unavailable.');
    const resolution = await resolveD1AuthWalletBinding(db, uid, context.signal);
    if ('reason' in resolution) {
      throw new DeliveryReceiptError('unauthenticated', 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) throw error;
    throw new DeliveryReceiptError('unavailable', 'Receipt data is temporarily unavailable.');
  }
}

async function runPendingReadyNotificationQuery(
  context: CommerceContext,
  ownerWallet: string,
): Promise<DeliveryOrderDocument[]> {
  const documents: DeliveryOrderDocument[] = [];
  let startAfterPath: string | undefined;
  while (documents.length < MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) {
    const value = await repository(context).queryPendingReadyNotifications({
      owner: ownerWallet,
      limit: PENDING_READY_NOTIFICATION_QUERY_PAGE_SIZE,
      ...(startAfterPath ? { startAfterPath } : {}),
    });
    const remaining = MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL - documents.length;
    documents.push(...decodeDeliveryOrderQuery(value, true).slice(0, remaining));
    if (value.length < PENDING_READY_NOTIFICATION_QUERY_PAGE_SIZE) break;
    startAfterPath = value[value.length - 1]?.key.path;
    if (!startAfterPath) break;
  }
  return documents;
}

function decodeDeliveryOrderQuery(
  value: readonly CommerceDocumentRecord[],
  requireIdentity: boolean,
): DeliveryOrderDocument[] {
  const documents: DeliveryOrderDocument[] = [];
  for (const result of value) {
    const document = commerceDocument(result);
    if (!document) continue;
    if (requireIdentity && !('identity' in resolveDeliveryOrderIdentity(document.id, document.fields, document.path))) {
      continue;
    }
    documents.push(document);
  }
  return documents;
}

async function runDeliveryRecoveryOrderQuery(
  context: CommerceContext,
  ownerWallet: string,
  requireIdentity = false,
): Promise<DeliveryOrderDocument[]> {
  const value = await repository(context).queryDeliveryRecoveryOrders(ownerWallet);
  return decodeDeliveryOrderQuery(value, requireIdentity);
}

function toMillisMaybe(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function preparedDeliveryRecoveryCheckCount(order: Record<string, unknown>): number {
  const recovery = isRecord(order.receiptRecovery) ? order.receiptRecovery : {};
  const raw = Number(recovery.preparedProbeCount || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function processingDeliveryRecoveryReferenceMs(order: Record<string, unknown>): number {
  const recovery = isRecord(order.receiptRecovery) ? order.receiptRecovery : {};
  return Math.max(
    toMillisMaybe(order.createdAt) ?? 0,
    toMillisMaybe(order.processingAt) ?? 0,
    toMillisMaybe(recovery.lastAttemptAt) ?? 0,
  );
}

function deliveryRecoveryPriorityMs(order: Record<string, unknown>): number {
  if (order.status === 'processing') return processingDeliveryRecoveryReferenceMs(order);
  if (order.status === 'prepared') return preparedDeliveryRecoveryNextCheckMs(order) ?? (toMillisMaybe(order.createdAt) ?? 0);
  return toMillisMaybe(order.createdAt) ?? 0;
}

function compareDeliveryRecoveryCandidates(
  left: DeliveryOrderDocument,
  right: DeliveryOrderDocument,
): number {
  const leftStatus = typeof left.fields.status === 'string' ? left.fields.status : '';
  const rightStatus = typeof right.fields.status === 'string' ? right.fields.status : '';
  if (leftStatus !== rightStatus) {
    if (leftStatus === 'processing') return -1;
    if (rightStatus === 'processing') return 1;
  }
  const priority = deliveryRecoveryPriorityMs(left.fields) - deliveryRecoveryPriorityMs(right.fields);
  return priority || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function deliveryRecoveryEligibility(
  order: Record<string, unknown>,
  nowMs: number,
  force: boolean,
): { eligible: boolean; outcome?: DeliveryRecoveryOutcome; message?: string } {
  const status = typeof order.status === 'string' ? order.status : 'unknown';
  if (status === 'processing') {
    if (force) return { eligible: true };
    const recovery = isRecord(order.receiptRecovery) ? order.receiptRecovery : {};
    const lastAttemptAt = toMillisMaybe(recovery.lastAttemptAt) ?? 0;
    if (lastAttemptAt > 0 && nowMs - lastAttemptAt < DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS) {
      return { eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active' };
    }
    return { eligible: true };
  }
  if (status === 'prepared') {
    if (force) return { eligible: true };
    const nextCheckAt = preparedDeliveryRecoveryNextCheckMs(order);
    if (nextCheckAt === null) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
    }
    if (nextCheckAt > nowMs) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order is not due for recovery yet' };
    }
    return { eligible: true };
  }
  if (status === 'prepared_abandoned') {
    return force
      ? { eligible: true }
      : { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
  }
  return {
    eligible: false,
    outcome: 'skipped_status',
    message: `order status \`${status}\` is not recoverable`,
  };
}

function orderResultBase(document: DeliveryOrderDocument): {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
} | null {
  const identity = resolveDeliveryOrderIdentity(document.id, document.fields, document.path);
  if (!('identity' in identity)) return null;
  if (resolveDeliveryOrderDropId(document.fields, document.path) !== identity.identity.dropId) return null;
  return {
    dropId: identity.identity.dropId,
    deliveryId: identity.identity.deliveryId,
    statusBefore: typeof document.fields.status === 'string' ? document.fields.status : 'unknown',
  };
}

type DeliveryRecoveryLeaseResult = {
  acquired: true;
  lease: {
    attemptCount: number;
    lastAttemptAtMs: number;
    leaseExpiresAtMs: number;
    previousAttemptCount: CommerceJsonValue | undefined;
    previousLastAttemptAt: CommerceJsonValue | undefined;
  };
} | { acquired: false; result: RecoverDeliveryOrdersItemResult };

async function acquireDeliveryRecoveryLease(
  context: CommerceContext,
  path: string,
  ownerWallet: string,
  nowMs: number,
  force: boolean,
): Promise<DeliveryRecoveryLeaseResult> {
  try {
    return await runCommerceWriteTransaction<DeliveryRecoveryLeaseResult>(context, async (transaction) => {
      const document = await readDocument(context, path, transaction);
      const fallback = path.split('/');
      const fallbackDropId = fallback.length === 4 ? fallback[1] : '';
      const fallbackDeliveryId = Number(fallback.at(-1)) || 0;
      if (!document) {
        return {
          result: {
            acquired: false as const,
            result: {
              dropId: fallbackDropId,
              deliveryId: fallbackDeliveryId,
              statusBefore: 'missing',
              outcome: 'not_found' as const,
              verification: 'delivery_pda' as const,
              message: 'delivery order not found',
            },
          },
        };
      }
      const base = orderResultBase(document);
      if (!base) {
        return {
          result: {
            acquired: false as const,
            result: {
              dropId: '',
              deliveryId: Number(document.id) || 0,
              statusBefore: typeof document.fields.status === 'string' ? document.fields.status : 'unknown',
              outcome: 'failed' as const,
              verification: 'delivery_pda' as const,
              message: 'delivery order is missing recovery identifiers',
            },
          },
        };
      }
      if (document.fields.owner && document.fields.owner !== ownerWallet) {
        return {
          result: {
            acquired: false as const,
            result: {
              ...base,
              outcome: 'failed' as const,
              verification: 'delivery_pda' as const,
              message: 'order belongs to a different wallet',
              errorCode: 'permission-denied',
            },
          },
        };
      }
      const eligibility = deliveryRecoveryEligibility(document.fields, nowMs, force);
      if (!eligibility.eligible) {
        return {
          result: {
            acquired: false as const,
            result: {
              ...base,
              outcome: eligibility.outcome || 'not_eligible',
              verification: 'delivery_pda' as const,
              ...(eligibility.message ? { message: eligibility.message } : {}),
            },
          },
        };
      }
      const recovery = isRecord(document.fields.receiptRecovery) ? document.fields.receiptRecovery : {};
      const leaseExpiresAt = toMillisMaybe(recovery.leaseExpiresAt) ?? 0;
      if (leaseExpiresAt > nowMs) {
        return {
          result: {
            acquired: false as const,
            result: {
              ...base,
              outcome: 'lease_active' as const,
              verification: 'delivery_pda' as const,
              message: 'another client is already retrying this order',
            },
          },
        };
      }
      const rawAttemptCount = Number(recovery.attemptCount || 0);
      const attemptCount = Number.isFinite(rawAttemptCount) && rawAttemptCount > 0
        ? Math.floor(rawAttemptCount) + 1
        : 1;
      const leaseExpiresAtMs = nowMs + DELIVERY_RECOVERY_LEASE_MS;
      return {
        result: {
          acquired: true as const,
          lease: {
            attemptCount,
            lastAttemptAtMs: nowMs,
            leaseExpiresAtMs,
            previousAttemptCount: recovery.attemptCount,
            previousLastAttemptAt: recovery.lastAttemptAt,
          },
        },
        writes: [updateWrite({
          path,
          values: {
            'receiptRecovery.leaseExpiresAt': commerceTimestamp(leaseExpiresAtMs),
            'receiptRecovery.lastAttemptAt': commerceTimestamp(nowMs),
            'receiptRecovery.attemptCount': attemptCount,
          },
          mustExist: true,
        })],
      };
    });
  } catch (error) {
    if (isDeliveryRecoveryCancellation(error, context.signal)) throw context.signal.reason;
    throw mapProviderError(error, 'Delivery recovery data is temporarily unavailable.');
  }
}

async function cancelDeliveryRecoveryAttempt(
  context: CommerceContext,
  path: string,
  lease: {
    attemptCount: number;
    lastAttemptAtMs: number;
    leaseExpiresAtMs: number;
    previousAttemptCount: CommerceJsonValue | undefined;
    previousLastAttemptAt: CommerceJsonValue | undefined;
  },
): Promise<void> {
  return retryCommerceConflicts(async () => {
    const document = await readDocument(context, path);
    if (!document) return;
    const recovery = isRecord(document.fields.receiptRecovery) ? document.fields.receiptRecovery : {};
    const leaseExpiresAt = toMillisMaybe(recovery.leaseExpiresAt);
    if (
      leaseExpiresAt === null || leaseExpiresAt < lease.leaseExpiresAtMs ||
      toMillisMaybe(recovery.lastAttemptAt) !== lease.lastAttemptAtMs ||
      Number(recovery.attemptCount) !== lease.attemptCount
    ) return;
    await commitWrites(context, [updateWrite({
      path,
      values: {
        'receiptRecovery.leaseExpiresAt': commerceFieldValue.delete(),
        'receiptRecovery.lastAttemptAt': lease.previousLastAttemptAt === undefined
          ? commerceFieldValue.delete()
          : lease.previousLastAttemptAt,
        'receiptRecovery.attemptCount': lease.previousAttemptCount === undefined
          ? commerceFieldValue.delete()
          : lease.previousAttemptCount,
      },
      expectedUpdateTime: document.updateTime,
    })]);
  }, { signal: context.signal });
}

async function finalizeDeliveryRecoveryAttempt(
  context: CommerceContext,
  path: string,
  result: { errorCode?: string; message?: string },
): Promise<void> {
  await commitWrites(context, [updateWrite({
    path,
    values: {
      'receiptRecovery.leaseExpiresAt': commerceFieldValue.delete(),
      'receiptRecovery.lastErrorCode': result.errorCode || commerceFieldValue.delete(),
      'receiptRecovery.lastErrorMessage': result.message || commerceFieldValue.delete(),
    },
    mustExist: true,
  })]);
}

async function recordPreparedDeliveryRecoveryMiss(
  context: CommerceContext,
  document: DeliveryOrderDocument,
  nowMs: number,
): Promise<number | null> {
  const probeCount = preparedDeliveryRecoveryCheckCount(document.fields);
  const nextProbeCount = probeCount + 1;
  const nextDelayMs = nextPreparedDeliveryRecoveryDelayMs(nextProbeCount);
  const values: CommerceDocumentWriteData = {
    'receiptRecovery.preparedProbeCount': nextProbeCount,
    'receiptRecovery.lastPreparedProbeAt': commerceTimestamp(nowMs),
    ...(nextDelayMs === null
      ? {
          status: 'prepared_abandoned',
          preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
          'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
        }
      : {
          'receiptRecovery.nextPreparedProbeAt': commerceTimestamp(nowMs + nextDelayMs),
        }),
  };
  await commitWrites(context, [updateWrite({
    path: document.path,
    values,
    expectedUpdateTime: document.updateTime,
  })]);
  return nextDelayMs === null ? null : nowMs + nextDelayMs;
}

async function stopPreparedDeliveryRecoveryChecks(
  context: CommerceContext,
  document: DeliveryOrderDocument,
  nowMs: number,
): Promise<void> {
  const probeCount = Math.max(
    preparedDeliveryRecoveryCheckCount(document.fields),
    MAX_PREPARED_DELIVERY_RECOVERY_CHECKS,
  );
  await commitWrites(context, [updateWrite({
    path: document.path,
    values: {
      status: 'prepared_abandoned',
      preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
      'receiptRecovery.preparedProbeCount': probeCount,
      'receiptRecovery.lastPreparedProbeAt': commerceTimestamp(nowMs),
      'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
    },
    expectedUpdateTime: document.updateTime,
  })]);
}

async function deferPreparedDeliveryRecovery(
  context: CommerceContext,
  document: DeliveryOrderDocument,
  nowMs: number,
): Promise<void> {
  const recovery = isRecord(document.fields.receiptRecovery) ? document.fields.receiptRecovery : {};
  const nextCheckAt = Math.max(
    nowMs + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
    toMillisMaybe(recovery.leaseExpiresAt) ?? 0,
  );
  await commitWrites(context, [updateWrite({
    path: document.path,
    values: {
      'receiptRecovery.nextPreparedProbeAt': commerceTimestamp(nextCheckAt),
    },
    expectedUpdateTime: document.updateTime,
  })]);
}

async function fetchDeliveryRecoveryState(
  context: CommerceContext,
  ownerWallet: string,
  nowMs: number,
): Promise<WalletDeliveryRecoveryState> {
  const documents = await runDeliveryRecoveryOrderQuery(context, ownerWallet);
  const processing = documents.filter((document) => document.fields.status === 'processing');
  const prepared = documents.filter((document) => document.fields.status === 'prepared');
  return buildWalletDeliveryRecoveryState({
    remainingProcessing: processing.length,
    nextCheckCandidates: [
      ...processing.map((document) => processingDeliveryRecoveryNextCheckMs(document.fields, nowMs)),
      ...prepared.map((document) => preparedDeliveryRecoveryNextCheckMs(document.fields)),
    ],
  });
}

const pause = sleepWithSignal;

function secureRandomInt(maxExclusive: number): number {
  const maximum = Math.floor(maxExclusive);
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new DeliveryReceiptError('internal', 'Secure random range is invalid.');
  }
  const range = 1n << 64n;
  const maximumBigInt = BigInt(maximum);
  const limit = (range / maximumBigInt) * maximumBigInt;
  const words = new Uint32Array(2);
  let value: bigint;
  do {
    crypto.getRandomValues(words);
    value = (BigInt(words[0]) << 32n) | BigInt(words[1]);
  } while (value >= limit);
  return Number(value % maximumBigInt);
}

function normalizeAssignedDudeIds(
  value: unknown,
  runtime: DeliveryRuntime,
  boxAssetId: string,
): number[] {
  try {
    return normalizeCommerceDudeIds(value, runtime.itemsPerBox, runtime.maxDudeId, boxAssetId);
  } catch (error) {
    if (!(error instanceof CommerceDudeAssignmentError)) throw error;
    throw new DeliveryReceiptError('failed-precondition', 'Stored figure assignment is invalid.', { boxAssetId });
  }
}

async function assignDudesForBox(
  context: CommerceContext,
  runtime: DeliveryRuntime,
  boxAssetId: string,
  randomInt: (maxExclusive: number) => number,
): Promise<number[]> {
  try {
    const result = await assignCommerceDudes({
      boxAssetId,
      dropFamily: runtime.config.dropFamily,
      dropId: runtime.dropId,
      itemsPerBox: runtime.itemsPerBox,
      maxDudeId: runtime.maxDudeId,
      nowMs: context.nowMs,
      randomInt,
      repository: repository(context),
      signal: context.signal,
      sleep: (milliseconds) => pause(milliseconds, context.signal),
    });
    return result.dudeIds;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof CommerceDudeAssignmentError) {
      throw new DeliveryReceiptError(
        error.code === 'invalid-stored-assignment' ? 'failed-precondition' : 'resource-exhausted',
        error.message,
        error.details,
      );
    }
    throw mapProviderError(error, 'Figure assignment is temporarily unavailable.');
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeDropIdMaybe(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = normalizeDropId(value);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null;
}

type ClaimCodeExpected = {
  code: string;
  dropId: string;
  boxAssetId: string;
  boxId: number;
  deliveryId: number;
  dudeIds: readonly number[];
};

function claimCodeCompatible(claim: Record<string, unknown>, expected: ClaimCodeExpected): boolean {
  const rawDudeIds = Array.isArray(claim.dudeIds) ? claim.dudeIds.map(Number) : [];
  const claimBoxId = Number(claim.boxId);
  const claimDeliveryId = Number(claim.deliveryId);
  return (
    (claim.namespace === undefined || claim.namespace === IRL_CLAIM_CODE_NAMESPACE) &&
    (claim.code === undefined || normalizeIrlClaimCode(claim.code) === expected.code) &&
    normalizeDropIdMaybe(claim.dropId) === expected.dropId &&
    claim.boxAssetId === expected.boxAssetId &&
    Number.isFinite(claimBoxId) && Math.floor(claimBoxId) === expected.boxId &&
    (claim.deliveryId === undefined || (Number.isFinite(claimDeliveryId) && Math.floor(claimDeliveryId) === expected.deliveryId)) &&
    sameNumbers(rawDudeIds, expected.dudeIds)
  );
}

function assignmentClaimCompatible(
  claim: Record<string, unknown>,
  expected: ClaimCodeExpected,
  ownerWallet: string,
): boolean {
  const rawDudeIds = Array.isArray(claim.dudeIds) ? claim.dudeIds.map(Number) : [];
  return claim.namespace === IRL_CLAIM_CODE_NAMESPACE &&
    normalizeIrlClaimCode(claim.code) === expected.code &&
    normalizeDropIdMaybe(claim.dropId) === expected.dropId &&
    Number(claim.boxId) === expected.boxId &&
    Number(claim.deliveryId) === expected.deliveryId &&
    claim.owner === ownerWallet &&
    sameNumbers(rawDudeIds, expected.dudeIds);
}

function claimCodeConflictReason(claim: Record<string, unknown>, expected: ClaimCodeExpected): string | null {
  const claimBoxId = Number(claim.boxId);
  if (
    (claim.namespace !== undefined && claim.namespace !== IRL_CLAIM_CODE_NAMESPACE) ||
    (claim.code !== undefined && normalizeIrlClaimCode(claim.code) !== expected.code) ||
    normalizeDropIdMaybe(claim.dropId) !== expected.dropId ||
    claim.boxAssetId !== expected.boxAssetId ||
    !Number.isFinite(claimBoxId) || Math.floor(claimBoxId) !== expected.boxId
  ) return 'box identity';
  if (claim.deliveryId !== undefined && Math.floor(Number(claim.deliveryId)) !== expected.deliveryId) return 'deliveryId';
  const rawDudeIds = claim.dudeIds ?? claim.dude_ids ?? claim.dudes;
  if (rawDudeIds !== undefined) {
    if (!Array.isArray(rawDudeIds)) return 'dudeIds';
    if (rawDudeIds.length && !sameNumbers(rawDudeIds.map(Number), expected.dudeIds)) return 'dudeIds';
  }
  return null;
}

function claimCodeFields(expected: ClaimCodeExpected, ownerWallet: string): CommerceDocumentData {
  return {
    version: 2,
    namespace: IRL_CLAIM_CODE_NAMESPACE,
    code: expected.code,
    dropId: expected.dropId,
    boxId: expected.boxId,
    boxAssetId: expected.boxAssetId,
    owner: ownerWallet,
    deliveryId: expected.deliveryId,
    dudeIds: [...expected.dudeIds],
  };
}

function assignmentClaimFields(expected: ClaimCodeExpected, ownerWallet: string): CommerceDocumentData {
  return {
    irlClaimCode: expected.code,
    irlClaim: {
      namespace: IRL_CLAIM_CODE_NAMESPACE,
      code: expected.code,
      dropId: expected.dropId,
      boxId: expected.boxId,
      deliveryId: expected.deliveryId,
      owner: ownerWallet,
      dudeIds: [...expected.dudeIds],
    },
  };
}

async function ensureIrlClaimCodeForBox(
  context: CommerceContext,
  runtime: DeliveryRuntime,
  args: {
    ownerWallet: string;
    deliveryId: number;
    boxAssetId: string;
    boxId: number;
    dudeIds: number[];
  },
  randomInt: (maxExclusive: number) => number,
): Promise<string> {
  const assignmentPath = dropBoxAssignmentPath(runtime.dropId, args.boxAssetId);
  try {
    return await runCommerceWriteTransaction(context, async (transaction) => {
      const assignment = await readDocument(context, assignmentPath, transaction);
      if (!assignment) {
        throw new DeliveryReceiptError('failed-precondition', 'Figure assignment is missing.', {
          boxAssetId: args.boxAssetId,
        });
      }
      const normalizedExisting = typeof assignment.fields.irlClaimCode === 'string'
        ? normalizeIrlClaimCode(assignment.fields.irlClaimCode)
        : '';
      const existingCode = normalizedExisting.length === IRL_CLAIM_CODE_DIGITS ? normalizedExisting : '';
      if (existingCode) {
        const expected: ClaimCodeExpected = { code: existingCode, dropId: runtime.dropId, ...args };
        const claimPath = `claimCodes/${existingCode}`;
        const claim = await readDocument(context, claimPath, transaction);
        const writes: CommerceWrite[] = [];
        if (!claim) {
          writes.push(createWrite({
            path: claimPath,
            values: {
              ...claimCodeFields(expected, args.ownerWallet),
              createdAt: commerceFieldValue.serverTimestamp(),
            },
          }));
        } else if (!claimCodeCompatible(claim.fields, expected)) {
          const reason = claimCodeConflictReason(claim.fields, expected);
          if (reason) {
            throw new DeliveryReceiptError(
              'failed-precondition',
              'Existing IRL claim code conflicts with this box assignment; manual review required',
              { boxAssetId: args.boxAssetId, boxId: args.boxId, existingCode, conflictReason: reason },
            );
          }
          writes.push(updateWrite({
            path: claimPath,
            values: {
              ...claimCodeFields(expected, args.ownerWallet),
              updatedAt: commerceFieldValue.serverTimestamp(),
            },
            mustExist: true,
          }));
        }
        const assignmentClaim = isRecord(assignment.fields.irlClaim) ? assignment.fields.irlClaim : {};
        if (writes.length || !assignmentClaimCompatible(assignmentClaim, expected, args.ownerWallet)) {
          const assignmentFields = assignmentClaimFields(expected, args.ownerWallet);
          writes.push(updateWrite({
            path: assignmentPath,
            values: {
              ...assignmentFields,
              'irlClaim.createdAt': commerceFieldValue.serverTimestamp(),
            },
            mustExist: true,
          }));
        }
        return { result: existingCode, writes };
      }
      let expected: ClaimCodeExpected | undefined;
      for (let claimAttempt = 0; claimAttempt < 40; claimAttempt += 1) {
        const code = String(randomInt(10 ** IRL_CLAIM_CODE_DIGITS)).padStart(IRL_CLAIM_CODE_DIGITS, '0');
        if (await readDocument(context, `claimCodes/${code}`, transaction)) continue;
        expected = { code, dropId: runtime.dropId, ...args };
        break;
      }
      if (!expected) {
        throw new DeliveryReceiptError('unavailable', 'Failed to allocate unique IRL claim code (try again)');
      }
      const assignmentFields = assignmentClaimFields(expected, args.ownerWallet);
      return {
        result: expected.code,
        writes: [
          createWrite({
            path: `claimCodes/${expected.code}`,
            values: {
              ...claimCodeFields(expected, args.ownerWallet),
              createdAt: commerceFieldValue.serverTimestamp(),
            },
          }),
          updateWrite({
            path: assignmentPath,
            values: {
              ...assignmentFields,
              'irlClaim.createdAt': commerceFieldValue.serverTimestamp(),
            },
            mustExist: true,
          }),
        ],
      };
    });
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof DeliveryReceiptError) throw error;
    throw mapProviderError(error, 'IRL claim code is temporarily unavailable.');
  }
}

function shouldProjectNormalIrlPackStatus(
  runtime: DeliveryRuntime,
  order: Record<string, unknown>,
): boolean {
  if (!shouldTrackPackStatusForDrop({
    dropId: runtime.dropId,
    cluster: runtime.cluster,
    itemsPerBox: runtime.itemsPerBox,
    maxSupply: runtime.maxSupply,
  })) return false;
  if (isStripeOffchainDeliveryOrderSource(order.source)) return false;
  if (
    isAdminIrlRedeemDeliveryOrderSource(order.source) &&
    isRecord(order.adminIrlRedeem) &&
    order.adminIrlRedeem.targetKind === 'card_receipt'
  ) return false;
  return true;
}

export function createDeliveryPackStatusProjectionOutbox(
  runtime: DeliveryRuntime,
  order: Record<string, unknown>,
  nowMs = Date.now(),
): CommerceDocumentWriteData {
  if (!shouldProjectNormalIrlPackStatus(runtime, order)) return {};
  if (countDeliveryOrderBoxItems(order.items) < 1 && countDeliveryOrderDudeItems(order.items) < 1) {
    return {};
  }
  const nextAttemptAtMs = Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : Date.now();
  return {
    [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_PENDING,
    [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: nextAttemptAtMs,
    [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: 0,
    [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
    [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
    [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: commerceFieldValue.delete(),
  };
}

async function countNormalIrlPackStatus(
  context: CommerceContext,
  runtime: DeliveryRuntime,
  deliveryId: number,
  order: Record<string, unknown>,
): Promise<void> {
  if (!shouldProjectNormalIrlPackStatus(runtime, order)) return;
  const packQuantity = countDeliveryOrderBoxItems(order.items);
  const cardQuantity = countDeliveryOrderDudeItems(order.items);
  if (packQuantity < 1 && cardQuantity < 1) return;
  const event: PackStatusEvent = {
    dropId: runtime.dropId,
    type: 'redeemedIrlNormal',
    eventKey: String(deliveryId),
    quantity: packQuantity * packStatusCardsPerPack(runtime) + cardQuantity,
    increments: {
      ...(packQuantity ? { redeemedIrlNormal: packQuantity } : {}),
      ...(cardQuantity ? { redeemedUnsealedCards: cardQuantity } : {}),
    },
    deliveryId,
    createdAtMs: context.nowMs,
  };
  await applyPackStatusProjection({
    dataDb: context.dataDb,
    event,
    log: (entry) => console.warn(entry),
  });
}

function deliveryPackStatusProjectionFailureCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function deliveryPackStatusProjectionNextAttemptAtMs(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function deliveryPackStatusProjectionErrorCode(error: unknown): string {
  if (error instanceof DeliveryPackStatusProjectionInvalidError) return error.code;
  if (error instanceof DeliveryReceiptError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'deadline-exceeded';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error && error.message === 'pack_status_data_db_not_configured') {
    return 'data-db-unavailable';
  }
  if (error instanceof Error && error.message === 'pack_status_d1_write_failed') return 'd1-write-failed';
  return 'internal';
}

async function transitionDeliveryPackStatusProjection(
  context: CommerceContext,
  documentPath: string,
  options: {
    values: CommerceDocumentWriteData;
    requiredState: string;
  },
): Promise<boolean> {
  return retryCommerceConflicts(async () => {
    const document = await readDocument(context, documentPath);
    if (!document || document.fields[PACK_STATUS_PROJECTION_STATE_FIELD] !== options.requiredState) return false;
    await commitWrites(context, [updateWrite({
      path: documentPath,
      values: options.values,
      expectedUpdateTime: document.updateTime,
    })]);
    return true;
  }, { signal: context.signal });
}

async function markDeliveryPackStatusProjectionCompleted(
  context: CommerceContext,
  documentPath: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    values: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_COMPLETED,
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function markDeliveryPackStatusProjectionFailed(
  context: CommerceContext,
  documentPath: string,
  errorCode: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    values: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_FAILED,
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: errorCode,
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function clearDeliveryPackStatusProjection(
  context: CommerceContext,
  documentPath: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    values: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: commerceFieldValue.delete(),
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function recordDeliveryPackStatusProjectionTransientFailure(args: {
  attemptStartedAtMs: number;
  context: CommerceContext;
  documentPath: string;
  errorCode: string;
}): Promise<boolean> {
  return retryCommerceConflicts(async () => {
    const document = await readDocument(args.context, args.documentPath);
    if (!document || document.fields[PACK_STATUS_PROJECTION_STATE_FIELD] !== PACK_STATUS_PROJECTION_PENDING) {
      return false;
    }
    if (
      deliveryPackStatusProjectionNextAttemptAtMs(
        document.fields[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD],
      ) > args.attemptStartedAtMs
    ) return false;
    const failureCount = deliveryPackStatusProjectionFailureCount(
      document.fields[PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD],
    );
    const backoffMs = PACK_STATUS_PROJECTION_BACKOFF_MS[
      Math.min(failureCount, PACK_STATUS_PROJECTION_BACKOFF_MS.length - 1)
    ];
    await commitWrites(args.context, [updateWrite({
      path: args.documentPath,
      values: {
        [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_PENDING,
        [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: args.attemptStartedAtMs + backoffMs,
        [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1),
        [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: args.errorCode,
        [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
        [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
      },
      expectedUpdateTime: document.updateTime,
    })]);
    return true;
  }, { signal: args.context.signal });
}

type DeliveryPackStatusProjectionOutcome = 'completed' | 'failed' | 'not-due' | 'not-needed' | 'pending';

export async function projectPendingDeliveryPackStatus(args: {
  context: CommerceContext;
  deliveryId: number;
  dropId: string;
  log?: (entry: Record<string, unknown>) => void;
  nowMs?: () => number;
}): Promise<DeliveryPackStatusProjectionOutcome> {
  const log = args.log || ((entry: Record<string, unknown>) => console.log(entry));
  const attemptStartedAtMs = (args.nowMs || Date.now)();
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(args.context.signal.reason);
  };
  args.context.signal.addEventListener('abort', onAbort, { once: true });
  if (args.context.signal.aborted) onAbort();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Pack-status projection timed out', 'TimeoutError')),
    PACK_STATUS_TIMEOUT_MS,
  );
  const context: CommerceContext = {
    ...args.context,
    nowMs: attemptStartedAtMs,
    signal: controller.signal,
  };
  const documentPath = dropDeliveryOrderPath(args.dropId, args.deliveryId);
  try {
    const order = await raceWithSignal(readDocument(context, documentPath), context.signal);
    if (!order) return 'not-needed';
    const state = order.fields[PACK_STATUS_PROJECTION_STATE_FIELD];
    if (state !== PACK_STATUS_PROJECTION_PENDING) return 'not-needed';
    if (
      deliveryPackStatusProjectionNextAttemptAtMs(
        order.fields[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD],
      ) > attemptStartedAtMs
    ) return 'not-due';
    if (order.fields.status !== 'ready_to_ship') {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-status',
        'Pack-status projection order is not ready to ship.',
      );
    }
    const resolution = resolveDeliveryOrderIdentity(order.id, order.fields, order.path);
    if (
      !('identity' in resolution) ||
      resolution.identity.dropId !== args.dropId ||
      resolution.identity.deliveryId !== args.deliveryId
    ) {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-identity',
        'Pack-status projection order identity is invalid.',
      );
    }
    let runtime: DeliveryRuntime;
    try {
      runtime = runtimeForDrop(args.dropId);
    } catch {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-drop',
        'Pack-status projection drop is invalid.',
      );
    }
    if (!shouldProjectNormalIrlPackStatus(runtime, order.fields)) {
      await raceWithSignal(clearDeliveryPackStatusProjection(context, order.path), context.signal);
      log({
        event: 'delivery_pack_status_projection_skipped',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
      });
      return 'not-needed';
    }
    if (
      countDeliveryOrderBoxItems(order.fields.items) < 1 &&
      countDeliveryOrderDudeItems(order.fields.items) < 1
    ) {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-items',
        'Pack-status projection order has no countable items.',
      );
    }
    if (!context.dataDb) throw new Error('pack_status_data_db_not_configured');
    await raceWithSignal(
      countNormalIrlPackStatus(context, runtime, args.deliveryId, order.fields),
      context.signal,
    );
    await raceWithSignal(markDeliveryPackStatusProjectionCompleted(context, order.path), context.signal);
    log({
      event: 'delivery_pack_status_projection_completed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
    });
    return 'completed';
  } catch (error) {
    const errorCode = deliveryPackStatusProjectionErrorCode(error);
    const persistenceContext = cleanupContext(args.context);
    if (error instanceof DeliveryPackStatusProjectionInvalidError) {
      await raceWithSignal(
        markDeliveryPackStatusProjectionFailed(persistenceContext, documentPath, errorCode),
        persistenceContext.signal,
      );
      log({
        event: 'delivery_pack_status_projection_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        errorCode,
        error: summarizeError(error),
      });
      return 'failed';
    }
    await raceWithSignal(
      recordDeliveryPackStatusProjectionTransientFailure({
        attemptStartedAtMs,
        context: persistenceContext,
        documentPath,
        errorCode,
      }),
      persistenceContext.signal,
    );
    log({
      event: 'delivery_pack_status_projection_retry_scheduled',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      errorCode,
      error: summarizeError(error),
    });
    return 'pending';
  } finally {
    clearTimeout(timeout);
    args.context.signal.removeEventListener('abort', onAbort);
  }
}

async function runDueDeliveryPackStatusProjectionQuery(
  context: CommerceContext,
  dropId: string,
  dueAtMs: number,
  limit: number,
): Promise<DeliveryOrderDocument[]> {
  const value = await repository(context).queryDuePackStatusProjections({
    dropId,
    dueAtMs,
    limit,
  });
  return decodeDeliveryOrderQuery(value, false);
}

export async function reconcilePendingDeliveryPackStatusProjections(
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  signal: AbortSignal,
  overrides: {
    dropIds?: readonly string[];
    log?: (entry: Record<string, unknown>) => void;
    nowMs?: () => number;
    providerFetch?: ProfileProviderFetch;
  } = {},
): Promise<number> {
  const nowMs = overrides.nowMs || Date.now;
  const dueAtMs = nowMs();
  const log = overrides.log || ((entry: Record<string, unknown>) => console.log(entry));
  const context: CommerceContext = {
    commerceDb: env.COMMERCE_DB,
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs: dueAtMs,
    providerFetch: overrides.providerFetch || ((input, init) => fetch(input, init)),
    signal,
    dataDb: env.DATA_DB,
  };
  const lanes = await Promise.all(
    (overrides.dropIds || Object.keys(API_DROPS).sort()).flatMap((dropId) => {
      const runtime = runtimeForDrop(dropId);
      if (!shouldTrackPackStatusForDrop(runtime)) return [];
      return [runDueDeliveryPackStatusProjectionQuery(
        context,
        runtime.dropId,
        dueAtMs,
        PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE,
      ).then((documents) => ({ documents, dropId: runtime.dropId }))];
    }),
  );
  const candidates: Array<{ deliveryId: number; dropId: string }> = [];
  const errors: unknown[] = [];
  let inspected = 0;
  while (
    inspected < PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE &&
    lanes.some((lane) => lane.documents.length)
  ) {
    for (const lane of lanes) {
      if (inspected >= PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE) break;
      const document = lane.documents.shift();
      if (!document) continue;
      inspected += 1;
      const resolution = resolveDeliveryOrderIdentity(document.id, document.fields, document.path);
      if (!('identity' in resolution) || resolution.identity.dropId !== lane.dropId) {
        try {
          await markDeliveryPackStatusProjectionFailed(
            cleanupContext(context),
            document.path,
            'invalid-order-identity',
          );
        } catch (error) {
          errors.push(error);
        }
        continue;
      }
      candidates.push({
        deliveryId: resolution.identity.deliveryId,
        dropId: lane.dropId,
      });
    }
  }
  let nextCandidate = 0;
  const worker = async () => {
    while (nextCandidate < candidates.length) {
      if (signal.aborted) {
        errors.push(signal.reason);
        return;
      }
      const candidate = candidates[nextCandidate];
      nextCandidate += 1;
      try {
        await projectPendingDeliveryPackStatus({
          ...candidate,
          context,
          log,
          nowMs,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PACK_STATUS_PROJECTION_RECONCILIATION_CONCURRENCY, candidates.length) },
      worker,
    ),
  );
  if (errors.length) throw new AggregateError(errors, 'Pack-status projection reconciliation failed');
  return candidates.length;
}

function scheduleDeliveryPackStatusProjection(args: {
  context: CommerceContext;
  deliveryId: number;
  dropId: string;
  waitUntil: DeferredWork;
}): void {
  const task = projectPendingDeliveryPackStatus({
    ...args,
    context: { ...args.context, signal: new AbortController().signal },
  }).catch((error) => {
    console.error({
      event: 'delivery_pack_status_projection_background_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
  });
  registerDeferredWork(args.waitUntil, task);
}

function decodeDeliverArgs(data: Buffer): { deliveryId: number; feeLamports: number; deliveryBump: number } {
  if (data.length < 21 || !data.subarray(0, 8).equals(IX_DELIVER)) {
    throw new DeliveryReceiptError('failed-precondition', 'Transaction has an invalid deliver instruction.');
  }
  const fee = data.readBigUInt64LE(12);
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery fee is too large.');
  }
  return {
    deliveryId: data.readUInt32LE(8),
    feeLamports: Number(fee),
    deliveryBump: data.readUInt8(20),
  };
}

function expectedDeliveryLamports(order: Record<string, unknown>): number {
  const value = Number(order.deliveryLamports ?? order.shippingLamports);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored delivery fee is invalid.');
  }
  return value;
}

function assertDeliverArgsMatchOrder(args: {
  decoded: ReturnType<typeof decodeDeliverArgs>;
  deliveryId: number;
  expectedDeliveryBump: number;
  order: Record<string, unknown>;
}): void {
  if (args.decoded.deliveryId !== args.deliveryId) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery id mismatch.', {
      reason: 'delivery_id_mismatch',
    });
  }
  if (args.decoded.deliveryBump !== args.expectedDeliveryBump) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery PDA bump mismatch.', {
      reason: 'delivery_bump_mismatch',
    });
  }
  if (args.decoded.feeLamports !== expectedDeliveryLamports(args.order)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery fee mismatch.', {
      reason: 'delivery_fee_mismatch',
    });
  }
}

function decodeDeliveryRecord(data: Buffer): {
  payer: PublicKey;
  deliveryFeeLamports: number;
  itemCount: number;
} {
  if (data.length < 50 || !data.subarray(0, 8).equals(ACCOUNT_DELIVERY_RECORD)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record account data is invalid.');
  }
  const fee = data.readBigUInt64LE(40);
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record fee is too large.');
  }
  return {
    payer: new PublicKey(data.subarray(8, 40)),
    deliveryFeeLamports: Number(fee),
    itemCount: data.readUInt16LE(48),
  };
}

function storedDeliveryItemIds(order: Record<string, unknown>): string[] {
  if (order.itemIds === undefined) return [];
  if (
    !Array.isArray(order.itemIds) ||
    !order.itemIds.every((value): value is string => typeof value === 'string' && isBase58Bytes(value, 32))
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery order contains invalid itemIds.');
  }
  if (new Set(order.itemIds).size !== order.itemIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery order contains duplicate itemIds.');
  }
  return [...order.itemIds];
}

async function fetchDeliveryRecord(
  connection: Connection,
  runtime: DeliveryRuntime,
  deliveryId: number,
  includeData = true,
): Promise<{
  expectedDeliveryPda: PublicKey;
  expectedDeliveryBump: number;
  deliveryInfo: AccountInfo<Buffer>;
} | null> {
  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPda(runtime, deliveryId);
  const deliveryInfo = await connection.getAccountInfo(
    expectedDeliveryPda,
    includeData
      ? { commitment: 'confirmed' }
      : { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
  );
  if (!deliveryInfo) return null;
  if (!deliveryInfo.owner.equals(runtime.boxMinterProgramId)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record PDA is owned by the wrong program.');
  }
  return { expectedDeliveryPda, expectedDeliveryBump, deliveryInfo };
}

function assertStoredDeliveryPda(order: Record<string, unknown>, expectedDeliveryPda: PublicKey): void {
  const stored = typeof order.deliveryPda === 'string' ? order.deliveryPda.trim() : '';
  if (stored && stored !== expectedDeliveryPda.toBase58()) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored delivery PDA does not match the expected delivery PDA.');
  }
}

function assertDeliveryPayers(
  ownerWallet: string,
  feePayer: PublicKey | undefined,
  deliveryPayer: PublicKey | undefined,
): void {
  if (!feePayer || feePayer.toBase58() !== ownerWallet) {
    throw new DeliveryReceiptError('failed-precondition', 'Transaction fee payer does not match owner.', {
      reason: 'payer_mismatch',
    });
  }
  if (!deliveryPayer || deliveryPayer.toBase58() !== ownerWallet) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery payer does not match owner.', {
      reason: 'payer_mismatch',
    });
  }
}

async function verifyReceiptIssuanceBySignature(args: {
  connection: Connection;
  deliveryId: number;
  order: Record<string, unknown>;
  ownerWallet: string;
  runtime: DeliveryRuntime;
  signature: string;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const transaction = await args.connection.getTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery transaction not found or failed.', {
      reason: 'transaction_not_found_or_failed',
    });
  }
  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPda(args.runtime, args.deliveryId);
  const keys = transactionAccountKeys(transaction);
  const fixedAccountCount = 9;
  let deliverAccounts: PublicKey[] | undefined;
  let deliverData: Buffer | undefined;
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program?.equals(args.runtime.boxMinterProgramId)) continue;
    const data = Buffer.from(instruction.data);
    if (!data.subarray(0, 8).equals(IX_DELIVER)) continue;
    const accounts = Array.from(instruction.accountKeyIndexes).map((index) => keys[index]);
    if (accounts.length >= fixedAccountCount && accounts[8]?.equals(expectedDeliveryPda)) {
      deliverAccounts = accounts;
      deliverData = data;
      break;
    }
  }
  if (!deliverAccounts || !deliverData) {
    throw new DeliveryReceiptError(
      'failed-precondition',
      'Delivery transaction is missing a deliver instruction for the expected delivery PDA.',
      { reason: 'missing_target_deliver_instruction' },
    );
  }
  assertDeliveryPayers(
    args.ownerWallet,
    transaction.transaction.message.staticAccountKeys[0],
    deliverAccounts[2],
  );
  const decoded = decodeDeliverArgs(deliverData);
  assertDeliverArgsMatchOrder({
    decoded,
    deliveryId: args.deliveryId,
    expectedDeliveryBump,
    order: args.order,
  });
  const itemIds = storedDeliveryItemIds(args.order);
  const deliveredAssets = deliverAccounts.slice(fixedAccountCount).map((key) => key.toBase58());
  if (itemIds.length && deliveredAssets.length && itemIds.length !== deliveredAssets.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery item count mismatch.', {
      reason: 'item_count_mismatch',
    });
  }
  if (itemIds.some((itemId, index) => deliveredAssets[index] && deliveredAssets[index] !== itemId)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivered asset list mismatch.', {
      reason: 'asset_list_mismatch',
    });
  }
  const targetAssetIds = itemIds.length ? itemIds : deliveredAssets;
  if (!targetAssetIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing delivered item ids.', {
      reason: 'missing_delivered_item_ids',
    });
  }
  return {
    verification: 'signature',
    signature: args.signature,
    expectedDeliveryPda,
    expectedDeliveryBump,
    targetAssetIds,
  };
}

async function verifyReceiptIssuanceByDeliveryRecord(args: {
  connection: Connection;
  deliveryId: number;
  order: Record<string, unknown>;
  ownerWallet: string;
  runtime: DeliveryRuntime;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const itemIds = storedDeliveryItemIds(args.order);
  if (!itemIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing itemIds for recovery.');
  }
  const account = await fetchDeliveryRecord(args.connection, args.runtime, args.deliveryId);
  if (!account) throw new DeliveryReceiptError('failed-precondition', 'Delivery record PDA not found.');
  assertStoredDeliveryPda(args.order, account.expectedDeliveryPda);
  const record = decodeDeliveryRecord(Buffer.from(account.deliveryInfo.data));
  if (record.payer.toBase58() !== args.ownerWallet) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record payer does not match owner.');
  }
  if (record.itemCount !== itemIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record item count mismatch.', {
      expected: itemIds.length,
      got: record.itemCount,
    });
  }
  const expectedLamports = expectedDeliveryLamports(args.order);
  if (record.deliveryFeeLamports !== expectedLamports) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record fee mismatch.', {
      expected: expectedLamports,
      got: record.deliveryFeeLamports,
    });
  }
  return {
    verification: 'delivery_pda',
    signature: typeof args.order.deliverySignature === 'string' ? args.order.deliverySignature : null,
    expectedDeliveryPda: account.expectedDeliveryPda,
    expectedDeliveryBump: account.expectedDeliveryBump,
    targetAssetIds: itemIds,
  };
}

function looksLikeComputeLimitError(message: string, logs: readonly string[]): boolean {
  const value = `${message}\n${logs.join('\n')}`.toLowerCase();
  return value.includes('computational budget exceeded') ||
    value.includes('exceeded maximum compute') ||
    value.includes('program failed to complete') ||
    (value.includes('compute units') && value.includes('consumed') && value.includes('failed'));
}

async function markDeliveryProcessing(
  context: CommerceContext,
  document: DeliveryOrderDocument,
  runtime: DeliveryRuntime,
  signature: string | null,
): Promise<void> {
  await commitWrites(context, [updateWrite({
    path: document.path,
    values: {
      dropId: runtime.dropId,
      status: 'processing',
      ...(signature ? { deliverySignature: signature } : {}),
      'receiptRecovery.lastPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.preparedProbeCount': commerceFieldValue.delete(),
      'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.status': commerceFieldValue.delete(),
      ...(document.fields.processingAt === undefined
        ? { processingAt: commerceFieldValue.serverTimestamp() }
        : {}),
    },
    mustExist: true,
  })]);
}

async function markDeliveryReady(
  context: CommerceContext,
  document: DeliveryOrderDocument,
  runtime: DeliveryRuntime,
  result: {
    signature: string | null;
    receiptsMinted: number;
    receiptTxs: string[];
    irlClaims: Array<{ code: string; boxId: number; boxAssetId: string; dudeIds: number[] }>;
  },
): Promise<DeliveryOrderDocument> {
  const fields: CommerceDocumentData = {
    dropId: runtime.dropId,
    status: 'ready_to_ship',
    ...(result.signature ? { deliverySignature: result.signature } : {}),
    receiptsMinted: result.receiptsMinted,
    receiptTxs: result.receiptTxs,
    ...(result.irlClaims.length ? { irlClaims: result.irlClaims } : {}),
  };
  const readyOrder = { ...document.fields, ...fields };
  const notificationOutbox = createReadyToShipNotificationOutbox({
    before: document.fields,
    after: readyOrder,
    deliveryId: Number(document.id),
    dropId: runtime.dropId,
    nowMs: context.nowMs,
  });
  Object.assign(readyOrder, Object.fromEntries(
    Object.entries(notificationOutbox.values).filter(([, value]) => !isCommerceDeleteField(value)),
  ));
  const packStatusOutbox = createDeliveryPackStatusProjectionOutbox(runtime, readyOrder, context.nowMs);
  Object.assign(readyOrder, Object.fromEntries(
    Object.entries(packStatusOutbox).filter(([, value]) => !isCommerceDeleteField(value)),
  ));
  await commitWrites(context, [updateWrite({
    path: document.path,
    values: {
      ...fields,
      ...notificationOutbox.values,
      ...packStatusOutbox,
      'receiptRecovery.leaseExpiresAt': commerceFieldValue.delete(),
      'receiptRecovery.lastErrorCode': commerceFieldValue.delete(),
      'receiptRecovery.lastErrorMessage': commerceFieldValue.delete(),
      'receiptRecovery.lastPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.preparedProbeCount': commerceFieldValue.delete(),
      'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
      'receiptRecovery.status': commerceFieldValue.delete(),
      processedAt: commerceFieldValue.serverTimestamp(),
      ...(result.irlClaims.length
        ? { irlClaimsUpdatedAt: commerceFieldValue.serverTimestamp() }
        : {}),
    },
    mustExist: true,
  })]);
  return { ...document, fields: readyOrder };
}

async function recordDeliveryClose(
  context: CommerceContext,
  documentPath: string,
  dropId: string,
  closeDeliveryTx: string,
): Promise<void> {
  await commitWrites(context, [updateWrite({
    path: documentPath,
    values: { dropId, closeDeliveryTx, deliveryClosedAt: commerceFieldValue.serverTimestamp() },
    mustExist: true,
  })]);
}

function pendingReceiptItems(
  order: Record<string, unknown>,
  targetAssetIds: readonly string[],
  infos: readonly (AccountInfo<Buffer> | null)[],
  runtime: DeliveryRuntime,
): Array<{ assetId: string; asset: PublicKey; kind: 'box' | 'dude'; refId: number }> {
  const storedItems = Array.isArray(order.items) ? order.items.filter(isRecord) : [];
  const byAssetId = new Map<string, Record<string, unknown>>();
  for (const item of storedItems) {
    if (typeof item.assetId === 'string') byAssetId.set(item.assetId, item);
  }
  const pending: Array<{ assetId: string; asset: PublicKey; kind: 'box' | 'dude'; refId: number }> = [];
  for (let index = 0; index < targetAssetIds.length; index += 1) {
    if (!infos[index]) continue;
    const assetId = targetAssetIds[index];
    const stored = byAssetId.get(assetId);
    const kind = stored?.kind;
    const refId = Number(stored?.refId);
    if (kind !== 'box' && kind !== 'dude') {
      throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing item kind for receipt minting.', {
        assetId,
      });
    }
    if (!Number.isSafeInteger(refId) || refId < 1 || refId > 0xffff_ffff) {
      throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing item refId for receipt minting.', {
        assetId,
      });
    }
    if (kind === 'dude' && refId > runtime.maxDudeId) {
      throw new DeliveryReceiptError('failed-precondition', 'Invalid figure id for receipt minting.', {
        assetId,
      });
    }
    pending.push({ assetId, asset: new PublicKey(assetId), kind, refId });
  }
  return pending;
}

async function sendReceiptBatch(args: {
  connection: Connection;
  runtime: DeliveryRuntime;
  signer: Keypair;
  owner: PublicKey;
  coreCollection: PublicKey;
  batch: readonly { asset: PublicKey; kind: 'box' | 'dude'; refId: number }[];
  signal: AbortSignal;
  lifecycle: ReceiptSubmissionLifecycle;
}): Promise<string> {
  const burnInstructions = args.batch.map((item) => mplCoreBurnInstruction({
    asset: item.asset,
    coreCollection: args.coreCollection,
    signer: args.signer.publicKey,
  }));
  const boxIds = args.batch.filter((item) => item.kind === 'box').map((item) => item.refId);
  const dudeIds = args.batch.filter((item) => item.kind === 'dude').map((item) => item.refId);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...burnInstructions,
    mintReceiptsInstruction({
      runtime: args.runtime,
      signer: args.signer.publicKey,
      recipient: args.owner,
      coreCollection: args.coreCollection,
      boxIds,
      dudeIds,
    }),
  ];
  let lastError: unknown;
  for (let attempt = 0; attempt < TX_MAX_SEND_ATTEMPTS; attempt += 1) {
    if (args.signal.aborted) throw args.signal.reason;
    const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash('confirmed');
    let transaction: VersionedTransaction;
    try {
      transaction = buildTransaction(instructions, args.signer.publicKey, blockhash, args.signer);
      if (transaction.serialize().length > SOLANA_MAX_RAW_TX_BYTES) {
        throw new RangeError('Receipt issuance transaction is too large.');
      }
    } catch (error) {
      throw error;
    }
    const signature = bs58.encode(transaction.signatures[0]);
    const pendingSubmission: PendingReceiptSubmission = {
      signature,
      blockhash,
      lastValidBlockHeight,
      assetIds: args.batch.map((item) => item.asset.toBase58()),
    };
    const submittedAtMs = Date.now();
    let submissionMayHaveLanded = false;
    try {
      await args.lifecycle.prepare(pendingSubmission);
      if (args.signal.aborted) {
        await args.lifecycle.settle(pendingSubmission, 'expired');
        throw args.signal.reason;
      }
      submissionMayHaveLanded = true;
      let sendError: unknown;
      try {
        await args.connection.sendTransaction(transaction, { maxRetries: 2 });
      } catch (error) {
        sendError = error;
        lastError = error;
      }
      if (sendError) {
        const message = transactionErrorMessage(sendError);
        const logs = transactionErrorLogs(sendError);
        if (logs.length) {
          submissionMayHaveLanded = false;
          await args.lifecycle.settle(pendingSubmission, 'expired');
          if (
            looksLikeAccountInUseError(message, logs) ||
            looksLikeRateLimitOrRpcError(message) ||
            looksLikeBlockhashError(message)
          ) {
            await pause(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000), args.signal);
            continue;
          }
          throw new DeliveryReceiptError(
            looksLikeComputeLimitError(message, logs) ? 'resource-exhausted' : 'failed-precondition',
            'Unable to issue receipts. Try fewer items or retry later.',
            { lastError: message, lastLogs: logs.slice(0, 80) },
          );
        }
        const maybe = await waitForSignature(args.connection, signature, args.signal, TX_SEND_TIMEOUT_MS);
        if (maybe.ok) {
          await args.lifecycle.settle(pendingSubmission, 'confirmed');
          return signature;
        }
        if (maybe.definitive) {
          submissionMayHaveLanded = false;
          await args.lifecycle.settle(pendingSubmission, 'expired');
          await pause(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000), args.signal);
          continue;
        }
        const postInfos = await args.connection.getMultipleAccountsInfo(
          args.batch.map((item) => item.asset),
          { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
        );
        if (postInfos.every((info) => !info)) {
          await args.lifecycle.settle(pendingSubmission, 'confirmed');
          return signature;
        }
        const outcome = await args.lifecycle.reconcile(pendingSubmission);
        if (outcome === 'confirmed') return signature;
        if (outcome === 'unresolved') {
          throw new DeliveryReceiptError('unavailable', 'Receipt issuance transaction submission status is unknown. Try again.', {
            signature,
            maybeSubmitted: true,
          });
        }
        submissionMayHaveLanded = false;
        await pause(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000), args.signal);
        continue;
      }
      const confirmed = await waitForSignature(args.connection, signature, args.signal, TX_CONFIRM_TIMEOUT_MS);
      if (confirmed.ok) {
        await args.lifecycle.settle(pendingSubmission, 'confirmed');
        return signature;
      }
      lastError = confirmed.error;
      const message = transactionErrorMessage(confirmed.error);
      if (confirmed.definitive) {
        submissionMayHaveLanded = false;
        await args.lifecycle.settle(pendingSubmission, 'expired');
      } else {
        const postInfos = await args.connection.getMultipleAccountsInfo(
          args.batch.map((item) => item.asset),
          { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
        );
        if (postInfos.every((info) => !info)) {
          await args.lifecycle.settle(pendingSubmission, 'confirmed');
          return signature;
        }
        const outcome = await args.lifecycle.reconcile(pendingSubmission);
        if (outcome === 'confirmed') return signature;
        if (outcome === 'unresolved') {
          throw new DeliveryReceiptError('unavailable', 'Receipt issuance transaction submission status is unknown. Try again.', {
            signature,
            maybeSubmitted: true,
          });
        }
        submissionMayHaveLanded = false;
      }
      if (looksLikeComputeLimitError(message, confirmed.logs)) {
        throw new DeliveryReceiptError('resource-exhausted', 'Receipt issuance batch exceeded compute limits.', {
          lastError: message,
          lastLogs: confirmed.logs.slice(0, 80),
        });
      }
      await pause(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000), args.signal);
    } catch (error) {
      if (submissionMayHaveLanded && isSignalCancellationError(args.signal, error)) {
        throw unknownTransactionSubmissionError({
          label: 'Receipt issuance',
          signal: args.signal,
          signature,
          details: { lastValidBlockHeight, submittedAtMs },
        });
      }
      throw error;
    }
  }
  throw new ReceiptBatchRetryExhaustedError(lastError);
}

function shouldShrinkReceiptBatch(error: unknown): boolean {
  return error instanceof RangeError ||
    error instanceof ReceiptBatchRetryExhaustedError ||
    (error instanceof DeliveryReceiptError && error.code === 'resource-exhausted');
}

async function closeDeliveryPda(args: {
  connection: Connection;
  runtime: DeliveryRuntime;
  signer: Keypair;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
  signal: AbortSignal;
}): Promise<string | null> {
  const info = await args.connection.getAccountInfo(args.deliveryPda, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
  });
  if (!info) return null;
  const { blockhash } = await args.connection.getLatestBlockhash('confirmed');
  const transaction = buildTransaction([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    closeDeliveryInstruction({
      runtime: args.runtime,
      signer: args.signer.publicKey,
      deliveryPda: args.deliveryPda,
      deliveryId: args.deliveryId,
      deliveryBump: args.deliveryBump,
    }),
  ], args.signer.publicKey, blockhash, args.signer);
  return sendAndConfirmSignedTransaction(args.connection, transaction, args.signal, 'Close delivery');
}

async function retryIssueReceipts(args: {
  request: RetryIssueReceiptsArgs;
  env: DeliveryReceiptsEnv;
  commerce: CommerceContext;
  provider: ProviderContext;
  waitUntil: DeferredWork;
  randomInt: (maxExclusive: number) => number;
}): Promise<ReceiptIssueResult> {
  const owner = canonicalPublicKey(args.request.ownerWallet, 'wallet address');
  const deliveryId = Math.floor(args.request.deliveryId);
  const runtime = runtimeForDrop(args.request.dropId);
  const path = dropDeliveryOrderPath(runtime.dropId, deliveryId);
  let document = await readDocument(args.commerce, path);
  if (!document) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  if (document.fields.owner && document.fields.owner !== owner.toBase58()) {
    throw new DeliveryReceiptError('permission-denied', 'Order belongs to a different wallet.');
  }
  const connection = createConnection(args.provider, runtime);
  const onchain = await fetchOnchainConfig(connection, runtime);
  const signer = decodeCosigner(args.env.COSIGNER_SECRET);
  if (!signer.publicKey.equals(onchain.admin)) {
    throw new DeliveryReceiptError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin.');
  }
  if (document.fields.status === 'ready_to_ship') {
    scheduleDeliveryPackStatusProjection({
      context: args.commerce,
      deliveryId,
      dropId: runtime.dropId,
      waitUntil: args.waitUntil,
    });
    let closeDeliveryTx = typeof document.fields.closeDeliveryTx === 'string'
      ? document.fields.closeDeliveryTx
      : null;
    if (!closeDeliveryTx) {
      const [deliveryPda, deliveryBump] = deriveDeliveryPda(runtime, deliveryId);
      try {
        closeDeliveryTx = await closeDeliveryPda({
          connection,
          runtime,
          signer,
          deliveryPda,
          deliveryId,
          deliveryBump,
          signal: args.provider.signal,
        });
        if (closeDeliveryTx) {
          await recordDeliveryClose(args.commerce, document.path, runtime.dropId, closeDeliveryTx);
        }
      } catch (error) {
        console.warn({
          event: 'delivery_receipt_late_close_failed',
          dropId: runtime.dropId,
          deliveryId,
          error: summarizeError(error),
        });
      }
    }
    await publishReadyToShipNotifications({
      context: args.commerce,
      deliveryId,
      document,
      dropId: runtime.dropId,
      queue: args.env.NOTIFICATION_EMAIL_QUEUE,
    });
    return {
      processed: true,
      deliveryId,
      receiptsMinted: Number(document.fields.receiptsMinted || 0),
      receiptTxs: Array.isArray(document.fields.receiptTxs)
        ? document.fields.receiptTxs.filter((value): value is string => typeof value === 'string')
        : [],
      closeDeliveryTx,
    };
  }
  const verified = args.request.verification === 'signature'
    ? await verifyReceiptIssuanceBySignature({
        connection,
        deliveryId,
        order: document.fields,
        ownerWallet: owner.toBase58(),
        runtime,
        signature: args.request.signature,
      })
    : await verifyReceiptIssuanceByDeliveryRecord({
        connection,
        deliveryId,
        order: document.fields,
        ownerWallet: owner.toBase58(),
        runtime,
      });
  await markDeliveryProcessing(args.commerce, document, runtime, verified.signature);
  const storedPendingSubmission = pendingReceiptSubmission(document.fields);
  if (storedPendingSubmission) {
    const outcome = await reconcilePendingReceiptSubmission({
      commerce: args.commerce,
      provider: args.provider,
      runtime,
      path: document.path,
      pending: storedPendingSubmission,
    });
    if (outcome === 'unresolved') {
      throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
    }
    const reconciled = await readDocument(args.commerce, path);
    if (!reconciled) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
    document = reconciled;
  }
  const lifecycle: ReceiptSubmissionLifecycle = {
    prepare: (pendingSubmission) => persistPendingReceiptSubmission(
      args.commerce,
      document.path,
      pendingSubmission,
    ),
    reconcile: (pendingSubmission) => reconcilePendingReceiptSubmission({
      commerce: args.commerce,
      provider: args.provider,
      runtime,
      path: document.path,
      pending: pendingSubmission,
    }),
    settle: (pendingSubmission, outcome) => settlePendingReceiptSubmission(
      cleanupContext(args.commerce),
      document.path,
      pendingSubmission,
      outcome,
    ),
  };
  const assetKeys = verified.targetAssetIds.map((assetId) => canonicalPublicKey(assetId, 'delivery asset id'));
  const infos = await connection.getMultipleAccountsInfo(assetKeys, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
  });
  const pending = pendingReceiptItems(document.fields, verified.targetAssetIds, infos, runtime);
  const alreadyProcessed = verified.targetAssetIds.length - pending.length;
  const receiptTxs = confirmedReceiptTransactions(document.fields);
  let totalProcessed = 0;
  while (pending.length) {
    if (args.provider.signal.aborted) throw args.provider.signal.reason;
    let batchSize = Math.min(pending.length, 3);
    let lastError: unknown;
    while (batchSize >= 1) {
      try {
        const signature = await sendReceiptBatch({
          connection,
          runtime,
          signer,
          owner,
          coreCollection: onchain.coreCollection,
          batch: pending.slice(0, batchSize),
          signal: args.provider.signal,
          lifecycle,
        });
        if (!receiptTxs.includes(signature)) receiptTxs.push(signature);
        totalProcessed += batchSize;
        pending.splice(0, batchSize);
        break;
      } catch (error) {
        lastError = error;
        if (shouldShrinkReceiptBatch(error)) {
          batchSize -= 1;
          continue;
        }
        throw error;
      }
    }
    if (batchSize < 1) {
      throw new DeliveryReceiptError(
        'failed-precondition',
        'Unable to issue receipts. Try fewer items or retry later.',
        { lastError: transactionErrorMessage(lastError) },
      );
    }
  }
  const receiptsMinted = alreadyProcessed + totalProcessed;
  const irlClaims: Array<{ code: string; boxId: number; boxAssetId: string; dudeIds: number[] }> = [];
  if (runtime.itemsPerBox > 0) {
    const items = Array.isArray(document.fields.items)
      ? document.fields.items.filter((item): item is CommerceDocumentData => isRecord(item))
      : [];
    for (const item of items) {
      if (item.kind !== 'box' || typeof item.assetId !== 'string') continue;
      const boxId = Number(item.refId);
      if (!Number.isSafeInteger(boxId) || boxId < 1 || boxId > 0xffff_ffff) continue;
      const dudeIds = await assignDudesForBox(
        args.commerce,
        runtime,
        item.assetId,
        args.randomInt,
      );
      const code = await ensureIrlClaimCodeForBox(args.commerce, runtime, {
        ownerWallet: owner.toBase58(),
        deliveryId,
        boxAssetId: item.assetId,
        boxId,
        dudeIds,
      }, args.randomInt);
      irlClaims.push({ code, boxId, boxAssetId: item.assetId, dudeIds });
    }
  }
  const readyDocument = await markDeliveryReady(args.commerce, document, runtime, {
    signature: verified.signature,
    receiptsMinted,
    receiptTxs,
    irlClaims,
  });
  scheduleDeliveryPackStatusProjection({
    context: args.commerce,
    deliveryId,
    dropId: runtime.dropId,
    waitUntil: args.waitUntil,
  });
  let closeDeliveryTx: string | null = null;
  try {
    closeDeliveryTx = await closeDeliveryPda({
      connection,
      runtime,
      signer,
      deliveryPda: verified.expectedDeliveryPda,
      deliveryId,
      deliveryBump: verified.expectedDeliveryBump,
      signal: args.provider.signal,
    });
  } catch (error) {
    console.warn({
      event: 'delivery_receipt_close_failed',
      dropId: runtime.dropId,
      deliveryId,
      error: summarizeError(error),
    });
  }
  if (closeDeliveryTx) {
    await recordDeliveryClose(args.commerce, document.path, runtime.dropId, closeDeliveryTx);
  }
  await publishReadyToShipNotifications({
    context: args.commerce,
    deliveryId,
    document: readyDocument,
    dropId: runtime.dropId,
    queue: args.env.NOTIFICATION_EMAIL_QUEUE,
  });
  return { processed: true, deliveryId, receiptsMinted, receiptTxs, closeDeliveryTx };
}

function cleanupContext(context: CommerceContext): CommerceContext {
  return {
    ...context,
    nowMs: Date.now(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  };
}

function isDeliveryRecoveryCancellation(error: unknown, signal: AbortSignal): boolean {
  return isSignalCancellationError(signal, error);
}

function confirmedReceiptTransactions(order: Record<string, unknown>): string[] {
  if (!Array.isArray(order.receiptTxs)) return [];
  return Array.from(new Set(order.receiptTxs.filter((value): value is string =>
    typeof value === 'string' && isNonZeroBase58Bytes(value, 64))));
}

function pendingReceiptSubmission(order: Record<string, unknown>): PendingReceiptSubmission | undefined {
  const recovery = isRecord(order.receiptRecovery) ? order.receiptRecovery : {};
  const value = recovery.pendingSubmission;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored receipt submission recovery is invalid.');
  }
  const signature = typeof value.signature === 'string' ? value.signature.trim() : '';
  const blockhash = typeof value.blockhash === 'string' ? value.blockhash.trim() : '';
  const lastValidBlockHeight = Math.floor(Number(value.lastValidBlockHeight));
  const assetIds = Array.isArray(value.assetIds)
    ? value.assetIds.map((assetId) => typeof assetId === 'string' ? assetId.trim() : '')
    : [];
  if (
    !isNonZeroBase58Bytes(signature, 64) || !isNonZeroBase58Bytes(blockhash, 32) ||
    !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1 ||
    assetIds.length < 1 || assetIds.length > 3 || new Set(assetIds).size !== assetIds.length ||
    assetIds.some((assetId) => !isNonZeroBase58Bytes(assetId, 32))
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored receipt submission recovery is invalid.');
  }
  return { signature, blockhash, lastValidBlockHeight, assetIds };
}

async function hasPendingReceiptSubmission(context: CommerceContext, path: string): Promise<boolean> {
  try {
    const document = await readDocument(context, path);
    return Boolean(document && pendingReceiptSubmission(document.fields));
  } catch {
    return true;
  }
}

function samePendingReceiptSubmission(left: PendingReceiptSubmission, right: PendingReceiptSubmission): boolean {
  return left.signature === right.signature &&
    left.blockhash === right.blockhash &&
    left.lastValidBlockHeight === right.lastValidBlockHeight &&
    left.assetIds.length === right.assetIds.length &&
    left.assetIds.every((assetId, index) => assetId === right.assetIds[index]);
}

function pendingReceiptSubmissionAlreadySettled(
  document: Record<string, unknown>,
  pending: PendingReceiptSubmission,
  outcome: Exclude<ReceiptSubmissionOutcome, 'unresolved'>,
): boolean {
  return outcome === 'expired' || confirmedReceiptTransactions(document).includes(pending.signature);
}

async function persistPendingReceiptSubmission(
  context: CommerceContext,
  path: string,
  pending: PendingReceiptSubmission,
): Promise<void> {
  try {
    await retryCommerceConflicts(async () => {
      const document = await readDocument(context, path);
      if (!document) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
      const existing = pendingReceiptSubmission(document.fields);
      if (existing && !samePendingReceiptSubmission(existing, pending)) {
        throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
      }
      await commitWrites(context, [updateWrite({
        path,
        values: {
          [RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD]: pending,
          'receiptRecovery.leaseExpiresAt': commerceTimestamp(
            context.nowMs + DELIVERY_AMBIGUOUS_SUBMISSION_LEASE_MS,
          ),
        },
        expectedUpdateTime: document.updateTime,
      })]);
    }, { signal: context.signal });
  } catch (error) {
    if (!(error instanceof CommerceWriteConflict)) {
      try {
        const cleanup = cleanupContext(context);
        const document = await readDocument(cleanup, path);
        const stored = document && pendingReceiptSubmission(document.fields);
        if (stored && samePendingReceiptSubmission(stored, pending)) return;
      } catch {}
    }
    throw error;
  }
}

async function settlePendingReceiptSubmission(
  context: CommerceContext,
  path: string,
  pending: PendingReceiptSubmission,
  outcome: Exclude<ReceiptSubmissionOutcome, 'unresolved'>,
): Promise<void> {
  try {
    await retryCommerceConflicts(async () => {
      const document = await readDocument(context, path);
      if (!document) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
      const existing = pendingReceiptSubmission(document.fields);
      if (!existing) {
        if (pendingReceiptSubmissionAlreadySettled(document.fields, pending, outcome)) return;
        throw new DeliveryReceiptError('aborted', 'Receipt submission recovery changed.');
      }
      if (!samePendingReceiptSubmission(existing, pending)) {
        throw new DeliveryReceiptError('aborted', 'Receipt submission recovery changed.');
      }
      await commitWrites(context, [updateWrite({
        path,
        values: {
          ...(outcome === 'confirmed' ? { receiptTxs: commerceFieldValue.arrayUnion(pending.signature) } : {}),
          [RECEIPT_RECOVERY_PENDING_SUBMISSION_FIELD]: commerceFieldValue.delete(),
        },
        expectedUpdateTime: document.updateTime,
      })]);
    }, { signal: context.signal });
  } catch (error) {
    try {
      const cleanup = cleanupContext(context);
      const document = await readDocument(cleanup, path);
      const stored = document && pendingReceiptSubmission(document.fields);
      if (
        document && !stored &&
        pendingReceiptSubmissionAlreadySettled(document.fields, pending, outcome)
      ) return;
    } catch {}
    throw error;
  }
}

async function probePendingReceiptSubmission(
  connection: Connection,
  pending: PendingReceiptSubmission,
): Promise<ReceiptSubmissionOutcome> {
  const status = (await connection.getSignatureStatuses(
    [pending.signature],
    { searchTransactionHistory: true },
  )).value[0];
  if (status?.err) return 'expired';
  if (hasConfirmedSignatureCommitment(status)) {
    return 'confirmed';
  }
  if (status) return 'unresolved';
  const infos = await connection.getMultipleAccountsInfo(
    pending.assetIds.map((assetId) => new PublicKey(assetId)),
    { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
  );
  if (infos.every((info) => !info)) return 'confirmed';
  const validity = await connection.isBlockhashValid(pending.blockhash, { commitment: 'confirmed' });
  return validity.value ? 'unresolved' : 'expired';
}

async function reconcilePendingReceiptSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: DeliveryRuntime;
  path: string;
  pending: PendingReceiptSubmission;
}): Promise<ReceiptSubmissionOutcome> {
  const probeContext = cleanupContext(args.commerce);
  let outcome: ReceiptSubmissionOutcome = 'unresolved';
  try {
    outcome = await probePendingReceiptSubmission(
      createConnection({ ...args.provider, signal: probeContext.signal }, args.runtime),
      args.pending,
    );
  } catch {}
  const persistence = cleanupContext(args.commerce);
  if (outcome === 'unresolved') {
    await persistPendingReceiptSubmission(persistence, args.path, args.pending);
  } else {
    await settlePendingReceiptSubmission(persistence, args.path, args.pending, outcome);
  }
  return outcome;
}

function normalizeRecoveryErrorCode(error: unknown): string | undefined {
  if (error instanceof DeliveryReceiptError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'deadline-exceeded';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  return error instanceof Error ? 'internal' : undefined;
}

function isRetryableRecoveryErrorCode(errorCode: string | undefined): boolean {
  return errorCode === 'aborted' ||
    errorCode === 'deadline-exceeded' ||
    errorCode === 'internal' ||
    errorCode === 'resource-exhausted' ||
    errorCode === 'unavailable';
}

async function handlePreparedRecoveryFailure(
  context: CommerceContext,
  documentPath: string,
  outcome: DeliveryRecoveryOutcome,
  errorCode: string | undefined,
  nowMs = Date.now(),
): Promise<void> {
  const current = await readDocument(context, documentPath);
  if (current?.fields.status !== 'prepared') return;
  if (outcome === 'missing_delivery') {
    await recordPreparedDeliveryRecoveryMiss(context, current, nowMs);
  } else if (isRetryableRecoveryErrorCode(errorCode)) {
    await deferPreparedDeliveryRecovery(context, current, nowMs);
  } else {
    await stopPreparedDeliveryRecoveryChecks(context, current, nowMs);
  }
}

function normalizeRecoveryMessage(error: unknown): string | undefined {
  const value = String(error instanceof Error ? error.message : error || '').trim();
  return value ? value.slice(0, 300) : undefined;
}

function deliveryRecoveryFailure(error: unknown): {
  errorCode: string | undefined;
  message: string | undefined;
  outcome: DeliveryRecoveryOutcome;
} {
  rethrowDeferredWorkRegistrationError(error);
  const errorCode = normalizeRecoveryErrorCode(error);
  const message = normalizeRecoveryMessage(error);
  const outcome: DeliveryRecoveryOutcome = errorCode === 'failed-precondition' &&
    /delivery record pda not found/i.test(message || '')
    ? 'missing_delivery'
    : 'failed';
  return { errorCode, message, outcome };
}

async function issueReceiptsRequest(
  body: IssueRequest,
  identity: RequestIdentity,
  env: DeliveryReceiptsEnv,
  commerce: CommerceContext,
  provider: ProviderContext,
  waitUntil: DeferredWork,
  overrides: Partial<{ retryIssueReceipts: typeof retryIssueReceipts }> = {},
): Promise<ReceiptIssueResult> {
  const wallet = await resolveRequestWallet(identity, (uid) => loadBoundWallet(commerce, env.OPS_DB, uid));
  const ownerWallet = canonicalPublicKey(body.owner, 'wallet address').toBase58();
  if (wallet !== ownerWallet) throw new DeliveryReceiptError('permission-denied', 'Owners only.');
  if (!isNonZeroBase58Bytes(body.signature, 64)) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery signature.');
  }
  const runtime = runtimeForDrop(body.dropId);
  const path = dropDeliveryOrderPath(runtime.dropId, body.deliveryId);
  const order = await readDocument(commerce, path);
  if (!order) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  let acquiredLease: Extract<Awaited<ReturnType<typeof acquireDeliveryRecoveryLease>>, { acquired: true }>['lease'] | undefined;
  if (order.fields.status !== 'ready_to_ship') {
    const lease = await acquireDeliveryRecoveryLease(commerce, path, ownerWallet, Date.now(), true);
    if (!lease.acquired) {
      if (lease.result.outcome === 'lease_active') {
        throw new DeliveryReceiptError('aborted', lease.result.message || 'Another client is already retrying this order.');
      }
      if (lease.result.outcome === 'not_found') {
        throw new DeliveryReceiptError('not-found', lease.result.message || 'Delivery order not found.');
      }
      if (lease.result.errorCode === 'permission-denied') {
        throw new DeliveryReceiptError('permission-denied', lease.result.message || 'Order belongs to a different wallet.');
      }
      if (lease.result.outcome !== 'skipped_status') {
        throw new DeliveryReceiptError('failed-precondition', lease.result.message || 'Unable to start receipt issuance.');
      }
    } else {
      acquiredLease = lease.lease;
    }
  }
  try {
    if (commerce.signal.aborted) throw commerce.signal.reason;
    const result = await (overrides.retryIssueReceipts || retryIssueReceipts)({
      request: {
        ownerWallet,
        deliveryId: body.deliveryId,
        dropId: runtime.dropId,
        verification: 'signature',
        signature: body.signature,
      },
      env,
      commerce,
      provider,
      waitUntil,
      randomInt: secureRandomInt,
    });
    if (acquiredLease) {
      await finalizeDeliveryRecoveryAttempt(cleanupContext(commerce), path, {}).catch(() => undefined);
    }
    return result;
  } catch (error) {
    if (acquiredLease && isDeliveryRecoveryCancellation(error, commerce.signal)) {
      const reason = commerce.signal.reason;
      const cleanup = cleanupContext(commerce);
      if (!await hasPendingReceiptSubmission(cleanup, path)) {
        await cancelDeliveryRecoveryAttempt(cleanup, path, acquiredLease).catch(() => undefined);
      }
      throw reason;
    }
    if (acquiredLease) {
      const cleanup = cleanupContext(commerce);
      if (!await hasPendingReceiptSubmission(cleanup, path)) {
        await finalizeDeliveryRecoveryAttempt(cleanup, path, {
          errorCode: normalizeRecoveryErrorCode(error),
          message: normalizeRecoveryMessage(error),
        }).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function hasConfirmedDeliveryRecord(
  provider: ProviderContext,
  runtime: DeliveryRuntime,
  deliveryId: number,
  order: Record<string, unknown>,
): Promise<boolean> {
  const connection = createConnection(provider, runtime);
  const [expectedDeliveryPda] = deriveDeliveryPda(runtime, deliveryId);
  assertStoredDeliveryPda(order, expectedDeliveryPda);
  return Boolean(await fetchDeliveryRecord(connection, runtime, deliveryId, false));
}

async function recoverReceiptsRequest(
  body: RecoverRequest,
  identity: RequestIdentity,
  env: DeliveryReceiptsEnv,
  commerce: CommerceContext,
  provider: ProviderContext,
  waitUntil: DeferredWork,
  overrides: Partial<{
    hasConfirmedDeliveryRecord: typeof hasConfirmedDeliveryRecord;
    recordPreparedDeliveryRecoveryMiss: typeof recordPreparedDeliveryRecoveryMiss;
    retryIssueReceipts: typeof retryIssueReceipts;
  }> = {},
): Promise<RecoverDeliveryOrdersResult> {
  const recoveryDependencies = {
    hasConfirmedDeliveryRecord,
    recordPreparedDeliveryRecoveryMiss,
    retryIssueReceipts,
    ...overrides,
  };
  const wallet = await resolveRequestWallet(identity, (uid) => loadBoundWallet(commerce, env.OPS_DB, uid));
  if (body.deliveryId !== undefined && body.dropId === undefined) {
    throw new DeliveryReceiptError('invalid-argument', 'deliveryId requires dropId.');
  }
  const filterDropId = body.dropId ? runtimeForDrop(body.dropId).dropId : undefined;
  const force = body.force === true;
  const nowMs = Date.now();
  const results: RecoverDeliveryOrdersItemResult[] = [];
  let attempted = 0;
  let recovered = 0;
  let candidates: DeliveryOrderDocument[] = [];
  if (filterDropId && body.deliveryId !== undefined) {
    const document = await readDocument(commerce, dropDeliveryOrderPath(filterDropId, body.deliveryId));
    if (document) candidates = [document];
    else {
      results.push({
        dropId: filterDropId,
        deliveryId: body.deliveryId,
        statusBefore: 'missing',
        outcome: 'not_found',
        verification: 'delivery_pda',
        message: 'delivery order not found',
      });
    }
  } else {
    const [recovery, pendingReady] = await Promise.all([
      runDeliveryRecoveryOrderQuery(commerce, wallet, true),
      runPendingReadyNotificationQuery(commerce, wallet),
    ]);
    candidates = Array.from(
      new Map([...recovery, ...pendingReady].map((document) => [document.path, document])).values(),
    ).filter((document) => !filterDropId || resolveDeliveryOrderDropId(document.fields, document.path) === filterDropId);
  }
  candidates.sort(compareDeliveryRecoveryCandidates);
  for (const document of candidates) {
    if (commerce.signal.aborted) throw commerce.signal.reason;
    const base = orderResultBase(document);
    if (!base) continue;
    if (document.fields.owner && document.fields.owner !== wallet) {
      results.push({
        ...base,
        outcome: 'failed',
        verification: 'delivery_pda',
        errorCode: 'permission-denied',
        message: 'order belongs to a different wallet',
      });
      continue;
    }
    if (base.statusBefore === 'ready_to_ship') {
      const result = await recoveryDependencies.retryIssueReceipts({
        request: {
          ownerWallet: wallet,
          deliveryId: base.deliveryId,
          dropId: base.dropId,
          verification: 'delivery_pda',
        },
        env,
        commerce,
        provider,
        waitUntil,
        randomInt: secureRandomInt,
      });
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: result.processed ? 'ready-order notifications resumed' : 'order already processed',
      });
      recovered += 1;
      continue;
    }
    const runtime = runtimeForDrop(base.dropId);
    if (base.statusBefore === 'prepared' && !force) {
      let exists: boolean | null = null;
      try {
        exists = await recoveryDependencies.hasConfirmedDeliveryRecord(
          provider,
          runtime,
          base.deliveryId,
          document.fields,
        );
      } catch (error) {
        if (isDeliveryRecoveryCancellation(error, commerce.signal)) throw commerce.signal.reason;
        console.warn({
          event: 'delivery_receipt_recovery_eligibility_failed',
          dropId: base.dropId,
          deliveryId: base.deliveryId,
          error: summarizeError(error),
        });
      }
      if (commerce.signal.aborted) throw commerce.signal.reason;
      if (exists === false) {
        const nextCheckAt = await recoveryDependencies.recordPreparedDeliveryRecoveryMiss(
          commerce,
          document,
          nowMs,
        ).catch((error) => {
          if (isDeliveryRecoveryCancellation(error, commerce.signal)) throw commerce.signal.reason;
          console.warn({
            event: 'delivery_receipt_recovery_probe_failed',
            dropId: base.dropId,
            deliveryId: base.deliveryId,
            error: summarizeError(error),
          });
          return null;
        });
        results.push({
          ...base,
          outcome: 'not_eligible',
          verification: 'delivery_pda',
          message: nextCheckAt === null
            ? 'prepared order never produced a confirmed on-chain delivery record'
            : 'prepared order has no confirmed on-chain delivery record yet',
        });
        continue;
      }
    }
    if (attempted >= MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) {
      results.push({
        ...base,
        outcome: 'attempt_capped',
        verification: 'delivery_pda',
        message: 'recovery attempt cap reached for this pass',
      });
      continue;
    }
    const lease = await acquireDeliveryRecoveryLease(commerce, document.path, wallet, nowMs, force);
    if (!lease.acquired) {
      results.push(lease.result);
      continue;
    }
    attempted += 1;
    try {
      if (commerce.signal.aborted) throw commerce.signal.reason;
      const result = await recoveryDependencies.retryIssueReceipts({
        request: {
          ownerWallet: wallet,
          deliveryId: base.deliveryId,
          dropId: base.dropId,
          verification: 'delivery_pda',
        },
        env,
        commerce,
        provider,
        waitUntil,
        randomInt: secureRandomInt,
      });
      recovered += 1;
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: result.processed ? 'receipts issued' : 'order already processed',
      });
      await finalizeDeliveryRecoveryAttempt(cleanupContext(commerce), document.path, {}).catch(() => undefined);
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isDeliveryRecoveryCancellation(error, commerce.signal)) {
        const reason = commerce.signal.reason;
        const cleanup = cleanupContext(commerce);
        if (!await hasPendingReceiptSubmission(cleanup, document.path)) {
          await cancelDeliveryRecoveryAttempt(
            cleanup,
            document.path,
            lease.lease,
          ).catch(() => undefined);
        }
        throw reason;
      }
      const { errorCode, message, outcome } = deliveryRecoveryFailure(error);
      const cleanup = cleanupContext(commerce);
      if (base.statusBefore === 'prepared') {
        await handlePreparedRecoveryFailure(
          cleanup,
          document.path,
          outcome,
          errorCode,
        ).catch(() => undefined);
      }
      if (!await hasPendingReceiptSubmission(cleanup, document.path)) {
        await finalizeDeliveryRecoveryAttempt(cleanup, document.path, {
          errorCode,
          message,
        }).catch(() => undefined);
      }
      if (error instanceof ReadyToShipNotificationEnqueueError) throw error;
      results.push({
        ...base,
        outcome,
        verification: 'delivery_pda',
        ...(errorCode ? { errorCode } : {}),
        ...(message ? { message } : {}),
      });
      console.warn({
        event: 'delivery_receipt_recovery_failed',
        dropId: base.dropId,
        deliveryId: base.deliveryId,
        error: summarizeError(error),
      });
    }
  }
  if (commerce.signal.aborted) throw commerce.signal.reason;
  const walletRecovery = await fetchDeliveryRecoveryState(commerce, wallet, Date.now());
  return buildRecoverDeliveryOrdersResult({ attempted, recovered, walletRecovery, results });
}

const defaultDependencies: DeliveryReceiptDependencies = {
  issue: issueReceiptsRequest,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  recover: recoverReceiptsRequest,
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

export async function handleDeliveryReceiptRequest(
  request: Request,
  env: DeliveryReceiptsEnv,
  path: typeof DELIVERY_RECEIPTS_ISSUE_PATH | typeof DELIVERY_RECEIPTS_RECOVER_PATH,
  defer: DeferredWork,
  overrides: Partial<DeliveryReceiptDependencies> = {},
): Promise<DeliveryReceiptRequestResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: DeliveryRequestMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new DeliveryReceiptError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics,
      authOutcome: 'rejected',
    };
  }
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs,
    timeoutMessage: 'Delivery receipt request timed out',
  });
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await dependencies.providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  };
  let identity: RequestIdentity | undefined;
  let dropId: string | undefined;
  let deliveryId: number | undefined;
  try {
    const verifiedIdentity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      deadline.signal,
      dependencies.nowMs(),
    );
    identity = verifiedIdentity;
    const rawBody = await readRequestBody(
      request,
      deadline.signal,
      path === DELIVERY_RECEIPTS_ISSUE_PATH ? 'issue' : 'recover',
    );
    const apiKey = String(env.HELIUS_API_KEY || '').trim();
    const cosignerSecret = String(env.COSIGNER_SECRET || '').trim();
    if (!apiKey || !cosignerSecret) {
      throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
    }
    const common: CommerceContext = {
      commerceDb: env.COMMERCE_DB,
      repository: new D1CommerceRepository(env.COMMERCE_DB),
      nowMs: dependencies.nowMs(),
      providerFetch: trackedFetch,
      signal: deadline.signal,
      dataDb: env.DATA_DB,
    };
    const provider: ProviderContext = { apiKey, fetch: trackedFetch, signal: deadline.signal };
    if (path === DELIVERY_RECEIPTS_ISSUE_PATH) {
      const body = rawBody as IssueRequest;
      dropId = normalizeDropId(body.dropId);
      deliveryId = body.deliveryId;
      const result: IssueReceiptsResult = await runCriticalRequestOperation(
        () => dependencies.issue(
          body,
          verifiedIdentity,
          env,
          common,
          provider,
          defer,
        ),
        { deadline, defer },
      );
      return {
        response: jsonResponse(result, 200, {
          headers: { 'Timing-Allow-Origin': '*' },
        }),
        metrics,
        authOutcome: 'accepted',
        dropId,
        deliveryId,
        verification: 'signature',
      };
    }
    const body = rawBody as RecoverRequest;
    dropId = body.dropId ? normalizeDropId(body.dropId) : undefined;
    deliveryId = body.deliveryId;
    const result = await runCriticalRequestOperation(
      () => dependencies.recover(
        body,
        verifiedIdentity,
        env,
        common,
        provider,
        defer,
      ),
      { deadline, defer },
    );
    return {
      response: jsonResponse(result, 200, {
        headers: { 'Timing-Allow-Origin': '*' },
      }),
      metrics,
      authOutcome: 'accepted',
      ...(dropId ? { dropId } : {}),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      verification: 'delivery_pda',
      attempted: result.attempted,
      recovered: result.recovered,
    };
  } catch (error) {
    rethrowDeferredWorkRegistrationError(error);
    let receiptError: DeliveryReceiptError;
    if (isRequestCancellationError(request, error)) throw error;
    if (deadline.timedOut()) {
      receiptError = new DeliveryReceiptError('deadline-exceeded', 'Delivery receipt request timed out.');
    } else if (error instanceof RequestIdentityError) {
      receiptError = new DeliveryReceiptError(
        error.kind === 'invalid-token' ? 'unauthenticated' : 'unavailable',
        error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.',
      );
    } else if (error instanceof DeliveryReceiptError) {
      receiptError = error;
    } else if (error instanceof ProfileReadError) {
      receiptError = new DeliveryReceiptError(
        error.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'unavailable',
        'Receipt data is temporarily unavailable.',
      );
    } else {
      console.error({
        event: 'delivery_receipt_unhandled_error',
        path,
        ...(dropId ? { dropId } : {}),
        ...(deliveryId === undefined ? {} : { deliveryId }),
        error: summarizeError(error),
      });
      receiptError = new DeliveryReceiptError('internal', 'Delivery receipt request failed.');
    }
    return {
      response: errorResponse(receiptError),
      metrics,
      authOutcome: identity
        ? 'accepted'
        : error instanceof RequestIdentityError && error.kind !== 'invalid-token'
          ? 'provider-failure'
          : 'rejected',
      ...(dropId ? { dropId } : {}),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      verification: path === DELIVERY_RECEIPTS_ISSUE_PATH ? 'signature' : 'delivery_pda',
    };
  } finally {
    deadline.dispose();
  }
}

export const deliveryReceiptTestHooks = {
  assignmentClaimCompatible,
  assertDeliveryPayers,
  assertDeliverArgsMatchOrder,
  acquireDeliveryRecoveryLease,
  cancelDeliveryRecoveryAttempt,
  compareDeliveryRecoveryCandidates,
  confirmedReceiptTransactions,
  decodeDeliveryRecord,
  deliveryRecoveryEligibility,
  deliveryRecoveryFailure,
  handlePreparedRecoveryFailure,
  issueReceiptsRequest,
  pendingReceiptSubmission,
  persistPendingReceiptSubmission,
  probePendingReceiptSubmission,
  reconcilePendingReceiptSubmission,
  settlePendingReceiptSubmission,
  loadBoundWallet,
  markDeliveryReady,
  normalizeAssignedDudeIds,
  projectPendingDeliveryPackStatus,
  recordDeliveryPackStatusProjectionTransientFailure,
  pendingReceiptItems,
  ReceiptBatchRetryExhaustedError,
  recoverReceiptsRequest,
  runtimeForDrop,
  rollbackTransactionBestEffort,
  runDeliveryRecoveryOrderQuery,
  runPendingReadyNotificationQuery,
  scheduleDeliveryPackStatusProjection,
  secureRandomInt,
  sendReceiptBatch,
  shouldShrinkReceiptBatch,
  storedDeliveryItemIds,
};

export const deliveryReceiptRuntime = {
  assignDudesForBox,
  beginTransaction: (context: CommerceContext) => beginTransaction(context),
  commitWrites: (
    context: CommerceContext,
    writes: readonly CommerceWrite[],
    transaction?: CommerceUnitOfWork,
  ) => commitWrites(context, writes, transaction),
  countNormalIrlPackStatus,
  createWrite,
  commerceInteger,
  commerceString,
  commerceTimestamp,
  commerceValue,
  pause,
  readDocument: (
    context: CommerceContext,
    path: string,
    transaction?: CommerceUnitOfWork,
  ) => readDocument(context, path, transaction),
  rollbackTransactionBestEffort: (
    context: CommerceContext,
    transaction: CommerceUnitOfWork,
  ) => rollbackTransactionBestEffort(context, transaction),
  runtimeForDrop,
  secureRandomInt,
  updateWrite,
};
