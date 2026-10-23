import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DogeDay2026RevealOverlay } from './DogeDay2026RevealOverlay';
import { clearDogeDay2026ImageCache, createDogeDay2026ImageCache, preloadDogeDay2026CardAssets, preloadDogeDay2026PackAssets } from './revealPlayer';
import { DOGE_DAY_2026_PACK_REVEAL_SEQUENCE } from './revealSequence';
import { DOGE_DAY_2026_WIP_CONFIG, DOGE_DAY_2026_WIP_SOUNDS, pickDogeDay2026ClickSound } from './starterConfig';
import { getDogeDay2026StarterCard } from './starterCards';
import { calcDogeDay2026RevealTargetRectInViewport, DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT, dogeDay2026RevealOverlayStyleVars, sameRevealOverlayRect } from './revealLayout';
import { soundPlayer } from '../lib/SoundPlayer';
import { isKeyboardShortcutTarget } from '../lib/focusTrap';
import { navigate } from '../navigation';
import { ModalFocusScope } from '../components/ModalFocusScope';
import './wip.css';

type OverlayRect = { left: number; top: number; width: number; height: number };

function calcWipTargetRect(): OverlayRect {
  if (typeof window === 'undefined') {
    const width = 320;
    return {
      left: 0,
      top: 16,
      width,
      height: width,
    };
  }
  return calcDogeDay2026RevealTargetRectInViewport();
}

function randomWipRevealDelayMs() {
  return DOGE_DAY_2026_WIP_CONFIG.cardReadyMinDelayMs + Math.floor(Math.random() * (DOGE_DAY_2026_WIP_CONFIG.cardReadyMaxDelayMs - DOGE_DAY_2026_WIP_CONFIG.cardReadyMinDelayMs + 1));
}

function randomWipCardId(cardCount: number) {
  return Math.floor(Math.random() * cardCount) + 1;
}

function randomWipCardIds(cardCount: number, count: number) {
  const targetUniqueCount = Math.min(count, cardCount);
  const ids: number[] = [];
  while (ids.length < targetUniqueCount) {
    const nextId = randomWipCardId(cardCount);
    if (!ids.includes(nextId)) {
      ids.push(nextId);
    }
  }
  while (ids.length < count) {
    ids.push(randomWipCardId(cardCount));
  }
  return ids;
}

function nextRandomWipCardIds(
  currentIds: readonly number[],
  cardCount: number,
  itemsPerBox: number,
) {
  if (cardCount < 2) return [...currentIds];
  const currentKey = currentIds.join(',');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nextIds = randomWipCardIds(cardCount, currentIds.length || itemsPerBox);
    if (nextIds.join(',') !== currentKey) return nextIds;
  }
  return randomWipCardIds(cardCount, currentIds.length || itemsPerBox);
}

export default function DogeDay2026WipApp() {
  const revealSoundProfile = DOGE_DAY_2026_WIP_CONFIG;
  const revealSoundUrls = DOGE_DAY_2026_WIP_SOUNDS;
  const itemsPerBox = DOGE_DAY_2026_WIP_CONFIG.itemsPerPack;
  const cardCount = DOGE_DAY_2026_WIP_CONFIG.cardCount;
  const [targetRect, setTargetRect] = useState<OverlayRect>(calcWipTargetRect);
  const [cardIds, setCardIds] = useState(() => randomWipCardIds(cardCount, itemsPerBox));
  const [cardReady, setCardReady] = useState(false);
  const [focusedMode, setFocusedMode] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const dogeImageCacheRef = useRef(createDogeDay2026ImageCache());
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const revealContainerLabel = DOGE_DAY_2026_WIP_CONFIG.packLabel;
  const mysteryContainerName = `Mystery ${revealContainerLabel}`;
  const packSequence = DOGE_DAY_2026_PACK_REVEAL_SEQUENCE;
  const currentCards = useMemo(() => cardIds
    .map(getDogeDay2026StarterCard)
    .filter((card): card is NonNullable<typeof card> => Boolean(card)), [cardIds]);

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
    void soundPlayer.preloadSound(revealSoundUrls.reveal);
    revealSoundUrls.click.forEach((clickUrl) => {
      void soundPlayer.preloadSound(clickUrl);
    });
  }, [revealSoundUrls.click, revealSoundUrls.reveal]);
  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(
        pickDogeDay2026ClickSound(),
        revealSoundProfile.clickVolume,
      );
    });
  }, [ensureSoundReady, revealSoundProfile.clickVolume]);
  const playRevealSound = useCallback(() => {
    const play = () => {
      void soundPlayer.playSound(revealSoundUrls.reveal, revealSoundProfile.revealVolume);
    };
    if (soundPlayer.isInitialized) {
      play();
      return;
    }
    const pending = soundInitPromiseRef.current;
    if (pending) {
      void pending.then(play);
    }
  }, [revealSoundProfile.revealVolume, revealSoundUrls.reveal]);
  const revealOverlayStyle = useMemo<React.CSSProperties>(
    () => dogeDay2026RevealOverlayStyleVars({
      originRect: targetRect,
      targetRect,
      cardCount: currentCards.length || DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT,
    }) as React.CSSProperties,
    [currentCards.length, targetRect],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frameId: number | null = null;
    const updateTarget = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const nextRect = calcWipTargetRect();
        setTargetRect((currentRect) => (sameRevealOverlayRect(currentRect, nextRect) ? currentRect : nextRect));
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
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  useEffect(() => {
    const imageCache = dogeImageCacheRef.current;
    return () => clearDogeDay2026ImageCache(imageCache);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    preloadDogeDay2026PackAssets(dogeImageCacheRef.current, { mode: 'warm', priority: 'low' }, packSequence);
  }, [packSequence]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    currentCards.forEach((nextCard) => {
      preloadDogeDay2026CardAssets(nextCard, dogeImageCacheRef.current, {
        mode: 'warm',
        priority: 'low',
      });
    });
  }, [currentCards]);

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
    const nextCardIds = nextRandomWipCardIds(cardIds, cardCount, itemsPerBox);
    setCardIds(nextCardIds);
  }, [cardCount, cardIds, itemsPerBox]);
  const handleClose = useCallback(() => {
    navigate('/');
  }, []);
  const handleBackdropPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      !(event.target instanceof Element) ||
      !event.target.classList.contains('doge-day-2026-reveal-overlay__backdrop')
    ) {
      return;
    }
    setFocusedMode((current) => !current);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isKeyboardShortcutTarget(event.target)) {
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
    <ModalFocusScope
      className={`doge-day-2026-wip-page${focusedMode ? ' doge-day-2026-wip-page--focused' : ''}`}
      ariaLabel={`${DOGE_DAY_2026_WIP_CONFIG.collectionName} pack preview`}
      focusTarget="scope"
      onEscape={handleClose}
      onPointerUpCapture={handleBackdropPointerUp}
    >
      <DogeDay2026RevealOverlay
        modal={false}
        overlayStyle={revealOverlayStyle}
        active
        closing={false}
        phase="ready"
        boxLabel={revealContainerLabel}
        boxName={mysteryContainerName}
        cards={currentCards}
        cardReady={cardReady && currentCards.length > 0}
        packSequence={packSequence}
        imageCache={dogeImageCacheRef.current}
        boxButtonRef={revealButtonRef}
        resetKey={resetKey}
        onPlayClick={playClickSound}
        onPlayReveal={playRevealSound}
      />
      <div
        className={`doge-day-2026-wip-controls${focusedMode ? ' doge-day-2026-wip-controls--hidden' : ''}`}
        aria-hidden={focusedMode || undefined}
        inert={focusedMode || undefined}
      >
        <button
          type="button"
          className="doge-day-2026-wip-close-btn"
          onClick={handleClose}
          aria-label="Close wip overlay"
        >
          Close
        </button>
        <button type="button" className="doge-day-2026-wip-reset-btn" onClick={handleReset} aria-label="Reset opening">
          Reset
        </button>
      </div>
    </ModalFocusScope>
  );
}
