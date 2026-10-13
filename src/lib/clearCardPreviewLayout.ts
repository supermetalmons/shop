import { findOpaquePixelBounds, type SnapshotPixelSize } from './clearCardSnapshot';

type PreviewBounds = { left: number; top: number; width: number; height: number };

export type ClearCardPreviewImage = {
  aspectRatio: number;
  bounds: PreviewBounds;
};

export type ClearCardPreviewModel = {
  bounds: PreviewBounds;
  canvas: PreviewBounds;
  viewport: SnapshotPixelSize;
};

export function clearCardPreviewPixelBounds(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  bottomUp = false,
): PreviewBounds | null {
  const bounds = findOpaquePixelBounds(pixels, width, height);
  if (!bounds) return null;
  return {
    left: bounds.x / width,
    top: (bottomUp ? bounds.y : height - bounds.y - bounds.height) / height,
    width: bounds.width / width,
    height: bounds.height / height,
  };
}

export function measureClearCardPreviewImage(image: HTMLImageElement): ClearCardPreviewImage | null {
  const { naturalWidth, naturalHeight } = image;
  if (!naturalWidth || !naturalHeight) return null;
  const scale = Math.min(1, 1024 / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const bounds = clearCardPreviewPixelBounds(pixels, canvas.width, canvas.height);
  return bounds ? { aspectRatio: naturalWidth / naturalHeight, bounds } : null;
}

export function resolveClearCardPreviewTransform(
  image: ClearCardPreviewImage,
  model: ClearCardPreviewModel,
) {
  const { bounds, canvas, viewport } = model;
  const dimensions = [
    image.aspectRatio, image.bounds.width, image.bounds.height,
    bounds.width, bounds.height, canvas.width, canvas.height, viewport.width, viewport.height,
  ];
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) return null;
  if ([image.bounds.left, image.bounds.top, bounds.left, bounds.top, canvas.left, canvas.top]
    .some(value => !Number.isFinite(value))) return null;
  const imageWidth = Math.min(viewport.width, viewport.height * image.aspectRatio);
  const imageHeight = imageWidth / image.aspectRatio;
  const targetLeft = (viewport.width - imageWidth) / 2 + image.bounds.left * imageWidth;
  const targetTop = (viewport.height - imageHeight) / 2 + image.bounds.top * imageHeight;
  const scaleX = image.bounds.width * imageWidth / (bounds.width * canvas.width);
  const scaleY = image.bounds.height * imageHeight / (bounds.height * canvas.height);
  return {
    x: targetLeft - canvas.left - bounds.left * canvas.width * scaleX,
    y: targetTop - canvas.top - bounds.top * canvas.height * scaleY,
    scaleX,
    scaleY,
  };
}
