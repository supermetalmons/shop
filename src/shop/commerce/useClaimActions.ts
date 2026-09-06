import { PublicKey, type Connection } from '@solana/web3.js';
import { claimStripeReceipt, requestClaimTx } from '../../api/commerce';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { isBlockhashExpiredError, isPotentiallySubmittedTransactionError, sendPreparedTransaction, shortAddress } from '../../lib/solana';
import { pendingSubmittedClaim } from '../../lib/pendingPreparedTransactions';
import { hasAlphabeticClaimCodeCharacters, isStripeReceiptClaimCode } from '../../lib/stripeReceiptClaims';
import type { InventoryItem } from '../../types';
import { createPreparedTransactionCoordinator, withBrowserLock } from '../preparedSubmission';
import type { CommerceWalletContext, CommerceInventoryRefresh, PreparedTransactionSender, DropConnection } from './contracts';
import type { usePreparedTransactionState } from './usePreparedTransactionState';
import type { useCommerceModals } from './useCommerceModals';
import type { useReceiptOperationState } from './useReceiptOperationState';
import type { usePreparedTransactionRecovery } from './usePreparedTransactionRecovery';
import type { useClaimPresentation } from './useClaimPresentation';
import { PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS, createPendingPreparedOperationId } from './transactionSupport';

type ClaimActionOptions = CommerceWalletContext & {
  prepared: ReturnType<typeof usePreparedTransactionState>;
  modals: Pick<ReturnType<typeof useCommerceModals>, 'claimModalGenerationRef' | 'closeClaimModal'>;
  receiptState: Pick<ReturnType<typeof useReceiptOperationState>, 'receiptOperationGenerationRef' | 'clearAuthoritativelyReturnedReceiptOperations'>;
  recovery: ReturnType<typeof usePreparedTransactionRecovery>;
  presentConfirmedNumericClaim: ReturnType<typeof useClaimPresentation>;
  inventory: InventoryItem[];
  refetchInventory: CommerceInventoryRefresh;
  unhideAssetsForWallet: (wallet: string, ids: readonly string[]) => void;
  requestClaimSignIn: () => void;
  showToast: (message: string) => void;
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
  getDropConnection: DropConnection;
  signAndSendPreparedViaConnection: PreparedTransactionSender;
};

export function useClaimActions({
  prepared,
  modals,
  receiptState,
  recovery,
  presentConfirmedNumericClaim,
  connectedWallet,
  publicKey,
  connectedWalletRef,
  owner,
  ownerRef,
  ensureSignedIn,
  blockViewerModeAction,
  inventory,
  refetchInventory,
  unhideAssetsForWallet,
  requestClaimSignIn,
  showToast,
  requireKnownDropConfig,
  getDropConnection,
  signAndSendPreparedViaConnection,
}: ClaimActionOptions) {
  const {
    pendingPreparedSubmissionKeysRef,
    readPendingPreparedTransaction,
    rememberPendingPreparedTransaction,
    submitPendingPreparedTransaction,
    forgetPendingPreparedTransaction,
  } = prepared;
  const { claimModalGenerationRef, closeClaimModal } = modals;
  const { receiptOperationGenerationRef, clearAuthoritativelyReturnedReceiptOperations } = receiptState;
  const { reconcilePendingPreparedTransaction } = recovery;
  const handleClaim = async ({ code, recipient }: { code: string; recipient?: string }) => {
    if (blockViewerModeAction()) return { deferred: true };
    const claimGeneration = claimModalGenerationRef.current;
    const receiptOperationCreatedGenerationAtClaimStart = receiptOperationGenerationRef.current;
    const claimUiIsCurrent = () => claimModalGenerationRef.current === claimGeneration;
    if (isStripeReceiptClaimCode(code)) {
      let recipientWallet: string;
      try {
        recipientWallet = new PublicKey(String(recipient || '').trim()).toBase58();
      } catch {
        throw new Error('Invalid receiver address');
      }

      const result = await claimStripeReceipt({ code, recipient: recipientWallet });
      const returnedReceiptAssetIds = result.receiptAssetIds || [];
      unhideAssetsForWallet(recipientWallet, returnedReceiptAssetIds);
      clearAuthoritativelyReturnedReceiptOperations(
        recipientWallet,
        returnedReceiptAssetIds,
        receiptOperationCreatedGenerationAtClaimStart,
      );
      const count = Math.max(0, Math.floor(Number(result.receiptsTransferred || 0)));
      const displayCount = count || 1;
      const receiptBaseLabel = result.receiptKind === 'figure' ? 'card receipt' : 'receipt';
      const receiptLabel = displayCount === 1 ? receiptBaseLabel : `${receiptBaseLabel}s`;
      if (claimUiIsCurrent()) {
        closeClaimModal();
        showToast(`Claim submitted · ${displayCount} ${receiptLabel} sent to ${shortAddress(recipientWallet)}`);
      }
      if (owner && (owner === recipientWallet || returnedReceiptAssetIds.length)) {
        void refetchInventory().catch((err) => {
          console.warn('[mons] failed to refresh inventory after receipt claim', err);
        });
      }
      return { deferred: true };
    }
    if (hasAlphabeticClaimCodeCharacters(code)) {
      throw new Error('Invalid receipt claim code');
    }
    if (!connectedWallet || !publicKey) requestClaimSignIn();
    const signedIn = await ensureSignedIn();
    if (!signedIn || !connectedWallet || !publicKey) return { deferred: true };
    if (!claimUiIsCurrent()) return { deferred: true };
    const previousReceiptIds = new Set(inventory.filter((item) => item.kind === 'certificate').map((item) => item.id));
    const claimWallet = publicKey.toBase58();
    const numericClaimUiIsCurrent = () => (
      claimUiIsCurrent() &&
      connectedWalletRef.current === claimWallet &&
      ownerRef.current === claimWallet
    );
    const claimTransaction = createPreparedTransactionCoordinator('claim', {
      wallet: claimWallet,
      isCurrent: numericClaimUiIsCurrent,
      readPending: readPendingPreparedTransaction,
      persistReservation: rememberPendingPreparedTransaction,
      persistSubmission: submitPendingPreparedTransaction,
      forget: forgetPendingPreparedTransaction,
    });
    const {
      assertCurrent: assertClaimReservationCurrent,
      recordSubmitted: recordSubmittedClaim,
      getSubmitted: getSubmittedClaim,
    } = claimTransaction;
    const existingPending = claimTransaction.readPending();
    const existingPendingClaim = pendingSubmittedClaim(existingPending, claimWallet);
    if (existingPendingClaim) {
      if (numericClaimUiIsCurrent()) {
        showToast(`Checking pending claim · ${shortAddress(existingPendingClaim.signature)}`);
      }
      const resolution = await reconcilePendingPreparedTransaction(existingPendingClaim, {
        claimUiIsCurrent: numericClaimUiIsCurrent,
        previousReceiptIds,
      });
      if (resolution === 'confirmed') {
        if (numericClaimUiIsCurrent()) {
          return presentConfirmedNumericClaim(
            existingPendingClaim,
            previousReceiptIds,
            numericClaimUiIsCurrent,
          );
        }
        return { deferred: true };
      }
      if (resolution === 'unknown') return { deferred: true };
      if (!numericClaimUiIsCurrent()) return { deferred: true };
    } else if (existingPending) {
      if (numericClaimUiIsCurrent()) showToast('Another wallet transaction is already pending');
      return { deferred: true };
    }
    const requestTx = async () => {
      assertClaimReservationCurrent();
      const prepared = await requestClaimTx(claimWallet, code);
      assertClaimReservationCurrent();
      return prepared;
    };
    let resp!: Awaited<ReturnType<typeof requestTx>>;
    let claimDrop!: FrontendDeploymentConfig;
    let claimConnection!: Connection;
    const submitClaim = (encodedTx: string, connection: Connection) => sendPreparedTransaction(
      encodedTx,
      connection,
      (tx) => signAndSendPreparedViaConnection(tx, connection, {
        assertWalletCurrent: assertClaimReservationCurrent,
        signedSendTimeoutMs: PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS,
        onBroadcastAttempt: recordSubmittedClaim,
      }),
      {
        onSubmitted: recordSubmittedClaim,
      },
    );
    const claimDeferred = await withBrowserLock(
      `mons:pending-prepared-submission:${claimWallet}`,
      async () => {
        assertClaimReservationCurrent();
        resp = await requestTx();
        if (!numericClaimUiIsCurrent()) return true;
        claimDrop = requireKnownDropConfig(resp.dropId, 'claim transaction response');
        claimConnection = getDropConnection(claimDrop.dropId);
        for (let attempt = 0; ; attempt += 1) {
          claimTransaction.reserve({
            kind: 'claim',
            phase: 'preparing',
            wallet: claimWallet,
            dropId: claimDrop.dropId,
            createdAt: Date.now(),
            operationId: createPendingPreparedOperationId(),
            blockhashContextSlot: resp.blockhashContextSlot,
            certificates: [...resp.certificates],
            certificateId: resp.certificateId,
          });
          pendingPreparedSubmissionKeysRef.current.add(claimWallet);
          try {
            await submitClaim(resp.encodedTx, claimConnection);
            const confirmedSubmission = getSubmittedClaim();
            if (confirmedSubmission) {
              pendingPreparedSubmissionKeysRef.current.delete(claimWallet);
              forgetPendingPreparedTransaction(confirmedSubmission);
            }
            claimTransaction.releaseReservation();
            return false;
          } catch (err) {
            const pendingSubmission = getSubmittedClaim();
            pendingPreparedSubmissionKeysRef.current.delete(claimWallet);
            if (pendingSubmission && isPotentiallySubmittedTransactionError(err)) {
              claimTransaction.releaseReservation();
              if (numericClaimUiIsCurrent()) {
                showToast(`Claim submitted · confirmation pending · ${shortAddress(pendingSubmission.signature)}`);
              }
              void reconcilePendingPreparedTransaction(pendingSubmission, {
                claimUiIsCurrent: numericClaimUiIsCurrent,
                previousReceiptIds,
              });
              return true;
            }
            claimTransaction.clearReservation();
            if (attempt > 0 || !isBlockhashExpiredError(err)) throw err;
            if (!numericClaimUiIsCurrent()) return true;
            showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
            resp = await requestTx();
            if (!numericClaimUiIsCurrent()) return true;
            claimDrop = requireKnownDropConfig(resp.dropId, 'claim transaction retry response');
            claimConnection = getDropConnection(claimDrop.dropId);
          }
        }
      },
    );
    if (claimDeferred) return { deferred: true };
    const confirmedClaim = getSubmittedClaim();
    if (!confirmedClaim) throw new Error('Claim confirmed without a recoverable submission');
    return presentConfirmedNumericClaim(confirmedClaim, previousReceiptIds, numericClaimUiIsCurrent);
  };

  return { handleClaim };
}
