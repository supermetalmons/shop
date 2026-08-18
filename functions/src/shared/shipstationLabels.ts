import type {
  FulfillmentShipStationLabel,
  ShipStationMoney,
} from './contracts.js';

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2';
const SHIPSTATION_LABEL_TIMEOUT_MS = 15_000;
const SHIPSTATION_LABEL_MAX_RESPONSE_BYTES = 256 * 1024;

export type ShipStationLabelResult = {
  label: FulfillmentShipStationLabel;
  downloadUrl?: string;
};

export type ShipStationLabelProviderErrorCode =
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'internal';

export class ShipStationLabelProviderError extends Error {
  constructor(
    readonly code: ShipStationLabelProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShipStationLabelProviderError';
  }
}

type ShipStationLabelProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ShipStationLabelClientOptions = Readonly<{
  fetch?: ShipStationLabelProviderFetch;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

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

function labelStatus(value: unknown): FulfillmentShipStationLabel['status'] {
  const normalized = stringValue(value);
  if (normalized === 'completed') return 'completed';
  if (normalized === 'processing' || normalized === 'error' || normalized === 'voided') return normalized;
  return 'error';
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
  if (!labelId || !shipmentId) return null;
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
    status: raw.voided === true ? 'voided' : labelStatus(raw.status),
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

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShipStationLabelProviderError('unavailable', 'ShipStation returned an oversized response');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ShipStationLabelProviderError('unavailable', 'ShipStation returned an oversized response');
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function shipStationErrorMessage(value: unknown, fallback: string): string {
  const errors = Array.isArray(record(value).errors) ? record(value).errors as unknown[] : [];
  const codes = Array.from(new Set(errors.flatMap((entry) => {
    const code = optionalString(record(entry).error_code);
    return code ? [code] : [];
  }))).slice(0, 5);
  if (codes.some((code) => /balance|fund|postage/i.test(code))) {
    return 'Insufficient ShipStation funds. Add funds or enable auto-funding in ShipStation.';
  }
  return codes.length ? codes.join('; ') : fallback;
}

function errorForStatus(status: number, message: string): ShipStationLabelProviderError {
  if (status === 401 || status === 403) {
    return new ShipStationLabelProviderError('failed-precondition', `ShipStation rejected the API key: ${message}`);
  }
  if (status === 429) {
    return new ShipStationLabelProviderError('resource-exhausted', `ShipStation rate limit: ${message}`);
  }
  if (status >= 500) {
    return new ShipStationLabelProviderError('unavailable', `ShipStation is unavailable: ${message}`);
  }
  return new ShipStationLabelProviderError('failed-precondition', `ShipStation rejected the shipment: ${message}`);
}

async function shipStationLabelFetch(
  apiKey: string,
  path: string,
  options: ShipStationLabelClientOptions,
): Promise<{ status: number; json: unknown }> {
  const providerFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('ShipStation request timed out', 'TimeoutError')),
    options.timeoutMs ?? SHIPSTATION_LABEL_TIMEOUT_MS,
  );
  try {
    const response = await providerFetch(`${SHIPSTATION_API_BASE}${path}`, {
      method: 'GET',
      headers: { 'API-Key': apiKey, Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await readBoundedText(
      response,
      options.maxResponseBytes ?? SHIPSTATION_LABEL_MAX_RESPONSE_BYTES,
      controller.signal,
    );
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  } catch (error) {
    if (error instanceof ShipStationLabelProviderError) throw error;
    throw new ShipStationLabelProviderError(
      controller.signal.aborted ? 'deadline-exceeded' : 'unavailable',
      controller.signal.aborted ? 'ShipStation request timed out' : 'Could not reach ShipStation',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function listShipStationLabelsForShipment(
  apiKey: string,
  shipmentId: string,
  options: ShipStationLabelClientOptions = {},
): Promise<ShipStationLabelResult[]> {
  const query = new URLSearchParams({ shipment_id: shipmentId, page_size: '50', sort_dir: 'desc' });
  const { status, json } = await shipStationLabelFetch(apiKey, `/labels?${query.toString()}`, options);
  if (status < 200 || status >= 300) {
    throw errorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
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
    options,
  );
  if (status < 200 || status >= 300) {
    throw errorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const payload = record(json);
  const result = shipStationLabelResult(payload.label ?? json);
  if (!result || result.label.labelId !== labelId) {
    throw new ShipStationLabelProviderError('internal', 'ShipStation did not return the requested label');
  }
  return result;
}
