import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getPreorderConfig } from '../../../shared/preorders';
import { usePreorderRecovery } from '../../hooks/usePreorderRecovery';
import { usePreorderRecoveryRecords } from '../../hooks/usePreorderRecoveryRecords';
import { revokePreorderInventoryAssets } from '../../lib/inventoryQuery';
import { acknowledgePreorderFailure, listPreorderRecoveries } from '../../lib/preorderRecovery';
import { subscribeBrowserRefreshEvents } from '../../lib/browserRefreshEvents';

const MI_NOTE_DEVNET_PREORDER = getPreorderConfig('mi_note_cards_devnet')!;
const MI_NOTE_MAINNET_PREORDER = getPreorderConfig('mi_note_cards')!;

type ShopPreorderRecoveryOptions = {
  connectedWallet: string | undefined;
  authenticatedWallet: string | undefined;
  isSignedInWallet: boolean;
  isViewerMode: boolean;
  statusUiSuspended: boolean;
  refreshInventoryAfterMint: () => Promise<unknown>;
  showToast: (message: string) => void;
};

export function useShopPreorderRecovery({
  connectedWallet, authenticatedWallet, isSignedInWallet, isViewerMode,
  statusUiSuspended, refreshInventoryAfterMint, showToast,
}: ShopPreorderRecoveryOptions) {
  const recoveryOptions = {
    buyer: connectedWallet,
    signedIn: isSignedInWallet,
    authenticatedBuyer: authenticatedWallet,
    onSettled: () => { void refreshInventoryAfterMint(); },
  };
  usePreorderRecovery({ ...recoveryOptions, config: MI_NOTE_MAINNET_PREORDER });
  usePreorderRecovery({ ...recoveryOptions, config: MI_NOTE_DEVNET_PREORDER });
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
        showToast('A preorder transaction did not finalize.');
        for (const { order } of unseen) notifiedPreorderFailures.current.add(`${order.buyer}:${order.preorderId}:${order.orderId}`);
      }
      for (const { order } of failures) void acknowledgePreorderFailure(order.buyer, order.preorderId, order.orderId).catch(() => {});
    };
    notify();
    const unsubscribeRefreshEvents = subscribeBrowserRefreshEvents(notify);
    return () => {
      unsubscribeRefreshEvents();
    };
  }, [connectedWallet, isSignedInWallet, statusUiSuspended, isViewerMode, preorderRecoveries, showToast]);

}
