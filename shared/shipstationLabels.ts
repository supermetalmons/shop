import { createShipStationTransport, type ShipStationClientOptions, type ShipStationProviderErrorCode } from './shipstationTransport.ts';
import type {
  FulfillmentShipStationLabel,
  ShipStationMoney,
} from './contracts.ts';
import { shipStationErrorDetails, type ShipStationErrorDiagnostics } from './shipstationErrors.ts';

export type ShipStationLabelResult = {
  label: FulfillmentShipStationLabel;
  downloadUrl?: string;
};

export type ShipStationLabelVoidResult = {
  alreadyVoided: boolean;
};

export type ShipStationLabelProviderErrorCode = ShipStationProviderErrorCode;

export class ShipStationLabelProviderError extends Error {
  constructor(
    readonly code: ShipStationLabelProviderErrorCode,
    message: string,
    readonly diagnostics?: ShipStationErrorDiagnostics,
  ) {
    super(message);
    this.name = 'ShipStationLabelProviderError';
  }
}

const { request: shipStationLabelFetch, errorForStatus } = createShipStationTransport(ShipStationLabelProviderError, 256 * 1024);

export type ShipStationLabelClientOptions = ShipStationClientOptions;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizedCurrency(value: unknown, fallback?: string): string | null {
  const currency = stringValue(value).toLowerCase();
  if (/^[a-z]{3}$/.test(currency)) return currency;
  return fallback && /^[a-z]{3}$/.test(fallback) ? fallback : null;
}

function shipStationMoney(value: unknown, fallbackCurrency?: string): ShipStationMoney | null {
  const raw = record(value);
  const amount = finiteNumber(raw.amount);
  const currency = normalizedCurrency(raw.currency, fallbackCurrency);
  if (amount == null || amount < 0 || !currency) return null;
  return { currency, amount: roundCurrency(amount) };
}

function labelStatus(value: unknown): FulfillmentShipStationLabel['status'] | null {
  const normalized = stringValue(value);
  if (normalized === 'completed') return 'completed';
  if (normalized === 'processing' || normalized === 'error' || normalized === 'voided') return normalized;
  return null;
}

function labelDownloadUrl(value: unknown): string | undefined {
  const raw = record(value);
  const url = stringValue(raw.pdf) || stringValue(raw.href);
  return /^https:\/\//i.test(url) ? url : undefined;
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}

export function isActiveShipStationLabel(
  label: Pick<FulfillmentShipStationLabel, 'status'> | null | undefined,
): boolean {
  return label?.status === 'completed' || label?.status === 'processing';
}

export function shouldClearShipStationPurchaseState(
  label: Pick<FulfillmentShipStationLabel, 'status'>,
  confirmedPurchase = false,
): boolean {
  return confirmedPurchase || isActiveShipStationLabel(label);
}

export function shouldTransitionShipStationPurchaseState(
  purchase: unknown,
  expectedRequestId: string | undefined,
  hasActiveLabel: boolean,
): boolean {
  const raw = record(purchase);
  if (hasActiveLabel || raw.status !== 'purchasing') return false;
  const currentRequestId = typeof raw.requestId === 'string' ? raw.requestId : undefined;
  return expectedRequestId ? currentRequestId === expectedRequestId : currentRequestId === undefined;
}

export function shipStationTrackingCodeUpdate(
  currentTrackingCode: string | undefined,
  currentLabel: Pick<FulfillmentShipStationLabel, 'labelId' | 'trackingNumber'> | undefined,
  nextLabel: Pick<FulfillmentShipStationLabel, 'labelId' | 'status' | 'trackingNumber'>,
): string | null | undefined {
  if (isActiveShipStationLabel(nextLabel) && nextLabel.trackingNumber) return nextLabel.trackingNumber;
  if (
    currentTrackingCode &&
    currentLabel?.trackingNumber === currentTrackingCode &&
    (currentLabel.labelId !== nextLabel.labelId || !isActiveShipStationLabel(nextLabel))
  ) {
    return null;
  }
  return undefined;
}

export function shipStationLabelResult(value: unknown): ShipStationLabelResult | null {
  const raw = record(value);
  const labelId = stringValue(raw.label_id);
  const shipmentId = stringValue(raw.shipment_id);
  const providerStatus = labelStatus(raw.status);
  if (!labelId || !shipmentId || !providerStatus) return null;
  const status = raw.voided === true ? 'voided' : providerStatus;
  const shipmentCost = shipStationMoney(raw.shipment_cost);
  const insuranceCost = shipStationMoney(raw.insurance_cost, shipmentCost?.currency);
  const createdAt = Date.parse(stringValue(raw.created_at));
  const totalCost = shipmentCost && (!insuranceCost || insuranceCost.currency === shipmentCost.currency)
    ? {
        currency: shipmentCost.currency,
        amount: roundCurrency(shipmentCost.amount + (insuranceCost?.amount ?? 0)),
      }
    : undefined;
  const label: FulfillmentShipStationLabel = {
    labelId,
    shipmentId,
    status,
    ...(optionalString(raw.rate_id) ? { rateId: optionalString(raw.rate_id) } : {}),
    ...(optionalString(raw.tracking_number) ? { trackingNumber: optionalString(raw.tracking_number) } : {}),
    ...(optionalString(raw.carrier_id) ? { carrierId: optionalString(raw.carrier_id) } : {}),
    ...(optionalString(raw.carrier_code) ? { carrierCode: optionalString(raw.carrier_code) } : {}),
    ...(optionalString(raw.carrier_friendly_name) ? { carrierName: optionalString(raw.carrier_friendly_name) } : {}),
    ...(optionalString(raw.service_code) ? { serviceCode: optionalString(raw.service_code) } : {}),
    ...(optionalString(raw.service_type) ? { serviceName: optionalString(raw.service_type) } : {}),
    ...(shipmentCost ? { shipmentCost } : {}),
    ...(insuranceCost ? { insuranceCost } : {}),
    ...(totalCost ? { totalCost } : {}),
    ...(Number.isFinite(createdAt) ? { purchasedAt: createdAt } : {}),
  };
  const downloadUrl = labelDownloadUrl(raw.label_download);
  return { label, ...(downloadUrl ? { downloadUrl } : {}) };
}

export function storedFulfillmentShipStationLabel(value: unknown): FulfillmentShipStationLabel | undefined {
  const raw = record(value);
  const labelId = stringValue(raw.labelId);
  const shipmentId = stringValue(raw.shipmentId);
  const status = raw.status;
  if (
    !labelId ||
    !shipmentId ||
    (status !== 'processing' && status !== 'completed' && status !== 'error' && status !== 'voided')
  ) return undefined;
  const shipmentCost = shipStationMoney(raw.shipmentCost);
  const insuranceCost = shipStationMoney(raw.insuranceCost);
  const totalCost = shipStationMoney(raw.totalCost);
  const purchasedAt = finiteNumber(raw.purchasedAt);
  return {
    labelId,
    shipmentId,
    status,
    ...(optionalString(raw.rateId) ? { rateId: optionalString(raw.rateId) } : {}),
    ...(optionalString(raw.trackingNumber) ? { trackingNumber: optionalString(raw.trackingNumber) } : {}),
    ...(optionalString(raw.carrierId) ? { carrierId: optionalString(raw.carrierId) } : {}),
    ...(optionalString(raw.carrierCode) ? { carrierCode: optionalString(raw.carrierCode) } : {}),
    ...(optionalString(raw.carrierName) ? { carrierName: optionalString(raw.carrierName) } : {}),
    ...(optionalString(raw.serviceCode) ? { serviceCode: optionalString(raw.serviceCode) } : {}),
    ...(optionalString(raw.serviceName) ? { serviceName: optionalString(raw.serviceName) } : {}),
    ...(shipmentCost ? { shipmentCost } : {}),
    ...(insuranceCost ? { insuranceCost } : {}),
    ...(totalCost ? { totalCost } : {}),
    ...(purchasedAt && purchasedAt > 0 ? { purchasedAt } : {}),
    ...(optionalString(raw.purchasedBy) ? { purchasedBy: optionalString(raw.purchasedBy) } : {}),
  };
}

export async function listShipStationLabelsForShipment(
  apiKey: string,
  shipmentId: string,
  options: ShipStationLabelClientOptions = {},
): Promise<ShipStationLabelResult[]> {
  const query = new URLSearchParams({ shipment_id: shipmentId, page_size: '50', sort_dir: 'desc' });
  const { status, json } = await shipStationLabelFetch(
    apiKey,
    `/labels?${query.toString()}`,
    { method: 'GET' },
    options,
  );
  if (status < 200 || status >= 300) {
    throw errorForStatus(status, json, 'label lookup');
  }
  const labels = record(json).labels;
  if (!Array.isArray(labels)) {
    throw new ShipStationLabelProviderError('internal', 'ShipStation returned an invalid label list');
  }
  const parsedLabels = labels.map(shipStationLabelResult);
  if (parsedLabels.some((result) => result === null)) {
    throw new ShipStationLabelProviderError('internal', 'ShipStation returned an invalid label list');
  }
  return parsedLabels
    .filter((result): result is ShipStationLabelResult => result !== null)
    .filter((result) => result.label.shipmentId === shipmentId && isActiveShipStationLabel(result.label));
}

export async function getShipStationLabelById(
  apiKey: string,
  labelId: string,
  options: ShipStationLabelClientOptions = {},
): Promise<ShipStationLabelResult> {
  const query = new URLSearchParams({ label_download_type: 'url' });
  const { status, json } = await shipStationLabelFetch(
    apiKey,
    `/labels/${encodeURIComponent(labelId)}?${query.toString()}`,
    { method: 'GET' },
    options,
  );
  if (status < 200 || status >= 300) {
    throw errorForStatus(status, json, 'label lookup');
  }
  const payload = record(json);
  const result = shipStationLabelResult(payload.label ?? json);
  if (!result || result.label.labelId !== labelId) {
    throw new ShipStationLabelProviderError('internal', 'ShipStation did not return the requested label');
  }
  return result;
}

export async function createShipStationLabelFromRate(
  apiKey: string,
  rateId: string,
  options: ShipStationLabelClientOptions = {},
): Promise<ShipStationLabelResult> {
  const { status, json } = await shipStationLabelFetch(
    apiKey,
    `/labels/rates/${encodeURIComponent(rateId)}`,
    {
      method: 'POST',
      body: {
        label_format: 'pdf',
        label_layout: '4x6',
        label_download_type: 'url',
      },
    },
    options,
  );
  if (status === 408) {
    const { message, diagnostics } = shipStationErrorDetails(json, 'ShipStation request timed out', status);
    throw new ShipStationLabelProviderError('deadline-exceeded', `ShipStation label purchase timed out: ${message}`, {
      ...diagnostics, operation: 'label purchase',
    });
  }
  if (status < 200 || status >= 300) {
    throw errorForStatus(status, json, 'label purchase');
  }
  const payload = record(json);
  const result = shipStationLabelResult(payload.label ?? json);
  if (!result) {
    const { message, diagnostics } = shipStationErrorDetails(json, 'ShipStation returned an invalid label', status);
    throw new ShipStationLabelProviderError('internal', `ShipStation label purchase was not confirmed: ${message}`, {
      ...diagnostics, operation: 'label purchase',
    });
  }
  return result;
}

function shipStationLabelVoidRejectionMessage(reasonCode: string): string {
  if (reasonCode === 'label_already_used') {
    return 'This label has already been used and cannot be voided.';
  }
  if (reasonCode === 'label_not_found_within_void_period') {
    return 'This label is outside the carrier\'s allowed void period.';
  }
  if (reasonCode === 'contact_carrier') {
    return 'Contact the carrier to void this label.';
  }
  return 'ShipStation did not approve the label void request.';
}

export async function voidShipStationLabel(
  apiKey: string,
  labelId: string,
  options: ShipStationLabelClientOptions = {},
): Promise<ShipStationLabelVoidResult> {
  const { status, json } = await shipStationLabelFetch(
    apiKey,
    `/labels/${encodeURIComponent(labelId)}/void`,
    { method: 'PUT' },
    options,
  );
  if (status === 408) {
    const { message, diagnostics } = shipStationErrorDetails(json, 'ShipStation request timed out', status);
    throw new ShipStationLabelProviderError('deadline-exceeded', `ShipStation label void request timed out: ${message}`, {
      ...diagnostics, operation: 'label void request',
    });
  }
  if (status < 200 || status >= 300) {
    throw errorForStatus(
      status,
      json,
      'label void request',
    );
  }
  const raw = record(json);
  if (typeof raw.approved !== 'boolean') {
    throw new ShipStationLabelProviderError('internal', 'ShipStation returned an invalid label void response');
  }
  if (raw.approved) return { alreadyVoided: false };
  const reasonCode = stringValue(raw.reason_code);
  if (reasonCode === 'label_already_voided') return { alreadyVoided: true };
  throw new ShipStationLabelProviderError(
    'failed-precondition',
    shipStationLabelVoidRejectionMessage(reasonCode),
  );
}

export async function adoptOrPurchaseShipStationLabel(
  findExisting: () => Promise<ShipStationLabelResult | null>,
  purchase: () => Promise<ShipStationLabelResult>,
): Promise<{ result: ShipStationLabelResult; alreadyPurchased: boolean }> {
  const existing = await findExisting();
  if (existing) return { result: existing, alreadyPurchased: true };
  return { result: await purchase(), alreadyPurchased: false };
}
