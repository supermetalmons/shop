import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type SyntheticEvent,
  type TransitionEvent,
} from 'react';
import type { DrifCardConfig } from '../drifCards';
import {
  getPonchoDrifellaCardByFigureId,
  type PonchoDrifellaRevealPhase,
} from '../lib/ponchoDrifellaReveal';
import WipInteractiveCard from './WipInteractiveCard';

export type PonchoInventoryRevealOverlayProps = {
  mode: 'inventory-unbox';
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  phase: PonchoDrifellaRevealPhase;
  revealedIds?: number[];
  loading: boolean;
  note: string;
  boxName: string;
  boxFrameSrc?: string;
  foregroundFrameSrc?: string;
  cardVisible: boolean;
  cardInteractive: boolean;
  boxDisabled: boolean;
  onAdvance: () => void;
  onDismiss: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
  onPackDiscardEnd?: () => void;
};

type PonchoRevealOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  stage: PonchoDrifellaRevealPhase;
  note: string;
  boxName: string;
  boxFrameSrc?: string;
  foregroundFrameSrc?: string;
  card?: DrifCardConfig;
  cardVisible?: boolean;
  cardInteractive?: boolean;
  boxBusy?: boolean;
  boxDisabled?: boolean;
  onAdvance: () => void;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
  onPackDiscardEnd?: () => void;
};

export function PonchoRevealOverlay({
  overlayStyle,
  active,
  closing,
  stage,
  note,
  boxName,
  boxFrameSrc,
  foregroundFrameSrc,
  card,
  cardVisible = false,
  cardInteractive = false,
  boxBusy = false,
  boxDisabled = false,
  onAdvance,
  onDismiss,
  onTransitionEnd,
  onPackDiscardEnd,
}: PonchoRevealOverlayProps) {
  const foregroundImageRef = useRef<HTMLImageElement | null>(null);
  const discardAnimationReportedRef = useRef(false);
  const [foregroundPrepared, setForegroundPrepared] = useState(false);
  const desiredForegroundVisible = Boolean(foregroundFrameSrc) && cardVisible;
  const foregroundCoverReady = Boolean(foregroundFrameSrc) && foregroundPrepared;
  const resolvedCardVisible = Boolean(card) && cardVisible && foregroundCoverReady;
  const packDiscarded = stage === 'revealed';
  const cardLocked = packDiscarded && resolvedCardVisible && !cardInteractive;
  const stopOverlayDismiss = (evt: SyntheticEvent) => {
    evt.stopPropagation();
  };

  useEffect(() => {
    if (!active || !foregroundFrameSrc) {
      setForegroundPrepared(false);
      return;
    }
    if (foregroundPrepared) {
      return;
    }
    const foregroundImage = foregroundImageRef.current;
    if (foregroundImage?.complete && foregroundImage.naturalWidth > 0) {
      setForegroundPrepared(true);
    }
  }, [active, foregroundFrameSrc, foregroundPrepared]);

  useEffect(() => {
    if (active && packDiscarded) return;
    discardAnimationReportedRef.current = false;
  }, [active, packDiscarded]);

  const handlePackDiscardAnimationEnd = (evt: AnimationEvent<HTMLElement>) => {
    if (evt.animationName !== 'wip-pack-discard') return;
    if (!packDiscarded) return;
    if (discardAnimationReportedRef.current) return;
    discardAnimationReportedRef.current = true;
    onPackDiscardEnd?.();
  };

  return (
    <div
      className={`reveal-overlay wip-overlay reveal-overlay--${stage}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}`}
      role="presentation"
      style={overlayStyle}
      onClick={onDismiss}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
        <div className={`reveal-overlay__shine${resolvedCardVisible ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
        <button
          type="button"
          className={`reveal-overlay__box${packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
          aria-label={`Reveal ${boxName}`}
          aria-busy={boxBusy}
          aria-disabled={boxDisabled}
          disabled={boxDisabled}
          onClick={(evt) => {
            evt.stopPropagation();
            if (boxDisabled) return;
            onAdvance();
          }}
          onAnimationEnd={handlePackDiscardAnimationEnd}
        >
          {boxFrameSrc ? (
            <img src={boxFrameSrc} alt={boxName} className="reveal-overlay__image" draggable={false} />
          ) : (
            <div className="reveal-overlay__image reveal-overlay__image--placeholder" aria-hidden="true" />
          )}
        </button>
        {card ? (
          <div
            className={`reveal-overlay__media wip-reveal__media${resolvedCardVisible ? ' reveal-overlay__media--visible' : ''}${cardInteractive ? ' wip-reveal__media--interactive' : ''}${cardLocked ? ' wip-reveal__media--locked' : ''}`}
            aria-hidden={!resolvedCardVisible || !cardInteractive}
          >
            <div
              className={`reveal-overlay__media-item wip-reveal__card-item${cardInteractive ? ' wip-reveal__card-item--interactive' : ''}${cardLocked ? ' wip-reveal__card-item--locked' : ''}`}
              onClick={cardInteractive || cardLocked ? stopOverlayDismiss : undefined}
            >
              <div className="reveal-overlay__media-float">
                <WipInteractiveCard card={card} interactive={cardInteractive} />
              </div>
            </div>
          </div>
        ) : null}
        {foregroundFrameSrc ? (
          <div
            className={`wip-reveal__foreground${desiredForegroundVisible ? ' wip-reveal__foreground--visible' : ' wip-reveal__foreground--hidden'}${packDiscarded ? ' wip-reveal__pack-layer--discarded' : ''}`}
            aria-hidden="true"
            onAnimationEnd={handlePackDiscardAnimationEnd}
          >
            <img
              ref={foregroundImageRef}
              src={foregroundFrameSrc}
              alt=""
              className="reveal-overlay__image wip-reveal__foreground-image"
              draggable={false}
              onLoad={() => {
                setForegroundPrepared(true);
              }}
            />
          </div>
        ) : null}
      </div>
      <div className="reveal-overlay__note">{note}</div>
    </div>
  );
}

export default function PonchoInventoryRevealOverlay({
  overlayStyle,
  active,
  closing,
  phase,
  revealedIds,
  loading,
  note,
  boxName,
  boxFrameSrc,
  foregroundFrameSrc,
  cardVisible,
  cardInteractive,
  boxDisabled,
  onAdvance,
  onDismiss,
  onTransitionEnd,
  onPackDiscardEnd,
}: PonchoInventoryRevealOverlayProps) {
  const revealedCard = useMemo(() => {
    if (!revealedIds?.length || revealedIds.length !== 1) return undefined;
    return getPonchoDrifellaCardByFigureId(revealedIds[0]);
  }, [revealedIds]);
  const stage = phase === 'preparing' ? 'preparing' : phase === 'revealed' && revealedCard ? 'revealed' : 'ready';

  return (
    <PonchoRevealOverlay
      overlayStyle={overlayStyle}
      active={active}
      closing={closing}
      stage={stage}
      note={note}
      boxName={boxName}
      boxFrameSrc={boxFrameSrc}
      foregroundFrameSrc={foregroundFrameSrc}
      card={revealedCard}
      cardVisible={cardVisible}
      cardInteractive={cardInteractive}
      boxBusy={loading}
      boxDisabled={boxDisabled}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      onTransitionEnd={onTransitionEnd}
      onPackDiscardEnd={onPackDiscardEnd}
    />
  );
}
