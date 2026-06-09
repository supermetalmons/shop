import {
  useCallback,
  useEffect,
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
  arePonchoDrifellaCardAssetsReady,
  createPonchoDrifellaRevealPlayer,
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS,
  PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS,
  preloadPonchoDrifellaCardAssets,
  releasePonchoDrifellaCardAssets,
  type PonchoDrifellaImageCache,
  type PonchoDrifellaRevealPhase,
  type PonchoDrifellaRevealPlayer,
  type PonchoDrifellaRevealPlayerViewState,
  type PonchoDrifellaRevealRequestStatus,
  usePonchoDrifellaCardAssetsReady,
  usePonchoDrifellaImageCacheGeneration,
} from '../lib/ponchoDrifellaReveal';
import {
  PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE,
  type InteractiveCardPackRevealSequence,
} from '../lib/interactiveCardPackReveal';
import WipInteractiveCard from './WipInteractiveCard';

type PonchoRevealSharedProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  boxName: string;
  imageCache: PonchoDrifellaImageCache;
  packSequence?: InteractiveCardPackRevealSequence;
  cardLabel?: string;
  resetKey: string | number;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  onBeforeAdvance?: () => boolean;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
  onRevealCompleteChange?: (complete: boolean) => void;
  onDismissReadyChange?: (ready: boolean) => void;
};

type PonchoRevealRuntimeProps = PonchoRevealSharedProps & {
  cards: readonly DrifCardConfig[];
  cardReady: boolean;
  loading?: boolean;
  boxButtonRef?: RefObject<HTMLButtonElement | null>;
};

export type PonchoInventoryRevealOverlayProps = PonchoRevealSharedProps & {
  mode: 'inventory-unbox';
  cards?: readonly DrifCardConfig[];
  cardReady?: boolean;
  loading: boolean;
};

export type InteractiveCardPackRevealOverlayProps = PonchoInventoryRevealOverlayProps;

export type PonchoCardViewerOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  card?: DrifCardConfig;
  loadingImageSrc?: string;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
};

function createInitialPlayerState(phase: PonchoDrifellaRevealPhase, boxLabel: string): PonchoDrifellaRevealPlayerViewState {
  return {
    phase,
    stage: 'idle',
    note: phase === 'ready' ? `click the ${boxLabel} to open` : '',
    advanceLocked: false,
    revealComplete: false,
    revealFailedOpen: false,
    cardInteractive: false,
    packDiscarded: false,
    stageVisible: false,
    cardVisible: false,
  };
}

function samePlayerState(a: PonchoDrifellaRevealPlayerViewState, b: PonchoDrifellaRevealPlayerViewState) {
  return (
    a.phase === b.phase &&
    a.stage === b.stage &&
    a.note === b.note &&
    a.advanceLocked === b.advanceLocked &&
    a.revealComplete === b.revealComplete &&
    a.revealFailedOpen === b.revealFailedOpen &&
    a.cardInteractive === b.cardInteractive &&
    a.packDiscarded === b.packDiscarded &&
    a.stageVisible === b.stageVisible &&
    a.cardVisible === b.cardVisible
  );
}

function clearPonchoCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawPonchoFrameToCanvas(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (!cssWidth || !cssHeight || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return false;
  }

  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5));
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  context.clearRect(0, 0, targetWidth, targetHeight);

  const scale = Math.min(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const drawX = (targetWidth - drawWidth) / 2;
  const drawY = (targetHeight - drawHeight) / 2;
  const downscaling = drawWidth < image.naturalWidth || drawHeight < image.naturalHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = downscaling && dpr <= 1.2 ? 'high' : 'medium';
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  return true;
}

function canDrawPonchoFrameToCanvas(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  return Boolean(cssWidth && cssHeight && image.naturalWidth > 0 && image.naturalHeight > 0);
}

function shouldSuspendPonchoCardResidentPreload(stage: PonchoDrifellaRevealPlayerViewState['stage']) {
  return stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2';
}

const EMPTY_CARD_STACK: readonly DrifCardConfig[] = [];
const PONCHO_REVEAL_CARD_READY_FALLBACK_MS = 600;
const PONCHO_REVEAL_CARD_STACK_DISCARD_FALLBACK_MS = 420;
const PONCHO_REVEAL_PACK_DISCARD_FALLBACK_MS =
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS + PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS + 120;

function cardStackKeyForCard(card: DrifCardConfig, index: number) {
  return `${index}:${card.effect.id}:${card.imageSrc}:${card.foilSrc || ''}:${card.textureSrc || ''}`;
}

function clearWindowTimeoutRef(timeoutRef: { current: number | null }) {
  if (timeoutRef.current === null || typeof window === 'undefined') return;
  window.clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}

type PonchoCardStackEntryRole = 'active' | 'discarding' | 'next';

type PonchoCardStackEntryModel = {
  card: DrifCardConfig;
  index: number;
  role: PonchoCardStackEntryRole;
  depth: number;
};

function usePonchoDrifellaCardStackAssets({
  active,
  activeCardIndex,
  cardVisible,
  imageCache,
  stackCards,
}: {
  active: boolean;
  activeCardIndex: number;
  cardVisible: boolean;
  imageCache: PonchoDrifellaImageCache;
  stackCards: readonly DrifCardConfig[];
}) {
  const stackCardsKey = useMemo(() => stackCards.map(cardStackKeyForCard).join('|'), [stackCards]);

  useEffect(() => {
    if (!active || !cardVisible) return;
    const [nextCard, ...laterCards] = stackCards.slice(activeCardIndex + 1);
    if (nextCard) {
      preloadPonchoDrifellaCardAssets(nextCard, imageCache, {
        mode: 'resident',
        priority: 'high',
      });
    }
    laterCards.forEach((laterCard) => {
      preloadPonchoDrifellaCardAssets(laterCard, imageCache, {
        mode: 'warm',
        priority: 'low',
      });
    });
  }, [active, activeCardIndex, cardVisible, imageCache, stackCardsKey]);

  useEffect(() => {
    const cardsToRelease = [...stackCards];
    return () => {
      cardsToRelease.forEach((nextCard) => {
        releasePonchoDrifellaCardAssets(nextCard, imageCache);
      });
    };
  }, [imageCache, stackCardsKey]);
}

function PonchoRevealCardStackEntry({
  entry,
  cardKey,
  cardInteractive,
  cardLocked,
  cardLabel,
  onCardClick,
  onImageReadyChange,
  onDiscardAnimationEnd,
}: {
  entry: PonchoCardStackEntryModel;
  cardKey: string;
  cardInteractive: boolean;
  cardLocked: boolean;
  cardLabel: string;
  onCardClick: (evt: SyntheticEvent) => void;
  onImageReadyChange: (cardKey: string, ready: boolean) => void;
  onDiscardAnimationEnd: (evt: AnimationEvent<HTMLElement>, cardIndex: number) => void;
}) {
  const { card, index, role, depth } = entry;
  const isActiveEntry = role === 'active';
  const isDiscardingEntry = role === 'discarding';
  const isNextEntry = role === 'next';
  const stackDepth = role === 'next' ? Math.min(Math.max(depth, 1), 3) : 0;
  const handleImageReadyChange = useCallback(
    (ready: boolean) => {
      onImageReadyChange(cardKey, ready);
    },
    [cardKey, onImageReadyChange],
  );
  const handleDiscardAnimationEnd = useCallback(
    (evt: AnimationEvent<HTMLElement>) => {
      onDiscardAnimationEnd(evt, index);
    },
    [index, onDiscardAnimationEnd],
  );

  return (
    <div
      className={`reveal-overlay__media-item wip-reveal__card-item${isNextEntry ? ' wip-reveal__card-item--next' : ''}${isActiveEntry && cardInteractive ? ' wip-reveal__card-item--interactive' : ''}${isActiveEntry && cardLocked ? ' wip-reveal__card-item--locked' : ''}`}
      aria-hidden={isNextEntry}
      onClick={isActiveEntry || isDiscardingEntry ? onCardClick : undefined}
    >
      <div
        className={`wip-reveal__card-stack-entry${isNextEntry ? ` wip-reveal__card-stack-entry--next wip-reveal__card-stack-entry--next-depth-${stackDepth}` : ''}${isDiscardingEntry ? ' wip-reveal__card-stack-entry--discarding' : ''}`}
        onAnimationEnd={handleDiscardAnimationEnd}
      >
        <div className="reveal-overlay__media-float">
          <WipInteractiveCard
            card={card}
            interactive={isActiveEntry && cardInteractive}
            onImageReadyChange={isActiveEntry ? handleImageReadyChange : undefined}
            wakeOnInteractiveUnlock={false}
            ariaLabel={cardLabel}
            imageAlt={cardLabel}
          />
        </div>
      </div>
    </div>
  );
}

export function PonchoRevealOverlay({
  overlayStyle,
  active,
  closing,
  phase,
  boxLabel,
  boxName,
  cards = EMPTY_CARD_STACK,
  cardReady,
  packSequence,
  cardLabel = 'Revealed card',
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
  onRevealCompleteChange,
  onDismissReadyChange,
}: PonchoRevealRuntimeProps) {
  const imageCacheGeneration = usePonchoDrifellaImageCacheGeneration(imageCache);
  const boxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<PonchoDrifellaRevealPlayer | null>(null);
  const activePackSequence = packSequence ?? PONCHO_DRIFELLA_PACK_REVEAL_SEQUENCE;
  const cardImageReadyRef = useRef(false);
  const discardAnimationReportedRef = useRef(false);
  const packDiscardFallbackTimeoutRef = useRef<number | null>(null);
  const cardStackAdvanceLockedRef = useRef(false);
  const cardStackDiscardFallbackTimeoutRef = useRef<number | null>(null);
  const activeCardReadyFallbackTimeoutRef = useRef<number | null>(null);
  const [hasCommittedBoxVisual, setHasCommittedBoxVisual] = useState(false);
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [discardingCardIndex, setDiscardingCardIndex] = useState<number | null>(null);
  const [packDiscardAnimationComplete, setPackDiscardAnimationComplete] = useState(false);
  const [readyCardKey, setReadyCardKey] = useState('');
  const [fallbackReadyCardKey, setFallbackReadyCardKey] = useState('');
  const [playerState, setPlayerState] = useState<PonchoDrifellaRevealPlayerViewState>(() =>
    createInitialPlayerState(phase, boxLabel),
  );
  const stackCards = cards;
  const stackCardsKey = useMemo(() => stackCards.map(cardStackKeyForCard).join('|'), [stackCards]);
  const activeStackCard = stackCards[activeCardIndex];
  const activeStackCardKey = activeStackCard ? cardStackKeyForCard(activeStackCard, activeCardIndex) : '';
  const nextStackCard = stackCards[activeCardIndex + 1];
  const remainingStackCards = useMemo(
    () => stackCards.slice(activeCardIndex + 1),
    [activeCardIndex, stackCards],
  );
  const cardAssetsReady = usePonchoDrifellaCardAssetsReady({
    active,
    card: activeStackCard,
    imageCache,
    suspendResidentPreload: shouldSuspendPonchoCardResidentPreload(playerState.stage),
    releaseOnCleanup: false,
  });
  const playerCardReady = cardReady && Boolean(activeStackCard);
  const cardStackTransitioning = discardingCardIndex !== null;
  const activeStackCardReady = Boolean(
    activeStackCardKey &&
      cardAssetsReady &&
      arePonchoDrifellaCardAssetsReady(activeStackCard, imageCache) &&
      (readyCardKey === activeStackCardKey || fallbackReadyCardKey === activeStackCardKey),
  );
  const cardStackCanAdvance =
    playerState.cardInteractive &&
    activeStackCardReady &&
    packDiscardAnimationComplete &&
    Boolean(nextStackCard) &&
    !cardStackTransitioning &&
    !closing;
  const cardStackDismissReady = Boolean(
    playerState.cardInteractive &&
      activeStackCardReady &&
      packDiscardAnimationComplete &&
      stackCards.length > 0 &&
      activeCardIndex >= stackCards.length - 1 &&
      !cardStackTransitioning,
  );
  usePonchoDrifellaCardStackAssets({
    active,
    activeCardIndex,
    cardVisible: playerState.cardVisible,
    imageCache,
    stackCards,
  });
  const clearVisuals = useCallback(() => {
    clearPonchoCanvas(boxCanvasRef.current);
    clearPonchoCanvas(foregroundCanvasRef.current);
  }, []);

  const commitVisual = useCallback(
    ({
      boxImage,
      foregroundImage,
      stageVisible,
    }: {
      boxImage: HTMLImageElement;
      foregroundImage?: HTMLImageElement;
      stageVisible: boolean;
    }) => {
      if (!canDrawPonchoFrameToCanvas(boxCanvasRef.current, boxImage)) return false;
      if (stageVisible) {
        if (!foregroundImage) return false;
        if (!canDrawPonchoFrameToCanvas(foregroundCanvasRef.current, foregroundImage)) return false;
      }

      const boxDrawn = drawPonchoFrameToCanvas(boxCanvasRef.current, boxImage);
      if (!boxDrawn) return false;
      if (stageVisible) {
        const nextForegroundImage = foregroundImage;
        if (!nextForegroundImage) return false;
        const foregroundDrawn = drawPonchoFrameToCanvas(foregroundCanvasRef.current, nextForegroundImage);
        if (!foregroundDrawn) return false;
      } else {
        clearPonchoCanvas(foregroundCanvasRef.current);
      }
      setHasCommittedBoxVisual(true);
      return true;
    },
    [],
  );

  const handlePlayerStateChange = useCallback((nextState: PonchoDrifellaRevealPlayerViewState) => {
    setPlayerState((currentState) => (samePlayerState(currentState, nextState) ? currentState : nextState));
  }, []);

  const clearPackDiscardFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(packDiscardFallbackTimeoutRef);
  }, []);

  const clearCardStackDiscardFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackDiscardFallbackTimeoutRef);
  }, []);

  const clearActiveCardReadyFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(activeCardReadyFallbackTimeoutRef);
  }, []);

  const completePackDiscardAnimation = useCallback(() => {
    if (discardAnimationReportedRef.current) return;
    discardAnimationReportedRef.current = true;
    clearPackDiscardFallbackTimeout();
    setPackDiscardAnimationComplete(true);
  }, [clearPackDiscardFallbackTimeout]);

  useEffect(() => {
    if (active && playerState.revealComplete) return;
    discardAnimationReportedRef.current = false;
    clearPackDiscardFallbackTimeout();
    setPackDiscardAnimationComplete(false);
  }, [active, clearPackDiscardFallbackTimeout, playerState.revealComplete]);

  const finishCardStackDiscard = useCallback(
    (discardedIndex: number) => {
      clearCardStackDiscardFallbackTimeout();
      cardStackAdvanceLockedRef.current = false;
      setActiveCardIndex((currentIndex) => Math.max(currentIndex, discardedIndex + 1));
      setDiscardingCardIndex((currentIndex) => (currentIndex === discardedIndex ? null : currentIndex));
    },
    [clearCardStackDiscardFallbackTimeout],
  );

  const advanceCardStack = useCallback(() => {
    if (!cardStackCanAdvance) return false;
    if (cardStackAdvanceLockedRef.current) return true;
    const discardedIndex = activeCardIndex;
    cardStackAdvanceLockedRef.current = true;
    setDiscardingCardIndex(discardedIndex);
    clearCardStackDiscardFallbackTimeout();
    if (typeof window !== 'undefined') {
      cardStackDiscardFallbackTimeoutRef.current = window.setTimeout(() => {
        cardStackDiscardFallbackTimeoutRef.current = null;
        finishCardStackDiscard(discardedIndex);
      }, PONCHO_REVEAL_CARD_STACK_DISCARD_FALLBACK_MS);
    }
    return true;
  }, [activeCardIndex, cardStackCanAdvance, clearCardStackDiscardFallbackTimeout, finishCardStackDiscard]);

  useEffect(() => {
    cardImageReadyRef.current = false;
    cardStackAdvanceLockedRef.current = false;
    discardAnimationReportedRef.current = false;
    clearPackDiscardFallbackTimeout();
    clearCardStackDiscardFallbackTimeout();
    clearActiveCardReadyFallbackTimeout();
    setReadyCardKey('');
    setFallbackReadyCardKey('');
    setActiveCardIndex(0);
    setDiscardingCardIndex(null);
    setPackDiscardAnimationComplete(false);
  }, [
    active,
    clearActiveCardReadyFallbackTimeout,
    clearCardStackDiscardFallbackTimeout,
    clearPackDiscardFallbackTimeout,
    resetKey,
    stackCardsKey,
  ]);

  useEffect(() => {
    onDismissReadyChange?.(cardStackDismissReady);
  }, [cardStackDismissReady, onDismissReadyChange]);

  useEffect(() => {
    if (!active || !playerState.packDiscarded || packDiscardAnimationComplete) {
      clearPackDiscardFallbackTimeout();
      return undefined;
    }
    if (typeof window === 'undefined') {
      completePackDiscardAnimation();
      return undefined;
    }
    clearPackDiscardFallbackTimeout();
    packDiscardFallbackTimeoutRef.current = window.setTimeout(() => {
      packDiscardFallbackTimeoutRef.current = null;
      completePackDiscardAnimation();
    }, PONCHO_REVEAL_PACK_DISCARD_FALLBACK_MS);
    return () => {
      clearPackDiscardFallbackTimeout();
    };
  }, [
    active,
    clearPackDiscardFallbackTimeout,
    completePackDiscardAnimation,
    packDiscardAnimationComplete,
    playerState.packDiscarded,
  ]);

  useEffect(() => {
    if (
      !active ||
      !activeStackCardKey ||
      readyCardKey === activeStackCardKey ||
      fallbackReadyCardKey === activeStackCardKey ||
      !playerState.cardInteractive ||
      !packDiscardAnimationComplete ||
      !cardAssetsReady ||
      !arePonchoDrifellaCardAssetsReady(activeStackCard, imageCache)
    ) {
      clearActiveCardReadyFallbackTimeout();
      return undefined;
    }
    if (typeof window === 'undefined') {
      setFallbackReadyCardKey(activeStackCardKey);
      return undefined;
    }
    clearActiveCardReadyFallbackTimeout();
    activeCardReadyFallbackTimeoutRef.current = window.setTimeout(() => {
      activeCardReadyFallbackTimeoutRef.current = null;
      setFallbackReadyCardKey(activeStackCardKey);
    }, PONCHO_REVEAL_CARD_READY_FALLBACK_MS);
    return () => {
      clearActiveCardReadyFallbackTimeout();
    };
  }, [
    active,
    activeStackCard,
    activeStackCardKey,
    cardAssetsReady,
    clearActiveCardReadyFallbackTimeout,
    fallbackReadyCardKey,
    imageCache,
    packDiscardAnimationComplete,
    playerState.cardInteractive,
    readyCardKey,
  ]);

  useEffect(() => {
    return () => {
      clearPackDiscardFallbackTimeout();
      clearCardStackDiscardFallbackTimeout();
      clearActiveCardReadyFallbackTimeout();
      onDismissReadyChange?.(false);
    };
  }, [
    clearActiveCardReadyFallbackTimeout,
    clearCardStackDiscardFallbackTimeout,
    clearPackDiscardFallbackTimeout,
    onDismissReadyChange,
  ]);

  useEffect(() => {
    if (!active) {
      playerRef.current?.dispose();
      playerRef.current = null;
      cardImageReadyRef.current = false;
      setHasCommittedBoxVisual(false);
      clearVisuals();
      setPlayerState(createInitialPlayerState(phase, boxLabel));
      return;
    }

    setHasCommittedBoxVisual(false);
    setPlayerState(createInitialPlayerState(phase, boxLabel));
    const player = createPonchoDrifellaRevealPlayer({
      active,
      phase,
      boxLabel,
      cardReady: playerCardReady,
      cardAssetsReady,
      packSequence: activePackSequence,
      imageCache,
      host: {
        clearVisuals,
        commitVisual: (visual) =>
          commitVisual({
            boxImage: visual.boxImage,
            foregroundImage: visual.foregroundImage,
            stageVisible: visual.stageVisible,
          }),
        onStateChange: handlePlayerStateChange,
      },
      onRequestReveal,
      onPlayClick,
      onPlayReveal,
    });
    playerRef.current = player;
    if (cardImageReadyRef.current) {
      player.setCardImageReady(true);
    }

    return () => {
      if (playerRef.current === player) {
        playerRef.current = null;
      }
      cardImageReadyRef.current = false;
      player.dispose();
      clearVisuals();
    };
  }, [
    active,
    activePackSequence,
    boxLabel,
    clearVisuals,
    commitVisual,
    handlePlayerStateChange,
    imageCache,
    imageCacheGeneration,
    resetKey,
  ]);

  useEffect(() => {
    playerRef.current?.update({
      active,
      phase,
      boxLabel,
      cardReady: playerCardReady,
      cardAssetsReady,
      packSequence: activePackSequence,
      imageCache,
      onRequestReveal,
      onPlayClick,
      onPlayReveal,
    });
  }, [active, activePackSequence, boxLabel, cardAssetsReady, imageCache, onPlayClick, onPlayReveal, onRequestReveal, phase, playerCardReady]);

  useEffect(() => {
    onRevealCompleteChange?.(playerState.revealComplete);
  }, [onRevealCompleteChange, playerState.revealComplete]);

  useEffect(() => {
    const boxCanvas = boxCanvasRef.current;
    if (!boxCanvas) return undefined;

    const redraw = () => {
      playerRef.current?.refreshVisuals();
    };

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(redraw);
      observer.observe(boxCanvas);
      return () => {
        observer.disconnect();
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', redraw);
      return () => {
        window.removeEventListener('resize', redraw);
      };
    }

    return undefined;
  }, []);

  const handleCardImageReadyChange = useCallback(
    (cardKey: string, ready: boolean) => {
      if (cardKey !== activeStackCardKey) return;
      if (ready) {
        setReadyCardKey(cardKey);
        clearActiveCardReadyFallbackTimeout();
        setFallbackReadyCardKey((currentKey) => (currentKey === cardKey ? '' : currentKey));
      } else {
        setReadyCardKey((currentKey) => (currentKey === cardKey ? '' : currentKey));
      }
      const wasReady = cardImageReadyRef.current;
      cardImageReadyRef.current = ready;
      if (ready && !wasReady) {
        playerRef.current?.setCardImageReady(true);
      }
    },
    [activeStackCardKey, clearActiveCardReadyFallbackTimeout],
  );

  const handlePackDiscardAnimationEnd = useCallback((evt: AnimationEvent<HTMLElement>) => {
    if (evt.animationName !== 'wip-pack-discard') return;
    if (!playerState.packDiscarded) return;
    completePackDiscardAnimation();
  }, [completePackDiscardAnimation, playerState.packDiscarded]);

  const handleCardStackDiscardAnimationEnd = useCallback((evt: AnimationEvent<HTMLElement>, cardIndex: number) => {
    if (evt.animationName !== 'wip-card-stack-discard-left') return;
    if (discardingCardIndex !== cardIndex) return;
    finishCardStackDiscard(cardIndex);
  }, [discardingCardIndex, finishCardStackDiscard]);

  const handleAdvance = () => {
    if (closing) return;
    if (onBeforeAdvance && !onBeforeAdvance()) return;
    playerRef.current?.handleAdvance();
  };

  const handleOverlayClick = useCallback(() => {
    if (advanceCardStack()) return;
    onDismiss?.();
  }, [advanceCardStack, onDismiss]);

  const handleCardClick = useCallback((evt: SyntheticEvent) => {
    evt.stopPropagation();
    advanceCardStack();
  }, [advanceCardStack]);

  const boxDisabled = closing || playerState.phase !== 'ready' || playerState.revealComplete || playerState.advanceLocked;
  const cardLocked = playerState.packDiscarded && playerState.cardVisible && !playerState.cardInteractive;
  const cardStackEntries = useMemo<PonchoCardStackEntryModel[]>(() => {
    const nextEntries = remainingStackCards
      .map((remainingCard, remainingIndex) => ({
        card: remainingCard,
        index: activeCardIndex + remainingIndex + 1,
        role: 'next' as PonchoCardStackEntryRole,
        depth: remainingIndex + 1,
      }))
      .reverse();
    if (!activeStackCard) return nextEntries;
    return [
      ...nextEntries,
      {
        card: activeStackCard,
        index: activeCardIndex,
        role: discardingCardIndex === activeCardIndex ? 'discarding' : 'active',
        depth: 0,
      },
    ];
  }, [activeCardIndex, activeStackCard, discardingCardIndex, remainingStackCards]);

  return (
    <div
      className={`reveal-overlay wip-overlay reveal-overlay--${playerState.phase}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={handleOverlayClick}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className={`reveal-overlay__shine${playerState.cardVisible ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
        <button
          ref={boxButtonRef}
          type="button"
          className={`reveal-overlay__box${playerState.packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
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
          {!hasCommittedBoxVisual ? (
            <img
              src={activePackSequence.initialFrameUrl}
              alt=""
              className="reveal-overlay__image"
              loading="eager"
              decoding="async"
              draggable={false}
              aria-hidden="true"
            />
          ) : null}
          <canvas ref={boxCanvasRef} className="reveal-overlay__image" aria-hidden="true" />
        </button>
        <div className={`wip-reveal__stage${playerState.stageVisible ? ' wip-reveal__stage--visible' : ''}`} aria-hidden={!playerState.stageVisible}>
          {activeStackCard ? (
            <div
              className={`reveal-overlay__media wip-reveal__media${playerState.cardVisible ? ' wip-reveal__media--visible' : ''}${playerState.cardInteractive ? ' wip-reveal__media--interactive' : ''}${cardLocked ? ' wip-reveal__media--locked' : ''}`}
              aria-hidden={!playerState.cardVisible || !playerState.cardInteractive}
            >
              {cardStackEntries.map((entry) => {
                const cardKey = cardStackKeyForCard(entry.card, entry.index);
                return (
                  <PonchoRevealCardStackEntry
                    key={cardKey}
                    entry={entry}
                    cardKey={cardKey}
                    cardInteractive={playerState.cardInteractive}
                    cardLocked={cardLocked}
                    cardLabel={cardLabel}
                    onCardClick={handleCardClick}
                    onImageReadyChange={handleCardImageReadyChange}
                    onDiscardAnimationEnd={handleCardStackDiscardAnimationEnd}
                  />
                );
              })}
            </div>
          ) : null}
          <div
            className={`wip-reveal__foreground${playerState.packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
            aria-hidden="true"
            onAnimationEnd={handlePackDiscardAnimationEnd}
          >
            <canvas
              ref={foregroundCanvasRef}
              className="reveal-overlay__image wip-reveal__foreground-image"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      <div className="reveal-overlay__note">{playerState.note}</div>
    </div>
  );
}

export default function PonchoInventoryRevealOverlay({
  mode: _mode,
  cards = EMPTY_CARD_STACK,
  cardReady,
  ...overlayProps
}: PonchoInventoryRevealOverlayProps) {
  return <PonchoRevealOverlay {...overlayProps} cards={cards} cardReady={cardReady ?? cards.length > 0} />;
}

export function InteractiveCardPackRevealOverlay(props: InteractiveCardPackRevealOverlayProps) {
  return <PonchoInventoryRevealOverlay {...props} />;
}

export function PonchoCardViewerOverlay({
  overlayStyle,
  active,
  closing,
  card,
  loadingImageSrc,
  onDismiss,
  onTransitionEnd,
}: PonchoCardViewerOverlayProps) {
  const stopOverlayDismiss = (evt: SyntheticEvent) => {
    evt.stopPropagation();
  };

  return (
    <div
      className={`reveal-overlay wip-overlay poncho-card-viewer-overlay reveal-overlay--revealed${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={onDismiss}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className="wip-reveal__stage wip-reveal__stage--visible">
          {card ? (
            <div className="reveal-overlay__media wip-reveal__media wip-reveal__media--visible wip-reveal__media--interactive">
              <div
                className="reveal-overlay__media-item wip-reveal__card-item wip-reveal__card-item--interactive"
                onClick={stopOverlayDismiss}
              >
                <div className="reveal-overlay__media-float">
                  <WipInteractiveCard card={card} interactive loadingImageSrc={loadingImageSrc} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
