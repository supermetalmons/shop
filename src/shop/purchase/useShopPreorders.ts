import type { VersionedTransaction } from '@solana/web3.js';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getPreorderConfig } from '../../../shared/preorders';
import { useMiNoteEthereumWallet } from '../../hooks/useMiNoteEthereumWallet';
import { useMiNoteVerification } from '../../hooks/useMiNoteVerification';
import { usePreorderCheckout } from '../../hooks/usePreorderCheckout';
import { usePreorderRecoveryRecords } from '../../hooks/usePreorderRecoveryRecords';
import { revokePreorderInventoryAssets } from '../../lib/inventoryQuery';
import { acknowledgePreorderFailure, listPreorderRecoveries } from '../../lib/preorderRecovery';
import type { ResolvedAppRoute } from '../../routes';

const MI_NOTE_DEVNET_PREORDER = getPreorderConfig('mi_note_cards_devnet')!;
const MI_NOTE_MAINNET_PREORDER = getPreorderConfig('mi_note_cards')!;

type ShopPreordersOptions = {
  preorderId: ResolvedAppRoute['preorderId'];
  connectedWallet: string | undefined;
  authenticatedWallet: string | undefined;
  isSignedInWallet: boolean;
  isViewerMode: boolean;
  commerceUiSuspended: boolean;
  statusUiSuspended: boolean;
  signTransaction: ((transaction: VersionedTransaction) => Promise<VersionedTransaction>) | undefined;
  ensureSignedIn: () => Promise<boolean>;
  refreshInventoryAfterMint: () => Promise<unknown>;
  showToast: (message: string) => void;
  showSuccessHud: (message: string) => void;
};

export function useShopPreorders({
  preorderId,
  connectedWallet,
  authenticatedWallet,
  isSignedInWallet,
  isViewerMode,
  commerceUiSuspended,
  statusUiSuspended,
  signTransaction,
  ensureSignedIn,
  refreshInventoryAfterMint,
  showToast,
  showSuccessHud,
}: ShopPreordersOptions) {
  const miNoteCardsPage = preorderId !== null;
  const preorderConfig = preorderId === MI_NOTE_MAINNET_PREORDER.preorderId ? MI_NOTE_MAINNET_PREORDER : MI_NOTE_DEVNET_PREORDER;
  const preorderActive = miNoteCardsPage && !commerceUiSuspended;
  const ethereumWallet = useMiNoteEthereumWallet(preorderActive);
  const ethereumVerification = useMiNoteVerification(preorderActive, preorderConfig.preorderId, ethereumWallet);
  const preorderOptions = {
    buyer: connectedWallet,
    signedIn: isSignedInWallet,
    authenticatedBuyer: authenticatedWallet,
    ethereumSession: ethereumVerification.session,
    onEthereumSessionInvalid: ethereumVerification.invalidate,
    signTransaction,
    ensureSignedIn,
    onSucceeded: () => {
      showSuccessHud('Preordered');
      void refreshInventoryAfterMint();
    },
    onSettled: () => { void refreshInventoryAfterMint(); },
  };
  const mainnetPreorder = usePreorderCheckout({
    ...preorderOptions,
    config: MI_NOTE_MAINNET_PREORDER,
    active: preorderActive && preorderConfig === MI_NOTE_MAINNET_PREORDER,
    ethereumSession: ethereumVerification.session?.preorderId === MI_NOTE_MAINNET_PREORDER.preorderId ? ethereumVerification.session : null,
  });
  const devnetPreorder = usePreorderCheckout({
    ...preorderOptions,
    config: MI_NOTE_DEVNET_PREORDER,
    active: preorderActive && preorderConfig === MI_NOTE_DEVNET_PREORDER,
    ethereumSession: ethereumVerification.session?.preorderId === MI_NOTE_DEVNET_PREORDER.preorderId ? ethereumVerification.session : null,
  });
  const preorderCheckout = preorderConfig === MI_NOTE_MAINNET_PREORDER ? mainnetPreorder : devnetPreorder;
  const preorderRecoveries = usePreorderRecoveryRecords(connectedWallet ?? authenticatedWallet);
  const inventoryQueryClient = useQueryClient();
  const revokedPreorders = useRef(new Set<string>());
  const notifiedPreorderFailures = useRef(new Set<string>());

  useEffect(() => {
    for (const { order } of preorderRecoveries) {
      if (order.status !== 'failed' && order.status !== 'expired') continue;
      const key = `${order.buyer}:${order.preorderId}:${order.orderId}`;
      if (revokedPreorders.current.has(key)) continue;
      revokedPreorders.current.add(key);
      void revokePreorderInventoryAssets(inventoryQueryClient, order.buyer, order.assets.map(asset => asset.address));
    }
  }, [inventoryQueryClient, preorderRecoveries]);

  useEffect(() => {
    const notify = () => {
      if (!connectedWallet || !isSignedInWallet || statusUiSuspended || isViewerMode || document.visibilityState === 'hidden') return;
      const failures = listPreorderRecoveries(connectedWallet).filter(record => !record.failureNotified && (record.order.status === 'failed' || record.order.status === 'expired'));
      if (!failures.length) return;
      const unseen = failures.filter(({ order }) => !notifiedPreorderFailures.current.has(`${order.buyer}:${order.preorderId}:${order.orderId}`));
      if (unseen.length) {
        showToast('A preorder transaction did not finalize. Select cards to try again.');
        for (const { order } of unseen) notifiedPreorderFailures.current.add(`${order.buyer}:${order.preorderId}:${order.orderId}`);
      }
      for (const { order } of failures) void acknowledgePreorderFailure(order.buyer, order.preorderId, order.orderId).catch(() => {});
    };
    notify();
    window.addEventListener('focus', notify);
    document.addEventListener('visibilitychange', notify);
    return () => {
      window.removeEventListener('focus', notify);
      document.removeEventListener('visibilitychange', notify);
    };
  }, [connectedWallet, isSignedInWallet, statusUiSuspended, isViewerMode, preorderRecoveries, showToast]);

  return { miNoteCardsPage, ethereumWallet, ethereumVerification, preorderCheckout };
}
