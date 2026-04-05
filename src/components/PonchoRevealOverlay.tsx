import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
  type TransitionEvent,
} from 'react';
import type { DrifCardConfig } from '../drifCards';
import {
  PONCHO_DRIFELLA_INITIAL_FRAME_URL,
  createPonchoDrifellaRevealPlayer,
  getPonchoDrifellaCardByFigureId,
  type PonchoDrifellaImageCache,
  type PonchoDrifellaRevealPhase,
  type PonchoDrifellaRevealPlayer,
  type PonchoDrifellaRevealPlayerViewState,
  type PonchoDrifellaRevealRequestStatus,
  usePonchoDrifellaCardAssetsReady,
  usePonchoDrifellaImageCacheGeneration,
} from '../lib/ponchoDrifellaReveal';
import WipInteractiveCard from './WipInteractiveCard';

type PonchoRevealSharedProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  boxName: string;
  imageCache: PonchoDrifellaImageCache;
  resetKey: string | number;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  onBeforeAdvance?: () => boolean;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
  onPackDiscardEnd?: () => void;
  onRevealCompleteChange?: (complete: boolean) => void;
};

type PonchoRevealRuntimeProps = PonchoRevealSharedProps & {
  card?: DrifCardConfig;
  cardReady: boolean;
  loading?: boolean;
  boxButtonRef?: RefObject<HTMLButtonElement | null>;
};

export type PonchoInventoryRevealOverlayProps = PonchoRevealSharedProps & {
  mode: 'inventory-unbox';
  revealedIds?: number[];
  loading: boolean;
};

export type PonchoCardViewerOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  card?: DrifCardConfig;
  loadingImageSrc?: string;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
};

function createInitialPlayerState(phase: PonchoDrifellaRevealPhase, boxLabel: string): PonchoDrifellaRevealPlayerViewState {
  return {
    phase,
    stage: 'idle',
    note: phase === 'ready' ? `click the ${boxLabel} to open` : '',
    advanceLocked: false,
    revealComplete: false,
    revealFailedOpen: false,
    cardInteractive: false,
    packDiscarded: false,
    stageVisible: false,
    cardVisible: false,
  };
}

function samePlayerState(a: PonchoDrifellaRevealPlayerViewState, b: PonchoDrifellaRevealPlayerViewState) {
  return (
    a.phase === b.phase &&
    a.stage === b.stage &&
    a.note === b.note &&
    a.advanceLocked === b.advanceLocked &&
    a.revealComplete === b.revealComplete &&
    a.revealFailedOpen === b.revealFailedOpen &&
    a.cardInteractive === b.cardInteractive &&
    a.packDiscarded === b.packDiscarded &&
    a.stageVisible === b.stageVisible &&
    a.cardVisible === b.cardVisible
  );
}

function clearPonchoCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawPonchoFrameToCanvas(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (!cssWidth || !cssHeight || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return false;
  }

  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5));
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  context.clearRect(0, 0, targetWidth, targetHeight);

  const scale = Math.min(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const drawX = (targetWidth - drawWidth) / 2;
  const drawY = (targetHeight - drawHeight) / 2;
  const downscaling = drawWidth < image.naturalWidth || drawHeight < image.naturalHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = downscaling && dpr <= 1.2 ? 'high' : 'medium';
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  return true;
}

function canDrawPonchoFrameToCanvas(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  return Boolean(cssWidth && cssHeight && image.naturalWidth > 0 && image.naturalHeight > 0);
}

function shouldSuspendPonchoCardResidentPreload(stage: PonchoDrifellaRevealPlayerViewState['stage']) {
  return stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2';
}

export function PonchoRevealOverlay({
  overlayStyle,
  active,
  closing,
  phase,
  boxLabel,
  boxName,
  card,
  cardReady,
  loading = false,
  boxButtonRef,
  imageCache,
  resetKey,
  onRequestReveal,
  onPlayClick,
  onPlayReveal,
  onBeforeAdvance,
  onDismiss,
  onTransitionEnd,
  onPackDiscardEnd,
  onRevealCompleteChange,
}: PonchoRevealRuntimeProps) {
  const imageCacheGeneration = usePonchoDrifellaImageCacheGeneration(imageCache);
  const boxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<PonchoDrifellaRevealPlayer | null>(null);
  const cardImageReadyRef = useRef(false);
  const discardAnimationReportedRef = useRef(false);
  const [hasCommittedBoxVisual, setHasCommittedBoxVisual] = useState(false);
  const [playerState, setPlayerState] = useState<PonchoDrifellaRevealPlayerViewState>(() =>
    createInitialPlayerState(phase, boxLabel),
  );
  const cardAssetsReady = usePonchoDrifellaCardAssetsReady({
    active,
    card,
    imageCache,
    suspendResidentPreload: shouldSuspendPonchoCardResidentPreload(playerState.stage),
  });

  const clearVisuals = useCallback(() => {
    clearPonchoCanvas(boxCanvasRef.current);
    clearPonchoCanvas(foregroundCanvasRef.current);
  }, []);

  const commitVisual = useCallback(
    ({
      boxImage,
      foregroundImage,
      stageVisible,
    }: {
      boxImage: HTMLImageElement;
      foregroundImage?: HTMLImageElement;
      stageVisible: boolean;
    }) => {
      if (!canDrawPonchoFrameToCanvas(boxCanvasRef.current, boxImage)) return false;
      if (stageVisible) {
        if (!foregroundImage) return false;
        if (!canDrawPonchoFrameToCanvas(foregroundCanvasRef.current, foregroundImage)) return false;
      }

      const boxDrawn = drawPonchoFrameToCanvas(boxCanvasRef.current, boxImage);
      if (!boxDrawn) return false;
      if (stageVisible) {
        const nextForegroundImage = foregroundImage;
        if (!nextForegroundImage) return false;
        const foregroundDrawn = drawPonchoFrameToCanvas(foregroundCanvasRef.current, nextForegroundImage);
        if (!foregroundDrawn) return false;
      } else {
        clearPonchoCanvas(foregroundCanvasRef.current);
      }
      setHasCommittedBoxVisual(true);
      return true;
    },
    [],
  );

  const handlePlayerStateChange = useCallback((nextState: PonchoDrifellaRevealPlayerViewState) => {
    setPlayerState((currentState) => (samePlayerState(currentState, nextState) ? currentState : nextState));
  }, []);

  useEffect(() => {
    if (active && playerState.revealComplete) return;
    discardAnimationReportedRef.current = false;
  }, [active, playerState.revealComplete]);

  useEffect(() => {
    if (!active) {
      playerRef.current?.dispose();
      playerRef.current = null;
      cardImageReadyRef.current = false;
      setHasCommittedBoxVisual(false);
      clearVisuals();
      setPlayerState(createInitialPlayerState(phase, boxLabel));
      return;
    }

    setHasCommittedBoxVisual(false);
    setPlayerState(createInitialPlayerState(phase, boxLabel));
    const player = createPonchoDrifellaRevealPlayer({
      active,
      phase,
      boxLabel,
      cardReady,
      cardAssetsReady,
      imageCache,
      host: {
        clearVisuals,
        commitVisual: (visual) =>
          commitVisual({
            boxImage: visual.boxImage,
            foregroundImage: visual.foregroundImage,
            stageVisible: visual.stageVisible,
          }),
        onStateChange: handlePlayerStateChange,
      },
      onRequestReveal,
      onPlayClick,
      onPlayReveal,
    });
    playerRef.current = player;
    if (cardImageReadyRef.current) {
      player.setCardImageReady(true);
    }

    return () => {
      if (playerRef.current === player) {
        playerRef.current = null;
      }
      cardImageReadyRef.current = false;
      player.dispose();
      clearVisuals();
    };
  }, [
    active,
    boxLabel,
    clearVisuals,
    commitVisual,
    handlePlayerStateChange,
    imageCache,
    imageCacheGeneration,
    resetKey,
  ]);

  useEffect(() => {
    playerRef.current?.update({
      active,
      phase,
      boxLabel,
      cardReady,
      cardAssetsReady,
      imageCache,
      onRequestReveal,
      onPlayClick,
      onPlayReveal,
    });
  }, [active, boxLabel, cardAssetsReady, cardReady, imageCache, onPlayClick, onPlayReveal, onRequestReveal, phase]);

  useEffect(() => {
    onRevealCompleteChange?.(playerState.revealComplete);
  }, [onRevealCompleteChange, playerState.revealComplete]);

  useEffect(() => {
    const boxCanvas = boxCanvasRef.current;
    if (!boxCanvas) return undefined;

    const redraw = () => {
      playerRef.current?.refreshVisuals();
    };

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(redraw);
      observer.observe(boxCanvas);
      return () => {
        observer.disconnect();
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', redraw);
      return () => {
        window.removeEventListener('resize', redraw);
      };
    }

    return undefined;
  }, []);

  const handleCardImageReadyChange = useCallback((ready: boolean) => {
    if (ready) {
      cardImageReadyRef.current = true;
    }
    playerRef.current?.setCardImageReady(ready);
  }, []);

  const stopOverlayDismiss = (evt: SyntheticEvent) => {
    evt.stopPropagation();
  };

  const handlePackDiscardAnimationEnd = (evt: AnimationEvent<HTMLElement>) => {
    if (evt.animationName !== 'wip-pack-discard') return;
    if (!playerState.packDiscarded) return;
    if (discardAnimationReportedRef.current) return;
    discardAnimationReportedRef.current = true;
    onPackDiscardEnd?.();
  };

  const handleAdvance = () => {
    if (closing) return;
    if (onBeforeAdvance && !onBeforeAdvance()) return;
    playerRef.current?.handleAdvance();
  };

  const boxDisabled = closing || playerState.phase !== 'ready' || playerState.revealComplete || playerState.advanceLocked;
  const cardLocked = playerState.packDiscarded && playerState.cardVisible && !playerState.cardInteractive;

  return (
    <div
      className={`reveal-overlay wip-overlay reveal-overlay--${playerState.phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={onDismiss}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className={`reveal-overlay__shine${playerState.cardVisible ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
        <button
          ref={boxButtonRef}
          type="button"
          className={`reveal-overlay__box${playerState.packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
          aria-label={`Reveal ${boxName}`}
          aria-busy={loading}
          aria-disabled={boxDisabled}
          disabled={boxDisabled}
          onClick={(evt) => {
            evt.stopPropagation();
            handleAdvance();
          }}
          onAnimationEnd={handlePackDiscardAnimationEnd}
        >
          {!hasCommittedBoxVisual ? (
            <img
              src={PONCHO_DRIFELLA_INITIAL_FRAME_URL}
              alt=""
              className="reveal-overlay__image"
              loading="eager"
              decoding="async"
              draggable={false}
              aria-hidden="true"
            />
          ) : null}
          <canvas ref={boxCanvasRef} className="reveal-overlay__image" aria-hidden="true" />
        </button>
        <div className={`wip-reveal__stage${playerState.stageVisible ? ' wip-reveal__stage--visible' : ''}`} aria-hidden={!playerState.stageVisible}>
          {card ? (
            <div
              className={`reveal-overlay__media wip-reveal__media${playerState.cardVisible ? ' wip-reveal__media--visible' : ''}${playerState.cardInteractive ? ' wip-reveal__media--interactive' : ''}${cardLocked ? ' wip-reveal__media--locked' : ''}`}
              aria-hidden={!playerState.cardVisible || !playerState.cardInteractive}
            >
              <div
                className={`reveal-overlay__media-item wip-reveal__card-item${playerState.cardInteractive ? ' wip-reveal__card-item--interactive' : ''}${cardLocked ? ' wip-reveal__card-item--locked' : ''}`}
                onClick={playerState.cardInteractive || cardLocked ? stopOverlayDismiss : undefined}
              >
                <div className="reveal-overlay__media-float">
                  <WipInteractiveCard
                    card={card}
                    interactive={playerState.cardInteractive}
                    onImageReadyChange={handleCardImageReadyChange}
                  />
                </div>
              </div>
            </div>
          ) : null}
          <div
            className={`wip-reveal__foreground${playerState.packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
            aria-hidden="true"
            onAnimationEnd={handlePackDiscardAnimationEnd}
          >
            <canvas
              ref={foregroundCanvasRef}
              className="reveal-overlay__image wip-reveal__foreground-image"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      <div className="reveal-overlay__note">{playerState.note}</div>
    </div>
  );
}

export default function PonchoInventoryRevealOverlay({
  mode: _mode,
  revealedIds,
  ...overlayProps
}: PonchoInventoryRevealOverlayProps) {
  const revealedCard = useMemo(() => {
    if (!revealedIds?.length || revealedIds.length !== 1) return undefined;
    return getPonchoDrifellaCardByFigureId(revealedIds[0]);
  }, [revealedIds]);

  return <PonchoRevealOverlay {...overlayProps} card={revealedCard} cardReady={Boolean(revealedCard)} />;
}

export function PonchoCardViewerOverlay({
  overlayStyle,
  active,
  closing,
  card,
  loadingImageSrc,
  onDismiss,
  onTransitionEnd,
}: PonchoCardViewerOverlayProps) {
  const stopOverlayDismiss = (evt: SyntheticEvent) => {
    evt.stopPropagation();
  };

  return (
    <div
      className={`reveal-overlay wip-overlay poncho-card-viewer-overlay reveal-overlay--revealed${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={onDismiss}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className="wip-reveal__stage wip-reveal__stage--visible">
          {card ? (
            <div className="reveal-overlay__media wip-reveal__media wip-reveal__media--visible wip-reveal__media--interactive">
              <div
                className="reveal-overlay__media-item wip-reveal__card-item wip-reveal__card-item--interactive"
                onClick={stopOverlayDismiss}
              >
                <div className="reveal-overlay__media-float">
                  <WipInteractiveCard card={card} interactive loadingImageSrc={loadingImageSrc} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
