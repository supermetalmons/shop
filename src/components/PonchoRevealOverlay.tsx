import { useMemo, type CSSProperties, type SyntheticEvent, type TransitionEvent } from 'react';
import type { DrifCardConfig } from '../drifCards';
import {
  PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE,
  getPonchoDrifellaCardByFigureId,
} from '../lib/ponchoDrifellaReveal';
import { resolveRevealFrameSrc } from '../lib/revealFrameSequence';
import WipInteractiveCard from './WipInteractiveCard';

type PonchoRevealPhase = 'preparing' | 'ready' | 'revealed';

export type PonchoInventoryRevealOverlayProps = {
  mode: 'inventory-unbox';
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  phase: PonchoRevealPhase;
  frame: number;
  autoOpening: boolean;
  revealedIds?: number[];
  loading: boolean;
  note: string;
  boxName: string;
  boxFrameSrc?: string;
  onAdvance: () => void;
  onDismiss: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
};

type PonchoRevealOverlayProps = {
  overlayStyle?: CSSProperties;
  active: boolean;
  closing: boolean;
  stage: PonchoRevealPhase;
  note: string;
  boxName: string;
  boxFrameSrc?: string;
  card?: DrifCardConfig;
  boxBusy?: boolean;
  boxDisabled?: boolean;
  onAdvance: () => void;
  onDismiss?: () => void;
  onTransitionEnd?: (evt: TransitionEvent<HTMLDivElement>) => void;
};

const BOX_FRAME_COUNT = PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount;

export function PonchoRevealOverlay({
  overlayStyle,
  active,
  closing,
  stage,
  note,
  boxName,
  boxFrameSrc,
  card,
  boxBusy = false,
  boxDisabled = false,
  onAdvance,
  onDismiss,
  onTransitionEnd,
}: PonchoRevealOverlayProps) {
  const cardVisible = stage === 'revealed' && Boolean(card);
  const stopOverlayDismiss = (evt: SyntheticEvent) => {
    evt.stopPropagation();
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
        <div className={`reveal-overlay__shine${cardVisible ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
        {card ? (
          <div className={`reveal-overlay__media wip-reveal__media${cardVisible ? ' reveal-overlay__media--visible' : ''}`} aria-hidden={!cardVisible}>
            <div className="reveal-overlay__media-item wip-reveal__card-item" onClick={stopOverlayDismiss}>
              <div className="reveal-overlay__media-float">
                <WipInteractiveCard card={card} />
              </div>
            </div>
          </div>
        ) : null}
        <button
          type="button"
          className={`reveal-overlay__box${cardVisible ? ' wip-reveal__box--discarded' : ''}`}
          aria-label={`Reveal ${boxName}`}
          aria-busy={boxBusy}
          aria-disabled={boxDisabled}
          disabled={boxDisabled}
          onClick={(evt) => {
            evt.stopPropagation();
            if (boxDisabled) return;
            onAdvance();
          }}
        >
          {boxFrameSrc ? (
            <img src={boxFrameSrc} alt={boxName} className="reveal-overlay__image" draggable={false} />
          ) : (
            <div className="reveal-overlay__image reveal-overlay__image--placeholder" aria-hidden="true" />
          )}
        </button>
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
  frame,
  autoOpening,
  revealedIds,
  loading,
  note,
  boxName,
  boxFrameSrc,
  onAdvance,
  onDismiss,
  onTransitionEnd,
}: PonchoInventoryRevealOverlayProps) {
  const revealedCard = useMemo(() => {
    if (!revealedIds?.length || revealedIds.length !== 1) return undefined;
    return getPonchoDrifellaCardByFigureId(revealedIds[0]);
  }, [revealedIds]);
  const stage = phase === 'preparing' ? 'preparing' : phase === 'revealed' && revealedCard ? 'revealed' : 'ready';
  const resolvedBoxFrameSrc = boxFrameSrc || resolveRevealFrameSrc(PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE, frame);
  const boxDisabled = closing || phase !== 'ready' || autoOpening || frame >= BOX_FRAME_COUNT;

  return (
    <PonchoRevealOverlay
      overlayStyle={overlayStyle}
      active={active}
      closing={closing}
      stage={stage}
      note={note}
      boxName={boxName}
      boxFrameSrc={resolvedBoxFrameSrc}
      card={revealedCard}
      boxBusy={loading}
      boxDisabled={boxDisabled}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      onTransitionEnd={onTransitionEnd}
    />
  );
}
