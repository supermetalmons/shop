import { useCallback, type TransitionEvent } from 'react';
import { PublicKey } from '@solana/web3.js';
import { isDropFamily } from '../../config/deployment';
import {
  usesAssetGatedRevealFlow,
  usesClearCard3dRevealFlow,
  usesInteractiveCardPackRevealFlow,
} from '../../config/dropsExtraContent';
import { revealDudes, revealDudesSubmissionUnknownDetails } from '../../api/commerce';
import { buildStartOpenBoxTxWithPending, fetchBoxMinterConfig } from '../../lib/boxMinter';
import { getMediaIdForFigureId } from '../../lib/figureMediaMap';
import { normalizeBoxDisplayImage } from '../../lib/dropContent';
import { soundPlayer } from '../../lib/SoundPlayer';
import { preloadPonchoDrifellaCardAssets, type PonchoDrifellaRevealRequestStatus } from '../../lib/ponchoDrifellaReveal';
import {
  getInteractiveCardPackCardByFigureId,
  getInteractiveCardPackRevealFigureIds,
  selectInteractiveCardPackRevealCardIdForDrop,
} from '../../lib/interactiveCardPackReveal';
import { clearCardModelIdFromRevealResult, clearCardModelUrl } from '../../lib/clearCardModels';
import { reconcileSubmittedTransaction, recoverAlreadyProcessedAccounts } from '../../lib/solana';
import { getInventoryRevealRect } from '../../lib/inventoryMediaRect';
import {
  calcAspectLockedRevealOriginRect,
  calcContainedMediaRevealOriginRect,
  calcClearCardRevealTargetRect,
  calcPonchoDrifellaAbsoluteCardRect,
  calcPonchoDrifellaRevealTargetRectInViewport,
  getRevealOverlayViewport as getOverlayViewport,
  offsetRevealOverlayRectForViewport,
  toRevealOverlayRect,
} from '../../lib/revealOverlayLayout';
import {
  applyRevealRequestRetry,
  requestRevealWithSubmissionRecovery,
  resolveRevealOverlayPhaseAfterReveal,
  type RevealOverlayPhase,
} from '../reveal';
import { isUserRejectedError } from '../commerce/transactionSupport';
import type { InventoryItem } from '../../types';
import { calcReceiptViewerTargetRectInViewport, calcRevealTargetRectForRendererInViewport } from './layout';
import { pickRandomSoundUrl } from './sounds';
import type { EarlyClearCardRevealGate, ImageViewerSize, ReceiptViewerImage, ReceiptViewerSource, RevealOverlayState } from './types';
import type { ShopRevealOptions } from './contracts';
import { useRevealAssets } from './useRevealAssets';
import { useRevealSession } from './useRevealSession';
import { useRevealPresentation } from './useRevealPresentation';

export function useShopReveal(options: ShopRevealOptions) {
  const {
    connectedWallet, publicKey, owner, inventory, pendingOpenBoxes, routeDrop,
    getDropContent, getDropConnection, requireKnownDropConfig,
    boxLabelForDropId, figureLabelForDropId, openGerundForDropId,
    canOpenBoxesForDropId, showToast, blockViewerModeAction,
    ensureSignedIn, sendAndConfirmViaConnection, retryAfterBlockhashExpiry,
    addLocalPendingReveal, removeLocalPendingReveal, rememberRecentReveal,
    addLocalRevealedDudes, markAssetsHidden, refetchInventory, refetchPendingOpenBoxes,
    clearSelection: clearInventorySelection, openWalletModal,
  } = options;
  const assets = useRevealAssets(options);
  const {
    usesInteractiveCardPackRevealForDropId, usesClearCard3dRevealForDropId,
    usesAssetGatedRevealForDropId, dropRevealIsAnimated,
    revealFrameCountForDropId, revealClickMaxForDropId, revealAutoplayStartForDropId,
    revealMediaStartForDropId, revealRendererForDropId, boxAspectRatioForDropId,
    resolveInteractiveCardPackMediaIdForBox, revealSoundUrlsForDropId,
    preloadRevealAssetsForPackMedia, preloadInteractiveCardPackRevealCardAssetsForDropId,
    preloadRevealVideos, ensureSoundReady, ponchoImageCacheRef,
    playClickSoundForDropId, playRevealSoundForDropId, playCardMotionSoundForDropId,
  } = assets;
  const session = useRevealSession({ ...options, assets });
  const {
    startOpenLoading, setStartOpenLoading, revealLoading, setRevealLoading,
    revealOverlay, setRevealOverlay, revealOverlayClosing,
    setInventorySnapshot, setPendingOpenSnapshot,
    ownerRef, connectedWalletRef, suspendedRef, presentationLoadingRef,
    openSelectedLockRef, openSelectedBoxIdRef, earlyClearCardRevealGateRef,
    revealOverlayRef, revealOverlaySessionRef, revealLoadingRequestCounterRef,
    revealLoadingRequestIdRef, revealSubmissionReconciliationAbortControllerRef,
    revealDismissLockedUntilRef, revealOverlayClosingRef,
    queueOverlayAction, clearRevealOverlayCloseTimeout, resetAssetGatedRevealDismissState,
    abortRevealSubmissionReconciliation, finalizeRevealOverlayDismissal,
    closeRevealOverlay, dismissRevealOverlay,
    canDismissAssetGatedRevealOverlay, startAutoOpening, presentRevealOverlay,
  } = session;
  const openRevealOverlay = (
    item: InventoryItem,
    rect: DOMRect,
    phase: RevealOverlayPhase = 'ready',
  ) => {
    const id = item.id;
    if (revealOverlayRef.current || revealLoading) return;
    if (startOpenLoading && startOpenLoading !== id) return;
    if (typeof window === 'undefined') return;
    const overlayDropId = item.dropId || routeDrop?.dropId;
    if (!overlayDropId) return;
    resetAssetGatedRevealDismissState();
    clearRevealOverlayCloseTimeout();
    const packMediaId = resolveInteractiveCardPackMediaIdForBox(overlayDropId, item.boxId);
    preloadRevealAssetsForPackMedia(overlayDropId, packMediaId);
    const inventoryOriginRect = toRevealOverlayRect(rect);
    const revealRenderer = revealRendererForDropId(overlayDropId);
    const boxAspectRatio = boxAspectRatioForDropId(overlayDropId);
    const targetRect = calcRevealTargetRectForRendererInViewport(
      revealRenderer,
      boxAspectRatio,
    );
    const originRect = usesClearCard3dRevealFlow(revealRenderer)
      ? calcContainedMediaRevealOriginRect(inventoryOriginRect, targetRect, boxAspectRatio)
      : inventoryOriginRect;
    setInventorySnapshot(inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);
    const nextOverlay: RevealOverlayState = {
      id,
      dropId: overlayDropId,
      name: item.name,
      image: normalizeBoxDisplayImage({ dropId: overlayDropId, imageRaw: item.image, boxId: item.boxId }),
      originRect,
      targetRect,
      phase,
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      packMediaId,
      interactiveRevealCardId: undefined,
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

  const handleStartOpenBox = async (item: InventoryItem) => {
    if (blockViewerModeAction()) return;
    if (!canOpenBoxesForDropId(item.dropId)) {
      showToast(`${boxLabelForDropId(item.dropId)} does not support opening.`);
      return;
    }
    if (!connectedWallet || !publicKey) {
      throw new Error(`Connect wallet to open a ${boxLabelForDropId(item.dropId)}`);
    }
    console.info('[mons] sending inventory asset to the vault', {
      assetId: item.id,
      dropId: item.dropId,
    });
    setStartOpenLoading(item.id);
    let earlyRevealGate: EarlyClearCardRevealGate | null = null;
    try {
      const targetDrop = requireKnownDropConfig(item.dropId, `inventory item ${item.id}`);
      const targetConnection = getDropConnection(targetDrop.dropId);
      const cfg = await fetchBoxMinterConfig(targetConnection, targetDrop);
      const enablesEarlyPackInteraction = isDropFamily(targetDrop, 'clear_cards');
      if (enablesEarlyPackInteraction) {
        let settleConfirmation!: (confirmed: boolean) => void;
        const confirmation = new Promise<boolean>((resolve) => {
          settleConfirmation = resolve;
        });
        earlyRevealGate = {
          boxAssetId: item.id,
          dropId: targetDrop.dropId,
          owner,
          revealSession: revealOverlaySessionRef.current,
          wallet: connectedWallet,
          confirmation,
          settleConfirmation,
        };
        earlyClearCardRevealGateRef.current = earlyRevealGate;
      }
      const sendOnce = async () => {
        const { tx, pendingPda } = await buildStartOpenBoxTxWithPending(
          targetConnection,
          cfg,
          publicKey,
          new PublicKey(item.id),
          targetDrop,
        );
        if (enablesEarlyPackInteraction) {
          setRevealOverlay((prev) => {
            if (!prev || prev.id !== item.id || prev.phase !== 'preparing') return prev;
            return { ...prev, phase: 'ready' };
          });
        }
        return sendAndConfirmViaConnection(tx, targetConnection, {
          onAlreadyProcessedWithoutSignature: (err) =>
            recoverAlreadyProcessedAccounts(targetConnection, [pendingPda], err),
        });
      };
      await retryAfterBlockhashExpiry(sendOnce, 'Transaction expired before you approved it. Please approve again…');
      earlyRevealGate?.settleConfirmation(true);
      console.info('[mons] inventory asset sent to the vault', {
        assetId: item.id,
        dropId: item.dropId,
      });
      queueOverlayAction(() => addLocalPendingReveal(item));
      setRevealOverlay((prev) => {
        if (!prev || prev.id !== item.id) return prev;
        if (enablesEarlyPackInteraction) {
          return { ...prev, phase: 'ready' };
        }
        return {
          ...prev,
          phase: 'ready',
          frame: 1,
          advanceClicks: 0,
          revealedIds: undefined,
          interactiveRevealCardId: undefined,
          hasRevealAttempted: false,
          autoOpening: false,
          autoMode: undefined,
        };
      });

      queueOverlayAction(() => markAssetsHidden([item.id]));
      queueOverlayAction(() => {
        void Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
      });
    } catch (err) {
      earlyRevealGate?.settleConfirmation(false);
      console.error(err);
      if (!isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : `Failed to open ${boxLabelForDropId(item.dropId)}`);
      }
      dismissRevealOverlay();
    } finally {
      if (earlyClearCardRevealGateRef.current === earlyRevealGate) {
        earlyClearCardRevealGateRef.current = null;
      }
      setStartOpenLoading(null);
    }
  };

  const handleRevealDudes = async (boxAssetId: string, dropId: string): Promise<PonchoDrifellaRevealRequestStatus> => {
    if (blockViewerModeAction()) return 'retry';
    if (!canOpenBoxesForDropId(dropId)) return 'resolved';
    if (revealLoadingRequestIdRef.current !== null) return 'resolved';
    if (!connectedWallet || !publicKey) return 'retry';
    const walletAddress = publicKey.toBase58();
    const requestSession = revealOverlaySessionRef.current;
    revealLoadingRequestCounterRef.current += 1;
    const loadingRequestId = revealLoadingRequestCounterRef.current;
    revealLoadingRequestIdRef.current = loadingRequestId;
    setRevealLoading(boxAssetId);
    abortRevealSubmissionReconciliation();
    const reconciliationController = new AbortController();
    revealSubmissionReconciliationAbortControllerRef.current = reconciliationController;
    const requestIsCurrent = () =>
      !reconciliationController.signal.aborted &&
      !suspendedRef.current &&
      revealOverlaySessionRef.current === requestSession &&
      connectedWalletRef.current === walletAddress;
    try {
      const signedIn = await ensureSignedIn();
      if (!signedIn) return 'retry';
      const revealDrop = requireKnownDropConfig(dropId, `reveal request for ${boxAssetId}`);
      const revealContent = getDropContent(revealDrop.dropId);
      const usesInteractiveCardPackFlow = usesInteractiveCardPackRevealFlow(revealContent.reveal.renderer);
      const usesClearCard3dFlow = usesClearCard3dRevealFlow(revealContent.reveal.renderer);
      const usesAssetGatedFlow = usesAssetGatedRevealFlow(revealContent.reveal.renderer);
      if (!requestIsCurrent()) return 'resolved';
      const revealResult = await requestRevealWithSubmissionRecovery({
        request: () => revealDudes(walletAddress, boxAssetId, revealDrop.dropId),
        recoveryDetails: (error) => revealDudesSubmissionUnknownDetails(error, revealDrop.dropId),
        reconcile: (submission, options) =>
          reconcileSubmittedTransaction(
            getDropConnection(revealDrop.dropId),
            submission,
            options,
          ),
        isCurrent: requestIsCurrent,
        signal: reconciliationController.signal,
      });
      if (revealResult.status === 'stale') return 'resolved';
      const resp = revealResult.response;
      const clearCardId = usesClearCard3dFlow
        ? clearCardModelIdFromRevealResult(resp?.dudeIds)
        : undefined;
      const revealed = usesClearCard3dFlow
        ? (clearCardId === undefined ? [] : [clearCardId])
        : (resp?.dudeIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (
        usesClearCard3dFlow &&
        clearCardId === undefined
      ) {
        showToast('The revealed Clear Card is unavailable. Tap the pack to retry.');
        return 'retry';
      }
      const selectedInteractiveRevealCardId = usesInteractiveCardPackFlow
        ? selectInteractiveCardPackRevealCardIdForDrop(revealDrop, revealed)
        : undefined;
      const interactiveRevealFigureIds = usesInteractiveCardPackFlow
        ? getInteractiveCardPackRevealFigureIds(revealDrop, revealed, selectedInteractiveRevealCardId)
        : [];
      preloadInteractiveCardPackRevealCardAssetsForDropId(revealDrop.dropId, interactiveRevealFigureIds);
      if (revealed.length) {
        revealDismissLockedUntilRef.current = Date.now() + 1_000;
      }
      if (!usesInteractiveCardPackFlow && revealed.length && revealContent.figures.revealPresentation === 'videos') {
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
        const nextPhase = resolveRevealOverlayPhaseAfterReveal({
          currentPhase: prev.phase,
          revealMode: revealContent.reveal.mode,
          usesAssetGatedFlow,
          frame: prev.frame,
          mediaStart: revealMediaStartForDropId(prev.dropId),
          hasResults,
        });
        return {
          ...prev,
          phase: nextPhase,
          revealedIds: revealed,
          interactiveRevealCardId: usesInteractiveCardPackFlow && hasResults
            ? prev.interactiveRevealCardId ?? selectedInteractiveRevealCardId
            : undefined,
        };
      });
      queueOverlayAction(() => removeLocalPendingReveal(boxAssetId));
      queueOverlayAction(() => rememberRecentReveal(boxAssetId));
      queueOverlayAction(() => addLocalRevealedDudes(revealed, revealDrop.dropId));
      queueOverlayAction(() => {
        void Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
      });
      return 'resolved';
    } catch (err) {
      if (!requestIsCurrent()) return 'resolved';
      console.error(err);
      const code = (err as { code?: string })?.code;
      if (code !== 'not-found' && !isUserRejectedError(err)) {
        showToast(err instanceof Error ? err.message : `Failed to reveal ${figureLabelForDropId(dropId, 2)}`);
      }
      return 'retry';
    } finally {
      if (revealSubmissionReconciliationAbortControllerRef.current === reconciliationController) {
        revealSubmissionReconciliationAbortControllerRef.current = null;
      }
      if (revealLoadingRequestIdRef.current === loadingRequestId) {
        revealLoadingRequestIdRef.current = null;
        setRevealLoading((current) => (current === boxAssetId ? null : current));
      }
    }
  };

  const ensureRevealOverlayAdvanceAllowed = useCallback(() => {
    if (blockViewerModeAction()) return false;
    if (!connectedWallet || !publicKey) {
      showToast('Connect wallet first');
      return false;
    }
    return true;
  }, [blockViewerModeAction, connectedWallet, publicKey, showToast]);

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
      const boxAssetId = revealOverlay.id;
      const dropId = revealOverlay.dropId;
      const requestSession = revealOverlaySessionRef.current;
      void (async () => {
        const status = await handleRevealDudes(boxAssetId, dropId);
        setRevealOverlay((current) => applyRevealRequestRetry(current, {
          status,
          requestSession,
          currentSession: revealOverlaySessionRef.current,
          boxAssetId,
          dropId,
        }));
      })();
    }
  };

  const handleRevealOverlayDismiss = () => {
    if (!revealOverlay || revealOverlayClosing) return;
    if (
      revealOverlay.viewerMode === 'poncho-card' ||
      revealOverlay.viewerMode === 'clear-card' ||
      revealOverlay.viewerMode === 'clear-pack' ||
      revealOverlay.viewerMode === 'receipt-image'
    ) {
      closeRevealOverlay();
      return;
    }
    const hasResults = Boolean(revealOverlay.revealedIds?.length);
    if (usesAssetGatedRevealForDropId(revealOverlay.dropId)) {
      if (!canDismissAssetGatedRevealOverlay(revealOverlay)) {
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
      if (typeof window === 'undefined') return;
      const originRect = findInventoryRect(box.id);
      const fallbackTarget = calcRevealTargetRectForRendererInViewport(
        revealRendererForDropId(box.dropId),
        boxAspectRatioForDropId(box.dropId),
      );
      const fallbackRect = new DOMRect(
        fallbackTarget.left,
        fallbackTarget.top,
        fallbackTarget.width,
        fallbackTarget.height,
      );
      openRevealOverlay(box, originRect || fallbackRect, 'preparing');
    },
    [
      canOpenBoxesForDropId,
      boxAspectRatioForDropId,
      openRevealOverlay,
      revealRendererForDropId,
    ],
  );

	  const openSelectedBox = async (selectedBox: InventoryItem) => {
      if (blockViewerModeAction()) return;
	    if (!selectedBox) return;
      if (!canOpenBoxesForDropId(selectedBox.dropId)) return;
	    if (!connectedWallet || !publicKey) {
	      openWalletModal();
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
	        queueOverlayAction(() => openPreparingOverlayForBox(selectedBox), 'presentation');
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
	      clearInventorySelection();
	      await handleStartOpenBox(selectedBox);
	    } finally {
	      if (openSelectedBoxIdRef.current === selectedBox.id) {
	        openSelectedBoxIdRef.current = null;
	      }
	      openSelectedLockRef.current = false;
	    }
	  };

  const openInteractiveCardViewer = useCallback((
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
    if (!usesInteractiveCardPackRevealForDropId(dropId)) return false;
    if (revealOverlayRef.current || revealLoading) return false;
    if (startOpenLoading) return false;
    if (typeof window === 'undefined') return false;

    const card = getInteractiveCardPackCardByFigureId(dropId, figureId);
    if (!card) return false;

    preloadPonchoDrifellaCardAssets(card, ponchoImageCacheRef.current, { mode: 'warm', priority: 'low' });
    resetAssetGatedRevealDismissState();
    clearRevealOverlayCloseTimeout();
    setInventorySnapshot(inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);

    const targetRect = calcPonchoDrifellaAbsoluteCardRect(
      calcPonchoDrifellaRevealTargetRectInViewport(),
    );
    const resolvedOriginRect = originRect
      ? calcAspectLockedRevealOriginRect(originRect, targetRect)
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
      originRect: toRevealOverlayRect(resolvedOriginRect),
      targetRect,
      phase: 'revealed',
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      packMediaId: undefined,
      interactiveRevealCardId: undefined,
      viewerMode: 'poncho-card',
      viewerFigureId: figureId,
      hasRevealAttempted: true,
      autoOpening: false,
      autoMode: undefined,
    });
    if (clearSelection) {
      clearInventorySelection();
    }
    return true;
  }, [
    clearRevealOverlayCloseTimeout,
    inventory,
    pendingOpenBoxes,
    presentRevealOverlay,
    resetAssetGatedRevealDismissState,
    revealLoading,
    startOpenLoading,
    usesInteractiveCardPackRevealForDropId,
  ]);

  const openClearCardModelViewer = useCallback((
    {
      overlayId,
      dropId,
      name,
      image,
      figureId,
      viewerMode,
      originRect,
      clearSelection = false,
    }: {
      overlayId: string;
      dropId: string;
      name: string;
      image?: string;
      figureId?: number;
      viewerMode: 'clear-card' | 'clear-pack';
      originRect?: DOMRect | null;
      clearSelection?: boolean;
    },
  ) => {
    if (!usesClearCard3dRevealForDropId(dropId)) return false;
    if (viewerMode === 'clear-card' && !clearCardModelUrl(figureId)) return false;
    if (revealOverlayRef.current || revealLoading) return false;
    if (startOpenLoading) return false;
    if (typeof window === 'undefined') return false;

    resetAssetGatedRevealDismissState();
    clearRevealOverlayCloseTimeout();
    setInventorySnapshot(inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);

    const viewport = getOverlayViewport();
    const targetRect = offsetRevealOverlayRectForViewport(
      calcClearCardRevealTargetRect(viewport.width, viewport.height),
      viewport,
    );
    const resolvedOriginRect = originRect
      ? viewerMode === 'clear-pack'
        ? calcContainedMediaRevealOriginRect(
            toRevealOverlayRect(originRect),
            targetRect,
            boxAspectRatioForDropId(dropId),
          )
        : calcAspectLockedRevealOriginRect(originRect, targetRect)
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
      originRect: toRevealOverlayRect(resolvedOriginRect),
      targetRect,
      phase: 'revealed',
      frame: 1,
      advanceClicks: 0,
      revealedIds: viewerMode === 'clear-card' && typeof figureId === 'number'
        ? [figureId]
        : undefined,
      packMediaId: undefined,
      interactiveRevealCardId: undefined,
      viewerMode,
      viewerFigureId: viewerMode === 'clear-card' ? figureId : undefined,
      hasRevealAttempted: true,
      autoOpening: false,
      autoMode: undefined,
    });
    if (clearSelection) {
      clearInventorySelection();
    }
    return true;
  }, [
    boxAspectRatioForDropId,
    clearRevealOverlayCloseTimeout,
    inventory,
    pendingOpenBoxes,
    presentRevealOverlay,
    resetAssetGatedRevealDismissState,
    revealLoading,
    startOpenLoading,
    usesClearCard3dRevealForDropId,
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
      adminIrlRedeemReceipt?: InventoryItem;
      allowMissingImage?: boolean;
    },
  ) => {
    if (revealOverlayRef.current || presentationLoadingRef.current) return false;
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
      ? calcAspectLockedRevealOriginRect(originRect, targetRect)
      : new DOMRect(targetRect.left, targetRect.top, targetRect.width, targetRect.height);

    resetAssetGatedRevealDismissState();
    clearRevealOverlayCloseTimeout();
    setInventorySnapshot(options?.inventorySnapshot ?? inventory);
    setPendingOpenSnapshot(pendingOpenBoxes);
    presentRevealOverlay({
      id: options?.overlayId || item.id,
      dropId: item.dropId,
      name: options?.overlayName || item.name,
      image: item.image,
      originRect: toRevealOverlayRect(resolvedOriginRect),
      targetRect,
      phase: 'revealed',
      frame: 1,
      advanceClicks: 0,
      revealedIds: undefined,
      packMediaId: undefined,
      interactiveRevealCardId: undefined,
      viewerMode: 'receipt-image',
      imageViewerSize: options?.size || 'receipt',
      receiptImages: options?.receiptImages,
      adminIrlRedeemReceipt: options?.adminIrlRedeemReceipt,
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
    resetAssetGatedRevealDismissState,
    showToast,
  ]);

  const openReceiptImageViewerGroup = useCallback((
    items: readonly ReceiptViewerSource[],
    originRect?: DOMRect | null,
    options?: {
      inventorySnapshot?: InventoryItem[];
      allowPlaceholders?: boolean;
      adminIrlRedeemReceipt?: InventoryItem;
    },
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
      adminIrlRedeemReceipt:
        receiptImages.length === 1 && options?.adminIrlRedeemReceipt?.id === firstReceipt.id
          ? options.adminIrlRedeemReceipt
          : undefined,
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
      adminIrlRedeemReceipt: item,
    });
  }, [openReceiptImageViewerGroup]);

  const viewItem = useCallback((selectedViewableItem: InventoryItem) => {
    if (!selectedViewableItem) return;
    const originRect = findInventoryRect(selectedViewableItem.id);
    if (selectedViewableItem.kind === 'box') {
      openClearCardModelViewer({
        overlayId: selectedViewableItem.id,
        dropId: selectedViewableItem.dropId,
        name: selectedViewableItem.name,
        image: selectedViewableItem.image,
        viewerMode: 'clear-pack',
        originRect,
        clearSelection: true,
      });
      return;
    }
    const figureId = selectedViewableItem.dudeId;
    if (typeof figureId !== 'number') return;
    if (usesClearCard3dRevealForDropId(selectedViewableItem.dropId)) {
      openClearCardModelViewer({
        overlayId: selectedViewableItem.id,
        dropId: selectedViewableItem.dropId,
        name: selectedViewableItem.name,
        image: selectedViewableItem.image,
        figureId,
        viewerMode: 'clear-card',
        originRect,
        clearSelection: true,
      });
      return;
    }
    openInteractiveCardViewer({
      overlayId: selectedViewableItem.id,
      dropId: selectedViewableItem.dropId,
      name: selectedViewableItem.name,
      image: selectedViewableItem.image,
      figureId,
      originRect,
      clearSelection: true,
    });
  }, [
    findInventoryRect,
    openClearCardModelViewer,
    openInteractiveCardViewer,
    usesClearCard3dRevealForDropId,
  ]);

  const handlePonchoOverlayRequestReveal = useCallback(() => {
    if (!revealOverlay) return 'retry' as const;
    const earlyRevealGate = earlyClearCardRevealGateRef.current;
    if (
      earlyRevealGate?.boxAssetId === revealOverlay.id &&
      earlyRevealGate.dropId === revealOverlay.dropId
    ) {
      return earlyRevealGate.confirmation.then((confirmed) =>
        confirmed &&
        !suspendedRef.current &&
        ownerRef.current === earlyRevealGate.owner &&
        connectedWalletRef.current === earlyRevealGate.wallet &&
        revealOverlaySessionRef.current === earlyRevealGate.revealSession &&
        revealOverlayRef.current?.id === earlyRevealGate.boxAssetId &&
        revealOverlayRef.current.dropId === earlyRevealGate.dropId &&
        !revealOverlayClosingRef.current
          ? handleRevealDudes(revealOverlay.id, revealOverlay.dropId)
          : 'resolved' as const,
      );
    }
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
  const handlePonchoOverlayPlayCardSwipe = useCallback(() => {
    if (!revealOverlay) return;
    playCardMotionSoundForDropId(revealOverlay.dropId, 'cardSwipe');
  }, [playCardMotionSoundForDropId, revealOverlay?.dropId]);
  const handlePonchoOverlayPlayCardSpread = useCallback(() => {
    if (!revealOverlay) return;
    playCardMotionSoundForDropId(revealOverlay.dropId, 'cardSpread');
  }, [playCardMotionSoundForDropId, revealOverlay?.dropId]);

  const openPendingReveal = async (item: InventoryItem, rect: DOMRect) => {
    if (blockViewerModeAction()) return;
    if (!connectedWallet || !publicKey) {
      openWalletModal();
      return;
    }
    const revealDropId = item.dropId || routeDrop?.dropId;
    if (!revealDropId) return;
    if (!canOpenBoxesForDropId(revealDropId)) return;
    const refreshedRect = findInventoryRect(item.id);
    openRevealOverlay(item, refreshedRect || rect);
    const signedIn = await ensureSignedIn();
    if (!signedIn && revealOverlayRef.current?.id === item.id) {
      closeRevealOverlay();
    }
  };

  const presentation = useRevealPresentation({ options, assets, revealOverlay });

  return {
    revealOverlay,
    revealOverlayOpen: session.revealOverlayOpen,
    revealOverlayActive: session.revealOverlayActive,
    revealOverlayClosing,
    startOpenLoading,
    revealLoading,
    inventoryView: session.inventoryView,
    pendingOpenBoxesView: session.pendingOpenBoxesView,
    getCurrentOverlay: session.getCurrentOverlay,
    isClosing: session.isClosing,
    queueOverlayAction,
    closeRevealOverlay,
    discardRevealOverlay: session.discardRevealOverlay,
    openSelectedBox,
    openPendingReveal,
    viewItem,
    openImageViewer,
    openReceiptImageViewerGroup,
    openReceiptImageViewer,
    openInteractiveCardViewer,
    openClearCardModelViewer,
    presentation,
    usesInteractiveCardPackRevealForDropId,
    usesClearCard3dRevealForDropId,
    boxImageForDropId: assets.boxImageForDropId,
    assets,
    routeDrop,
    suspended: options.suspended,
    handleRevealOverlayClick,
    handleRevealOverlayDismiss,
    handleRevealOverlayTransitionEnd,
    handlePonchoOverlayRequestReveal,
    handlePonchoOverlayPlayClick,
    handlePonchoOverlayPlayReveal,
    handlePonchoOverlayPlayCardSwipe,
    handlePonchoOverlayPlayCardSpread,
    ensureRevealOverlayAdvanceAllowed,
    updateAssetGatedRevealComplete: session.updateAssetGatedRevealComplete,
    updateClearCardDismissReady: session.updateClearCardDismissReady,
    updatePonchoDismissReady: session.updatePonchoDismissReady,
  };
}

export type ShopRevealController = ReturnType<typeof useShopReveal>;
