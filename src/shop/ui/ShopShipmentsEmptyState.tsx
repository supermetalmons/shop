import type { ShopShipments } from '../account/useShopShipments';

export function ShopShipmentsEmptyState({
  isOwnProfileView,
  ownShipmentsEmptyState,
  isViewerMode,
  viewedProfileError,
  profileLoadingForView,
  anonymousStripeHistoryVisible,
  anonymousStripeHistoryInitialLoading,
  anonymousStripeHistoryError,
  anonymousStripeHistoryWaitingForFulfillment,
  handleSignInForShipments,
  authLoading,
  pendingShipmentsSignIn,
}: ShopShipments['emptyState']) {
  if (isOwnProfileView) {
    if (ownShipmentsEmptyState === 'error') return 'Unable to load shipments.';
    if (ownShipmentsEmptyState === 'preparing') return 'Preparing shipment…';
    return ownShipmentsEmptyState === 'empty' ? 'No shipments yet.' : 'Loading shipments…';
  }
  if (isViewerMode) {
    if (viewedProfileError) return 'Unable to load shipments.';
    return profileLoadingForView ? 'Loading shipments…' : 'No shipments yet.';
  }
  if (anonymousStripeHistoryVisible) {
    if (anonymousStripeHistoryInitialLoading) return 'Loading shipments…';
    if (anonymousStripeHistoryError) return 'Unable to load shipments.';
    return anonymousStripeHistoryWaitingForFulfillment ? 'Preparing shipment…' : 'No shipments yet.';
  }
  return (
    <span className="shipments-signin">
      <button
        type="button"
        className="link"
        onClick={handleSignInForShipments}
        disabled={authLoading || pendingShipmentsSignIn}
      >
        Sign in
      </button>
      {' '}
      <span>to view your shipments.</span>
    </span>
  );
}
