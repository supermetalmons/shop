import {
  useEffect,
  useMemo
} from 'react';
import {
  getFrontendDrop
} from '../../config/deployment';
import { useSolanaAuth } from '../../hooks/useSolanaAuth';
import { useStripeCheckoutRecovery } from '../../hooks/useStripeCheckoutRecovery';
import {
  resolveDropContent
} from '../../lib/dropContent';
import { getMediaIdForFigureId } from '../../lib/figureMediaMap';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  type FigureMetadataTarget
} from '../../lib/figureMetadata';
import {
  profileSectionReadiness,
  retainedProfileShipmentsError
} from '../../lib/profileClientLifecycle';
import {
  ownProfileShipmentsEmptyState
} from '../../lib/profileState';
import { FIGURE_METADATA_RETRY_MS } from '../inventory/stateSupport';
import type { ShopInventorySource } from '../inventory/useShopInventorySource';
import type { ShopInventoryView } from '../inventory/useShopInventoryView';
import type { ShopAccount } from './useShopAccount';
import type { useShopSignIn } from './useShopSignIn';

type ShopShipmentsOptions = {
  account: ShopAccount;
  auth: ReturnType<typeof useSolanaAuth>;
  stripeRecovery: ReturnType<typeof useStripeCheckoutRecovery>;
  source: ShopInventorySource;
  view: ShopInventoryView;
  signIn: ReturnType<typeof useShopSignIn>;
  connectedWallet: string | undefined;
  getDropContent: (dropId?: string) => ReturnType<typeof resolveDropContent>;
};
export function useShopShipments({
  account,
  auth,
  stripeRecovery,
  source,
  view,
  signIn,
  connectedWallet,
  getDropContent,
}: ShopShipmentsOptions) {
  const { canReadOwnProfile, isViewerMode, viewedProfileLoading, viewedProfile, viewedProfileError } = account;
  const { shipments: profileShipments, shipmentsReady: profileShipmentsReady, shipmentsError: profileShipmentsError, loading: authLoading } = auth;
  const { profileRecoveryPending: stripeCheckoutProfileRecoveryPending, anonymousHistory: { orders: anonymousStripeDeliveryOrders, visible: anonymousStripeHistoryVisible, initialLoading: anonymousStripeHistoryInitialLoading, waitingForFulfillment: anonymousStripeHistoryWaitingForFulfillment, error: anonymousStripeHistoryError } } = stripeRecovery;
  const { figureMetadataByKey, actions: { queueFigureMetadataFetch } } = source;
  const { inventoryInitialResponseReady, receiptItems, inventoryEmptyStateVisibility } = view;
  const { authReady, walletIdleReady, pendingShipmentsSignIn, handleSignInForShipments } = signIn;
  const isOwnProfileView = canReadOwnProfile;

  const profileLoadingForView = isViewerMode && viewedProfileLoading;

  const deliveryOrders = isOwnProfileView
    ? profileShipments
    : viewedProfile?.orders || (anonymousStripeHistoryVisible ? anonymousStripeDeliveryOrders : []);

  const shipmentFigureTargetsNeedingMetadata = useMemo(() => {
    const targetsByKey = new Map<string, FigureMetadataTarget>();
    deliveryOrders.forEach((order) => {
      const dropConfig = getFrontendDrop(order.dropId);
      if (!dropConfig) return;
      const dropContent = getDropContent(order.dropId);
      const shouldUseMetadataFallback = dropContent.figures.fulfillmentPreviewMode === 'metadata_stills';
      const figureMediaBase = dropContent.figures.fulfillmentMediaBaseUrl;
      order.items.forEach((item) => {
        if (item.kind !== 'dude') return;
        if (!shouldUseMetadataFallback) {
          const hasMappedMedia = Boolean(figureMediaBase && getMediaIdForFigureId(item.refId, dropConfig.figureMedia));
          if (hasMappedMedia) return;
        }
        const cacheKey = figureMetadataCacheKey(order.dropId, item.refId);
        const metadata = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(order.dropId, item.refId);
        if (!figureMetadataHasImage(metadata)) {
          targetsByKey.set(cacheKey, { dropId: order.dropId, figureId: item.refId });
        }
      });
    });
    return Array.from(targetsByKey.values());
  }, [deliveryOrders, figureMetadataByKey, getDropContent]);

  const ownShipmentsEmptyState = ownProfileShipmentsEmptyState({
    ready: profileShipmentsReady,
    error: profileShipmentsError,
    checkoutRecoveryPending: stripeCheckoutProfileRecoveryPending,
  });

  const shipmentsRetainedError = retainedProfileShipmentsError({
    isOwnProfileView,
    shipmentCount: deliveryOrders.length,
    error: profileShipmentsError,
  });
  const shipmentsEmptyStateReady = isOwnProfileView
    ? ownShipmentsEmptyState !== 'loading'
    : isViewerMode
      ? !viewedProfileLoading
      : anonymousStripeHistoryVisible
        ? !anonymousStripeHistoryInitialLoading
        : connectedWallet
          ? authReady
          : walletIdleReady && authReady && !stripeCheckoutProfileRecoveryPending;

  const shipmentsEmptyStateVisibility = shipmentsEmptyStateReady ? 'visible' : 'hidden';

  const profileSectionsReady = profileSectionReadiness({
    shipmentCount: deliveryOrders.length,
    shipmentsEmptyStateReady,
    inventoryInitialResponseReady,
    receiptItemCount: receiptItems.length,
    inventoryEmptyStateVisible: inventoryEmptyStateVisibility === 'visible',
  });

  const shipmentsSectionReady = profileSectionsReady.shipments;

  const receiptsContentVisible = profileSectionsReady.receipts;
  useEffect(() => {
    if (!shipmentFigureTargetsNeedingMetadata.length) return;
    if (typeof window === 'undefined') return;
    queueFigureMetadataFetch(shipmentFigureTargetsNeedingMetadata);
    const interval = window.setInterval(() => {
      queueFigureMetadataFetch(shipmentFigureTargetsNeedingMetadata);
    }, FIGURE_METADATA_RETRY_MS);
    return () => window.clearInterval(interval);
  }, [queueFigureMetadataFetch, shipmentFigureTargetsNeedingMetadata]);
  return { deliveryOrders, shipmentsRetainedError, shipmentsEmptyStateVisibility: shipmentsEmptyStateVisibility as 'visible' | 'hidden', shipmentsSectionReady, receiptsContentVisible, emptyState: { isOwnProfileView, ownShipmentsEmptyState, isViewerMode, viewedProfileError, profileLoadingForView, anonymousStripeHistoryVisible, anonymousStripeHistoryInitialLoading, anonymousStripeHistoryError, anonymousStripeHistoryWaitingForFulfillment, handleSignInForShipments, authLoading, pendingShipmentsSignIn } };
}
export type ShopShipments = ReturnType<typeof useShopShipments>;
