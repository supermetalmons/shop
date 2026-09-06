import { useMemo } from 'react';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { canAdminIrlRedeemCardReceipt } from '../../lib/adminIrlRedeem';
import { canonicalReceiptPublicKey, receiptOperationKey, resolveReceiptTransferTarget, type ReceiptOperationRegistry } from '../../lib/receiptTransfer';
import { solanaExplorerAddressUrl } from '../../lib/solanaExplorer';
import type { InventoryItem } from '../../types';
import type { RevealOverlayState } from '../reveal/types';

export function useReceiptView({
  connectedWallet,
  owner,
  isSignedInWallet,
  isViewerMode,
  getDropConfig,
  inventory,
  receiptOperations,
  revealOverlay,
  receiptTransferTarget,
}: {
  connectedWallet: string | undefined;
  owner: string | undefined;
  isSignedInWallet: boolean;
  isViewerMode: boolean;
  getDropConfig: (dropId?: string) => FrontendDeploymentConfig | undefined;
  inventory: InventoryItem[];
  receiptOperations: ReceiptOperationRegistry;
  revealOverlay: RevealOverlayState | null;
  receiptTransferTarget: InventoryItem | null;
}) {
  const receiptViewerOperation = useMemo(() => {
    if (!connectedWallet) return null;
    if (revealOverlay?.viewerMode !== 'receipt-image' || revealOverlay.imageViewerSize !== 'receipt') return null;
    const receiptImages = revealOverlay.receiptImages || [];
    if (receiptImages.length !== 1) return null;
    const wallet = canonicalReceiptPublicKey(connectedWallet);
    const assetId = canonicalReceiptPublicKey(receiptImages[0]?.key);
    if (!wallet || !assetId) return null;
    return receiptOperations.get(receiptOperationKey(wallet, assetId)) ?? null;
  }, [connectedWallet, receiptOperations, revealOverlay]);
  const adminIrlRedeemOverlayReceipt = useMemo(() => {
    if (revealOverlay?.viewerMode !== 'receipt-image' || revealOverlay.imageViewerSize !== 'receipt') return null;
    if (receiptViewerOperation) return null;
    const receipt = revealOverlay.adminIrlRedeemReceipt;
    const receiptImages = revealOverlay.receiptImages || [];
    if (!receipt || receiptImages.length !== 1 || receiptImages[0]?.key !== receipt.id) return null;
    return canAdminIrlRedeemCardReceipt({
      wallet: connectedWallet,
      isSignedInWallet,
      selectionOwner: owner,
      receiptCount: receiptImages.length,
      item: receipt,
      dropFamily: getDropConfig(receipt.dropId)?.dropFamily,
    })
      ? receipt
      : null;
  }, [connectedWallet, getDropConfig, isSignedInWallet, owner, receiptViewerOperation, revealOverlay]);
  const receiptExplorerHref = useMemo(() => {
    if (revealOverlay?.viewerMode !== 'receipt-image' || revealOverlay.imageViewerSize !== 'receipt') return undefined;
    const receiptImages = revealOverlay.receiptImages || [];
    if (receiptImages.length !== 1) return undefined;
    const receiptId = receiptImages[0]?.key;
    const cluster = getDropConfig(revealOverlay.dropId)?.solanaCluster;
    return receiptId && cluster ? solanaExplorerAddressUrl(receiptId, cluster) ?? undefined : undefined;
  }, [getDropConfig, revealOverlay]);
  const transferableReceipt = useMemo(
    () =>
      resolveReceiptTransferTarget({
        wallet: connectedWallet,
        inventoryOwner: owner,
        inventoryItems: inventory,
        dropId: revealOverlay?.dropId,
        viewerMode: revealOverlay?.viewerMode,
        viewerSize: revealOverlay?.imageViewerSize,
        receiptImages: revealOverlay?.receiptImages,
        isAdminReadOnly: isViewerMode,
      }),
    [connectedWallet, inventory, isViewerMode, owner, revealOverlay],
  );
  const receiptTransferActionTarget =
    transferableReceipt ||
    (receiptTransferTarget &&
      revealOverlay?.viewerMode === 'receipt-image' &&
      revealOverlay.imageViewerSize === 'receipt' &&
      revealOverlay.dropId === receiptTransferTarget.dropId &&
      revealOverlay.receiptImages?.length === 1 &&
      revealOverlay.receiptImages[0]?.key === receiptTransferTarget.id
      ? receiptTransferTarget
      : null);

  return { receiptViewerOperation, adminIrlRedeemOverlayReceipt, receiptExplorerHref, receiptTransferActionTarget };
}
