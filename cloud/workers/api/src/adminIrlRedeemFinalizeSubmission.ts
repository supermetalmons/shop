import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { PendingFinalizeSubmissionError } from './adminIrlRedeemErrors.js';
import { createConnection } from './adminIrlRedeemFinalizeOnchainReads.js';
import { requestKey } from './adminIrlRedeemFinalizeRequest.js';
import type { CommerceContext, Runtime } from './adminIrlRedeemFinalizeTypes.js';
import type { ProviderContext } from './adminIrlRedeemOnchain.js';
import type { PendingFinalizeSubmission, StartedRequest } from './adminIrlRedeemRequestState.js';
import {
  cleanupContext,
  holdPendingFinalizeSubmission,
  persistPendingFinalizeSubmission,
  settlePendingFinalizeSubmission,
} from './adminIrlRedeemRequestStore.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import { DeliveryReceiptError, sendAndConfirmSignedTransaction } from './deliveryReceiptOnchain.js';
import { probeTransactionSubmission, type TransactionSubmissionOutcome } from './transactionSubmissionRecovery.js';

export function isTombstone(account: Awaited<ReturnType<Connection['getAccountInfo']>>): boolean {
  return !account || account.data.length <= 1;
}

export async function probePendingFinalizeSubmission(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getAccountInfoAndContext' | 'getMultipleAccountsInfo' | 'isBlockhashValid'>,
  pending: PendingFinalizeSubmission,
): Promise<TransactionSubmissionOutcome> {
  return probeTransactionSubmission({
    connection,
    signature: pending.signature,
    blockhash: pending.blockhash,
    hasLanded: async () => pending.kind === 'internal_delivery'
      ? Boolean((await connection.getAccountInfoAndContext(new PublicKey(pending.deliveryPda), {
        commitment: 'confirmed', dataSlice: { offset: 0, length: 0 },
      })).value)
      : (await connection.getMultipleAccountsInfo(pending.assetIds.map((assetId) => new PublicKey(assetId)), {
        commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
      })).every(isTombstone),
  });
}

async function reconcilePendingFinalizeSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<TransactionSubmissionOutcome> {
  const probeContext = cleanupContext(args.commerce);
  let outcome: TransactionSubmissionOutcome = 'unresolved';
  try {
    outcome = await probePendingFinalizeSubmission(
      createConnection({ ...args.provider, signal: probeContext.signal }, args.runtime),
      args.pending,
    );
  } catch {}
  const persistence = cleanupContext(args.commerce);
  if (outcome === 'unresolved') {
    await holdPendingFinalizeSubmission(persistence, requestKey(args.path), args.attemptId, args.pending);
  } else {
    await settlePendingFinalizeSubmission(
      persistence,
      requestKey(args.path),
      args.attemptId,
      args.pending,
      outcome,
    );
  }
  return outcome;
}

function pendingFinalizeSubmissionError(error: unknown, signal: AbortSignal): PendingFinalizeSubmissionError {
  return new PendingFinalizeSubmissionError(signal.aborted ? signal.reason : error);
}

export function isDefinitiveTransactionFailure(error: unknown): boolean {
  return error instanceof DeliveryReceiptError &&
    isRecord(error.details) &&
    error.details.definitiveFailure === true;
}

export async function receiptBatchConfirmedByPostState(
  error: unknown,
  connection: Pick<Connection, 'getMultipleAccountsInfo'>,
  assets: PublicKey[],
): Promise<boolean> {
  if (isDefinitiveTransactionFailure(error)) return false;
  const post = await connection.getMultipleAccountsInfo(assets, {
    commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
  }).catch(() => []);
  return post.length === assets.length && post.every(isTombstone);
}

export async function clearDefinitiveFinalizeSubmission(args: {
  commerce: CommerceContext;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<void> {
  try {
    await settlePendingFinalizeSubmission(
      cleanupContext(args.commerce),
      requestKey(args.path),
      args.attemptId,
      args.pending,
      'expired',
    );
  } catch (error) {
    throw pendingFinalizeSubmissionError(error, args.commerce.signal);
  }
}

export async function rethrowUnbroadcastFinalizeCancellation(args: {
  broadcastStarted: boolean;
  commerce: CommerceContext;
  error: unknown;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<void> {
  if (args.broadcastStarted || !isSignalCancellationError(args.commerce.signal, args.error)) return;
  await clearDefinitiveFinalizeSubmission(args);
  throw args.commerce.signal.reason;
}

export async function executePendingFinalizeSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
  connection: Connection;
  transaction: VersionedTransaction;
  label: string;
}): Promise<void> {
  await persistPendingFinalizeSubmission(args.commerce, requestKey(args.path), args.attemptId, args.pending);
  let broadcastStarted = false;
  try {
    await sendAndConfirmSignedTransaction(
      args.connection,
      args.transaction,
      args.commerce.signal,
      args.label,
      () => { broadcastStarted = true; },
    );
    await settlePendingFinalizeSubmission(args.commerce, requestKey(args.path), args.attemptId, args.pending, 'confirmed');
  } catch (error) {
    await rethrowUnbroadcastFinalizeCancellation({ ...args, broadcastStarted, error });
    if (isDefinitiveTransactionFailure(error)) {
      await clearDefinitiveFinalizeSubmission(args);
      throw error;
    }
    const outcome = await reconcilePendingFinalizeSubmission(args).catch(() => 'unresolved' as const);
    if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(error, args.commerce.signal);
    if (outcome === 'expired') throw error;
  }
}

export async function reconcileStartedRequestSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  request: StartedRequest;
}): Promise<void> {
  const pending = args.request.pendingFinalizeSubmission;
  if (!pending) return;
  let outcome: TransactionSubmissionOutcome;
  try {
    outcome = await reconcilePendingFinalizeSubmission({
      ...args,
      pending,
    });
  } catch (error) {
    throw pendingFinalizeSubmissionError(error, args.commerce.signal);
  }
  if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(undefined, args.commerce.signal);
  if (outcome === 'confirmed') {
    if (pending.kind === 'internal_delivery') {
      args.request.internalDeliveryId = pending.deliveryId;
      args.request.internalDeliveryPda = pending.deliveryPda;
      args.request.internalDeliveryTx = pending.signature;
    } else if (!args.request.receiptTxs.includes(pending.signature)) {
      args.request.receiptTxs.push(pending.signature);
    }
  }
  delete args.request.pendingFinalizeSubmission;
}
