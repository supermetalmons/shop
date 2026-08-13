import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractiveCardPackRevealOverlay,
  PonchoRevealOverlay,
  type InteractiveCardPackRevealOverlayProps,
} from './components/PonchoRevealOverlay';
import { CARD_NFT_2_PACK_INITIAL_COUNT } from './config/dropMediaDefaults';
import {
  createPonchoDrifellaImageCache,
  preloadPonchoDrifellaCardAssets,
  preloadPonchoDrifellaPackAssets,
} from './lib/ponchoDrifellaReveal';
import {
  getInteractiveCardPackCardsByFigureIds,
  getInteractiveCardPackRevealSequenceForDropId,
} from './lib/interactiveCardPackReveal';
import {
  interactiveCardPackRevealSoundUrlsForDropId,
  pickRandomInteractiveCardPackClickSoundUrl,
} from './lib/interactiveCardPackRevealSounds';
import { getFrontendDrop } from './config/deployment';
import { resolveDropContent } from './lib/dropContent';
import { dropAssetLabel } from './lib/dropLabels';
import {
  calcPonchoDrifellaRevealTargetRectInViewport,
  PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
  ponchoDrifellaRevealOverlayStyleVars,
  sameRevealOverlayRect,
} from './lib/revealOverlayLayout';
import { soundPlayer } from './lib/SoundPlayer';
import { isKeyboardShortcutTarget } from './lib/focusTrap';
import { navigate } from './navigation';
import { ModalFocusScope } from './components/ModalFocusScope';
import LittleSwagBoxesWipApp from './LittleSwagBoxesWipApp';

const WIP_CARD_READY_MIN_DELAY_MS = 1_000;
const WIP_CARD_READY_MAX_DELAY_MS = 1_300;

type OverlayRect = { left: number; top: number; width: number; height: number };

export type PackWipDropId = 'card_nft_2' | 'little_swag_boxes' | 'poncho_drifella';

type WipLocalPlayProps = {
  mode?: 'local-play';
  dropId?: PackWipDropId;
};

export type WipAppProps = WipLocalPlayProps | InteractiveCardPackRevealOverlayProps;

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
  return calcPonchoDrifellaRevealTargetRectInViewport();
}

function randomWipRevealDelayMs() {
  return WIP_CARD_READY_MIN_DELAY_MS + Math.floor(Math.random() * (WIP_CARD_READY_MAX_DELAY_MS - WIP_CARD_READY_MIN_DELAY_MS + 1));
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

function randomWipPackMediaId(packMediaCount: number) {
  return Math.floor(Math.random() * packMediaCount) + 1;
}

function nextRandomWipValue(currentValue: number, count: number) {
  if (count < 2) return currentValue;
  let nextValue = currentValue;
  while (nextValue === currentValue) {
    nextValue = Math.floor(Math.random() * count) + 1;
  }
  return nextValue;
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

function LocalPlayWipApp({ dropId }: { dropId: Exclude<PackWipDropId, 'little_swag_boxes'> }) {
  const wipDrop = getFrontendDrop(dropId);
  if (!wipDrop) {
    throw new Error(`Missing ${dropId} frontend drop config`);
  }
  const revealSoundProfile = resolveDropContent(wipDrop).reveal.sound;
  const revealSoundUrls = useMemo(
    () => interactiveCardPackRevealSoundUrlsForDropId(wipDrop.dropId),
    [wipDrop.dropId],
  );
  const cardMotionSoundUrls = useMemo(
    () => [revealSoundUrls.cardSwipe, revealSoundUrls.cardSpread]
      .filter((soundUrl): soundUrl is string => Boolean(soundUrl)),
    [revealSoundUrls.cardSpread, revealSoundUrls.cardSwipe],
  );
  const boxSupplyCount = Math.max(1, Math.floor(wipDrop.maxSupply));
  const itemsPerBox = Math.max(1, Math.floor(wipDrop.itemsPerBox || 1));
  const cardCount = boxSupplyCount * itemsPerBox;
  const packMediaCount = Math.max(
    1,
    Math.floor(
      wipDrop.boxMedia?.count ||
        (wipDrop.dropId === 'card_nft_2' ? CARD_NFT_2_PACK_INITIAL_COUNT : 1),
    ),
  );
  const [targetRect, setTargetRect] = useState<OverlayRect>(calcWipTargetRect);
  const [cardIds, setCardIds] = useState(() => randomWipCardIds(cardCount, itemsPerBox));
  const [packMediaId, setPackMediaId] = useState(() => randomWipPackMediaId(packMediaCount));
  const [cardReady, setCardReady] = useState(false);
  const [focusedMode, setFocusedMode] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const ponchoImageCacheRef = useRef(createPonchoDrifellaImageCache());
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const revealContainerLabel = dropAssetLabel(wipDrop, 'box', 1);
  const mysteryContainerName = `Mystery ${revealContainerLabel}`;
  const packSequence = useMemo(
    () => getInteractiveCardPackRevealSequenceForDropId(wipDrop.dropId, packMediaId),
    [packMediaId, wipDrop.dropId],
  );
  const currentCards = useMemo(() => {
    return getInteractiveCardPackCardsByFigureIds(wipDrop.dropId, cardIds);
  }, [cardIds, wipDrop.dropId]);

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

  const preloadCardMotionSounds = useCallback(() => {
    cardMotionSoundUrls.forEach((motionUrl) => {
      void soundPlayer.preloadSound(motionUrl);
    });
  }, [cardMotionSoundUrls]);
  const scheduleCardMotionSoundPreload = useCallback(() => {
    if (typeof window === 'undefined') {
      preloadCardMotionSounds();
      return;
    }
    window.setTimeout(preloadCardMotionSounds, 0);
  }, [preloadCardMotionSounds]);
  const preloadRevealSounds = useCallback(() => {
    void soundPlayer.preloadSound(revealSoundUrls.reveal);
    revealSoundUrls.click.forEach((clickUrl) => {
      void soundPlayer.preloadSound(clickUrl);
    });
    preloadCardMotionSounds();
  }, [preloadCardMotionSounds, revealSoundUrls.click, revealSoundUrls.reveal]);
  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(
        pickRandomInteractiveCardPackClickSoundUrl(wipDrop.dropId),
        revealSoundProfile.clickVolume,
      );
      scheduleCardMotionSoundPreload();
    });
  }, [ensureSoundReady, revealSoundProfile.clickVolume, scheduleCardMotionSoundPreload, wipDrop.dropId]);
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
  const playCardMotionSound = useCallback(
    (motionUrl: string | undefined) => {
      if (!motionUrl) return;
      const play = () => {
        void soundPlayer.playSound(motionUrl, revealSoundProfile.clickVolume);
      };
      if (soundPlayer.isInitialized) {
        play();
        return;
      }
      const pending = soundInitPromiseRef.current;
      if (pending) {
        void pending.then(play);
        return;
      }
      void ensureSoundReady().then(play);
    },
    [ensureSoundReady, revealSoundProfile.clickVolume],
  );
  const playCardSwipeSound = useCallback(() => {
    playCardMotionSound(revealSoundUrls.cardSwipe);
  }, [playCardMotionSound, revealSoundUrls.cardSwipe]);
  const playCardSpreadSound = useCallback(() => {
    playCardMotionSound(revealSoundUrls.cardSpread);
  }, [playCardMotionSound, revealSoundUrls.cardSpread]);

  const revealOverlayStyle = useMemo<React.CSSProperties>(
    () => ponchoDrifellaRevealOverlayStyleVars({
      originRect: targetRect,
      targetRect,
      cardCount: currentCards.length || PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
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
    if (typeof window === 'undefined') return;
    preloadPonchoDrifellaPackAssets(ponchoImageCacheRef.current, { mode: 'warm', priority: 'low' }, packSequence);
  }, [packSequence]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    currentCards.forEach((nextCard) => {
      preloadPonchoDrifellaCardAssets(nextCard, ponchoImageCacheRef.current, {
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
    const nextPackMediaId = nextRandomWipValue(packMediaId, packMediaCount);
    setCardIds(nextCardIds);
    setPackMediaId(nextPackMediaId);
  }, [cardCount, cardIds, itemsPerBox, packMediaCount, packMediaId]);
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
      className={`wip-page${focusedMode ? ' wip-page--focused' : ''}`}
      ariaLabel={`${wipDrop.collectionName} pack preview`}
      focusTarget="scope"
      onEscape={handleClose}
      onPointerUpCapture={handleBackdropPointerUp}
    >
      <PonchoRevealOverlay
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
        imageCache={ponchoImageCacheRef.current}
        boxButtonRef={revealButtonRef}
        resetKey={resetKey}
        onPlayClick={playClickSound}
        onPlayReveal={playRevealSound}
        onPlayCardSwipe={playCardSwipeSound}
        onPlayCardSpread={playCardSpreadSound}
      />
      <div
        className={`wip-controls${focusedMode ? ' wip-controls--hidden' : ''}`}
        aria-hidden={focusedMode || undefined}
        inert={focusedMode || undefined}
      >
        <button
          type="button"
          className="wip-close-btn"
          onClick={handleClose}
          aria-label="Close wip overlay"
        >
          Close
        </button>
        <button type="button" className="wip-reset-btn" onClick={handleReset} aria-label="Reset opening">
          Reset
        </button>
      </div>
    </ModalFocusScope>
  );
}

export default function WipApp(props: WipAppProps) {
  if (props.mode === 'inventory-unbox') {
    return <InteractiveCardPackRevealOverlay {...props} />;
  }
  const dropId = props.dropId || 'card_nft_2';
  if (dropId === 'little_swag_boxes') {
    return <LittleSwagBoxesWipApp />;
  }
  return <LocalPlayWipApp dropId={dropId} />;
}
