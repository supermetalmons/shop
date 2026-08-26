export const FIRESTORE_PROJECT_ID = 'mons-shop';

export const FIRESTORE_DATABASE_NAME = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)`;
export const FIRESTORE_DOCUMENTS_BASE_URL =
  `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents`;
export const FIRESTORE_DOCUMENT_NAME_PREFIX = `${FIRESTORE_DATABASE_NAME}/documents/`;

export class ProfileReadError extends Error {
  constructor(
    readonly code:
      | 'invalid-argument'
      | 'unauthenticated'
      | 'permission-denied'
      | 'not-found'
      | 'aborted'
      | 'failed-precondition'
      | 'resource-exhausted'
      | 'deadline-exceeded'
      | 'unavailable'
      | 'internal',
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProfileReadError';
  }
}

export class FirestoreWriteConflict extends Error {
  constructor(readonly status: 'ABORTED' | 'ALREADY_EXISTS' | 'FAILED_PRECONDITION' = 'ABORTED') {
    super('Firestore document changed during the write');
    this.name = 'FirestoreWriteConflict';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (typeof value.booleanValue === 'boolean') return value.booleanValue;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.timestampValue === 'string') {
    const milliseconds = Date.parse(value.timestampValue);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  if (typeof value.integerValue === 'string' && /^-?\d+$/.test(value.integerValue)) {
    const integer = Number(value.integerValue);
    return Number.isSafeInteger(integer) ? integer : value.integerValue;
  }
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (typeof value.bytesValue === 'string') return value.bytesValue;
  if (typeof value.referenceValue === 'string') return value.referenceValue;
  if (isRecord(value.geoPointValue)) {
    const latitude = value.geoPointValue.latitude;
    const longitude = value.geoPointValue.longitude;
    return typeof latitude === 'number' && Number.isFinite(latitude) &&
      typeof longitude === 'number' && Number.isFinite(longitude)
      ? { latitude, longitude }
      : undefined;
  }
  if (isRecord(value.arrayValue)) {
    const values = value.arrayValue.values;
    if (values === undefined) return [];
    if (!Array.isArray(values)) return undefined;
    const decoded = values.map(decodeFirestoreValue);
    return decoded.some((entry) => entry === undefined) ? undefined : decoded;
  }
  if (isRecord(value.mapValue)) {
    const fields = value.mapValue.fields;
    if (fields === undefined) return {};
    if (!isRecord(fields)) return undefined;
    const decoded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(fields)) {
      const decodedEntry = decodeFirestoreValue(entry);
      if (decodedEntry === undefined) return undefined;
      decoded[key] = decodedEntry;
    }
    return decoded;
  }
  return undefined;
}

export function decodeFirestoreFields(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const decodedEntry = decodeFirestoreValue(entry);
    if (decodedEntry === undefined) return null;
    decoded[key] = decodedEntry;
  }
  return decoded;
}
