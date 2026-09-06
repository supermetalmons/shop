import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InventoryItem, PendingOpenBox } from '../../types';
import { useOverlayScrollLock } from '../../hooks/useOverlayScrollLock';
import {
  runDeferredOverlayActions,
  type DeferredOverlayAction,
  type DeferredOverlayActionKind,
} from '../../lib/deferredOverlayActions';
import {
  calcPonchoDrifellaAbsoluteCardRect,
  calcPonchoDrifellaRevealTargetRectInViewport,
  getRevealOverlayViewport as getOverlayViewport,
  sameRevealOverlayRect,
} from '../../lib/revealOverlayLayout';
import { calcReceiptViewerTargetRectInViewport, calcRevealTargetRectForRendererInViewport } from './layout';
import { PONCHO_OUTSIDE_TAP_DISMISS_LOCK_MS, REVEAL_CLOSE_FALLBACK_MS } from './sounds';
import type { PonchoRevealDismissReadySource } from '../../components/PonchoRevealOverlay';
import type { EarlyClearCardRevealGate, RevealOverlayState } from './types';
import type { ShopRevealOptions } from './contracts';
import type { RevealAssets } from './useRevealAssets';

type RevealSessionOptions = Pick<ShopRevealOptions,
  'connectedWallet' | 'owner' | 'localAccountWallet' | 'suspended' |
  'walletModalVisible' | 'receiptTransferOpen' | 'inventory' | 'pendingOpenBoxes'
> & {
  assets: Pick<RevealAssets,
    'usesClearCard3dRevealForDropId' | 'usesAssetGatedRevealForDropId' |
    'dropRevealIsAnimated' | 'revealFrameCountForDropId' | 'revealMediaStartForDropId' |
    'revealRendererForDropId' | 'boxAspectRatioForDropId' | 'clearRevealVideos' | 'resetRevealAssets'
  >;
};

export function useRevealSession({
  connectedWallet, owner, localAccountWallet, suspended, walletModalVisible,
  receiptTransferOpen, inventory, pendingOpenBoxes, assets,
}: RevealSessionOptions) {
  const {
    usesClearCard3dRevealForDropId, usesAssetGatedRevealForDropId,
    dropRevealIsAnimated, revealFrameCountForDropId, revealMediaStartForDropId,
    revealRendererForDropId, boxAspectRatioForDropId, clearRevealVideos, resetRevealAssets,
  } = assets;
  const [startOpenLoading, setStartOpenLoading] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState<string | null>(null);
  const [revealOverlay, setRevealOverlay] = useState<RevealOverlayState | null>(null);
  const [revealOverlayActive, setRevealOverlayActive] = useState(false);
  const [revealOverlayClosing, setRevealOverlayClosing] = useState(false);
  const [inventorySnapshot, setInventorySnapshot] = useState<InventoryItem[]>([]);
  const [pendingOpenSnapshot, setPendingOpenSnapshot] = useState<PendingOpenBox[]>([]);
  const inventoryView = revealOverlay ? inventorySnapshot : inventory;
  const pendingOpenBoxesView = revealOverlay ? pendingOpenSnapshot : pendingOpenBoxes;
  const revealOverlayOpen = Boolean(revealOverlay);
  const freezeClearCardUnpackingPage = Boolean(
    revealOverlay && revealOverlay.viewerMode === undefined &&
    usesClearCard3dRevealForDropId(revealOverlay.dropId)
  );
  const revealOverlayRafRef = useRef<number | null>(null);
  const revealOverlayResizeRafRef = useRef<number | null>(null);
  const connectedWalletRef = useRef<string | null>(connectedWallet || null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const previousConnectedWalletForOwnerRef = useRef(connectedWallet);
  const openSelectedLockRef = useRef(false);
  const openSelectedBoxIdRef = useRef<string | null>(null);
  const interactiveRevealCompleteRef = useRef(false);
  const deferredOverlayActionsRef = useRef<DeferredOverlayAction[]>([]);
  const revealOverlayRef = useRef<RevealOverlayState | null>(null);
  const presentationLoadingRef = useRef(Boolean(revealLoading || startOpenLoading));
  presentationLoadingRef.current = Boolean(revealLoading || startOpenLoading);
  const earlyClearCardRevealGateRef = useRef<EarlyClearCardRevealGate | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const revealOverlaySessionRef = useRef(0);
  const revealLoadingRequestCounterRef = useRef(0);
  const revealLoadingRequestIdRef = useRef<number | null>(null);
  const revealSubmissionReconciliationAbortControllerRef = useRef<AbortController | null>(null);
  const revealDismissLockedUntilRef = useRef<number>(0);
  const interactiveRevealDismissReadyRef = useRef(false);
  const revealOverlayActiveRef = useRef(false);
  const revealOverlayClosingRef = useRef(false);
  const revealOverlayCloseTimeoutRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    connectedWalletRef.current = connectedWallet || null;
  }, [connectedWallet]);
  const queueOverlayAction = useCallback(
    (run: () => void, kind: DeferredOverlayActionKind = 'reconcile') => {
      if (
        revealOverlayRef.current ||
        (kind === 'presentation' && (suspendedRef.current || presentationLoadingRef.current))
      ) {
        deferredOverlayActionsRef.current.push({ kind, run });
        return;
      }
      run();
    },
    [],
  );

  const flushOverlayActions = useCallback(
    ({
      includePresentationActions = true,
    }: { includePresentationActions?: boolean } = {}) => {
      if (revealOverlayRef.current) return;
      const actions = deferredOverlayActionsRef.current;
      if (!actions.length) return;
      const includePresentation = (
        includePresentationActions &&
        !suspendedRef.current &&
        !presentationLoadingRef.current
      );
      deferredOverlayActionsRef.current = includePresentation
        ? []
        : actions.filter((action) => action.kind === 'presentation');
      runDeferredOverlayActions(actions, {
        includePresentation,
      });
    },
    [],
  );

  useEffect(() => {
    if (suspended || revealOverlay || revealLoading || startOpenLoading) return;
    flushOverlayActions();
  }, [flushOverlayActions, revealLoading, revealOverlay, startOpenLoading, suspended]);
  const clearRevealOverlayCloseTimeout = useCallback(() => {
    if (revealOverlayCloseTimeoutRef.current === null) return;
    if (typeof window === 'undefined') return;
    window.clearTimeout(revealOverlayCloseTimeoutRef.current);
    revealOverlayCloseTimeoutRef.current = null;
  }, []);

  const markPonchoRevealDismissReady = useCallback((lockOutsideTap = true) => {
    interactiveRevealDismissReadyRef.current = true;
    revealDismissLockedUntilRef.current = lockOutsideTap
      ? Date.now() + PONCHO_OUTSIDE_TAP_DISMISS_LOCK_MS
      : 0;
  }, []);

  const updatePonchoDismissReady = useCallback(
    (ready: boolean, source?: PonchoRevealDismissReadySource) => {
      if (ready) {
        switch (source) {
          case 'row':
            markPonchoRevealDismissReady(false);
            return;
          case 'card':
          default:
            markPonchoRevealDismissReady(true);
            return;
        }
      }
      interactiveRevealDismissReadyRef.current = false;
    },
    [markPonchoRevealDismissReady],
  );

  const updateAssetGatedRevealComplete = useCallback((complete: boolean) => {
    interactiveRevealCompleteRef.current = complete;
  }, []);

  const updateClearCardDismissReady = useCallback((ready: boolean) => {
    interactiveRevealDismissReadyRef.current = ready;
    revealDismissLockedUntilRef.current = 0;
  }, []);

  const resetAssetGatedRevealDismissState = useCallback(() => {
    revealDismissLockedUntilRef.current = 0;
    interactiveRevealDismissReadyRef.current = false;
    updateAssetGatedRevealComplete(false);
  }, [updateAssetGatedRevealComplete]);

  const abortRevealSubmissionReconciliation = useCallback(() => {
    revealSubmissionReconciliationAbortControllerRef.current?.abort();
    revealSubmissionReconciliationAbortControllerRef.current = null;
  }, []);

  const resetRevealRequestState = useCallback(() => {
    abortRevealSubmissionReconciliation();
    revealOverlaySessionRef.current += 1;
    revealLoadingRequestIdRef.current = null;
    setRevealLoading(null);
  }, [abortRevealSubmissionReconciliation]);

  useEffect(
    () => () => abortRevealSubmissionReconciliation(),
    [abortRevealSubmissionReconciliation],
  );

  const finalizeRevealOverlayDismissal = useCallback(
    ({
      flushActions = true,
      includePresentationActions = true,
    }: {
      flushActions?: boolean;
      includePresentationActions?: boolean;
    } = {}) => {
      abortRevealSubmissionReconciliation();
      clearRevealOverlayCloseTimeout();
      revealOverlayRef.current = null;
      resetAssetGatedRevealDismissState();
      setRevealOverlay(null);
      setRevealOverlayClosing(false);
      setRevealOverlayActive(false);
      clearRevealVideos();
      if (flushActions) {
        flushOverlayActions({ includePresentationActions });
        return;
      }
      deferredOverlayActionsRef.current = [];
    },
    [
      abortRevealSubmissionReconciliation,
      clearRevealOverlayCloseTimeout,
      clearRevealVideos,
      flushOverlayActions,
      resetAssetGatedRevealDismissState,
    ],
  );

  const cancelRevealOverlayAnimationFrame = useCallback(() => {
    if (revealOverlayRafRef.current === null) return;
    cancelAnimationFrame(revealOverlayRafRef.current);
    revealOverlayRafRef.current = null;
  }, []);

  useEffect(() => {
    if (!suspended || (!revealOverlayRef.current && !revealOverlay)) return;
    cancelRevealOverlayAnimationFrame();
    finalizeRevealOverlayDismissal({ includePresentationActions: false });
  }, [
    cancelRevealOverlayAnimationFrame,
    finalizeRevealOverlayDismissal,
    revealOverlay,
    suspended,
  ]);

  const closeRevealOverlay = useCallback(() => {
    const overlay = revealOverlayRef.current;
    if (!overlay) return;
    if (revealOverlayClosingRef.current) return;
    abortRevealSubmissionReconciliation();
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
  }, [
    abortRevealSubmissionReconciliation,
    cancelRevealOverlayAnimationFrame,
    clearRevealOverlayCloseTimeout,
    finalizeRevealOverlayDismissal,
  ]);

  const canDismissAssetGatedRevealOverlay = useCallback((overlay: Pick<RevealOverlayState, 'revealedIds'>) => {
    const hasResults = Boolean(overlay.revealedIds?.length);
    if (!interactiveRevealCompleteRef.current) return false;
    if (hasResults && !interactiveRevealDismissReadyRef.current) return false;
    if (hasResults && Date.now() < revealDismissLockedUntilRef.current) return false;
    return true;
  }, []);

  const canDismissRevealOverlayFromKeyboard = useCallback(() => {
    const overlay = revealOverlayRef.current;
    if (!overlay) return false;
    if (
      overlay.viewerMode === 'poncho-card' ||
      overlay.viewerMode === 'clear-card' ||
      overlay.viewerMode === 'clear-pack' ||
      overlay.viewerMode === 'receipt-image'
    ) return true;
    if (usesAssetGatedRevealForDropId(overlay.dropId)) {
      return canDismissAssetGatedRevealOverlay(overlay);
    }
    return true;
  }, [canDismissAssetGatedRevealOverlay, usesAssetGatedRevealForDropId]);

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
      if (suspendedRef.current) return;
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


  useEffect(() => {
    const walletChanged = previousConnectedWalletForOwnerRef.current !== connectedWallet;
    previousConnectedWalletForOwnerRef.current = connectedWallet;
    if (walletChanged) discardRevealOverlay();
    else closeRevealOverlay();
  }, [closeRevealOverlay, connectedWallet, discardRevealOverlay, owner]);

  useEffect(() => {
    resetRevealRequestState();
    setInventorySnapshot([]);
    setPendingOpenSnapshot([]);
    resetRevealAssets();
    deferredOverlayActionsRef.current = [];
  }, [localAccountWallet, resetRevealRequestState, resetRevealAssets]);

  useEffect(() => {
    if (revealOverlay) return;
    setInventorySnapshot(inventory);
  }, [inventory, revealOverlay]);

  useEffect(() => {
    if (revealOverlay) return;
    setPendingOpenSnapshot(pendingOpenBoxes);
  }, [pendingOpenBoxes, revealOverlay]);

  useEffect(() => {
    revealOverlayRef.current = suspended ? null : revealOverlay;
  }, [revealOverlay, suspended]);

  useEffect(() => {
    revealOverlayActiveRef.current = suspended ? false : revealOverlayActive;
  }, [revealOverlayActive, suspended]);

  useEffect(() => {
    revealOverlayClosingRef.current = suspended ? false : revealOverlayClosing;
  }, [revealOverlayClosing, suspended]);
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

  const handleRevealOverlayEscape = useCallback(() => {
    if (walletModalVisible || receiptTransferOpen) return;
    if (canDismissRevealOverlayFromKeyboard()) {
      closeRevealOverlay();
    }
  }, [
    canDismissRevealOverlayFromKeyboard,
    closeRevealOverlay,
    receiptTransferOpen,
    walletModalVisible,
  ]);

  useOverlayScrollLock({
    active: revealOverlayOpen,
    escapeEnabled: !walletModalVisible && !receiptTransferOpen,
    freezePage: freezeClearCardUnpackingPage,
    onEscape: handleRevealOverlayEscape,
  });

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
              : calcRevealTargetRectForRendererInViewport(
                  revealRendererForDropId(prev.dropId),
                  boxAspectRatioForDropId(prev.dropId),
                  viewport,
                );
          if (sameRevealOverlayRect(prev.targetRect, nextTarget)) {
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
  }, [boxAspectRatioForDropId, revealOverlayOpen, revealRendererForDropId]);

  useEffect(() => () => {
    cancelRevealOverlayAnimationFrame();
    if (revealOverlayResizeRafRef.current) {
      cancelAnimationFrame(revealOverlayResizeRafRef.current);
    }
    if (revealOverlayCloseTimeoutRef.current !== null) {
      clearTimeout(revealOverlayCloseTimeoutRef.current);
    }
  }, [cancelRevealOverlayAnimationFrame]);

  const getCurrentOverlay = useCallback(() => revealOverlayRef.current, []);
  const isClosing = useCallback(() => revealOverlayClosingRef.current, []);

  return {
    startOpenLoading, setStartOpenLoading, revealLoading, setRevealLoading,
    revealOverlay, setRevealOverlay, revealOverlayActive, revealOverlayClosing,
    inventoryView, pendingOpenBoxesView, revealOverlayOpen,
    setInventorySnapshot, setPendingOpenSnapshot,
    ownerRef, connectedWalletRef, suspendedRef, presentationLoadingRef,
    openSelectedLockRef, openSelectedBoxIdRef, earlyClearCardRevealGateRef,
    revealOverlayRef, revealOverlaySessionRef, revealLoadingRequestCounterRef,
    revealLoadingRequestIdRef, revealSubmissionReconciliationAbortControllerRef,
    revealDismissLockedUntilRef, revealOverlayClosingRef,
    queueOverlayAction, clearRevealOverlayCloseTimeout, resetAssetGatedRevealDismissState,
    updateAssetGatedRevealComplete, updatePonchoDismissReady, updateClearCardDismissReady,
    abortRevealSubmissionReconciliation, finalizeRevealOverlayDismissal,
    closeRevealOverlay, dismissRevealOverlay, discardRevealOverlay,
    canDismissAssetGatedRevealOverlay, startAutoOpening, presentRevealOverlay,
    getCurrentOverlay, isClosing,
  };
}
