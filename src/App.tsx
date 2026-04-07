import { useCallback, useEffect, useMemo, useRef, useState, type TransitionEvent } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Connection, LAMPORTS_PER_SOL, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { FaBoxOpen, FaPlane, FaTableCellsLarge } from 'react-icons/fa6';
import { MintPanel } from './components/MintPanel';
import { DropsPanel } from './components/DropsPanel';
import { InventoryGrid } from './components/InventoryGrid';
import { DeliveryForm } from './components/DeliveryForm';
import { Modal } from './components/Modal';
import { ClaimForm } from './components/ClaimForm';
import { useMintProgress } from './hooks/useMintProgress';
import { useInventory } from './hooks/useInventory';
import { usePendingOpenBoxes } from './hooks/usePendingOpenBoxes';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import {
  getProfile,
  listDeliveryOrderOwners,
  recoverMyDeliveryOrders,
  requestClaimTx,
  requestDeliveryTx,
  revealDudes,
  saveEncryptedAddress,
  issueReceipts,
} from './lib/api';
import { isRetryableCallableError, retryWithBackoff } from './lib/callableErrors';
import { buildMintBoxesTx, buildMintDiscountedBoxTx, buildStartOpenBoxTx, fetchBoxMinterConfig, fetchDiscountMintRecordUsedCount } from './lib/boxMinter';
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
import { joinDropAssetUrl, normalizeBoxDisplayImage, resolveDropContent } from './lib/dropContent';
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
  sendPreparedTransaction,
  shortAddress,
} from './lib/solana';
import { calculateDeliveryLamports } from './lib/shipping';
import {
  DeliveryOrderSummary,
  InventoryItem,
  PendingOpenBox,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
} from './types';
import { type FrontendDeploymentConfig, getFrontendDrop, isDropFamily } from './config/deployment';
import { getNormalizedPathname, navigate } from './navigation';
import {
  dropPath,
  listFrontendDrops,
  resolveFrontendDropByPath,
  rpcEndpointForCluster,
} from './lib/dropConfig';
import { getInventoryRevealRect } from './lib/inventoryMediaRect';
import {
  calcPonchoDrifellaAbsoluteCardRect,
  calcPonchoDrifellaCardRect,
  calcPonchoDrifellaRevealTargetRect,
} from './lib/revealOverlayLayout';

const ADDRESS_ENCRYPTION_PUBLIC_KEY = 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=';
const BUILD_INFO = getBuildInfo();
const REVEAL_CLOSE_FALLBACK_MS = 380;
const PONCHO_OUTSIDE_TAP_DISMISS_LOCK_MS = 1_300;

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
const ADMIN_WALLETS = new Set<string>([
  'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
]);
const ADMIN_OWNER_DOC_PAGE_SIZE = 200;
const ADMIN_VIEWER_READ_ONLY_MESSAGE = 'Admin viewer mode is read-only.';

type OverlayRect = { left: number; top: number; width: number; height: number };

type RevealOverlayPhase = 'preparing' | 'ready' | 'revealed';

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
  viewerMode?: 'poncho-card';
  viewerFigureId?: number;
  hasRevealAttempted?: boolean;
  autoOpening?: boolean;
  autoMode?: 'normal' | 'fast';
};

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

type AppProps = {
  currentPath?: string;
};

function App({ currentPath }: AppProps) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { publicKey, sendTransaction } = wallet;
  const normalizedCurrentPath = useMemo(
    () => (currentPath ? currentPath : getNormalizedPathname()),
    [currentPath],
  );
  const routeDrop = useMemo(() => resolveFrontendDropByPath(normalizedCurrentPath), [normalizedCurrentPath]);
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
  const connectedWallet = publicKey?.toBase58();
  const [adminViewedOwner, setAdminViewedOwner] = useState<string | null>(null);
  const isAdminWallet = Boolean(connectedWallet && ADMIN_WALLETS.has(connectedWallet));
  const isSignedInWallet = Boolean(token && connectedWallet && profile?.wallet === connectedWallet);
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
  const forcedSoldOutStats = useMemo(
    () =>
      routeDrop
        ? {
            minted: routeDrop.maxSupply,
            total: routeDrop.maxSupply,
            remaining: 0,
            maxPerTx: routeDrop.maxPerTx,
          }
        : undefined,
    [routeDrop],
  );
  const activeMintStatsFallback = useMemo(
    () =>
      routeDrop
        ? {
            minted: 0,
            total: routeDrop.maxSupply,
            remaining: routeDrop.maxSupply,
            maxPerTx: routeDrop.maxPerTx,
          }
        : undefined,
    [routeDrop],
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
  const [discountEligible, setDiscountEligible] = useState(false);
  const [discountRemainingCount, setDiscountRemainingCount] = useState(0);
  const [discountChecking, setDiscountChecking] = useState(false);
  const [guestDiscountReady, setGuestDiscountReady] = useState(false);
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
  const [walletIdleReady, setWalletIdleReady] = useState(false);
  const [shipmentsReady, setShipmentsReady] = useState(false);
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
  const defaultBoxImage = routeDrop ? boxImageForDropId(routeDrop.dropId) : undefined;
  const revealFrameSequence = revealFrameSequenceForDropId(revealOverlay?.dropId || routeDrop?.dropId);
  const revealMediaBase = revealMediaBaseForDropId(revealOverlay?.dropId || routeDrop?.dropId);

  const TOAST_VISIBLE_MS = 1800;
  const TOAST_FADE_MS = 250;
  const showToast = (message: string) => {
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
  };

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
    if (canUseAdminViewer) return;
    if (adminViewedOwner) setAdminViewedOwner(null);
    if (settingsOpen) setSettingsOpen(false);
  }, [adminViewedOwner, canUseAdminViewer, settingsOpen]);

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
    promise = signIn()
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
    const targetRect = calcRevealTargetRectForDrop(
      window.innerWidth,
      window.innerHeight,
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
    if (!revealOverlay) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') closeRevealOverlay();
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [revealOverlay, closeRevealOverlay]);

  useEffect(() => {
    if (!revealOverlay) return;
    const updateTargetRect = () => {
      if (revealOverlayResizeRafRef.current) {
        cancelAnimationFrame(revealOverlayResizeRafRef.current);
      }
      revealOverlayResizeRafRef.current = requestAnimationFrame(() => {
        revealOverlayResizeRafRef.current = null;
        setRevealOverlay((prev) => {
          if (!prev) return prev;
          const nextTarget =
            prev.viewerMode === 'poncho-card'
              ? calcPonchoDrifellaAbsoluteCardRect(
                  calcPonchoDrifellaRevealTargetRect(window.innerWidth, window.innerHeight),
                )
              : calcRevealTargetRectForDrop(
                  window.innerWidth,
                  window.innerHeight,
                  prev.dropId,
                  boxAspectRatioForDropId(prev.dropId),
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
    return () => {
      window.removeEventListener('resize', updateTargetRect);
      window.removeEventListener('orientationchange', updateTargetRect);
      if (revealOverlayResizeRafRef.current) {
        cancelAnimationFrame(revealOverlayResizeRafRef.current);
        revealOverlayResizeRafRef.current = null;
      }
    };
  }, [boxAspectRatioForDropId, revealOverlay]);

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
  const canOpenSelected = selectedCount === 1 && selectedItems[0]?.kind === 'box';
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
    async (tx: VersionedTransaction, targetConnection: Connection) => {
      if (wallet.signTransaction) {
        const signed = await wallet.signTransaction(tx);
        const raw = signed.serialize();
        return targetConnection.sendRawTransaction(raw, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
      }
      return sendTransaction(tx, targetConnection, { skipPreflight: false });
    },
    [sendTransaction, wallet],
  );

  const mintedOut = useMemo(() => {
    return !effectiveMintStats || effectiveMintStats.remaining <= 0;
  }, [effectiveMintStats]);

  useEffect(() => {
    if (publicKey || mintedOut || walletBusy) {
      setGuestDiscountReady(false);
      return;
    }
    const timer = window.setTimeout(() => setGuestDiscountReady(true), 300);
    return () => window.clearTimeout(timer);
  }, [mintedOut, publicKey, walletBusy]);

  const discountCtaState = useMemo(() => {
    if (mintedOut) return { visible: false, label: '' };
    if (walletBusy) return { visible: false, label: '' };
    if (!publicKey) return { visible: guestDiscountReady, label: 'Connect wallet' };
    if (discountChecking) return { visible: false, label: '' };
    return { visible: discountEligible, label: '' };
  }, [discountChecking, discountEligible, guestDiscountReady, mintedOut, publicKey, walletBusy]);

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

  const handleMint = async (quantity: number) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const mintDrop = requireRouteDrop('mint');
    if (!routeConnection) throw new Error('Missing route connection for mint');
    setMinting(true);
    try {
      const cfg = await fetchBoxMinterConfig(routeConnection, mintDrop);
      const sendOnce = async () => {
        const tx = await buildMintBoxesTx(routeConnection, cfg, publicKey, quantity, mintDrop);
        const sig = await signAndSendViaConnection(tx, routeConnection);
        await routeConnection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      try {
        await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Transaction expired before you approved it. Please approve again…');
        await sendOnce();
      }
      addLocalMintedBoxes(quantity, mintDrop.dropId);
      await Promise.all([shouldFetchMintStats ? refetchStats() : Promise.resolve(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      throw err;
    } finally {
      setMinting(false);
    }
  };

  const handleDiscountMint = async (quantity: number) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) {
      setVisible(true);
      return;
    }
    const mintDrop = requireRouteDrop('discount mint');
    if (!routeConnection) throw new Error('Missing route connection for discount mint');
    if (mintedOut || discountMinting || minting) return;
    const maxDiscountQuantity = Math.max(0, discountRemainingCount);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > maxDiscountQuantity) {
      if (maxDiscountQuantity > 0) {
        showToast(`Discount available for up to ${dropAssetCount(mintDrop, 'box', maxDiscountQuantity)}`);
      } else {
        showToast('Wallet is not eligible for the discount');
      }
      return;
    }

    setDiscountMinting(true);
    try {
      const proof = await getDiscountProof(mintDrop.dropId, publicKey.toBase58());
      if (!proof) {
        setDiscountEligible(false);
        setDiscountRemainingCount(0);
        showToast('Wallet is not eligible for the discount');
        return;
      }

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
        const tx = await buildMintDiscountedBoxTx(routeConnection, cfg, publicKey, quantity, proof, mintDrop);
        const sig = await signAndSendViaConnection(tx, routeConnection);
        await routeConnection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      try {
        await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Transaction expired before you approved it. Please approve again…');
        await sendOnce();
      }
      addLocalMintedBoxes(quantity, mintDrop.dropId);
      const nextUsedCount = onchainUsedCount + quantity;
      const nextRemainingCount = Math.max(0, onchainDiscountAllowance - nextUsedCount);
      setDiscountUsedCount(nextUsedCount);
      setDiscountRemainingCount(nextRemainingCount);
      setDiscountEligible(nextRemainingCount > 0);
      if (connectedWallet) persistDiscountUsedCount(activeDiscountScope, activeDiscountVersion, connectedWallet, nextUsedCount);
      await Promise.all([shouldFetchMintStats ? refetchStats() : Promise.resolve(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      showToast(err instanceof Error ? err.message : `Failed to mint discounted ${boxLabelForDropId(mintDrop.dropId)}`);
    } finally {
      setDiscountMinting(false);
    }
  };

  const handleStartOpenBox = async (item: InventoryItem) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) throw new Error(`Connect wallet to open a ${boxLabelForDropId(item.dropId)}`);
    setStartOpenLoading(item.id);
    try {
      const targetDrop = requireKnownDropConfig(item.dropId, `inventory item ${item.id}`);
      const targetConnection = getDropConnection(targetDrop.dropId);
      const cfg = await fetchBoxMinterConfig(targetConnection, targetDrop);
      const sendOnce = async () => {
        const tx = await buildStartOpenBoxTx(targetConnection, cfg, publicKey, new PublicKey(item.id), targetDrop);
        const sig = await signAndSendViaConnection(tx, targetConnection);
        await targetConnection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      try {
        await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Transaction expired before you approved it. Please approve again…');
        await sendOnce();
      }
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
    if (revealOverlay.viewerMode === 'poncho-card') {
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
      preloadRevealSounds(box.dropId);
      preloadPonchoRevealPackAssetsForDropId(box.dropId);
      preloadBoxFrames(1, revealClickMaxForDropId(box.dropId), box.dropId);
      preloadBoxFrames(revealAutoplayStartForDropId(box.dropId), revealFrameCountForDropId(box.dropId), box.dropId);
      if (typeof window === 'undefined') return;
      const originRect = findInventoryRect(box.id);
      const fallbackTarget = calcRevealTargetRectForDrop(
        window.innerWidth,
        window.innerHeight,
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
      calcPonchoDrifellaRevealTargetRect(window.innerWidth, window.innerHeight),
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
      const session = isSignedInWallet ? { profile } : await signIn();
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
          signAndSendViaConnection(tx, deliveryConnection),
        );
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
        resp = await requestTx();
        sig = await sendPreparedTransaction(resp.encodedTx, deliveryConnection, (tx) =>
          signAndSendViaConnection(tx, deliveryConnection),
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
      setVisible(true);
      return;
    }
    if (authLoading) return;
    try {
      await signIn();
    } catch (err) {
      if (isUserRejectedError(err)) return;
      showToast(err instanceof Error ? err.message : 'Failed to sign in');
    }
  };

  const handleClaim = async ({ code }: { code: string }) => {
    if (blockViewerModeAction()) return;
    if (!publicKey) throw new Error('Connect wallet to claim');
    // Ensure wallet session exists for authenticated callable.
    if (!isSignedInWallet) {
      await signIn();
    }
    const requestTx = () => requestClaimTx(publicKey.toBase58(), code);
    let resp = await requestTx();
    let claimDrop = requireKnownDropConfig(resp.dropId, 'claim transaction response');
    let claimConnection = getDropConnection(claimDrop.dropId);
    let sig: string;
    try {
      sig = await sendPreparedTransaction(resp.encodedTx, claimConnection, (tx) =>
        signAndSendViaConnection(tx, claimConnection),
      );
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
      resp = await requestTx();
      claimDrop = requireKnownDropConfig(resp.dropId, 'claim transaction retry response');
      claimConnection = getDropConnection(claimDrop.dropId);
      sig = await sendPreparedTransaction(resp.encodedTx, claimConnection, (tx) =>
        signAndSendViaConnection(tx, claimConnection),
      );
    }
    showToast(`Claimed certificates · ${sig}`);
    await refetchInventory();
    return {
      itemsPerBox: claimDrop.itemsPerBox,
      boxNamePrefix: claimDrop.namePrefix,
      figureNamePrefix: claimDrop.figureNamePrefix,
    };
  };

  const profileLoadingForView = viewedProfileLoading && (!profile || profile.wallet !== owner);
  const deliveryOrders = viewedProfile?.orders || [];
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
  const shipmentsEmptyContent = !viewedProfile
    ? isSignedInWallet && owner
      ? profileLoadingForView
        ? 'Loading shipments…'
        : 'No shipments yet.'
      : (
        <span className="shipments-signin">
          <button type="button" className="link" onClick={handleSignInForShipments} disabled={authLoading}>
            Sign in
          </button>
          <span>to view your shipments.</span>
        </span>
      )
    : 'No shipments yet.';
  const shipmentsEmptyStateVisibility = connectedWallet
    ? authReady
      ? 'visible'
      : 'hidden'
    : walletIdleReady
      ? 'visible'
      : 'hidden';
  const shipmentsContentVisible =
    shipmentsReady && (deliveryOrders.length > 0 || shipmentsEmptyStateVisibility === 'visible');

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
            if (item.kind === 'box') {
              const boxImage = normalizeBoxDisplayImage(order.dropId);
              return (
                <div
                  key={`${order.dropId}:${order.deliveryId}:${item.kind}:${item.refId}:${index}`}
                  className="figure-tile shipment-item-tile"
                  draggable={false}
                  onDragStart={(evt) => evt.preventDefault()}
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

            return (
              <div
                key={`${order.dropId}:${order.deliveryId}:${item.kind}:${item.refId}:${index}`}
                className={`figure-tile shipment-item-tile${canViewPonchoCard ? ' shipment-item-tile--interactive' : ''}`}
                role={canViewPonchoCard ? 'button' : undefined}
                tabIndex={canViewPonchoCard ? 0 : undefined}
                aria-label={canViewPonchoCard ? `View ${label}` : undefined}
                draggable={false}
                onDragStart={(evt) => evt.preventDefault()}
                onClick={
                  canViewPonchoCard
                    ? (evt) => {
                        openPonchoCardViewer({
                          overlayId: `shipment:${order.dropId}:${order.deliveryId}:${item.refId}:${index}`,
                          dropId: order.dropId,
                          name: label,
                          image: primarySrc || fallbackSrc,
                          figureId: item.refId,
                          originRect: getInventoryRevealRect(evt.currentTarget),
                        });
                      }
                    : undefined
                }
                onKeyDown={
                  canViewPonchoCard
                    ? (evt) => {
                        if (evt.key !== 'Enter' && evt.key !== ' ') return;
                        evt.preventDefault();
                        openPonchoCardViewer({
                          overlayId: `shipment:${order.dropId}:${order.deliveryId}:${item.refId}:${index}`,
                          dropId: order.dropId,
                          name: label,
                          image: primarySrc || fallbackSrc,
                          figureId: item.refId,
                          originRect: getInventoryRevealRect(evt.currentTarget),
                        });
                      }
                    : undefined
                }
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
    [figureMetadataByKey, getDropContent, mergeLoadedFigureMetadata, openPonchoCardViewer, requireKnownDropConfig],
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
  const revealOverlayUsesPonchoRenderer = Boolean(
    revealOverlay &&
      !revealOverlayUsesPonchoViewer &&
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
  const deliveryOrderOwnersErrorMessage = deliveryOrderOwnersError instanceof Error ? deliveryOrderOwnersError.message : '';
  const canLoadMoreOwners = Boolean(deliveryOrderOwnersHasNextPage);
  const activeError = authError && !isUserRejectedError(authError) ? authError : viewedProfileErrorMessage;

  return (
    <div className="page">
      {toast ? (
        <div className={`toast${toastVisible ? '' : ' toast--hidden'}`} role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      {revealOverlayNode}
      <header className={`top${canUseAdminViewer ? ' top--with-admin' : ''}`}>
        <div className="brand">
          <a
            href="/"
            className="brand__home-link"
            aria-label="Go to mons.shop home"
            draggable={false}
            onClick={(evt) => {
              evt.preventDefault();
              navigate('/');
            }}
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
        {canUseAdminViewer ? (
          <div className="top__actions" ref={settingsRef}>
            <button
              type="button"
              className={`top__settings${settingsOpen ? ' top__settings--active' : ''}`}
              onClick={() => setSettingsOpen((prev) => !prev)}
              aria-label="Admin settings"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
            >
              <FaTableCellsLarge aria-hidden />
            </button>
            {settingsOpen ? (
              <div className="top__submenu" role="menu" aria-label="Admin settings">
                {!ownerPickerOpened ? (
                  <button
                    type="button"
                    className="link small top__submenu-nav"
                    aria-expanded={ownerPickerOpened}
                    onClick={() => {
                      setOwnerPickerOpened(true);
                    }}
                  >
                    address override
                  </button>
                ) : null}
                {ownerPickerOpened ? (
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
                {canLoadMoreOwners ? (
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
                {deliveryOrderOwnersErrorMessage ? <div className="error small">{deliveryOrderOwnersErrorMessage}</div> : null}
                <div className="muted small top__build-info">{BUILD_INFO}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {!routeDrop ? (
        <DropsPanel />
      ) : (
        <MintPanel
          stats={effectiveMintStats}
          onMint={handleMint}
          busy={minting}
          onError={showToast}
          title={routeDrop.collectionName}
          boxImageSrc={defaultBoxImage}
          boxAspectRatio={boxAspectRatioForDropId(routeDrop.dropId)}
          boxNamePrefix={routeDrop.namePrefix}
          priceSol={routeDrop.priceSol}
          discountPriceSol={routeDrop.discountPriceSol}
          maxSupply={routeDrop.maxSupply}
          maxPerTx={routeDrop.maxPerTx}
          secondaryHref={routeDrop.secondaryMarketHref}
          discountVisible={discountCtaState.visible}
          discountLabel={discountCtaState.label}
          discountMaxQuantity={publicKey ? discountRemainingCount : undefined}
          onDiscountClick={handleDiscountMint}
          discountBusy={discountMinting || discountChecking || minting || walletBusy}
        />
      )}

	      <section className="card">
	        <div className="card__title">Inventory</div>
		        <InventoryGrid
		          items={inventoryItems}
		          selected={selected}
		          onToggle={toggleSelected}
		          pendingRevealIds={pendingRevealIds}
		          onReveal={async (id, rect) => {
                if (blockViewerModeAction()) return;
		            if (!publicKey) {
		              setVisible(true);
		              return;
		            }
                const revealItem = inventoryIndex.get(id);
                const revealDropId = revealItem?.dropId || routeDrop?.dropId;
                if (!revealDropId) return;
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

      <Modal open={claimOpen} title="Secret Code" onClose={() => setClaimOpen(false)}>
        <ClaimForm
          onClaim={handleClaim}
          onSuccess={() => setClaimOpen(false)}
          mode="modal"
          showTitle={false}
          itemsPerBox={routeDrop?.itemsPerBox}
          boxNamePrefix={routeDrop?.namePrefix}
          figureNamePrefix={routeDrop?.figureNamePrefix}
        />
      </Modal>

      {activeError ? <div className="error">{activeError}</div> : null}
      <section className="card">
        <div className="card__head">
          <div className="card__title">Shipments</div>
        </div>
        {shipmentsReady ? (
          deliveryOrders.length ? (
          <div className="delivery-list">
            {deliveryOrders.map((order) => {
              return (
                <div key={`${order.dropId}:${order.deliveryId}`} className="delivery-row">
                  <div className="card__head">
                    <div>
                      <div className="card__title">{dropById.get(order.dropId)?.collectionName || order.dropId}</div>
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
        <section className="card">
          <div className="card__head">
            <div className="card__title">Receipts</div>
            <div className="card__actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  if (blockViewerModeAction()) return;
                  setClaimOpen(true);
                }}
              >
                Enter code
              </button>
            </div>
          </div>
          <InventoryGrid items={receiptItems} selected={selected} onToggle={toggleSelected} className="inventory--receipts" />
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
    </div>
  );
}

export default App;
