import { isDropFamily, type FrontendDeploymentConfig } from '../config/deployment';
import type { DropFigureFulfillmentPreviewMode } from '../config/dropsExtraContent';
import type { FulfillmentOrder, FulfillmentOrderAddress, FulfillmentOrderBox } from '../types';
import type { FigureMetadataRecord } from './figureMetadata';
import { fulfillmentBoxSecretCode } from './fulfillmentCodes';
import { resolveBoxMediaIdForDrop, resolveDropContent } from './dropContent';
import { isDirectDeliveryItemsPerBox } from './shipping';
import { findCountryByCode } from './countries';
import { resolveFulfillmentDirectDeliveryBoxLabel, resolveFulfillmentFigureLabel } from './fulfillmentLabels';

export type FulfillmentExportBox = {
  secretCode?: string;
  style?: string;
  variant?: string;
  figures?: number[];
};

export type FulfillmentOrderExport = {
  orderId: string;
  country?: string;
  boxes?: FulfillmentExportBox[];
  looseFigures?: number[];
};

export type FulfillmentAddressExportEntry = {
  address: string[] | null;
  email?: string;
  phone?: string;
};

export type FulfillmentSecretCodeExportEntry = {
  orderId: string;
  boxId: number;
  boxIndex: number;
  secretCode: string;
  claimUrl: string;
  filename: string;
};

export type FulfillmentOrdersExportOptions = {
  dropById: ReadonlyMap<string, FrontendDeploymentConfig>;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
};

export type FulfillmentExportFilenameKind = 'orders' | 'addresses-sensitive' | 'secret-codes';

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

export function fulfillmentExportOrderId(order: Pick<FulfillmentOrder, 'dropId' | 'deliveryId'>): string {
  return `${order.dropId}:${order.deliveryId}`;
}

export function fulfillmentSecretCodeClaimUrl(secretCode: string): string {
  return `https://mons.shop/claim/?code=${encodeURIComponent(secretCode)}`;
}

export function formatFulfillmentCountry(country?: string, countryCode?: string): string {
  const countryCodeName = findCountryByCode(countryCode)?.name;
  if (countryCodeName) return countryCodeName;

  const countryValue = typeof country === 'string' ? country.trim() : '';
  const countryValueName = findCountryByCode(countryValue)?.name;
  return countryValueName || countryValue || (typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '');
}

export function formatFulfillmentAddressText(address: FulfillmentOrderAddress): string {
  const formattedCountry = formatFulfillmentCountry(address.country, address.countryCode);
  if (address.full === '***') return formattedCountry || '***';
  if (typeof address.full !== 'string') return '';

  const countryCode = (address.countryCode || address.country || '').trim().toUpperCase();
  if (!countryCode || !formattedCountry) return address.full;

  const lines = address.full.split('\n');
  const finalLineIndex = lines.length - 1;
  if (lines[finalLineIndex]?.trim().toUpperCase() !== countryCode) return address.full;

  const nextLines = [...lines];
  nextLines[finalLineIndex] = formattedCountry;
  return nextLines.join('\n');
}

function countryExportFields(address: FulfillmentOrderAddress): Pick<FulfillmentOrderExport, 'country'> {
  const country = normalizeOptionalString(formatFulfillmentCountry(address.country, address.countryCode));
  return {
    ...(country ? { country } : {}),
  };
}

function figureExportLabel(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | null;
  figureId: number;
  previewMode: DropFigureFulfillmentPreviewMode;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
}): number | null {
  const figureId = normalizePositiveInteger(args.figureId);
  if (!figureId) return null;

  const label = resolveFulfillmentFigureLabel({
    dropId: args.dropId,
    drop: args.drop,
    figureId,
    previewMode: args.previewMode,
    figureMetadataByKey: args.figureMetadataByKey,
  }).label;
  return normalizePositiveInteger(label);
}

function buildFigureExports(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | null;
  previewMode: DropFigureFulfillmentPreviewMode;
  figureIds: number[];
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
}): number[] {
  return args.figureIds
    .map((figureId) =>
      figureExportLabel({
        ...args,
        figureId,
      }),
    )
    .filter((entry): entry is number => Boolean(entry));
}

function cardNft2PackStyleName(styleId: number | null): string | undefined {
  switch (styleId) {
    case 1:
      return 'blue';
    case 2:
      return 'red';
    case 3:
      return 'yellow';
    case 4:
      return 'purple';
    default:
      return undefined;
  }
}

function boxExportItem(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | null;
  previewMode: DropFigureFulfillmentPreviewMode;
  box: FulfillmentOrderBox;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
}): FulfillmentExportBox {
  const secretCode = fulfillmentBoxSecretCode(args.box);
  const isDirectDelivery = isDirectDeliveryItemsPerBox(args.drop?.itemsPerBox);
  const boxId = normalizePositiveInteger(args.box.boxId);
  const style =
    boxId && isDropFamily(args.drop?.dropId || args.dropId, 'card_nft_2')
      ? cardNft2PackStyleName(resolveBoxMediaIdForDrop(args.dropId, boxId))
      : undefined;
  const variant = isDirectDelivery && boxId ? resolveFulfillmentDirectDeliveryBoxLabel(args.drop, boxId).sizeLabel : undefined;

  return {
    ...(secretCode ? { secretCode } : {}),
    ...(style ? { style } : {}),
    ...(variant ? { variant } : {}),
    ...(!isDirectDelivery
      ? {
          figures: buildFigureExports({
            dropId: args.dropId,
            drop: args.drop,
            previewMode: args.previewMode,
            figureIds: args.box.dudeIds,
            figureMetadataByKey: args.figureMetadataByKey,
          }),
        }
      : {}),
  };
}

export function buildFulfillmentOrdersExport(
  orders: FulfillmentOrder[],
  options: FulfillmentOrdersExportOptions,
): FulfillmentOrderExport[] {
  return orders.map((order) => {
    const drop = options.dropById.get(order.dropId) || null;
    const previewMode = resolveDropContent(drop || order.dropId).figures.fulfillmentPreviewMode;
    const boxes = order.boxes.map((box) =>
      boxExportItem({
        dropId: order.dropId,
        drop,
        previewMode,
        box,
        figureMetadataByKey: options.figureMetadataByKey,
      }),
    );
    const looseFigures = buildFigureExports({
      dropId: order.dropId,
      drop,
      previewMode,
      figureIds: order.looseDudes,
      figureMetadataByKey: options.figureMetadataByKey,
    });
    return {
      orderId: fulfillmentExportOrderId(order),
      ...countryExportFields(order.address),
      ...(boxes.length > 0 ? { boxes } : {}),
      ...(looseFigures.length > 0 ? { looseFigures } : {}),
    };
  });
}

export function buildFulfillmentAddressExport(orders: FulfillmentOrder[]): Record<string, FulfillmentAddressExportEntry> {
  return Object.fromEntries(
    orders.map((order) => {
      const fullAddress = typeof order.address.full === 'string' ? order.address.full.trim() : '';
      const addressText = fullAddress && fullAddress !== '***' ? formatFulfillmentAddressText(order.address) : null;
      const addressLines = addressText ? addressText.replace(/\r\n?/g, '\n').split('\n') : null;
      const showContact = order.address.full !== '***';
      const email = showContact ? normalizeOptionalString(order.address.email) : undefined;
      const phone = showContact ? normalizeOptionalString(order.address.phone) : undefined;
      return [
        fulfillmentExportOrderId(order),
        {
          address: addressLines,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        },
      ];
    }),
  );
}

function uniqueFilename(filename: string, usedFilenames: Set<string>): string {
  if (!usedFilenames.has(filename)) {
    usedFilenames.add(filename);
    return filename;
  }

  const dotIndex = filename.lastIndexOf('.');
  const basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';
  let index = 2;
  while (usedFilenames.has(`${basename}-${index}${extension}`)) {
    index += 1;
  }
  const nextFilename = `${basename}-${index}${extension}`;
  usedFilenames.add(nextFilename);
  return nextFilename;
}

export function buildFulfillmentSecretCodeExportEntries(orders: FulfillmentOrder[]): FulfillmentSecretCodeExportEntry[] {
  const usedFilenames = new Set<string>();
  return orders.flatMap((order) => {
    const orderId = fulfillmentExportOrderId(order);
    let secretCodeIndex = 0;
    return order.boxes.flatMap((box, boxIndex) => {
      const secretCode = fulfillmentBoxSecretCode(box);
      if (!secretCode) return [];

      secretCodeIndex += 1;
      const orderSegment = sanitizeFilenameSegment(String(order.deliveryId), 'order');
      const filename = uniqueFilename(`${orderSegment}-${secretCodeIndex}.png`, usedFilenames);

      return [
        {
          orderId,
          boxId: box.boxId,
          boxIndex,
          secretCode,
          claimUrl: fulfillmentSecretCodeClaimUrl(secretCode),
          filename,
        },
      ];
    });
  });
}

function sanitizeFilenameSegment(value: string, fallback: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return normalized || fallback;
}

function formatDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildFulfillmentExportFilename(args: {
  kind: FulfillmentExportFilenameKind;
  selectedDropId: string;
  orderVisibilityFilter: string;
  now?: Date;
}): string {
  const exportKind = {
    orders: { prefix: 'orders', extension: 'json' },
    'addresses-sensitive': { prefix: 'addresses-SENSITIVE', extension: 'json' },
    'secret-codes': { prefix: 'secret-codes', extension: 'zip' },
  }[args.kind];
  const dropSegment = sanitizeFilenameSegment(args.selectedDropId, 'all-drops');
  const statusSegment = sanitizeFilenameSegment(args.orderVisibilityFilter, 'all');
  const dateSegment = formatDateStamp(args.now || new Date());
  return `${exportKind.prefix}-${dropSegment}-${statusSegment}-${dateSegment}.${exportKind.extension}`;
}
