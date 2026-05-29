import { useLayoutEffect, type RefObject } from 'react';

type DropPageCompactScrollOptions = {
  active: boolean;
  pageRef: RefObject<HTMLElement | null>;
  frameRef: RefObject<HTMLElement | null>;
};

type DropPageCompactMetrics = {
  fullHeight: number;
  compactHeight: number;
  collapseDistance: number;
  scrollRange: number;
  pagePaddingTop: number;
  heroPreviewPaddingBottom: number;
  compactPreviewPaddingBottom: number;
  heroBoxesTranslateY: number;
};

const MIN_SCROLL_RANGE = 220;
const CSS_NUMBER_PRECISION = 4;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function smoothStep(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function readPixelValue(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function readTranslateY(transform: string): number {
  if (!transform || transform === 'none') return 0;

  const matrix3dMatch = transform.match(/^matrix3d\((.+)\)$/);
  if (matrix3dMatch) {
    const values = matrix3dMatch[1].split(',').map((value) => Number.parseFloat(value.trim()));
    return Number.isFinite(values[13]) ? values[13] : 0;
  }

  const matrixMatch = transform.match(/^matrix\((.+)\)$/);
  if (matrixMatch) {
    const values = matrixMatch[1].split(',').map((value) => Number.parseFloat(value.trim()));
    return Number.isFinite(values[5]) ? values[5] : 0;
  }

  return 0;
}

function viewportHeight(): number {
  return window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0;
}

function measureDropPageCompactMetrics(frame: HTMLElement): DropPageCompactMetrics {
  const pagePaddingTop = readPixelValue(window.getComputedStyle(document.body).getPropertyValue('--page-padding-top'));
  const fullHeight = Math.max(0, Math.round(viewportHeight() - pagePaddingTop));
  const preview = frame.querySelector<HTMLElement>('.mint-panel__preview');
  const boxes = frame.querySelector<HTMLElement>('.mint-panel__boxes');
  const previousPreviewPadding = frame.style.getPropertyValue('--drop-preview-padding-bottom');
  const previousBoxesTranslate = frame.style.getPropertyValue('--drop-boxes-translate-y');

  frame.style.removeProperty('--drop-preview-padding-bottom');
  frame.style.removeProperty('--drop-boxes-translate-y');

  const heroPreviewPaddingBottom = preview
    ? readPixelValue(window.getComputedStyle(preview).paddingBottom)
    : 0;
  const heroBoxesTranslateY = boxes
    ? readTranslateY(window.getComputedStyle(boxes).transform)
    : 0;

  frame.classList.add('drop-page-frame--measuring-compact');

  const compactPreviewPaddingBottom = preview
    ? readPixelValue(window.getComputedStyle(preview).paddingBottom)
    : heroPreviewPaddingBottom;
  const compactHeight = Math.ceil(frame.scrollHeight);

  frame.classList.remove('drop-page-frame--measuring-compact');

  if (previousPreviewPadding) {
    frame.style.setProperty('--drop-preview-padding-bottom', previousPreviewPadding);
  }
  if (previousBoxesTranslate) {
    frame.style.setProperty('--drop-boxes-translate-y', previousBoxesTranslate);
  }

  const collapseDistance = Math.max(0, fullHeight - compactHeight);
  const scrollRange = Math.max(MIN_SCROLL_RANGE, collapseDistance);

  return {
    fullHeight,
    compactHeight,
    collapseDistance,
    scrollRange,
    pagePaddingTop,
    heroPreviewPaddingBottom,
    compactPreviewPaddingBottom,
    heroBoxesTranslateY,
  };
}

function formatCssNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(CSS_NUMBER_PRECISION).replace(/\.?0+$/, '');
}

export function useDropPageCompactScroll({
  active,
  pageRef,
  frameRef,
}: DropPageCompactScrollOptions): void {
  useLayoutEffect(() => {
    const page = pageRef.current;
    const frame = frameRef.current;
    if (!active || !page || !frame || typeof window === 'undefined') {
      page?.style.removeProperty('--drop-compact-progress');
      page?.style.removeProperty('--drop-backdrop-opacity');
      frame?.style.removeProperty('--drop-frame-height');
      frame?.style.removeProperty('--drop-frame-padding-bottom');
      frame?.style.removeProperty('--drop-preview-padding-bottom');
      frame?.style.removeProperty('--drop-boxes-translate-y');
      return;
    }

    let frameId = 0;
    let metrics = measureDropPageCompactMetrics(frame);

    const applyProgress = () => {
      frameId = 0;

      const rawProgress = metrics.scrollRange > 0 ? window.scrollY / metrics.scrollRange : 0;
      const progress = smoothStep(rawProgress);
      const remainingProgress = 1 - progress;
      const frameHeight = metrics.fullHeight - metrics.collapseDistance * progress;
      const framePaddingBottom = metrics.pagePaddingTop * remainingProgress;
      const previewPaddingBottom =
        metrics.compactPreviewPaddingBottom +
        (metrics.heroPreviewPaddingBottom - metrics.compactPreviewPaddingBottom) * remainingProgress;
      const boxesTranslateY = metrics.heroBoxesTranslateY * remainingProgress;

      page.style.setProperty('--drop-compact-progress', formatCssNumber(progress));
      page.style.setProperty('--drop-backdrop-opacity', formatCssNumber(remainingProgress));
      frame.style.setProperty('--drop-frame-height', `${Math.round(frameHeight)}px`);
      frame.style.setProperty('--drop-frame-padding-bottom', `${Math.max(0, framePaddingBottom).toFixed(2)}px`);
      frame.style.setProperty('--drop-preview-padding-bottom', `${Math.max(0, previewPaddingBottom).toFixed(2)}px`);
      frame.style.setProperty('--drop-boxes-translate-y', `${boxesTranslateY.toFixed(2)}px`);
    };

    const requestApplyProgress = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(applyProgress);
    };

    const handleResize = () => {
      metrics = measureDropPageCompactMetrics(frame);
      requestApplyProgress();
    };

    applyProgress();
    window.addEventListener('scroll', requestApplyProgress, { passive: true });
    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', requestApplyProgress);
      window.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('resize', handleResize);
      page.style.removeProperty('--drop-compact-progress');
      page.style.removeProperty('--drop-backdrop-opacity');
      frame.style.removeProperty('--drop-frame-height');
      frame.style.removeProperty('--drop-frame-padding-bottom');
      frame.style.removeProperty('--drop-preview-padding-bottom');
      frame.style.removeProperty('--drop-boxes-translate-y');
      frame.classList.remove('drop-page-frame--measuring-compact');
    };
  }, [active, frameRef, pageRef]);
}
