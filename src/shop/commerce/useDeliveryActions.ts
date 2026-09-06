import { useEffect } from 'react';
import { requestDeliveryTx, issueReceipts } from '../../api/commerce';
import { saveEncryptedAddress } from '../../api/profile';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { encryptAddressPayload, isBlockhashExpiredError, isPotentiallySubmittedTransactionError, sendPreparedTransaction, shortAddress } from '../../lib/solana';
import { isUserRejectedError } from './transactionSupport';
import { isRetryableReceiptIssuanceError, retryWithBackoff } from '../../lib/apiErrors';
import { createPreparedTransactionCoordinator, withBrowserLock } from '../preparedSubmission';
import type { InventoryItem } from '../../types';
import type { CommerceWalletContext, CommerceInventoryRefresh, PreparedTransactionSender, DeliveryRecovery, DropConnection } from './contracts';
import type { usePreparedTransactionState } from './usePreparedTransactionState';
import type { useCommerceModals } from './useCommerceModals';
import type { usePreparedTransactionRecovery } from './usePreparedTransactionRecovery';
import { PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS, createPendingPreparedOperationId, pendingSubmittedTransactionKey } from './transactionSupport';

type DeliveryActionOptions = Omit<CommerceWalletContext, 'owner'> & {
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
  prepared: ReturnType<typeof usePreparedTransactionState>;
  modals: Pick<ReturnType<typeof useCommerceModals>, 'deliveryOpen' | 'setDeliveryOpen' | 'deliveryActionGenerationRef'>;
  recovery: ReturnType<typeof usePreparedTransactionRecovery>;
  selected: Set<string>;
  replaceSelection: (ids: Iterable<string>) => void;
  removeSelected: (ids: Iterable<string>) => void;
  deliverableItems: InventoryItem[];
  canShipSelected: boolean;
  setVisible: (visible: boolean) => void;
  showToast: (message: string) => void;
  addressEncryptionPublicKey: string;
  boxLabelForDropId: (dropId?: string, count?: number) => string;
  figureLabelForDropId: (dropId?: string, count?: number) => string;
  getDropConnection: DropConnection;
  signAndSendPreparedViaConnection: PreparedTransactionSender;
  hideAssetsForWallet: (wallet: string, ids: readonly string[]) => void;
  refetchInventory: CommerceInventoryRefresh;
  refreshProfileState: () => Promise<unknown>;
  runDeliveryRecovery: DeliveryRecovery;
};

export function useDeliveryActions({
  prepared,
  modals,
  recovery,
  connectedWallet,
  publicKey,
  requireKnownDropConfig,
  connectedWalletRef,
  ownerRef,
  ensureSignedIn,
  blockViewerModeAction,
  selected,
  replaceSelection,
  removeSelected,
  deliverableItems,
  canShipSelected,
  setVisible,
  showToast,
  addressEncryptionPublicKey,
  boxLabelForDropId,
  figureLabelForDropId,
  getDropConnection,
  signAndSendPreparedViaConnection,
  hideAssetsForWallet,
  refetchInventory,
  refreshProfileState,
  runDeliveryRecovery,
}: DeliveryActionOptions) {
  const {
    pendingDeliveryItemIds,
    pendingPreparedSubmissionKeysRef,
    readPendingPreparedTransaction,
    rememberPendingPreparedTransaction,
    submitPendingPreparedTransaction,
    forgetPendingPreparedTransaction,
  } = prepared;
  const { deliveryOpen, setDeliveryOpen, deliveryActionGenerationRef } = modals;
  const { startShipmentRefresh, reconcilePendingPreparedTransaction } = recovery;
  useEffect(() => {
    if (!deliveryOpen || canShipSelected || pendingDeliveryItemIds.size) return;
    setDeliveryOpen(false);
  }, [canShipSelected, deliveryOpen, pendingDeliveryItemIds]);
  const handleOpenShip = async () => {
    if (blockViewerModeAction()) return;
    if (!canShipSelected) return;
    const signedIn = await ensureSignedIn();
    if (!signedIn) return;
    deliveryActionGenerationRef.current += 1;
    setDeliveryOpen(true);
  };

  const handleShip = async ({
    formatted,
    country,
    email,
    countryCode,
  }: {
    formatted: string;
    country: string;
    email: string;
    countryCode: string;
  }) => {
    if (blockViewerModeAction()) return;
    if (!canShipSelected) {
      setDeliveryOpen(false);
      return;
    }
    if (!connectedWallet || !publicKey) {
      setVisible(true);
      return;
    }
    if (!selected.size) {
      showToast('Select items to ship');
      return;
    }
    const deliveryWallet = publicKey.toBase58();
    const deliveryGeneration = ++deliveryActionGenerationRef.current;
    const deliverableIds = deliverableItems.map((item) => item.id);
    const deliveryUiIsCurrent = () => (
      deliveryActionGenerationRef.current === deliveryGeneration &&
      connectedWalletRef.current === deliveryWallet &&
      ownerRef.current === deliveryWallet
    );
    const deliveryTransaction = createPreparedTransactionCoordinator('delivery', {
      wallet: deliveryWallet,
      isCurrent: deliveryUiIsCurrent,
      readPending: readPendingPreparedTransaction,
      persistReservation: rememberPendingPreparedTransaction,
      persistSubmission: submitPendingPreparedTransaction,
      forget: forgetPendingPreparedTransaction,
    });
    const {
      assertCurrent: assertDeliveryWalletCurrent,
      recordSubmitted: recordSubmittedDelivery,
      getSubmitted: getSubmittedDelivery,
    } = deliveryTransaction;
    if (!deliverableIds.length) {
      showToast(`Select ${boxLabelForDropId(undefined, 2)} or ${figureLabelForDropId(undefined, 2)} to ship`);
      return;
    }
    const deliveryDropId = deliverableItems[0]?.dropId || '';
    if (!deliveryDropId) {
      showToast('Unable to determine drop for selected items');
      return;
    }
    if (deliverableItems.some((item) => item.dropId !== deliveryDropId)) {
      return;
    }
    const existingPending = deliveryTransaction.readPending(false);
    if (existingPending) {
      if (deliveryUiIsCurrent()) showToast('Another wallet transaction is already pending');
      return;
    }
    if (deliverableIds.length !== selected.size) {
      replaceSelection(deliverableIds);
    }

    const encryptionKey = (addressEncryptionPublicKey || '').trim();
    if (!encryptionKey) {
      showToast('Missing address encryption public key (src/App.tsx)');
      return;
    }

    try {
      const deliveryDrop = requireKnownDropConfig(deliveryDropId, 'delivery selection');
      const deliveryConnection = getDropConnection(deliveryDrop.dropId);
      const signedIn = await ensureSignedIn();
      if (!signedIn) return;
      assertDeliveryWalletCurrent();
      const { cipherText, hint } = encryptAddressPayload(formatted, encryptionKey);
      const saved = await saveEncryptedAddress(cipherText, country, hint, email, countryCode);
      assertDeliveryWalletCurrent();

      const requestTx = async () => {
        assertDeliveryWalletCurrent();
        const prepared = await requestDeliveryTx(
          deliveryWallet,
          { itemIds: deliverableIds, addressId: saved.id },
          deliveryDrop.dropId,
        );
        assertDeliveryWalletCurrent();
        return prepared;
      };
      let resp!: Awaited<ReturnType<typeof requestTx>>;
      const submitDelivery = (encodedTx: string) => sendPreparedTransaction(
        encodedTx,
        deliveryConnection,
        (tx) => signAndSendPreparedViaConnection(tx, deliveryConnection, {
          assertWalletCurrent: assertDeliveryWalletCurrent,
          signedSendTimeoutMs: PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS,
          onBroadcastAttempt: recordSubmittedDelivery,
        }),
        {
          onSubmitted: recordSubmittedDelivery,
        },
      );
      const submitWithBlockhashRetry = async (): Promise<string | null> => {
        for (let attempt = 0; ; attempt += 1) {
          deliveryTransaction.reserve({
            kind: 'delivery',
            phase: 'preparing',
            wallet: deliveryWallet,
            dropId: deliveryDrop.dropId,
            createdAt: Date.now(),
            operationId: createPendingPreparedOperationId(),
            blockhashContextSlot: resp.blockhashContextSlot,
            deliveryId: resp.deliveryId,
            itemIds: [...deliverableIds],
          });
          pendingPreparedSubmissionKeysRef.current.add(deliveryWallet);
          try {
            const signature = await submitDelivery(resp.encodedTx);
            const confirmedSubmission = getSubmittedDelivery();
            if (confirmedSubmission) {
              pendingPreparedSubmissionKeysRef.current.delete(deliveryWallet);
              hideAssetsForWallet(deliveryWallet, deliverableIds);
              forgetPendingPreparedTransaction(confirmedSubmission);
            }
            deliveryTransaction.releaseReservation();
            return signature;
          } catch (err) {
            const pendingSubmission = getSubmittedDelivery();
            pendingPreparedSubmissionKeysRef.current.delete(deliveryWallet);
            if (pendingSubmission && isPotentiallySubmittedTransactionError(err)) {
              deliveryTransaction.releaseReservation();
              startShipmentRefresh(
                pendingSubmission.wallet,
                pendingSubmission.dropId,
                pendingSubmission.deliveryId,
                pendingSubmittedTransactionKey(pendingSubmission),
              );
              if (deliveryUiIsCurrent()) {
                showToast(
                  `Shipment submitted · id ${pendingSubmission.deliveryId} · confirmation pending · ${shortAddress(pendingSubmission.signature)}`,
                );
              }
              const recovery = runDeliveryRecovery({
                dropId: pendingSubmission.dropId,
                deliveryId: pendingSubmission.deliveryId,
                force: true,
              });
              void recovery.catch(() => undefined);
              void reconcilePendingPreparedTransaction(pendingSubmission).catch(() => undefined);
              return null;
            }
            deliveryTransaction.clearReservation();
            if (attempt > 0 || !isBlockhashExpiredError(err)) throw err;
            if (deliveryUiIsCurrent()) {
              showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
            }
            resp = await requestTx();
          }
        }
      };
      const sig = await withBrowserLock(
        `mons:pending-prepared-submission:${deliveryWallet}`,
        async () => {
          assertDeliveryWalletCurrent();
          resp = await requestTx();
          return submitWithBlockhashRetry();
        },
      );
      if (!sig) return;
      const idSuffix = resp.deliveryId ? ` · id ${resp.deliveryId}` : '';
      if (deliveryUiIsCurrent()) showToast(`Shipment submitted${idSuffix} · ${sig}`);

      if (deliveryUiIsCurrent()) {
        setDeliveryOpen(false);
        removeSelected(deliverableIds);
      }
      void refetchInventory().catch((err) => {
        console.warn('[mons] failed to refresh inventory after shipment', err);
      });
      const deliveryId = resp.deliveryId;
      if (deliveryId) {
        startShipmentRefresh(deliveryWallet, deliveryDrop.dropId, deliveryId);
        try {
          if (deliveryUiIsCurrent()) showToast(`Shipment submitted${idSuffix} · ${sig} · issuing receipts…`);
          const issued = await retryWithBackoff(
            () => issueReceipts(deliveryWallet, deliveryId, sig, deliveryDrop.dropId),
            {
              maxAttempts: 3,
              baseDelayMs: 500,
              maxDelayMs: 2_000,
              shouldRetry: isRetryableReceiptIssuanceError,
            },
          );
          const minted = Number(issued?.receiptsMinted || 0);
          if (deliveryUiIsCurrent()) {
            showToast(`Shipment submitted${idSuffix} · ${sig} · receipts issued (${minted})`);
          }
          await Promise.all([
            refetchInventory().catch((err) => {
              console.warn('[mons] failed to refresh inventory after issuing shipment receipts', err);
            }),
            refreshProfileState().catch((err) => {
              console.warn('[mons] failed to refresh shipments after issuing shipment receipts', err);
            }),
          ]);
        } catch (err) {
          console.warn('Direct issueReceipts failed, starting background recovery', err);
          void refreshProfileState().catch((refreshErr) => {
            console.warn('[mons] failed to refresh shipment before recovery', refreshErr);
          });
          void runDeliveryRecovery({
            dropId: deliveryDrop.dropId,
            deliveryId,
            force: true,
          });
          if (deliveryUiIsCurrent()) {
            showToast(`Shipment submitted${idSuffix} · ${sig} · receipts recovering in background`);
          }
        }
      }
    } catch (err) {
      console.error(err);
      if (deliveryUiIsCurrent() && !isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : 'Failed to ship');
      }
    }
  };

  return { handleOpenShip, handleShip };
}
