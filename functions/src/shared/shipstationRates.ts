import { z } from 'zod';

import { normalizeCountryCode } from './countryNormalization.js';
import type {
  FulfillmentShipStationInvalidRate,
  FulfillmentShipStationRate,
  ShipStationMoney,
} from './contracts.js';
import {
  defaultShipStationPackage,
  parseShipStationPackage,
  type ShipStationPackageInput,
} from './shipstationPackage.js';

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2';
const SHIPSTATION_TIMEOUT_MS = 15_000;
const SHIPSTATION_MAX_RESPONSE_BYTES = 512 * 1024;
const SHIPSTATION_RATE_STATUSES = new Set(['working', 'completed', 'partial', 'error']);

export type ShipStationRatesProviderErrorCode =
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'internal';

export class ShipStationRatesProviderError extends Error {
  constructor(
    readonly code: ShipStationRatesProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShipStationRatesProviderError';
  }
}

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

export type ShipStationRatesClientOptions = Readonly<{
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function providerResponseError(): ShipStationRatesProviderError {
  return new ShipStationRatesProviderError('unavailable', 'ShipStation returned an invalid response');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shipmentValue(value: unknown): ShipStationShipment {
  const raw = record(value);
  const shipmentId = stringValue(raw.shipment_id);
  const shipmentStatus = stringValue(raw.shipment_status);
  const externalShipmentId = raw.external_shipment_id === null ? null : stringValue(raw.external_shipment_id);
  const shipmentNumber = raw.shipment_number === null ? null : stringValue(raw.shipment_number);
  return {
    ...(shipmentId ? { shipment_id: shipmentId } : {}),
    ...(shipmentStatus ? { shipment_status: shipmentStatus } : {}),
    ...(externalShipmentId === null || externalShipmentId ? { external_shipment_id: externalShipmentId } : {}),
    ...(shipmentNumber === null || shipmentNumber ? { shipment_number: shipmentNumber } : {}),
    ...(Array.isArray(raw.packages) ? { packages: raw.packages } : {}),
    ...(raw.errors !== undefined ? { errors: raw.errors } : {}),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean).slice(0, 10);
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
  const roundedAmount = roundCurrency(amount);
  return Number.isFinite(roundedAmount) ? { currency, amount: roundedAmount } : null;
}

function packageWeightOunces(weight: unknown): number | null {
  const raw = record(weight);
  const value = finiteNumber(raw.value);
  if (value == null) return null;
  switch (stringValue(raw.unit).toLowerCase()) {
    case 'ounce': return value;
    case 'pound': return value * 16;
    case 'gram': return value / 28.349523125;
    case 'kilogram': return value * 35.27396195;
    default: return null;
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
  const raw = record(value);
  const dimensions = record(raw.dimensions);
  const unit = stringValue(dimensions.unit).toLowerCase();
  const length = packageDimensionInches(dimensions.length, unit);
  const width = packageDimensionInches(dimensions.width, unit);
  const height = packageDimensionInches(dimensions.height, unit);
  const weight = packageWeightOunces(raw.weight);
  if (length == null || width == null || height == null || weight == null) return null;
  return parseShipStationPackage({
    length: Math.round(length * 100) / 100,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    weight: Math.round(weight * 100) / 100,
  });
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

function invalidRate(
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

function invalidRateKey(rate: FulfillmentShipStationInvalidRate): string {
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

function rateErrorMessages(value: unknown): string[] {
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

function responseInvalidRates(value: unknown): FulfillmentShipStationInvalidRate[] {
  const errors = Array.isArray(value) ? value : value ? [value] : [];
  const summaries = errors.map((candidate): FulfillmentShipStationInvalidRate => {
    if (typeof candidate === 'string') {
      return invalidRate(
        { carrier_friendly_name: 'ShipStation', service_type: 'Rating' },
        rateErrorMessages([candidate]),
        true,
      );
    }
    const error = record(candidate);
    const code = stringValue(error.error_code) || stringValue(error.code);
    const type = stringValue(error.error_type);
    const fieldName = stringValue(error.field_name);
    const source = stringValue(error.error_source);
    const carrierId = stringValue(error.carrier_id);
    const carrierCode = stringValue(error.carrier_code);
    const carrierName = stringValue(error.carrier_name) || stringValue(error.carrier_friendly_name) ||
      stringValue(error.carrier_nickname);
    const hasCarrierIdentity = Boolean(carrierId || carrierCode || carrierName);
    const responseIssue = !hasCarrierIdentity || Boolean(source && source.toLowerCase() !== 'carrier');
    const details = [code || 'rate_error'];
    if (type) details.push(`type: ${type}`);
    if (fieldName) details.push(`field: ${fieldName}`);
    if (source) details.push(`source: ${source}`);
    return invalidRate({
      carrier_id: carrierId,
      carrier_code: carrierCode,
      carrier_friendly_name: carrierName || (!hasCarrierIdentity ? 'ShipStation' : undefined),
      service_type: 'Rating',
    }, [details.join(' · ').slice(0, 500)], responseIssue);
  });
  const grouped = new Map<string, FulfillmentShipStationInvalidRate>();
  for (const summary of summaries) {
    const key = summary.carrierId
      ? `id:${summary.carrierId}`
      : `fallback:${summary.carrierCode}\n${summary.carrierName}`;
    const existing = grouped.get(key);
    if (!existing) grouped.set(key, summary);
    else {
      existing.errorMessages = Array.from(new Set([...existing.errorMessages, ...summary.errorMessages]));
      if (summary.responseIssue) existing.responseIssue = true;
    }
  }
  return Array.from(grouped.values()).slice(0, 10);
}

export function shipStationRateSummaries(value: unknown, expectedRateRequestId?: string): ShipStationRateResponse {
  const roots = Array.isArray(value) ? value : [value];
  const responses = roots.map((root) => {
    const raw = record(root);
    return Object.keys(record(raw.rate_response)).length ? record(raw.rate_response) : raw;
  });
  const raw = expectedRateRequestId
    ? responses.find((response) => stringValue(response.rate_request_id) === expectedRateRequestId) ?? {}
    : responses[0] ?? {};
  const shipmentId = stringValue(raw.shipment_id);
  const rateRequestId = stringValue(raw.rate_request_id);
  const createdAt = stringValue(raw.created_at);
  const rates: FulfillmentShipStationRate[] = [];
  const rejectedRates: FulfillmentShipStationInvalidRate[] = [];
  for (const candidate of Array.isArray(raw.rates) ? raw.rates : []) {
    const rate = record(candidate);
    const rateId = stringValue(rate.rate_id);
    const rateShipmentId = stringValue(rate.shipment_id) || shipmentId;
    const rejectionMessages = rateErrorMessages(rate.error_messages);
    const responseIssues: string[] = [];
    const validationStatus = stringValue(rate.validation_status);
    if (!rateId) responseIssues.push('The rate is missing its ShipStation rate ID.');
    if (!rateShipmentId) responseIssues.push('The rate is missing its ShipStation shipment ID.');
    if (validationStatus !== 'valid' && validationStatus !== 'has_warnings') {
      const message = `ShipStation validation status is “${validationStatus || 'missing'}”.`;
      if (validationStatus === 'invalid' || validationStatus === 'unknown') rejectionMessages.push(message);
      else responseIssues.push(message);
    }
    const shippingAmount = shipStationMoney(rate.shipping_amount);
    if (!shippingAmount) responseIssues.push('The shipping amount is missing or invalid.');
    const insuranceAmount = shippingAmount ? shipStationMoney(rate.insurance_amount, shippingAmount.currency) : null;
    const confirmationAmount = shippingAmount ? shipStationMoney(rate.confirmation_amount, shippingAmount.currency) : null;
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
      if ([insuranceAmount, confirmationAmount, otherAmount, taxAmount]
        .filter((amount): amount is ShipStationMoney => Boolean(amount))
        .some((amount) => amount.currency !== shippingAmount.currency)) {
        responseIssues.push('The rate charges use different currencies.');
      }
    }
    rejectionMessages.push(...responseIssues);
    if (rejectionMessages.length || !shippingAmount || !insuranceAmount || !confirmationAmount || !otherAmount) {
      rejectedRates.push(invalidRate(rate, Array.from(new Set(rejectionMessages)), responseIssues.length > 0));
      continue;
    }
    const total = roundCurrency(
      shippingAmount.amount + insuranceAmount.amount + confirmationAmount.amount + otherAmount.amount +
      (taxAmount?.amount ?? 0),
    );
    if (!Number.isFinite(total)) {
      rejectedRates.push(invalidRate(rate, ['The rate total is invalid.'], true));
      continue;
    }
    const totalAmount = {
      currency: shippingAmount.currency,
      amount: total,
    };
    const carrierCode = stringValue(rate.carrier_code);
    const carrierNickname = stringValue(rate.carrier_nickname);
    const carrierName = stringValue(rate.carrier_friendly_name) || carrierNickname || carrierCode || 'Carrier';
    const serviceCode = stringValue(rate.service_code);
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
      serviceName: stringValue(rate.service_type) || serviceCode || 'Service',
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
  rates.sort((a, b) =>
    a.totalAmount.currency.localeCompare(b.totalAmount.currency) ||
    a.totalAmount.amount - b.totalAmount.amount ||
    a.carrierName.localeCompare(b.carrierName) ||
    a.serviceName.localeCompare(b.serviceName));
  const explicitInvalidRates = (Array.isArray(raw.invalid_rates) ? raw.invalid_rates : []).map((candidate) => {
    const rate = record(candidate);
    return invalidRate(rate, rateErrorMessages(rate.error_messages));
  });
  const invalidRates = [
    ...responseInvalidRates(raw.errors),
    ...explicitInvalidRates,
    ...rejectedRates,
  ].filter((rate, index, all) => {
    const key = invalidRateKey(rate);
    return all.findIndex((candidate) => invalidRateKey(candidate) === key) === index;
  }).slice(0, 50);
  if (!rates.length && !invalidRates.length) {
    const status = stringValue(raw.status);
    invalidRates.push(invalidRate(
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

type ShipStationRateEnvelope = {
  raw: Record<string, unknown>;
  root: Record<string, unknown>;
};

function rateResponseEnvelope(candidate: unknown): ShipStationRateEnvelope {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw providerResponseError();
  const root = candidate as Record<string, unknown>;
  if (root.rate_response !== undefined) {
    if (!root.rate_response || typeof root.rate_response !== 'object' || Array.isArray(root.rate_response)) {
      throw providerResponseError();
    }
    return { root, raw: root.rate_response as Record<string, unknown> };
  }
  return { root, raw: root };
}

function rawRateRequestId(candidate: unknown): string {
  const root = record(candidate);
  const raw = root.rate_response === undefined ? root : record(root.rate_response);
  return stringValue(raw.rate_request_id);
}

function validateRateEnvelope(
  envelope: ShipStationRateEnvelope,
  expectedShipmentId: string,
): ShipStationRateResponse {
  const rootShipmentId = stringValue(envelope.root.shipment_id);
  const shipmentId = stringValue(envelope.raw.shipment_id);
  const status = stringValue(envelope.raw.status);
  const rateRequestId = stringValue(envelope.raw.rate_request_id);
  if (
    (rootShipmentId && rootShipmentId !== expectedShipmentId) ||
    shipmentId !== expectedShipmentId ||
    !SHIPSTATION_RATE_STATUSES.has(status) ||
    !rateRequestId ||
    (envelope.raw.rates !== undefined && !Array.isArray(envelope.raw.rates)) ||
    (envelope.raw.invalid_rates !== undefined && !Array.isArray(envelope.raw.invalid_rates)) ||
    (envelope.raw.errors != null && !Array.isArray(envelope.raw.errors)) ||
    (Array.isArray(envelope.raw.rates) && envelope.raw.rates.some((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true;
      const rateShipmentId = stringValue((candidate as Record<string, unknown>).shipment_id);
      return Boolean(rateShipmentId && rateShipmentId !== expectedShipmentId);
    }))
  ) {
    throw providerResponseError();
  }
  return shipStationRateSummaries(envelope.raw);
}

function validatedRateResponse(
  value: unknown,
  expectedShipmentId: string,
  expectedRateRequestId?: string,
): ShipStationRateResponse | null {
  const candidates = Array.isArray(value) ? value : [value];
  const candidate = expectedRateRequestId
    ? candidates.find((entry) => rawRateRequestId(entry) === expectedRateRequestId)
    : candidates[0];
  if (candidate === undefined) {
    if (expectedRateRequestId) return null;
    throw providerResponseError();
  }
  return validateRateEnvelope(rateResponseEnvelope(candidate), expectedShipmentId);
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

export function parseShipStationShipFrom(raw: string): ShipStationAddress {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new ShipStationRatesProviderError('failed-precondition', 'ShipStation origin address is not configured');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ShipStationRatesProviderError('failed-precondition', 'ShipStation origin address is not valid JSON');
  }
  const result = shipFromSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
    throw new ShipStationRatesProviderError('failed-precondition', `ShipStation origin address is invalid (${detail})`);
  }
  const data = result.data;
  return {
    name: data.name,
    ...(data.company_name ? { company_name: data.company_name } : {}),
    ...(data.phone ? { phone: data.phone } : {}),
    ...(data.email ? { email: data.email } : {}),
    address_line1: data.address_line1,
    ...(data.address_line2 ? { address_line2: data.address_line2 } : {}),
    ...(data.address_line3 ? { address_line3: data.address_line3 } : {}),
    city_locality: data.city_locality,
    state_province: data.state_province,
    postal_code: data.postal_code,
    country_code: data.country_code.toUpperCase(),
    address_residential_indicator: data.address_residential_indicator,
  };
}

export type ParsedShipToResult = {
  ok: boolean;
  shipTo?: ShipStationAddress;
  reason?: string;
};

function splitStateAndPostalCode(rest: string): { stateProvince: string; postalCode: string } {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const hasDigit = (token: string) => /\d/.test(token);
  let start = tokens.length - 1;
  if (start > 0 && !hasDigit(tokens[start]) && /^[A-Za-z]{1,3}$/.test(tokens[start]) && hasDigit(tokens[start - 1])) {
    start -= 1;
  }
  if (start < 0 || !hasDigit(tokens[start])) return { stateProvince: '', postalCode: tokens.join(' ') };
  while (start > 0 && hasDigit(tokens[start - 1])) start -= 1;
  return { stateProvince: tokens.slice(0, start).join(' '), postalCode: tokens.slice(start).join(' ') };
}

export function parseShipStationShipTo(full: string | null | undefined, snapshotCountryCode?: string): ParsedShipToResult {
  const normalized = typeof full === 'string' ? full.replace(/\r\n/g, '\n').trim() : '';
  if (!normalized || normalized === '***') return { ok: false, reason: 'Delivery address is unavailable for this order' };
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) {
    return { ok: false, reason: 'Delivery address is missing lines (need name, street, city line, country)' };
  }
  const name = lines[0];
  const countryLine = lines[lines.length - 1];
  const cityLine = lines[lines.length - 2];
  const streetLines = lines.slice(1, lines.length - 2);
  if (/^\d+\s/.test(name)) return { ok: false, reason: 'Delivery address does not start with a recipient name line' };
  const countryCode = (normalizeCountryCode(snapshotCountryCode) || normalizeCountryCode(countryLine) || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, reason: 'Could not resolve a country code from the last address line' };
  }
  if (!streetLines.length) return { ok: false, reason: 'Delivery address is missing a street line' };
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
      state_province: /^[A-Za-z]{2,3}$/.test(stateProvince) ? stateProvince.toUpperCase() : stateProvince,
      postal_code: postalCode,
      country_code: countryCode,
      address_residential_indicator: 'yes',
    },
  };
}

export function buildShipStationPackages(unitCount: number, override?: ShipStationPackageInput | null): ShipStationPackage[] {
  const parcel = override ?? defaultShipStationPackage(unitCount);
  return [{
    weight: { value: parcel.weight, unit: 'ounce' },
    dimensions: { length: parcel.length, width: parcel.width, height: parcel.height, unit: 'inch' },
  }];
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShipStationRatesProviderError('unavailable', 'ShipStation returned an oversized response');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
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
        throw new ShipStationRatesProviderError('unavailable', 'ShipStation returned an oversized response');
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

function errorMessage(value: unknown, fallback: string): string {
  const errors = Array.isArray(record(value).errors) ? record(value).errors as unknown[] : [];
  const codes = Array.from(new Set(errors.flatMap((entry) => {
    const code = stringValue(record(entry).error_code);
    return code ? [code] : [];
  }))).slice(0, 5);
  if (codes.some((code) => /balance|fund|postage/i.test(code))) {
    return 'Insufficient ShipStation funds. Add funds or enable auto-funding in ShipStation.';
  }
  return codes.length ? codes.join('; ') : fallback;
}

function errorForStatus(status: number, message: string): ShipStationRatesProviderError {
  if (status === 401 || status === 403) {
    return new ShipStationRatesProviderError('failed-precondition', `ShipStation rejected the API key: ${message}`);
  }
  if (status === 429) return new ShipStationRatesProviderError('resource-exhausted', `ShipStation rate limit: ${message}`);
  if (status >= 500) return new ShipStationRatesProviderError('unavailable', `ShipStation is unavailable: ${message}`);
  return new ShipStationRatesProviderError('failed-precondition', `ShipStation rejected the shipment: ${message}`);
}

async function shipStationFetch(
  apiKey: string,
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown },
  options: ShipStationRatesClientOptions,
): Promise<{ status: number; json: unknown; validJson: boolean }> {
  const providerFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('ShipStation request timed out', 'TimeoutError')),
    options.timeoutMs ?? SHIPSTATION_TIMEOUT_MS,
  );
  try {
    const response = await providerFetch(`${SHIPSTATION_API_BASE}${path}`, {
      method: init.method,
      headers: {
        'API-Key': apiKey,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await readBoundedText(
      response,
      options.maxResponseBytes ?? SHIPSTATION_MAX_RESPONSE_BYTES,
      controller.signal,
    );
    let json: unknown = null;
    let validJson = false;
    if (text) {
      try {
        json = JSON.parse(text);
        validJson = true;
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, validJson };
  } catch (error) {
    if (error instanceof ShipStationRatesProviderError) throw error;
    throw new ShipStationRatesProviderError(
      controller.signal.aborted ? 'deadline-exceeded' : 'unavailable',
      controller.signal.aborted ? 'ShipStation request timed out' : 'Could not reach ShipStation',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function getShipStationShipmentById(
  apiKey: string,
  shipmentId: string,
  options: ShipStationRatesClientOptions = {},
): Promise<ShipStationShipment> {
  const { status, json, validJson } = await shipStationFetch(apiKey, `/shipments/${encodeURIComponent(shipmentId)}`, {
    method: 'GET',
  }, options);
  if (status < 200 || status >= 300) throw errorForStatus(status, errorMessage(json, `HTTP ${status}`));
  if (!validJson) throw providerResponseError();
  const raw = record(json);
  const shipment = shipmentValue(Object.keys(record(raw.shipment)).length ? raw.shipment : raw);
  if (stringValue(shipment.shipment_id) !== shipmentId || !Array.isArray(shipment.packages)) {
    throw providerResponseError();
  }
  return shipment;
}

export async function updateShipStationShipment(
  apiKey: string,
  shipmentId: string,
  update: { ship_to?: ShipStationAddress; ship_from?: ShipStationAddress; packages?: ShipStationPackage[] },
  options: ShipStationRatesClientOptions = {},
): Promise<ShipStationShipment> {
  const { status, json, validJson } = await shipStationFetch(apiKey, `/shipments/${encodeURIComponent(shipmentId)}`, {
    method: 'PUT',
    body: update,
  }, options);
  if (status < 200 || status >= 300) throw errorForStatus(status, errorMessage(json, `HTTP ${status}`));
  if (!validJson) throw providerResponseError();
  const raw = record(json);
  const shipment = shipmentValue(Object.keys(record(raw.shipment)).length ? raw.shipment : raw);
  if (stringValue(shipment.shipment_id) !== shipmentId || !Array.isArray(shipment.packages)) {
    throw providerResponseError();
  }
  return shipment;
}

export async function requestShipStationShipmentRates(
  apiKey: string,
  shipmentId: string,
  options: ShipStationRatesClientOptions = {},
): Promise<ShipStationRateResponse> {
  const carriersResponse = await shipStationFetch(
    apiKey,
    '/carriers?page_size=50&include_extended_details=false',
    { method: 'GET' },
    options,
  );
  if (carriersResponse.status < 200 || carriersResponse.status >= 300) {
    throw errorForStatus(carriersResponse.status, errorMessage(carriersResponse.json, `HTTP ${carriersResponse.status}`));
  }
  if (!carriersResponse.validJson) throw providerResponseError();
  const carriersPayload = record(carriersResponse.json);
  if (!Array.isArray(carriersPayload.carriers)) throw providerResponseError();
  const carriers = carriersPayload.carriers;
  const carrierIds = Array.from(new Set(carriers.flatMap((candidate): string[] => {
    const carrier = record(candidate);
    const carrierId = stringValue(carrier.carrier_id);
    if (!carrierId || carrier.send_rates === false || carrier.disabled_by_billing_plan === true ||
      stringValue(carrier.connection_status) === 'pending_approval') return [];
    return [carrierId];
  })));
  if (!carrierIds.length) {
    throw new ShipStationRatesProviderError(
      'failed-precondition',
      'No connected ShipStation carriers are available for rate shopping.',
    );
  }
  const { status, json, validJson } = await shipStationFetch(apiKey, '/rates', {
    method: 'POST',
    body: { shipment_id: shipmentId, rate_options: { carrier_ids: carrierIds } },
  }, options);
  if (status < 200 || status >= 300) throw errorForStatus(status, errorMessage(json, `HTTP ${status}`));
  if (!validJson) throw providerResponseError();
  const response = validatedRateResponse(json, shipmentId);
  if (!response) throw providerResponseError();
  return response;
}

export async function getShipStationShipmentRates(
  apiKey: string,
  shipmentId: string,
  expectedRequest: { requestId: string; createdAt?: string },
  options: ShipStationRatesClientOptions = {},
): Promise<ShipStationRateResponse> {
  const query = expectedRequest.createdAt
    ? `?created_at_start=${encodeURIComponent(expectedRequest.createdAt)}`
    : '';
  const { status, json, validJson } = await shipStationFetch(
    apiKey,
    `/shipments/${encodeURIComponent(shipmentId)}/rates${query}`,
    { method: 'GET' },
    options,
  );
  if (status < 200 || status >= 300) throw errorForStatus(status, errorMessage(json, `HTTP ${status}`));
  if (!validJson) throw providerResponseError();
  const response = validatedRateResponse(json, shipmentId, expectedRequest.requestId);
  if (!response) {
    return {
      shipmentId,
      status: 'working',
      rates: [],
      invalidRates: [],
      rateRequestId: expectedRequest.requestId,
      ...(expectedRequest.createdAt ? { createdAt: expectedRequest.createdAt } : {}),
    };
  }
  return response;
}

export async function getShipStationRateById(
  apiKey: string,
  rateId: string,
  shipmentId: string,
  options: ShipStationRatesClientOptions = {},
): Promise<FulfillmentShipStationRate> {
  const { status, json, validJson } = await shipStationFetch(
    apiKey,
    `/rates/${encodeURIComponent(rateId)}`,
    { method: 'GET' },
    options,
  );
  if (status < 200 || status >= 300) throw errorForStatus(status, errorMessage(json, `HTTP ${status}`));
  if (!validJson) throw providerResponseError();
  const payload = record(json);
  const raw = Object.keys(record(payload.rate)).length ? record(payload.rate) : payload;
  const rateShipmentId = stringValue(raw.shipment_id);
  if (rateShipmentId && rateShipmentId !== shipmentId) throw providerResponseError();
  const response = shipStationRateSummaries({
    shipment_id: shipmentId,
    status: 'completed',
    rates: [{ ...raw, shipment_id: rateShipmentId || shipmentId }],
  });
  const rate = response.rates.find((candidate) => candidate.rateId === rateId);
  if (!rate) {
    throw new ShipStationRatesProviderError('failed-precondition', 'The selected ShipStation rate is no longer valid');
  }
  return rate;
}
