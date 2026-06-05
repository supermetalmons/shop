import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type TransitionEvent } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Connection, LAMPORTS_PER_SOL, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { onAuthStateChanged } from 'firebase/auth';
import { FaBoxOpen, FaPlane, FaTableCellsLarge } from 'react-icons/fa6';
import { MintPanel, type MintPanelBoxMedia } from './components/MintPanel';
import { DropsPanel } from './components/DropsPanel';
import { InventoryGrid } from './components/InventoryGrid';
import { DeliveryForm } from './components/DeliveryForm';
import { Modal } from './components/Modal';
import { NotifyOverlay } from './components/NotifyOverlay';
import { ClaimForm } from './components/ClaimForm';
import { ShopHeader } from './components/ShopHeader';
import { useMintProgress } from './hooks/useMintProgress';
import { useInventory } from './hooks/useInventory';
import { usePendingOpenBoxes } from './hooks/usePendingOpenBoxes';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { useDropPageScrollFade } from './hooks/useDropPageScrollFade';
import {
  createStripeCheckoutSession,
  getAnonymousStripeDeliveryHistory,
  getProfile,
  listDeliveryOrderOwners,
  recoverMyDeliveryOrders,
  rememberPendingOpenDropId,
  requestClaimTx,
  requestDeliveryTx,
  revealDudes,
  saveEncryptedAddress,
  issueReceipts,
} from './lib/api';
import { auth } from './lib/firebase';
import { isRetryableCallableError, retryWithBackoff } from './lib/callableErrors';
import {
  completeStripeCheckoutMarker,
  completedStripeCheckoutMarkerSummaryForFirebaseUid,
  forgetCompletedStripeCheckoutMarkersForFirebaseUid,
  loadStripeCheckoutMarkers,
  rememberStripeCheckoutStarted,
} from './lib/stripeCheckoutMarkers';
import {
  buildMintBoxesTxWithAccounts,
  buildMintDiscountedBoxTxWithAccounts,
  buildMintDiscountedVariantBoxTxWithAccounts,
  buildMintVariantBoxTxWithAccounts,
  buildStartOpenBoxTxWithPending,
  deriveMintSelectionAvailabilityFromConfig,
  fetchBoxMinterConfig,
  fetchDiscountMintRecordUsedCount,
} from './lib/boxMinter';
import { getDiscountProof, isDiscountListed } from './lib/discounts';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  loadFigureMetadata,
  parseFigureMetadataCacheKey,
  type FigureMetadataRecord,
  type FigureMetadataTarget,
} from './lib/figureMetadata';
import { hideImageShowFallback, showImageHideFallback } from './lib/imageFallback';
import {
  joinDropAssetUrl,
  mintPanelPreviewAspectRatio,
  mintPanelPreviewImage,
  normalizeCertificateDisplayImage,
  normalizeBoxDisplayImage,
  resolveDropContent,
} from './lib/dropContent';
import {
  dropAssetCount,
  dropAssetLabel,
  dropAssetReference,
  dropOpenActionLabel,
  dropOpenActionProgress,
  dropOpenGerund,
  dropOpenVerb,
} from './lib/dropLabels';
import { soundPlayer } from './lib/SoundPlayer';
import { getBuildInfo } from './lib/buildInfo';
import PonchoInventoryRevealOverlay, { PonchoCardViewerOverlay } from './components/PonchoRevealOverlay';
import {
  PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
  PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS,
  PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS,
  clearPonchoDrifellaImageCache,
  createPonchoDrifellaImageCache,
  getPonchoDrifellaCardByFigureId,
  preloadPonchoDrifellaCardAssets,
  preloadPonchoDrifellaPackAssets,
  type PonchoDrifellaRevealRequestStatus,
} from './lib/ponchoDrifellaReveal';
import { preloadRevealFrames, resolveRevealFrameSrc } from './lib/revealFrameSequence';
import {
  encryptAddressPayload,
  isBlockhashExpiredError,
  recoverAlreadyProcessedAccounts,
  recoverAlreadyProcessedSignature,
  sendPreparedTransaction,
  shortAddress,
} from './lib/solana';
import { calculateDeliveryLamports, isDirectDeliveryItemsPerBox } from './lib/shipping';
import {
  DeliveryOrderSummary,
  InventoryItem,
  PendingOpenBox,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
} from './types';
import { type FrontendDeploymentConfig, getFrontendDrop, isDropFamily, resolveDropAssetUrl } from './config/deployment';
import { getNormalizedPathname, navigate } from './navigation';
import {
  dropPath,
  listFrontendDrops,
  resolveFrontendDropByPath,
  resolveUpcomingDropRouteByPath,
  rpcEndpointForCluster,
} from './lib/dropConfig';
import { ADMIN_WALLETS, hasFulfillmentAppAccess } from './lib/fulfillmentAccess';
import { getInventoryRevealRect } from './lib/inventoryMediaRect';
import {
  calcPonchoDrifellaAbsoluteCardRect,
  calcPonchoDrifellaCardRect,
  calcPonchoDrifellaRevealTargetRect,
} from './lib/revealOverlayLayout';
import {
  CARD_NFT_2_PACK_DARK_VIDEO_POSTER_URL,
  CARD_NFT_2_PACK_DARK_VIDEO_SOURCES,
  CARD_NFT_2_PACK_COMPACT_VIDEO_SCALE,
  CARD_NFT_2_PACK_LIGHT_VIDEO_POSTER_URL,
  CARD_NFT_2_PACK_LIGHT_VIDEO_SOURCES,
  CARD_NFT_2_PACK_PREVIEW_IMAGE_URL,
  CARD_NFT_2_PACK_VIDEO_ASPECT_RATIO,
  CARD_NFT_2_PACK_VIDEO_SCALE,
} from './lib/cardNft2Packs';

const ADDRESS_ENCRYPTION_PUBLIC_KEY = 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=';
const BUILD_INFO = getBuildInfo();
const REVEAL_CLOSE_FALLBACK_MS = 380;
const PONCHO_OUTSIDE_TAP_DISMISS_LOCK_MS = 1_300;
const TOAST_VISIBLE_MS = 1800;
const TOAST_FADE_MS = 250;
const DROP_CARD_BACKDROP_ENABLED = false;
const DROP_CARD_BACKDROP_COUNT = 30;
const DROP_CARD_BACKDROP_COLUMNS = 6;
const DROP_CARD_BACKDROP_ROWS = 5;
const DROP_CARD_BACKDROP_EDGE_GAP_PX = 10;
const DROP_CARD_BACKDROP_AVOID_GAP_PX = 12;
const DROP_CARD_BACKDROP_MIN_CARD_SIZE_PX = 44;
const DROP_CARD_BACKDROP_MAX_CARD_SIZE_PX = 132;
const DROP_CARD_BACKDROP_DEFAULT_HEIGHT_RATIO = 1.66;
const DROP_CARD_BACKDROP_SAFE_SIZE_MULTIPLIER = 1.04;
const DROP_CARD_BACKDROP_REPOSITION_STEPS = 28;
const DROP_CARD_BACKDROP_REPOSITION_CANDIDATES = 12;
const DARK_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

type DropCardBackdropConfig = {
  baseUrl: string;
  maxId: number;
  allowRepeats?: boolean;
  srcForId?: (baseUrl: string, id: number) => string;
  sizeBase?: number;
  sizeRange?: number;
  opacityBase?: number;
  opacityRange?: number;
  rotateRange?: number;
  heightRatio?: number;
};
type ReceiptViewerSource = Pick<InventoryItem, 'id' | 'dropId' | 'name' | 'image'>;
type ReceiptViewerImage = {
  key: string;
  name: string;
  image?: string;
};
type ReceiptViewerImageShellStyle = CSSProperties & { '--receipt-viewer-count'?: string };
type OverlayViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type DropCardBackdropItem = {
  id: number;
  src: string;
  x: number;
  y: number;
  size: number;
  opacity: number;
  rotate: number;
  blur: number;
  heightRatio: number;
};
type DropCardBackdropBounds = {
  viewportWidth: number;
  viewportHeight: number;
  avoidRects: DropCardBackdropRect[];
};
type DropCardBackdropRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
type DropCardBackdropPlacement = {
  x: number;
  y: number;
  rect: DropCardBackdropRect;
};
type DropCardBackdropRenderItem = {
  item: DropCardBackdropItem;
  index: number;
  placement: DropCardBackdropPlacement;
};
type StripePaymentMode = 'test' | 'live';
type StripeCheckoutReturn =
  | {
      status: 'success';
      sessionId: string;
    }
  | {
      status: 'cancel' | 'unverified_success';
      sessionId?: undefined;
    };

function shuffleWithRandom<T>(items: T[], random: () => number): T[] {
  const next = items.slice();
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function dropCardBackdropRowY(row: number, random: () => number): number {
  const lastRow = DROP_CARD_BACKDROP_ROWS - 1;
  if (lastRow <= 0) return 50;
  if (row <= 0) return random() * 4;
  if (row >= lastRow) return 100 - random() * 4;
  return clampNumber((row / lastRow) * 100 + (random() - 0.5) * 8, 0, 100);
}

function seededBackdropRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function createDropCardBackdropItems(config: DropCardBackdropConfig): DropCardBackdropItem[] {
  const random = Math.random;
  const sizeBase = config.sizeBase ?? 7.5;
  const sizeRange = config.sizeRange ?? 4.5;
  const opacityBase = config.opacityBase ?? 0.07;
  const opacityRange = config.opacityRange ?? 0.1;
  const rotateRange = config.rotateRange ?? 26;
  const heightRatio = config.heightRatio ?? DROP_CARD_BACKDROP_DEFAULT_HEIGHT_RATIO;
  const ids = config.allowRepeats
    ? Array.from({ length: DROP_CARD_BACKDROP_COUNT }, () => Math.floor(random() * config.maxId) + 1)
    : shuffleWithRandom(
        Array.from({ length: config.maxId }, (_, index) => index + 1),
        random,
      ).slice(0, DROP_CARD_BACKDROP_COUNT);
  const cells = shuffleWithRandom(
    Array.from({ length: DROP_CARD_BACKDROP_COUNT }, (_, index) => ({
      col: index % DROP_CARD_BACKDROP_COLUMNS,
      row: Math.floor(index / DROP_CARD_BACKDROP_COLUMNS),
    })),
    random,
  );

  return ids.map((id, index) => {
    const cell = cells[index];
    const xJitter = (random() - 0.5) * 6;
    const depth = random();

    return {
      id,
      src: config.srcForId ? config.srcForId(config.baseUrl, id) : `${config.baseUrl}/${id}.webp`,
      x: ((cell.col + 0.5) / DROP_CARD_BACKDROP_COLUMNS) * 100 + xJitter,
      y: dropCardBackdropRowY(cell.row, random),
      size: sizeBase + depth * sizeRange,
      opacity: opacityBase + depth * opacityRange,
      rotate: (random() - 0.5) * rotateRange,
      blur: depth < 0.35 ? 0.3 : 0,
      heightRatio,
    };
  });
}

const PONCHO_DROP_CARD_BACKDROP_CONFIG: DropCardBackdropConfig = {
  baseUrl: '/backdrops/poncho_drifella',
  maxId: 207,
  heightRatio: 500 / 357,
};
const HOODIE_DROP_CARD_BACKDROP_CONFIG: DropCardBackdropConfig = {
  baseUrl: '/hoodie',
  maxId: 7,
  allowRepeats: true,
  sizeBase: 5.2,
  sizeRange: 3.2,
  rotateRange: 0,
  heightRatio: 555 / 371,
};
const LSB_DROP_CARD_BACKDROP_CONFIG: DropCardBackdropConfig = {
  baseUrl: '/backdrops/little_swag_boxes',
  maxId: 333,
  sizeBase: 5.2,
  sizeRange: 3.2,
  rotateRange: 0,
  heightRatio: 500 / 304,
};

function dropCardBackdropViewportMin(bounds: DropCardBackdropBounds): number {
  const layoutWidth = typeof window === 'undefined' ? bounds.viewportWidth : window.innerWidth || bounds.viewportWidth;
  const layoutHeight = typeof window === 'undefined' ? bounds.viewportHeight : window.innerHeight || bounds.viewportHeight;
  return Math.min(layoutWidth, layoutHeight);
}

function dropCardBackdropWidthPx(item: DropCardBackdropItem, bounds: DropCardBackdropBounds): number {
  return clampNumber(
    (dropCardBackdropViewportMin(bounds) * item.size) / 100,
    DROP_CARD_BACKDROP_MIN_CARD_SIZE_PX,
    DROP_CARD_BACKDROP_MAX_CARD_SIZE_PX,
  );
}

function dropCardBackdropSafeBox(item: DropCardBackdropItem, bounds: DropCardBackdropBounds) {
  const width = dropCardBackdropWidthPx(item, bounds);
  const height = width * item.heightRatio;
  const rotation = Math.abs(item.rotate) * (Math.PI / 180);
  const rotatedWidth = width * Math.cos(rotation) + height * Math.sin(rotation);
  const rotatedHeight = width * Math.sin(rotation) + height * Math.cos(rotation);

  return {
    halfWidth: (rotatedWidth * DROP_CARD_BACKDROP_SAFE_SIZE_MULTIPLIER) / 2 + DROP_CARD_BACKDROP_AVOID_GAP_PX,
    halfHeight: (rotatedHeight * DROP_CARD_BACKDROP_SAFE_SIZE_MULTIPLIER) / 2 + DROP_CARD_BACKDROP_AVOID_GAP_PX,
  };
}

function dropCardBackdropRectFromCenter(
  x: number,
  y: number,
  safeBox: ReturnType<typeof dropCardBackdropSafeBox>,
): DropCardBackdropRect {
  return {
    left: x - safeBox.halfWidth,
    top: y - safeBox.halfHeight,
    right: x + safeBox.halfWidth,
    bottom: y + safeBox.halfHeight,
  };
}

function rectsOverlap(a: DropCardBackdropRect, b: DropCardBackdropRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rectInsideBackdropViewport(rect: DropCardBackdropRect, bounds: DropCardBackdropBounds): boolean {
  return (
    rect.left >= DROP_CARD_BACKDROP_EDGE_GAP_PX &&
    rect.top >= DROP_CARD_BACKDROP_EDGE_GAP_PX &&
    rect.right <= bounds.viewportWidth - DROP_CARD_BACKDROP_EDGE_GAP_PX &&
    rect.bottom <= bounds.viewportHeight - DROP_CARD_BACKDROP_EDGE_GAP_PX
  );
}

function backdropRectAllowed(
  rect: DropCardBackdropRect,
  bounds: DropCardBackdropBounds,
  occupiedRects: DropCardBackdropRect[],
): boolean {
  if (!rectInsideBackdropViewport(rect, bounds)) return false;
  if (bounds.avoidRects.some((avoidRect) => rectsOverlap(rect, avoidRect))) return false;
  return !occupiedRects.some((occupiedRect) => rectsOverlap(rect, occupiedRect));
}

function elementAvoidRect(selector: string, padding: number): DropCardBackdropRect | null {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  };
}

function elementAvoidRects(selector: string, padding: number): DropCardBackdropRect[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return [];
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];

    return [{
      left: rect.left - padding,
      top: rect.top - padding,
      right: rect.right + padding,
      bottom: rect.bottom + padding,
    }];
  });
}

function measureDropCardBackdropBounds(): DropCardBackdropBounds {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0;
  const avoidPadding = DROP_CARD_BACKDROP_AVOID_GAP_PX;
  const avoidRects = [
    elementAvoidRect('header.top--fixed .brand h1', avoidPadding),
    elementAvoidRect('header.top--fixed .top__right', avoidPadding),
    ...elementAvoidRects(
      [
        '.mint-panel__footer .mint-panel__info',
        '.mint-panel__footer .mint-panel__slider:not(.mint-panel__slider--hidden)',
        '.mint-panel__footer .mint-panel__cta',
      ].join(','),
      avoidPadding,
    ),
  ].filter((rect): rect is DropCardBackdropRect => Boolean(rect));

  return { viewportWidth, viewportHeight, avoidRects };
}

function boundsEqual(a: DropCardBackdropBounds | null, b: DropCardBackdropBounds): boolean {
  if (!a || Math.abs(a.viewportWidth - b.viewportWidth) >= 0.5 || Math.abs(a.viewportHeight - b.viewportHeight) >= 0.5) {
    return false;
  }
  if (a.avoidRects.length !== b.avoidRects.length) return false;

  return a.avoidRects.every((rect, index) => {
    const next = b.avoidRects[index];
    return (
      Math.abs(rect.left - next.left) < 0.5 &&
      Math.abs(rect.top - next.top) < 0.5 &&
      Math.abs(rect.right - next.right) < 0.5 &&
      Math.abs(rect.bottom - next.bottom) < 0.5
    );
  });
}

function clampBackdropCenter(
  x: number,
  y: number,
  safeBox: ReturnType<typeof dropCardBackdropSafeBox>,
  bounds: DropCardBackdropBounds,
): { x: number; y: number } | null {
  const minX = DROP_CARD_BACKDROP_EDGE_GAP_PX + safeBox.halfWidth;
  const minY = DROP_CARD_BACKDROP_EDGE_GAP_PX + safeBox.halfHeight;
  const maxX = bounds.viewportWidth - DROP_CARD_BACKDROP_EDGE_GAP_PX - safeBox.halfWidth;
  const maxY = bounds.viewportHeight - DROP_CARD_BACKDROP_EDGE_GAP_PX - safeBox.halfHeight;

  if (maxX < minX || maxY < minY) return null;

  return {
    x: clampNumber(x, minX, maxX),
    y: clampNumber(y, minY, maxY),
  };
}

function backdropPlacementFromCenter(
  x: number,
  y: number,
  safeBox: ReturnType<typeof dropCardBackdropSafeBox>,
  bounds: DropCardBackdropBounds,
  occupiedRects: DropCardBackdropRect[],
): DropCardBackdropPlacement | null {
  const center = clampBackdropCenter(x, y, safeBox, bounds);
  if (!center) return null;

  const rect = dropCardBackdropRectFromCenter(center.x, center.y, safeBox);
  if (!backdropRectAllowed(rect, bounds, occupiedRects)) return null;

  return { x: center.x, y: center.y, rect };
}

function scanBackdropGridPlacement(
  x: number,
  y: number,
  safeBox: ReturnType<typeof dropCardBackdropSafeBox>,
  bounds: DropCardBackdropBounds,
  occupiedRects: DropCardBackdropRect[],
): DropCardBackdropPlacement | null {
  const minX = DROP_CARD_BACKDROP_EDGE_GAP_PX + safeBox.halfWidth;
  const minY = DROP_CARD_BACKDROP_EDGE_GAP_PX + safeBox.halfHeight;
  const maxX = bounds.viewportWidth - DROP_CARD_BACKDROP_EDGE_GAP_PX - safeBox.halfWidth;
  const maxY = bounds.viewportHeight - DROP_CARD_BACKDROP_EDGE_GAP_PX - safeBox.halfHeight;
  if (maxX < minX || maxY < minY) return null;

  const stepX = Math.max(24, safeBox.halfWidth * 1.1);
  const stepY = Math.max(24, safeBox.halfHeight * 1.1);
  const cols = Math.max(1, Math.floor((maxX - minX) / stepX) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / stepY) + 1);
  let best: DropCardBackdropPlacement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let row = 0; row < rows; row += 1) {
    const candidateY = rows === 1 ? (minY + maxY) / 2 : minY + ((maxY - minY) * row) / (rows - 1);
    for (let col = 0; col < cols; col += 1) {
      const candidateX = cols === 1 ? (minX + maxX) / 2 : minX + ((maxX - minX) * col) / (cols - 1);
      const rect = dropCardBackdropRectFromCenter(candidateX, candidateY, safeBox);
      if (!backdropRectAllowed(rect, bounds, occupiedRects)) continue;

      const distanceScore = Math.abs(candidateX - x) + Math.abs(candidateY - y);
      if (distanceScore < bestScore) {
        best = { x: candidateX, y: candidateY, rect };
        bestScore = distanceScore;
      }
    }
  }

  return best;
}

function repositionBackdropPlacement(
  item: DropCardBackdropItem,
  index: number,
  x: number,
  y: number,
  bounds: DropCardBackdropBounds,
  occupiedRects: DropCardBackdropRect[],
): DropCardBackdropPlacement | null {
  const safeBox = dropCardBackdropSafeBox(item, bounds);
  const initial = backdropPlacementFromCenter(x, y, safeBox, bounds, occupiedRects);
  if (initial) return initial;

  const baseAngle = seededBackdropRandom(item.id + index * 97) * Math.PI * 2;
  const radiusStep = Math.max(24, Math.min(safeBox.halfWidth, safeBox.halfHeight) * 0.8);

  for (let step = 1; step <= DROP_CARD_BACKDROP_REPOSITION_STEPS; step += 1) {
    const radius = step * radiusStep;
    for (let candidate = 0; candidate < DROP_CARD_BACKDROP_REPOSITION_CANDIDATES; candidate += 1) {
      const angle = baseAngle + (candidate / DROP_CARD_BACKDROP_REPOSITION_CANDIDATES) * Math.PI * 2;
      const placed = backdropPlacementFromCenter(
        x + Math.cos(angle) * radius,
        y + Math.sin(angle) * radius,
        safeBox,
        bounds,
        occupiedRects,
      );
      if (placed) return placed;
    }
  }

  return scanBackdropGridPlacement(x, y, safeBox, bounds, occupiedRects);
}

function createDropCardBackdropPlacements(
  items: DropCardBackdropItem[],
  bounds: DropCardBackdropBounds,
): DropCardBackdropRenderItem[] {
  const occupiedRects: DropCardBackdropRect[] = [];
  const orderedItems = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.size - a.item.size || a.index - b.index);
  const placedItems: DropCardBackdropRenderItem[] = [];

  orderedItems.forEach(({ item, index }) => {
    const x = (item.x / 100) * bounds.viewportWidth;
    const y = (item.y / 100) * bounds.viewportHeight;
    const placement = repositionBackdropPlacement(item, index, x, y, bounds, occupiedRects);
    if (!placement) return;

    occupiedRects.push(placement.rect);
    placedItems.push({ item, index, placement });
  });

  return placedItems.sort((a, b) => a.index - b.index);
}

function DropCardsBackdrop({ items }: { items: DropCardBackdropItem[] }) {
  const [bounds, setBounds] = useState<DropCardBackdropBounds | null>(null);
  const placedItems = useMemo(
    () => (bounds ? createDropCardBackdropPlacements(items, bounds) : []),
    [bounds, items],
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let frame = 0;
    const update = () => {
      frame = 0;
      const next = measureDropCardBackdropBounds();
      setBounds((prev) => (boundsEqual(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    frame = window.requestAnimationFrame(update);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [items]);

  return (
    <div className="drop-cards-backdrop" aria-hidden="true">
      {placedItems.map(({ item, index, placement }) => {
        return (
          <img
            key={`${item.id}-${index}`}
            className="drop-cards-backdrop__card"
            src={item.src}
            alt=""
            draggable={false}
            decoding="async"
            style={
              {
                '--drop-card-x': `${placement.x}px`,
                '--drop-card-y': `${placement.y}px`,
                '--drop-card-size': `${item.size}vmin`,
                '--drop-card-opacity': item.opacity,
                '--drop-card-rotate': `${item.rotate}deg`,
                '--drop-card-blur': `${item.blur}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

const STRIPE_CHECKOUT_HISTORY_POLL_INTERVAL_MS = 3_000;
const STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS = 2 * 60_000;
const STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT = 100;
const STRIPE_UNIT_AMOUNT_CENTS_MIN = 50;
const STRIPE_UNIT_AMOUNT_CENTS_MAX = 99_999_999;
const OVERLAY_BLOCKED_EVENTS = ['touchmove', 'gesturestart', 'gesturechange', 'gestureend', 'wheel'] as const;
const OVERLAY_ZOOM_SHORTCUT_KEYS = new Set(['+', '=', '-', '_', '0']);

function anonymousStripeDeliveryHistoryQueryKey(firebaseUid: string | null, markerKey: string) {
  return ['anonymousStripeDeliveryHistory', firebaseUid, markerKey] as const;
}

function stripeCheckoutModeForDrop(drop: FrontendDeploymentConfig | null | undefined): StripePaymentMode | null {
  if (!drop?.stripeCheckoutEnabled) return null;
  const { solanaCluster } = drop;
  if (solanaCluster === 'devnet') return 'test';
  if (solanaCluster === 'mainnet-beta') return 'live';
  return null;
}

function normalizeStripeUnitAmountCents(value: unknown): number | null {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < STRIPE_UNIT_AMOUNT_CENTS_MIN || parsed > STRIPE_UNIT_AMOUNT_CENTS_MAX) return null;
  return parsed;
}

function stripeTestUnitAmountCents(): number {
  const configuredAmountCents =
    import.meta.env.STRIPE_TEST_UNIT_AMOUNT_CENTS ?? import.meta.env.VITE_STRIPE_TEST_UNIT_AMOUNT_CENTS;
  return (
    normalizeStripeUnitAmountCents(configuredAmountCents) ||
    STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT
  );
}

function stripeCheckoutPriceLabelForDrop(
  drop: FrontendDeploymentConfig | null | undefined,
  mode: StripePaymentMode | null,
): string | undefined {
  if (!drop || !mode) return undefined;
  const unitAmountCents =
    mode === 'test'
      ? stripeTestUnitAmountCents()
      : normalizeStripeUnitAmountCents(drop.stripeLiveUnitAmountCents);
  if (unitAmountCents == null) return undefined;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(unitAmountCents / 100);
}

function consumeStripeCheckoutReturnFromUrl(): StripeCheckoutReturn | null {
  if (typeof window === 'undefined') return null;
  const parsed = new URL(window.location.href);
  const status = parsed.searchParams.get('stripe_checkout');
  if (status !== 'success' && status !== 'cancel') return null;

  const sessionId = parsed.searchParams.get('session_id')?.trim() || '';
  parsed.searchParams.delete('stripe_checkout');
  parsed.searchParams.delete('session_id');
  window.history.replaceState(window.history.state, '', `${parsed.pathname}${parsed.search}${parsed.hash}`);

  if (status === 'success' && !sessionId) return { status: 'unverified_success' };
  if (status === 'success') return { status, sessionId };
  return { status };
}

function pickRandomSoundUrl(soundUrls: readonly string[]) {
  return soundUrls[Math.floor(Math.random() * soundUrls.length)] || soundUrls[0]!;
}

function moveLittleSwagBoxesFamilyToEnd<T extends { dropId?: string }>(items: readonly T[]): T[] {
  const leading: T[] = [];
  const trailing: T[] = [];
  const littleSwagFamilyByDropId = new Map<string, boolean>();
  items.forEach((item) => {
    const dropId = item.dropId || '';
    let isLittleSwagFamily = littleSwagFamilyByDropId.get(dropId);
    if (typeof isLittleSwagFamily !== 'boolean') {
      isLittleSwagFamily = isDropFamily(dropId, 'little_swag_boxes');
      littleSwagFamilyByDropId.set(dropId, isLittleSwagFamily);
    }
    if (isLittleSwagFamily) trailing.push(item);
    else leading.push(item);
  });
  return trailing.length ? [...leading, ...trailing] : [...leading];
}

function hiddenInventoryKey(wallet?: string) {
  return wallet ? `monsHiddenAssets:${wallet}` : 'monsHiddenAssets:disconnected';
}

function loadHiddenAssets(wallet?: string): Set<string> {
  if (typeof window === 'undefined' || !wallet) return new Set();
  try {
    const raw = window.localStorage?.getItem(hiddenInventoryKey(wallet));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === 'string' && v));
  } catch {
    return new Set();
  }
}

function persistHiddenAssets(wallet: string, ids: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(hiddenInventoryKey(wallet), JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage failures
  }
}

function pendingRevealKey(wallet?: string) {
  return wallet ? `monsPendingReveals:${wallet}` : 'monsPendingReveals:disconnected';
}

function loadPendingReveals(wallet?: string): LocalPendingReveal[] {
  if (typeof window === 'undefined' || !wallet) return [];
  try {
    const raw = window.localStorage?.getItem(pendingRevealKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: LocalPendingReveal[] = [];
    parsed.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const id = typeof entry.id === 'string' ? entry.id : '';
      const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : 0;
      if (!id || !createdAt) return;
      const dropId = typeof entry.dropId === 'string' ? entry.dropId : undefined;
      const name = typeof entry.name === 'string' ? entry.name : undefined;
      const image = typeof entry.image === 'string' ? entry.image : undefined;
      entries.push({ id, createdAt, dropId, name, image });
    });
    return entries;
  } catch {
    return [];
  }
}

function persistPendingReveals(wallet: string, entries: LocalPendingReveal[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(pendingRevealKey(wallet), JSON.stringify(entries));
  } catch {
    // ignore storage failures
  }
}

function recentRevealKey(wallet?: string) {
  return wallet ? `monsRecentReveals:${wallet}` : 'monsRecentReveals:disconnected';
}

function loadRecentReveals(wallet?: string): string[] {
  if (typeof window === 'undefined' || !wallet) return [];
  try {
    const raw = window.localStorage?.getItem(recentRevealKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id);
  } catch {
    return [];
  }
}

function persistRecentReveals(wallet: string, ids: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(recentRevealKey(wallet), JSON.stringify(ids));
  } catch {
    // ignore storage failures
  }
}

const DISCOUNT_USED_STORAGE_PREFIX = 'monsDiscountUsed';
function discountUsedVersion(
  drop: Pick<FrontendDeploymentConfig, 'dropId' | 'boxMinterProgramId' | 'discountMerkleRoot' | 'discountMintsPerWallet'>,
): string {
  return `${String(drop.dropId || '').trim().toLowerCase()}:${drop.boxMinterProgramId}:${drop.discountMerkleRoot}:${drop.discountMintsPerWallet}`;
}

function discountUsedScope(drop: Pick<FrontendDeploymentConfig, 'dropId'>): string {
  return `${DISCOUNT_USED_STORAGE_PREFIX}:${String(drop.dropId || '').trim().toLowerCase()}`;
}

function discountUsedKey(version: string, wallet?: string) {
  return wallet
    ? `${DISCOUNT_USED_STORAGE_PREFIX}:${version}:${wallet}`
    : `${DISCOUNT_USED_STORAGE_PREFIX}:${version}:disconnected`;
}

function cleanupDiscountUsedKeys(scopePrefix: string, wallet: string, keepKey: string) {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    const walletSuffix = `:${wallet}`;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(`${scopePrefix}:`)) continue;
      if (!key.endsWith(walletSuffix)) continue;
      if (key !== keepKey) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.localStorage?.removeItem(key));
  } catch {
    // ignore storage failures
  }
}

function parseDiscountUsedCount(raw: string | null | undefined): number {
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1) return 0;
  return parsed;
}

function loadDiscountUsedCount(scopePrefix: string, version: string, wallet?: string): number {
  if (typeof window === 'undefined' || !wallet) return 0;
  const key = discountUsedKey(version, wallet);
  cleanupDiscountUsedKeys(scopePrefix, wallet, key);
  try {
    return parseDiscountUsedCount(window.localStorage?.getItem(key));
  } catch {
    return 0;
  }
}

function persistDiscountUsedCount(scopePrefix: string, version: string, wallet: string, usedCount: number) {
  if (typeof window === 'undefined') return;
  const key = discountUsedKey(version, wallet);
  cleanupDiscountUsedKeys(scopePrefix, wallet, key);
  try {
    if (usedCount > 0) {
      window.localStorage?.setItem(key, String(usedCount));
    } else {
      window.localStorage?.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}

function formatOrderStatus(status: string): string {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatOrderDate(order: DeliveryOrderSummary): string {
  const timestamp = order.processedAt ?? order.processingAt ?? order.createdAt;
  if (!timestamp) return 'Date pending';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

function displayOrderStatus(order: DeliveryOrderSummary): string {
  const fulfillmentStatus = typeof order.fulfillmentStatus === 'string' ? order.fulfillmentStatus.trim() : '';
  if (fulfillmentStatus) return fulfillmentStatus;
  return formatOrderStatus(order.status === 'ready_to_ship' ? 'Preparing' : order.status);
}

function normalizeClaimedReceiptIds(ids: number[] | undefined): number[] {
  if (!Array.isArray(ids)) return [];
  const normalized = new Set<number>();
  ids.forEach((id) => {
    const figureId = Math.floor(Number(id));
    if (Number.isFinite(figureId) && figureId > 0) normalized.add(figureId);
  });
  return Array.from(normalized);
}

function findFirstNewClaimedReceipt(
  items: readonly InventoryItem[],
  dropId: string,
  previousReceiptIds: ReadonlySet<string>,
  burnedReceiptId?: string,
): InventoryItem | undefined {
  for (const item of items) {
    if (item.kind !== 'certificate' || item.dropId !== dropId) continue;
    if (item.id !== burnedReceiptId && !previousReceiptIds.has(item.id)) {
      return item;
    }
  }
  return undefined;
}

function findClaimedReceiptsByFigureId(items: readonly InventoryItem[], dropId: string): Map<number, InventoryItem> {
  const receiptByFigureId = new Map<number, InventoryItem>();
  items.forEach((item) => {
    if (item.kind !== 'certificate' || item.dropId !== dropId) return;
    if (typeof item.dudeId === 'number' && !receiptByFigureId.has(item.dudeId)) {
      receiptByFigureId.set(item.dudeId, item);
    }
  });
  return receiptByFigureId;
}

function buildClaimedReceiptPreviewItems(
  snapshot: readonly InventoryItem[],
  dropId: string,
  claimedFigureIds: readonly number[],
  previousReceiptIds: ReadonlySet<string>,
  burnedReceiptId?: string,
  fallbackImages?: ReadonlyMap<number, string>,
): ReceiptViewerSource[] {
  if (!claimedFigureIds.length) {
    const item = findFirstNewClaimedReceipt(snapshot, dropId, previousReceiptIds, burnedReceiptId);
    return item ? [{ id: item.id, dropId: item.dropId, name: item.name, image: item.image }] : [];
  }

  const receiptByFigureId = findClaimedReceiptsByFigureId(snapshot, dropId);
  return claimedFigureIds.map((figureId) => {
    const item = receiptByFigureId.get(figureId);
    const fallbackImage = fallbackImages?.get(figureId);
    if (item) {
      return {
        id: item.id,
        dropId: item.dropId,
        name: item.name,
        image: item.image || fallbackImage,
      };
    }
    return {
      id: `claimed-receipt-${dropId}-${figureId}`,
      dropId,
      name: dropAssetReference(getFrontendDrop(dropId), 'figure', figureId),
      image: fallbackImage,
    };
  });
}

async function loadClaimedReceiptImage(dropId: string, figureId: number): Promise<string | undefined> {
  const drop = getFrontendDrop(dropId);
  if (!drop) return undefined;
  const metadataUrl = resolveDropAssetUrl(`${drop.paths.receiptsFiguresJsonBase}${figureId}.json`);
  if (!metadataUrl) return undefined;
  try {
    const resp = await fetch(metadataUrl);
    if (!resp.ok) return undefined;
    const metadata = (await resp.json()) as { image?: unknown };
    return normalizeCertificateDisplayImage(dropId, typeof metadata.image === 'string' ? metadata.image : undefined);
  } catch {
    return undefined;
  }
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

  return (
    <img
      src={activeSrc}
      alt={alt}
      loading="lazy"
      className="figure-image"
      draggable={false}
      onDragStart={(evt) => evt.preventDefault()}
      onError={handleError}
    />
  );
}

const MAX_SHIPMENT_ITEMS = 24;
const EMPTY_INVENTORY: InventoryItem[] = [];
const EMPTY_PENDING_OPEN: PendingOpenBox[] = [];
const REVEAL_NOTE_OFFSET = 28;
// Keep locally-inserted pending reveals visible for a short grace window while on-chain indexing catches up.
const LOCAL_PENDING_GRACE_MS = 2 * 60 * 1000;
const RECENT_REVEALS_LIMIT = 10;
const FIGURE_METADATA_RETRY_MS = 3000;
const DEFAULT_BOX_SOUND_REVEAL_URL = 'https://assets.mons.link/sounds/shop/unbox1p.mp3';
const DEFAULT_BOX_SOUND_CLICK_URL = 'https://assets.mons.link/sounds/shop/click.mp3';
const ADMIN_OWNER_DOC_PAGE_SIZE = 200;
const ADMIN_VIEWER_READ_ONLY_MESSAGE = 'Admin viewer mode is read-only.';

type OverlayRect = { left: number; top: number; width: number; height: number };

type RevealOverlayPhase = 'preparing' | 'ready' | 'revealed';
type ImageViewerSize = 'receipt' | 'shipment' | 'shipment-figure';

type LocalPendingReveal = {
  id: string;
  createdAt: number;
  dropId?: string;
  name?: string;
  image?: string;
};

type LocalMintedBox = {
  id: string;
  dropId: string;
  createdAt: number;
  expectedChainCount?: number;
};

function mergeDeliveryRecoveryRequest(
  current: RecoverDeliveryOrdersArgs | null,
  next: RecoverDeliveryOrdersArgs,
): RecoverDeliveryOrdersArgs {
  const merged: RecoverDeliveryOrdersArgs = { ...(current ?? {}) };
  if (next.dropId) merged.dropId = next.dropId;
  if (next.deliveryId != null) merged.deliveryId = next.deliveryId;
  if (current?.force || next.force) merged.force = true;
  return merged;
}

function deliveryRecoveryNextCheckAtFromResult(result: RecoverDeliveryOrdersResult): number | null {
  return typeof result.nextCheckAt === 'number' && Number.isFinite(result.nextCheckAt) ? result.nextCheckAt : null;
}

function earliestDeliveryRecoveryCheckAt(...values: Array<number | null | undefined>): number | null {
  let earliest: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (earliest == null || value < earliest) earliest = value;
  }
  return earliest;
}

type RevealOverlayState = {
  id: string;
  dropId: string;
  name: string;
  image?: string;
  originRect: OverlayRect;
  targetRect: OverlayRect;
  phase: RevealOverlayPhase;
  frame: number;
  advanceClicks: number;
  revealedIds?: number[];
  viewerMode?: 'poncho-card' | 'receipt-image';
  imageViewerSize?: ImageViewerSize;
  receiptImages?: ReceiptViewerImage[];
  viewerFigureId?: number;
  hasRevealAttempted?: boolean;
  autoOpening?: boolean;
  autoMode?: 'normal' | 'fast';
};

type ReceiptImageViewerOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  images?: readonly ReceiptViewerImage[];
  imageSrc?: string;
  alt: string;
  viewerSize?: ImageViewerSize;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
};

function ReceiptImageViewerOverlay({
  overlayStyle,
  active,
  closing,
  images,
  imageSrc,
  alt,
  viewerSize = 'receipt',
  onDismiss,
  onTransitionEnd,
}: ReceiptImageViewerOverlayProps) {
  const receiptImages = images?.length ? images : [{ key: 'receipt-image', name: alt, image: imageSrc }];
  const multiReceiptClass = receiptImages.length > 1 ? ' receipt-viewer-overlay__image-shell--multi' : '';
  const imageShellStyle: ReceiptViewerImageShellStyle | undefined =
    receiptImages.length > 1
      ? { '--receipt-viewer-count': String(receiptImages.length) }
      : undefined;

  return (
    <div
      className={`reveal-overlay receipt-viewer-overlay receipt-viewer-overlay--${viewerSize} reveal-overlay--revealed${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={onDismiss}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className={`receipt-viewer-overlay__image-shell${multiReceiptClass}`} style={imageShellStyle}>
          {receiptImages.map((receiptImage, index) => (
            <div className="receipt-viewer-overlay__image-frame" key={`${receiptImage.key}:${index}`}>
              {receiptImage.image ? (
                <>
                  <img
                    src={receiptImage.image}
                    alt={receiptImage.name || alt}
                    className="receipt-viewer-overlay__image"
                    draggable={false}
                    onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
                    onError={(evt) => hideImageShowFallback(evt.currentTarget)}
                  />
                  <div className="receipt-viewer-overlay__image receipt-viewer-overlay__image--placeholder" hidden aria-hidden="true" />
                </>
              ) : (
                <div className="receipt-viewer-overlay__image receipt-viewer-overlay__image--placeholder" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function toOverlayRect(rect: DOMRect): OverlayRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function calcAspectLockedViewerOriginRect(
  originRect: DOMRect,
  targetRect: Readonly<{ width: number; height: number }>,
): DOMRect {
  const safeSourceHeight = Math.max(1, originRect.height);
  const safeTargetWidth = Math.max(1, targetRect.width);
  const safeTargetHeight = Math.max(1, targetRect.height);
  const aspectRatio = safeTargetWidth / safeTargetHeight;
  const width = Math.max(1, safeSourceHeight * aspectRatio);
  return new DOMRect(
    originRect.left + (originRect.width - width) / 2,
    originRect.top,
    width,
    safeSourceHeight,
  );
}

function calcRevealTargetRect(viewportWidth: number, viewportHeight: number, aspectRatio: number): OverlayRect {
  const maxWidth = viewportWidth * 0.65;
  const maxHeight = viewportHeight * 0.43;
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * safeAspectRatio)));
  const height = Math.max(1, Math.floor(width / safeAspectRatio));
  const lift = Math.round(height * 0.42);
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.max(16, Math.round((viewportHeight - height) / 2) - lift),
    width,
    height,
  };
}

function calcReceiptViewerTargetRect(
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
  size: ImageViewerSize = 'receipt',
): OverlayRect {
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const maxWidth =
    size === 'shipment-figure'
      ? Math.min(viewportWidth * 0.86, 760)
      : size === 'shipment'
        ? Math.min(viewportWidth * 0.82, 640)
        : Math.min(viewportWidth * 0.84, 620);
  const maxHeight =
    size === 'shipment-figure'
      ? Math.min(viewportHeight * 0.72, 660)
      : size === 'shipment'
        ? Math.min(viewportHeight * 0.72, 640)
        : Math.min(viewportHeight * 0.78, 760);
  let width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * safeAspectRatio)));
  let height = Math.max(1, Math.floor(width / safeAspectRatio));
  if (height > maxHeight) {
    height = Math.max(1, Math.floor(maxHeight));
    width = Math.max(1, Math.floor(height * safeAspectRatio));
  }
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.max(16, Math.round((viewportHeight - height) / 2)),
    width,
    height,
  };
}

function getOverlayViewport(): OverlayViewport {
  if (typeof window === 'undefined') return { left: 0, top: 0, width: 1, height: 1 };
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return {
      left: 0,
      top: 0,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    };
  }
  return {
    left: Number.isFinite(visualViewport.offsetLeft) ? visualViewport.offsetLeft : 0,
    top: Number.isFinite(visualViewport.offsetTop) ? visualViewport.offsetTop : 0,
    width: Math.max(1, visualViewport.width),
    height: Math.max(1, visualViewport.height),
  };
}

function offsetOverlayRectForViewport(rect: OverlayRect, viewport: OverlayViewport): OverlayRect {
  return {
    ...rect,
    left: Math.round(rect.left + viewport.left),
    top: Math.round(rect.top + viewport.top),
  };
}

function calcPonchoDrifellaRevealTargetRectInViewport(viewport = getOverlayViewport()): OverlayRect {
  return offsetOverlayRectForViewport(
    calcPonchoDrifellaRevealTargetRect(viewport.width, viewport.height),
    viewport,
  );
}

function calcReceiptViewerTargetRectInViewport(
  aspectRatio: number,
  size: ImageViewerSize = 'receipt',
  viewport = getOverlayViewport(),
): OverlayRect {
  return offsetOverlayRectForViewport(
    calcReceiptViewerTargetRect(viewport.width, viewport.height, aspectRatio, size),
    viewport,
  );
}

function calcRevealTargetRectForDropInViewport(
  dropId: string | undefined,
  aspectRatio: number,
  viewport = getOverlayViewport(),
): OverlayRect {
  return offsetOverlayRectForViewport(
    calcRevealTargetRectForDrop(viewport.width, viewport.height, dropId, aspectRatio),
    viewport,
  );
}

function getRenderedImagePreview(root: HTMLElement, fallback?: string): { src?: string; aspectRatio?: number } {
  const image = root.querySelector<HTMLImageElement>('img.figure-image:not([hidden])');
  const src = String(image?.currentSrc || image?.src || '').trim();
  const naturalAspectRatio =
    image && image.naturalWidth > 0 && image.naturalHeight > 0
      ? image.naturalWidth / image.naturalHeight
      : undefined;
  return { src: src || fallback, aspectRatio: naturalAspectRatio };
}

function calcRevealTargetRectForDrop(
  viewportWidth: number,
  viewportHeight: number,
  dropId: string | undefined,
  aspectRatio: number,
): OverlayRect {
  if (isDropFamily(dropId, 'poncho_drifella')) {
    return calcPonchoDrifellaRevealTargetRect(viewportWidth, viewportHeight);
  }
  return calcRevealTargetRect(viewportWidth, viewportHeight, aspectRatio);
}

function formatRevealIds(ids?: number[]) {
  if (!ids || !ids.length) return 'Figures: none';
  return '';
}

function getPrefersDarkColorScheme(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_COLOR_SCHEME_QUERY).matches;
}

function usePrefersDarkColorScheme(): boolean {
  const [prefersDark, setPrefersDark] = useState(getPrefersDarkColorScheme);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia(DARK_COLOR_SCHEME_QUERY);
    const update = () => setPrefersDark(mediaQuery.matches);
    update();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', update);
      return () => mediaQuery.removeEventListener('change', update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return prefersDark;
}

function resolveMintPreviewMedia(
  media: MintPanelBoxMedia,
  usesCardNft2Video: boolean,
  cardNft2PackVideoSources: MintPanelBoxMedia['videoSources'],
  cardNft2PackVideoPosterSrc: string,
): MintPanelBoxMedia {
  if (!usesCardNft2Video) return media;

  return {
    ...media,
    imageSrc: media.imageSrc || CARD_NFT_2_PACK_PREVIEW_IMAGE_URL,
    videoSources: cardNft2PackVideoSources,
    videoPosterSrc: cardNft2PackVideoPosterSrc,
    mediaScale: CARD_NFT_2_PACK_VIDEO_SCALE,
    compactMediaScale: CARD_NFT_2_PACK_COMPACT_VIDEO_SCALE,
    aspectRatio: CARD_NFT_2_PACK_VIDEO_ASPECT_RATIO,
  };
}

function errorMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  const anyErr = err as { message?: unknown; error?: unknown };
  if (typeof anyErr.message === 'string') return anyErr.message;
  if (typeof anyErr.error === 'string') return anyErr.error;
  if (typeof (anyErr.error as { message?: unknown })?.message === 'string') {
    return (anyErr.error as { message: string }).message;
  }
  return '';
}

function isUserRejectedError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: unknown; name?: unknown; cause?: unknown };
  if (anyErr.cause && isUserRejectedError(anyErr.cause)) return true;
  const code = anyErr.code;
  if (code === 4001 || code === 'ACTION_REJECTED' || code === 'USER_REJECTED' || code === 'Rejected') {
    return true;
  }
  const name = typeof anyErr.name === 'string' ? anyErr.name : '';
  if (/wallet.*rejected/i.test(name)) return true;
  const message = errorMessage(err).toLowerCase();
  if (!message) return false;
  return (
    message.includes('user rejected') ||
    message.includes('rejected the request') ||
    message.includes('rejected the transaction') ||
    message.includes('user denied') ||
    message === 'canceled' ||
    message === 'cancelled' ||
    message.includes('request was rejected') ||
    message.includes('transaction was rejected')
  );
}

function pendingRevealListEqual(left: LocalPendingReveal[], right: LocalPendingReveal[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (a.createdAt !== b.createdAt) return false;
    if ((a.dropId || '') !== (b.dropId || '')) return false;
    if ((a.name || '') !== (b.name || '')) return false;
    if ((a.image || '') !== (b.image || '')) return false;
  }
  return true;
}

type SendViaConnectionOptions = {
  onAlreadyProcessedWithoutSignature?: (err: unknown) => Promise<boolean>;
};

async function recoverConnectionSendError(
  tx: VersionedTransaction | null,
  targetConnection: Connection,
  err: unknown,
  options?: SendViaConnectionOptions,
): Promise<string | null> {
  const recoveredSignature = await recoverAlreadyProcessedSignature(tx, targetConnection, err);
  if (recoveredSignature) return recoveredSignature;
  if (options?.onAlreadyProcessedWithoutSignature) {
    const recovered = await options.onAlreadyProcessedWithoutSignature(err);
    if (recovered) return null;
  }
  throw err;
}

type AppProps = {
  currentPath?: string;
};

function App({ currentPath }: AppProps) {
  const wallet = useWallet();
  const { visible: walletModalVisible, setVisible } = useWalletModal();
  const { publicKey, sendTransaction } = wallet;
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const cardNft2PackVideoSources = prefersDarkColorScheme
    ? CARD_NFT_2_PACK_DARK_VIDEO_SOURCES
    : CARD_NFT_2_PACK_LIGHT_VIDEO_SOURCES;
  const cardNft2PackVideoPosterSrc = prefersDarkColorScheme
    ? CARD_NFT_2_PACK_DARK_VIDEO_POSTER_URL
    : CARD_NFT_2_PACK_LIGHT_VIDEO_POSTER_URL;
  const normalizedCurrentPath = useMemo(
    () => (currentPath ? currentPath : getNormalizedPathname()),
    [currentPath],
  );
  const routeDrop = useMemo(() => resolveFrontendDropByPath(normalizedCurrentPath), [normalizedCurrentPath]);
  const upcomingDropRoute = useMemo(
    () => (routeDrop ? null : resolveUpcomingDropRouteByPath(normalizedCurrentPath)),
    [normalizedCurrentPath, routeDrop],
  );
  const [notifyOverlayOpen, setNotifyOverlayOpen] = useState(false);
  useEffect(() => {
    if (!upcomingDropRoute) setNotifyOverlayOpen(false);
  }, [upcomingDropRoute]);
  const allDrops = useMemo(() => listFrontendDrops(), []);
  const adminMenuDrops = useMemo(
    () => allDrops.filter((drop) => !['little_swag_boxes', 'poncho_drifella'].includes(drop.dropId)),
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
      const created = new Connection(rpcEndpointForCluster(drop.solanaCluster), { commitment: 'confirmed' });
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
    (dropId?: string, count = 1, options?: { capitalize?: boolean }) =>
      dropAssetLabel(getDropConfig(dropId), 'box', count, options),
    [getDropConfig],
  );
  const figureLabelForDropId = useCallback(
    (dropId?: string, count = 1, options?: { capitalize?: boolean }) =>
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
  const adminMenuLabel = (value: string) => value.replace(/^\/+/, '');
  const openActionLabelForDropId = useCallback((dropId?: string) => dropOpenActionLabel(getDropConfig(dropId)), [getDropConfig]);
  const openActionProgressForDropId = useCallback(
    (dropId?: string) => dropOpenActionProgress(getDropConfig(dropId)),
    [getDropConfig],
  );
  const openVerbForDropId = useCallback((dropId?: string) => dropOpenVerb(getDropConfig(dropId)), [getDropConfig]);
  const openGerundForDropId = useCallback((dropId?: string) => dropOpenGerund(getDropConfig(dropId)), [getDropConfig]);
  const canOpenBoxesForDropId = useCallback(
    (dropId?: string) => {
      const dropConfig = getDropConfig(dropId);
      if (isDropFamily(dropConfig, 'little_swag_hoodies')) return false;
      return !isDirectDeliveryItemsPerBox(dropConfig?.itemsPerBox);
    },
    [getDropConfig],
  );
  const dropRevealIsAnimated = useCallback(
    (dropId?: string) => {
      const content = getDropContent(dropId);
      return content.reveal.mode === 'animated' && Boolean(content.reveal.frameSequence);
    },
    [getDropContent],
  );
  const revealFrameCountForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameSequence?.frameCount || 1,
    [getDropContent],
  );
  const revealClickMaxForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameSequence?.clickMax || 1,
    [getDropContent],
  );
  const revealAutoplayStartForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameSequence?.autoplayStart || 1,
    [getDropContent],
  );
  const revealMediaStartForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.frameSequence?.mediaStart || 1,
    [getDropContent],
  );
  const revealRendererForDropId = useCallback(
    (dropId?: string) => getDropContent(dropId).reveal.renderer,
    [getDropContent],
  );
  const revealSoundUrlsForDropId = useCallback(
    (dropId?: string) => {
      const { sound } = getDropContent(dropId).reveal;
      if (revealRendererForDropId(dropId) === 'poncho_drifella') {
        return {
          click: PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
          reveal: PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
          clickVolume: sound.clickVolume,
          revealVolume: sound.revealVolume,
        };
      }
      return {
        click: [DEFAULT_BOX_SOUND_CLICK_URL],
        reveal: DEFAULT_BOX_SOUND_REVEAL_URL,
        clickVolume: sound.clickVolume,
        revealVolume: sound.revealVolume,
      };
    },
    [getDropContent, revealRendererForDropId],
  );
  const preloadPonchoRevealCardAssetsForDropId = useCallback(
    (dropId?: string, figureIds?: readonly number[]) => {
      if (revealRendererForDropId(dropId) !== 'poncho_drifella') return;
      if (!figureIds?.length) return;
      figureIds.forEach((figureId) => {
        preloadPonchoDrifellaCardAssets(
          getPonchoDrifellaCardByFigureId(figureId),
          ponchoImageCacheRef.current,
          { mode: 'warm', priority: 'low' },
        );
      });
    },
    [revealRendererForDropId],
  );
  const preloadPonchoRevealPackAssetsForDropId = useCallback(
    (dropId?: string) => {
      if (revealRendererForDropId(dropId) !== 'poncho_drifella') return;
      preloadPonchoDrifellaPackAssets(ponchoImageCacheRef.current, { mode: 'warm', priority: 'low' });
    },
    [revealRendererForDropId],
  );
  const routeConnection = useMemo(
    () => (routeDrop ? getDropConnection(routeDrop.dropId) : null),
    [getDropConnection, routeDrop],
  );
  const activeDiscountVersion = useMemo(
    () => (routeDrop ? discountUsedVersion(routeDrop) : 'none'),
    [routeDrop],
  );
  const activeDiscountScope = useMemo(
    () => (routeDrop ? discountUsedScope(routeDrop) : `${DISCOUNT_USED_STORAGE_PREFIX}:none`),
    [routeDrop],
  );
  const shouldFetchMintStats = Boolean(routeDrop && !routeDrop.forceSoldOut);
  const { data: mintStats, refetch: refetchStats } = useMintProgress(routeConnection, routeDrop, shouldFetchMintStats);
  const {
    profile,
    token,
    loading: authLoading,
    error: authError,
    signIn,
    updateProfile,
    refreshProfile,
  } = useSolanaAuth();
  const queryClient = useQueryClient();
  const connectedWallet = publicKey?.toBase58();
  const [adminViewedOwner, setAdminViewedOwner] = useState<string | null>(null);
  const isAdminWallet = Boolean(connectedWallet && ADMIN_WALLETS.has(connectedWallet));
  const isSignedInWallet = Boolean(token && connectedWallet && profile?.wallet === connectedWallet);
  const canUseAdminMenu = Boolean(isSignedInWallet && hasFulfillmentAppAccess(connectedWallet));
  const canUseAdminViewer = isAdminWallet && isSignedInWallet;
  const owner = canUseAdminViewer && adminViewedOwner ? adminViewedOwner : connectedWallet;
  const isViewerMode = Boolean(owner && connectedWallet && owner !== connectedWallet);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ownerPickerOpened, setOwnerPickerOpened] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const { data: inventoryData, refetch: refetchInventory, isFetched: inventoryFetched } = useInventory(owner, {
    includeDevnet: isAdminWallet,
  });
  const {
    data: pendingOpenBoxesData,
    refetch: refetchPendingOpenBoxes,
    isSuccess: pendingOpenBoxesSuccess,
  } = usePendingOpenBoxes(owner, { includeDevnet: isAdminWallet });

  const {
    data: deliveryOrderOwnersData,
    isFetchingNextPage: deliveryOrderOwnersLoadingMore,
    hasNextPage: deliveryOrderOwnersHasNextPage,
    fetchNextPage: fetchNextDeliveryOrderOwners,
    error: deliveryOrderOwnersError,
  } = useInfiniteQuery({
    queryKey: ['adminDeliveryOrderOwners', connectedWallet],
    enabled: Boolean(canUseAdminViewer && settingsOpen && ownerPickerOpened),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listDeliveryOrderOwners({
        cursor: typeof pageParam === 'string' && pageParam ? pageParam : undefined,
        pageSize: ADMIN_OWNER_DOC_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined),
    staleTime: 30_000,
  });
  const deliveryOrderOwners = useMemo(() => {
    const unique = new Set<string>();
    if (connectedWallet) unique.add(connectedWallet);
    const fromApi =
      deliveryOrderOwnersData?.pages?.flatMap((page) => (Array.isArray(page?.owners) ? page.owners : [])) || [];
    fromApi.forEach((entry) => {
      if (typeof entry === 'string' && entry) unique.add(entry);
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [connectedWallet, deliveryOrderOwnersData]);

  const {
    data: viewedProfileData,
    isFetching: viewedProfileLoading,
    error: viewedProfileError,
  } = useQuery({
    queryKey: ['viewedProfile', connectedWallet, owner, isSignedInWallet],
    enabled: Boolean(
      isSignedInWallet &&
        connectedWallet &&
        owner &&
        (owner === connectedWallet || canUseAdminViewer) &&
        (isViewerMode || !profile || profile.wallet !== owner),
    ),
    queryFn: () => getProfile(owner || undefined),
    staleTime: 10_000,
  });

  const viewedProfile = useMemo(() => {
    if (profile && profile.wallet === owner) return profile;
    return viewedProfileData?.profile || null;
  }, [owner, profile, viewedProfileData?.profile]);
  const currentOwnerDeliveryRecoveryNextCheckAt =
    typeof profile?.deliveryRecovery?.nextCheckAt === 'number' &&
    isSignedInWallet &&
    !isViewerMode &&
    profile?.wallet === connectedWallet
      ? profile.deliveryRecovery.nextCheckAt
      : null;

  const inventory = inventoryData ?? EMPTY_INVENTORY;
  const pendingOpenBoxes = pendingOpenBoxesData ?? EMPTY_PENDING_OPEN;
  const fallbackMintSelectionAvailability = useMemo(
    () => deriveMintSelectionAvailabilityFromConfig(routeDrop?.mintSelection),
    [routeDrop?.mintSelection],
  );
  const soldOutMintSelectionAvailability = useMemo(
    () =>
      fallbackMintSelectionAvailability
        ? Object.fromEntries(Object.keys(fallbackMintSelectionAvailability).map((key) => [key, 0]))
        : undefined,
    [fallbackMintSelectionAvailability],
  );
  const forcedSoldOutStats = useMemo(
    () => {
      if (!routeDrop) return undefined;
      return {
        minted: routeDrop.maxSupply,
        total: routeDrop.maxSupply,
        remaining: 0,
        maxPerTx: routeDrop.maxPerTx,
        ...(soldOutMintSelectionAvailability ? { mintSelectionAvailability: soldOutMintSelectionAvailability } : {}),
      };
    },
    [routeDrop, soldOutMintSelectionAvailability],
  );
  const activeMintStatsFallback = useMemo(
    () => {
      if (!routeDrop) return undefined;
      return {
        minted: 0,
        total: routeDrop.maxSupply,
        remaining: routeDrop.maxSupply,
        maxPerTx: routeDrop.maxPerTx,
        ...(fallbackMintSelectionAvailability ? { mintSelectionAvailability: fallbackMintSelectionAvailability } : {}),
      };
    },
    [routeDrop, fallbackMintSelectionAvailability],
  );
  const effectiveMintStats = routeDrop
    ? routeDrop.forceSoldOut
      ? forcedSoldOutStats
      : mintStats || activeMintStatsFallback
    : undefined;
  const activeDiscountAllowance = routeDrop ? mintStats?.discountMintsPerWallet ?? routeDrop.discountMintsPerWallet : 0;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState(false);
  const [discountMinting, setDiscountMinting] = useState(false);
  const [stripePaymentLoading, setStripePaymentLoading] = useState(false);
  // A confirmed mint should reset MintPanel controls immediately even if the
  // stats/inventory refresh that follows takes longer or fails.
  const [successfulMintToken, setSuccessfulMintToken] = useState(0);
  const [discountEligible, setDiscountEligible] = useState(false);
  const [discountRemainingCount, setDiscountRemainingCount] = useState(0);
  const [discountChecking, setDiscountChecking] = useState(false);
  const [startOpenLoading, setStartOpenLoading] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState<string | null>(null);
  const [revealOverlay, setRevealOverlay] = useState<RevealOverlayState | null>(null);
  const [revealOverlayActive, setRevealOverlayActive] = useState(false);
  const [revealOverlayClosing, setRevealOverlayClosing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastFadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealOverlayRafRef = useRef<number | null>(null);
  const revealOverlayResizeRafRef = useRef<number | null>(null);
  const authLoadingSeenRef = useRef(false);
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUid, setFirebaseUid] = useState<string | null>(() => auth?.currentUser?.uid || null);
  const [walletIdleReady, setWalletIdleReady] = useState(false);
  const [shipmentsReady, setShipmentsReady] = useState(false);
  const [pendingShipmentsSignIn, setPendingShipmentsSignIn] = useState(false);
  const [pendingHeaderWalletSignIn, setPendingHeaderWalletSignIn] = useState(false);
  const [headerWalletButtonRevealed, setHeaderWalletButtonRevealed] = useState(false);
  const [stripeCheckoutMarkers, setStripeCheckoutMarkers] = useState(() => loadStripeCheckoutMarkers());
  const [stripeCheckoutHistoryNow, setStripeCheckoutHistoryNow] = useState(() => Date.now());
  const anonymousStripeHistoryCompletion = useMemo(
    () => completedStripeCheckoutMarkerSummaryForFirebaseUid(firebaseUid, stripeCheckoutMarkers),
    [firebaseUid, stripeCheckoutMarkers],
  );
  const anonymousStripeHistoryMarkerKey = anonymousStripeHistoryCompletion.markerKey;
  const hasLocalCompletedStripeCheckout = Boolean(anonymousStripeHistoryMarkerKey);
  const anonymousStripeHistoryPollUntil = anonymousStripeHistoryCompletion.latestCompletedAt
    ? anonymousStripeHistoryCompletion.latestCompletedAt + STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS
    : 0;
  const anonymousStripeHistoryEnabled = !connectedWallet && hasLocalCompletedStripeCheckout;
  const anonymousStripeHistoryPollActive =
    anonymousStripeHistoryEnabled &&
    Boolean(anonymousStripeHistoryPollUntil && stripeCheckoutHistoryNow < anonymousStripeHistoryPollUntil);
  const {
    data: anonymousStripeHistoryData,
    isFetching: anonymousStripeHistoryLoading,
    error: anonymousStripeHistoryError,
  } = useQuery({
    queryKey: anonymousStripeDeliveryHistoryQueryKey(firebaseUid, anonymousStripeHistoryMarkerKey),
    enabled: anonymousStripeHistoryEnabled,
    queryFn: getAnonymousStripeDeliveryHistory,
    refetchInterval: (query) => {
      if (!anonymousStripeHistoryPollActive || !anonymousStripeHistoryPollUntil) return false;
      if (Date.now() >= anonymousStripeHistoryPollUntil) return false;
      if (query.state.error) return false;
      return STRIPE_CHECKOUT_HISTORY_POLL_INTERVAL_MS;
    },
    refetchOnReconnect: anonymousStripeHistoryPollActive,
    refetchOnWindowFocus: anonymousStripeHistoryPollActive,
    staleTime: 10_000,
  });
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryCountryCode, setDeliveryCountryCode] = useState('US');
  const [claimOpen, setClaimOpen] = useState(false);
  const [discountUsedCount, setDiscountUsedCount] = useState<number>(() =>
    loadDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet),
  );
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const [hiddenAssets, setHiddenAssets] = useState<Set<string>>(() => loadHiddenAssets(connectedWallet));
  const [localPendingReveals, setLocalPendingReveals] = useState<LocalPendingReveal[]>(() =>
    loadPendingReveals(connectedWallet),
  );
  const [recentRevealedBoxes, setRecentRevealedBoxes] = useState<string[]>(() => loadRecentReveals(connectedWallet));
  const [localMintedBoxes, setLocalMintedBoxes] = useState<LocalMintedBox[]>([]);
  const [inventorySnapshot, setInventorySnapshot] = useState<InventoryItem[]>([]);
  const [pendingOpenSnapshot, setPendingOpenSnapshot] = useState<PendingOpenBox[]>([]);
  const inventoryView = revealOverlay ? inventorySnapshot : inventory;
  const pendingOpenBoxesView = revealOverlay ? pendingOpenSnapshot : pendingOpenBoxes;
  const revealOverlayOpen = Boolean(revealOverlay);
  const [localRevealedDudeKeys, setLocalRevealedDudeKeys] = useState<string[]>([]);
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const figureMetadataRef = useRef<Record<string, FigureMetadataRecord>>({});
  const figureMetadataLoadingRef = useRef<Set<string>>(new Set());
  const figureMetadataRetryAtRef = useRef<Map<string, number>>(new Map());
  const authTokenRef = useRef<string | null>(null);
  const authTokenWalletRef = useRef<string | null>(null);
  const connectedWalletRef = useRef<string | null>(connectedWallet || null);
  const signInPromiseRef = useRef<Promise<boolean> | null>(null);
  const deliveryRecoveryPromiseRef = useRef<Promise<void> | null>(null);
  const deliveryRecoveryQueuedRef = useRef<RecoverDeliveryOrdersArgs | null>(null);
  const lastScheduledDeliveryRecoveryAtRef = useRef<number | null>(null);
  const authReadyRef = useRef(false);
  const authLoadingRef = useRef(false);
  const mintActionLockRef = useRef<null | 'mint' | 'discount'>(null);
  const openSelectedLockRef = useRef(false);
  const openSelectedBoxIdRef = useRef<string | null>(null);
  const previousConnectedWalletForOwnerRef = useRef(connectedWallet);
  const localMintCounterRef = useRef(0);
  const knownBoxIdsByDropRef = useRef<Map<string, Set<string>>>(new Map());
  const preloadedBoxFramesRef = useRef<Set<string>>(new Set());
  const boxFramePreloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const ponchoImageCacheRef = useRef(createPonchoDrifellaImageCache());
  const [ponchoRevealComplete, setPonchoRevealComplete] = useState(false);
  const [deliveryRecoveryOverrideNextCheckAt, setDeliveryRecoveryOverrideNextCheckAt] = useState<number | null>(null);
  const autoplayFramePreloadScheduledDropIdRef = useRef<string | null>(null);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const videoPreloadRootRef = useRef<HTMLDivElement | null>(null);
  const videoPreloadKeyRef = useRef<string>('');
  const deferredOverlayActionsRef = useRef<Array<() => void>>([]);
  const revealOverlayRef = useRef<RevealOverlayState | null>(null);
  const revealOverlaySessionRef = useRef(0);
  const revealLoadingRequestCounterRef = useRef(0);
  const revealLoadingRequestIdRef = useRef<number | null>(null);
  const revealDismissLockedUntilRef = useRef<number>(0);
  const ponchoPackDiscardDismissReadyRef = useRef(false);
  const revealOverlayActiveRef = useRef(false);
  const revealOverlayClosingRef = useRef(false);
  const revealOverlayCloseTimeoutRef = useRef<number | null>(null);
  const ponchoPackDiscardDismissTimeoutRef = useRef<number | null>(null);
  const stripeCheckoutReturnRef = useRef<StripeCheckoutReturn | null | undefined>(undefined);
  const stripeCheckoutCompletionHandledRef = useRef(false);
  const stripeCheckoutWalletRefreshStartedRef = useRef(false);
  const stripeCheckoutReturnWalletRefreshSessionRef = useRef<string | null>(null);

  const boxImageForDropId = useCallback(
    (dropId?: string): string | undefined => {
      const content = getDropContent(dropId);
      return content.box.previewImageUrl;
    },
    [getDropContent],
  );
  const boxAspectRatioForDropId = useCallback(
    (dropId?: string): number => {
      const content = getDropContent(dropId);
      return content.box.aspectRatio;
    },
    [getDropContent],
  );
  const revealFrameSequenceForDropId = useCallback(
    (dropId?: string) => {
      const content = getDropContent(dropId);
      return content.reveal.frameSequence;
    },
    [getDropContent],
  );
  const revealMediaBaseForDropId = useCallback(
    (dropId?: string): string | undefined => {
      const content = getDropContent(dropId);
      return content.figures.revealVideoBaseUrl;
    },
    [getDropContent],
  );
  const mintPreviewMedia = routeDrop
    ? resolveMintPreviewMedia(
        {
          imageSrc: mintPanelPreviewImage(routeDrop.dropId),
          aspectRatio: mintPanelPreviewAspectRatio(routeDrop.dropId),
        },
        isDropFamily(routeDrop, 'card_nft_2'),
        cardNft2PackVideoSources,
        cardNft2PackVideoPosterSrc,
      )
    : { aspectRatio: 1 };
  const routeStripePaymentMode = stripeCheckoutModeForDrop(routeDrop);
  const routeStripePaymentPriceLabel = stripeCheckoutPriceLabelForDrop(routeDrop, routeStripePaymentMode);
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
    cardNft2PackVideoPosterSrc,
  );
  const revealFrameSequence = revealFrameSequenceForDropId(revealOverlay?.dropId || routeDrop?.dropId);
  const revealMediaBase = revealMediaBaseForDropId(revealOverlay?.dropId || routeDrop?.dropId);

  const showToast = useCallback((message: string) => {
    setToast(message);
    setToastVisible(true);
    if (toastFadeTimeoutRef.current) {
      clearTimeout(toastFadeTimeoutRef.current);
    }
    if (toastClearTimeoutRef.current) {
      clearTimeout(toastClearTimeoutRef.current);
    }
    toastFadeTimeoutRef.current = setTimeout(() => {
      setToastVisible(false);
    }, TOAST_VISIBLE_MS);
    toastClearTimeoutRef.current = setTimeout(() => {
      setToast(null);
    }, TOAST_VISIBLE_MS + TOAST_FADE_MS);
  }, []);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUid(user?.uid || null);
    });
  }, []);

  useEffect(() => {
    setStripeCheckoutHistoryNow(Date.now());
    if (!anonymousStripeHistoryPollUntil) return;
    const remaining = anonymousStripeHistoryPollUntil - Date.now();
    if (remaining <= 0) return;
    const timeout = setTimeout(() => {
      setStripeCheckoutHistoryNow(Date.now());
    }, remaining);
    return () => {
      clearTimeout(timeout);
    };
  }, [anonymousStripeHistoryPollUntil]);

  useEffect(() => {
    if (stripeCheckoutReturnRef.current === undefined) {
      stripeCheckoutReturnRef.current = consumeStripeCheckoutReturnFromUrl();
    }
    const checkoutReturn = stripeCheckoutReturnRef.current;
    if (!checkoutReturn) return;
    if (checkoutReturn.status === 'success') {
      showToast('Stripe checkout completed.');
      return;
    }
    if (checkoutReturn.status === 'unverified_success') {
      showToast('Stripe checkout completed.');
      return;
    }
  }, [showToast]);

  useEffect(() => {
    if (stripeCheckoutCompletionHandledRef.current || !firebaseUid) return;
    const checkoutReturn = stripeCheckoutReturnRef.current;
    if (!checkoutReturn || checkoutReturn.status !== 'success') return;
    const result = completeStripeCheckoutMarker({
      sessionId: checkoutReturn.sessionId,
      firebaseUid,
      completedAt: Date.now(),
    });
    if (result.completed) {
      stripeCheckoutCompletionHandledRef.current = true;
      setStripeCheckoutMarkers(result.markers);
    }
  }, [firebaseUid]);

  useEffect(() => {
    stripeCheckoutWalletRefreshStartedRef.current = false;
  }, [anonymousStripeHistoryMarkerKey, connectedWallet]);

  useEffect(() => {
    if (stripeCheckoutWalletRefreshStartedRef.current || !connectedWallet || !isSignedInWallet) return;
    const checkoutReturn = stripeCheckoutReturnRef.current;
    const checkoutReturnSessionId = checkoutReturn?.status === 'success' ? checkoutReturn.sessionId : '';
    const hasCheckoutReturn =
      Boolean(checkoutReturnSessionId) &&
      stripeCheckoutReturnWalletRefreshSessionRef.current !== checkoutReturnSessionId;
    if (!hasCheckoutReturn && !hasLocalCompletedStripeCheckout) return;

    connectedWalletRef.current = connectedWallet;
    stripeCheckoutWalletRefreshStartedRef.current = true;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const completedMarkerKey = anonymousStripeHistoryMarkerKey;
    const completedMarkerFirebaseUid = firebaseUid;
    const stopAt = hasCheckoutReturn
      ? Date.now() + STRIPE_CHECKOUT_HISTORY_POLL_WINDOW_MS
      : anonymousStripeHistoryPollUntil && Date.now() < anonymousStripeHistoryPollUntil
        ? anonymousStripeHistoryPollUntil
        : Date.now();

    const refreshUntilSettled = () => {
      if (cancelled || connectedWalletRef.current !== connectedWallet) return;
      void refreshProfile({ mergeStripeDeliveryOrders: true })
        .then((refreshedProfile) => {
          if (!refreshedProfile || !completedMarkerFirebaseUid) return;
          const walletStripeSessionIds = (refreshedProfile.orders || [])
            .map((order) => order.stripeCheckoutSessionId || '')
            .filter(Boolean);
          const result = forgetCompletedStripeCheckoutMarkersForFirebaseUid({
            firebaseUid: completedMarkerFirebaseUid,
            sessionIds: walletStripeSessionIds,
          });
          if (!result.removed) return;
          setStripeCheckoutMarkers(result.markers);
          if (completedMarkerKey) {
            queryClient.removeQueries({
              queryKey: anonymousStripeDeliveryHistoryQueryKey(completedMarkerFirebaseUid, completedMarkerKey),
              exact: true,
            });
          }
        })
        .catch((err) => {
          console.warn('[mons] failed to refresh profile after Stripe checkout', err);
        })
        .finally(() => {
          if (cancelled || connectedWalletRef.current !== connectedWallet) return;
          if (hasCheckoutReturn) {
            stripeCheckoutReturnWalletRefreshSessionRef.current = checkoutReturnSessionId;
          }
          if (Date.now() + STRIPE_CHECKOUT_HISTORY_POLL_INTERVAL_MS > stopAt) return;
          timeout = setTimeout(refreshUntilSettled, STRIPE_CHECKOUT_HISTORY_POLL_INTERVAL_MS);
        });
    };

    refreshUntilSettled();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [
    anonymousStripeHistoryMarkerKey,
    anonymousStripeHistoryPollUntil,
    connectedWallet,
    firebaseUid,
    hasLocalCompletedStripeCheckout,
    isSignedInWallet,
    queryClient,
    refreshProfile,
  ]);

  const blockViewerModeAction = () => {
    if (!isViewerMode) return false;
    showToast(ADMIN_VIEWER_READ_ONLY_MESSAGE);
    return true;
  };

  useEffect(() => {
    if (!connectedWallet) {
      setAdminViewedOwner(null);
      setSettingsOpen(false);
      return;
    }
    if (adminViewedOwner === connectedWallet) {
      setAdminViewedOwner(null);
    }
  }, [adminViewedOwner, connectedWallet]);

  useEffect(() => {
    if (canUseAdminMenu) return;
    if (settingsOpen) setSettingsOpen(false);
  }, [canUseAdminMenu, settingsOpen]);

  useEffect(() => {
    if (canUseAdminViewer) return;
    if (adminViewedOwner) setAdminViewedOwner(null);
    if (ownerPickerOpened) setOwnerPickerOpened(false);
  }, [adminViewedOwner, canUseAdminViewer, ownerPickerOpened]);

  useEffect(() => {
    if (!settingsOpen) {
      setOwnerPickerOpened(false);
      return;
    }
    setOwnerPickerOpened(Boolean(adminViewedOwner && adminViewedOwner !== connectedWallet));
  }, [adminViewedOwner, connectedWallet, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (evt: MouseEvent) => {
      const root = settingsRef.current;
      if (!root) return;
      if (!root.contains(evt.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    connectedWalletRef.current = connectedWallet || null;
  }, [connectedWallet]);

  useEffect(() => {
    authTokenRef.current = null;
    authTokenWalletRef.current = null;
    signInPromiseRef.current = null;
    deliveryRecoveryQueuedRef.current = null;
    lastScheduledDeliveryRecoveryAtRef.current = null;
    setDeliveryRecoveryOverrideNextCheckAt(null);
  }, [connectedWallet]);

  useEffect(() => {
    authTokenRef.current = token;
    authTokenWalletRef.current = token && profile?.wallet ? profile.wallet : null;
  }, [token, profile?.wallet]);

  useEffect(() => {
    authReadyRef.current = authReady;
  }, [authReady]);

  useEffect(() => {
    authLoadingRef.current = authLoading;
  }, [authLoading]);

  const ensureSignedIn = async (): Promise<boolean> => {
    const hasWalletBoundToken =
      Boolean(connectedWallet) &&
      Boolean(authTokenRef.current) &&
      Boolean(authTokenWalletRef.current) &&
      authTokenWalletRef.current === connectedWallet;
    if (!publicKey) {
      setVisible(true);
      return false;
    }
    if (isSignedInWallet && token) {
      authTokenRef.current = token;
      authTokenWalletRef.current = connectedWallet || null;
      return true;
    }
    if (hasWalletBoundToken) return true;
    if (signInPromiseRef.current) return signInPromiseRef.current;

    // Wait briefly for Firebase session restoration after reload (avoid unnecessary wallet prompts).
    if (typeof window !== 'undefined' && (!authReadyRef.current || authLoadingRef.current)) {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        if (
          connectedWallet &&
          authTokenRef.current &&
          authTokenWalletRef.current &&
          authTokenWalletRef.current === connectedWallet
        ) {
          return true;
        }
        if (signInPromiseRef.current) return signInPromiseRef.current;
        if (authReadyRef.current && !authLoadingRef.current) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
    }

    if (
      connectedWallet &&
      authTokenRef.current &&
      authTokenWalletRef.current &&
      authTokenWalletRef.current === connectedWallet
    ) {
      return true;
    }
    if (signInPromiseRef.current) return signInPromiseRef.current;

    let promise: Promise<boolean>;
    promise = signIn(hasLocalCompletedStripeCheckout ? { mergeStripeDeliveryOrders: true } : undefined)
      .then((session) => {
        authTokenRef.current = session?.token ?? null;
        authTokenWalletRef.current = session?.token && session.profile?.wallet ? session.profile.wallet : null;
        return true;
      })
      .catch((err) => {
        if (!isUserRejectedError(err)) {
          showToast(err instanceof Error ? err.message : 'Failed to sign in');
        }
        return false;
      })
      .finally(() => {
        if (signInPromiseRef.current === promise) {
          signInPromiseRef.current = null;
        }
      });

    signInPromiseRef.current = promise;
    return promise;
  };

  useEffect(() => {
    if (!pendingShipmentsSignIn || !publicKey) return;
    if (isSignedInWallet) {
      setPendingShipmentsSignIn(false);
      return;
    }
    if (!authReady || authLoading) return;
    setPendingShipmentsSignIn(false);
    void ensureSignedIn();
  }, [authLoading, authReady, isSignedInWallet, pendingShipmentsSignIn, publicKey]);

  useEffect(() => {
    if (!pendingShipmentsSignIn || walletModalVisible || publicKey || wallet.connecting) return;
    setPendingShipmentsSignIn(false);
  }, [pendingShipmentsSignIn, publicKey, wallet.connecting, walletModalVisible]);

  useEffect(() => {
    if (!pendingHeaderWalletSignIn || !publicKey) return;
    if (isSignedInWallet) {
      setPendingHeaderWalletSignIn(false);
      return;
    }
    if (!authReady || authLoading) return;
    setPendingHeaderWalletSignIn(false);
    void ensureSignedIn();
  }, [authLoading, authReady, isSignedInWallet, pendingHeaderWalletSignIn, publicKey]);

  useEffect(() => {
    if (!pendingHeaderWalletSignIn || walletModalVisible || publicKey || wallet.connecting) return;
    setPendingHeaderWalletSignIn(false);
  }, [pendingHeaderWalletSignIn, publicKey, wallet.connecting, walletModalVisible]);

  useEffect(() => {
    if (isSignedInWallet) {
      setHeaderWalletButtonRevealed(false);
      return;
    }
    if (pendingHeaderWalletSignIn) {
      setHeaderWalletButtonRevealed(true);
      return;
    }
    if (connectedWallet) {
      if (authReady && !authLoading) setHeaderWalletButtonRevealed(true);
      return;
    }
    if (walletIdleReady && !walletBusy) setHeaderWalletButtonRevealed(true);
  }, [
    authLoading,
    authReady,
    connectedWallet,
    isSignedInWallet,
    pendingHeaderWalletSignIn,
    walletBusy,
    walletIdleReady,
  ]);

  const runDeliveryRecovery = useCallback(
    async (request: RecoverDeliveryOrdersArgs = {}) => {
      const recoveryWallet = connectedWallet;
      if (!recoveryWallet || !isSignedInWallet || isViewerMode) return;

      if (deliveryRecoveryPromiseRef.current) {
        deliveryRecoveryQueuedRef.current = mergeDeliveryRecoveryRequest(deliveryRecoveryQueuedRef.current, request);
        return deliveryRecoveryPromiseRef.current;
      }

      let promise: Promise<void>;
      promise = (async () => {
        let nextRequest: RecoverDeliveryOrdersArgs | null = request;

        while (nextRequest) {
          const activeRequest = nextRequest;
          deliveryRecoveryQueuedRef.current = null;

          try {
            const result = await recoverMyDeliveryOrders(activeRequest);
            const stillCurrent =
              connectedWalletRef.current === recoveryWallet &&
              authTokenWalletRef.current === recoveryWallet;

            if (stillCurrent) {
              const nextCheckAt = deliveryRecoveryNextCheckAtFromResult(result);
              let refreshedProfile = false;
              await Promise.all([
                refreshProfile()
                  .then(() => {
                    refreshedProfile = true;
                  })
                  .catch(() => null),
                result.attempted > 0 || result.recovered > 0
                  ? refetchInventory().catch(() => undefined)
                  : Promise.resolve(undefined),
              ]);
              setDeliveryRecoveryOverrideNextCheckAt(refreshedProfile ? null : nextCheckAt);
            }
          } catch (err) {
            console.warn('Delivery recovery failed', err);
            if (connectedWalletRef.current === recoveryWallet && authTokenWalletRef.current === recoveryWallet) {
              setDeliveryRecoveryOverrideNextCheckAt(Date.now() + 30_000);
            }
          }

          nextRequest = deliveryRecoveryQueuedRef.current;
        }
      })().finally(() => {
        if (deliveryRecoveryPromiseRef.current === promise) {
          deliveryRecoveryPromiseRef.current = null;
        }
      });

      deliveryRecoveryPromiseRef.current = promise;
      return promise;
    },
    [connectedWallet, isSignedInWallet, isViewerMode, refreshProfile, refetchInventory],
  );

  const scheduledDeliveryRecoveryAt = useMemo(
    () =>
      earliestDeliveryRecoveryCheckAt(
        currentOwnerDeliveryRecoveryNextCheckAt,
        deliveryRecoveryOverrideNextCheckAt,
      ),
    [currentOwnerDeliveryRecoveryNextCheckAt, deliveryRecoveryOverrideNextCheckAt],
  );

  useEffect(() => {
    if (!connectedWallet || !isSignedInWallet || isViewerMode) {
      lastScheduledDeliveryRecoveryAtRef.current = null;
      return;
    }
    if (scheduledDeliveryRecoveryAt == null) {
      lastScheduledDeliveryRecoveryAtRef.current = null;
      return;
    }

    if (scheduledDeliveryRecoveryAt <= Date.now()) {
      if (lastScheduledDeliveryRecoveryAtRef.current === scheduledDeliveryRecoveryAt) return;
      lastScheduledDeliveryRecoveryAtRef.current = scheduledDeliveryRecoveryAt;
      void runDeliveryRecovery();
      return;
    }

    lastScheduledDeliveryRecoveryAtRef.current = scheduledDeliveryRecoveryAt;
    const timeoutMs = Math.min(Math.max(0, scheduledDeliveryRecoveryAt - Date.now()), 0x7fffffff);
    const timeoutId = window.setTimeout(() => {
      void runDeliveryRecovery();
    }, timeoutMs);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [connectedWallet, isSignedInWallet, isViewerMode, runDeliveryRecovery, scheduledDeliveryRecoveryAt]);

  const queueOverlayAction = useCallback((action: () => void) => {
    if (revealOverlayRef.current) {
      deferredOverlayActionsRef.current.push(action);
      return;
    }
    action();
  }, []);

  const flushOverlayActions = useCallback(() => {
    const actions = deferredOverlayActionsRef.current;
    if (!actions.length) return;
    deferredOverlayActionsRef.current = [];
    actions.forEach((action) => action());
  }, []);

  const preloadBoxFrames = useCallback(
    (fromFrame = 1, toFrame?: number, dropId?: string) => {
      if (typeof window === 'undefined') return;
      if (revealRendererForDropId(dropId) === 'poncho_drifella') return;
      preloadRevealFrames(
        revealFrameSequenceForDropId(dropId),
        preloadedBoxFramesRef.current,
        boxFramePreloadImagesRef.current,
        fromFrame,
        toFrame,
      );
    },
    [revealFrameSequenceForDropId, revealRendererForDropId],
  );

  const ensureVideoPreloadRoot = useCallback(() => {
    if (typeof document === 'undefined') return null;
    if (videoPreloadRootRef.current) return videoPreloadRootRef.current;
    const root = document.createElement('div');
    root.setAttribute('data-reveal-video-preload', 'true');
    root.style.position = 'absolute';
    root.style.width = '0px';
    root.style.height = '0px';
    root.style.overflow = 'hidden';
    root.style.opacity = '0';
    root.style.pointerEvents = 'none';
    document.body.appendChild(root);
    videoPreloadRootRef.current = root;
    return root;
  }, []);

  const preloadRevealVideos = useCallback(
    (mediaIds: number[], dropId?: string) => {
      if (typeof document === 'undefined') return;
      const revealMediaBase = revealMediaBaseForDropId(dropId);
      if (!revealMediaBase) return;
      const root = ensureVideoPreloadRoot();
      if (!root) return;
      const ids = Array.from(new Set(mediaIds.filter((mediaId) => Number.isFinite(mediaId) && mediaId > 0)));
      if (!ids.length) return;
      const key = `${revealMediaBase}|${ids.join(',')}`;
      if (videoPreloadKeyRef.current === key) return;
      videoPreloadKeyRef.current = key;
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
      ids.forEach((mediaId) => {
        const movSrc = joinDropAssetUrl(revealMediaBase, `${mediaId}.mov`);
        const webmSrc = joinDropAssetUrl(revealMediaBase, `${mediaId}.webm`);
        if (!movSrc || !webmSrc) return;
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.setAttribute('aria-hidden', 'true');
        const sourceMov = document.createElement('source');
        sourceMov.src = movSrc;
        sourceMov.type = 'video/quicktime; codecs="hvc1"';
        const sourceWebm = document.createElement('source');
        sourceWebm.src = webmSrc;
        sourceWebm.type = 'video/webm';
        video.appendChild(sourceMov);
        video.appendChild(sourceWebm);
        root.appendChild(video);
        video.load();
      });
    },
    [ensureVideoPreloadRoot, revealMediaBaseForDropId],
  );

  const ensureSoundReady = useCallback(() => {
    if (soundPlayer.isInitialized) return Promise.resolve();
    if (soundInitPromiseRef.current) return soundInitPromiseRef.current;
    const promise = soundPlayer.initializeOnUserInteraction(true);
    soundInitPromiseRef.current = promise.finally(() => {
      if (soundInitPromiseRef.current === promise) {
        soundInitPromiseRef.current = null;
      }
    });
    return soundInitPromiseRef.current;
  }, []);

  const preloadRevealSounds = useCallback((dropId?: string) => {
    const { click, reveal } = revealSoundUrlsForDropId(dropId);
    void soundPlayer.preloadSound(reveal);
    click.forEach((clickUrl) => {
      void soundPlayer.preloadSound(clickUrl);
    });
    void ensureSoundReady().then(() => {
      void soundPlayer.preloadSound(reveal);
      click.forEach((clickUrl) => {
        void soundPlayer.preloadSound(clickUrl);
      });
    });
  }, [ensureSoundReady, revealSoundUrlsForDropId]);
  const playRevealSoundForDropId = useCallback(
    (dropId?: string) => {
      const { reveal, revealVolume } = revealSoundUrlsForDropId(dropId);
      const play = () => {
        void soundPlayer.playSound(reveal, revealVolume);
      };
      if (soundPlayer.isInitialized) {
        play();
        return;
      }
      const pending = soundInitPromiseRef.current;
      if (pending) {
        void pending.then(play);
      }
    },
    [revealSoundUrlsForDropId],
  );
  const playClickSoundForDropId = useCallback(
    (dropId?: string) => {
      const { click, clickVolume } = revealSoundUrlsForDropId(dropId);
      const clickUrl = pickRandomSoundUrl(click);
      void ensureSoundReady().then(() => {
        void soundPlayer.playSound(clickUrl, clickVolume);
      });
    },
    [ensureSoundReady, revealSoundUrlsForDropId],
  );

  const addLocalPendingReveal = (item: InventoryItem) => {
    if (!connectedWallet || isViewerMode) return;
    const now = Date.now();
    setLocalPendingReveals((prev) => {
      const nextEntry: LocalPendingReveal = {
        id: item.id,
        createdAt: now,
        dropId: item.dropId,
        name: item.name,
        image: normalizeBoxDisplayImage(item.dropId, item.image),
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

  const addLocalMintedBoxes = (quantity: number, dropId: string) => {
    if (isViewerMode) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const normalizedDropId = String(dropId || '').trim().toLowerCase();
    if (!normalizedDropId) return;
    const now = Date.now();
    setLocalMintedBoxes((prev) => {
      const entries: LocalMintedBox[] = [];
      const knownChainCount = inventoryFetched
        ? inventoryView.filter((item) => item.kind === 'box' && item.dropId === normalizedDropId).length
        : undefined;
      const pendingForDrop = prev.filter((entry) => entry.dropId === normalizedDropId).length;
      for (let i = 0; i < Math.floor(quantity); i += 1) {
        localMintCounterRef.current += 1;
        entries.push({
          id: `local-minted-${now}-${localMintCounterRef.current}`,
          dropId: normalizedDropId,
          createdAt: now + i,
          ...(knownChainCount != null ? { expectedChainCount: knownChainCount + pendingForDrop + i + 1 } : {}),
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

  const clearRevealOverlayCloseTimeout = useCallback(() => {
    if (revealOverlayCloseTimeoutRef.current === null) return;
    if (typeof window === 'undefined') return;
    window.clearTimeout(revealOverlayCloseTimeoutRef.current);
    revealOverlayCloseTimeoutRef.current = null;
  }, []);

  const clearPonchoPackDiscardDismissTimeout = useCallback(() => {
    if (ponchoPackDiscardDismissTimeoutRef.current === null) return;
    if (typeof window === 'undefined') return;
    window.clearTimeout(ponchoPackDiscardDismissTimeoutRef.current);
    ponchoPackDiscardDismissTimeoutRef.current = null;
  }, []);

  const markPonchoPackDiscardDismissReady = useCallback(() => {
    ponchoPackDiscardDismissReadyRef.current = true;
    revealDismissLockedUntilRef.current = Date.now() + PONCHO_OUTSIDE_TAP_DISMISS_LOCK_MS;
    clearPonchoPackDiscardDismissTimeout();
  }, [clearPonchoPackDiscardDismissTimeout]);

  const resetPonchoRevealDismissState = useCallback(() => {
    revealDismissLockedUntilRef.current = 0;
    ponchoPackDiscardDismissReadyRef.current = false;
    setPonchoRevealComplete(false);
    clearPonchoPackDiscardDismissTimeout();
  }, [clearPonchoPackDiscardDismissTimeout]);

  const resetRevealRequestState = useCallback(() => {
    revealOverlaySessionRef.current += 1;
    revealLoadingRequestIdRef.current = null;
    setRevealLoading(null);
  }, []);

  const finalizeRevealOverlayDismissal = useCallback(({ flushActions = true }: { flushActions?: boolean } = {}) => {
    clearRevealOverlayCloseTimeout();
    revealOverlayRef.current = null;
    resetPonchoRevealDismissState();
    setRevealOverlay(null);
    setRevealOverlayClosing(false);
    setRevealOverlayActive(false);
    videoPreloadKeyRef.current = '';
    if (videoPreloadRootRef.current) {
      while (videoPreloadRootRef.current.firstChild) {
        videoPreloadRootRef.current.removeChild(videoPreloadRootRef.current.firstChild);
      }
    }
    if (flushActions) {
      flushOverlayActions();
      return;
    }
    deferredOverlayActionsRef.current = [];
  }, [clearRevealOverlayCloseTimeout, flushOverlayActions, resetPonchoRevealDismissState]);

  const cancelRevealOverlayAnimationFrame = useCallback(() => {
    if (revealOverlayRafRef.current === null) return;
    cancelAnimationFrame(revealOverlayRafRef.current);
    revealOverlayRafRef.current = null;
  }, []);

  const closeRevealOverlay = useCallback(() => {
    const overlay = revealOverlayRef.current;
    if (!overlay) return;
    if (revealOverlayClosingRef.current) return;
    if (overlay.phase === 'preparing') {
      setStartOpenLoading((prev) => (prev === overlay.id ? null : prev));
    }
    cancelRevealOverlayAnimationFrame();
    if (!revealOverlayActiveRef.current) {
      finalizeRevealOverlayDismissal();
      return;
    }
    setRevealOverlayClosing(true);
    clearRevealOverlayCloseTimeout();
    revealOverlayCloseTimeoutRef.current = window.setTimeout(() => {
      revealOverlayCloseTimeoutRef.current = null;
      finalizeRevealOverlayDismissal();
    }, REVEAL_CLOSE_FALLBACK_MS);
  }, [cancelRevealOverlayAnimationFrame, clearRevealOverlayCloseTimeout, finalizeRevealOverlayDismissal]);

  const dismissRevealOverlay = () => {
    cancelRevealOverlayAnimationFrame();
    clearRevealOverlayCloseTimeout();
    finalizeRevealOverlayDismissal();
  };

  const discardRevealOverlay = useCallback(() => {
    const overlay = revealOverlayRef.current;
    if (overlay) {
      setStartOpenLoading((prev) => (prev === overlay.id ? null : prev));
    }
    resetRevealRequestState();
    cancelRevealOverlayAnimationFrame();
    clearRevealOverlayCloseTimeout();
    finalizeRevealOverlayDismissal({ flushActions: false });
  }, [cancelRevealOverlayAnimationFrame, clearRevealOverlayCloseTimeout, finalizeRevealOverlayDismissal, resetRevealRequestState]);

  const startAutoOpening = useCallback((mode: 'normal' | 'fast') => {
    setRevealOverlay((prev) => {
      if (!prev) return prev;
      if (prev.phase !== 'ready') return prev;
      if (prev.autoOpening) return prev;
      if (!prev.revealedIds || !prev.revealedIds.length) return prev;
      if (!dropRevealIsAnimated(prev.dropId)) return prev;
      if (prev.frame >= revealFrameCountForDropId(prev.dropId)) return prev;
      return {
        ...prev,
        autoOpening: true,
        autoMode: mode,
        advanceClicks: 0,
        hasRevealAttempted: prev.hasRevealAttempted || mode === 'fast',
      };
    });
  }, [dropRevealIsAnimated, revealFrameCountForDropId]);

  const presentRevealOverlay = useCallback(
    (nextOverlay: RevealOverlayState) => {
      revealOverlayRef.current = nextOverlay;
      setRevealOverlay(nextOverlay);
      setRevealOverlayClosing(false);
      setRevealOverlayActive(false);
      cancelRevealOverlayAnimationFrame();
      revealOverlayRafRef.current = requestAnimationFrame(() => {
        revealOverlayRafRef.current = requestAnimationFrame(() => {
          setRevealOverlayActive(true);
          revealOverlayRafRef.current = null;
        });
      });
    },
    [cancelRevealOverlayAnimationFrame],
  );

  const openRevealOverlay = (
    id: string,
    rect: DOMRect,
    phase: RevealOverlayPhase = 'ready',
    itemOverride?: InventoryItem,
  ) => {
    if (revealOverlayRef.current || revealLoading) return;
    if (startOpenLoading && startOpenLoading !== id) return;
    if (typeof window === 'undefined') return;
    const item = itemOverride || inventoryIndex.get(id);
    if (!item) return;
    const overlayDropId = item.dropId || routeDrop?.dropId;
    if (!overlayDropId) return;
    resetPonchoRevealDismissState();
    clearRevealOverlayCloseTimeout();
    preloadRevealSounds(overlayDropId);
    preloadPonchoRevealPackAssetsForDropId(overlayDropId);
    preloadBoxFrames(1, revealClickMaxForDropId(overlayDropId), overlayDropId);
    preloadBoxFrames(revealAutoplayStartForDropId(overlayDropId), revealFrameCountForDropId(overlayDropId), overlayDropId);
    const originRect = toOverlayRect(rect);
    const targetRect = calcRevealTargetRectForDropInViewport(
      overlayDropId,
      boxAspectRatioForDropId(overlayDropId),
    );
    setInventorySnapshot(inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);
    const nextOverlay: RevealOverlayState = {
      id,
      dropId: overlayDropId,
      name: item.name,
      image: normalizeBoxDisplayImage(overlayDropId, item.image),
      originRect,
      targetRect,
      phase,
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      viewerMode: undefined,
      viewerFigureId: undefined,
      hasRevealAttempted: false,
      autoOpening: false,
      autoMode: undefined,
    };
    presentRevealOverlay(nextOverlay);
  };

  const findInventoryRect = (id: string) => {
    if (typeof document === 'undefined') return null;
    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const el = document.querySelector<HTMLElement>(`[data-inventory-id="${safeId}"]`);
    if (!el) return null;
    return getInventoryRevealRect(el);
  };

  useEffect(() => {
    const walletChanged = previousConnectedWalletForOwnerRef.current !== connectedWallet;
    previousConnectedWalletForOwnerRef.current = connectedWallet;
    if (walletChanged) {
      discardRevealOverlay();
    } else {
      closeRevealOverlay();
    }
    setSelected(new Set());
    setDeliveryOpen(false);
    setClaimOpen(false);
  }, [closeRevealOverlay, connectedWallet, discardRevealOverlay, owner]);

  useEffect(() => {
    setHiddenAssets(loadHiddenAssets(connectedWallet));
  }, [connectedWallet]);

  useEffect(() => {
    const usedCount = loadDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet);
    setDiscountUsedCount(usedCount);
    setDiscountRemainingCount(Math.max(0, activeDiscountAllowance - usedCount));
    setDiscountEligible(false);
    setDiscountChecking(false);
  }, [activeDiscountAllowance, activeDiscountScope, activeDiscountVersion, connectedWallet]);

  useEffect(() => {
    resetRevealRequestState();
    setLocalPendingReveals(loadPendingReveals(connectedWallet));
    setRecentRevealedBoxes(loadRecentReveals(connectedWallet).slice(0, RECENT_REVEALS_LIMIT));
    setLocalMintedBoxes([]);
    setInventorySnapshot([]);
    setPendingOpenSnapshot([]);
    setLocalRevealedDudeKeys([]);
    setFigureMetadataByKey({});
    figureMetadataRef.current = {};
    figureMetadataLoadingRef.current.clear();
    figureMetadataRetryAtRef.current.clear();
    localMintCounterRef.current = 0;
    knownBoxIdsByDropRef.current = new Map();
    preloadedBoxFramesRef.current.clear();
    boxFramePreloadImagesRef.current.clear();
    clearPonchoDrifellaImageCache(ponchoImageCacheRef.current);
    autoplayFramePreloadScheduledDropIdRef.current = null;
    videoPreloadKeyRef.current = '';
    if (videoPreloadRootRef.current) {
      videoPreloadRootRef.current.remove();
      videoPreloadRootRef.current = null;
    }
    deferredOverlayActionsRef.current = [];
  }, [connectedWallet, resetRevealRequestState]);

  useEffect(() => {
    if (revealOverlay) return;
    setInventorySnapshot(inventory);
  }, [inventory, revealOverlay]);

  useEffect(() => {
    if (revealOverlay) return;
    setPendingOpenSnapshot(pendingOpenBoxes);
  }, [pendingOpenBoxes, revealOverlay]);

  useEffect(() => {
    revealOverlayRef.current = revealOverlay;
  }, [revealOverlay]);

  useEffect(() => {
    revealOverlayActiveRef.current = revealOverlayActive;
  }, [revealOverlayActive]);

  useEffect(() => {
    revealOverlayClosingRef.current = revealOverlayClosing;
  }, [revealOverlayClosing]);

  useEffect(() => {
    if (!connectedWallet || isViewerMode) return;
    persistPendingReveals(connectedWallet, localPendingReveals);
  }, [connectedWallet, localPendingReveals, isViewerMode]);

  useEffect(() => {
    if (!connectedWallet || isViewerMode) return;
    persistRecentReveals(connectedWallet, recentRevealedBoxes);
  }, [connectedWallet, recentRevealedBoxes, isViewerMode]);

  useEffect(() => {
    figureMetadataRef.current = figureMetadataByKey;
  }, [figureMetadataByKey]);

  useEffect(() => {
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
  }, [
    owner,
    isViewerMode,
    pendingOpenBoxesView,
    pendingOpenBoxesSuccess,
    localPendingReveals,
    recentRevealedBoxes,
    inventoryView,
    revealOverlay,
  ]);

  useEffect(() => {
    if (isViewerMode) return;
    if (revealOverlay) return;
    if (!inventoryFetched) return;
    const currentBoxIdsByDrop = new Map<string, Set<string>>();
    inventoryView.forEach((item) => {
      if (item.kind !== 'box') return;
      const dropId = String(item.dropId || '').trim().toLowerCase();
      if (!dropId) return;
      const existing = currentBoxIdsByDrop.get(dropId) || new Set<string>();
      existing.add(item.id);
      currentBoxIdsByDrop.set(dropId, existing);
    });
    const prevBoxIdsByDrop = knownBoxIdsByDropRef.current;
    if (localMintedBoxes.length) {
      const currentBoxCountByDrop = new Map<string, number>();
      currentBoxIdsByDrop.forEach((ids, dropId) => {
        currentBoxCountByDrop.set(dropId, ids.size);
      });
      const newBoxCountByDrop = new Map<string, number>();
      currentBoxIdsByDrop.forEach((ids, dropId) => {
        const prevIds = prevBoxIdsByDrop.get(dropId);
        if (!prevIds) return;
        let newCount = 0;
        ids.forEach((id) => {
          if (!prevIds.has(id)) newCount += 1;
        });
        if (newCount > 0) {
          newBoxCountByDrop.set(dropId, newCount);
        }
      });
      setLocalMintedBoxes((prev) => {
        if (!prev.length) return prev;
        const removeIndexes = new Set<number>();
        const remainingIndexesByDrop = new Map<string, number[]>();
        prev.forEach((entry, index) => {
          const currentCount = currentBoxCountByDrop.get(entry.dropId) || 0;
          if (entry.expectedChainCount != null && currentCount >= entry.expectedChainCount) {
            removeIndexes.add(index);
            return;
          }
          const existing = remainingIndexesByDrop.get(entry.dropId) || [];
          existing.push(index);
          remainingIndexesByDrop.set(entry.dropId, existing);
        });
        remainingIndexesByDrop.forEach((indexes, dropId) => {
          let remainingToRemove = newBoxCountByDrop.get(dropId) || 0;
          if (!remainingToRemove) return;
          indexes
            .sort((leftIdx, rightIdx) => prev[leftIdx].createdAt - prev[rightIdx].createdAt)
            .forEach((index) => {
              if (remainingToRemove <= 0) return;
              removeIndexes.add(index);
              remainingToRemove -= 1;
            });
        });
        if (!removeIndexes.size) return prev;
        const next = prev.filter((_, index) => !removeIndexes.has(index));
        if (next.length === prev.length) return prev;
        return next;
      });
    }
    knownBoxIdsByDropRef.current = currentBoxIdsByDrop;
  }, [inventoryView, inventoryFetched, localMintedBoxes.length, revealOverlay, isViewerMode]);

  useEffect(() => {
    if (isViewerMode) return;
    if (!inventoryFetched) return;
    setLocalMintedBoxes((prev) => {
      let changed = false;
      const next = [...prev];
      const indexesByDrop = new Map<string, number[]>();
      prev.forEach((entry, index) => {
        const existing = indexesByDrop.get(entry.dropId) || [];
        existing.push(index);
        indexesByDrop.set(entry.dropId, existing);
      });
      indexesByDrop.forEach((indexes, dropId) => {
        const knownCount = knownBoxIdsByDropRef.current.get(dropId)?.size || 0;
        indexes
          .sort((leftIdx, rightIdx) => prev[leftIdx].createdAt - prev[rightIdx].createdAt)
          .forEach((index, offset) => {
            const expectedChainCount = knownCount + offset + 1;
            if (prev[index].expectedChainCount === expectedChainCount) return;
            next[index] = {
              ...prev[index],
              expectedChainCount,
            };
            changed = true;
          });
      });
      return changed ? next : prev;
    });
  }, [inventoryFetched, isViewerMode]);

  useEffect(() => {
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
  }, [inventoryView, localRevealedDudeKeys, figureMetadataByKey, revealOverlay, isViewerMode]);

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
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void refetchInventory();
    };
    tick();
    const interval = window.setInterval(tick, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [shouldPollInventory, refetchInventory]);

  useEffect(() => {
    if (!revealOverlay || !revealOverlay.autoOpening) return;
    if (revealOverlayClosing) return;
    const frameCount = revealFrameCountForDropId(revealOverlay.dropId);
    if (revealOverlay.frame >= frameCount) {
      setRevealOverlay((prev) => {
        if (!prev) return prev;
        if (!prev.autoOpening) return prev;
        return { ...prev, autoOpening: false, autoMode: undefined };
      });
      return;
    }
    if (typeof window === 'undefined') return;
    const delay = 30;
    const timeout = window.setTimeout(() => {
      setRevealOverlay((prev) => {
        if (!prev || !prev.autoOpening) return prev;
        const nextFrame = Math.min(prev.frame + 1, revealFrameCountForDropId(prev.dropId));
        const nextPhase =
          prev.phase === 'revealed'
            ? prev.phase
            : prev.revealedIds && prev.revealedIds.length && nextFrame >= revealMediaStartForDropId(prev.dropId)
              ? 'revealed'
              : prev.phase;
        return { ...prev, frame: nextFrame, phase: nextPhase };
      });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [revealFrameCountForDropId, revealMediaStartForDropId, revealOverlay, revealOverlayClosing]);

  useEffect(() => {
    if (!revealOverlayOpen) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if ((evt.metaKey || evt.ctrlKey) && OVERLAY_ZOOM_SHORTCUT_KEYS.has(evt.key)) {
        evt.preventDefault();
        return;
      }
      if (evt.key !== 'Escape') return;
      if (revealOverlayRef.current?.viewerMode === 'receipt-image') {
        evt.preventDefault();
      }
      closeRevealOverlay();
    };
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const preventDefault = (evt: Event) => evt.preventDefault();
    const nonPassiveOptions = { passive: false } as AddEventListenerOptions;

    document.addEventListener('keydown', onKeyDown);
    OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
      document.addEventListener(eventName, preventDefault, nonPassiveOptions);
    });
    html.classList.add('overlay-scroll-lock');
    body.classList.add('overlay-scroll-lock');
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
        document.removeEventListener(eventName, preventDefault, nonPassiveOptions);
      });
      html.classList.remove('overlay-scroll-lock');
      body.classList.remove('overlay-scroll-lock');
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [revealOverlayOpen, closeRevealOverlay]);

  useEffect(() => {
    if (!revealOverlayOpen) return;
    const updateTargetRect = () => {
      if (revealOverlayResizeRafRef.current) {
        cancelAnimationFrame(revealOverlayResizeRafRef.current);
      }
      revealOverlayResizeRafRef.current = requestAnimationFrame(() => {
        revealOverlayResizeRafRef.current = null;
        setRevealOverlay((prev) => {
          if (!prev) return prev;
          const viewport = getOverlayViewport();
          const nextTarget =
            prev.viewerMode === 'poncho-card'
              ? calcPonchoDrifellaAbsoluteCardRect(
                  calcPonchoDrifellaRevealTargetRectInViewport(viewport),
                )
              : prev.viewerMode === 'receipt-image'
                ? calcReceiptViewerTargetRectInViewport(
                    prev.targetRect.width / Math.max(1, prev.targetRect.height),
                    prev.imageViewerSize,
                    viewport,
                  )
              : calcRevealTargetRectForDropInViewport(
                  prev.dropId,
                  boxAspectRatioForDropId(prev.dropId),
                  viewport,
                );
          if (
            prev.targetRect.left === nextTarget.left &&
            prev.targetRect.top === nextTarget.top &&
            prev.targetRect.width === nextTarget.width &&
            prev.targetRect.height === nextTarget.height
          ) {
            return prev;
          }
          return { ...prev, targetRect: nextTarget };
        });
      });
    };
    window.addEventListener('resize', updateTargetRect);
    window.addEventListener('orientationchange', updateTargetRect);
    window.visualViewport?.addEventListener('resize', updateTargetRect);
    window.visualViewport?.addEventListener('scroll', updateTargetRect);
    return () => {
      window.removeEventListener('resize', updateTargetRect);
      window.removeEventListener('orientationchange', updateTargetRect);
      window.visualViewport?.removeEventListener('resize', updateTargetRect);
      window.visualViewport?.removeEventListener('scroll', updateTargetRect);
      if (revealOverlayResizeRafRef.current) {
        cancelAnimationFrame(revealOverlayResizeRafRef.current);
        revealOverlayResizeRafRef.current = null;
      }
    };
  }, [boxAspectRatioForDropId, revealOverlayOpen]);

  useEffect(() => {
    authLoadingSeenRef.current = false;
    setAuthReady(false);
  }, [connectedWallet]);

  useEffect(() => {
    if (!connectedWallet) return;
    if (authLoading) {
      authLoadingSeenRef.current = true;
      return;
    }
    if (profile || authLoadingSeenRef.current) {
      setAuthReady(true);
    }
  }, [connectedWallet, authLoading, profile]);

  useEffect(() => {
    if (connectedWallet || walletBusy) {
      setWalletIdleReady(false);
      return;
    }
    const timeout = setTimeout(() => {
      setWalletIdleReady(true);
    }, 250);
    return () => {
      clearTimeout(timeout);
    };
  }, [connectedWallet, walletBusy]);

  useEffect(() => {
    return () => {
      if (toastFadeTimeoutRef.current) {
        clearTimeout(toastFadeTimeoutRef.current);
      }
      if (toastClearTimeoutRef.current) {
        clearTimeout(toastClearTimeoutRef.current);
      }
      cancelRevealOverlayAnimationFrame();
      if (revealOverlayResizeRafRef.current) {
        cancelAnimationFrame(revealOverlayResizeRafRef.current);
      }
      if (revealOverlayCloseTimeoutRef.current !== null) {
        clearTimeout(revealOverlayCloseTimeoutRef.current);
      }
    };
  }, [cancelRevealOverlayAnimationFrame]);

  const markAssetsHidden = useMemo(() => {
    if (!connectedWallet || isViewerMode) return (_ids: string[]) => undefined;
    return (ids: string[]) => {
      setHiddenAssets((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => {
          if (typeof id === 'string' && id) next.add(id);
        });
        persistHiddenAssets(connectedWallet, next);
        return next;
      });
    };
  }, [connectedWallet, isViewerMode]);

  const localRevealedDudes = useMemo(() => {
    if (isViewerMode) return [] as InventoryItem[];
    if (!localRevealedDudeKeys.length) return [] as InventoryItem[];
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

  const visibleInventory = useMemo(() => {
    const base =
      isViewerMode || !hiddenAssets.size ? inventoryView : inventoryView.filter((item) => !hiddenAssets.has(item.id));
    const enriched = base.map((item) => {
      if (item.kind === 'box') {
        const image = normalizeBoxDisplayImage(item.dropId, item.image);
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
  }, [inventoryView, hiddenAssets, localRevealedDudes, figureMetadataByKey, boxImageForDropId, isViewerMode]);

  const localMintedItems = useMemo<InventoryItem[]>(() => {
    if (isViewerMode) return [] as InventoryItem[];
    if (!localMintedBoxes.length) return [] as InventoryItem[];
    return moveLittleSwagBoxesFamilyToEnd(
      localMintedBoxes.map((entry) => ({
        id: entry.id,
        dropId: entry.dropId,
        name: `Pending ${boxLabelForDropId(entry.dropId)}`,
        kind: 'box' as const,
        image: boxImageForDropId(entry.dropId),
        status: 'pending' as const,
      })),
    );
  }, [localMintedBoxes, boxImageForDropId, boxLabelForDropId, isViewerMode]);

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
  useEffect(() => {
    if (!routeDrop || !shouldPreloadBoxFramesInitial) return;
    preloadPonchoRevealPackAssetsForDropId(routeDrop.dropId);
    if (!dropRevealIsAnimated(routeDrop.dropId)) return;
    preloadBoxFrames(1, revealClickMaxForDropId(routeDrop.dropId), routeDrop.dropId);
  }, [
    routeDrop,
    dropRevealIsAnimated,
    preloadBoxFrames,
    preloadPonchoRevealPackAssetsForDropId,
    revealClickMaxForDropId,
    shouldPreloadBoxFramesInitial,
  ]);
  useEffect(() => {
    if (!routeDrop || !shouldPreloadBoxFramesInitial) return;
    if (!dropRevealIsAnimated(routeDrop.dropId)) return;
    if (typeof window === 'undefined') return;
    if (autoplayFramePreloadScheduledDropIdRef.current === routeDrop.dropId) return;
    autoplayFramePreloadScheduledDropIdRef.current = routeDrop.dropId;
    const run = () =>
      preloadBoxFrames(routeDrop.dropId ? revealAutoplayStartForDropId(routeDrop.dropId) : 1, revealFrameCountForDropId(routeDrop.dropId), routeDrop.dropId);
    const win = window as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const handle = win.requestIdleCallback(run, { timeout: 1500 });
      return () => {
        if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(handle);
      };
    }
    const timeout = window.setTimeout(run, 750);
    return () => window.clearTimeout(timeout);
  }, [
    routeDrop,
    dropRevealIsAnimated,
    preloadBoxFrames,
    revealAutoplayStartForDropId,
    revealFrameCountForDropId,
    shouldPreloadBoxFramesInitial,
  ]);
  useEffect(() => {
    if (!revealOverlay) return;
    if (revealOverlay.viewerMode === 'receipt-image') return;
    preloadPonchoRevealPackAssetsForDropId(revealOverlay.dropId);
    if (!dropRevealIsAnimated(revealOverlay.dropId)) return;
    preloadBoxFrames(
      revealAutoplayStartForDropId(revealOverlay.dropId),
      revealFrameCountForDropId(revealOverlay.dropId),
      revealOverlay.dropId,
    );
  }, [
    dropRevealIsAnimated,
    preloadBoxFrames,
    preloadPonchoRevealPackAssetsForDropId,
    revealAutoplayStartForDropId,
    revealFrameCountForDropId,
    revealOverlay,
  ]);
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
      pendingItems.push({
        id,
        dropId: itemDropId,
        name: localMatch?.name || match?.name || boxReferenceForDropId(itemDropId, shortAddress(id)),
        kind: 'box',
        image: normalizeBoxDisplayImage(itemDropId, localMatch?.image || match?.image),
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
      pendingItems.push({
        id,
        dropId: itemDropId,
        name: entry.name || match?.name || boxReferenceForDropId(itemDropId, shortAddress(id)),
        kind: 'box',
        image: normalizeBoxDisplayImage(itemDropId, entry.image || match?.image),
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
  const inventoryEmptyStateVisibility = connectedWallet
    ? inventoryFetched
      ? 'visible'
      : 'hidden'
    : walletIdleReady
      ? 'visible'
      : 'hidden';
  const inventoryReadyForShipments = inventoryItems.length > 0 || inventoryEmptyStateVisibility === 'visible';

  const selectedItems = useMemo(() => {
    if (!selected.size) return [] as InventoryItem[];
    const inventoryById = new Map(inventoryView.map((item) => [item.id, item]));
    return Array.from(selected)
      .map((id) => inventoryById.get(id))
      .filter((item): item is InventoryItem => Boolean(item));
  }, [selected, inventoryView]);
  const selectedCount = selected.size;
  const deliverableItems = useMemo(
    () => selectedItems.filter((item) => item.kind !== 'certificate' && !pendingRevealIds.has(item.id)),
    [selectedItems, pendingRevealIds],
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
      previewImage: item.kind === 'box' ? normalizeBoxDisplayImage(item.dropId, item.image) : item.image,
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
      for (let i = 0; i < preview.length; i += 1) {
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
  }, [selectedItems, boxImageForDropId, compactPanel]);
  const selectedOverflow = Math.max(0, selectedCount - selectedPreview.length);
  const canOpenSelected =
    selectedCount === 1 &&
    selectedItems[0]?.kind === 'box' &&
    canOpenBoxesForDropId(selectedItems[0]?.dropId);
  const selectedBox = canOpenSelected ? selectedItems[0] : null;
  const selectedPonchoFigure = useMemo(() => {
    const item = selectedCount === 1 ? selectedItems[0] : null;
    if (!item || item.kind !== 'dude') return null;
    if (!isDropFamily(item.dropId, 'poncho_drifella')) return null;
    if (typeof item.dudeId !== 'number') return null;
    if (!getPonchoDrifellaCardByFigureId(item.dudeId)) return null;
    return item;
  }, [selectedCount, selectedItems]);
  const canViewSelected = Boolean(selectedPonchoFigure);

  useEffect(() => {
    if (!pendingRevealIds.size) return;
    setSelected((prev) => {
      let changed = false;
      const next = new Set(prev);
      pendingRevealIds.forEach((id) => {
        if (next.delete(id)) changed = true;
      });
      return changed ? next : prev;
    });
  }, [pendingRevealIds]);

  useEffect(() => {
    if (!selected.size) return;
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();

      prev.forEach((id) => {
        const item = inventoryIndex.get(id);
        if (!item || item.kind === 'certificate' || pendingRevealIds.has(id)) {
          changed = true;
          return;
        }
        next.add(id);
      });

      return changed ? next : prev;
    });
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

  useEffect(() => {
    if (!deliveryOpen || selectedCount) return;
    setDeliveryOpen(false);
  }, [deliveryOpen, selectedCount]);

  // Prefer signing locally + sending via our app RPC connection. This avoids wallet-side cluster mismatches
  // (e.g. Phantom set to mainnet while the app is on devnet) and surfaces clearer RPC errors.
  const signAndSendViaConnection = useCallback(
    async (
      tx: VersionedTransaction,
      targetConnection: Connection,
      options?: SendViaConnectionOptions,
    ): Promise<string | null> => {
      if (wallet.signTransaction) {
        const signed = await wallet.signTransaction(tx);
        const raw = signed.serialize();
        try {
          return await targetConnection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3,
          });
        } catch (err) {
          return recoverConnectionSendError(signed, targetConnection, err, options);
        }
      }
      try {
        return await sendTransaction(tx, targetConnection, { skipPreflight: false });
      } catch (err) {
        return recoverConnectionSendError(tx, targetConnection, err, options);
      }
    },
    [sendTransaction, wallet],
  );

  async function sendAndConfirmViaConnection(
    tx: VersionedTransaction,
    targetConnection: Connection,
    options?: SendViaConnectionOptions,
  ): Promise<string | null> {
    const signature = await signAndSendViaConnection(tx, targetConnection, options);
    if (signature) {
      await targetConnection.confirmTransaction(signature, 'confirmed');
    }
    return signature;
  }

  async function sendAndConfirmMintViaConnection(
    tx: VersionedTransaction,
    targetConnection: Connection,
    options?: SendViaConnectionOptions,
  ): Promise<boolean> {
    const signature = await signAndSendViaConnection(tx, targetConnection, options);
    if (!signature) return false;
    const result = await targetConnection.confirmTransaction(signature, 'confirmed');
    return Boolean(result.value.err);
  }

  const signAndSendPreparedViaConnection = useCallback(
    async (tx: VersionedTransaction, targetConnection: Connection): Promise<string> => {
      const signature = await signAndSendViaConnection(tx, targetConnection);
      if (!signature) {
        throw new Error('Wallet submitted the transaction but did not provide a recoverable signature');
      }
      return signature;
    },
    [signAndSendViaConnection],
  );

  async function retryAfterBlockhashExpiry<T>(sendOnce: () => Promise<T>, expiredMessage: string): Promise<T> {
    try {
      return await sendOnce();
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      showToast(expiredMessage);
      return sendOnce();
    }
  }

  const mintedOut = useMemo(() => {
    return !effectiveMintStats || effectiveMintStats.remaining <= 0;
  }, [effectiveMintStats]);

  const discountAvailable =
    Boolean(publicKey) && !mintedOut && !walletBusy && !discountChecking && discountEligible && discountRemainingCount > 0;

  useEffect(() => {
    if (!routeDrop || !routeConnection || !publicKey || mintedOut) {
      setDiscountEligible(false);
      setDiscountRemainingCount(0);
      setDiscountChecking(false);
      return;
    }
    let cancelled = false;
    setDiscountChecking(true);
    (async () => {
      const address = publicKey.toBase58();
      try {
        const listed = await isDiscountListed(routeDrop.dropId, address);
        if (cancelled) return;
        if (!listed) {
          setDiscountEligible(false);
          setDiscountRemainingCount(0);
          setDiscountUsedCount(0);
          persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, address, 0);
          return;
        }
        const usedCount = await fetchDiscountMintRecordUsedCount(routeConnection, publicKey, routeDrop);
        if (cancelled) return;
        const remainingCount = Math.max(0, activeDiscountAllowance - usedCount);
        setDiscountUsedCount(usedCount);
        setDiscountRemainingCount(remainingCount);
        setDiscountEligible(remainingCount > 0);
        persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, address, usedCount);
      } catch (err) {
        if (cancelled) return;
        console.warn('[mons] failed to check discount eligibility', err);
        setDiscountEligible(false);
        setDiscountRemainingCount(0);
      } finally {
        if (!cancelled) setDiscountChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeDiscountAllowance,
    activeDiscountScope,
    activeDiscountVersion,
    mintedOut,
    publicKey,
    routeConnection,
    routeDrop,
  ]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      }
      if (prev.size >= MAX_SHIPMENT_ITEMS) return prev;
      const nextItem = inventoryIndex.get(id);
      if (!nextItem || nextItem.kind === 'certificate') return prev;
      const firstSelectedId = prev.values().next().value as string | undefined;
      const firstSelectedItem = firstSelectedId ? inventoryIndex.get(firstSelectedId) : undefined;
      if (
        firstSelectedItem &&
        firstSelectedItem.dropId &&
        nextItem.dropId &&
        firstSelectedItem.dropId !== nextItem.dropId
      ) {
        return new Set([id]);
      }
      const copy = new Set(prev);
      copy.add(id);
      return copy;
    });
  };

  const handleMint = async (quantity: number, variantKey?: string) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const mintDrop = requireRouteDrop('mint');
    if (!routeConnection) throw new Error('Missing route connection for mint');
    if (mintedOut || minting || discountMinting || mintActionLockRef.current) return;
    if (mintDrop.mintSelection?.kind === 'size' && !variantKey) {
      showToast('Select a size');
      return;
    }
    const mintedQuantity = mintDrop.mintSelection?.kind === 'size' ? 1 : quantity;
    let didConfirmMint = false;
    mintActionLockRef.current = 'mint';
    setMinting(true);
    try {
      const cfg = await fetchBoxMinterConfig(routeConnection, mintDrop);
      const sendOnce = async () => {
        const { tx, boxAccounts } =
          mintDrop.mintSelection?.kind === 'size'
            ? await buildMintVariantBoxTxWithAccounts(routeConnection, cfg, publicKey, variantKey || '', mintDrop)
            : await buildMintBoxesTxWithAccounts(routeConnection, cfg, publicKey, quantity, mintDrop);
        return sendAndConfirmMintViaConnection(tx, routeConnection, {
          onAlreadyProcessedWithoutSignature: (err) =>
            recoverAlreadyProcessedAccounts(routeConnection, boxAccounts, err),
        });
      };
      const hasConfirmationError = await retryAfterBlockhashExpiry(
        sendOnce,
        'Transaction expired before you approved it. Please approve again…',
      );
      if (!hasConfirmationError) {
        addLocalMintedBoxes(mintedQuantity, mintDrop.dropId);
        setSuccessfulMintToken((prev) => prev + 1);
        didConfirmMint = true;
      }
      await Promise.all([shouldFetchMintStats ? refetchStats() : Promise.resolve(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      if (didConfirmMint) {
        console.warn('Mint succeeded but failed to refresh mint state', err);
        return;
      }
      throw err;
    } finally {
      if (mintActionLockRef.current === 'mint') {
        mintActionLockRef.current = null;
      }
      setMinting(false);
    }
  };

  const handleDiscountMint = async (quantity: number, variantKey?: string) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const mintDrop = requireRouteDrop('discount mint');
    if (!routeConnection) throw new Error('Missing route connection for discount mint');
    if (mintedOut || discountMinting || minting || mintActionLockRef.current) return;
    if (mintDrop.mintSelection?.kind === 'size' && !variantKey) {
      showToast('Select a size');
      return;
    }
    const maxDiscountQuantity = Math.max(0, discountRemainingCount);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > maxDiscountQuantity) {
      if (maxDiscountQuantity > 0) {
        showToast(`Discount available for up to ${dropAssetCount(mintDrop, 'box', maxDiscountQuantity)}`);
      } else {
        showToast('Wallet is not eligible for the discount');
      }
      return;
    }

    mintActionLockRef.current = 'discount';
    setDiscountMinting(true);
    let didConfirmMint = false;
    try {
      const proof = await getDiscountProof(mintDrop.dropId, publicKey.toBase58());
      if (!proof) {
        setDiscountEligible(false);
        setDiscountRemainingCount(0);
        showToast('Wallet is not eligible for the discount');
        return;
      }

      const mintedQuantity = mintDrop.mintSelection?.kind === 'size' ? 1 : quantity;
      const cfg = await fetchBoxMinterConfig(routeConnection, mintDrop);
      const onchainDiscountAllowance = cfg.discountMintsPerWallet;
      const onchainUsedCount = await fetchDiscountMintRecordUsedCount(routeConnection, publicKey, mintDrop);
      const onchainRemainingCount = Math.max(0, onchainDiscountAllowance - onchainUsedCount);
      if (quantity > onchainRemainingCount) {
        setDiscountUsedCount(onchainUsedCount);
        setDiscountRemainingCount(onchainRemainingCount);
        setDiscountEligible(onchainRemainingCount > 0);
        if (connectedWallet) persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet, onchainUsedCount);
        if (onchainRemainingCount > 0) {
          showToast(`Discount available for up to ${dropAssetCount(mintDrop, 'box', onchainRemainingCount)}`);
        } else {
          showToast('Wallet is not eligible for the discount');
        }
        return;
      }
      const sendOnce = async () => {
        const { tx, boxAccounts } =
          mintDrop.mintSelection?.kind === 'size'
            ? await buildMintDiscountedVariantBoxTxWithAccounts(routeConnection, cfg, publicKey, variantKey || '', proof, mintDrop)
            : await buildMintDiscountedBoxTxWithAccounts(routeConnection, cfg, publicKey, quantity, proof, mintDrop);
        return sendAndConfirmMintViaConnection(tx, routeConnection, {
          onAlreadyProcessedWithoutSignature: (err) =>
            recoverAlreadyProcessedAccounts(routeConnection, boxAccounts, err),
        });
      };
      const hasConfirmationError = await retryAfterBlockhashExpiry(
        sendOnce,
        'Transaction expired before you approved it. Please approve again…',
      );
      if (!hasConfirmationError) {
        addLocalMintedBoxes(mintedQuantity, mintDrop.dropId);
        setSuccessfulMintToken((prev) => prev + 1);
        didConfirmMint = true;
      }
      const nextUsedCount = hasConfirmationError ? onchainUsedCount : onchainUsedCount + mintedQuantity;
      const nextRemainingCount = hasConfirmationError
        ? onchainRemainingCount
        : Math.max(0, onchainDiscountAllowance - nextUsedCount);
      setDiscountUsedCount(nextUsedCount);
      setDiscountRemainingCount(nextRemainingCount);
      setDiscountEligible(nextRemainingCount > 0);
      if (connectedWallet) persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet, nextUsedCount);
      await Promise.all([shouldFetchMintStats ? refetchStats() : Promise.resolve(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      if (didConfirmMint) {
        console.warn('Discount mint succeeded but failed to refresh mint state', err);
        return;
      }
      showToast(err instanceof Error ? err.message : `Failed to mint discounted ${boxLabelForDropId(mintDrop.dropId)}`);
      return;
    } finally {
      if (mintActionLockRef.current === 'discount') {
        mintActionLockRef.current = null;
      }
      setDiscountMinting(false);
    }
  };

  const handleStripePayment = async (variantKey?: string) => {
    if (blockViewerModeAction()) return;
    const mintDrop = requireRouteDrop('Stripe payment');
    const stripePaymentMode = stripeCheckoutModeForDrop(mintDrop);
    if (!stripePaymentMode) {
      showToast('Stripe payment is not enabled for this drop');
      return;
    }
    if (stripePaymentLoading) return;

    setStripePaymentLoading(true);
    try {
      const returnUrl = typeof window !== 'undefined' ? window.location.href : undefined;
      const { id, url } = await createStripeCheckoutSession({
        dropId: mintDrop.dropId,
        variantKey,
        returnUrl,
      });
      const checkoutFirebaseUid = auth?.currentUser?.uid || firebaseUid;
      if (checkoutFirebaseUid) {
        setStripeCheckoutMarkers(
          rememberStripeCheckoutStarted({
            sessionId: id,
            dropId: mintDrop.dropId,
            firebaseUid: checkoutFirebaseUid,
            createdAt: Date.now(),
          }),
        );
      }
      window.location.assign(url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to start Stripe payment');
    } finally {
      setStripePaymentLoading(false);
    }
  };

  const handleStartOpenBox = async (item: InventoryItem) => {
    if (blockViewerModeAction()) return;
    if (!canOpenBoxesForDropId(item.dropId)) {
      showToast(`${boxLabelForDropId(item.dropId)} does not support opening.`);
      return;
    }
    if (!publicKey) throw new Error(`Connect wallet to open a ${boxLabelForDropId(item.dropId)}`);
    setStartOpenLoading(item.id);
    try {
      const targetDrop = requireKnownDropConfig(item.dropId, `inventory item ${item.id}`);
      const targetConnection = getDropConnection(targetDrop.dropId);
      const cfg = await fetchBoxMinterConfig(targetConnection, targetDrop);
      const sendOnce = async () => {
        const { tx, pendingPda } = await buildStartOpenBoxTxWithPending(
          targetConnection,
          cfg,
          publicKey,
          new PublicKey(item.id),
          targetDrop,
        );
        return sendAndConfirmViaConnection(tx, targetConnection, {
          onAlreadyProcessedWithoutSignature: (err) =>
            recoverAlreadyProcessedAccounts(targetConnection, [pendingPda], err),
        });
      };
      await retryAfterBlockhashExpiry(sendOnce, 'Transaction expired before you approved it. Please approve again…');
      rememberPendingOpenDropId(targetDrop.solanaCluster, item.id, targetDrop.dropId);
      queueOverlayAction(() => addLocalPendingReveal(item));
      setRevealOverlay((prev) => {
        if (!prev || prev.id !== item.id) return prev;
        return {
          ...prev,
          phase: 'ready',
          frame: 1,
          advanceClicks: 0,
          revealedIds: undefined,
          hasRevealAttempted: false,
          autoOpening: false,
          autoMode: undefined,
        };
      });
      // Helius indexing can lag after transfers; hide immediately once the tx is confirmed.
      queueOverlayAction(() => markAssetsHidden([item.id]));
      queueOverlayAction(() => {
        void Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
      });
    } catch (err) {
      console.error(err);
      if (!isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : `Failed to open ${boxLabelForDropId(item.dropId)}`);
      }
      dismissRevealOverlay();
    } finally {
      setStartOpenLoading(null);
    }
  };

  const handleRevealDudes = async (boxAssetId: string, dropId: string): Promise<PonchoDrifellaRevealRequestStatus> => {
    if (blockViewerModeAction()) return 'retry';
    if (!canOpenBoxesForDropId(dropId)) return 'resolved';
    const requestSession = revealOverlaySessionRef.current;
    const signedIn = await ensureSignedIn();
    if (!signedIn) return 'retry';
    if (!publicKey) return 'retry';
    if (revealOverlaySessionRef.current !== requestSession) {
      return 'resolved';
    }
    revealLoadingRequestCounterRef.current += 1;
    const loadingRequestId = revealLoadingRequestCounterRef.current;
    revealLoadingRequestIdRef.current = loadingRequestId;
    setRevealLoading(boxAssetId);
    try {
      const revealDrop = requireKnownDropConfig(dropId, `reveal request for ${boxAssetId}`);
      const revealContent = getDropContent(revealDrop.dropId);
      const resp = await revealDudes(publicKey.toBase58(), boxAssetId, revealDrop.dropId);
      const revealed = (resp?.dudeIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (revealOverlaySessionRef.current !== requestSession) {
        return 'resolved';
      }
      preloadPonchoRevealCardAssetsForDropId(revealDrop.dropId, revealed);
      if (revealed.length) {
        revealDismissLockedUntilRef.current = Date.now() + 1_000;
      }
      if (revealed.length && revealContent.figures.revealPresentation === 'videos') {
        const mediaIds = Array.from(
          new Set(
            revealed
              .map((figureId) => getMediaIdForFigureId(figureId, revealDrop.figureMedia))
              .filter((mediaId): mediaId is number => Boolean(mediaId)),
          ),
        );
        if (mediaIds.length) {
          preloadRevealVideos(mediaIds, revealDrop.dropId);
        }
      }
      setRevealOverlay((prev) => {
        if (!prev || prev.id !== boxAssetId) return prev;
        const hasResults = revealed.length > 0;
        const usesPonchoRenderer = revealContent.reveal.renderer === 'poncho_drifella';
        const nextPhase =
          revealContent.reveal.mode === 'static'
            ? hasResults
              ? 'revealed'
              : prev.phase === 'preparing'
                ? prev.phase
                : 'ready'
            : usesPonchoRenderer
              ? prev.phase === 'preparing'
                ? prev.phase
                : 'ready'
              : prev.phase === 'preparing'
                ? prev.phase
                : prev.frame >= revealMediaStartForDropId(prev.dropId) && hasResults
                  ? 'revealed'
                  : 'ready';
        return { ...prev, phase: nextPhase, revealedIds: revealed };
      });
      queueOverlayAction(() => removeLocalPendingReveal(boxAssetId));
      queueOverlayAction(() => rememberRecentReveal(boxAssetId));
      queueOverlayAction(() => addLocalRevealedDudes(revealed, revealDrop.dropId));
      queueOverlayAction(() => {
        void Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
      });
      return 'resolved';
    } catch (err) {
      if (revealOverlaySessionRef.current !== requestSession) {
        return 'resolved';
      }
      console.error(err);
      const code = (err as { code?: string })?.code;
      if (code !== 'not-found' && !isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : `Failed to reveal ${figureLabelForDropId(dropId, 2)}`);
      }
      return 'retry';
    } finally {
      if (revealLoadingRequestIdRef.current === loadingRequestId) {
        revealLoadingRequestIdRef.current = null;
        setRevealLoading((current) => (current === boxAssetId ? null : current));
      }
    }
  };

  const ensureRevealOverlayAdvanceAllowed = useCallback(() => {
    if (blockViewerModeAction()) return false;
    if (!publicKey) {
      showToast('Connect wallet first');
      return false;
    }
    return true;
  }, [blockViewerModeAction, publicKey, showToast]);

  const handleRevealOverlayClick = () => {
    if (!revealOverlay || revealOverlayClosing) return;
    if (!canOpenBoxesForDropId(revealOverlay.dropId)) return;
    if (revealOverlay.phase !== 'ready') return;
    if (revealOverlay.autoOpening) return;
    const revealContent = getDropContent(revealOverlay.dropId);
    if (revealContent.reveal.mode === 'animated' && revealOverlay.frame >= revealFrameCountForDropId(revealOverlay.dropId)) {
      return;
    }
    if (!ensureRevealOverlayAdvanceAllowed()) return;

    const { click, clickVolume } = revealSoundUrlsForDropId(revealOverlay.dropId);
    void ensureSoundReady().then(() => soundPlayer.playSound(pickRandomSoundUrl(click), clickVolume));
    const shouldSendReveal = !revealOverlay.hasRevealAttempted && !revealOverlay.revealedIds?.length;
    setRevealOverlay((prev) => {
      if (!prev || prev.id !== revealOverlay.id) return prev;
      if (prev.phase !== 'ready') return prev;
      if (prev.autoOpening) return prev;
      if (revealContent.reveal.mode !== 'animated') {
        return {
          ...prev,
          hasRevealAttempted: true,
          advanceClicks: 0,
        };
      }

      const hasResults = Boolean(prev.revealedIds?.length);
      const canAdvance =
        prev.frame < revealClickMaxForDropId(prev.dropId) ||
        (prev.frame === revealClickMaxForDropId(prev.dropId) && hasResults);
      const shouldAdvanceNow = canAdvance;
      const nextFrame = shouldAdvanceNow
        ? prev.frame < revealClickMaxForDropId(prev.dropId)
          ? prev.frame + 1
          : prev.frame === revealClickMaxForDropId(prev.dropId) && hasResults
            ? revealAutoplayStartForDropId(prev.dropId)
            : prev.frame
        : prev.frame;
      const shouldAuto =
        hasResults && nextFrame === revealAutoplayStartForDropId(prev.dropId) && prev.frame !== nextFrame;
      return {
        ...prev,
        frame: nextFrame,
        hasRevealAttempted: true,
        advanceClicks: 0,
        autoOpening: shouldAuto ? true : prev.autoOpening,
        autoMode: shouldAuto ? 'normal' : prev.autoMode,
      };
    });

    if (shouldSendReveal) {
      void handleRevealDudes(revealOverlay.id, revealOverlay.dropId);
    }
  };

  const handleRevealOverlayBackdropClick = () => {
    if (!revealOverlay || revealOverlayClosing) return;
    if (revealOverlay.viewerMode === 'poncho-card' || revealOverlay.viewerMode === 'receipt-image') {
      closeRevealOverlay();
      return;
    }
    const hasResults = Boolean(revealOverlay.revealedIds?.length);
    if (revealOverlayUsesPonchoRenderer) {
      if (!ponchoRevealComplete) {
        return;
      }
      if (hasResults && !ponchoPackDiscardDismissReadyRef.current) {
        return;
      }
      if (hasResults && Date.now() < revealDismissLockedUntilRef.current) {
        return;
      }
      closeRevealOverlay();
      return;
    }
    if (hasResults && dropRevealIsAnimated(revealOverlay.dropId) && revealOverlay.frame < revealFrameCountForDropId(revealOverlay.dropId)) {
      startAutoOpening('fast');
      return;
    }
    if (revealOverlay.hasRevealAttempted && revealLoading === revealOverlay.id) {
      return;
    }
    if (hasResults && Date.now() < revealDismissLockedUntilRef.current) {
      return;
    }
    closeRevealOverlay();
  };

  const handleRevealOverlayTransitionEnd = useCallback(
    (evt: TransitionEvent<HTMLDivElement>) => {
      if (evt.propertyName !== 'opacity') return;
      if (!revealOverlayClosing) return;
      finalizeRevealOverlayDismissal();
    },
    [finalizeRevealOverlayDismissal, revealOverlayClosing],
  );

  const openPreparingOverlayForBox = useCallback(
    (box: InventoryItem) => {
      if (!canOpenBoxesForDropId(box.dropId)) return;
      preloadRevealSounds(box.dropId);
      preloadPonchoRevealPackAssetsForDropId(box.dropId);
      preloadBoxFrames(1, revealClickMaxForDropId(box.dropId), box.dropId);
      preloadBoxFrames(revealAutoplayStartForDropId(box.dropId), revealFrameCountForDropId(box.dropId), box.dropId);
      if (typeof window === 'undefined') return;
      const originRect = findInventoryRect(box.id);
      const fallbackTarget = calcRevealTargetRectForDropInViewport(
        box.dropId,
        boxAspectRatioForDropId(box.dropId),
      );
      const fallbackRect = new DOMRect(
        fallbackTarget.left,
        fallbackTarget.top,
        fallbackTarget.width,
        fallbackTarget.height,
      );
      const overlayItem: InventoryItem = { ...box, image: normalizeBoxDisplayImage(box.dropId, box.image) };
      openRevealOverlay(box.id, originRect || fallbackRect, 'preparing', overlayItem);
    },
    [
      canOpenBoxesForDropId,
      boxAspectRatioForDropId,
      openRevealOverlay,
      preloadBoxFrames,
      preloadPonchoRevealPackAssetsForDropId,
      preloadRevealSounds,
      revealAutoplayStartForDropId,
      revealClickMaxForDropId,
      revealFrameCountForDropId,
    ],
  );

	  const handleOpenSelectedBox = async () => {
      if (blockViewerModeAction()) return;
	    if (!selectedBox) return;
      if (!canOpenBoxesForDropId(selectedBox.dropId)) return;
	    if (!publicKey) {
	      setVisible(true);
	      return;
	    }
	    if (openSelectedLockRef.current) {
	      const activeId = openSelectedBoxIdRef.current;
	      if (activeId && activeId !== selectedBox.id) {
	        showToast(`Check your wallet to finish the current ${openGerundForDropId(selectedBox.dropId)}`);
	        return;
	      }
	      openSelectedBoxIdRef.current = selectedBox.id;
	      if (revealOverlayRef.current?.id === selectedBox.id) return;
	      if (revealOverlayRef.current || revealOverlayClosingRef.current) {
	        queueOverlayAction(() => openPreparingOverlayForBox(selectedBox));
	        return;
	      }
	      openPreparingOverlayForBox(selectedBox);
	      return;
	    }
	    openSelectedLockRef.current = true;
	    openSelectedBoxIdRef.current = selectedBox.id;
	    try {
	      openPreparingOverlayForBox(selectedBox);
	      const signedIn = await ensureSignedIn();
	      if (!signedIn) {
	        if (revealOverlayRef.current?.id === selectedBox.id) {
	          closeRevealOverlay();
	        }
	        return;
	      }
      if (
        !revealOverlayRef.current ||
        revealOverlayRef.current.id !== selectedBox.id ||
        revealOverlayClosingRef.current
      ) {
        return;
      }
	      setSelected(new Set());
	      await handleStartOpenBox(selectedBox);
	    } finally {
	      if (openSelectedBoxIdRef.current === selectedBox.id) {
	        openSelectedBoxIdRef.current = null;
	      }
	      openSelectedLockRef.current = false;
	    }
	  };

  const openPonchoCardViewer = useCallback((
    {
      overlayId,
      dropId,
      name,
      image,
      figureId,
      originRect,
      clearSelection = false,
    }: {
      overlayId: string;
      dropId: string;
      name: string;
      image?: string;
      figureId: number;
      originRect?: DOMRect | null;
      clearSelection?: boolean;
    },
  ) => {
    if (!isDropFamily(dropId, 'poncho_drifella')) return false;
    if (revealOverlayRef.current || revealLoading) return false;
    if (startOpenLoading) return false;
    if (typeof window === 'undefined') return false;

    const card = getPonchoDrifellaCardByFigureId(figureId);
    if (!card) return false;

    preloadPonchoDrifellaCardAssets(card, ponchoImageCacheRef.current, { mode: 'warm', priority: 'low' });
    resetPonchoRevealDismissState();
    clearRevealOverlayCloseTimeout();
    setInventorySnapshot(inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);

    const targetRect = calcPonchoDrifellaAbsoluteCardRect(
      calcPonchoDrifellaRevealTargetRectInViewport(),
    );
    const resolvedOriginRect = originRect
      ? calcAspectLockedViewerOriginRect(originRect, targetRect)
      : new DOMRect(
          targetRect.left,
          targetRect.top,
          targetRect.width,
          targetRect.height,
        );
    presentRevealOverlay({
      id: overlayId,
      dropId,
      name,
      image,
      originRect: toOverlayRect(resolvedOriginRect),
      targetRect,
      phase: 'revealed',
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      viewerMode: 'poncho-card',
      viewerFigureId: figureId,
      hasRevealAttempted: true,
      autoOpening: false,
      autoMode: undefined,
    });
    if (clearSelection) {
      setSelected(new Set());
    }
    return true;
  }, [
    clearRevealOverlayCloseTimeout,
    inventory,
    pendingOpenBoxes,
    presentRevealOverlay,
    resetPonchoRevealDismissState,
    revealLoading,
    startOpenLoading,
  ]);

  const openImageViewer = useCallback((
    item: ReceiptViewerSource,
    originRect?: DOMRect | null,
    options?: {
      aspectRatio?: number;
      size?: ImageViewerSize;
      unavailableMessage?: string;
      inventorySnapshot?: InventoryItem[];
      overlayId?: string;
      overlayName?: string;
      receiptImages?: ReceiptViewerImage[];
      allowMissingImage?: boolean;
    },
  ) => {
    if (revealOverlayRef.current || revealLoading) return false;
    if (startOpenLoading) return false;
    if (typeof window === 'undefined') return false;
    const missingImage = options?.receiptImages?.length
      ? options.receiptImages.some((receiptImage) => !receiptImage.image)
      : !item.image;
    if (!options?.allowMissingImage && missingImage) {
      showToast(options?.unavailableMessage || 'Image unavailable');
      return false;
    }

    const aspectRatio =
      options?.aspectRatio && Number.isFinite(options.aspectRatio) && options.aspectRatio > 0
        ? options.aspectRatio
        : originRect && originRect.height > 0 && Number.isFinite(originRect.width / originRect.height)
          ? originRect.width / originRect.height
          : 1;
    const targetRect = calcReceiptViewerTargetRectInViewport(aspectRatio, options?.size);
    const resolvedOriginRect = originRect
      ? calcAspectLockedViewerOriginRect(originRect, targetRect)
      : new DOMRect(targetRect.left, targetRect.top, targetRect.width, targetRect.height);

    resetPonchoRevealDismissState();
    clearRevealOverlayCloseTimeout();
    setInventorySnapshot(options?.inventorySnapshot ?? inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);
    presentRevealOverlay({
      id: options?.overlayId || item.id,
      dropId: item.dropId,
      name: options?.overlayName || item.name,
      image: item.image,
      originRect: toOverlayRect(resolvedOriginRect),
      targetRect,
      phase: 'revealed',
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      viewerMode: 'receipt-image',
      imageViewerSize: options?.size || 'receipt',
      receiptImages: options?.receiptImages,
      viewerFigureId: undefined,
      hasRevealAttempted: true,
      autoOpening: false,
      autoMode: undefined,
    });
    return true;
  }, [
    clearRevealOverlayCloseTimeout,
    inventory,
    pendingOpenBoxes,
    presentRevealOverlay,
    resetPonchoRevealDismissState,
    revealLoading,
    showToast,
    startOpenLoading,
  ]);

  const openReceiptImageViewerGroup = useCallback((
    items: readonly ReceiptViewerSource[],
    originRect?: DOMRect | null,
    options?: { inventorySnapshot?: InventoryItem[]; allowPlaceholders?: boolean },
  ) => {
    const receiptImages = items.filter((item) => item.id && item.dropId);
    const firstReceipt = receiptImages[0];
    if (!firstReceipt) return false;

    const singleAspectRatio =
      originRect && originRect.height > 0 && Number.isFinite(originRect.width / originRect.height)
        ? originRect.width / originRect.height
        : 1;
    return openImageViewer(firstReceipt, originRect, {
      aspectRatio: singleAspectRatio * receiptImages.length,
      size: 'receipt',
      unavailableMessage: 'Receipt image unavailable',
      inventorySnapshot: options?.inventorySnapshot,
      overlayId: receiptImages.length === 1
        ? firstReceipt.id
        : `claimed-receipts-${firstReceipt.dropId}-${receiptImages.map((item) => item.id).join('-')}`,
      overlayName: receiptImages.length === 1 ? firstReceipt.name : 'Claimed receipts',
      receiptImages: receiptImages.map((item) => ({ key: item.id, name: item.name, image: item.image })),
      allowMissingImage: options?.allowPlaceholders,
    });
  }, [openImageViewer]);

  const openReceiptImageViewer = useCallback((
    item: InventoryItem,
    originRect?: DOMRect | null,
    options?: { inventorySnapshot?: InventoryItem[] },
  ) => {
    if (item.kind !== 'certificate') return false;
    return openReceiptImageViewerGroup([item], originRect, {
      inventorySnapshot: options?.inventorySnapshot,
    });
  }, [openReceiptImageViewerGroup]);

  const handleViewSelectedPonchoCard = useCallback(() => {
    if (!selectedPonchoFigure) return;
    const figureId = selectedPonchoFigure.dudeId;
    if (typeof figureId !== 'number') return;
    openPonchoCardViewer({
      overlayId: selectedPonchoFigure.id,
      dropId: selectedPonchoFigure.dropId,
      name: selectedPonchoFigure.name,
      image: selectedPonchoFigure.image,
      figureId,
      originRect: findInventoryRect(selectedPonchoFigure.id),
      clearSelection: true,
    });
  }, [findInventoryRect, openPonchoCardViewer, selectedPonchoFigure]);

  const handleOpenShip = async () => {
    if (blockViewerModeAction()) return;
    if (selectedDropIds.length > 1) {
      return;
    }
    const signedIn = await ensureSignedIn();
    if (!signedIn) return;
    setDeliveryOpen(true);
  };

  const handleShip = async ({
    formatted,
    country,
    email,
    countryCode,
  }: {
    formatted: string;
    country: string;
    email: string;
    countryCode: string;
  }) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) {
      setVisible(true);
      showToast('Connect a wallet to ship items');
      return;
    }
    if (!selected.size) {
      showToast('Select items to ship');
      return;
    }
    const deliverableIds = deliverableItems.map((item) => item.id);
    if (!deliverableIds.length) {
      showToast(`Select ${boxLabelForDropId(undefined, 2)} or ${figureLabelForDropId(undefined, 2)} to ship`);
      return;
    }
    const deliveryDropId = deliverableItems[0]?.dropId || '';
    if (!deliveryDropId) {
      showToast('Unable to determine drop for selected items');
      return;
    }
    if (deliverableItems.some((item) => item.dropId !== deliveryDropId)) {
      return;
    }
    if (deliverableIds.length !== selected.size) {
      setSelected(new Set(deliverableIds));
    }

    const encryptionKey = (ADDRESS_ENCRYPTION_PUBLIC_KEY || '').trim();
    if (!encryptionKey) {
      showToast('Missing address encryption public key (src/App.tsx)');
      return;
    }

    try {
      const deliveryDrop = requireKnownDropConfig(deliveryDropId, 'delivery selection');
      const deliveryConnection = getDropConnection(deliveryDrop.dropId);
      const session = isSignedInWallet
        ? { profile }
        : await signIn(hasLocalCompletedStripeCheckout ? { mergeStripeDeliveryOrders: true } : undefined);
      const { cipherText, hint } = encryptAddressPayload(formatted, encryptionKey);
      const saved = await saveEncryptedAddress(cipherText, country, hint, email, countryCode);
      const base = session?.profile || profile;
      if (updateProfile && base) {
        updateProfile({
          ...base,
          email: email || base.email,
        });
      }

      const requestTx = () =>
        requestDeliveryTx(publicKey.toBase58(), { itemIds: deliverableIds, addressId: saved.id }, deliveryDrop.dropId);
      let resp = await requestTx();
      let sig: string;
      try {
        sig = await sendPreparedTransaction(resp.encodedTx, deliveryConnection, (tx) =>
          signAndSendPreparedViaConnection(tx, deliveryConnection),
        );
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
        resp = await requestTx();
        sig = await sendPreparedTransaction(resp.encodedTx, deliveryConnection, (tx) =>
          signAndSendPreparedViaConnection(tx, deliveryConnection),
        );
      }
      const idSuffix = resp.deliveryId ? ` · id ${resp.deliveryId}` : '';
      showToast(`Shipment submitted${idSuffix} · ${sig}`);
      // Delivery transfers the selected assets to the vault; hide them immediately once confirmed.
      markAssetsHidden(deliverableIds);
      setSelected(new Set());
      await refetchInventory();
      const deliveryId = resp.deliveryId;
      if (deliveryId) {
        try {
          showToast(`Shipment submitted${idSuffix} · ${sig} · issuing receipts…`);
          const issued = await retryWithBackoff(
            () => issueReceipts(publicKey.toBase58(), deliveryId, sig, deliveryDrop.dropId),
            {
              maxAttempts: 3,
              baseDelayMs: 500,
              maxDelayMs: 2_000,
              shouldRetry: isRetryableCallableError,
            },
          );
          const minted = Number(issued?.receiptsMinted || 0);
          showToast(`Shipment submitted${idSuffix} · ${sig} · receipts issued (${minted})`);
          await Promise.all([refetchInventory(), refreshProfile().catch(() => null)]);
        } catch (err) {
          console.warn('Direct issueReceipts failed, starting background recovery', err);
          void runDeliveryRecovery({
            dropId: deliveryDrop.dropId,
            deliveryId,
            force: true,
          });
          showToast(`Shipment submitted${idSuffix} · ${sig} · receipts recovering in background`);
        }
      }
    } catch (err) {
      console.error(err);
      if (!isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : 'Failed to ship');
      }
    }
  };

  const handleSignInForShipments = async () => {
    if (!publicKey) {
      setPendingShipmentsSignIn(true);
      setVisible(true);
      return;
    }
    if (authLoading) return;
    await ensureSignedIn();
  };

  const handleHeaderWalletSignIn = async () => {
    if (authLoading || walletBusy || pendingHeaderWalletSignIn) return;
    if (!publicKey) {
      setPendingHeaderWalletSignIn(true);
      setVisible(true);
      return;
    }
    await ensureSignedIn();
  };

  const handleClaim = async ({ code }: { code: string }) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) throw new Error('Connect wallet to claim');
    const previousReceiptIds = new Set(inventory.filter((item) => item.kind === 'certificate').map((item) => item.id));
    // Ensure wallet session exists for authenticated callable.
    if (!isSignedInWallet) {
      await signIn(hasLocalCompletedStripeCheckout ? { mergeStripeDeliveryOrders: true } : undefined);
    }
    const requestTx = () => requestClaimTx(publicKey.toBase58(), code);
    let resp = await requestTx();
    let claimDrop = requireKnownDropConfig(resp.dropId, 'claim transaction response');
    let claimConnection = getDropConnection(claimDrop.dropId);
    try {
      await sendPreparedTransaction(resp.encodedTx, claimConnection, (tx) =>
        signAndSendPreparedViaConnection(tx, claimConnection),
      );
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
      resp = await requestTx();
      claimDrop = requireKnownDropConfig(resp.dropId, 'claim transaction retry response');
      claimConnection = getDropConnection(claimDrop.dropId);
      await sendPreparedTransaction(resp.encodedTx, claimConnection, (tx) =>
        signAndSendPreparedViaConnection(tx, claimConnection),
      );
    }
    const claimedFigureIds = normalizeClaimedReceiptIds(resp.certificates);
    closeClaimModal();

    let opened = false;
    const openClaimedReceiptPreview = (
      previewItems: readonly ReceiptViewerSource[],
      snapshot: InventoryItem[],
      options?: { allowPlaceholders?: boolean },
    ) => {
      if (opened || revealOverlayRef.current) return;
      if (!previewItems.length) return;
      if (!options?.allowPlaceholders && previewItems.some((item) => !item.image)) return;
      opened = openReceiptImageViewerGroup(previewItems, null, {
        inventorySnapshot: snapshot,
        allowPlaceholders: options?.allowPlaceholders,
      });
    };

    const initialPreviewItems = buildClaimedReceiptPreviewItems(
      inventory,
      claimDrop.dropId,
      claimedFigureIds,
      previousReceiptIds,
      resp.certificateId,
    );
    openClaimedReceiptPreview(initialPreviewItems, inventory);

    const missingFallbackFigureIds = claimedFigureIds.filter((_, index) => !initialPreviewItems[index]?.image);
    if (missingFallbackFigureIds.length && !opened) {
      void Promise.all(
        missingFallbackFigureIds.map(async (figureId): Promise<[number, string | undefined]> => [
          figureId,
          await loadClaimedReceiptImage(claimDrop.dropId, figureId),
        ]),
      )
        .then((entries) => {
          const fallbackImages = new Map(
            entries.filter((entry): entry is [number, string] => Boolean(entry[1])),
          );
          openClaimedReceiptPreview(
            buildClaimedReceiptPreviewItems(
              inventory,
              claimDrop.dropId,
              claimedFigureIds,
              previousReceiptIds,
              resp.certificateId,
              fallbackImages,
            ),
            inventory,
            { allowPlaceholders: true },
          );
        })
        .catch(() => undefined);
    }

    void refetchInventory()
      .then((result) => {
        const refreshedInventory = result.data ?? inventory;
        openClaimedReceiptPreview(
          buildClaimedReceiptPreviewItems(
            refreshedInventory,
            claimDrop.dropId,
            claimedFigureIds,
            previousReceiptIds,
            resp.certificateId,
          ),
          refreshedInventory,
        );
      })
      .catch((err) => {
        console.warn('[mons] failed to refresh inventory after claim', err);
      });

    return {
      itemsPerBox: claimDrop.itemsPerBox,
      boxNamePrefix: claimDrop.namePrefix,
      figureNamePrefix: claimDrop.figureNamePrefix,
    };
  };

  const profileLoadingForView = viewedProfileLoading && (!profile || profile.wallet !== owner);
  const anonymousStripeDeliveryOrders = anonymousStripeHistoryData?.orders || [];
  const anonymousStripeHistoryHasOrders = anonymousStripeDeliveryOrders.length > 0;
  const anonymousStripeHistoryInitialLoading =
    anonymousStripeHistoryPollActive && anonymousStripeHistoryLoading && !anonymousStripeHistoryData;
  const anonymousStripeHistoryVisible =
    !connectedWallet && (anonymousStripeHistoryPollActive || anonymousStripeHistoryHasOrders);
  const anonymousStripeHistoryWaitingForFulfillment =
    anonymousStripeHistoryPollActive &&
    !anonymousStripeHistoryHasOrders &&
    !anonymousStripeHistoryError &&
    (anonymousStripeHistoryInitialLoading ||
      Boolean(anonymousStripeHistoryPollUntil && Date.now() < anonymousStripeHistoryPollUntil));
  const deliveryOrders = viewedProfile?.orders || (anonymousStripeHistoryVisible ? anonymousStripeDeliveryOrders : []);
  const shipmentFigureTargetsNeedingMetadata = useMemo(() => {
    const targetsByKey = new Map<string, FigureMetadataTarget>();
    deliveryOrders.forEach((order) => {
      const dropConfig = requireKnownDropConfig(order.dropId, `shipment order ${order.deliveryId}`);
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
  }, [deliveryOrders, figureMetadataByKey, getDropContent, requireKnownDropConfig]);
  const shipmentsEmptyContent = (() => {
    if (viewedProfile) return 'No shipments yet.';
    if (anonymousStripeHistoryVisible) {
      if (anonymousStripeHistoryInitialLoading) return 'Loading shipments…';
      if (anonymousStripeHistoryError) return 'Unable to load shipments.';
      return anonymousStripeHistoryWaitingForFulfillment ? 'Preparing shipment…' : 'No shipments yet.';
    }
    if (isSignedInWallet && owner) return profileLoadingForView ? 'Loading shipments…' : 'No shipments yet.';
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
        <span>to view your shipments.</span>
      </span>
    );
  })();
  const shipmentsEmptyStateVisibility = connectedWallet
    ? authReady
      ? 'visible'
      : 'hidden'
    : walletIdleReady
      ? 'visible'
      : 'hidden';
  const shipmentsContentVisible =
    shipmentsReady && (deliveryOrders.length > 0 || shipmentsEmptyStateVisibility === 'visible');
  const closeClaimModal = useCallback(() => {
    setClaimOpen(false);
  }, []);

  useEffect(() => {
    if (!inventoryReadyForShipments) {
      setShipmentsReady(false);
      return;
    }
    setShipmentsReady(true);
  }, [inventoryReadyForShipments]);
  useEffect(() => {
    if (!deliveryOrders.length) {
      setClaimOpen(false);
    }
  }, [deliveryOrders.length]);
  useEffect(() => {
    if (!shipmentFigureTargetsNeedingMetadata.length) return;
    if (typeof window === 'undefined') return;
    queueFigureMetadataFetch(shipmentFigureTargetsNeedingMetadata);
    const interval = window.setInterval(() => {
      queueFigureMetadataFetch(shipmentFigureTargetsNeedingMetadata);
    }, FIGURE_METADATA_RETRY_MS);
    return () => window.clearInterval(interval);
  }, [queueFigureMetadataFetch, shipmentFigureTargetsNeedingMetadata]);

  const renderShipmentItems = useCallback(
    (order: DeliveryOrderSummary) => {
      const dropConfig = requireKnownDropConfig(order.dropId, `shipment render ${order.deliveryId}`);
      const dropContent = getDropContent(order.dropId);
      const figureMediaBase = dropContent.figures.fulfillmentMediaBaseUrl;
      const useMediaFolderPreview = dropContent.figures.fulfillmentPreviewMode === 'media_map_folder';
      const isPonchoFamily = isDropFamily(order.dropId, 'poncho_drifella');
      return (
        <div className="figure-grid shipment-item-grid">
          {order.items.map((item, index) => {
            const label = dropAssetReference(dropConfig, item.kind === 'box' ? 'box' : 'figure', item.refId);
            const previewId = `shipment:${order.dropId}:${order.deliveryId}:${item.kind}:${item.refId}:${index}`;
            if (item.kind === 'box') {
              const boxImage = normalizeBoxDisplayImage(order.dropId);
              return (
                <div
                  key={previewId}
                  className="figure-tile shipment-item-tile shipment-item-tile--interactive"
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${label}`}
                  draggable={false}
                  onDragStart={(evt) => evt.preventDefault()}
                  onClick={(evt) => {
                    const originRect = getInventoryRevealRect(evt.currentTarget);
                    const previewImage = getRenderedImagePreview(evt.currentTarget, boxImage);
                    openImageViewer(
                      { id: previewId, dropId: order.dropId, name: label, image: previewImage.src },
                      originRect,
                      {
                        aspectRatio: previewImage.aspectRatio,
                        size: 'shipment',
                        unavailableMessage: 'Shipment image unavailable',
                      },
                    );
                  }}
                  onKeyDown={(evt) => {
                    if (evt.key !== 'Enter' && evt.key !== ' ') return;
                    evt.preventDefault();
                    const originRect = getInventoryRevealRect(evt.currentTarget);
                    const previewImage = getRenderedImagePreview(evt.currentTarget, boxImage);
                    openImageViewer(
                      { id: previewId, dropId: order.dropId, name: label, image: previewImage.src },
                      originRect,
                      {
                        aspectRatio: previewImage.aspectRatio,
                        size: 'shipment',
                        unavailableMessage: 'Shipment image unavailable',
                      },
                    );
                  }}
                >
                  {boxImage ? (
                    <img
                      src={boxImage}
                      alt={label}
                      loading="lazy"
                      className="figure-image"
                      draggable={false}
                      onDragStart={(evt) => evt.preventDefault()}
                    />
                  ) : (
                    <div className="figure-image figure-image--placeholder" aria-hidden="true" />
                  )}
                </div>
              );
            }

            const cacheKey = figureMetadataCacheKey(order.dropId, item.refId);
            const metadata = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(order.dropId, item.refId);
            const fallbackSrc = figureMetadataHasImage(metadata) ? metadata.image : undefined;
            const mediaId = useMediaFolderPreview ? getMediaIdForFigureId(item.refId, dropConfig.figureMedia) : undefined;
            const primarySrc = mediaId ? joinDropAssetUrl(figureMediaBase, `${mediaId}.webp`) : undefined;
            const canViewPonchoCard = isPonchoFamily && Boolean(getPonchoDrifellaCardByFigureId(item.refId));
            const previewImage = primarySrc || fallbackSrc;

            return (
              <div
                key={previewId}
                className="figure-tile shipment-item-tile shipment-item-tile--interactive"
                role="button"
                tabIndex={0}
                aria-label={`View ${label}`}
                draggable={false}
                onDragStart={(evt) => evt.preventDefault()}
                onClick={(evt) => {
                  const originRect = getInventoryRevealRect(evt.currentTarget);
                  const renderedPreviewImage = getRenderedImagePreview(evt.currentTarget, previewImage);
                  if (canViewPonchoCard) {
                    openPonchoCardViewer({
                      overlayId: previewId,
                      dropId: order.dropId,
                      name: label,
                      image: renderedPreviewImage.src,
                      figureId: item.refId,
                      originRect,
                    });
                    return;
                  }
                  openImageViewer(
                    { id: previewId, dropId: order.dropId, name: label, image: renderedPreviewImage.src },
                    originRect,
                    {
                      aspectRatio: renderedPreviewImage.aspectRatio,
                      size: 'shipment-figure',
                      unavailableMessage: 'Shipment image unavailable',
                    },
                  );
                }}
                onKeyDown={(evt) => {
                  if (evt.key !== 'Enter' && evt.key !== ' ') return;
                  evt.preventDefault();
                  const originRect = getInventoryRevealRect(evt.currentTarget);
                  const renderedPreviewImage = getRenderedImagePreview(evt.currentTarget, previewImage);
                  if (canViewPonchoCard) {
                    openPonchoCardViewer({
                      overlayId: previewId,
                      dropId: order.dropId,
                      name: label,
                      image: renderedPreviewImage.src,
                      figureId: item.refId,
                      originRect,
                    });
                    return;
                  }
                  openImageViewer(
                    { id: previewId, dropId: order.dropId, name: label, image: renderedPreviewImage.src },
                    originRect,
                    {
                      aspectRatio: renderedPreviewImage.aspectRatio,
                      size: 'shipment-figure',
                      unavailableMessage: 'Shipment image unavailable',
                    },
                  );
                }}
              >
                <FigureTileImage
                  dropId={order.dropId}
                  figureId={item.refId}
                  primarySrc={primarySrc}
                  fallbackSrc={fallbackSrc}
                  alt={label}
                  onMetadataResolved={mergeLoadedFigureMetadata}
                />
              </div>
            );
          })}
        </div>
      );
    },
    [figureMetadataByKey, getDropContent, mergeLoadedFigureMetadata, openImageViewer, openPonchoCardViewer, requireKnownDropConfig],
  );

  const revealOverlayStyle = revealOverlay
    ? (() => {
        const { originRect, targetRect } = revealOverlay;
        const safeTargetWidth = Math.max(1, targetRect.width);
        const safeTargetHeight = Math.max(1, targetRect.height);
        const viewerScale = Math.max(0.01, originRect.height / safeTargetHeight);
        const scaleX = revealOverlay.viewerMode === 'poncho-card'
          ? viewerScale
          : Math.max(0.01, originRect.width / safeTargetWidth);
        const scaleY = revealOverlay.viewerMode === 'poncho-card'
          ? viewerScale
          : Math.max(0.01, originRect.height / safeTargetHeight);
        const ponchoCardRect = isDropFamily(revealOverlay.dropId, 'poncho_drifella')
          ? revealOverlay.viewerMode === 'poncho-card'
            ? {
                left: 0,
                top: 0,
                width: safeTargetWidth,
                height: safeTargetHeight,
              }
            : calcPonchoDrifellaCardRect({
                width: safeTargetWidth,
                height: safeTargetHeight,
              })
          : undefined;
        return {
          ['--reveal-target-left' as never]: `${targetRect.left}px`,
          ['--reveal-target-top' as never]: `${targetRect.top}px`,
          ['--reveal-target-width' as never]: `${safeTargetWidth}px`,
          ['--reveal-target-height' as never]: `${safeTargetHeight}px`,
          ['--reveal-start-x' as never]: `${originRect.left - targetRect.left}px`,
          ['--reveal-start-y' as never]: `${originRect.top - targetRect.top}px`,
          ['--reveal-start-scale-x' as never]: String(scaleX),
          ['--reveal-start-scale-y' as never]: String(scaleY),
          ['--reveal-note-offset' as never]: `${REVEAL_NOTE_OFFSET}px`,
          ...(ponchoCardRect
            ? {
                ['--poncho-card-left' as never]: `${ponchoCardRect.left}px`,
                ['--poncho-card-top' as never]: `${ponchoCardRect.top}px`,
                ['--poncho-card-width' as never]: `${ponchoCardRect.width}px`,
                ['--poncho-card-height' as never]: `${ponchoCardRect.height}px`,
                ['--poncho-pack-discard-delay' as never]: `${PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS}ms`,
                ['--poncho-pack-discard-duration' as never]: `${PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS}ms`,
              }
            : {}),
        };
      })()
    : undefined;
  const revealOverlayContent = useMemo(
    () => getDropContent(revealOverlay?.dropId || routeDrop?.dropId),
    [getDropContent, revealOverlay?.dropId, routeDrop?.dropId],
  );
  const revealOverlayContainerLabel = revealOverlay
    ? boxLabelForDropId(revealOverlay.dropId)
    : boxLabelForDropId(routeDrop?.dropId);
  const ponchoViewerCard = useMemo(() => {
    if (revealOverlay?.viewerMode !== 'poncho-card' || typeof revealOverlay.viewerFigureId !== 'number') return undefined;
    return getPonchoDrifellaCardByFigureId(revealOverlay.viewerFigureId);
  }, [revealOverlay?.viewerFigureId, revealOverlay?.viewerMode]);
  const ponchoRevealCard = useMemo(() => {
    if (!revealOverlay?.revealedIds?.length || revealOverlay.revealedIds.length !== 1) return undefined;
    return getPonchoDrifellaCardByFigureId(revealOverlay.revealedIds[0]);
  }, [revealOverlay?.revealedIds]);
  const revealOverlayUsesPonchoViewer = revealOverlay?.viewerMode === 'poncho-card';
  const revealOverlayUsesReceiptImage = revealOverlay?.viewerMode === 'receipt-image';
  const revealOverlayUsesPonchoRenderer = Boolean(
    revealOverlay &&
      !revealOverlayUsesPonchoViewer &&
      !revealOverlayUsesReceiptImage &&
      revealOverlayContent.reveal.renderer === 'poncho_drifella' &&
      (!revealOverlay.revealedIds?.length || (revealOverlay.revealedIds.length === 1 && ponchoRevealCard)),
  );
  const handlePonchoOverlayRequestReveal = useCallback(() => {
    if (!revealOverlay) return 'retry' as const;
    return handleRevealDudes(revealOverlay.id, revealOverlay.dropId);
  }, [handleRevealDudes, revealOverlay?.dropId, revealOverlay?.id]);
  const handlePonchoOverlayPlayClick = useCallback(() => {
    if (!revealOverlay) return;
    playClickSoundForDropId(revealOverlay.dropId);
  }, [playClickSoundForDropId, revealOverlay?.dropId]);
  const handlePonchoOverlayPlayReveal = useCallback(() => {
    if (!revealOverlay) return;
    playRevealSoundForDropId(revealOverlay.dropId);
  }, [playRevealSoundForDropId, revealOverlay?.dropId]);
  const showRevealOutcome = Boolean(
    revealOverlay &&
      revealOverlay.revealedIds?.length &&
      (revealOverlayContent.reveal.mode === 'static' || revealOverlay.frame >= revealMediaStartForDropId(revealOverlay.dropId)),
  );
  const revealOverlayStage = revealOverlay
    ? revealOverlay.phase === 'preparing'
      ? 'preparing'
      : showRevealOutcome
        ? 'revealed'
        : 'ready'
    : 'ready';
  useEffect(() => {
    if (!revealOverlayUsesPonchoRenderer || !revealOverlay?.revealedIds?.length || !ponchoRevealComplete) {
      ponchoPackDiscardDismissReadyRef.current = false;
      clearPonchoPackDiscardDismissTimeout();
      return undefined;
    }
    if (ponchoPackDiscardDismissReadyRef.current || typeof window === 'undefined') {
      return undefined;
    }
    const overlayId = revealOverlay.id;
    clearPonchoPackDiscardDismissTimeout();
    ponchoPackDiscardDismissTimeoutRef.current = window.setTimeout(() => {
      if (revealOverlayRef.current?.id !== overlayId) return;
      markPonchoPackDiscardDismissReady();
    }, PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS + PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS);
    return () => {
      clearPonchoPackDiscardDismissTimeout();
    };
  }, [
    clearPonchoPackDiscardDismissTimeout,
    markPonchoPackDiscardDismissReady,
    ponchoRevealComplete,
    revealOverlay?.id,
    revealOverlay?.revealedIds?.length,
    revealOverlayUsesPonchoRenderer,
  ]);
  const revealMediaItems = useMemo<Array<{ figureId: number; index: number; mediaId?: number; image?: string; name: string }>>(() => {
    if (!revealOverlay?.revealedIds?.length) {
      return [];
    }
    const revealDrop = requireKnownDropConfig(revealOverlay.dropId, 'reveal overlay');
    if (revealOverlayContent.figures.revealPresentation === 'videos') {
      return revealOverlay.revealedIds.map((figureId, index) => {
        const cacheKey = figureMetadataCacheKey(revealOverlay.dropId, figureId);
        const meta = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(revealOverlay.dropId, figureId);
        return {
          figureId,
          index,
          mediaId: getMediaIdForFigureId(figureId, revealDrop.figureMedia),
          image: meta?.image,
          name: meta?.name || figureReferenceForDropId(revealOverlay.dropId, figureId),
        };
      });
    }
    return revealOverlay.revealedIds.map((figureId, index) => {
      const cacheKey = figureMetadataCacheKey(revealOverlay.dropId, figureId);
      const meta = figureMetadataByKey[cacheKey] || getCachedFigureMetadata(revealOverlay.dropId, figureId);
      return {
        figureId,
        index,
        image: meta?.image,
        name: meta?.name || figureReferenceForDropId(revealOverlay.dropId, figureId),
      };
    });
  }, [
    figureMetadataByKey,
    figureReferenceForDropId,
    requireKnownDropConfig,
    revealOverlay?.dropId,
    revealOverlay?.revealedIds,
    revealOverlayContent.figures.revealPresentation,
  ]);
  const revealMediaIds = useMemo(
    () =>
      Array.from(
        new Set(
          revealMediaItems
            .map((entry) => entry.mediaId)
            .filter((mediaId): mediaId is number => Boolean(mediaId)),
        ),
      ),
    [revealMediaItems],
  );

  const revealSoundPlayedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealOverlay) {
      revealSoundPlayedRef.current = null;
      return;
    }
    if (revealOverlayUsesPonchoRenderer) return;
    if (!showRevealOutcome) return;
    if (revealSoundPlayedRef.current === revealOverlay.id) return;
    revealSoundPlayedRef.current = revealOverlay.id;
    playRevealSoundForDropId(revealOverlay.dropId);
  }, [playRevealSoundForDropId, revealOverlay, revealOverlayUsesPonchoRenderer, showRevealOutcome]);

  useEffect(() => {
    if (!revealOverlay?.revealedIds?.length) return;
    queueFigureMetadataFetch(revealOverlay.revealedIds.map((figureId) => ({ dropId: revealOverlay.dropId, figureId })));
  }, [queueFigureMetadataFetch, revealOverlay?.dropId, revealOverlay?.revealedIds]);

  const revealMediaStyle = useMemo(() => {
    if (!revealOverlay || !revealMediaItems.length) return undefined;
    const width = revealOverlay.targetRect.width;
    const height = revealOverlay.targetRect.height;
    const base = Math.min(width, height);
    const baseSize = Math.floor(Math.min(base * 0.7, 220));
    const widthCap = width < 240 ? 0.42 : width < 320 ? 0.48 : width < 420 ? 0.52 : 0.6;
    const maxByWidth = Math.floor(width * widthCap);
    const maxByHeight = Math.floor(height * 0.9);
    const maxSize = Math.floor(Math.min(baseSize * 1.4, maxByWidth, maxByHeight));
    const count = revealMediaItems.length;
    const densityScale = count <= 3 ? 0.8 : count <= 5 ? 0.68 : count <= 8 ? 0.56 : 0.48;
    const size = Math.max(48, Math.floor(maxSize * densityScale));
    const shiftY = Math.floor(size * 0.1);
    return {
      ['--reveal-media-size' as never]: `${size}px`,
      ['--reveal-media-shift-y' as never]: `${shiftY}px`,
    };
  }, [revealOverlay, revealMediaItems.length]);
  useEffect(() => {
    if (!revealMediaIds.length) return;
    if (revealOverlayContent.figures.revealPresentation !== 'videos') return;
    preloadRevealVideos(revealMediaIds, revealOverlay?.dropId || routeDrop?.dropId);
  }, [preloadRevealVideos, revealMediaIds, revealOverlay?.dropId, revealOverlayContent.figures.revealPresentation, routeDrop?.dropId]);
  const animatedRevealFrameSrc =
    revealOverlay && revealOverlay.frame && revealOverlayContent.reveal.mode === 'animated' && revealFrameSequence
      ? resolveRevealFrameSrc(revealFrameSequence, revealOverlay.frame)
      : undefined;
  const revealBoxFrameSrc =
    revealOverlay && !revealOverlayUsesPonchoRenderer && revealOverlay.frame
      ? animatedRevealFrameSrc || revealOverlay.image || boxImageForDropId(revealOverlay.dropId)
      : undefined;
  const revealOverlayNote =
    revealOverlayStage === 'preparing'
      ? `preparing to ${openVerbForDropId(revealOverlay?.dropId)}...`
      : revealOverlayStage === 'revealed'
        ? ''
        : revealOverlay
          ? revealOverlay.hasRevealAttempted
            ? revealOverlayContent.reveal.mode === 'animated'
              ? `keep clicking the ${revealOverlayContainerLabel}`
              : revealLoading === revealOverlay.id
                ? 'opening...'
                : ''
            : `click the ${revealOverlayContainerLabel} to open`
          : '';
  const defaultRevealOverlayNode = revealOverlay ? (
    <div
      className={`reveal-overlay reveal-overlay--${revealOverlayStage}${revealOverlayActive ? ' reveal-overlay--active' : ''}${revealOverlayClosing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={revealOverlayStyle}
      onClick={handleRevealOverlayBackdropClick}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div
        className="reveal-overlay__frame"
        onTransitionEnd={handleRevealOverlayTransitionEnd}
      >
        <div
          className={`reveal-overlay__shine${showRevealOutcome ? ' reveal-overlay__shine--visible' : ''}`}
          aria-hidden="true"
        />
        {revealMediaItems.length ? (
          <div
            className={`reveal-overlay__media${showRevealOutcome ? ' reveal-overlay__media--visible' : ''}`}
            style={revealMediaStyle}
            aria-hidden="true"
          >
            {revealMediaItems.map(({ figureId, mediaId, image, index, name }) => {
              const count = revealMediaItems.length;
              const angle = -Math.PI / 2 + (index * (Math.PI * 2)) / Math.max(count, 1);
              const ring = count <= 1 ? 0 : count <= 3 ? 28 : count <= 5 ? 32 : count <= 8 ? 36 : 40;
              const left = 50 + Math.cos(angle) * ring;
              const top = 50 + Math.sin(angle) * ring;
              return (
                <div
                  key={`${revealOverlay.id}-${figureId}-${index}`}
                  className="reveal-overlay__media-item"
                  style={{
                    left: showRevealOutcome ? `${left}%` : '50%',
                    top: showRevealOutcome ? `${top}%` : '50%',
                    ['--reveal-media-delay' as never]: `${index * 70}ms`,
                  }}
                >
                  <div className="reveal-overlay__media-float">
                    {revealOverlayContent.figures.revealPresentation === 'videos' && revealMediaBase && mediaId ? (
                      <video
                        className="reveal-overlay__video"
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        poster={image}
                        draggable={false}
                      >
                        <source
                          src={joinDropAssetUrl(revealMediaBase, `${mediaId}.mov`)}
                          type='video/quicktime; codecs="hvc1"'
                        />
                        <source src={joinDropAssetUrl(revealMediaBase, `${mediaId}.webm`)} type="video/webm" />
                      </video>
                    ) : image ? (
                      <>
                        <img
                          src={image}
                          alt={name}
                          className="reveal-overlay__still"
                          draggable={false}
                          onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
                          onError={(evt) => hideImageShowFallback(evt.currentTarget)}
                        />
                        <div className="reveal-overlay__still reveal-overlay__still--placeholder" hidden />
                      </>
                    ) : (
                      <div className="reveal-overlay__still reveal-overlay__still--placeholder" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        <button
          type="button"
          className="reveal-overlay__box"
          aria-label={`Reveal ${revealOverlay.name}`}
          aria-busy={revealLoading === revealOverlay.id}
          aria-disabled={
            revealOverlayClosing ||
            revealOverlay.phase !== 'ready' ||
            revealOverlay.autoOpening ||
            (revealOverlayContent.reveal.mode === 'animated' &&
              revealOverlay.frame >= revealFrameCountForDropId(revealOverlay.dropId))
          }
          onClick={(evt) => {
            evt.stopPropagation();
            handleRevealOverlayClick();
          }}
        >
          {revealBoxFrameSrc ? (
            <>
              <img
                src={revealBoxFrameSrc}
                alt={revealOverlay.name}
                className="reveal-overlay__image"
                draggable={false}
                onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
                onError={(evt) => hideImageShowFallback(evt.currentTarget)}
              />
              <div className="reveal-overlay__image reveal-overlay__image--placeholder" hidden aria-hidden="true" />
            </>
          ) : (
            <div className="reveal-overlay__image reveal-overlay__image--placeholder" aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="reveal-overlay__note">{revealOverlayNote}</div>
    </div>
  ) : null;
  const revealOverlayNode = revealOverlay ? (
    revealOverlayUsesPonchoViewer ? (
      <PonchoCardViewerOverlay
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        card={ponchoViewerCard}
        loadingImageSrc={revealOverlay.image}
        onDismiss={handleRevealOverlayBackdropClick}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
      />
    ) : revealOverlayUsesReceiptImage ? (
      <ReceiptImageViewerOverlay
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        images={revealOverlay.receiptImages}
        imageSrc={revealOverlay.image}
        alt={revealOverlay.name}
        viewerSize={revealOverlay.imageViewerSize}
        onDismiss={handleRevealOverlayBackdropClick}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
      />
    ) : revealOverlayUsesPonchoRenderer ? (
      <PonchoInventoryRevealOverlay
        mode="inventory-unbox"
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        phase={revealOverlay.phase}
        revealedIds={revealOverlay.revealedIds}
        loading={revealLoading === revealOverlay.id}
        boxName={revealOverlay.name}
        boxLabel={revealOverlayContainerLabel}
        imageCache={ponchoImageCacheRef.current}
        resetKey={revealOverlay.id}
        onRequestReveal={handlePonchoOverlayRequestReveal}
        onPlayClick={handlePonchoOverlayPlayClick}
        onPlayReveal={handlePonchoOverlayPlayReveal}
        onBeforeAdvance={ensureRevealOverlayAdvanceAllowed}
        onDismiss={handleRevealOverlayBackdropClick}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
        onPackDiscardEnd={markPonchoPackDiscardDismissReady}
        onRevealCompleteChange={setPonchoRevealComplete}
      />
    ) : (
      defaultRevealOverlayNode
    )
  ) : null;
  const ownerPickerValue = owner || '';
  const viewedProfileErrorMessage = viewedProfileError instanceof Error ? viewedProfileError.message : '';
  const anonymousStripeHistoryErrorMessage =
    anonymousStripeHistoryError instanceof Error ? anonymousStripeHistoryError.message : '';
  const deliveryOrderOwnersErrorMessage = deliveryOrderOwnersError instanceof Error ? deliveryOrderOwnersError.message : '';
  const canLoadMoreOwners = Boolean(deliveryOrderOwnersHasNextPage);
  const activeError =
    authError && !isUserRejectedError(authError)
      ? authError
      : viewedProfileErrorMessage || (anonymousStripeHistoryVisible ? anonymousStripeHistoryErrorMessage : '');
  const showHeaderWalletButton = !isSignedInWallet && headerWalletButtonRevealed;
  const dropPageFrameViewport = Boolean(routeDrop || upcomingDropRoute || normalizedCurrentPath === '/');
  const dropsPanelFrameActive = !routeDrop && !upcomingDropRoute && normalizedCurrentPath === '/';
  const pageRef = useRef<HTMLDivElement | null>(null);
  const primaryFrameClassName = [
    'drop-page-frame',
    dropPageFrameViewport ? 'drop-page-frame--active' : '',
    dropsPanelFrameActive ? 'drop-page-frame--drops-panel' : '',
  ].filter(Boolean).join(' ');
  useDropPageScrollFade({
    active: Boolean(routeDrop || upcomingDropRoute),
    pageRef,
  });
  const dropCardBackdropItems = useMemo(() => {
    if (!DROP_CARD_BACKDROP_ENABLED || !routeDrop) return null;
    if (isDropFamily(routeDrop, 'poncho_drifella')) {
      return createDropCardBackdropItems(PONCHO_DROP_CARD_BACKDROP_CONFIG);
    }
    if (isDropFamily(routeDrop, 'little_swag_hoodies')) {
      return createDropCardBackdropItems(HOODIE_DROP_CARD_BACKDROP_CONFIG);
    }
    return createDropCardBackdropItems(
      LSB_DROP_CARD_BACKDROP_CONFIG,
    );
  }, [routeDrop]);
  const renderHeaderRight = ({ interactive }: { interactive: boolean }) => {
    const walletAction = showHeaderWalletButton ? (
      <button
        type="button"
        className="top__wallet-button secondary-light"
        onClick={interactive ? handleHeaderWalletSignIn : undefined}
        aria-label={interactive ? (publicKey ? 'Sign in with Solana' : 'Connect wallet and sign in with Solana') : undefined}
        tabIndex={interactive ? undefined : -1}
      >
        <span>Connect Wallet</span>
      </button>
    ) : (
      <div className="top__wallet-spacer" aria-hidden="true" />
    );
    const adminMenu = !canUseAdminMenu ? null : interactive ? (
      <div className="top__actions" ref={settingsRef}>
        <button
          type="button"
          className={`top__settings${settingsOpen ? ' top__settings--active' : ''}`}
          onClick={() => setSettingsOpen((prev) => !prev)}
          aria-label="App menu"
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
        >
          <FaTableCellsLarge aria-hidden />
        </button>
        {settingsOpen ? (
          <div className="top__submenu" role="menu" aria-label="App menu">
            {canUseAdminViewer && !ownerPickerOpened ? (
              <button
                type="button"
                className="link small top__submenu-nav"
                aria-expanded={ownerPickerOpened}
                onClick={() => {
                  setOwnerPickerOpened(true);
                }}
              >
                override address
              </button>
            ) : null}
            {canUseAdminViewer && ownerPickerOpened ? (
              <select
                id="admin-owner-picker"
                aria-label="Viewer owner"
                value={ownerPickerValue}
                onChange={(evt) => {
                  const value = evt.target.value.trim();
                  if (!connectedWallet || !value || value === connectedWallet) {
                    setAdminViewedOwner(null);
                    return;
                  }
                  setAdminViewedOwner(value);
                }}
              >
                {connectedWallet ? (
                  <option value={connectedWallet}>{connectedWallet}</option>
                ) : null}
                {adminViewedOwner && !deliveryOrderOwners.includes(adminViewedOwner) ? (
                  <option value={adminViewedOwner}>{adminViewedOwner}</option>
                ) : null}
                {deliveryOrderOwners
                  .filter((entry) => entry !== connectedWallet)
                  .map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
              </select>
            ) : null}
            <button
              type="button"
              className="link small top__submenu-nav"
              onClick={() => {
                navigate('/ff');
              }}
            >
              {adminMenuLabel('/fullfillment')}
            </button>
            <button
              type="button"
              className="link small top__submenu-nav"
              onClick={() => {
                navigate('/wip');
              }}
            >
              {adminMenuLabel('/wip')}
            </button>
            <button
              type="button"
              className="link small top__submenu-nav"
              onClick={() => {
                navigate('/notify_me');
              }}
            >
              {adminMenuLabel('/notify_me')}
            </button>
            {adminMenuDrops.map((drop) => (
              <button
                key={drop.dropId}
                type="button"
                className="link small top__submenu-nav"
                onClick={() => {
                  navigate(dropPath(drop.dropId));
                }}
              >
                {adminMenuLabel(dropPath(drop.dropId))}
              </button>
            ))}
            {canUseAdminViewer && canLoadMoreOwners ? (
              <button
                type="button"
                className="link small top__submenu-more"
                disabled={deliveryOrderOwnersLoadingMore}
                onClick={() => {
                  void fetchNextDeliveryOrderOwners();
                }}
              >
                {deliveryOrderOwnersLoadingMore ? 'Loading more owners…' : 'Show more owners'}
              </button>
            ) : null}
            {canUseAdminViewer && deliveryOrderOwnersErrorMessage ? (
              <div className="error small">{deliveryOrderOwnersErrorMessage}</div>
            ) : null}
            <div className="muted small top__build-info">{BUILD_INFO}</div>
          </div>
        ) : null}
      </div>
    ) : (
      <div className="top__actions">
        <button type="button" className="top__settings" tabIndex={-1}>
          <FaTableCellsLarge aria-hidden />
        </button>
      </div>
    );

    return (
      <>
        {walletAction}
        {adminMenu}
      </>
    );
  };

  return (
    <div className="page" ref={pageRef}>
      {dropCardBackdropItems ? <DropCardsBackdrop items={dropCardBackdropItems} /> : null}
      {toast ? (
        <div className={`toast${toastVisible ? '' : ' toast--hidden'}`} role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      {revealOverlayNode}
      <div className={primaryFrameClassName}>
        <ShopHeader scrollHomeToTop renderRight={renderHeaderRight} />

        {!routeDrop && upcomingDropRoute ? (
          <MintPanel
            onMint={() => undefined}
            busy={false}
            title={upcomingDropRoute.title}
            boxMedia={upcomingMintPreviewMedia}
            boxNamePrefix={upcomingDropRoute.boxNamePrefix}
            priceSol={0}
            discountPriceSol={0}
            maxSupply={1}
            maxPerTx={1}
            terminalAction={{
              statusText: 'Soon',
              buttonText: 'Notify me',
              onClick: () => setNotifyOverlayOpen(true),
            }}
          />
        ) : !routeDrop ? (
          <DropsPanel />
        ) : (
          <MintPanel
            stats={effectiveMintStats}
            onMint={handleMint}
            busy={minting}
            onError={showToast}
            title={routeDrop.collectionName}
            boxMedia={mintPreviewMedia}
            boxNamePrefix={routeDrop.namePrefix}
            dropId={routeDrop.dropId}
            priceSol={routeDrop.priceSol}
            discountPriceSol={routeDrop.discountPriceSol}
            maxSupply={routeDrop.maxSupply}
            maxPerTx={routeDrop.maxPerTx}
            discountAvailable={discountAvailable}
            discountMaxQuantity={publicKey ? discountRemainingCount : undefined}
            onDiscountMint={handleDiscountMint}
            discountBusy={discountMinting || minting || walletBusy}
            onStripePaymentClick={handleStripePayment}
            stripePaymentVisible={
              Boolean(routeStripePaymentMode) &&
              Boolean(routeStripePaymentPriceLabel) &&
              isDirectDeliveryItemsPerBox(routeDrop.itemsPerBox) &&
              routeDrop.mintSelection?.kind === 'size'
            }
            stripePaymentBusy={stripePaymentLoading}
            stripePaymentPriceLabel={routeStripePaymentPriceLabel}
            mintSelection={routeDrop.mintSelection}
            showSizeInfo={isDropFamily(routeDrop.dropId, 'little_swag_hoodies') && routeDrop.mintSelection?.kind === 'size'}
            successfulMintToken={successfulMintToken}
          />
        )}
      </div>

      <section className="app-section inventory-section">
        <div className="app-section__head">
          <div className="app-section__title">Inventory</div>
        </div>
        <InventoryGrid
          items={inventoryItems}
          selected={selected}
          onToggle={toggleSelected}
          pendingRevealIds={pendingRevealIds}
          canRevealItem={(item) => canOpenBoxesForDropId(item.dropId)}
          onReveal={async (id, rect) => {
            if (blockViewerModeAction()) return;
            if (!publicKey) {
              setVisible(true);
              return;
            }
            const revealItem = inventoryIndex.get(id);
            const revealDropId = revealItem?.dropId || routeDrop?.dropId;
            if (!revealDropId) return;
            if (!canOpenBoxesForDropId(revealDropId)) return;
            preloadRevealSounds(revealDropId);
            preloadPonchoRevealPackAssetsForDropId(revealDropId);
            preloadBoxFrames(1, revealClickMaxForDropId(revealDropId), revealDropId);
            preloadBoxFrames(revealAutoplayStartForDropId(revealDropId), revealFrameCountForDropId(revealDropId), revealDropId);
            const refreshedRect = findInventoryRect(id);
            openRevealOverlay(id, refreshedRect || rect);
            const signedIn = await ensureSignedIn();
            if (!signedIn) {
              if (revealOverlayRef.current?.id === id) {
                closeRevealOverlay();
              }
            }
          }}
          revealLoadingId={revealLoading}
          revealDisabled={Boolean(revealLoading) || Boolean(startOpenLoading) || Boolean(revealOverlay)}
          emptyStateVisibility={inventoryEmptyStateVisibility}
        />
        {startOpenLoading ? <div className="muted">Sending {shortAddress(startOpenLoading)} to the vault…</div> : null}
      </section>

      <Modal
        open={deliveryOpen}
        title="Shipment"
        onClose={() => {
          setDeliveryOpen(false);
        }}
      >
        <div className="modal-form delivery-modal">
          <div className="delivery-modal__summary">
            <div>
              <div className="card__title">{selectionSummary}</div>
            </div>
          </div>

          {!publicKey ? <div className="muted small">Connect a wallet to ship items.</div> : null}
          <DeliveryForm
            mode="modal"
            onSubmit={handleShip}
            defaultEmail={viewedProfile?.email || ''}
            itemsPerBox={selectedDropConfig?.itemsPerBox}
            boxNamePrefix={selectedDropConfig?.namePrefix}
            figureNamePrefix={selectedDropConfig?.figureNamePrefix}
            dropFamily={selectedDropConfig?.dropFamily}
            submitDisabled={!deliverableItems.length || !publicKey}
            countryCode={deliveryCountryCode}
            onCountryCodeChange={setDeliveryCountryCode}
            submitLabel={deliveryCtaLabel}
          />
        </div>
      </Modal>

      <Modal open={claimOpen} title="Secret Code" onClose={closeClaimModal} closeOnEscape={false}>
        <ClaimForm
          onClaim={handleClaim}
          onSuccess={closeClaimModal}
          onDismiss={closeClaimModal}
          mode="modal"
          showTitle={false}
          itemsPerBox={routeDrop?.itemsPerBox}
          boxNamePrefix={routeDrop?.namePrefix}
          figureNamePrefix={routeDrop?.figureNamePrefix}
        />
      </Modal>

      {activeError ? <div className="error">{activeError}</div> : null}
      <section className="app-section shipments-section">
        <div className="app-section__head">
          <div className="app-section__title">Shipments</div>
        </div>
        {shipmentsReady ? (
          deliveryOrders.length ? (
          <div className="delivery-list">
            {deliveryOrders.map((order) => {
              return (
                <div key={`${order.dropId}:${order.deliveryId}`} className="delivery-row">
                  <div className="delivery-row__head">
                    <div>
                      <div className="delivery-row__title">{dropById.get(order.dropId)?.collectionName || order.dropId}</div>
                      <div className="muted small">{formatOrderDate(order)}</div>
                    </div>
                    <div className="delivery-status">{displayOrderStatus(order)}</div>
                  </div>
                  {order.items.length ? (
                    renderShipmentItems(order)
                  ) : (
                    <div className="muted small">Items unavailable.</div>
                  )}
                </div>
              );
            })}
          </div>
          ) : (
          <div
            className={`muted small${shipmentsEmptyStateVisibility === 'hidden' ? ' empty-state--hidden' : ''}`}
            aria-hidden={shipmentsEmptyStateVisibility === 'hidden'}
          >
            {shipmentsEmptyContent}
          </div>
          )
        ) : (
          <div className="muted small empty-state--hidden" aria-hidden="true">
            {shipmentsEmptyContent}
          </div>
        )}
      </section>

      {receiptItems.length && shipmentsContentVisible ? (
        <section className="app-section receipts-section">
          <div className="app-section__head receipts-section__head">
            <div className="app-section__title">Receipts</div>
            <div className="app-section__actions">
              <button
                type="button"
                className="receipts-section__code-button"
                onClick={() => {
                  if (blockViewerModeAction()) return;
                  setClaimOpen(true);
                }}
              >
                Enter code
              </button>
            </div>
          </div>
          <InventoryGrid
            items={receiptItems}
            selected={selected}
            onToggle={toggleSelected}
            onViewItem={openReceiptImageViewer}
            className="inventory--receipts"
          />
        </section>
      ) : null}

      {selectedCount ? (
        <div className="selection-panel">
          <div className="selection-panel__left">
            <div className="selection-panel__preview">
              {selectedPreview.map(({ item, previewImage }, idx) => {
                return previewImage ? (
                  <div
                    key={item.id}
                    className="selection-panel__thumb"
                    style={{ backgroundImage: `url(${previewImage})`, zIndex: idx + 1 }}
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    key={item.id}
                    className="selection-panel__thumb selection-panel__thumb--empty"
                    style={{ zIndex: idx + 1 }}
                    aria-hidden="true"
                  >
                    <span>#</span>
                  </div>
                );
              })}
              {selectedOverflow ? (
                <div className="selection-panel__more" style={{ zIndex: selectedPreview.length + 2 }}>
                  +{selectedOverflow}
                </div>
              ) : null}
            </div>
          </div>
          <div className="selection-panel__actions">
            <button type="button" className="quiet" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
            {canViewSelected ? (
              <button
                type="button"
                className="selection-panel__view"
                onClick={handleViewSelectedPonchoCard}
              >
                <svg
                  aria-hidden="true"
                  focusable="false"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <rect
                    x="3.25"
                    y="1.75"
                    width="9.5"
                    height="12.5"
                    rx="2.5"
                    stroke="currentColor"
                    strokeWidth="1.75"
                  />
                </svg>
                <span>View</span>
              </button>
            ) : null}
            {canOpenSelected ? (
	              <button
	                type="button"
	                className="selection-panel__open"
	                onClick={handleOpenSelectedBox}
	                disabled={Boolean(startOpenLoading)}
	              >
                <FaBoxOpen aria-hidden="true" focusable="false" size={18} />
                <span>{startOpenLoading === selectedBox?.id ? openActionProgressForDropId(selectedBox?.dropId) : openActionLabelForDropId(selectedBox?.dropId)}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="selection-panel__ship"
              onClick={handleOpenShip}
            >
              <FaPlane aria-hidden="true" focusable="false" size={16} />
              <span>Send</span>
            </button>
          </div>
        </div>
      ) : null}
      {upcomingDropRoute ? (
        <NotifyOverlay open={notifyOverlayOpen} onClose={() => setNotifyOverlayOpen(false)} />
      ) : null}
    </div>
  );
}

export default App;
