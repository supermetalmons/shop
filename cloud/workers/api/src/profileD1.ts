import type { ProfileAddress } from '../../../../shared/contracts.js';
import {
  parseD1Profile,
  parseD1ProfileAddress,
  type D1Profile,
  type D1ProfileAddress,
} from '../../../../shared/profileD1.js';
import { saveProfileAddress } from './profilePersistence.js';

export {
  type D1Profile,
  type D1ProfileAddress,
} from '../../../../shared/profileD1.js';

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

export function saveD1ProfileAddress(
  db: D1Database,
  address: D1ProfileAddress,
  signal?: AbortSignal,
): Promise<ProfileAddress> {
  return saveProfileAddress(db, address, { profileTable: 'profiles', insertAddress: addressInsert }, signal);
}
