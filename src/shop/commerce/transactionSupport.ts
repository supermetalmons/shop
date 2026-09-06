import { Connection, type VersionedTransaction } from '@solana/web3.js';
import {
  type PendingSubmittedTransaction
} from '../../lib/pendingPreparedTransactions';
import {
  type ReceiptOperation
} from '../../lib/receiptTransfer';
import {
  classifySignedTransactionSendError,
  isPotentiallySubmittedTransactionError,
  reconcileSubmittedTransaction,
  recoverAlreadyProcessedSignature
} from '../../lib/solana';

export const PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS = 10_000;

export const RECEIPT_STATUS_CHECK_TIMEOUT_MS = 12_000;

export const RECEIPT_HIDDEN_OPERATION_PHASES = new Set<ReceiptOperation['phase']>(['hidden']);

export const DELIVERY_SHIPMENT_REFRESH_INITIAL_DELAY_MS = 2_000;

export const DELIVERY_SHIPMENT_REFRESH_MAX_DELAY_MS = 30_000;

export const DELIVERY_SHIPMENT_REFRESH_TIMEOUT_MS = 5 * 60_000;

export type PendingPreparedResolution = Awaited<ReturnType<typeof reconcileSubmittedTransaction>>;

export function pendingSubmittedTransactionKey(record: PendingSubmittedTransaction): string {
  return `${record.wallet}:${record.operationId}:${record.signature}`;
}

export function createPendingPreparedOperationId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE =
  'This wallet cannot safely sign receipt transfers. Use a wallet with Solana v0 transaction support.';

export const RECEIPT_TRANSFER_WALLET_CHANGED_MESSAGE =
  'The connected wallet changed. Start the receipt transfer again.';

function errorMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  const anyErr = err as { message?: unknown; error?: unknown; };
  if (typeof anyErr.message === 'string') return anyErr.message;
  if (typeof anyErr.error === 'string') return anyErr.error;
  if (typeof (anyErr.error as { message?: unknown; })?.message === 'string') {
    return (anyErr.error as { message: string; }).message;
  }
  return '';
}

export function isUserRejectedError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: unknown; name?: unknown; cause?: unknown; };
  if (anyErr.cause && isUserRejectedError(anyErr.cause)) return true;
  const code = anyErr.code;
  if (code === 4001 || code === 'ACTION_REJECTED' || code === 'USER_REJECTED' || code === 'Rejected') {
    return true;
  }
  const name = typeof anyErr.name === 'string' ? anyErr.name : '';
  if (/wallet.*rejected/i.test(name)) return true;
  const message = errorMessage(err).toLowerCase();
  if (!message) return false;
  return (
    message.includes('user rejected') ||
    message.includes('rejected the request') ||
    message.includes('rejected the transaction') ||
    message.includes('user denied') ||
    message === 'canceled' ||
    message === 'cancelled' ||
    message.includes('request was rejected') ||
    message.includes('transaction was rejected')
  );
}

export type SendViaConnectionOptions = {
  onAlreadyProcessedWithoutSignature?: (err: unknown) => Promise<boolean>;
  surfaceSignedSubmissionImmediately?: boolean;
  assertWalletCurrent?: () => void;
  signedSendTimeoutMs?: number;
  onBroadcastAttempt?: (signature: string, tx: VersionedTransaction) => void;
};

export async function recoverConnectionSendError(
  tx: VersionedTransaction | null,
  targetConnection: Connection,
  err: unknown,
  options?: SendViaConnectionOptions,
): Promise<string | null> {
  const immediateClassification =
    tx && options?.surfaceSignedSubmissionImmediately
      ? classifySignedTransactionSendError(tx, err)
      : null;
  if (isPotentiallySubmittedTransactionError(immediateClassification)) {
    throw immediateClassification;
  }
  const recoveredSignature = await recoverAlreadyProcessedSignature(tx, targetConnection, err);
  if (recoveredSignature) return recoveredSignature;
  if (options?.onAlreadyProcessedWithoutSignature) {
    const recovered = await options.onAlreadyProcessedWithoutSignature(err);
    if (recovered) return null;
  }
  throw immediateClassification ?? (tx ? classifySignedTransactionSendError(tx, err) : err);
}
