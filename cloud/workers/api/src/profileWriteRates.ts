import type { GetFulfillmentShipStationRatesResponse } from '../../../../shared/contracts.js';
import type { ShipStationPackageInput } from '../../../../shared/shipstationPackage.js';
import { isRecord } from './dataAccess.js';

export function commerceMoney(
  value: { currency: string; amount: number },
): { currency: string; amount: number } {
  return { currency: value.currency, amount: value.amount };
}

export function commercePackage(value: ShipStationPackageInput): ShipStationPackageInput {
  return { ...value };
}

export function commerceRateQuotes(
  rates: GetFulfillmentShipStationRatesResponse['rates'],
): Array<{ rateId: string; shipmentId: string; totalAmount: { currency: string; amount: number } }> {
  return rates.map((rate) => ({
    rateId: rate.rateId,
    shipmentId: rate.shipmentId,
    totalAmount: commerceMoney(rate.totalAmount),
  }));
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function storedShipStationMoney(
  value: unknown,
): { currency: string; amount: number } | undefined {
  if (!isRecord(value)) return undefined;
  const currency = optionalString(value.currency)?.toLowerCase() ?? '';
  const amount = typeof value.amount === 'number' ? value.amount : Number.NaN;
  return /^[a-z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0
    ? { currency, amount }
    : undefined;
}

export function storedShipStationRateQuotes(value: unknown): Array<{
  rateId: string;
  shipmentId: string;
  totalAmount: { currency: string; amount: number };
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const rateId = optionalString(entry.rateId);
    const shipmentId = optionalString(entry.shipmentId);
    const totalAmount = storedShipStationMoney(entry.totalAmount);
    return rateId && shipmentId && totalAmount ? [{ rateId, shipmentId, totalAmount }] : [];
  }).slice(0, 100);
}
