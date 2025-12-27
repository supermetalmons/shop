import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { FaBoxOpen, FaPlane } from 'react-icons/fa6';
import { MintPanel } from './components/MintPanel';
import { InventoryGrid } from './components/InventoryGrid';
import { DeliveryForm } from './components/DeliveryForm';
import { Modal } from './components/Modal';
import { ClaimForm } from './components/ClaimForm';
import { useMintProgress } from './hooks/useMintProgress';
import { useInventory } from './hooks/useInventory';
import { usePendingOpenBoxes } from './hooks/usePendingOpenBoxes';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import {
  requestClaimTx,
  requestDeliveryTx,
  revealDudes,
  saveEncryptedAddress,
  removeAddress,
  issueReceipts,
} from './lib/api';
import { buildMintBoxesTx, buildMintDiscountedBoxTx, buildStartOpenBoxTx, discountMintRecordPda, fetchBoxMinterConfig } from './lib/boxMinter';
import { getDiscountProof, isDiscountListed } from './lib/discounts';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import { soundPlayer } from './lib/SoundPlayer';
import {
  encryptAddressPayload,
  isBlockhashExpiredError,
  lamportsToSol,
  normalizeCountryCode,
  sendPreparedTransaction,
  shortAddress,
} from './lib/solana';
import { countryLabel, findCountryByCode } from './lib/countries';
import { DeliveryOrderSummary, InventoryItem, PendingOpenBox, ProfileAddress } from './types';
import { FRONTEND_DEPLOYMENT } from './config/deployment';

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
      const name = typeof entry.name === 'string' ? entry.name : undefined;
      const image = typeof entry.image === 'string' ? entry.image : undefined;
      entries.push({ id, createdAt, name, image });
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
const DISCOUNT_USED_VERSION = `${FRONTEND_DEPLOYMENT.boxMinterProgramId}:${FRONTEND_DEPLOYMENT.discountMerkleRoot}`;

function discountUsedKey(wallet?: string) {
  return wallet
    ? `${DISCOUNT_USED_STORAGE_PREFIX}:${DISCOUNT_USED_VERSION}:${wallet}`
    : `${DISCOUNT_USED_STORAGE_PREFIX}:${DISCOUNT_USED_VERSION}:disconnected`;
}

function cleanupDiscountUsedKeys(wallet: string, keepKey: string) {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    const walletSuffix = `:${wallet}`;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(`${DISCOUNT_USED_STORAGE_PREFIX}:`)) continue;
      if (!key.endsWith(walletSuffix)) continue;
      if (key !== keepKey) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.localStorage?.removeItem(key));
  } catch {
    // ignore storage failures
  }
}

function loadDiscountUsed(wallet?: string): boolean {
  if (typeof window === 'undefined' || !wallet) return false;
  const key = discountUsedKey(wallet);
  cleanupDiscountUsedKeys(wallet, key);
  try {
    return window.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function persistDiscountUsed(wallet: string, used: boolean) {
  if (typeof window === 'undefined') return;
  const key = discountUsedKey(wallet);
  cleanupDiscountUsedKeys(wallet, key);
  try {
    if (used) {
      window.localStorage?.setItem(key, '1');
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
  const timestamp = order.processedAt ?? order.createdAt;
  if (!timestamp) return 'Date pending';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

const MAX_SHIPMENT_ITEMS = 24;
const EMPTY_INVENTORY: InventoryItem[] = [];
const EMPTY_PENDING_OPEN: PendingOpenBox[] = [];
const REVEAL_BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)
const REVEAL_NOTE_OFFSET = 28;
// Keep locally-inserted pending reveals visible for a short grace window while on-chain indexing catches up.
const LOCAL_PENDING_GRACE_MS = 2 * 60 * 1000;
const RECENT_REVEALS_LIMIT = 10;
const FIGURE_METADATA_RETRY_MS = 3000;
const BOX_FRAME_COUNT = 21;
const BOX_FRAME_CLICK_MAX = 8;
const BOX_FRAME_AUTOPLAY_START = 9;
const BOX_FRAME_MEDIA_START = 10;
const BOX_SOUND_REVEAL_URL = 'https://assets.mons.link/sounds/shop/unbox1p.mp3';
const BOX_SOUND_CLICK_URL = 'https://assets.mons.link/sounds/shop/click.mp3';

type OverlayRect = { left: number; top: number; width: number; height: number };

type RevealOverlayPhase = 'preparing' | 'ready' | 'revealed';

type LocalPendingReveal = {
  id: string;
  createdAt: number;
  name?: string;
  image?: string;
};

type LocalMintedBox = {
  id: string;
  createdAt: number;
};

type FigureMetadata = {
  id: number;
  name?: string;
  image?: string;
  attributes?: { trait_type: string; value: string }[];
};

type RevealOverlayState = {
  id: string;
  name: string;
  image: string;
  originRect: OverlayRect;
  targetRect: OverlayRect;
  phase: RevealOverlayPhase;
  frame: number;
  advanceClicks: number;
  revealedIds?: number[];
  hasRevealAttempted?: boolean;
  autoOpening?: boolean;
  autoMode?: 'normal' | 'fast';
};

function toOverlayRect(rect: DOMRect): OverlayRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function calcRevealTargetRect(viewportWidth: number, viewportHeight: number): OverlayRect {
  const maxWidth = viewportWidth * 0.65;
  const maxHeight = viewportHeight * 0.43;
  const width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * REVEAL_BOX_ASPECT_RATIO)));
  const height = Math.max(1, Math.floor(width / REVEAL_BOX_ASPECT_RATIO));
  const lift = Math.round(height * 0.42);
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.max(16, Math.round((viewportHeight - height) / 2) - lift),
    width,
    height,
  };
}

function formatRevealIds(ids?: number[]) {
  if (!ids || !ids.length) return 'Figures: none';
  return '';
}

function normalizeFigureImage(imageRaw?: string): string | undefined {
  if (!imageRaw) return imageRaw;
  if (imageRaw.includes('/figures/clean/')) return imageRaw;
  return imageRaw.replace('/figures/', '/figures/clean/');
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
    if ((a.name || '') !== (b.name || '')) return false;
    if ((a.image || '') !== (b.image || '')) return false;
  }
  return true;
}

function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { publicKey, sendTransaction } = wallet;
  const { data: mintStats, refetch: refetchStats } = useMintProgress();
  const {
    profile,
    token,
    loading: authLoading,
    error: authError,
    signIn,
    updateProfile,
  } = useSolanaAuth();
  const { data: inventoryData, refetch: refetchInventory, isFetched: inventoryFetched } = useInventory();
  const {
    data: pendingOpenBoxesData,
    refetch: refetchPendingOpenBoxes,
    isSuccess: pendingOpenBoxesSuccess,
  } = usePendingOpenBoxes();
  const inventory = inventoryData ?? EMPTY_INVENTORY;
  const pendingOpenBoxes = pendingOpenBoxesData ?? EMPTY_PENDING_OPEN;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState(false);
  const [discountMinting, setDiscountMinting] = useState(false);
  const [discountEligible, setDiscountEligible] = useState(false);
  const [discountChecking, setDiscountChecking] = useState(false);
  const [guestDiscountReady, setGuestDiscountReady] = useState(false);
  const [startOpenLoading, setStartOpenLoading] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState<string | null>(null);
  const [revealOverlay, setRevealOverlay] = useState<RevealOverlayState | null>(null);
  const [revealOverlayActive, setRevealOverlayActive] = useState(false);
  const [revealOverlayClosing, setRevealOverlayClosing] = useState(false);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryCost, setDeliveryCost] = useState<number | undefined>();
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
  const [addressId, setAddressId] = useState<string | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryAddOpen, setDeliveryAddOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [removeAddressLoading, setRemoveAddressLoading] = useState<string | null>(null);
  const owner = publicKey?.toBase58();
  const [discountUsed, setDiscountUsed] = useState<boolean>(() => loadDiscountUsed(owner));
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const [hiddenAssets, setHiddenAssets] = useState<Set<string>>(() => loadHiddenAssets(owner));
  const [localPendingReveals, setLocalPendingReveals] = useState<LocalPendingReveal[]>(() => loadPendingReveals(owner));
  const [recentRevealedBoxes, setRecentRevealedBoxes] = useState<string[]>(() => loadRecentReveals(owner));
  const [localMintedBoxes, setLocalMintedBoxes] = useState<LocalMintedBox[]>([]);
  const [inventorySnapshot, setInventorySnapshot] = useState<InventoryItem[]>([]);
  const [pendingOpenSnapshot, setPendingOpenSnapshot] = useState<PendingOpenBox[]>([]);
  const inventoryView = revealOverlay ? inventorySnapshot : inventory;
  const pendingOpenBoxesView = revealOverlay ? pendingOpenSnapshot : pendingOpenBoxes;
  const [localRevealedDudeIds, setLocalRevealedDudeIds] = useState<number[]>([]);
  const [figureMetadataById, setFigureMetadataById] = useState<Record<number, FigureMetadata>>({});
  const figureMetadataRef = useRef<Record<number, FigureMetadata>>({});
  const figureMetadataLoadingRef = useRef<Set<number>>(new Set());
  const figureMetadataRetryAtRef = useRef<Map<number, number>>(new Map());
  const authTokenRef = useRef<string | null>(null);
  const signInPromiseRef = useRef<Promise<boolean> | null>(null);
  const authReadyRef = useRef(false);
  const authLoadingRef = useRef(false);
  const openSelectedLockRef = useRef(false);
  const openSelectedBoxIdRef = useRef<string | null>(null);
  const localMintCounterRef = useRef(0);
  const knownBoxIdsRef = useRef<Set<string>>(new Set());
  const preloadedBoxFramesRef = useRef<Set<number>>(new Set());
  const boxFramePreloadImagesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const autoplayFramePreloadScheduledRef = useRef(false);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const videoPreloadRootRef = useRef<HTMLDivElement | null>(null);
  const videoPreloadKeyRef = useRef<string>('');
  const deferredOverlayActionsRef = useRef<Array<() => void>>([]);
  const revealOverlayRef = useRef<RevealOverlayState | null>(null);
  const revealDismissLockedUntilRef = useRef<number>(0);
  const revealOverlayActiveRef = useRef(false);
  const revealOverlayClosingRef = useRef(false);

  const defaultBoxImage = `${FRONTEND_DEPLOYMENT.paths.base}/box/tight.webp`;
  const boxFrameBase = `${FRONTEND_DEPLOYMENT.paths.base}/box/`;
  const revealMediaBase = `${FRONTEND_DEPLOYMENT.paths.base}/figures/small-rotating/`;

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

  useEffect(() => {
    authTokenRef.current = token;
  }, [token]);

  useEffect(() => {
    authReadyRef.current = authReady;
  }, [authReady]);

  useEffect(() => {
    authLoadingRef.current = authLoading;
  }, [authLoading]);

  const ensureSignedIn = async (): Promise<boolean> => {
    if (!publicKey) {
      setVisible(true);
      return false;
    }
    if (token) {
      authTokenRef.current = token;
      return true;
    }
    if (authTokenRef.current) return true;
    if (signInPromiseRef.current) return signInPromiseRef.current;

    // Wait briefly for Firebase session restoration after reload (avoid unnecessary wallet prompts).
    if (typeof window !== 'undefined' && (!authReadyRef.current || authLoadingRef.current)) {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        if (authTokenRef.current) return true;
        if (signInPromiseRef.current) return signInPromiseRef.current;
        if (authReadyRef.current && !authLoadingRef.current) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
    }

    if (authTokenRef.current) return true;
    if (signInPromiseRef.current) return signInPromiseRef.current;

    let promise: Promise<boolean>;
    promise = signIn()
      .then((session) => {
        authTokenRef.current = session?.token ?? null;
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
    (fromFrame = 1, toFrame = BOX_FRAME_COUNT) => {
      if (typeof window === 'undefined') return;
      const safeFrom = Math.max(1, Math.floor(fromFrame));
      const safeTo = Math.min(BOX_FRAME_COUNT, Math.floor(toFrame));
      for (let i = safeFrom; i <= safeTo; i += 1) {
        if (preloadedBoxFramesRef.current.has(i)) continue;
        const frame = i;
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
          boxFramePreloadImagesRef.current.delete(frame);
        };
        img.onerror = () => {
          boxFramePreloadImagesRef.current.delete(frame);
          preloadedBoxFramesRef.current.delete(frame);
        };
        img.src = `${boxFrameBase}${frame}.webp`;
        boxFramePreloadImagesRef.current.set(frame, img);
        preloadedBoxFramesRef.current.add(frame);
      }
    },
    [boxFrameBase],
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
    (mediaIds: number[]) => {
      if (typeof document === 'undefined') return;
      const root = ensureVideoPreloadRoot();
      if (!root) return;
      const ids = mediaIds
        .filter((mediaId) => Number.isFinite(mediaId) && mediaId > 0)
        .slice(0, 3);
      const key = ids.join(',');
      if (!key) return;
      if (videoPreloadKeyRef.current === key) return;
      videoPreloadKeyRef.current = key;
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
      ids.forEach((mediaId) => {
        const movSrc = `${revealMediaBase}${mediaId}.mov`;
        const webmSrc = `${revealMediaBase}${mediaId}.webm`;
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
    [ensureVideoPreloadRoot, revealMediaBase],
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

  const preloadRevealSounds = useCallback(() => {
    void soundPlayer.preloadSound(BOX_SOUND_REVEAL_URL);
    void soundPlayer.preloadSound(BOX_SOUND_CLICK_URL);
    void ensureSoundReady().then(() => {
      void soundPlayer.preloadSound(BOX_SOUND_REVEAL_URL);
      void soundPlayer.preloadSound(BOX_SOUND_CLICK_URL);
    });
  }, [ensureSoundReady]);

  const addLocalPendingReveal = (item: InventoryItem) => {
    if (!owner) return;
    const now = Date.now();
    setLocalPendingReveals((prev) => {
      const nextEntry: LocalPendingReveal = {
        id: item.id,
        createdAt: now,
        name: item.name,
        image: item.image || defaultBoxImage,
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

  const addLocalMintedBoxes = (quantity: number) => {
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const now = Date.now();
    const entries: LocalMintedBox[] = [];
    for (let i = 0; i < Math.floor(quantity); i += 1) {
      localMintCounterRef.current += 1;
      entries.push({
        id: `local-minted-${now}-${localMintCounterRef.current}`,
        createdAt: now + i,
      });
    }
    if (!entries.length) return;
    setLocalMintedBoxes((prev) => [...entries, ...prev]);
  };

  const removeLocalPendingReveal = (id: string) => {
    setLocalPendingReveals((prev) => {
      const next = prev.filter((entry) => entry.id !== id);
      return next.length === prev.length ? prev : next;
    });
  };

  const rememberRecentReveal = (boxId: string) => {
    if (!boxId) return;
    setRecentRevealedBoxes((prev) => {
      const next = [boxId, ...prev.filter((id) => id !== boxId)];
      return next.slice(0, RECENT_REVEALS_LIMIT);
    });
  };

  const queueFigureMetadataFetch = useCallback((ids: number[]) => {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    ids.forEach((id) => {
      if (!Number.isFinite(id) || id <= 0) return;
      const cached = figureMetadataRef.current[id];
      if (cached?.image) return;
      if (figureMetadataLoadingRef.current.has(id)) return;
      const retryAt = figureMetadataRetryAtRef.current.get(id);
      if (retryAt && retryAt > now) return;
      figureMetadataLoadingRef.current.add(id);
      const metadataUrl = `${FRONTEND_DEPLOYMENT.paths.figuresJsonBase}${id}.json`;
      void (async () => {
        try {
          const resp = await fetch(metadataUrl);
          if (!resp.ok) throw new Error('metadata fetch failed');
          const data = (await resp.json()) as {
            name?: string;
            image?: string;
            attributes?: { trait_type: string; value: string }[];
          };
          const rawImage = typeof data.image === 'string' ? data.image : '';
          const image = normalizeFigureImage(rawImage) || '';
          if (!image) throw new Error('metadata missing image');
          const name = typeof data.name === 'string' ? data.name : undefined;
          const attributes = Array.isArray(data.attributes) ? data.attributes : undefined;
          setFigureMetadataById((prev) => {
            const existing = prev[id];
            if (existing && existing.image === image && existing.name === name) {
              return prev;
            }
            return { ...prev, [id]: { id, name, image, attributes } };
          });
          figureMetadataRetryAtRef.current.delete(id);
        } catch (err) {
          console.warn('[mons] failed to load figure metadata', { id, error: err });
          figureMetadataRetryAtRef.current.set(id, Date.now() + FIGURE_METADATA_RETRY_MS);
        } finally {
          figureMetadataLoadingRef.current.delete(id);
        }
      })();
    });
  }, []);

  const addLocalRevealedDudes = (ids: number[]) => {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
    if (!uniqueIds.length) return;
    setLocalRevealedDudeIds((prev) => {
      const next = new Set(prev);
      uniqueIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
    queueFigureMetadataFetch(uniqueIds);
  };

  const finalizeRevealOverlayDismissal = useCallback(() => {
    revealOverlayRef.current = null;
    revealDismissLockedUntilRef.current = 0;
    setRevealOverlay(null);
    setRevealOverlayClosing(false);
    setRevealOverlayActive(false);
    videoPreloadKeyRef.current = '';
    if (videoPreloadRootRef.current) {
      while (videoPreloadRootRef.current.firstChild) {
        videoPreloadRootRef.current.removeChild(videoPreloadRootRef.current.firstChild);
      }
    }
    flushOverlayActions();
  }, [flushOverlayActions]);

  const closeRevealOverlay = useCallback(() => {
    const overlay = revealOverlayRef.current;
    if (!overlay) return;
    if (revealOverlayClosingRef.current) return;
    if (overlay.phase === 'preparing') {
      setStartOpenLoading((prev) => (prev === overlay.id ? null : prev));
    }
    if (revealOverlayRafRef.current) {
      cancelAnimationFrame(revealOverlayRafRef.current);
      revealOverlayRafRef.current = null;
    }
    if (!revealOverlayActiveRef.current) {
      finalizeRevealOverlayDismissal();
      return;
    }
    setRevealOverlayClosing(true);
  }, [finalizeRevealOverlayDismissal]);

  const dismissRevealOverlay = () => {
    if (revealOverlayRafRef.current) {
      cancelAnimationFrame(revealOverlayRafRef.current);
      revealOverlayRafRef.current = null;
    }
    finalizeRevealOverlayDismissal();
  };

	  const startAutoOpening = useCallback((mode: 'normal' | 'fast') => {
	    setRevealOverlay((prev) => {
	      if (!prev) return prev;
	      if (prev.phase !== 'ready') return prev;
	      if (prev.autoOpening) return prev;
      if (!prev.revealedIds || !prev.revealedIds.length) return prev;
      if (prev.frame >= BOX_FRAME_COUNT) return prev;
      return {
        ...prev,
        autoOpening: true,
        autoMode: mode,
        advanceClicks: 0,
        hasRevealAttempted: prev.hasRevealAttempted || mode === 'fast',
      };
    });
  }, []);

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
	    revealDismissLockedUntilRef.current = 0;
    preloadRevealSounds();
    preloadBoxFrames(1, BOX_FRAME_CLICK_MAX);
    preloadBoxFrames(BOX_FRAME_AUTOPLAY_START, BOX_FRAME_COUNT);
    const originRect = toOverlayRect(rect);
    const targetRect = calcRevealTargetRect(window.innerWidth, window.innerHeight);
    setInventorySnapshot(inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);
    const nextOverlay: RevealOverlayState = {
      id,
      name: item.name,
      image: item.image || defaultBoxImage,
      originRect,
      targetRect,
      phase,
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      hasRevealAttempted: false,
      autoOpening: false,
      autoMode: undefined,
    };
    revealOverlayRef.current = nextOverlay;
    setRevealOverlay(nextOverlay);
    setRevealOverlayClosing(false);
    setRevealOverlayActive(false);
    if (revealOverlayRafRef.current) {
      cancelAnimationFrame(revealOverlayRafRef.current);
    }
    revealOverlayRafRef.current = requestAnimationFrame(() => {
      revealOverlayRafRef.current = requestAnimationFrame(() => {
        setRevealOverlayActive(true);
        revealOverlayRafRef.current = null;
      });
    });
  };

  const findInventoryRect = (id: string) => {
    if (typeof document === 'undefined') return null;
    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const el = document.querySelector<HTMLElement>(`[data-inventory-id="${safeId}"]`);
    if (!el) return null;
    const imageEl = el.querySelector<HTMLElement>('.inventory__image');
    return (imageEl || el).getBoundingClientRect();
  };

  useEffect(() => {
    setHiddenAssets(loadHiddenAssets(owner));
  }, [owner]);

  useEffect(() => {
    setDiscountUsed(loadDiscountUsed(owner));
    setDiscountEligible(false);
    setDiscountChecking(false);
  }, [owner]);

  useEffect(() => {
    setLocalPendingReveals(loadPendingReveals(owner));
    setRecentRevealedBoxes(loadRecentReveals(owner).slice(0, RECENT_REVEALS_LIMIT));
    setLocalMintedBoxes([]);
    setInventorySnapshot([]);
    setPendingOpenSnapshot([]);
    setLocalRevealedDudeIds([]);
    setFigureMetadataById({});
    figureMetadataRef.current = {};
    figureMetadataLoadingRef.current.clear();
    figureMetadataRetryAtRef.current.clear();
    localMintCounterRef.current = 0;
    knownBoxIdsRef.current = new Set();
    preloadedBoxFramesRef.current.clear();
    boxFramePreloadImagesRef.current.clear();
    autoplayFramePreloadScheduledRef.current = false;
    videoPreloadKeyRef.current = '';
    if (videoPreloadRootRef.current) {
      videoPreloadRootRef.current.remove();
      videoPreloadRootRef.current = null;
    }
    deferredOverlayActionsRef.current = [];
  }, [owner]);

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
    if (!owner) return;
    persistPendingReveals(owner, localPendingReveals);
  }, [owner, localPendingReveals]);

  useEffect(() => {
    if (!owner) return;
    persistRecentReveals(owner, recentRevealedBoxes);
  }, [owner, recentRevealedBoxes]);

  useEffect(() => {
    figureMetadataRef.current = figureMetadataById;
  }, [figureMetadataById]);

  useEffect(() => {
    if (!owner) return;
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
    pendingOpenBoxesView,
    pendingOpenBoxesSuccess,
    localPendingReveals,
    recentRevealedBoxes,
    inventoryView,
    revealOverlay,
  ]);

  useEffect(() => {
    if (revealOverlay) return;
    if (!inventoryFetched) return;
    const currentIds = new Set(inventoryView.filter((item) => item.kind === 'box').map((item) => item.id));
    const prevIds = knownBoxIdsRef.current;
    if (localMintedBoxes.length) {
      if (!prevIds.size) {
        if (currentIds.size > 0) {
          const removeCount = Math.min(currentIds.size, localMintedBoxes.length);
          setLocalMintedBoxes((prev) => prev.slice(removeCount));
        }
      } else {
        let newCount = 0;
        currentIds.forEach((id) => {
          if (!prevIds.has(id)) newCount += 1;
        });
        if (newCount > 0) {
          setLocalMintedBoxes((prev) => prev.slice(Math.min(newCount, prev.length)));
        }
      }
    }
    knownBoxIdsRef.current = currentIds;
  }, [inventoryView, inventoryFetched, localMintedBoxes.length, revealOverlay]);

  useEffect(() => {
    if (revealOverlay) return;
    if (!localRevealedDudeIds.length) return;
    const chainDudes = new Map<number, InventoryItem>();
    inventoryView.forEach((item) => {
      if (item.kind !== 'dude') return;
      if (!item.dudeId) return;
      chainDudes.set(item.dudeId, item);
    });
    setLocalRevealedDudeIds((prev) => {
      const next = prev.filter((id) => {
        const item = chainDudes.get(id);
        if (!item) return true;
        if (item.image && String(item.image).trim()) return false;
        const meta = figureMetadataById[id];
        return !meta?.image;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [inventoryView, localRevealedDudeIds, figureMetadataById, revealOverlay]);

  const figureIdsNeedingMetadata = useMemo(() => {
    const ids = new Set<number>();
    localRevealedDudeIds.forEach((id) => {
      if (!figureMetadataById[id]?.image) ids.add(id);
    });
    inventoryView.forEach((item) => {
      if (item.kind !== 'dude') return;
      if (!item.dudeId) return;
      if (item.image && String(item.image).trim()) return;
      if (!figureMetadataById[item.dudeId]?.image) ids.add(item.dudeId);
    });
    return Array.from(ids);
  }, [inventoryView, localRevealedDudeIds, figureMetadataById]);

  useEffect(() => {
    if (!figureIdsNeedingMetadata.length) return;
    if (typeof window === 'undefined') return;
    queueFigureMetadataFetch(figureIdsNeedingMetadata);
    const interval = window.setInterval(() => {
      queueFigureMetadataFetch(figureIdsNeedingMetadata);
    }, FIGURE_METADATA_RETRY_MS);
    return () => window.clearInterval(interval);
  }, [figureIdsNeedingMetadata, queueFigureMetadataFetch]);

  const shouldPollInventory = !revealOverlay && (localRevealedDudeIds.length > 0 || localMintedBoxes.length > 0);

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
    if (revealOverlay.frame >= BOX_FRAME_COUNT) {
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
        const nextFrame = Math.min(prev.frame + 1, BOX_FRAME_COUNT);
        const nextPhase =
          prev.phase === 'revealed'
            ? prev.phase
            : prev.revealedIds && prev.revealedIds.length && nextFrame >= BOX_FRAME_MEDIA_START
              ? 'revealed'
              : prev.phase;
        return { ...prev, frame: nextFrame, phase: nextPhase };
      });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [revealOverlay, revealOverlayClosing]);

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
          const nextTarget = calcRevealTargetRect(window.innerWidth, window.innerHeight);
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
  }, [revealOverlay]);

  useEffect(() => {
    authLoadingSeenRef.current = false;
    setAuthReady(false);
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    if (authLoading) {
      authLoadingSeenRef.current = true;
      return;
    }
    if (profile || authLoadingSeenRef.current) {
      setAuthReady(true);
    }
  }, [owner, authLoading, profile]);

  useEffect(() => {
    if (owner || walletBusy) {
      setWalletIdleReady(false);
      return;
    }
    const timeout = setTimeout(() => {
      setWalletIdleReady(true);
    }, 250);
    return () => {
      clearTimeout(timeout);
    };
  }, [owner, walletBusy]);

  useEffect(() => {
    return () => {
      if (toastFadeTimeoutRef.current) {
        clearTimeout(toastFadeTimeoutRef.current);
      }
      if (toastClearTimeoutRef.current) {
        clearTimeout(toastClearTimeoutRef.current);
      }
      if (revealOverlayRafRef.current) {
        cancelAnimationFrame(revealOverlayRafRef.current);
      }
      if (revealOverlayResizeRafRef.current) {
        cancelAnimationFrame(revealOverlayResizeRafRef.current);
      }
    };
  }, []);

  const markAssetsHidden = useMemo(() => {
    if (!owner) return (_ids: string[]) => undefined;
    return (ids: string[]) => {
      setHiddenAssets((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => {
          if (typeof id === 'string' && id) next.add(id);
        });
        persistHiddenAssets(owner, next);
        return next;
      });
    };
  }, [owner]);

  const localRevealedDudes = useMemo(() => {
    if (!localRevealedDudeIds.length) return [] as InventoryItem[];
    const chainDudeIds = new Set(
      inventoryView.map((item) => item.dudeId).filter((id): id is number => typeof id === 'number'),
    );
    const out: InventoryItem[] = [];
    localRevealedDudeIds.forEach((id) => {
      if (chainDudeIds.has(id)) return;
      const meta = figureMetadataById[id];
      if (!meta?.image) return;
      out.push({
        id: `local-dude-${id}`,
        name: meta.name || `Figure ${id}`,
        kind: 'dude',
        image: meta.image,
        attributes: meta.attributes || [],
        dudeId: id,
        status: 'pending',
      });
    });
    return out;
  }, [inventoryView, localRevealedDudeIds, figureMetadataById]);

  const visibleInventory = useMemo(() => {
    const base = hiddenAssets.size ? inventoryView.filter((item) => !hiddenAssets.has(item.id)) : inventoryView;
    const enriched = base.map((item) => {
      if (item.kind === 'box') {
        if (item.image && String(item.image).trim()) return item;
        return { ...item, image: defaultBoxImage };
      }
      if (item.kind !== 'dude' || !item.dudeId) return item;
      if (item.image && String(item.image).trim()) return item;
      const meta = figureMetadataById[item.dudeId];
      if (!meta?.image) return item;
      return {
        ...item,
        image: meta.image,
        name: item.name || meta.name || item.name,
        attributes: item.attributes?.length ? item.attributes : meta.attributes,
      };
    });
    if (!localRevealedDudes.length) return enriched;
    return [...enriched, ...localRevealedDudes];
  }, [inventoryView, hiddenAssets, localRevealedDudes, figureMetadataById, defaultBoxImage]);

  const localMintedItems = useMemo<InventoryItem[]>(() => {
    if (!localMintedBoxes.length) return [] as InventoryItem[];
    return localMintedBoxes.map((entry) => ({
      id: entry.id,
      name: 'Pending box',
      kind: 'box' as const,
      image: defaultBoxImage,
      status: 'pending' as const,
    }));
  }, [localMintedBoxes, defaultBoxImage]);

  const recentRevealedSet = useMemo(() => new Set(recentRevealedBoxes), [recentRevealedBoxes]);
  const pendingOpenBoxesFiltered = useMemo(
    () => pendingOpenBoxesView.filter((entry) => entry.boxAssetId && !recentRevealedSet.has(entry.boxAssetId)),
    [pendingOpenBoxesView, recentRevealedSet],
  );
  const localPendingFiltered = useMemo(
    () => localPendingReveals.filter((entry) => !recentRevealedSet.has(entry.id)),
    [localPendingReveals, recentRevealedSet],
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
    pendingRevealIds.size > 0 || localMintedBoxes.length > 0 || inventoryView.some((item) => item.kind === 'box');
  useEffect(() => {
    if (!shouldPreloadBoxFramesInitial) return;
    preloadBoxFrames(1, BOX_FRAME_CLICK_MAX);
  }, [shouldPreloadBoxFramesInitial, preloadBoxFrames]);
  useEffect(() => {
    if (!shouldPreloadBoxFramesInitial) return;
    if (typeof window === 'undefined') return;
    if (autoplayFramePreloadScheduledRef.current) return;
    autoplayFramePreloadScheduledRef.current = true;
    const run = () => preloadBoxFrames(BOX_FRAME_AUTOPLAY_START, BOX_FRAME_COUNT);
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
  }, [shouldPreloadBoxFramesInitial, preloadBoxFrames]);
  useEffect(() => {
    if (!revealOverlay) return;
    preloadBoxFrames(BOX_FRAME_AUTOPLAY_START, BOX_FRAME_COUNT);
  }, [revealOverlay, preloadBoxFrames]);
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
      pendingItems.push({
        id,
        name: localMatch?.name || match?.name || `Box ${shortAddress(id)}`,
        kind: 'box',
        image: defaultBoxImage,
      });
    });
    const localSorted = [...localPendingFiltered].sort((a, b) => b.createdAt - a.createdAt);
    localSorted.forEach((entry) => {
      const id = entry.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const match = inventoryById.get(id);
      pendingItems.push({
        id,
        name: entry.name || match?.name || `Box ${shortAddress(id)}`,
        kind: 'box',
        image: defaultBoxImage,
      });
    });
    return pendingItems;
  }, [pendingOpenBoxesFiltered, localPendingFiltered, inventoryView, defaultBoxImage]);

  const inventoryItems = useMemo(() => {
    const boxes: typeof visibleInventory = [];
    const dudes: typeof visibleInventory = [];
    visibleInventory.forEach((item) => {
      if (pendingRevealIds.has(item.id)) return;
      if (item.kind === 'box') boxes.push(item);
      else if (item.kind === 'dude') dudes.push(item);
    });
    return [...pendingRevealItems, ...localMintedItems, ...boxes, ...dudes];
  }, [visibleInventory, pendingRevealIds, pendingRevealItems, localMintedItems]);
  const inventoryIndex = useMemo(() => new Map(inventoryItems.map((item) => [item.id, item])), [inventoryItems]);
  const receiptItems = useMemo(() => visibleInventory.filter((item) => item.kind === 'certificate'), [visibleInventory]);
  const inventoryEmptyStateVisibility = owner
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
  const [compactPanel, setCompactPanel] = useState(false);
  const selectedPreview = useMemo(() => {
    const limit = compactPanel ? 3 : 5;
    const entries = selectedItems.map((item) => ({
      item,
      previewImage: item.image || (item.kind === 'box' ? defaultBoxImage : undefined),
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
  }, [selectedItems, defaultBoxImage, compactPanel]);
  const selectedOverflow = Math.max(0, selectedCount - selectedPreview.length);
  const canOpenSelected = selectedCount === 1 && selectedItems[0]?.kind === 'box';
  const selectedBox = canOpenSelected ? selectedItems[0] : null;

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
    setDeliveryAddOpen(false);
  }, [deliveryOpen, selectedCount]);

  // Prefer signing locally + sending via our app RPC connection. This avoids wallet-side cluster mismatches
  // (e.g. Phantom set to mainnet while the app is on devnet) and surfaces clearer RPC errors.
  const signAndSendViaConnection = async (tx: VersionedTransaction) => {
    if (wallet.signTransaction) {
      const signed = await wallet.signTransaction(tx);
      const raw = signed.serialize();
      return connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
    }
    return sendTransaction(tx, connection, { skipPreflight: false });
  };

  const mintedOut = useMemo(() => {
    if (!mintStats) return false;
    return mintStats.remaining <= 0;
  }, [mintStats]);

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
    if (!publicKey) return { visible: guestDiscountReady, label: 'lsw discount' };
    if (discountChecking) return { visible: false, label: '' };
    return { visible: discountEligible, label: 'Mint one for 0.55 SOL' };
  }, [discountChecking, discountEligible, guestDiscountReady, mintedOut, publicKey, walletBusy]);

  useEffect(() => {
    if (!publicKey || mintedOut || discountUsed) {
      setDiscountEligible(false);
      setDiscountChecking(false);
      return;
    }
    const address = publicKey.toBase58();
    if (!isDiscountListed(address)) {
      setDiscountEligible(false);
      setDiscountChecking(false);
      return;
    }

    let cancelled = false;
    setDiscountChecking(true);
    (async () => {
      try {
        const [discountPda] = discountMintRecordPda(publicKey);
        const info = await connection.getAccountInfo(discountPda, 'confirmed');
        if (cancelled) return;
        if (info) {
          setDiscountEligible(false);
          setDiscountUsed(true);
          persistDiscountUsed(address, true);
          return;
        }
        setDiscountEligible(true);
      } catch (err) {
        if (cancelled) return;
        console.warn('[mons] failed to check discount eligibility', err);
        setDiscountEligible(false);
      } finally {
        if (!cancelled) setDiscountChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, discountUsed, mintedOut, publicKey]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      }
      if (prev.size >= MAX_SHIPMENT_ITEMS) return prev;
      const copy = new Set(prev);
      copy.add(id);
      return copy;
    });
  };

  const handleMint = async (quantity: number) => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    setMinting(true);
    try {
      const cfg = await fetchBoxMinterConfig(connection);
      const sendOnce = async () => {
        const tx = await buildMintBoxesTx(connection, cfg, publicKey, quantity);
        const sig = await signAndSendViaConnection(tx);
        await connection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      try {
        await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Transaction expired before you approved it. Please approve again…');
        await sendOnce();
      }
      addLocalMintedBoxes(quantity);
      await Promise.all([refetchStats(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      throw err;
    } finally {
      setMinting(false);
    }
  };

  const handleDiscountMint = async () => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    if (mintedOut || discountMinting || minting) return;
    const proof = getDiscountProof(publicKey.toBase58());
    if (!proof) {
      setDiscountEligible(false);
      showToast('Wallet is not eligible for the discount');
      return;
    }

    setDiscountMinting(true);
    try {
      const cfg = await fetchBoxMinterConfig(connection);
      const sendOnce = async () => {
        const tx = await buildMintDiscountedBoxTx(connection, cfg, publicKey, proof);
        const sig = await signAndSendViaConnection(tx);
        await connection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      try {
        await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Transaction expired before you approved it. Please approve again…');
        await sendOnce();
      }
      addLocalMintedBoxes(1);
      setDiscountUsed(true);
      setDiscountEligible(false);
      if (owner) persistDiscountUsed(owner, true);
      await Promise.all([refetchStats(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      showToast(err instanceof Error ? err.message : 'Failed to mint discounted box');
    } finally {
      setDiscountMinting(false);
    }
  };

  const handleStartOpenBox = async (item: InventoryItem) => {
    if (!publicKey) throw new Error('Connect wallet to open a box');
    setStartOpenLoading(item.id);
    try {
      const cfg = await fetchBoxMinterConfig(connection);
      const sendOnce = async () => {
        const tx = await buildStartOpenBoxTx(connection, cfg, publicKey, new PublicKey(item.id));
        const sig = await signAndSendViaConnection(tx);
        await connection.confirmTransaction(sig, 'confirmed');
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
        showToast(err instanceof Error ? err.message : 'Failed to open box');
      }
      dismissRevealOverlay();
    } finally {
      setStartOpenLoading(null);
    }
  };

  const handleRevealDudes = async (boxAssetId: string) => {
    const signedIn = await ensureSignedIn();
    if (!signedIn) return;
    if (!publicKey) return;
    setRevealLoading(boxAssetId);
    try {
      const resp = await revealDudes(publicKey.toBase58(), boxAssetId);
      const revealed = (resp?.dudeIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (revealed.length) {
        revealDismissLockedUntilRef.current = Date.now() + 1_000;
      }
      if (revealed.length) {
        const mediaIds = Array.from(
          new Set(
            revealed
              .map((figureId) => getMediaIdForFigureId(figureId))
              .filter((mediaId): mediaId is number => Boolean(mediaId)),
          ),
        ).slice(0, 3);
        if (mediaIds.length) {
          preloadRevealVideos(mediaIds);
        }
      }
      setRevealOverlay((prev) => {
        if (!prev || prev.id !== boxAssetId) return prev;
        const nextPhase =
          prev.phase === 'preparing'
            ? prev.phase
            : prev.frame >= BOX_FRAME_MEDIA_START && revealed.length
              ? 'revealed'
              : 'ready';
        return { ...prev, phase: nextPhase, revealedIds: revealed };
      });
      queueOverlayAction(() => removeLocalPendingReveal(boxAssetId));
      queueOverlayAction(() => rememberRecentReveal(boxAssetId));
      queueOverlayAction(() => addLocalRevealedDudes(revealed));
      queueOverlayAction(() => {
        void Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
      });
    } catch (err) {
      console.error(err);
      const code = (err as { code?: string })?.code;
      if (code !== 'not-found' && !isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : 'Failed to reveal figures');
      }
    } finally {
      setRevealLoading(null);
    }
  };

  const handleRevealOverlayClick = () => {
    if (!revealOverlay || revealOverlayClosing) return;
    if (revealOverlay.phase !== 'ready') return;
    if (revealOverlay.autoOpening) return;
    if (revealOverlay.frame >= BOX_FRAME_COUNT) return;
    if (!publicKey) {
      showToast('Connect wallet first');
      return;
    }

    void ensureSoundReady().then(() => soundPlayer.playSound(BOX_SOUND_CLICK_URL, 0.42));
    const shouldSendReveal = !revealOverlay.hasRevealAttempted && !revealOverlay.revealedIds?.length;
    setRevealOverlay((prev) => {
      if (!prev || prev.id !== revealOverlay.id) return prev;
      if (prev.phase !== 'ready') return prev;
      if (prev.autoOpening) return prev;

      const hasResults = Boolean(prev.revealedIds?.length);
      const canAdvance =
        prev.frame < BOX_FRAME_CLICK_MAX || (prev.frame === BOX_FRAME_CLICK_MAX && hasResults);
      const shouldAdvanceNow = canAdvance;
      const nextFrame = shouldAdvanceNow
        ? prev.frame < BOX_FRAME_CLICK_MAX
          ? prev.frame + 1
          : prev.frame === BOX_FRAME_CLICK_MAX && hasResults
            ? BOX_FRAME_AUTOPLAY_START
            : prev.frame
        : prev.frame;
      const shouldAuto = hasResults && nextFrame === BOX_FRAME_AUTOPLAY_START && prev.frame !== nextFrame;
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
      void handleRevealDudes(revealOverlay.id);
    }
  };

	  const handleRevealOverlayBackdropClick = () => {
	    if (!revealOverlay || revealOverlayClosing) return;
	    const hasResults = Boolean(revealOverlay.revealedIds?.length);
    if (hasResults && revealOverlay.frame < BOX_FRAME_COUNT) {
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

	  const openPreparingOverlayForBox = useCallback(
	    (box: InventoryItem) => {
	      preloadRevealSounds();
	      preloadBoxFrames(1, BOX_FRAME_CLICK_MAX);
	      preloadBoxFrames(BOX_FRAME_AUTOPLAY_START, BOX_FRAME_COUNT);
	      if (typeof window === 'undefined') return;
	      const originRect = findInventoryRect(box.id);
	      const fallbackTarget = calcRevealTargetRect(window.innerWidth, window.innerHeight);
	      const fallbackRect = new DOMRect(
	        fallbackTarget.left,
	        fallbackTarget.top,
	        fallbackTarget.width,
	        fallbackTarget.height,
	      );
	      const overlayItem: InventoryItem = { ...box, image: defaultBoxImage };
	      openRevealOverlay(box.id, originRect || fallbackRect, 'preparing', overlayItem);
	    },
	    [defaultBoxImage, openRevealOverlay, preloadBoxFrames, preloadRevealSounds],
	  );

	  const handleOpenSelectedBox = async () => {
	    if (!selectedBox) return;
	    if (!publicKey) {
	      setVisible(true);
	      return;
	    }
	    if (openSelectedLockRef.current) {
	      const activeId = openSelectedBoxIdRef.current;
	      if (activeId && activeId !== selectedBox.id) {
	        showToast('Check your wallet to finish the current unboxing');
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

  const handleSaveAddress = async ({
    formatted,
    country,
    label,
    email,
    countryCode,
  }: {
    formatted: string;
    country: string;
    label: string;
    email: string;
    countryCode: string;
  }) => {
    const encryptionKey = (FRONTEND_DEPLOYMENT.addressEncryptionPublicKey || '').trim();
    if (!encryptionKey) throw new Error('Missing address encryption public key (src/config/deployment.ts)');
    const { cipherText, hint } = encryptAddressPayload(formatted, encryptionKey);
    // Ensure wallet session exists for authenticated callable.
    const session = token ? { profile } : await signIn();
    const saved = await saveEncryptedAddress(cipherText, country, label, hint, email, countryCode);
    const base = (session?.profile || profile) as typeof profile;
    if (updateProfile && base) {
      updateProfile({
        ...base,
        email: email || base.email,
        addresses: [...(base.addresses || []), { ...saved, hint }],
      });
    }
    setAddressId(saved.id);
    setDeliveryAddOpen(false);
    showToast('Address saved and encrypted');
  };

  const handleRemoveAddress = async (id: string) => {
    if (!publicKey) throw new Error('Connect a wallet to manage shipping addresses');
    setRemoveAddressLoading(id);
    try {
      const session = token ? { profile } : await signIn();
      await removeAddress(id);
      const base = session?.profile || profile;
      const remaining = (base?.addresses || []).filter((addr) => addr.id !== id);
      if (updateProfile && base) {
        updateProfile({
          ...base,
          addresses: remaining,
        });
      }
      if (addressId === id) {
        setAddressId(remaining.length ? remaining[0].id : null);
      }
      showToast('Address removed');
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Failed to remove address');
    } finally {
      setRemoveAddressLoading(null);
    }
  };

  const handleSignInForDelivery = async () => {
    await signIn();
    showToast('Signed in. Saved addresses loaded.');
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

  const handleRequestDelivery = async (addressId: string | null) => {
    if (!publicKey) throw new Error('Connect wallet first');
    if (!addressId) throw new Error('Select a shipping address');
    const itemIds = Array.from(selected);
    if (!itemIds.length) throw new Error('Select items to ship');
    const addr = savedAddresses.find((a) => a.id === addressId);
    if (!addr) throw new Error('Select a shipping address');
    // Ensure wallet session exists for authenticated callable.
    if (!token) {
      await signIn();
    }
    const deliverableIds = itemIds.filter((id) => {
      const item = inventoryView.find((entry) => entry.id === id);
      return item && item.kind !== 'certificate' && !pendingRevealIds.has(id);
    });
    if (!deliverableIds.length) throw new Error('Select boxes or figures to ship');
    if (deliverableIds.length !== itemIds.length) {
      setSelected(new Set(deliverableIds));
    }

    setDeliveryLoading(true);
    setDeliveryCost(undefined);
    try {
      const requestTx = () => requestDeliveryTx(publicKey.toBase58(), { itemIds: deliverableIds, addressId });
      let resp = await requestTx();
      setDeliveryCost(typeof resp.deliveryLamports === 'number' ? resp.deliveryLamports : undefined);
      let sig: string;
      try {
        sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
        resp = await requestTx();
        setDeliveryCost(typeof resp.deliveryLamports === 'number' ? resp.deliveryLamports : undefined);
        sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      }
      const idSuffix = resp.deliveryId ? ` · id ${resp.deliveryId}` : '';
      showToast(`Shipment submitted${idSuffix} · ${sig}`);
      // Delivery transfers the selected assets to the vault; hide them immediately once confirmed.
      markAssetsHidden(deliverableIds);
      setSelected(new Set());
      await refetchInventory();
      if (resp.deliveryId) {
        try {
          showToast(`Shipment submitted${idSuffix} · ${sig} · issuing receipts…`);
          const issued = await issueReceipts(publicKey.toBase58(), resp.deliveryId, sig);
          const minted = Number(issued?.receiptsMinted || 0);
          showToast(`Shipment submitted${idSuffix} · ${sig} · receipts issued (${minted})`);
          await refetchInventory();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to issue receipts';
          showToast(`Shipment submitted${idSuffix} · ${sig} (receipt warning: ${msg})`);
        }
      }
    } catch (err) {
      console.error(err);
      if (!isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : 'Failed to request shipment');
      }
    } finally {
      setDeliveryLoading(false);
    }
  };

  const handleClaim = async ({ code }: { code: string }) => {
    if (!publicKey) throw new Error('Connect wallet to claim');
    // Ensure wallet session exists for authenticated callable.
    if (!token) {
      await signIn();
    }
    const requestTx = () => requestClaimTx(publicKey.toBase58(), code);
    let resp = await requestTx();
    let sig: string;
    try {
      sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
      resp = await requestTx();
      sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    }
    showToast(`Claimed certificates · ${sig}`);
    await refetchInventory();
  };

  const secondaryLinks = [
    { label: 'Tensor', href: 'https://www.tensor.trade/' },
    { label: 'Magic Eden', href: 'https://magiceden.io/' },
  ];

  const savedAddresses = profile?.addresses || [];
  const formattedAddresses = useMemo(
    () => savedAddresses.map((addr) => ({ ...addr, hint: addr.hint || addr.id.slice(0, 4) })),
    [savedAddresses],
  );
  const deliveryOrders = profile?.orders || [];
  const shipmentsEmptyContent = !profile ? (
    <span className="shipments-signin">
      <button type="button" className="link" onClick={handleSignInForShipments} disabled={authLoading}>
        Sign in
      </button>
      <span>to view your shipments.</span>
    </span>
  ) : (
    'No shipments yet.'
  );
  const shipmentsEmptyStateVisibility = owner
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
  const formatCountry = (addr: ProfileAddress) => {
    const code = addr.countryCode || normalizeCountryCode(addr.country);
    const option = findCountryByCode(code);
    if (option) return countryLabel(option);
    return addr.country || code || 'Unknown';
  };

  useEffect(() => {
    if (!deliveryOrders.length) {
      setClaimOpen(false);
    }
  }, [deliveryOrders.length]);

  useEffect(() => {
    if (!addressId && savedAddresses.length) {
      setAddressId(savedAddresses[0].id);
    }
  }, [addressId, savedAddresses]);

  useEffect(() => {
    // Delivery cost is returned by the server when preparing the delivery transaction.
    // Clear any previously-returned value whenever the inputs change to avoid showing stale fees.
    setDeliveryCost(undefined);
  }, [addressId, selected]);

  const revealOverlayStyle = revealOverlay
    ? (() => {
        const { originRect, targetRect } = revealOverlay;
        const safeTargetWidth = Math.max(1, targetRect.width);
        const safeTargetHeight = Math.max(1, targetRect.height);
        const scaleX = Math.max(0.01, originRect.width / safeTargetWidth);
        const scaleY = Math.max(0.01, originRect.height / safeTargetHeight);
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
        };
      })()
    : undefined;
  const showRevealOutcome = Boolean(
    revealOverlay && revealOverlay.revealedIds?.length && revealOverlay.frame >= BOX_FRAME_MEDIA_START,
  );
  const revealOverlayStage = revealOverlay
    ? revealOverlay.phase === 'preparing'
      ? 'preparing'
      : showRevealOutcome
        ? 'revealed'
        : 'ready'
    : 'ready';
  const revealMediaIds = useMemo(() => {
    if (!revealOverlay?.revealedIds?.length) return [] as number[];
    const seen = new Set<number>();
    return revealOverlay.revealedIds
      .map((figureId) => {
        const mediaId = getMediaIdForFigureId(figureId);
        if (!mediaId) return null;
        if (seen.has(mediaId)) return null;
        seen.add(mediaId);
        return mediaId;
      })
      .filter((entry): entry is number => Boolean(entry))
      .slice(0, 3);
  }, [revealOverlay?.revealedIds]);
  const revealMediaVisible = Boolean(revealOverlay && revealMediaIds.length && revealOverlay.frame >= BOX_FRAME_MEDIA_START);

  const revealSoundPlayedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealOverlay) {
      revealSoundPlayedRef.current = null;
      return;
    }
    if (!revealMediaVisible) return;
    if (revealSoundPlayedRef.current === revealOverlay.id) return;
    revealSoundPlayedRef.current = revealOverlay.id;
    const play = () => {
      void soundPlayer.playSound(BOX_SOUND_REVEAL_URL, 0.42);
    };
    if (soundPlayer.isInitialized) {
      play();
      return;
    }
    const pending = soundInitPromiseRef.current;
    if (pending) {
      void pending.then(play);
    }
  }, [revealOverlay?.id, revealMediaVisible]);

	  const revealMediaStyle = useMemo(() => {
	    if (!revealOverlay || !revealMediaIds.length) return undefined;
	    const width = revealOverlay.targetRect.width;
	    const height = revealOverlay.targetRect.height;
	    const base = Math.min(width, height);
	    const baseSize = Math.floor(Math.min(base * 0.7, 220));
	    const widthCap = width < 240 ? 0.42 : width < 320 ? 0.48 : width < 420 ? 0.52 : 0.6;
	    const maxByWidth = Math.floor(width * widthCap);
	    const maxByHeight = Math.floor(height * 0.9);
	    const maxSize = Math.floor(Math.min(baseSize * 1.4, maxByWidth, maxByHeight));
	    const size = Math.max(64, Math.floor(maxSize * 0.8));
	    const shiftY = Math.floor(size * 0.1);
	    return {
	      ['--reveal-media-size' as never]: `${size}px`,
	      ['--reveal-media-shift-y' as never]: `${shiftY}px`,
	    };
	  }, [revealOverlay, revealMediaIds.length]);
  useEffect(() => {
    if (!revealMediaIds.length) return;
    preloadRevealVideos(revealMediaIds);
  }, [revealMediaIds, preloadRevealVideos]);
  const revealBoxFrameSrc =
    revealOverlay && revealOverlay.frame
      ? `${boxFrameBase}${Math.min(Math.max(revealOverlay.frame, 1), BOX_FRAME_COUNT)}.webp`
      : '';
  const revealOverlayNote =
    revealOverlayStage === 'preparing'
      ? 'preparing to unbox...'
      : revealOverlayStage === 'revealed'
        ? ''
        : revealOverlay
          ? revealOverlay.hasRevealAttempted
            ? 'keep clicking the box'
            : 'click the box to open'
          : '';

  return (
    <div className="page">
      {toast ? (
        <div className={`toast${toastVisible ? '' : ' toast--hidden'}`} role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      {revealOverlay ? (
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
            onTransitionEnd={(evt) => {
              if (evt.propertyName !== 'opacity') return;
              if (!revealOverlayClosing) return;
              finalizeRevealOverlayDismissal();
            }}
          >
            <div
              className={`reveal-overlay__shine${revealMediaVisible ? ' reveal-overlay__shine--visible' : ''}`}
              aria-hidden="true"
            />
            {revealMediaIds.length ? (
              <div
                className={`reveal-overlay__media${revealMediaVisible ? ' reveal-overlay__media--visible' : ''}`}
                style={revealMediaStyle}
                aria-hidden="true"
              >
                {revealMediaIds.map((mediaId, index) => (
                  <div
                    key={`${revealOverlay.id}-${mediaId}`}
                    className={`reveal-overlay__media-item reveal-overlay__media-item--${['top', 'left', 'right'][index] || 'top'}`}
                    style={{ ['--reveal-media-delay' as never]: `${index * 90}ms` }}
                  >
                    <div className="reveal-overlay__media-float">
	                      <video
	                        className="reveal-overlay__video"
	                        autoPlay
	                        muted
	                        loop
	                        playsInline
	                        preload="metadata"
	                        draggable={false}
	                      >
                        <source
                          src={`${revealMediaBase}${mediaId}.mov`}
                          type='video/quicktime; codecs="hvc1"'
                        />
                        <source src={`${revealMediaBase}${mediaId}.webm`} type="video/webm" />
                      </video>
                    </div>
                  </div>
                ))}
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
                revealOverlay.frame >= BOX_FRAME_COUNT
              }
              onClick={(evt) => {
                evt.stopPropagation();
                handleRevealOverlayClick();
              }}
	            >
	              <img
	                src={revealBoxFrameSrc}
	                alt={revealOverlay.name}
	                className="reveal-overlay__image"
	                draggable={false}
	              />
	            </button>
	          </div>
	          <div className="reveal-overlay__note">{revealOverlayNote}</div>
	        </div>
      ) : null}
      <header className="top">
        <div className="brand">
          <h1>
            <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" />
            <span>mons.shop</span>
          </h1>
        </div>
      </header>

      <MintPanel
        stats={mintStats}
        onMint={handleMint}
        busy={minting}
        onError={showToast}
        secondaryHref={secondaryLinks[0]?.href}
        discountVisible={discountCtaState.visible}
        discountLabel={discountCtaState.label}
        onDiscountClick={handleDiscountMint}
        discountBusy={discountMinting || discountChecking || minting || walletBusy}
      />

      {mintedOut ? (
        <section className="card">
          <div className="card__title">Minted out</div>
          <p className="muted">All boxes are gone. Grab them on secondary.</p>
          <div className="row">
            {secondaryLinks.map((link) => (
              <a key={link.href} className="pill" href={link.href} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            ))}
          </div>
        </section>
      ) : null}

	      <section className="card">
	        <div className="card__title">Inventory</div>
		        <InventoryGrid
		          items={inventoryItems}
		          selected={selected}
		          onToggle={toggleSelected}
		          pendingRevealIds={pendingRevealIds}
		          onReveal={async (id, rect) => {
		            if (!publicKey) {
		              setVisible(true);
		              return;
		            }
		            preloadRevealSounds();
		            preloadBoxFrames(1, BOX_FRAME_CLICK_MAX);
		            preloadBoxFrames(BOX_FRAME_AUTOPLAY_START, BOX_FRAME_COUNT);
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
          setDeliveryAddOpen(false);
        }}
      >
        <div className="modal-form delivery-modal">
          <div className="delivery-modal__summary">
            <div>
              <div className="card__title">{selectedCount} selected</div>
              <div className="muted small">Choose a saved address or add a new one.</div>
            </div>
            {selectedCount && addressId ? (
              <div className="pill-row">
                {typeof deliveryCost === 'number' ? (
                  <span className="pill">Ship: {lamportsToSol(deliveryCost)} ◎</span>
                ) : deliveryLoading ? (
                  <span className="pill">Ship: calculating…</span>
                ) : (
                  <span className="pill">Ship: calculated on request</span>
                )}
              </div>
            ) : null}
          </div>

          {!publicKey ? <div className="muted small">Connect a wallet to manage shipping addresses.</div> : null}
          {publicKey && !profile && !authLoading ? (
            <div className="muted small">
              Sign in once to load saved addresses on this device. Afterwards you can reload and still see them.
            </div>
          ) : null}

          <div className="card__head">
            <div>
              <div className="card__title">Shipping address</div>
              <div className="muted small">Select a saved address or add a new one.</div>
            </div>
            <div className="card__actions">
              {!profile ? (
                <button type="button" className="ghost" onClick={handleSignInForDelivery} disabled={!publicKey || authLoading}>
                  {authLoading ? 'Loading…' : 'Sign in to load addresses'}
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                onClick={() => setDeliveryAddOpen((prev) => !prev)}
                disabled={!publicKey || authLoading}
              >
                {deliveryAddOpen ? 'Hide address form' : 'Add new address'}
              </button>
            </div>
          </div>

          <label>
            <span className="muted">Send to</span>
            <select
              value={addressId || ''}
              onChange={(evt) => setAddressId(evt.target.value)}
              disabled={!formattedAddresses.length}
            >
              <option value="" disabled>
                {formattedAddresses.length
                  ? 'Choose saved address'
                  : profile
                    ? 'No saved addresses yet'
                    : 'Sign in to load addresses'}
              </option>
              {formattedAddresses.map((addr) => (
                <option key={addr.id} value={addr.id}>
                  {addr.label} · {formatCountry(addr)} · {addr.hint}
                </option>
              ))}
            </select>
          </label>

          {formattedAddresses.length ? (
            <>
              <div className="muted small">Saved addresses</div>
              <div className="grid">
                {formattedAddresses.map((addr) => {
                  const isSelected = addr.id === addressId;
                  return (
                    <div key={addr.id} className="card subtle">
                      <div className="card__head">
                        <div>
                          <div className="card__title">{addr.label}</div>
                          <div className="muted small">
                            {formatCountry(addr)} · {addr.hint}
                          </div>
                        </div>
                        <div className="card__actions">
                          {isSelected ? <span className="pill">Selected</span> : null}
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              void handleRemoveAddress(addr.id);
                            }}
                            disabled={!profile || Boolean(removeAddressLoading)}
                          >
                            {removeAddressLoading === addr.id ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {deliveryAddOpen ? (
            <div className="card subtle">
              <div className="card__title">Add a new address</div>
              <DeliveryForm
                mode="modal"
                onSave={handleSaveAddress}
                defaultEmail={profile?.email || ''}
                onCancel={() => setDeliveryAddOpen(false)}
              />
            </div>
          ) : null}

          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDeliveryOpen(false);
                setDeliveryAddOpen(false);
              }}
            >
              Close
            </button>
            <button onClick={() => handleRequestDelivery(addressId)} disabled={!selectedCount || !addressId || deliveryLoading}>
              {deliveryLoading ? 'Preparing tx…' : 'Request shipment tx'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={claimOpen} title="Secret Code" onClose={() => setClaimOpen(false)}>
        <ClaimForm onClaim={handleClaim} mode="modal" showTitle={false} />
      </Modal>

      {authError && !isUserRejectedError(authError) ? <div className="error">{authError}</div> : null}
      <section className="card">
        <div className="card__head">
          <div className="card__title">Shipments</div>
        </div>
        {shipmentsReady ? (
          deliveryOrders.length ? (
          <div className="delivery-list">
            {deliveryOrders.map((order) => (
              <div key={order.deliveryId} className="delivery-row">
                <div className="card__head">
                  <div>
                    <div className="card__title">{order.deliveryId}</div>
                    <div className="muted small">{formatOrderDate(order)}</div>
                  </div>
                  <div className="delivery-status">Preparing</div>
                </div>
                {order.items.length ? (
                  <div className="muted small">
                    {order.items
                      .map((item) => `${item.kind === 'box' ? 'Box' : 'Figure'} ${item.refId}`)
                      .join(', ')}
                  </div>
                ) : (
                  <div className="muted small">Items unavailable.</div>
                )}
                {order.fulfillmentStatus ? (
                  <div className="muted small">Fulfillment update: {order.fulfillmentStatus}</div>
                ) : null}
              </div>
            ))}
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
              <button type="button" className="ghost" onClick={() => setClaimOpen(true)}>
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
            {canOpenSelected ? (
	              <button
	                type="button"
	                className="selection-panel__open"
	                onClick={handleOpenSelectedBox}
	                disabled={Boolean(startOpenLoading)}
	              >
                <FaBoxOpen aria-hidden="true" focusable="false" size={18} />
                <span>{startOpenLoading === selectedBox?.id ? 'Unboxing…' : 'Unbox'}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="selection-panel__ship"
              onClick={() => {
                setDeliveryOpen(true);
                setDeliveryAddOpen(false);
              }}
            >
              <FaPlane aria-hidden="true" focusable="false" size={16} />
              <span>Ship</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
