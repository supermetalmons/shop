import { calcContainedMediaRect } from './revealOverlayLayout';

function findVisibleInventoryMediaElement(root: ParentNode): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('.inventory__media > :not([hidden])') ||
    root.querySelector<HTMLElement>('.figure-image:not([hidden])') ||
    root.querySelector<HTMLElement>('.inventory__media') ||
    root.querySelector<HTMLElement>('.inventory__image')
  );
}

export function getInventoryMediaImage(root: HTMLElement): HTMLImageElement | null {
  return root.querySelector<HTMLImageElement>('img.figure-image:not([hidden]), img.inventory__image:not([hidden]), img.inventory__video-poster') ||
    root.querySelector<HTMLImageElement>('.inventory__media > img[hidden]:not(.inventory__image)');
}

export function getInventoryRevealRect(target: HTMLElement): DOMRect {
  const media = findVisibleInventoryMediaElement(target) || target;
  const bounds = media.getBoundingClientRect();
  const style = window.getComputedStyle(media);
  const inset = (padding: string, border: string, borderStyle: string) =>
    (parseFloat(padding) || 0) + (borderStyle && borderStyle !== 'none' && borderStyle !== 'hidden' ? parseFloat(border) || 0 : 0);
  const left = inset(style.paddingLeft, style.borderLeftWidth, style.borderLeftStyle);
  const right = inset(style.paddingRight, style.borderRightWidth, style.borderRightStyle);
  const top = inset(style.paddingTop, style.borderTopWidth, style.borderTopStyle);
  const bottom = inset(style.paddingBottom, style.borderBottomWidth, style.borderBottomStyle);
  const content = {
    left: bounds.left + left,
    top: bounds.top + top,
    width: Math.max(0, bounds.width - left - right),
    height: Math.max(0, bounds.height - top - bottom),
  };
  const image = getInventoryMediaImage(target);
  const video = media.querySelector<HTMLVideoElement>('video:not([hidden])');
  const mediaWidth = video?.videoWidth || image?.naturalWidth || 0;
  const mediaHeight = video?.videoHeight || image?.naturalHeight || 0;
  const containsImage = media.tagName === 'IMG'
    ? style.objectFit === 'contain'
    : style.backgroundSize === 'contain' || media.classList.contains('inventory__video-stack');
  const rect = containsImage && mediaWidth > 0 && mediaHeight > 0
    ? calcContainedMediaRect(content, mediaWidth / mediaHeight)
    : content;
  return new window.DOMRect(rect.left, rect.top, rect.width, rect.height);
}
