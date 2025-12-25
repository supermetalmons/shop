import { useEffect, useMemo, useRef, useState } from 'react';
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
import { buildMintBoxesTx, buildStartOpenBoxTx, fetchBoxMinterConfig } from './lib/boxMinter';
import {
  encryptAddressPayload,
  isBlockhashExpiredError,
  lamportsToSol,
  normalizeCountryCode,
  sendPreparedTransaction,
  shortAddress,
} from './lib/solana';
import { countryLabel, findCountryByCode } from './lib/countries';
import { DeliveryOrderSummary, InventoryItem, ProfileAddress } from './types';
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
const REVEAL_BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)
const REVEAL_NOTE_OFFSET = 14;
const LOCAL_PENDING_GRACE_MS = 10 * 60 * 1000;
const RECENT_REVEALS_LIMIT = 10;

type OverlayRect = { left: number; top: number; width: number; height: number };

type RevealOverlayPhase = 'preparing' | 'ready' | 'revealed';

type LocalPendingReveal = {
  id: string;
  createdAt: number;
  name?: string;
  image?: string;
};

type RevealOverlayState = {
  id: string;
  name: string;
  image: string;
  originRect: OverlayRect;
  targetRect: OverlayRect;
  phase: RevealOverlayPhase;
  revealedIds?: number[];
  hasRevealAttempted?: boolean;
};

function toOverlayRect(rect: DOMRect): OverlayRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function calcRevealTargetRect(viewportWidth: number, viewportHeight: number): OverlayRect {
  const maxWidth = viewportWidth * 0.5;
  const maxHeight = viewportHeight * 0.33;
  const width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * REVEAL_BOX_ASPECT_RATIO)));
  const height = Math.max(1, Math.floor(width / REVEAL_BOX_ASPECT_RATIO));
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.round((viewportHeight - height) / 2),
    width,
    height,
  };
}

function formatRevealIds(ids?: number[]) {
  if (!ids || !ids.length) return 'Figures: none';
  return `Figures: ${ids.join(', ')}`;
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
  const { data: inventory = [], refetch: refetchInventory, isFetched: inventoryFetched } = useInventory();
  const {
    data: pendingOpenBoxes = [],
    refetch: refetchPendingOpenBoxes,
    isFetched: pendingOpenBoxesFetched,
  } = usePendingOpenBoxes();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState(false);
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
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const [hiddenAssets, setHiddenAssets] = useState<Set<string>>(() => loadHiddenAssets(owner));
  const [localPendingReveals, setLocalPendingReveals] = useState<LocalPendingReveal[]>(() => loadPendingReveals(owner));
  const [recentRevealedBoxes, setRecentRevealedBoxes] = useState<string[]>(() => loadRecentReveals(owner));
  const [localRevealedDudes, setLocalRevealedDudes] = useState<InventoryItem[]>([]);
  const localDudeCacheRef = useRef<Map<number, InventoryItem>>(new Map());

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

  const addLocalRevealedDudes = async (ids: number[]) => {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
    if (!uniqueIds.length) return;
    const pending = uniqueIds.filter((id) => !localDudeCacheRef.current.has(id));
    if (!pending.length) return;
    const results = await Promise.all(
      pending.map(async (id) => {
        const metadataUrl = `${FRONTEND_DEPLOYMENT.paths.figuresJsonBase}${id}.json`;
        try {
          const resp = await fetch(metadataUrl);
          if (!resp.ok) throw new Error('metadata fetch failed');
          const data = (await resp.json()) as {
            name?: string;
            image?: string;
            attributes?: { trait_type: string; value: string }[];
          };
          const image =
            typeof data.image === 'string' && data.image
              ? data.image
              : `${FRONTEND_DEPLOYMENT.paths.base}/figures/${id}.webp`;
          const name = typeof data.name === 'string' && data.name ? data.name : `Figure ${id}`;
          return {
            id: `local-dude-${id}`,
            name,
            kind: 'dude',
            image,
            attributes: Array.isArray(data.attributes) ? data.attributes : [],
            dudeId: id,
            status: 'pending',
          } satisfies InventoryItem;
        } catch (err) {
          console.warn('[mons] failed to load figure metadata', { id, error: err });
          return {
            id: `local-dude-${id}`,
            name: `Figure ${id}`,
            kind: 'dude',
            image: `${FRONTEND_DEPLOYMENT.paths.base}/figures/${id}.webp`,
            dudeId: id,
            status: 'pending',
          } satisfies InventoryItem;
        }
      }),
    );

    results.forEach((item) => {
      if (!item?.dudeId) return;
      localDudeCacheRef.current.set(item.dudeId, item);
    });
    setLocalRevealedDudes((prev) => {
      const merged = new Map<number, InventoryItem>();
      prev.forEach((entry) => {
        if (entry.dudeId) merged.set(entry.dudeId, entry);
      });
      results.forEach((entry) => {
        if (entry?.dudeId) merged.set(entry.dudeId, entry);
      });
      return Array.from(merged.values());
    });
  };

  const clearStartOpenLoadingForOverlay = (overlay: RevealOverlayState | null) => {
    if (!overlay) return;
    if (overlay.phase !== 'preparing') return;
    setStartOpenLoading((prev) => (prev === overlay.id ? null : prev));
  };

  const closeRevealOverlay = () => {
    if (!revealOverlay) return;
    if (revealOverlayClosing) return;
    clearStartOpenLoadingForOverlay(revealOverlay);
    if (revealOverlayRafRef.current) {
      cancelAnimationFrame(revealOverlayRafRef.current);
      revealOverlayRafRef.current = null;
    }
    if (!revealOverlayActive) {
      setRevealOverlay(null);
      setRevealOverlayClosing(false);
      setRevealOverlayActive(false);
      return;
    }
    setRevealOverlayClosing(true);
  };

  const dismissRevealOverlay = () => {
    if (revealOverlayRafRef.current) {
      cancelAnimationFrame(revealOverlayRafRef.current);
      revealOverlayRafRef.current = null;
    }
    setRevealOverlay(null);
    setRevealOverlayClosing(false);
    setRevealOverlayActive(false);
  };

  const openRevealOverlay = (
    id: string,
    rect: DOMRect,
    phase: RevealOverlayPhase = 'ready',
    itemOverride?: InventoryItem,
  ) => {
    if (revealOverlay || revealLoading || startOpenLoading) return;
    if (typeof window === 'undefined') return;
    const item = itemOverride || inventoryIndex.get(id);
    if (!item) return;
    const originRect = toOverlayRect(rect);
    const targetRect = calcRevealTargetRect(window.innerWidth, window.innerHeight);
    setRevealOverlay({
      id,
      name: item.name,
      image: item.image || defaultBoxImage,
      originRect,
      targetRect,
      phase,
      revealedIds: undefined,
      hasRevealAttempted: false,
    });
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
    setLocalPendingReveals(loadPendingReveals(owner));
    setRecentRevealedBoxes(loadRecentReveals(owner).slice(0, RECENT_REVEALS_LIMIT));
    setLocalRevealedDudes([]);
    localDudeCacheRef.current.clear();
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    persistPendingReveals(owner, localPendingReveals);
  }, [owner, localPendingReveals]);

  useEffect(() => {
    if (!owner) return;
    persistRecentReveals(owner, recentRevealedBoxes);
  }, [owner, recentRevealedBoxes]);

  useEffect(() => {
    if (!owner) return;
    const recentSet = new Set(recentRevealedBoxes);
    const now = Date.now();
    if (!pendingOpenBoxesFetched) {
      const next = localPendingReveals.filter((entry) => !recentSet.has(entry.id));
      if (!pendingRevealListEqual(next, localPendingReveals)) {
        setLocalPendingReveals(next);
      }
      return;
    }
    const onchainIds = new Set(pendingOpenBoxes.map((entry) => entry.boxAssetId).filter(Boolean));
    const inventoryById = new Map(inventory.map((item) => [item.id, item]));
    const nextMap = new Map<string, LocalPendingReveal>();
    pendingOpenBoxes.forEach((entry) => {
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
  }, [owner, pendingOpenBoxes, pendingOpenBoxesFetched, localPendingReveals, recentRevealedBoxes, inventory]);

  useEffect(() => {
    if (!localRevealedDudes.length) return;
    const chainDudeIds = new Set(
      inventory.map((item) => item.dudeId).filter((id): id is number => typeof id === 'number'),
    );
    const next = localRevealedDudes.filter((entry) => !entry.dudeId || !chainDudeIds.has(entry.dudeId));
    if (next.length !== localRevealedDudes.length) {
      setLocalRevealedDudes(next);
    }
  }, [inventory, localRevealedDudes]);

  useEffect(() => {
    if (!localRevealedDudes.length) return;
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
  }, [localRevealedDudes.length, refetchInventory]);

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

  const localVisibleDudes = useMemo(() => {
    if (!localRevealedDudes.length) return [] as InventoryItem[];
    const chainDudeIds = new Set(
      inventory.map((item) => item.dudeId).filter((id): id is number => typeof id === 'number'),
    );
    return localRevealedDudes.filter((entry) => !entry.dudeId || !chainDudeIds.has(entry.dudeId));
  }, [inventory, localRevealedDudes]);

  const visibleInventory = useMemo(() => {
    const base = hiddenAssets.size ? inventory.filter((item) => !hiddenAssets.has(item.id)) : inventory;
    if (!localVisibleDudes.length) return base;
    return [...base, ...localVisibleDudes];
  }, [inventory, hiddenAssets, localVisibleDudes]);

  const defaultBoxImage = `${FRONTEND_DEPLOYMENT.paths.base}/box/tight.webp`;
  const recentRevealedSet = useMemo(() => new Set(recentRevealedBoxes), [recentRevealedBoxes]);
  const pendingOpenBoxesFiltered = useMemo(
    () => pendingOpenBoxes.filter((entry) => entry.boxAssetId && !recentRevealedSet.has(entry.boxAssetId)),
    [pendingOpenBoxes, recentRevealedSet],
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
  const pendingRevealItems = useMemo(() => {
    if (!pendingOpenBoxesFiltered.length && !localPendingFiltered.length) return [];
    const inventoryById = new Map(inventory.map((item) => [item.id, item]));
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
  }, [pendingOpenBoxesFiltered, localPendingFiltered, inventory, defaultBoxImage]);

  const inventoryItems = useMemo(() => {
    const boxes: typeof visibleInventory = [];
    const dudes: typeof visibleInventory = [];
    visibleInventory.forEach((item) => {
      if (pendingRevealIds.has(item.id)) return;
      if (item.kind === 'box') boxes.push(item);
      else if (item.kind === 'dude') dudes.push(item);
    });
    return [...pendingRevealItems, ...boxes, ...dudes];
  }, [visibleInventory, pendingRevealIds, pendingRevealItems]);
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
    const inventoryById = new Map(inventory.map((item) => [item.id, item]));
    return Array.from(selected)
      .map((id) => inventoryById.get(id))
      .filter((item): item is InventoryItem => Boolean(item));
  }, [selected, inventory]);
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
      let sig: string;
      try {
        sig = await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        showToast('Transaction expired before you approved it. Please approve again…');
        sig = await sendOnce();
      }
      showToast(`Minted ${quantity} boxes · ${sig}`);
      await Promise.all([refetchStats(), refetchInventory()]);
    } catch (err) {
      if (isUserRejectedError(err)) return;
      throw err;
    } finally {
      setMinting(false);
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
      addLocalPendingReveal(item);
      setRevealOverlay((prev) => {
        if (!prev || prev.id !== item.id) return prev;
        return { ...prev, phase: 'ready', revealedIds: undefined, hasRevealAttempted: false };
      });
      // Helius indexing can lag after transfers; hide immediately once the tx is confirmed.
      markAssetsHidden([item.id]);
      await Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
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
    if (!publicKey) throw new Error('Connect wallet first');
    // Ensure the wallet session exists (reveal is an authenticated callable).
    if (!token) {
      await signIn();
    }
    setRevealLoading(boxAssetId);
    try {
      const resp = await revealDudes(publicKey.toBase58(), boxAssetId);
      const revealed = (resp?.dudeIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
      setRevealOverlay((prev) => {
        if (!prev || prev.id !== boxAssetId) return prev;
        return { ...prev, phase: 'revealed', revealedIds: revealed };
      });
      removeLocalPendingReveal(boxAssetId);
      rememberRecentReveal(boxAssetId);
      void addLocalRevealedDudes(revealed);
      await Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
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
    if (!revealOverlay || revealOverlayClosing || revealLoading) return;
    if (revealOverlay.phase !== 'ready') return;
    if (!publicKey) {
      showToast('Connect wallet first');
      return;
    }
    setRevealOverlay((prev) => {
      if (!prev || prev.id !== revealOverlay.id) return prev;
      if (prev.hasRevealAttempted) return prev;
      return { ...prev, hasRevealAttempted: true };
    });
    void handleRevealDudes(revealOverlay.id);
  };

  const handleOpenSelectedBox = async () => {
    if (!selectedBox) return;
    if (typeof window !== 'undefined') {
      const originRect = findInventoryRect(selectedBox.id);
      const fallbackTarget = calcRevealTargetRect(window.innerWidth, window.innerHeight);
      const fallbackRect = new DOMRect(
        fallbackTarget.left,
        fallbackTarget.top,
        fallbackTarget.width,
        fallbackTarget.height,
      );
      const overlayItem: InventoryItem = { ...selectedBox, image: defaultBoxImage };
      openRevealOverlay(selectedBox.id, originRect || fallbackRect, 'preparing', overlayItem);
    }
    setSelected(new Set());
    await handleStartOpenBox(selectedBox);
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
      const item = inventory.find((entry) => entry.id === id);
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
  const shipmentsEmptyMessage = !profile ? 'Sign in to view your shipments.' : 'No shipments yet.';
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
  const revealOverlayNote =
    revealOverlay?.phase === 'preparing'
      ? 'preparing to unbox...'
      : revealOverlay?.phase === 'revealed'
        ? formatRevealIds(revealOverlay.revealedIds)
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
          className={`reveal-overlay reveal-overlay--${revealOverlay.phase}${revealOverlayActive ? ' reveal-overlay--active' : ''}${revealOverlayClosing ? ' reveal-overlay--closing' : ''}`}
          role="presentation"
          style={revealOverlayStyle}
          onClick={closeRevealOverlay}
        >
          <div className="reveal-overlay__backdrop" />
          <div
            className="reveal-overlay__frame"
            onTransitionEnd={(evt) => {
              if (evt.propertyName !== 'opacity') return;
              if (!revealOverlayClosing) return;
              setRevealOverlay(null);
              setRevealOverlayClosing(false);
              setRevealOverlayActive(false);
            }}
          >
            <button
              type="button"
              className="reveal-overlay__box"
              aria-label={`Reveal ${revealOverlay.name}`}
              aria-busy={revealLoading === revealOverlay.id}
              aria-disabled={revealOverlayClosing || revealLoading === revealOverlay.id || revealOverlay.phase !== 'ready'}
              onClick={(evt) => {
                evt.stopPropagation();
                handleRevealOverlayClick();
              }}
            >
              <img src={revealOverlay.image} alt={revealOverlay.name} className="reveal-overlay__image" />
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
          onReveal={openRevealOverlay}
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

      {authError ? <div className="error">{authError}</div> : null}
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
            {shipmentsEmptyMessage}
          </div>
          )
        ) : (
          <div className="muted small empty-state--hidden" aria-hidden="true">
            {shipmentsEmptyMessage}
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
