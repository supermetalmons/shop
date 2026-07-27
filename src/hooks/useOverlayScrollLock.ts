import { useEffect } from 'react';
import { acquireBodyScrollLock, releaseBodyScrollLock } from '../lib/bodyScrollLock';

const OVERLAY_BLOCKED_EVENTS = ['touchmove', 'gesturestart', 'gesturechange', 'gestureend', 'wheel'] as const;
const OVERLAY_ZOOM_SHORTCUT_KEYS = new Set(['+', '=', '-', '_', '0']);
const OVERLAY_SCROLL_ALLOWED_SELECTOR = '[data-overlay-scroll-allow]';

function eventAllowsNestedOverlayScroll(evt: Event): boolean {
  if (evt.type !== 'touchmove' && evt.type !== 'wheel') return false;
  if (evt.type === 'wheel') {
    const wheelEvent = evt as WheelEvent;
    if (wheelEvent.ctrlKey || wheelEvent.metaKey) return false;
  }
  if (evt.type === 'touchmove' && (evt as TouchEvent).touches?.length > 1) return false;
  const target = evt.target;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(OVERLAY_SCROLL_ALLOWED_SELECTOR));
}

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
    const preventDefault = (evt: Event) => {
      if (eventAllowsNestedOverlayScroll(evt)) return;
      evt.preventDefault();
    };
    const nonPassiveOptions = { passive: false } as AddEventListenerOptions;

    document.addEventListener('keydown', onKeyDown);
    OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
      document.addEventListener(eventName, preventDefault, nonPassiveOptions);
    });
    html.classList.add('overlay-scroll-lock');
    body.classList.add('overlay-scroll-lock');
    html.style.overflow = 'hidden';
    acquireBodyScrollLock();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
        document.removeEventListener(eventName, preventDefault, nonPassiveOptions);
      });
      html.classList.remove('overlay-scroll-lock');
      body.classList.remove('overlay-scroll-lock');
      html.style.overflow = previousHtmlOverflow;
      releaseBodyScrollLock();
    };
  }, [active, onEscape]);
}
