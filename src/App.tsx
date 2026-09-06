import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useEffect, useRef } from 'react';
import { NotifySubscription } from './components/NotifySubscription';
import { ShopHeader } from './components/ShopHeader';
import { useSolanaAuth } from './hooks/useSolanaAuth';
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

type AppProps = {
  currentPath?: string;
  claimDeepLinkCode?: string | null;
  suspended?: boolean;
};

function App({ currentPath, claimDeepLinkCode = null, suspended = false }: AppProps) {
  const wallet = useWallet();
  const { visible: walletModalVisible, setVisible } = useWalletModal();
  const { publicKey } = wallet;
  const connectedWallet = wallet.connected ? publicKey?.toBase58() : undefined;
  const connectedWalletRef = useRef<string | null>(connectedWallet || null);
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const statusUiSuspended = suspended || walletModalVisible;
  const auth = useSolanaAuth();
  const drop = useShopDrop(currentPath);
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
    claimOpen: modals.claimOpen, showToast, isUserRejectedError,
  });
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
    connectedWallet, publicKey, owner, localAccountWallet, isViewerMode, suspended,
    walletModalVisible, receiptTransferOpen: Boolean(modals.receiptTransferTarget),
    inventory: queries.inventory, pendingOpenBoxes: queries.pendingOpenBoxes,
    figureMetadataByKey: inventorySource.figureMetadataByKey,
    refetchInventory: queries.refetchInventory,
    refetchPendingOpenBoxes: queries.refetchPendingOpenBoxes,
    ensureSignedIn: signIn.ensureSignedIn,
    openWalletModal: () => setVisible(true),
    showToast, blockViewerModeAction,
    sendAndConfirmViaConnection: transactions.sendAndConfirmViaConnection,
    retryAfterBlockhashExpiry: transactions.retryAfterBlockhashExpiry,
  });
  useShopInventoryMaintenance(inventorySource, reveal);
  const inventory = useShopInventoryView({
    ...drop,
    source: inventorySource,
    inventoryView: reveal.inventoryView,
    pendingOpenBoxesView: reveal.pendingOpenBoxesView,
    revealOverlay: reveal.revealOverlay,
    receiptOperationHiddenAssets: receiptState.receiptOperationHiddenAssets,
    pendingDeliveryItemIds: prepared.pendingDeliveryItemIds,
    connectedWallet, isSignedInWallet,
    stripeCheckoutInventoryRefreshPending,
    stripeCheckoutProfileRecoveryPending: stripeRecovery.profileRecoveryPending,
    walletIdleReady: signIn.walletIdleReady,
    authReady: signIn.authReady,
    deliveryCountryCode: modals.deliveryCountryCode,
    boxImageForDropId: reveal.boxImageForDropId,
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
    isViewerMode, suspended, isSignedInWallet,
    getDropConnection: drop.getDropConnection,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    hasAuthenticatedWalletSession: auth.hasAuthenticatedWalletSession,
    profileShipments: auth.shipments,
    hideAssetsForWallet: inventorySource.actions.hideAssetsForWallet,
    runDeliveryRecovery,
    refetchInventory: queries.refetchInventory,
    refreshProfileState: auth.refreshProfileState,
    showToast, presentConfirmedNumericClaim,
  });
  const deliveryActions = useDeliveryActions({
    prepared, modals, recovery, connectedWallet, publicKey,
    connectedWalletRef, ownerRef,
    ensureSignedIn: signIn.ensureSignedIn,
    blockViewerModeAction,
    selected: inventory.selected,
    replaceSelection: inventorySource.actions.replaceSelection,
    removeSelected: inventorySource.actions.removeSelected,
    deliverableItems: inventory.deliverableItems,
    canShipSelected: inventory.canShipSelected,
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
    ensureSignedIn: signIn.ensureSignedIn,
    blockViewerModeAction,
    inventory: queries.inventory,
    refetchInventory: queries.refetchInventory,
    unhideAssetsForWallet: inventorySource.actions.unhideAssetsForWallet,
    requestClaimSignIn: signIn.requestClaimSignIn,
    showToast,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    getDropConnection: drop.getDropConnection,
    signAndSendPreparedViaConnection: transactions.signAndSendPreparedViaConnection,
  });
  const receiptActions = useReceiptActions({
    wallet, modals, receiptState, connectedWallet, publicKey, connectedWalletRef, owner,
    ensureSignedIn: signIn.ensureSignedIn,
    blockViewerModeAction, isSignedInWallet,
    getDropConfig: drop.getDropConfig,
    requireKnownDropConfig: drop.requireKnownDropConfig,
    getDropConnection: drop.getDropConnection,
    selectedDropId: inventory.selectedDropId,
    adminIrlRedeemSelection: inventory.adminIrlRedeemSelection,
    deliverableItems: inventory.deliverableItems,
    clearSelection: inventorySource.actions.clearSelection,
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
  const receiptControls = useReceiptViewerControls({
    receiptView, modals, receiptActions,
    revealOverlayClosing: reveal.revealOverlayClosing,
    isClosing: reveal.isClosing,
    showToast,
  });
  const shipments = useShopShipments({
    account, auth, stripeRecovery,
    source: inventorySource, view: inventory, signIn, connectedWallet,
    getDropContent: drop.getDropContent,
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
  const revealOverlaySuspended = isModalLayerSuspended({ activeLayer: activeModalLayer, layer: 'reveal', open: reveal.revealOverlayOpen });
  const toastAboveModal = shouldToastAppearAboveModal({
    activeLayer: activeModalLayer,
    receiptTransferOpen: Boolean(modals.receiptTransferTarget),
    receiptViewerOpen: reveal.presentation.revealOverlayUsesReceiptImage,
  });
  useEffect(() => {
    inventorySource.actions.clearSelection();
    modals.setDeliveryOpen(false);
    modals.closeReceiptTransferModal();
  }, [connectedWallet, owner]);
  useEffect(() => { modals.closeReceiptTransferModal(); }, [drop.normalizedCurrentPath]);
  useEffect(() => {
    if (!inventory.selectedCount || activeModalLayer || suspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      inventorySource.actions.clearSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeModalLayer, inventory.selectedCount, suspended]);
  const viewedProfileErrorMessage = account.viewedProfileError instanceof Error ? account.viewedProfileError.message : '';
  const anonymousStripeHistoryErrorMessage = stripeRecovery.anonymousHistory.error instanceof Error ? stripeRecovery.anonymousHistory.error.message : '';
  const activeError = auth.error && !isUserRejectedError(auth.error)
    ? auth.error
    : account.canReadOwnProfile && auth.profileError
      ? auth.profileError
      : viewedProfileErrorMessage || (stripeRecovery.anonymousHistory.visible ? anonymousStripeHistoryErrorMessage : '');
  const showHeaderWalletButton = signIn.authReady && !auth.loading && !signIn.pendingHeaderWalletSignIn && !account.hasAuthenticatedAccount && signIn.headerWalletButtonRevealed;
  const dropsPanelFrameActive = !drop.routeDrop && !drop.upcomingDropRoute && drop.normalizedCurrentPath === '/';
  const primaryFrameClassName = [
    'drop-page-frame',
    drop.routeDrop || drop.upcomingDropRoute || drop.normalizedCurrentPath === '/' ? 'drop-page-frame--active' : '',
    dropsPanelFrameActive ? 'drop-page-frame--drops-panel' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="page">
      <ShopStatus feedback={feedback} suspended={statusUiSuspended} toastAboveModal={toastAboveModal} />
      <NotifySubscription
        open={notifications.notifyOpen}
        onOpenChange={notifications.handleNotifyOpenChange}
        onSubscribed={showSuccessHud}
        suspended={isModalLayerSuspended({ activeLayer: activeModalLayer, appSuspended: suspended, layer: 'notify', open: notifications.notifyOpen })}
      />
      <div className={primaryFrameClassName}>
        <ShopHeader
          onNavigateHome={drop.restoreHomeOnNextNavigation}
          scrollHomeToTop={dropsPanelFrameActive}
          renderRight={({ interactive }) => <ShopHeaderActions
            {...account}
            interactive={interactive}
            showHeaderWalletButton={showHeaderWalletButton}
            connectedWallet={connectedWallet}
            handleHeaderWalletSignIn={signIn.handleHeaderWalletSignIn}
            adminMenuDevnetDrops={drop.adminMenuDevnetDrops}
          />}
        />
        <ShopPurchaseSection
          {...drop}
          {...purchaseState}
          {...purchaseActions}
          effectiveMintStats={effectiveMintStats}
          connectedWallet={connectedWallet}
          publicKey={publicKey}
          walletBusy={walletBusy}
          showToast={showToast}
          handleOpenNotify={notifications.handleOpenNotify}
        />
      </div>
      <ShopInventorySection
        {...inventory}
        canOpenBoxesForDropId={drop.canOpenBoxesForDropId}
        onReveal={(id, rect) => {
          const item = inventory.inventoryIndex.get(id);
          if (item) void reveal.openPendingReveal(item, rect);
        }}
        revealLoading={reveal.revealLoading}
        revealDisabled={Boolean(reveal.revealLoading || reveal.startOpenLoading || reveal.revealOverlay)}
      />
      <ShopCommerceModals
        modals={modals}
        view={inventory}
        activeModalLayer={activeModalLayer}
        suspended={suspended}
        connectedWallet={connectedWallet}
        publicKey={publicKey}
        routeDrop={drop.routeDrop}
        viewedProfile={account.viewedProfile}
        pendingDeliveryItemIds={prepared.pendingDeliveryItemIds}
        revealOverlay={reveal.revealOverlay}
        handleReceiptTransfer={receiptActions.handleReceiptTransfer}
        handleAdminIrlRedeem={receiptActions.handleAdminIrlRedeem}
        handleShip={deliveryActions.handleShip}
        handleClaim={claimActions.handleClaim}
      />
      <ShopRevealLayer reveal={reveal} suspended={revealOverlaySuspended} receiptControls={receiptControls} />
      {activeError ? <div className="error">{activeError}</div> : null}
      <ShopShipmentsSection
        {...shipments}
        {...reveal}
        figureMetadataByKey={inventorySource.figureMetadataByKey}
        getDropContent={drop.getDropContent}
        dropById={drop.dropById}
        mergeLoadedFigureMetadata={inventorySource.actions.mergeLoadedFigureMetadata}
        shipmentsEmptyContent={<ShopShipmentsEmptyState {...shipments.emptyState} />}
      />
      <ShopReceiptsSection
        onEnterCode={() => { if (!blockViewerModeAction()) modals.openClaim(); }}
        receiptsContentVisible={shipments.receiptsContentVisible}
        receiptItems={inventory.receiptItems}
        selected={inventory.selected}
        toggleSelected={inventory.toggleSelected}
        openReceiptImageViewer={reveal.openReceiptImageViewer}
      />
      <ShopSelectionBar
        {...inventory}
        clearSelection={inventorySource.actions.clearSelection}
        handleViewSelectedItem={() => { if (inventory.selectedViewableItem) reveal.viewItem(inventory.selectedViewableItem); }}
        handleOpenSelectedBox={() => { if (inventory.selectedBox) void reveal.openSelectedBox(inventory.selectedBox); }}
        handleOpenShip={deliveryActions.handleOpenShip}
        startOpenLoading={reveal.startOpenLoading}
        openActionLabelForDropId={drop.openActionLabelForDropId}
        openActionProgressForDropId={drop.openActionProgressForDropId}
      />
    </div>
  );
}

export default App;
