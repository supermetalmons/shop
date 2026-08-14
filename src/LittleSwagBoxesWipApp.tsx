import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from 'react';
import { getFrontendDrop } from './config/deployment';
import { ModalFocusScope } from './components/ModalFocusScope';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  joinDropAssetUrl,
  resolveDropContent,
  resolveFigureMediaImageUrlForMediaId,
} from './lib/dropContent';
import { preloadRevealFrames, resolveRevealFrameSrc } from './lib/revealFrameSequence';
import {
  getRevealOverlayViewport,
  offsetRevealOverlayRectForViewport,
  revealOverlayStyleVars,
  sameRevealOverlayRect,
} from './lib/revealOverlayLayout';
import { soundPlayer } from './lib/SoundPlayer';
import { navigate } from './navigation';

const LITTLE_SWAG_BOXES_DROP = (() => {
  const drop = getFrontendDrop('little_swag_boxes');
  if (!drop) throw new Error('Missing little_swag_boxes frontend drop config');
  return drop;
})();
const LITTLE_SWAG_BOXES_CONTENT = resolveDropContent(LITTLE_SWAG_BOXES_DROP);
const LITTLE_SWAG_BOXES_FRAME_SEQUENCE = LITTLE_SWAG_BOXES_CONTENT.reveal.frameSequence;
const LITTLE_SWAG_BOXES_FRAME_TIMING = LITTLE_SWAG_BOXES_CONTENT.reveal.frameTiming;
const LITTLE_SWAG_BOXES_ASSET_COUNT = Math.max(
  1,
  Math.floor(LITTLE_SWAG_BOXES_DROP.maxSupply) *
    Math.max(1, Math.floor(LITTLE_SWAG_BOXES_DROP.itemsPerBox || 1)),
);
const LITTLE_SWAG_BOXES_ITEMS_PER_BOX = Math.max(
  1,
  Math.floor(LITTLE_SWAG_BOXES_DROP.itemsPerBox || 1),
);
const LITTLE_SWAG_BOXES_SOUND_BASE_URL = 'https://cdn.lil.org/nft/little_swag_boxes/sounds';
const LITTLE_SWAG_BOXES_CLICK_SOUND_URL = `${LITTLE_SWAG_BOXES_SOUND_BASE_URL}/click.mp3`;
const LITTLE_SWAG_BOXES_REVEAL_SOUND_URL = `${LITTLE_SWAG_BOXES_SOUND_BASE_URL}/unbox1p.mp3`;
const AUTOPLAY_FRAME_DELAY_MS = 30;

type OverlayRect = { left: number; top: number; width: number; height: number };

function calcTargetRect(): OverlayRect {
  const viewport = getRevealOverlayViewport();
  const maxWidth = viewport.width * 0.65;
  const maxHeight = viewport.height * 0.43;
  const aspectRatio = LITTLE_SWAG_BOXES_CONTENT.box.aspectRatio;
  const width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * aspectRatio)));
  const height = Math.max(1, Math.floor(width / aspectRatio));
  const lift = Math.round(height * 0.42);
  return offsetRevealOverlayRectForViewport(
    {
      left: Math.round((viewport.width - width) / 2),
      top: Math.max(16, Math.round((viewport.height - height) / 2) - lift),
      width,
      height,
    },
    viewport,
  );
}

function randomFigureId() {
  return Math.floor(Math.random() * LITTLE_SWAG_BOXES_ASSET_COUNT) + 1;
}

function randomFigureIds() {
  const ids: number[] = [];
  while (ids.length < LITTLE_SWAG_BOXES_ITEMS_PER_BOX) {
    const nextId = randomFigureId();
    if (!ids.includes(nextId)) ids.push(nextId);
  }
  return ids;
}

function nextRandomFigureIds(currentIds: readonly number[]) {
  const currentKey = currentIds.join(',');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nextIds = randomFigureIds();
    if (nextIds.join(',') !== currentKey) return nextIds;
  }
  return randomFigureIds();
}

export default function LittleSwagBoxesWipApp() {
  if (!LITTLE_SWAG_BOXES_FRAME_SEQUENCE || !LITTLE_SWAG_BOXES_FRAME_TIMING) {
    throw new Error('Missing little_swag_boxes reveal sequence');
  }

  const [targetRect, setTargetRect] = useState<OverlayRect>(calcTargetRect);
  const [figureIds, setFigureIds] = useState(randomFigureIds);
  const [frame, setFrame] = useState(1);
  const [autoOpening, setAutoOpening] = useState(false);
  const [focusedMode, setFocusedMode] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealSoundPlayedRef = useRef(false);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const loadedFramesRef = useRef(new Set<string>());
  const pendingFramesRef = useRef(new Map<string, HTMLImageElement>());
  const showRevealOutcome = frame >= LITTLE_SWAG_BOXES_FRAME_TIMING.mediaStart;
  const frameSrc = resolveRevealFrameSrc(LITTLE_SWAG_BOXES_FRAME_SEQUENCE, frame);

  const revealItems = useMemo(
    () => figureIds.map((figureId) => {
      const mediaId = getMediaIdForFigureId(figureId, LITTLE_SWAG_BOXES_DROP.figureMedia);
      return {
        figureId,
        mediaId,
        poster: resolveFigureMediaImageUrlForMediaId(
          LITTLE_SWAG_BOXES_CONTENT.figures.inventoryImageBaseUrl,
          mediaId,
        ),
      };
    }),
    [figureIds],
  );

  const overlayStyle = useMemo<CSSProperties>(
    () => revealOverlayStyleVars({ originRect: targetRect, targetRect }) as CSSProperties,
    [targetRect],
  );

  const mediaStyle = useMemo<CSSProperties>(() => {
    const base = Math.min(targetRect.width, targetRect.height);
    const baseSize = Math.floor(Math.min(base * 0.7, 220));
    const widthCap = targetRect.width < 240
      ? 0.42
      : targetRect.width < 320
        ? 0.48
        : targetRect.width < 420
          ? 0.52
          : 0.6;
    const maxByWidth = Math.floor(targetRect.width * widthCap);
    const maxByHeight = Math.floor(targetRect.height * 0.9);
    const maxSize = Math.floor(Math.min(baseSize * 1.4, maxByWidth, maxByHeight));
    const size = Math.max(48, Math.floor(maxSize * 0.8));
    return {
      ['--reveal-media-size' as never]: `${size}px`,
      ['--reveal-media-shift-y' as never]: `${Math.floor(size * 0.1)}px`,
    };
  }, [targetRect.height, targetRect.width]);

  const ensureSoundReady = useCallback(() => {
    if (soundPlayer.isInitialized) return Promise.resolve();
    if (soundInitPromiseRef.current) return soundInitPromiseRef.current;
    const promise = soundPlayer.initializeOnUserInteraction(true);
    soundInitPromiseRef.current = promise.finally(() => {
      if (soundInitPromiseRef.current === promise) soundInitPromiseRef.current = null;
    });
    return soundInitPromiseRef.current;
  }, []);

  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(
        LITTLE_SWAG_BOXES_CLICK_SOUND_URL,
        LITTLE_SWAG_BOXES_CONTENT.reveal.sound.clickVolume,
      );
    });
  }, [ensureSoundReady]);

  const playRevealSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(
        LITTLE_SWAG_BOXES_REVEAL_SOUND_URL,
        LITTLE_SWAG_BOXES_CONTENT.reveal.sound.revealVolume,
      );
    });
  }, [ensureSoundReady]);

  const handleAdvance = useCallback(() => {
    if (autoOpening || frame >= LITTLE_SWAG_BOXES_FRAME_TIMING.frameCount) return;
    playClickSound();
    if (frame < LITTLE_SWAG_BOXES_FRAME_TIMING.clickMax) {
      setFrame((current) => current + 1);
      return;
    }
    setFrame(LITTLE_SWAG_BOXES_FRAME_TIMING.autoplayStart);
    setAutoOpening(true);
  }, [autoOpening, frame, playClickSound]);

  const handleBoxClick = useCallback((event: SyntheticEvent) => {
    event.stopPropagation();
    handleAdvance();
  }, [handleAdvance]);

  const handleReset = useCallback(() => {
    setFigureIds((current) => nextRandomFigureIds(current));
    setFrame(1);
    setAutoOpening(false);
    setResetKey((current) => current + 1);
    revealSoundPlayedRef.current = false;
  }, []);

  const handleClose = useCallback(() => {
    navigate('/');
  }, []);

  const handleBackdropPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      !(event.target instanceof Element) ||
      !event.target.classList.contains('reveal-overlay__backdrop')
    ) {
      return;
    }
    setFocusedMode((current) => !current);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frameId: number | null = null;
    const updateTarget = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const nextRect = calcTargetRect();
        setTargetRect((current) => sameRevealOverlayRect(current, nextRect) ? current : nextRect);
      });
    };
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', updateTarget);
    window.addEventListener('orientationchange', updateTarget);
    visualViewport?.addEventListener('resize', updateTarget);
    visualViewport?.addEventListener('scroll', updateTarget);
    return () => {
      window.removeEventListener('resize', updateTarget);
      window.removeEventListener('orientationchange', updateTarget);
      visualViewport?.removeEventListener('resize', updateTarget);
      visualViewport?.removeEventListener('scroll', updateTarget);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    preloadRevealFrames(
      LITTLE_SWAG_BOXES_FRAME_SEQUENCE,
      loadedFramesRef.current,
      pendingFramesRef.current,
      1,
      LITTLE_SWAG_BOXES_FRAME_TIMING.frameCount,
      'low',
    );
    void soundPlayer.preloadSound(LITTLE_SWAG_BOXES_CLICK_SOUND_URL);
    void soundPlayer.preloadSound(LITTLE_SWAG_BOXES_REVEAL_SOUND_URL);
  }, []);

  useEffect(() => {
    if (!autoOpening) return undefined;
    if (frame >= LITTLE_SWAG_BOXES_FRAME_TIMING.frameCount) {
      setAutoOpening(false);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setFrame((current) => Math.min(
        current + 1,
        LITTLE_SWAG_BOXES_FRAME_TIMING.frameCount,
      ));
    }, AUTOPLAY_FRAME_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [autoOpening, frame]);

  useEffect(() => {
    if (!showRevealOutcome || revealSoundPlayedRef.current) return;
    revealSoundPlayedRef.current = true;
    playRevealSound();
  }, [playRevealSound, showRevealOutcome]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isKeyboardShortcutTarget(event.target)) return;
      if (event.code === 'KeyR' || event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        handleReset();
        return;
      }
      if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        revealButtonRef.current?.click();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleReset]);

  return (
    <ModalFocusScope
      className={`wip-page${focusedMode ? ' wip-page--focused' : ''}`}
      ariaLabel="Little Swag Boxes preview"
      focusTarget="scope"
      onEscape={handleClose}
      onPointerUpCapture={handleBackdropPointerUp}
    >
      <div
        className={`reveal-overlay little-swag-boxes-wip reveal-overlay--${
          showRevealOutcome ? 'revealed' : 'ready'
        } reveal-overlay--active`}
        style={overlayStyle}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="reveal-overlay__backdrop" />
        <div className="reveal-overlay__frame">
          <div
            className={`reveal-overlay__shine${
              showRevealOutcome ? ' reveal-overlay__shine--visible' : ''
            }`}
            aria-hidden="true"
          />
          <div
            className={`reveal-overlay__media${
              showRevealOutcome ? ' reveal-overlay__media--visible' : ''
            }`}
            style={mediaStyle}
            aria-hidden="true"
          >
            {revealItems.map(({ figureId, mediaId, poster }, index) => {
              const angle = -Math.PI / 2 + (index * Math.PI * 2) / revealItems.length;
              const left = 50 + Math.cos(angle) * 28;
              const top = 50 + Math.sin(angle) * 28;
              const finalTop = index === 0
                ? `${top}%`
                : `calc(${top}% + var(--reveal-media-size))`;
              return (
                <div
                  key={`${resetKey}:${figureId}:${index}`}
                  className="reveal-overlay__media-item"
                  style={{
                    left: showRevealOutcome ? `${left}%` : '50%',
                    top: showRevealOutcome ? finalTop : '50%',
                    ['--reveal-media-delay' as never]: `${index * 70}ms`,
                  }}
                >
                  <div className="reveal-overlay__media-float">
                    {mediaId ? (
                      <video
                        className="reveal-overlay__video"
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        poster={poster}
                        draggable={false}
                      >
                        <source
                          src={joinDropAssetUrl(
                            LITTLE_SWAG_BOXES_CONTENT.figures.revealVideoBaseUrl,
                            `${mediaId}.mov`,
                          )}
                          type='video/quicktime; codecs="hvc1"'
                        />
                        <source
                          src={joinDropAssetUrl(
                            LITTLE_SWAG_BOXES_CONTENT.figures.revealVideoBaseUrl,
                            `${mediaId}.webm`,
                          )}
                          type="video/webm"
                        />
                      </video>
                    ) : (
                      <div className="reveal-overlay__still reveal-overlay__still--placeholder" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div
            className={`little-swag-boxes-wip__wordmark-stage${
              showRevealOutcome ? ' little-swag-boxes-wip__wordmark-stage--visible' : ''
            }`}
            aria-hidden="true"
          >
            <span className="little-swag-boxes-wip__wordmark">
              <img
                src="https://cdn.lil.org/mons/shop/favicon/logo.webp"
                alt=""
                className="brand-icon"
                draggable={false}
              />
              <span>mons.shop</span>
            </span>
          </div>
          <button
            ref={revealButtonRef}
            type="button"
            className="reveal-overlay__box"
            aria-label="Reveal Little Swag Box"
            aria-disabled={autoOpening || frame >= LITTLE_SWAG_BOXES_FRAME_TIMING.frameCount}
            onClick={handleBoxClick}
          >
            {frameSrc ? (
              <img
                src={frameSrc}
                alt="Little Swag Box"
                className="reveal-overlay__image"
                draggable={false}
              />
            ) : (
              <div className="reveal-overlay__image reveal-overlay__image--placeholder" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div
        className={`wip-controls${focusedMode ? ' wip-controls--hidden' : ''}`}
        aria-hidden={focusedMode || undefined}
        inert={focusedMode || undefined}
      >
        <button
          type="button"
          className="wip-close-btn"
          onClick={handleClose}
          aria-label="Close Little Swag Boxes preview"
        >
          Close
        </button>
        <button
          type="button"
          className="wip-reset-btn"
          onClick={handleReset}
          aria-label="Reset Little Swag Boxes opening"
        >
          Reset
        </button>
      </div>
    </ModalFocusScope>
  );
}
