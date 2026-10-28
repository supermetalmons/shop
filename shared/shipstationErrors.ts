export type ShipStationErrorDiagnostics = Readonly<{
  status?: number;
  requestId?: string;
  operation?: string;
  errors: readonly Readonly<{
    code?: string;
    type?: string;
    source?: string;
    field?: string;
    summary: string;
  }>[];
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function identifier(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(text) ? text : '';
}

function fieldName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/.test(text) ? text : '';
}

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_status: 'The shipment or label status does not allow this operation.',
  trial_expired: 'The shipping account trial has expired. Update the account plan before retrying.',
  insufficient_funds: 'Insufficient ShipStation funds. Add funds or enable auto-funding in ShipStation.',
  rate_expired: 'The selected ShipStation rate expired. Refresh rates before purchasing.',
};
const GENERIC_CODES = new Set([
  '', 'unspecified', 'validation_error', 'invalid_address', 'invalid_field_value',
  'invalid_string_length', 'field_value_required', 'invalid_object',
]);

function specificErrorMessage(value: string): string | undefined {
  const text = value.toLowerCase().replace(/_/g, ' ');
  if (/\bfull\s*name\b/.test(text) && /at least 2 alphabetic characters/.test(text)
    && /followed by a space/.test(text) && /at least another 2 alphabetic characters/.test(text)) {
    return 'The carrier requires first and last names with at least 2 letters each. Check both sender and recipient names.';
  }
  if (/insufficient.{0,30}(fund|balance|credit)|(?:fund|balance|credit).{0,30}(insufficient|too low)|not enough.{0,30}(fund|balance|credit)/.test(text)) {
    return CODE_MESSAGES.insufficient_funds;
  }
  if (/\brate\b.{0,40}\bexpired\b|\bexpired\b.{0,40}\brate\b/.test(text)) {
    return CODE_MESSAGES.rate_expired;
  }
  if (/\brate\b.{0,40}\bno longer valid\b/.test(text)) {
    return 'The selected ShipStation rate is no longer valid. Refresh rates before purchasing.';
  }
  return undefined;
}

function errorCategory(value: string): string | undefined {
  const text = value.toLowerCase().replace(/_/g, ' ');
  if (/\bharmonized\b|\btariff\b|\bhs[ .-]?code\b|\bcommodity[ .-]?code\b/.test(text)) {
    return 'ShipStation reported a problem with the customs HS code.';
  }
  if (/non.?delivery/.test(text)) return 'ShipStation reported a problem with the customs non-delivery option.';
  if (/country[ .-]+of[ .-]+origin|origin[ .-]+country/.test(text)) {
    return 'ShipStation reported a problem with the customs country of origin.';
  }
  if (/declared value|customs.{0,30}value/.test(text)) return 'ShipStation reported a problem with the customs declared value.';
  if (/\bcustoms\b/.test(text)) return 'ShipStation reported a problem with the customs declaration.';
  if (/\bpostal[ .-]+code\b|\bzip\b/.test(text)) return 'ShipStation reported a problem with the postal code.';
  if (/\bphone\b|\btelephone\b/.test(text)) return 'ShipStation reported a problem with the phone number.';
  if (/\bemail\b|e-mail/.test(text)) return 'ShipStation reported a problem with the email address.';
  if (/\bweight\b/.test(text)) return 'ShipStation reported a problem with the package weight.';
  if (/\bdimensions?\b/.test(text)
    || /\b(?:packages?|parcels?)(?:\[\d+\])?[ .]+(?:length|width|height)\b/.test(text)
    || /\b(?:length|width|height) of (?:the )?(?:package|parcel)\b/.test(text)) {
    return 'ShipStation reported a problem with the package dimensions.';
  }
  if (/\bprovince\b|\b(?:address|destination|recipient|sender)[ .-]+(?:state|region)\b|\bstate (?:code|abbreviation)\b/.test(text)
    || /\bship[ .-]+(?:to|from)[ .-]+(?:state|region)\b/.test(text)) {
    return 'ShipStation reported a problem with the state or province.';
  }
  if (/\bcity\b|\blocality\b/.test(text)) return 'ShipStation reported a problem with the city.';
  if (/\bcountry\b/.test(text)) return 'ShipStation reported a problem with the country.';
  if (/\baddress\b|\bship[ .-]+to\b|\bship[ .-]+from\b/.test(text)) return 'ShipStation reported a problem with the shipping address.';
  return undefined;
}

export function shipStationErrorDetails(
  value: unknown,
  fallback: string,
  status?: number,
): { message: string; diagnostics: ShipStationErrorDiagnostics } {
  const root = record(value);
  const errors = (Array.isArray(root.errors) ? root.errors : []).slice(0, 5).map((entry) => {
    const error = record(entry);
    const code = identifier(error.error_code);
    const type = identifier(error.error_type);
    const source = identifier(error.error_source);
    const field = fieldName(error.field_name);
    const providerMessage = typeof error.message === 'string' ? error.message.slice(0, 4000) : '';
    const normalizedCode = code.toLowerCase();
    const canInfer = GENERIC_CODES.has(normalizedCode) && ['', 'validation', 'business_rules'].includes(type.toLowerCase());
    const summary = (Object.hasOwn(CODE_MESSAGES, normalizedCode) ? CODE_MESSAGES[normalizedCode] : undefined)
      || (canInfer ? specificErrorMessage(providerMessage)
        || errorCategory(field) || errorCategory(code) || errorCategory(providerMessage) : undefined)
      || (normalizedCode === 'unspecified' ? 'ShipStation did not provide a specific error code.' : code || fallback);
    return {
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
      ...(source ? { source } : {}),
      ...(field ? { field } : {}),
      summary,
    };
  });
  const requestId = identifier(root.request_id);
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const diagnostics: ShipStationErrorDiagnostics = {
    ...(httpStatus !== undefined ? { status: httpStatus } : {}),
    ...(requestId ? { requestId } : {}),
    errors,
  };
  const details = Array.from(new Set(errors.map((error) => {
    const context = [
      ...(error.code && error.code.toLowerCase() !== 'unspecified' && error.code !== 'insufficient_funds' && error.summary !== error.code
        ? [`code: ${error.code}`] : []),
      ...(error.type ? [`type: ${error.type}`] : []),
      ...(error.source ? [`source: ${error.source}`] : []),
      ...(error.field ? [`field: ${error.field}`] : []),
    ];
    return `${error.summary}${context.length ? ` (${context.join(', ')})` : ''}`;
  })));
  const support = [
    ...(httpStatus !== undefined ? [`HTTP ${httpStatus}`] : []),
    ...(requestId ? [`request ID: ${requestId}`] : []),
  ];
  const suffix = support.length ? ` [${support.join('; ')}]` : '';
  const summary = details.length ? details.join('; ') : fallback;
  const limit = 420 - suffix.length;
  const message = `${summary.length > limit ? `${summary.slice(0, limit - 1)}…` : summary}${suffix}`;
  return { message, diagnostics };
}
