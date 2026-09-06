import type { ReceiptImageViewerOverlayProps } from '../reveal/types';
import type { useCommerceModals } from './useCommerceModals';
import type { useReceiptActions } from './useReceiptActions';
import type { useReceiptView } from './useReceiptView';
import { RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE } from './transactionSupport';

type ReceiptViewerControls = Pick<ReceiptImageViewerOverlayProps, 'explorerHref' | 'transfer' | 'adminIrlRedeem'>;

export function useReceiptViewerControls({
  receiptView,
  modals,
  receiptActions,
  revealOverlayClosing,
  isClosing,
  showToast,
}: {
  receiptView: ReturnType<typeof useReceiptView>;
  modals: ReturnType<typeof useCommerceModals>;
  receiptActions: ReturnType<typeof useReceiptActions>;
  revealOverlayClosing: boolean;
  isClosing: () => boolean;
  showToast: (message: string) => void;
}): ReceiptViewerControls {
  const { receiptExplorerHref, receiptViewerOperation, receiptTransferActionTarget, adminIrlRedeemOverlayReceipt } = receiptView;
  const {
    adminIrlRedeeming,
    receiptTransferWalletSupported,
    receiptTransferWalletSupportedRef,
    receiptTransferTarget,
    receiptTransferInFlight,
    receiptTransferInFlightRef,
    openReceiptTransfer,
  } = modals;
  const { checkReceiptOperationStatus, handleAdminIrlRedeem } = receiptActions;

  return {
    explorerHref: receiptExplorerHref,
    transfer:
      receiptViewerOperation?.phase === 'unverified' || receiptViewerOperation?.phase === 'checking'
        ? {
            label: receiptViewerOperation.phase === 'checking' ? 'Checking status…' : 'Check status',
            disabled: receiptViewerOperation.phase === 'checking',
            busy: receiptViewerOperation.phase === 'checking',
            onClick: () => {
              checkReceiptOperationStatus(receiptViewerOperation);
            },
          }
        : receiptTransferActionTarget
          ? {
              unavailable:
                adminIrlRedeeming ||
                revealOverlayClosing ||
                !receiptTransferWalletSupported ||
                Boolean(receiptTransferTarget) ||
                receiptTransferInFlight,
              onClick: (opener) => {
                if (revealOverlayClosing || isClosing()) return;
                if (adminIrlRedeeming) {
                  showToast('Wait for Admin IRL Redeem to finish before transferring');
                  return;
                }
                if (!receiptTransferWalletSupported || !receiptTransferWalletSupportedRef.current) {
                  showToast(RECEIPT_TRANSFER_WALLET_UNSUPPORTED_MESSAGE);
                  return;
                }
                if (receiptTransferTarget || receiptTransferInFlightRef.current) return;
                openReceiptTransfer(receiptTransferActionTarget, opener);
              },
            }
          : undefined,
    adminIrlRedeem: adminIrlRedeemOverlayReceipt
      ? {
          loading: adminIrlRedeeming,
          onClick: () => {
            void handleAdminIrlRedeem(adminIrlRedeemOverlayReceipt);
          },
        }
      : undefined,
  };
}
