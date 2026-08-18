import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

import { normalizeCountryCode } from './normalizers.js';
import type {
  FulfillmentShipStationInvalidRate,
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
import { defaultShipStationPackage, type ShipStationPackageInput } from './shared/shipstationPackage.js';

export {
  isActiveShipStationLabel,
  shipStationLabelResult,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
};
export type { ShipStationLabelResult };

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2';
const SHIPSTATION_TIMEOUT_MS = 15_000;

export type ShipStationAddress = {
  name: string;
  company_name?: string;
  phone?: string;
  email?: string;
  address_line1: string;
  address_line2?: string;
  address_line3?: string;
  city_locality: string;
  state_province: string;
  postal_code: string;
  country_code: string;
  address_residential_indicator: 'yes' | 'no' | 'unknown';
};

export type ShipStationPackage = {
  weight: { value: number; unit: 'ounce' };
  dimensions: { length: number; width: number; height: number; unit: 'inch' };
};

export type ShipStationShipment = {
  shipment_id?: string;
  shipment_status?: string;
  external_shipment_id?: string | null;
  shipment_number?: string | null;
  packages?: unknown[];
  errors?: unknown;
};

export type ShipStationRateResponse = {
  shipmentId: string;
  status: string;
  rates: FulfillmentShipStationRate[];
  invalidRates: FulfillmentShipStationInvalidRate[];
  rateRequestId?: string;
  createdAt?: string;
};

export async function adoptOrPurchaseShipStationLabel(
  findExisting: () => Promise<ShipStationLabelResult | null>,
  purchase: () => Promise<ShipStationLabelResult>,
): Promise<{ result: ShipStationLabelResult; alreadyPurchased: boolean }> {
  const existing = await findExisting();
  if (existing) return { result: existing, alreadyPurchased: true };
  return { result: await purchase(), alreadyPurchased: false };
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
  const currency = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (/^[a-z]{3}$/.test(currency)) return currency;
  return fallback && /^[a-z]{3}$/.test(fallback) ? fallback : null;
}

function shipStationMoney(value: unknown, fallbackCurrency?: string): ShipStationMoney | null {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const amount = finiteNumber(raw.amount);
  const currency = normalizedCurrency(raw.currency, fallbackCurrency);
  if (amount == null || amount < 0 || !currency) return null;
  return {
    currency,
    amount: roundCurrency(amount),
  };
}

export function shipStationMoneyMatches(expected: ShipStationMoney, actual: ShipStationMoney): boolean {
  return expected.currency.trim().toLowerCase() === actual.currency && Math.abs(expected.amount - actual.amount) < 0.005;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean).slice(0, 10);
}

function packageWeightOunces(weight: unknown): number | null {
  const raw = weight && typeof weight === 'object' ? (weight as Record<string, unknown>) : {};
  const value = finiteNumber(raw.value);
  if (value == null) return null;
  switch (stringValue(raw.unit).toLowerCase()) {
    case 'ounce':
      return value;
    case 'pound':
      return value * 16;
    case 'gram':
      return value / 28.349523125;
    case 'kilogram':
      return value * 35.27396195;
    default:
      return null;
  }
}

function packageDimensionInches(value: unknown, unit: string): number | null {
  const number = finiteNumber(value);
  if (number == null) return null;
  if (unit === 'inch') return number;
  if (unit === 'centimeter') return number / 2.54;
  return null;
}

export function shipStationPackageInputFromShipmentPackage(value: unknown): ShipStationPackageInput | null {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const dimensions = raw.dimensions && typeof raw.dimensions === 'object'
    ? (raw.dimensions as Record<string, unknown>)
    : {};
  const unit = stringValue(dimensions.unit).toLowerCase();
  const weight = packageWeightOunces(raw.weight);
  const length = packageDimensionInches(dimensions.length, unit);
  const width = packageDimensionInches(dimensions.width, unit);
  const height = packageDimensionInches(dimensions.height, unit);
  if (weight == null || length == null || width == null || height == null) return null;
  return {
    length: Math.round(length * 100) / 100,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    weight: Math.round(weight * 100) / 100,
  };
}

export function shipStationPackageDetails(shipment: ShipStationShipment): {
  package?: ShipStationPackageInput;
  packageCount: number;
} {
  const packages = Array.isArray(shipment.packages) ? shipment.packages : [];
  if (packages.length !== 1) return { packageCount: packages.length };
  const packageInput = shipStationPackageInputFromShipmentPackage(packages[0]);
  return { packageCount: 1, ...(packageInput ? { package: packageInput } : {}) };
}

function shipStationInvalidRateSummary(
  rate: Record<string, unknown>,
  errorMessages: string[],
  responseIssue = false,
): FulfillmentShipStationInvalidRate {
  const carrierCode = stringValue(rate.carrier_code);
  const serviceCode = stringValue(rate.service_code);
  return {
    carrierId: stringValue(rate.carrier_id),
    carrierCode,
    carrierName:
      stringValue(rate.carrier_friendly_name) ||
      stringValue(rate.carrier_name) ||
      stringValue(rate.carrier_nickname) ||
      carrierCode ||
      stringValue(rate.carrier_id) ||
      'Carrier',
    serviceCode,
    serviceName: stringValue(rate.service_type) || serviceCode || 'Service',
    errorMessages: errorMessages.length ? errorMessages : ['ShipStation marked this service as unavailable.'],
    ...(responseIssue ? { responseIssue: true as const } : {}),
  };
}

function shipStationInvalidRateKey(rate: FulfillmentShipStationInvalidRate): string {
  return [
    rate.carrierId,
    rate.carrierCode,
    rate.carrierName,
    rate.serviceCode,
    rate.serviceName,
    rate.responseIssue ? 'response-issue' : 'unavailable',
    rate.errorMessages.join('\n'),
  ].join('\n');
}

function shipStationRateErrorMessages(value: unknown): string[] {
  return Array.from(new Set(stringList(value).map((message) => {
    const normalized = message.toLowerCase();
    if (/postal|zip/.test(normalized)) return 'The carrier rejected the postal code.';
    if (/phone/.test(normalized)) return 'The carrier rejected the phone number.';
    if (/address/.test(normalized)) return 'The carrier rejected the address.';
    if (/weight/.test(normalized)) return 'The carrier rejected the package weight.';
    if (/dimension|length|width|height/.test(normalized)) return 'The carrier rejected the package dimensions.';
    if (/country/.test(normalized)) return 'The carrier rejected the country.';
    if (/state|province|region/.test(normalized)) return 'The carrier rejected the state or province.';
    if (/city|locality/.test(normalized)) return 'The carrier rejected the city.';
    if (/fund|balance/.test(normalized)) return 'The carrier account may need funds.';
    if (/package/.test(normalized)) return 'The carrier rejected the package.';
    if (/service/.test(normalized)) return 'The carrier rejected the service.';
    if (/carrier|account/.test(normalized)) return 'The carrier account is unavailable.';
    return 'The carrier rejected this rate.';
  })));
}

function shipStationResponseInvalidRates(value: unknown): FulfillmentShipStationInvalidRate[] {
  const errors = Array.isArray(value) ? value : value ? [value] : [];
  const summaries = errors.map((candidate): FulfillmentShipStationInvalidRate => {
    if (typeof candidate === 'string') {
      return shipStationInvalidRateSummary(
        { carrier_friendly_name: 'ShipStation', service_type: 'Rating' },
        shipStationRateErrorMessages([candidate]),
        true,
      );
    }
    const error = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
    const code = stringValue(error.error_code) || stringValue(error.code);
    const type = stringValue(error.error_type);
    const fieldName = stringValue(error.field_name);
    const source = stringValue(error.error_source);
    const carrierId = stringValue(error.carrier_id);
    const carrierCode = stringValue(error.carrier_code);
    const carrierName =
      stringValue(error.carrier_name) ||
      stringValue(error.carrier_friendly_name) ||
      stringValue(error.carrier_nickname);
    const hasCarrierIdentity = Boolean(carrierId || carrierCode || carrierName);
    const responseIssue = !hasCarrierIdentity || Boolean(source && source.toLowerCase() !== 'carrier');
    const details = [code || 'rate_error'];
    if (type) details.push(`type: ${type}`);
    if (fieldName) details.push(`field: ${fieldName}`);
    if (source) details.push(`source: ${source}`);
    return shipStationInvalidRateSummary(
      {
        carrier_id: carrierId,
        carrier_code: carrierCode,
        carrier_friendly_name: carrierName || (!hasCarrierIdentity ? 'ShipStation' : undefined),
        service_type: 'Rating',
      },
      [details.join(' · ').slice(0, 500)],
      responseIssue,
    );
  });
  const grouped = new Map<string, FulfillmentShipStationInvalidRate>();
  for (const summary of summaries) {
    const key = summary.carrierId
      ? `id:${summary.carrierId}`
      : `fallback:${summary.carrierCode}\n${summary.carrierName}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, summary);
      continue;
    }
    existing.errorMessages = Array.from(new Set([...existing.errorMessages, ...summary.errorMessages]));
    if (summary.responseIssue) existing.responseIssue = true;
  }
  return Array.from(grouped.values()).slice(0, 10);
}

export function shipStationRateSummaries(value: unknown, expectedRateRequestId?: string): ShipStationRateResponse {
  const roots = Array.isArray(value) ? value : [value];
  const responses = roots.map((root): Record<string, unknown> => {
    const rootRecord = root && typeof root === 'object' ? (root as Record<string, unknown>) : {};
    return rootRecord.rate_response && typeof rootRecord.rate_response === 'object'
      ? (rootRecord.rate_response as Record<string, unknown>)
      : rootRecord;
  });
  const raw = expectedRateRequestId
    ? responses.find((response) => stringValue(response.rate_request_id) === expectedRateRequestId) ?? {}
    : responses[0] ?? {};
  const shipmentId = stringValue(raw.shipment_id);
  const rateRequestId = stringValue(raw.rate_request_id);
  const createdAt = stringValue(raw.created_at);
  const ratesRaw = Array.isArray(raw.rates) ? raw.rates : [];
  const rates: FulfillmentShipStationRate[] = [];
  const rejectedRates: FulfillmentShipStationInvalidRate[] = [];
  for (const candidate of ratesRaw) {
    const rate = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
    const rateId = stringValue(rate.rate_id);
    const rateShipmentId = stringValue(rate.shipment_id) || shipmentId;
    const errorMessages = shipStationRateErrorMessages(rate.error_messages);
    const validationStatus = stringValue(rate.validation_status);
    const rejectionMessages: string[] = [];
    const responseIssues: string[] = [];
    if (!rateId) responseIssues.push('The rate is missing its ShipStation rate ID.');
    if (!rateShipmentId) responseIssues.push('The rate is missing its ShipStation shipment ID.');
    if (validationStatus !== 'valid' && validationStatus !== 'has_warnings') {
      const message = `ShipStation validation status is “${validationStatus || 'missing'}”.`;
      if (validationStatus === 'invalid' || validationStatus === 'unknown') {
        rejectionMessages.push(message);
      } else {
        responseIssues.push(message);
      }
    }
    rejectionMessages.push(...errorMessages);
    const shippingAmount = shipStationMoney(rate.shipping_amount);
    if (!shippingAmount) responseIssues.push('The shipping amount is missing or invalid.');
    const insuranceAmount = shippingAmount
      ? shipStationMoney(rate.insurance_amount, shippingAmount.currency)
      : null;
    const confirmationAmount = shippingAmount
      ? shipStationMoney(rate.confirmation_amount, shippingAmount.currency)
      : null;
    const otherAmount = shippingAmount ? shipStationMoney(rate.other_amount, shippingAmount.currency) : null;
    const hasTaxAmount = rate.tax_amount != null;
    const taxAmount = shippingAmount && hasTaxAmount
      ? shipStationMoney(rate.tax_amount, shippingAmount.currency)
      : undefined;
    if (shippingAmount) {
      if (!insuranceAmount) responseIssues.push('The insurance amount is missing or invalid.');
      if (!confirmationAmount) responseIssues.push('The confirmation amount is missing or invalid.');
      if (!otherAmount) responseIssues.push('The other charges amount is missing or invalid.');
      if (hasTaxAmount && !taxAmount) responseIssues.push('The tax amount is invalid.');
      if (
        [insuranceAmount, confirmationAmount, otherAmount, taxAmount]
          .filter((amount): amount is ShipStationMoney => Boolean(amount))
          .some((amount) => amount.currency !== shippingAmount.currency)
      ) {
        responseIssues.push('The rate charges use different currencies.');
      }
    }
    rejectionMessages.push(...responseIssues);
    if (rejectionMessages.length || !shippingAmount || !insuranceAmount || !confirmationAmount || !otherAmount) {
      rejectedRates.push(shipStationInvalidRateSummary(
        rate,
        Array.from(new Set(rejectionMessages)),
        responseIssues.length > 0,
      ));
      continue;
    }
    const totalAmount = {
      currency: shippingAmount.currency,
      amount: roundCurrency(
        shippingAmount.amount +
          insuranceAmount.amount +
          confirmationAmount.amount +
          otherAmount.amount +
          (taxAmount?.amount ?? 0),
      ),
    };
    const carrierCode = stringValue(rate.carrier_code);
    const carrierNickname = stringValue(rate.carrier_nickname);
    const carrierName =
      stringValue(rate.carrier_friendly_name) || carrierNickname || carrierCode || 'Carrier';
    const serviceCode = stringValue(rate.service_code);
    const serviceName = stringValue(rate.service_type) || serviceCode || 'Service';
    const deliveryDays = finiteNumber(rate.delivery_days);
    const zone = finiteNumber(rate.zone);
    rates.push({
      rateId,
      shipmentId: rateShipmentId,
      carrierId: stringValue(rate.carrier_id),
      carrierCode,
      carrierName,
      ...(carrierNickname ? { carrierNickname } : {}),
      serviceCode,
      serviceName,
      ...(stringValue(rate.package_type) ? { packageType: stringValue(rate.package_type) } : {}),
      ...(stringValue(rate.rate_type) ? { rateType: stringValue(rate.rate_type) } : {}),
      ...(zone != null && zone >= 0 ? { zone: Math.floor(zone) } : {}),
      ...(stringValue(rate.carrier_delivery_days)
        ? { carrierDeliveryDays: stringValue(rate.carrier_delivery_days) }
        : {}),
      ...(stringValue(rate.ship_date) ? { shipDate: stringValue(rate.ship_date) } : {}),
      ...(typeof rate.negotiated_rate === 'boolean' ? { negotiatedRate: rate.negotiated_rate } : {}),
      ...(typeof rate.trackable === 'boolean' ? { trackable: rate.trackable } : {}),
      shippingAmount,
      insuranceAmount,
      confirmationAmount,
      otherAmount,
      ...(taxAmount ? { taxAmount } : {}),
      totalAmount,
      ...(deliveryDays != null && deliveryDays >= 0 ? { deliveryDays: Math.floor(deliveryDays) } : {}),
      ...(stringValue(rate.estimated_delivery_date) || stringValue(rate.delivery_date)
        ? { estimatedDeliveryDate: stringValue(rate.estimated_delivery_date) || stringValue(rate.delivery_date) }
        : {}),
      guaranteedService: rate.guaranteed_service === true,
      warningMessages: stringList(rate.warning_messages),
    });
  }
  rates.sort(
    (a, b) =>
      a.totalAmount.currency.localeCompare(b.totalAmount.currency) ||
      a.totalAmount.amount - b.totalAmount.amount ||
      a.carrierName.localeCompare(b.carrierName) ||
      a.serviceName.localeCompare(b.serviceName),
  );
  const invalidRatesRaw = Array.isArray(raw.invalid_rates) ? raw.invalid_rates : [];
  const explicitInvalidRates = invalidRatesRaw.map((candidate): FulfillmentShipStationInvalidRate => {
    const rate = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
    const errorMessages = shipStationRateErrorMessages(rate.error_messages);
    return shipStationInvalidRateSummary(rate, errorMessages);
  });
  const invalidRates = [
    ...shipStationResponseInvalidRates(raw.errors),
    ...explicitInvalidRates,
    ...rejectedRates,
  ].filter((rate, index, all) => {
    const key = shipStationInvalidRateKey(rate);
    return all.findIndex((candidate) => shipStationInvalidRateKey(candidate) === key) === index;
  }).slice(0, 50);
  if (!rates.length && !invalidRates.length) {
    const status = stringValue(raw.status);
    invalidRates.push(shipStationInvalidRateSummary(
      { carrier_friendly_name: 'ShipStation', service_type: 'Rating' },
      [`ShipStation returned no rate entries or rejection details${status ? ` (status: ${status})` : ''}.`],
    ));
  }
  return {
    shipmentId,
    status: stringValue(raw.status),
    rates,
    invalidRates,
    ...(rateRequestId ? { rateRequestId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

const shipFromSchema = z.object({
  name: z.string().min(1),
  company_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address_line1: z.string().min(1),
  address_line2: z.string().optional(),
  address_line3: z.string().optional(),
  city_locality: z.string().min(1),
  state_province: z.string().default(''),
  postal_code: z.string().min(1),
  country_code: z.string().min(2).max(2),
  address_residential_indicator: z.enum(['yes', 'no', 'unknown']).default('no'),
});

/**
 * The origin address is kept in the SHIPSTATION_SHIP_FROM secret as a single JSON
 * object so it can change without a code deploy.
 */
export function parseShipStationShipFrom(raw: string): ShipStationAddress {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new HttpsError('failed-precondition', 'ShipStation origin address is not configured');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpsError('failed-precondition', 'ShipStation origin address is not valid JSON');
  }
  const result = shipFromSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
    throw new HttpsError('failed-precondition', `ShipStation origin address is invalid (${detail})`);
  }
  const data = result.data;
  return {
    name: String(data.name),
    ...(data.company_name ? { company_name: data.company_name } : {}),
    ...(data.phone ? { phone: data.phone } : {}),
    ...(data.email ? { email: data.email } : {}),
    address_line1: String(data.address_line1),
    ...(data.address_line2 ? { address_line2: data.address_line2 } : {}),
    ...(data.address_line3 ? { address_line3: data.address_line3 } : {}),
    city_locality: String(data.city_locality),
    state_province: String(data.state_province || ''),
    postal_code: String(data.postal_code),
    country_code: String(data.country_code).toUpperCase(),
    address_residential_indicator: data.address_residential_indicator || 'no',
  };
}

/**
 * Not a discriminated union: the functions tsconfig runs with `strict: false`, which
 * stops TypeScript narrowing on a boolean literal tag.
 */
export type ParsedShipToResult = {
  ok: boolean;
  shipTo?: ShipStationAddress;
  reason?: string;
};

/**
 * Splits the segment after the city comma into state and postal code.
 *
 * The state is a free-text field in DeliveryForm, so it is just as often "California"
 * or "Noord-Holland" as "CA" — anchoring on the state is hopeless. Anchor on the postal
 * code instead: it is the trailing run of digit-bearing tokens ("90001", "M5V 3A8",
 * "SW1A 1AA"), optionally followed by a short letter group ("1012 AB").
 */
function splitStateAndPostalCode(rest: string): { stateProvince: string; postalCode: string } {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const hasDigit = (token: string) => /\d/.test(token);
  let start = tokens.length - 1;
  if (start > 0 && !hasDigit(tokens[start]) && /^[A-Za-z]{1,3}$/.test(tokens[start]) && hasDigit(tokens[start - 1])) {
    start -= 1;
  }
  if (start < 0 || !hasDigit(tokens[start])) {
    // Nothing postal-code shaped (countries without one, "N/A", …) — keep it whole.
    return { stateProvince: '', postalCode: tokens.join(' ') };
  }
  while (start > 0 && hasDigit(tokens[start - 1])) start -= 1;
  return { stateProvince: tokens.slice(0, start).join(' '), postalCode: tokens.slice(start).join(' ') };
}

/**
 * Delivery addresses are stored as a single plaintext block:
 *
 *   Name
 *   line1
 *   [line2]
 *   City, ST 12345
 *   Country name or country code
 *
 * See DeliveryForm (`src/components/DeliveryForm.tsx`) and
 * `stripeFulfillmentAddressFromSession` for the two writers of that shape.
 */
export function parseShipStationShipTo(
  full: string | null | undefined,
  snapshotCountryCode?: string,
): ParsedShipToResult {
  const normalized = typeof full === 'string' ? full.replace(/\r\n/g, '\n').trim() : '';
  if (!normalized || normalized === '***') {
    return { ok: false, reason: 'Delivery address is unavailable for this order' };
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 4) {
    return { ok: false, reason: 'Delivery address is missing lines (need name, street, city line, country)' };
  }

  const name = lines[0];
  const countryLine = lines[lines.length - 1];
  const cityLine = lines[lines.length - 2];
  const streetLines = lines.slice(1, lines.length - 2);

  // Both writers drop empty lines, so a missing name silently shifts every line up and
  // the street becomes the recipient. A leading house number is the giveaway — match the
  // number-then-space shape only, so handles like "0xNina", "88mph" or "3M" still pass.
  if (/^\d+\s/.test(name)) {
    return { ok: false, reason: 'Delivery address does not start with a recipient name line' };
  }

  // Reasons must never quote address content: they end up in `shipstation.lastError`,
  // which is stored unencrypted next to the encrypted address snapshot.
  const countryCode = (normalizeCountryCode(snapshotCountryCode) || normalizeCountryCode(countryLine) || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, reason: 'Could not resolve a country code from the last address line' };
  }

  if (!streetLines.length) {
    return { ok: false, reason: 'Delivery address is missing a street line' };
  }

  // "City, ST 12345" — the state segment is optional so countries without one still parse.
  const cityMatch = cityLine.match(/^(.+?),\s*(.+)$/);
  const cityLocality = cityMatch ? cityMatch[1].trim() : '';
  const { stateProvince, postalCode } = splitStateAndPostalCode(cityMatch ? cityMatch[2] : '');
  if (!cityLocality || !postalCode) {
    return { ok: false, reason: 'Could not read the city and postal code line (expected "City, ST 12345")' };
  }

  return {
    ok: true,
    shipTo: {
      name,
      address_line1: streetLines[0],
      ...(streetLines[1] ? { address_line2: streetLines[1] } : {}),
      ...(streetLines[2] ? { address_line3: streetLines.slice(2).join(', ') } : {}),
      city_locality: cityLocality,
      // Codes get uppercased; spelled-out regions stay as written.
      state_province: /^[A-Za-z]{2,3}$/.test(stateProvince) ? stateProvince.toUpperCase() : stateProvince,
      postal_code: postalCode,
      country_code: countryCode,
      address_residential_indicator: 'yes',
    },
  };
}

export function buildShipStationPackages(
  unitCount: number,
  override?: ShipStationPackageInput | null,
): ShipStationPackage[] {
  const parcel = override ?? defaultShipStationPackage(unitCount);
  return [
    {
      weight: { value: parcel.weight, unit: 'ounce' },
      dimensions: { length: parcel.length, width: parcel.width, height: parcel.height, unit: 'inch' },
    },
  ];
}

/**
 * Deterministic per order — this is what makes the create call de-duplicable.
 * ShipStation truncates this at 50 characters; the longest drop id leaves ~15 to spare.
 */
export function shipStationExternalId(dropId: string, deliveryId: number): string {
  return `mons-${dropId}-${deliveryId}`;
}

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

/**
 * Crash-recovery lookup: if we created a shipment but failed to record it, this
 * finds it again instead of creating a duplicate. Returns null when absent.
 */
export async function getShipStationShipmentByExternalId(
  apiKey: string,
  externalId: string,
): Promise<ShipStationShipment | null> {
  const { status, json } = await shipStationFetch(
    apiKey,
    `/shipments/external_shipment_id/${encodeURIComponent(externalId)}`,
    { method: 'GET' },
  );
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  // The endpoint answers with a bare shipment object; the wrapper check costs nothing and
  // a wrong guess here means a duplicate shipment.
  const shipment: ShipStationShipment | null = json?.shipment || json || null;
  if (!shipment || typeof shipment.shipment_id !== 'string' || !shipment.shipment_id) return null;
  // A cancelled shipment should not block a fresh push.
  if (shipment.shipment_status === 'cancelled') return null;
  return shipment;
}

export async function getShipStationShipmentById(apiKey: string, shipmentId: string): Promise<ShipStationShipment> {
  const { status, json } = await shipStationFetch(apiKey, `/shipments/${encodeURIComponent(shipmentId)}`, {
    method: 'GET',
  });
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const shipment: ShipStationShipment | null = json?.shipment || json || null;
  if (!shipment || stringValue(shipment.shipment_id) !== shipmentId) {
    throw new HttpsError('internal', 'ShipStation did not return the requested shipment');
  }
  return shipment;
}

export async function updateShipStationShipment(
  apiKey: string,
  shipmentId: string,
  update: { ship_to?: ShipStationAddress; ship_from?: ShipStationAddress; packages?: ShipStationPackage[] },
): Promise<ShipStationShipment> {
  const { status, json } = await shipStationFetch(apiKey, `/shipments/${encodeURIComponent(shipmentId)}`, {
    method: 'PUT',
    body: update,
  });
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const shipment: ShipStationShipment | null = json?.shipment || json || null;
  if (shipment && stringValue(shipment.shipment_id) === shipmentId) return shipment;
  return getShipStationShipmentById(apiKey, shipmentId);
}

export async function requestShipStationShipmentRates(
  apiKey: string,
  shipmentId: string,
): Promise<ShipStationRateResponse> {
  const carriersResponse = await shipStationFetch(apiKey, '/carriers?page_size=50', { method: 'GET' });
  if (carriersResponse.status < 200 || carriersResponse.status >= 300) {
    throw httpsErrorForStatus(
      carriersResponse.status,
      shipStationErrorMessage(carriersResponse.json, `HTTP ${carriersResponse.status}`),
    );
  }
  const carriers = Array.isArray(carriersResponse.json?.carriers) ? carriersResponse.json.carriers : [];
  const carrierIds = Array.from(new Set(carriers.flatMap((candidate: unknown): string[] => {
    const carrier = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
    const carrierId = stringValue(carrier.carrier_id);
    if (
      !carrierId ||
      carrier.send_rates === false ||
      carrier.disabled_by_billing_plan === true ||
      stringValue(carrier.connection_status) === 'pending_approval'
    ) return [];
    return [carrierId];
  })));
  if (!carrierIds.length) {
    throw new HttpsError('failed-precondition', 'No connected ShipStation carriers are available for rate shopping.');
  }
  const { status, json } = await shipStationFetch(apiKey, '/rates', {
    method: 'POST',
    body: {
      shipment_id: shipmentId,
      rate_options: { carrier_ids: carrierIds },
    },
  });
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const response = shipStationRateSummaries(json);
  return { ...response, shipmentId: response.shipmentId || shipmentId };
}

export async function getShipStationShipmentRates(
  apiKey: string,
  shipmentId: string,
  expectedRequest?: { requestId: string; createdAt?: string },
): Promise<ShipStationRateResponse> {
  const query = expectedRequest?.createdAt
    ? `?created_at_start=${encodeURIComponent(expectedRequest.createdAt)}`
    : '';
  const { status, json } = await shipStationFetch(apiKey, `/shipments/${encodeURIComponent(shipmentId)}/rates${query}`, {
    method: 'GET',
  });
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const response = shipStationRateSummaries(json, expectedRequest?.requestId);
  if (expectedRequest && response.rateRequestId !== expectedRequest.requestId) {
    return {
      shipmentId,
      status: 'working',
      rates: [],
      invalidRates: [],
      rateRequestId: expectedRequest.requestId,
      ...(expectedRequest.createdAt ? { createdAt: expectedRequest.createdAt } : {}),
    };
  }
  return { ...response, shipmentId: response.shipmentId || shipmentId };
}

export async function getShipStationRateById(
  apiKey: string,
  rateId: string,
  shipmentId: string,
): Promise<FulfillmentShipStationRate> {
  const { status, json } = await shipStationFetch(apiKey, `/rates/${encodeURIComponent(rateId)}`, { method: 'GET' });
  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }
  const raw = json?.rate || json;
  const response = shipStationRateSummaries({
    shipment_id: raw?.shipment_id || shipmentId,
    status: 'completed',
    rates: [raw],
  });
  const rate = response.rates.find((candidate) => candidate.rateId === rateId);
  if (!rate) throw new HttpsError('failed-precondition', 'The selected ShipStation rate is no longer valid');
  return rate;
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

export async function createShipStationShipment(
  apiKey: string,
  shipment: {
    external_shipment_id: string;
    shipment_number: string;
    ship_to: ShipStationAddress;
    ship_from: ShipStationAddress;
    packages: ShipStationPackage[];
  },
): Promise<ShipStationShipment> {
  const { status, json } = await shipStationFetch(apiKey, '/shipments', {
    method: 'POST',
    body: {
      shipments: [
        {
          ...shipment,
          create_sales_order: true,
          shipment_status: 'pending',
        },
      ],
    },
  });

  if (status < 200 || status >= 300) {
    throw httpsErrorForStatus(status, shipStationErrorMessage(json, `HTTP ${status}`));
  }

  const created: ShipStationShipment | undefined = Array.isArray(json?.shipments) ? json.shipments[0] : undefined;
  // Any error entry rejects the shipment, whether or not a code could be read off it.
  const shipmentErrors = Array.isArray(created?.errors) ? created?.errors : [];
  const codes = shipStationErrorCodes(shipmentErrors);
  if (json?.has_errors === true || shipmentErrors.length) {
    const message = codes.length
      ? codes.join('; ')
      : shipStationErrorMessage(json, 'ShipStation reported an error');
    throw new HttpsError('failed-precondition', `ShipStation rejected the shipment: ${message}`);
  }
  if (!created || typeof created.shipment_id !== 'string' || !created.shipment_id) {
    throw new HttpsError('internal', 'ShipStation did not return a shipment id');
  }
  return created;
}
