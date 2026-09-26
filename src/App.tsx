import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useQueryClient } from '@tanstack/react-query';
import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { NfcClaimPage } from './components/NfcClaimPage';
import { NotifySubscription } from './components/NotifySubscription';
import { ShopHeader } from './components/ShopHeader';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { usePreorderCheckout } from './hooks/usePreorderCheckout';
import { usePreorderRecoveryRecords } from './hooks/usePreorderRecoveryRecords';
import { acknowledgePreorderFailure, listPreorderRecoveries } from './lib/preorderRecovery';
import { revokePreorderInventoryAssets } from './lib/inventoryQuery';
import { useMiNoteEthereumWallet } from './hooks/useMiNoteEthereumWallet';
import { useMiNoteVerification } from './hooks/useMiNoteVerification';
import { getPreorderConfig } from '../shared/preorders';
import { useStripeCheckoutInventoryRecovery } from './hooks/useStripeCheckoutInventoryRecovery';
import { useStripeCheckoutRecovery } from './hooks/useStripeCheckoutRecovery';
import {
  isModalLayerSuspended,
  resolveActiveModalLayer,
  shouldToastAppearAboveModal,
} from './lib/modalLayers';
import { navigate } from './navigation';
import { ADMIN_VIEWER_READ_ONLY_MESSAGE } from './shop/account/display';
import { useDeliveryRecovery } from './shop/account/useDeliveryRecovery';
import { useShopAccount, useShopAccountEffects } from './shop/account/useShopAccount';
import { useShopShipments } from './shop/account/useShopShipments';
import { useShopSignIn } from './shop/account/useShopSignIn';
import { useShopActionContinuation } from './shop/account/useShopActionContinuation';
import { useShopActionHandlers } from './shop/useShopActionHandlers';
import { isUserRejectedError } from './shop/commerce/transactionSupport';
import { useClaimActions } from './shop/commerce/useClaimActions';
import { useClaimPresentation } from './shop/commerce/useClaimPresentation';
import { useCommerceModals } from './shop/commerce/useCommerceModals';
import { useDeliveryActions } from './shop/commerce/useDeliveryActions';
import { usePreparedTransactionRecovery } from './shop/commerce/usePreparedTransactionRecovery';
import { usePreparedTransactionState } from './shop/commerce/usePreparedTransactionState';
import { useReceiptActions } from './shop/commerce/useReceiptActions';
import { useReceiptOperationState } from './shop/commerce/useReceiptOperationState';
import { useReceiptView } from './shop/commerce/useReceiptView';
import { useReceiptViewerControls } from './shop/commerce/useReceiptViewerControls';
import { useWalletTransactions } from './shop/commerce/useWalletTransactions';
import { useShopInventoryQueries } from './shop/inventory/useShopInventoryQueries';
import { useShopInventorySelection, useShopInventorySelectionState } from './shop/inventory/useShopInventorySelection';
import { useShopInventoryMaintenance, useShopInventorySource } from './shop/inventory/useShopInventorySource';
import { useShopInventoryView } from './shop/inventory/useShopInventoryView';
import { useShopPurchaseActions } from './shop/purchase/useShopPurchaseActions';
import { useEffectiveMintStats, useShopPurchaseState } from './shop/purchase/useShopPurchaseState';
import { ShopRevealLayer } from './shop/reveal/ShopRevealLayer';
import { useShopReveal } from './shop/reveal/useShopReveal';
import { useShopRevealPreloading } from './shop/reveal/useShopRevealPreloading';
import { ShopCommerceModals } from './shop/ui/ShopCommerceModals';
import { ShopHeaderActions } from './shop/ui/ShopHeaderActions';
import { ShopInventorySection } from './shop/ui/ShopInventorySection';
import { ShopPurchaseSection } from './shop/ui/ShopPurchaseSection';
import { ShopReceiptsSection } from './shop/ui/ShopReceiptsSection';
import { ShopSelectionBar } from './shop/ui/ShopSelectionBar';
import { ShopShipmentsEmptyState } from './shop/ui/ShopShipmentsEmptyState';
import { ShopShipmentsSection } from './shop/ui/ShopShipmentsSection';
import { ShopStatus } from './shop/ui/ShopStatus';
import { useShopFeedback } from './shop/ui/useShopFeedback';
import { useShopNotifications } from './shop/ui/useShopNotifications';
import { useShopDrop } from './shop/useShopDrop';

const ADDRESS_ENCRYPTION_PUBLIC_KEY = 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=';
const MiNoteCardsGallery = lazy(() => import('./components/MiNoteCardsGallery'));
const MI_NOTE_DEVNET_PREORDER = getPreorderConfig('mi_note_cards_devnet')!;
const MI_NOTE_MAINNET_PREORDER = getPreorderConfig('mi_note_cards')!;

class MiNoteCardsErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type AppProps = {
  currentPath?: string;
  claimDeepLinkCode?: string | null;
  nfcDeepLinkCode?: string | null;
  suspended?: boolean;
};

function App({ currentPath, claimDeepLinkCode = null, nfcDeepLinkCode = null, suspended = false }: AppProps) {
  const wallet = useWallet();
  const { visible: walletModalVisible, setVisible } = useWalletModal();
  const { publicKey } = wallet;
  const connectedWallet = wallet.connected ? publicKey?.toBase58() : undefined;
  const connectedWalletRef = useRef<string | null>(connectedWallet || null);
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const statusUiSuspended = suspended || walletModalVisible;
  const auth = useSolanaAuth();
  const drop = useShopDrop(currentPath);
  const isNfcPage = drop.normalizedCurrentPath === '/nfc';
  const commerceUiSuspended = suspended || isNfcPage;
  const feedback = useShopFeedback(statusUiSuspended);
  const { showToast, showSuccessHud } = feedback;
  const purchaseState = useShopPurchaseState(drop);
  const stripeRecovery = useStripeCheckoutRecovery({
    auth,
    connectedWallet,
    dropId: drop.routeDrop?.dropId,
    mintStats: purchaseState.mintStats,
    shouldFetchMintStats: purchaseState.shouldFetchMintStats,
    refetchStats: purchaseState.refetchStats,
    onCompleted: showSuccessHud,
  });
  const account = useShopAccount({ auth, connectedWallet, stripeCheckoutDataOwner: stripeRecovery.dataOwner });
  const { owner, localAccountWallet, isViewerMode, isSignedInWallet } = account;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const queries = useShopInventoryQueries(owner, account.includeDevnetInventory, isViewerMode);
  const stripeCheckoutInventoryRefreshPending = useStripeCheckoutInventoryRecovery({
    recoveredProfile: stripeRecovery.recoveredProfile,
    owner,
    inventoryDataUpdatedAt: queries.inventoryDataUpdatedAt,
    inventoryFetched: queries.inventoryFetched,
    inventoryFetching: queries.inventoryFetching,
  });
  const effectiveMintStats = useEffectiveMintStats({
    routeDrop: drop.routeDrop,
    mintStats: purchaseState.mintStats,
    stripeCheckoutOptimisticMintProgress: stripeRecovery.optimisticMintProgress,
  });
  const inventorySource = useShopInventorySource({
    ...queries, owner, connectedWallet, localAccountWallet, isViewerMode,
    requireKnownDropConfig: drop.requireKnownDropConfig,
  });
  const selectionState = useShopInventorySelectionState({ connectedWallet, owner });
  const prepared = usePreparedTransactionState(connectedWallet, connectedWalletRef);
  const receiptState = useReceiptOperationState(connectedWallet);
  const modals = useCommerceModals({
    wallet, connectedWallet, connectedWalletRef,
    rebaseReceiptOperations: receiptState.rebaseReceiptOperations,
    claimDeepLinkCode, navigate,
  });
  useShopAccountEffects(account);
  const blockViewerModeAction = () => {
    if (!isViewerMode) return false;
    showToast(ADMIN_VIEWER_READ_ONLY_MESSAGE);
    return true;
  };
  const signIn = useShopSignIn({
    auth, connectedWallet, publicKey, wallet, walletModalVisible, setVisible,
    isSignedInWallet, hasAuthenticatedAccount: account.hasAuthenticatedAccount,
    showToast, isUserRejectedError,
  });
  const continuation = useShopActionContinuation({
    connectedWallet,
    cancellationSignal: auth.intentCancellationSignal,
    scopeKey: `${drop.normalizedCurrentPath}:${commerceUiSuspended}`,
    ensureSignedIn: signIn.ensureSignedIn,
    ensureWalletConnected: signIn.ensureWalletConnected,
    showToast,
  });
  const pendingAction = continuation.pendingAction;
  const walletActionBusy = Boolean(pendingAction);
  const awaitingActionSignIn = pendingAction?.phase === 'authenticating';
  const preserveDelivery = awaitingActionSignIn && pendingAction.key === 'ship';
  const preorderConfig = drop.normalizedCurrentPath === '/mi_note_cards' ? MI_NOTE_MAINNET_PREORDER : MI_NOTE_DEVNET_PREORDER;
  const preorderActive = ['/mi_note_cards', '/mi_note_cards_devnet'].includes(drop.normalizedCurrentPath) && !commerceUiSuspended;
  const ethereumWallet = useMiNoteEthereumWallet(preorderActive);
  const ethereumVerification = useMiNoteVerification(preorderActive, preorderConfig.preorderId, ethereumWallet);
  const preorderOptions = {
    buyer: connectedWallet,
    signedIn: isSignedInWallet,
    authenticatedBuyer: account.authenticatedWallet,
    ethereumSession: ethereumVerification.session,
    onEthereumSessionInvalid: ethereumVerification.invalidate,
    signTransaction: wallet.signTransaction,
    ensureSignedIn: continuation.ensureActionSignedIn,
    onSucceeded: () => {
      showSuccessHud('Preordered');
      void queries.refreshInventoryAfterMint();
    },
    onSettled: () => { void queries.refreshInventoryAfterMint(); },
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
  const preorderRecoveries = usePreorderRecoveryRecords(connectedWallet ?? account.authenticatedWallet);
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
    return () => { window.removeEventListener('focus', notify); document.removeEventListener('visibilitychange', notify); };
  }, [connectedWallet, isSignedInWallet, statusUiSuspended, isViewerMode, preorderRecoveries, showToast]);
  const transactions = useWalletTransactions(wallet, showToast);
  const runDeliveryRecovery = useDeliveryRecovery({
    auth,
    authenticatedWallet: account.authenticatedWallet,
    hasAuthenticatedAccount: account.hasAuthenticatedAccount,
    isViewerMode,
    currentOwnerDeliveryRecoveryNextCheckAt: account.currentOwnerDeliveryRecoveryNextCheckAt,
    refetchInventory: queries.refetchInventory,
  });
  const reveal = useShopReveal({
    ...drop, ...inventorySource.actions,
    clearSelection: selectionState.clearSelection,
    connectedWallet, publicKey, owner, localAccountWallet, isViewerMode, suspended: commerceUiSuspended,
    walletModalVisible, receiptTransferOpen: Boolean(modals.receiptTransferTarget),
    inventory: queries.inventory, pendingOpenBoxes: queries.pendingOpenBoxes,
    figureMetadataByKey: inventorySource.figureMetadataByKey,
    refetchInventory: queries.refetchInventory,
    refetchPendingOpenBoxes: queries.refetchPendingOpenBoxes,
    ensureSignedIn: continuation.ensureActionSignedIn,
    openWalletModal: () => setVisible(true),
    showToast, blockViewerModeAction,
    sendAndConfirmViaConnection: transactions.sendAndConfirmViaConnection,
    retryAfterBlockhashExpiry: transactions.retryAfterBlockhashExpiry,
  });
  const notifications = useShopNotifications(drop.normalizedCurrentPath, Boolean(drop.upcomingDropRoute), reveal.revealOverlayOpen);
  const activeModalLayer = resolveActiveModalLayer({
    wallet: walletModalVisible,
    transfer: Boolean(modals.receiptTransferTarget),
    reveal: reveal.revealOverlayOpen && !reveal.revealOverlayClosing,
    claim: modals.claimOpen,
    shipment: modals.deliveryOpen,
    notify: notifications.notifyOpen,
  });
  useShopInventoryMaintenance(inventorySource, reveal);
  const inventory = useShopInventoryView({
    ...drop,
    source: inventorySource,
    inventoryView: reveal.inventoryView,
    pendingOpenBoxesView: reveal.pendingOpenBoxesView,
    receiptOperationHiddenAssets: receiptState.receiptOperationHiddenAssets,
    stripeCheckoutInventoryRefreshPending,
    stripeCheckoutProfileRecoveryPending: stripeRecovery.profileRecoveryPending,
    walletIdleReady: signIn.walletIdleReady,
    authReady: signIn.authReady,
    boxImageForDropId: reveal.boxImageForDropId,
  });
  const selection = useShopInventorySelection({
    state: selectionState,
    inventoryView: reveal.inventoryView,
    inventoryIndex: inventory.inventoryIndex,
    pendingRevealIds: inventory.pendingRevealIds,
    pendingDeliveryItemIds: prepared.pendingDeliveryItemIds,
    owner, connectedWallet, isSignedInWallet,
    deliveryCountryCode: modals.deliveryCountryCode,
    dismissalBlocked: Boolean(activeModalLayer) || commerceUiSuspended,
    onDismissSelection: continuation.cancel,
    getDropConfig: drop.getDropConfig,
    canOpenBoxesForDropId: drop.canOpenBoxesForDropId,
    usesClearCard3dRevealForDropId: reveal.usesClearCard3dRevealForDropId,
    usesInteractiveCardPackRevealForDropId: reveal.usesInteractiveCardPackRevealForDropId,
  });
  useShopRevealPreloading(reveal, inventory.shouldPreloadBoxFramesInitial);
  const purchaseActions = useShopPurchaseActions({
    ...drop, ...purchaseState,
    connectedWallet, publicKey, walletBusy, authSubject: auth.authSubject,
    effectiveMintStats,
    refetchInventory: queries.refetchInventory,
    refreshInventoryAfterMint: queries.refreshInventoryAfterMint,
    addLocalMintedBoxes: (quantity, dropId, assetIds) => inventorySource.actions.addLocalMintedBoxes(quantity, dropId, assetIds, reveal.inventoryView),
    blockViewerModeAction,
    setVisible, showToast, isUserRejectedError,
    rememberCheckoutStarted: stripeRecovery.rememberCheckoutStarted,
    sendAndConfirmMintViaConnection: transactions.sendAndConfirmMintViaConnection,
  });
  const presentConfirmedNumericClaim = useClaimPresentation({
    requireKnownDropConfig: drop.requireKnownDropConfig,
    connectedWalletRef, ownerRef,
    claimOpen: modals.claimOpen,
    claimModalGenerationRef: modals.claimModalGenerationRef,
    closeClaimModal: modals.closeClaimModal,
    inventory: queries.inventory,
    refetchInventory: queries.refetchInventory,
    queueOverlayAction: reveal.queueOverlayAction,
    openReceiptImageViewerGroup: reveal.openReceiptImageViewerGroup,
  });
  const recovery = usePreparedTransactionRecovery({
    prepared, connectedWallet, connectedWalletRef, ownerRef,
    claimModalGenerationRef: modals.claimModalGenerationRef,
    isViewerMode, suspended: commerceUiSuspended, isSignedInWallet,
    getDropConnection: drop.getDropConnection,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    hasAuthenticatedWalletSession: auth.hasAuthenticatedWalletSession,
    hideAssetsForWallet: inventorySource.actions.hideAssetsForWallet,
    runDeliveryRecovery,
    refetchInventory: queries.refetchInventory,
    refreshProfileState: auth.refreshProfileState,
    showToast, presentConfirmedNumericClaim,
  });
  const deliveryActions = useDeliveryActions({
    prepared, modals, recovery, connectedWallet, publicKey,
    connectedWalletRef, ownerRef,
    ensureSignedIn: continuation.ensureActionSignedIn,
    blockViewerModeAction,
    selected: selection.selected,
    replaceSelection: selectionState.replaceSelection,
    removeSelected: selectionState.removeSelected,
    deliverableItems: selection.deliverableItems,
    canShipSelected: selection.canShipSelected,
    awaitingSignIn: preserveDelivery,
    setVisible, showToast,
    addressEncryptionPublicKey: ADDRESS_ENCRYPTION_PUBLIC_KEY,
    boxLabelForDropId: drop.boxLabelForDropId,
    figureLabelForDropId: drop.figureLabelForDropId,
    getDropConnection: drop.getDropConnection,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    signAndSendPreparedViaConnection: transactions.signAndSendPreparedViaConnection,
    hideAssetsForWallet: inventorySource.actions.hideAssetsForWallet,
    refetchInventory: queries.refetchInventory,
    refreshProfileState: auth.refreshProfileState,
    runDeliveryRecovery,
  });
  const claimActions = useClaimActions({
    prepared, modals, receiptState, recovery, presentConfirmedNumericClaim,
    connectedWallet, publicKey, connectedWalletRef, owner, ownerRef,
    ensureSignedIn: continuation.ensureActionSignedIn,
    blockViewerModeAction,
    inventory: queries.inventory,
    refetchInventory: queries.refetchInventory,
    unhideAssetsForWallet: inventorySource.actions.unhideAssetsForWallet,
    showToast,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    getDropConnection: drop.getDropConnection,
    signAndSendPreparedViaConnection: transactions.signAndSendPreparedViaConnection,
  });
  const receiptActions = useReceiptActions({
    wallet, modals, receiptState, connectedWallet, publicKey, connectedWalletRef, owner,
    ensureSignedIn: continuation.ensureActionSignedIn,
    blockViewerModeAction, isSignedInWallet,
    getDropConfig: drop.getDropConfig,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    getDropConnection: drop.getDropConnection,
    selectedDropId: selection.selectedDropId,
    adminIrlRedeemSelection: selection.adminIrlRedeemSelection,
    deliverableItems: selection.deliverableItems,
    clearSelection: selectionState.clearSelection,
    getCurrentOverlay: reveal.getCurrentOverlay,
    closeRevealOverlay: reveal.closeRevealOverlay,
    setVisible, showToast,
    markAssetsHidden: inventorySource.actions.markAssetsHidden,
    refetchInventory: queries.refetchInventory,
    signAndSendPreparedViaConnection: transactions.signAndSendPreparedViaConnection,
  });
  const receiptView = useReceiptView({
    connectedWallet, owner, isSignedInWallet, isViewerMode,
    getDropConfig: drop.getDropConfig,
    inventory: queries.inventory,
    receiptOperations: receiptState.receiptOperations,
    revealOverlay: reveal.revealOverlay,
    receiptTransferTarget: modals.receiptTransferTarget,
  });
  const actionHandlers = useShopActionHandlers({
    continuation, owner, routeDropId: drop.routeDrop?.dropId,
    blockViewerModeAction, showToast, selection, selectionState,
    inventory, queries, modals, preorder: preorderCheckout,
    purchase: purchaseActions, delivery: deliveryActions, claim: claimActions,
    receipts: receiptActions, reveal,
  });
  const controlledReveal = {
    ...reveal,
    revealLoading: reveal.revealLoading || (pendingAction?.key === 'reveal' && awaitingActionSignIn ? reveal.revealOverlay?.id || null : null),
    handleRevealOverlayClick: actionHandlers.handleRevealOverlayClick,
    handlePonchoOverlayRequestReveal: actionHandlers.handlePonchoOverlayRequestReveal,
  };
  const receiptControls = useReceiptViewerControls({
    receiptView, modals, receiptActions: { ...receiptActions, handleAdminIrlRedeem: actionHandlers.handleAdminIrlRedeem },
    walletActionBusy,
    revealOverlayClosing: reveal.revealOverlayClosing,
    isClosing: reveal.isClosing,
    showToast,
  });
  const shipments = useShopShipments({
    account, auth, stripeRecovery,
    source: inventorySource, view: inventory, signIn, connectedWallet,
    getDropContent: drop.getDropContent,
  });
  const revealOverlaySuspended = isModalLayerSuspended({ activeLayer: activeModalLayer, layer: 'reveal', open: reveal.revealOverlayOpen });
  const toastAboveModal = shouldToastAppearAboveModal({
    activeLayer: activeModalLayer,
    receiptTransferOpen: Boolean(modals.receiptTransferTarget),
    receiptViewerOpen: reveal.presentation.revealOverlayUsesReceiptImage,
  });
  useEffect(() => {
    if (!preserveDelivery) modals.setDeliveryOpen(false);
    modals.closeReceiptTransferModal();
  }, [connectedWallet, owner]);
  useEffect(() => { modals.closeReceiptTransferModal(); }, [drop.normalizedCurrentPath]);
  const viewedProfileErrorMessage = account.viewedProfileError instanceof Error ? account.viewedProfileError.message : '';
  const anonymousStripeHistoryErrorMessage = stripeRecovery.anonymousHistory.error instanceof Error ? stripeRecovery.anonymousHistory.error.message : '';
  const activeError = auth.error && !awaitingActionSignIn && !isUserRejectedError(auth.error)
    ? auth.error
    : account.canReadOwnProfile && auth.profileError
      ? auth.profileError
      : viewedProfileErrorMessage || (stripeRecovery.anonymousHistory.visible ? anonymousStripeHistoryErrorMessage : '');
  const showHeaderWalletButton = !walletActionBusy && signIn.authReady && !auth.loading && !signIn.pendingHeaderWalletSignIn && !account.hasAuthenticatedAccount && signIn.headerWalletButtonRevealed;
  const miNoteCardsPage = drop.normalizedCurrentPath === '/mi_note_cards' || drop.normalizedCurrentPath === '/mi_note_cards_devnet';
  const dropsPanelFrameActive = !drop.routeDrop && !drop.upcomingDropRoute && drop.normalizedCurrentPath === '/';
  const primaryFrameClassName = [
    'drop-page-frame',
    drop.routeDrop || drop.upcomingDropRoute || drop.normalizedCurrentPath === '/' ? 'drop-page-frame--active' : '',
    dropsPanelFrameActive ? 'drop-page-frame--drops-panel' : '',
    miNoteCardsPage ? 'drop-page-frame--mi-note-cards' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="page">
      <ShopStatus feedback={feedback} suspended={statusUiSuspended} toastAboveModal={toastAboveModal} />
      {!isNfcPage && (
        <NotifySubscription
          open={notifications.notifyOpen}
          onOpenChange={notifications.handleNotifyOpenChange}
          onSubscribed={showSuccessHud}
          suspended={isModalLayerSuspended({ activeLayer: activeModalLayer, appSuspended: suspended, layer: 'notify', open: notifications.notifyOpen })}
        />
      )}
      <div className={primaryFrameClassName}>
        <ShopHeader
          onNavigateHome={drop.restoreHomeOnNextNavigation}
          scrollHomeToTop={dropsPanelFrameActive}
          renderRight={({ interactive }) => <ShopHeaderActions
            {...account}
            interactive={interactive}
            showHeaderWalletButton={showHeaderWalletButton}
            handleHeaderWalletSignIn={actionHandlers.handleHeaderSignIn}
            adminMenuDevnetDrops={drop.adminMenuDevnetDrops}
          />}
        />
        {isNfcPage ? (
          <NfcClaimPage key={nfcDeepLinkCode} />
        ) : miNoteCardsPage ? (
          <MiNoteCardsErrorBoundary>
            <Suspense fallback={null}>
              <MiNoteCardsGallery
                wallet={ethereumWallet}
                verification={ethereumVerification}
                onAdminSignIn={actionHandlers.handleHeaderSignIn}
                preorder={{
                  ...preorderCheckout,
                  purchase: actionHandlers.handlePreorder,
                  busy: preorderCheckout.busy || walletActionBusy,
                  phase: pendingAction?.key === 'preorder' && awaitingActionSignIn ? 'authenticating' : preorderCheckout.phase,
                }}
                onCancelPendingSignIn={pendingAction?.key === 'preorder' && awaitingActionSignIn ? continuation.cancel : undefined}
                showToast={statusUiSuspended ? undefined : showToast}
                onViewPreordered={(item, originRect, aspectRatio) => reveal.openImageViewer(item, originRect, {
                  size: 'preorder', aspectRatio, unavailableMessage: 'Preorder image unavailable',
                })}
              />
            </Suspense>
          </MiNoteCardsErrorBoundary>
        ) : (
          <ShopPurchaseSection
            {...drop}
            {...purchaseState}
            {...purchaseActions}
            handleMint={actionHandlers.handleMint}
            handleDiscountMint={actionHandlers.handleDiscountMint}
            walletActionBusy={walletActionBusy}
            minting={purchaseActions.minting || pendingAction?.key === 'mint'}
            discountMinting={purchaseActions.discountMinting || pendingAction?.key === 'discount'}
            effectiveMintStats={effectiveMintStats}
            connectedWallet={connectedWallet}
            publicKey={publicKey}
            walletBusy={walletBusy}
            showToast={showToast}
            handleOpenNotify={notifications.handleOpenNotify}
          />
        )}
      </div>
      {!miNoteCardsPage && !isNfcPage && (
        <ShopInventorySection
          {...inventory}
          selected={selection.selected}
          toggleSelected={(id) => { if (!walletActionBusy) selection.toggleSelected(id); }}
          canOpenBoxesForDropId={drop.canOpenBoxesForDropId}
          onReveal={(id, rect) => {
            const item = inventory.inventoryIndex.get(id);
            if (item) void actionHandlers.openPendingReveal(item, rect);
          }}
          revealLoading={reveal.revealLoading}
          revealDisabled={walletActionBusy || Boolean(reveal.revealLoading || reveal.startOpenLoading || reveal.revealOverlay)}
        />
      )}
      {!isNfcPage && (
        <ShopCommerceModals
          modals={modals}
          selection={selection}
          activeModalLayer={activeModalLayer}
          suspended={suspended}
          connectedWallet={connectedWallet}
          publicKey={publicKey}
          routeDrop={drop.routeDrop}
          viewedProfile={account.viewedProfile}
          pendingDeliveryItemIds={prepared.pendingDeliveryItemIds}
          revealOverlay={reveal.revealOverlay}
          walletActionBusy={walletActionBusy}
          adminSignInPending={pendingAction?.key === 'admin-redeem' && awaitingActionSignIn}
          claimSignInPending={pendingAction?.key === 'claim' && awaitingActionSignIn}
          handleReceiptTransfer={actionHandlers.handleReceiptTransfer}
          handleAdminIrlRedeem={actionHandlers.handleAdminIrlRedeem}
          handleShip={actionHandlers.handleShip}
          handleClaim={actionHandlers.handleClaim}
        />
      )}
      <ShopRevealLayer reveal={controlledReveal} suspended={revealOverlaySuspended} receiptControls={receiptControls} />
      {activeError ? <div className="error">{activeError}</div> : null}
      {!miNoteCardsPage && !isNfcPage && (
        <>
          <ShopShipmentsSection
            {...shipments}
            {...reveal}
            figureMetadataByKey={inventorySource.figureMetadataByKey}
            getDropContent={drop.getDropContent}
            dropById={drop.dropById}
            shipmentsEmptyContent={<ShopShipmentsEmptyState
              {...shipments.emptyState}
              handleSignInForShipments={actionHandlers.handleShipmentsSignIn}
              pendingShipmentsSignIn={shipments.emptyState.pendingShipmentsSignIn || walletActionBusy}
            />}
          />
          <ShopReceiptsSection
            onEnterCode={() => { if (!blockViewerModeAction()) modals.openClaim(); }}
            receiptsContentVisible={shipments.receiptsContentVisible}
            receiptItems={inventory.receiptItems}
            selected={selection.selected}
            toggleSelected={(id) => { if (!walletActionBusy) selection.toggleSelected(id); }}
            openReceiptImageViewer={reveal.openReceiptImageViewer}
          />
          <ShopSelectionBar
            {...selection}
            clearSelection={() => { continuation.cancel(); selectionState.clearSelection(); }}
            handleViewSelectedItem={() => { if (selection.selectedViewableItem) reveal.viewItem(selection.selectedViewableItem); }}
            handleOpenSelectedBox={() => { if (selection.selectedBox) void actionHandlers.openSelectedBox(selection.selectedBox); }}
            handleOpenShip={actionHandlers.handleOpenShip}
            walletActionBusy={walletActionBusy}
            shippingSignInPending={pendingAction?.key === 'open-ship' && awaitingActionSignIn}
            startOpenLoading={reveal.startOpenLoading || (pendingAction?.key === 'open-box' ? selection.selectedBox?.id || null : null)}
            openActionLabelForDropId={drop.openActionLabelForDropId}
            openActionProgressForDropId={drop.openActionProgressForDropId}
          />
        </>
      )}
    </div>
  );
}

export default App;
