import {
  usesClearCard3dRevealFlow,
  usesInteractiveCardPackRevealFlow,
  type DropRevealRenderer
} from '../../config/dropsExtraContent';
import {
  calcClearCardRevealTargetRect,
  calcPonchoDrifellaRevealTargetRect,
  getRevealOverlayViewport as getOverlayViewport,
  offsetRevealOverlayRectForViewport
} from '../../lib/revealOverlayLayout';
import { ImageViewerSize, OverlayRect } from './types';

function calcRevealTargetRect(viewportWidth: number, viewportHeight: number, aspectRatio: number): OverlayRect {
  const maxWidth = viewportWidth * 0.65;
  const maxHeight = viewportHeight * 0.43;
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * safeAspectRatio)));
  const height = Math.max(1, Math.floor(width / safeAspectRatio));
  const lift = Math.round(height * 0.42);
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.max(16, Math.round((viewportHeight - height) / 2) - lift),
    width,
    height,
  };
}

function calcReceiptViewerTargetRect(
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
  size: ImageViewerSize = 'receipt',
): OverlayRect {
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const maxWidth =
    size === 'shipment-figure'
      ? Math.min(viewportWidth * 0.86, 760)
      : size === 'shipment'
        ? Math.min(viewportWidth * 0.82, 640)
        : Math.min(viewportWidth * 0.84, 620);
  const maxHeight =
    size === 'shipment-figure'
      ? Math.min(viewportHeight * 0.72, 660)
      : size === 'shipment'
        ? Math.min(viewportHeight * 0.72, 640)
        : Math.min(viewportHeight * 0.78, 760);
  let width = Math.max(1, Math.floor(Math.min(maxWidth, maxHeight * safeAspectRatio)));
  let height = Math.max(1, Math.floor(width / safeAspectRatio));
  if (height > maxHeight) {
    height = Math.max(1, Math.floor(maxHeight));
    width = Math.max(1, Math.floor(height * safeAspectRatio));
  }
  return {
    left: Math.round((viewportWidth - width) / 2),
    top: Math.max(16, Math.round((viewportHeight - height) / 2)),
    width,
    height,
  };
}

export function calcReceiptViewerTargetRectInViewport(
  aspectRatio: number,
  size: ImageViewerSize = 'receipt',
  viewport = getOverlayViewport(),
): OverlayRect {
  return offsetRevealOverlayRectForViewport(
    calcReceiptViewerTargetRect(viewport.width, viewport.height, aspectRatio, size),
    viewport,
  );
}

export function calcRevealTargetRectForRendererInViewport(
  revealRenderer: DropRevealRenderer | undefined,
  aspectRatio: number,
  viewport = getOverlayViewport(),
): OverlayRect {
  return offsetRevealOverlayRectForViewport(
    calcRevealTargetRectForRenderer(viewport.width, viewport.height, revealRenderer, aspectRatio),
    viewport,
  );
}

export function getRenderedImagePreview(root: HTMLElement, fallback?: string): { src?: string; aspectRatio?: number; } {
  const image = root.querySelector<HTMLImageElement>('img.figure-image:not([hidden])');
  const src = String(image?.currentSrc || image?.src || '').trim();
  const naturalAspectRatio =
    image && image.naturalWidth > 0 && image.naturalHeight > 0
      ? image.naturalWidth / image.naturalHeight
      : undefined;
  return { src: src || fallback, aspectRatio: naturalAspectRatio };
}

function calcRevealTargetRectForRenderer(
  viewportWidth: number,
  viewportHeight: number,
  revealRenderer: DropRevealRenderer | undefined,
  aspectRatio: number,
): OverlayRect {
  if (usesInteractiveCardPackRevealFlow(revealRenderer)) {
    return calcPonchoDrifellaRevealTargetRect(viewportWidth, viewportHeight);
  }
  if (usesClearCard3dRevealFlow(revealRenderer)) {
    return calcClearCardRevealTargetRect(viewportWidth, viewportHeight);
  }
  return calcRevealTargetRect(viewportWidth, viewportHeight, aspectRatio);
}
