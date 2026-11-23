import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

export function useTarotCardTransition(eligible: boolean, paused: boolean) {
  const cardRef = useRef<HTMLImageElement>(null);
  const from = useRef<DOMRect | null>(null);
  const [phase, setPhase] = useState<'artwork' | 'entering' | 'claim'>('artwork');
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!eligible) {
      setPhase('artwork');
      return;
    }
    if (!card || phase === 'claim') return;
    if (phase === 'artwork') {
      if (paused || hidden) return;
      if (reducedMotion || typeof card.animate !== 'function') {
        setPhase('claim');
        return;
      }
      let active = true;
      let frame = 0;
      const timeout = setTimeout(() => {
        active = false;
        cancelAnimationFrame(frame);
        setPhase('claim');
      }, 1_500);
      const ready = async () => {
        try { await card.decode(); } catch {}
        if (!active) return;
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            from.current = card.getBoundingClientRect();
            setPhase('entering');
          });
        });
      };
      if (card.complete) void ready();
      else {
        card.addEventListener('load', ready, { once: true });
        card.addEventListener('error', ready, { once: true });
      }
      return () => {
        active = false;
        clearTimeout(timeout);
        cancelAnimationFrame(frame);
        card.removeEventListener('load', ready);
        card.removeEventListener('error', ready);
      };
    }

    const start = from.current;
    const end = card.getBoundingClientRect();
    if (paused || hidden || reducedMotion || !start?.width || !end.width || !end.height) {
      setPhase('claim');
      return;
    }
    const animation = card.animate([
      { transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width})` },
      { transform: 'none' },
    ], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
    let active = true;
    const finish = () => { if (active) setPhase('claim'); };
    void animation.finished.then(finish, () => {});
    window.addEventListener('resize', finish);
    window.addEventListener('scroll', finish, true);
    window.visualViewport?.addEventListener('resize', finish);
    return () => {
      active = false;
      animation.cancel();
      window.removeEventListener('resize', finish);
      window.removeEventListener('scroll', finish, true);
      window.visualViewport?.removeEventListener('resize', finish);
    };
  }, [eligible, paused, hidden, reducedMotion, phase]);

  return { cardRef, compact: eligible && phase !== 'artwork', transitioning: eligible && phase === 'entering' };
}
