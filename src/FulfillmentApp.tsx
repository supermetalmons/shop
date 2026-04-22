import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { listFulfillmentOrders, updateFulfillmentStatus } from './lib/api';
import { FulfillmentOrder, FulfillmentOrdersCursor, FulfillmentStatus } from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  loadFigureMetadata,
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from './lib/figureMetadata';
import { joinDropAssetUrl, normalizeBoxDisplayImage, resolveDropContent } from './lib/dropContent';
import { dropAssetLabel, dropAssetReference, dropMintSelectionLabel } from './lib/dropLabels';
import { isDirectDeliveryItemsPerBox } from './lib/shipping';
import { Modal } from './components/Modal';
import { listFrontendDrops, normalizeDropId, type FigureMediaConfig, type FrontendDeploymentConfig } from './config/deployment';
import { listAllowedFulfillmentDropIds } from './lib/fulfillmentAccess';

const FULFILLMENT_ORDER_REQUEST_LIMIT = 1000;
const LITTLE_SWAG_BOXES_DROP_ID = 'little_swag_boxes';
const FIGURE_METADATA_RETRY_MS = 3000;
const FULFILLMENT_STATUS_OPTIONS = ['Preparing', 'Shipped'] as const;
const ORDER_VISIBILITY_OPTIONS = [
  { value: 'not_shipped', label: 'Not shipped' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'all', label: 'All' },
] as const;

type OrderVisibilityFilter = (typeof ORDER_VISIBILITY_OPTIONS)[number]['value'];
const DEFAULT_ORDER_VISIBILITY_FILTER: OrderVisibilityFilter = 'not_shipped';

function normalizeFulfillmentStatus(value: unknown): FulfillmentStatus | '' {
  return value === 'Preparing' || value === 'Shipped' ? value : '';
}

function formatOrderDate(ts?: number) {
  if (!ts) return 'Date pending';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatOrderStatus(status: string) {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function listOrderFigureIds(order: FulfillmentOrder): number[] {
  return [...order.looseDudes, ...order.boxes.flatMap((box) => box.dudeIds)];
}

type DuplicateFigureSummary = {
  groupKey: string;
  figureId: number;
  labelId: string;
  count: number;
  sortValue: number;
};

type FulfillmentOrderGroup = {
  pageIndex: number;
  groupKey: string;
  orders: FulfillmentOrder[];
  collapseSharedContact: boolean;
};

function fulfillmentOrderGroupKey(order: FulfillmentOrder): string {
  const owner = typeof order.owner === 'string' ? order.owner.trim() : '';
  return owner ? `owner:${owner}` : `delivery:${order.deliveryId}`;
}

function dedupeOrdersByDeliveryId(orders: FulfillmentOrder[], existingDeliveryIds?: Set<number>): FulfillmentOrder[] {
  const seen = existingDeliveryIds ? new Set(existingDeliveryIds) : new Set<number>();
  return orders.filter((order) => {
    if (seen.has(order.deliveryId)) return false;
    seen.add(order.deliveryId);
    return true;
  });
}

function normalizeFulfillmentOrderMatchValue(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]+/g, '')
    .toLowerCase();
}

function parseFulfillmentOrderFullAddress(full?: string | null): { name: string; deliveryAddress: string } | null {
  if (typeof full !== 'string') return null;
  const normalized = full.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized === '***') return null;
  const [name, ...addressLines] = normalized.split('\n');
  const deliveryAddress = addressLines.join('\n');
  if (!name || !deliveryAddress) return null;
  return { name, deliveryAddress };
}

function canCollapseFulfillmentOrderGroupContact(orders: FulfillmentOrder[]): boolean {
  if (orders.length < 2) return false;
  const [firstOrder, ...restOrders] = orders;
  const firstAddress = parseFulfillmentOrderFullAddress(firstOrder.address.full);
  if (!firstAddress) return false;
  const firstEmail = normalizeFulfillmentOrderMatchValue(
    typeof firstOrder.address.email === 'string' ? firstOrder.address.email : '',
  );
  const firstName = normalizeFulfillmentOrderMatchValue(firstAddress.name);
  const firstDeliveryAddress = normalizeFulfillmentOrderMatchValue(firstAddress.deliveryAddress);
  if (!firstName) return false;

  return restOrders.every((order) => {
    const currentAddress = parseFulfillmentOrderFullAddress(order.address.full);
    if (!currentAddress) return false;
    const currentEmail = normalizeFulfillmentOrderMatchValue(
      typeof order.address.email === 'string' ? order.address.email : '',
    );
    return (
      currentEmail === firstEmail &&
      normalizeFulfillmentOrderMatchValue(currentAddress.deliveryAddress) === firstDeliveryAddress &&
      normalizeFulfillmentOrderMatchValue(currentAddress.name) === firstName
    );
  });
}

function summarizeDuplicateFigures(args: {
  orders: FulfillmentOrder[];
  previewMode: 'media_map_folder' | 'metadata_stills';
  figureMedia?: FigureMediaConfig;
  minimumCount?: number;
}): DuplicateFigureSummary[] {
  const { orders, previewMode, figureMedia, minimumCount = 2 } = args;
  const grouped = new Map<string, DuplicateFigureSummary>();

  orders.forEach((order) => {
    listOrderFigureIds(order).forEach((figureIdRaw) => {
      const figureId = Math.floor(Number(figureIdRaw));
      if (!Number.isFinite(figureId) || figureId <= 0) return;

      const mediaId = previewMode === 'media_map_folder' ? getMediaIdForFigureId(figureId, figureMedia) : null;
      const key = mediaId ? `media:${mediaId}` : `figure:${figureId}`;
      const labelId = mediaId ? String(mediaId) : String(figureId);
      const sortValue = mediaId ?? figureId;
      const existing = grouped.get(key);

      if (existing) {
        existing.count += 1;
        if (figureId < existing.figureId) {
          existing.figureId = figureId;
        }
        return;
      }

      grouped.set(key, {
        groupKey: key,
        figureId,
        labelId,
        count: 1,
        sortValue,
      });
    });
  });

  return Array.from(grouped.values())
    .filter((entry) => entry.count >= minimumCount)
    .sort((a, b) => b.count - a.count || a.sortValue - b.sortValue || a.figureId - b.figureId);
}

function mergeFigureMetadataRecords(
  prev: Record<string, FigureMetadataRecord>,
  records: FigureMetadataRecord[],
): Record<string, FigureMetadataRecord> {
  let changed = false;
  const next = { ...prev };
  records.forEach((record) => {
    const key = figureMetadataCacheKey(record.dropId, record.id);
    const existing = next[key];
    if (
      figureMetadataHasImage(existing) &&
      existing.image === record.image &&
      existing.name === record.name &&
      existing.attributes === record.attributes
    ) {
      return;
    }
    next[key] = record;
    changed = true;
  });
  return changed ? next : prev;
}

function FigureTileImage(props: {
  dropId: string;
  figureId: number;
  alt: string;
  primarySrc?: string;
  fallbackSrc?: string;
  onMetadataResolved?: (record: FigureMetadataRecord) => void;
}) {
  const { dropId, figureId, alt, primarySrc, fallbackSrc, onMetadataResolved } = props;
  const [activeSrc, setActiveSrc] = useState<string | null>(() => primarySrc || fallbackSrc || null);
  const [usingFallback, setUsingFallback] = useState(() => !primarySrc && Boolean(fallbackSrc));
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    if (primarySrc) {
      setActiveSrc(primarySrc);
      setUsingFallback(false);
      return;
    }
    if (fallbackSrc) {
      setActiveSrc(fallbackSrc);
      setUsingFallback(true);
      return;
    }
    setActiveSrc(null);
    setUsingFallback(false);
  }, [dropId, figureId, primarySrc]);

  useEffect(() => {
    if (!fallbackSrc) return;
    setActiveSrc((current) => (current ? current : fallbackSrc));
    setUsingFallback((current) => current || !primarySrc);
  }, [fallbackSrc, primarySrc]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const handleError = useCallback(() => {
    if (usingFallback) {
      setActiveSrc(null);
      return;
    }
    if (fallbackSrc && fallbackSrc !== primarySrc) {
      setActiveSrc(fallbackSrc);
      setUsingFallback(true);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setActiveSrc(null);
    void loadFigureMetadata(dropId, figureId)
      .then((record) => {
        if (requestIdRef.current !== requestId || !record?.image || record.image === primarySrc) return;
        onMetadataResolved?.(record);
        setActiveSrc(record.image);
        setUsingFallback(true);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setActiveSrc(null);
      });
  }, [dropId, fallbackSrc, figureId, onMetadataResolved, primarySrc, usingFallback]);

  if (!activeSrc) {
    return <div className="figure-image figure-image--placeholder" aria-hidden="true" />;
  }

  return <img src={activeSrc} alt={alt} loading="lazy" className="figure-image" onError={handleError} />;
}

function renderFigureTiles(args: {
  dropId: string;
  figureIds: number[];
  keyPrefix: string;
  figureNamePrefix?: string;
  previewMode: 'media_map_folder' | 'metadata_stills';
  figureMedia?: FigureMediaConfig;
  figureMediaBase?: string;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  onMetadataResolved?: (record: FigureMetadataRecord) => void;
  labelOverride?: (args: { figureId: number; index: number; mediaId: number | null; fallbackName: string }) => string;
}) {
  const {
    dropId,
    figureIds,
    keyPrefix,
    figureNamePrefix,
    previewMode,
    figureMedia,
    figureMediaBase,
    figureMetadataByKey,
    onMetadataResolved,
    labelOverride,
  } = args;
  const labelSource = { namePrefix: undefined, figureNamePrefix };
  return (
    <div className="figure-grid">
      {figureIds.map((figureId, index) => {
        const metadata = figureMetadataByKey[figureMetadataCacheKey(dropId, figureId)] || getCachedFigureMetadata(dropId, figureId);
        const metadataImage = figureMetadataHasImage(metadata) ? metadata.image : undefined;
        const fallbackName = metadata?.name || dropAssetReference(labelSource, 'figure', figureId);
        const mediaId = previewMode === 'media_map_folder' ? getMediaIdForFigureId(figureId, figureMedia) : null;
        const label = labelOverride?.({ figureId, index, mediaId, fallbackName }) || (mediaId ? String(mediaId) : fallbackName);
        if (previewMode === 'media_map_folder') {
          const src = mediaId ? joinDropAssetUrl(figureMediaBase, `${mediaId}.webp`) : undefined;
          return (
            <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
              <FigureTileImage
                dropId={dropId}
                figureId={figureId}
                primarySrc={src}
                fallbackSrc={metadataImage}
                alt={mediaId ? `Media ${mediaId}` : fallbackName}
                onMetadataResolved={onMetadataResolved}
              />
              <div className="muted small">{label}</div>
            </div>
          );
        }
        return (
          <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
            <FigureTileImage
              dropId={dropId}
              figureId={figureId}
              fallbackSrc={metadataImage}
              alt={fallbackName}
              onMetadataResolved={onMetadataResolved}
            />
            <div className="muted small">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

function renderBoxTiles(args: {
  boxIds: number[];
  keyPrefix: string;
  labelSource: Pick<FrontendDeploymentConfig, 'namePrefix' | 'figureNamePrefix' | 'mintSelection'>;
  previewSrc?: string;
}) {
  const { boxIds, keyPrefix, labelSource, previewSrc } = args;
  return (
    <div className="figure-grid">
      {boxIds.map((boxId, index) => {
        const sizeLabel = dropMintSelectionLabel(labelSource, boxId);
        const label = sizeLabel || dropAssetReference(labelSource, 'box', boxId);
        return (
          <div key={`${keyPrefix}:${boxId}:${index}`} className="figure-tile">
            {previewSrc ? (
              <img src={previewSrc} alt={label} loading="lazy" className="figure-image" />
            ) : (
              <div className="figure-image figure-image--placeholder" aria-hidden="true" />
            )}
            <div className={sizeLabel ? 'fulfillment-size-label' : 'muted small'}>{label}</div>
          </div>
        );
      })}
    </div>
  );
}

type FulfillmentAppProps = {
  selectedDropId: string;
  onSelectedDropIdChange: (dropId: string) => void;
};

export default function FulfillmentApp({ selectedDropId, onSelectedDropIdChange }: FulfillmentAppProps) {
  const allDrops = useMemo(() => listFrontendDrops(), []);
  const walletAdapter = useWallet();
  const { publicKey } = walletAdapter;
  const { visible: walletModalVisible, setVisible: setWalletModalVisible } = useWalletModal();
  const { profile, signIn, loading: authLoading, error: authError } = useSolanaAuth();
  const walletAddress = publicKey?.toBase58() || '';
  const allowedDropIds = useMemo(
    () => listAllowedFulfillmentDropIds(walletAddress, allDrops.map((drop) => drop.dropId)),
    [allDrops, walletAddress],
  );
  const visibleDrops = useMemo(() => {
    const allowedDropIdsSet = new Set(allowedDropIds);
    return allDrops.filter((drop) => allowedDropIdsSet.has(drop.dropId));
  }, [allowedDropIds, allDrops]);
  const selectedDrop = useMemo(
    () => visibleDrops.find((drop) => drop.dropId === selectedDropId) || null,
    [visibleDrops, selectedDropId],
  );
  const isLittleSwagBoxesDrop = normalizeDropId(selectedDrop?.dropId || '') === LITTLE_SWAG_BOXES_DROP_ID;
  const isDirectDeliveryDrop = isDirectDeliveryItemsPerBox(selectedDrop?.itemsPerBox);
  const selectedDropContent = useMemo(() => resolveDropContent(selectedDrop || undefined), [selectedDrop]);
  const boxPreviewImage = selectedDrop ? normalizeBoxDisplayImage(selectedDrop.dropId) : undefined;
  const figureMediaBase = selectedDropContent.figures.fulfillmentMediaBaseUrl;
  const signedIn = Boolean(profile && profile.wallet === walletAddress);
  const walletHasFulfillmentAccess = visibleDrops.length > 0;
  const hasFulfillmentAccess = walletHasFulfillmentAccess && signedIn;
  const walletBusy = walletAdapter.connecting || walletAdapter.disconnecting;
  const walletReadyState = walletAdapter.wallet?.readyState;
  const autoConnectPossible =
    Boolean(walletAdapter.wallet) &&
    walletAdapter.autoConnect &&
    (walletReadyState === WalletReadyState.Installed || walletReadyState === WalletReadyState.Loadable);

  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [orderPageDeliveryIds, setOrderPageDeliveryIds] = useState<number[][]>([]);
  const [cursor, setCursor] = useState<FulfillmentOrdersCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderVisibilityFilter, setOrderVisibilityFilter] = useState<OrderVisibilityFilter>(
    DEFAULT_ORDER_VISIBILITY_FILTER,
  );
  const [statusEdits, setStatusEdits] = useState<Record<number, FulfillmentStatus | ''>>({});
  const [statusSaving, setStatusSaving] = useState<Record<number, boolean>>({});
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [activeUpdateOrderId, setActiveUpdateOrderId] = useState<number | null>(null);
  const walletConnectingSeenRef = useRef(false);
  const [walletReady, setWalletReady] = useState(() => !walletAdapter.wallet || !autoConnectPossible);
  const authLoadingSeenRef = useRef(false);
  const [authReady, setAuthReady] = useState(() => !walletAddress);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const orderRequestEpochRef = useRef(0);

  useEffect(() => {
    walletConnectingSeenRef.current = false;
    setWalletReady(!walletAdapter.wallet || !autoConnectPossible);
  }, [autoConnectPossible, walletAdapter.wallet]);

  useEffect(() => {
    if (!walletAdapter.wallet) return;
    if (!autoConnectPossible) {
      setWalletReady(true);
      return;
    }
    if (walletAdapter.connecting) {
      walletConnectingSeenRef.current = true;
      return;
    }
    if (publicKey || walletConnectingSeenRef.current) {
      setWalletReady(true);
    }
  }, [autoConnectPossible, publicKey, walletAdapter.connecting, walletAdapter.wallet]);

  useEffect(() => {
    authLoadingSeenRef.current = false;
    setAuthReady(!walletAddress);
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;
    if (authLoading) {
      authLoadingSeenRef.current = true;
      return;
    }
    if (profile?.wallet === walletAddress || authLoadingSeenRef.current) {
      setAuthReady(true);
    }
  }, [authLoading, profile?.wallet, walletAddress]);

  useEffect(() => {
    if (!walletAddress) {
      if (selectedDropId) onSelectedDropIdChange('');
      return;
    }
    if (!visibleDrops.length) {
      if (selectedDropId) onSelectedDropIdChange('');
      return;
    }
    if (selectedDropId && !visibleDrops.some((drop) => drop.dropId === selectedDropId)) {
      onSelectedDropIdChange('');
    }
  }, [onSelectedDropIdChange, selectedDropId, visibleDrops, walletAddress]);

  const mergeStatusEdits = useCallback((incoming: FulfillmentOrder[]) => {
    setStatusEdits((prev) => {
      const next = { ...prev };
      incoming.forEach((order) => {
        if (!(order.deliveryId in next)) {
          next[order.deliveryId] = normalizeFulfillmentStatus(order.fulfillmentStatus);
        }
      });
      return next;
    });
  }, []);

  const loadInitial = useCallback(async () => {
    if (!hasFulfillmentAccess || !signedIn || !selectedDrop) {
      orderRequestEpochRef.current += 1;
      setLoading(false);
      setLoadingMore(false);
      setOrdersError(null);
      setHasMore(false);
      setCursor(null);
      setOrders([]);
      setOrderPageDeliveryIds([]);
      setStatusEdits({});
      setStatusSaving({});
      setActiveUpdateOrderId(null);
      return;
    }
    const requestEpoch = orderRequestEpochRef.current + 1;
    orderRequestEpochRef.current = requestEpoch;
    setLoading(true);
    setLoadingMore(false);
    setOrdersError(null);
    setHasMore(true);
    setCursor(null);
    setOrders([]);
    setOrderPageDeliveryIds([]);
    setStatusEdits({});
    setStatusSaving({});
    setActiveUpdateOrderId(null);
    try {
      const resp = await listFulfillmentOrders({
        limit: FULFILLMENT_ORDER_REQUEST_LIMIT,
        cursor: null,
        dropId: selectedDrop.dropId,
      });
      if (orderRequestEpochRef.current !== requestEpoch) return;
      const nextOrders = dedupeOrdersByDeliveryId(Array.isArray(resp.orders) ? resp.orders : []);
      setOrders(nextOrders);
      setOrderPageDeliveryIds(nextOrders.length ? [nextOrders.map((order) => order.deliveryId)] : []);
      mergeStatusEdits(nextOrders);
      setCursor(resp.nextCursor || null);
      setHasMore(Boolean(resp.nextCursor));
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setLoading(false);
      }
    }
  }, [hasFulfillmentAccess, signedIn, mergeStatusEdits, selectedDrop]);

  const loadMore = useCallback(async () => {
    if (!hasFulfillmentAccess || !signedIn || !selectedDrop || loadingMore || loading || !hasMore) return;
    const requestEpoch = orderRequestEpochRef.current;
    const existingDeliveryIds = new Set(orders.map((order) => order.deliveryId));
    setLoadingMore(true);
    setOrdersError(null);
    try {
      const resp = await listFulfillmentOrders({
        limit: FULFILLMENT_ORDER_REQUEST_LIMIT,
        cursor,
        dropId: selectedDrop.dropId,
      });
      if (orderRequestEpochRef.current !== requestEpoch) return;
      const nextOrders = dedupeOrdersByDeliveryId(Array.isArray(resp.orders) ? resp.orders : [], existingDeliveryIds);
      if (nextOrders.length) {
        setOrders((prev) => prev.concat(nextOrders));
        setOrderPageDeliveryIds((prev) => prev.concat([nextOrders.map((order) => order.deliveryId)]));
        mergeStatusEdits(nextOrders);
      }
      setCursor(resp.nextCursor || null);
      setHasMore(Boolean(resp.nextCursor));
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load more orders');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setLoadingMore(false);
      }
    }
  }, [hasFulfillmentAccess, signedIn, selectedDrop, loadingMore, loading, hasMore, cursor, mergeStatusEdits, orders]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const mergeLoadedFigureMetadata = useCallback((records: FigureMetadataRecord[]) => {
    if (!records.length) return;
    setFigureMetadataByKey((prev) => mergeFigureMetadataRecords(prev, records));
  }, []);

  const displayedOrders = useMemo(
    () => {
      if (orderVisibilityFilter === 'all') return orders;
      if (orderVisibilityFilter === 'shipped') {
        return orders.filter((order) => normalizeFulfillmentStatus(order.fulfillmentStatus) === 'Shipped');
      }
      return orders.filter((order) => normalizeFulfillmentStatus(order.fulfillmentStatus) !== 'Shipped');
    },
    [orderVisibilityFilter, orders],
  );

  const orderByDeliveryId = useMemo(() => new Map(orders.map((order) => [order.deliveryId, order] as const)), [orders]);
  const displayedOrderIds = useMemo(() => new Set(displayedOrders.map((order) => order.deliveryId)), [displayedOrders]);

  const groupedOrders = useMemo(() => {
    const groups: FulfillmentOrderGroup[] = [];
    orderPageDeliveryIds.forEach((pageDeliveryIds, pageIndex) => {
      const visibleGroups = new Map<string, FulfillmentOrder[]>();
      pageDeliveryIds.forEach((deliveryId) => {
        const order = orderByDeliveryId.get(deliveryId);
        if (!order) return;
        const groupKey = fulfillmentOrderGroupKey(order);
        if (!displayedOrderIds.has(deliveryId)) return;
        const visibleGroupOrders = visibleGroups.get(groupKey);
        if (visibleGroupOrders) {
          visibleGroupOrders.push(order);
        } else {
          visibleGroups.set(groupKey, [order]);
        }
      });
      visibleGroups.forEach((visibleGroupOrders, groupKey) => {
        groups.push({
          pageIndex,
          groupKey,
          orders: visibleGroupOrders,
          collapseSharedContact: canCollapseFulfillmentOrderGroupContact(visibleGroupOrders),
        });
      });
    });
    return groups;
  }, [displayedOrderIds, orderByDeliveryId, orderPageDeliveryIds]);

  const allDuplicateFigures = useMemo(() => {
    if (!isLittleSwagBoxesDrop || !selectedDrop || !orders.length) return [];
    return summarizeDuplicateFigures({
      orders,
      previewMode: selectedDropContent.figures.fulfillmentPreviewMode,
      figureMedia: selectedDrop.figureMedia,
    });
  }, [
    isLittleSwagBoxesDrop,
    orders,
    selectedDrop,
    selectedDrop?.figureMedia,
    selectedDropContent.figures.fulfillmentPreviewMode,
  ]);

  const duplicateFigures = useMemo(() => {
    if (!isLittleSwagBoxesDrop || !selectedDrop || orderVisibilityFilter !== 'not_shipped') return [];
    if (!displayedOrders.length || !allDuplicateFigures.length) return [];

    const remainingDuplicates = summarizeDuplicateFigures({
      orders: displayedOrders,
      previewMode: selectedDropContent.figures.fulfillmentPreviewMode,
      figureMedia: selectedDrop.figureMedia,
      minimumCount: 1,
    });
    const remainingCountByGroupKey = new Map(remainingDuplicates.map((entry) => [entry.groupKey, entry.count]));

    return allDuplicateFigures
      .map((entry) => {
        const remainingCount = remainingCountByGroupKey.get(entry.groupKey) ?? 0;
        if (remainingCount < 1) return null;
        const adjustedCount = remainingCount === entry.count ? remainingCount - 1 : remainingCount;
        if (adjustedCount < 1) return null;
        return { ...entry, count: adjustedCount };
      })
      .filter((entry): entry is DuplicateFigureSummary => Boolean(entry));
  }, [
    allDuplicateFigures,
    displayedOrders,
    isLittleSwagBoxesDrop,
    orderVisibilityFilter,
    selectedDrop,
    selectedDrop?.figureMedia,
    selectedDropContent.figures.fulfillmentPreviewMode,
  ]);

  const duplicateFigureByFigureId = useMemo(
    () => new Map(duplicateFigures.map((entry) => [entry.figureId, entry])),
    [duplicateFigures],
  );

  const fulfillmentFigureMetadataTargets = useMemo(() => {
    if (!selectedDrop) return [];
    const shouldUseMetadataFallback = selectedDropContent.figures.fulfillmentPreviewMode === 'metadata_stills';
    const targets = new Map<string, { dropId: string; figureId: number }>();
    displayedOrders.forEach((order) => {
      listOrderFigureIds(order).forEach((figureId) => {
        const normalizedFigureId = Math.floor(Number(figureId));
        if (!Number.isFinite(normalizedFigureId) || normalizedFigureId <= 0) return;
        if (!shouldUseMetadataFallback) {
          const hasMappedMedia = Boolean(
            figureMediaBase && getMediaIdForFigureId(normalizedFigureId, selectedDrop.figureMedia),
          );
          if (hasMappedMedia) return;
        }
        const key = figureMetadataCacheKey(selectedDrop.dropId, normalizedFigureId);
        const cached = figureMetadataByKey[key] || getCachedFigureMetadata(selectedDrop.dropId, normalizedFigureId);
        if (figureMetadataHasImage(cached)) return;
        targets.set(key, { dropId: selectedDrop.dropId, figureId: normalizedFigureId });
      });
    });
    if (isLittleSwagBoxesDrop) {
      duplicateFigures.forEach(({ figureId }) => {
        const normalizedFigureId = Math.floor(Number(figureId));
        if (!Number.isFinite(normalizedFigureId) || normalizedFigureId <= 0) return;
        if (!shouldUseMetadataFallback) {
          const hasMappedMedia = Boolean(
            figureMediaBase && getMediaIdForFigureId(normalizedFigureId, selectedDrop.figureMedia),
          );
          if (hasMappedMedia) return;
        }
        const key = figureMetadataCacheKey(selectedDrop.dropId, normalizedFigureId);
        const cached = figureMetadataByKey[key] || getCachedFigureMetadata(selectedDrop.dropId, normalizedFigureId);
        if (figureMetadataHasImage(cached)) return;
        targets.set(key, { dropId: selectedDrop.dropId, figureId: normalizedFigureId });
      });
    }
    return Array.from(targets.values());
  }, [
    duplicateFigures,
    displayedOrders,
    figureMediaBase,
    figureMetadataByKey,
    isLittleSwagBoxesDrop,
    selectedDrop?.dropId,
    selectedDrop?.figureMedia,
    selectedDropContent.figures.fulfillmentPreviewMode,
  ]);

  useEffect(() => {
    if (!selectedDrop || !fulfillmentFigureMetadataTargets.length) return;
    let cancelled = false;
    const fetchMetadata = async () => {
      try {
        const records = await loadFigureMetadataBatch(fulfillmentFigureMetadataTargets);
        if (cancelled || !records.length) return;
        mergeLoadedFigureMetadata(records);
      } catch (err) {
        console.warn('[mons] failed to load fulfillment figure metadata', { dropId: selectedDrop.dropId, error: err });
      }
    };

    void fetchMetadata();
    if (typeof window === 'undefined') return;
    const interval = window.setInterval(() => {
      void fetchMetadata();
    }, FIGURE_METADATA_RETRY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fulfillmentFigureMetadataTargets, mergeLoadedFigureMetadata, selectedDrop]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasFulfillmentAccess || !signedIn || !selectedDrop) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasFulfillmentAccess, signedIn, selectedDrop, loadMore]);

  const handleSaveStatus = useCallback(
    async (deliveryId: number) => {
      if (!hasFulfillmentAccess || !signedIn || !selectedDrop) return false;
      const requestEpoch = orderRequestEpochRef.current;
      setStatusSaving((prev) => ({ ...prev, [deliveryId]: true }));
      setOrdersError(null);
      try {
        const nextStatus = normalizeFulfillmentStatus(statusEdits[deliveryId]);
        const resp = await updateFulfillmentStatus(deliveryId, nextStatus, selectedDrop.dropId);
        if (orderRequestEpochRef.current !== requestEpoch) return false;
        const normalized = normalizeFulfillmentStatus(resp.fulfillmentStatus || nextStatus);
        setOrders((prev) =>
          prev.map((order) =>
            order.deliveryId === deliveryId ? { ...order, fulfillmentStatus: normalized || undefined } : order,
          ),
        );
        setStatusEdits((prev) => ({ ...prev, [deliveryId]: normalized }));
        return true;
      } catch (err) {
        if (orderRequestEpochRef.current !== requestEpoch) return false;
        console.error(err);
        setOrdersError(err instanceof Error ? err.message : 'Failed to update status');
        return false;
      } finally {
        if (orderRequestEpochRef.current === requestEpoch) {
          setStatusSaving((prev) => ({ ...prev, [deliveryId]: false }));
        }
      }
    },
    [hasFulfillmentAccess, signedIn, selectedDrop, statusEdits],
  );

  const statusDirty = useMemo(() => {
    const dirty = new Set<number>();
    orders.forEach((order) => {
      const current = normalizeFulfillmentStatus(order.fulfillmentStatus);
      const edited = statusEdits[order.deliveryId] ?? '';
      if (current !== edited) dirty.add(order.deliveryId);
    });
    return dirty;
  }, [orders, statusEdits]);

  const activeUpdateOrder = useMemo(
    () => orders.find((order) => order.deliveryId === activeUpdateOrderId) ?? null,
    [activeUpdateOrderId, orders],
  );
  const activeUpdateText = activeUpdateOrder
    ? statusEdits[activeUpdateOrder.deliveryId] ?? normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus)
    : '';
  const activeUpdateDirty = activeUpdateOrder ? statusDirty.has(activeUpdateOrder.deliveryId) : false;
  const activeUpdateSaving = activeUpdateOrder ? Boolean(statusSaving[activeUpdateOrder.deliveryId]) : false;

  const handleOpenUpdateModal = useCallback((deliveryId: number) => {
    setActiveUpdateOrderId(deliveryId);
  }, []);

  const handleCancelUpdate = useCallback(() => {
    if (!activeUpdateOrder) {
      setActiveUpdateOrderId(null);
      return;
    }
    setStatusEdits((prev) => ({
      ...prev,
      [activeUpdateOrder.deliveryId]: normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus),
    }));
    setActiveUpdateOrderId(null);
  }, [activeUpdateOrder]);

  const handleSaveActiveUpdate = useCallback(async () => {
    if (!activeUpdateOrder) return;
    if (!activeUpdateDirty) {
      setActiveUpdateOrderId(null);
      return;
    }
    const ok = await handleSaveStatus(activeUpdateOrder.deliveryId);
    if (ok) setActiveUpdateOrderId(null);
  }, [activeUpdateDirty, activeUpdateOrder, handleSaveStatus]);

  const handleSolanaSignIn = useCallback(() => {
    if (authLoading) return;
    if (!publicKey) {
      setPendingSignIn(true);
      setWalletModalVisible(true);
      return;
    }
    if (!walletHasFulfillmentAccess || signedIn) return;
    void signIn();
  }, [authLoading, publicKey, setWalletModalVisible, signIn, signedIn, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || !publicKey) return;
    if (!walletHasFulfillmentAccess || signedIn) {
      setPendingSignIn(false);
      return;
    }
    if (authLoading) return;
    setPendingSignIn(false);
    void signIn();
  }, [authLoading, pendingSignIn, publicKey, signIn, signedIn, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || walletModalVisible || publicKey) return;
    setPendingSignIn(false);
  }, [pendingSignIn, publicKey, walletModalVisible]);

  const hasVisibleOrderCards = duplicateFigures.length > 0 || groupedOrders.length > 0;

  const renderFulfillmentOrderSection = (
    order: FulfillmentOrder,
    options?: { showEmail?: boolean; showFullAddress?: boolean },
  ) => {
    if (!selectedDrop) return null;
    const showEmail = options?.showEmail ?? true;
    const showFullAddress = options?.showFullAddress ?? true;
    return (
      <div key={`${selectedDrop.dropId}:${order.deliveryId}`} className="fulfillment-order-section">
        <div className="card__head">
          <div>
            <div className="card__title">Order {order.deliveryId}</div>
            <div className="muted small">{formatOrderDate(order.processedAt || order.createdAt)}</div>
            {showEmail && order.address.full !== '***' && order.address.email ? (
              <div className="muted small">{order.address.email}</div>
            ) : null}
          </div>
          <div className="order-update">
            {(() => {
              const statusText = normalizeFulfillmentStatus(order.fulfillmentStatus);
              return statusText ? <div className="status-readout small">{statusText}</div> : <em className="muted small">Not set</em>;
            })()}
            <button
              type="button"
              className="link small no-focus-style"
              onClick={() => handleOpenUpdateModal(order.deliveryId)}
            >
              {normalizeFulfillmentStatus(order.fulfillmentStatus) ? 'Edit status' : 'Set status'}
            </button>
          </div>
        </div>

        <div className="order-items">
          {showFullAddress ? (
            <div className="address-lines">
              {order.address.full ? (
                <div className="address-text">
                  {order.address.full === '***' ? order.address.country || order.address.countryCode || '***' : order.address.full}
                </div>
              ) : (
                <>
                  <div className="muted small">Encrypted address payload</div>
                  <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                </>
              )}
            </div>
          ) : null}

          {order.boxes.length ? (
            isDirectDeliveryDrop ? (
              renderBoxTiles({
                boxIds: order.boxes.map((box) => box.boxId),
                keyPrefix: `${order.deliveryId}:box`,
                labelSource: selectedDrop,
                previewSrc: boxPreviewImage,
              })
            ) : (
              <div className="grid">
                {order.boxes.map((box) => (
                  <div key={`${order.deliveryId}:${box.boxId}`} className="card subtle box-contents">
                    <div className="card__title">
                      {box.claimCode ? (
                        <>
                          {dropAssetLabel(selectedDrop, 'box', 1, { capitalize: true })} Secret{' '}
                          <span className="fulfillment-secret-code">{box.claimCode}</span>
                        </>
                      ) : (
                        dropAssetReference(selectedDrop, 'box', box.boxId, { capitalize: true })
                      )}
                    </div>
                    {!box.claimCode ? (
                      <div className="muted small">Secret code unavailable</div>
                    ) : !box.dudeIds.length ? (
                      <div className="muted small">Assigned {dropAssetLabel(selectedDrop, 'figure', 2)} pending</div>
                    ) : null}
                    {box.dudeIds.length ? (
                      renderFigureTiles({
                        dropId: selectedDrop.dropId,
                        figureIds: box.dudeIds,
                        keyPrefix: `${order.deliveryId}:${box.boxId}`,
                        figureNamePrefix: selectedDrop.figureNamePrefix,
                        previewMode: selectedDropContent.figures.fulfillmentPreviewMode,
                        figureMediaBase,
                        figureMedia: selectedDrop.figureMedia,
                        figureMetadataByKey,
                        onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                      })
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : null}

          {order.looseDudes.length
            ? renderFigureTiles({
                dropId: selectedDrop.dropId,
                figureIds: order.looseDudes,
                keyPrefix: `${order.deliveryId}:dude`,
                figureNamePrefix: selectedDrop.figureNamePrefix,
                previewMode: selectedDropContent.figures.fulfillmentPreviewMode,
                figureMediaBase,
                figureMedia: selectedDrop.figureMedia,
                figureMetadataByKey,
                onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
              })
            : null}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <a
            href="/"
            className="brand__home-link"
            aria-label="Go to mons.shop home"
            draggable={false}
            onDragStart={(evt) => {
              evt.preventDefault();
            }}
          >
            <h1>
              <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" draggable={false} />
              <span>mons.shop</span>
            </h1>
          </a>
        </div>
      </header>

      {!walletBusy && walletReady && (walletAddress ? (!walletHasFulfillmentAccess || authReady) : true) ? (
        !walletAddress ? (
          <section className="card">
            <button type="button" onClick={handleSolanaSignIn} disabled={authLoading}>
              {authLoading ? 'Signing in…' : 'Sign in with Solana'}
            </button>
          </section>
        ) : !walletHasFulfillmentAccess ? (
          <section className="card">
            <div className="card__title">Access denied</div>
            <p className="muted small">This wallet is not authorized for fulfillment.</p>
          </section>
        ) : !signedIn ? (
          <section className="card">
            <button type="button" onClick={handleSolanaSignIn} disabled={authLoading}>
              {authLoading ? 'Signing in…' : 'Sign in with Solana'}
            </button>
          </section>
        ) : (
          <section className="orders">
            <div className="row fulfillment-orders-toolbar">
              <select
                id="fulfillment-drop-picker"
                className="fulfillment-drop-picker"
                aria-label="Drop"
                value={selectedDropId}
                onChange={(evt) => {
                  setOrderVisibilityFilter(DEFAULT_ORDER_VISIBILITY_FILTER);
                  onSelectedDropIdChange(evt.target.value);
                }}
              >
                <option value="">Select a drop</option>
                {visibleDrops.map((drop) => (
                  <option key={drop.dropId} value={drop.dropId}>
                    {drop.dropId}
                  </option>
                ))}
              </select>
              {selectedDrop ? (
                <select
                  id="fulfillment-orders-filter-picker"
                  className="fulfillment-drop-picker fulfillment-orders-filter-picker"
                  aria-label="Order filter"
                  value={orderVisibilityFilter}
                  onChange={(evt) => {
                    setOrderVisibilityFilter(evt.target.value as OrderVisibilityFilter);
                  }}
                >
                  {ORDER_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            {selectedDrop && loading && !hasVisibleOrderCards ? <div className="muted small">Loading orders…</div> : null}
            {selectedDrop && ordersError ? <div className="error">{ordersError}</div> : null}
            {selectedDrop && hasVisibleOrderCards ? (
              <div className="order-list">
                {duplicateFigures.length ? (
                  <div key={`${selectedDrop.dropId}:duplicates`} className="card subtle">
                    <div className="card__head">
                      <div className="card__title">New Duplicates</div>
                    </div>
                    <div className="order-items">
                      {renderFigureTiles({
                        dropId: selectedDrop.dropId,
                        figureIds: duplicateFigures.map((entry) => entry.figureId),
                        keyPrefix: 'duplicates',
                        figureNamePrefix: selectedDrop.figureNamePrefix,
                        previewMode: selectedDropContent.figures.fulfillmentPreviewMode,
                        figureMediaBase,
                        figureMedia: selectedDrop.figureMedia,
                        figureMetadataByKey,
                        onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                        labelOverride: ({ figureId, mediaId }) => {
                          const duplicate = duplicateFigureByFigureId.get(figureId);
                          const labelId = duplicate?.labelId || (mediaId ? String(mediaId) : String(figureId));
                          const count = duplicate?.count || 0;
                          return `${labelId} x ${count}`;
                        },
                      })}
                    </div>
                  </div>
                ) : null}
                {groupedOrders.map((group) => (
                  <div
                    key={`${selectedDrop.dropId}:${group.pageIndex}:${group.groupKey}`}
                    className="card subtle fulfillment-order-group"
                  >
                    {group.orders.map((order, index) =>
                      renderFulfillmentOrderSection(order, {
                        showEmail: !group.collapseSharedContact || index === 0,
                        showFullAddress: !group.collapseSharedContact || index === 0,
                      }),
                    )}
                  </div>
                ))}
              </div>
            ) : selectedDrop && loading ? null : selectedDrop ? (
              <div className="muted small">
                {orderVisibilityFilter === 'all'
                  ? 'No orders.'
                  : orderVisibilityFilter === 'shipped'
                    ? 'No shipped orders.'
                    : 'No unshipped orders.'}
              </div>
            ) : null}

            {selectedDrop && loadingMore ? <div className="muted small">Loading more…</div> : null}
            <div ref={sentinelRef} />
          </section>
        )
      ) : null}

      <Modal
        open={activeUpdateOrderId !== null}
        title={activeUpdateOrder ? `Order ${activeUpdateOrder.deliveryId}` : 'Order'}
        onClose={handleCancelUpdate}
        showCloseButton={false}
      >
        <div className="modal-form">
          <select
            className="status-input"
            value={activeUpdateText}
            onChange={(evt) => {
              if (!activeUpdateOrder) return;
              const nextStatus = normalizeFulfillmentStatus(evt.target.value);
              setStatusEdits((prev) => ({ ...prev, [activeUpdateOrder.deliveryId]: nextStatus }));
            }}
            aria-label="Fulfillment status"
          >
            <option value="">Not set</option>
            {FULFILLMENT_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <div className="row row--end">
            <button type="button" className="ghost" onClick={handleCancelUpdate}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveActiveUpdate()}
              disabled={!activeUpdateOrder || activeUpdateSaving || !activeUpdateDirty}
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      {authError ? <div className="error">{authError}</div> : null}
    </div>
  );
}
