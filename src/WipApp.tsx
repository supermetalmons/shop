import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PonchoInventoryRevealOverlay, {
  PonchoRevealOverlay,
  type PonchoInventoryRevealOverlayProps,
} from './components/PonchoRevealOverlay';
import { DRIF_CARD_COUNT, DRIF_CARDS } from './drifCards';
import {
  PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL,
  PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE,
  preloadPonchoDrifellaCardAssets,
} from './lib/ponchoDrifellaReveal';
import { listRevealFrameSrcs, preloadRevealFrameSrc, resolveRevealFrameSrc } from './lib/revealFrameSequence';
import { soundPlayer } from './lib/SoundPlayer';
import { navigate } from './navigation';

const REVEAL_BOX_ASPECT_RATIO = 1;
const REVEAL_NOTE_OFFSET = 28;
const BOX_FRAME_COUNT = PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount;
const PACK_AUTOPLAY_TRIGGER_FRAME = PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.autoplayStart;
const PACK_AUTOPLAY_DELAY_MS = 35;
const PACK_PRELOAD_IMMEDIATE_COUNT_FAST = 4;
const PACK_PRELOAD_IMMEDIATE_COUNT_SLOW = 2;
const PACK_PRELOAD_DELAY_MS_FAST = 70;
const PACK_PRELOAD_DELAY_MS_SLOW = 180;
const PACK_PRELOAD_LOOKAHEAD_FAST = 10;
const PACK_PRELOAD_LOOKAHEAD_SLOW = 6;

type OverlayRect = { left: number; top: number; width: number; height: number };

type WipLocalPlayProps = {
  mode?: 'local-play';
};

export type WipAppProps = WipLocalPlayProps | PonchoInventoryRevealOverlayProps;

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

function LocalPlayWipApp() {
  const [targetRect, setTargetRect] = useState<OverlayRect>(() => getInitialTargetRect());
  const [frame, setFrame] = useState(1);
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_CARD_COUNT));
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
  const revealSoundPlayedRef = useRef(false);

  const revealComplete = frame >= BOX_FRAME_COUNT;
  const autoOpening = frame >= PACK_AUTOPLAY_TRIGGER_FRAME && frame < BOX_FRAME_COUNT;
  const stage = revealComplete ? 'revealed' : 'ready';
  const revealNote = revealComplete
    ? ''
    : autoOpening
      ? 'opening...'
      : frame > 1
        ? 'keep clicking the pack'
        : 'click the pack to open';
  const revealBoxFrameSrc = resolveRevealFrameSrc(PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE, frame);
  const currentCard = DRIF_CARDS[cardIndex];

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  const preloadUpcomingPackFrames = useCallback(
    (fromFrame: number, lookaheadCount: number, fetchPriority: 'high' | 'low' | 'auto' = 'auto') => {
      if (lookaheadCount <= 0) return;
      const startFrame = fromFrame + 1;
      if (startFrame > BOX_FRAME_COUNT) return;
      const endFrame = Math.min(BOX_FRAME_COUNT, fromFrame + lookaheadCount);
      for (let frameIndex = startFrame; frameIndex <= endFrame; frameIndex += 1) {
        preloadRevealFrameSrc(
          resolveRevealFrameSrc(PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE, frameIndex),
          preloadedBoxFramesRef.current,
          boxFramePreloadImagesRef.current,
          fetchPriority,
        );
      }
    },
    [],
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
    void soundPlayer.preloadSound(PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL);
    void soundPlayer.preloadSound(PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL);
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
    const html = document.documentElement;
    const body = document.body;
    html.classList.add('wip-scroll-lock');
    body.classList.add('wip-scroll-lock');
    return () => {
      html.classList.remove('wip-scroll-lock');
      body.classList.remove('wip-scroll-lock');
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const queue = listRevealFrameSrcs(PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE);
    const immediateCount = constrainedNetwork ? PACK_PRELOAD_IMMEDIATE_COUNT_SLOW : PACK_PRELOAD_IMMEDIATE_COUNT_FAST;
    const preloadDelayMs = constrainedNetwork ? PACK_PRELOAD_DELAY_MS_SLOW : PACK_PRELOAD_DELAY_MS_FAST;
    const immediateQueue = queue.slice(0, immediateCount);
    const backgroundQueue = queue.slice(immediateCount);
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    let nextIndex = 0;
    let isActive = true;

    immediateQueue.forEach((frameSrc) => {
      preloadRevealFrameSrc(frameSrc, preloadedBoxFramesRef.current, boxFramePreloadImagesRef.current, 'auto');
    });

    const scheduleNextFrame = () => {
      if (!isActive) return;
      if (nextIndex >= backgroundQueue.length) return;
      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(
          () => {
            if (!isActive) return;
            idleId = undefined;
            preloadNextFrame();
          },
          { timeout: preloadDelayMs },
        );
        return;
      }
      timeoutId = window.setTimeout(preloadNextFrame, preloadDelayMs);
    };

    const preloadNextFrame = () => {
      if (!isActive) return;
      if (nextIndex >= backgroundQueue.length) return;
      preloadRevealFrameSrc(
        backgroundQueue[nextIndex],
        preloadedBoxFramesRef.current,
        boxFramePreloadImagesRef.current,
        'auto',
      );
      nextIndex += 1;
      scheduleNextFrame();
    };

    scheduleNextFrame();

    return () => {
      isActive = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      if (idleId !== undefined && idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(idleId);
      }
    };
  }, [constrainedNetwork]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const lookaheadCount = constrainedNetwork ? PACK_PRELOAD_LOOKAHEAD_SLOW : PACK_PRELOAD_LOOKAHEAD_FAST;
    const fetchPriority: 'high' | 'auto' = autoOpening ? 'high' : 'auto';
    preloadUpcomingPackFrames(frame, lookaheadCount, fetchPriority);
  }, [autoOpening, constrainedNetwork, frame, preloadUpcomingPackFrames]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadPonchoDrifellaCardAssets(currentCard, preloadedCardsRef.current, cardPreloadImagesRef.current);
  }, [currentCard]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadRevealSounds();
  }, [preloadRevealSounds]);

  useEffect(() => {
    if (!autoOpening) return undefined;
    const timeoutId = window.setTimeout(() => {
      const prevFrame = frameRef.current;
      if (prevFrame >= BOX_FRAME_COUNT) return;
      const nextFrame = Math.min(prevFrame + 1, BOX_FRAME_COUNT);
      frameRef.current = nextFrame;
      setFrame(nextFrame);
    }, PACK_AUTOPLAY_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [autoOpening, frame]);

  useEffect(() => {
    if (!revealComplete || revealSoundPlayedRef.current) return;
    revealSoundPlayedRef.current = true;
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL, 0.42);
    });
  }, [ensureSoundReady, revealComplete]);

  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL, 0.42);
    });
  }, [ensureSoundReady]);

  const advanceRevealFrame = useCallback(() => {
    const prevFrame = frameRef.current;
    if (prevFrame >= BOX_FRAME_COUNT) return;
    if (prevFrame >= PACK_AUTOPLAY_TRIGGER_FRAME) return;
    const nextFrame = Math.min(prevFrame + 1, BOX_FRAME_COUNT);
    frameRef.current = nextFrame;
    setFrame(nextFrame);
    playClickSound();
  }, [playClickSound]);

  const handleRevealBoxPress = useCallback(() => {
    void ensureSoundReady().then(() => {
      preloadRevealSounds();
    });
    if (frameRef.current >= PACK_AUTOPLAY_TRIGGER_FRAME && frameRef.current < BOX_FRAME_COUNT) {
      playClickSound();
      return;
    }
    advanceRevealFrame();
  }, [advanceRevealFrame, ensureSoundReady, playClickSound, preloadRevealSounds]);

  const handleReset = useCallback(() => {
    revealSoundPlayedRef.current = false;
    frameRef.current = 1;
    setFrame(1);
    if (DRIF_CARD_COUNT < 2) return;
    let nextIndex = cardIndex;
    while (nextIndex === cardIndex) {
      nextIndex = Math.floor(Math.random() * DRIF_CARD_COUNT);
    }
    preloadPonchoDrifellaCardAssets(DRIF_CARDS[nextIndex], preloadedCardsRef.current, cardPreloadImagesRef.current);
    setCardIndex(nextIndex);
  }, [cardIndex]);

  return (
    <div className="wip-page">
      <PonchoRevealOverlay
        overlayStyle={revealOverlayStyle}
        active
        closing={false}
        stage={stage}
        note={revealNote}
        boxName="Mystery pack"
        boxFrameSrc={revealBoxFrameSrc}
        card={currentCard}
        boxDisabled={revealComplete}
        onAdvance={handleRevealBoxPress}
      />
      <button
        type="button"
        className="wip-close-btn"
        onClick={() => {
          navigate('/');
        }}
        aria-label="Close wip overlay"
      >
        Close
      </button>
      <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset unboxing">
        Reset
      </button>
    </div>
  );
}

export default function WipApp(props: WipAppProps) {
  if (props.mode === 'inventory-unbox') {
    return <PonchoInventoryRevealOverlay {...props} />;
  }
  return <LocalPlayWipApp />;
}
