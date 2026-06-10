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
import { isDropFamily, listFrontendDrops } from './config/deployment';
import { resolveDropContent } from './lib/dropContent';
import { dropAssetLabel } from './lib/dropLabels';
import {
  calcPonchoDrifellaRevealTargetRectInViewport,
  PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT,
  ponchoDrifellaRevealOverlayStyleVars,
  sameRevealOverlayRect,
} from './lib/revealOverlayLayout';
import { soundPlayer } from './lib/SoundPlayer';
import { navigate } from './navigation';

const WIP_CARD_READY_MIN_DELAY_MS = 1_000;
const WIP_CARD_READY_MAX_DELAY_MS = 1_300;
const WIP_DROP = (() => {
  const devnetCardNft2Drop = listFrontendDrops().find(
    (drop) => drop.solanaCluster === 'devnet' && isDropFamily(drop, 'card_nft_2'),
  );
  if (!devnetCardNft2Drop) {
    throw new Error('Missing devnet card_nft_2 frontend drop config');
  }
  return devnetCardNft2Drop;
})();
const WIP_REVEAL_SOUND_PROFILE = resolveDropContent(WIP_DROP).reveal.sound;
const WIP_REVEAL_SOUND_URLS = interactiveCardPackRevealSoundUrlsForDropId(WIP_DROP.dropId);
const WIP_CARD_MOTION_SOUND_URLS = [
  WIP_REVEAL_SOUND_URLS.cardSwipe,
  WIP_REVEAL_SOUND_URLS.cardSpread,
].filter((soundUrl): soundUrl is string => Boolean(soundUrl));
const WIP_BOX_SUPPLY_COUNT = Math.max(1, Math.floor(WIP_DROP.maxSupply));
const WIP_ITEMS_PER_BOX = Math.max(1, Math.floor(WIP_DROP.itemsPerBox || 1));
const WIP_CARD_COUNT = WIP_BOX_SUPPLY_COUNT * WIP_ITEMS_PER_BOX;
const WIP_PACK_MEDIA_COUNT = Math.max(1, Math.floor(WIP_DROP.boxMedia?.count || CARD_NFT_2_PACK_INITIAL_COUNT));

type OverlayRect = { left: number; top: number; width: number; height: number };

type WipLocalPlayProps = {
  mode?: 'local-play';
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

function randomWipCardId() {
  return Math.floor(Math.random() * WIP_CARD_COUNT) + 1;
}

function randomWipCardIds(count = WIP_ITEMS_PER_BOX) {
  const targetUniqueCount = Math.min(count, WIP_CARD_COUNT);
  const ids: number[] = [];
  while (ids.length < targetUniqueCount) {
    const nextId = randomWipCardId();
    if (!ids.includes(nextId)) {
      ids.push(nextId);
    }
  }
  while (ids.length < count) {
    ids.push(randomWipCardId());
  }
  return ids;
}

function randomWipPackMediaId() {
  return Math.floor(Math.random() * WIP_PACK_MEDIA_COUNT) + 1;
}

function nextRandomWipValue(currentValue: number, count: number) {
  if (count < 2) return currentValue;
  let nextValue = currentValue;
  while (nextValue === currentValue) {
    nextValue = Math.floor(Math.random() * count) + 1;
  }
  return nextValue;
}

function nextRandomWipCardIds(currentIds: readonly number[]) {
  if (WIP_CARD_COUNT < 2) return [...currentIds];
  const currentKey = currentIds.join(',');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nextIds = randomWipCardIds(currentIds.length || WIP_ITEMS_PER_BOX);
    if (nextIds.join(',') !== currentKey) return nextIds;
  }
  return randomWipCardIds(currentIds.length || WIP_ITEMS_PER_BOX);
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
  const [targetRect, setTargetRect] = useState<OverlayRect>(calcWipTargetRect);
  const [cardIds, setCardIds] = useState(() => randomWipCardIds());
  const [packMediaId, setPackMediaId] = useState(() => randomWipPackMediaId());
  const [cardReady, setCardReady] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const ponchoImageCacheRef = useRef(createPonchoDrifellaImageCache());
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const revealContainerLabel = dropAssetLabel(WIP_DROP, 'box', 1);
  const mysteryContainerName = `Mystery ${revealContainerLabel}`;
  const packSequence = useMemo(
    () => getInteractiveCardPackRevealSequenceForDropId(WIP_DROP.dropId, packMediaId),
    [packMediaId],
  );
  const currentCards = useMemo(() => {
    return getInteractiveCardPackCardsByFigureIds(WIP_DROP.dropId, cardIds);
  }, [cardIds]);

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
    WIP_CARD_MOTION_SOUND_URLS.forEach((motionUrl) => {
      void soundPlayer.preloadSound(motionUrl);
    });
  }, []);
  const scheduleCardMotionSoundPreload = useCallback(() => {
    if (typeof window === 'undefined') {
      preloadCardMotionSounds();
      return;
    }
    window.setTimeout(preloadCardMotionSounds, 0);
  }, [preloadCardMotionSounds]);
  const preloadRevealSounds = useCallback(() => {
    void soundPlayer.preloadSound(WIP_REVEAL_SOUND_URLS.reveal);
    WIP_REVEAL_SOUND_URLS.click.forEach((clickUrl) => {
      void soundPlayer.preloadSound(clickUrl);
    });
    preloadCardMotionSounds();
  }, [preloadCardMotionSounds]);
  const playClickSound = useCallback(() => {
    void ensureSoundReady().then(() => {
      void soundPlayer.playSound(
        pickRandomInteractiveCardPackClickSoundUrl(WIP_DROP.dropId),
        WIP_REVEAL_SOUND_PROFILE.clickVolume,
      );
      scheduleCardMotionSoundPreload();
    });
  }, [ensureSoundReady, scheduleCardMotionSoundPreload]);
  const playRevealSound = useCallback(() => {
    const play = () => {
      void soundPlayer.playSound(WIP_REVEAL_SOUND_URLS.reveal, WIP_REVEAL_SOUND_PROFILE.revealVolume);
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
  const playCardMotionSound = useCallback(
    (motionUrl: string | undefined) => {
      if (!motionUrl) return;
      const play = () => {
        void soundPlayer.playSound(motionUrl, WIP_REVEAL_SOUND_PROFILE.clickVolume);
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
    [ensureSoundReady],
  );
  const playCardSwipeSound = useCallback(() => {
    playCardMotionSound(WIP_REVEAL_SOUND_URLS.cardSwipe);
  }, [playCardMotionSound]);
  const playCardSpreadSound = useCallback(() => {
    playCardMotionSound(WIP_REVEAL_SOUND_URLS.cardSpread);
  }, [playCardMotionSound]);

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
    const nextCardIds = nextRandomWipCardIds(cardIds);
    const nextPackMediaId = nextRandomWipValue(packMediaId, WIP_PACK_MEDIA_COUNT);
    setCardIds(nextCardIds);
    setPackMediaId(nextPackMediaId);
  }, [cardIds, packMediaId]);
  const handleClose = useCallback(() => {
    navigate('/');
  }, []);

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
        onDismiss={handleClose}
      />
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
  );
}

export default function WipApp(props: WipAppProps) {
  if (props.mode === 'inventory-unbox') {
    return <InteractiveCardPackRevealOverlay {...props} />;
  }
  return <LocalPlayWipApp />;
}
