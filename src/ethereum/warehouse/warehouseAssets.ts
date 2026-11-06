import type { EthereumInventoryItem } from '../../../shared/ethereum/protocol';
import type { CratePreviewAssets } from '../crate/crateAssets';

export const WAREHOUSE_CRATE_IMAGE_SRC = '/111k/crate-reference.webp';

export type WarehouseCrateImage = {
  image: HTMLCanvasElement;
  width: number;
  height: number;
  release: () => void;
};

type ImageOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  createImage?: () => HTMLImageElement;
  createCanvas?: () => HTMLCanvasElement;
};

export function loadWarehouseCrateImage({ signal, timeoutMs = 30_000,
  createImage = () => new Image(), createCanvas = () => document.createElement('canvas'),
}: ImageOptions = {}): Promise<WarehouseCrateImage> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Crate preview loading was cancelled.', 'AbortError')); return; }
    const image = createImage();
    let canvas: HTMLCanvasElement | null = null;
    let settled = false;
    let released = false;
    let decoding = false;
    const clearImage = () => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      image.src = '';
    };
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', abort);
      clearImage();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      release();
      reject(error);
    };
    function abort() {
      if (settled) release();
      else fail(new DOMException('Crate preview loading was cancelled.', 'AbortError'));
    }
    const timer = setTimeout(() => fail(new Error('The crate preview took too long to load.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    image.decoding = 'async';
    image.fetchPriority = 'high';
    const loaded = async () => {
      if (decoding || settled || released) return;
      decoding = true;
      try {
        await image.decode();
        if (settled || released) return;
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error('The crate preview has no dimensions.');
        }
        const scale = Math.min(1, 512 / Math.max(width, height));
        canvas = createCanvas();
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to prepare the crate preview.');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        clearImage();
        settled = true;
        resolve({ image: canvas, width, height, release });
      } catch {
        if (!settled && !released) fail(new Error('Unable to prepare the crate preview.'));
      }
    };
    image.onload = () => { void loaded(); };
    image.onerror = () => fail(new Error('Unable to load the crate preview.'));
    image.src = WAREHOUSE_CRATE_IMAGE_SRC;
    if (image.complete && image.naturalWidth > 0) void loaded();
  });
}

export function warehouseCratePreviews(items: readonly EthereumInventoryItem[], preview: WarehouseCrateImage | null): CratePreviewAssets | null {
  if (!preview || !items.length) return null;
  return { items: items.map(item => ({ id: item.id, name: item.name, src: WAREHOUSE_CRATE_IMAGE_SRC,
    image: preview.image, width: preview.width, height: preview.height })), release() {} };
}
