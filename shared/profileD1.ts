import type { ProfileAddress } from './contracts.ts';
import { isBase58Bytes } from './solanaRpcProxy.ts';

const MAX_PROFILE_TIMESTAMP_MS = 253_402_300_799_999;
const PROFILE_ADDRESS_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PROFILE_ADDRESS_ID_LENGTH = 20;
const PROFILE_ADDRESS_ID_RANDOM_LIMIT = 248;

export const PROFILE_ADDRESS_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

export function createProfileAddressId(): string {
  let id = '';
  while (id.length < PROFILE_ADDRESS_ID_LENGTH) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(PROFILE_ADDRESS_ID_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= PROFILE_ADDRESS_ID_RANDOM_LIMIT) continue;
      id += PROFILE_ADDRESS_ID_ALPHABET[byte % PROFILE_ADDRESS_ID_ALPHABET.length];
      if (id.length === PROFILE_ADDRESS_ID_LENGTH) break;
    }
  }
  return id;
}

export type D1Profile = {
  wallet: string;
  email?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type D1ProfileAddress = ProfileAddress & {
  wallet: string;
  label?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function boundedString(value: unknown, maximum: number, label: string, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.length === 0)) {
    return fail(`${label} is invalid.`);
  }
  return value;
}

function nullableBoundedString(value: unknown, maximum: number, label: string): string | undefined {
  if (value === null) return undefined;
  return boundedString(value, maximum, label, false);
}

function timestamp(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > MAX_PROFILE_TIMESTAMP_MS) {
    return fail(`${label} is invalid.`);
  }
  return normalized;
}

function wallet(value: unknown): string {
  if (typeof value !== 'string' || !isBase58Bytes(value, 32)) return fail('Profile wallet is invalid.');
  return value;
}

function addressId(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ADDRESS_ID_PATTERN.test(value)) return fail('Profile address id is invalid.');
  return value;
}

export function parseD1Profile(row: Record<string, unknown>): D1Profile {
  const createdAtMs = timestamp(row.created_at_ms, 'Profile created timestamp');
  const updatedAtMs = timestamp(row.updated_at_ms, 'Profile updated timestamp');
  if (updatedAtMs < createdAtMs) return fail('Profile timestamps are invalid.');
  const email = nullableBoundedString(row.email, 254, 'Profile email');
  return {
    wallet: wallet(row.wallet),
    ...(email ? { email } : {}),
    createdAtMs,
    updatedAtMs,
  };
}

export function parseD1ProfileAddress(row: Record<string, unknown>): D1ProfileAddress {
  const createdAtMs = timestamp(row.created_at_ms, 'Profile address created timestamp');
  const updatedAtMs = timestamp(row.updated_at_ms, 'Profile address updated timestamp');
  if (updatedAtMs < createdAtMs) return fail('Profile address timestamps are invalid.');
  const countryCode = nullableBoundedString(row.country_code, 32, 'Profile address country code');
  const email = nullableBoundedString(row.email, 254, 'Profile address email');
  const label = nullableBoundedString(row.label, 256, 'Profile address label');
  return {
    wallet: wallet(row.wallet),
    id: addressId(row.address_id),
    encrypted: boundedString(row.encrypted, 4096, 'Profile address ciphertext'),
    country: boundedString(row.country, 64, 'Profile address country'),
    ...(countryCode ? { countryCode } : {}),
    hint: boundedString(row.hint, 256, 'Profile address hint'),
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
    createdAtMs,
    updatedAtMs,
  };
}
