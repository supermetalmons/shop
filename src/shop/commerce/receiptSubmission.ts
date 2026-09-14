import type { Connection, VersionedTransaction } from '@solana/web3.js';
import { sendPreparedTransaction } from '../../lib/solana';
import type { PreparedTransactionSender } from './contracts';
import { PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS } from './transactionSupport';

const DEFAULT_RUNTIME = { sendPreparedTransaction };

type ReceiptSubmissionOptions = {
  encodedTx: string;
  connection: Connection;
  signAndSendPreparedViaConnection: PreparedTransactionSender;
  receiptWallet?: {
    assertCurrent: () => void;
    onBroadcastAttempt: (signature: string, transaction: VersionedTransaction) => void;
  };
  simulateBeforeSigning?: boolean;
  onSubmitted: (signature: string, transaction: VersionedTransaction) => void;
};

export function sendReceiptSubmission(
  {
    encodedTx,
    connection,
    signAndSendPreparedViaConnection,
    receiptWallet,
    simulateBeforeSigning,
    onSubmitted,
  }: ReceiptSubmissionOptions,
  runtime: typeof DEFAULT_RUNTIME = DEFAULT_RUNTIME,
): Promise<string> {
  receiptWallet?.assertCurrent();
  return runtime.sendPreparedTransaction(
    encodedTx,
    connection,
    (transaction) => signAndSendPreparedViaConnection(transaction, connection, receiptWallet
      ? {
          assertWalletCurrent: receiptWallet.assertCurrent,
          signedSendTimeoutMs: PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS,
          onBroadcastAttempt: receiptWallet.onBroadcastAttempt,
        }
      : undefined),
    { simulateBeforeSigning, onSubmitted },
  );
}
