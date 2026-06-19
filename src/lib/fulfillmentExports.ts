import type { FrontendDeploymentConfig } from '../config/deployment';
import type { DropFigureFulfillmentPreviewMode } from '../config/dropsExtraContent';
import type { FulfillmentOrder, FulfillmentOrderAddress, FulfillmentOrderBox, FulfillmentStatus } from '../types';
import type { FigureMetadataRecord } from './figureMetadata';
import { fulfillmentBoxSecretCode } from './fulfillmentCodes';
import { resolveDropContent } from './dropContent';
import { isDirectDeliveryItemsPerBox } from './shipping';
import { findCountryByCode } from './countries';
import {
  fulfillmentBoxContentsLabel,
  resolveFulfillmentDirectDeliveryBoxLabel,
  resolveFulfillmentFigureLabel,
} from './fulfillmentLabels';
import { normalizeFulfillmentStatusOrNull } from './fulfillmentStatus';

export type FulfillmentExportFigure = {
  figureId: number;
  label: string;
};

export type FulfillmentExportBox = {
  boxId: number;
  label: string;
  secretCode?: string;
  assignedFigures?: FulfillmentExportFigure[];
};

export type FulfillmentOrderExport = {
  orderId: string;
  dropId: string;
  deliveryId: number;
  date: string | null;
  fulfillmentStatus: FulfillmentStatus | null;
  country?: string;
  countryCode?: string;
  boxes: FulfillmentExportBox[];
  looseFigures: FulfillmentExportFigure[];
};

export type FulfillmentAddressExportEntry = {
  address: string[] | null;
  email?: string;
  phone?: string;
};

export type FulfillmentOrdersExportOptions = {
  dropById: ReadonlyMap<string, FrontendDeploymentConfig>;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
};

export type FulfillmentExportFilenameKind = 'orders' | 'addresses-sensitive';

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

function formatIsoDate(ts?: number): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function countryExportFields(address: FulfillmentOrderAddress): Pick<FulfillmentOrderExport, 'country' | 'countryCode'> {
  const country = normalizeOptionalString(formatFulfillmentCountry(address.country, address.countryCode));
  const rawCountryCode = normalizeOptionalString(address.countryCode);
  const rawCountry = normalizeOptionalString(address.country);
  const countryCode = rawCountryCode
    ? rawCountryCode.toUpperCase()
    : rawCountry && findCountryByCode(rawCountry)
      ? rawCountry.toUpperCase()
      : undefined;
  return {
    ...(country ? { country } : {}),
    ...(countryCode ? { countryCode } : {}),
  };
}

function figureExportItem(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | null;
  figureId: number;
  previewMode: DropFigureFulfillmentPreviewMode;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
}): FulfillmentExportFigure | null {
  const figureId = normalizePositiveInteger(args.figureId);
  if (!figureId) return null;

  return {
    figureId,
    label: resolveFulfillmentFigureLabel({
      dropId: args.dropId,
      drop: args.drop,
      figureId,
      previewMode: args.previewMode,
      figureMetadataByKey: args.figureMetadataByKey,
    }).label,
  };
}

function buildFigureExports(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | null;
  previewMode: DropFigureFulfillmentPreviewMode;
  figureIds: number[];
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
}): FulfillmentExportFigure[] {
  return args.figureIds
    .map((figureId) =>
      figureExportItem({
        ...args,
        figureId,
      }),
    )
    .filter((entry): entry is FulfillmentExportFigure => Boolean(entry));
}

function boxExportItem(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | null;
  previewMode: DropFigureFulfillmentPreviewMode;
  box: FulfillmentOrderBox;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
}): FulfillmentExportBox {
  const boxId = Math.floor(Number(args.box.boxId));
  const secretCode = fulfillmentBoxSecretCode(args.box);
  const isDirectDelivery = isDirectDeliveryItemsPerBox(args.drop?.itemsPerBox);
  const label = isDirectDelivery
    ? resolveFulfillmentDirectDeliveryBoxLabel(args.drop, boxId).label
    : fulfillmentBoxContentsLabel(args.drop, boxId, secretCode);

  return {
    boxId,
    label,
    ...(secretCode ? { secretCode } : {}),
    ...(!isDirectDelivery
      ? {
          assignedFigures: buildFigureExports({
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
    return {
      orderId: fulfillmentExportOrderId(order),
      dropId: order.dropId,
      deliveryId: order.deliveryId,
      date: formatIsoDate(order.processedAt || order.createdAt),
      fulfillmentStatus: normalizeFulfillmentStatusOrNull(order.fulfillmentStatus),
      ...countryExportFields(order.address),
      boxes: order.boxes.map((box) =>
        boxExportItem({
          dropId: order.dropId,
          drop,
          previewMode,
          box,
          figureMetadataByKey: options.figureMetadataByKey,
        }),
      ),
      looseFigures: buildFigureExports({
        dropId: order.dropId,
        drop,
        previewMode,
        figureIds: order.looseDudes,
        figureMetadataByKey: options.figureMetadataByKey,
      }),
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
  const prefix = args.kind === 'orders' ? 'orders' : 'addresses-SENSITIVE';
  const dropSegment = sanitizeFilenameSegment(args.selectedDropId, 'all-drops');
  const statusSegment = sanitizeFilenameSegment(args.orderVisibilityFilter, 'all');
  const dateSegment = formatDateStamp(args.now || new Date());
  return `${prefix}-${dropSegment}-${statusSegment}-${dateSegment}.json`;
}
