import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type TransitionEvent } from 'react';
import type { EthereumInventoryItem } from '../../shared/ethereum/protocol';
import { useOverlayScrollLock } from '../hooks/useOverlayScrollLock';
import { resolveDropContent } from '../lib/dropContent';
import { getInventoryRevealRect } from '../lib/inventoryMediaRect';
import { calcContainedMediaRevealOriginRect, getRevealOverlayViewport, revealOverlayStyleVars, sameRevealOverlayRect, toRevealOverlayRect } from '../lib/revealOverlayLayout';
import { soundPlayer } from '../lib/SoundPlayer';
import { calcReceiptViewerTargetRectInViewport, calcRevealTargetRectForRendererInViewport, getRenderedImagePreview } from '../shop/reveal/layout';
import { DEFAULT_BOX_SOUND_CLICK_URL, DEFAULT_BOX_SOUND_REVEAL_URL, REVEAL_CLOSE_FALLBACK_MS, REVEAL_OUTSIDE_TAP_DISMISS_LOCK_MS } from '../shop/reveal/sounds';
import type { OverlayRect } from '../shop/reveal/types';
import { ethereumInventoryView } from './state';

type PresentationOptions = {
  scope: string | null;
  suspended?: boolean;
  onUnpack: (items: readonly EthereumInventoryItem[]) => Promise<string | null>;
  applyArtwork?: (item: EthereumInventoryItem) => EthereumInventoryItem;
  onError?: (message: string) => void;
  unpackResults: Readonly<Record<string, readonly EthereumInventoryItem[]>>;
  unpackErrors: Readonly<Record<string, string>>;
};

type Presentation = {
  session: number;
  scope: string | null;
  mode: 'unpack' | 'viewer';
  items: readonly EthereumInventoryItem[];
  source: HTMLElement | null;
  sourceRect: OverlayRect | null;
  sourceImage?: string;
  originRect: OverlayRect;
  originViewport: OverlayRect;
  targetRect: OverlayRect;
  viewport: OverlayRect;
  active: boolean;
  closing: boolean;
  closeMode: 'return' | 'fade';
  attempted: boolean;
  transactionHash?: string;
  results: readonly EthereumInventoryItem[];
  resultsVisible: boolean;
};

function targetRect(mode: Presentation['mode'], item: EthereumInventoryItem, viewport = getRevealOverlayViewport()) {
  const dimensions = ethereumInventoryView(item).imageDimensions;
  const aspect = dimensions ? dimensions.width / dimensions.height : 1;
  if (mode === 'unpack' && item.kind === 'crate') {
    const width = Math.min(viewport.width * 0.76, viewport.height * 0.42 * aspect, 700);
    const height = width / aspect;
    return { left: viewport.left + (viewport.width - width) / 2, top: viewport.top + viewport.height * 0.56 - height / 2, width, height };
  }
  return mode === 'viewer' ? calcReceiptViewerTargetRectInViewport(aspect, 'shipment-figure', viewport)
    : calcRevealTargetRectForRendererInViewport(undefined, aspect, viewport);
}

function inventoryElement(id: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-inventory-id]')).find(element => element.dataset.inventoryId === id) ?? null;
}

function sameResults(left: readonly EthereumInventoryItem[], right: readonly EthereumInventoryItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.id === other.id && item.name === other.name && item.image === other.image &&
      item.animation_url === other.animation_url && item.category === other.category &&
      item.aspectRatio?.width === other.aspectRatio?.width && item.aspectRatio?.height === other.aspectRatio?.height;
  });
}

function isCrateUnpack(state: Presentation): boolean {
  return state.mode === 'unpack' && state.items.length === 1 && state.items[0].kind === 'crate';
}

export function useEthereumInventoryPresentation(options: PresentationOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [overlay, setOverlay] = useState<Presentation | null>(null);
  const viewerItem = useMemo(() => overlay?.mode === 'viewer' && overlay.scope === options.scope
    ? options.applyArtwork?.(overlay.items[0]) ?? overlay.items[0] : undefined,
  [overlay?.mode, overlay?.scope, overlay?.items, options.scope, options.applyArtwork]);
  const current = useRef<Presentation | null>(null);
  const sequence = useRef(0);
  const playedReveal = useRef(0);
  const dismissLockedUntil = useRef(0);
  const mounted = useRef(true);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((next: Presentation | null) => {
    current.current = next;
    if (mounted.current) setOverlay(next);
  }, []);
  const finishClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    update(null);
  }, [update]);
  const close = useCallback(() => {
    const state = current.current;
    if (!state || state.closing) return;
    const rect = state.source?.isConnected ? getInventoryRevealRect(state.source) : null;
    const canReturn = rect && state.sourceRect && sameRevealOverlayRect(rect, state.sourceRect) &&
      sameRevealOverlayRect(getRevealOverlayViewport(), state.originViewport) &&
      getRenderedImagePreview(state.source!, ethereumInventoryView(state.items[0]).image).src === state.sourceImage;
    update({ ...state, closing: true, active: false, closeMode: state.mode === 'viewer' && !canReturn ? 'fade' : 'return' });
    closeTimer.current = setTimeout(finishClose, REVEAL_CLOSE_FALLBACK_MS);
  }, [finishClose, update]);
  const dismiss = useCallback(() => {
    const state = current.current;
    if (state?.mode === 'unpack' && state.attempted && (!state.resultsVisible || Date.now() < dismissLockedUntil.current)) return;
    close();
  }, [close]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current = null;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);
  useLayoutEffect(() => {
    if (current.current && current.current.scope !== options.scope) finishClose();
  }, [options.scope, finishClose]);
  const present = useCallback((mode: Presentation['mode'], items: readonly EthereumInventoryItem[], rect?: DOMRect | null) => {
    if (!items.length || current.current || optionsRef.current.suspended) return false;
    const item = items[0];
    const source = inventoryElement(item.id);
    const viewport = getRevealOverlayViewport();
    const target = targetRect(mode, item, viewport);
    const sourceRect = rect ?? (source ? getInventoryRevealRect(source) : null);
    const origin = sourceRect && sourceRect.width > 0 && sourceRect.height > 0
      ? calcContainedMediaRevealOriginRect(sourceRect, target, target.width / target.height) : target;
    dismissLockedUntil.current = 0;
    update({ session: ++sequence.current, scope: optionsRef.current.scope, mode, items: [...items], source,
      sourceRect: source ? toRevealOverlayRect(getInventoryRevealRect(source)) : null,
      sourceImage: source ? getRenderedImagePreview(source, ethereumInventoryView(item).image).src : undefined,
      originRect: toRevealOverlayRect(origin), originViewport: viewport, targetRect: target, viewport,
      active: false, closing: false, closeMode: 'return', attempted: false, results: [], resultsVisible: false });
    return true;
  }, [update]);
  const openViewer = useCallback((item: EthereumInventoryItem, rect?: DOMRect | null) => present('viewer', [item], rect), [present]);
  useLayoutEffect(() => {
    const state = current.current;
    if (!state || state.mode !== 'viewer' || state.closing || !viewerItem) return;
    const target = targetRect('viewer', viewerItem, state.viewport);
    if (!sameRevealOverlayRect(target, state.targetRect)) update({ ...state, targetRect: target });
  }, [viewerItem, overlay?.viewport, update]);
  useLayoutEffect(() => {
    if (!overlay || overlay.active || overlay.closing) return;
    const session = overlay.session;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const state = current.current;
        if (state?.session === session && !state.closing) update({ ...state, active: true });
      });
    });
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); };
  }, [overlay?.session, overlay?.active, overlay?.closing, update]);
  const hideSource = !options.suspended && (!overlay?.closing || overlay.closeMode === 'return');
  useLayoutEffect(() => {
    const source = overlay?.source;
    if (!source || !hideSource) return;
    const visibility = source.style.getPropertyValue('visibility');
    const priority = source.style.getPropertyPriority('visibility');
    source.style.setProperty('visibility', 'hidden');
    return () => {
      if (visibility) source.style.setProperty('visibility', visibility, priority);
      else source.style.removeProperty('visibility');
    };
  }, [overlay?.source, hideSource]);
  useEffect(() => {
    if (!overlay) return;
    const resize = () => {
      const state = current.current;
      if (!state || state.closing) return;
      const viewport = getRevealOverlayViewport();
      const item = state.mode === 'viewer' ? optionsRef.current.applyArtwork?.(state.items[0]) ?? state.items[0] : state.items[0];
      update({ ...state, viewport, targetRect: targetRect(state.mode, item, viewport) });
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, [overlay?.session, update]);
  const requestUnpack = useCallback(async () => {
    const state = current.current;
    if (!state || state.mode !== 'unpack' || state.closing || state.results.length || optionsRef.current.suspended) return;
    const session = state.session;
    const isActive = () => current.current?.session === session && !current.current.closing && !optionsRef.current.suspended;
    if (!isCrateUnpack(state)) void soundPlayer.initializeOnUserInteraction(true).then(() => {
      if (!isActive()) return;
      void soundPlayer.playSound(DEFAULT_BOX_SOUND_CLICK_URL, resolveDropContent().reveal.sound.clickVolume, isActive);
      void soundPlayer.preloadSound(DEFAULT_BOX_SOUND_REVEAL_URL).catch(() => {});
    }).catch(() => {});
    if (state.attempted) return;
    update({ ...state, attempted: true, transactionHash: undefined, results: [], resultsVisible: false });
    let transactionHash: string | null = null;
    try { transactionHash = await optionsRef.current.onUnpack(state.items); } catch {}
    const latest = current.current;
    if (latest?.session !== session || latest.closing || latest.scope !== optionsRef.current.scope) return;
    update({ ...latest, attempted: Boolean(transactionHash), transactionHash: transactionHash?.toLowerCase() });
  }, [update]);
  const openUnpack = useCallback((items: readonly EthereumInventoryItem[], rect?: DOMRect | null) => {
    if (items.length !== 1) return false;
    if (!present('unpack', items, rect)) return false;
    void requestUnpack();
    return true;
  }, [present, requestUnpack]);
  useEffect(() => {
    const state = current.current;
    if (!state || state.mode !== 'unpack' || state.closing || !state.transactionHash || state.scope !== options.scope) return;
    const results = options.unpackResults[state.transactionHash];
    if (Object.hasOwn(options.unpackResults, state.transactionHash)) {
      if (!results.length) {
        update({ ...state, attempted: false, transactionHash: undefined });
        close();
      } else if (!sameResults(results, state.results)) update({ ...state, results });
    } else if (options.unpackErrors[state.transactionHash]) {
      if (options.suspended) return;
      const message = options.unpackErrors[state.transactionHash];
      update({ ...state, attempted: false, transactionHash: undefined });
      optionsRef.current.onError?.(message);
    }
  }, [overlay?.transactionHash, options.scope, options.suspended, options.unpackResults, options.unpackErrors, close, update]);
  useLayoutEffect(() => {
    if (!overlay?.results.length || overlay.resultsVisible || overlay.closing || isCrateUnpack(overlay)) return;
    const session = overlay.session;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const state = current.current;
        if (state?.session === session && !state.closing) {
          dismissLockedUntil.current = Date.now() + REVEAL_OUTSIDE_TAP_DISMISS_LOCK_MS;
          update({ ...state, resultsVisible: true });
        }
      });
    });
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); };
  }, [overlay?.session, overlay?.results.length, overlay?.resultsVisible, overlay?.closing, update]);
  useEffect(() => {
    if (!overlay?.resultsVisible || overlay.closing || options.suspended || isCrateUnpack(overlay) || playedReveal.current === overlay.session) return;
    const session = overlay.session;
    playedReveal.current = session;
    void soundPlayer.playSound(DEFAULT_BOX_SOUND_REVEAL_URL, resolveDropContent().reveal.sound.revealVolume,
      () => current.current?.session === session && !current.current.closing && !optionsRef.current.suspended);
  }, [overlay?.session, overlay?.resultsVisible, overlay?.closing, options.suspended]);
  const completeCrateReveal = useCallback((session: number) => {
    const state = current.current;
    if (!state || state.session !== session || state.closing || optionsRef.current.suspended || !isCrateUnpack(state) ||
      !state.results.length || state.resultsVisible) return;
    dismissLockedUntil.current = Date.now() + REVEAL_OUTSIDE_TAP_DISMISS_LOCK_MS;
    update({ ...state, resultsVisible: true });
  }, [update]);
  useOverlayScrollLock({ active: Boolean(overlay) && !options.suspended, escapeEnabled: !overlay?.closing, onEscape: close });
  const transitionEnd = useCallback((event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !current.current?.closing) return;
    if (event.propertyName === (current.current.mode === 'viewer' && current.current.closeMode === 'return' ? 'transform' : 'opacity')) finishClose();
  }, [finishClose]);
  const style: CSSProperties | undefined = overlay ? {
    ...revealOverlayStyleVars({ originRect: overlay.originRect, targetRect: overlay.targetRect }),
    ...(overlay.mode === 'viewer' && overlay.closeMode === 'fade' ? {
      '--reveal-close-transform': 'none', '--reveal-close-opacity': '0', '--reveal-close-transition': 'opacity 260ms ease',
    } : {}),
  } as CSSProperties : undefined;
  return { open: Boolean(overlay), overlay, viewerItem, style, openUnpack, openViewer, close, dismiss, requestUnpack, completeCrateReveal, transitionEnd };
}

export type EthereumInventoryPresentation = ReturnType<typeof useEthereumInventoryPresentation>;
