import { useEffect, useRef, useState, type RefObject } from 'react';
import type { DrifCardConfig } from '../drifCards';
import { createDogeFoilScene, type DogeCardSceneState } from './foilPackScene';
import { dogeDay2026CardIdentityKey } from './starterCards';

type RevealStage = 'sealed' | 'hit' | 'waiting' | 'opening' | 'revealed';

type DogeDay2026RevealOverlayProps = {
  cards: readonly DrifCardConfig[];
  cardReady: boolean;
  boxLabel: string;
  resetKey: string | number;
  inspectionTimeMs?: number;
  inspectionDensity?: number;
  inspectionCaptureRef?: RefObject<(() => string[]) | null>;
  onInspectionReady?: (ready: boolean) => void;
  boxButtonRef?: RefObject<HTMLButtonElement | null>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  onPlayCardSwipe?: () => void;
  onPlayCardSpread?: () => void;
  onBackgroundTap?: () => void;
  onError?: () => void;
};

// TODO: Reuse playMiNoteClosingParticles on successful unpack dismissal when adding the Doge Day production inventory flow.
export function DogeDay2026RevealOverlay(props: DogeDay2026RevealOverlayProps) {
  const { cards, cardReady, boxLabel, resetKey, boxButtonRef } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<ReturnType<typeof createDogeFoilScene> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [stage, setStage] = useState<RevealStage>('sealed');
  const [assetsReady, setAssetsReady] = useState(false);
  const [error, setError] = useState(false);
  const [cardState, setCardState] = useState<DogeCardSceneState>({ mode: 'stack', activeCardIndex: 0, transitioning: false });
  const cardKey = JSON.stringify(cards.map(dogeDay2026CardIdentityKey));

  useEffect(() => {
    const host = hostRef.current;
    const sceneCards = propsRef.current.cards;
    if (!host || !sceneCards.length) return;
    let active = true;
    setStage('sealed');
    setAssetsReady(false);
    propsRef.current.onInspectionReady?.(false);
    setError(false);
    setCardState({ mode: 'stack', activeCardIndex: 0, transitioning: false });
    const handleError = () => {
      if (!active) return;
      setError(true);
      propsRef.current.onInspectionReady?.(false);
      propsRef.current.onError?.();
    };
    try {
      sceneRef.current = createDogeFoilScene(host, {
        cards: sceneCards,
        cardReady: propsRef.current.cardReady,
        inspectionTimeMs: propsRef.current.inspectionTimeMs,
        inspectionDensity: propsRef.current.inspectionDensity,
        onStageChange: (nextStage) => {
          if (active) setStage(nextStage);
        },
        onCardStateChange: (nextState) => {
          if (active) setCardState(nextState);
        },
        onReady: () => {
          if (active) setAssetsReady(true);
        },
        onGpuReady: () => {
          if (active) propsRef.current.onInspectionReady?.(true);
        },
        onError: handleError,
        onHit: () => {
          if (active) propsRef.current.onPlayClick?.();
        },
        onReveal: () => {
          if (active) propsRef.current.onPlayReveal?.();
        },
        onCardSwipe: () => {
          if (active) propsRef.current.onPlayCardSwipe?.();
        },
        onCardSpread: () => {
          if (active) propsRef.current.onPlayCardSpread?.();
        },
        onBackgroundTap: () => {
          if (active) propsRef.current.onBackgroundTap?.();
        },
      });
      if (propsRef.current.inspectionCaptureRef) {
        propsRef.current.inspectionCaptureRef.current = () => sceneRef.current?.captureOpeningFrames() ?? [];
      }
    } catch {
      handleError();
    }
    return () => {
      active = false;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      if (propsRef.current.inspectionCaptureRef) propsRef.current.inspectionCaptureRef.current = null;
    };
  }, [cardKey, resetKey]);

  useEffect(() => {
    sceneRef.current?.setCardReady(cardReady);
  }, [cardReady]);

  useEffect(() => {
    sceneRef.current?.setInspectionTime(props.inspectionTimeMs ?? null);
  }, [props.inspectionTimeMs]);

  useEffect(() => {
    sceneRef.current?.setInspectionDensity(props.inspectionDensity ?? null);
  }, [props.inspectionDensity]);

  const multipleCards = cards.length > 1;
  const rowVisible = cardState.mode === 'row';
  const cardAction = !multipleCards || rowVisible
    ? 'Reset card tilt'
    : cardState.activeCardIndex === cards.length - 1
      ? 'Show all cards'
      : 'Next card';
  const actionLabel = stage === 'revealed' ? cardAction : `Hit the ${boxLabel}`;
  const activationBlocked = error || props.inspectionTimeMs !== undefined || stage === 'opening' || cardState.transitioning || !cards.length;
  const cardStatus = !multipleCards
    ? 'Your card is ready and interactive. Drag to tilt.'
    : cardState.transitioning
      ? cardState.mode === 'spreading' ? 'Showing all cards…' : 'Showing the next card…'
      : rowVisible
        ? `All ${cards.length} cards are ready and interactive. Drag any card to tilt.`
        : `Card ${cardState.activeCardIndex + 1} of ${cards.length}. Drag to tilt. ${cardAction}.`;
  const status = error
    ? 'Unable to load this pack.'
    : stage === 'revealed'
      ? cardStatus
      : stage === 'opening'
        ? 'Opening…'
        : stage === 'waiting'
          ? multipleCards ? 'Getting your cards ready…' : 'Getting your card ready…'
          : !assetsReady
            ? 'Loading pack…'
            : 'Tap the pack';

  return (
    <div className="doge-day-2026-reveal-overlay" data-stage={stage} data-card-mode={cardState.mode}>
      <div className="doge-day-2026-reveal-overlay__scene" ref={hostRef} aria-hidden="true" />
      <div className="doge-day-2026-reveal-overlay__sr-only">
        <p role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
      </div>
      <button
        ref={boxButtonRef}
        type="button"
        className="doge-day-2026-reveal-overlay__activate"
        aria-label={actionLabel}
        aria-disabled={activationBlocked || undefined}
        disabled={error || !cards.length}
        onClick={() => {
          if (!activationBlocked) sceneRef.current?.activate();
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
