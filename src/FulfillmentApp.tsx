import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type TransitionEvent,
} from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { FiAlertTriangle, FiDownload, FiMoreHorizontal } from 'react-icons/fi';
import { listFulfillmentManualReviewCheckouts, listFulfillmentOrders, updateFulfillmentStatus } from './lib/api';
import {
  FulfillmentManualReviewCheckout,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  FulfillmentStatus,
} from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  loadFigureMetadata,
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from './lib/figureMetadata';
import { normalizeBoxDisplayImage, resolveBoxMediaIdForDrop, resolveDropContent } from './lib/dropContent';
import { dropAssetLabel } from './lib/dropLabels';
import { fulfillmentBoxSecretCode } from './lib/fulfillmentCodes';
import { isDirectDeliveryItemsPerBox } from './lib/shipping';
import { CARD_NFT_2_PACK_IMAGES } from './lib/cardNft2Packs';
import { Modal } from './components/Modal';
import { PonchoCardViewerOverlay } from './components/PonchoRevealOverlay';
import { ShopHeader } from './components/ShopHeader';
import { useOverlayScrollLock } from './hooks/useOverlayScrollLock';
import {
  buildFulfillmentAddressExport,
  buildFulfillmentExportFilename,
  buildFulfillmentOrdersExport,
  buildFulfillmentSecretCodeExportEntries,
  countFulfillmentSecretCodeExportEntries,
  formatFulfillmentAddressText,
  type FulfillmentSecretCodeExportEntry,
} from './lib/fulfillmentExports';
import {
  fulfillmentBoxContentsLabel,
  fulfillmentBoxSecretLabelPrefix,
  resolveFulfillmentDirectDeliveryBoxLabel,
  resolveFulfillmentFigurePreview,
  type FulfillmentFigureLabelOverrideArgs,
} from './lib/fulfillmentLabels';
import { FULFILLMENT_STATUS_OPTIONS, normalizeFulfillmentStatus } from './lib/fulfillmentStatus';
import {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode,
  shouldDisplayFulfillmentTrackingCode,
} from './lib/fulfillmentTracking';
import {
  isDropFamily,
  listFrontendDrops,
  normalizeDropId,
  type FigureMediaConfig,
  type FrontendDeploymentConfig,
} from './config/deployment';
import { usesInteractiveCardPackRevealFlow } from './config/dropsExtraContent';
import { listAllowedFulfillmentDropIds } from './lib/fulfillmentAccess';
import { getInteractiveCardPackCardByFigureId } from './lib/interactiveCardPackReveal';
import {
  calcAspectLockedRevealOriginRect,
  calcPonchoDrifellaAbsoluteCardRect,
  calcPonchoDrifellaRevealTargetRectInViewport,
  getRevealOverlayViewport,
  ponchoDrifellaRevealOverlayStyleVars,
  sameRevealOverlayRect,
  toRevealOverlayRect,
  type PonchoDrifellaFrameRect,
} from './lib/revealOverlayLayout';
import {
  clearPonchoDrifellaImageCache,
  createPonchoDrifellaImageCache,
  preloadPonchoDrifellaCardAssets,
  type PonchoDrifellaImageCache,
} from './lib/ponchoDrifellaReveal';
import type { DrifCardConfig } from './drifCards';

const FULFILLMENT_ORDER_REQUEST_LIMIT = 1000;
const LITTLE_SWAG_BOXES_DROP_ID = 'little_swag_boxes';
const FIGURE_METADATA_RETRY_MS = 3000;
const FULFILLMENT_CARD_VIEWER_CLOSE_FALLBACK_MS = 380;
const BOX_CONTENTS_FIGURE_WIDTH = 130;
const BOX_CONTENTS_FIGURE_GAP = 12;
const BOX_CONTENTS_HORIZONTAL_CHROME = 54;
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
const FULFILLMENT_INTERACTIVE_CARD_CLICK_ENABLED = false;
const ORDER_VISIBILITY_OPTIONS = [
  { value: 'not_shipped', label: 'Not shipped' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'all', label: 'All' },
] as const;

type OrderVisibilityFilter = (typeof ORDER_VISIBILITY_OPTIONS)[number]['value'];
const DEFAULT_ORDER_VISIBILITY_FILTER: OrderVisibilityFilter = 'not_shipped';
type QRCodeModule = typeof import('qrcode');
type SecretCodesZipProgressHandler = (percent: number) => void;
type SecretCodePreviewImageCache = Map<string, Promise<HTMLImageElement>>;
type FulfillmentInteractiveCardViewerHandler = (args: {
  dropId: string;
  figureId: number;
  loadingImageSrc?: string;
  originRect?: DOMRect | null;
}) => void;
type FulfillmentInteractiveCardViewerState = {
  overlayId: string;
  card: DrifCardConfig;
  loadingImageSrc?: string;
  originRect: PonchoDrifellaFrameRect;
  targetRect: PonchoDrifellaFrameRect;
  active: boolean;
  closing: boolean;
};

function formatOrderDate(ts?: number) {
  if (!ts) return 'Date pending';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatOrderStatus(status: string) {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatManualReviewAmount(amountTotal?: number, currency?: string) {
  if (typeof amountTotal !== 'number' || !Number.isFinite(amountTotal)) return 'Amount pending';
  const currencyCode = String(currency || '').trim().toUpperCase();
  const amount = amountTotal / 100;
  if (currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
    } catch {
      return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currencyCode}`;
    }
  }
  return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortenStripeSessionId(sessionId: string) {
  const value = String(sessionId || '').trim();
  if (value.length <= 24) return value || 'Session unavailable';
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}

function manualReviewCheckoutKey(checkout: Pick<FulfillmentManualReviewCheckout, 'dropId' | 'sessionId'>): string {
  return `${checkout.dropId}:${checkout.sessionId}`;
}

function manualReviewSortValue(checkout: FulfillmentManualReviewCheckout): number {
  return checkout.failedAt || checkout.createdAt || 0;
}

function sortManualReviewCheckouts(checkouts: FulfillmentManualReviewCheckout[]): FulfillmentManualReviewCheckout[] {
  return [...checkouts].sort(
    (a, b) =>
      manualReviewSortValue(b) - manualReviewSortValue(a) ||
      a.dropId.localeCompare(b.dropId) ||
      b.sessionId.localeCompare(a.sessionId),
  );
}

function dedupeManualReviewCheckouts(checkouts: FulfillmentManualReviewCheckout[]): FulfillmentManualReviewCheckout[] {
  const seen = new Set<string>();
  return checkouts.filter((checkout) => {
    const key = manualReviewCheckoutKey(checkout);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function manualReviewIssueText(checkout: FulfillmentManualReviewCheckout): string {
  return checkout.errorMessage || checkout.manualRefundReviewReason || 'Manual review required';
}

function listOrderFigureIds(order: FulfillmentOrder): number[] {
  return [...order.looseDudes, ...order.boxes.flatMap((box) => box.dudeIds)];
}

type DuplicateFigureSummary = {
  groupKey: string;
  figureId: number;
  labelId: string;
  count: number;
  sortValue: number;
};

type FulfillmentOrderGroup = {
  pageIndex: number;
  groupKey: string;
  orders: FulfillmentOrder[];
  collapseSharedContact: boolean;
};

type FulfillmentOrdersCursorByDropId = Record<string, FulfillmentOrdersCursor | null>;

function fulfillmentOrderKey(order: Pick<FulfillmentOrder, 'dropId' | 'deliveryId'>): string {
  return `${order.dropId}:${order.deliveryId}`;
}

function fulfillmentOrderGroupKey(order: FulfillmentOrder): string {
  const owner = typeof order.owner === 'string' ? order.owner.trim() : '';
  return owner ? `owner:${owner}` : `delivery:${fulfillmentOrderKey(order)}`;
}

function fulfillmentOrderSortValue(order: FulfillmentOrder): number {
  return order.processedAt || order.createdAt || 0;
}

function sortFulfillmentOrders(orders: FulfillmentOrder[]): FulfillmentOrder[] {
  return [...orders].sort(
    (a, b) =>
      fulfillmentOrderSortValue(b) - fulfillmentOrderSortValue(a) ||
      a.dropId.localeCompare(b.dropId) ||
      b.deliveryId - a.deliveryId,
  );
}

function getBoxContentsStyle(itemCount: number): CSSProperties {
  const columns = Math.max(1, Math.min(itemCount, 3));
  const contentWidth = columns * BOX_CONTENTS_FIGURE_WIDTH + Math.max(0, columns - 1) * BOX_CONTENTS_FIGURE_GAP;
  return { width: `min(100%, ${contentWidth + BOX_CONTENTS_HORIZONTAL_CHROME}px)` };
}

function downloadBlobFile(filename: string, blob: Blob) {
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

function downloadJsonFile(filename: string, data: unknown) {
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

async function loadSecretCodePreviewImageWithRetry(src: string): Promise<HTMLImageElement> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SECRET_CODE_PREVIEW_IMAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await loadSecretCodePreviewImageOnce(src);
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

async function buildSecretCodesZipBlob(
  entries: FulfillmentSecretCodeExportEntry[],
  onProgress?: SecretCodesZipProgressHandler,
): Promise<Blob> {
  const [{ default: JSZip }, qrCodeImport] = await Promise.all([import('jszip'), import('qrcode')]);
  const qrCode = ((qrCodeImport as QRCodeModule & { default?: QRCodeModule }).default || qrCodeImport) as QRCodeModule;
  const zip = new JSZip();
  const totalEntries = entries.length;
  const previewImageCache: SecretCodePreviewImageCache = new Map();

  onProgress?.(0);

  for (const [index, entry] of entries.entries()) {
    const pngBlob = await renderSecretCodePngBlob(qrCode, entry, previewImageCache);
    zip.file(entry.filename, pngBlob);
    onProgress?.(Math.min(95, Math.round(((index + 1) / Math.max(1, totalEntries)) * 95)));
  }

  return zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => {
    onProgress?.(Math.min(100, 95 + Math.round((metadata.percent || 0) / 20)));
  });
}

function useDismissibleMenu<T extends HTMLElement>(
  open: boolean,
  menuRef: RefObject<T | null>,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const handlePointerDown = (evt: MouseEvent | TouchEvent) => {
      const node = menuRef.current;
      if (!node || node.contains(evt.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuRef, open, setOpen]);
}

function dedupeOrdersByKey(orders: FulfillmentOrder[], existingOrderKeys?: Set<string>): FulfillmentOrder[] {
  const seen = existingOrderKeys ? new Set(existingOrderKeys) : new Set<string>();
  return orders.filter((order) => {
    const key = fulfillmentOrderKey(order);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFulfillmentOrderMatchValue(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]+/g, '')
    .toLowerCase();
}

function parseFulfillmentOrderFullAddress(full?: string | null): { name: string; deliveryAddress: string } | null {
  if (typeof full !== 'string') return null;
  const normalized = full.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized === '***') return null;
  const [name, ...addressLines] = normalized.split('\n');
  const deliveryAddress = addressLines.join('\n');
  if (!name || !deliveryAddress) return null;
  return { name, deliveryAddress };
}

function canCollapseFulfillmentOrderGroupContact(orders: FulfillmentOrder[]): boolean {
  if (orders.length < 2) return false;
  const [firstOrder, ...restOrders] = orders;
  const firstAddress = parseFulfillmentOrderFullAddress(firstOrder.address.full);
  if (!firstAddress) return false;
  const firstEmail = normalizeFulfillmentOrderMatchValue(
    typeof firstOrder.address.email === 'string' ? firstOrder.address.email : '',
  );
  const firstName = normalizeFulfillmentOrderMatchValue(firstAddress.name);
  const firstDeliveryAddress = normalizeFulfillmentOrderMatchValue(firstAddress.deliveryAddress);
  if (!firstName) return false;

  return restOrders.every((order) => {
    const currentAddress = parseFulfillmentOrderFullAddress(order.address.full);
    if (!currentAddress) return false;
    const currentEmail = normalizeFulfillmentOrderMatchValue(
      typeof order.address.email === 'string' ? order.address.email : '',
    );
    return (
      currentEmail === firstEmail &&
      normalizeFulfillmentOrderMatchValue(currentAddress.deliveryAddress) === firstDeliveryAddress &&
      normalizeFulfillmentOrderMatchValue(currentAddress.name) === firstName
    );
  });
}

function summarizeDuplicateFigures(args: {
  orders: FulfillmentOrder[];
  previewMode: 'media_map_folder' | 'metadata_stills';
  figureMedia?: FigureMediaConfig;
  minimumCount?: number;
}): DuplicateFigureSummary[] {
  const { orders, previewMode, figureMedia, minimumCount = 2 } = args;
  const grouped = new Map<string, DuplicateFigureSummary>();

  orders.forEach((order) => {
    listOrderFigureIds(order).forEach((figureIdRaw) => {
      const figureId = Math.floor(Number(figureIdRaw));
      if (!Number.isFinite(figureId) || figureId <= 0) return;

      const mediaId = previewMode === 'media_map_folder' ? getMediaIdForFigureId(figureId, figureMedia) : null;
      const key = mediaId ? `media:${mediaId}` : `figure:${figureId}`;
      const labelId = mediaId ? String(mediaId) : String(figureId);
      const sortValue = mediaId ?? figureId;
      const existing = grouped.get(key);

      if (existing) {
        existing.count += 1;
        if (figureId < existing.figureId) {
          existing.figureId = figureId;
        }
        return;
      }

      grouped.set(key, {
        groupKey: key,
        figureId,
        labelId,
        count: 1,
        sortValue,
      });
    });
  });

  return Array.from(grouped.values())
    .filter((entry) => entry.count >= minimumCount)
    .sort((a, b) => b.count - a.count || a.sortValue - b.sortValue || a.figureId - b.figureId);
}

function mergeFigureMetadataRecords(
  prev: Record<string, FigureMetadataRecord>,
  records: FigureMetadataRecord[],
): Record<string, FigureMetadataRecord> {
  let changed = false;
  const next = { ...prev };
  records.forEach((record) => {
    const key = figureMetadataCacheKey(record.dropId, record.id);
    const existing = next[key];
    if (
      figureMetadataHasImage(existing) &&
      existing.image === record.image &&
      existing.name === record.name &&
      existing.attributes === record.attributes
    ) {
      return;
    }
    next[key] = record;
    changed = true;
  });
  return changed ? next : prev;
}

function supportsFulfillmentInteractiveCardViewer(dropOrId: FrontendDeploymentConfig | string | undefined): boolean {
  return usesInteractiveCardPackRevealFlow(resolveDropContent(dropOrId).reveal.renderer);
}

function getFulfillmentInteractiveCard(
  dropOrId: FrontendDeploymentConfig | string | undefined,
  figureId: number,
): DrifCardConfig | undefined {
  if (!supportsFulfillmentInteractiveCardViewer(dropOrId)) return undefined;
  const lookupDropId = typeof dropOrId === 'string' ? dropOrId : dropOrId?.dropId;
  return getInteractiveCardPackCardByFigureId(lookupDropId, figureId);
}

function getFigureTileImageElement(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.figure-image');
}

function getFigureTileImageRect(root: HTMLElement): DOMRect {
  return (getFigureTileImageElement(root) || root).getBoundingClientRect();
}

function getFigureTileRenderedImageSrc(root: HTMLElement, fallback?: string): string | undefined {
  const image = root.querySelector<HTMLImageElement>('img.figure-image:not([hidden])');
  const src = String(image?.currentSrc || image?.src || '').trim();
  return src || fallback;
}

function fulfillmentInteractiveCardLoadingImageSrc(image: string | undefined): string | undefined {
  const trimmed = String(image || '').trim();
  return trimmed ? `${trimmed.split('#')[0]}#fulfillment-card-preview` : undefined;
}

function FigureTileImage(props: {
  dropId: string;
  figureId: number;
  alt: string;
  primarySrc?: string;
  fallbackSrc?: string;
  onMetadataResolved?: (record: FigureMetadataRecord) => void;
}) {
  const { dropId, figureId, alt, primarySrc, fallbackSrc, onMetadataResolved } = props;
  const [activeSrc, setActiveSrc] = useState<string | null>(() => primarySrc || fallbackSrc || null);
  const [usingFallback, setUsingFallback] = useState(() => !primarySrc && Boolean(fallbackSrc));
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    if (primarySrc) {
      setActiveSrc(primarySrc);
      setUsingFallback(false);
      return;
    }
    if (fallbackSrc) {
      setActiveSrc(fallbackSrc);
      setUsingFallback(true);
      return;
    }
    setActiveSrc(null);
    setUsingFallback(false);
  }, [dropId, figureId, primarySrc]);

  useEffect(() => {
    if (!fallbackSrc) return;
    setActiveSrc((current) => (current ? current : fallbackSrc));
    setUsingFallback((current) => current || !primarySrc);
  }, [fallbackSrc, primarySrc]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const handleError = useCallback(() => {
    if (usingFallback) {
      setActiveSrc(null);
      return;
    }
    if (fallbackSrc && fallbackSrc !== primarySrc) {
      setActiveSrc(fallbackSrc);
      setUsingFallback(true);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setActiveSrc(null);
    void loadFigureMetadata(dropId, figureId)
      .then((record) => {
        if (requestIdRef.current !== requestId || !record?.image || record.image === primarySrc) return;
        onMetadataResolved?.(record);
        setActiveSrc(record.image);
        setUsingFallback(true);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setActiveSrc(null);
      });
  }, [dropId, fallbackSrc, figureId, onMetadataResolved, primarySrc, usingFallback]);

  if (!activeSrc) {
    return <span className="figure-image figure-image--placeholder" aria-hidden="true" />;
  }

  return <img src={activeSrc} alt={alt} loading="lazy" draggable={false} className="figure-image" onError={handleError} />;
}

function renderFigureTiles(args: {
  drop?: FrontendDeploymentConfig | null;
  dropId: string;
  figureIds: number[];
  keyPrefix: string;
  figureNamePrefix?: string;
  previewMode: 'media_map_folder' | 'metadata_stills';
  figureMedia?: FigureMediaConfig;
  figureMediaBase?: string;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
  onMetadataResolved?: (record: FigureMetadataRecord) => void;
  onViewInteractiveCard?: FulfillmentInteractiveCardViewerHandler;
  labelOverride?: (args: FulfillmentFigureLabelOverrideArgs) => string;
}) {
  const {
    dropId,
    figureIds,
    keyPrefix,
    drop,
    figureNamePrefix,
    previewMode,
    figureMedia,
    figureMediaBase,
    figureMetadataByKey,
    onMetadataResolved,
    onViewInteractiveCard,
    labelOverride,
  } = args;
  return (
    <div className="figure-grid">
      {figureIds.map((figureId, index) => {
        const preview = resolveFulfillmentFigurePreview({
          dropId,
          drop: drop || { dropId, figureNamePrefix, figureMedia },
          figureId,
          index,
          previewMode,
          figureMediaBase,
          figureMetadataByKey,
          labelOverride,
        });
        const canViewInteractiveCard = Boolean(
          FULFILLMENT_INTERACTIVE_CARD_CLICK_ENABLED &&
            getFulfillmentInteractiveCard(drop || dropId, figureId) &&
            onViewInteractiveCard,
        );
        const tileContent = (
          <>
            <FigureTileImage
              dropId={dropId}
              figureId={figureId}
              primarySrc={preview.primarySrc}
              fallbackSrc={preview.fallbackSrc}
              alt={preview.alt}
              onMetadataResolved={onMetadataResolved}
            />
            <span className="muted small">{preview.label}</span>
          </>
        );
        if (canViewInteractiveCard) {
          const viewInteractiveCard = (target: HTMLElement) => {
            onViewInteractiveCard?.({
              dropId,
              figureId,
              loadingImageSrc: getFigureTileRenderedImageSrc(target, preview.imageSrc),
              originRect: getFigureTileImageRect(target),
            });
          };
          return (
            <div
              key={`${keyPrefix}:${figureId}:${index}`}
              className="figure-tile"
              role="button"
              tabIndex={0}
              aria-label={`View ${preview.label}`}
              onClick={(evt) => viewInteractiveCard(evt.currentTarget)}
              onKeyDown={(evt) => {
                if (evt.key !== 'Enter' && evt.key !== ' ') return;
                evt.preventDefault();
                viewInteractiveCard(evt.currentTarget);
              }}
            >
              {tileContent}
            </div>
          );
        }
        return (
          <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
            {tileContent}
          </div>
        );
      })}
    </div>
  );
}

function renderBoxTiles(args: {
  boxIds: number[];
  keyPrefix: string;
  labelSource: Pick<FrontendDeploymentConfig, 'namePrefix' | 'figureNamePrefix' | 'mintSelection'>;
  getPreviewSrc?: (boxId: number) => string | undefined;
  secretCodeByBoxId?: ReadonlyMap<number, string>;
}) {
  const { boxIds, keyPrefix, labelSource, getPreviewSrc, secretCodeByBoxId } = args;
  return (
    <div className="figure-grid">
      {boxIds.map((boxId, index) => {
        const { label, sizeLabel } = resolveFulfillmentDirectDeliveryBoxLabel(labelSource, boxId);
        const secretCode = secretCodeByBoxId?.get(boxId);
        const imageSrc = getPreviewSrc?.(boxId);
        return (
          <div key={`${keyPrefix}:${boxId}:${index}`} className="figure-tile">
            {imageSrc ? (
              <img src={imageSrc} alt={label} loading="lazy" draggable={false} className="figure-image" />
            ) : (
              <div className="figure-image figure-image--placeholder" aria-hidden="true" />
            )}
            <div className={sizeLabel ? 'fulfillment-size-label' : 'muted small'}>{label}</div>
            {secretCode ? (
              <div className="muted small">
                {fulfillmentBoxSecretLabelPrefix(labelSource)}{' '}
                <span className="fulfillment-secret-code">{secretCode}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function renderFulfillmentPackSecretImage(args: {
  dropId: string;
  boxId: number;
}) {
  const { dropId, boxId } = args;
  const cardNft2PackMediaId = isDropFamily(dropId, 'card_nft_2') ? resolveBoxMediaIdForDrop(dropId, boxId) : null;
  const imageSrc =
    (cardNft2PackMediaId ? CARD_NFT_2_PACK_IMAGES[cardNft2PackMediaId - 1]?.src : undefined) ||
    normalizeBoxDisplayImage({ dropId, boxId });
  if (!imageSrc) return null;
  return (
    <img
      src={imageSrc}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      className="fulfillment-pack-secret-image"
    />
  );
}

type FulfillmentAppProps = {
  selectedDropId: string;
  onSelectedDropIdChange: (dropId: string) => void;
};

export default function FulfillmentApp({ selectedDropId, onSelectedDropIdChange }: FulfillmentAppProps) {
  const allDrops = useMemo(() => listFrontendDrops(), []);
  const walletAdapter = useWallet();
  const { publicKey } = walletAdapter;
  const { visible: walletModalVisible, setVisible: setWalletModalVisible } = useWalletModal();
  const { profile, signIn, loading: authLoading, error: authError } = useSolanaAuth();
  const walletAddress = publicKey?.toBase58() || '';
  const allowedDropIds = useMemo(
    () => listAllowedFulfillmentDropIds(walletAddress, allDrops.map((drop) => drop.dropId)),
    [allDrops, walletAddress],
  );
  const visibleDrops = useMemo(() => {
    const allowedDropIdsSet = new Set(allowedDropIds);
    return allDrops.filter((drop) => allowedDropIdsSet.has(drop.dropId));
  }, [allowedDropIds, allDrops]);
  const dropById = useMemo(() => new Map(visibleDrops.map((drop) => [drop.dropId, drop])), [visibleDrops]);
  const selectedDrop = useMemo(
    () => visibleDrops.find((drop) => drop.dropId === selectedDropId) || null,
    [visibleDrops, selectedDropId],
  );
  const selectedDrops = useMemo(() => {
    if (selectedDrop) return [selectedDrop];
    if (!selectedDropId) return visibleDrops;
    return [];
  }, [selectedDrop, selectedDropId, visibleDrops]);
  const selectedDropIds = useMemo(() => selectedDrops.map((drop) => drop.dropId), [selectedDrops]);
  const duplicateDrop = useMemo(
    () => selectedDrops.find((drop) => normalizeDropId(drop.dropId) === LITTLE_SWAG_BOXES_DROP_ID) || null,
    [selectedDrops],
  );
  const duplicateDropContent = useMemo(() => (duplicateDrop ? resolveDropContent(duplicateDrop) : null), [duplicateDrop]);
  const duplicateFigureMediaBase = duplicateDropContent?.figures.fulfillmentMediaBaseUrl;
  const signedIn = Boolean(profile && profile.wallet === walletAddress);
  const walletHasFulfillmentAccess = visibleDrops.length > 0;
  const hasFulfillmentAccess = walletHasFulfillmentAccess && signedIn;
  const walletBusy = walletAdapter.connecting || walletAdapter.disconnecting;
  const walletReadyState = walletAdapter.wallet?.readyState;
  const autoConnectPossible =
    Boolean(walletAdapter.wallet) &&
    walletAdapter.autoConnect &&
    (walletReadyState === WalletReadyState.Installed || walletReadyState === WalletReadyState.Loadable);

  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [orderPageKeys, setOrderPageKeys] = useState<string[][]>([]);
  const [cursorsByDropId, setCursorsByDropId] = useState<FulfillmentOrdersCursorByDropId>({});
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderVisibilityFilter, setOrderVisibilityFilter] = useState<OrderVisibilityFilter>(
    DEFAULT_ORDER_VISIBILITY_FILTER,
  );
  const [manualReviewCheckouts, setManualReviewCheckouts] = useState<FulfillmentManualReviewCheckout[]>([]);
  const [manualReviewMenuOpen, setManualReviewMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [secretCodesExporting, setSecretCodesExporting] = useState(false);
  const [secretCodesExportProgress, setSecretCodesExportProgress] = useState(0);
  const [statusEdits, setStatusEdits] = useState<Record<string, FulfillmentStatus | ''>>({});
  const [trackingCodeEdits, setTrackingCodeEdits] = useState<Record<string, string>>({});
  const [statusSaving, setStatusSaving] = useState<Record<string, boolean>>({});
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const [cardViewer, setCardViewer] = useState<FulfillmentInteractiveCardViewerState | null>(null);
  const cardViewerImageCacheRef = useRef<PonchoDrifellaImageCache | null>(null);
  const cardViewerResizeRafRef = useRef<number | null>(null);
  if (!cardViewerImageCacheRef.current) {
    cardViewerImageCacheRef.current = createPonchoDrifellaImageCache();
  }
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [activeUpdateOrderKey, setActiveUpdateOrderKey] = useState<string | null>(null);
  const walletConnectingSeenRef = useRef(false);
  const [walletReady, setWalletReady] = useState(() => !walletAdapter.wallet || !autoConnectPossible);
  const authLoadingSeenRef = useRef(false);
  const [authReady, setAuthReady] = useState(() => !walletAddress);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const manualReviewMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const orderRequestEpochRef = useRef(0);

  useDismissibleMenu(manualReviewMenuOpen, manualReviewMenuRef, setManualReviewMenuOpen);
  useDismissibleMenu(exportMenuOpen, exportMenuRef, setExportMenuOpen);

  const dismissCardViewer = useCallback(() => {
    setCardViewer((current) => (current && !current.closing ? { ...current, active: false, closing: true } : current));
  }, []);

  useOverlayScrollLock({ active: Boolean(cardViewer), onEscape: dismissCardViewer });

  useEffect(() => {
    return () => {
      if (cardViewerImageCacheRef.current) {
        clearPonchoDrifellaImageCache(cardViewerImageCacheRef.current);
      }
      if (cardViewerResizeRafRef.current !== null) {
        window.cancelAnimationFrame(cardViewerResizeRafRef.current);
        cardViewerResizeRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!cardViewer || cardViewer.active || cardViewer.closing || typeof window === 'undefined') return undefined;
    let raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(() => {
        setCardViewer((current) => (
          current?.overlayId === cardViewer.overlayId ? { ...current, active: true } : current
        ));
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [cardViewer]);

  useEffect(() => {
    if (!cardViewer?.closing || typeof window === 'undefined') return undefined;
    const { overlayId } = cardViewer;
    const closeTimeout = window.setTimeout(() => {
      setCardViewer((current) => (current?.overlayId === overlayId && current.closing ? null : current));
    }, FULFILLMENT_CARD_VIEWER_CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(closeTimeout);
  }, [cardViewer?.closing, cardViewer?.overlayId]);

  useEffect(() => {
    if (!cardViewer || cardViewer.closing || typeof window === 'undefined') return undefined;
    const { overlayId } = cardViewer;
    const updateTargetRect = () => {
      if (cardViewerResizeRafRef.current !== null) return;
      cardViewerResizeRafRef.current = window.requestAnimationFrame(() => {
        cardViewerResizeRafRef.current = null;
        const targetRect = calcPonchoDrifellaAbsoluteCardRect(calcPonchoDrifellaRevealTargetRectInViewport());
        setCardViewer((current) => {
          if (!current || current.overlayId !== overlayId || current.closing) return current;
          return sameRevealOverlayRect(current.targetRect, targetRect) ? current : { ...current, targetRect };
        });
      });
    };

    window.addEventListener('resize', updateTargetRect);
    window.addEventListener('orientationchange', updateTargetRect);
    window.visualViewport?.addEventListener('resize', updateTargetRect);
    window.visualViewport?.addEventListener('scroll', updateTargetRect);
    return () => {
      window.removeEventListener('resize', updateTargetRect);
      window.removeEventListener('orientationchange', updateTargetRect);
      window.visualViewport?.removeEventListener('resize', updateTargetRect);
      window.visualViewport?.removeEventListener('scroll', updateTargetRect);
      if (cardViewerResizeRafRef.current !== null) {
        window.cancelAnimationFrame(cardViewerResizeRafRef.current);
        cardViewerResizeRafRef.current = null;
      }
    };
  }, [cardViewer?.overlayId, cardViewer?.closing]);

  const openInteractiveCardViewer = useCallback<FulfillmentInteractiveCardViewerHandler>(
    ({ dropId, figureId, loadingImageSrc, originRect }) => {
      if (typeof window === 'undefined' || !cardViewerImageCacheRef.current) return;
      const drop = dropById.get(dropId);
      const card = getFulfillmentInteractiveCard(drop || dropId, figureId);
      if (!card) return;

      preloadPonchoDrifellaCardAssets(card, cardViewerImageCacheRef.current, { mode: 'warm', priority: 'low' });
      const targetRect = calcPonchoDrifellaAbsoluteCardRect(calcPonchoDrifellaRevealTargetRectInViewport());
      const resolvedOriginRect = originRect
        ? calcAspectLockedRevealOriginRect(originRect, targetRect)
        : new DOMRect(targetRect.left, targetRect.top, targetRect.width, targetRect.height);

      setCardViewer({
        overlayId: `${dropId}:${figureId}:${Date.now()}`,
        card,
        loadingImageSrc: fulfillmentInteractiveCardLoadingImageSrc(loadingImageSrc || card.imageSrc),
        originRect: toRevealOverlayRect(resolvedOriginRect),
        targetRect,
        active: false,
        closing: false,
      });
    },
    [dropById],
  );

  const handleCardViewerTransitionEnd = useCallback((evt: TransitionEvent<HTMLDivElement>) => {
    if (evt.target !== evt.currentTarget || evt.propertyName !== 'opacity') return;
    setCardViewer((current) => (current?.closing ? null : current));
  }, []);

  const cardViewerOverlayStyle: CSSProperties | undefined = cardViewer
    ? (ponchoDrifellaRevealOverlayStyleVars({
        originRect: cardViewer.originRect,
        targetRect: cardViewer.targetRect,
        mode: 'poncho-card',
        viewport: getRevealOverlayViewport(),
        cardCount: 1,
      }) as CSSProperties)
    : undefined;

  useEffect(() => {
    walletConnectingSeenRef.current = false;
    setWalletReady(!walletAdapter.wallet || !autoConnectPossible);
  }, [autoConnectPossible, walletAdapter.wallet]);

  useEffect(() => {
    if (!walletAdapter.wallet) return;
    if (!autoConnectPossible) {
      setWalletReady(true);
      return;
    }
    if (walletAdapter.connecting) {
      walletConnectingSeenRef.current = true;
      return;
    }
    if (publicKey || walletConnectingSeenRef.current) {
      setWalletReady(true);
    }
  }, [autoConnectPossible, publicKey, walletAdapter.connecting, walletAdapter.wallet]);

  useEffect(() => {
    authLoadingSeenRef.current = false;
    setAuthReady(!walletAddress);
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;
    if (authLoading) {
      authLoadingSeenRef.current = true;
      return;
    }
    if (profile?.wallet === walletAddress || authLoadingSeenRef.current) {
      setAuthReady(true);
    }
  }, [authLoading, profile?.wallet, walletAddress]);

  useEffect(() => {
    if (!walletAddress) {
      if (selectedDropId) onSelectedDropIdChange('');
      return;
    }
    if (!visibleDrops.length) {
      if (selectedDropId) onSelectedDropIdChange('');
      return;
    }
    if (selectedDropId && !visibleDrops.some((drop) => drop.dropId === selectedDropId)) {
      onSelectedDropIdChange('');
    }
  }, [onSelectedDropIdChange, selectedDropId, visibleDrops, walletAddress]);

  const mergeStatusEdits = useCallback((incoming: FulfillmentOrder[]) => {
    setStatusEdits((prev) => {
      const next = { ...prev };
      incoming.forEach((order) => {
        const key = fulfillmentOrderKey(order);
        if (!(key in next)) {
          next[key] = normalizeFulfillmentStatus(order.fulfillmentStatus);
        }
      });
      return next;
    });
    setTrackingCodeEdits((prev) => {
      const next = { ...prev };
      incoming.forEach((order) => {
        const key = fulfillmentOrderKey(order);
        if (!(key in next)) {
          next[key] = normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode) || '';
        }
      });
      return next;
    });
  }, []);

  const loadInitial = useCallback(async () => {
    if (!hasFulfillmentAccess || !signedIn || !selectedDropIds.length) {
      orderRequestEpochRef.current += 1;
      setLoading(false);
      setLoadingMore(false);
      setOrdersError(null);
      setHasMore(false);
      setCursorsByDropId({});
      setOrders([]);
      setOrderPageKeys([]);
      setManualReviewCheckouts([]);
      setManualReviewMenuOpen(false);
      setStatusEdits({});
      setTrackingCodeEdits({});
      setStatusSaving({});
      setActiveUpdateOrderKey(null);
      return;
    }
    const requestEpoch = orderRequestEpochRef.current + 1;
    orderRequestEpochRef.current = requestEpoch;
    setLoading(true);
    setLoadingMore(false);
    setOrdersError(null);
    setHasMore(true);
    setCursorsByDropId({});
    setOrders([]);
    setOrderPageKeys([]);
    setManualReviewCheckouts([]);
    setManualReviewMenuOpen(false);
    setStatusEdits({});
    setTrackingCodeEdits({});
    setStatusSaving({});
    setActiveUpdateOrderKey(null);
    try {
      const responses = await Promise.all(
        selectedDropIds.map(async (dropId) => {
          const [ordersResp, manualReviewResp] = await Promise.all([
            listFulfillmentOrders({
              limit: FULFILLMENT_ORDER_REQUEST_LIMIT,
              cursor: null,
              dropId,
            }),
            listFulfillmentManualReviewCheckouts({ dropId }).catch((err) => {
              console.warn('[mons] failed to load fulfillment manual-review checkouts', { dropId, error: err });
              return { checkouts: [] as FulfillmentManualReviewCheckout[] };
            }),
          ]);
          return {
            dropId,
            orders: Array.isArray(ordersResp.orders) ? ordersResp.orders : [],
            nextCursor: ordersResp.nextCursor || null,
            manualReviewCheckouts: Array.isArray(manualReviewResp.checkouts) ? manualReviewResp.checkouts : [],
          };
        }),
      );
      if (orderRequestEpochRef.current !== requestEpoch) return;
      const nextCursors = responses.reduce<FulfillmentOrdersCursorByDropId>((acc, resp) => {
        acc[resp.dropId] = resp.nextCursor;
        return acc;
      }, {});
      const nextOrders = sortFulfillmentOrders(dedupeOrdersByKey(responses.flatMap((resp) => resp.orders)));
      const nextManualReviewCheckouts = sortManualReviewCheckouts(
        dedupeManualReviewCheckouts(responses.flatMap((resp) => resp.manualReviewCheckouts)),
      );
      setOrders(nextOrders);
      setOrderPageKeys(nextOrders.length ? [nextOrders.map((order) => fulfillmentOrderKey(order))] : []);
      setManualReviewCheckouts(nextManualReviewCheckouts);
      mergeStatusEdits(nextOrders);
      setCursorsByDropId(nextCursors);
      setHasMore(Object.values(nextCursors).some(Boolean));
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load orders');
      setManualReviewCheckouts([]);
      setManualReviewMenuOpen(false);
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setLoading(false);
      }
    }
  }, [hasFulfillmentAccess, signedIn, selectedDropIds, mergeStatusEdits]);

  const loadMore = useCallback(async () => {
    if (!hasFulfillmentAccess || !signedIn || !selectedDropIds.length || loadingMore || loading || !hasMore) return;
    const dropIdsWithMore = selectedDropIds.filter((dropId) => cursorsByDropId[dropId]);
    if (!dropIdsWithMore.length) {
      setHasMore(false);
      return;
    }
    const requestEpoch = orderRequestEpochRef.current;
    const existingOrderKeys = new Set(orders.map((order) => fulfillmentOrderKey(order)));
    setLoadingMore(true);
    setOrdersError(null);
    try {
      const responses = await Promise.all(
        dropIdsWithMore.map(async (dropId) => {
          const resp = await listFulfillmentOrders({
            limit: FULFILLMENT_ORDER_REQUEST_LIMIT,
            cursor: cursorsByDropId[dropId],
            dropId,
          });
          return { dropId, orders: Array.isArray(resp.orders) ? resp.orders : [], nextCursor: resp.nextCursor || null };
        }),
      );
      if (orderRequestEpochRef.current !== requestEpoch) return;
      const nextCursors = { ...cursorsByDropId };
      responses.forEach((resp) => {
        nextCursors[resp.dropId] = resp.nextCursor;
      });
      const nextOrders = sortFulfillmentOrders(
        dedupeOrdersByKey(
          responses.flatMap((resp) => resp.orders),
          existingOrderKeys,
        ),
      );
      if (nextOrders.length) {
        setOrders((prev) => prev.concat(nextOrders));
        setOrderPageKeys((prev) => prev.concat([nextOrders.map((order) => fulfillmentOrderKey(order))]));
        mergeStatusEdits(nextOrders);
      }
      setCursorsByDropId(nextCursors);
      setHasMore(Object.values(nextCursors).some(Boolean));
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load more orders');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setLoadingMore(false);
      }
    }
  }, [
    hasFulfillmentAccess,
    signedIn,
    selectedDropIds,
    loadingMore,
    loading,
    hasMore,
    cursorsByDropId,
    mergeStatusEdits,
    orders,
  ]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!manualReviewCheckouts.length && manualReviewMenuOpen) {
      setManualReviewMenuOpen(false);
    }
  }, [manualReviewCheckouts.length, manualReviewMenuOpen]);

  const mergeLoadedFigureMetadata = useCallback((records: FigureMetadataRecord[]) => {
    if (!records.length) return;
    setFigureMetadataByKey((prev) => mergeFigureMetadataRecords(prev, records));
  }, []);

  const displayedOrders = useMemo(
    () => {
      if (orderVisibilityFilter === 'all') return orders;
      if (orderVisibilityFilter === 'shipped') {
        return orders.filter((order) => normalizeFulfillmentStatus(order.fulfillmentStatus) === 'Shipped');
      }
      return orders.filter((order) => normalizeFulfillmentStatus(order.fulfillmentStatus) !== 'Shipped');
    },
    [orderVisibilityFilter, orders],
  );
  const displayedSecretCodeCount = useMemo(
    () => countFulfillmentSecretCodeExportEntries(displayedOrders),
    [displayedOrders],
  );

  const orderByKey = useMemo(() => new Map(orders.map((order) => [fulfillmentOrderKey(order), order] as const)), [orders]);
  const displayedOrderKeys = useMemo(() => new Set(displayedOrders.map((order) => fulfillmentOrderKey(order))), [displayedOrders]);

  const groupedOrders = useMemo(() => {
    const groups: FulfillmentOrderGroup[] = [];
    orderPageKeys.forEach((pageOrderKeys, pageIndex) => {
      const visibleGroups = new Map<string, FulfillmentOrder[]>();
      pageOrderKeys.forEach((orderKey) => {
        const order = orderByKey.get(orderKey);
        if (!order) return;
        const groupKey = fulfillmentOrderGroupKey(order);
        if (!displayedOrderKeys.has(orderKey)) return;
        const visibleGroupOrders = visibleGroups.get(groupKey);
        if (visibleGroupOrders) {
          visibleGroupOrders.push(order);
        } else {
          visibleGroups.set(groupKey, [order]);
        }
      });
      visibleGroups.forEach((visibleGroupOrders, groupKey) => {
        groups.push({
          pageIndex,
          groupKey,
          orders: visibleGroupOrders,
          collapseSharedContact: canCollapseFulfillmentOrderGroupContact(visibleGroupOrders),
        });
      });
    });
    return groups;
  }, [displayedOrderKeys, orderByKey, orderPageKeys]);

  const duplicateDropOrders = useMemo(() => {
    if (!duplicateDrop) return [];
    return orders.filter((order) => normalizeDropId(order.dropId) === LITTLE_SWAG_BOXES_DROP_ID);
  }, [duplicateDrop, orders]);

  const displayedDuplicateDropOrders = useMemo(() => {
    if (!duplicateDrop) return [];
    return displayedOrders.filter((order) => normalizeDropId(order.dropId) === LITTLE_SWAG_BOXES_DROP_ID);
  }, [displayedOrders, duplicateDrop]);

  const allDuplicateFigures = useMemo(() => {
    if (!duplicateDrop || !duplicateDropContent || !duplicateDropOrders.length) return [];
    return summarizeDuplicateFigures({
      orders: duplicateDropOrders,
      previewMode: duplicateDropContent.figures.fulfillmentPreviewMode,
      figureMedia: duplicateDrop.figureMedia,
    });
  }, [
    duplicateDrop,
    duplicateDrop?.figureMedia,
    duplicateDropContent,
    duplicateDropContent?.figures.fulfillmentPreviewMode,
    duplicateDropOrders,
  ]);

  const duplicateFigures = useMemo(() => {
    if (!duplicateDrop || !duplicateDropContent || orderVisibilityFilter !== 'not_shipped') return [];
    if (!displayedDuplicateDropOrders.length || !allDuplicateFigures.length) return [];

    const remainingDuplicates = summarizeDuplicateFigures({
      orders: displayedDuplicateDropOrders,
      previewMode: duplicateDropContent.figures.fulfillmentPreviewMode,
      figureMedia: duplicateDrop.figureMedia,
      minimumCount: 1,
    });
    const remainingCountByGroupKey = new Map(remainingDuplicates.map((entry) => [entry.groupKey, entry.count]));

    return allDuplicateFigures
      .map((entry) => {
        const remainingCount = remainingCountByGroupKey.get(entry.groupKey) ?? 0;
        if (remainingCount < 1) return null;
        const adjustedCount = remainingCount === entry.count ? remainingCount - 1 : remainingCount;
        if (adjustedCount < 1) return null;
        return { ...entry, count: adjustedCount };
      })
      .filter((entry): entry is DuplicateFigureSummary => Boolean(entry));
  }, [
    allDuplicateFigures,
    displayedDuplicateDropOrders,
    duplicateDrop,
    duplicateDrop?.figureMedia,
    duplicateDropContent,
    duplicateDropContent?.figures.fulfillmentPreviewMode,
    orderVisibilityFilter,
  ]);

  const duplicateFigureByFigureId = useMemo(
    () => new Map(duplicateFigures.map((entry) => [entry.figureId, entry])),
    [duplicateFigures],
  );

  const fulfillmentFigureMetadataTargets = useMemo(() => {
    const targets = new Map<string, { dropId: string; figureId: number }>();
    const addFigureTarget = (drop: FrontendDeploymentConfig, figureId: number) => {
      const dropContent = resolveDropContent(drop);
      const shouldUseMetadataFallback = dropContent.figures.fulfillmentPreviewMode === 'metadata_stills';
      if (!shouldUseMetadataFallback) {
        const hasMappedMedia = Boolean(
          dropContent.figures.fulfillmentMediaBaseUrl && getMediaIdForFigureId(figureId, drop.figureMedia),
        );
        if (hasMappedMedia) return;
      }
      const key = figureMetadataCacheKey(drop.dropId, figureId);
      const cached = figureMetadataByKey[key] || getCachedFigureMetadata(drop.dropId, figureId);
      if (figureMetadataHasImage(cached)) return;
      targets.set(key, { dropId: drop.dropId, figureId });
    };

    displayedOrders.forEach((order) => {
      const drop = dropById.get(order.dropId);
      if (!drop) return;
      listOrderFigureIds(order).forEach((figureId) => {
        const normalizedFigureId = Math.floor(Number(figureId));
        if (!Number.isFinite(normalizedFigureId) || normalizedFigureId <= 0) return;
        addFigureTarget(drop, normalizedFigureId);
      });
    });
    if (duplicateDrop) {
      duplicateFigures.forEach(({ figureId }) => {
        const normalizedFigureId = Math.floor(Number(figureId));
        if (!Number.isFinite(normalizedFigureId) || normalizedFigureId <= 0) return;
        addFigureTarget(duplicateDrop, normalizedFigureId);
      });
    }
    return Array.from(targets.values());
  }, [
    duplicateFigures,
    displayedOrders,
    dropById,
    duplicateDrop,
    figureMetadataByKey,
  ]);

  useEffect(() => {
    if (!fulfillmentFigureMetadataTargets.length) return;
    let cancelled = false;
    const fetchMetadata = async () => {
      try {
        const records = await loadFigureMetadataBatch(fulfillmentFigureMetadataTargets);
        if (cancelled || !records.length) return;
        mergeLoadedFigureMetadata(records);
      } catch (err) {
        console.warn('[mons] failed to load fulfillment figure metadata', { error: err });
      }
    };

    void fetchMetadata();
    if (typeof window === 'undefined') return;
    const interval = window.setInterval(() => {
      void fetchMetadata();
    }, FIGURE_METADATA_RETRY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fulfillmentFigureMetadataTargets, mergeLoadedFigureMetadata]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasFulfillmentAccess || !signedIn || !selectedDropIds.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasFulfillmentAccess, signedIn, selectedDropIds, loadMore]);

  const handleSaveStatus = useCallback(
    async (orderToUpdate: FulfillmentOrder) => {
      if (!hasFulfillmentAccess || !signedIn) return false;
      const requestEpoch = orderRequestEpochRef.current;
      const key = fulfillmentOrderKey(orderToUpdate);
      setStatusSaving((prev) => ({ ...prev, [key]: true }));
      setOrdersError(null);
      try {
        const nextStatus = normalizeFulfillmentStatus(statusEdits[key]);
        const nextTrackingCode =
          nextStatus === 'Shipped' ? sanitizeFulfillmentTrackingCode(trackingCodeEdits[key]) : undefined;
        const resp = await updateFulfillmentStatus(
          orderToUpdate.deliveryId,
          nextStatus,
          orderToUpdate.dropId,
          nextTrackingCode,
        );
        if (orderRequestEpochRef.current !== requestEpoch) return false;
        const normalized = normalizeFulfillmentStatus(resp.fulfillmentStatus || nextStatus);
        const responseTrackingCode = normalizeOptionalFulfillmentTrackingCode(resp.fulfillmentTrackingCode);
        setOrders((prev) =>
          prev.map((order) =>
            fulfillmentOrderKey(order) === key
              ? {
                  ...order,
                  fulfillmentStatus: normalized || undefined,
                  fulfillmentTrackingCode:
                    normalized === 'Shipped'
                      ? responseTrackingCode
                      : responseTrackingCode || normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
                }
              : order,
          ),
        );
        setStatusEdits((prev) => ({ ...prev, [key]: normalized }));
        setTrackingCodeEdits((prev) => ({
          ...prev,
          [key]:
            normalized === 'Shipped'
              ? responseTrackingCode || ''
              : responseTrackingCode || normalizeOptionalFulfillmentTrackingCode(orderToUpdate.fulfillmentTrackingCode) || '',
        }));
        return true;
      } catch (err) {
        if (orderRequestEpochRef.current !== requestEpoch) return false;
        console.error(err);
        setOrdersError(err instanceof Error ? err.message : 'Failed to update status');
        return false;
      } finally {
        if (orderRequestEpochRef.current === requestEpoch) {
          setStatusSaving((prev) => ({ ...prev, [key]: false }));
        }
      }
    },
    [hasFulfillmentAccess, signedIn, statusEdits, trackingCodeEdits],
  );

  const statusDirty = useMemo(() => {
    const dirty = new Set<string>();
    orders.forEach((order) => {
      const key = fulfillmentOrderKey(order);
      const current = normalizeFulfillmentStatus(order.fulfillmentStatus);
      const edited = statusEdits[key] ?? '';
      const currentTrackingCode = normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode) || '';
      const editedTrackingCode = sanitizeFulfillmentTrackingCode(trackingCodeEdits[key]);
      if (current !== edited || (edited === 'Shipped' && currentTrackingCode !== editedTrackingCode)) dirty.add(key);
    });
    return dirty;
  }, [orders, statusEdits, trackingCodeEdits]);

  const activeUpdateOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeUpdateOrderKey) ?? null,
    [activeUpdateOrderKey, orders],
  );
  const activeUpdateOrderKeyResolved = activeUpdateOrder ? fulfillmentOrderKey(activeUpdateOrder) : '';
  const activeUpdateText = activeUpdateOrder
    ? statusEdits[activeUpdateOrderKeyResolved] ?? normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus)
    : '';
  const activeUpdateTrackingCode = activeUpdateOrder
    ? trackingCodeEdits[activeUpdateOrderKeyResolved] ??
      normalizeOptionalFulfillmentTrackingCode(activeUpdateOrder.fulfillmentTrackingCode) ??
      ''
    : '';
  const activeUpdateDirty = activeUpdateOrder ? statusDirty.has(activeUpdateOrderKeyResolved) : false;
  const activeUpdateSaving = activeUpdateOrder ? Boolean(statusSaving[activeUpdateOrderKeyResolved]) : false;

  const handleOpenUpdateModal = useCallback((orderKey: string) => {
    setActiveUpdateOrderKey(orderKey);
  }, []);

  const handleCancelUpdate = useCallback(() => {
    if (!activeUpdateOrder) {
      setActiveUpdateOrderKey(null);
      return;
    }
    const key = fulfillmentOrderKey(activeUpdateOrder);
    setStatusEdits((prev) => ({
      ...prev,
      [key]: normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus),
    }));
    setTrackingCodeEdits((prev) => ({
      ...prev,
      [key]: normalizeOptionalFulfillmentTrackingCode(activeUpdateOrder.fulfillmentTrackingCode) || '',
    }));
    setActiveUpdateOrderKey(null);
  }, [activeUpdateOrder]);

  const handleSaveActiveUpdate = useCallback(async () => {
    if (!activeUpdateOrder) return;
    if (!activeUpdateDirty) {
      setActiveUpdateOrderKey(null);
      return;
    }
    const ok = await handleSaveStatus(activeUpdateOrder);
    if (ok) setActiveUpdateOrderKey(null);
  }, [activeUpdateDirty, activeUpdateOrder, handleSaveStatus]);

  const handleSolanaSignIn = useCallback(() => {
    if (authLoading) return;
    if (!publicKey) {
      setPendingSignIn(true);
      setWalletModalVisible(true);
      return;
    }
    if (!walletHasFulfillmentAccess || signedIn) return;
    void signIn();
  }, [authLoading, publicKey, setWalletModalVisible, signIn, signedIn, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || !publicKey) return;
    if (!walletHasFulfillmentAccess || signedIn) {
      setPendingSignIn(false);
      return;
    }
    if (authLoading) return;
    setPendingSignIn(false);
    void signIn();
  }, [authLoading, pendingSignIn, publicKey, signIn, signedIn, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || walletModalVisible || publicKey) return;
    setPendingSignIn(false);
  }, [pendingSignIn, publicKey, walletModalVisible]);

  const hasVisibleOrderCards = duplicateFigures.length > 0 || groupedOrders.length > 0;
  const showManualReviewDropId = selectedDropIds.length > 1;

  const downloadDisplayedOrders = useCallback(() => {
    const filename = buildFulfillmentExportFilename({
      kind: 'orders',
      selectedDropId,
      orderVisibilityFilter,
    });
    const payload = buildFulfillmentOrdersExport(displayedOrders, { dropById, figureMetadataByKey });
    downloadJsonFile(filename, payload);
    setExportMenuOpen(false);
  }, [displayedOrders, dropById, figureMetadataByKey, orderVisibilityFilter, selectedDropId]);

  const downloadDisplayedAddresses = useCallback(() => {
    const filename = buildFulfillmentExportFilename({
      kind: 'addresses-sensitive',
      selectedDropId,
      orderVisibilityFilter,
    });
    const payload = buildFulfillmentAddressExport(displayedOrders);
    downloadJsonFile(filename, payload);
    setExportMenuOpen(false);
  }, [displayedOrders, orderVisibilityFilter, selectedDropId]);

  const downloadDisplayedSecretCodes = useCallback(async () => {
    setExportMenuOpen(false);
    if (secretCodesExporting || !displayedSecretCodeCount) return;

    setSecretCodesExporting(true);
    setSecretCodesExportProgress(0);
    setOrdersError(null);
    try {
      const filename = buildFulfillmentExportFilename({
        kind: 'secret-codes',
        selectedDropId,
        orderVisibilityFilter,
      });
      let exportFigureMetadataByKey = figureMetadataByKey;
      if (fulfillmentFigureMetadataTargets.length) {
        const records = await loadFigureMetadataBatch(fulfillmentFigureMetadataTargets);
        if (records.length) {
          mergeLoadedFigureMetadata(records);
          exportFigureMetadataByKey = mergeFigureMetadataRecords(exportFigureMetadataByKey, records);
        }
      }
      const exportEntries = buildFulfillmentSecretCodeExportEntries(displayedOrders, {
        dropById,
        figureMetadataByKey: exportFigureMetadataByKey,
      });
      const zipBlob = await buildSecretCodesZipBlob(exportEntries, setSecretCodesExportProgress);
      setSecretCodesExportProgress(100);
      downloadBlobFile(filename, zipBlob);
    } catch (err) {
      console.error('[mons] failed to export fulfillment secret code PNGs', err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to export fulfillment secret code PNGs');
    } finally {
      setSecretCodesExporting(false);
      setSecretCodesExportProgress(0);
    }
  }, [
    displayedSecretCodeCount,
    displayedOrders,
    dropById,
    figureMetadataByKey,
    fulfillmentFigureMetadataTargets,
    mergeLoadedFigureMetadata,
    orderVisibilityFilter,
    secretCodesExporting,
    selectedDropId,
  ]);

  const secretCodesExportPercent = Math.max(0, Math.min(100, Math.round(secretCodesExportProgress)));

  const renderManualReviewMenu = () => (
    <div className="manual-review-menu" role="dialog" aria-label="Needs manual review">
      <div className="manual-review-menu__head">
        <div className="manual-review-menu__title">Needs manual review</div>
        <div className="muted small">
          {manualReviewCheckouts.length} {manualReviewCheckouts.length === 1 ? 'checkout' : 'checkouts'}
        </div>
      </div>
      <div className="manual-review-menu__list">
        {manualReviewCheckouts.map((checkout) => {
          const addressText = formatFulfillmentAddressText(checkout.address);
          const contactEmail = checkout.address.full !== '***' ? checkout.address.email : '';
          const quantityText = typeof checkout.quantity === 'number' ? `${checkout.quantity} item${checkout.quantity === 1 ? '' : 's'}` : 'Quantity pending';
          const ownerText = checkout.owner || checkout.firebaseUid || 'Owner unavailable';
          return (
            <div key={manualReviewCheckoutKey(checkout)} className="manual-review-row">
              <div className="manual-review-row__top">
                <div className="manual-review-row__title">
                  {showManualReviewDropId ? `${checkout.dropId} · ` : ''}
                  {quantityText} · {formatManualReviewAmount(checkout.amountTotal, checkout.currency)}
                </div>
                <div className="muted small">{formatOrderDate(checkout.failedAt || checkout.createdAt)}</div>
              </div>
              <div className="manual-review-row__meta">
                <span className="mono small">{shortenStripeSessionId(checkout.sessionId)}</span>
                <span className="mono small">{ownerText}</span>
              </div>
              {contactEmail ? <div className="manual-review-contact small">{contactEmail}</div> : null}
              <div className="manual-review-address small">{addressText || 'Address unavailable'}</div>
              <div className="manual-review-reason small">{manualReviewIssueText(checkout)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderExportMenu = () => (
    <div className="fulfillment-export-menu" role="menu" aria-label="Fulfillment exports">
      <button
        type="button"
        className="fulfillment-export-menu__item"
        role="menuitem"
        onClick={downloadDisplayedOrders}
      >
        <FiDownload aria-hidden="true" />
        <span>Download Orders</span>
      </button>
      <button
        type="button"
        className="fulfillment-export-menu__item"
        role="menuitem"
        onClick={downloadDisplayedSecretCodes}
        disabled={secretCodesExporting || !displayedSecretCodeCount}
      >
        <FiDownload aria-hidden="true" />
        <span>{secretCodesExporting ? 'Preparing Secret Codes ZIP…' : 'Download Secret Codes ZIP'}</span>
      </button>
      <button
        type="button"
        className="fulfillment-export-menu__item"
        role="menuitem"
        onClick={downloadDisplayedAddresses}
      >
        <FiDownload aria-hidden="true" />
        <span>Download Addresses [SENSITIVE]</span>
      </button>
    </div>
  );

  const renderFulfillmentOrderSection = (
    order: FulfillmentOrder,
    options?: { showContactInfo?: boolean; showFullAddress?: boolean },
  ) => {
    const orderDrop = dropById.get(order.dropId);
    if (!orderDrop) return null;
    const orderKey = fulfillmentOrderKey(order);
    const orderDropContent = resolveDropContent(orderDrop);
    const orderFigureMediaBase = orderDropContent.figures.fulfillmentMediaBaseUrl;
    const orderIsDirectDeliveryDrop = isDirectDeliveryItemsPerBox(orderDrop.itemsPerBox);
    const orderShowsFulfillmentPackPreview = isDropFamily(orderDrop, 'card_nft_2');
    const showContactInfo = options?.showContactInfo ?? true;
    const showFullAddress = options?.showFullAddress ?? true;
    return (
      <div key={orderKey} className="fulfillment-order-section">
        <div className="card__head">
          <div>
            <div className="card__title">Order {order.deliveryId}</div>
            <div className="muted fulfillment-order-date small">{formatOrderDate(order.processedAt || order.createdAt)}</div>
            {showContactInfo && order.address.full !== '***' && order.address.email ? (
              <div className="muted small">{order.address.email}</div>
            ) : null}
            {showContactInfo && order.address.full !== '***' && order.address.phone ? (
              <div className="muted small">{order.address.phone}</div>
            ) : null}
          </div>
          <div className="order-update">
            {(() => {
              const statusText = normalizeFulfillmentStatus(order.fulfillmentStatus);
              const trackingCode = shouldDisplayFulfillmentTrackingCode(order.fulfillmentStatus, order.fulfillmentTrackingCode)
                ? normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode)
                : '';
              const trackingHref = resolveFulfillmentTrackingHref(trackingCode);
              return statusText ? (
                <>
                  <div className="status-readout fulfillment-order-status-text small">{statusText}</div>
                  {trackingCode ? (
                    trackingHref ? (
                      <a className="tracking-link small" href={trackingHref} target="_blank" rel="noopener noreferrer">
                        Tracking
                      </a>
                    ) : (
                      <div className="tracking-code-readout mono small">{trackingCode}</div>
                    )
                  ) : null}
                </>
              ) : (
                <em className="muted fulfillment-order-status-text small">Not set</em>
              );
            })()}
            <button
              type="button"
              className="link fulfillment-order-status-action small no-focus-style"
              onClick={() => handleOpenUpdateModal(orderKey)}
            >
              {normalizeFulfillmentStatus(order.fulfillmentStatus) ? 'Edit status' : 'Set status'}
            </button>
          </div>
        </div>

        <div className="order-items">
          {showFullAddress ? (
            <div className="address-lines">
              {order.address.full ? (
                <div className="address-text">
                  {formatFulfillmentAddressText(order.address)}
                </div>
              ) : (
                <>
                  <div className="muted small">Encrypted address payload</div>
                  <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                </>
              )}
            </div>
          ) : null}

          {order.boxes.length ? (
            orderIsDirectDeliveryDrop ? (
              renderBoxTiles({
                boxIds: order.boxes.map((box) => box.boxId),
                keyPrefix: `${orderKey}:box`,
                labelSource: orderDrop,
                getPreviewSrc: (boxId) => normalizeBoxDisplayImage({ dropId: orderDrop.dropId, boxId }),
                secretCodeByBoxId: new Map(
                  order.boxes
                    .map((box) => [box.boxId, fulfillmentBoxSecretCode(box)] as const)
                    .filter(([, secretCode]) => secretCode),
                ),
              })
            ) : (
              <div className="box-contents-list">
                {order.boxes.map((box) => {
                  const secretCode = fulfillmentBoxSecretCode(box);
                  const packSecretImage = orderShowsFulfillmentPackPreview
                    ? renderFulfillmentPackSecretImage({
                        dropId: orderDrop.dropId,
                        boxId: box.boxId,
                      })
                    : null;
                  return (
                    <div
                      key={`${orderKey}:${box.boxId}`}
                      className="card subtle box-contents"
                      style={getBoxContentsStyle(box.dudeIds.length)}
                    >
                      <div className="card__title">
                        {secretCode ? (
                          <span className="fulfillment-pack-secret">
                            {packSecretImage}
                            <span>
                              {fulfillmentBoxSecretLabelPrefix(orderDrop)}{' '}
                              <span className="fulfillment-secret-code">{secretCode}</span>
                            </span>
                          </span>
                        ) : (
                          fulfillmentBoxContentsLabel(orderDrop, box.boxId, '')
                        )}
                      </div>
                      {!secretCode ? (
                        <div className="muted small">Secret code unavailable</div>
                      ) : !box.dudeIds.length ? (
                        <div className="muted small">Assigned {dropAssetLabel(orderDrop, 'figure', 2)} pending</div>
                      ) : null}
                      {box.dudeIds.length ? (
                        renderFigureTiles({
                          dropId: orderDrop.dropId,
                          drop: orderDrop,
                          figureIds: box.dudeIds,
                          keyPrefix: `${orderKey}:${box.boxId}`,
                          figureNamePrefix: orderDrop.figureNamePrefix,
                          previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                          figureMediaBase: orderFigureMediaBase,
                          figureMedia: orderDrop.figureMedia,
                          figureMetadataByKey,
                          onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                          onViewInteractiveCard: openInteractiveCardViewer,
                        })
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          {order.looseDudes.length
            ? renderFigureTiles({
                dropId: orderDrop.dropId,
                drop: orderDrop,
                figureIds: order.looseDudes,
                keyPrefix: `${orderKey}:dude`,
                figureNamePrefix: orderDrop.figureNamePrefix,
                previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                figureMediaBase: orderFigureMediaBase,
                figureMedia: orderDrop.figureMedia,
                figureMetadataByKey,
                onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                onViewInteractiveCard: openInteractiveCardViewer,
              })
            : null}
        </div>
      </div>
    );
  };

  return (
    <div className="page fulfillment-page">
      {cardViewer ? (
        <PonchoCardViewerOverlay
          overlayStyle={cardViewerOverlayStyle}
          active={cardViewer.active}
          closing={cardViewer.closing}
          card={cardViewer.card}
          loadingImageSrc={cardViewer.loadingImageSrc}
          onDismiss={dismissCardViewer}
          onTransitionEnd={handleCardViewerTransitionEnd}
        />
      ) : null}
      <ShopHeader scrollHomeToTop />

      {!walletBusy && walletReady && (walletAddress ? (!walletHasFulfillmentAccess || authReady) : true) ? (
        !walletAddress ? (
          <section className="card">
            <button type="button" onClick={handleSolanaSignIn} disabled={authLoading}>
              {authLoading ? 'Signing in…' : 'Sign in with Solana'}
            </button>
          </section>
        ) : !walletHasFulfillmentAccess ? (
          <section className="card">
            <div className="card__title">Access denied</div>
            <p className="muted small">This wallet is not authorized for fulfillment.</p>
          </section>
        ) : !signedIn ? (
          <section className="card">
            <button type="button" onClick={handleSolanaSignIn} disabled={authLoading}>
              {authLoading ? 'Signing in…' : 'Sign in with Solana'}
            </button>
          </section>
        ) : (
          <section className="orders">
            <div className="row fulfillment-orders-toolbar">
              <select
                id="fulfillment-drop-picker"
                className="fulfillment-drop-picker"
                aria-label="Drop"
                value={selectedDropId}
                onChange={(evt) => {
                  setOrderVisibilityFilter(DEFAULT_ORDER_VISIBILITY_FILTER);
                  onSelectedDropIdChange(evt.target.value);
                }}
              >
                <option value="">All drops</option>
                {visibleDrops.map((drop) => (
                  <option key={drop.dropId} value={drop.dropId}>
                    {drop.dropId}
                  </option>
                ))}
              </select>
              {selectedDropIds.length ? (
                <select
                  id="fulfillment-orders-filter-picker"
                  className="fulfillment-drop-picker fulfillment-orders-filter-picker"
                  aria-label="Order filter"
                  value={orderVisibilityFilter}
                  onChange={(evt) => {
                    setOrderVisibilityFilter(evt.target.value as OrderVisibilityFilter);
                  }}
                >
                  {ORDER_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {selectedDropIds.length ? (
                <div className="fulfillment-toolbar-actions">
                  {manualReviewCheckouts.length ? (
                    <div className="manual-review-menu-wrap" ref={manualReviewMenuRef}>
                      <button
                        type="button"
                        className="manual-review-button"
                        aria-label={`Needs manual review, ${manualReviewCheckouts.length} ${
                          manualReviewCheckouts.length === 1 ? 'checkout' : 'checkouts'
                        }`}
                        aria-haspopup="dialog"
                        aria-expanded={manualReviewMenuOpen}
                        title="Needs manual review"
                        onClick={() => {
                          setExportMenuOpen(false);
                          setManualReviewMenuOpen((open) => !open);
                        }}
                      >
                        <FiAlertTriangle aria-hidden="true" />
                        <span>{manualReviewCheckouts.length}</span>
                      </button>
                      {manualReviewMenuOpen ? renderManualReviewMenu() : null}
                    </div>
                  ) : null}
                  <div className="fulfillment-export-menu-wrap" ref={exportMenuRef}>
                    <button
                      type="button"
                      className={`fulfillment-more-button${exportMenuOpen ? ' fulfillment-more-button--active' : ''}`}
                      aria-label="Fulfillment export menu"
                      aria-haspopup="menu"
                      aria-expanded={exportMenuOpen}
                      title="More"
                      onClick={() => {
                        setManualReviewMenuOpen(false);
                        setExportMenuOpen((open) => !open);
                      }}
                    >
                      <FiMoreHorizontal aria-hidden="true" />
                    </button>
                    {exportMenuOpen ? renderExportMenu() : null}
                  </div>
                </div>
              ) : null}
            </div>
            {selectedDropIds.length && loading && !hasVisibleOrderCards ? <div className="muted small">Loading orders…</div> : null}
            {selectedDropIds.length && ordersError ? <div className="error">{ordersError}</div> : null}
            {selectedDropIds.length && hasVisibleOrderCards ? (
              <div className="order-list">
                {duplicateDrop && duplicateDropContent && duplicateFigures.length ? (
                  <div key={`${duplicateDrop.dropId}:duplicates`} className="card subtle">
                    <div className="card__head">
                      <div className="card__title">New Duplicates</div>
                    </div>
                    <div className="order-items">
                      {renderFigureTiles({
                        dropId: duplicateDrop.dropId,
                        drop: duplicateDrop,
                        figureIds: duplicateFigures.map((entry) => entry.figureId),
                        keyPrefix: 'duplicates',
                        figureNamePrefix: duplicateDrop.figureNamePrefix,
                        previewMode: duplicateDropContent.figures.fulfillmentPreviewMode,
                        figureMediaBase: duplicateFigureMediaBase,
                        figureMedia: duplicateDrop.figureMedia,
                        figureMetadataByKey,
                        onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                        onViewInteractiveCard: openInteractiveCardViewer,
                        labelOverride: ({ figureId, mediaId }) => {
                          const duplicate = duplicateFigureByFigureId.get(figureId);
                          const labelId = duplicate?.labelId || (mediaId ? String(mediaId) : String(figureId));
                          const count = duplicate?.count || 0;
                          return `${labelId} x ${count}`;
                        },
                      })}
                    </div>
                  </div>
                ) : null}
                {groupedOrders.map((group) => (
                  <div
                    key={`${group.pageIndex}:${group.groupKey}`}
                    className="card subtle fulfillment-order-group"
                  >
                    {group.orders.map((order, index) =>
                      renderFulfillmentOrderSection(order, {
                        showContactInfo: !group.collapseSharedContact || index === 0,
                        showFullAddress: !group.collapseSharedContact || index === 0,
                      }),
                    )}
                  </div>
                ))}
              </div>
            ) : selectedDropIds.length && loading ? null : selectedDropIds.length ? (
              <div className="muted small">
                {orderVisibilityFilter === 'all'
                  ? 'No orders.'
                  : orderVisibilityFilter === 'shipped'
                    ? 'No shipped orders.'
                    : 'No unshipped orders.'}
              </div>
            ) : null}

            {selectedDropIds.length && loadingMore ? <div className="muted small">Loading more…</div> : null}
            <div ref={sentinelRef} />
          </section>
        )
      ) : null}

      {secretCodesExporting ? (
        <div className="fulfillment-export-progress" role="status" aria-live="polite" aria-busy="true">
          <div className="fulfillment-export-progress__panel">
            <div className="fulfillment-export-progress__title">Exporting Secret Codes ZIP</div>
            <div className="fulfillment-export-progress__percent">{secretCodesExportPercent}%</div>
            <div className="muted small">
              {displayedSecretCodeCount} {displayedSecretCodeCount === 1 ? 'PNG' : 'PNGs'}
            </div>
          </div>
        </div>
      ) : null}

      <Modal
        open={activeUpdateOrderKey !== null}
        title={activeUpdateOrder ? `Order ${activeUpdateOrder.deliveryId}` : 'Order'}
        onClose={handleCancelUpdate}
        showCloseButton={false}
      >
        <div className="modal-form">
          <select
            className="status-input"
            value={activeUpdateText}
            onChange={(evt) => {
              if (!activeUpdateOrder) return;
              const nextStatus = normalizeFulfillmentStatus(evt.target.value);
              setStatusEdits((prev) => ({ ...prev, [fulfillmentOrderKey(activeUpdateOrder)]: nextStatus }));
            }}
            aria-label="Fulfillment status"
          >
            <option value="">Not set</option>
            {FULFILLMENT_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          {activeUpdateText === 'Shipped' ? (
            <input
              className="tracking-input"
              value={activeUpdateTrackingCode}
              onChange={(evt) => {
                if (!activeUpdateOrder) return;
                setTrackingCodeEdits((prev) => ({
                  ...prev,
                  [fulfillmentOrderKey(activeUpdateOrder)]: evt.target.value,
                }));
              }}
              placeholder="Tracking link"
              aria-label="Tracking link"
              autoComplete="off"
            />
          ) : null}
          <div className="row row--end">
            <button type="button" className="ghost" onClick={handleCancelUpdate}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveActiveUpdate()}
              disabled={!activeUpdateOrder || activeUpdateSaving || !activeUpdateDirty}
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      {authError ? <div className="error">{authError}</div> : null}
    </div>
  );
}
