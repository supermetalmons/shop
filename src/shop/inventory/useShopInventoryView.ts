import { useMemo } from 'react';
import {
  isDropFamily,
  type FrontendDeploymentConfig
} from '../../config/deployment';
import {
  normalizeBoxDisplayImage
} from '../../lib/dropContent';
import {
  figureMetadataCacheKey,
  parseFigureMetadataCacheKey
} from '../../lib/figureMetadata';
import {
  isCardNft2LocalMintedBox,
  withoutLocallyMintedUnresolvedCardNft2Boxes
} from '../../lib/localMintedBoxes';
import {
  shortAddress
} from '../../lib/solana';
import {
  InventoryItem,
  InventoryPreviewVideo
} from '../../types';
import { boxDisplayImageForInventoryItem, moveLittleSwagBoxesFamilyToEnd } from './media';
import { EMPTY_INVENTORY, EMPTY_LOCAL_MINTED_BOXES } from './stateSupport';
import type { ShopInventorySource, ShopInventoryViews } from './useShopInventorySource';

type InventoryViewOptions = Pick<ShopInventoryViews, 'inventoryView' | 'pendingOpenBoxesView'> & {
  source: ShopInventorySource;
  routeDrop: FrontendDeploymentConfig | null;
  receiptOperationHiddenAssets: ReadonlySet<string>;
  stripeCheckoutInventoryRefreshPending: boolean;
  stripeCheckoutProfileRecoveryPending: boolean;
  walletIdleReady: boolean;
  authReady: boolean;
  cardNft2PackInventoryPreviewVideo: InventoryPreviewVideo;
  figureReferenceForDropId: (dropId: string | undefined, reference: string | number) => string;
  boxReferenceForDropId: (dropId: string | undefined, reference: string | number) => string;
  boxLabelForDropId: (dropId?: string, count?: number, options?: { capitalize?: boolean; }) => string;
  boxImageForDropId: (dropId?: string) => string | undefined;
};
export function useShopInventoryView({
  source,
  inventoryView,
  pendingOpenBoxesView,
  routeDrop,
  receiptOperationHiddenAssets,
  stripeCheckoutInventoryRefreshPending,
  stripeCheckoutProfileRecoveryPending,
  walletIdleReady,
  authReady,
  cardNft2PackInventoryPreviewVideo,
  figureReferenceForDropId,
  boxReferenceForDropId,
  boxLabelForDropId,
  boxImageForDropId,
}: InventoryViewOptions) {
  const {
    hiddenAssets,
    localPendingReveals,
    recentRevealedBoxes,
    localMintedBoxes,
    localRevealedDudeKeys,
    figureMetadataByKey,
  } = source;
  const { owner, isViewerMode, inventoryFetched } = source.queries;
  const localRevealedDudes = useMemo(() => {
    if (isViewerMode) return EMPTY_INVENTORY;
    if (!localRevealedDudeKeys.length) return EMPTY_INVENTORY;
    const chainDudeKeys = new Set(
      inventoryView
        .filter((item) => item.kind === 'dude' && typeof item.dudeId === 'number')
        .map((item) => figureMetadataCacheKey(item.dropId, item.dudeId as number)),
    );
    const out: InventoryItem[] = [];
    localRevealedDudeKeys.forEach((cacheKey) => {
      if (chainDudeKeys.has(cacheKey)) return;
      const parsed = parseFigureMetadataCacheKey(cacheKey);
      if (!parsed) return;
      const { dropId, figureId } = parsed;
      const meta = figureMetadataByKey[cacheKey];
      out.push({
        id: `local-dude-${dropId}-${figureId}`,
        dropId,
        name: meta?.name || figureReferenceForDropId(dropId, figureId),
        kind: 'dude',
        image: meta?.image,
        attributes: meta?.attributes || [],
        dudeId: figureId,
        status: 'pending',
      });
    });
    return out;
  }, [inventoryView, localRevealedDudeKeys, figureMetadataByKey, figureReferenceForDropId, isViewerMode]);

  const pendingCardNft2LocalMintedBoxes = useMemo(() => {
    if (isViewerMode || !localMintedBoxes.length) return EMPTY_LOCAL_MINTED_BOXES;
    const entries = localMintedBoxes.filter(isCardNft2LocalMintedBox);
    return entries.length ? entries : EMPTY_LOCAL_MINTED_BOXES;
  }, [localMintedBoxes, isViewerMode]);

  const visibleInventory = useMemo(() => {
    const baseRaw =
      isViewerMode || (!hiddenAssets.size && !receiptOperationHiddenAssets.size)
        ? inventoryView
        : inventoryView.filter((item) => (
          !hiddenAssets.has(item.id) &&
          !receiptOperationHiddenAssets.has(item.id)
        ));
    const base = withoutLocallyMintedUnresolvedCardNft2Boxes(baseRaw, pendingCardNft2LocalMintedBoxes);
    const enriched = base.map((item) => {
      if (item.kind === 'box') {
        const image = boxDisplayImageForInventoryItem(item);
        return image === item.image ? item : { ...item, image };
      }
      if (item.kind !== 'dude' || !item.dudeId) return item;
      if (item.image && String(item.image).trim()) return item;
      const cacheKey = figureMetadataCacheKey(item.dropId, item.dudeId);
      const meta = figureMetadataByKey[cacheKey];
      if (!meta) return item;
      return {
        ...item,
        image: meta.image,
        name: item.name || meta.name || item.name,
        attributes: item.attributes?.length ? item.attributes : meta.attributes,
      };
    });
    if (!localRevealedDudes.length) return enriched;
    return [...enriched, ...localRevealedDudes];
  }, [
    inventoryView,
    hiddenAssets,
    receiptOperationHiddenAssets,
    pendingCardNft2LocalMintedBoxes,
    localRevealedDudes,
    figureMetadataByKey,
    isViewerMode,
  ]);

  const localMintedItems = useMemo<InventoryItem[]>(() => {
    if (isViewerMode) return EMPTY_INVENTORY;
    if (!localMintedBoxes.length) return EMPTY_INVENTORY;
    return moveLittleSwagBoxesFamilyToEnd(
      localMintedBoxes.map((entry) => {
        const isCardNft2 = isDropFamily(entry.dropId, 'card_nft_2');
        return {
          id: entry.id,
          dropId: entry.dropId,
          name: `Pending ${boxLabelForDropId(entry.dropId)}`,
          kind: 'box' as const,
          image: boxImageForDropId(entry.dropId),
          ...(isCardNft2
            ? {
              previewVideo: cardNft2PackInventoryPreviewVideo,
            }
            : {}),
          status: 'pending' as const,
        };
      }),
    );
  }, [localMintedBoxes, boxImageForDropId, boxLabelForDropId, cardNft2PackInventoryPreviewVideo, isViewerMode]);

  const recentRevealedSet = useMemo(
    () => (isViewerMode ? new Set<string>() : new Set(recentRevealedBoxes)),
    [recentRevealedBoxes, isViewerMode],
  );

  const pendingOpenBoxesFiltered = useMemo(
    () => pendingOpenBoxesView.filter((entry) => entry.boxAssetId && !recentRevealedSet.has(entry.boxAssetId)),
    [pendingOpenBoxesView, recentRevealedSet],
  );

  const localPendingFiltered = useMemo(
    () => (isViewerMode ? [] : localPendingReveals.filter((entry) => !recentRevealedSet.has(entry.id))),
    [localPendingReveals, recentRevealedSet, isViewerMode],
  );

  const pendingRevealIds = useMemo(() => {
    const ids = new Set<string>();
    pendingOpenBoxesFiltered.forEach((entry) => {
      if (entry.boxAssetId) ids.add(entry.boxAssetId);
    });
    localPendingFiltered.forEach((entry) => {
      if (entry.id) ids.add(entry.id);
    });
    return ids;
  }, [pendingOpenBoxesFiltered, localPendingFiltered]);

  const shouldPreloadBoxFramesInitial =
    pendingRevealIds.size > 0 || localMintedItems.length > 0 || inventoryView.some((item) => item.kind === 'box');

  const pendingRevealItems = useMemo(() => {
    if (!pendingOpenBoxesFiltered.length && !localPendingFiltered.length) return [];
    const inventoryById = new Map(inventoryView.map((item) => [item.id, item]));
    const localById = new Map(localPendingFiltered.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const pendingItems: InventoryItem[] = [];
    pendingOpenBoxesFiltered.forEach((entry) => {
      const id = entry.boxAssetId;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const match = inventoryById.get(id);
      const localMatch = localById.get(id);
      const itemDropId = localMatch?.dropId || entry.dropId || match?.dropId || routeDrop?.dropId || '';
      if (!itemDropId) return;
      const boxId = localMatch?.boxId || match?.boxId;
      pendingItems.push({
        id,
        dropId: itemDropId,
        name: localMatch?.name || match?.name || boxReferenceForDropId(itemDropId, shortAddress(id)),
        kind: 'box',
        boxId,
        image: normalizeBoxDisplayImage({
          dropId: itemDropId,
          imageRaw: localMatch?.image || match?.image,
          boxId,
        }),
      });
    });
    const localSorted = [...localPendingFiltered].sort((a, b) => b.createdAt - a.createdAt);
    localSorted.forEach((entry) => {
      const id = entry.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const match = inventoryById.get(id);
      const itemDropId = entry.dropId || match?.dropId || routeDrop?.dropId || '';
      if (!itemDropId) return;
      const boxId = entry.boxId || match?.boxId;
      pendingItems.push({
        id,
        dropId: itemDropId,
        name: entry.name || match?.name || boxReferenceForDropId(itemDropId, shortAddress(id)),
        kind: 'box',
        boxId,
        image: normalizeBoxDisplayImage({
          dropId: itemDropId,
          imageRaw: entry.image || match?.image,
          boxId,
        }),
      });
    });
    return moveLittleSwagBoxesFamilyToEnd(pendingItems);
  }, [pendingOpenBoxesFiltered, localPendingFiltered, inventoryView, routeDrop?.dropId, boxReferenceForDropId]);

  const inventoryItems = useMemo(() => {
    const boxes: typeof visibleInventory = [];
    const dudes: typeof visibleInventory = [];
    visibleInventory.forEach((item) => {
      if (pendingRevealIds.has(item.id)) return;
      if (item.kind === 'box') boxes.push(item);
      else if (item.kind === 'dude') dudes.push(item);
    });
    return [
      ...pendingRevealItems,
      ...localMintedItems,
      ...moveLittleSwagBoxesFamilyToEnd(boxes),
      ...moveLittleSwagBoxesFamilyToEnd(dudes),
    ];
  }, [visibleInventory, pendingRevealIds, pendingRevealItems, localMintedItems]);

  const inventoryIndex = useMemo(() => new Map(inventoryItems.map((item) => [item.id, item])), [inventoryItems]);

  const receiptItems = useMemo(
    () => moveLittleSwagBoxesFamilyToEnd(visibleInventory.filter((item) => item.kind === 'certificate')),
    [visibleInventory],
  );

  const inventoryEmptyStateVisibility: 'visible' | 'hidden' = owner
    ? inventoryFetched && !stripeCheckoutInventoryRefreshPending
      ? 'visible'
      : 'hidden'
    : walletIdleReady && authReady && !stripeCheckoutProfileRecoveryPending
      ? 'visible'
      : 'hidden';

  const inventoryInitialResponseReady = !owner || inventoryFetched;

  return {
    inventoryItems, inventoryIndex, receiptItems, inventoryEmptyStateVisibility, inventoryInitialResponseReady,
    pendingRevealIds, shouldPreloadBoxFramesInitial,
  };
}
export type ShopInventoryView = ReturnType<typeof useShopInventoryView>;
