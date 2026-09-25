import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculateDeliveryLamports, canDeliverItemKind } from '../../../shared/shipping.ts';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { canAdminIrlRedeemSelection } from '../../lib/adminIrlRedeem';
import { clearCardModelUrl } from '../../lib/clearCardModels';
import { dropAssetCount } from '../../lib/dropLabels';
import { getInteractiveCardPackCardByFigureId } from '../../lib/interactiveCardPackReveal';
import { toggleInventorySelection } from '../../lib/inventorySelection';
import type { InventoryItem } from '../../types';
import { boxDisplayImageForInventoryItem } from './media';
import { MAX_SHIPMENT_ITEMS } from './stateSupport';

type SelectionScope = {
  connectedWallet: string | undefined;
  owner: string | undefined;
};

export function useShopInventorySelectionState({ connectedWallet, owner }: SelectionScope) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const previousScope = useRef({ connectedWallet, owner });
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const replaceSelection = useCallback((ids: Iterable<string>) => setSelected(new Set(ids)), []);
  const removeSelected = useCallback((ids: Iterable<string>) => setSelected((current) => {
    const next = new Set(current);
    for (const id of ids) next.delete(id);
    return next.size === current.size ? current : next;
  }), []);
  const pruneSelection = useCallback((validIds: ReadonlySet<string>, excludedIds: ReadonlySet<string>) => setSelected((current) => {
    const next = new Set([...current].filter((id) => validIds.has(id) && !excludedIds.has(id)));
    return next.size === current.size ? current : next;
  }), []);
  const toggleSelection = useCallback((id: string, inventoryIndex: ReadonlyMap<string, InventoryItem>) => {
    setSelected((previous) => toggleInventorySelection({ selected: previous, itemId: id, inventoryIndex, maxSelected: MAX_SHIPMENT_ITEMS }));
  }, []);

  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = { connectedWallet, owner };
    const connectingOwner = !previous.connectedWallet && Boolean(connectedWallet) &&
      connectedWallet === owner && previous.owner === owner;
    if (!connectingOwner && (previous.connectedWallet !== connectedWallet || previous.owner !== owner)) clearSelection();
  }, [connectedWallet, owner, clearSelection]);

  return { selected, clearSelection, replaceSelection, removeSelected, pruneSelection, toggleSelection };
}

type InventorySelectionOptions = SelectionScope & {
  state: ReturnType<typeof useShopInventorySelectionState>;
  inventoryView: InventoryItem[];
  inventoryIndex: ReadonlyMap<string, InventoryItem>;
  pendingRevealIds: ReadonlySet<string>;
  pendingDeliveryItemIds: ReadonlySet<string>;
  isSignedInWallet: boolean;
  deliveryCountryCode: string;
  dismissalBlocked: boolean;
  onDismissSelection?: () => void;
  getDropConfig: (dropId?: string) => FrontendDeploymentConfig | undefined;
  canOpenBoxesForDropId: (dropId?: string) => boolean;
  usesClearCard3dRevealForDropId: (dropId?: string) => boolean;
  usesInteractiveCardPackRevealForDropId: (dropId?: string) => boolean;
};

export function useShopInventorySelection({
  state,
  inventoryView,
  inventoryIndex,
  pendingRevealIds,
  pendingDeliveryItemIds,
  owner,
  connectedWallet,
  isSignedInWallet,
  deliveryCountryCode,
  dismissalBlocked,
  onDismissSelection,
  getDropConfig,
  canOpenBoxesForDropId,
  usesClearCard3dRevealForDropId,
  usesInteractiveCardPackRevealForDropId,
}: InventorySelectionOptions) {
  const { selected, clearSelection, pruneSelection, toggleSelection } = state;
  const selectedItems = useMemo(() => {
    if (!selected.size) return [] as InventoryItem[];
    const inventoryById = new Map(inventoryView.map((item) => [item.id, item]));
    return Array.from(selected)
      .map((id) => inventoryById.get(id))
      .filter((item): item is InventoryItem => Boolean(item));
  }, [selected, inventoryView]);

  const selectedCount = selected.size;
  const hasPreorderSelected = selectedItems.some((item) => item.kind === 'preorder');

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
    selectedCount > 0 && !hasPreorderSelected &&
    deliverableItems.length === selectedCount &&
    selectionHasSingleDrop;

  const selectedViewableItem = useMemo(() => {
    const item = selectedCount === 1 ? selectedItems[0] : null;
    if (!item) return null;
    if (item.kind === 'preorder') return item;
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
    if (!selected.size) return;
    const validIds = new Set(
      [...inventoryIndex.values()].filter((item) => item.kind !== 'certificate').map((item) => item.id),
    );
    pruneSelection(validIds, pendingRevealIds);
  }, [selected, inventoryIndex, pendingRevealIds, pruneSelection]);
  useEffect(() => {
    if (!selectedCount || dismissalBlocked) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onDismissSelection?.();
      clearSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedCount, dismissalBlocked, clearSelection, onDismissSelection]);
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
    toggleSelection(id, inventoryIndex);
  };
  return {
    selected, selectedItems, selectedCount, hasPreorderSelected, deliverableItems, selectedDropIds, selectedDropId, selectedDropConfig,
    adminIrlRedeemSelection, canShowAdminIrlRedeem, selectionSummary, deliveryCtaLabel,
    selectedPreview, selectedOverflow, canOpenSelected, selectedBox, canShipSelected, selectedViewableItem, canViewSelected,
    toggleSelected,
  };
}
export type ShopInventorySelection = ReturnType<typeof useShopInventorySelection>;
