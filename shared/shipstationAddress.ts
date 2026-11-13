import { countryRequiresPostalCode, countryRequiresState, countryUsesPostalCode, normalizeCountryCode } from './countryNormalization.ts';
import { SHIPSTATION_EDITABLE_ADDRESS_FIELDS, type ShipStationEditableAddressField } from './contracts.ts';

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
  instructions?: string;
  geolocation?: Array<{ type: 'what3words'; value: string }>;
};

export type ParsedShipToResult = {
  ok: boolean;
  shipTo?: ShipStationAddress;
  reason?: string;
  correctionFields?: ShipStationEditableAddressField[];
};

const POSTAL_CODE_PATTERNS: Readonly<Record<string, string>> = {
  AR: '(?:[A-Z]\\d{4}(?:\\s?[A-Z]{3})?|\\d{4})',
  US: '\\d{5}(?:-\\d{4})?',
  FR: '\\d{5}',
  IT: '\\d{5}',
  ES: '\\d{5}',
  DE: '\\d{5}',
  TR: '\\d{5}',
  IN: '\\d{3}\\s?\\d{3}',
  AU: '\\d{4}',
  AT: '\\d{4}',
  CH: '\\d{4}',
  BR: '\\d{5}-?\\d{3}',
  BM: '(?:[A-Z]{2}(?:\\s?\\d{2}|\\s[A-Z]{2})|HM[A-Z]X|[A-Z]{2}BX)',
  BN: '[A-Z]{2}\\s?\\d{4}',
  KN: '(?:KN\\d{4}|\\d{4,})',
  LC: '(?:LC\\d{2}\\s?\\d{3}|\\d{4,})',
  LB: '\\d{4}(?:\\s?\\d{4})?',
  NZ: '\\d{4}',
  CA: '[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d',
  GB: '(?:[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}|GIR\\s?0AA)',
  JE: 'JE\\d{1,2}\\s?\\d[A-Z]{2}',
  GG: 'GY\\d{1,2}\\s?\\d[A-Z]{2}',
  IM: 'IM\\d{1,2}\\s?\\d[A-Z]{2}',
  GI: 'GX11\\s?1AA',
  IE: '(?:[A-Z]\\d{2}|D6W)\\s?[A-Z\\d]{4}',
  NL: '\\d{4}\\s?[A-Z]{2}',
  JP: '(?:〒\\s*)?\\d{3}-?\\d{4}',
  CZ: '\\d{3}\\s?\\d{2}',
  SK: '\\d{3}\\s?\\d{2}',
  SE: '\\d{3}\\s?\\d{2}',
  MT: '[A-Z]{3}\\s?\\d{2,4}',
  OM: '(?:PC\\s?)?\\d{3}',
  PE: '(?:LIMA\\s?\\d{1,2}|CALLAO\\s?0?\\d|[0-2]\\d{4})',
  SO: '[A-Z]{2}\\s?\\d{5}',
  SZ: '[HLMS]\\s?\\d{3}',
};

const POSTAL_CODE_PREFIX_ALIASES: Readonly<Record<string, string>> = {
  AT: 'A',
  DE: 'D',
  ES: 'E',
  FR: 'F',
  IT: 'I',
  SE: 'S',
};

function postalCodePattern(countryCode: string): string {
  const pattern = POSTAL_CODE_PATTERNS[countryCode];
  if (!pattern) return '(?=[A-Z\\d-]*\\d)[A-Z\\d]+(?:-[A-Z\\d]+)*';
  const alias = POSTAL_CODE_PREFIX_ALIASES[countryCode];
  const prefix = alias ? `${countryCode}|${alias}` : countryCode;
  return `(?:(?:${prefix})\\s*-\\s*)?(?:${pattern})`;
}

function trailingPostalCode(value: string, countryCode: string, preserveNumericGroups = false): { before: string; postalCode: string } | null {
  const usesPostalCode = countryUsesPostalCode(countryCode);
  const normalized = value.trim().replace(/\s+/g, ' ');
  const numericGroups = usesPostalCode && preserveNumericGroups && !POSTAL_CODE_PATTERNS[countryCode]
    ? normalized.match(/^(?:(.*?)\s+)??(\d+(?:\s+\d+)+)$/)
    : null;
  const pattern = usesPostalCode ? postalCodePattern(countryCode) : '\\d{4,}';
  const match = numericGroups ?? normalized.match(new RegExp(`^(?:(.*?)\\s+)??(${pattern})$`, 'i'));
  if (!match) return null;
  const postalCode = match[2].replace(/^〒\s*/, '');
  return { before: (match[1] ?? '').trim(), postalCode };
}

function parseShipStationCityAndState(
  value: string,
  countryCode: string,
): Pick<ShipStationAddress, 'city_locality' | 'state_province'> {
  const comma = value.indexOf(',');
  if (comma >= 0) {
    return { city_locality: value.slice(0, comma).trim(), state_province: value.slice(comma + 1).trim() };
  }
  const stateMatch = ['US', 'CA', 'AU'].includes(countryCode)
    ? value.match(/^(.+)\s+([A-Z]{2,3})$/)
    : null;
  return {
    city_locality: stateMatch?.[1] ?? (countryRequiresState(countryCode) ? '' : value),
    state_province: stateMatch?.[2] ?? '',
  };
}

function parseShipStationLocality(
  cityLine: string,
  countryCode: string,
): Pick<ShipStationAddress, 'city_locality' | 'state_province' | 'postal_code'> {
  const comma = cityLine.indexOf(',');
  if (comma >= 0) {
    const city = cityLine.slice(0, comma).trim();
    const rest = cityLine.slice(comma + 1).trim();
    const postalSeparator = rest.lastIndexOf(',');
    if (postalSeparator >= 0) {
      const region = rest.slice(0, postalSeparator).trim();
      const postalCode = rest.slice(postalSeparator + 1).trim();
      const legacyPostal = trailingPostalCode(postalCode, countryCode, true);
      const legacyRegion = legacyPostal && (
        POSTAL_CODE_PATTERNS[countryCode] || !countryUsesPostalCode(countryCode) || (/^\d+(?:[ -]\d+)*$/.test(legacyPostal.postalCode) &&
          legacyPostal.before.toUpperCase() !== countryCode)
      ) ? legacyPostal.before : '';
      return {
        city_locality: city,
        state_province: [region, legacyRegion].filter(Boolean).join(', '),
        postal_code: legacyRegion && legacyPostal ? legacyPostal.postalCode : postalCode,
      };
    }
    const postal = trailingPostalCode(rest, countryCode, true);
    return {
      city_locality: city,
      state_province: postal?.before ?? rest,
      postal_code: postal?.postalCode ?? '',
    };
  }
  if (!countryUsesPostalCode(countryCode)) {
    return { city_locality: cityLine, state_province: '', postal_code: '' };
  }
  const countryPostalPattern = POSTAL_CODE_PATTERNS[countryCode] && postalCodePattern(countryCode);
  const leadingPostal = countryPostalPattern
    ? cityLine.replace(/\s+/g, ' ').match(new RegExp(`^(${countryPostalPattern})\\s+(.+)$`, 'i'))
    : null;
  if (leadingPostal) {
    return {
      ...parseShipStationCityAndState(leadingPostal[2].trim(), countryCode),
      postal_code: leadingPostal[1].replace(/^〒\s*/, ''),
    };
  }
  const postal = countryPostalPattern ? trailingPostalCode(cityLine, countryCode) : null;
  if (postal?.before) {
    return {
      ...parseShipStationCityAndState(postal.before, countryCode),
      postal_code: postal.postalCode,
    };
  }
  return {
    city_locality: /\d/.test(cityLine) && (countryRequiresPostalCode(countryCode) || !countryPostalPattern) ? '' : cityLine,
    state_province: '',
    postal_code: '',
  };
}

export function validateShipStationShipTo(address: ShipStationAddress): ParsedShipToResult {
  const shipTo = {
    ...address,
    country_code: normalizeCountryCode(address.country_code),
    postal_code: address.postal_code.trim().replace(/\s+/g, ' '),
  };
  const required = new Set<ShipStationEditableAddressField>(['name', 'address_line1', 'city_locality', 'country_code']);
  if (countryRequiresState(shipTo.country_code)) required.add('state_province');
  if (countryRequiresPostalCode(shipTo.country_code)) required.add('postal_code');
  const correctionFields = SHIPSTATION_EDITABLE_ADDRESS_FIELDS.filter((field) => {
    const value = shipTo[field]?.trim() ?? '';
    return value.length > 50 || (required.has(field) && !value);
  });
  if (correctionFields.length) {
    return {
      ok: false,
      shipTo,
      correctionFields,
      reason: correctionFields.includes('country_code')
        ? 'Choose the destination country for this address'
        : 'Complete or correct the delivery address fields',
    };
  }
  return { ok: true, shipTo };
}

export function parseShipStationShipTo(
  full: string | null | undefined,
  snapshotCountryCode?: string,
  fallbackCountry?: string,
): ParsedShipToResult {
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
  const countryCode = normalizeCountryCode(snapshotCountryCode)
    || normalizeCountryCode(countryLine)
    || normalizeCountryCode(fallbackCountry);
  const standalonePostal = trailingPostalCode(cityLine, countryCode, true);
  const locality = standalonePostal && !standalonePostal.before
    ? {
      ...parseShipStationCityAndState(streetLines.length > 1 ? streetLines.pop() ?? '' : '', countryCode),
      postal_code: standalonePostal.postalCode,
    }
    : parseShipStationLocality(cityLine, countryCode);
  return validateShipStationShipTo({
    name,
    address_line1: streetLines[0],
    ...(streetLines[1] ? { address_line2: streetLines[1] } : {}),
    ...(streetLines[2] ? { address_line3: streetLines.slice(2).join(', ') } : {}),
    ...locality,
    state_province: /^[A-Za-z]{2,3}$/.test(locality.state_province)
      ? locality.state_province.toUpperCase()
      : locality.state_province,
    country_code: countryCode,
    address_residential_indicator: 'yes',
  });
}
