import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

import { normalizeCountryCode } from './normalizers.js';
import { defaultShipStationPackage, type ShipStationPackageInput } from './shared/shipstationPackage.js';

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
  errors?: unknown;
};

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
  init: { method: 'GET' | 'POST'; body?: unknown },
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

function shipStationErrorMessage(json: any, fallback: string): string {
  const codes = shipStationErrorCodes(json?.errors);
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
