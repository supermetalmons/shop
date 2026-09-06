import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  isDropFamily,
  normalizeDropId,
  type FrontendDeploymentConfig
} from '../../config/deployment';
import {
  removeHiddenAssetIds
} from '../../lib/adminIrlRedeem';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  loadFigureMetadata,
  parseFigureMetadataCacheKey,
  type FigureMetadataRecord,
  type FigureMetadataTarget,
} from '../../lib/figureMetadata';
import { toggleInventorySelection } from '../../lib/inventorySelection';
import {
  buildCurrentBoxIdIndexes,
  isUnresolvedCardNft2Box,
  localMintedBoxExpiresAt,
  pruneExpiredLocalMintedBoxes,
  reconcileLocalMintedBoxes,
  refreshLocalMintedBoxCountExpectations,
  type CurrentBoxIdIndexes,
  type LocalMintedBox,
  type LocalMintedBoxMatch
} from '../../lib/localMintedBoxes';
import {
  InventoryItem,
  PendingOpenBox
} from '../../types';
import {
  hiddenInventoryKey,
  loadHiddenAssets,
  loadPendingReveals,
  loadRecentReveals,
  persistHiddenAssets,
  persistPendingReveals,
  persistRecentReveals,
  type LocalPendingReveal
} from '../persistedState';
import { startPostActionInventoryPolling } from '../postActionPolling';
import { RevealOverlayState } from '../reveal/types';
import { FIGURE_METADATA_RETRY_MS, LOCAL_PENDING_GRACE_MS, MAX_SHIPMENT_ITEMS, RECENT_REVEALS_LIMIT, pendingRevealListEqual } from './stateSupport';
import type { ShopInventoryQueries } from './useShopInventoryQueries';

export type ShopInventoryViews = {
  inventoryView: InventoryItem[];
  pendingOpenBoxesView: PendingOpenBox[];
  revealOverlay: RevealOverlayState | null;
};
type InventorySourceOptions = ShopInventoryQueries & {
  owner: string | undefined;
  connectedWallet: string | undefined;
  localAccountWallet: string | undefined;
  isViewerMode: boolean;
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
};
export function useShopInventorySource(options: InventorySourceOptions) {
  const {
    owner,
    connectedWallet,
    localAccountWallet,
    isViewerMode,
    requireKnownDropConfig,
    inventory,
    inventoryFetched,
    pendingOpenBoxesSuccess,
  } = options;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiddenAssets, setHiddenAssets] = useState<Set<string>>(() => loadHiddenAssets(localAccountWallet));
  const [localPendingReveals, setLocalPendingReveals] = useState<LocalPendingReveal[]>(() =>
    loadPendingReveals(localAccountWallet),
  );
  const [recentRevealedBoxes, setRecentRevealedBoxes] = useState<string[]>(() => loadRecentReveals(localAccountWallet));
  const [localMintedBoxes, setLocalMintedBoxes] = useState<LocalMintedBox[]>([]);
  const [localRevealedDudeKeys, setLocalRevealedDudeKeys] = useState<string[]>([]);
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const figureMetadataRef = useRef<Record<string, FigureMetadataRecord>>({});
  const figureMetadataLoadingRef = useRef<Set<string>>(new Set());
  const figureMetadataRetryAtRef = useRef<Map<string, number>>(new Map());
  const localAccountWalletRef = useRef<string | null>(localAccountWallet || null);
  const pendingRevealHydrationWalletRef = useRef<string | null>(null);
  const recentRevealHydrationWalletRef = useRef<string | null>(null);
  const localMintCounterRef = useRef(0);
  const knownBoxIdIndexesRef = useRef<CurrentBoxIdIndexes>({
    allByDrop: new Map(),
    resolvedByDrop: new Map(),
    unresolvedByDrop: new Map(),
  });
  useLayoutEffect(() => { localAccountWalletRef.current = localAccountWallet || null; }, [localAccountWallet]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (localAccountWallet && event.key === hiddenInventoryKey(localAccountWallet)) setHiddenAssets(loadHiddenAssets(localAccountWallet));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [localAccountWallet]);
  useEffect(() => {
    setHiddenAssets(loadHiddenAssets(localAccountWallet));
  }, [localAccountWallet]);
  useEffect(() => {

    const hydrationWallet = localAccountWallet || '';
    pendingRevealHydrationWalletRef.current = hydrationWallet;
    recentRevealHydrationWalletRef.current = hydrationWallet;
    setLocalPendingReveals(loadPendingReveals(localAccountWallet));
    setRecentRevealedBoxes(loadRecentReveals(localAccountWallet).slice(0, RECENT_REVEALS_LIMIT));
    setLocalMintedBoxes([]);

    setLocalRevealedDudeKeys([]);
    setFigureMetadataByKey({});
    figureMetadataRef.current = {};
    figureMetadataLoadingRef.current.clear();
    figureMetadataRetryAtRef.current.clear();
    localMintCounterRef.current = 0;
    knownBoxIdIndexesRef.current = {
      allByDrop: new Map(),
      resolvedByDrop: new Map(),
      unresolvedByDrop: new Map(),
    };

  }, [localAccountWallet]);
  useEffect(() => {
    const hydrationWallet = localAccountWallet || '';
    if (pendingRevealHydrationWalletRef.current === hydrationWallet) {
      pendingRevealHydrationWalletRef.current = null;
      return;
    }
    if (!localAccountWallet || isViewerMode) return;
    persistPendingReveals(localAccountWallet, localPendingReveals);
  }, [localAccountWallet, localPendingReveals, isViewerMode]);

  useEffect(() => {
    const hydrationWallet = localAccountWallet || '';
    if (recentRevealHydrationWalletRef.current === hydrationWallet) {
      recentRevealHydrationWalletRef.current = null;
      return;
    }
    if (!localAccountWallet || isViewerMode) return;
    persistRecentReveals(localAccountWallet, recentRevealedBoxes);
  }, [localAccountWallet, recentRevealedBoxes, isViewerMode]);

  useEffect(() => {
    figureMetadataRef.current = figureMetadataByKey;
  }, [figureMetadataByKey]);
  const addLocalPendingReveal = (item: InventoryItem) => {
    if (!connectedWallet || isViewerMode) return;
    const now = Date.now();
    setLocalPendingReveals((prev) => {
      const nextEntry: LocalPendingReveal = {
        id: item.id,
        createdAt: now,
        dropId: item.dropId,
        name: item.name,
        image: item.image,
        boxId: item.boxId,
      };
      const existingIndex = prev.findIndex((entry) => entry.id === item.id);
      if (existingIndex !== -1) {
        const next = [...prev];
        next[existingIndex] = { ...next[existingIndex], ...nextEntry };
        return next;
      }
      return [nextEntry, ...prev];
    });
  };
  const addLocalMintedBoxes = (quantity: number, dropId: string, assetIds: readonly string[] = [], inventoryView: InventoryItem[] = inventory) => {
    if (isViewerMode) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const normalizedDropId = normalizeDropId(dropId);
    if (!normalizedDropId) return;
    const now = Date.now();
    setLocalMintedBoxes((prev) => {
      const entries: LocalMintedBox[] = [];
      const knownBoxItems = inventoryFetched
        ? inventoryView.filter((item) => item.kind === 'box' && normalizeDropId(item.dropId) === normalizedDropId)
        : undefined;
      const isCardNft2Drop = isDropFamily(normalizedDropId, 'card_nft_2');
      const knownInventoryCount = knownBoxItems?.filter((item) => !isUnresolvedCardNft2Box(item)).length;
      const baselineAssetIds = knownBoxItems && isCardNft2Drop ? knownBoxItems.map((item) => item.id) : undefined;
      const pendingForDrop = prev.filter((entry) => entry.dropId === normalizedDropId).length;
      for (let i = 0;i < Math.floor(quantity);i += 1) {
        const expectedAssetId = isCardNft2Drop ? assetIds[i] : undefined;
        const match: LocalMintedBoxMatch = expectedAssetId
          ? { kind: 'asset', expectedAssetId }
          : baselineAssetIds
            ? { kind: 'baseline', baselineAssetIds }
            : {
              kind: 'count',
              ...(knownInventoryCount != null
                ? { expectedInventoryCount: knownInventoryCount + pendingForDrop + i + 1 }
                : {}),
            };
        localMintCounterRef.current += 1;
        entries.push({
          id: `local-minted-${now}-${localMintCounterRef.current}`,
          dropId: normalizedDropId,
          createdAt: now + i,
          match,
        });
      }
      return entries.length ? [...entries, ...prev] : prev;
    });
  };
  const removeLocalPendingReveal = (id: string) => {
    setLocalPendingReveals((prev) => {
      const next = prev.filter((entry) => entry.id !== id);
      return next.length === prev.length ? prev : next;
    });
  };
  const rememberRecentReveal = (boxId: string) => {
    if (isViewerMode) return;
    if (!boxId) return;
    setRecentRevealedBoxes((prev) => {
      const next = [boxId, ...prev.filter((id) => id !== boxId)];
      return next.slice(0, RECENT_REVEALS_LIMIT);
    });
  };
  const queueFigureMetadataFetch = useCallback((targets: FigureMetadataTarget[]) => {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    const seen = new Set<string>();
    targets.forEach((target) => {
      const id = Number(target.figureId);
      if (!Number.isFinite(id) || id <= 0) return;
      const drop = requireKnownDropConfig(target.dropId, `figure metadata target ${target.dropId}:${id}`);
      const cacheKey = figureMetadataCacheKey(drop.dropId, id);
      if (seen.has(cacheKey)) return;
      seen.add(cacheKey);
      const cached = figureMetadataRef.current[cacheKey] || getCachedFigureMetadata(drop.dropId, id);
      if (figureMetadataHasImage(cached)) {
        setFigureMetadataByKey((prev) =>
          figureMetadataHasImage(prev[cacheKey]) ? prev : { ...prev, [cacheKey]: cached },
        );
        return;
      }
      if (figureMetadataLoadingRef.current.has(cacheKey)) return;
      const retryAt = figureMetadataRetryAtRef.current.get(cacheKey);
      if (retryAt && retryAt > now) return;
      figureMetadataLoadingRef.current.add(cacheKey);
      void (async () => {
        try {
          const metadata = await loadFigureMetadata(drop.dropId, id);
          if (!metadata) throw new Error('metadata fetch failed');
          setFigureMetadataByKey((prev) => {
            const existing = prev[cacheKey];
            if (
              existing &&
              existing.image === metadata.image &&
              existing.name === metadata.name &&
              existing.attributes === metadata.attributes
            ) {
              return prev;
            }
            return {
              ...prev,
              [cacheKey]: metadata,
            };
          });
          figureMetadataRetryAtRef.current.delete(cacheKey);
        } catch (err) {
          console.warn('[mons] failed to load figure metadata', {
            dropId: drop.dropId,
            id,
            cacheKey,
            error: err,
          });
          figureMetadataRetryAtRef.current.set(cacheKey, Date.now() + FIGURE_METADATA_RETRY_MS);
        } finally {
          figureMetadataLoadingRef.current.delete(cacheKey);
        }
      })();
    });
  }, [requireKnownDropConfig]);
  const addLocalRevealedDudes = (ids: number[], dropId: string) => {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
    if (!uniqueIds.length) return;
    const canonicalDropId = requireKnownDropConfig(dropId, 'revealed dudes').dropId;
    const targets = uniqueIds.map((id) => ({ dropId: canonicalDropId, figureId: id }));
    setLocalRevealedDudeKeys((prev) => {
      const next = new Set(prev);
      targets.forEach((target) => {
        next.add(figureMetadataCacheKey(target.dropId, target.figureId));
      });
      return Array.from(next);
    });
    queueFigureMetadataFetch(targets);
  };
  const mergeLoadedFigureMetadata = useCallback((record: FigureMetadataRecord) => {
    const cacheKey = figureMetadataCacheKey(record.dropId, record.id);
    setFigureMetadataByKey((prev) => {
      const existing = prev[cacheKey];
      if (
        existing &&
        existing.image === record.image &&
        existing.name === record.name &&
        existing.attributes === record.attributes
      ) {
        return prev;
      }
      return {
        ...prev,
        [cacheKey]: record,
      };
    });
  }, []);
  const hideAssetsForWallet = useCallback((wallet: string, ids: readonly string[]) => {
    const stored = loadHiddenAssets(wallet);
    const nextStored = new Set(stored);
    ids.forEach((id) => {
      if (typeof id === 'string' && id) nextStored.add(id);
    });
    if (nextStored.size !== stored.size) persistHiddenAssets(wallet, nextStored);
    if (localAccountWalletRef.current !== wallet) return;
    setHiddenAssets((prev) => {
      if (localAccountWalletRef.current !== wallet) return prev;
      const next = new Set([...prev, ...nextStored]);
      return next.size === prev.size ? prev : next;
    });
  }, []);
  const markAssetsHidden = useMemo(() => {
    if (!connectedWallet || isViewerMode) return (_ids: string[]) => undefined;
    return (ids: string[]) => hideAssetsForWallet(connectedWallet, ids);
  }, [connectedWallet, hideAssetsForWallet, isViewerMode]);
  const unhideAssetsForWallet = useCallback((wallet: string, ids: readonly string[]) => {
    const stored = loadHiddenAssets(wallet);
    const nextStored = removeHiddenAssetIds(stored, ids);
    if (nextStored.size !== stored.size) {
      persistHiddenAssets(wallet, nextStored);
    }
    if (localAccountWalletRef.current !== wallet) return;
    setHiddenAssets((prev) => {
      if (localAccountWalletRef.current !== wallet) return prev;
      const next = removeHiddenAssetIds(prev, ids);
      if (next.size === prev.size) return prev;
      persistHiddenAssets(wallet, next);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const replaceSelection = useCallback((ids: Iterable<string>) => setSelected(new Set(ids)), []);
  const removeSelected = useCallback((ids: Iterable<string>) => setSelected(current => {
    const next = new Set(current);
    for (const id of ids) next.delete(id);
    return next.size === current.size ? current : next;
  }), []);
  const pruneSelection = useCallback((validIds: ReadonlySet<string>, excludedIds: ReadonlySet<string>) => setSelected(current => {
    const next = new Set([...current].filter(id => validIds.has(id) && !excludedIds.has(id)));
    return next.size === current.size ? current : next;
  }), []);
  const toggleSelection = (id: string, inventoryIndex: ReadonlyMap<string, InventoryItem>) => {
    setSelected(previous => toggleInventorySelection({ selected: previous, itemId: id, inventoryIndex, maxSelected: MAX_SHIPMENT_ITEMS }));
  };
  function reconcilePendingReveals({ inventoryView, pendingOpenBoxesView, revealOverlay }: ShopInventoryViews) {
    if (!owner || isViewerMode) return;
    if (revealOverlay) return;
    const recentSet = new Set(recentRevealedBoxes);
    const now = Date.now();
    if (!pendingOpenBoxesSuccess) {
      const next = localPendingReveals.filter((entry) => !recentSet.has(entry.id));
      if (!pendingRevealListEqual(next, localPendingReveals)) {
        setLocalPendingReveals(next);
      }
      return;
    }
    const onchainIds = new Set(pendingOpenBoxesView.map((entry) => entry.boxAssetId).filter(Boolean));
    const inventoryById = new Map(inventoryView.map((item) => [item.id, item]));
    const nextMap = new Map<string, LocalPendingReveal>();
    pendingOpenBoxesView.forEach((entry) => {
      const id = entry.boxAssetId;
      if (!id || recentSet.has(id)) return;
      const existing = localPendingReveals.find((item) => item.id === id);
      const match = inventoryById.get(id);
      nextMap.set(id, {
        id,
        createdAt: existing?.createdAt || now,
        dropId: existing?.dropId || entry.dropId || match?.dropId,
        name: existing?.name || match?.name,
        image: existing?.image || match?.image,
        boxId: existing?.boxId || match?.boxId,
      });
    });
    localPendingReveals.forEach((entry) => {
      if (recentSet.has(entry.id)) return;
      if (onchainIds.has(entry.id)) return;
      if (now - entry.createdAt > LOCAL_PENDING_GRACE_MS) return;
      nextMap.set(entry.id, entry);
    });
    const next = Array.from(nextMap.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (!pendingRevealListEqual(next, localPendingReveals)) {
      setLocalPendingReveals(next);
    }
  }

  function reconcileMintedBoxes({ inventoryView, revealOverlay }: ShopInventoryViews) {
    if (isViewerMode) return;
    if (revealOverlay) return;
    if (!inventoryFetched) return;
    const currentBoxIds = buildCurrentBoxIdIndexes(inventoryView);
    if (localMintedBoxes.length) {
      const previousAllBoxIdsByDrop = knownBoxIdIndexesRef.current.allByDrop;
      setLocalMintedBoxes((prev) =>
        reconcileLocalMintedBoxes(prev, currentBoxIds, previousAllBoxIdsByDrop, Date.now()),
      );
    }
    knownBoxIdIndexesRef.current = currentBoxIds;
  }

  function pruneExpiredMintedBoxes({ revealOverlay }: ShopInventoryViews) {
    if (isViewerMode) return undefined;
    if (revealOverlay) return undefined;

    const pruneExpired = () => {
      setLocalMintedBoxes((prev) => pruneExpiredLocalMintedBoxes(prev, Date.now()));
    };
    const now = Date.now();
    let nextExpiresAt: number | null = null;
    for (const entry of localMintedBoxes) {
      const expiresAt = localMintedBoxExpiresAt(entry);
      if (expiresAt == null) continue;
      if (expiresAt <= now) {
        pruneExpired();
        return undefined;
      }
      nextExpiresAt = nextExpiresAt == null ? expiresAt : Math.min(nextExpiresAt, expiresAt);
    }

    if (nextExpiresAt == null || typeof window === 'undefined') return undefined;
    const timeout = window.setTimeout(pruneExpired, Math.max(0, nextExpiresAt - now));

    return () => window.clearTimeout(timeout);
  }

  function refreshMintedExpectations() {
    if (isViewerMode) return;
    if (!inventoryFetched) return;
    setLocalMintedBoxes((prev) =>
      refreshLocalMintedBoxCountExpectations(prev, knownBoxIdIndexesRef.current.resolvedByDrop),
    );
  }

  function reconcileRevealedFigures({ inventoryView, revealOverlay }: ShopInventoryViews) {
    if (isViewerMode) return;
    if (revealOverlay) return;
    if (!localRevealedDudeKeys.length) return;
    const chainDudes = new Map<string, InventoryItem>();
    inventoryView.forEach((item) => {
      if (item.kind !== 'dude') return;
      if (!item.dudeId) return;
      chainDudes.set(figureMetadataCacheKey(item.dropId, item.dudeId), item);
    });
    setLocalRevealedDudeKeys((prev) => {
      const next = prev.filter((cacheKey) => {
        const item = chainDudes.get(cacheKey);
        if (!item) return true;
        const meta = figureMetadataByKey[cacheKey];
        if (item.image && String(item.image).trim()) return false;
        return !figureMetadataHasImage(meta);
      });
      return next.length === prev.length ? prev : next;
    });
  }
  return {
    queries: options,
    selected, hiddenAssets, localPendingReveals, recentRevealedBoxes, localMintedBoxes, localRevealedDudeKeys, figureMetadataByKey,
    actions: { addLocalPendingReveal, addLocalMintedBoxes, removeLocalPendingReveal, rememberRecentReveal, queueFigureMetadataFetch, addLocalRevealedDudes, mergeLoadedFigureMetadata, hideAssetsForWallet, markAssetsHidden, unhideAssetsForWallet, clearSelection, replaceSelection, removeSelected, pruneSelection, toggleSelection },
    maintenance: { reconcilePendingReveals, reconcileMintedBoxes, pruneExpiredMintedBoxes, refreshMintedExpectations, reconcileRevealedFigures },
  };
}
export type ShopInventorySource = ReturnType<typeof useShopInventorySource>;
export function useShopInventoryMaintenance(source: ShopInventorySource, views: ShopInventoryViews) {
  const { inventoryView, pendingOpenBoxesView, revealOverlay } = views;
  const { owner, isViewerMode, inventoryFetched, pendingOpenBoxesSuccess, refetchInventory } = source.queries;
  const { recentRevealedBoxes, localPendingReveals, localMintedBoxes, localRevealedDudeKeys, figureMetadataByKey } = source;
  const { queueFigureMetadataFetch } = source.actions;
  useEffect(() => source.maintenance.reconcilePendingReveals(views), [
    owner,
    isViewerMode,
    pendingOpenBoxesView,
    pendingOpenBoxesSuccess,
    localPendingReveals,
    recentRevealedBoxes,
    inventoryView,
    revealOverlay,
  ]);
  useEffect(() => source.maintenance.reconcileMintedBoxes(views), [inventoryView, inventoryFetched, localMintedBoxes.length, revealOverlay, isViewerMode]);
  useEffect(() => source.maintenance.pruneExpiredMintedBoxes(views), [localMintedBoxes, revealOverlay, isViewerMode]);
  useEffect(() => source.maintenance.refreshMintedExpectations(), [inventoryFetched, isViewerMode]);
  useEffect(() => source.maintenance.reconcileRevealedFigures(views), [inventoryView, localRevealedDudeKeys, figureMetadataByKey, revealOverlay, isViewerMode]);
  const figureTargetsNeedingMetadata = useMemo(() => {
    const targetsByKey = new Map<string, FigureMetadataTarget>();
    localRevealedDudeKeys.forEach((cacheKey) => {
      const parsed = parseFigureMetadataCacheKey(cacheKey);
      if (!parsed) return;
      if (!figureMetadataHasImage(figureMetadataByKey[cacheKey])) targetsByKey.set(cacheKey, parsed);
    });
    inventoryView.forEach((item) => {
      if (item.kind !== 'dude') return;
      if (!item.dudeId) return;
      if (item.image && String(item.image).trim()) return;
      const cacheKey = figureMetadataCacheKey(item.dropId, item.dudeId);
      if (!figureMetadataHasImage(figureMetadataByKey[cacheKey])) {
        targetsByKey.set(cacheKey, { dropId: item.dropId, figureId: item.dudeId });
      }
    });
    return Array.from(targetsByKey.values());
  }, [inventoryView, localRevealedDudeKeys, figureMetadataByKey]);

  useEffect(() => {
    if (!figureTargetsNeedingMetadata.length) return;
    if (typeof window === 'undefined') return;
    queueFigureMetadataFetch(figureTargetsNeedingMetadata);
    const interval = window.setInterval(() => {
      queueFigureMetadataFetch(figureTargetsNeedingMetadata);
    }, FIGURE_METADATA_RETRY_MS);
    return () => window.clearInterval(interval);
  }, [figureTargetsNeedingMetadata, queueFigureMetadataFetch]);

  const shouldPollInventory =
    !isViewerMode && !revealOverlay && (localRevealedDudeKeys.length > 0 || localMintedBoxes.length > 0);

  useEffect(() => {
    if (!shouldPollInventory) return;
    if (typeof window === 'undefined') return;
    return startPostActionInventoryPolling(refetchInventory, {
      setInterval: (run, delayMs) => window.setInterval(run, delayMs),
      clearInterval: (timer) => window.clearInterval(timer as number),
    });
  }, [shouldPollInventory, refetchInventory]);
}
