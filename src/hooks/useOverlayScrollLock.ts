import { useLayoutEffect } from 'react';
import { acquireBodyScrollLock, releaseBodyScrollLock } from '../lib/bodyScrollLock';
import {
  captureViewportScrollPosition,
  restoreViewportScrollPosition,
} from '../lib/viewportScroll';

const OVERLAY_BLOCKED_EVENTS = ['touchmove', 'gesturestart', 'gesturechange', 'gestureend', 'wheel'] as const;
const OVERLAY_ZOOM_SHORTCUT_KEYS = new Set(['+', '=', '-', '_', '0']);
const OVERLAY_SCROLL_ALLOWED_SELECTOR = '[data-overlay-scroll-allow]';
const OVERLAY_SCROLLBAR_HIDDEN_CLASS = 'overlay-scroll-lock--scrollbar-hidden';
let scrollbarReleaseFrame: number | null = null;

function cancelScrollbarRelease() {
  if (scrollbarReleaseFrame === null) return;
  window.cancelAnimationFrame(scrollbarReleaseFrame);
  scrollbarReleaseFrame = null;
}

function releaseScrollbarAfterPaint(html: HTMLElement, body: HTMLElement) {
  cancelScrollbarRelease();
  scrollbarReleaseFrame = window.requestAnimationFrame(() => {
    scrollbarReleaseFrame = window.requestAnimationFrame(() => {
      scrollbarReleaseFrame = null;
      html.classList.remove(OVERLAY_SCROLLBAR_HIDDEN_CLASS);
      body.classList.remove(OVERLAY_SCROLLBAR_HIDDEN_CLASS);
    });
  });
}

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
  escapeEnabled?: boolean;
  freezePage?: boolean;
  onEscape?: () => void;
};

export function shouldHandleOverlayEscape({
  defaultPrevented,
  escapeEnabled,
  hasEscapeHandler,
  key,
}: {
  defaultPrevented: boolean;
  escapeEnabled: boolean;
  hasEscapeHandler: boolean;
  key: string;
}): boolean {
  return key === 'Escape' && !defaultPrevented && escapeEnabled && hasEscapeHandler;
}

export function useOverlayScrollLock({
  active,
  escapeEnabled = true,
  freezePage = false,
  onEscape,
}: UseOverlayScrollLockOptions) {
  useLayoutEffect(() => {
    if (!active) return undefined;

    const scrollPosition = captureViewportScrollPosition();
    const onKeyDown = (evt: KeyboardEvent) => {
      if ((evt.metaKey || evt.ctrlKey) && OVERLAY_ZOOM_SHORTCUT_KEYS.has(evt.key)) {
        evt.preventDefault();
        return;
      }
      if (
        !shouldHandleOverlayEscape({
          defaultPrevented: evt.defaultPrevented,
          escapeEnabled,
          hasEscapeHandler: Boolean(onEscape),
          key: evt.key,
        })
      ) {
        return;
      }
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
    if (freezePage) {
      cancelScrollbarRelease();
      html.classList.add('overlay-scroll-lock--page-frozen');
      body.classList.add('overlay-scroll-lock--page-frozen');
      html.classList.add(OVERLAY_SCROLLBAR_HIDDEN_CLASS);
      body.classList.add(OVERLAY_SCROLLBAR_HIDDEN_CLASS);
    } else {
      restoreViewportScrollPosition(scrollPosition);
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      OVERLAY_BLOCKED_EVENTS.forEach((eventName) => {
        document.removeEventListener(eventName, preventDefault, nonPassiveOptions);
      });
      if (freezePage) {
        html.classList.remove('overlay-scroll-lock--page-frozen');
        body.classList.remove('overlay-scroll-lock--page-frozen');
      }
      html.classList.remove('overlay-scroll-lock');
      body.classList.remove('overlay-scroll-lock');
      html.style.overflow = previousHtmlOverflow;
      releaseBodyScrollLock();
      if (freezePage) {
        releaseScrollbarAfterPaint(html, body);
      } else {
        restoreViewportScrollPosition(scrollPosition);
      }
    };
  }, [active, escapeEnabled, freezePage, onEscape]);
}
