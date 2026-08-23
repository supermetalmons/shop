export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseCanonicalPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

export function parsePositiveSafeInteger(value: unknown): number | null {
  if (isPositiveSafeInteger(value)) return value;
  return parseCanonicalPositiveInteger(value);
}
