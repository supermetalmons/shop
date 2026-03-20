import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FRONTEND_DEPLOYMENT } from './config/deployment';
import WipInteractiveCard, { type WipCardConfig } from './components/WipInteractiveCard';

const BOX_FRAME_COUNT = 21;
const BOX_FRAME_CLICK_MAX = 8;
const BOX_FRAME_AUTOPLAY_START = 9;
const BOX_FRAME_MEDIA_START = 10;
const REVEAL_BOX_ASPECT_RATIO = 1440 / 1030; // width / height (tight.webp)
const REVEAL_NOTE_OFFSET = 28;
const FRAME_AUTOPLAY_DELAY_MS = 30;

const CARDS: WipCardConfig[] = [
  { imageSrc: '/Poncho_Drifella/drifs/0.webp', glowType: 'water' },
  { imageSrc: '/Poncho_Drifella/drifs/1.jpeg', glowType: 'metal' },
  { imageSrc: '/Poncho_Drifella/drifs/2.jpeg', glowType: 'fairy' },
  { imageSrc: '/Poncho_Drifella/drifs/3.jpg', glowType: 'dragon' },
  { imageSrc: '/Poncho_Drifella/drifs/4.jpeg', glowType: 'grass' },
  { imageSrc: '/Poncho_Drifella/drifs/5.jpeg', glowType: 'metal' },
  { imageSrc: '/Poncho_Drifella/drifs/6.jpeg', glowType: 'lightning' },
  { imageSrc: '/Poncho_Drifella/drifs/7.jpeg', glowType: 'water' },
  { imageSrc: '/Poncho_Drifella/drifs/8.jpeg', glowType: 'psychic' },
  { imageSrc: '/Poncho_Drifella/drifs/9.jpeg', glowType: 'dragon' },
  { imageSrc: '/Poncho_Drifella/drifs/10.jpeg', glowType: 'darkness' },
  { imageSrc: '/Poncho_Drifella/drifs/11.jpeg', glowType: 'fairy' },
];

type OverlayRect = { left: number; top: number; width: number; height: number };

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
  const [autoOpening, setAutoOpening] = useState(false);
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * CARDS.length));
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
  const autoOpenTimeoutRef = useRef<number | null>(null);
  const boxFrameBase = `${FRONTEND_DEPLOYMENT.paths.base}/box/`;

  const revealComplete = frame >= BOX_FRAME_COUNT;
  const cardVisible = frame >= BOX_FRAME_MEDIA_START;
  const stage = cardVisible ? 'revealed' : 'ready';
  const revealNote = cardVisible
    ? ''
    : autoOpening
      ? 'opening...'
      : frame >= BOX_FRAME_CLICK_MAX
        ? 'keep clicking the box'
        : 'click the box to open';
  const revealBoxFrameSrc = `${boxFrameBase}${Math.min(Math.max(frame, 1), BOX_FRAME_COUNT)}.webp`;
  const currentCard = CARDS[cardIndex];

  const clearAutoOpenTimeout = useCallback(() => {
    if (autoOpenTimeoutRef.current === null) return;
    window.clearTimeout(autoOpenTimeoutRef.current);
    autoOpenTimeoutRef.current = null;
  }, []);

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
      const frameSrc = `${boxFrameBase}${frameIndex}.webp`;
      preloadBoxFrame(frameSrc);
    }
  }, [boxFrameBase, preloadBoxFrame]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadCard(currentCard.imageSrc);
  }, [currentCard.imageSrc, preloadCard]);

  useEffect(() => {
    if (typeof window === 'undefined' || constrainedNetwork) return;
    CARDS.forEach(({ imageSrc }) => {
      preloadCard(imageSrc);
    });
  }, [constrainedNetwork, preloadCard]);

  useEffect(() => {
    if (!autoOpening) {
      clearAutoOpenTimeout();
      return;
    }
    if (revealComplete) {
      clearAutoOpenTimeout();
      setAutoOpening(false);
      return;
    }
    clearAutoOpenTimeout();
    autoOpenTimeoutRef.current = window.setTimeout(() => {
      autoOpenTimeoutRef.current = null;
      setFrame((prev) => Math.min(prev + 1, BOX_FRAME_COUNT));
    }, FRAME_AUTOPLAY_DELAY_MS);
    return clearAutoOpenTimeout;
  }, [autoOpening, clearAutoOpenTimeout, revealComplete, frame]);

  useEffect(() => clearAutoOpenTimeout, [clearAutoOpenTimeout]);

  const handleRevealBoxClick = useCallback(() => {
    if (autoOpening || revealComplete) return;
    if (frame < BOX_FRAME_CLICK_MAX) {
      setFrame((prev) => Math.min(prev + 1, BOX_FRAME_CLICK_MAX));
      return;
    }
    if (frame === BOX_FRAME_CLICK_MAX) {
      clearAutoOpenTimeout();
      setFrame(BOX_FRAME_AUTOPLAY_START);
      setAutoOpening(true);
    }
  }, [autoOpening, clearAutoOpenTimeout, frame, revealComplete]);

  const handleRevealBoxKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLDivElement>) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.preventDefault();
      handleRevealBoxClick();
    },
    [handleRevealBoxClick],
  );

  const handleReset = useCallback(() => {
    clearAutoOpenTimeout();
    setAutoOpening(false);
    setFrame(1);
    setCardIndex((prev) => {
      if (CARDS.length < 2) return prev;
      let next = prev;
      while (next === prev) {
        next = Math.floor(Math.random() * CARDS.length);
      }
      return next;
    });
  }, [clearAutoOpenTimeout]);

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
            className="reveal-overlay__box"
            role="button"
            tabIndex={revealComplete ? -1 : 0}
            aria-label="Unbox card"
            aria-disabled={autoOpening || revealComplete}
            onClick={(evt) => {
              evt.stopPropagation();
              handleRevealBoxClick();
            }}
            onKeyDown={handleRevealBoxKeyDown}
          >
            <img src={revealBoxFrameSrc} alt="Mystery box" className="reveal-overlay__image" draggable={false} />
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
