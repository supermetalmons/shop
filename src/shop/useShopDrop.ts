import { Connection } from '@solana/web3.js';
import {
  useCallback,
  useMemo,
  useRef
} from 'react';
import { isDirectDeliveryItemsPerBox } from '../../shared/shipping.ts';
import {
  classifyStripeCheckoutKind,
  stripeCheckoutModeForDrop
} from '../../shared/stripeCheckoutCore.ts';
import {
  getFrontendDrop,
  isDropFamily,
  listFrontendDrops,
  type FrontendDeploymentConfig
} from '../config/deployment';
import { useHomePageScrollRestoration } from '../hooks/useHomePageScrollRestoration';
import {
  resolveFrontendDropByPath,
  resolveUpcomingDropRouteByPath
} from '../lib/dropConfig';
import {
  mintPanelPreviewAspectRatio,
  mintPanelPreviewImage,
  resolveDropContent
} from '../lib/dropContent';
import {
  dropAssetLabel,
  dropAssetReference,
  dropOpenActionLabel,
  dropOpenActionProgress,
  dropOpenGerund
} from '../lib/dropLabels';
import { createShopConnection } from '../lib/shopRpc';
import { getNormalizedPathname } from '../navigation';
import { cardNft2PackVideoSourcesForBrowser, createCardNft2PackInventoryPreviewVideo, formatStripeUsdAmountCents, resolveMintPreviewMedia, stripeCheckoutUnitAmountCentsForDrop } from './purchase/media';

export function useShopDrop(currentPath?: string) {
  const cardNft2PackVideoSources = useMemo(cardNft2PackVideoSourcesForBrowser, []);

  const cardNft2PackInventoryPreviewVideo = useMemo(
    () => createCardNft2PackInventoryPreviewVideo(cardNft2PackVideoSources),
    [cardNft2PackVideoSources],
  );

  const normalizedCurrentPath = useMemo(
    () => (currentPath ? currentPath : getNormalizedPathname()),
    [currentPath],
  );

  const restoreHomeOnNextNavigation = useHomePageScrollRestoration(normalizedCurrentPath);

  const routeDrop = useMemo(() => resolveFrontendDropByPath(normalizedCurrentPath), [normalizedCurrentPath]);

  const routeStripeOnly = routeDrop?.salesMode === 'stripe_receipt_only';

  const upcomingDropRoute = useMemo(
    () => (routeDrop ? null : resolveUpcomingDropRouteByPath(normalizedCurrentPath)),
    [normalizedCurrentPath, routeDrop],
  );

  const allDrops = useMemo(() => listFrontendDrops(), []);

  const adminMenuDevnetDrops = useMemo(
    () => allDrops.filter((drop) => drop.solanaCluster === 'devnet'),
    [allDrops],
  );

  const dropById = useMemo(() => new Map(allDrops.map((drop) => [drop.dropId, drop])), [allDrops]);

  const dropConnectionCacheRef = useRef<Map<string, Connection>>(new Map());

  const requireRouteDrop = useCallback(
    (context: string): FrontendDeploymentConfig => {
      if (!routeDrop) {
        throw new Error(`This action requires an explicit drop route (${context})`);
      }
      return routeDrop;
    },
    [routeDrop],
  );

  const getDropConfig = useCallback(
    (dropId?: string): FrontendDeploymentConfig | undefined => {
      if (!dropId) return routeDrop || undefined;
      return getFrontendDrop(dropId);
    },
    [routeDrop],
  );

  const requireKnownDropConfig = useCallback(
    (dropId: string | undefined, context: string): FrontendDeploymentConfig => {
      if (!dropId) {
        throw new Error(`Missing dropId from ${context}`);
      }
      const found = getFrontendDrop(dropId);
      if (found) return found;
      throw new Error(`Unknown dropId "${dropId}" from ${context}`);
    },
    [],
  );

  const getDropConnection = useCallback(
    (dropId: string): Connection => {
      const drop = requireKnownDropConfig(dropId, 'connection');
      const cacheKey = `${drop.solanaCluster}:${drop.dropId}`;
      const cached = dropConnectionCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const created = createShopConnection(drop.solanaCluster);
      dropConnectionCacheRef.current.set(cacheKey, created);
      return created;
    },
    [requireKnownDropConfig],
  );

  const getDropContent = useCallback(
    (dropId?: string) => resolveDropContent(dropId ? getFrontendDrop(dropId) || dropId : routeDrop || undefined),
    [routeDrop],
  );

  const boxLabelForDropId = useCallback(
    (dropId?: string, count = 1, options?: { capitalize?: boolean; }) =>
      dropAssetLabel(getDropConfig(dropId), 'box', count, options),
    [getDropConfig],
  );

  const figureLabelForDropId = useCallback(
    (dropId?: string, count = 1, options?: { capitalize?: boolean; }) =>
      dropAssetLabel(getDropConfig(dropId), 'figure', count, options),
    [getDropConfig],
  );

  const boxReferenceForDropId = useCallback(
    (dropId: string | undefined, reference: string | number) =>
      dropAssetReference(getDropConfig(dropId), 'box', reference),
    [getDropConfig],
  );

  const figureReferenceForDropId = useCallback(
    (dropId: string | undefined, reference: string | number) =>
      dropAssetReference(getDropConfig(dropId), 'figure', reference),
    [getDropConfig],
  );
  const openActionLabelForDropId = useCallback((dropId?: string) => dropOpenActionLabel(getDropConfig(dropId)), [getDropConfig]);

  const openActionProgressForDropId = useCallback(
    (dropId?: string) => dropOpenActionProgress(getDropConfig(dropId)),
    [getDropConfig],
  );

  const openGerundForDropId = useCallback((dropId?: string) => dropOpenGerund(getDropConfig(dropId)), [getDropConfig]);

  const canOpenBoxesForDropId = useCallback(
    (dropId?: string) => {
      const dropConfig = getDropConfig(dropId);
      if (isDropFamily(dropConfig, 'little_swag_hoodies')) return false;
      return !isDirectDeliveryItemsPerBox(dropConfig?.itemsPerBox);
    },
    [getDropConfig],
  );
  const routeConnection = useMemo(
    () => (routeDrop ? getDropConnection(routeDrop.dropId) : null),
    [getDropConnection, routeDrop],
  );
  const mintPreviewMedia = routeDrop
    ? resolveMintPreviewMedia(
      {
        imageSrc: mintPanelPreviewImage(routeDrop.dropId),
        aspectRatio: mintPanelPreviewAspectRatio(routeDrop.dropId),
      },
      isDropFamily(routeDrop, 'card_nft_2'),
      cardNft2PackVideoSources,
    )
    : { aspectRatio: 1 };
  const routeStripePaymentMode = stripeCheckoutModeForDrop(routeDrop);
  const routeStripePaymentUnitAmountCents = stripeCheckoutUnitAmountCentsForDrop(routeDrop, routeStripePaymentMode);
  const routeStripePaymentPriceLabel =
    routeStripePaymentUnitAmountCents == null
      ? undefined
      : formatStripeUsdAmountCents(routeStripePaymentUnitAmountCents);
  const routeStripeCheckoutKind = classifyStripeCheckoutKind(routeDrop);
  const routeStripePaymentVisible = Boolean(
    routeDrop && routeStripePaymentMode && routeStripePaymentUnitAmountCents != null && routeStripeCheckoutKind,
  );
  const upcomingDropContent = useMemo(
    () => (upcomingDropRoute?.previewDropId ? resolveDropContent(upcomingDropRoute.previewDropId) : undefined),
    [upcomingDropRoute?.previewDropId],
  );
  const upcomingMintPreviewMedia = resolveMintPreviewMedia(
    {
      imageSrc:
        upcomingDropRoute?.previewImageUrl ||
        upcomingDropContent?.mintPanel.previewImageUrl ||
        upcomingDropContent?.box.previewImageUrl,
      aspectRatio:
        upcomingDropRoute?.previewAspectRatio ||
        (upcomingDropContent?.mintPanel.previewImageUrl
          ? upcomingDropContent.mintPanel.aspectRatio
          : upcomingDropContent?.box.aspectRatio || 1),
    },
    upcomingDropRoute?.dropFamily === 'card_nft_2',
    cardNft2PackVideoSources,
  );
  return { routeDrop, routeStripeOnly, upcomingDropRoute, allDrops, adminMenuDevnetDrops, dropById, requireRouteDrop, getDropConfig, requireKnownDropConfig, getDropConnection, getDropContent, boxLabelForDropId, figureLabelForDropId, boxReferenceForDropId, figureReferenceForDropId, openActionLabelForDropId, openActionProgressForDropId, openGerundForDropId, canOpenBoxesForDropId, routeConnection, cardNft2PackVideoSources, cardNft2PackInventoryPreviewVideo, normalizedCurrentPath, restoreHomeOnNextNavigation, mintPreviewMedia, routeStripePaymentMode, routeStripePaymentUnitAmountCents, routeStripePaymentPriceLabel, routeStripeCheckoutKind, routeStripePaymentVisible, upcomingMintPreviewMedia };
}
