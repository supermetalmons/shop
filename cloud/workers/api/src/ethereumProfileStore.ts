import type { ProfileAddress } from '../../../../shared/contracts.js';
import { parseProfileAddress, type D1ProfileAddress } from '../../../../shared/profileD1.js';
import { saveProfileAddress } from './profilePersistence.js';

function parseAddressRow(row: Record<string, unknown>): ProfileAddress {
  if (typeof row.address_json !== 'string') throw new Error('Profile address is invalid.');
  const address = parseProfileAddress(JSON.parse(row.address_json));
  if (address.id !== row.address_id) throw new Error('Profile address identity is invalid.');
  return address;
}

export async function loadEthereumProfileAddress(
  db: D1Database,
  wallet: string,
  id: string,
  signal?: AbortSignal,
): Promise<ProfileAddress | null> {
  signal?.throwIfAborted();
  const row = await db.prepare(`SELECT address_id, address_json FROM ethereum_profile_addresses
    WHERE wallet = ? AND address_id = ?`).bind(wallet, id).first<Record<string, unknown>>();
  return row ? parseAddressRow(row) : null;
}

export function saveEthereumProfileAddress(
  db: D1Database,
  address: D1ProfileAddress,
  signal?: AbortSignal,
): Promise<ProfileAddress> {
  return saveProfileAddress(db, address, {
    profileTable: 'ethereum_profiles',
    insertAddress: (database, value) => database.prepare(`INSERT INTO ethereum_profile_addresses
      (wallet, address_id, address_json, created_at_ms) VALUES (?, ?, ?, ?)`)
      .bind(value.wallet, value.id, JSON.stringify(parseProfileAddress(value)), value.createdAtMs),
  }, signal);
}

export async function loadEthereumProfile(
  db: D1Database,
  wallet: string,
  signal?: AbortSignal,
): Promise<{ wallet: string; email?: string; addresses: ProfileAddress[] }> {
  signal?.throwIfAborted();
  const [profile, addresses] = await Promise.all([
    db.prepare('SELECT email FROM ethereum_profiles WHERE wallet = ?').bind(wallet).first<{ email: unknown }>(),
    db.prepare(`SELECT address_id, address_json FROM ethereum_profile_addresses
      WHERE wallet = ? ORDER BY created_at_ms DESC LIMIT 100`).bind(wallet).all<Record<string, unknown>>(),
  ]);
  const email = profile?.email;
  if (email != null && (typeof email !== 'string' || email.length > 254)) throw new Error('Profile email is invalid.');
  return { wallet, ...(email ? { email } : {}), addresses: addresses.results.map(parseAddressRow) };
}
