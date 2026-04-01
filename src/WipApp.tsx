import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PonchoInventoryRevealOverlay, {
  PonchoRevealOverlay,
  type PonchoInventoryRevealOverlayProps,
} from './components/PonchoRevealOverlay';
import { DRIF_CARD_COUNT, DRIF_CARDS } from './drifCards';
import {
  PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL,
  PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  preloadPonchoDrifellaCardAssets,
  preloadPonchoDrifellaPackAssets,
  usePonchoDrifellaRevealController,
  waitForPonchoDrifellaCardAssets,
} from './lib/ponchoDrifellaReveal';
import { getFrontendDrop } from './config/deployment';
import { dropAssetLabel } from './lib/dropLabels';
import { calcPonchoDrifellaCardRect, calcPonchoDrifellaRevealTargetRect } from './lib/revealOverlayLayout';
import { soundPlayer } from './lib/SoundPlayer';
import { navigate } from './navigation';

const REVEAL_NOTE_OFFSET = 28;
const WIP_CARD_READY_MIN_DELAY_MS = 5_000;
const WIP_CARD_READY_MAX_DELAY_MS = 10_000;
const WIP_DROP = getFrontendDrop('poncho_drifella_draft');

type OverlayRect = { left: number; top: number; width: number; height: number };

type WipLocalPlayProps = {
  mode?: 'local-play';
};

export type WipAppProps = WipLocalPlayProps | PonchoInventoryRevealOverlayProps;

function getInitialTargetRect(): OverlayRect {
  if (typeof window === 'undefined') {
    const width = 320;
    return {
      left: 0,
      top: 16,
      width,
      height: width,
    };
  }
  return calcPonchoDrifellaRevealTargetRect(window.innerWidth, window.innerHeight);
}

function randomWipRevealDelayMs() {
  return WIP_CARD_READY_MIN_DELAY_MS + Math.floor(Math.random() * (WIP_CARD_READY_MAX_DELAY_MS - WIP_CARD_READY_MIN_DELAY_MS + 1));
}

function LocalPlayWipApp() {
  const [targetRect, setTargetRect] = useState<OverlayRect>(() => getInitialTargetRect());
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_CARD_COUNT));
  const [cardReady, setCardReady] = useState(false);
  const [cardDisplayReady, setCardDisplayReady] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const preloadedBoxFramesRef = useRef<Set<string>>(new Set());
  const boxFramePreloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const preloadedCardsRef = useRef<Set<string>>(new Set());
  const cardPreloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealContainerLabel = dropAssetLabel(WIP_DROP, 'box', 1);
  const mysteryContainerName = `Mystery ${revealContainerLabel}`;
  const currentCard = DRIF_CARDS[cardIndex];

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
  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL, 0.42);
    });
  }, [ensureSoundReady]);
  const playRevealSound = useCallback(() => {
    const play = () => {
      void soundPlayer.playSound(PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL, 0.42);
    };
    if (soundPlayer.isInitialized) {
      play();
      return;
    }
    const pending = soundInitPromiseRef.current;
    if (pending) {
      void pending.then(play);
    }
  }, []);
  const ponchoRevealController = usePonchoDrifellaRevealController({
    active: true,
    phase: 'ready',
    boxLabel: revealContainerLabel,
    cardReady,
    cardDisplayReady,
    loadedImages: preloadedBoxFramesRef.current,
    pendingImages: boxFramePreloadImagesRef.current,
    resetKey,
    onPlayClick: playClickSound,
    onPlayReveal: playRevealSound,
  });

  const revealOverlayStyle = useMemo<React.CSSProperties>(() => {
    const safeTargetWidth = Math.max(1, targetRect.width);
    const safeTargetHeight = Math.max(1, targetRect.height);
    const cardRect = calcPonchoDrifellaCardRect({
      width: safeTargetWidth,
      height: safeTargetHeight,
    });
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
      ['--poncho-card-left' as never]: `${cardRect.left}px`,
      ['--poncho-card-top' as never]: `${cardRect.top}px`,
      ['--poncho-card-width' as never]: `${cardRect.width}px`,
      ['--poncho-card-height' as never]: `${cardRect.height}px`,
    };
  }, [targetRect]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const updateTarget = () => {
      setTargetRect(calcPonchoDrifellaRevealTargetRect(window.innerWidth, window.innerHeight));
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
    if (typeof window === 'undefined') return;
    preloadPonchoDrifellaPackAssets(preloadedBoxFramesRef.current, boxFramePreloadImagesRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCardDisplayReady(false);
    void waitForPonchoDrifellaCardAssets(currentCard, preloadedCardsRef.current, cardPreloadImagesRef.current).finally(() => {
      if (cancelled) return;
      setCardDisplayReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [currentCard]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadRevealSounds();
  }, [preloadRevealSounds]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    setCardReady(false);
    const timeoutId = window.setTimeout(() => {
      setCardReady(true);
    }, randomWipRevealDelayMs());
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [resetKey]);

  const handleReset = useCallback(() => {
    setResetKey((prev) => prev + 1);
    setCardIndex((prevIndex) => {
      if (DRIF_CARD_COUNT < 2) return prevIndex;
      let nextIndex = prevIndex;
      while (nextIndex === prevIndex) {
        nextIndex = Math.floor(Math.random() * DRIF_CARD_COUNT);
      }
      preloadPonchoDrifellaCardAssets(DRIF_CARDS[nextIndex], preloadedCardsRef.current, cardPreloadImagesRef.current);
      return nextIndex;
    });
  }, []);

  return (
    <div className="wip-page">
      <PonchoRevealOverlay
        overlayStyle={revealOverlayStyle}
        active
        closing={false}
        stage={ponchoRevealController.phase}
        note={ponchoRevealController.note}
        boxName={mysteryContainerName}
        boxFrameSrc={ponchoRevealController.boxFrameSrc}
        foregroundFrameSrc={ponchoRevealController.foregroundFrameSrc}
        card={currentCard}
        cardVisible={ponchoRevealController.cardVisible}
        cardInteractive={ponchoRevealController.cardInteractive}
        boxDisabled={ponchoRevealController.revealComplete}
        onAdvance={ponchoRevealController.handleAdvance}
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
      <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset opening">
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
