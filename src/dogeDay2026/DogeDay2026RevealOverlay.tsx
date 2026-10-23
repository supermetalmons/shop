import { useEffect, useRef, useState, type RefObject } from 'react';
import type { DrifCardConfig } from '../drifCards';
import { createDogeFoilScene } from './foilPackScene';
import { dogeDay2026CardIdentityKey } from './starterCards';

type RevealStage = 'sealed' | 'hit' | 'waiting' | 'opening' | 'revealed';

type DogeDay2026RevealOverlayProps = {
  cards: readonly DrifCardConfig[];
  cardReady: boolean;
  boxLabel: string;
  resetKey: string | number;
  boxButtonRef?: RefObject<HTMLButtonElement | null>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  onBackgroundTap?: () => void;
  onError?: () => void;
};

export function DogeDay2026RevealOverlay(props: DogeDay2026RevealOverlayProps) {
  const { cards, cardReady, boxLabel, resetKey, boxButtonRef } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<ReturnType<typeof createDogeFoilScene> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [stage, setStage] = useState<RevealStage>('sealed');
  const [assetsReady, setAssetsReady] = useState(false);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const cardKey = cards[0] ? dogeDay2026CardIdentityKey(cards[0]) : '';

  useEffect(() => {
    const host = hostRef.current;
    const card = propsRef.current.cards[0];
    if (!host || !card) return;
    let active = true;
    setStage('sealed');
    setAssetsReady(false);
    setError(false);
    const handleError = () => {
      if (!active) return;
      setError(true);
      propsRef.current.onError?.();
    };
    try {
      sceneRef.current = createDogeFoilScene(host, {
        card,
        cardReady: propsRef.current.cardReady,
        onStageChange: (nextStage) => {
          if (active) setStage(nextStage);
        },
        onReady: () => {
          if (active) setAssetsReady(true);
        },
        onError: handleError,
        onHit: () => {
          if (active) propsRef.current.onPlayClick?.();
        },
        onReveal: () => {
          if (active) propsRef.current.onPlayReveal?.();
        },
        onBackgroundTap: () => {
          if (active) propsRef.current.onBackgroundTap?.();
        },
      });
    } catch {
      handleError();
    }
    return () => {
      active = false;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [cardKey, resetKey, retryKey]);

  useEffect(() => {
    sceneRef.current?.setCardReady(cardReady);
  }, [cardReady]);

  const status = error
    ? 'Unable to load this pack.'
    : stage === 'revealed'
      ? 'Your card is ready and interactive. Drag to tilt.'
      : stage === 'opening'
        ? 'Opening…'
        : stage === 'waiting'
          ? 'Getting your card ready…'
          : !assetsReady
            ? 'Loading pack…'
            : 'Tap the pack';

  return (
    <div className="doge-day-2026-reveal-overlay" data-stage={stage}>
      <div className="doge-day-2026-reveal-overlay__scene" ref={hostRef} aria-hidden="true" />
      <div className={error ? 'doge-day-2026-reveal-overlay__error' : 'doge-day-2026-reveal-overlay__sr-only'}>
        <p role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
        {error && (
          <button type="button" className="doge-day-2026-reveal-overlay__retry" onClick={() => setRetryKey((current) => current + 1)}>
            Retry
          </button>
        )}
      </div>
      <button
        ref={boxButtonRef}
        type="button"
        className="doge-day-2026-reveal-overlay__activate"
        aria-label={stage === 'revealed' ? 'Reset card tilt' : `Hit the ${boxLabel}`}
        disabled={error || stage === 'opening' || !cards.length}
        onClick={() => sceneRef.current?.activate()}
      >
        {stage === 'revealed' ? 'Reset card tilt' : `Hit the ${boxLabel}`}
      </button>
    </div>
  );
}
