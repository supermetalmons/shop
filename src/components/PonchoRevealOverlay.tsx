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
import { drifCardIdentityKey, type DrifCardConfig } from '../drifCards';
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
import { PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT } from '../lib/revealOverlayLayout';
import WipInteractiveCard from './WipInteractiveCard';

export type PonchoRevealDismissReadySource = 'card' | 'row';

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
  onDismissReadyChange?: (ready: boolean, source?: PonchoRevealDismissReadySource) => void;
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
const PONCHO_REVEAL_CARD_STACK_CYCLE_DURATION_MS = 560;
const PONCHO_REVEAL_CARD_ROW_DURATION_MS = 560;
const PONCHO_REVEAL_CARD_STACK_DISCARD_FALLBACK_MS = 420;
const PONCHO_REVEAL_CARD_STACK_CYCLE_FALLBACK_MS =
  PONCHO_REVEAL_CARD_STACK_CYCLE_DURATION_MS + 80;
const PONCHO_REVEAL_CARD_ROW_FALLBACK_MS =
  PONCHO_REVEAL_CARD_ROW_DURATION_MS + 140;
const PONCHO_REVEAL_PACK_DISCARD_FALLBACK_MS =
  PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS + PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS + 120;
const PONCHO_REVEAL_PACK_DISCARD_ANIMATION = 'wip-pack-discard';
const PONCHO_REVEAL_CARD_DISCARD_ANIMATION = 'wip-card-stack-discard-left';
const PONCHO_REVEAL_CARD_CYCLE_ANIMATION = 'wip-card-stack-cycle-to-bottom';
const PONCHO_REVEAL_CARD_ROW_ANIMATION = 'wip-card-row-spread';

function cardStackKeyForCard(card: DrifCardConfig, index: number) {
  return `${index}:${drifCardIdentityKey(card)}`;
}

function clearWindowTimeoutRef(timeoutRef: { current: number | null }) {
  if (timeoutRef.current === null || typeof window === 'undefined') return;
  window.clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}

type PonchoCardStackEntryRole = 'active' | 'cycling' | 'discarding' | 'next' | 'row';

type PonchoCardStackEntryModel = {
  card: DrifCardConfig;
  index: number;
  role: PonchoCardStackEntryRole;
  depth: number;
  rowSlot?: number;
};

type CardStackViewMode = 'stack' | 'row';

function clampCardStackDepth(depth: number) {
  return Math.min(Math.max(depth, 0), PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT);
}

function clampCardStackRowSlotIndex(rowSlot: number) {
  return Math.min(Math.max(rowSlot, 0), PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT - 1);
}

function cardStackEntryRoleState(entry: PonchoCardStackEntryModel) {
  const isActiveEntry = entry.role === 'active';
  const isCyclingEntry = entry.role === 'cycling';
  const isDiscardingEntry = entry.role === 'discarding';
  const isNextEntry = entry.role === 'next';
  const isRowEntry = entry.role === 'row';
  return {
    isActiveEntry,
    isCyclingEntry,
    isDiscardingEntry,
    isNextEntry,
    isRowEntry,
    interactiveEntry: isActiveEntry || isCyclingEntry || isDiscardingEntry || isRowEntry,
    rowSlotIndex: isRowEntry ? clampCardStackRowSlotIndex(entry.rowSlot ?? entry.index) : 0,
    stackDepth: isNextEntry || isCyclingEntry || isRowEntry ? clampCardStackDepth(entry.depth) : 0,
  };
}

function cardStackEntryClassName(
  entry: PonchoCardStackEntryModel,
  cardInteractive: boolean,
  cardLocked: boolean,
  rowTransitioning: boolean,
) {
  const {
    isActiveEntry,
    isCyclingEntry,
    isNextEntry,
    isRowEntry,
    rowSlotIndex,
    stackDepth,
  } = cardStackEntryRoleState(entry);
  return [
    'reveal-overlay__media-item',
    'wip-reveal__card-item',
    `wip-reveal__card-item--stack-depth-${stackDepth}`,
    isNextEntry ? 'wip-reveal__card-item--next' : '',
    isCyclingEntry ? 'wip-reveal__card-item--cycling' : '',
    isRowEntry ? `wip-reveal__card-item--row wip-reveal__card-item--row-slot-${rowSlotIndex}` : '',
    isRowEntry && rowTransitioning ? 'wip-reveal__card-item--row-spreading' : '',
    (isActiveEntry || isRowEntry) && cardInteractive ? 'wip-reveal__card-item--interactive' : '',
    isActiveEntry && cardLocked ? 'wip-reveal__card-item--locked' : '',
  ].filter(Boolean).join(' ');
}

function cardStackEntryInnerClassName(entry: PonchoCardStackEntryModel) {
  const { isDiscardingEntry, isNextEntry } = cardStackEntryRoleState(entry);
  return [
    'wip-reveal__card-stack-entry',
    isNextEntry ? 'wip-reveal__card-stack-entry--next' : '',
    isDiscardingEntry ? 'wip-reveal__card-stack-entry--discarding' : '',
  ].filter(Boolean).join(' ');
}

function buildRowCardStackEntries(
  stackCards: readonly DrifCardConfig[],
  normalizedCardStackOrder: readonly number[],
): PonchoCardStackEntryModel[] {
  const rowStartDepthByCardIndex = new Map(
    normalizedCardStackOrder.map((cardIndex, stackDepth) => [cardIndex, stackDepth]),
  );
  return stackCards.map((card, index) => ({
    card,
    index,
    role: 'row',
    depth: rowStartDepthByCardIndex.get(index) ?? normalizedCardStackOrder.indexOf(index),
    rowSlot: index,
  }));
}

function buildCyclingCardStackEntries(
  stackCards: readonly DrifCardConfig[],
  normalizedCardStackOrder: readonly number[],
  cyclingCardIndex: number | null,
): PonchoCardStackEntryModel[] {
  const visibleStackOrder =
    cyclingCardIndex === null
      ? normalizedCardStackOrder
      : [
          ...normalizedCardStackOrder.filter((cardIndex) => cardIndex !== cyclingCardIndex),
          cyclingCardIndex,
        ];
  const roleForStackPosition = (cardIndex: number, stackDepth: number): PonchoCardStackEntryRole => {
    if (cyclingCardIndex === null) return stackDepth === 0 ? 'active' : 'next';
    return cardIndex === cyclingCardIndex ? 'cycling' : 'next';
  };
  const stackEntries: PonchoCardStackEntryModel[] = [];
  visibleStackOrder.forEach((cardIndex, stackDepth) => {
    const card = stackCards[cardIndex];
    if (!card) return;
    stackEntries.push({
      card,
      index: cardIndex,
      role: roleForStackPosition(cardIndex, stackDepth),
      depth: stackDepth,
    });
  });
  return stackEntries.reverse();
}

function buildSingleCardStackEntries({
  activeStackCard,
  cardStackTransitioning,
  discardingCardIndex,
  remainingStackCards,
  singleActiveCardIndex,
}: {
  activeStackCard?: DrifCardConfig;
  cardStackTransitioning: boolean;
  discardingCardIndex: number | null;
  remainingStackCards: readonly DrifCardConfig[];
  singleActiveCardIndex: number;
}): PonchoCardStackEntryModel[] {
  const nextEntries = remainingStackCards
    .map((remainingCard, remainingIndex) => ({
      card: remainingCard,
      index: singleActiveCardIndex + remainingIndex + 1,
      role: 'next' as PonchoCardStackEntryRole,
      depth: remainingIndex + 1,
    }))
    .reverse();
  if (!activeStackCard) return cardStackTransitioning ? nextEntries : [];
  return [
    ...(cardStackTransitioning ? nextEntries : []),
    {
      card: activeStackCard,
      index: singleActiveCardIndex,
      role: discardingCardIndex === singleActiveCardIndex ? 'discarding' : 'active',
      depth: 0,
    },
  ];
}

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
  rowTransitioning,
  onCardClick,
  onImageReadyChange,
  onMotionAnimationEnd,
}: {
  entry: PonchoCardStackEntryModel;
  cardKey: string;
  cardInteractive: boolean;
  cardLocked: boolean;
  cardLabel: string;
  rowTransitioning: boolean;
  onCardClick: (evt: SyntheticEvent) => void;
  onImageReadyChange: (cardKey: string, ready: boolean) => void;
  onMotionAnimationEnd: (evt: AnimationEvent<HTMLElement>, cardIndex: number) => void;
}) {
  const { card, index } = entry;
  const {
    isActiveEntry,
    isCyclingEntry,
    isDiscardingEntry,
    isRowEntry,
    interactiveEntry,
  } = cardStackEntryRoleState(entry);
  const handleImageReadyChange = useCallback(
    (ready: boolean) => {
      onImageReadyChange(cardKey, ready);
    },
    [cardKey, onImageReadyChange],
  );
  const handleMotionAnimationEnd = useCallback(
    (evt: AnimationEvent<HTMLElement>) => {
      onMotionAnimationEnd(evt, index);
    },
    [index, onMotionAnimationEnd],
  );

  return (
    <div
      className={cardStackEntryClassName(entry, cardInteractive, cardLocked, rowTransitioning)}
      aria-hidden={!isActiveEntry && !isRowEntry}
      onClick={interactiveEntry ? onCardClick : undefined}
      onAnimationEnd={handleMotionAnimationEnd}
    >
      <div className={cardStackEntryInnerClassName(entry)}>
        <div className="reveal-overlay__media-float">
          <WipInteractiveCard
            card={card}
            interactive={interactiveEntry && cardInteractive}
            onImageReadyChange={isActiveEntry ? handleImageReadyChange : undefined}
            wakeOnInteractiveUnlock={false}
            interactionMode={isCyclingEntry || isDiscardingEntry ? 'settling' : 'normal'}
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
  const cardStackMotionFallbackTimeoutRef = useRef<number | null>(null);
  const cardStackRowFallbackTimeoutRef = useRef<number | null>(null);
  const activeCardReadyFallbackTimeoutRef = useRef<number | null>(null);
  const stackCards = useMemo(
    () => (
      cards.length > PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT
        ? cards.slice(0, PONCHO_DRIFELLA_REVEAL_ROW_SLOT_COUNT)
        : cards
    ),
    [cards],
  );
  const stackCardsKey = useMemo(() => stackCards.map(cardStackKeyForCard).join('|'), [stackCards]);
  const initialCardStackOrder = useMemo(() => stackCards.map((_card, index) => index), [stackCardsKey]);
  const [hasCommittedBoxVisual, setHasCommittedBoxVisual] = useState(false);
  const [singleActiveCardIndex, setSingleActiveCardIndex] = useState(0);
  const [cardStackOrder, setCardStackOrder] = useState<number[]>(() => initialCardStackOrder);
  const [cardStackDiscard, setCardStackDiscard] = useState<number | null>(null);
  const [cardStackCycle, setCardStackCycle] = useState<number | null>(null);
  const [cardStackViewMode, setCardStackViewMode] = useState<CardStackViewMode>('stack');
  const [cardStackRowTransitionComplete, setCardStackRowTransitionComplete] = useState(false);
  const [packDiscardAnimationComplete, setPackDiscardAnimationComplete] = useState(false);
  const [readyCardKey, setReadyCardKey] = useState('');
  const [fallbackReadyCardKey, setFallbackReadyCardKey] = useState('');
  const [playerState, setPlayerState] = useState<PonchoDrifellaRevealPlayerViewState>(() =>
    createInitialPlayerState(phase, boxLabel),
  );
  const stackRevealEnabled = stackCards.length > 1;
  const normalizedCardStackOrder = useMemo(() => {
    const orderedIndexes = cardStackOrder.filter((index) => index >= 0 && index < stackCards.length);
    if (orderedIndexes.length !== stackCards.length) return initialCardStackOrder;
    return orderedIndexes;
  }, [cardStackOrder, initialCardStackOrder, stackCards.length]);
  const activeCardIndex = stackRevealEnabled
    ? (normalizedCardStackOrder[0] ?? 0)
    : singleActiveCardIndex;
  const activeStackCard = stackCards[activeCardIndex];
  const activeStackCardKey = activeStackCard ? cardStackKeyForCard(activeStackCard, activeCardIndex) : '';
  const nextStackCard = stackRevealEnabled
    ? stackCards[normalizedCardStackOrder[1] ?? -1]
    : stackCards[singleActiveCardIndex + 1];
  const remainingStackCards = useMemo(
    () => stackCards.slice(singleActiveCardIndex + 1),
    [singleActiveCardIndex, stackCards],
  );
  const cardAssetsReady = usePonchoDrifellaCardAssetsReady({
    active,
    card: activeStackCard,
    imageCache,
    suspendResidentPreload: shouldSuspendPonchoCardResidentPreload(playerState.stage),
    releaseOnCleanup: false,
  });
  const playerCardReady = cardReady && Boolean(activeStackCard);
  const discardingCardIndex = cardStackDiscard;
  const cyclingCardIndex = cardStackCycle;
  const cardStackCycling = cardStackCycle !== null;
  const cardStackRowVisible = stackRevealEnabled && cardStackViewMode === 'row';
  const cardStackRowTransitioning = cardStackRowVisible && !cardStackRowTransitionComplete;
  const cardStackTransitioning = cardStackDiscard !== null || cardStackCycling || cardStackRowTransitioning;
  const activeCardIsLastRevealedCard = stackCards.length > 0 && activeCardIndex >= stackCards.length - 1;
  const activeStackCardReady = Boolean(
    activeStackCardKey &&
      cardAssetsReady &&
      arePonchoDrifellaCardAssetsReady(activeStackCard, imageCache) &&
      (readyCardKey === activeStackCardKey || fallbackReadyCardKey === activeStackCardKey),
  );
  const cardStackReadyForAction =
    playerState.cardInteractive &&
    activeStackCardReady &&
    packDiscardAnimationComplete &&
    !cardStackTransitioning &&
    !closing;
  const finalCardReadyForDismiss =
    playerState.cardInteractive &&
    activeStackCardReady &&
    packDiscardAnimationComplete &&
    activeCardIsLastRevealedCard;
  const cardStackCanAdvance =
    !stackRevealEnabled &&
    cardStackReadyForAction &&
    Boolean(nextStackCard) &&
    !activeCardIsLastRevealedCard;
  const cardStackCanCycle =
    stackRevealEnabled &&
    cardStackViewMode === 'stack' &&
    cardStackReadyForAction &&
    Boolean(nextStackCard) &&
    !activeCardIsLastRevealedCard;
  const cardStackCanSpreadToRow =
    stackRevealEnabled &&
    cardStackViewMode === 'stack' &&
    cardStackReadyForAction &&
    activeCardIsLastRevealedCard;
  const cardStackDismissReady = stackRevealEnabled
    ? Boolean(cardStackRowVisible && cardStackRowTransitionComplete && !closing)
    : Boolean(finalCardReadyForDismiss && !cardStackTransitioning);
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

  const clearCardStackMotionFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackMotionFallbackTimeoutRef);
  }, []);

  const clearCardStackRowFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackRowFallbackTimeoutRef);
  }, []);

  const clearCardStackTransitionState = useCallback(() => {
    clearCardStackMotionFallbackTimeout();
    clearCardStackRowFallbackTimeout();
    setCardStackDiscard(null);
    setCardStackCycle(null);
  }, [clearCardStackMotionFallbackTimeout, clearCardStackRowFallbackTimeout]);

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
      clearCardStackMotionFallbackTimeout();
      cardStackAdvanceLockedRef.current = false;
      setSingleActiveCardIndex((currentIndex) => Math.max(currentIndex, discardedIndex + 1));
      setCardStackDiscard((currentDiscard) => (currentDiscard === discardedIndex ? null : currentDiscard));
    },
    [clearCardStackMotionFallbackTimeout],
  );

  const startCardStackDiscard = useCallback(
    (discardedIndex: number) => {
      if (cardStackAdvanceLockedRef.current) return true;
      cardStackAdvanceLockedRef.current = true;
      clearCardStackTransitionState();
      setCardStackViewMode('stack');
      setCardStackRowTransitionComplete(false);
      setCardStackDiscard(discardedIndex);
      if (typeof window === 'undefined') {
        finishCardStackDiscard(discardedIndex);
        return true;
      }
      cardStackMotionFallbackTimeoutRef.current = window.setTimeout(() => {
        cardStackMotionFallbackTimeoutRef.current = null;
        finishCardStackDiscard(discardedIndex);
      }, PONCHO_REVEAL_CARD_STACK_DISCARD_FALLBACK_MS);
      return true;
    },
    [clearCardStackTransitionState, finishCardStackDiscard],
  );

  const finishCardStackCycle = useCallback(
    (cycledIndex: number) => {
      clearCardStackMotionFallbackTimeout();
      cardStackAdvanceLockedRef.current = false;
      setCardStackOrder((currentOrder) => {
        if (currentOrder[0] !== cycledIndex) return currentOrder;
        return [...currentOrder.slice(1), cycledIndex];
      });
      setCardStackCycle((currentCycle) => (currentCycle === cycledIndex ? null : currentCycle));
    },
    [clearCardStackMotionFallbackTimeout],
  );

  const startCardStackCycle = useCallback(() => {
    if (!cardStackCanCycle) return false;
    if (cardStackAdvanceLockedRef.current) return true;
    const cycledIndex = activeCardIndex;
    cardStackAdvanceLockedRef.current = true;
    clearCardStackTransitionState();
    setCardStackViewMode('stack');
    setCardStackRowTransitionComplete(false);
    setCardStackCycle(cycledIndex);
    if (typeof window === 'undefined') {
      finishCardStackCycle(cycledIndex);
      return true;
    }
    cardStackMotionFallbackTimeoutRef.current = window.setTimeout(() => {
      cardStackMotionFallbackTimeoutRef.current = null;
      finishCardStackCycle(cycledIndex);
    }, PONCHO_REVEAL_CARD_STACK_CYCLE_FALLBACK_MS);
    return true;
  }, [activeCardIndex, cardStackCanCycle, clearCardStackTransitionState, finishCardStackCycle]);

  const completeCardStackRowTransition = useCallback(() => {
    if (!stackRevealEnabled) return;
    clearCardStackRowFallbackTimeout();
    cardStackAdvanceLockedRef.current = false;
    setCardStackRowTransitionComplete(true);
  }, [clearCardStackRowFallbackTimeout, stackRevealEnabled]);

  const spreadCardStackToRow = useCallback(() => {
    if (!cardStackCanSpreadToRow) return false;
    if (cardStackAdvanceLockedRef.current) return true;
    cardStackAdvanceLockedRef.current = true;
    clearCardStackTransitionState();
    setCardStackViewMode('row');
    setCardStackRowTransitionComplete(false);
    if (typeof window === 'undefined') {
      completeCardStackRowTransition();
      return true;
    }
    cardStackRowFallbackTimeoutRef.current = window.setTimeout(() => {
      cardStackRowFallbackTimeoutRef.current = null;
      completeCardStackRowTransition();
    }, PONCHO_REVEAL_CARD_ROW_FALLBACK_MS);
    return true;
  }, [
    cardStackCanSpreadToRow,
    clearCardStackTransitionState,
    completeCardStackRowTransition,
  ]);

  const advanceCardStack = useCallback(() => {
    if (!cardStackCanAdvance) return false;
    return startCardStackDiscard(activeCardIndex);
  }, [activeCardIndex, cardStackCanAdvance, startCardStackDiscard]);

  useEffect(() => {
    cardImageReadyRef.current = false;
    cardStackAdvanceLockedRef.current = false;
    discardAnimationReportedRef.current = false;
    clearPackDiscardFallbackTimeout();
    clearCardStackMotionFallbackTimeout();
    clearCardStackRowFallbackTimeout();
    clearActiveCardReadyFallbackTimeout();
    setReadyCardKey('');
    setFallbackReadyCardKey('');
    setSingleActiveCardIndex(0);
    setCardStackOrder(initialCardStackOrder);
    setCardStackDiscard(null);
    setCardStackCycle(null);
    setCardStackViewMode('stack');
    setCardStackRowTransitionComplete(false);
    setPackDiscardAnimationComplete(false);
  }, [
    active,
    clearActiveCardReadyFallbackTimeout,
    clearCardStackMotionFallbackTimeout,
    clearCardStackRowFallbackTimeout,
    clearPackDiscardFallbackTimeout,
    initialCardStackOrder,
    resetKey,
    stackCardsKey,
  ]);

  useEffect(() => {
    onDismissReadyChange?.(
      cardStackDismissReady,
      cardStackDismissReady ? (stackRevealEnabled ? 'row' : 'card') : undefined,
    );
  }, [cardStackDismissReady, onDismissReadyChange, stackRevealEnabled]);

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
      clearCardStackMotionFallbackTimeout();
      clearCardStackRowFallbackTimeout();
      clearActiveCardReadyFallbackTimeout();
      onDismissReadyChange?.(false);
    };
  }, [
    clearActiveCardReadyFallbackTimeout,
    clearCardStackMotionFallbackTimeout,
    clearCardStackRowFallbackTimeout,
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
    if (evt.animationName !== PONCHO_REVEAL_PACK_DISCARD_ANIMATION) return;
    if (!playerState.packDiscarded) return;
    completePackDiscardAnimation();
  }, [completePackDiscardAnimation, playerState.packDiscarded]);

  const handleCardStackMotionAnimationEnd = useCallback(
    (evt: AnimationEvent<HTMLElement>, cardIndex: number) => {
      if (evt.animationName === PONCHO_REVEAL_CARD_ROW_ANIMATION) {
        if (cardIndex !== stackCards.length - 1) return;
        completeCardStackRowTransition();
        return;
      }
      if (evt.animationName === PONCHO_REVEAL_CARD_CYCLE_ANIMATION) {
        if (cyclingCardIndex !== cardIndex) return;
        finishCardStackCycle(cardIndex);
        return;
      }
      if (evt.animationName !== PONCHO_REVEAL_CARD_DISCARD_ANIMATION) return;
      if (discardingCardIndex !== cardIndex) return;
      finishCardStackDiscard(cardIndex);
    },
    [
      completeCardStackRowTransition,
      cyclingCardIndex,
      discardingCardIndex,
      finishCardStackCycle,
      finishCardStackDiscard,
      stackCards.length,
    ],
  );

  const handleAdvance = () => {
    if (closing) return;
    if (onBeforeAdvance && !onBeforeAdvance()) return;
    playerRef.current?.handleAdvance();
  };

  const handleOverlayClick = useCallback(() => {
    if (stackRevealEnabled) {
      if (cardStackRowVisible && cardStackRowTransitionComplete) {
        onDismiss?.();
      }
      return;
    }
    if (advanceCardStack()) return;
    onDismiss?.();
  }, [
    advanceCardStack,
    cardStackRowTransitionComplete,
    cardStackRowVisible,
    onDismiss,
    stackRevealEnabled,
  ]);

  const handleCardClick = useCallback((evt: SyntheticEvent) => {
    evt.stopPropagation();
    if (stackRevealEnabled) {
      if (cardStackRowVisible) return;
      if (startCardStackCycle()) return;
      spreadCardStackToRow();
      return;
    }
    if (advanceCardStack()) return;
  }, [
    advanceCardStack,
    cardStackRowVisible,
    spreadCardStackToRow,
    stackRevealEnabled,
    startCardStackCycle,
  ]);

  const boxDisabled = closing || playerState.phase !== 'ready' || playerState.revealComplete || playerState.advanceLocked;
  const cardLocked = playerState.packDiscarded && playerState.cardVisible && !playerState.cardInteractive;
  const cardStackEntries = useMemo<PonchoCardStackEntryModel[]>(() => {
    if (stackRevealEnabled) {
      if (cardStackViewMode === 'row') {
        return buildRowCardStackEntries(stackCards, normalizedCardStackOrder);
      }
      return buildCyclingCardStackEntries(stackCards, normalizedCardStackOrder, cyclingCardIndex);
    }
    return buildSingleCardStackEntries({
      activeStackCard,
      cardStackTransitioning,
      discardingCardIndex,
      remainingStackCards,
      singleActiveCardIndex,
    });
  }, [
    activeStackCard,
    cardStackTransitioning,
    cardStackViewMode,
    cyclingCardIndex,
    discardingCardIndex,
    normalizedCardStackOrder,
    remainingStackCards,
    singleActiveCardIndex,
    stackCards,
    stackRevealEnabled,
  ]);
  const renderCardStackEntry = (entry: PonchoCardStackEntryModel) => {
    const cardKey = cardStackKeyForCard(entry.card, entry.index);
    return (
      <PonchoRevealCardStackEntry
        key={cardKey}
        entry={entry}
        cardKey={cardKey}
        cardInteractive={playerState.cardInteractive}
        cardLocked={cardLocked}
        cardLabel={cardLabel}
        rowTransitioning={cardStackRowTransitioning}
        onCardClick={handleCardClick}
        onImageReadyChange={handleCardImageReadyChange}
        onMotionAnimationEnd={handleCardStackMotionAnimationEnd}
      />
    );
  };
  const overlayStyleWithMotionVars: CSSProperties = {
    ['--poncho-pack-discard-delay' as never]: `${PONCHO_DRIFELLA_PACK_DISCARD_DELAY_MS}ms`,
    ['--poncho-pack-discard-duration' as never]: `${PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS}ms`,
    ...(overlayStyle ?? {}),
    ['--poncho-card-stack-cycle-duration' as never]: `${PONCHO_REVEAL_CARD_STACK_CYCLE_DURATION_MS}ms`,
    ['--poncho-card-row-duration' as never]: `${PONCHO_REVEAL_CARD_ROW_DURATION_MS}ms`,
  };

  return (
    <div
      className={`reveal-overlay wip-overlay reveal-overlay--${playerState.phase}${active ? ' reveal-overlay--active' : ''}${cardStackTransitioning ? ' wip-overlay--card-motion' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyleWithMotionVars}
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
          {activeStackCard && !cardStackRowVisible ? (
            <div
              className={`reveal-overlay__media wip-reveal__media${playerState.cardVisible ? ' wip-reveal__media--visible' : ''}${playerState.cardInteractive ? ' wip-reveal__media--interactive' : ''}${cardLocked ? ' wip-reveal__media--locked' : ''}`}
              aria-hidden={!playerState.cardVisible || !playerState.cardInteractive}
            >
              {cardStackEntries.map(renderCardStackEntry)}
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
      {cardStackRowVisible && activeStackCard ? (
        <div
          className={`wip-reveal__row-layer${playerState.cardVisible ? ' wip-reveal__row-layer--visible' : ''}${playerState.cardInteractive ? ' wip-reveal__row-layer--interactive' : ''}`}
          aria-hidden={!playerState.cardVisible || !playerState.cardInteractive}
        >
          {cardStackEntries.map(renderCardStackEntry)}
        </div>
      ) : null}
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
      onClick={() => onDismiss?.()}
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
