import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  getPonchoDrifellaCardByFigureId,
  type PonchoDrifellaImageCache,
  type PonchoDrifellaRevealPhase,
  type PonchoDrifellaRevealRequestStatus,
  usePonchoDrifellaImageCacheGeneration,
  usePonchoDrifellaRevealController,
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
  cardAssetsReady: boolean;
  loading?: boolean;
  boxButtonRef?: RefObject<HTMLButtonElement | null>;
};

export type PonchoInventoryRevealOverlayProps = PonchoRevealSharedProps & {
  mode: 'inventory-unbox';
  revealedIds?: number[];
  cardAssetsReady: boolean;
  loading: boolean;
};

type PonchoFrameCanvasProps = {
  image?: HTMLImageElement;
  className: string;
  onDrawComplete?: () => void;
  redrawToken?: string;
  drawMode?: 'deferred' | 'immediate';
};

type SessionReadyState = {
  ready: boolean;
  sessionKey: string;
};

type SessionForegroundPaintState = {
  frameSrc: string | null;
  sessionKey: string;
};

type SessionVisibleLatchState = {
  sessionKey: string;
  visible: boolean;
};

function createSessionReadyState(sessionKey: string, ready = false): SessionReadyState {
  return {
    ready,
    sessionKey,
  };
}

function createSessionForegroundPaintState(
  sessionKey: string,
  frameSrc: string | null = null,
): SessionForegroundPaintState {
  return {
    frameSrc,
    sessionKey,
  };
}

function createSessionVisibleLatchState(sessionKey: string, visible = false): SessionVisibleLatchState {
  return {
    sessionKey,
    visible,
  };
}

function PonchoFrameCanvas({
  image,
  className,
  onDrawComplete,
  redrawToken,
  drawMode = 'deferred',
}: PonchoFrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | undefined>(image);
  const drawRafRef = useRef<number | null>(null);
  const lastRenderSignatureRef = useRef<string>('');
  const onDrawCompleteRef = useRef(onDrawComplete);

  useLayoutEffect(() => {
    onDrawCompleteRef.current = onDrawComplete;
  }, [onDrawComplete]);

  const cancelScheduledDraw = useCallback(() => {
    if (drawRafRef.current === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(drawRafRef.current);
    drawRafRef.current = null;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (!cssWidth || !cssHeight) {
      lastRenderSignatureRef.current = '';
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const frameImage = imageRef.current;
    const imageKey = frameImage ? frameImage.currentSrc || frameImage.src : '';
    const dpr = typeof window === 'undefined' ? 1 : Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5));
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
    const renderSignature = `${targetWidth}x${targetHeight}|${imageKey}`;
    if (lastRenderSignatureRef.current === renderSignature) {
      return;
    }
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    context.clearRect(0, 0, targetWidth, targetHeight);
    if (!frameImage || frameImage.naturalWidth <= 0 || frameImage.naturalHeight <= 0) {
      lastRenderSignatureRef.current = '';
      return;
    }

    const scale = Math.min(targetWidth / frameImage.naturalWidth, targetHeight / frameImage.naturalHeight);
    const drawWidth = frameImage.naturalWidth * scale;
    const drawHeight = frameImage.naturalHeight * scale;
    const drawX = (targetWidth - drawWidth) / 2;
    const drawY = (targetHeight - drawHeight) / 2;
    const downscaling = drawWidth < frameImage.naturalWidth || drawHeight < frameImage.naturalHeight;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = downscaling && dpr <= 1.2 ? 'high' : 'medium';
    context.drawImage(frameImage, drawX, drawY, drawWidth, drawHeight);
    lastRenderSignatureRef.current = renderSignature;
    onDrawCompleteRef.current?.();
  }, []);

  const scheduleDraw = useCallback(() => {
    if (typeof window === 'undefined') {
      draw();
      return;
    }
    if (drawRafRef.current !== null) return;
    drawRafRef.current = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      draw();
    });
  }, [draw]);

  useLayoutEffect(() => {
    if (drawMode !== 'immediate') return;
    imageRef.current = image;
    lastRenderSignatureRef.current = '';
    cancelScheduledDraw();
    draw();
  }, [cancelScheduledDraw, draw, drawMode, image, redrawToken]);

  useEffect(() => {
    if (drawMode !== 'deferred') return;
    imageRef.current = image;
    lastRenderSignatureRef.current = '';
    scheduleDraw();
  }, [drawMode, image, redrawToken, scheduleDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        scheduleDraw();
      });
      observer.observe(canvas);
      return () => {
        observer.disconnect();
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', scheduleDraw);
      return () => {
        window.removeEventListener('resize', scheduleDraw);
      };
    }

    return undefined;
  }, [scheduleDraw]);

  useEffect(() => {
    return () => {
      cancelScheduledDraw();
    };
  }, [cancelScheduledDraw]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
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
  cardAssetsReady,
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
  const cardSessionKey = useMemo(
    () => `${active ? 'active' : 'inactive'}:${resetKey}:${imageCacheGeneration}:${card?.effect.id ?? 'none'}`,
    [
      active,
      card?.effect.id,
      imageCacheGeneration,
      resetKey,
    ],
  );
  const [cardPaintReadyState, setCardPaintReadyState] = useState(() => createSessionReadyState(cardSessionKey));
  const [cardVisibleLatchState, setCardVisibleLatchState] = useState(() => createSessionVisibleLatchState(cardSessionKey));
  const [foregroundPaintState, setForegroundPaintState] = useState(() => createSessionForegroundPaintState(cardSessionKey));
  const discardAnimationReportedRef = useRef(false);
  const retainedForegroundStateRef = useRef<{
    image: HTMLImageElement | null;
    sessionKey: string;
  }>({
    image: null,
    sessionKey: cardSessionKey,
  });

  const cardPaintReady = cardPaintReadyState.sessionKey === cardSessionKey && cardPaintReadyState.ready;
  const cardVisibleLatched = cardVisibleLatchState.sessionKey === cardSessionKey && cardVisibleLatchState.visible;
  const cardDisplayReady = cardAssetsReady && cardPaintReady;

  useEffect(() => {
    setCardPaintReadyState((currentState) =>
      currentState.sessionKey === cardSessionKey ? currentState : createSessionReadyState(cardSessionKey),
    );
    setCardVisibleLatchState((currentState) =>
      currentState.sessionKey === cardSessionKey ? currentState : createSessionVisibleLatchState(cardSessionKey),
    );
    setForegroundPaintState((currentState) =>
      currentState.sessionKey === cardSessionKey ? currentState : createSessionForegroundPaintState(cardSessionKey),
    );
  }, [cardSessionKey]);

  const controller = usePonchoDrifellaRevealController({
    active,
    phase,
    boxLabel,
    cardReady,
    cardDisplayReady,
    imageCache,
    resetKey,
    onRequestReveal,
    onPlayClick,
    onPlayReveal,
  });

  useEffect(() => {
    if (active && controller.revealComplete) return;
    discardAnimationReportedRef.current = false;
  }, [active, controller.revealComplete]);

  const boxFrameImage = imageCache.resident.get(controller.boxFrameSrc);
  const boxFrameFallbackSrc =
    !boxFrameImage && controller.stage !== 'autoplay' && controller.stage !== 'revealed'
      ? controller.boxFrameSrc
      : undefined;
  const currentForegroundFrameSrc = controller.foregroundFrameSrc ?? null;
  const foregroundFrameImage = currentForegroundFrameSrc
    ? imageCache.resident.get(currentForegroundFrameSrc)
    : undefined;
  const retainedForegroundImage =
    retainedForegroundStateRef.current.sessionKey === cardSessionKey
      ? retainedForegroundStateRef.current.image
      : null;
  const displayedForegroundImage = foregroundFrameImage || retainedForegroundImage || undefined;
  const foregroundPaintReady =
    foregroundPaintState.sessionKey === cardSessionKey &&
    currentForegroundFrameSrc !== null &&
    foregroundPaintState.frameSrc === currentForegroundFrameSrc;

  const handleForegroundDrawComplete = useCallback(() => {
    if (!currentForegroundFrameSrc) return;
    if (retainedForegroundStateRef.current.sessionKey !== cardSessionKey || retainedForegroundStateRef.current.image !== foregroundFrameImage) {
      retainedForegroundStateRef.current = {
        image: foregroundFrameImage || null,
        sessionKey: cardSessionKey,
      };
    }
    setForegroundPaintState((currentState) => {
      if (currentState.sessionKey === cardSessionKey && currentState.frameSrc === currentForegroundFrameSrc) {
        return currentState;
      }
      return createSessionForegroundPaintState(cardSessionKey, currentForegroundFrameSrc);
    });
  }, [cardSessionKey, currentForegroundFrameSrc, foregroundFrameImage]);

  const revealReadyForCard =
    Boolean(displayedForegroundImage) &&
    controller.cardVisible &&
    foregroundPaintReady;

  useEffect(() => {
    if (cardVisibleLatched || !revealReadyForCard) return undefined;
    if (typeof window === 'undefined') {
      setCardVisibleLatchState((currentState) => {
        if (currentState.sessionKey === cardSessionKey && currentState.visible) {
          return currentState;
        }
        return createSessionVisibleLatchState(cardSessionKey, true);
      });
      return undefined;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      setCardVisibleLatchState((currentState) => {
        if (currentState.sessionKey === cardSessionKey && currentState.visible) {
          return currentState;
        }
        return createSessionVisibleLatchState(cardSessionKey, true);
      });
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [cardSessionKey, cardVisibleLatched, revealReadyForCard]);

  const resolvedForegroundVisible = controller.foregroundVisible && Boolean(displayedForegroundImage);
  const resolvedRevealVisible = resolvedForegroundVisible && cardVisibleLatched;
  const resolvedCardVisible = Boolean(card) && cardVisibleLatched;
  const packDiscarded = controller.phase === 'revealed' && resolvedRevealVisible;
  const cardLocked = packDiscarded && resolvedCardVisible && !controller.cardInteractive;
  const revealComplete = controller.revealComplete && (resolvedRevealVisible || controller.revealFailedOpen);
  const boxDisabled =
    closing ||
    controller.phase !== 'ready' ||
    controller.revealComplete ||
    controller.advanceLocked;

  useEffect(() => {
    onRevealCompleteChange?.(revealComplete);
  }, [onRevealCompleteChange, revealComplete]);

  const handleCardImageReadyChange = useCallback(
    (ready: boolean) => {
      setCardPaintReadyState((currentState) => {
        if (currentState.sessionKey === cardSessionKey && currentState.ready === ready) {
          return currentState;
        }
        return createSessionReadyState(cardSessionKey, ready);
      });
    },
    [cardSessionKey],
  );

  const stopOverlayDismiss = (evt: SyntheticEvent) => {
    evt.stopPropagation();
  };

  const handlePackDiscardAnimationEnd = (evt: AnimationEvent<HTMLElement>) => {
    if (evt.animationName !== 'wip-pack-discard') return;
    if (!packDiscarded) return;
    if (discardAnimationReportedRef.current) return;
    discardAnimationReportedRef.current = true;
    onPackDiscardEnd?.();
  };

  const handleAdvance = () => {
    if (boxDisabled) return;
    if (onBeforeAdvance && !onBeforeAdvance()) return;
    controller.handleAdvance();
  };

  return (
    <div
      className={`reveal-overlay wip-overlay reveal-overlay--${controller.phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={onDismiss}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className={`reveal-overlay__shine${resolvedCardVisible ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
        <button
          ref={boxButtonRef}
          type="button"
          className={`reveal-overlay__box${packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
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
          {boxFrameImage ? (
            <PonchoFrameCanvas image={boxFrameImage} className="reveal-overlay__image" />
          ) : boxFrameFallbackSrc ? (
            <img
              src={boxFrameFallbackSrc}
              alt=""
              className="reveal-overlay__image"
              loading="eager"
              decoding="async"
              draggable={false}
              aria-hidden="true"
            />
          ) : (
            <div className="reveal-overlay__image reveal-overlay__image--placeholder" aria-hidden="true" />
          )}
        </button>
        <div
          className={`wip-reveal__stage${resolvedForegroundVisible ? ' wip-reveal__stage--visible' : ''}`}
          aria-hidden={!resolvedForegroundVisible}
        >
          {card ? (
            <div
              className={`reveal-overlay__media wip-reveal__media${resolvedCardVisible ? ' wip-reveal__media--visible' : ''}${controller.cardInteractive ? ' wip-reveal__media--interactive' : ''}${cardLocked ? ' wip-reveal__media--locked' : ''}`}
              aria-hidden={!resolvedCardVisible || !controller.cardInteractive}
            >
              <div
                className={`reveal-overlay__media-item wip-reveal__card-item${controller.cardInteractive ? ' wip-reveal__card-item--interactive' : ''}${cardLocked ? ' wip-reveal__card-item--locked' : ''}`}
                onClick={controller.cardInteractive || cardLocked ? stopOverlayDismiss : undefined}
              >
                <div className="reveal-overlay__media-float">
                  <WipInteractiveCard
                    card={card}
                    interactive={controller.cardInteractive}
                    onImageReadyChange={handleCardImageReadyChange}
                  />
                </div>
              </div>
            </div>
          ) : null}
          {displayedForegroundImage ? (
            <div
              className={`wip-reveal__foreground${packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
              aria-hidden="true"
              onAnimationEnd={handlePackDiscardAnimationEnd}
            >
              <PonchoFrameCanvas
                image={displayedForegroundImage}
                className="reveal-overlay__image wip-reveal__foreground-image"
                drawMode="immediate"
                onDrawComplete={handleForegroundDrawComplete}
                redrawToken={`${cardSessionKey}:${currentForegroundFrameSrc ?? 'none'}`}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="reveal-overlay__note">{controller.note}</div>
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

  return (
    <PonchoRevealOverlay
      {...overlayProps}
      card={revealedCard}
      cardReady={Boolean(revealedCard)}
    />
  );
}
