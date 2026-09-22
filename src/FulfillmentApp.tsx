import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { FiAlertTriangle, FiDownload, FiMoreHorizontal } from 'react-icons/fi';
import type { FulfillmentOrder } from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from './lib/figureMetadata';
import { resolveDropContent } from './lib/dropContent';
import { fulfillmentOrderLooseFigureIds } from './lib/fulfillmentCodes';
import { FulfillmentOrderCard } from './fulfillment/FulfillmentOrderCard';
import { FulfillmentManualReviewMenu } from './fulfillment/FulfillmentManualReviewMenu';
import { FulfillmentFigureTiles } from './fulfillment/FulfillmentMedia';
import { FulfillmentStatusModal } from './fulfillment/FulfillmentStatusModal';
import { FulfillmentAddressModal } from './fulfillment/FulfillmentAddressModal';
import { FulfillmentShipStationModal } from './fulfillment/FulfillmentShipStationModal';
import { useFulfillmentOrders } from './fulfillment/useFulfillmentOrders';
import { useFulfillmentExports } from './fulfillment/useFulfillmentExports';
import { ShopHeader } from './components/ShopHeader';
import { BodyPortal } from './components/BackgroundBlurLayer';
import {
  DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER,
  FULFILLMENT_ORDER_VISIBILITY_OPTIONS,
  filterFulfillmentOrdersByVisibility,
  isRedeemedForIrlFulfillmentOrder,
  type FulfillmentOrderVisibilityFilter,
} from './lib/fulfillmentOrderVisibility';
import {
  listFrontendDrops,
  normalizeDropId,
  type FigureMediaConfig,
  type FrontendDeploymentConfig,
} from './config/deployment';
import { hasFulfillmentAddressAdminAccess, listAllowedFulfillmentDropIds } from './lib/fulfillmentAccess';
import { walletSessionSignInReadiness } from './lib/profileClientLifecycle';
import { fulfillmentOrderKey, groupFulfillmentOrders } from './fulfillment/orders';
import {
  collectFulfillmentFigureMetadataTargets,
  mergeFigureMetadataRecords,
} from './fulfillment/figureMetadata';

const LITTLE_SWAG_BOXES_DROP_ID = 'little_swag_boxes';
const FIGURE_METADATA_RETRY_MS = 3000;

function listOrderFigureIds(order: FulfillmentOrder): number[] {
  return [...fulfillmentOrderLooseFigureIds(order), ...order.boxes.flatMap((box) => box.dudeIds)];
}

type DuplicateFigureSummary = {
  groupKey: string;
  figureId: number;
  labelId: string;
  count: number;
  sortValue: number;
};

function useDismissibleMenu<T extends HTMLElement>(
  open: boolean,
  menuRef: RefObject<T | null>,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const handlePointerDown = (evt: MouseEvent | TouchEvent) => {
      const node = menuRef.current;
      if (!node || node.contains(evt.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuRef, open, setOpen]);
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

type FulfillmentAppProps = {
  selectedDropId: string;
  onSelectedDropIdChange: (dropId: string) => void;
  orderVisibilityFilter: FulfillmentOrderVisibilityFilter;
  onOrderVisibilityFilterChange: (filter: FulfillmentOrderVisibilityFilter) => void;
};

export default function FulfillmentApp({
  selectedDropId,
  onSelectedDropIdChange,
  orderVisibilityFilter,
  onOrderVisibilityFilterChange,
}: FulfillmentAppProps) {
  const allDrops = useMemo(() => listFrontendDrops(), []);
  const walletAdapter = useWallet();
  const { publicKey } = walletAdapter;
  const { visible: walletModalVisible, setVisible: setWalletModalVisible } = useWalletModal();
  const {
    sessionWallet,
    authenticated,
    signIn,
    loading: authLoading,
    error: authError,
    sessionResolution,
  } = useSolanaAuth();
  const connectedWallet = walletAdapter.connected ? publicKey?.toBase58() || '' : '';
  const authenticatedWallet = authenticated && sessionWallet ? sessionWallet : '';
  const walletAddress = connectedWallet || authenticatedWallet;
  const allowedDropIds = useMemo(
    () => listAllowedFulfillmentDropIds(walletAddress, allDrops.map((drop) => drop.dropId)),
    [allDrops, walletAddress],
  );
  const visibleDrops = useMemo(() => {
    const allowedDropIdsSet = new Set(allowedDropIds);
    return allDrops.filter((drop) => allowedDropIdsSet.has(drop.dropId));
  }, [allowedDropIds, allDrops]);
  const dropById = useMemo(() => new Map(visibleDrops.map((drop) => [drop.dropId, drop])), [visibleDrops]);
  const selectedDrop = useMemo(
    () => visibleDrops.find((drop) => drop.dropId === selectedDropId) || null,
    [visibleDrops, selectedDropId],
  );
  const selectedDrops = useMemo(() => {
    if (selectedDrop) return [selectedDrop];
    if (!selectedDropId) return visibleDrops;
    return [];
  }, [selectedDrop, selectedDropId, visibleDrops]);
  const selectedDropIds = useMemo(() => selectedDrops.map((drop) => drop.dropId), [selectedDrops]);
  const duplicateDrop = useMemo(
    () => selectedDrops.find((drop) => normalizeDropId(drop.dropId) === LITTLE_SWAG_BOXES_DROP_ID) || null,
    [selectedDrops],
  );
  const duplicateDropContent = useMemo(() => (duplicateDrop ? resolveDropContent(duplicateDrop) : null), [duplicateDrop]);
  const duplicateFigureMediaBase = duplicateDropContent?.figures.fulfillmentMediaBaseUrl;
  const signedIn = Boolean(authenticatedWallet && authenticatedWallet === walletAddress);
  const signInReadiness = walletSessionSignInReadiness({
    hasAuthenticatedSession: signedIn,
    sessionResolution,
    authLoading,
  });
  const walletHasFulfillmentAccess = visibleDrops.length > 0;
  const hasFulfillmentAccess = walletHasFulfillmentAccess && signedIn;
  const canAdminEditFulfillmentAddress = signedIn && hasFulfillmentAddressAdminAccess(walletAddress);
  const walletBusy = walletAdapter.connecting || walletAdapter.disconnecting;
  const walletReadyState = walletAdapter.wallet?.readyState;
  const autoConnectPossible =
    Boolean(walletAdapter.wallet) &&
    walletAdapter.autoConnect &&
    (walletReadyState === WalletReadyState.Installed || walletReadyState === WalletReadyState.Loadable);

  const [manualReviewMenuOpen, setManualReviewMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const closeExportMenu = useCallback(() => setExportMenuOpen(false), []);
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [activeUpdateOrderKey, setActiveUpdateOrderKey] = useState<string | null>(null);
  const [activeAddressOrderKey, setActiveAddressOrderKey] = useState<string | null>(null);
  const [activeShipstationOrderKey, setActiveShipstationOrderKey] = useState<string | null>(null);
  const walletConnectingSeenRef = useRef(false);
  const [walletReady, setWalletReady] = useState(() => !walletAdapter.wallet || !autoConnectPossible);
  const authReady = sessionResolution === 'settled';
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const manualReviewMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  useDismissibleMenu(manualReviewMenuOpen, manualReviewMenuRef, setManualReviewMenuOpen);
  useDismissibleMenu(exportMenuOpen, exportMenuRef, setExportMenuOpen);
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
    if (!walletAddress) return;
    if (!visibleDrops.length) {
      if (selectedDropId) onSelectedDropIdChange('');
      return;
    }
    if (selectedDropId && !visibleDrops.some((drop) => drop.dropId === selectedDropId)) {
      onSelectedDropIdChange('');
    }
  }, [onSelectedDropIdChange, selectedDropId, visibleDrops, walletAddress]);

  const resetOrderUi = useCallback(() => {
    setManualReviewMenuOpen(false);
    setActiveUpdateOrderKey(null);
    setActiveAddressOrderKey(null);
    setActiveShipstationOrderKey(null);
  }, []);

  const {
    scopeVersion,
    orders,
    orderPageKeys,
    manualReviewCheckouts,
    manualReviewHasMore,
    manualReviewLoading,
    manualReviewError,
    loadMoreManualReview,
    loading,
    loadingMore,
    ordersError,
    loadMore,
    setOrdersError,
    updateOrder,
    isCurrentScope,
  } = useFulfillmentOrders({
    walletAddress: authenticatedWallet,
    enabled: hasFulfillmentAccess && signedIn,
    dropIds: selectedDropIds,
    onReset: resetOrderUi,
  });

  const manualReviewVisible = manualReviewCheckouts.length > 0 || manualReviewHasMore || manualReviewLoading || Boolean(manualReviewError);
  const manualReviewCount = `${manualReviewCheckouts.length}${manualReviewHasMore ? '+' : ''}`;
  useEffect(() => {
    if (!manualReviewVisible && manualReviewMenuOpen) {
      setManualReviewMenuOpen(false);
    }
  }, [manualReviewVisible, manualReviewMenuOpen]);

  const mergeLoadedFigureMetadata = useCallback((records: FigureMetadataRecord[]) => {
    if (!records.length) return;
    setFigureMetadataByKey((prev) => mergeFigureMetadataRecords(prev, records));
  }, []);

  const displayedOrders = useMemo(
    () => filterFulfillmentOrdersByVisibility(orders, orderVisibilityFilter),
    [orderVisibilityFilter, orders],
  );

  const groupedOrders = useMemo(
    () =>
      groupFulfillmentOrders({
        orders,
        pageOrderKeys: orderPageKeys,
        visibleOrderKeys: new Set(displayedOrders.map((order) => fulfillmentOrderKey(order))),
      }),
    [displayedOrders, orderPageKeys, orders],
  );

  const duplicateDropOrders = useMemo(() => {
    if (!duplicateDrop) return [];
    return filterFulfillmentOrdersByVisibility(orders, 'all').filter(
      (order) => normalizeDropId(order.dropId) === LITTLE_SWAG_BOXES_DROP_ID,
    );
  }, [duplicateDrop, orders]);

  const displayedDuplicateDropOrders = useMemo(() => {
    if (!duplicateDrop) return [];
    return displayedOrders.filter((order) => normalizeDropId(order.dropId) === LITTLE_SWAG_BOXES_DROP_ID);
  }, [displayedOrders, duplicateDrop]);

  const allDuplicateFigures = useMemo(() => {
    if (!duplicateDrop || !duplicateDropContent || !duplicateDropOrders.length) return [];
    return summarizeDuplicateFigures({
      orders: duplicateDropOrders,
      previewMode: duplicateDropContent.figures.fulfillmentPreviewMode,
      figureMedia: duplicateDrop.figureMedia,
    });
  }, [
    duplicateDrop,
    duplicateDrop?.figureMedia,
    duplicateDropContent,
    duplicateDropContent?.figures.fulfillmentPreviewMode,
    duplicateDropOrders,
  ]);

  const duplicateFigures = useMemo(() => {
    if (!duplicateDrop || !duplicateDropContent || orderVisibilityFilter !== 'not_shipped') return [];
    if (!displayedDuplicateDropOrders.length || !allDuplicateFigures.length) return [];

    const remainingDuplicates = summarizeDuplicateFigures({
      orders: displayedDuplicateDropOrders,
      previewMode: duplicateDropContent.figures.fulfillmentPreviewMode,
      figureMedia: duplicateDrop.figureMedia,
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
    displayedDuplicateDropOrders,
    duplicateDrop,
    duplicateDrop?.figureMedia,
    duplicateDropContent,
    duplicateDropContent?.figures.fulfillmentPreviewMode,
    orderVisibilityFilter,
  ]);

  const duplicateFigureByFigureId = useMemo(
    () => new Map(duplicateFigures.map((entry) => [entry.figureId, entry])),
    [duplicateFigures],
  );

  const fulfillmentFigureMetadataTargets = useMemo(() => {
    const entries: Array<{ drop: FrontendDeploymentConfig; figureIds: number[] }> = [];
    displayedOrders.forEach((order) => {
      const drop = dropById.get(order.dropId);
      if (!drop) return;
      entries.push({ drop, figureIds: listOrderFigureIds(order) });
    });
    if (duplicateDrop) {
      entries.push({ drop: duplicateDrop, figureIds: duplicateFigures.map(({ figureId }) => figureId) });
    }
    return collectFulfillmentFigureMetadataTargets({ entries, figureMetadataByKey });
  }, [
    duplicateFigures,
    displayedOrders,
    dropById,
    duplicateDrop,
    figureMetadataByKey,
  ]);

  useEffect(() => {
    if (!fulfillmentFigureMetadataTargets.length) return;
    let cancelled = false;
    const fetchMetadata = async () => {
      try {
        const records = await loadFigureMetadataBatch(fulfillmentFigureMetadataTargets);
        if (cancelled || !records.length) return;
        mergeLoadedFigureMetadata(records);
      } catch (err) {
        console.warn('[mons] failed to load fulfillment figure metadata', { error: err });
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
  }, [fulfillmentFigureMetadataTargets, mergeLoadedFigureMetadata]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasFulfillmentAccess || !signedIn || !selectedDropIds.length) return;
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
  }, [hasFulfillmentAccess, signedIn, selectedDropIds, loadMore]);

  const activeUpdateOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeUpdateOrderKey) ?? null,
    [activeUpdateOrderKey, orders],
  );
  const handleOpenUpdateModal = useCallback((orderKey: string) => {
    setActiveUpdateOrderKey(orderKey);
  }, []);

  const activeShipstationOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeShipstationOrderKey) ?? null,
    [activeShipstationOrderKey, orders],
  );
  const handleOpenShipstationModal = useCallback((orderKey: string) => {
    setActiveShipstationOrderKey(orderKey);
  }, []);
  const handleCloseShipstationModal = useCallback(() => {
    setActiveShipstationOrderKey(null);
  }, []);
  const handleCloseUpdateModal = useCallback(() => setActiveUpdateOrderKey(null), []);

  const activeAddressOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeAddressOrderKey) ?? null,
    [activeAddressOrderKey, orders],
  );
  const handleOpenAddressModal = useCallback(
    (order: FulfillmentOrder) => {
      if (!canAdminEditFulfillmentAddress || isRedeemedForIrlFulfillmentOrder(order)) return;
      setActiveAddressOrderKey(fulfillmentOrderKey(order));
    },
    [canAdminEditFulfillmentAddress],
  );

  const handleCloseAddressModal = useCallback(() => setActiveAddressOrderKey(null), []);

  const handleSolanaSignIn = useCallback(() => {
    if (!connectedWallet || !publicKey) {
      setPendingSignIn(true);
      setWalletModalVisible(true);
      return;
    }
    if (!walletHasFulfillmentAccess || signInReadiness !== 'sign') return;
    void signIn();
  }, [connectedWallet, publicKey, setWalletModalVisible, signIn, signInReadiness, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || !connectedWallet || !publicKey) return;
    if (!walletHasFulfillmentAccess || signedIn) {
      setPendingSignIn(false);
      return;
    }
    if (signInReadiness !== 'sign') return;
    setPendingSignIn(false);
    void signIn();
  }, [connectedWallet, pendingSignIn, publicKey, signIn, signedIn, signInReadiness, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || walletModalVisible || connectedWallet) return;
    setPendingSignIn(false);
  }, [connectedWallet, pendingSignIn, walletModalVisible]);

  const hasVisibleOrderCards = duplicateFigures.length > 0 || groupedOrders.length > 0;
  const showManualReviewDropId = selectedDropIds.length > 1;

  const {
    displayedSecretCodeCount,
    secretCodesExporting,
    secretCodesExportPercent,
    secretCodeDownloadDisabled,
    downloadDisplayedOrders,
    downloadDisplayedAddresses,
    downloadDisplayedSecretCodes,
    downloadSecretCodePng,
  } = useFulfillmentExports({
    displayedOrders,
    selectedDropId,
    orderVisibilityFilter,
    dropById,
    figureMetadataByKey,
    fulfillmentFigureMetadataTargets,
    mergeLoadedFigureMetadata,
    setOrdersError,
    onMenuClose: closeExportMenu,
  });

  const renderExportMenu = () => (
    <div className="fulfillment-export-menu" role="menu" aria-label="Fulfillment exports">
      <button
        type="button"
        className="fulfillment-export-menu__item"
        role="menuitem"
        onClick={downloadDisplayedOrders}
      >
        <FiDownload aria-hidden="true" />
        <span>Download Orders</span>
      </button>
      <button
        type="button"
        className="fulfillment-export-menu__item"
        role="menuitem"
        onClick={downloadDisplayedSecretCodes}
        disabled={secretCodeDownloadDisabled || !displayedSecretCodeCount}
      >
        <FiDownload aria-hidden="true" />
        <span>{secretCodesExporting ? 'Preparing Secret Codes ZIP…' : 'Download Secret Codes ZIP'}</span>
      </button>
      <button
        type="button"
        className="fulfillment-export-menu__item"
        role="menuitem"
        onClick={downloadDisplayedAddresses}
      >
        <FiDownload aria-hidden="true" />
        <span>Download Addresses [SENSITIVE]</span>
      </button>
    </div>
  );

  return (
    <div className="page fulfillment-page">
      <ShopHeader scrollHomeToTop />

      {!walletBusy && (walletReady || signedIn) && (walletAddress ? (!walletHasFulfillmentAccess || authReady) : authReady) ? (
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
                  onOrderVisibilityFilterChange(DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER);
                  onSelectedDropIdChange(evt.target.value);
                }}
              >
                <option value="">All drops</option>
                {visibleDrops.map((drop) => (
                  <option key={drop.dropId} value={drop.dropId}>
                    {drop.dropId}
                  </option>
                ))}
              </select>
              {selectedDropIds.length ? (
                <select
                  id="fulfillment-orders-filter-picker"
                  className="fulfillment-drop-picker fulfillment-orders-filter-picker"
                  aria-label="Order filter"
                  value={orderVisibilityFilter}
                  onChange={(evt) => {
                    onOrderVisibilityFilterChange(evt.target.value as FulfillmentOrderVisibilityFilter);
                  }}
                >
                  {FULFILLMENT_ORDER_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {selectedDropIds.length ? (
                <div className="fulfillment-toolbar-actions">
                  {manualReviewVisible ? (
                    <div className="manual-review-menu-wrap" ref={manualReviewMenuRef}>
                      <button
                        type="button"
                        className="manual-review-button"
                        aria-label={`Needs manual review, ${manualReviewCount} ${
                          manualReviewCheckouts.length === 1 && !manualReviewHasMore ? 'checkout' : 'checkouts'
                        }`}
                        aria-haspopup="dialog"
                        aria-expanded={manualReviewMenuOpen}
                        title="Needs manual review"
                        onClick={() => {
                          setExportMenuOpen(false);
                          setManualReviewMenuOpen((open) => !open);
                        }}
                      >
                        <FiAlertTriangle aria-hidden="true" />
                        <span>{manualReviewCount}</span>
                      </button>
                      {manualReviewMenuOpen ? (
                        <FulfillmentManualReviewMenu
                          checkouts={manualReviewCheckouts}
                          showDropId={showManualReviewDropId}
                          hasMore={manualReviewHasMore}
                          loading={manualReviewLoading}
                          error={manualReviewError}
                          onLoadMore={loadMoreManualReview}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <div className="fulfillment-export-menu-wrap" ref={exportMenuRef}>
                    <button
                      type="button"
                      className={`fulfillment-more-button${exportMenuOpen ? ' fulfillment-more-button--active' : ''}`}
                      aria-label="Fulfillment export menu"
                      aria-haspopup="menu"
                      aria-expanded={exportMenuOpen}
                      title="More"
                      onClick={() => {
                        setManualReviewMenuOpen(false);
                        setExportMenuOpen((open) => !open);
                      }}
                    >
                      <FiMoreHorizontal aria-hidden="true" />
                    </button>
                    {exportMenuOpen ? renderExportMenu() : null}
                  </div>
                </div>
              ) : null}
            </div>
            {selectedDropIds.length && loading && !hasVisibleOrderCards ? <div className="muted small">Loading orders…</div> : null}
            {selectedDropIds.length && ordersError ? <div className="error">{ordersError}</div> : null}
            {selectedDropIds.length && hasVisibleOrderCards ? (
              <div className="order-list">
                {duplicateDrop && duplicateDropContent && duplicateFigures.length ? (
                  <div key={`${duplicateDrop.dropId}:duplicates`} className="card subtle">
                    <div className="card__head">
                      <div className="card__title">New Duplicates</div>
                    </div>
                    <div className="order-items">
                      <FulfillmentFigureTiles
                        dropId={duplicateDrop.dropId}
                        drop={duplicateDrop}
                        figureIds={duplicateFigures.map((entry) => entry.figureId)}
                        keyPrefix="duplicates"
                        figureNamePrefix={duplicateDrop.figureNamePrefix}
                        previewMode={duplicateDropContent.figures.fulfillmentPreviewMode}
                        figureMediaBase={duplicateFigureMediaBase}
                        figureMedia={duplicateDrop.figureMedia}
                        figureMetadataByKey={figureMetadataByKey}
                        onMetadataResolved={(record) => mergeLoadedFigureMetadata([record])}
                        labelOverride={({ figureId, mediaId }) => {
                          const duplicate = duplicateFigureByFigureId.get(figureId);
                          const labelId = duplicate?.labelId || (mediaId ? String(mediaId) : String(figureId));
                          const count = duplicate?.count || 0;
                          return `${labelId} x ${count}`;
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {groupedOrders.map((group) => (
                  <div
                    key={`${group.pageIndex}:${group.groupKey}`}
                    className="card subtle fulfillment-order-group"
                  >
                    {group.orders.map((order, index) => (
                      <FulfillmentOrderCard
                        key={fulfillmentOrderKey(order)}
                        order={order}
                        drop={dropById.get(order.dropId)}
                        figureMetadataByKey={figureMetadataByKey}
                        showContactInfo={!group.collapseSharedContact || index === 0}
                        showFullAddress={!group.collapseSharedContact || index === 0}
                        canAdminEditFulfillmentAddress={canAdminEditFulfillmentAddress}
                        secretCodeDownloadDisabled={secretCodeDownloadDisabled}
                        onMetadataResolved={(record) => mergeLoadedFigureMetadata([record])}
                        onEditAddress={handleOpenAddressModal}
                        onEditStatus={handleOpenUpdateModal}
                        onPrintLabel={handleOpenShipstationModal}
                        onDownloadSecretCode={downloadSecretCodePng}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : selectedDropIds.length && loading ? null : selectedDropIds.length ? (
              <div className="muted small">
                {orderVisibilityFilter === 'all'
                  ? 'No orders.'
                  : orderVisibilityFilter === 'shipped'
                    ? 'No shipped orders.'
                    : orderVisibilityFilter === 'redeemed_for_irl'
                      ? 'No orders redeemed for IRL.'
                      : 'No unshipped orders.'}
              </div>
            ) : null}

            {selectedDropIds.length && loadingMore ? <div className="muted small">Loading more…</div> : null}
            <div ref={sentinelRef} />
          </section>
        )
      ) : null}

      {secretCodesExporting ? (
        <BodyPortal>
          <div className="fulfillment-export-progress" role="status" aria-live="polite" aria-busy="true">
            <div className="fulfillment-export-progress__panel">
              <div className="fulfillment-export-progress__title">Exporting Secret Codes ZIP</div>
              <div className="fulfillment-export-progress__percent">{secretCodesExportPercent}%</div>
              <div className="muted small">
                {displayedSecretCodeCount} {displayedSecretCodeCount === 1 ? 'PNG' : 'PNGs'}
              </div>
            </div>
          </div>
        </BodyPortal>
      ) : null}

      <FulfillmentAddressModal
        key={`address:${scopeVersion}`}
        order={activeAddressOrder}
        canManage={canAdminEditFulfillmentAddress}
        suspended={walletModalVisible}
        isCurrentScope={isCurrentScope}
        onClose={handleCloseAddressModal}
        onOrderUpdated={updateOrder}
      />

      <FulfillmentShipStationModal
        key={`shipstation:${scopeVersion}`}
        order={activeShipstationOrder}
        canManage={hasFulfillmentAccess && signedIn}
        suspended={walletModalVisible}
        isCurrentScope={isCurrentScope}
        onClose={handleCloseShipstationModal}
        onOrderUpdated={updateOrder}
      />

      <FulfillmentStatusModal
        key={`status:${scopeVersion}`}
        order={activeUpdateOrder}
        canManage={hasFulfillmentAccess && signedIn}
        suspended={walletModalVisible}
        isCurrentScope={isCurrentScope}
        onClose={handleCloseUpdateModal}
        onOrderUpdated={updateOrder}
        onError={setOrdersError}
      />

      {authError ? <div className="error">{authError}</div> : null}
    </div>
  );
}
