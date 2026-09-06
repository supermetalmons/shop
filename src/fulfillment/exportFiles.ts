import type { FulfillmentSecretCodeExportEntry } from '../lib/fulfillmentExports';

const SECRET_CODE_PNG_WIDTH = 2000;
const SECRET_CODE_PNG_HEIGHT = 2800;
const SECRET_CODE_QR_SIZE = 1450;
const SECRET_CODE_QR_TOP = 150;
const SECRET_CODE_PREVIEW_BAND_TOP = 1615;
const SECRET_CODE_PREVIEW_BAND_HEIGHT = 780;
const SECRET_CODE_PREVIEW_MAX_ROW_WIDTH = 1600;
const SECRET_CODE_PREVIEW_TILE_SIZE = 420;
const SECRET_CODE_PREVIEW_SINGLE_TILE_SIZE = 570;
const SECRET_CODE_PREVIEW_MIN_TILE_SIZE = 240;
const SECRET_CODE_PREVIEW_TILE_GAP = 90;
const SECRET_CODE_PREVIEW_IMAGE_TIMEOUT_MS = 12_000;
const SECRET_CODE_PREVIEW_IMAGE_MAX_ATTEMPTS = 5;
const SECRET_CODE_PREVIEW_IMAGE_RETRY_BASE_DELAY_MS = 400;
const SECRET_CODE_TEXT_Y = 2525;
const SECRET_CODE_TEXT_MAX_WIDTH = 1800;
const SECRET_CODE_TEXT_MAX_FONT_SIZE = 132;
const SECRET_CODE_TEXT_MIN_FONT_SIZE = 12;
type QRCodeModule = typeof import('qrcode');
type SecretCodesZipProgressHandler = (percent: number) => void;
type SecretCodePreviewImageCache = Map<string, Promise<HTMLImageElement>>;

export function downloadBlobFile(filename: string, blob: Blob) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  downloadBlobFile(filename, blob);
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to render secret code PNG'));
        }
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

function fitSecretCodeText(ctx: CanvasRenderingContext2D, secretCode: string): void {
  let fontSize = SECRET_CODE_TEXT_MAX_FONT_SIZE;
  while (fontSize > SECRET_CODE_TEXT_MIN_FONT_SIZE) {
    ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    if (ctx.measureText(secretCode).width <= SECRET_CODE_TEXT_MAX_WIDTH) return;
    fontSize -= 4;
  }

  ctx.font = `700 ${SECRET_CODE_TEXT_MIN_FONT_SIZE}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const measuredWidth = ctx.measureText(secretCode).width;
  const fittedSize = Math.max(
    1,
    Math.floor((SECRET_CODE_TEXT_MIN_FONT_SIZE * SECRET_CODE_TEXT_MAX_WIDTH) / Math.max(1, measuredWidth)),
  );
  ctx.font = `700 ${fittedSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function loadSecretCodePreviewImageOnce(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(new Error(`Timed out loading secret code preview image: ${src}`));
    }, SECRET_CODE_PREVIEW_IMAGE_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      if (error) {
        image.src = '';
        reject(error);
        return;
      }
      resolve(image);
    };

    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish();
      } else {
        finish(new Error(`Loaded secret code preview image without dimensions: ${src}`));
      }
    };
    image.onerror = () => finish(new Error(`Failed to load secret code preview image: ${src}`));
    image.src = src;
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish();
    }
  });
}

function secretCodePreviewImageExportSrc(src: string): string {
  const normalizedSrc = String(src || '').trim();
  if (!/^https?:\/\//i.test(normalizedSrc)) return normalizedSrc;

  try {
    const url = new URL(normalizedSrc);
    if (url.hostname.toLowerCase() !== 'cdn.lil.org') return normalizedSrc;
    url.searchParams.set('mons_export_cors', '1');
    return url.toString();
  } catch {
    return normalizedSrc;
  }
}

async function loadSecretCodePreviewImageWithRetry(src: string): Promise<HTMLImageElement> {
  const exportSrc = secretCodePreviewImageExportSrc(src);
  let lastError: unknown;
  for (let attempt = 1; attempt <= SECRET_CODE_PREVIEW_IMAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadSecretCodePreviewImageOnce(exportSrc);
    } catch (err) {
      lastError = err;
      if (attempt === SECRET_CODE_PREVIEW_IMAGE_MAX_ATTEMPTS) break;
      await wait(SECRET_CODE_PREVIEW_IMAGE_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : 'Unknown image load error';
  throw new Error(
    `Failed to load required secret code preview image after ${SECRET_CODE_PREVIEW_IMAGE_MAX_ATTEMPTS} attempts: ${src}. ${detail}`,
  );
}

function loadSecretCodePreviewImage(src: string, cache: SecretCodePreviewImageCache): Promise<HTMLImageElement> {
  const cached = cache.get(src);
  if (cached) return cached;

  const promise = loadSecretCodePreviewImageWithRetry(src).catch((err) => {
    cache.delete(src);
    throw err;
  });
  cache.set(src, promise);
  return promise;
}

async function loadSecretCodePreviewImages(
  previews: FulfillmentSecretCodeExportEntry['previewImages'],
  cache: SecretCodePreviewImageCache,
): Promise<HTMLImageElement[]> {
  if (!previews?.length) return [];
  return Promise.all(previews.map((preview) => loadSecretCodePreviewImage(preview.src, cache)));
}

function drawContainedPreviewImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  size: number,
): void {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
  const maxSize = size;
  const scale = Math.min(maxSize / image.naturalWidth, maxSize / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const drawX = x + (size - drawWidth) / 2;
  const drawY = y + (size - drawHeight) / 2;

  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function drawSecretCodePreviewImages(ctx: CanvasRenderingContext2D, images: HTMLImageElement[]): void {
  if (!images.length) return;

  const gap = images.length > 1 ? SECRET_CODE_PREVIEW_TILE_GAP : 0;
  const preferredTileSize = images.length === 1 ? SECRET_CODE_PREVIEW_SINGLE_TILE_SIZE : SECRET_CODE_PREVIEW_TILE_SIZE;
  const tileSize = Math.max(
    SECRET_CODE_PREVIEW_MIN_TILE_SIZE,
    Math.min(
      preferredTileSize,
      Math.floor((SECRET_CODE_PREVIEW_MAX_ROW_WIDTH - Math.max(0, images.length - 1) * gap) / images.length),
    ),
  );
  const rowWidth = images.length * tileSize + Math.max(0, images.length - 1) * gap;
  const startX = Math.floor((SECRET_CODE_PNG_WIDTH - rowWidth) / 2);
  const y = Math.floor(SECRET_CODE_PREVIEW_BAND_TOP + (SECRET_CODE_PREVIEW_BAND_HEIGHT - tileSize) / 2);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  images.forEach((image, index) => {
    const x = startX + index * (tileSize + gap);
    drawContainedPreviewImage(ctx, image, x, y, tileSize);
  });
  ctx.restore();
}

async function renderSecretCodePngBlob(
  qrCode: QRCodeModule,
  entry: FulfillmentSecretCodeExportEntry,
  previewImageCache: SecretCodePreviewImageCache,
): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('Secret code PNG export requires a browser document');

  const canvas = document.createElement('canvas');
  canvas.width = SECRET_CODE_PNG_WIDTH;
  canvas.height = SECRET_CODE_PNG_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to create secret code PNG canvas');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SECRET_CODE_PNG_WIDTH, SECRET_CODE_PNG_HEIGHT);

  const qrCanvas = document.createElement('canvas');
  await qrCode.toCanvas(qrCanvas, entry.claimUrl, {
    errorCorrectionLevel: 'M',
    margin: 3,
    width: SECRET_CODE_QR_SIZE,
    color: {
      dark: '#000000ff',
      light: '#ffffffff',
    },
  });

  const qrLeft = Math.floor((SECRET_CODE_PNG_WIDTH - SECRET_CODE_QR_SIZE) / 2);
  ctx.drawImage(qrCanvas, qrLeft, SECRET_CODE_QR_TOP, SECRET_CODE_QR_SIZE, SECRET_CODE_QR_SIZE);

  const previewImages = await loadSecretCodePreviewImages(entry.previewImages, previewImageCache);
  drawSecretCodePreviewImages(ctx, previewImages);

  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitSecretCodeText(ctx, entry.secretCode);
  ctx.fillText(entry.secretCode, SECRET_CODE_PNG_WIDTH / 2, SECRET_CODE_TEXT_Y);

  return canvasToPngBlob(canvas);
}

async function loadQRCodeModule(): Promise<QRCodeModule> {
  const qrCodeImport = await import('qrcode');
  return ((qrCodeImport as QRCodeModule & { default?: QRCodeModule }).default || qrCodeImport) as QRCodeModule;
}

export async function buildSecretCodePngBlob(
  entry: FulfillmentSecretCodeExportEntry,
  previewImageCache?: SecretCodePreviewImageCache,
  qrCode?: QRCodeModule,
): Promise<Blob> {
  const resolvedQrCode = qrCode || (await loadQRCodeModule());
  return renderSecretCodePngBlob(resolvedQrCode, entry, previewImageCache || new Map());
}

export async function buildSecretCodesZipBlob(
  entries: FulfillmentSecretCodeExportEntry[],
  onProgress?: SecretCodesZipProgressHandler,
): Promise<Blob> {
  const [{ default: JSZip }, qrCode] = await Promise.all([import('jszip'), loadQRCodeModule()]);
  const zip = new JSZip();
  const totalEntries = entries.length;
  const previewImageCache: SecretCodePreviewImageCache = new Map();

  onProgress?.(0);

  for (const [index, entry] of entries.entries()) {
    const pngBlob = await buildSecretCodePngBlob(entry, previewImageCache, qrCode);
    zip.file(entry.filename, pngBlob);
    onProgress?.(Math.min(95, Math.round(((index + 1) / Math.max(1, totalEntries)) * 95)));
  }

  return zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => {
    onProgress?.(Math.min(100, 95 + Math.round((metadata.percent || 0) / 20)));
  });
}
