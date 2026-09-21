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
  looksLikeAccountInUseError,
  looksLikeBlockhashError,
  looksLikeRateLimitOrRpcError,
  mintReceiptsInstruction,
  mplCoreBurnInstruction,
  runtimeForDrop,
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
  summarizeDeliveryReceiptError as summarizeError,
} from './deliveryReceiptErrors.js';
import { transactionAccountKeys } from './receiptTransferVerification.js';
import {
  dropDeliveryOrderPath,
} from './dropPaths.js';
import type {
  DeliveryRecoveryOutcome,
  IssueReceiptsResult,
  RecoverDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult,
} from '../../../../shared/contracts.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import {
  isBase58Bytes,
  isNonZeroBase58Bytes,
} from '../../../../shared/solanaRpcProxy.js';
import { RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  readBoundedRequestJson,
  runCriticalRequestOperation,
  sleepWithSignal,
} from './boundedRequest.js';
import { requestIdentityErrorDetails, withAuthenticatedRequest } from './authenticatedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import {
  CommerceDudeAssignmentError,
  normalizeCommerceDudeIds,
} from './commerceDudeAssignments.js';
import { assignDudesForBox } from './deliveryDudeAssignments.js';
import { secureRandomInt } from './deliveryRandom.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import {
  publishReadyToShipNotifications,
  ReadyToShipNotificationEnqueueError,
} from './readyToShipNotificationOutbox.js';
import {
  scheduleDeliveryPackStatusProjection,
} from './deliveryPackStatusOutbox.js';
import {
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import {
  probeTransactionSubmission,
  type TransactionSubmissionOutcome,
} from './transactionSubmissionRecovery.js';
import { resolveDeliveryOrderDropId } from './deliveryOrderSummaries.js';
import { buildRecoverDeliveryOrdersResult } from '../../../../shared/deliveryRecovery.js';
import { D1CommerceRepository, type CommerceDocumentData } from './commerceRepository.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import {
  confirmedReceiptTransactions,
  deliveryOrderKey,
  ensureIrlClaimCodeForBox,
  hasPendingReceiptSubmission,
  markDeliveryProcessing,
  markDeliveryReady,
  pendingReceiptSubmission,
  persistPendingReceiptSubmission,
  readDeliveryOrder,
  recordDeliveryClose,
  settlePendingReceiptSubmission,
  type DeliveryIrlClaim,
  type DeliveryOrderDocument,
  type PendingReceiptSubmission,
} from './deliveryReceiptStore.js';
import {
  MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL,
  acquireDeliveryRecoveryLease,
  cancelDeliveryRecoveryAttempt,
  compareDeliveryRecoveryCandidates,
  fetchDeliveryRecoveryState,
  finalizeDeliveryRecoveryAttempt,
  handlePreparedRecoveryFailure,
  orderResultBase,
  recordPreparedDeliveryRecoveryMiss,
  runDeliveryRecoveryOrderQuery,
  runPendingReadyNotificationQuery,
  type DeliveryRecoveryLease,
} from './deliveryRecoveryStore.js';

export const DELIVERY_RECEIPTS_ISSUE_PATH = '/delivery/receipts/issue';
export const DELIVERY_RECEIPTS_RECOVER_PATH = '/delivery/receipts/recover';

const REQUEST_MAX_BYTES = 4096;
const HANDLER_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const TX_MAX_SEND_ATTEMPTS = 3;
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

type CommerceContext = CommerceRepositoryContext & {
  providerFetch: ProfileProviderFetch;
  dataDb?: D1Database;
  [key: string]: unknown;
};

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

type ReceiptSubmissionLifecycle = {
  prepare(pending: PendingReceiptSubmission): Promise<void>;
  reconcile(pending: PendingReceiptSubmission): Promise<TransactionSubmissionOutcome>;
  settle(pending: PendingReceiptSubmission, outcome: Exclude<TransactionSubmissionOutcome, 'unresolved'>): Promise<void>;
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

const pause = sleepWithSignal;

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
  const deliveryInfo = (await connection.getAccountInfoAndContext(
    expectedDeliveryPda,
    includeData
      ? { commitment: 'confirmed' }
      : { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
  )).value;
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
    const { blockhash, lastValidBlockHeight } = (await args.connection.getLatestBlockhashAndContext('confirmed')).value;
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
  const info = (await args.connection.getAccountInfoAndContext(args.deliveryPda, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
  })).value;
  if (!info) return null;
  const { blockhash } = (await args.connection.getLatestBlockhashAndContext('confirmed')).value;
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
  let document = await readDeliveryOrder(args.commerce, deliveryOrderKey(path));
  if (!document) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  if (document.data.owner && document.data.owner !== owner.toBase58()) {
    throw new DeliveryReceiptError('permission-denied', 'Order belongs to a different wallet.');
  }
  const connection = createConnection(args.provider, runtime);
  const onchain = await fetchOnchainConfig(connection, runtime);
  const signer = decodeCosigner(args.env.COSIGNER_SECRET);
  if (!signer.publicKey.equals(onchain.admin)) {
    throw new DeliveryReceiptError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin.');
  }
  if (document.data.status === 'ready_to_ship') {
    scheduleDeliveryPackStatusProjection({
      context: args.commerce,
      deliveryId,
      dropId: runtime.dropId,
      waitUntil: args.waitUntil,
    });
    let closeDeliveryTx = typeof document.data.closeDeliveryTx === 'string'
      ? document.data.closeDeliveryTx
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
          await recordDeliveryClose(args.commerce, document.key, runtime.dropId, closeDeliveryTx);
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
      receiptsMinted: Number(document.data.receiptsMinted || 0),
      receiptTxs: Array.isArray(document.data.receiptTxs)
        ? document.data.receiptTxs.filter((value): value is string => typeof value === 'string')
        : [],
      closeDeliveryTx,
    };
  }
  const verified = args.request.verification === 'signature'
    ? await verifyReceiptIssuanceBySignature({
        connection,
        deliveryId,
        order: document.data,
        ownerWallet: owner.toBase58(),
        runtime,
        signature: args.request.signature,
      })
    : await verifyReceiptIssuanceByDeliveryRecord({
        connection,
        deliveryId,
        order: document.data,
        ownerWallet: owner.toBase58(),
        runtime,
      });
  await markDeliveryProcessing(args.commerce, document, runtime, verified.signature);
  const storedPendingSubmission = pendingReceiptSubmission(document.data);
  if (storedPendingSubmission) {
    const outcome = await reconcilePendingReceiptSubmission({
      commerce: args.commerce,
      provider: args.provider,
      runtime,
      path: document.key.path,
      pending: storedPendingSubmission,
    });
    if (outcome === 'unresolved') {
      throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
    }
    const reconciled = await readDeliveryOrder(args.commerce, deliveryOrderKey(path));
    if (!reconciled) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
    document = reconciled;
  }
  const lifecycle: ReceiptSubmissionLifecycle = {
    prepare: (pendingSubmission) => persistPendingReceiptSubmission(
      args.commerce,
      document.key,
      pendingSubmission,
      () => cleanupContext(args.commerce),
    ),
    reconcile: (pendingSubmission) => reconcilePendingReceiptSubmission({
      commerce: args.commerce,
      provider: args.provider,
      runtime,
      path: document.key.path,
      pending: pendingSubmission,
    }),
    settle: (pendingSubmission, outcome) => settlePendingReceiptSubmission(
      cleanupContext(args.commerce),
      document.key,
      pendingSubmission,
      outcome,
      () => cleanupContext(args.commerce),
    ),
  };
  const assetKeys = verified.targetAssetIds.map((assetId) => canonicalPublicKey(assetId, 'delivery asset id'));
  const infos = await connection.getMultipleAccountsInfo(assetKeys, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
  });
  const pending = pendingReceiptItems(document.data, verified.targetAssetIds, infos, runtime);
  const alreadyProcessed = verified.targetAssetIds.length - pending.length;
  const receiptTxs = confirmedReceiptTransactions(document.data);
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
  const irlClaims: DeliveryIrlClaim[] = [];
  if (runtime.itemsPerBox > 0) {
    const items = Array.isArray(document.data.items)
      ? document.data.items.filter((item): item is CommerceDocumentData => isRecord(item))
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
    await recordDeliveryClose(args.commerce, document.key, runtime.dropId, closeDeliveryTx);
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

async function probePendingReceiptSubmission(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getMultipleAccountsInfo' | 'isBlockhashValid'>,
  pending: PendingReceiptSubmission,
): Promise<TransactionSubmissionOutcome> {
  return probeTransactionSubmission({
    connection,
    signature: pending.signature,
    blockhash: pending.blockhash,
    hasLanded: async () => {
      const infos = await connection.getMultipleAccountsInfo(
        pending.assetIds.map((assetId) => new PublicKey(assetId)),
        { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
      );
      return infos.every((info) => !info);
    },
  });
}

async function reconcilePendingReceiptSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: DeliveryRuntime;
  path: string;
  pending: PendingReceiptSubmission;
}): Promise<TransactionSubmissionOutcome> {
  const probeContext = cleanupContext(args.commerce);
  let outcome: TransactionSubmissionOutcome = 'unresolved';
  try {
    outcome = await probePendingReceiptSubmission(
      createConnection({ ...args.provider, signal: probeContext.signal }, args.runtime),
      args.pending,
    );
  } catch {}
  const persistence = cleanupContext(args.commerce);
  if (outcome === 'unresolved') {
    await persistPendingReceiptSubmission(
      persistence,
      deliveryOrderKey(args.path),
      args.pending,
      () => cleanupContext(persistence),
    );
  } else {
    await settlePendingReceiptSubmission(
      persistence,
      deliveryOrderKey(args.path),
      args.pending,
      outcome,
      () => cleanupContext(persistence),
    );
  }
  return outcome;
}

function normalizeRecoveryErrorCode(error: unknown): string | undefined {
  if (error instanceof DeliveryReceiptError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'deadline-exceeded';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  return error instanceof Error ? 'internal' : undefined;
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
  const order = await readDeliveryOrder(commerce, deliveryOrderKey(path));
  if (!order) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  let acquiredLease: DeliveryRecoveryLease | undefined;
  if (order.data.status !== 'ready_to_ship') {
    const lease = await acquireDeliveryRecoveryLease(commerce, order.key, ownerWallet, Date.now(), true);
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
      await finalizeDeliveryRecoveryAttempt(cleanupContext(commerce), order.key, {}).catch(() => undefined);
    }
    return result;
  } catch (error) {
    if (acquiredLease && isDeliveryRecoveryCancellation(error, commerce.signal)) {
      const reason = commerce.signal.reason;
      const cleanup = cleanupContext(commerce);
      if (!await hasPendingReceiptSubmission(cleanup, order.key)) {
        await cancelDeliveryRecoveryAttempt(cleanup, order.key, acquiredLease).catch(() => undefined);
      }
      throw reason;
    }
    if (acquiredLease) {
      const cleanup = cleanupContext(commerce);
      if (!await hasPendingReceiptSubmission(cleanup, order.key)) {
        await finalizeDeliveryRecoveryAttempt(cleanup, order.key, {
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
    const document = await readDeliveryOrder(commerce, deliveryOrderKey(dropDeliveryOrderPath(filterDropId, body.deliveryId)));
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
      new Map([...recovery, ...pendingReady].map((document) => [document.key.path, document])).values(),
    ).filter((document) => !filterDropId || resolveDeliveryOrderDropId(document.data, document.key.path) === filterDropId);
  }
  candidates.sort(compareDeliveryRecoveryCandidates);
  for (const document of candidates) {
    if (commerce.signal.aborted) throw commerce.signal.reason;
    const base = orderResultBase(document);
    if (!base) continue;
    if (document.data.owner && document.data.owner !== wallet) {
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
          document.data,
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
    const lease = await acquireDeliveryRecoveryLease(commerce, document.key, wallet, nowMs, force);
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
      await finalizeDeliveryRecoveryAttempt(cleanupContext(commerce), document.key, {}).catch(() => undefined);
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isDeliveryRecoveryCancellation(error, commerce.signal)) {
        const reason = commerce.signal.reason;
        const cleanup = cleanupContext(commerce);
        if (!await hasPendingReceiptSubmission(cleanup, document.key)) {
          await cancelDeliveryRecoveryAttempt(
            cleanup,
            document.key,
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
          document.key,
          outcome,
          errorCode,
        ).catch(() => undefined);
      }
      if (!await hasPendingReceiptSubmission(cleanup, document.key)) {
        await finalizeDeliveryRecoveryAttempt(cleanup, document.key, {
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
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new DeliveryReceiptError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome: 'rejected',
    };
  }
  return withAuthenticatedRequest(request, {
    opsDb: env.OPS_DB,
    timeoutMessage: 'Delivery receipt request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    let identity: RequestIdentity | undefined;
    let dropId: string | undefined;
    let deliveryId: number | undefined;
    try {
      const verifiedIdentity = await authenticate();
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
        const mapped = requestIdentityErrorDetails(error, {
          code: 'unavailable',
          message: 'Authentication is temporarily unavailable.',
        });
        receiptError = new DeliveryReceiptError(mapped.code, mapped.message);
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
    }
  });
}

export const deliveryReceiptTestHooks = {
  assertDeliveryPayers,
  assertDeliverArgsMatchOrder,
  decodeDeliveryRecord,
  deliveryRecoveryFailure,
  issueReceiptsRequest,
  probePendingReceiptSubmission,
  reconcilePendingReceiptSubmission,
  loadBoundWallet,
  normalizeAssignedDudeIds,
  pendingReceiptItems,
  ReceiptBatchRetryExhaustedError,
  recoverReceiptsRequest,
  runtimeForDrop,
  sendReceiptBatch,
  shouldShrinkReceiptBatch,
  storedDeliveryItemIds,
};
