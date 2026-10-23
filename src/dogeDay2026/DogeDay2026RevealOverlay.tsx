import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { dogeDay2026CardIdentityKey } from './starterCards';
import {
  areDogeDay2026CardAssetsReady,
  createDogeDay2026RevealPlayer,
  DOGE_DAY_2026_PACK_DISCARD_DELAY_MS,
  DOGE_DAY_2026_PACK_DISCARD_DURATION_MS,
  preloadDogeDay2026CardAssets,
  releaseDogeDay2026CardAssets,
  type DogeDay2026ImageCache,
  type DogeDay2026RevealPhase,
  type DogeDay2026RevealPlayer,
  type DogeDay2026RevealPlayerViewState,
  type DogeDay2026RevealRequestStatus,
  useDogeDay2026CardAssetsReady,
  useDogeDay2026ImageCacheGeneration,
} from './revealPlayer';
import {
  DOGE_DAY_2026_PACK_REVEAL_SEQUENCE,
  type DogeDay2026RevealSequence,
} from './revealSequence';
import { DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT } from './revealLayout';
import {
  createMobileTapCandidate,
  findTouchByIdentifier,
  isMobileBrowser,
  prepareMobileTouchActivation,
  shouldCompleteMobileTapCandidate,
  updateMobileTapCandidateForMove,
  type MobileTapCandidate,
} from '../lib/mobileInteractionGuards';
import { ModalFocusScope } from '../components/ModalFocusScope';
import WipInteractiveCard from '../components/WipInteractiveCard';

type DogeDay2026RevealDismissReadySource = 'card' | 'row';

type DogeDay2026RevealSharedProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  suspended?: boolean;
  modal?: boolean;
  phase: DogeDay2026RevealPhase;
  boxLabel: string;
  boxName: string;
  imageCache: DogeDay2026ImageCache;
  packSequence?: DogeDay2026RevealSequence;
  cardLabel?: string;
  resetKey: string | number;
  onRequestReveal?: () => DogeDay2026RevealRequestStatus | void | Promise<DogeDay2026RevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  onPlayCardSwipe?: () => void;
  onPlayCardSpread?: () => void;
  onBeforeAdvance?: () => boolean;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
  onRevealCompleteChange?: (complete: boolean) => void;
  onDismissReadyChange?: (ready: boolean, source?: DogeDay2026RevealDismissReadySource) => void;
};

type DogeDay2026RevealRuntimeProps = DogeDay2026RevealSharedProps & {
  cards: readonly DrifCardConfig[];
  cardReady: boolean;
  loading?: boolean;
  boxButtonRef?: RefObject<HTMLButtonElement | null>;
};

function createInitialPlayerState(phase: DogeDay2026RevealPhase, boxLabel: string): DogeDay2026RevealPlayerViewState {
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

function samePlayerState(a: DogeDay2026RevealPlayerViewState, b: DogeDay2026RevealPlayerViewState) {
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

function clearDogeDay2026Canvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawDogeDay2026FrameToCanvas(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (!cssWidth || !cssHeight || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return false;
  }

  const rawDpr =
    typeof window === 'undefined' || !Number.isFinite(window.devicePixelRatio) || window.devicePixelRatio <= 0
      ? 1
      : window.devicePixelRatio;
  const maxDprForCanvas = 1080 / Math.max(cssWidth, cssHeight);
  const dpr = Math.min(rawDpr, maxDprForCanvas);
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
  context.imageSmoothingQuality = downscaling ? 'high' : 'medium';
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  return true;
}

function canDrawDogeDay2026FrameToCanvas(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  return Boolean(cssWidth && cssHeight && image.naturalWidth > 0 && image.naturalHeight > 0);
}

function shouldSuspendDogeDay2026CardResidentPreload(stage: DogeDay2026RevealPlayerViewState['stage']) {
  return stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2';
}

const EMPTY_CARD_STACK: readonly DrifCardConfig[] = [];
const DOGE_DAY_2026_REVEAL_CARD_READY_FALLBACK_MS = 600;
const DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_DURATION_MS = 560;
const DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_OUT_DURATION_MS =
  Math.round(DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_DURATION_MS * 0.43);
const DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_IN_DURATION_MS =
  DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_DURATION_MS - DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_OUT_DURATION_MS;
const DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_SETTLE_MS = 120;
const DOGE_DAY_2026_REVEAL_CARD_ROW_DURATION_MS = 560;
const DOGE_DAY_2026_REVEAL_CARD_STACK_DISCARD_FALLBACK_MS = 420;
const DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_FALLBACK_MS =
  DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_DURATION_MS + 80;
const DOGE_DAY_2026_REVEAL_CARD_ROW_FALLBACK_MS =
  DOGE_DAY_2026_REVEAL_CARD_ROW_DURATION_MS + 140;
const DOGE_DAY_2026_REVEAL_PACK_DISCARD_FALLBACK_MS =
  DOGE_DAY_2026_PACK_DISCARD_DELAY_MS + DOGE_DAY_2026_PACK_DISCARD_DURATION_MS + 120;
const DOGE_DAY_2026_REVEAL_PACK_DISCARD_ANIMATION = 'doge-day-2026-wip-pack-discard';
const DOGE_DAY_2026_REVEAL_CARD_DISCARD_ANIMATION = 'doge-day-2026-wip-card-stack-discard-left';
const DOGE_DAY_2026_REVEAL_CARD_CYCLE_OUT_ANIMATION = 'doge-day-2026-wip-card-stack-cycle-out';
const DOGE_DAY_2026_REVEAL_CARD_CYCLE_IN_ANIMATION = 'doge-day-2026-wip-card-stack-cycle-in';
const DOGE_DAY_2026_REVEAL_CARD_ROW_ANIMATION = 'doge-day-2026-wip-card-row-spread';

function cardStackKeyForCard(card: DrifCardConfig, index: number) {
  return `${index}:${dogeDay2026CardIdentityKey(card)}`;
}

function clearWindowTimeoutRef(timeoutRef: { current: number | null }) {
  if (timeoutRef.current === null || typeof window === 'undefined') return;
  window.clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}

type DogeDay2026CardStackEntryRole = 'active' | 'cycling' | 'discarding' | 'next' | 'row';

type DogeDay2026CardStackEntryModel = {
  card: DrifCardConfig;
  index: number;
  role: DogeDay2026CardStackEntryRole;
  depth: number;
  rowSlot?: number;
};

type CardStackViewMode = 'stack' | 'row';

function clampCardStackDepth(depth: number) {
  return Math.min(Math.max(depth, 0), DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT);
}

function clampCardStackRowSlotIndex(rowSlot: number) {
  return Math.min(Math.max(rowSlot, 0), DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT - 1);
}

function cardStackEntryRoleState(entry: DogeDay2026CardStackEntryModel) {
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
  entry: DogeDay2026CardStackEntryModel,
  cardInteractive: boolean,
  cardLocked: boolean,
  rowTransitioning: boolean,
  cycleRestacked: boolean,
  cycleSettled: boolean,
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
    'doge-day-2026-reveal-overlay__media-item',
    'doge-day-2026-wip-reveal__card-item',
    `doge-day-2026-wip-reveal__card-item--stack-depth-${stackDepth}`,
    isNextEntry ? 'doge-day-2026-wip-reveal__card-item--next' : '',
    isCyclingEntry ? 'doge-day-2026-wip-reveal__card-item--cycling' : '',
    isCyclingEntry
      ? `doge-day-2026-wip-reveal__card-item--cycling-${cycleRestacked ? 'in' : 'out'}`
      : '',
    isNextEntry && cycleSettled ? 'doge-day-2026-wip-reveal__card-item--cycle-settled' : '',
    isRowEntry ? `doge-day-2026-wip-reveal__card-item--row doge-day-2026-wip-reveal__card-item--row-slot-${rowSlotIndex}` : '',
    isRowEntry && rowTransitioning ? 'doge-day-2026-wip-reveal__card-item--row-spreading' : '',
    (isActiveEntry || isRowEntry) && cardInteractive ? 'doge-day-2026-wip-reveal__card-item--interactive' : '',
    isActiveEntry && cardLocked ? 'doge-day-2026-wip-reveal__card-item--locked' : '',
  ].filter(Boolean).join(' ');
}

function cardStackEntryInnerClassName(entry: DogeDay2026CardStackEntryModel) {
  const { isDiscardingEntry, isNextEntry } = cardStackEntryRoleState(entry);
  return [
    'doge-day-2026-wip-reveal__card-stack-entry',
    isNextEntry ? 'doge-day-2026-wip-reveal__card-stack-entry--next' : '',
    isDiscardingEntry ? 'doge-day-2026-wip-reveal__card-stack-entry--discarding' : '',
  ].filter(Boolean).join(' ');
}

function buildRowCardStackEntries(
  stackCards: readonly DrifCardConfig[],
  normalizedCardStackOrder: readonly number[],
): DogeDay2026CardStackEntryModel[] {
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
): DogeDay2026CardStackEntryModel[] {
  const visibleStackOrder =
    cyclingCardIndex === null
      ? normalizedCardStackOrder
      : [
          ...normalizedCardStackOrder.filter((cardIndex) => cardIndex !== cyclingCardIndex),
          cyclingCardIndex,
        ];
  const roleForStackPosition = (cardIndex: number, stackDepth: number): DogeDay2026CardStackEntryRole => {
    if (cyclingCardIndex === null) return stackDepth === 0 ? 'active' : 'next';
    return cardIndex === cyclingCardIndex ? 'cycling' : 'next';
  };
  const stackEntries: DogeDay2026CardStackEntryModel[] = [];
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
}): DogeDay2026CardStackEntryModel[] {
  const nextEntries = remainingStackCards
    .map((remainingCard, remainingIndex) => ({
      card: remainingCard,
      index: singleActiveCardIndex + remainingIndex + 1,
      role: 'next' as DogeDay2026CardStackEntryRole,
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

function useDogeDay2026CardStackAssets({
  active,
  activeCardIndex,
  cardVisible,
  imageCache,
  stackCards,
}: {
  active: boolean;
  activeCardIndex: number;
  cardVisible: boolean;
  imageCache: DogeDay2026ImageCache;
  stackCards: readonly DrifCardConfig[];
}) {
  const stackCardsKey = useMemo(() => stackCards.map(cardStackKeyForCard).join('|'), [stackCards]);

  useEffect(() => {
    if (!active || !cardVisible) return;
    const [nextCard, ...laterCards] = stackCards.slice(activeCardIndex + 1);
    if (nextCard) {
      preloadDogeDay2026CardAssets(nextCard, imageCache, {
        mode: 'resident',
        priority: 'high',
      });
    }
    laterCards.forEach((laterCard) => {
      preloadDogeDay2026CardAssets(laterCard, imageCache, {
        mode: 'warm',
        priority: 'low',
      });
    });
  }, [active, activeCardIndex, cardVisible, imageCache, stackCardsKey]);

  useEffect(() => {
    const cardsToRelease = [...stackCards];
    return () => {
      cardsToRelease.forEach((nextCard) => {
        releaseDogeDay2026CardAssets(nextCard, imageCache);
      });
    };
  }, [imageCache, stackCardsKey]);
}

function DogeDay2026RevealCardStackEntry({
  entry,
  cardKey,
  cardInteractive,
  cardLocked,
  cardLabel,
  rowTransitioning,
  cycleRestacked,
  cycleSettled,
  trackImageReady,
  onCardClick,
  onImageReadyChange,
  onMotionAnimationEnd,
}: {
  entry: DogeDay2026CardStackEntryModel;
  cardKey: string;
  cardInteractive: boolean;
  cardLocked: boolean;
  cardLabel: string;
  rowTransitioning: boolean;
  cycleRestacked: boolean;
  cycleSettled: boolean;
  trackImageReady: boolean;
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
      data-card-interaction-surface
      className={cardStackEntryClassName(
        entry,
        cardInteractive,
        cardLocked,
        rowTransitioning,
        cycleRestacked,
        cycleSettled,
      )}
      aria-hidden={!isActiveEntry && !isRowEntry}
      onClick={interactiveEntry ? onCardClick : undefined}
      onAnimationEnd={handleMotionAnimationEnd}
    >
      <div className={cardStackEntryInnerClassName(entry)}>
        <div className="doge-day-2026-reveal-overlay__media-float">
          <WipInteractiveCard
            card={card}
            interactive={interactiveEntry && cardInteractive}
            onImageReadyChange={isActiveEntry && trackImageReady ? handleImageReadyChange : undefined}
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

export function DogeDay2026RevealOverlay({
  overlayStyle,
  active,
  closing,
  suspended = false,
  modal = true,
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
  onPlayCardSwipe,
  onPlayCardSpread,
  onBeforeAdvance,
  onDismiss,
  onTransitionEnd,
  onRevealCompleteChange,
  onDismissReadyChange,
}: DogeDay2026RevealRuntimeProps) {
  const imageCacheGeneration = useDogeDay2026ImageCacheGeneration(imageCache);
  const boxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<DogeDay2026RevealPlayer | null>(null);
  const activePackSequence = packSequence ?? DOGE_DAY_2026_PACK_REVEAL_SEQUENCE;
  const cardImageReadyRef = useRef(false);
  const discardAnimationReportedRef = useRef(false);
  const packDiscardFallbackTimeoutRef = useRef<number | null>(null);
  const cardStackAdvanceLockedRef = useRef(false);
  const cardStackMotionFallbackTimeoutRef = useRef<number | null>(null);
  const cardStackCycleRestackTimeoutRef = useRef<number | null>(null);
  const cardStackCycleSettleTimeoutRef = useRef<number | null>(null);
  const cardStackRowFallbackTimeoutRef = useRef<number | null>(null);
  const activeCardReadyFallbackTimeoutRef = useRef<number | null>(null);
  const stackCards = useMemo(
    () => (
      cards.length > DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT
        ? cards.slice(0, DOGE_DAY_2026_REVEAL_ROW_SLOT_COUNT)
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
  const [cardStackCycleRestacked, setCardStackCycleRestacked] = useState<number | null>(null);
  const [cardStackCycleSettled, setCardStackCycleSettled] = useState<number | null>(null);
  const [cardStackViewMode, setCardStackViewMode] = useState<CardStackViewMode>('stack');
  const [cardStackRowTransitionComplete, setCardStackRowTransitionComplete] = useState(false);
  const [packDiscardAnimationComplete, setPackDiscardAnimationComplete] = useState(false);
  const [readyCardKey, setReadyCardKey] = useState('');
  const [fallbackReadyCardKey, setFallbackReadyCardKey] = useState('');
  const [playerState, setPlayerState] = useState<DogeDay2026RevealPlayerViewState>(() =>
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
  const cardAssetsReady = useDogeDay2026CardAssetsReady({
    active,
    card: activeStackCard,
    imageCache,
    suspendResidentPreload: shouldSuspendDogeDay2026CardResidentPreload(playerState.stage),
    releaseOnCleanup: false,
  });
  const playerCardReady = cardReady && Boolean(activeStackCard);
  const discardingCardIndex = cardStackDiscard;
  const cyclingCardIndex = cardStackCycle;
  const cardStackCycling = cardStackCycle !== null;
  const cardStackRowVisible = stackRevealEnabled && cardStackViewMode === 'row';
  const cardStackRowTransitioning = cardStackRowVisible && !cardStackRowTransitionComplete;
  const cardStackTransitioning = cardStackDiscard !== null || cardStackCycling || cardStackRowTransitioning;
  const cardStackFixedLayerMounted = stackRevealEnabled && Boolean(activeStackCard) && playerState.cardVisible;
  const cardStackFixedLayerReady = cardStackFixedLayerMounted && packDiscardAnimationComplete;
  const cardStackFixedLayerVisible = cardStackFixedLayerReady && !closing;
  const activeCardIsLastRevealedCard = stackCards.length > 0 && activeCardIndex >= stackCards.length - 1;
  const activeStackCardReady = Boolean(
    activeStackCardKey &&
      cardAssetsReady &&
      areDogeDay2026CardAssetsReady(activeStackCard, imageCache) &&
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
  useDogeDay2026CardStackAssets({
    active,
    activeCardIndex,
    cardVisible: playerState.cardVisible,
    imageCache,
    stackCards,
  });
  const clearVisuals = useCallback(() => {
    clearDogeDay2026Canvas(boxCanvasRef.current);
    clearDogeDay2026Canvas(foregroundCanvasRef.current);
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
      if (!canDrawDogeDay2026FrameToCanvas(boxCanvasRef.current, boxImage)) return false;
      if (stageVisible) {
        if (!foregroundImage) return false;
        if (!canDrawDogeDay2026FrameToCanvas(foregroundCanvasRef.current, foregroundImage)) return false;
      }

      const boxDrawn = drawDogeDay2026FrameToCanvas(boxCanvasRef.current, boxImage);
      if (!boxDrawn) return false;
      if (stageVisible) {
        const nextForegroundImage = foregroundImage;
        if (!nextForegroundImage) return false;
        const foregroundDrawn = drawDogeDay2026FrameToCanvas(foregroundCanvasRef.current, nextForegroundImage);
        if (!foregroundDrawn) return false;
      } else {
        clearDogeDay2026Canvas(foregroundCanvasRef.current);
      }
      setHasCommittedBoxVisual(true);
      return true;
    },
    [],
  );

  const handlePlayerStateChange = useCallback((nextState: DogeDay2026RevealPlayerViewState) => {
    setPlayerState((currentState) => (samePlayerState(currentState, nextState) ? currentState : nextState));
  }, []);

  const clearPackDiscardFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(packDiscardFallbackTimeoutRef);
  }, []);

  const clearCardStackMotionFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackMotionFallbackTimeoutRef);
  }, []);

  const clearCardStackCycleRestackTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackCycleRestackTimeoutRef);
  }, []);

  const clearCardStackCycleSettleTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackCycleSettleTimeoutRef);
  }, []);

  const clearCardStackRowFallbackTimeout = useCallback(() => {
    clearWindowTimeoutRef(cardStackRowFallbackTimeoutRef);
  }, []);

  const clearCardStackTransitionState = useCallback(() => {
    clearCardStackMotionFallbackTimeout();
    clearCardStackCycleRestackTimeout();
    clearCardStackCycleSettleTimeout();
    clearCardStackRowFallbackTimeout();
    setCardStackDiscard(null);
    setCardStackCycle(null);
    setCardStackCycleRestacked(null);
    setCardStackCycleSettled(null);
  }, [
    clearCardStackCycleRestackTimeout,
    clearCardStackCycleSettleTimeout,
    clearCardStackMotionFallbackTimeout,
    clearCardStackRowFallbackTimeout,
  ]);

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
      }, DOGE_DAY_2026_REVEAL_CARD_STACK_DISCARD_FALLBACK_MS);
      return true;
    },
    [clearCardStackTransitionState, finishCardStackDiscard],
  );

  const finishCardStackCycle = useCallback(
    (cycledIndex: number) => {
      clearCardStackMotionFallbackTimeout();
      clearCardStackCycleRestackTimeout();
      clearCardStackCycleSettleTimeout();
      cardStackAdvanceLockedRef.current = false;
      setCardStackOrder((currentOrder) => {
        if (currentOrder[0] !== cycledIndex) return currentOrder;
        return [...currentOrder.slice(1), cycledIndex];
      });
      setCardStackCycle((currentCycle) => (currentCycle === cycledIndex ? null : currentCycle));
      setCardStackCycleRestacked((currentCycle) => (currentCycle === cycledIndex ? null : currentCycle));
      setCardStackCycleSettled(cycledIndex);
      if (typeof window !== 'undefined') {
        cardStackCycleSettleTimeoutRef.current = window.setTimeout(() => {
          cardStackCycleSettleTimeoutRef.current = null;
          setCardStackCycleSettled((currentCycle) => (currentCycle === cycledIndex ? null : currentCycle));
        }, DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_SETTLE_MS);
      }
    },
    [
      clearCardStackCycleRestackTimeout,
      clearCardStackCycleSettleTimeout,
      clearCardStackMotionFallbackTimeout,
    ],
  );

  const startCardStackCycleReturn = useCallback(
    (cycledIndex: number) => {
      clearCardStackCycleRestackTimeout();
      setCardStackCycleRestacked((currentCycle) => currentCycle ?? cycledIndex);
    },
    [clearCardStackCycleRestackTimeout],
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
    setCardStackCycleRestacked(null);
    if (typeof window === 'undefined') {
      finishCardStackCycle(cycledIndex);
      return true;
    }
    cardStackCycleRestackTimeoutRef.current = window.setTimeout(() => {
      cardStackCycleRestackTimeoutRef.current = null;
      startCardStackCycleReturn(cycledIndex);
    }, DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_OUT_DURATION_MS);
    cardStackMotionFallbackTimeoutRef.current = window.setTimeout(() => {
      cardStackMotionFallbackTimeoutRef.current = null;
      finishCardStackCycle(cycledIndex);
    }, DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_FALLBACK_MS);
    return true;
  }, [
    activeCardIndex,
    cardStackCanCycle,
    clearCardStackTransitionState,
    finishCardStackCycle,
    startCardStackCycleReturn,
  ]);

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
    }, DOGE_DAY_2026_REVEAL_CARD_ROW_FALLBACK_MS);
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
    clearCardStackCycleRestackTimeout();
    clearCardStackCycleSettleTimeout();
    clearCardStackRowFallbackTimeout();
    clearActiveCardReadyFallbackTimeout();
    setReadyCardKey('');
    setFallbackReadyCardKey('');
    setSingleActiveCardIndex(0);
    setCardStackOrder(initialCardStackOrder);
    setCardStackDiscard(null);
    setCardStackCycle(null);
    setCardStackCycleRestacked(null);
    setCardStackCycleSettled(null);
    setCardStackViewMode('stack');
    setCardStackRowTransitionComplete(false);
    setPackDiscardAnimationComplete(false);
  }, [
    active,
    clearActiveCardReadyFallbackTimeout,
    clearCardStackCycleRestackTimeout,
    clearCardStackCycleSettleTimeout,
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
    }, DOGE_DAY_2026_REVEAL_PACK_DISCARD_FALLBACK_MS);
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
      !areDogeDay2026CardAssetsReady(activeStackCard, imageCache)
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
    }, DOGE_DAY_2026_REVEAL_CARD_READY_FALLBACK_MS);
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
      clearCardStackCycleRestackTimeout();
      clearCardStackCycleSettleTimeout();
      clearCardStackRowFallbackTimeout();
      clearActiveCardReadyFallbackTimeout();
      onDismissReadyChange?.(false);
    };
  }, [
    clearActiveCardReadyFallbackTimeout,
    clearCardStackCycleRestackTimeout,
    clearCardStackCycleSettleTimeout,
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
    const player = createDogeDay2026RevealPlayer({
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
    if (evt.animationName !== DOGE_DAY_2026_REVEAL_PACK_DISCARD_ANIMATION) return;
    if (!playerState.packDiscarded) return;
    completePackDiscardAnimation();
  }, [completePackDiscardAnimation, playerState.packDiscarded]);

  const handleCardStackMotionAnimationEnd = useCallback(
    (evt: AnimationEvent<HTMLElement>, cardIndex: number) => {
      if (evt.animationName === DOGE_DAY_2026_REVEAL_CARD_ROW_ANIMATION) {
        if (cardIndex !== stackCards.length - 1) return;
        completeCardStackRowTransition();
        return;
      }
      if (evt.animationName === DOGE_DAY_2026_REVEAL_CARD_CYCLE_OUT_ANIMATION) {
        if (cyclingCardIndex !== cardIndex) return;
        startCardStackCycleReturn(cardIndex);
        return;
      }
      if (evt.animationName === DOGE_DAY_2026_REVEAL_CARD_CYCLE_IN_ANIMATION) {
        if (cyclingCardIndex !== cardIndex) return;
        finishCardStackCycle(cardIndex);
        return;
      }
      if (evt.animationName !== DOGE_DAY_2026_REVEAL_CARD_DISCARD_ANIMATION) return;
      if (discardingCardIndex !== cardIndex) return;
      finishCardStackDiscard(cardIndex);
    },
    [
      completeCardStackRowTransition,
      cyclingCardIndex,
      discardingCardIndex,
      finishCardStackCycle,
      finishCardStackDiscard,
      startCardStackCycleReturn,
      stackCards.length,
    ],
  );

  const handleAdvance = () => {
    if (closing || suspended) return;
    if (onBeforeAdvance && !onBeforeAdvance()) return;
    playerRef.current?.handleAdvance();
  };

  const handleBoxClick = (evt: SyntheticEvent) => {
    evt.stopPropagation();
    handleAdvance();
  };

  const handleOverlayClick = useCallback(() => {
    if (suspended) return;
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
    suspended,
  ]);

  const activateCardStack = useCallback(() => {
    if (suspended) return;
    if (stackRevealEnabled) {
      if (cardStackRowVisible) return;
      if (cardStackCanCycle && !cardStackAdvanceLockedRef.current) {
        onPlayCardSwipe?.();
      }
      if (startCardStackCycle()) return;
      if (cardStackCanSpreadToRow && !cardStackAdvanceLockedRef.current) {
        onPlayCardSpread?.();
      }
      spreadCardStackToRow();
      return;
    }
    if (advanceCardStack()) return;
  }, [
    advanceCardStack,
    cardStackCanCycle,
    cardStackCanSpreadToRow,
    cardStackRowVisible,
    onPlayCardSpread,
    onPlayCardSwipe,
    spreadCardStackToRow,
    stackRevealEnabled,
    startCardStackCycle,
    suspended,
  ]);

  const handleCardClick = useCallback((evt: SyntheticEvent) => {
    evt.stopPropagation();
    activateCardStack();
  }, [activateCardStack]);

  const boxDisabled =
    closing ||
    suspended ||
    playerState.phase !== 'ready' ||
    playerState.revealComplete ||
    playerState.advanceLocked;
  const cardLocked = playerState.packDiscarded && playerState.cardVisible && !playerState.cardInteractive;
  const cardTapCandidateRef = useRef<MobileTapCandidate | null>(null);
  const mobileTouchStateRef = useRef({
    boxDisabled,
    handleAdvance,
    handleOverlayClick,
    activateCardStack,
  });
  useLayoutEffect(() => {
    mobileTouchStateRef.current = {
      boxDisabled,
      handleAdvance,
      handleOverlayClick,
      activateCardStack,
    };
  });

  useEffect(() => {
    if (!isMobileBrowser()) return undefined;

    const handleDocumentTouchStart = (event: globalThis.TouchEvent) => {
      cardTapCandidateRef.current = null;
      if (!(event.target instanceof Element)) return;
      const overlayElement = event.target.closest('.doge-day-2026-reveal-overlay.doge-day-2026-wip-overlay');
      if (!overlayElement) return;

      const boxElement = event.target.closest('.doge-day-2026-reveal-overlay__box');
      if (boxElement && overlayElement.contains(boxElement)) {
        if (!prepareMobileTouchActivation(event)) return;
        const touchState = mobileTouchStateRef.current;
        if (!touchState.boxDisabled) touchState.handleAdvance();
        return;
      }

      const cardElement = event.target.closest('.doge-day-2026-wip-reveal__card-item--interactive');
      if (cardElement && overlayElement.contains(cardElement)) {
        if (!prepareMobileTouchActivation(event)) return;
        const touch = event.changedTouches.item(0);
        if (!touch || event.touches.length !== 1) return;
        cardTapCandidateRef.current = createMobileTapCandidate(touch);
        return;
      }

      if (!prepareMobileTouchActivation(event)) return;
      mobileTouchStateRef.current.handleOverlayClick();
    };

    const handleDocumentTouchMove = (event: globalThis.TouchEvent) => {
      const candidate = cardTapCandidateRef.current;
      if (!candidate) return;
      const touch = findTouchByIdentifier(event.changedTouches, candidate.identifier);
      cardTapCandidateRef.current = updateMobileTapCandidateForMove(candidate, touch);
    };

    const handleDocumentTouchEnd = (event: globalThis.TouchEvent) => {
      const candidate = cardTapCandidateRef.current;
      if (!candidate) return;
      const touch = findTouchByIdentifier(event.changedTouches, candidate.identifier);
      cardTapCandidateRef.current = null;
      if (!shouldCompleteMobileTapCandidate(candidate, touch)) return;
      mobileTouchStateRef.current.activateCardStack();
    };

    const handleDocumentTouchCancel = (event: globalThis.TouchEvent) => {
      const candidate = cardTapCandidateRef.current;
      if (!candidate) return;
      if (!findTouchByIdentifier(event.changedTouches, candidate.identifier)) return;
      cardTapCandidateRef.current = null;
    };

    document.addEventListener('touchstart', handleDocumentTouchStart, { passive: false });
    document.addEventListener('touchmove', handleDocumentTouchMove, { passive: true });
    document.addEventListener('touchend', handleDocumentTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleDocumentTouchCancel, { passive: true });
    return () => {
      cardTapCandidateRef.current = null;
      document.removeEventListener('touchstart', handleDocumentTouchStart);
      document.removeEventListener('touchmove', handleDocumentTouchMove);
      document.removeEventListener('touchend', handleDocumentTouchEnd);
      document.removeEventListener('touchcancel', handleDocumentTouchCancel);
    };
  }, []);

  const cardStackEntries = useMemo<DogeDay2026CardStackEntryModel[]>(() => {
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
  const renderCardStackEntry = (
    entry: DogeDay2026CardStackEntryModel,
    {
      cardInteractive: entryCardInteractive,
      cardLocked: entryCardLocked,
      trackImageReady,
    }: {
      cardInteractive: boolean;
      cardLocked: boolean;
      trackImageReady: boolean;
    },
  ) => {
    const cardKey = cardStackKeyForCard(entry.card, entry.index);
    return (
      <DogeDay2026RevealCardStackEntry
        key={cardKey}
        entry={entry}
        cardKey={cardKey}
        cardInteractive={entryCardInteractive}
        cardLocked={entryCardLocked}
        cardLabel={cardLabel}
        rowTransitioning={cardStackRowTransitioning}
        cycleRestacked={entry.role === 'cycling' && cardStackCycleRestacked === entry.index}
        cycleSettled={entry.role === 'next' && cardStackCycleSettled === entry.index}
        trackImageReady={trackImageReady}
        onCardClick={handleCardClick}
        onImageReadyChange={handleCardImageReadyChange}
        onMotionAnimationEnd={handleCardStackMotionAnimationEnd}
      />
    );
  };
  const cardStackFixedLayerTracksImages = cardStackFixedLayerReady && !activeStackCardReady;
  const cardStackFixedLayerInteractive = cardStackFixedLayerVisible && playerState.cardInteractive;
  const cardStackFixedLayerLocked = cardStackFixedLayerVisible && cardLocked;
  const cardStackFixedLayerClassName = [
    'doge-day-2026-wip-reveal__stack-layer',
    cardStackFixedLayerVisible ? 'doge-day-2026-wip-reveal__stack-layer--visible' : '',
    cardStackRowVisible ? 'doge-day-2026-wip-reveal__stack-layer--row' : '',
    cardStackFixedLayerInteractive ? 'doge-day-2026-wip-reveal__stack-layer--interactive' : '',
    cardStackFixedLayerLocked ? 'doge-day-2026-wip-reveal__stack-layer--locked' : '',
  ].filter(Boolean).join(' ');
  const overlayStyleWithMotionVars: CSSProperties = {
    ['--doge-day-2026-pack-discard-delay' as never]: `${DOGE_DAY_2026_PACK_DISCARD_DELAY_MS}ms`,
    ['--doge-day-2026-pack-discard-duration' as never]: `${DOGE_DAY_2026_PACK_DISCARD_DURATION_MS}ms`,
    ...(overlayStyle ?? {}),
    ['--doge-day-2026-card-stack-cycle-duration' as never]: `${DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_DURATION_MS}ms`,
    ['--doge-day-2026-card-stack-cycle-out-duration' as never]: `${DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_OUT_DURATION_MS}ms`,
    ['--doge-day-2026-card-stack-cycle-in-duration' as never]: `${DOGE_DAY_2026_REVEAL_CARD_STACK_CYCLE_IN_DURATION_MS}ms`,
    ['--doge-day-2026-card-row-duration' as never]: `${DOGE_DAY_2026_REVEAL_CARD_ROW_DURATION_MS}ms`,
  };

  return (
    <ModalFocusScope
      ariaLabel={`${boxName} unboxing`}
      enabled={modal}
      suspended={closing || suspended}
      focusKey={`${playerState.phase}:${String(boxDisabled)}`}
      className={`doge-day-2026-reveal-overlay doge-day-2026-wip-overlay doge-day-2026-reveal-overlay--${playerState.phase}${active ? ' doge-day-2026-reveal-overlay--active' : ''}${cardStackTransitioning ? ' doge-day-2026-wip-overlay--card-motion' : ''}${closing ? ' doge-day-2026-reveal-overlay--closing' : ''}${suspended ? ' doge-day-2026-reveal-overlay--suspended' : ''}`}
      style={overlayStyleWithMotionVars}
      onClick={handleOverlayClick}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="doge-day-2026-reveal-overlay__backdrop" />
      <div className="doge-day-2026-reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className={`doge-day-2026-reveal-overlay__shine${playerState.cardVisible ? ' doge-day-2026-reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
        <button
          ref={boxButtonRef}
          type="button"
          className={`doge-day-2026-reveal-overlay__box${playerState.packDiscarded ? ' doge-day-2026-wip-reveal__pack-layer--discarded' : ''}`}
          aria-label={`Reveal ${boxName}`}
          aria-busy={loading}
          aria-disabled={boxDisabled}
          disabled={boxDisabled}
          onClick={handleBoxClick}
          onAnimationEnd={handlePackDiscardAnimationEnd}
        >
          {!hasCommittedBoxVisual ? (
            <img
              src={activePackSequence.initialFrameUrl}
              alt=""
              className="doge-day-2026-reveal-overlay__image"
              loading="eager"
              decoding="async"
              draggable={false}
              aria-hidden="true"
            />
          ) : null}
          <canvas ref={boxCanvasRef} className="doge-day-2026-reveal-overlay__image" aria-hidden="true" />
        </button>
        <div className={`doge-day-2026-wip-reveal__stage${playerState.stageVisible ? ' doge-day-2026-wip-reveal__stage--visible' : ''}`} aria-hidden={!playerState.stageVisible}>
          {activeStackCard && !cardStackRowVisible && !cardStackFixedLayerReady ? (
            <div
              className={`doge-day-2026-reveal-overlay__media doge-day-2026-wip-reveal__media${playerState.cardVisible ? ' doge-day-2026-wip-reveal__media--visible' : ''}${playerState.cardInteractive ? ' doge-day-2026-wip-reveal__media--interactive' : ''}${cardLocked ? ' doge-day-2026-wip-reveal__media--locked' : ''}`}
              aria-hidden={!playerState.cardVisible || !playerState.cardInteractive}
            >
              {cardStackEntries.map((entry) =>
                renderCardStackEntry(entry, {
                  cardInteractive: playerState.cardInteractive,
                  cardLocked,
                  trackImageReady: true,
                })
              )}
            </div>
          ) : null}
          <div
            className={`doge-day-2026-wip-reveal__foreground${playerState.packDiscarded ? ' doge-day-2026-wip-reveal__pack-layer--discarded' : ''}`}
            aria-hidden="true"
            onAnimationEnd={handlePackDiscardAnimationEnd}
          >
            <canvas
              ref={foregroundCanvasRef}
              className="doge-day-2026-reveal-overlay__image doge-day-2026-wip-reveal__foreground-image"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
      {cardStackFixedLayerMounted && activeStackCard ? (
        <div
          className={cardStackFixedLayerClassName}
          aria-hidden={!cardStackFixedLayerInteractive}
        >
          {cardStackEntries.map((entry) =>
            renderCardStackEntry(entry, {
              cardInteractive: cardStackFixedLayerInteractive,
              cardLocked: cardStackFixedLayerLocked,
              trackImageReady: cardStackFixedLayerTracksImages,
            })
          )}
        </div>
      ) : null}
    </ModalFocusScope>
  );
}
