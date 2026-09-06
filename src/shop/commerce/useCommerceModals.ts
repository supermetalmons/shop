import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { canSignReceiptTransferTransaction } from '../../lib/receiptTransfer';
import type { InventoryItem } from '../../types';

export function useCommerceModals({
  wallet,
  connectedWallet,
  connectedWalletRef,
  rebaseReceiptOperations,
  claimDeepLinkCode,
  navigate,
}: {
  wallet: WalletContextState;
  connectedWallet: string | undefined;
  connectedWalletRef: RefObject<string | null>;
  rebaseReceiptOperations: (wallet: string) => void;
  claimDeepLinkCode: string | null;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [adminIrlRedeeming, setAdminIrlRedeeming] = useState(false);
  const [deliveryCountryCode, setDeliveryCountryCode] = useState('US');
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimSubmitting, setClaimSubmitting] = useState(false);
  const [claimInitialCode, setClaimInitialCode] = useState('');
  const [claimOpenedFromDeepLink, setClaimOpenedFromDeepLink] = useState(false);
  const [receiptTransferTarget, setReceiptTransferTarget] = useState<InventoryItem | null>(null);
  const [receiptTransferInFlight, setReceiptTransferInFlight] = useState(false);
  const receiptTransferWalletAdapter = wallet.wallet?.adapter ?? null;
  const receiptTransferWalletSupported = canSignReceiptTransferTransaction(
    wallet.signTransaction,
    receiptTransferWalletAdapter?.supportedTransactionVersions,
  );
  const deliveryActionGenerationRef = useRef(0);
  const receiptTransferWalletSupportedRef = useRef(receiptTransferWalletSupported);
  const receiptTransferWalletAdapterRef = useRef(receiptTransferWalletAdapter);
  const receiptTransferReturnFocusRef = useRef<HTMLElement | null>(null);
  const claimModalGenerationRef = useRef(0);
  const receiptTransferWalletSessionGenerationRef = useRef(0);
  const receiptTransferWalletContextRef = useRef({
    wallet: connectedWallet || null,
    adapter: receiptTransferWalletAdapter,
    supported: receiptTransferWalletSupported,
  });
  const receiptTransferInFlightRef = useRef(false);
  useLayoutEffect(() => {
    const nextWallet = connectedWallet || null;
    const previousContext = receiptTransferWalletContextRef.current;
    const walletContextChanged =
      previousContext.wallet !== nextWallet ||
      previousContext.adapter !== receiptTransferWalletAdapter ||
      previousContext.supported !== receiptTransferWalletSupported;
    if (walletContextChanged) {
      deliveryActionGenerationRef.current += 1;
      claimModalGenerationRef.current += 1;
      receiptTransferWalletSessionGenerationRef.current += 1;
      receiptTransferReturnFocusRef.current = null;
      setReceiptTransferTarget(null);
      if (previousContext.wallet) {
        rebaseReceiptOperations(previousContext.wallet);
      }
    }
    receiptTransferWalletContextRef.current = {
      wallet: nextWallet,
      adapter: receiptTransferWalletAdapter,
      supported: receiptTransferWalletSupported,
    };
    connectedWalletRef.current = nextWallet;
    receiptTransferWalletSupportedRef.current = receiptTransferWalletSupported;
    receiptTransferWalletAdapterRef.current = receiptTransferWalletAdapter;
  }, [
    connectedWallet,
    receiptTransferWalletAdapter,
    receiptTransferWalletSupported,
    rebaseReceiptOperations,
  ]);

  useEffect(() => {
    if (claimDeepLinkCode === null) return;
    claimModalGenerationRef.current += 1;
    setClaimInitialCode(claimDeepLinkCode);
    setClaimOpenedFromDeepLink(true);
    setClaimOpen(true);
  }, [claimDeepLinkCode]);

  useEffect(() => {
    if (claimDeepLinkCode !== null || !claimOpenedFromDeepLink) return;
    claimModalGenerationRef.current += 1;
    setClaimOpenedFromDeepLink(false);
    setClaimInitialCode('');
    setClaimOpen(false);
  }, [claimDeepLinkCode, claimOpenedFromDeepLink]);
  const closeClaimModal = useCallback(() => {
    claimModalGenerationRef.current += 1;
    setClaimOpen(false);
    setClaimSubmitting(false);
    setClaimInitialCode('');
    setClaimOpenedFromDeepLink(false);
    if (claimOpenedFromDeepLink || claimDeepLinkCode !== null) {
      navigate('/', { replace: true });
    }
  }, [claimDeepLinkCode, claimOpenedFromDeepLink]);
  const closeReceiptTransferModal = () => {
    if (receiptTransferInFlightRef.current) return;
    setReceiptTransferTarget(null);
  };

  const openDelivery = () => {
    deliveryActionGenerationRef.current += 1;
    setDeliveryOpen(true);
  };
  const closeDelivery = () => {
    deliveryActionGenerationRef.current += 1;
    setDeliveryOpen(false);
  };
  const openClaim = () => {
    claimModalGenerationRef.current += 1;
    setClaimInitialCode('');
    setClaimOpenedFromDeepLink(false);
    setClaimOpen(true);
  };
  const openReceiptTransfer = (target: InventoryItem, opener: HTMLElement) => {
    receiptTransferReturnFocusRef.current = opener;
    setReceiptTransferTarget(target);
  };

  return {
    deliveryOpen,
    deliveryCountryCode,
    adminIrlRedeeming,
    claimOpen,
    claimSubmitting,
    claimInitialCode,
    receiptTransferTarget,
    receiptTransferInFlight,
    receiptTransferWalletAdapter,
    receiptTransferWalletSupported,
    receiptTransferWalletSupportedRef,
    receiptTransferWalletAdapterRef,
    receiptTransferReturnFocusRef,
    receiptTransferWalletSessionGenerationRef,
    receiptTransferInFlightRef,
    deliveryActionGenerationRef,
    claimModalGenerationRef,
    setDeliveryOpen,
    setDeliveryCountryCode,
    setAdminIrlRedeeming,
    setClaimSubmitting,
    setReceiptTransferTarget,
    setReceiptTransferInFlight,
    openDelivery,
    closeDelivery,
    openClaim,
    closeClaimModal,
    openReceiptTransfer,
    closeReceiptTransferModal,
  };
}
