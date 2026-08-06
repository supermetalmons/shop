import type { FulfillmentShipStationRate } from '../types';

export const FULFILLMENT_SHIPSTATION_RECOMMENDED_RATE_COUNT = 3;

function moneyKey(money: FulfillmentShipStationRate['totalAmount'] | undefined): string {
  return money ? `${money.currency}:${money.amount}` : '';
}

function readableMoney(money: FulfillmentShipStationRate['totalAmount'] | undefined): string {
  return money ? `${money.currency.toUpperCase()} ${money.amount.toFixed(2)}` : 'Not provided';
}

export function fulfillmentShipStationDeliveryText(rate: FulfillmentShipStationRate): string {
  if (rate.estimatedDeliveryDate) {
    const date = new Date(rate.estimatedDeliveryDate);
    if (Number.isFinite(date.getTime())) {
      return `Estimated ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
  }
  if (rate.deliveryDays != null) return `${rate.deliveryDays} ${rate.deliveryDays === 1 ? 'day' : 'days'}`;
  return 'Delivery estimate unavailable';
}

function rateVisibleKey(rate: FulfillmentShipStationRate): string {
  return JSON.stringify([
    rate.carrierName,
    rate.serviceName,
    moneyKey(rate.totalAmount),
    fulfillmentShipStationDeliveryText(rate),
    rate.guaranteedService,
    rate.warningMessages,
  ]);
}

function readableRateValue(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function shortIdentifier(identifier: string): string {
  if (identifier.length <= 8) return identifier;
  return `…${identifier.slice(-6)}`;
}

function readableDate(value: string | undefined): string {
  if (!value) return 'Not provided';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function prepareFulfillmentShipStationRates(rates: readonly FulfillmentShipStationRate[]): {
  rates: FulfillmentShipStationRate[];
  detailByRateId: ReadonlyMap<string, string>;
} {
  const seenRateIds = new Set<string>();
  const uniqueRates = rates.filter((rate) => {
    if (seenRateIds.has(rate.rateId)) return false;
    seenRateIds.add(rate.rateId);
    return true;
  });
  const visibleGroups = new Map<string, FulfillmentShipStationRate[]>();
  for (const rate of uniqueRates) {
    const key = rateVisibleKey(rate);
    const group = visibleGroups.get(key);
    if (group) group.push(rate);
    else visibleGroups.set(key, [rate]);
  }
  const detailByRateId = new Map<string, string>();
  for (const group of visibleGroups.values()) {
    if (group.length < 2) continue;
    const carrierAccounts = new Set(
      group.map((rate) => rate.carrierId || rate.carrierNickname?.trim() || rate.carrierName),
    );
    const serviceCodes = new Set(group.map((rate) => rate.serviceCode));
    const packageTypes = new Set(group.map((rate) => rate.packageType ?? ''));
    const rateTypes = new Set(group.map((rate) => rate.rateType ?? ''));
    const zones = new Set(group.map((rate) => rate.zone ?? null));
    const carrierDeliveryDays = new Set(group.map((rate) => rate.carrierDeliveryDays ?? ''));
    const shipDates = new Set(group.map((rate) => rate.shipDate ?? ''));
    const negotiatedRates = new Set(group.map((rate) => rate.negotiatedRate ?? null));
    const trackableRates = new Set(group.map((rate) => rate.trackable ?? null));
    const chargeFields = [
      ['Shipping', 'shippingAmount'],
      ['Insurance', 'insuranceAmount'],
      ['Confirmation', 'confirmationAmount'],
      ['Other charges', 'otherAmount'],
      ['Tax', 'taxAmount'],
    ] as const;
    const differingChargeFields = chargeFields.filter(([, field]) =>
      new Set(group.map((rate) => moneyKey(rate[field]))).size > 1,
    );
    for (const rate of group) {
      const details: string[] = [];
      if (carrierAccounts.size > 1) {
        const nickname = rate.carrierNickname?.trim();
        const nicknameIsUnique = Boolean(
          nickname && group.filter((candidate) => candidate.carrierNickname?.trim() === nickname).length === 1,
        );
        const account = nicknameIsUnique
          ? nickname
          : [nickname, rate.carrierId ? shortIdentifier(rate.carrierId) : 'Unknown'].filter(Boolean).join(' · ');
        details.push(`Account: ${account}`);
      }
      if (serviceCodes.size > 1) {
        details.push(`Service code: ${readableRateValue(rate.serviceCode || 'Not provided')}`);
      }
      if (packageTypes.size > 1) {
        details.push(`Package: ${readableRateValue(rate.packageType || 'Not provided')}`);
      }
      if (trackableRates.size > 1) {
        details.push(
          rate.trackable === true
            ? 'Tracking included'
            : rate.trackable === false
              ? 'Tracking unavailable'
              : 'Tracking: Not provided',
        );
      }
      if (negotiatedRates.size > 1) {
        details.push(
          rate.negotiatedRate === true
            ? 'Negotiated rate'
            : rate.negotiatedRate === false
              ? 'Standard rate'
              : 'Rate pricing: Not provided',
        );
      }
      if (rateTypes.size > 1) {
        details.push(`Rate type: ${readableRateValue(rate.rateType || 'Not provided')}`);
      }
      if (zones.size > 1) {
        details.push(`Zone: ${rate.zone ?? 'Not provided'}`);
      }
      if (carrierDeliveryDays.size > 1) {
        details.push(`Carrier estimate: ${rate.carrierDeliveryDays || 'Not provided'}`);
      }
      if (shipDates.size > 1) {
        details.push(`Ship date: ${readableDate(rate.shipDate)}`);
      }
      for (const [label, field] of differingChargeFields) {
        details.push(`${label}: ${readableMoney(rate[field])}`);
      }
      if (!details.length) details.push(`ShipStation quote: ${shortIdentifier(rate.rateId)}`);
      if (details.length) detailByRateId.set(rate.rateId, details.join(' · '));
    }
  }
  return { rates: uniqueRates, detailByRateId };
}

export function groupFulfillmentShipStationRates<T extends { rateId: string }>(
  rates: readonly T[],
  selectedRateId: string | null,
): {
  recommendedRates: T[];
  otherRates: T[];
  selectedOtherRate: T | null;
} {
  const recommendedRates = rates.slice(0, FULFILLMENT_SHIPSTATION_RECOMMENDED_RATE_COUNT);
  const otherRates = rates.slice(FULFILLMENT_SHIPSTATION_RECOMMENDED_RATE_COUNT);
  return {
    recommendedRates,
    otherRates,
    selectedOtherRate: otherRates.find((rate) => rate.rateId === selectedRateId) ?? null,
  };
}
