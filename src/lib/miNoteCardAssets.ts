import { getDrifCardVisualAssetSources, type DrifCardConfig } from '../drifCards.ts';

export type MiNoteCardAssetResidency = {
  images: readonly HTMLImageElement[];
  release: () => void;
};

type MiNoteCardAssetOptions = {
  signal?: AbortSignal;
  createImage?: () => HTMLImageElement;
  timeoutMs?: number;
};

export function loadMiNoteCardAssets(
  cards: readonly DrifCardConfig[],
  { signal, createImage = () => new Image(), timeoutMs = 30_000 }: MiNoteCardAssetOptions = {},
): Promise<MiNoteCardAssetResidency> {
  const sources = [...new Set(cards.flatMap(getDrifCardVisualAssetSources))];

  return new Promise((resolve, reject) => {
    const images: HTMLImageElement[] = [];
    const timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
    let settled = false;
    let released = false;
    let remaining = sources.length;

    const clearPending = () => {
      timers.forEach((timer) => globalThis.clearTimeout(timer));
      timers.clear();
      images.forEach((image) => {
        image.onload = null;
        image.onerror = null;
      });
    };

    const release = () => {
      if (released) return;
      released = true;
      clearPending();
      signal?.removeEventListener('abort', handleAbort);
      images.forEach((image) => {
        image.src = '';
      });
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      release();
      reject(error);
    };

    const handleAbort = () => {
      if (settled) {
        release();
        return;
      }
      fail(new DOMException('Card asset loading was cancelled.', 'AbortError'));
    };

    const finish = () => {
      if (settled || released) return;
      settled = true;
      clearPending();
      resolve({ images, release });
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (remaining === 0) {
      finish();
      return;
    }

    try {
      for (const src of sources) {
        if (settled || released) break;
        const image = createImage();
        images.push(image);
        image.decoding = 'async';
        image.fetchPriority = 'high';
        let decoding = false;
        const timer = globalThis.setTimeout(() => {
          fail(new Error(`Timed out loading card asset: ${src}`));
        }, timeoutMs);
        timers.add(timer);

        const handleLoad = async () => {
          if (settled || released || decoding) return;
          decoding = true;
          try {
            await image.decode();
            if (settled || released) return;
            if (image.naturalWidth <= 0) {
              fail(new Error(`Invalid card asset: ${src}`));
              return;
            }
            globalThis.clearTimeout(timer);
            timers.delete(timer);
            image.onload = null;
            image.onerror = null;
            remaining -= 1;
            if (remaining === 0) finish();
          } catch {
            fail(new Error(`Unable to decode card asset: ${src}`));
          }
        };

        image.onload = () => { void handleLoad(); };
        image.onerror = () => { fail(new Error(`Unable to load card asset: ${src}`)); };
        image.src = src;
        if (image.complete && image.naturalWidth > 0) void handleLoad();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Unable to preload card assets.'));
    }
  });
}
