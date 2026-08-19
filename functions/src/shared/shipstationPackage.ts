const PACK_WEIGHT_OUNCES = 4;
const PACKAGE_DIMENSIONS = { length: 12, width: 9, height: 2 };

const MIN_DIMENSION_INCHES = 0.1;
const MAX_DIMENSION_INCHES = 200;
const MIN_WEIGHT_OUNCES = 0.1;
const MAX_WEIGHT_OUNCES = 1600;

export const SHIPSTATION_PACKAGE_RANGE_MESSAGE =
  `Dimensions must be ${MIN_DIMENSION_INCHES}–${MAX_DIMENSION_INCHES} in and weight ${MIN_WEIGHT_OUNCES}–${MAX_WEIGHT_OUNCES} oz.`;

export type ShipStationPackageInput = {
  /** Inches. */
  length: number;
  width: number;
  height: number;
  /** Ounces. */
  weight: number;
};

export function defaultShipStationPackage(unitCount: number): ShipStationPackageInput {
  const units = Math.max(1, Math.floor(Number(unitCount) || 0));
  return { ...PACKAGE_DIMENSIONS, weight: PACK_WEIGHT_OUNCES * units };
}

function roundMeasurement(value: number): number {
  return Math.round(value * 100) / 100;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export function parseShipStationPackage(input: unknown): ShipStationPackageInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.length !== 'number' ||
    typeof raw.width !== 'number' ||
    typeof raw.height !== 'number' ||
    typeof raw.weight !== 'number'
  ) return null;
  const value = {
    length: raw.length,
    width: raw.width,
    height: raw.height,
    weight: raw.weight,
  };
  return Object.values(value).every((measurement) => Number.isFinite(measurement) && measurement > 0)
    ? value
    : null;
}

/** Null when any measurement is missing or out of range. */
export function normalizeShipStationPackage(input: unknown): ShipStationPackageInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const parsed = parseShipStationPackage({
    length: Number(raw.length),
    width: Number(raw.width),
    height: Number(raw.height),
    weight: Number(raw.weight),
  });
  if (!parsed) return null;
  const value = {
    length: roundMeasurement(parsed.length),
    width: roundMeasurement(parsed.width),
    height: roundMeasurement(parsed.height),
    weight: roundMeasurement(parsed.weight),
  };
  if (
    !inRange(value.length, MIN_DIMENSION_INCHES, MAX_DIMENSION_INCHES) ||
    !inRange(value.width, MIN_DIMENSION_INCHES, MAX_DIMENSION_INCHES) ||
    !inRange(value.height, MIN_DIMENSION_INCHES, MAX_DIMENSION_INCHES) ||
    !inRange(value.weight, MIN_WEIGHT_OUNCES, MAX_WEIGHT_OUNCES)
  ) {
    return null;
  }
  return value;
}
