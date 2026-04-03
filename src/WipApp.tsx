import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PonchoInventoryRevealOverlay, {
  PonchoRevealOverlay,
  type PonchoInventoryRevealOverlayProps,
} from './components/PonchoRevealOverlay';
import { DRIF_CARD_COUNT, DRIF_CARDS } from './drifCards';
import {
  PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
  PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS,
  PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS,
  createPonchoDrifellaImageCache,
  getRandomPonchoDrifellaBoxClickSoundUrl,
  preloadPonchoDrifellaCardAssets,
  preloadPonchoDrifellaPackAssets,
  usePonchoDrifellaCardAssetsReady,
} from './lib/ponchoDrifellaReveal';
import { getFrontendDrop } from './config/deployment';
import { resolveDropContent } from './lib/dropContent';
import { dropAssetLabel } from './lib/dropLabels';
import { calcPonchoDrifellaCardRect, calcPonchoDrifellaRevealTargetRect } from './lib/revealOverlayLayout';
import { soundPlayer } from './lib/SoundPlayer';
import { navigate } from './navigation';

const REVEAL_NOTE_OFFSET = 28;
const WIP_CARD_READY_MIN_DELAY_MS = 1_000;
const WIP_CARD_READY_MAX_DELAY_MS = 1_300;
const WIP_DROP = getFrontendDrop('poncho_drifella_draft');
const WIP_REVEAL_SOUND_PROFILE = resolveDropContent(WIP_DROP).reveal.sound;

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

function nextWipCardIndex(currentIndex: number) {
  if (DRIF_CARD_COUNT < 2) return currentIndex;
  let nextIndex = currentIndex;
  while (nextIndex === currentIndex) {
    nextIndex = Math.floor(Math.random() * DRIF_CARD_COUNT);
  }
  return nextIndex;
}

function isWipShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    tagName === 'BUTTON' ||
    tagName === 'A'
  );
}

function LocalPlayWipApp() {
  const [targetRect, setTargetRect] = useState<OverlayRect>(() => getInitialTargetRect());
  const [cardIndex, setCardIndex] = useState(() => Math.floor(Math.random() * DRIF_CARD_COUNT));
  const [cardReady, setCardReady] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const ponchoImageCacheRef = useRef(createPonchoDrifellaImageCache());
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const revealContainerLabel = dropAssetLabel(WIP_DROP, 'box', 1);
  const mysteryContainerName = `Mystery ${revealContainerLabel}`;
  const currentCard = DRIF_CARDS[cardIndex];
  const cardAssetsReady = usePonchoDrifellaCardAssetsReady({
    active: true,
    card: currentCard,
    imageCache: ponchoImageCacheRef.current,
  });

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
    PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS.forEach((clickUrl) => {
      void soundPlayer.preloadSound(clickUrl);
    });
  }, []);
  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(getRandomPonchoDrifellaBoxClickSoundUrl(), WIP_REVEAL_SOUND_PROFILE.clickVolume);
    });
  }, [ensureSoundReady]);
  const playRevealSound = useCallback(() => {
    const play = () => {
      void soundPlayer.playSound(PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL, WIP_REVEAL_SOUND_PROFILE.revealVolume);
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
      ['--poncho-pack-discard-delay' as never]: `${PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS}ms`,
      ['--poncho-pack-discard-duration' as never]: `${PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS}ms`,
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
    preloadPonchoDrifellaPackAssets(ponchoImageCacheRef.current, { mode: 'warm', priority: 'low' });
  }, []);

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
    const nextIndex = nextWipCardIndex(cardIndex);
    if (nextIndex !== cardIndex) {
      preloadPonchoDrifellaCardAssets(DRIF_CARDS[nextIndex], ponchoImageCacheRef.current, {
        mode: 'resident',
        priority: 'high',
      });
    }
    setCardIndex(nextIndex);
  }, [cardIndex]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isWipShortcutTarget(event.target)) {
        return;
      }
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
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleReset]);

  return (
    <div className="wip-page">
      <PonchoRevealOverlay
        overlayStyle={revealOverlayStyle}
        active
        closing={false}
        phase="ready"
        boxLabel={revealContainerLabel}
        boxName={mysteryContainerName}
        card={currentCard}
        cardReady={cardReady}
        cardAssetsReady={cardAssetsReady}
        imageCache={ponchoImageCacheRef.current}
        boxButtonRef={revealButtonRef}
        resetKey={resetKey}
        onPlayClick={playClickSound}
        onPlayReveal={playRevealSound}
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
