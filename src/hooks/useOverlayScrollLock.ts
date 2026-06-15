import { useEffect } from 'react';

const OVERLAY_BLOCKED_EVENTS = ['touchmove', 'gesturestart', 'gesturechange', 'gestureend', 'wheel'] as const;
const OVERLAY_ZOOM_SHORTCUT_KEYS = new Set(['+', '=', '-', '_', '0']);

type UseOverlayScrollLockOptions = {
  active: boolean;
  onEscape?: () => void;
};

export function useOverlayScrollLock({ active, onEscape }: UseOverlayScrollLockOptions) {
  useEffect(() => {
    if (!active) return undefined;

    const onKeyDown = (evt: KeyboardEvent) => {
      if ((evt.metaKey || evt.ctrlKey) && OVERLAY_ZOOM_SHORTCUT_KEYS.has(evt.key)) {
        evt.preventDefault();
        return;
      }
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      onEscape?.();
    };
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const preventDefault = (evt: Event) => evt.preventDefault();
    const nonPassiveOptions = { passive: false } as AddEventListenerOptions;

    document.addEventListener('keydown', onKeyDown);
    OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
      document.addEventListener(eventName, preventDefault, nonPassiveOptions);
    });
    html.classList.add('overlay-scroll-lock');
    body.classList.add('overlay-scroll-lock');
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
        document.removeEventListener(eventName, preventDefault, nonPassiveOptions);
      });
      html.classList.remove('overlay-scroll-lock');
      body.classList.remove('overlay-scroll-lock');
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [active, onEscape]);
}
