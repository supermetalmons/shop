function fallbackElementForImage(image: HTMLImageElement): HTMLElement | null {
  return image.nextElementSibling instanceof HTMLElement ? image.nextElementSibling : null;
}

export function showImageHideFallback(image: HTMLImageElement) {
  image.hidden = false;
  const fallback = fallbackElementForImage(image);
  if (fallback) fallback.hidden = true;
}

export function hideImageShowFallback(image: HTMLImageElement) {
  image.hidden = true;
  const fallback = fallbackElementForImage(image);
  if (fallback) fallback.hidden = false;
}
