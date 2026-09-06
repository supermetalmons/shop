import { useCallback } from 'react';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import type { Connection, VersionedTransaction } from '@solana/web3.js';
import {
  confirmSubmittedTransactionByPolling,
  isBlockhashExpiredError,
  isSubmittedTransactionFailureError,
  sendSignedTransactionViaConnection,
} from '../../lib/solana';
import { recoverConnectionSendError, type SendViaConnectionOptions } from './transactionSupport';

export function useWalletTransactions(wallet: WalletContextState, showToast: (message: string) => void) {
  const { sendTransaction } = wallet;
  const signAndSendViaConnection = useCallback(
    async (
      tx: VersionedTransaction,
      targetConnection: Connection,
      options?: SendViaConnectionOptions,
    ): Promise<string | null> => {
      if (wallet.signTransaction) {
        options?.assertWalletCurrent?.();
        const signed = await wallet.signTransaction(tx);
        options?.assertWalletCurrent?.();
        if (options?.signedSendTimeoutMs) {
          return sendSignedTransactionViaConnection(signed, targetConnection, {
            timeoutMs: options.signedSendTimeoutMs,
            sendOptions: {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 3,
            },
            onBroadcastAttempt: (signature) => {
              options.onBroadcastAttempt?.(signature, signed);
            },
          });
        }
        const raw = signed.serialize();
        try {
          return await targetConnection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3,
          });
        } catch (err) {
          return recoverConnectionSendError(signed, targetConnection, err, options);
        }
      }
      if (options?.onBroadcastAttempt) {
        throw new Error('This wallet cannot safely track the transaction before broadcast. Use a wallet with transaction signing support.');
      }
      options?.assertWalletCurrent?.();
      try {
        return await sendTransaction(tx, targetConnection, { skipPreflight: false });
      } catch (err) {
        return recoverConnectionSendError(tx, targetConnection, err, options);
      }
    },
    [sendTransaction, wallet],
  );

  async function sendAndConfirmViaConnection(
    tx: VersionedTransaction,
    targetConnection: Connection,
    options?: SendViaConnectionOptions,
  ): Promise<string | null> {
    const signature = await signAndSendViaConnection(tx, targetConnection, options);
    if (signature) {
      await confirmSubmittedTransactionByPolling(targetConnection, signature);
    }
    return signature;
  }

  async function sendAndConfirmMintViaConnection(
    tx: VersionedTransaction,
    targetConnection: Connection,
    options?: SendViaConnectionOptions,
  ): Promise<boolean> {
    const signature = await signAndSendViaConnection(tx, targetConnection, options);
    if (!signature) return false;
    try {
      await confirmSubmittedTransactionByPolling(targetConnection, signature);
      return false;
    } catch (error) {
      if (isSubmittedTransactionFailureError(error)) return true;
      throw error;
    }
  }

  const signAndSendPreparedViaConnection = useCallback(
    async (
      tx: VersionedTransaction,
      targetConnection: Connection,
      options?: Pick<
        SendViaConnectionOptions,
        'assertWalletCurrent' | 'signedSendTimeoutMs' | 'onBroadcastAttempt'
      >,
    ): Promise<string> => {
      const signature = await signAndSendViaConnection(tx, targetConnection, {
        surfaceSignedSubmissionImmediately: true,
        ...options,
      });
      if (!signature) {
        throw new Error('Wallet submitted the transaction but did not provide a recoverable signature');
      }
      return signature;
    },
    [signAndSendViaConnection],
  );

  async function retryAfterBlockhashExpiry<T>(sendOnce: () => Promise<T>, expiredMessage: string): Promise<T> {
    try {
      return await sendOnce();
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      showToast(expiredMessage);
      return sendOnce();
    }
  }

  return {
    signAndSendViaConnection,
    sendAndConfirmViaConnection,
    sendAndConfirmMintViaConnection,
    signAndSendPreparedViaConnection,
    retryAfterBlockhashExpiry,
  };
}
