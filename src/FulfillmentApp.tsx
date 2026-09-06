import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { FiAlertTriangle, FiDownload, FiEdit2, FiMoreHorizontal } from 'react-icons/fi';
import { updateFulfillmentAddress, updateFulfillmentStatus } from './api/fulfillment';
import { FulfillmentOrder, FulfillmentStatus } from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  loadFigureMetadata,
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from './lib/figureMetadata';
import { normalizeBoxDisplayImage, resolveBoxMediaIdForDrop, resolveDropContent } from './lib/dropContent';
import { dropAssetLabel } from './lib/dropLabels';
import {
  fulfillmentBoxSecretCode,
  fulfillmentCardClaimSecretCode,
  fulfillmentLooseFigureIdsExcludingCardClaims,
  fulfillmentOrderLooseFigureIds,
  isUsedReceiptClaimStatus,
} from './lib/fulfillmentCodes';
import { isDirectDeliveryItemsPerBox } from '../shared/shipping.ts';
import { CARD_NFT_2_PACK_IMAGES } from './lib/cardNft2Packs';
import { Modal } from './components/Modal';
import { FulfillmentShipStationModal } from './fulfillment/FulfillmentShipStationModal';
import { useFulfillmentOrders } from './fulfillment/useFulfillmentOrders';
import { useFulfillmentExports } from './fulfillment/useFulfillmentExports';
import { ShopHeader } from './components/ShopHeader';
import { BodyPortal } from './components/BackgroundBlurLayer';
import { formatFulfillmentAddressText } from './lib/fulfillmentExports';
import {
  fulfillmentBoxContentsLabel,
  resolveFulfillmentDirectDeliveryBoxLabel,
  resolveFulfillmentFigurePreview,
  type FulfillmentFigureLabelOverrideArgs,
} from './lib/fulfillmentLabels';
import { FULFILLMENT_STATUS_OPTIONS, normalizeFulfillmentStatus } from './lib/fulfillmentStatus';
import {
  DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER,
  FULFILLMENT_ORDER_VISIBILITY_OPTIONS,
  canEditFulfillmentOrderAddress,
  filterFulfillmentOrdersByVisibility,
  isRedeemedForIrlFulfillmentOrder,
  type FulfillmentOrderVisibilityFilter,
} from './lib/fulfillmentOrderVisibility';
import {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode,
  shouldDisplayFulfillmentTrackingCode,
} from '../shared/fulfillmentTracking.ts';
import {
  isDropFamily,
  listFrontendDrops,
  normalizeDropId,
  type FigureMediaConfig,
  type FrontendDeploymentConfig,
} from './config/deployment';
import { hasFulfillmentAddressAdminAccess, listAllowedFulfillmentDropIds } from './lib/fulfillmentAccess';
import { walletSessionSignInReadiness } from './lib/profileClientLifecycle';
import {
  formatManualReviewAmount,
  formatOrderDate,
  manualReviewCheckoutKey,
  manualReviewIssueText,
  shortenStripeSessionId,
} from './fulfillment/manualReview';
import { fulfillmentOrderKey, groupFulfillmentOrders } from './fulfillment/orders';
import {
  collectFulfillmentFigureMetadataTargets,
  mergeFigureMetadataRecords,
} from './fulfillment/figureMetadata';

const LITTLE_SWAG_BOXES_DROP_ID = 'little_swag_boxes';
const FIGURE_METADATA_RETRY_MS = 3000;
const BOX_CONTENTS_FIGURE_WIDTH = 130;
const BOX_CONTENTS_FIGURE_GAP = 12;
const BOX_CONTENTS_HORIZONTAL_CHROME = 54;

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

function getBoxContentsStyle(itemCount: number): CSSProperties {
  const columns = Math.max(1, Math.min(itemCount, 3));
  const contentWidth = columns * BOX_CONTENTS_FIGURE_WIDTH + Math.max(0, columns - 1) * BOX_CONTENTS_FIGURE_GAP;
  return { width: `min(100%, ${contentWidth + BOX_CONTENTS_HORIZONTAL_CHROME}px)` };
}

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
    return <span className="figure-image figure-image--placeholder" aria-hidden="true" />;
  }

  return <img src={activeSrc} alt={alt} loading="lazy" draggable={false} className="figure-image" onError={handleError} />;
}

function renderFigureTiles(args: {
  drop?: FrontendDeploymentConfig | null;
  dropId: string;
  figureIds: number[];
  keyPrefix: string;
  figureNamePrefix?: string;
  previewMode: 'media_map_folder' | 'metadata_stills';
  figureMedia?: FigureMediaConfig;
  figureMediaBase?: string;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  onMetadataResolved?: (record: FigureMetadataRecord) => void;
  labelOverride?: (args: FulfillmentFigureLabelOverrideArgs) => string;
  renderFooter?: (args: { figureId: number; index: number }) => ReactNode;
}) {
  const {
    dropId,
    figureIds,
    keyPrefix,
    drop,
    figureNamePrefix,
    previewMode,
    figureMedia,
    figureMediaBase,
    figureMetadataByKey,
    onMetadataResolved,
    labelOverride,
    renderFooter,
  } = args;
  return (
    <div className="figure-grid">
      {figureIds.map((figureId, index) => {
        const preview = resolveFulfillmentFigurePreview({
          dropId,
          drop: drop || { dropId, figureNamePrefix, figureMedia },
          figureId,
          index,
          previewMode,
          figureMediaBase,
          figureMetadataByKey,
          labelOverride,
        });
        return (
          <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
            <FigureTileImage
              dropId={dropId}
              figureId={figureId}
              primarySrc={preview.primarySrc}
              fallbackSrc={preview.fallbackSrc}
              alt={preview.alt}
              onMetadataResolved={onMetadataResolved}
            />
            <span className="muted small">{preview.label}</span>
            {renderFooter?.({ figureId, index })}
          </div>
        );
      })}
    </div>
  );
}

function SecretCodeDownloadButton(props: {
  secretCode: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  if (!props.onClick) return null;

  return (
    <button
      type="button"
      className="fulfillment-secret-code-download"
      aria-label={`Download PNG for secret code ${props.secretCode}`}
      title="Download PNG"
      disabled={props.disabled}
      onClick={(evt) => {
        evt.stopPropagation();
        props.onClick?.();
      }}
    >
      <FiDownload aria-hidden="true" />
    </button>
  );
}

function fulfillmentSecretCodeClassName(receiptClaimStatus: string | undefined): string {
  return isUsedReceiptClaimStatus(receiptClaimStatus)
    ? 'fulfillment-secret-code fulfillment-secret-code--used'
    : 'fulfillment-secret-code';
}

function SecretCodeDisplay(props: {
  secretCode: string;
  receiptClaimStatus?: string;
  downloadDisabled?: boolean;
  onDownload?: () => void;
  className?: string;
}) {
  const className = props.className
    ? `fulfillment-secret-code-group ${props.className}`
    : 'fulfillment-secret-code-group';

  return (
    <span className={className}>
      <span className="fulfillment-secret-code-heading">
        <span>Secret Code</span>
        <SecretCodeDownloadButton
          secretCode={props.secretCode}
          disabled={props.downloadDisabled}
          onClick={props.onDownload}
        />
      </span>
      <span className={fulfillmentSecretCodeClassName(props.receiptClaimStatus)}>{props.secretCode}</span>
    </span>
  );
}

function renderBoxTiles(args: {
  boxes: Array<{ boxId: number; boxIndex: number; secretCode: string; receiptClaimStatus?: string }>;
  keyPrefix: string;
  labelSource: Pick<FrontendDeploymentConfig, 'namePrefix' | 'figureNamePrefix' | 'mintSelection'>;
  getPreviewSrc?: (boxId: number) => string | undefined;
  secretCodeDownloadDisabled?: boolean;
  onDownloadSecretCode?: (boxIndex: number) => void;
}) {
  const {
    boxes,
    keyPrefix,
    labelSource,
    getPreviewSrc,
    secretCodeDownloadDisabled,
    onDownloadSecretCode,
  } = args;
  return (
    <div className="figure-grid">
      {boxes.map(({ boxId, boxIndex, secretCode, receiptClaimStatus }, index) => {
        const { label, sizeLabel } = resolveFulfillmentDirectDeliveryBoxLabel(labelSource, boxId);
        const imageSrc = getPreviewSrc?.(boxId);
        const hideSecretCodeDownload = isUsedReceiptClaimStatus(receiptClaimStatus);
        return (
          <div key={`${keyPrefix}:${boxId}:${index}`} className="figure-tile">
            {imageSrc ? (
              <img src={imageSrc} alt={label} loading="lazy" draggable={false} className="figure-image" />
            ) : (
              <div className="figure-image figure-image--placeholder" aria-hidden="true" />
            )}
            <div className={sizeLabel ? 'fulfillment-size-label' : 'muted small'}>{label}</div>
            {secretCode ? (
              <SecretCodeDisplay
                className="muted small"
                secretCode={secretCode}
                receiptClaimStatus={receiptClaimStatus}
                downloadDisabled={secretCodeDownloadDisabled}
                onDownload={
                  onDownloadSecretCode && !hideSecretCodeDownload ? () => onDownloadSecretCode(boxIndex) : undefined
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function renderFulfillmentPackSecretImage(args: {
  dropId: string;
  boxId: number;
}) {
  const { dropId, boxId } = args;
  const cardNft2PackMediaId = isDropFamily(dropId, 'card_nft_2') ? resolveBoxMediaIdForDrop(dropId, boxId) : null;
  const imageSrc =
    (cardNft2PackMediaId ? CARD_NFT_2_PACK_IMAGES[cardNft2PackMediaId - 1]?.src : undefined) ||
    normalizeBoxDisplayImage({ dropId, boxId });
  if (!imageSrc) return null;
  return (
    <img
      src={imageSrc}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      className="fulfillment-pack-secret-image"
    />
  );
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
  const [statusEdits, setStatusEdits] = useState<Record<string, FulfillmentStatus | ''>>({});
  const [trackingCodeEdits, setTrackingCodeEdits] = useState<Record<string, string>>({});
  const [statusSaving, setStatusSaving] = useState<Record<string, boolean>>({});
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [activeUpdateOrderKey, setActiveUpdateOrderKey] = useState<string | null>(null);
  const [activeAddressOrderKey, setActiveAddressOrderKey] = useState<string | null>(null);
  const [activeShipstationOrderKey, setActiveShipstationOrderKey] = useState<string | null>(null);
  const [addressEditText, setAddressEditText] = useState('');
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
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

  const mergeStatusEdits = useCallback((incoming: FulfillmentOrder[]) => {
    setStatusEdits((prev) => {
      const next = { ...prev };
      incoming.forEach((order) => {
        const key = fulfillmentOrderKey(order);
        if (!(key in next)) {
          next[key] = normalizeFulfillmentStatus(order.fulfillmentStatus);
        }
      });
      return next;
    });
    setTrackingCodeEdits((prev) => {
      const next = { ...prev };
      incoming.forEach((order) => {
        const key = fulfillmentOrderKey(order);
        if (!(key in next)) {
          next[key] = normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode) || '';
        }
      });
      return next;
    });
  }, []);

  const resetOrderUi = useCallback(() => {
    setManualReviewMenuOpen(false);
    setStatusEdits({});
    setTrackingCodeEdits({});
    setStatusSaving({});
    setActiveUpdateOrderKey(null);
    setActiveAddressOrderKey(null);
    setActiveShipstationOrderKey(null);
    setAddressEditText('');
    setAddressSaving(false);
    setAddressError(null);
  }, []);

  const {
    scopeVersion,
    orders,
    orderPageKeys,
    manualReviewCheckouts,
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
    onOrdersLoaded: mergeStatusEdits,
  });

  useEffect(() => {
    if (!manualReviewCheckouts.length && manualReviewMenuOpen) {
      setManualReviewMenuOpen(false);
    }
  }, [manualReviewCheckouts.length, manualReviewMenuOpen]);

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

  const handleSaveStatus = useCallback(
    async (orderToUpdate: FulfillmentOrder) => {
      if (!hasFulfillmentAccess || !signedIn) return false;
      const key = fulfillmentOrderKey(orderToUpdate);
      setStatusSaving((prev) => ({ ...prev, [key]: true }));
      setOrdersError(null);
      try {
        const nextStatus = normalizeFulfillmentStatus(statusEdits[key]);
        const nextTrackingCode =
          nextStatus === 'Shipped' ? sanitizeFulfillmentTrackingCode(trackingCodeEdits[key]) : undefined;
        const resp = await updateFulfillmentStatus(
          orderToUpdate.deliveryId,
          nextStatus,
          orderToUpdate.dropId,
          nextTrackingCode,
        );
        if (!isCurrentScope()) return false;
        const normalized = normalizeFulfillmentStatus(resp.fulfillmentStatus || nextStatus);
        const responseTrackingCode = normalizeOptionalFulfillmentTrackingCode(resp.fulfillmentTrackingCode);
        updateOrder(key, (order) => ({
          ...order,
          fulfillmentStatus: normalized || undefined,
          fulfillmentTrackingCode:
            normalized === 'Shipped'
              ? responseTrackingCode
              : responseTrackingCode || normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
        }));
        setStatusEdits((prev) => ({ ...prev, [key]: normalized }));
        setTrackingCodeEdits((prev) => ({
          ...prev,
          [key]:
            normalized === 'Shipped'
              ? responseTrackingCode || ''
              : responseTrackingCode || normalizeOptionalFulfillmentTrackingCode(orderToUpdate.fulfillmentTrackingCode) || '',
        }));
        return true;
      } catch (err) {
        if (!isCurrentScope()) return false;
        console.error(err);
        setOrdersError(err instanceof Error ? err.message : 'Failed to update status');
        return false;
      } finally {
        if (isCurrentScope()) {
          setStatusSaving((prev) => ({ ...prev, [key]: false }));
        }
      }
    },
    [hasFulfillmentAccess, isCurrentScope, setOrdersError, signedIn, statusEdits, trackingCodeEdits, updateOrder],
  );

  const statusDirty = useMemo(() => {
    const dirty = new Set<string>();
    orders.forEach((order) => {
      const key = fulfillmentOrderKey(order);
      const current = normalizeFulfillmentStatus(order.fulfillmentStatus);
      const edited = statusEdits[key] ?? '';
      const currentTrackingCode = normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode) || '';
      const editedTrackingCode = sanitizeFulfillmentTrackingCode(trackingCodeEdits[key]);
      if (current !== edited || (edited === 'Shipped' && currentTrackingCode !== editedTrackingCode)) dirty.add(key);
    });
    return dirty;
  }, [orders, statusEdits, trackingCodeEdits]);

  const activeUpdateOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeUpdateOrderKey) ?? null,
    [activeUpdateOrderKey, orders],
  );
  const activeUpdateOrderKeyResolved = activeUpdateOrder ? fulfillmentOrderKey(activeUpdateOrder) : '';
  const activeUpdateText = activeUpdateOrder
    ? statusEdits[activeUpdateOrderKeyResolved] ?? normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus)
    : '';
  const activeUpdateTrackingCode = activeUpdateOrder
    ? trackingCodeEdits[activeUpdateOrderKeyResolved] ??
      normalizeOptionalFulfillmentTrackingCode(activeUpdateOrder.fulfillmentTrackingCode) ??
      ''
    : '';
  const activeUpdateDirty = activeUpdateOrder ? statusDirty.has(activeUpdateOrderKeyResolved) : false;
  const activeUpdateSaving = activeUpdateOrder ? Boolean(statusSaving[activeUpdateOrderKeyResolved]) : false;

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
  const handleShipstationOrderUpdated = useCallback((
    key: string,
    update: (order: FulfillmentOrder) => FulfillmentOrder,
    trackingCodeUpdate?: string | null,
  ) => {
    if (!isCurrentScope()) return;
    updateOrder(key, update);
    if (trackingCodeUpdate !== undefined) {
      setTrackingCodeEdits((prev) => ({ ...prev, [key]: trackingCodeUpdate ?? '' }));
    }
  }, [isCurrentScope, updateOrder]);

  const handleCancelUpdate = useCallback(() => {
    if (!activeUpdateOrder) {
      setActiveUpdateOrderKey(null);
      return;
    }
    const key = fulfillmentOrderKey(activeUpdateOrder);
    setStatusEdits((prev) => ({
      ...prev,
      [key]: normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus),
    }));
    setTrackingCodeEdits((prev) => ({
      ...prev,
      [key]: normalizeOptionalFulfillmentTrackingCode(activeUpdateOrder.fulfillmentTrackingCode) || '',
    }));
    setActiveUpdateOrderKey(null);
  }, [activeUpdateOrder]);

  const handleSaveActiveUpdate = useCallback(async () => {
    if (!activeUpdateOrder) return;
    if (!activeUpdateDirty) {
      setActiveUpdateOrderKey(null);
      return;
    }
    const ok = await handleSaveStatus(activeUpdateOrder);
    if (ok && isCurrentScope()) setActiveUpdateOrderKey(null);
  }, [activeUpdateDirty, activeUpdateOrder, handleSaveStatus, isCurrentScope]);

  const activeAddressOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeAddressOrderKey) ?? null,
    [activeAddressOrderKey, orders],
  );
  const activeAddressText =
    typeof activeAddressOrder?.address.full === 'string' && activeAddressOrder.address.full !== '***'
      ? activeAddressOrder.address.full.trim()
      : '';
  const addressEditDirty = Boolean(activeAddressOrder && addressEditText.trim() !== activeAddressText);

  const handleOpenAddressModal = useCallback(
    (order: FulfillmentOrder) => {
      if (!canAdminEditFulfillmentAddress || isRedeemedForIrlFulfillmentOrder(order)) return;
      const full = typeof order.address.full === 'string' && order.address.full !== '***' ? order.address.full : '';
      setAddressEditText(full);
      setAddressError(null);
      setActiveAddressOrderKey(fulfillmentOrderKey(order));
    },
    [canAdminEditFulfillmentAddress],
  );

  const handleCloseAddressModal = useCallback(() => {
    if (addressSaving) return;
    setActiveAddressOrderKey(null);
    setAddressEditText('');
    setAddressError(null);
  }, [addressSaving]);

  const handleSaveAddress = useCallback(async () => {
    if (!activeAddressOrder || !canAdminEditFulfillmentAddress || addressSaving) return;
    const full = addressEditText.trim();
    if (!full) {
      setAddressError('Enter a delivery address.');
      return;
    }
    if (!addressEditDirty) {
      handleCloseAddressModal();
      return;
    }

    const orderKey = fulfillmentOrderKey(activeAddressOrder);
    setAddressSaving(true);
    setAddressError(null);
    try {
      const response = await updateFulfillmentAddress(
        activeAddressOrder.deliveryId,
        full,
        activeAddressOrder.dropId,
      );
      if (!isCurrentScope()) return;
      updateOrder(orderKey, (order) => ({ ...order, address: { ...order.address, ...response.address } }));
      setActiveAddressOrderKey(null);
      setAddressEditText('');
    } catch (err) {
      if (!isCurrentScope()) return;
      console.error(err);
      setAddressError(err instanceof Error ? err.message : 'Failed to update delivery address');
    } finally {
      if (isCurrentScope()) {
        setAddressSaving(false);
      }
    }
  }, [
    activeAddressOrder,
    addressEditDirty,
    addressEditText,
    addressSaving,
    canAdminEditFulfillmentAddress,
    handleCloseAddressModal,
    isCurrentScope,
    updateOrder,
  ]);

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

  const renderManualReviewMenu = () => (
    <div className="manual-review-menu" role="dialog" aria-label="Needs manual review">
      <div className="manual-review-menu__head">
        <div className="manual-review-menu__title">Needs manual review</div>
        <div className="muted small">
          {manualReviewCheckouts.length} {manualReviewCheckouts.length === 1 ? 'checkout' : 'checkouts'}
        </div>
      </div>
      <div className="manual-review-menu__list">
        {manualReviewCheckouts.map((checkout) => {
          const addressText = formatFulfillmentAddressText(checkout.address);
          const contactEmail = checkout.address.full !== '***' ? checkout.address.email : '';
          const quantityText = typeof checkout.quantity === 'number' ? `${checkout.quantity} item${checkout.quantity === 1 ? '' : 's'}` : 'Quantity pending';
          const ownerText = checkout.owner || checkout.authSubject || 'Owner unavailable';
          return (
            <div key={manualReviewCheckoutKey(checkout)} className="manual-review-row">
              <div className="manual-review-row__top">
                <div className="manual-review-row__title">
                  {showManualReviewDropId ? `${checkout.dropId} · ` : ''}
                  {quantityText} · {formatManualReviewAmount(checkout.amountTotal, checkout.currency)}
                </div>
                <div className="muted small">{formatOrderDate(checkout.failedAt || checkout.createdAt)}</div>
              </div>
              <div className="manual-review-row__meta">
                <span className="mono small">{shortenStripeSessionId(checkout.sessionId)}</span>
                <span className="mono small">{ownerText}</span>
              </div>
              {contactEmail ? <div className="manual-review-contact small">{contactEmail}</div> : null}
              <div className="manual-review-address small">{addressText || 'Address unavailable'}</div>
              <div className="manual-review-reason small">{manualReviewIssueText(checkout)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );

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

  const renderFulfillmentOrderSection = (
    order: FulfillmentOrder,
    options?: { showContactInfo?: boolean; showFullAddress?: boolean },
  ) => {
    const orderDrop = dropById.get(order.dropId);
    if (!orderDrop) return null;
    const orderKey = fulfillmentOrderKey(order);
    const orderDropContent = resolveDropContent(orderDrop);
    const orderFigureMediaBase = orderDropContent.figures.fulfillmentMediaBaseUrl;
    const orderIsDirectDeliveryDrop = isDirectDeliveryItemsPerBox(orderDrop.itemsPerBox);
    const orderShowsFulfillmentPackPreview = isDropFamily(orderDrop, 'card_nft_2');
    const cardClaims = order.cardClaims || [];
    const looseDudes = fulfillmentLooseFigureIdsExcludingCardClaims(order);
    const showContactInfo = options?.showContactInfo ?? true;
    const showFullAddress = options?.showFullAddress ?? true;
    const canEditOrderAddress = canEditFulfillmentOrderAddress(order, {
      showFullAddress,
      hasAddressAccess: canAdminEditFulfillmentAddress,
    });
    const canPrintOrderLabel =
      !isRedeemedForIrlFulfillmentOrder(order) &&
      (Boolean(order.shipstationShipmentId) || normalizeFulfillmentStatus(order.fulfillmentStatus) !== 'Shipped');
    const showOrderEmailLine =
      showContactInfo && ((order.address.full !== '***' && Boolean(order.address.email)) || canEditOrderAddress);
    return (
      <div key={orderKey} className="fulfillment-order-section">
        <div className="card__head">
          <div>
            <div className="card__title">Order {order.deliveryId}</div>
            <div className="muted fulfillment-order-date small">{formatOrderDate(order.processedAt || order.createdAt)}</div>
            {showOrderEmailLine ? (
              <div className="fulfillment-order-email-line">
                {order.address.full !== '***' && order.address.email ? (
                  <div className="muted small">{order.address.email}</div>
                ) : null}
                {canEditOrderAddress ? (
                  <button
                    type="button"
                    className="fulfillment-order-address-edit"
                    onClick={() => handleOpenAddressModal(order)}
                    aria-label={`Edit address for order ${order.deliveryId}`}
                    title="Edit address"
                  >
                    <FiEdit2 aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
            {showContactInfo && order.address.full !== '***' && order.address.phone ? (
              <div className="muted small">{order.address.phone}</div>
            ) : null}
          </div>
          <div className="order-update">
            {(() => {
              const statusText = normalizeFulfillmentStatus(order.fulfillmentStatus);
              const trackingCode = shouldDisplayFulfillmentTrackingCode(order.fulfillmentStatus, order.fulfillmentTrackingCode)
                ? normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode)
                : '';
              const trackingHref = resolveFulfillmentTrackingHref(trackingCode);
              return statusText ? (
                <>
                  <div className="status-readout fulfillment-order-status-text small">{statusText}</div>
                  {trackingCode ? (
                    trackingHref ? (
                      <a className="tracking-link small" href={trackingHref} target="_blank" rel="noopener noreferrer">
                        Tracking
                      </a>
                    ) : (
                      <div className="tracking-code-readout mono small">{trackingCode}</div>
                    )
                  ) : null}
                </>
              ) : (
                <em className="muted fulfillment-order-status-text small">Not set</em>
              );
            })()}
            <button
              type="button"
              className="link fulfillment-order-status-action small no-focus-style"
              onClick={() => handleOpenUpdateModal(orderKey)}
            >
              {normalizeFulfillmentStatus(order.fulfillmentStatus) ? 'Edit status' : 'Set status'}
            </button>
          </div>
        </div>

        <div className="order-items">
          {showFullAddress || canPrintOrderLabel ? (
            <div className="address-lines">
              {showFullAddress ? (
                order.address.full ? (
                  <div className="address-text">
                    {formatFulfillmentAddressText(order.address)}
                  </div>
                ) : (
                  <>
                    <div className="muted small">Encrypted address payload</div>
                    <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                  </>
                )
              ) : null}
              {canPrintOrderLabel ? (
                <div className="fulfillment-order-address-actions">
                  <button
                    type="button"
                    className="link fulfillment-order-address-action small no-focus-style"
                    onClick={() => handleOpenShipstationModal(orderKey)}
                  >
                    Print Label
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {order.boxes.length ? (
            orderIsDirectDeliveryDrop ? (
              renderBoxTiles({
                boxes: order.boxes.map((box, boxIndex) => ({
                  boxId: box.boxId,
                  boxIndex,
                  secretCode: fulfillmentBoxSecretCode(box),
                  receiptClaimStatus: box.receiptClaimStatus,
                })),
                keyPrefix: `${orderKey}:box`,
                labelSource: orderDrop,
                getPreviewSrc: (boxId) => normalizeBoxDisplayImage({ dropId: orderDrop.dropId, boxId }),
                secretCodeDownloadDisabled,
                onDownloadSecretCode: (boxIndex) =>
                  void downloadSecretCodePng(order, { kind: 'box', index: boxIndex }),
              })
            ) : (
              <div className="box-contents-list">
                {order.boxes.map((box, boxIndex) => {
                  const secretCode = fulfillmentBoxSecretCode(box);
                  const hideSecretCodeDownload = isUsedReceiptClaimStatus(box.receiptClaimStatus);
                  const packSecretImage = orderShowsFulfillmentPackPreview
                    ? renderFulfillmentPackSecretImage({
                        dropId: orderDrop.dropId,
                        boxId: box.boxId,
                      })
                    : null;
                  return (
                    <div
                      key={`${orderKey}:${box.boxId}`}
                      className="card subtle box-contents"
                      style={getBoxContentsStyle(box.dudeIds.length)}
                    >
                      <div className="card__title">
                        {secretCode ? (
                          <span className="fulfillment-pack-secret">
                            {packSecretImage}
                            <SecretCodeDisplay
                              secretCode={secretCode}
                              receiptClaimStatus={box.receiptClaimStatus}
                              downloadDisabled={secretCodeDownloadDisabled}
                              onDownload={
                                hideSecretCodeDownload
                                  ? undefined
                                  : () => void downloadSecretCodePng(order, { kind: 'box', index: boxIndex })
                              }
                            />
                          </span>
                        ) : (
                          fulfillmentBoxContentsLabel(orderDrop, box.boxId, '')
                        )}
                      </div>
                      {!secretCode ? (
                        <div className="muted small">Secret code unavailable</div>
                      ) : !box.dudeIds.length ? (
                        <div className="muted small">Assigned {dropAssetLabel(orderDrop, 'figure', 2)} pending</div>
                      ) : null}
                      {box.dudeIds.length ? (
                        renderFigureTiles({
                          dropId: orderDrop.dropId,
                          drop: orderDrop,
                          figureIds: box.dudeIds,
                          keyPrefix: `${orderKey}:${box.boxId}`,
                          figureNamePrefix: orderDrop.figureNamePrefix,
                          previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                          figureMediaBase: orderFigureMediaBase,
                          figureMedia: orderDrop.figureMedia,
                          figureMetadataByKey,
                          onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                        })
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          {cardClaims.length
            ? renderFigureTiles({
                dropId: orderDrop.dropId,
                drop: orderDrop,
                figureIds: cardClaims.map((claim) => claim.figureId),
                keyPrefix: `${orderKey}:card-claim`,
                figureNamePrefix: orderDrop.figureNamePrefix,
                previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                figureMediaBase: orderFigureMediaBase,
                figureMedia: orderDrop.figureMedia,
                figureMetadataByKey,
                onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                renderFooter: ({ index }) => {
                  const claim = cardClaims[index];
                  const secretCode = claim ? fulfillmentCardClaimSecretCode(claim) : '';
                  if (!claim || !secretCode) {
                    return <span className="muted small">Secret code unavailable</span>;
                  }
                  const hideSecretCodeDownload = isUsedReceiptClaimStatus(claim.receiptClaimStatus);
                  return (
                    <SecretCodeDisplay
                      className="muted small"
                      secretCode={secretCode}
                      receiptClaimStatus={claim.receiptClaimStatus}
                      downloadDisabled={secretCodeDownloadDisabled}
                      onDownload={
                        hideSecretCodeDownload
                          ? undefined
                          : () => void downloadSecretCodePng(order, { kind: 'card-claim', index })
                      }
                    />
                  );
                },
              })
            : null}

          {looseDudes.length
            ? renderFigureTiles({
                dropId: orderDrop.dropId,
                drop: orderDrop,
                figureIds: looseDudes,
                keyPrefix: `${orderKey}:dude`,
                figureNamePrefix: orderDrop.figureNamePrefix,
                previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                figureMediaBase: orderFigureMediaBase,
                figureMedia: orderDrop.figureMedia,
                figureMetadataByKey,
                onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
              })
            : null}
        </div>
      </div>
    );
  };

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
                  {manualReviewCheckouts.length ? (
                    <div className="manual-review-menu-wrap" ref={manualReviewMenuRef}>
                      <button
                        type="button"
                        className="manual-review-button"
                        aria-label={`Needs manual review, ${manualReviewCheckouts.length} ${
                          manualReviewCheckouts.length === 1 ? 'checkout' : 'checkouts'
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
                        <span>{manualReviewCheckouts.length}</span>
                      </button>
                      {manualReviewMenuOpen ? renderManualReviewMenu() : null}
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
                      {renderFigureTiles({
                        dropId: duplicateDrop.dropId,
                        drop: duplicateDrop,
                        figureIds: duplicateFigures.map((entry) => entry.figureId),
                        keyPrefix: 'duplicates',
                        figureNamePrefix: duplicateDrop.figureNamePrefix,
                        previewMode: duplicateDropContent.figures.fulfillmentPreviewMode,
                        figureMediaBase: duplicateFigureMediaBase,
                        figureMedia: duplicateDrop.figureMedia,
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
                    key={`${group.pageIndex}:${group.groupKey}`}
                    className="card subtle fulfillment-order-group"
                  >
                    {group.orders.map((order, index) =>
                      renderFulfillmentOrderSection(order, {
                        showContactInfo: !group.collapseSharedContact || index === 0,
                        showFullAddress: !group.collapseSharedContact || index === 0,
                      }),
                    )}
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

      <Modal
        open={activeAddressOrderKey !== null}
        title={activeAddressOrder ? `Edit address · Order ${activeAddressOrder.deliveryId}` : 'Edit address'}
        onClose={handleCloseAddressModal}
        showCloseButton={false}
        closeOnEscape={!addressSaving}
        suspended={walletModalVisible}
      >
        <form
          className="modal-form fulfillment-address-form"
          onSubmit={(evt) => {
            evt.preventDefault();
            void handleSaveAddress();
          }}
        >
          <label>
            <span className="muted">Delivery address</span>
            <textarea
              value={addressEditText}
              onChange={(evt) => setAddressEditText(evt.target.value)}
              rows={8}
              maxLength={2048}
              required
              disabled={addressSaving}
              autoComplete="street-address"
              aria-label="Delivery address"
            />
          </label>
          <div className="muted small">This changes the address for this order only.</div>
          {addressError ? <div className="error">{addressError}</div> : null}
          <div className="row row--end">
            <button
              type="button"
              className="secondary-light"
              onClick={handleCloseAddressModal}
              disabled={addressSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!activeAddressOrder || addressSaving || !addressEditDirty || !addressEditText.trim()}
            >
              {addressSaving ? 'Saving…' : 'Save address'}
            </button>
          </div>
        </form>
      </Modal>

      <FulfillmentShipStationModal
        key={scopeVersion}
        order={activeShipstationOrder}
        canManage={hasFulfillmentAccess && signedIn}
        suspended={walletModalVisible}
        isCurrentScope={isCurrentScope}
        onClose={handleCloseShipstationModal}
        onOrderUpdated={handleShipstationOrderUpdated}
      />

      <Modal
        open={activeUpdateOrderKey !== null}
        title={activeUpdateOrder ? `Order ${activeUpdateOrder.deliveryId}` : 'Order'}
        onClose={handleCancelUpdate}
        showCloseButton={false}
        suspended={walletModalVisible}
      >
        <div className="modal-form">
          <select
            className="status-input"
            value={activeUpdateText}
            onChange={(evt) => {
              if (!activeUpdateOrder) return;
              const nextStatus = normalizeFulfillmentStatus(evt.target.value);
              setStatusEdits((prev) => ({ ...prev, [fulfillmentOrderKey(activeUpdateOrder)]: nextStatus }));
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
          {activeUpdateText === 'Shipped' ? (
            <input
              className="tracking-input"
              value={activeUpdateTrackingCode}
              onChange={(evt) => {
                if (!activeUpdateOrder) return;
                setTrackingCodeEdits((prev) => ({
                  ...prev,
                  [fulfillmentOrderKey(activeUpdateOrder)]: evt.target.value,
                }));
              }}
              placeholder="Tracking link"
              aria-label="Tracking link"
              autoComplete="off"
            />
          ) : null}
          <div className="row row--end">
            <button type="button" className="secondary-light" onClick={handleCancelUpdate}>
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
