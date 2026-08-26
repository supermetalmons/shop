import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type FetchFn,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  API_DROPS,
  getApiDrop,
  type ApiDropConfig,
} from './dropConfig.js';
import {
  IRL_CLAIM_CODE_DIGITS,
  IRL_CLAIM_CODE_NAMESPACE,
  normalizeIrlClaimCode,
} from './claimCodes.js';
import {
  dropBoxAssignmentPath,
  dropDeliveryOrderPath,
  dropDudeAssignmentPath,
  dropDudePoolPath,
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
  DudeAssignmentPoolExhaustedError,
  pickDudeIdsForAssignment,
} from '../../../../shared/assignDudesPicker.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import type {
  DeliveryRecoveryOutcome,
  IssueReceiptsResult,
  RecoverDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult,
  WalletDeliveryRecoveryState,
} from '../../../../shared/contracts.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  isAdminIrlRedeemDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../../../../shared/fulfillmentSources.js';
import { sanitizeDudeAssignmentPool } from '../../../../shared/dudeAssignmentPool.js';
import {
  countDeliveryOrderBoxItems,
  countDeliveryOrderDudeItems,
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
  type PackStatusEvent,
} from '../../../../shared/packStatus.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  isBase58Bytes,
  isNonZeroBase58Bytes,
} from '../../../../shared/solanaRpcProxy.js';
import { RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import {
  cancelResponseBody,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
  type CommerceUnitOfWork,
  type CommerceUpdateValue,
} from './commerceRepository.js';
import { resolveD1WalletSession } from './walletSessionD1.js';
import {
  BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
  READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
  READY_TO_SHIP_NOTIFICATION_FAILED,
  READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS,
  READY_TO_SHIP_NOTIFICATION_PENDING,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_QUEUED,
  READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
  createReadyToShipNotificationJobs,
  createReadyToShipNotificationOutbox,
  inspectPendingReadyToShipNotifications,
  type PendingReadyToShipNotification,
} from './readyToShipNotifications.js';
import { applyPackStatusProjection } from './packStatusProjection.js';
import {
  compareAndSetReadyNotificationCursor,
  loadReadyNotificationControl,
} from './d1ReadyNotificationControl.js';

export const DELIVERY_RECEIPTS_ISSUE_PATH = '/delivery/receipts/issue';
export const DELIVERY_RECEIPTS_RECOVER_PATH = '/delivery/receipts/recover';

const REQUEST_MAX_BYTES = 4096;
const PROVIDER_MAX_BYTES = 2 * 1024 * 1024;
const HANDLER_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PACK_STATUS_TIMEOUT_MS = 10_000;
const READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE = 8;
const READY_NOTIFICATION_RECONCILIATION_PUBLISH_LIMIT = 4;
const READY_NOTIFICATION_FAILED_AT_FIELD = 'readyToShipNotificationFailedAt';
const READY_NOTIFICATION_LAST_ERROR_CODE_FIELD = 'readyToShipNotificationLastErrorCode';
const PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE = 4;
const PACK_STATUS_PROJECTION_RECONCILIATION_CONCURRENCY = 2;
const PACK_STATUS_PROJECTION_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;
const PACK_STATUS_PROJECTION_COMPLETED = 'completed';
const PACK_STATUS_PROJECTION_FAILED = 'failed';
const PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD = 'packStatusProjectionFailureCount';
const PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD = 'packStatusProjectionCompletedAt';
const PACK_STATUS_PROJECTION_FAILED_AT_FIELD = 'packStatusProjectionFailedAt';
const PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD = 'packStatusProjectionLastErrorCode';
const RPC_TIMEOUT_MS = 8_000;
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
const TX_MAX_SEND_ATTEMPTS = 3;
const DELIVERY_RECOVERY_LEASE_MS = 90_000;
const MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL = 2;
const MAX_PREPARED_DELIVERY_RECOVERY_CHECKS = DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length;
const COMMERCE_TRANSACTION_ATTEMPTS = 6;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const MAX_U32 = 0xffff_ffff;
const CANONICAL_DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MPL_CORE_COLLECTION_V1_DISCRIMINATOR = 5;
const MPL_CORE_COLLECTION_V1_MIN_BYTES = 49;
const ACCOUNT_DELIVERY_RECORD = Buffer.from('2b0f869afad50393', 'hex');
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
const IX_CLOSE_DELIVERY = Buffer.from('ae641ab98ea5f208', 'hex');
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

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

type DeliveryReceiptErrorCode =
  | 'invalid-argument'
  | 'unauthenticated'
  | 'permission-denied'
  | 'not-found'
  | 'aborted'
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'deadline-exceeded'
  | 'unavailable'
  | 'internal';

class DeliveryReceiptError extends Error {
  constructor(
    readonly code: DeliveryReceiptErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryReceiptError';
  }
}

class ReceiptBatchRetryExhaustedError extends DeliveryReceiptError {
  constructor(lastError: unknown) {
    super('unavailable', 'Unable to issue receipts. Retry later.', {
      lastError: transactionErrorMessage(lastError),
    });
    this.name = 'ReceiptBatchRetryExhaustedError';
  }
}

class ReadyToShipNotificationEnqueueError extends DeliveryReceiptError {
  constructor(message = 'Delivery completed, but notification emails could not be queued. Retry to finish notification delivery.') {
    super(
      'unavailable',
      message,
    );
    this.name = 'ReadyToShipNotificationEnqueueError';
  }
}

class ReadyToShipNotificationFinalizationError extends ReadyToShipNotificationEnqueueError {
  constructor() {
    super('Delivery completed and notifications were queued, but their recovery state could not be saved. Retry later.');
    this.name = 'ReadyToShipNotificationFinalizationError';
  }
}

class ReadyToShipNotificationControlError extends ReadyToShipNotificationEnqueueError {
  constructor() {
    super('Delivery completed, but notification publication is paused or unavailable. Retry later.');
    this.name = 'ReadyToShipNotificationControlError';
  }
}

class DeliveryPackStatusProjectionInvalidError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeliveryPackStatusProjectionInvalidError';
  }
}

type DeliveryRuntime = {
  config: ApiDropConfig;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  itemsPerBox: number;
  maxSupply: number;
  maxDudeId: number;
};

type DecodedOnchainConfig = {
  admin: PublicKey;
  coreCollection: PublicKey;
  decoded: DecodedBoxMinterConfigData;
};

type CommerceContext = {
  commerceDb: D1Database;
  repository?: D1CommerceRepository;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  dataDb?: D1Database;
  [key: string]: unknown;
};

type ProviderContext = {
  apiKey: string;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
};

type CommerceDocument = {
  id: string;
  path: string;
  fields: Record<string, unknown>;
  updateTime: string;
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

type DeliveryReceiptWaitUntil = (promise: Promise<unknown>) => void;

type DeliveryReceiptDependencies = {
  issue: (
    body: IssueRequest,
    identity: RequestIdentity,
    env: DeliveryReceiptsEnv,
    commerce: CommerceContext,
    provider: ProviderContext,
    waitUntil: DeliveryReceiptWaitUntil,
  ) => Promise<ReceiptIssueResult>;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  recover: (
    body: RecoverRequest,
    identity: RequestIdentity,
    env: DeliveryReceiptsEnv,
    commerce: CommerceContext,
    provider: ProviderContext,
    waitUntil: DeliveryReceiptWaitUntil,
  ) => Promise<RecoverDeliveryOrdersResult>;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

function statusForCode(code: DeliveryReceiptErrorCode): number {
  if (code === 'invalid-argument') return 400;
  if (code === 'unauthenticated') return 401;
  if (code === 'permission-denied') return 403;
  if (code === 'not-found') return 404;
  if (code === 'aborted' || code === 'failed-precondition') return 409;
  if (code === 'resource-exhausted') return 429;
  if (code === 'deadline-exceeded') return 504;
  if (code === 'unavailable') return 503;
  return 500;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Timing-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorResponse(error: DeliveryReceiptError): Response {
  return jsonResponse({
    error: {
      code: error.code,
      message: error.message,
    },
  }, statusForCode(error.code));
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof DeliveryReceiptError) {
    return {
      kind: error.name,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: typeof error, message: String(error) };
}

async function readRequestBody(
  request: Request,
  signal: AbortSignal,
  kind: 'issue' | 'recover',
): Promise<IssueRequest | RecoverRequest> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new DeliveryReceiptError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new DeliveryReceiptError('invalid-argument', 'Delivery receipt request is too large.');
  }
  if (!request.body) throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery receipt request.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_MAX_BYTES) {
        throw new DeliveryReceiptError('invalid-argument', 'Delivery receipt request is too large.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const value: unknown = JSON.parse(chunks.join(''));
    const parsed = kind === 'issue' ? issueSchema.safeParse(value) : recoverSchema.safeParse(value);
    if (!parsed.success) throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery receipt request.');
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof DeliveryReceiptError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery receipt request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

function decodeCosigner(secret: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret.trim());
  } catch {
    throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
  }
  if (decoded.length !== 64) {
    throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
  }
  try {
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
  }
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

function commerceTimestamp(value: number): CommerceUpdateValue {
  const seconds = Math.floor(value / 1000);
  return commerceFieldValue.timestamp(seconds, (value - seconds * 1000) * 1_000_000);
}

type CommerceTransform = { fieldPath: string; value: CommerceUpdateValue };
type CommerceWrite = {
  operation: 'create' | 'update';
  path: string;
  values: CommerceDocumentWriteData;
  expectedUpdateTime?: string;
};

function keyForPath(path: string): CommerceDocumentKey {
  const claim = /^claimCodes\/([^/]+)$/.exec(path);
  if (claim) return commerceKeys.claimCode(claim[1]);
  const meta = /^drops\/([^/]+)\/meta\/dudePool$/.exec(path);
  if (meta) return commerceKeys.dudePool(meta[1]);
  const match = /^drops\/([^/]+)\/(deliveryOrders|boxAssignments|dudeAssignments|offchainOrders|adminIrlRedeemRequests|adminIrlRedeemPackMarkers|adminIrlRedeemReceiptMarkers)\/([^/]+)$/.exec(path);
  if (!match) throw new DeliveryReceiptError('internal', 'Invalid commerce document path.');
  const [, dropId, collection, id] = match;
  if (collection === 'deliveryOrders') return commerceKeys.deliveryOrder(dropId, id);
  if (collection === 'boxAssignments') return commerceKeys.boxAssignment(dropId, id);
  if (collection === 'dudeAssignments') return commerceKeys.dudeAssignment(dropId, id);
  if (collection === 'offchainOrders') return commerceKeys.offchainOrder(dropId, id);
  if (collection === 'adminIrlRedeemRequests') return commerceKeys.adminIrlRedeemRequest(dropId, id);
  if (collection === 'adminIrlRedeemPackMarkers') return commerceKeys.adminIrlRedeemPackMarker(dropId, id);
  return commerceKeys.adminIrlRedeemReceiptMarker(dropId, id);
}

function commerceDocument(record: CommerceDocumentRecord | null): CommerceDocument | null {
  return record ? {
    id: record.key.documentId,
    path: record.key.path,
    fields: record.data,
    updateTime: record.updateTime,
  } : null;
}

function repository(context: CommerceContext): D1CommerceRepository {
  return context.repository || new D1CommerceRepository(context.commerceDb);
}

async function readDocument(
  context: CommerceContext,
  path: string,
  transaction?: CommerceUnitOfWork,
): Promise<CommerceDocument | null> {
  const record = transaction
    ? await transaction.get(keyForPath(path))
    : await repository(context).get(keyForPath(path));
  return commerceDocument(record);
}

function beginTransaction(context: CommerceContext): Promise<CommerceUnitOfWork> {
  return repository(context).begin(context.nowMs);
}

async function rollbackTransactionBestEffort(
  _context: CommerceContext,
  transaction: CommerceUnitOfWork,
): Promise<void> {
  transaction.rollback();
}

async function applyWrite(unit: CommerceUnitOfWork, write: CommerceWrite): Promise<void> {
  const key = keyForPath(write.path);
  if (write.expectedUpdateTime) {
    const current = await unit.get(key);
    if (!current || current.updateTime !== write.expectedUpdateTime) throw new CommerceWriteConflict();
  }
  if (write.operation === 'create') await unit.create(key, write.values);
  else await unit.update(key, write.values);
}

async function commitWrites(
  context: CommerceContext,
  writes: readonly CommerceWrite[],
  transaction?: CommerceUnitOfWork,
): Promise<void> {
  const unit = transaction || await repository(context).begin(context.nowMs);
  try {
    for (const write of writes) await applyWrite(unit, write);
    await unit.commit();
  } catch (error) {
    unit.rollback();
    throw error;
  }
}

function updateWrite(args: {
  path: string;
  fields?: Record<string, unknown>;
  fieldPaths: readonly string[];
  transforms?: readonly CommerceTransform[];
  mustExist?: boolean;
  expectedUpdateTime?: string;
}): CommerceWrite {
  const fields = args.fields || {};
  return {
    operation: 'update',
    path: args.path,
    values: {
      ...Object.fromEntries(args.fieldPaths.map((field) => [
        field,
        Object.hasOwn(fields, field) ? fields[field] as CommerceUpdateValue : commerceFieldValue.delete(),
      ])),
      ...Object.fromEntries((args.transforms || []).map((transform) => [transform.fieldPath, transform.value])),
    },
    ...(args.expectedUpdateTime ? { expectedUpdateTime: args.expectedUpdateTime } : {}),
  };
}

function createWrite(args: {
  path: string;
  fields: Record<string, unknown>;
  transforms?: readonly CommerceTransform[];
}): CommerceWrite {
  return {
    operation: 'create',
    path: args.path,
    values: {
      ...args.fields as CommerceDocumentWriteData,
      ...Object.fromEntries((args.transforms || []).map((transform) => [transform.fieldPath, transform.value])),
    },
  };
}

async function loadWalletSession(
  context: CommerceContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new DeliveryReceiptError('unavailable', 'Receipt data is temporarily unavailable.');
    const resolution = await resolveD1WalletSession(db, uid, context.signal);
    if ('reason' in resolution) {
      throw new DeliveryReceiptError('unauthenticated', 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError || context.signal.aborted) throw error;
    throw new DeliveryReceiptError('unavailable', 'Receipt data is temporarily unavailable.');
  }
}

function mapProviderError(error: unknown, message: string): DeliveryReceiptError {
  if (error instanceof DeliveryReceiptError) return error;
  if (error instanceof ProfileReadError) {
    return new DeliveryReceiptError(
      error.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'unavailable',
      message,
    );
  }
  return new DeliveryReceiptError('unavailable', message);
}

async function runDeliveryOrderQuery(
  context: CommerceContext,
  ownerWallet: string,
  status: 'prepared' | 'processing',
): Promise<DeliveryOrderDocument[]> {
  const value = await repository(context).query({
    kind: 'delivery_order',
    filters: [
      { field: 'owner', op: 'equal', value: ownerWallet },
      { field: 'status', op: 'equal', value: status },
    ],
  });
  return decodeDeliveryOrderQuery(value, true);
}

async function runPendingReadyNotificationQuery(
  context: CommerceContext,
  ownerWallet: string,
): Promise<DeliveryOrderDocument[]> {
  const value = await repository(context).query({
    kind: 'delivery_order',
    filters: [
      { field: 'owner', op: 'equal', value: ownerWallet },
      { field: 'status', op: 'equal', value: 'ready_to_ship' },
    ],
  });
  return decodeDeliveryOrderQuery(value, true)
    .filter((document) => (
      document.fields[BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD] === READY_TO_SHIP_NOTIFICATION_PENDING ||
      document.fields[SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD] === READY_TO_SHIP_NOTIFICATION_PENDING
    ))
    .slice(0, MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL);
}

async function runPendingReadyNotificationReconciliationQuery(
  context: CommerceContext,
  limit: number,
  startAfterCursorPath?: string,
): Promise<DeliveryOrderDocument[]> {
  const value = await repository(context).query({
    kind: 'delivery_order',
    filters: [{ field: 'status', op: 'equal', value: 'ready_to_ship' }],
    orderBy: [{ field: 'documentPath', direction: 'asc' }],
    ...(startAfterCursorPath ? { startAfter: [startAfterCursorPath] } : {}),
  });
  return decodeDeliveryOrderQuery(value, false)
    .filter((document) => (
      document.fields[BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD] === READY_TO_SHIP_NOTIFICATION_PENDING ||
      document.fields[SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD] === READY_TO_SHIP_NOTIFICATION_PENDING
    ))
    .slice(0, limit);
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

async function runDeliveryRecoveryStateQuery(
  context: CommerceContext,
  ownerWallet: string,
): Promise<DeliveryOrderDocument[]> {
  const value = await repository(context).query({
    kind: 'delivery_order',
    filters: [
      { field: 'owner', op: 'equal', value: ownerWallet },
      { field: 'status', op: 'in', value: ['processing', 'prepared'] },
    ],
  });
  return decodeDeliveryOrderQuery(value, false);
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
  return priority || left.path.localeCompare(right.path);
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

async function acquireDeliveryRecoveryLease(
  context: CommerceContext,
  path: string,
  ownerWallet: string,
  nowMs: number,
  force: boolean,
): Promise<{ acquired: true } | { acquired: false; result: RecoverDeliveryOrdersItemResult }> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: CommerceUnitOfWork | undefined;
    try {
      transaction = await beginTransaction(context);
      const document = await readDocument(context, path, transaction);
      const fallback = path.split('/');
      const fallbackDropId = fallback.length === 4 ? fallback[1] : '';
      const fallbackDeliveryId = Number(fallback.at(-1)) || 0;
      if (!document) {
        await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return {
          acquired: false,
          result: {
            dropId: fallbackDropId,
            deliveryId: fallbackDeliveryId,
            statusBefore: 'missing',
            outcome: 'not_found',
            verification: 'delivery_pda',
            message: 'delivery order not found',
          },
        };
      }
      const base = orderResultBase(document);
      if (!base) {
        await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return {
          acquired: false,
          result: {
            dropId: '',
            deliveryId: Number(document.id) || 0,
            statusBefore: typeof document.fields.status === 'string' ? document.fields.status : 'unknown',
            outcome: 'failed',
            verification: 'delivery_pda',
            message: 'delivery order is missing recovery identifiers',
          },
        };
      }
      if (document.fields.owner && document.fields.owner !== ownerWallet) {
        await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return {
          acquired: false,
          result: {
            ...base,
            outcome: 'failed',
            verification: 'delivery_pda',
            message: 'order belongs to a different wallet',
            errorCode: 'permission-denied',
          },
        };
      }
      const eligibility = deliveryRecoveryEligibility(document.fields, nowMs, force);
      if (!eligibility.eligible) {
        await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return {
          acquired: false,
          result: {
            ...base,
            outcome: eligibility.outcome || 'not_eligible',
            verification: 'delivery_pda',
            ...(eligibility.message ? { message: eligibility.message } : {}),
          },
        };
      }
      const recovery = isRecord(document.fields.receiptRecovery) ? document.fields.receiptRecovery : {};
      const leaseExpiresAt = toMillisMaybe(recovery.leaseExpiresAt) ?? 0;
      if (leaseExpiresAt > nowMs) {
        await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return {
          acquired: false,
          result: {
            ...base,
            outcome: 'lease_active',
            verification: 'delivery_pda',
            message: 'another client is already retrying this order',
          },
        };
      }
      const rawAttemptCount = Number(recovery.attemptCount || 0);
      const attemptCount = Number.isFinite(rawAttemptCount) && rawAttemptCount > 0
        ? Math.floor(rawAttemptCount) + 1
        : 1;
      await commitWrites(context, [updateWrite({
        path,
        fields: {
          'receiptRecovery.leaseExpiresAt': commerceTimestamp(nowMs + DELIVERY_RECOVERY_LEASE_MS),
          'receiptRecovery.lastAttemptAt': commerceTimestamp(nowMs),
          'receiptRecovery.attemptCount': attemptCount,
        },
        fieldPaths: [
          'receiptRecovery.leaseExpiresAt',
          'receiptRecovery.lastAttemptAt',
          'receiptRecovery.attemptCount',
        ],
        mustExist: true,
      })], transaction);
      transaction = undefined;
      return { acquired: true };
    } catch (error) {
      if (transaction) await rollbackTransactionBestEffort(context, transaction);
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw mapProviderError(error, 'Delivery recovery data is temporarily unavailable.');
    }
  }
  throw new DeliveryReceiptError('unavailable', 'Delivery recovery data is temporarily unavailable.');
}

async function finalizeDeliveryRecoveryAttempt(
  context: CommerceContext,
  path: string,
  result: { errorCode?: string; message?: string },
): Promise<void> {
  const fieldPaths = [
    'receiptRecovery.leaseExpiresAt',
    'receiptRecovery.lastErrorCode',
    'receiptRecovery.lastErrorMessage',
  ];
  await commitWrites(context, [updateWrite({
    path,
    fields: {
      ...(result.errorCode ? { 'receiptRecovery.lastErrorCode': result.errorCode } : {}),
      ...(result.message ? { 'receiptRecovery.lastErrorMessage': result.message } : {}),
    },
    fieldPaths,
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
  const fields: Record<string, unknown> = {
    'receiptRecovery.preparedProbeCount': nextProbeCount,
    'receiptRecovery.lastPreparedProbeAt': commerceTimestamp(nowMs),
    ...(nextDelayMs === null
      ? {
          status: 'prepared_abandoned',
          preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
        }
      : {
          'receiptRecovery.nextPreparedProbeAt': commerceTimestamp(nowMs + nextDelayMs),
        }),
  };
  const fieldPaths = [
    'receiptRecovery.preparedProbeCount',
    'receiptRecovery.lastPreparedProbeAt',
    'receiptRecovery.nextPreparedProbeAt',
    ...(nextDelayMs === null ? ['status', 'preparedRecoveryAbandonedAt'] : []),
  ];
  await commitWrites(context, [updateWrite({
    path: document.path,
    fields,
    fieldPaths,
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
    fields: {
      status: 'prepared_abandoned',
      preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
      'receiptRecovery.preparedProbeCount': probeCount,
      'receiptRecovery.lastPreparedProbeAt': commerceTimestamp(nowMs),
    },
    fieldPaths: [
      'status',
      'preparedRecoveryAbandonedAt',
      'receiptRecovery.preparedProbeCount',
      'receiptRecovery.lastPreparedProbeAt',
      'receiptRecovery.nextPreparedProbeAt',
    ],
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
    fields: {
      'receiptRecovery.nextPreparedProbeAt': commerceTimestamp(nextCheckAt),
    },
    fieldPaths: ['receiptRecovery.nextPreparedProbeAt'],
    expectedUpdateTime: document.updateTime,
  })]);
}

async function fetchDeliveryRecoveryState(
  context: CommerceContext,
  ownerWallet: string,
  nowMs: number,
): Promise<WalletDeliveryRecoveryState> {
  const documents = await runDeliveryRecoveryStateQuery(context, ownerWallet);
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

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

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
  const dudeIds = Array.isArray(value) ? value.map((entry) => Math.floor(Number(entry))) : [];
  if (
    dudeIds.length !== runtime.itemsPerBox ||
    dudeIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > runtime.maxDudeId) ||
    new Set(dudeIds).size !== dudeIds.length
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored figure assignment is invalid.', { boxAssetId });
  }
  return dudeIds;
}

async function assignDudesForBox(
  context: CommerceContext,
  runtime: DeliveryRuntime,
  boxAssetId: string,
  randomInt: (maxExclusive: number) => number,
): Promise<number[]> {
  const assignmentPath = dropBoxAssignmentPath(runtime.dropId, boxAssetId);
  const poolPath = dropDudePoolPath(runtime.dropId);
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: CommerceUnitOfWork | undefined;
    try {
      transaction = await beginTransaction(context);
      const existing = await readDocument(context, assignmentPath, transaction);
      if (existing) {
        await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return normalizeAssignedDudeIds(existing.fields.dudeIds, runtime, boxAssetId);
      }
      const poolDocument = await readDocument(context, poolPath, transaction);
      const pool = sanitizeDudeAssignmentPool(poolDocument?.fields.available, runtime.maxDudeId).pool;
      if (pool.length < runtime.itemsPerBox) {
        throw new DeliveryReceiptError('resource-exhausted', 'No figures remaining to assign.', {
          boxAssetId,
          poolLen: pool.length,
          required: runtime.itemsPerBox,
        });
      }
      let picked;
      try {
        picked = await pickDudeIdsForAssignment({
          dropFamily: runtime.config.dropFamily,
          itemsPerBox: runtime.itemsPerBox,
          maxDudeId: runtime.maxDudeId,
          pool,
          randomInt,
          isAssigned: async (dudeId) => Boolean(await readDocument(
            context,
            dropDudeAssignmentPath(runtime.dropId, dudeId),
            transaction,
          )),
        });
      } catch (error) {
        if (error instanceof DudeAssignmentPoolExhaustedError) {
          throw new DeliveryReceiptError('resource-exhausted', error.message, {
            boxAssetId,
            bucket: error.bucket,
            chosen: error.chosen,
            candidatesChecked: error.candidatesChecked,
            staleAssigned: error.staleAssigned,
            poolLen: error.poolLen,
          });
        }
        throw error;
      }
      const writes = picked.chosen.map((dudeId) => createWrite({
        path: dropDudeAssignmentPath(runtime.dropId, dudeId),
        fields: { dudeId, boxAssetId },
        transforms: [{ fieldPath: 'assignedAt', value: commerceFieldValue.serverTimestamp() }],
      }));
      writes.push(updateWrite({
        path: poolPath,
        fields: { available: pool },
        fieldPaths: ['available'],
        transforms: [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }],
      }));
      writes.push(createWrite({
        path: assignmentPath,
        fields: { dudeIds: picked.chosen },
        transforms: [{ fieldPath: 'createdAt', value: commerceFieldValue.serverTimestamp() }],
      }));
      await commitWrites(context, writes, transaction);
      transaction = undefined;
      return picked.chosen;
    } catch (error) {
      if (transaction) await rollbackTransactionBestEffort(context, transaction);
      if (error instanceof DeliveryReceiptError) throw error;
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(2_500, 150 * 2 ** Math.min(attempt, 4)), context.signal);
        continue;
      }
      throw mapProviderError(error, 'Figure assignment is temporarily unavailable.');
    }
  }
  throw new DeliveryReceiptError('unavailable', 'Figure assignment is temporarily unavailable.');
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

function claimCodeFields(expected: ClaimCodeExpected, ownerWallet: string): Record<string, unknown> {
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

function assignmentClaimFields(expected: ClaimCodeExpected, ownerWallet: string): Record<string, unknown> {
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
  for (let transactionAttempt = 0; transactionAttempt < COMMERCE_TRANSACTION_ATTEMPTS; transactionAttempt += 1) {
    let transaction: CommerceUnitOfWork | undefined;
    try {
      transaction = await beginTransaction(context);
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
            fields: claimCodeFields(expected, args.ownerWallet),
            transforms: [{ fieldPath: 'createdAt', value: commerceFieldValue.serverTimestamp() }],
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
            fields: claimCodeFields(expected, args.ownerWallet),
            fieldPaths: Object.keys(claimCodeFields(expected, args.ownerWallet)),
            transforms: [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }],
            mustExist: true,
          }));
        }
        const assignmentClaim = isRecord(assignment.fields.irlClaim) ? assignment.fields.irlClaim : {};
        if (writes.length || !assignmentClaimCompatible(assignmentClaim, expected, args.ownerWallet)) {
          const assignmentFields = assignmentClaimFields(expected, args.ownerWallet);
          writes.push(updateWrite({
            path: assignmentPath,
            fields: assignmentFields,
            fieldPaths: Object.keys(assignmentFields),
            transforms: [{ fieldPath: 'irlClaim.createdAt', value: commerceFieldValue.serverTimestamp() }],
            mustExist: true,
          }));
        }
        if (writes.length) await commitWrites(context, writes, transaction);
        else await rollbackTransactionBestEffort(context, transaction);
        transaction = undefined;
        return existingCode;
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
      await commitWrites(context, [
        createWrite({
          path: `claimCodes/${expected.code}`,
          fields: claimCodeFields(expected, args.ownerWallet),
          transforms: [{ fieldPath: 'createdAt', value: commerceFieldValue.serverTimestamp() }],
        }),
        updateWrite({
          path: assignmentPath,
          fields: assignmentFields,
          fieldPaths: Object.keys(assignmentFields),
          transforms: [{ fieldPath: 'irlClaim.createdAt', value: commerceFieldValue.serverTimestamp() }],
          mustExist: true,
        }),
      ], transaction);
      transaction = undefined;
      return expected.code;
    } catch (error) {
      if (transaction) await rollbackTransactionBestEffort(context, transaction);
      if (error instanceof DeliveryReceiptError) throw error;
      if (error instanceof CommerceWriteConflict && transactionAttempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(2_500, 150 * 2 ** Math.min(transactionAttempt, 4)), context.signal);
        continue;
      }
      throw mapProviderError(error, 'IRL claim code is temporarily unavailable.');
    }
  }
  throw new DeliveryReceiptError('unavailable', 'IRL claim code is temporarily unavailable.');
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
): { fields: Record<string, unknown>; fieldPaths: string[] } {
  if (!shouldProjectNormalIrlPackStatus(runtime, order)) return { fields: {}, fieldPaths: [] };
  if (countDeliveryOrderBoxItems(order.items) < 1 && countDeliveryOrderDudeItems(order.items) < 1) {
    return { fields: {}, fieldPaths: [] };
  }
  const nextAttemptAtMs = Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : Date.now();
  return {
    fields: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_PENDING,
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: nextAttemptAtMs,
      [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: 0,
    },
    fieldPaths: [
      PACK_STATUS_PROJECTION_STATE_FIELD,
      PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
      PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD,
      PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD,
      PACK_STATUS_PROJECTION_FAILED_AT_FIELD,
      PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD,
    ],
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
    clearFields?: readonly string[];
    fields?: Record<string, unknown>;
    requiredState: string;
    timestampField?: string;
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const document = await readDocument(context, documentPath);
    if (!document || document.fields[PACK_STATUS_PROJECTION_STATE_FIELD] !== options.requiredState) return false;
    try {
      await commitWrites(context, [updateWrite({
        path: documentPath,
        fields: options.fields,
        fieldPaths: [
          ...Object.keys(options.fields || {}),
          ...(options.clearFields || []),
        ],
        transforms: options.timestampField
          ? [{ fieldPath: options.timestampField, value: commerceFieldValue.serverTimestamp() }]
          : undefined,
        expectedUpdateTime: document.updateTime,
      })]);
      return true;
    } catch (error) {
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function markDeliveryPackStatusProjectionCompleted(
  context: CommerceContext,
  documentPath: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    clearFields: [
      PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
      PACK_STATUS_PROJECTION_FAILED_AT_FIELD,
      PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD,
    ],
    fields: { [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_COMPLETED },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
    timestampField: PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD,
  });
}

async function markDeliveryPackStatusProjectionFailed(
  context: CommerceContext,
  documentPath: string,
  errorCode: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    clearFields: [
      PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
      PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD,
    ],
    fields: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_FAILED,
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: errorCode,
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
    timestampField: PACK_STATUS_PROJECTION_FAILED_AT_FIELD,
  });
}

async function clearDeliveryPackStatusProjection(
  context: CommerceContext,
  documentPath: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    clearFields: [
      PACK_STATUS_PROJECTION_STATE_FIELD,
      PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
      PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD,
      PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD,
      PACK_STATUS_PROJECTION_FAILED_AT_FIELD,
      PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD,
    ],
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function recordDeliveryPackStatusProjectionTransientFailure(args: {
  attemptStartedAtMs: number;
  context: CommerceContext;
  documentPath: string;
  errorCode: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
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
    try {
      await commitWrites(args.context, [updateWrite({
        path: args.documentPath,
        fields: {
          [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_PENDING,
          [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: args.attemptStartedAtMs + backoffMs,
          [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1),
          [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: args.errorCode,
        },
        fieldPaths: [
          PACK_STATUS_PROJECTION_STATE_FIELD,
          PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
          PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD,
          PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD,
          PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD,
          PACK_STATUS_PROJECTION_FAILED_AT_FIELD,
        ],
        expectedUpdateTime: document.updateTime,
      })]);
      return true;
    } catch (error) {
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), args.context.signal);
        continue;
      }
      throw error;
    }
  }
  return false;
}

type DeliveryPackStatusProjectionOutcome = 'completed' | 'failed' | 'not-due' | 'not-needed' | 'pending';

async function projectPendingDeliveryPackStatus(args: {
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
    const order = await readDocument(context, documentPath);
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
      await clearDeliveryPackStatusProjection(context, order.path);
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
    await countNormalIrlPackStatus(context, runtime, args.deliveryId, order.fields);
    await markDeliveryPackStatusProjectionCompleted(context, order.path);
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
      await markDeliveryPackStatusProjectionFailed(persistenceContext, documentPath, errorCode);
      log({
        event: 'delivery_pack_status_projection_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        errorCode,
        error: summarizeError(error),
      });
      return 'failed';
    }
    await recordDeliveryPackStatusProjectionTransientFailure({
      attemptStartedAtMs,
      context: persistenceContext,
      documentPath,
      errorCode,
    });
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
  const value = await repository(context).query({
    kind: 'delivery_order',
    dropId,
    filters: [{ field: PACK_STATUS_PROJECTION_STATE_FIELD, op: 'equal', value: PACK_STATUS_PROJECTION_PENDING }],
  });
  return decodeDeliveryOrderQuery(value, false)
    .filter((document) => Number(document.fields[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]) <= dueAtMs)
    .sort((left, right) => (
      Number(left.fields[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]) -
        Number(right.fields[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]) ||
      left.path.localeCompare(right.path)
    ))
    .slice(0, limit);
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

export function scheduleDeliveryPackStatusProjection(args: {
  context: CommerceContext;
  deliveryId: number;
  dropId: string;
  waitUntil: DeliveryReceiptWaitUntil;
}): void {
  const task = projectPendingDeliveryPackStatus(args).catch((error) => {
    console.error({
      event: 'delivery_pack_status_projection_background_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
  });
  try {
    args.waitUntil(task);
  } catch (error) {
    void task;
    console.error({
      event: 'delivery_pack_status_projection_tracking_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
  }
}

async function readBoundedProviderResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > PROVIDER_MAX_BYTES) {
    await cancelResponseBody(response);
    throw new DeliveryReceiptError('unavailable', 'Receipt provider returned too much data.');
  }
  if (!response.body) throw new DeliveryReceiptError('unavailable', 'Receipt provider returned an invalid response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PROVIDER_MAX_BYTES) {
        throw new DeliveryReceiptError('unavailable', 'Receipt provider returned too much data.');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function heliusOrigin(cluster: SolanaCluster): string {
  return `https://${cluster === 'mainnet-beta' ? 'mainnet' : cluster}.helius-rpc.com/`;
}

function createConnection(context: ProviderContext, runtime: DeliveryRuntime): Connection {
  const boundedFetch: FetchFn = async (input, init) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Receipt provider request timed out', 'TimeoutError')),
      RPC_TIMEOUT_MS,
    );
    try {
      if (context.signal.aborted) onAbort();
      const response = await context.fetch(input, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new DeliveryReceiptError('unavailable', 'Receipt provider is temporarily unavailable.');
      }
      const body = await readBoundedProviderResponse(response, controller.signal);
      return new Response(Uint8Array.from(body).buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (context.signal.aborted || controller.signal.reason?.name === 'TimeoutError') {
        throw new DeliveryReceiptError('deadline-exceeded', 'Receipt provider request timed out.');
      }
      throw mapProviderError(error, 'Receipt provider is temporarily unavailable.');
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
    }
  };
  return new Connection(`${heliusOrigin(runtime.cluster)}?api-key=${encodeURIComponent(context.apiKey)}`, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: boundedFetch,
  });
}

function u16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32LE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid unsigned 32-bit integer.');
  }
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function deriveDeliveryPda(runtime: DeliveryRuntime, deliveryId: number): [PublicKey, number] {
  const singleton = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED)],
    runtime.boxMinterProgramId,
  )[0];
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!runtime.boxMinterConfigPda.equals(singleton)) seeds.push(runtime.boxMinterConfigPda.toBuffer());
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, runtime.boxMinterProgramId);
}

function deriveTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
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

function decodeOnchainConfig(data: Buffer): DecodedOnchainConfig {
  try {
    const decoded = decodeBoxMinterConfigData(data, { validateDiscriminator: true });
    return {
      admin: new PublicKey(decoded.admin),
      coreCollection: new PublicKey(decoded.coreCollection),
      decoded,
    };
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new DeliveryReceiptError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
}

function paymentRoutingMatches(config: ApiDropConfig, decoded: DecodedBoxMinterConfigData): boolean {
  const routing = decoded.paymentRouting;
  if (!routing) return false;
  if (!config.paymentRouting) return routing.schema === 'legacy';
  if (routing.schema !== 'split-payments-v1') return false;
  if (
    new PublicKey(routing.deliveryPaymentReceiver).toBase58() !== config.paymentRouting.deliveryPaymentReceiver ||
    routing.mintProceeds.length !== config.paymentRouting.mintProceeds.length
  ) return false;
  return config.paymentRouting.mintProceeds.every((expected, index) => {
    const actual = routing.mintProceeds[index];
    return Boolean(actual) &&
      new PublicKey(actual.address).toBase58() === expected.address &&
      actual.percentage === expected.percentage;
  });
}

function assertOnchainConfigMatchesRuntime(runtime: DeliveryRuntime, config: DecodedOnchainConfig): void {
  const decoded = config.decoded;
  if (
    !config.coreCollection.equals(runtime.collectionMint) ||
    decoded.itemsPerBox !== runtime.itemsPerBox ||
    decoded.maxSupply !== runtime.maxSupply ||
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet ||
    !isBoxMinterDiscountMintsPerWallet(decoded.discountMintsPerWallet) ||
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ) ||
    new PublicKey(decoded.treasury).toBase58() !== runtime.config.treasury ||
    !paymentRoutingMatches(runtime.config, decoded)
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Committed drop configuration does not match the on-chain config.');
  }
}

async function fetchOnchainConfig(
  connection: Connection,
  runtime: DeliveryRuntime,
): Promise<DecodedOnchainConfig> {
  const [collection, info] = await connection.getMultipleAccountsInfo(
    [runtime.collectionMint, runtime.boxMinterConfigPda],
    { commitment: 'confirmed' },
  );
  if (
    !collection?.data ||
    !collection.owner.equals(MPL_CORE_PROGRAM_ID) ||
    collection.data.length < MPL_CORE_COLLECTION_V1_MIN_BYTES ||
    collection.data[0] !== MPL_CORE_COLLECTION_V1_DISCRIMINATOR
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Configured collection is not an MPL Core collection.');
  }
  if (!info?.data || info.data.length < 104) {
    throw new DeliveryReceiptError('failed-precondition', 'Box minter config PDA was not found.', {
      dropId: runtime.dropId,
      configPda: runtime.boxMinterConfigPda.toBase58(),
    });
  }
  if (!info.owner.equals(runtime.boxMinterProgramId)) {
    throw new DeliveryReceiptError('failed-precondition', 'Box minter config PDA has an unexpected owner.', {
      dropId: runtime.dropId,
    });
  }
  const config = decodeOnchainConfig(Buffer.from(info.data));
  assertOnchainConfigMatchesRuntime(runtime, config);
  return config;
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

function resolveInstructionAccounts(transaction: VersionedTransactionResponse): PublicKey[] {
  const accountKeys = transaction.transaction.message.getAccountKeys({
    accountKeysFromLookups: transaction.meta?.loadedAddresses,
  });
  return [
    ...accountKeys.staticAccountKeys,
    ...(accountKeys.accountKeysFromLookups?.writable || []),
    ...(accountKeys.accountKeysFromLookups?.readonly || []),
  ];
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
  const keys = resolveInstructionAccounts(transaction);
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

function mplCoreBurnInstruction(args: {
  asset: PublicKey;
  coreCollection: PublicKey;
  signer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([12, 0]),
  });
}

function encodeMintReceiptsArgs(
  runtime: DeliveryRuntime,
  boxIds: readonly number[],
  dudeIds: readonly number[],
): Buffer {
  for (const id of boxIds) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffff_ffff) {
      throw new DeliveryReceiptError('invalid-argument', `Invalid box id: ${id}`);
    }
  }
  for (const id of dudeIds) {
    if (!Number.isSafeInteger(id) || id < 1 || id > runtime.maxDudeId) {
      throw new DeliveryReceiptError('invalid-argument', `Invalid figure id: ${id}`);
    }
  }
  return Buffer.concat([
    IX_MINT_RECEIPTS,
    u32LE(boxIds.length),
    ...boxIds.map(u32LE),
    u32LE(dudeIds.length),
    ...dudeIds.map(u16LE),
  ]);
}

function mintReceiptsInstruction(args: {
  runtime: DeliveryRuntime;
  signer: PublicKey;
  recipient: PublicKey;
  coreCollection: PublicKey;
  boxIds: readonly number[];
  dudeIds: readonly number[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.runtime.boxMinterProgramId,
    keys: [
      { pubkey: args.runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: false },
      { pubkey: args.runtime.receiptsMerkleTree, isSigner: false, isWritable: true },
      { pubkey: deriveTreeConfigPda(args.runtime.receiptsMerkleTree), isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeMintReceiptsArgs(args.runtime, args.boxIds, args.dudeIds),
  });
}

function closeDeliveryInstruction(args: {
  runtime: DeliveryRuntime;
  signer: PublicKey;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.runtime.boxMinterProgramId,
    keys: [
      { pubkey: args.runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.deliveryPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX_CLOSE_DELIVERY,
      u32LE(args.deliveryId),
      Buffer.from([args.deliveryBump & 0xff]),
    ]),
  });
}

function buildTransaction(
  instructions: readonly TransactionInstruction[],
  payer: PublicKey,
  blockhash: string,
  signer: Keypair,
): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message());
  transaction.sign([signer]);
  return transaction;
}

function transactionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function transactionErrorLogs(error: unknown): string[] {
  if (!isRecord(error) || !Array.isArray(error.logs)) return [];
  return error.logs.map(String);
}

function looksLikeComputeLimitError(message: string, logs: readonly string[]): boolean {
  const value = `${message}\n${logs.join('\n')}`.toLowerCase();
  return value.includes('computational budget exceeded') ||
    value.includes('exceeded maximum compute') ||
    value.includes('program failed to complete') ||
    (value.includes('compute units') && value.includes('consumed') && value.includes('failed'));
}

function looksLikeAccountInUseError(message: string, logs: readonly string[]): boolean {
  const value = `${message}\n${logs.join('\n')}`.toLowerCase();
  return value.includes('account in use') || value.includes('already in use');
}

function looksLikeBlockhashError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes('blockhash not found') ||
    value.includes('blockhash expired') ||
    value.includes('transaction expired') ||
    value.includes('block height exceeded') ||
    value.includes('transactionexpiredblockheightexceedederror');
}

function looksLikeRateLimitOrRpcError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes('429') ||
    value.includes('rate limit') ||
    value.includes('too many requests') ||
    value.includes('timed out') ||
    value.includes('timeout') ||
    value.includes('fetch failed') ||
    value.includes('socket hang up') ||
    value.includes('econnreset') ||
    value.includes('etimedout') ||
    value.includes('service unavailable') ||
    value.includes('gateway timeout') ||
    (value.includes('rpc') && value.includes('error'));
}

async function waitForSignature(
  connection: Connection,
  signature: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: unknown; logs: string[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal.aborted) throw signal.reason;
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: Date.now() - startedAt > 6_000,
      });
      const status = statuses.value[0];
      if (status?.err) {
        let logs: string[] = [];
        try {
          const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
          logs = Array.isArray(transaction?.meta?.logMessages)
            ? transaction.meta.logMessages.filter((entry): entry is string => typeof entry === 'string')
            : [];
        } catch {}
        return { ok: false, error: status.err, logs };
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return { ok: true };
      }
    } catch {
      if (signal.aborted) throw signal.reason;
    }
    await pause(TX_CONFIRM_POLL_MS, signal);
  }
  try {
    const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (transaction?.meta && !transaction.meta.err) return { ok: true };
    return {
      ok: false,
      error: transaction?.meta?.err || 'timeout',
      logs: Array.isArray(transaction?.meta?.logMessages)
        ? transaction.meta.logMessages.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    return { ok: false, error: 'timeout', logs: [] };
  }
}

async function sendAndConfirmSignedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  signal: AbortSignal,
  label: string,
): Promise<string> {
  const signature = bs58.encode(transaction.signatures[0]);
  let sendError: unknown;
  try {
    await connection.sendTransaction(transaction, { maxRetries: 2 });
  } catch (error) {
    sendError = error;
  }
  if (sendError) {
    const logs = transactionErrorLogs(sendError);
    if (logs.length) {
      const message = transactionErrorMessage(sendError);
      const code = looksLikeBlockhashError(message) || looksLikeAccountInUseError(message, logs)
        ? 'aborted'
        : looksLikeRateLimitOrRpcError(message) ? 'unavailable' : 'failed-precondition';
      throw new DeliveryReceiptError(code, `${label} transaction preflight failed.`, {
        lastError: message,
        lastLogs: logs.slice(0, 80),
      });
    }
    const maybe = await waitForSignature(connection, signature, signal, TX_SEND_TIMEOUT_MS);
    if (maybe.ok) return signature;
    throw new DeliveryReceiptError('unavailable', `${label} transaction submission status is unknown. Try again.`, {
      maybeSubmitted: true,
      lastError: transactionErrorMessage(sendError),
    });
  }
  const confirmed = await waitForSignature(connection, signature, signal, TX_CONFIRM_TIMEOUT_MS);
  if (confirmed.ok) return signature;
  const message = transactionErrorMessage(confirmed.error);
  throw new DeliveryReceiptError(
    /timeout/i.test(message) ? 'deadline-exceeded' : 'failed-precondition',
    `${label} transaction was not confirmed. Try again.`,
    { lastError: message, lastLogs: confirmed.logs.slice(0, 80) },
  );
}

async function markDeliveryProcessing(
  context: CommerceContext,
  document: DeliveryOrderDocument,
  runtime: DeliveryRuntime,
  signature: string | null,
): Promise<void> {
  const fields: Record<string, unknown> = {
    dropId: runtime.dropId,
    status: 'processing',
    ...(signature ? { deliverySignature: signature } : {}),
  };
  const fieldPaths = [
    'dropId',
    'status',
    ...(signature ? ['deliverySignature'] : []),
    'receiptRecovery.lastPreparedProbeAt',
    'receiptRecovery.preparedProbeCount',
    'receiptRecovery.nextPreparedProbeAt',
    'receiptRecovery.status',
  ];
  await commitWrites(context, [updateWrite({
    path: document.path,
    fields,
    fieldPaths,
    transforms: document.fields.processingAt === undefined
      ? [{ fieldPath: 'processingAt', value: commerceFieldValue.serverTimestamp() }]
      : undefined,
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
  const fields: Record<string, unknown> = {
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
  Object.assign(fields, notificationOutbox.fields);
  Object.assign(readyOrder, notificationOutbox.fields);
  const packStatusOutbox = createDeliveryPackStatusProjectionOutbox(runtime, readyOrder, context.nowMs);
  Object.assign(fields, packStatusOutbox.fields);
  Object.assign(readyOrder, packStatusOutbox.fields);
  const fieldPaths = [
    ...Object.keys(fields),
    ...notificationOutbox.fieldPaths.filter((fieldPath) => !Object.hasOwn(fields, fieldPath)),
    ...packStatusOutbox.fieldPaths.filter((fieldPath) => !Object.hasOwn(fields, fieldPath)),
    'receiptRecovery.leaseExpiresAt',
    'receiptRecovery.lastErrorCode',
    'receiptRecovery.lastErrorMessage',
    'receiptRecovery.lastPreparedProbeAt',
    'receiptRecovery.preparedProbeCount',
    'receiptRecovery.nextPreparedProbeAt',
    'receiptRecovery.status',
  ];
  await commitWrites(context, [updateWrite({
    path: document.path,
    fields,
    fieldPaths,
    transforms: [
      { fieldPath: 'processedAt', value: commerceFieldValue.serverTimestamp() },
      ...(result.irlClaims.length
        ? [{ fieldPath: 'irlClaimsUpdatedAt', value: commerceFieldValue.serverTimestamp() }]
        : []),
    ],
    mustExist: true,
  })]);
  return { ...document, fields: readyOrder };
}

async function markReadyToShipNotificationsQueued(
  context: CommerceContext,
  documentPath: string,
  claimId: string,
  pending: readonly PendingReadyToShipNotification[],
): Promise<string[]> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const document = await readDocument(context, documentPath);
    if (
      !document ||
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== claimId
    ) return [];
    const matching = pending.filter((marker) => (
      document.fields[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      document.fields[marker.jobIdField] === marker.jobId &&
      document.fields[marker.idempotencyKeyField] === marker.idempotencyKey
    ));
    if (!matching.length) return [];
    const matchingStateFields = new Set(matching.map((marker) => marker.stateField));
    const hasRemainingPendingMarker = [
      BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
      SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
    ].some((stateField) => (
      document.fields[stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      !matchingStateFields.has(stateField)
    ));
    const clearedClaimFields = hasRemainingPendingMarker
      ? []
      : [
          READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
          READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
        ];
    try {
      await commitWrites(context, [updateWrite({
        path: documentPath,
        fields: Object.fromEntries(matching.flatMap((marker) => [
          [marker.stateField, READY_TO_SHIP_NOTIFICATION_QUEUED],
          [marker.jobIdField, marker.jobId],
        ])),
        fieldPaths: [
          ...matching.flatMap((marker) => [marker.stateField, marker.jobIdField]),
          ...clearedClaimFields,
        ],
        transforms: matching.map((marker) => ({
          fieldPath: marker.queuedAtField,
          value: commerceFieldValue.serverTimestamp(),
        })),
        expectedUpdateTime: document.updateTime,
      })]);
      return matching.map((marker) => marker.kind);
    } catch (error) {
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    }
  }
  return [];
}

type ReadyToShipNotificationClaim = {
  claimId: string;
  document: DeliveryOrderDocument;
  pending: PendingReadyToShipNotification[];
  previousAttemptCount: number;
};

type ReadyToShipNotificationClaimResult =
  | { outcome: 'busy' | 'manual-review' | 'none' }
  | { outcome: 'claimed'; claim: ReadyToShipNotificationClaim };

function readyToShipNotificationNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

async function claimReadyToShipNotifications(args: {
  context: CommerceContext;
  deliveryId: number;
  documentPath: string;
  dropId: string;
}): Promise<ReadyToShipNotificationClaimResult> {
  const nowMs = Math.max(0, Math.floor(args.context.nowMs));
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const document = await readDocument(args.context, args.documentPath);
    if (!document) return { outcome: 'none' };
    const inspection = inspectPendingReadyToShipNotifications(document.fields, {
      deliveryId: args.deliveryId,
      dropId: args.dropId,
    });
    if (!inspection.pending.length) return { outcome: 'none' };
    const activeClaimId = document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD];
    const claimExpiresAtMs = readyToShipNotificationNonNegativeInteger(
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD],
    );
    if (typeof activeClaimId === 'string' && activeClaimId && claimExpiresAtMs !== null && claimExpiresAtMs > nowMs) {
      return { outcome: 'busy' };
    }
    const retryUntilMs = readyToShipNotificationNonNegativeInteger(
      document.fields[READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD],
    );
    const attemptCount = readyToShipNotificationNonNegativeInteger(
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD],
    );
    if (
      retryUntilMs === null ||
      attemptCount === null ||
      attemptCount >= READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS ||
      (attemptCount > 0 && retryUntilMs <= nowMs)
    ) {
      const stateFields = inspection.pending.map((marker) => marker.stateField);
      try {
        await commitWrites(args.context, [updateWrite({
          path: args.documentPath,
          fields: {
            ...Object.fromEntries(stateFields.map((stateField) => [stateField, READY_TO_SHIP_NOTIFICATION_FAILED])),
            [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: 'manual-review-required',
          },
          fieldPaths: [
            ...stateFields,
            READY_NOTIFICATION_LAST_ERROR_CODE_FIELD,
            READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
            READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
          ],
          transforms: [{ fieldPath: READY_NOTIFICATION_FAILED_AT_FIELD, value: commerceFieldValue.serverTimestamp() }],
          expectedUpdateTime: document.updateTime,
        })]);
        return { outcome: 'manual-review' };
      } catch (error) {
        if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
          await pause(Math.min(400, 25 * 2 ** attempt), args.context.signal);
          continue;
        }
        throw error;
      }
    }
    const claimId = crypto.randomUUID();
    try {
      await commitWrites(args.context, [updateWrite({
        path: args.documentPath,
        fields: {
          [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: claimId,
          [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]:
            nowMs + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
          [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: attemptCount + 1,
          [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: attemptCount === 0
            ? nowMs + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS
            : retryUntilMs,
        },
        fieldPaths: [
          READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
          READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
          READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
          READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
        ],
        expectedUpdateTime: document.updateTime,
      })]);
      return {
        outcome: 'claimed',
        claim: {
          claimId,
          document,
          pending: inspection.pending,
          previousAttemptCount: attemptCount,
        },
      };
    } catch (error) {
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), args.context.signal);
        continue;
      }
      throw error;
    }
  }
  return { outcome: 'busy' };
}

async function releaseReadyToShipNotificationClaim(
  context: CommerceContext,
  documentPath: string,
  claim: ReadyToShipNotificationClaim,
): Promise<boolean> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const document = await readDocument(context, documentPath);
    if (
      !document ||
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== claim.claimId
    ) return false;
    try {
      await commitWrites(context, [updateWrite({
        path: documentPath,
        fields: {
          [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: claim.previousAttemptCount,
        },
        fieldPaths: [
          READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
          READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
          READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
        ],
        expectedUpdateTime: document.updateTime,
      })]);
      return true;
    } catch (error) {
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function markPendingReadyToShipNotificationsFailed(
  context: CommerceContext,
  documentPath: string,
  errorCode: string,
  targetStateFields?: readonly string[],
): Promise<string[]> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const document = await readDocument(context, documentPath);
    if (!document) return [];
    const stateFields = [
      BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
      SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
    ].filter((fieldPath) => (
      document.fields[fieldPath] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      (!targetStateFields || targetStateFields.includes(fieldPath))
    ));
    if (!stateFields.length) return [];
    try {
      await commitWrites(context, [updateWrite({
        path: documentPath,
        fields: {
          ...Object.fromEntries(
            stateFields.map((fieldPath) => [fieldPath, READY_TO_SHIP_NOTIFICATION_FAILED]),
          ),
          [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: errorCode,
        },
        fieldPaths: [...stateFields, READY_NOTIFICATION_LAST_ERROR_CODE_FIELD],
        transforms: [{ fieldPath: READY_NOTIFICATION_FAILED_AT_FIELD, value: commerceFieldValue.serverTimestamp() }],
        expectedUpdateTime: document.updateTime,
      })]);
      return stateFields;
    } catch (error) {
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    }
  }
  return [];
}

async function publishReadyToShipNotifications(args: {
  context: CommerceContext;
  deliveryId: number;
  document: DeliveryOrderDocument;
  dropId: string;
  opsDb: D1Database;
  queue: Env['NOTIFICATION_EMAIL_QUEUE'];
}): Promise<boolean> {
  const expectedIdentity = { deliveryId: args.deliveryId, dropId: args.dropId };
  let initialInspection = inspectPendingReadyToShipNotifications(args.document.fields, expectedIdentity);
  let invalidMarkerFinalizationError: unknown;
  if (initialInspection.invalidStateFields.length) {
    const currentDocument = await readDocument(args.context, args.document.path);
    if (!currentDocument) return false;
    initialInspection = inspectPendingReadyToShipNotifications(currentDocument.fields, expectedIdentity);
  }
  if (initialInspection.invalidStateFields.length) {
    try {
      await markPendingReadyToShipNotificationsFailed(
        cleanupContext(args.context),
        args.document.path,
        'invalid-notification-data',
        initialInspection.invalidStateFields,
      );
    } catch (error) {
      invalidMarkerFinalizationError = error;
      console.error({
        event: 'ready_to_ship_notifications_marker_finalization_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        error: summarizeError(error),
      });
    }
  }
  if (!initialInspection.pending.length) {
    console.log({
      event: 'ready_to_ship_notifications_skipped',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      reason: initialInspection.invalidStateFields.length ? 'no-valid-pending-markers' : 'no-pending-markers',
    });
    if (invalidMarkerFinalizationError) throw new ReadyToShipNotificationFinalizationError();
    return false;
  }

  const claimResult = await claimReadyToShipNotifications({
    context: args.context,
    deliveryId: args.deliveryId,
    documentPath: args.document.path,
    dropId: args.dropId,
  });
  if (claimResult.outcome !== 'claimed') {
    console.log({
      event: 'ready_to_ship_notifications_skipped',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      reason: claimResult.outcome,
    });
    if (invalidMarkerFinalizationError) throw new ReadyToShipNotificationFinalizationError();
    return false;
  }
  const { claim } = claimResult;
  const pending: PendingReadyToShipNotification[] = [];
  const jobs: Awaited<ReturnType<typeof createReadyToShipNotificationJobs>> = [];
  const buildErrors: unknown[] = [];
  for (const marker of claim.pending) {
    try {
      const markerJobs = await createReadyToShipNotificationJobs({
        order: claim.document.fields,
        deliveryId: args.deliveryId,
        dropId: args.dropId,
        pending: [marker],
      });
      if (markerJobs.length !== 1) throw new Error('ready_notification_job_count_invalid');
      pending.push(marker);
      jobs.push(markerJobs[0]);
    } catch (error) {
      buildErrors.push(error);
      console.error({
        event: 'ready_to_ship_notification_build_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        stateField: marker.stateField,
        error: summarizeError(error),
      });
    }
  }
  try {
    args.context.signal.throwIfAborted();
    const latestControl = await loadReadyNotificationControl(args.opsDb, args.context.nowMs);
    args.context.signal.throwIfAborted();
    if (latestControl.paused) throw new ReadyToShipNotificationControlError();
  } catch (error) {
    await releaseReadyToShipNotificationClaim(
      cleanupContext(args.context),
      args.document.path,
      claim,
    ).catch((releaseError) => {
      console.error({
        event: 'ready_to_ship_notifications_claim_release_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        error: summarizeError(releaseError),
      });
    });
    console.error({
      event: 'ready_to_ship_notifications_control_unavailable',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
    args.context.signal.throwIfAborted();
    throw error instanceof ReadyToShipNotificationControlError
      ? error
      : new ReadyToShipNotificationControlError();
  }
  if (!jobs.length) {
    console.log({
      event: 'ready_to_ship_notifications_skipped',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      reason: 'job-build-failed',
    });
    throw new ReadyToShipNotificationEnqueueError(
      'Delivery completed, but notification emails could not be prepared. Retry later.',
    );
  }
  try {
    await args.queue.sendBatch(jobs.map((job) => ({ body: job, contentType: 'json' })));
  } catch (error) {
    console.error({
      event: 'ready_to_ship_notifications_enqueue_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
    throw new ReadyToShipNotificationEnqueueError();
  }
  console.log({
    event: 'ready_to_ship_notifications_queued',
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    jobs: jobs.map((job) => ({ jobId: job.jobId, kind: job.kind })),
  });
  const persistenceContext = cleanupContext(args.context);
  try {
    const finalizedKinds = await markReadyToShipNotificationsQueued(
      persistenceContext,
      args.document.path,
      claim.claimId,
      pending,
    );
    if (finalizedKinds.length !== pending.length) {
      const latest = await readDocument(persistenceContext, args.document.path);
      const remaining = pending.filter((marker) => (
        latest?.fields[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
        latest.fields[marker.jobIdField] === marker.jobId &&
        latest.fields[marker.idempotencyKeyField] === marker.idempotencyKey
      ));
      if (remaining.length) throw new Error('ready_notification_marker_still_pending');
    }
    if (invalidMarkerFinalizationError) throw invalidMarkerFinalizationError;
  } catch (error) {
    console.error({
      event: 'ready_to_ship_notifications_marker_finalization_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
    throw new ReadyToShipNotificationFinalizationError();
  }
  if (buildErrors.length) {
    throw new ReadyToShipNotificationEnqueueError(
      'Delivery completed, but some notification emails could not be prepared. Retry later.',
    );
  }
  return true;
}

export async function reconcilePendingReadyToShipNotifications(
  env: Pick<Env, 'COMMERCE_DB' | 'NOTIFICATION_EMAIL_QUEUE' | 'OPS_DB'>,
  signal: AbortSignal,
  overrides: {
    log?: (entry: Record<string, unknown>) => void;
    nowMs?: () => number;
    providerFetch?: ProfileProviderFetch;
  } = {},
): Promise<number> {
  const context: CommerceContext = {
    commerceDb: env.COMMERCE_DB,
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs: (overrides.nowMs || Date.now)(),
    providerFetch: overrides.providerFetch || ((input, init) => fetch(input, init)),
    signal,
  };
  const log = overrides.log || ((entry: Record<string, unknown>) => console.log(entry));
  signal.throwIfAborted();
  const control = await loadReadyNotificationControl(env.OPS_DB, context.nowMs);
  signal.throwIfAborted();
  if (control.paused) {
    log({ event: 'ready_to_ship_notifications_reconciliation_paused' });
    return 0;
  }
  const afterCursor = await runPendingReadyNotificationReconciliationQuery(
    context,
    READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE,
    control.cursorPath || undefined,
  );
  const wrapped = control.cursorPath && afterCursor.length < READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE
    ? await runPendingReadyNotificationReconciliationQuery(
        context,
        READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE - afterCursor.length,
      )
    : [];
  const documents = Array.from(
    new Map(
      [...afterCursor, ...wrapped].map((document) => [document.path, document] as const),
    ).values(),
  ).slice(0, READY_NOTIFICATION_RECONCILIATION_SCAN_SIZE);
  const failures: unknown[] = [];
  let publicationAttempts = 0;
  let processed = 0;
  let lastVisitedPath: string | undefined;
  for (const document of documents) {
    if (signal.aborted) {
      failures.push(signal.reason);
      break;
    }
    const resolution = resolveDeliveryOrderIdentity(document.id, document.fields, document.path);
    const dropId = resolveDeliveryOrderDropId(document.fields, document.path);
    if (!('identity' in resolution) || !dropId || dropId !== resolution.identity.dropId) {
      lastVisitedPath = document.path;
      try {
        await markPendingReadyToShipNotificationsFailed(
          cleanupContext(context),
          document.path,
          'invalid-order-identity',
        );
        log({
          event: 'ready_to_ship_notifications_invalid_order',
          documentPath: document.path,
        });
      } catch (error) {
        failures.push(error);
      }
      continue;
    }
    if (publicationAttempts >= READY_NOTIFICATION_RECONCILIATION_PUBLISH_LIMIT) break;
    lastVisitedPath = document.path;
    publicationAttempts += 1;
    try {
      const published = await publishReadyToShipNotifications({
        context,
        deliveryId: resolution.identity.deliveryId,
        document,
        dropId,
        opsDb: env.OPS_DB,
        queue: env.NOTIFICATION_EMAIL_QUEUE,
      });
      if (published) processed += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (lastVisitedPath) {
    try {
      await compareAndSetReadyNotificationCursor(
        env.OPS_DB,
        lastVisitedPath,
        control.revision,
        (overrides.nowMs || Date.now)(),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Ready-notification reconciliation failed');
  return processed;
}

async function recordDeliveryClose(
  context: CommerceContext,
  documentPath: string,
  dropId: string,
  closeDeliveryTx: string,
): Promise<void> {
  await commitWrites(context, [updateWrite({
    path: documentPath,
    fields: { dropId, closeDeliveryTx },
    fieldPaths: ['dropId', 'closeDeliveryTx'],
    transforms: [{ fieldPath: 'deliveryClosedAt', value: commerceFieldValue.serverTimestamp() }],
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
    const { blockhash } = await args.connection.getLatestBlockhash('confirmed');
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
      if (maybe.ok) return signature;
      const postInfos = await args.connection.getMultipleAccountsInfo(
        args.batch.map((item) => item.asset),
        { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
      );
      if (postInfos.every((info) => !info)) return signature;
      await pause(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000), args.signal);
      continue;
    }
    const confirmed = await waitForSignature(args.connection, signature, args.signal, TX_CONFIRM_TIMEOUT_MS);
    if (confirmed.ok) return signature;
    const postInfos = await args.connection.getMultipleAccountsInfo(
      args.batch.map((item) => item.asset),
      { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
    );
    if (postInfos.every((info) => !info)) return signature;
    lastError = confirmed.error;
    const message = transactionErrorMessage(confirmed.error);
    if (looksLikeComputeLimitError(message, confirmed.logs)) {
      throw new DeliveryReceiptError('resource-exhausted', 'Receipt issuance batch exceeded compute limits.', {
        lastError: message,
        lastLogs: confirmed.logs.slice(0, 80),
      });
    }
    await pause(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000), args.signal);
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
  waitUntil: DeliveryReceiptWaitUntil;
  randomInt: (maxExclusive: number) => number;
}): Promise<ReceiptIssueResult> {
  const owner = canonicalPublicKey(args.request.ownerWallet, 'wallet address');
  const deliveryId = Math.floor(args.request.deliveryId);
  const runtime = runtimeForDrop(args.request.dropId);
  const path = dropDeliveryOrderPath(runtime.dropId, deliveryId);
  const document = await readDocument(args.commerce, path);
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
      opsDb: args.env.OPS_DB,
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
  const assetKeys = verified.targetAssetIds.map((assetId) => canonicalPublicKey(assetId, 'delivery asset id'));
  const infos = await connection.getMultipleAccountsInfo(assetKeys, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
  });
  const pending = pendingReceiptItems(document.fields, verified.targetAssetIds, infos, runtime);
  const alreadyProcessed = verified.targetAssetIds.length - pending.length;
  const receiptTxs: string[] = [];
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
        });
        receiptTxs.push(signature);
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
    const items = Array.isArray(document.fields.items) ? document.fields.items.filter(isRecord) : [];
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
    opsDb: args.env.OPS_DB,
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

async function issueReceiptsRequest(
  body: IssueRequest,
  identity: RequestIdentity,
  env: DeliveryReceiptsEnv,
  commerce: CommerceContext,
  provider: ProviderContext,
  waitUntil: DeliveryReceiptWaitUntil,
): Promise<ReceiptIssueResult> {
  const wallet = await resolveRequestWallet(identity, (uid) => loadWalletSession(commerce, env.OPS_DB, uid));
  const ownerWallet = canonicalPublicKey(body.owner, 'wallet address').toBase58();
  if (wallet !== ownerWallet) throw new DeliveryReceiptError('permission-denied', 'Owners only.');
  if (!isNonZeroBase58Bytes(body.signature, 64)) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery signature.');
  }
  const runtime = runtimeForDrop(body.dropId);
  const path = dropDeliveryOrderPath(runtime.dropId, body.deliveryId);
  const order = await readDocument(commerce, path);
  if (!order) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  let leaseAcquired = false;
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
      leaseAcquired = true;
    }
  }
  try {
    const result = await retryIssueReceipts({
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
    if (leaseAcquired) {
      await finalizeDeliveryRecoveryAttempt(cleanupContext(commerce), path, {}).catch(() => undefined);
    }
    return result;
  } catch (error) {
    if (leaseAcquired) {
      await finalizeDeliveryRecoveryAttempt(cleanupContext(commerce), path, {
        errorCode: normalizeRecoveryErrorCode(error),
        message: normalizeRecoveryMessage(error),
      }).catch(() => undefined);
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
  waitUntil: DeliveryReceiptWaitUntil,
): Promise<RecoverDeliveryOrdersResult> {
  const wallet = await resolveRequestWallet(identity, (uid) => loadWalletSession(commerce, env.OPS_DB, uid));
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
    const [processing, prepared, pendingReady] = await Promise.all([
      runDeliveryOrderQuery(commerce, wallet, 'processing'),
      runDeliveryOrderQuery(commerce, wallet, 'prepared'),
      runPendingReadyNotificationQuery(commerce, wallet),
    ]);
    candidates = Array.from(
      new Map([...processing, ...prepared, ...pendingReady].map((document) => [document.path, document])).values(),
    ).filter((document) => !filterDropId || resolveDeliveryOrderDropId(document.fields, document.path) === filterDropId);
  }
  candidates.sort(compareDeliveryRecoveryCandidates);
  for (const document of candidates) {
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
      const result = await retryIssueReceipts({
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
        exists = await hasConfirmedDeliveryRecord(provider, runtime, base.deliveryId, document.fields);
      } catch (error) {
        console.warn({
          event: 'delivery_receipt_recovery_eligibility_failed',
          dropId: base.dropId,
          deliveryId: base.deliveryId,
          error: summarizeError(error),
        });
      }
      if (exists === false) {
        const nextCheckAt = await recordPreparedDeliveryRecoveryMiss(
          commerce,
          document,
          nowMs,
        ).catch((error) => {
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
      const result = await retryIssueReceipts({
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
      const errorCode = normalizeRecoveryErrorCode(error);
      const message = normalizeRecoveryMessage(error);
      const outcome: DeliveryRecoveryOutcome = errorCode === 'failed-precondition' &&
        /delivery record pda not found/i.test(message || '')
        ? 'missing_delivery'
        : 'failed';
      const cleanup = cleanupContext(commerce);
      if (base.statusBefore === 'prepared') {
        await handlePreparedRecoveryFailure(
          cleanup,
          document.path,
          outcome,
          errorCode,
        ).catch(() => undefined);
      }
      await finalizeDeliveryRecoveryAttempt(cleanup, document.path, {
        errorCode,
        message,
      }).catch(() => undefined);
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
  waitUntil: DeliveryReceiptWaitUntil,
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Delivery receipt request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
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
    identity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      controller.signal,
      dependencies.nowMs(),
    );
    const rawBody = await readRequestBody(
      request,
      controller.signal,
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
      signal: controller.signal,
      dataDb: env.DATA_DB,
    };
    const provider: ProviderContext = { apiKey, fetch: trackedFetch, signal: controller.signal };
    if (path === DELIVERY_RECEIPTS_ISSUE_PATH) {
      const body = rawBody as IssueRequest;
      dropId = normalizeDropId(body.dropId);
      deliveryId = body.deliveryId;
      const result: IssueReceiptsResult = await dependencies.issue(
        body,
        identity,
        env,
        common,
        provider,
        waitUntil,
      );
      return {
        response: jsonResponse(result),
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
    const result = await dependencies.recover(
      body,
      identity,
      env,
      common,
      provider,
      waitUntil,
    );
    return {
      response: jsonResponse(result),
      metrics,
      authOutcome: 'accepted',
      ...(dropId ? { dropId } : {}),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      verification: 'delivery_pda',
      attempted: result.attempted,
      recovered: result.recovered,
    };
  } catch (error) {
    let receiptError: DeliveryReceiptError;
    if (controller.signal.aborted) {
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
    clearTimeout(timeout);
  }
}

export const deliveryReceiptTestHooks = {
  assignmentClaimCompatible,
  assertDeliveryPayers,
  assertDeliverArgsMatchOrder,
  assertOnchainConfigMatchesRuntime,
  acquireDeliveryRecoveryLease,
  compareDeliveryRecoveryCandidates,
  decodeDeliveryRecord,
  decodeCosigner,
  deliveryRecoveryEligibility,
  deriveDeliveryPda,
  DeliveryReceiptError,
  handlePreparedRecoveryFailure,
  issueReceiptsRequest,
  loadWalletSession,
  markDeliveryReady,
  markReadyToShipNotificationsQueued,
  normalizeAssignedDudeIds,
  projectPendingDeliveryPackStatus,
  recordDeliveryPackStatusProjectionTransientFailure,
  pendingReceiptItems,
  ReceiptBatchRetryExhaustedError,
  ReadyToShipNotificationEnqueueError,
  recoverReceiptsRequest,
  publishReadyToShipNotifications,
  runtimeForDrop,
  rollbackTransactionBestEffort,
  runDeliveryRecoveryStateQuery,
  runPendingReadyNotificationQuery,
  secureRandomInt,
  shouldShrinkReceiptBatch,
  storedDeliveryItemIds,
};

export const deliveryReceiptRuntime = {
  assignDudesForBox,
  beginTransaction,
  buildTransaction,
  closeDeliveryInstruction,
  commitWrites,
  countNormalIrlPackStatus,
  createConnection,
  createWrite,
  decodeCosigner,
  DeliveryReceiptError,
  deriveDeliveryPda,
  fetchOnchainConfig,
  commerceInteger,
  commerceString,
  commerceTimestamp,
  commerceValue,
  mintReceiptsInstruction,
  pause,
  readDocument,
  rollbackTransactionBestEffort,
  runtimeForDrop,
  secureRandomInt,
  sendAndConfirmSignedTransaction,
  updateWrite,
};
