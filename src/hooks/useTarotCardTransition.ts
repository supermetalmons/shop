import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

function prepareImage(image: HTMLImageElement, onReady: (ready: boolean) => void) {
  let active = true;
  const report = (ready: boolean) => { if (active) onReady(ready); };
  const failed = () => report(false);
  const reportLoaded = () => report(image.complete && image.naturalWidth > 0);
  const loaded = () => {
    if (typeof image.decode === 'function') void image.decode().then(() => report(true), reportLoaded);
    else reportLoaded();
  };

  if (image.complete) loaded();
  else {
    image.addEventListener('load', loaded, { once: true });
    image.addEventListener('error', failed, { once: true });
  }

  return () => {
    active = false;
    image.removeEventListener('load', loaded);
    image.removeEventListener('error', failed);
  };
}

export function useTarotCardTransition(eligible: boolean, paused: boolean) {
  const cardRef = useRef<HTMLImageElement>(null);
  const receiptRef = useRef<HTMLImageElement>(null);
  const receiptPreparation = useRef<Promise<void> | null>(null);
  const [receiptState, setReceiptState] = useState<'loading' | 'ready' | 'failed'>('loading');
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
    const receipt = receiptRef.current;
    if (!eligible || !receipt) {
      setReceiptState('loading');
      return;
    }

    let stop = () => {};
    receiptPreparation.current = new Promise<void>(resolve => {
      stop = prepareImage(receipt, ready => {
        setReceiptState(ready ? 'ready' : 'failed');
        resolve();
      });
    });
    return () => {
      stop();
      receiptPreparation.current = null;
    };
  }, [eligible]);

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
      let artworkPainted = false;
      let frame = 0;
      let receiptTimeout: ReturnType<typeof setTimeout> | undefined;
      const enter = () => {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        clearTimeout(receiptTimeout);
        from.current = card.getBoundingClientRect();
        setPhase('entering');
      };
      const timeout = setTimeout(() => {
        if (artworkPainted) {
          enter();
        } else {
          active = false;
          cancelAnimationFrame(frame);
          setPhase('claim');
        }
      }, 1_500);
      const stop = prepareImage(card, ready => {
        if (!active) return;
        if (!ready) {
          setPhase('claim');
          return;
        }
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            artworkPainted = true;
            const receipt = receiptPreparation.current;
            if (!receipt) enter();
            else {
              receiptTimeout = setTimeout(enter, 220);
              void receipt.then(enter);
            }
          });
        });
      });
      return () => {
        active = false;
        clearTimeout(timeout);
        clearTimeout(receiptTimeout);
        cancelAnimationFrame(frame);
        stop();
      };
    }

    const start = from.current;
    const end = card.getBoundingClientRect();
    if (paused || hidden || reducedMotion || !start?.width || !end.width || !end.height) {
      setPhase('claim');
      return;
    }
    const viewport = window.visualViewport;
    const width = viewport?.width;
    const height = viewport?.height;
    const scale = viewport?.scale;
    const animation = card.animate([
      { transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width})` },
      { transform: 'none' },
    ], { duration: 394, delay: 16, easing: 'cubic-bezier(.24,.42,.2,1)', fill: 'backwards' });
    let active = true;
    const finish = () => { if (active) setPhase('claim'); };
    const viewportResized = () => {
      if (viewport?.width !== width || viewport?.height !== height || viewport?.scale !== scale) finish();
    };
    void animation.finished.then(finish, () => {});
    window.addEventListener('resize', finish);
    window.addEventListener('scroll', finish, true);
    viewport?.addEventListener('resize', viewportResized);
    return () => {
      active = false;
      animation.cancel();
      window.removeEventListener('resize', finish);
      window.removeEventListener('scroll', finish, true);
      viewport?.removeEventListener('resize', viewportResized);
    };
  }, [eligible, paused, hidden, reducedMotion, phase]);

  return { cardRef, receiptRef, receiptState, compact: eligible && phase !== 'artwork', transitioning: eligible && phase === 'entering' };
}
