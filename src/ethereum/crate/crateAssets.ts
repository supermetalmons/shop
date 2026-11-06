import type { EthereumInventoryItem } from '../../../shared/ethereum/protocol';
import { ethereumInventoryView } from '../state';

export type CratePreview = {
  id: string;
  src: string;
  name: string;
  width: number;
  height: number;
  image: HTMLCanvasElement;
};

export type CratePreviewAssets = {
  items: readonly CratePreview[];
  release: () => void;
};

type CratePreviewOptions = {
  signal?: AbortSignal;
  concurrency?: number;
  timeoutMs?: number;
  createImage?: () => HTMLImageElement;
  createCanvas?: () => HTMLCanvasElement;
};

export function loadCratePreviewAssets(
  items: readonly EthereumInventoryItem[],
  {
    signal,
    concurrency = 4,
    timeoutMs = 30_000,
    createImage = () => new Image(),
    createCanvas = () => document.createElement('canvas'),
  }: CratePreviewOptions = {},
): Promise<CratePreviewAssets> {
  return new Promise((resolve, reject) => {
    const residents = new Map<string, Pick<CratePreview, 'width' | 'height' | 'image'>>();
    const active = new Map<HTMLImageElement, ReturnType<typeof setTimeout>>();
    const canvases = new Set<HTMLCanvasElement>();
    let settled = false;
    let released = false;
    let cursor = 0;
    let complete = 0;
    const limit = Number.isFinite(concurrency) ? Math.max(1, Math.min(4, Math.floor(concurrency))) : 4;

    const clearImage = (image: HTMLImageElement) => {
      clearTimeout(active.get(image));
      active.delete(image);
      image.onload = null;
      image.onerror = null;
      image.src = '';
    };
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', abort);
      for (const image of active.keys()) clearImage(image);
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
      canvases.clear();
      residents.clear();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      release();
      reject(error);
    };
    function abort() {
      if (settled) release();
      else fail(new DOMException('Artwork preview loading was cancelled.', 'AbortError'));
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const entries = items.map(item => ({ item, src: ethereumInventoryView(item).image }));
      if (entries.some(entry => !entry.src)) throw new Error('An artwork preview is missing.');
      const sources = [...new Set(entries.map(entry => entry.src!))];
      const finish = () => {
        if (settled || released) return;
        settled = true;
        resolve({
          items: entries.map(({ item, src }) => ({ id: item.id, name: item.name, src: src!, ...residents.get(src!)! })),
          release,
        });
      };
      const startNext = () => {
        if (settled || released) return;
        if (complete === sources.length) { finish(); return; }
        while (active.size < limit && cursor < sources.length && !settled && !released) {
          const src = sources[cursor++];
          const image = createImage();
          image.crossOrigin = 'anonymous';
          image.decoding = 'async';
          image.fetchPriority = 'high';
          let decoding = false;
          active.set(image, setTimeout(() => fail(new Error(`Timed out loading artwork preview: ${src}`)), timeoutMs));
          const loaded = async () => {
            if (decoding || settled || released) return;
            decoding = true;
            try {
              await image.decode();
              if (settled || released) return;
              const width = image.naturalWidth;
              const height = image.naturalHeight;
              if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                throw new Error('The image has no dimensions.');
              }
              const scale = Math.min(1, 512 / Math.max(width, height));
              const canvas = createCanvas();
              canvases.add(canvas);
              canvas.width = Math.max(1, Math.round(width * scale));
              canvas.height = Math.max(1, Math.round(height * scale));
              const context = canvas.getContext('2d');
              if (!context) throw new Error('The image could not be prepared.');
              context.imageSmoothingEnabled = true;
              context.imageSmoothingQuality = 'high';
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              residents.set(src, { width, height, image: canvas });
              clearImage(image);
              complete++;
              startNext();
            } catch {
              if (!settled && !released) fail(new Error(`Unable to decode artwork preview: ${src}`));
            }
          };
          image.onload = () => { void loaded(); };
          image.onerror = () => fail(new Error(`Unable to load artwork preview: ${src}`));
          image.src = src;
          if (image.complete && image.naturalWidth > 0) void loaded();
        }
      };
      startNext();
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Unable to prepare artwork previews.'));
    }
  });
}
