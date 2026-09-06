import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  useEffect,
  useMemo,
  useState
} from 'react';
import { calculateDeliveryLamports, canDeliverItemKind } from '../../../shared/shipping.ts';
import {
  isDropFamily,
  type FrontendDeploymentConfig
} from '../../config/deployment';
import {
  canAdminIrlRedeemSelection
} from '../../lib/adminIrlRedeem';
import { clearCardModelUrl } from '../../lib/clearCardModels';
import {
  normalizeBoxDisplayImage
} from '../../lib/dropContent';
import {
  dropAssetCount
} from '../../lib/dropLabels';
import {
  figureMetadataCacheKey,
  parseFigureMetadataCacheKey
} from '../../lib/figureMetadata';
import {
  getInteractiveCardPackCardByFigureId
} from '../../lib/interactiveCardPackReveal';
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

type InventoryViewOptions = ShopInventoryViews & {
  source: ShopInventorySource;
  routeDrop: FrontendDeploymentConfig | null;
  receiptOperationHiddenAssets: ReadonlySet<string>;
  pendingDeliveryItemIds: ReadonlySet<string>;
  connectedWallet: string | undefined;
  isSignedInWallet: boolean;
  stripeCheckoutInventoryRefreshPending: boolean;
  stripeCheckoutProfileRecoveryPending: boolean;
  walletIdleReady: boolean;
  authReady: boolean;
  deliveryCountryCode: string;
  cardNft2PackInventoryPreviewVideo: InventoryPreviewVideo;
  getDropConfig: (dropId?: string) => FrontendDeploymentConfig | undefined;
  figureReferenceForDropId: (dropId: string | undefined, reference: string | number) => string;
  boxReferenceForDropId: (dropId: string | undefined, reference: string | number) => string;
  boxLabelForDropId: (dropId?: string, count?: number, options?: { capitalize?: boolean; }) => string;
  boxImageForDropId: (dropId?: string) => string | undefined;
  canOpenBoxesForDropId: (dropId?: string) => boolean;
  usesClearCard3dRevealForDropId: (dropId?: string) => boolean;
  usesInteractiveCardPackRevealForDropId: (dropId?: string) => boolean;
};
export function useShopInventoryView({
  source,
  inventoryView,
  pendingOpenBoxesView,
  routeDrop,
  receiptOperationHiddenAssets,
  pendingDeliveryItemIds,
  connectedWallet,
  isSignedInWallet,
  stripeCheckoutInventoryRefreshPending,
  stripeCheckoutProfileRecoveryPending,
  walletIdleReady,
  authReady,
  deliveryCountryCode,
  cardNft2PackInventoryPreviewVideo,
  getDropConfig,
  figureReferenceForDropId,
  boxReferenceForDropId,
  boxLabelForDropId,
  boxImageForDropId,
  canOpenBoxesForDropId,
  usesClearCard3dRevealForDropId,
  usesInteractiveCardPackRevealForDropId,
}: InventoryViewOptions) {
  const {
    selected,
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

  const selectedItems = useMemo(() => {
    if (!selected.size) return [] as InventoryItem[];
    const inventoryById = new Map(inventoryView.map((item) => [item.id, item]));
    return Array.from(selected)
      .map((id) => inventoryById.get(id))
      .filter((item): item is InventoryItem => Boolean(item));
  }, [selected, inventoryView]);

  const selectedCount = selected.size;

  const deliverableItems = useMemo(
    () => selectedItems.filter((item) => (
      !pendingRevealIds.has(item.id) &&
      !pendingDeliveryItemIds.has(item.id) &&
      canDeliverItemKind(getDropConfig(item.dropId)?.dropFamily, item.kind)
    )),
    [getDropConfig, pendingDeliveryItemIds, pendingRevealIds, selectedItems],
  );

  const selectedDropIds = useMemo(
    () => Array.from(new Set(deliverableItems.map((item) => item.dropId).filter(Boolean))),
    [deliverableItems],
  );

  const selectionHasSingleDrop = selectedDropIds.length === 1;

  const selectedDropId = selectionHasSingleDrop ? selectedDropIds[0] : '';

  const selectedDropConfig = useMemo(
    () => (selectedDropId ? getDropConfig(selectedDropId) : undefined),
    [getDropConfig, selectedDropId],
  );

  const adminIrlRedeemSelection = useMemo(
    () => ({
      selectedCount,
      selectedDropIds,
      selectedItems,
      deliverableItems,
      selectionOwner: owner,
      selectedDropFamily: selectedDropConfig?.dropFamily,
    }),
    [deliverableItems, owner, selectedCount, selectedDropConfig?.dropFamily, selectedDropIds, selectedItems],
  );

  const canShowAdminIrlRedeem = useMemo(
    () =>
      canAdminIrlRedeemSelection({
        wallet: connectedWallet,
        isSignedInWallet,
        ...adminIrlRedeemSelection,
      }),
    [adminIrlRedeemSelection, connectedWallet, isSignedInWallet],
  );

  const selectionSummary = useMemo(() => {
    const boxCount = deliverableItems.filter((item) => item.kind === 'box').length;
    const figureCount = deliverableItems.filter((item) => item.kind === 'dude').length;
    if (!selectionHasSingleDrop) return `${selectedCount} selected`;
    const parts: string[] = [];
    if (boxCount) parts.push(dropAssetCount(selectedDropConfig, 'box', boxCount));
    if (figureCount) parts.push(dropAssetCount(selectedDropConfig, 'figure', figureCount));
    return parts.length ? parts.join(', ') : `${selectedCount} selected`;
  }, [deliverableItems, selectedCount, selectedDropConfig, selectionHasSingleDrop]);

  const deliveryEstimateLamports = useMemo(
    () =>
      calculateDeliveryLamports(
        deliverableItems,
        deliveryCountryCode,
        selectedDropConfig?.itemsPerBox,
        selectedDropConfig?.dropFamily,
      ),
    [deliverableItems, deliveryCountryCode, selectedDropConfig?.dropFamily, selectedDropConfig?.itemsPerBox],
  );

  const deliveryCtaLabel = useMemo(() => {
    if (deliveryEstimateLamports <= 0) return 'Send';
    const sol = (deliveryEstimateLamports / LAMPORTS_PER_SOL).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 9,
      useGrouping: false,
    });
    return `Send for ${sol} SOL`;
  }, [deliveryEstimateLamports]);

  const [compactPanel, setCompactPanel] = useState(false);

  const selectedPreview = useMemo(() => {
    const limit = compactPanel ? 3 : 5;
    const entries = selectedItems.map((item) => ({
      item,
      previewImage: item.kind === 'box'
        ? boxDisplayImageForInventoryItem(item)
        : item.image,
    }));
    const preview: typeof entries = [];
    const counts = new Map<string, number>();
    const addEntry = (entry: (typeof entries)[number]) => {
      preview.push(entry);
      if (!entry.previewImage) return;
      counts.set(entry.previewImage, (counts.get(entry.previewImage) || 0) + 1);
    };
    entries.forEach((entry) => {
      if (preview.length < limit) {
        addEntry(entry);
        return;
      }
      if (!entry.previewImage) return;
      if (counts.has(entry.previewImage)) return;
      let replaceIndex = -1;
      for (let i = 0;i < preview.length;i += 1) {
        const img = preview[i].previewImage;
        if (!img) continue;
        if ((counts.get(img) || 0) > 1) {
          replaceIndex = i;
          break;
        }
      }
      if (replaceIndex === -1) return;
      const [removed] = preview.splice(replaceIndex, 1);
      if (removed.previewImage) {
        const nextCount = (counts.get(removed.previewImage) || 1) - 1;
        if (nextCount <= 0) counts.delete(removed.previewImage);
        else counts.set(removed.previewImage, nextCount);
      }
      addEntry(entry);
    });
    return preview;
  }, [selectedItems, compactPanel]);

  const selectedOverflow = Math.max(0, selectedCount - selectedPreview.length);

  const canOpenSelected =
    selectedCount === 1 &&
    selectedItems[0]?.kind === 'box' &&
    !pendingDeliveryItemIds.has(selectedItems[0].id) &&
    canOpenBoxesForDropId(selectedItems[0]?.dropId);

  const selectedBox = canOpenSelected ? selectedItems[0] : null;

  const canShipSelected =
    selectedCount > 0 &&
    deliverableItems.length === selectedCount &&
    selectionHasSingleDrop;

  const selectedViewableItem = useMemo(() => {
    const item = selectedCount === 1 ? selectedItems[0] : null;
    if (!item) return null;
    if (item.kind === 'box') {
      return usesClearCard3dRevealForDropId(item.dropId) ? item : null;
    }
    if (item.kind !== 'dude') return null;
    if (typeof item.dudeId !== 'number') return null;
    if (
      usesInteractiveCardPackRevealForDropId(item.dropId) &&
      getInteractiveCardPackCardByFigureId(item.dropId, item.dudeId)
    ) {
      return item;
    }
    if (
      usesClearCard3dRevealForDropId(item.dropId) &&
      clearCardModelUrl(item.dudeId)
    ) {
      return item;
    }
    return null;
  }, [
    selectedCount,
    selectedItems,
    usesClearCard3dRevealForDropId,
    usesInteractiveCardPackRevealForDropId,
  ]);

  const canViewSelected = Boolean(selectedViewableItem);
  useEffect(() => {
    if (!pendingRevealIds.size) return;
    source.actions.removeSelected(pendingRevealIds);
  }, [pendingRevealIds]);
  useEffect(() => {
    if (!selected.size) return;
    source.actions.pruneSelection(new Set([...inventoryIndex.values()].filter(item => item.kind !== 'certificate').map(item => item.id)), pendingRevealIds);
  }, [selected, inventoryIndex, pendingRevealIds]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia('(max-width: 720px)');
    const sync = () => setCompactPanel(media.matches);
    sync();
    if (media.addEventListener) {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);
  const toggleSelected = (id: string) => {
    if (pendingDeliveryItemIds.has(id)) return;
    source.actions.toggleSelection(id, inventoryIndex);
  };
  return {
    inventoryItems, inventoryIndex, receiptItems, inventoryEmptyStateVisibility, inventoryInitialResponseReady,
    pendingRevealIds, shouldPreloadBoxFramesInitial,
    selected, selectedItems, selectedCount, deliverableItems, selectedDropIds, selectedDropId, selectedDropConfig,
    adminIrlRedeemSelection, canShowAdminIrlRedeem, selectionSummary, deliveryCtaLabel,
    selectedPreview, selectedOverflow, canOpenSelected, selectedBox, canShipSelected, selectedViewableItem, canViewSelected,
    toggleSelected,
  };
}
export type ShopInventoryView = ReturnType<typeof useShopInventoryView>;
