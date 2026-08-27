import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { FiAlertTriangle, FiDownload, FiEdit2, FiMoreHorizontal } from 'react-icons/fi';
import {
  addFulfillmentOrderToShipStation,
  fulfillmentShipStationAddressCorrectionDetails,
  getFulfillmentShipStationLabel,
  getFulfillmentShipStationRates,
  listFulfillmentManualReviewCheckouts,
  listFulfillmentOrders,
  purchaseFulfillmentShipStationLabel,
  updateFulfillmentAddress,
  updateFulfillmentStatus,
  voidFulfillmentShipStationLabel,
} from './api/fulfillment';
import {
  FulfillmentManualReviewCheckout,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  FulfillmentShipStationInvalidRate,
  FulfillmentShipStationRate,
  FulfillmentStatus,
  ShipStationMoney,
  ShipStationEditableAddressField,
  ShipStationPackageInput,
} from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { useOverlayScrollLock } from './hooks/useOverlayScrollLock';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import {
  loadFigureMetadata,
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from './lib/figureMetadata';
import { normalizeBoxDisplayImage, resolveBoxMediaIdForDrop, resolveDropContent } from './lib/dropContent';
import { dropAssetLabel } from './lib/dropLabels';
import {
  fulfillmentBoxSecretCode,
  fulfillmentCardClaimSecretCode,
  fulfillmentLooseFigureIdsExcludingCardClaims,
  fulfillmentOrderLooseFigureIds,
  isUsedReceiptClaimStatus,
} from './lib/fulfillmentCodes';
import { isDirectDeliveryItemsPerBox } from '../shared/shipping.ts';
import { CARD_NFT_2_PACK_IMAGES } from './lib/cardNft2Packs';
import { Modal } from './components/Modal';
import { ShopHeader } from './components/ShopHeader';
import { BodyPortal } from './components/BackgroundBlurLayer';
import {
  buildFulfillmentAddressExport,
  buildFulfillmentCardClaimSecretCodeExportEntry,
  buildFulfillmentExportFilename,
  buildFulfillmentOrdersExport,
  buildFulfillmentSecretCodeExportEntry,
  buildFulfillmentSecretCodeExportEntries,
  countFulfillmentSecretCodeExportEntries,
  formatFulfillmentAddressText,
  type FulfillmentSecretCodeExportEntry,
} from './lib/fulfillmentExports';
import {
  fulfillmentBoxContentsLabel,
  resolveFulfillmentDirectDeliveryBoxLabel,
  resolveFulfillmentFigurePreview,
  type FulfillmentFigureLabelOverrideArgs,
} from './lib/fulfillmentLabels';
import { FULFILLMENT_STATUS_OPTIONS, normalizeFulfillmentStatus } from './lib/fulfillmentStatus';
import {
  DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER,
  FULFILLMENT_ORDER_VISIBILITY_OPTIONS,
  canEditFulfillmentOrderAddress,
  filterFulfillmentOrdersByVisibility,
  isRedeemedForIrlFulfillmentOrder,
  type FulfillmentOrderVisibilityFilter,
} from './lib/fulfillmentOrderVisibility';
import {
  fulfillmentShipStationDeliveryText,
  groupFulfillmentShipStationRates,
  prepareFulfillmentShipStationRates,
} from './lib/fulfillmentShipStationRates';
import {
  fulfillmentShipStationAddressCanRetry,
  fulfillmentShipStationAddressCorrectionFailure,
  fulfillmentShipStationAddressDraft,
  fulfillmentShipStationAddressOtherFailure,
  fulfillmentShipStationAddressPatch,
  type FulfillmentShipStationAddressCorrectionSession,
} from './lib/fulfillmentShipStationAddress';
import {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode,
  shouldDisplayFulfillmentTrackingCode,
} from '../shared/fulfillmentTracking.ts';
import {
  isDropFamily,
  listFrontendDrops,
  normalizeDropId,
  type FigureMediaConfig,
  type FrontendDeploymentConfig,
} from './config/deployment';
import { hasFulfillmentAddressAdminAccess, listAllowedFulfillmentDropIds } from './lib/fulfillmentAccess';
import { walletSessionSignInReadiness } from './lib/profileClientLifecycle';
import {
  defaultShipStationPackage,
  normalizeShipStationPackage,
  SHIPSTATION_PACKAGE_RANGE_MESSAGE,
} from '../shared/shipstationPackage.js';
import { buildShipStationCustomsDeclaration } from '../shared/shipstationCustoms.js';
import {
  dedupeManualReviewCheckouts,
  formatManualReviewAmount,
  formatOrderDate,
  manualReviewCheckoutKey,
  manualReviewIssueText,
  shortenStripeSessionId,
  sortManualReviewCheckouts,
} from './fulfillment/manualReview';
import {
  dedupeOrdersByKey,
  fulfillmentOrderKey,
  groupFulfillmentOrders,
  sortFulfillmentOrders,
} from './fulfillment/orders';
import {
  collectFulfillmentFigureMetadataTargets,
  mergeFigureMetadataRecords,
} from './fulfillment/figureMetadata';

const FULFILLMENT_ORDER_REQUEST_LIMIT = 1000;
const SHIPSTATION_AWAITING_SHIPMENT_URL = 'https://ship.shipstation.com/orders/awaiting-shipment';
const LITTLE_SWAG_BOXES_DROP_ID = 'little_swag_boxes';
const FIGURE_METADATA_RETRY_MS = 3000;
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
type QRCodeModule = typeof import('qrcode');
type SecretCodesZipProgressHandler = (percent: number) => void;
type SecretCodePreviewImageCache = Map<string, Promise<HTMLImageElement>>;
type FulfillmentSecretCodeDownloadTarget =
  | { kind: 'box'; index: number }
  | { kind: 'card-claim'; index: number };

type ShipStationPackageDraft = { length: string; width: string; height: string; weight: string };

const SHIPSTATION_PACKAGE_FIELDS: { key: keyof ShipStationPackageDraft; label: string; ariaLabel: string }[] = [
  { key: 'length', label: 'L in', ariaLabel: 'Package length in inches' },
  { key: 'width', label: 'W in', ariaLabel: 'Package width in inches' },
  { key: 'height', label: 'H in', ariaLabel: 'Package height in inches' },
  { key: 'weight', label: 'oz', ariaLabel: 'Package weight in ounces' },
];

const SHIPSTATION_ADDRESS_FIELDS: Record<
  ShipStationEditableAddressField,
  { label: string; autoComplete: string; optional?: boolean }
> = {
  name: { label: 'Recipient name', autoComplete: 'name' },
  address_line1: { label: 'Address line 1', autoComplete: 'address-line1' },
  address_line2: { label: 'Address line 2', autoComplete: 'address-line2', optional: true },
  address_line3: { label: 'Address line 3', autoComplete: 'address-line3', optional: true },
  city_locality: { label: 'City', autoComplete: 'address-level2' },
  state_province: { label: 'State / province', autoComplete: 'address-level1' },
  postal_code: { label: 'Postal code', autoComplete: 'postal-code' },
  country_code: { label: 'Country code', autoComplete: 'country' },
};

function defaultShipStationPackageDraft(order: FulfillmentOrder): ShipStationPackageDraft {
  const parcel = defaultShipStationPackage(order.boxes.length + order.looseDudes.length);
  const countryCode = String(order.address.countryCode || '').trim().toUpperCase();
  if (!countryCode || countryCode === 'US') return shipStationPackageDraft(parcel);
  const declaration = buildShipStationCustomsDeclaration(
    order.dropId,
    order.boxes.length,
    order.looseDudes.length,
  );
  return shipStationPackageDraft(
    declaration && parcel.weight < declaration.minimumPackageWeightOunces
      ? { ...parcel, weight: declaration.minimumPackageWeightOunces }
      : parcel,
  );
}

function shipStationPackageDraft(parcel: ShipStationPackageInput): ShipStationPackageDraft {
  return {
    length: String(parcel.length),
    width: String(parcel.width),
    height: String(parcel.height),
    weight: String(parcel.weight),
  };
}

function formatShipStationMoney(money: ShipStationMoney | undefined): string {
  if (!money) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: money.currency.toUpperCase(),
    }).format(money.amount);
  } catch {
    return `${money.amount.toFixed(2)} ${money.currency.toUpperCase()}`;
  }
}

function ShipStationRateOption({
  rate,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  rate: FulfillmentShipStationRate;
  detail?: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={`shipstation-rate-option${selected ? ' shipstation-rate-option--selected' : ''}`}>
      <input
        type="radio"
        name="shipstation-rate"
        value={rate.rateId}
        checked={selected}
        onChange={onSelect}
        disabled={disabled}
      />
      <span className="shipstation-rate-option__body">
        <span className="shipstation-rate-option__main">
          <span>
            <strong>{rate.carrierName}</strong>
            <span className="muted"> · {rate.serviceName}</span>
          </span>
          <strong>{formatShipStationMoney(rate.totalAmount)}</strong>
        </span>
        {detail ? <span className="muted small">{detail}</span> : null}
        <span className="muted small">
          {fulfillmentShipStationDeliveryText(rate)}
          {rate.guaranteedService ? ' · Guaranteed' : ''}
        </span>
        {rate.warningMessages.map((warning, warningIndex) => (
          <span key={`${rate.rateId}:${warningIndex}`} className="shipstation-rate-option__warning small">
            {warning}
          </span>
        ))}
      </span>
    </label>
  );
}

function isActiveShipStationLabel(label: FulfillmentOrder['shipstationLabel']): boolean {
  return label?.status === 'completed' || label?.status === 'processing';
}

function shipStationTrackingCodeUpdateForOrder(
  order: FulfillmentOrder,
  nextLabel: FulfillmentOrder['shipstationLabel'],
): string | null | undefined {
  if (!nextLabel) return undefined;
  if (isActiveShipStationLabel(nextLabel) && nextLabel.trackingNumber) return nextLabel.trackingNumber;
  const currentTrackingCode = normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode);
  if (
    currentTrackingCode &&
    order.shipstationLabel?.trackingNumber === currentTrackingCode &&
    (order.shipstationLabel.labelId !== nextLabel.labelId || !isActiveShipStationLabel(nextLabel))
  ) {
    return null;
  }
  return undefined;
}

function shipStationLabelOrderUpdate(
  order: FulfillmentOrder,
  nextLabel: FulfillmentOrder['shipstationLabel'],
) {
  const trackingCodeUpdate = shipStationTrackingCodeUpdateForOrder(order, nextLabel);
  return {
    shipstationLabel: nextLabel,
    ...(trackingCodeUpdate === null
      ? { fulfillmentTrackingCode: undefined }
      : trackingCodeUpdate
        ? { fulfillmentTrackingCode: trackingCodeUpdate }
        : {}),
  };
}

function downloadShipStationLabel(url: string): void {
  if (typeof window === 'undefined' || !/^https:\/\//i.test(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function parseShipStationMeasurement(value: string): number {
  return Number(value.trim().replace(',', '.'));
}

function listOrderFigureIds(order: FulfillmentOrder): number[] {
  return [...fulfillmentOrderLooseFigureIds(order), ...order.boxes.flatMap((box) => box.dudeIds)];
}

type DuplicateFigureSummary = {
  groupKey: string;
  figureId: number;
  labelId: string;
  count: number;
  sortValue: number;
};

type FulfillmentOrdersCursorByDropId = Record<string, FulfillmentOrdersCursor | null>;

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

async function buildSecretCodePngBlob(
  entry: FulfillmentSecretCodeExportEntry,
  previewImageCache?: SecretCodePreviewImageCache,
  qrCode?: QRCodeModule,
): Promise<Blob> {
  const resolvedQrCode = qrCode || (await loadQRCodeModule());
  return renderSecretCodePngBlob(resolvedQrCode, entry, previewImageCache || new Map());
}

async function buildSecretCodesZipBlob(
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
  labelOverride?: (args: FulfillmentFigureLabelOverrideArgs) => string;
  renderFooter?: (args: { figureId: number; index: number }) => ReactNode;
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
    labelOverride,
    renderFooter,
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
        return (
          <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
            <FigureTileImage
              dropId={dropId}
              figureId={figureId}
              primarySrc={preview.primarySrc}
              fallbackSrc={preview.fallbackSrc}
              alt={preview.alt}
              onMetadataResolved={onMetadataResolved}
            />
            <span className="muted small">{preview.label}</span>
            {renderFooter?.({ figureId, index })}
          </div>
        );
      })}
    </div>
  );
}

function SecretCodeDownloadButton(props: {
  secretCode: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  if (!props.onClick) return null;

  return (
    <button
      type="button"
      className="fulfillment-secret-code-download"
      aria-label={`Download PNG for secret code ${props.secretCode}`}
      title="Download PNG"
      disabled={props.disabled}
      onClick={(evt) => {
        evt.stopPropagation();
        props.onClick?.();
      }}
    >
      <FiDownload aria-hidden="true" />
    </button>
  );
}

function fulfillmentSecretCodeClassName(receiptClaimStatus: string | undefined): string {
  return isUsedReceiptClaimStatus(receiptClaimStatus)
    ? 'fulfillment-secret-code fulfillment-secret-code--used'
    : 'fulfillment-secret-code';
}

function SecretCodeDisplay(props: {
  secretCode: string;
  receiptClaimStatus?: string;
  downloadDisabled?: boolean;
  onDownload?: () => void;
  className?: string;
}) {
  const className = props.className
    ? `fulfillment-secret-code-group ${props.className}`
    : 'fulfillment-secret-code-group';

  return (
    <span className={className}>
      <span className="fulfillment-secret-code-heading">
        <span>Secret Code</span>
        <SecretCodeDownloadButton
          secretCode={props.secretCode}
          disabled={props.downloadDisabled}
          onClick={props.onDownload}
        />
      </span>
      <span className={fulfillmentSecretCodeClassName(props.receiptClaimStatus)}>{props.secretCode}</span>
    </span>
  );
}

function renderBoxTiles(args: {
  boxes: Array<{ boxId: number; boxIndex: number; secretCode: string; receiptClaimStatus?: string }>;
  keyPrefix: string;
  labelSource: Pick<FrontendDeploymentConfig, 'namePrefix' | 'figureNamePrefix' | 'mintSelection'>;
  getPreviewSrc?: (boxId: number) => string | undefined;
  secretCodeDownloadDisabled?: boolean;
  onDownloadSecretCode?: (boxIndex: number) => void;
}) {
  const {
    boxes,
    keyPrefix,
    labelSource,
    getPreviewSrc,
    secretCodeDownloadDisabled,
    onDownloadSecretCode,
  } = args;
  return (
    <div className="figure-grid">
      {boxes.map(({ boxId, boxIndex, secretCode, receiptClaimStatus }, index) => {
        const { label, sizeLabel } = resolveFulfillmentDirectDeliveryBoxLabel(labelSource, boxId);
        const imageSrc = getPreviewSrc?.(boxId);
        const hideSecretCodeDownload = isUsedReceiptClaimStatus(receiptClaimStatus);
        return (
          <div key={`${keyPrefix}:${boxId}:${index}`} className="figure-tile">
            {imageSrc ? (
              <img src={imageSrc} alt={label} loading="lazy" draggable={false} className="figure-image" />
            ) : (
              <div className="figure-image figure-image--placeholder" aria-hidden="true" />
            )}
            <div className={sizeLabel ? 'fulfillment-size-label' : 'muted small'}>{label}</div>
            {secretCode ? (
              <SecretCodeDisplay
                className="muted small"
                secretCode={secretCode}
                receiptClaimStatus={receiptClaimStatus}
                downloadDisabled={secretCodeDownloadDisabled}
                onDownload={
                  onDownloadSecretCode && !hideSecretCodeDownload ? () => onDownloadSecretCode(boxIndex) : undefined
                }
              />
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
  const {
    sessionWallet,
    authenticated,
    signIn,
    loading: authLoading,
    error: authError,
    sessionResolution,
  } = useSolanaAuth();
  const connectedWallet = walletAdapter.connected ? publicKey?.toBase58() || '' : '';
  const authenticatedWallet = authenticated && sessionWallet ? sessionWallet : '';
  const walletAddress = connectedWallet || authenticatedWallet;
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
  const signedIn = Boolean(authenticatedWallet && authenticatedWallet === walletAddress);
  const signInReadiness = walletSessionSignInReadiness({
    hasAuthenticatedSession: signedIn,
    sessionResolution,
    authLoading,
  });
  const walletHasFulfillmentAccess = visibleDrops.length > 0;
  const hasFulfillmentAccess = walletHasFulfillmentAccess && signedIn;
  const canAdminEditFulfillmentAddress = signedIn && hasFulfillmentAddressAdminAccess(walletAddress);
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
  const [orderVisibilityFilter, setOrderVisibilityFilter] = useState<FulfillmentOrderVisibilityFilter>(
    DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER,
  );
  const [manualReviewCheckouts, setManualReviewCheckouts] = useState<FulfillmentManualReviewCheckout[]>([]);
  const [manualReviewMenuOpen, setManualReviewMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [secretCodesExporting, setSecretCodesExporting] = useState(false);
  const [secretCodesExportProgress, setSecretCodesExportProgress] = useState(0);
  const [secretCodePngExportingKey, setSecretCodePngExportingKey] = useState<string | null>(null);
  const [statusEdits, setStatusEdits] = useState<Record<string, FulfillmentStatus | ''>>({});
  const [trackingCodeEdits, setTrackingCodeEdits] = useState<Record<string, string>>({});
  const [statusSaving, setStatusSaving] = useState<Record<string, boolean>>({});
  const [figureMetadataByKey, setFigureMetadataByKey] = useState<Record<string, FigureMetadataRecord>>({});
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [activeUpdateOrderKey, setActiveUpdateOrderKey] = useState<string | null>(null);
  const [activeAddressOrderKey, setActiveAddressOrderKey] = useState<string | null>(null);
  const [activeShipstationOrderKey, setActiveShipstationOrderKey] = useState<string | null>(null);
  const [addressEditText, setAddressEditText] = useState('');
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [shipstationSaving, setShipstationSaving] = useState(false);
  const [shipstationRatesLoading, setShipstationRatesLoading] = useState(false);
  const [shipstationPurchasing, setShipstationPurchasing] = useState(false);
  const [shipstationLabelLoading, setShipstationLabelLoading] = useState(false);
  const [shipstationVoiding, setShipstationVoiding] = useState(false);
  const [shipstationError, setShipstationError] = useState<string | null>(null);
  const [shipstationPackageEdits, setShipstationPackageEdits] = useState<Record<string, ShipStationPackageDraft>>({});
  const [shipstationAddressCorrection, setShipstationAddressCorrection] =
    useState<FulfillmentShipStationAddressCorrectionSession | null>(null);
  const [shipstationRates, setShipstationRates] = useState<FulfillmentShipStationRate[]>([]);
  const [shipstationInvalidRates, setShipstationInvalidRates] = useState<FulfillmentShipStationInvalidRate[]>([]);
  const [shipstationRatesExpanded, setShipstationRatesExpanded] = useState(false);
  const [shipstationSelectedRateId, setShipstationSelectedRateId] = useState<string | null>(null);
  const [shipstationRatesRequested, setShipstationRatesRequested] = useState(false);
  const [shipstationReviewingPurchase, setShipstationReviewingPurchase] = useState(false);
  const [shipstationReviewingVoid, setShipstationReviewingVoid] = useState(false);
  const [shipstationPurchaseRequestId, setShipstationPurchaseRequestId] = useState<string | null>(null);
  const [shipstationLabelDownloadUrl, setShipstationLabelDownloadUrl] = useState<string | null>(null);
  const [shipstationPurchaseUnknown, setShipstationPurchaseUnknown] = useState(false);
  const walletConnectingSeenRef = useRef(false);
  const [walletReady, setWalletReady] = useState(() => !walletAdapter.wallet || !autoConnectPossible);
  const authReady = sessionResolution === 'settled';
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const manualReviewMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const orderRequestEpochRef = useRef(0);

  useDismissibleMenu(manualReviewMenuOpen, manualReviewMenuRef, setManualReviewMenuOpen);
  useDismissibleMenu(exportMenuOpen, exportMenuRef, setExportMenuOpen);
  useOverlayScrollLock({ active: activeShipstationOrderKey !== null && !walletModalVisible });

  const resetShipstationFlow = useCallback(() => {
    setShipstationVoiding(false);
    setShipstationRates([]);
    setShipstationInvalidRates([]);
    setShipstationRatesExpanded(false);
    setShipstationSelectedRateId(null);
    setShipstationRatesRequested(false);
    setShipstationReviewingPurchase(false);
    setShipstationReviewingVoid(false);
    setShipstationPurchaseRequestId(null);
    setShipstationLabelDownloadUrl(null);
    setShipstationPurchaseUnknown(false);
    setShipstationError(null);
    setShipstationAddressCorrection(null);
  }, []);

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
      setActiveAddressOrderKey(null);
      setActiveShipstationOrderKey(null);
      setAddressEditText('');
      setAddressSaving(false);
      setAddressError(null);
      setShipstationSaving(false);
      setShipstationRatesLoading(false);
      setShipstationPurchasing(false);
      setShipstationLabelLoading(false);
      setShipstationPackageEdits({});
      resetShipstationFlow();
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
    setActiveAddressOrderKey(null);
    setActiveShipstationOrderKey(null);
    setAddressEditText('');
    setAddressSaving(false);
    setAddressError(null);
    setShipstationSaving(false);
    setShipstationRatesLoading(false);
    setShipstationPurchasing(false);
    setShipstationLabelLoading(false);
    setShipstationPackageEdits({});
    resetShipstationFlow();
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
  }, [hasFulfillmentAccess, signedIn, selectedDropIds, mergeStatusEdits, resetShipstationFlow]);

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
    () => filterFulfillmentOrdersByVisibility(orders, orderVisibilityFilter),
    [orderVisibilityFilter, orders],
  );
  const displayedSecretCodeCount = useMemo(
    () => countFulfillmentSecretCodeExportEntries(displayedOrders),
    [displayedOrders],
  );

  const groupedOrders = useMemo(
    () =>
      groupFulfillmentOrders({
        orders,
        pageOrderKeys: orderPageKeys,
        visibleOrderKeys: new Set(displayedOrders.map((order) => fulfillmentOrderKey(order))),
      }),
    [displayedOrders, orderPageKeys, orders],
  );

  const duplicateDropOrders = useMemo(() => {
    if (!duplicateDrop) return [];
    return filterFulfillmentOrdersByVisibility(orders, 'all').filter(
      (order) => normalizeDropId(order.dropId) === LITTLE_SWAG_BOXES_DROP_ID,
    );
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
    const entries: Array<{ drop: FrontendDeploymentConfig; figureIds: number[] }> = [];
    displayedOrders.forEach((order) => {
      const drop = dropById.get(order.dropId);
      if (!drop) return;
      entries.push({ drop, figureIds: listOrderFigureIds(order) });
    });
    if (duplicateDrop) {
      entries.push({ drop: duplicateDrop, figureIds: duplicateFigures.map(({ figureId }) => figureId) });
    }
    return collectFulfillmentFigureMetadataTargets({ entries, figureMetadataByKey });
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

  const activeShipstationOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeShipstationOrderKey) ?? null,
    [activeShipstationOrderKey, orders],
  );
  const activeShipstationAddressBaseline = useMemo(
    () => activeShipstationOrder ? fulfillmentShipStationAddressDraft(activeShipstationOrder.address) : null,
    [activeShipstationOrder],
  );
  const activeShipstationOrderKeyResolved = activeShipstationOrder ? fulfillmentOrderKey(activeShipstationOrder) : '';
  const activeShipstationPackageDraft = activeShipstationOrder
    ? shipstationPackageEdits[activeShipstationOrderKeyResolved] ??
      (activeShipstationOrder.shipstationPackage
        ? shipStationPackageDraft(activeShipstationOrder.shipstationPackage)
        : defaultShipStationPackageDraft(activeShipstationOrder))
    : { length: '', width: '', height: '', weight: '' };
  const activeShipstationLabel = activeShipstationOrder?.shipstationLabel;
  const activeShipstationHasLabel = isActiveShipStationLabel(activeShipstationLabel);
  const activeShipstationPackageKnown = Boolean(
    activeShipstationOrder &&
      (!activeShipstationOrder.shipstationShipmentId ||
        activeShipstationOrder.shipstationPackage ||
        shipstationPackageEdits[activeShipstationOrderKeyResolved]),
  );
  const activeShipstationMultiPackage = Boolean(
    activeShipstationOrder?.shipstationShipmentId &&
      activeShipstationOrder.shipstationPackageCount != null &&
      activeShipstationOrder.shipstationPackageCount !== 1,
  );
  const activeShipstationPurchaseUnknown = Boolean(
    shipstationPurchaseUnknown || activeShipstationOrder?.shipstationPurchaseUnknown,
  );
  const activeShipstationBusy =
    shipstationSaving || shipstationRatesLoading || shipstationPurchasing || shipstationLabelLoading || shipstationVoiding;
  const activeShipstationSelectedRate =
    shipstationRates.find((rate) => rate.rateId === shipstationSelectedRateId) ?? null;
  const activeShipstationPreparedRates = useMemo(
    () => prepareFulfillmentShipStationRates(shipstationRates),
    [shipstationRates],
  );
  const activeShipstationRateGroups = useMemo(
    () => groupFulfillmentShipStationRates(activeShipstationPreparedRates.rates, shipstationSelectedRateId),
    [activeShipstationPreparedRates.rates, shipstationSelectedRateId],
  );
  const activeShipstationSelectedRateDetail = activeShipstationSelectedRate
    ? activeShipstationPreparedRates.detailByRateId.get(activeShipstationSelectedRate.rateId)
    : undefined;
  const activeShipstationSelectedOtherRate = activeShipstationRateGroups.selectedOtherRate;
  const visibleShipstationInvalidRates = shipstationRates.length
    ? shipstationInvalidRates.filter((rate) => rate.responseIssue)
    : shipstationInvalidRates;
  const activeShipstationCanAdd = Boolean(
    activeShipstationOrder &&
      !activeShipstationOrder.shipstationShipmentId &&
      normalizeFulfillmentStatus(activeShipstationOrder.fulfillmentStatus) !== 'Shipped',
  );
  const activeShipstationAddressPatch = shipstationAddressCorrection
    ? fulfillmentShipStationAddressPatch(shipstationAddressCorrection)
    : {};
  const activeShipstationAddressCorrectionValid = Boolean(
    shipstationAddressCorrection && fulfillmentShipStationAddressCanRetry(shipstationAddressCorrection),
  );
  const activeShipstationCanGetRates = Boolean(
    activeShipstationOrder?.shipstationShipmentId &&
      !activeShipstationHasLabel &&
      !activeShipstationMultiPackage &&
      !activeShipstationPurchaseUnknown,
  );

  const handleSelectShipstationRate = (rateId: string) => {
    setShipstationSelectedRateId(rateId);
    setShipstationPurchaseRequestId(null);
    setShipstationError(null);
  };

  const handleOpenShipstationModal = useCallback((orderKey: string) => {
    resetShipstationFlow();
    setActiveShipstationOrderKey(orderKey);
  }, [resetShipstationFlow]);

  const handleCloseShipstationModal = useCallback(() => {
    if (activeShipstationBusy) return;
    setActiveShipstationOrderKey(null);
    resetShipstationFlow();
  }, [activeShipstationBusy, resetShipstationFlow]);

  const handleAddToShipStation = useCallback(async () => {
    if (
      !activeShipstationOrder ||
      !hasFulfillmentAccess ||
      !signedIn ||
      shipstationSaving ||
      (Boolean(shipstationAddressCorrection?.visibleFields.length) && !activeShipstationAddressCorrectionValid)
    ) return;
    const requestEpoch = orderRequestEpochRef.current;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const addressPatch = shipstationAddressCorrection && Object.keys(activeShipstationAddressPatch).length > 0
      ? activeShipstationAddressPatch
      : undefined;
    const draft = shipstationPackageEdits[key] ?? defaultShipStationPackageDraft(activeShipstationOrder);
    const parcel = normalizeShipStationPackage({
      length: parseShipStationMeasurement(draft.length),
      width: parseShipStationMeasurement(draft.width),
      height: parseShipStationMeasurement(draft.height),
      weight: parseShipStationMeasurement(draft.weight),
    });
    if (!parcel) {
      setShipstationError(SHIPSTATION_PACKAGE_RANGE_MESSAGE);
      return;
    }
    setShipstationSaving(true);
    setShipstationError(null);
    try {
      const response = await addFulfillmentOrderToShipStation(
        activeShipstationOrder.deliveryId,
        activeShipstationOrder.dropId,
        parcel,
        addressPatch,
      );
      if (orderRequestEpochRef.current !== requestEpoch) return;
      setOrders((prev) =>
        prev.map((order) =>
          fulfillmentOrderKey(order) === key
            ? {
                ...order,
                shipstationShipmentId: response.shipmentId,
                shipstationAddedAt: response.shipstationAddedAt ?? order.shipstationAddedAt ?? Date.now(),
                ...(!response.alreadyAdded
                  ? { shipstationPackage: parcel, shipstationPackageCount: 1 }
                  : {}),
              }
            : order,
        ),
      );
      if (response.alreadyAdded) {
        setShipstationError(
          `This order was already in ShipStation, so these measurements${addressPatch ? ' and address corrections' : ''} were not applied.`,
        );
      }
      setShipstationAddressCorrection(null);
      setShipstationPackageEdits((prev) => {
        if (!Object.hasOwn(prev, key)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setShipstationError(err instanceof Error ? err.message : 'Failed to add the order to ShipStation');
      const correction = fulfillmentShipStationAddressCorrectionDetails(err);
      setShipstationAddressCorrection((current) => correction
        ? fulfillmentShipStationAddressCorrectionFailure(
            current,
            activeShipstationAddressBaseline,
            correction.fields,
            addressPatch ?? {},
          )
        : fulfillmentShipStationAddressOtherFailure(current, addressPatch ?? {}));
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) setShipstationSaving(false);
    }
  }, [
    activeShipstationAddressBaseline,
    activeShipstationAddressCorrectionValid,
    activeShipstationAddressPatch,
    activeShipstationOrder,
    hasFulfillmentAccess,
    shipstationAddressCorrection,
    shipstationPackageEdits,
    shipstationSaving,
    signedIn,
  ]);

  const handleGetShipstationRates = useCallback(async () => {
    if (
      !activeShipstationOrder ||
      !activeShipstationOrder.shipstationShipmentId ||
      !hasFulfillmentAccess ||
      !signedIn ||
      activeShipstationBusy ||
      activeShipstationHasLabel ||
      activeShipstationMultiPackage ||
      activeShipstationPurchaseUnknown
    ) {
      return;
    }
    const requestEpoch = orderRequestEpochRef.current;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const packageDraft = shipstationPackageEdits[key];
    const draftPackage = packageDraft ? {
      length: parseShipStationMeasurement(packageDraft.length),
      width: parseShipStationMeasurement(packageDraft.width),
      height: parseShipStationMeasurement(packageDraft.height),
      weight: parseShipStationMeasurement(packageDraft.weight),
    } : undefined;
    const canonicalPackage = activeShipstationOrder.shipstationPackage;
    const draftMatchesCanonical = Boolean(
      draftPackage &&
      canonicalPackage &&
      SHIPSTATION_PACKAGE_FIELDS.every(({ key: field }) => draftPackage[field] === canonicalPackage[field]),
    );
    let parcel: ShipStationPackageInput | undefined;
    if (draftPackage && !draftMatchesCanonical) {
      parcel = normalizeShipStationPackage(draftPackage) ?? undefined;
      if (!parcel) {
        setShipstationError(SHIPSTATION_PACKAGE_RANGE_MESSAGE);
        return;
      }
    }
    setShipstationRatesLoading(true);
    setShipstationRatesRequested(true);
    setShipstationRatesExpanded(false);
    setShipstationReviewingPurchase(false);
    setShipstationPurchaseRequestId(null);
    setShipstationError(null);
    setShipstationInvalidRates([]);
    try {
      const response = await getFulfillmentShipStationRates(
        activeShipstationOrder.deliveryId,
        activeShipstationOrder.dropId,
        parcel,
      );
      if (orderRequestEpochRef.current !== requestEpoch) return;
      const resolvedPackage = response.package;
      if (resolvedPackage) {
        setShipstationPackageEdits((prev) => {
          if (!Object.hasOwn(prev, key)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      setOrders((prev) =>
        prev.map((order) =>
          fulfillmentOrderKey(order) === key
            ? {
                ...order,
                ...(response.package ? { shipstationPackage: response.package } : {}),
                shipstationPackageCount: response.packageCount,
                ...shipStationLabelOrderUpdate(order, response.label),
                shipstationPurchaseUnknown: Boolean(response.purchaseUnknown),
              }
            : order,
        ),
      );
      setShipstationRates(response.rates);
      setShipstationInvalidRates(response.invalidRates ?? []);
      setShipstationSelectedRateId(response.rates[0]?.rateId ?? null);
      setShipstationLabelDownloadUrl(response.labelDownloadUrl || null);
      setShipstationPurchaseUnknown(Boolean(response.purchaseUnknown));
      const trackingCodeUpdate = shipStationTrackingCodeUpdateForOrder(activeShipstationOrder, response.label);
      if (trackingCodeUpdate !== undefined) {
        setTrackingCodeEdits((prev) => ({ ...prev, [key]: trackingCodeUpdate ?? '' }));
      }
      if (!response.label && !response.purchaseUnknown && response.packageCount === 1 && !response.rates.length) {
        if (!response.invalidRates?.length) {
          setShipstationError('ShipStation returned no valid rates for this shipment.');
        }
      }
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setShipstationError(err instanceof Error ? err.message : 'Failed to get ShipStation rates');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) setShipstationRatesLoading(false);
    }
  }, [
    activeShipstationBusy,
    activeShipstationHasLabel,
    activeShipstationMultiPackage,
    activeShipstationOrder,
    activeShipstationPurchaseUnknown,
    hasFulfillmentAccess,
    shipstationPackageEdits,
    signedIn,
  ]);

  const handleReviewShipstationPurchase = useCallback(() => {
    if (!activeShipstationSelectedRate || activeShipstationBusy) return;
    setShipstationPurchaseRequestId(globalThis.crypto.randomUUID());
    setShipstationReviewingPurchase(true);
    setShipstationError(null);
  }, [activeShipstationBusy, activeShipstationSelectedRate]);

  const handleConfirmShipstationPurchase = useCallback(async () => {
    if (
      !activeShipstationOrder ||
      !activeShipstationSelectedRate ||
      !hasFulfillmentAccess ||
      !signedIn ||
      activeShipstationBusy
    ) {
      return;
    }
    const requestEpoch = orderRequestEpochRef.current;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const requestId = shipstationPurchaseRequestId || globalThis.crypto.randomUUID();
    setShipstationPurchaseRequestId(requestId);
    setShipstationPurchasing(true);
    setShipstationError(null);
    try {
      const response = await purchaseFulfillmentShipStationLabel({
        dropId: activeShipstationOrder.dropId,
        deliveryId: activeShipstationOrder.deliveryId,
        rateId: activeShipstationSelectedRate.rateId,
        expectedTotal: activeShipstationSelectedRate.totalAmount,
        requestId,
      });
      if (orderRequestEpochRef.current !== requestEpoch) return;
      setOrders((prev) =>
        prev.map((order) =>
          fulfillmentOrderKey(order) === key
            ? {
                ...order,
                ...shipStationLabelOrderUpdate(order, response.label),
                shipstationPurchaseUnknown: false,
              }
            : order,
        ),
      );
      setShipstationRates([]);
      setShipstationRatesExpanded(false);
      setShipstationSelectedRateId(null);
      setShipstationReviewingPurchase(false);
      setShipstationPurchaseUnknown(false);
      setShipstationLabelDownloadUrl(response.labelDownloadUrl || null);
      const trackingCodeUpdate = shipStationTrackingCodeUpdateForOrder(activeShipstationOrder, response.label);
      if (trackingCodeUpdate !== undefined) {
        setTrackingCodeEdits((prev) => ({ ...prev, [key]: trackingCodeUpdate ?? '' }));
      }
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      const message = err instanceof Error ? err.message : 'Failed to purchase the ShipStation label';
      setShipstationError(message);
      if (/check purchase status|may already|did not confirm/i.test(message)) {
        setShipstationPurchaseUnknown(true);
        setOrders((prev) =>
          prev.map((order) =>
            fulfillmentOrderKey(order) === key ? { ...order, shipstationPurchaseUnknown: true } : order,
          ),
        );
      } else if (/rate.*changed|refresh rates|no longer valid/i.test(message)) {
        setShipstationRates([]);
        setShipstationRatesExpanded(false);
        setShipstationSelectedRateId(null);
        setShipstationReviewingPurchase(false);
        setShipstationPurchaseRequestId(null);
        setShipstationRatesRequested(true);
      } else {
        setShipstationPurchaseRequestId(null);
      }
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) setShipstationPurchasing(false);
    }
  }, [
    activeShipstationBusy,
    activeShipstationOrder,
    activeShipstationSelectedRate,
    hasFulfillmentAccess,
    shipstationPurchaseRequestId,
    signedIn,
  ]);

  const handleConfirmShipstationVoid = useCallback(async () => {
    if (
      !activeShipstationOrder ||
      activeShipstationLabel?.status !== 'completed' ||
      !hasFulfillmentAccess ||
      !signedIn ||
      activeShipstationBusy
    ) {
      return;
    }
    const requestEpoch = orderRequestEpochRef.current;
    const key = fulfillmentOrderKey(activeShipstationOrder);
    const labelId = activeShipstationLabel.labelId;
    setShipstationVoiding(true);
    setShipstationError(null);
    try {
      const response = await voidFulfillmentShipStationLabel({
        dropId: activeShipstationOrder.dropId,
        deliveryId: activeShipstationOrder.deliveryId,
        labelId,
      });
      if (orderRequestEpochRef.current !== requestEpoch) return;
      if (response.label.labelId !== labelId) {
        throw new Error('ShipStation returned a different label. Check its status again.');
      }
      setOrders((prev) =>
        prev.map((order) =>
          fulfillmentOrderKey(order) === key
            ? {
                ...order,
                ...shipStationLabelOrderUpdate(order, response.label),
                shipstationPurchaseUnknown: false,
              }
            : order,
        ),
      );
      setShipstationRates([]);
      setShipstationInvalidRates([]);
      setShipstationRatesExpanded(false);
      setShipstationSelectedRateId(null);
      setShipstationRatesRequested(false);
      setShipstationReviewingPurchase(false);
      setShipstationReviewingVoid(false);
      setShipstationPurchaseRequestId(null);
      setShipstationPurchaseUnknown(false);
      setShipstationLabelDownloadUrl(null);
      const trackingCodeUpdate = shipStationTrackingCodeUpdateForOrder(activeShipstationOrder, response.label);
      if (trackingCodeUpdate !== undefined) {
        setTrackingCodeEdits((prev) => ({ ...prev, [key]: trackingCodeUpdate ?? '' }));
      }
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setShipstationError(err instanceof Error ? err.message : 'Failed to void the ShipStation label');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) setShipstationVoiding(false);
    }
  }, [
    activeShipstationBusy,
    activeShipstationLabel,
    activeShipstationOrder,
    hasFulfillmentAccess,
    signedIn,
  ]);

  const refreshShipstationLabel = useCallback(
    async (downloadAfterRefresh: boolean) => {
      if (
        !activeShipstationOrder ||
        !activeShipstationOrder.shipstationShipmentId ||
        !hasFulfillmentAccess ||
        !signedIn ||
        shipstationLabelLoading ||
        shipstationPurchasing
      ) {
        return;
      }
      const requestEpoch = orderRequestEpochRef.current;
      const key = fulfillmentOrderKey(activeShipstationOrder);
      setShipstationLabelLoading(true);
      setShipstationError(null);
      try {
        const response = await getFulfillmentShipStationLabel(
          activeShipstationOrder.deliveryId,
          activeShipstationOrder.dropId,
        );
        if (orderRequestEpochRef.current !== requestEpoch) return;
        setOrders((prev) =>
          prev.map((order) =>
            fulfillmentOrderKey(order) === key
              ? {
                  ...order,
                  ...shipStationLabelOrderUpdate(order, response.label),
                  shipstationPurchaseUnknown: Boolean(response.purchaseUnknown),
                }
              : order,
          ),
        );
        setShipstationPurchaseUnknown(Boolean(response.purchaseUnknown));
        setShipstationLabelDownloadUrl(response.labelDownloadUrl || null);
        const trackingCodeUpdate = shipStationTrackingCodeUpdateForOrder(activeShipstationOrder, response.label);
        if (trackingCodeUpdate !== undefined) {
          setTrackingCodeEdits((prev) => ({ ...prev, [key]: trackingCodeUpdate ?? '' }));
        }
        if (downloadAfterRefresh && response.labelDownloadUrl) {
          downloadShipStationLabel(response.labelDownloadUrl);
        } else if (downloadAfterRefresh && !response.labelDownloadUrl) {
          setShipstationError('The ShipStation label PDF is not ready yet.');
        }
      } catch (err) {
        if (orderRequestEpochRef.current !== requestEpoch) return;
        console.error(err);
        setShipstationError(err instanceof Error ? err.message : 'Failed to check the ShipStation label');
      } finally {
        if (orderRequestEpochRef.current === requestEpoch) setShipstationLabelLoading(false);
      }
    },
    [
      activeShipstationOrder,
      hasFulfillmentAccess,
      shipstationLabelLoading,
      shipstationPurchasing,
      signedIn,
    ],
  );

  useEffect(() => {
    if (!activeShipstationOrderKey || activeShipstationLabel?.status !== 'processing' || activeShipstationBusy) return;
    const interval = window.setInterval(() => {
      void refreshShipstationLabel(false);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [
    activeShipstationBusy,
    activeShipstationLabel?.status,
    activeShipstationOrderKey,
    refreshShipstationLabel,
  ]);

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

  const activeAddressOrder = useMemo(
    () => orders.find((order) => fulfillmentOrderKey(order) === activeAddressOrderKey) ?? null,
    [activeAddressOrderKey, orders],
  );
  const activeAddressText =
    typeof activeAddressOrder?.address.full === 'string' && activeAddressOrder.address.full !== '***'
      ? activeAddressOrder.address.full.trim()
      : '';
  const addressEditDirty = Boolean(activeAddressOrder && addressEditText.trim() !== activeAddressText);

  const handleOpenAddressModal = useCallback(
    (order: FulfillmentOrder) => {
      if (!canAdminEditFulfillmentAddress || isRedeemedForIrlFulfillmentOrder(order)) return;
      const full = typeof order.address.full === 'string' && order.address.full !== '***' ? order.address.full : '';
      setAddressEditText(full);
      setAddressError(null);
      setActiveAddressOrderKey(fulfillmentOrderKey(order));
    },
    [canAdminEditFulfillmentAddress],
  );

  const handleCloseAddressModal = useCallback(() => {
    if (addressSaving) return;
    setActiveAddressOrderKey(null);
    setAddressEditText('');
    setAddressError(null);
  }, [addressSaving]);

  const handleSaveAddress = useCallback(async () => {
    if (!activeAddressOrder || !canAdminEditFulfillmentAddress || addressSaving) return;
    const full = addressEditText.trim();
    if (!full) {
      setAddressError('Enter a delivery address.');
      return;
    }
    if (!addressEditDirty) {
      handleCloseAddressModal();
      return;
    }

    const requestEpoch = orderRequestEpochRef.current;
    const orderKey = fulfillmentOrderKey(activeAddressOrder);
    setAddressSaving(true);
    setAddressError(null);
    try {
      const response = await updateFulfillmentAddress(
        activeAddressOrder.deliveryId,
        full,
        activeAddressOrder.dropId,
      );
      if (orderRequestEpochRef.current !== requestEpoch) return;
      setOrders((current) =>
        current.map((order) =>
          fulfillmentOrderKey(order) === orderKey
            ? { ...order, address: { ...order.address, ...response.address } }
            : order,
        ),
      );
      setActiveAddressOrderKey(null);
      setAddressEditText('');
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setAddressError(err instanceof Error ? err.message : 'Failed to update delivery address');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setAddressSaving(false);
      }
    }
  }, [
    activeAddressOrder,
    addressEditDirty,
    addressEditText,
    addressSaving,
    canAdminEditFulfillmentAddress,
    handleCloseAddressModal,
  ]);

  const handleSolanaSignIn = useCallback(() => {
    if (!connectedWallet || !publicKey) {
      setPendingSignIn(true);
      setWalletModalVisible(true);
      return;
    }
    if (!walletHasFulfillmentAccess || signInReadiness !== 'sign') return;
    void signIn();
  }, [connectedWallet, publicKey, setWalletModalVisible, signIn, signInReadiness, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || !connectedWallet || !publicKey) return;
    if (!walletHasFulfillmentAccess || signedIn) {
      setPendingSignIn(false);
      return;
    }
    if (signInReadiness !== 'sign') return;
    setPendingSignIn(false);
    void signIn();
  }, [connectedWallet, pendingSignIn, publicKey, signIn, signedIn, signInReadiness, walletHasFulfillmentAccess]);

  useEffect(() => {
    if (!pendingSignIn || walletModalVisible || connectedWallet) return;
    setPendingSignIn(false);
  }, [connectedWallet, pendingSignIn, walletModalVisible]);

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

  const loadFulfillmentExportFigureMetadata = useCallback(async (targets = fulfillmentFigureMetadataTargets) => {
    let exportFigureMetadataByKey = figureMetadataByKey;
    if (targets.length) {
      const records = await loadFigureMetadataBatch(targets);
      if (records.length) {
        mergeLoadedFigureMetadata(records);
        exportFigureMetadataByKey = mergeFigureMetadataRecords(exportFigureMetadataByKey, records);
      }
    }
    return exportFigureMetadataByKey;
  }, [figureMetadataByKey, fulfillmentFigureMetadataTargets, mergeLoadedFigureMetadata]);

  const downloadSecretCodePng = useCallback(
    async (order: FulfillmentOrder, target: FulfillmentSecretCodeDownloadTarget) => {
      if (secretCodesExporting || secretCodePngExportingKey) return;

      let figureIds: number[];
      if (target.kind === 'box') {
        const box = order.boxes[target.index];
        if (!box || !fulfillmentBoxSecretCode(box)) return;
        figureIds = box.dudeIds;
      } else {
        const claim = order.cardClaims?.[target.index];
        const secretCode = claim ? fulfillmentCardClaimSecretCode(claim) : '';
        if (!claim || !secretCode || isUsedReceiptClaimStatus(claim.receiptClaimStatus)) return;
        figureIds = [claim.figureId];
      }

      const exportKey = `${fulfillmentOrderKey(order)}:${
        target.kind === 'box' ? target.index : `card:${target.index}`
      }`;
      setSecretCodePngExportingKey(exportKey);
      setOrdersError(null);
      try {
        const orderDrop = dropById.get(order.dropId);
        const exportFigureMetadataByKey = await loadFulfillmentExportFigureMetadata(
          orderDrop
            ? collectFulfillmentFigureMetadataTargets({
                entries: [{ drop: orderDrop, figureIds }],
                figureMetadataByKey,
              })
            : [],
        );
        const options = { dropById, figureMetadataByKey: exportFigureMetadataByKey };
        const entry =
          target.kind === 'box'
            ? buildFulfillmentSecretCodeExportEntry({ order, boxIndex: target.index, options })
            : buildFulfillmentCardClaimSecretCodeExportEntry({
                order,
                cardClaimIndex: target.index,
                options,
              });
        if (!entry) throw new Error('Secret code unavailable');

        const pngBlob = await buildSecretCodePngBlob(entry);
        downloadBlobFile(entry.filename, pngBlob);
      } catch (err) {
        const fallbackMessage =
          target.kind === 'card-claim'
            ? 'Failed to export fulfillment card secret code PNG'
            : 'Failed to export fulfillment secret code PNG';
        console.error(
          target.kind === 'card-claim'
            ? '[mons] failed to export fulfillment card secret code PNG'
            : '[mons] failed to export fulfillment secret code PNG',
          err,
        );
        setOrdersError(err instanceof Error ? err.message : fallbackMessage);
      } finally {
        setSecretCodePngExportingKey((current) => (current === exportKey ? null : current));
      }
    },
    [dropById, figureMetadataByKey, loadFulfillmentExportFigureMetadata, secretCodePngExportingKey, secretCodesExporting],
  );

  const downloadDisplayedSecretCodes = useCallback(async () => {
    setExportMenuOpen(false);
    if (secretCodesExporting || secretCodePngExportingKey || !displayedSecretCodeCount) return;

    setSecretCodesExporting(true);
    setSecretCodesExportProgress(0);
    setOrdersError(null);
    try {
      const filename = buildFulfillmentExportFilename({
        kind: 'secret-codes',
        selectedDropId,
        orderVisibilityFilter,
      });
      const exportFigureMetadataByKey = await loadFulfillmentExportFigureMetadata();
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
    loadFulfillmentExportFigureMetadata,
    orderVisibilityFilter,
    secretCodePngExportingKey,
    secretCodesExporting,
    selectedDropId,
  ]);

  const secretCodesExportPercent = Math.max(0, Math.min(100, Math.round(secretCodesExportProgress)));
  const secretCodeDownloadDisabled = secretCodesExporting || Boolean(secretCodePngExportingKey);

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
          const ownerText = checkout.owner || checkout.authSubject || 'Owner unavailable';
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
        disabled={secretCodeDownloadDisabled || !displayedSecretCodeCount}
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
    const cardClaims = order.cardClaims || [];
    const looseDudes = fulfillmentLooseFigureIdsExcludingCardClaims(order);
    const showContactInfo = options?.showContactInfo ?? true;
    const showFullAddress = options?.showFullAddress ?? true;
    const canEditOrderAddress = canEditFulfillmentOrderAddress(order, {
      showFullAddress,
      hasAddressAccess: canAdminEditFulfillmentAddress,
    });
    const canPrintOrderLabel =
      !isRedeemedForIrlFulfillmentOrder(order) &&
      (Boolean(order.shipstationShipmentId) || normalizeFulfillmentStatus(order.fulfillmentStatus) !== 'Shipped');
    const showOrderEmailLine =
      showContactInfo && ((order.address.full !== '***' && Boolean(order.address.email)) || canEditOrderAddress);
    return (
      <div key={orderKey} className="fulfillment-order-section">
        <div className="card__head">
          <div>
            <div className="card__title">Order {order.deliveryId}</div>
            <div className="muted fulfillment-order-date small">{formatOrderDate(order.processedAt || order.createdAt)}</div>
            {showOrderEmailLine ? (
              <div className="fulfillment-order-email-line">
                {order.address.full !== '***' && order.address.email ? (
                  <div className="muted small">{order.address.email}</div>
                ) : null}
                {canEditOrderAddress ? (
                  <button
                    type="button"
                    className="fulfillment-order-address-edit"
                    onClick={() => handleOpenAddressModal(order)}
                    aria-label={`Edit address for order ${order.deliveryId}`}
                    title="Edit address"
                  >
                    <FiEdit2 aria-hidden="true" />
                  </button>
                ) : null}
              </div>
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
          {showFullAddress || canPrintOrderLabel ? (
            <div className="address-lines">
              {showFullAddress ? (
                order.address.full ? (
                  <div className="address-text">
                    {formatFulfillmentAddressText(order.address)}
                  </div>
                ) : (
                  <>
                    <div className="muted small">Encrypted address payload</div>
                    <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                  </>
                )
              ) : null}
              {canPrintOrderLabel ? (
                <div className="fulfillment-order-address-actions">
                  <button
                    type="button"
                    className="link fulfillment-order-address-action small no-focus-style"
                    onClick={() => handleOpenShipstationModal(orderKey)}
                  >
                    Print Label
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {order.boxes.length ? (
            orderIsDirectDeliveryDrop ? (
              renderBoxTiles({
                boxes: order.boxes.map((box, boxIndex) => ({
                  boxId: box.boxId,
                  boxIndex,
                  secretCode: fulfillmentBoxSecretCode(box),
                  receiptClaimStatus: box.receiptClaimStatus,
                })),
                keyPrefix: `${orderKey}:box`,
                labelSource: orderDrop,
                getPreviewSrc: (boxId) => normalizeBoxDisplayImage({ dropId: orderDrop.dropId, boxId }),
                secretCodeDownloadDisabled,
                onDownloadSecretCode: (boxIndex) =>
                  void downloadSecretCodePng(order, { kind: 'box', index: boxIndex }),
              })
            ) : (
              <div className="box-contents-list">
                {order.boxes.map((box, boxIndex) => {
                  const secretCode = fulfillmentBoxSecretCode(box);
                  const hideSecretCodeDownload = isUsedReceiptClaimStatus(box.receiptClaimStatus);
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
                            <SecretCodeDisplay
                              secretCode={secretCode}
                              receiptClaimStatus={box.receiptClaimStatus}
                              downloadDisabled={secretCodeDownloadDisabled}
                              onDownload={
                                hideSecretCodeDownload
                                  ? undefined
                                  : () => void downloadSecretCodePng(order, { kind: 'box', index: boxIndex })
                              }
                            />
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
                        })
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : null}

          {cardClaims.length
            ? renderFigureTiles({
                dropId: orderDrop.dropId,
                drop: orderDrop,
                figureIds: cardClaims.map((claim) => claim.figureId),
                keyPrefix: `${orderKey}:card-claim`,
                figureNamePrefix: orderDrop.figureNamePrefix,
                previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                figureMediaBase: orderFigureMediaBase,
                figureMedia: orderDrop.figureMedia,
                figureMetadataByKey,
                onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
                renderFooter: ({ index }) => {
                  const claim = cardClaims[index];
                  const secretCode = claim ? fulfillmentCardClaimSecretCode(claim) : '';
                  if (!claim || !secretCode) {
                    return <span className="muted small">Secret code unavailable</span>;
                  }
                  const hideSecretCodeDownload = isUsedReceiptClaimStatus(claim.receiptClaimStatus);
                  return (
                    <SecretCodeDisplay
                      className="muted small"
                      secretCode={secretCode}
                      receiptClaimStatus={claim.receiptClaimStatus}
                      downloadDisabled={secretCodeDownloadDisabled}
                      onDownload={
                        hideSecretCodeDownload
                          ? undefined
                          : () => void downloadSecretCodePng(order, { kind: 'card-claim', index })
                      }
                    />
                  );
                },
              })
            : null}

          {looseDudes.length
            ? renderFigureTiles({
                dropId: orderDrop.dropId,
                drop: orderDrop,
                figureIds: looseDudes,
                keyPrefix: `${orderKey}:dude`,
                figureNamePrefix: orderDrop.figureNamePrefix,
                previewMode: orderDropContent.figures.fulfillmentPreviewMode,
                figureMediaBase: orderFigureMediaBase,
                figureMedia: orderDrop.figureMedia,
                figureMetadataByKey,
                onMetadataResolved: (record) => mergeLoadedFigureMetadata([record]),
              })
            : null}
        </div>
      </div>
    );
  };

  return (
    <div className="page fulfillment-page">
      <ShopHeader scrollHomeToTop />

      {!walletBusy && (walletReady || signedIn) && (walletAddress ? (!walletHasFulfillmentAccess || authReady) : authReady) ? (
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
                  setOrderVisibilityFilter(DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER);
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
                    setOrderVisibilityFilter(evt.target.value as FulfillmentOrderVisibilityFilter);
                  }}
                >
                  {FULFILLMENT_ORDER_VISIBILITY_OPTIONS.map((option) => (
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
                    : orderVisibilityFilter === 'redeemed_for_irl'
                      ? 'No orders redeemed for IRL.'
                      : 'No unshipped orders.'}
              </div>
            ) : null}

            {selectedDropIds.length && loadingMore ? <div className="muted small">Loading more…</div> : null}
            <div ref={sentinelRef} />
          </section>
        )
      ) : null}

      {secretCodesExporting ? (
        <BodyPortal>
          <div className="fulfillment-export-progress" role="status" aria-live="polite" aria-busy="true">
            <div className="fulfillment-export-progress__panel">
              <div className="fulfillment-export-progress__title">Exporting Secret Codes ZIP</div>
              <div className="fulfillment-export-progress__percent">{secretCodesExportPercent}%</div>
              <div className="muted small">
                {displayedSecretCodeCount} {displayedSecretCodeCount === 1 ? 'PNG' : 'PNGs'}
              </div>
            </div>
          </div>
        </BodyPortal>
      ) : null}

      <Modal
        open={activeAddressOrderKey !== null}
        title={activeAddressOrder ? `Edit address · Order ${activeAddressOrder.deliveryId}` : 'Edit address'}
        onClose={handleCloseAddressModal}
        showCloseButton={false}
        closeOnEscape={!addressSaving}
        suspended={walletModalVisible}
      >
        <form
          className="modal-form fulfillment-address-form"
          onSubmit={(evt) => {
            evt.preventDefault();
            void handleSaveAddress();
          }}
        >
          <label>
            <span className="muted">Delivery address</span>
            <textarea
              value={addressEditText}
              onChange={(evt) => setAddressEditText(evt.target.value)}
              rows={8}
              maxLength={2048}
              required
              disabled={addressSaving}
              autoComplete="street-address"
              aria-label="Delivery address"
            />
          </label>
          <div className="muted small">This changes the address for this order only.</div>
          {addressError ? <div className="error">{addressError}</div> : null}
          <div className="row row--end">
            <button
              type="button"
              className="secondary-light"
              onClick={handleCloseAddressModal}
              disabled={addressSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!activeAddressOrder || addressSaving || !addressEditDirty || !addressEditText.trim()}
            >
              {addressSaving ? 'Saving…' : 'Save address'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={activeShipstationOrderKey !== null}
        title={activeShipstationOrder ? `Print label · Order ${activeShipstationOrder.deliveryId}` : 'Print label'}
        onClose={handleCloseShipstationModal}
        showCloseButton={false}
        closeOnEscape={!activeShipstationBusy}
        suspended={walletModalVisible}
      >
        <div className="modal-form">
          {activeShipstationOrder && !isRedeemedForIrlFulfillmentOrder(activeShipstationOrder) ? (
            <div className="fulfillment-shipstation">
              {activeShipstationOrder.shipstationShipmentId ? (
                <div className="shipstation-header-actions">
                  <a
                    className="link small no-focus-style"
                    href={SHIPSTATION_AWAITING_SHIPMENT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on ShipStation
                  </a>
                </div>
              ) : null}

              {shipstationReviewingVoid && activeShipstationLabel?.status === 'completed' ? (
                <div className="shipstation-review shipstation-review--void" role="alert">
                  <div className="shipstation-review__title">Void this label?</div>
                  <div className="small">
                    This cannot be undone. ShipStation will request a carrier refund when applicable, but approval and timing depend on the carrier.
                  </div>
                  {activeShipstationLabel.trackingNumber ? (
                    <div className="muted small">Tracking {activeShipstationLabel.trackingNumber}</div>
                  ) : null}
                </div>
              ) : activeShipstationLabel ? (
                <div className="shipstation-label-summary" aria-live="polite">
                  <div className="shipstation-label-summary__heading">
                    {activeShipstationLabel.status === 'processing'
                      ? 'Label purchase is processing'
                      : activeShipstationLabel.status === 'completed'
                        ? 'Label purchased'
                        : activeShipstationLabel.status === 'voided'
                          ? 'Previous label was voided'
                          : 'Previous label could not be created'}
                  </div>
                  {activeShipstationHasLabel ? (
                    <div className="shipstation-label-summary__details">
                      <span>
                        {[activeShipstationLabel.carrierName || activeShipstationLabel.carrierCode,
                          activeShipstationLabel.serviceName || activeShipstationLabel.serviceCode]
                          .filter(Boolean)
                          .join(' · ') || 'Carrier details pending'}
                      </span>
                      {activeShipstationLabel.totalCost ? (
                        <span>{formatShipStationMoney(activeShipstationLabel.totalCost)}</span>
                      ) : null}
                      {activeShipstationLabel.trackingNumber ? (
                        <span>Tracking {activeShipstationLabel.trackingNumber}</span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="muted small">Get fresh rates to purchase another label.</div>
                  )}
                </div>
              ) : null}

              {activeShipstationPurchaseUnknown ? (
                <div className="shipstation-notice" role="status">
                  ShipStation may already have charged for this label. Check its status before taking any other action.
                </div>
              ) : null}

              {activeShipstationMultiPackage && !activeShipstationHasLabel ? (
                <div className="shipstation-notice">
                  {activeShipstationOrder.shipstationPackageCount
                    ? `This shipment has ${activeShipstationOrder.shipstationPackageCount} packages.`
                    : 'This shipment does not have a single package.'}{' '}
                  Buy its label in ShipStation; the in-app flow supports one package only.
                </div>
              ) : null}

              {!activeShipstationHasLabel && !activeShipstationMultiPackage && !activeShipstationPurchaseUnknown ? (
                activeShipstationPackageKnown ? (
                  <div className="shipstation-package">
                    {SHIPSTATION_PACKAGE_FIELDS.map((field) => (
                      <label key={field.key} className="shipstation-package-field">
                        <span className="muted small">{field.label}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={activeShipstationPackageDraft[field.key]}
                          onChange={(evt) => {
                            const value = evt.target.value;
                            setShipstationPackageEdits((prev) => ({
                              ...prev,
                              [activeShipstationOrderKeyResolved]: {
                                ...(prev[activeShipstationOrderKeyResolved] ?? activeShipstationPackageDraft),
                                [field.key]: value,
                              },
                            }));
                            setShipstationRates([]);
                            setShipstationInvalidRates([]);
                            setShipstationRatesExpanded(false);
                            setShipstationSelectedRateId(null);
                            setShipstationReviewingPurchase(false);
                            setShipstationPurchaseRequestId(null);
                            setShipstationError(null);
                          }}
                          disabled={activeShipstationBusy || shipstationReviewingPurchase}
                          aria-label={field.ariaLabel}
                          autoComplete="off"
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="muted small">
                    Package details will be loaded from ShipStation when you get rates.
                  </div>
                )
              ) : null}

              {shipstationReviewingPurchase && activeShipstationSelectedRate ? (
                <div className="shipstation-review">
                  <div className="shipstation-review__title">Review label purchase</div>
                  <div className="shipstation-review__row">
                    <span>Carrier</span>
                    <strong>{activeShipstationSelectedRate.carrierName}</strong>
                  </div>
                  <div className="shipstation-review__row">
                    <span>Service</span>
                    <strong>{activeShipstationSelectedRate.serviceName}</strong>
                  </div>
                  <div className="shipstation-review__row shipstation-review__row--total">
                    <span>Total charge</span>
                    <strong>{formatShipStationMoney(activeShipstationSelectedRate.totalAmount)}</strong>
                  </div>
                  {activeShipstationSelectedRateDetail ? (
                    <div className="muted small">{activeShipstationSelectedRateDetail}</div>
                  ) : null}
                  <div className="muted small">The charge is made through your ShipStation account.</div>
                </div>
              ) : activeShipstationPreparedRates.rates.length ? (
                <div className="shipstation-rate-picker">
                  <div className="shipstation-rate-picker__head">
                    <div id="shipstation-lowest-prices-label" className="shipstation-rate-section__label">
                      Lowest prices
                    </div>
                    {activeShipstationRateGroups.otherRates.length ? (
                      <button
                        type="button"
                        className="link small shipstation-rate-toggle"
                        aria-expanded={shipstationRatesExpanded}
                        aria-controls="shipstation-rate-options"
                        onClick={() => setShipstationRatesExpanded((expanded) => !expanded)}
                        disabled={activeShipstationBusy}
                      >
                        {shipstationRatesExpanded
                          ? 'Show fewer'
                          : `Show all ${activeShipstationPreparedRates.rates.length} rates`}
                      </button>
                    ) : null}
                  </div>
                  <div
                    id="shipstation-rate-options"
                    className="shipstation-rate-groups"
                    role="radiogroup"
                    aria-label="Shipping rates"
                  >
                    <div
                      className="shipstation-rate-section"
                      role="group"
                      aria-labelledby="shipstation-lowest-prices-label"
                    >
                      <div className="shipstation-rate-list">
                        {activeShipstationRateGroups.recommendedRates.map((rate) => (
                          <ShipStationRateOption
                            key={rate.rateId}
                            rate={rate}
                            detail={activeShipstationPreparedRates.detailByRateId.get(rate.rateId)}
                            selected={rate.rateId === shipstationSelectedRateId}
                            disabled={activeShipstationBusy}
                            onSelect={() => handleSelectShipstationRate(rate.rateId)}
                          />
                        ))}
                      </div>
                    </div>
                    {shipstationRatesExpanded ? (
                      <div
                        className="shipstation-rate-section"
                        role="group"
                        aria-labelledby="shipstation-other-rates-label"
                      >
                        <div id="shipstation-other-rates-label" className="shipstation-rate-section__label">
                          Other rates
                        </div>
                        <div className="shipstation-rate-list">
                          {activeShipstationRateGroups.otherRates.map((rate) => (
                            <ShipStationRateOption
                              key={rate.rateId}
                              rate={rate}
                              detail={activeShipstationPreparedRates.detailByRateId.get(rate.rateId)}
                              selected={rate.rateId === shipstationSelectedRateId}
                              disabled={activeShipstationBusy}
                              onSelect={() => handleSelectShipstationRate(rate.rateId)}
                            />
                          ))}
                        </div>
                      </div>
                    ) : activeShipstationSelectedOtherRate ? (
                      <div
                        className="shipstation-rate-section"
                        role="group"
                        aria-labelledby="shipstation-selected-rate-label"
                      >
                        <div id="shipstation-selected-rate-label" className="shipstation-rate-section__label">
                          Selected rate
                        </div>
                        <div className="shipstation-rate-list">
                          <ShipStationRateOption
                            rate={activeShipstationSelectedOtherRate}
                            detail={activeShipstationPreparedRates.detailByRateId.get(
                              activeShipstationSelectedOtherRate.rateId,
                            )}
                            selected
                            disabled={activeShipstationBusy}
                            onSelect={() => handleSelectShipstationRate(activeShipstationSelectedOtherRate.rateId)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {visibleShipstationInvalidRates.length ? (
                <div className="error shipstation-invalid-rates" role="status">
                  <strong>
                    {shipstationRates.length
                      ? 'Some ShipStation rates couldn’t be processed'
                      : 'ShipStation couldn’t quote these services'}
                  </strong>
                  {visibleShipstationInvalidRates.map((rate, rateIndex) => (
                    <div
                      key={`${rate.carrierId}:${rate.serviceCode}:${rateIndex}`}
                      className="shipstation-invalid-rate"
                    >
                      <span>
                        {[rate.carrierName, rate.serviceName].filter(Boolean).join(' · ')}
                      </span>
                      {rate.errorMessages.map((message, messageIndex) => (
                        <span key={`${rateIndex}:${messageIndex}`}>{message}</span>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {shipstationError ? <div className="error">{shipstationError}</div> : null}
          {shipstationAddressCorrection?.visibleFields.length ? (
            <div className="shipstation-address-correction" role="group" aria-label="Temporary ShipStation address corrections">
              <div className="shipstation-address-correction__heading">Correct the ShipStation address</div>
              <div className="muted small">
                {shipstationAddressCorrection.baseline
                  ? 'These changes apply only to the ShipStation shipment and do not update the saved fulfillment address.'
                  : 'The saved address is hidden for this account. Enter the requested values; they apply only to the ShipStation shipment.'}
              </div>
              <div className="shipstation-address-correction__fields">
                {shipstationAddressCorrection.visibleFields.map((field) => {
                  const config = SHIPSTATION_ADDRESS_FIELDS[field];
                  return (
                    <label key={field} className="shipstation-address-correction__field">
                      <span className="muted small">
                        {config.label}{config.optional ? ' (optional)' : ''}
                      </span>
                      <input
                        type="text"
                        value={shipstationAddressCorrection.draft[field]}
                        onChange={(evt) => {
                          const value = field === 'country_code' ? evt.target.value.toUpperCase() : evt.target.value;
                          setShipstationAddressCorrection((current) => current ? {
                            ...current,
                            draft: { ...current.draft, [field]: value },
                          } : current);
                        }}
                        maxLength={field === 'country_code' ? 2 : 50}
                        required={!config.optional}
                        disabled={activeShipstationBusy}
                        autoComplete={config.autoComplete}
                        aria-label={config.label}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="row row--end">
            <button
              type="button"
              className="secondary-light"
              onClick={handleCloseShipstationModal}
              disabled={activeShipstationBusy}
            >
              Cancel
            </button>
            {activeShipstationCanAdd ? (
              <button
                type="button"
                onClick={() => void handleAddToShipStation()}
                disabled={activeShipstationBusy || (
                  Boolean(shipstationAddressCorrection?.visibleFields.length) &&
                    !activeShipstationAddressCorrectionValid
                )}
              >
                {shipstationSaving ? 'Adding…' : 'Add to ShipStation'}
              </button>
            ) : shipstationReviewingVoid && activeShipstationLabel?.status === 'completed' ? (
              <>
                <button
                  type="button"
                  className="secondary-light"
                  onClick={() => {
                    setShipstationReviewingVoid(false);
                    setShipstationError(null);
                  }}
                  disabled={activeShipstationBusy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="shipstation-void-confirm"
                  onClick={() => void handleConfirmShipstationVoid()}
                  disabled={activeShipstationBusy}
                >
                  {shipstationVoiding ? 'Voiding…' : 'Confirm void'}
                </button>
              </>
            ) : activeShipstationPurchaseUnknown || activeShipstationLabel?.status === 'processing' ? (
              <button type="button" onClick={() => void refreshShipstationLabel(false)} disabled={activeShipstationBusy}>
                {shipstationLabelLoading ? 'Checking…' : 'Check purchase status'}
              </button>
            ) : activeShipstationLabel?.status === 'completed' ? (
              <>
                <button
                  type="button"
                  className="secondary-light shipstation-void-button"
                  onClick={() => {
                    setShipstationReviewingPurchase(false);
                    setShipstationReviewingVoid(true);
                    setShipstationError(null);
                  }}
                  disabled={activeShipstationBusy}
                >
                  Void label
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (shipstationLabelDownloadUrl) {
                      downloadShipStationLabel(shipstationLabelDownloadUrl);
                    } else {
                      void refreshShipstationLabel(true);
                    }
                  }}
                  disabled={activeShipstationBusy}
                >
                  {shipstationLabelLoading ? 'Preparing PDF…' : 'Download PDF'}
                </button>
              </>
            ) : shipstationReviewingPurchase && activeShipstationSelectedRate ? (
              <>
                <button
                  type="button"
                  className="secondary-light"
                  onClick={() => {
                    setShipstationReviewingPurchase(false);
                    setShipstationPurchaseRequestId(null);
                    setShipstationError(null);
                  }}
                  disabled={activeShipstationBusy}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmShipstationPurchase()}
                  disabled={activeShipstationBusy}
                >
                  {shipstationPurchasing
                    ? 'Purchasing…'
                    : `Confirm purchase · ${formatShipStationMoney(activeShipstationSelectedRate.totalAmount)}`}
                </button>
              </>
            ) : shipstationRates.length ? (
              <button
                type="button"
                onClick={handleReviewShipstationPurchase}
                disabled={activeShipstationBusy || !activeShipstationSelectedRate}
              >
                Review purchase
              </button>
            ) : activeShipstationCanGetRates ? (
              <button type="button" onClick={() => void handleGetShipstationRates()} disabled={activeShipstationBusy}>
                {shipstationRatesLoading ? 'Getting rates…' : shipstationRatesRequested ? 'Refresh rates' : 'Get rates'}
              </button>
            ) : null}
          </div>
        </div>
      </Modal>

      <Modal
        open={activeUpdateOrderKey !== null}
        title={activeUpdateOrder ? `Order ${activeUpdateOrder.deliveryId}` : 'Order'}
        onClose={handleCancelUpdate}
        showCloseButton={false}
        suspended={walletModalVisible}
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
            <button type="button" className="secondary-light" onClick={handleCancelUpdate}>
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
