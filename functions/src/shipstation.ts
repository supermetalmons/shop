import { HttpsError } from 'firebase-functions/v2/https';

import type {
  FulfillmentShipStationRate,
  ShipStationMoney,
} from './shared/contracts.js';
import {
  getShipStationLabelById as getSharedShipStationLabelById,
  isActiveShipStationLabel,
  listShipStationLabelsForShipment as listSharedShipStationLabelsForShipment,
  shipStationLabelResult,
  ShipStationLabelProviderError,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  type ShipStationLabelResult,
} from './shared/shipstationLabels.js';
import {
  buildShipStationPackages as buildSharedShipStationPackages,
  getShipStationRateById as getSharedShipStationRateById,
  getShipStationShipmentRates as getSharedShipStationShipmentRates,
  requestShipStationShipmentRates as requestSharedShipStationShipmentRates,
  shipStationPackageDetails as sharedShipStationPackageDetails,
  shipStationPackageInputFromShipmentPackage as sharedShipStationPackageInputFromShipmentPackage,
  shipStationRateSummaries as sharedShipStationRateSummaries,
  ShipStationRatesProviderError,
  updateShipStationShipment as updateSharedShipStationShipment,
  type ShipStationAddress,
  type ShipStationPackage,
  type ShipStationRateResponse,
  type ShipStationShipment,
} from './shared/shipstationRates.js';

export {
  isActiveShipStationLabel,
  shipStationLabelResult,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
};
export type { ShipStationLabelResult };
export type {
  ShipStationAddress,
  ShipStationPackage,
  ShipStationRateResponse,
  ShipStationShipment,
};

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2';
const SHIPSTATION_TIMEOUT_MS = 15_000;

export async function adoptOrPurchaseShipStationLabel(
  findExisting: () => Promise<ShipStationLabelResult | null>,
  purchase: () => Promise<ShipStationLabelResult>,
): Promise<{ result: ShipStationLabelResult; alreadyPurchased: boolean }> {
  const existing = await findExisting();
  if (existing) return { result: existing, alreadyPurchased: true };
  return { result: await purchase(), alreadyPurchased: false };
}

export function shipStationMoneyMatches(expected: ShipStationMoney, actual: ShipStationMoney): boolean {
  return expected.currency.trim().toLowerCase() === actual.currency && Math.abs(expected.amount - actual.amount) < 0.005;
}

export const shipStationPackageInputFromShipmentPackage = sharedShipStationPackageInputFromShipmentPackage;
export const shipStationPackageDetails = sharedShipStationPackageDetails;
export const shipStationRateSummaries = sharedShipStationRateSummaries;
export const buildShipStationPackages = buildSharedShipStationPackages;

async function shipStationFetch(
  apiKey: string,
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown },
): Promise<{ status: number; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHIPSTATION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${SHIPSTATION_API_BASE}${path}`, {
      method: init.method,
      headers: {
        'API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as any)?.name === 'AbortError';
    throw new HttpsError(
      aborted ? 'deadline-exceeded' : 'unavailable',
      aborted ? 'ShipStation request timed out' : 'Could not reach ShipStation',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json };
}

/**
 * ShipStation validation errors quote the submitted address back at us, and whatever we
 * return here lands in `shipstation.lastError` (stored unencrypted next to the encrypted
 * snapshot) and in the operator-facing error. So: machine-readable codes only, never
 * `message` and never the raw response body.
 */
function shipStationErrorCodes(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  const codes = errors
    .map((error: any) => (typeof error?.error_code === 'string' ? error.error_code : ''))
    .map((code: string) => code.trim())
    .filter(Boolean);
  return Array.from(new Set(codes)).slice(0, 5);
}

export function shipStationErrorMessage(json: any, fallback: string): string {
  const codes = shipStationErrorCodes(json?.errors);
  if (codes.some((code) => /balance|fund|postage/i.test(code))) {
    return 'Insufficient ShipStation funds. Add funds or enable auto-funding in ShipStation.';
  }
  return codes.length ? codes.join('; ') : fallback;
}

function httpsErrorForStatus(status: number, message: string): HttpsError {
  if (status === 401 || status === 403) return new HttpsError('failed-precondition', `ShipStation rejected the API key: ${message}`);
  if (status === 429) return new HttpsError('resource-exhausted', `ShipStation rate limit: ${message}`);
  if (status >= 500) return new HttpsError('unavailable', `ShipStation is unavailable: ${message}`);
  return new HttpsError('failed-precondition', `ShipStation rejected the shipment: ${message}`);
}

async function withFirebaseRatesError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ShipStationRatesProviderError) throw new HttpsError(error.code, error.message);
    throw error;
  }
}

export async function updateShipStationShipment(
  apiKey: string,
  shipmentId: string,
  update: { ship_to?: ShipStationAddress; ship_from?: ShipStationAddress; packages?: ShipStationPackage[] },
): Promise<ShipStationShipment> {
  return withFirebaseRatesError(() => updateSharedShipStationShipment(apiKey, shipmentId, update));
}

export async function requestShipStationShipmentRates(
  apiKey: string,
  shipmentId: string,
): Promise<ShipStationRateResponse> {
  return withFirebaseRatesError(() => requestSharedShipStationShipmentRates(apiKey, shipmentId));
}

export async function getShipStationShipmentRates(
  apiKey: string,
  shipmentId: string,
  expectedRequest: { requestId: string; createdAt?: string },
): Promise<ShipStationRateResponse> {
  return withFirebaseRatesError(() => getSharedShipStationShipmentRates(apiKey, shipmentId, expectedRequest));
}

export async function getShipStationRateById(
  apiKey: string,
  rateId: string,
  shipmentId: string,
): Promise<FulfillmentShipStationRate> {
  return withFirebaseRatesError(() => getSharedShipStationRateById(apiKey, rateId, shipmentId));
}

export async function listShipStationLabelsForShipment(
  apiKey: string,
  shipmentId: string,
): Promise<ShipStationLabelResult[]> {
  try {
    return await listSharedShipStationLabelsForShipment(apiKey, shipmentId);
  } catch (error) {
    if (error instanceof ShipStationLabelProviderError) {
      throw new HttpsError(error.code, error.message);
    }
    throw error;
  }
}

export async function getShipStationLabelById(apiKey: string, labelId: string): Promise<ShipStationLabelResult> {
  try {
    return await getSharedShipStationLabelById(apiKey, labelId);
  } catch (error) {
    if (error instanceof ShipStationLabelProviderError) {
      throw new HttpsError(error.code, error.message);
    }
    throw error;
  }
}

export async function createShipStationLabelFromRate(
  apiKey: string,
  rateId: string,
): Promise<ShipStationLabelResult> {
  const { status, json } = await shipStationFetch(apiKey, `/labels/rates/${encodeURIComponent(rateId)}`, {
    method: 'POST',
    body: {
      label_format: 'pdf',
      label_layout: '4x6',
      label_download_type: 'url',
    },
  });
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const result = shipStationLabelResult(json?.label || json);
  if (!result) throw new HttpsError('internal', 'ShipStation did not return a label id');
  return result;
}
