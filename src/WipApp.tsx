import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WipInteractiveCard from './components/WipInteractiveCard';
import { DRIF_CARDS } from './drifCards';
import { soundPlayer } from './lib/SoundPlayer';

const PACK_FRAME_IDS = [
  1, 20, 55, 56, 57, 59, 60, 61, 69, 79, 89, 104, 106, 107, 109, 110, 111, 113, 114, 115, 116, 118, 119, 123, 132,
] as const;
const PACK_FRAME_BASE = '/Poncho_Drifella/pack/';
const BOX_FRAME_COUNT = PACK_FRAME_IDS.length;
const REVEAL_BOX_ASPECT_RATIO = 1;
const REVEAL_NOTE_OFFSET = 28;
const BOX_SOUND_REVEAL_URL = 'https://assets.mons.link/sounds/shop/unbox1p.mp3';
const BOX_SOUND_CLICK_URL = 'https://assets.mons.link/sounds/shop/click.mp3';

type OverlayRect = { left: number; top: number; width: number; height: number };

function getPackFrameSrc(frameIndex: number) {
  const frameId = PACK_FRAME_IDS[Math.min(Math.max(frameIndex, 1), BOX_FRAME_COUNT) - 1];
  return `${PACK_FRAME_BASE}1_${frameId}.webp`;
}

function calcRevealTargetRect(viewportWidth: number, viewportHeight: number): OverlayRect {
  const portrait = viewportHeight >= viewportWidth;
  const gutter = portrait ? 8 : 16;
  const width = portrait
    ? Math.max(1, Math.floor(Math.min(viewportWidth * 1.4, viewportHeight - gutter * 2)))
    : Math.max(1, Math.floor(viewportHeight * 0.82 * REVEAL_BOX_ASPECT_RATIO));
  const height = Math.max(1, Math.floor(width / REVEAL_BOX_ASPECT_RATIO));
  const visualLift = portrait ? Math.min(44, Math.round(height * 0.08)) : Math.min(32, Math.round(height * 0.06));
  const maxTop = Math.max(gutter, viewportHeight - height - gutter);
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.min(maxTop, Math.max(gutter, Math.round((viewportHeight - height) / 2) - visualLift)),
    width,
    height,
  };
}

function getInitialTargetRect(): OverlayRect {
  if (typeof window === 'undefined') {
    const width = 320;
    return {
      left: 0,
      top: 16,
      width,
      height: Math.round(width / REVEAL_BOX_ASPECT_RATIO),
    };
  }
  return calcRevealTargetRect(window.innerWidth, window.innerHeight);
}

export default function WipApp() {
  const [targetRect, setTargetRect] = useState<OverlayRect>(() => getInitialTargetRect());
  const [frame, setFrame] = useState(1);
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_CARDS.length));
  const frameRef = useRef(1);
  const constrainedNetwork = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const connection = (
      navigator as Navigator & {
        connection?: {
          saveData?: boolean;
          effectiveType?: string | null;
        };
      }
    ).connection;
    const effectiveType = String(connection?.effectiveType ?? '');
    return Boolean(connection?.saveData) || /(^|-)2g/.test(effectiveType);
  }, []);
  const preloadedBoxFramesRef = useRef<Set<string>>(new Set());
  const boxFramePreloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const preloadedCardsRef = useRef<Set<string>>(new Set());
  const cardPreloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);

  const revealComplete = frame >= BOX_FRAME_COUNT;
  const cardVisible = revealComplete;
  const stage = cardVisible ? 'revealed' : 'ready';
  const revealNote = cardVisible ? '' : frame > 1 ? 'keep clicking the pack' : 'click the pack to open';
  const revealBoxFrameSrc = getPackFrameSrc(frame);
  const currentCard = DRIF_CARDS[cardIndex];

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  const preloadBoxFrame = useCallback((frameSrc: string) => {
    if (preloadedBoxFramesRef.current.has(frameSrc)) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      boxFramePreloadImagesRef.current.delete(frameSrc);
    };
    img.onerror = () => {
      boxFramePreloadImagesRef.current.delete(frameSrc);
      preloadedBoxFramesRef.current.delete(frameSrc);
    };
    boxFramePreloadImagesRef.current.set(frameSrc, img);
    preloadedBoxFramesRef.current.add(frameSrc);
    img.src = frameSrc;
  }, []);

  const preloadCard = useCallback((imageSrc: string) => {
    if (!imageSrc || preloadedCardsRef.current.has(imageSrc)) return;
    const card = new Image();
    card.decoding = 'async';
    card.onload = () => {
      cardPreloadImagesRef.current.delete(imageSrc);
    };
    card.onerror = () => {
      cardPreloadImagesRef.current.delete(imageSrc);
      preloadedCardsRef.current.delete(imageSrc);
    };
    cardPreloadImagesRef.current.set(imageSrc, card);
    preloadedCardsRef.current.add(imageSrc);
    card.src = imageSrc;
  }, []);

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
  }, []);

  const revealOverlayStyle = useMemo<React.CSSProperties>(() => {
    const safeTargetWidth = Math.max(1, targetRect.width);
    const safeTargetHeight = Math.max(1, targetRect.height);
    return {
      ['--reveal-target-left' as never]: `${targetRect.left}px`,
      ['--reveal-target-top' as never]: `${targetRect.top}px`,
      ['--reveal-target-width' as never]: `${safeTargetWidth}px`,
      ['--reveal-target-height' as never]: `${safeTargetHeight}px`,
      ['--reveal-start-x' as never]: '0px',
      ['--reveal-start-y' as never]: '0px',
      ['--reveal-start-scale-x' as never]: '1',
      ['--reveal-start-scale-y' as never]: '1',
      ['--reveal-note-offset' as never]: `${REVEAL_NOTE_OFFSET}px`,
    };
  }, [targetRect]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const updateTarget = () => {
      setTargetRect(calcRevealTargetRect(window.innerWidth, window.innerHeight));
    };
    window.addEventListener('resize', updateTarget);
    window.addEventListener('orientationchange', updateTarget);
    return () => {
      window.removeEventListener('resize', updateTarget);
      window.removeEventListener('orientationchange', updateTarget);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    document.body.classList.add('wip-body');
    return () => {
      document.body.classList.remove('wip-body');
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    for (let frameIndex = 1; frameIndex <= BOX_FRAME_COUNT; frameIndex += 1) {
      preloadBoxFrame(getPackFrameSrc(frameIndex));
    }
  }, [preloadBoxFrame]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadCard(currentCard.imageSrc);
    preloadCard(currentCard.textureSrc);
    preloadCard(currentCard.foilSrc);
  }, [currentCard.foilSrc, currentCard.imageSrc, currentCard.textureSrc, preloadCard]);

  useEffect(() => {
    if (typeof window === 'undefined' || constrainedNetwork) return;
    DRIF_CARDS.forEach(({ imageSrc, textureSrc, foilSrc }) => {
      preloadCard(imageSrc);
      preloadCard(textureSrc);
      preloadCard(foilSrc);
    });
  }, [constrainedNetwork, preloadCard]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadRevealSounds();
  }, [preloadRevealSounds]);

  const advanceRevealFrame = useCallback(() => {
    const prevFrame = frameRef.current;
    if (prevFrame >= BOX_FRAME_COUNT) return;
    const nextFrame = Math.min(prevFrame + 1, BOX_FRAME_COUNT);
    frameRef.current = nextFrame;
    setFrame(nextFrame);
    const soundUrl = nextFrame >= BOX_FRAME_COUNT ? BOX_SOUND_REVEAL_URL : BOX_SOUND_CLICK_URL;
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(soundUrl, 0.42);
    });
  }, [ensureSoundReady]);

  const handleRevealBoxPress = useCallback(() => {
    void ensureSoundReady().then(() => {
      preloadRevealSounds();
    });
    advanceRevealFrame();
  }, [advanceRevealFrame, ensureSoundReady, preloadRevealSounds]);

  const handleRevealBoxPointerDown = useCallback(
    (evt: React.PointerEvent<HTMLDivElement>) => {
      if (evt.pointerType === 'mouse' && evt.button !== 0) return;
      evt.stopPropagation();
      handleRevealBoxPress();
    },
    [handleRevealBoxPress],
  );

  const handleRevealBoxKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLDivElement>) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.preventDefault();
      handleRevealBoxPress();
    },
    [handleRevealBoxPress],
  );

  const handleReset = useCallback(() => {
    frameRef.current = 1;
    setFrame(1);
    setCardIndex((prev) => {
      if (DRIF_CARDS.length < 2) return prev;
      let next = prev;
      while (next === prev) {
        next = Math.floor(Math.random() * DRIF_CARDS.length);
      }
      return next;
    });
  }, []);

  return (
    <div className="wip-page">
      <div
        className={`reveal-overlay wip-overlay reveal-overlay--${stage} reveal-overlay--active`}
        role="presentation"
        style={revealOverlayStyle}
      >
        <div className="reveal-overlay__backdrop" />
        <div className="reveal-overlay__frame">
          <div className={`reveal-overlay__shine${cardVisible ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
          <div
            className={`reveal-overlay__media wip-reveal__media${cardVisible ? ' reveal-overlay__media--visible' : ''}`}
            aria-hidden={!cardVisible}
          >
            <div className="reveal-overlay__media-item wip-reveal__card-item">
              <div className="reveal-overlay__media-float">
                <WipInteractiveCard card={currentCard} />
              </div>
            </div>
          </div>
          <div
            className={`reveal-overlay__box${cardVisible ? ' wip-reveal__box--discarded' : ''}`}
            role="button"
            tabIndex={revealComplete ? -1 : 0}
            aria-label="Open pack"
            aria-disabled={revealComplete}
            onPointerDown={handleRevealBoxPointerDown}
            onKeyDown={handleRevealBoxKeyDown}
          >
            <img src={revealBoxFrameSrc} alt="Mystery pack" className="reveal-overlay__image" draggable={false} />
          </div>
        </div>
        <div className="reveal-overlay__note">{revealNote}</div>
      </div>
      <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset unboxing">
        Reset
      </button>
    </div>
  );
}
