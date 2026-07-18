import { useLayoutEffect, type RefObject } from 'react';

type DropPageScrollFadeOptions = {
  active: boolean;
  pageRef: RefObject<HTMLElement | null>;
};

const SCROLL_FADE_RANGE = 220;
const CSS_NUMBER_PRECISION = 4;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function smoothStep(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function formatCssNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(CSS_NUMBER_PRECISION).replace(/\.?0+$/, '');
}

export function useDropPageScrollFade({ active, pageRef }: DropPageScrollFadeOptions): void {
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!active || !page || typeof window === 'undefined') {
      page?.style.removeProperty('--drop-scroll-progress');
      return;
    }

    let frameId = 0;

    const applyProgress = () => {
      frameId = 0;
      const progress = smoothStep((window.scrollY || 0) / SCROLL_FADE_RANGE);
      page.style.setProperty('--drop-scroll-progress', formatCssNumber(progress));
    };

    const requestApplyProgress = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(applyProgress);
    };

    applyProgress();
    window.addEventListener('scroll', requestApplyProgress, { passive: true });
    window.addEventListener('resize', requestApplyProgress);
    window.visualViewport?.addEventListener('scroll', requestApplyProgress, { passive: true });
    window.visualViewport?.addEventListener('resize', requestApplyProgress);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', requestApplyProgress);
      window.removeEventListener('resize', requestApplyProgress);
      window.visualViewport?.removeEventListener('scroll', requestApplyProgress);
      window.visualViewport?.removeEventListener('resize', requestApplyProgress);
      page.style.removeProperty('--drop-scroll-progress');
    };
  }, [active, pageRef]);
}
