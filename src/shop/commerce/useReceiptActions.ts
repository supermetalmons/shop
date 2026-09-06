import type { WalletContextState } from '@solana/wallet-adapter-react';
import type { Connection, VersionedTransaction } from '@solana/web3.js';
import { prepareAdminIrlRedeemTx, finalizeAdminIrlRedeem, prepareReceiptTransferTx } from '../../api/commerce';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { canAdminIrlRedeemCardReceipt, canAdminIrlRedeemSelection, forgetPendingAdminIrlRedeem, rememberPendingAdminIrlRedeem } from '../../lib/adminIrlRedeem';
import { isBlockhashExpiredError, isPotentiallySubmittedTransactionError, isSubmittedTransactionFailureError, reconcileSubmittedTransaction, sendPreparedTransaction, shortAddress } from '../../lib/solana';
import { receiptOperationKey, receiptReconciliationDisposition, type ReceiptOperation } from '../../lib/receiptTransfer';
import type { InventoryItem } from '../../types';
import { ADMIN_VIEWER_READ_ONLY_MESSAGE } from '../account/display';
import type { RevealOverlayState } from '../reveal/types';
import type { CommerceWalletContext, CommerceInventoryRefresh, PreparedTransactionSender, DropConnection } from './contracts';
import type { useCommerceModals } from './useCommerceModals';
import type { useReceiptOperationState } from './useReceiptOperationState';
import { isUserRejectedError, PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS, RECEIPT_STATUS_CHECK_TIMEOUT_MS, RECEIPT_TRANSFER_WALLET_CHANGED_MESSAGE, RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE } from './transactionSupport';

type ReceiptActionOptions = Omit<CommerceWalletContext, 'ownerRef'> & {
  wallet: WalletContextState;
  modals: ReturnType<typeof useCommerceModals>;
  receiptState: ReturnType<typeof useReceiptOperationState>;
  isSignedInWallet: boolean;
  getDropConfig: (dropId?: string) => FrontendDeploymentConfig | undefined;
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
  getDropConnection: DropConnection;
  selectedDropId: string;
  adminIrlRedeemSelection: Omit<Parameters<typeof canAdminIrlRedeemSelection>[0], 'wallet' | 'isSignedInWallet'>;
  deliverableItems: InventoryItem[];
  clearSelection: () => void;
  getCurrentOverlay: () => RevealOverlayState | null;
  closeRevealOverlay: () => void;
  setVisible: (visible: boolean) => void;
  showToast: (message: string) => void;
  markAssetsHidden: (ids: string[]) => void;
  refetchInventory: CommerceInventoryRefresh;
  signAndSendPreparedViaConnection: PreparedTransactionSender;
};

export function useReceiptActions({
  wallet,
  modals,
  receiptState,
  connectedWallet,
  publicKey,
  connectedWalletRef,
  owner,
  ensureSignedIn,
  blockViewerModeAction,
  isSignedInWallet,
  getDropConfig,
  requireKnownDropConfig,
  getDropConnection,
  selectedDropId,
  adminIrlRedeemSelection,
  deliverableItems,
  clearSelection,
  getCurrentOverlay,
  closeRevealOverlay,
  setVisible,
  showToast,
  markAssetsHidden,
  refetchInventory,
  signAndSendPreparedViaConnection,
}: ReceiptActionOptions) {
  const {
    adminIrlRedeeming,
    receiptTransferTarget,
    receiptTransferWalletAdapter,
    receiptTransferWalletSupported,
    receiptTransferWalletSessionGenerationRef,
    receiptTransferWalletAdapterRef,
    receiptTransferWalletSupportedRef,
    receiptTransferInFlightRef,
    setAdminIrlRedeeming,
    setDeliveryOpen,
    setReceiptTransferTarget,
    setReceiptTransferInFlight,
  } = modals;
  const {
    receiptOperationsRef,
    receiptOperationGenerationRef,
    beginReceiptOperation,
    updateReceiptOperation,
    recordReceiptSubmission,
    resetReceiptSubmissionForRetry,
    isReceiptOperationCurrent,
  } = receiptState;
  const assertReceiptTransferWalletReady = (
    expectedWallet: string,
    expectedAdapter: typeof receiptTransferWalletAdapter,
    expectedWalletSessionGeneration: number,
  ) => {
    const adapterWallet = expectedAdapter?.publicKey?.toBase58() || null;
    if (
      receiptTransferWalletSessionGenerationRef.current !== expectedWalletSessionGeneration ||
      connectedWalletRef.current !== expectedWallet ||
      receiptTransferWalletAdapterRef.current !== expectedAdapter ||
      adapterWallet !== expectedWallet
    ) {
      throw new Error(RECEIPT_TRANSFER_WALLET_CHANGED_MESSAGE);
    }
    if (
      !receiptTransferWalletSupportedRef.current ||
      typeof wallet.signTransaction !== 'function' ||
      expectedAdapter?.supportedTransactionVersions?.has(0) !== true
    ) {
      throw new Error(RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE);
    }
  };

  const refreshInventoryAfterReceiptReconciliation = () => {
    void refetchInventory()
      .then((result) => {
        if (result.error) {
          console.warn('[mons] failed to refresh inventory after receipt transfer reconciliation', result.error);
        }
      })
      .catch((refreshErr) => {
        console.warn('[mons] failed to refresh inventory after receipt transfer reconciliation', refreshErr);
      });
  };

  const settleReceiptOperation = (
    operation: ReceiptOperation,
    resolution: Awaited<ReturnType<typeof reconcileSubmittedTransaction>>,
    options?: { manual?: boolean; reconciliationError?: unknown },
  ) => {
    const disposition = receiptReconciliationDisposition(resolution);
    const applied = updateReceiptOperation(operation, (current) => {
      if (disposition === 'available') return null;
      return {
        ...current,
        phase: disposition === 'hidden' ? 'hidden' : 'unverified',
      };
    });
    if (!applied) return;
    if (disposition === 'available' && operation.adminFinalizeRequestId) {
      forgetPendingAdminIrlRedeem(operation.wallet, operation.adminFinalizeRequestId);
    }
    if (connectedWalletRef.current !== operation.wallet) return;

    if (disposition === 'hidden') {
      showToast(
        operation.adminFinalizeRequestId
          ? 'Admin IRL transfer confirmed'
          : operation.signature
            ? `Receipt transfer confirmed · ${shortAddress(operation.signature)}`
            : 'Receipt transfer confirmed',
      );
    } else if (disposition === 'available') {
      showToast(
        operation.adminFinalizeRequestId
          ? 'Admin IRL transfer did not complete · receipt restored'
          : 'Receipt transfer did not complete · receipt restored',
      );
    } else {
      console.warn('[mons] receipt transfer confirmation remains unresolved', {
        signature: operation.signature,
        recentBlockhash: operation.recentBlockhash,
        receiptId: operation.assetId,
        adminFinalizeRequestId: operation.adminFinalizeRequestId || null,
        error: options?.reconciliationError,
      });
      showToast(
        options?.manual
          ? 'Receipt transfer status is still unavailable · no new transfer was sent'
          : operation.adminFinalizeRequestId
            ? 'Admin IRL transfer status could not be verified · receipt is view-only for now'
            : 'Receipt transfer status could not be verified · receipt is view-only for now',
      );
    }
    refreshInventoryAfterReceiptReconciliation();
  };

  const reconcilePendingReceiptSubmission = (args: {
    connection: Connection;
    operation: ReceiptOperation;
  }) => {
    if (!args.operation.signature || !args.operation.recentBlockhash) {
      console.warn('[mons] cannot reconcile pending receipt transfer without submission identifiers', {
        receiptId: args.operation.assetId,
        generation: args.operation.generation,
      });
      settleReceiptOperation(args.operation, 'unknown');
      return;
    }
    void reconcileSubmittedTransaction(args.connection, {
      signature: args.operation.signature,
      recentBlockhash: args.operation.recentBlockhash,
    })
      .then((resolution) => {
        settleReceiptOperation(args.operation, resolution);
      })
      .catch((err) => {
        settleReceiptOperation(args.operation, 'unknown', { reconciliationError: err });
      });
  };

  const checkReceiptOperationStatus = (operation: ReceiptOperation) => {
    if (
      operation.phase !== 'unverified' ||
      !operation.signature ||
      !operation.recentBlockhash ||
      connectedWalletRef.current !== operation.wallet
    ) {
      return;
    }
    const started = updateReceiptOperation(operation, (current) => {
      if (current.phase !== 'unverified') return current;
      return {
        ...current,
        generation: ++receiptOperationGenerationRef.current,
        phase: 'checking',
      };
    });
    const checkingOperation = receiptOperationsRef.current.get(operation.key);
    if (
      !started ||
      !checkingOperation ||
      checkingOperation.phase !== 'checking' ||
      checkingOperation.generation === operation.generation ||
      !checkingOperation.signature ||
      !checkingOperation.recentBlockhash
    ) {
      return;
    }
    let statusConnection: Connection;
    try {
      statusConnection = getDropConnection(checkingOperation.dropId);
    } catch (err) {
      settleReceiptOperation(checkingOperation, 'unknown', { manual: true, reconciliationError: err });
      return;
    }
    void reconcileSubmittedTransaction(
      statusConnection,
      {
        signature: checkingOperation.signature,
        recentBlockhash: checkingOperation.recentBlockhash,
      },
      { timeoutMs: RECEIPT_STATUS_CHECK_TIMEOUT_MS },
    )
      .then((resolution) => {
        settleReceiptOperation(checkingOperation, resolution, { manual: true });
      })
      .catch((err) => {
        settleReceiptOperation(checkingOperation, 'unknown', { manual: true, reconciliationError: err });
      });
  };

  const handleAdminIrlRedeem = async (receiptTarget?: InventoryItem) => {
    if (blockViewerModeAction()) return;
    if (adminIrlRedeeming) return;
    const isReceiptTarget = receiptTarget?.kind === 'certificate';
    const operationWalletAdapter = isReceiptTarget ? receiptTransferWalletAdapter : null;
    const operationWalletSessionGeneration = receiptTransferWalletSessionGenerationRef.current;
    if (receiptTransferInFlightRef.current || receiptTransferTarget) {
      showToast('Finish the receipt transfer first');
      return;
    }
    if (!connectedWallet || !publicKey) {
      setVisible(true);
      return;
    }
    if (isReceiptTarget && !receiptTransferWalletSupported) {
      showToast(RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE);
      return;
    }
    const signedIn = isSignedInWallet ? true : await ensureSignedIn();
    if (!signedIn) return;
    const wallet = publicKey.toBase58();
    if (connectedWalletRef.current !== wallet) return;
    if (isReceiptTarget && receiptTransferWalletAdapterRef.current !== operationWalletAdapter) return;
    if (isReceiptTarget && !receiptTransferWalletSupportedRef.current) {
      showToast(RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE);
      return;
    }
    if (
      isReceiptTarget &&
      receiptOperationsRef.current.has(receiptOperationKey(wallet, receiptTarget.id))
    ) {
      showToast('Check the existing receipt transfer status before starting another action');
      return;
    }
    const currentOverlay = getCurrentOverlay();
    const currentOverlayReceiptCount = currentOverlay?.receiptImages?.length || 0;
    const receiptTargetMatchesOverlay = Boolean(
      isReceiptTarget &&
        currentOverlay?.viewerMode === 'receipt-image' &&
        currentOverlay.imageViewerSize === 'receipt' &&
        currentOverlay.adminIrlRedeemReceipt?.id === receiptTarget.id &&
        currentOverlayReceiptCount === 1 &&
        currentOverlay.receiptImages?.[0]?.key === receiptTarget.id,
    );
    const closeReceiptTargetOverlayIfCurrent = () => {
      if (!isReceiptTarget) return;
      const overlay = getCurrentOverlay();
      if (
        overlay?.viewerMode !== 'receipt-image' ||
        overlay.imageViewerSize !== 'receipt' ||
        overlay.adminIrlRedeemReceipt?.id !== receiptTarget.id ||
        overlay.receiptImages?.length !== 1 ||
        overlay.receiptImages[0]?.key !== receiptTarget.id
      ) {
        return;
      }
      closeRevealOverlay();
    };
    const eligible = isReceiptTarget
      ? canAdminIrlRedeemCardReceipt({
          wallet,
          isSignedInWallet: true,
          selectionOwner: owner,
          receiptCount: receiptTargetMatchesOverlay ? currentOverlayReceiptCount : 0,
          item: receiptTarget,
          dropFamily: getDropConfig(receiptTarget.dropId)?.dropFamily,
        })
      : canAdminIrlRedeemSelection({
          wallet,
          isSignedInWallet: true,
          ...adminIrlRedeemSelection,
        });
    if (!eligible) {
      showToast(
        isReceiptTarget
          ? 'Open one card_nft_2 card receipt to run Admin IRL Redeem'
          : 'Select only card_nft_2 packs for Admin IRL Redeem',
      );
      return;
    }

    const adminIrlDropId = isReceiptTarget ? receiptTarget.dropId : selectedDropId;
    const redeemIds = isReceiptTarget ? [receiptTarget.id] : deliverableItems.map((item) => item.id);
    let pendingFinalizeRequestId = '';
    let pendingFinalizeTransferSignature = '';
    let pendingFinalizeRecentBlockhash = '';
    let pendingFinalizeConnection: Connection | null = null;
    let broadcastAttemptRequestId = '';
    let transferConfirmed = false;
    let receiptOperation: ReceiptOperation | null = null;
    const receiptOperationIsCurrent = () =>
      !isReceiptTarget || isReceiptOperationCurrent(receiptOperation);
    try {
      setAdminIrlRedeeming(true);
      const adminIrlDrop = requireKnownDropConfig(adminIrlDropId, 'Admin IRL redeem selection');
      const adminIrlConnection = getDropConnection(adminIrlDrop.dropId);
      pendingFinalizeConnection = adminIrlConnection;
      if (isReceiptTarget) {
        receiptOperation = beginReceiptOperation({
          wallet,
          assetId: receiptTarget.id,
          dropId: adminIrlDrop.dropId,
        });
      }
      const requestTx = () => {
        if (isReceiptTarget) {
          assertReceiptTransferWalletReady(
            wallet,
            operationWalletAdapter,
            operationWalletSessionGeneration,
          );
        }
        return prepareAdminIrlRedeemTx({
          owner: wallet,
          dropId: adminIrlDrop.dropId,
          itemIds: redeemIds,
        });
      };
      const recordReceiptSubmissionState = (
        phase: Extract<ReceiptOperation['phase'], 'in-flight' | 'hidden'>,
        signature: string,
        submittedTx: VersionedTransaction,
        requestId: string,
      ): boolean => {
        if (!receiptOperation) return false;
        const recorded = recordReceiptSubmission(receiptOperation, {
          phase,
          signature,
          recentBlockhash: submittedTx.message.recentBlockhash,
          adminFinalizeRequestId: requestId,
        });
        receiptOperation = recorded.operation;
        return recorded.applied;
      };

      const submitTransfer = (encodedTx: string, requestId: string): Promise<string> => {
        if (isReceiptTarget) {
          assertReceiptTransferWalletReady(
            wallet,
            operationWalletAdapter,
            operationWalletSessionGeneration,
          );
        }
        return sendPreparedTransaction(
          encodedTx,
          adminIrlConnection,
          (tx) =>
            signAndSendPreparedViaConnection(
              tx,
              adminIrlConnection,
              isReceiptTarget
                ? {
                    assertWalletCurrent: () =>
                      assertReceiptTransferWalletReady(
                        wallet,
                        operationWalletAdapter,
                        operationWalletSessionGeneration,
                      ),
                    signedSendTimeoutMs: PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS,
                    onBroadcastAttempt: (signature, submittedTx) => {
                      recordReceiptSubmissionState('in-flight', signature, submittedTx, requestId);
                      rememberPendingAdminIrlRedeem(wallet, {
                        dropId: adminIrlDrop.dropId,
                        requestId,
                        transferSignature: signature,
                        itemIds: redeemIds,
                      });
                      broadcastAttemptRequestId = requestId;
                    },
                  }
                : undefined,
            ),
          {
            onSubmitted: (submittedSig, submittedTx) => {
              rememberPendingAdminIrlRedeem(wallet, {
                dropId: adminIrlDrop.dropId,
                requestId,
                transferSignature: submittedSig,
                itemIds: redeemIds,
              });
              pendingFinalizeRequestId = requestId;
              pendingFinalizeTransferSignature = submittedSig;
              pendingFinalizeRecentBlockhash = submittedTx.message.recentBlockhash;
              recordReceiptSubmissionState('hidden', submittedSig, submittedTx, requestId);
            },
          },
        );
      };

      let resp = await requestTx();
      let sig: string;
      try {
        sig = await submitTransfer(resp.encodedTx, resp.requestId);
      } catch (err) {
        if (pendingFinalizeRequestId || !isBlockhashExpiredError(err)) throw err;
        if (broadcastAttemptRequestId) {
          forgetPendingAdminIrlRedeem(wallet, broadcastAttemptRequestId);
          broadcastAttemptRequestId = '';
        }
        if (receiptOperation) {
          receiptOperation = resetReceiptSubmissionForRetry(receiptOperation) ?? receiptOperation;
        }
        if (connectedWalletRef.current === wallet && receiptOperationIsCurrent()) {
          showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
        }
        resp = await requestTx();
        sig = await submitTransfer(resp.encodedTx, resp.requestId);
      }

      transferConfirmed = true;
      if (connectedWalletRef.current === wallet && receiptOperationIsCurrent()) {
        if (!isReceiptTarget) markAssetsHidden(redeemIds);
        if (isReceiptTarget) closeReceiptTargetOverlayIfCurrent();
        else clearSelection();
        showToast(`Admin IRL transfer confirmed · finalizing…`);
      }
      const finalized = await finalizeAdminIrlRedeem({
        dropId: adminIrlDrop.dropId,
        requestId: resp.requestId,
        transferSignature: sig,
      });
      forgetPendingAdminIrlRedeem(wallet, resp.requestId);
      pendingFinalizeRequestId = '';
      pendingFinalizeTransferSignature = '';
      pendingFinalizeRecentBlockhash = '';
      broadcastAttemptRequestId = '';

      if (connectedWalletRef.current === wallet && receiptOperationIsCurrent()) {
        const codeCount = Math.max(
          0,
          finalized.claimCodes?.length || finalized.cards?.length || finalized.boxes?.length || redeemIds.length,
        );
        const codeLabel = codeCount === 1 ? 'code' : 'codes';
        const orderSuffix = finalized.deliveryId ? ` · order ${finalized.deliveryId}` : '';
        showToast(`Admin IRL redeem ready${orderSuffix} · ${codeCount} ${codeLabel}`);
        if (!isReceiptTarget) setDeliveryOpen(false);
        await refetchInventory().catch((refreshErr) => {
          console.warn('[mons] failed to refresh inventory after Admin IRL finalization', refreshErr);
        });
      }
    } catch (err) {
      const hadPendingSubmission = Boolean(pendingFinalizeRequestId);
      if (!hadPendingSubmission && broadcastAttemptRequestId) {
        forgetPendingAdminIrlRedeem(wallet, broadcastAttemptRequestId);
        broadcastAttemptRequestId = '';
      }
      if (hadPendingSubmission || !isUserRejectedError(err)) {
        console.error(err);
        if (pendingFinalizeRequestId && isSubmittedTransactionFailureError(err)) {
          forgetPendingAdminIrlRedeem(wallet, pendingFinalizeRequestId);
          pendingFinalizeRequestId = '';
          pendingFinalizeTransferSignature = '';
          pendingFinalizeRecentBlockhash = '';
        }
        if (pendingFinalizeRequestId) {
          if (connectedWalletRef.current === wallet && receiptOperationIsCurrent()) {
            if (isReceiptTarget) closeReceiptTargetOverlayIfCurrent();
            else {
              clearSelection();
              setDeliveryOpen(false);
            }
            void refetchInventory().catch((refreshErr) => {
              console.warn('[mons] failed to refresh inventory after pending Admin IRL redeem transfer', refreshErr);
            });
          }
          console.warn('[mons] Admin IRL redeem transfer submitted but finalization did not complete', {
            dropId: adminIrlDropId,
            requestId: pendingFinalizeRequestId,
            transferSignature: pendingFinalizeTransferSignature,
            error: err,
          });
          if (
            isReceiptTarget &&
            !transferConfirmed &&
            pendingFinalizeConnection &&
            pendingFinalizeRecentBlockhash &&
            receiptOperation
          ) {
            reconcilePendingReceiptSubmission({
              connection: pendingFinalizeConnection,
              operation: receiptOperation,
            });
          }
        }
        if (connectedWalletRef.current === wallet && receiptOperationIsCurrent()) {
          showToast(
            pendingFinalizeRequestId
              ? 'Admin IRL transfer submitted; finalization details saved locally for support'
              : err instanceof Error
                ? err.message
                : 'Failed to run Admin IRL Redeem',
          );
        }
      }
    } finally {
      if (receiptOperation && !pendingFinalizeRequestId && !transferConfirmed) {
        updateReceiptOperation(receiptOperation, () => null);
      }
      setAdminIrlRedeeming(false);
    }
  };
  const handleReceiptTransfer = async (destination: string): Promise<void> => {
    const target = receiptTransferTarget;
    if (!target || target.kind !== 'certificate') {
      throw new Error('Receipt is no longer available to transfer');
    }
    if (adminIrlRedeeming) {
      throw new Error('Wait for Admin IRL Redeem to finish before transferring');
    }
    if (blockViewerModeAction()) {
      throw new Error(ADMIN_VIEWER_READ_ONLY_MESSAGE);
    }
    const operationWalletAdapter = receiptTransferWalletAdapter;
    const operationWalletSessionGeneration = receiptTransferWalletSessionGenerationRef.current;
    const wallet = connectedWallet;
    if (!wallet || owner !== wallet) {
      throw new Error('Connect the receipt owner wallet to transfer');
    }
    if (connectedWalletRef.current !== wallet) {
      throw new Error(RECEIPT_TRANSFER_WALLET_CHANGED_MESSAGE);
    }
    if (receiptTransferWalletAdapterRef.current !== operationWalletAdapter) {
      throw new Error(RECEIPT_TRANSFER_WALLET_CHANGED_MESSAGE);
    }
    if (!receiptTransferWalletSupported || !receiptTransferWalletSupportedRef.current) {
      throw new Error(RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE);
    }
    if (receiptOperationsRef.current.has(receiptOperationKey(wallet, target.id))) {
      throw new Error('Check the existing receipt transfer status before starting another transfer');
    }
    if (receiptTransferInFlightRef.current) {
      throw new Error('A receipt transfer is already in progress');
    }

    receiptTransferInFlightRef.current = true;
    setReceiptTransferInFlight(true);
    let receiptOperation: ReceiptOperation | null = null;
    let submittedSignature = '';
    try {
      const transferDrop = requireKnownDropConfig(target.dropId, 'receipt transfer');
      const transferConnection = getDropConnection(transferDrop.dropId);
      receiptOperation = beginReceiptOperation({
        wallet,
        assetId: target.id,
        dropId: transferDrop.dropId,
      });
      const requestTx = () => {
        assertReceiptTransferWalletReady(
          wallet,
          operationWalletAdapter,
          operationWalletSessionGeneration,
        );
        return prepareReceiptTransferTx({
          owner: wallet,
          dropId: transferDrop.dropId,
          receiptAssetId: target.id,
          destination,
        });
      };
      const recordReceiptSubmissionState = (
        phase: Extract<ReceiptOperation['phase'], 'in-flight' | 'hidden'>,
        signature: string,
        submittedTx: VersionedTransaction,
      ): boolean => {
        if (!receiptOperation) return false;
        const recorded = recordReceiptSubmission(receiptOperation, {
          phase,
          signature,
          recentBlockhash: submittedTx.message.recentBlockhash,
        });
        receiptOperation = recorded.operation;
        return recorded.applied;
      };
      const submitTransfer = (encodedTx: string) => {
        assertReceiptTransferWalletReady(
          wallet,
          operationWalletAdapter,
          operationWalletSessionGeneration,
        );
        return sendPreparedTransaction(
          encodedTx,
          transferConnection,
          (tx) =>
            signAndSendPreparedViaConnection(tx, transferConnection, {
              assertWalletCurrent: () =>
                assertReceiptTransferWalletReady(
                  wallet,
                  operationWalletAdapter,
                  operationWalletSessionGeneration,
                ),
              signedSendTimeoutMs: PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS,
              onBroadcastAttempt: (signature, submittedTx) => {
                recordReceiptSubmissionState('in-flight', signature, submittedTx);
              },
            }),
          {
            simulateBeforeSigning: true,
            onSubmitted: (signature, submittedTx) => {
              submittedSignature = signature;
              const applied = recordReceiptSubmissionState('hidden', signature, submittedTx);
              if (applied && connectedWalletRef.current === wallet) {
                showToast(`Receipt transfer submitted · ${shortAddress(signature)}`);
              }
            },
          },
        );
      };
      const finishPendingTransfer = (signature: string) => {
        if (connectedWalletRef.current === wallet && isReceiptOperationCurrent(receiptOperation)) {
          setReceiptTransferTarget(null);
          closeRevealOverlay();
          showToast(`Receipt transfer submitted · confirmation pending · ${shortAddress(signature)}`);
          void refetchInventory().catch((refreshErr) => {
            console.warn('[mons] failed to refresh inventory after pending receipt transfer', refreshErr);
          });
        }
        if (receiptOperation?.signature && receiptOperation.recentBlockhash) {
          reconcilePendingReceiptSubmission({
            connection: transferConnection,
            operation: receiptOperation,
          });
        } else {
          console.warn('[mons] cannot reconcile pending receipt transfer without its recent blockhash', {
            signature,
            receiptId: target.id,
          });
        }
      };

      const submitWithBlockhashRetry = async (): Promise<string | null> => {
        for (let attempt = 0; ; attempt += 1) {
          const prepared = await requestTx();
          try {
            return await submitTransfer(prepared.encodedTx);
          } catch (err) {
            if (isPotentiallySubmittedTransactionError(err)) {
              submittedSignature = err.signature;
            }
            if (submittedSignature && !isSubmittedTransactionFailureError(err)) {
              finishPendingTransfer(submittedSignature);
              return null;
            }
            if (attempt > 0 || submittedSignature || !isBlockhashExpiredError(err)) throw err;
            if (receiptOperation) {
              receiptOperation = resetReceiptSubmissionForRetry(receiptOperation) ?? receiptOperation;
            }
            if (connectedWalletRef.current === wallet && isReceiptOperationCurrent(receiptOperation)) {
              showToast('Prepared transaction expired. Preparing a fresh one…');
            }
          }
        }
      };

      const signature = await submitWithBlockhashRetry();
      if (!signature) return;

      if (connectedWalletRef.current === wallet && isReceiptOperationCurrent(receiptOperation)) {
        setReceiptTransferTarget(null);
        closeRevealOverlay();
        showToast(`Receipt transferred to ${shortAddress(destination)} · ${shortAddress(signature)}`);
        void refetchInventory().catch((err) => {
          console.warn('[mons] failed to refresh inventory after receipt transfer', err);
        });
      }
    } catch (err) {
      if (receiptOperation && (!submittedSignature || isSubmittedTransactionFailureError(err))) {
        updateReceiptOperation(receiptOperation, () => null);
      }
      throw err;
    } finally {
      receiptTransferInFlightRef.current = false;
      setReceiptTransferInFlight(false);
      if (connectedWalletRef.current !== wallet) {
        setReceiptTransferTarget(null);
      }
    }
  };


  return { handleAdminIrlRedeem, handleReceiptTransfer, checkReceiptOperationStatus };
}
