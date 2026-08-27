import type { ProfileAddress } from '../../../../shared/contracts.js';
import {
  parseD1Profile,
  parseD1ProfileAddress,
  type D1Profile,
  type D1ProfileAddress,
} from '../../../../shared/profileD1.js';

export {
  type D1Profile,
  type D1ProfileAddress,
} from '../../../../shared/profileD1.js';

function fail(message: string): never {
  throw new Error(message);
}

const D1_WRITE_ATTEMPTS = 2;
const RETRYABLE_D1_ERROR_PARTS = [
  'network connection lost',
  'storage caused object to be reset',
  'reset because its code was updated',
  'cannot resolve d1 db due to transient issue',
] as const;

function profileUpsert(db: D1Database, profile: D1Profile): D1PreparedStatement {
  return db.prepare(`INSERT INTO profiles (
    wallet,
    email,
    created_at_ms,
    updated_at_ms
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT (wallet) DO UPDATE SET
    email = CASE
      WHEN excluded.email IS NOT NULL AND (
        profiles.email IS NULL OR excluded.updated_at_ms >= profiles.updated_at_ms
      )
        THEN excluded.email
      ELSE profiles.email
    END,
    created_at_ms = MIN(profiles.created_at_ms, excluded.created_at_ms),
    updated_at_ms = CASE
      WHEN excluded.email IS NULL THEN profiles.updated_at_ms
      WHEN profiles.email IS NULL THEN excluded.updated_at_ms
      ELSE MAX(profiles.updated_at_ms, excluded.updated_at_ms)
    END`)
    .bind(profile.wallet, profile.email ?? null, profile.createdAtMs, profile.updatedAtMs);
}

function d1ErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error).toLowerCase();
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause || '');
  return `${error.message} ${cause}`.toLowerCase();
}

function isRetryableD1Error(error: unknown): boolean {
  const text = d1ErrorText(error);
  return RETRYABLE_D1_ERROR_PARTS.some((part) => text.includes(part));
}

export async function runD1Write<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  for (let attempt = 0; attempt < D1_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 >= D1_WRITE_ATTEMPTS || !isRetryableD1Error(error)) throw error;
    }
  }
  return fail('D1 write retry failed.');
}

function addressInsert(db: D1Database, address: D1ProfileAddress): D1PreparedStatement {
  return db.prepare(`INSERT INTO profile_addresses (
    wallet,
    address_id,
    encrypted,
    country,
    country_code,
    hint,
    email,
    label,
    created_at_ms,
    updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      address.wallet,
      address.id,
      address.encrypted,
      address.country,
      address.countryCode ?? null,
      address.hint,
      address.email ?? null,
      address.label ?? null,
      address.createdAtMs,
      address.updatedAtMs,
    );
}

export async function loadD1Profile(
  db: D1Database,
  ownerWallet: string,
  signal?: AbortSignal,
): Promise<D1Profile | null> {
  if (signal?.aborted) throw signal.reason;
  const row = await db.prepare(`SELECT wallet, email, created_at_ms, updated_at_ms
      FROM profiles
      WHERE wallet = ?`)
    .bind(ownerWallet)
    .first<Record<string, unknown>>();
  return row ? parseD1Profile(row) : null;
}

export async function loadD1ProfileAddress(
  db: D1Database,
  ownerWallet: string,
  id: string,
  signal?: AbortSignal,
): Promise<D1ProfileAddress | null> {
  if (signal?.aborted) throw signal.reason;
  const row = await db.prepare(`SELECT
      wallet,
      address_id,
      encrypted,
      country,
      country_code,
      hint,
      email,
      label,
      created_at_ms,
      updated_at_ms
    FROM profile_addresses
    WHERE wallet = ? AND address_id = ?`)
    .bind(ownerWallet, id)
    .first<Record<string, unknown>>();
  return row ? parseD1ProfileAddress(row) : null;
}

export async function saveD1ProfileAddress(
  db: D1Database,
  address: D1ProfileAddress,
  signal?: AbortSignal,
): Promise<ProfileAddress> {
  await runD1Write(signal, () => db.batch([
    profileUpsert(db, {
      wallet: address.wallet,
      ...(address.email ? { email: address.email } : {}),
      createdAtMs: address.createdAtMs,
      updatedAtMs: address.updatedAtMs,
    }),
    addressInsert(db, address),
  ]));
  return {
    id: address.id,
    country: address.country,
    ...(address.countryCode ? { countryCode: address.countryCode } : {}),
    hint: address.hint,
    encrypted: address.encrypted,
    ...(address.email ? { email: address.email } : {}),
  };
}

export async function ensureD1Profile(
  db: D1Database,
  profile: Pick<D1Profile, 'wallet' | 'createdAtMs' | 'updatedAtMs'>,
  signal?: AbortSignal,
): Promise<void> {
  await runD1Write(signal, () => db.prepare(`INSERT INTO profiles (
      wallet,
      email,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, NULL, ?, ?)
    ON CONFLICT (wallet) DO NOTHING`)
    .bind(profile.wallet, profile.createdAtMs, profile.updatedAtMs)
    .run());
}
