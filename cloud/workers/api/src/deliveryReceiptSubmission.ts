import type { DeliveryOrderReceiptView } from './deliveryOrderReceiptView.js';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  type VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import {
  TX_SEND_TIMEOUT_MS,
  TX_CONFIRM_TIMEOUT_MS,
  buildTransaction,
  closeDeliveryInstruction,
  createConnection,
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
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import { isSignalCancellationError, sleepWithSignal } from './boundedRequest.js';
import { probeTransactionSubmission, type TransactionSubmissionOutcome } from './transactionSubmissionRecovery.js';
import { deliveryOrderKey } from './deliveryOrderStore.js';
import {
  persistPendingReceiptSubmission,
  settlePendingReceiptSubmission,
  type PendingReceiptSubmission,
} from './deliveryReceiptStore.js';
import type { DeliveryRecoveryLease } from './deliveryRecoveryStore.js';
import { deliveryRecoveryCleanupContext as cleanupContext } from './deliveryRecoveryAttempt.js';
import type { CommerceContext } from './deliveryReceiptRequest.js';

const TX_MAX_SEND_ATTEMPTS = 3;

const SOLANA_MAX_RAW_TX_BYTES = 1232;

export class ReceiptBatchRetryExhaustedError extends DeliveryReceiptError {
  constructor(lastError: unknown) {
    super('unavailable', 'Unable to issue receipts. Retry later.', {
      lastError: transactionErrorMessage(lastError),
    });
    this.name = 'ReceiptBatchRetryExhaustedError';
  }
}

export type ReceiptSubmissionLifecycle = {
  prepare(pending: PendingReceiptSubmission): Promise<void>;
  reconcile(pending: PendingReceiptSubmission): Promise<TransactionSubmissionOutcome>;
  settle(pending: PendingReceiptSubmission, outcome: Exclude<TransactionSubmissionOutcome, 'unresolved'>): Promise<void>;
};

const pause = sleepWithSignal;

function looksLikeComputeLimitError(message: string, logs: readonly string[]): boolean {
  const value = `${message}\n${logs.join('\n')}`.toLowerCase();
  return value.includes('computational budget exceeded') ||
    value.includes('exceeded maximum compute') ||
    value.includes('program failed to complete') ||
    (value.includes('compute units') && value.includes('consumed') && value.includes('failed'));
}

export function pendingReceiptItems(
  order: DeliveryOrderReceiptView,
  targetAssetIds: readonly string[],
  infos: readonly (AccountInfo<Buffer> | null)[],
  runtime: DeliveryRuntime,
): Array<{ assetId: string; asset: PublicKey; kind: 'box' | 'dude'; refId: number }> {
  assertCompleteReceiptAssetAccounts(infos, targetAssetIds.length);
  const storedItems = order.items;
  const byAssetId = new Map<string, DeliveryOrderReceiptView['items'][number]>();
  for (const item of storedItems) {
    if (typeof item.assetId === 'string') byAssetId.set(item.assetId, item);
  }
  const pending: Array<{ assetId: string; asset: PublicKey; kind: 'box' | 'dude'; refId: number }> = [];
  for (let index = 0; index < targetAssetIds.length; index += 1) {
    if (isConsumedReceiptAsset(infos[index])) continue;
    const assetId = targetAssetIds[index];
    const stored = byAssetId.get(assetId);
    const kind = stored?.kind;
    const refId = stored?.refId ?? NaN;
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

function isConsumedReceiptAsset(info: AccountInfo<Buffer> | null): boolean {
  return info === null || (info.executable === false && info.owner.toBase58() === MPL_CORE_PROGRAM_ADDRESS &&
    info.data.length === 1 && info.data[0] === 0);
}

function assertCompleteReceiptAssetAccounts(infos: readonly (AccountInfo<Buffer> | null)[], expected: number): void {
  if (infos.length !== expected || Array.from(infos).some((info) => info === undefined)) {
    throw new DeliveryReceiptError('unavailable', 'Receipt provider returned incomplete asset accounts.');
  }
}

export async function fetchReceiptAssetAccounts(
  connection: Pick<Connection, 'getMultipleAccountsInfo'>,
  assets: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  const infos = await connection.getMultipleAccountsInfo(assets, {
    commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
  });
  assertCompleteReceiptAssetAccounts(infos, assets.length);
  return infos;
}

export async function sendReceiptBatch(args: {
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
        const postInfos = await fetchReceiptAssetAccounts(args.connection,
          args.batch.map((item) => item.asset),
        );
        if (postInfos.every(isConsumedReceiptAsset)) {
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
        const postInfos = await fetchReceiptAssetAccounts(args.connection,
          args.batch.map((item) => item.asset),
        );
        if (postInfos.every(isConsumedReceiptAsset)) {
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

export function shouldShrinkReceiptBatch(error: unknown): boolean {
  return error instanceof RangeError ||
    error instanceof ReceiptBatchRetryExhaustedError ||
    (error instanceof DeliveryReceiptError && error.code === 'resource-exhausted');
}

export async function closeDeliveryPda(args: {
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

export async function probePendingReceiptSubmission(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getMultipleAccountsInfo' | 'isBlockhashValid'>,
  pending: PendingReceiptSubmission,
): Promise<TransactionSubmissionOutcome> {
  return probeTransactionSubmission({
    connection,
    signature: pending.signature,
    blockhash: pending.blockhash,
    hasLanded: async () => {
      const infos = await fetchReceiptAssetAccounts(connection,
        pending.assetIds.map((assetId) => new PublicKey(assetId)),
      );
      return infos.every(isConsumedReceiptAsset);
    },
  });
}

export async function reconcilePendingReceiptSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: DeliveryRuntime;
  path: string;
  pending: PendingReceiptSubmission;
  lease: DeliveryRecoveryLease;
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
      args.lease,
      () => cleanupContext(persistence),
    );
  } else {
    await settlePendingReceiptSubmission(
      persistence,
      deliveryOrderKey(args.path),
      args.pending,
      outcome,
      args.lease,
      () => cleanupContext(persistence),
    );
  }
  return outcome;
}
