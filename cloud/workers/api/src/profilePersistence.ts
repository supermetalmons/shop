import type { ProfileAddress } from '../../../../shared/contracts.js';
import { parseProfileAddress, type D1ProfileAddress } from '../../../../shared/profileD1.js';

const D1_WRITE_ATTEMPTS = 2;
const RETRYABLE_D1_ERROR_PARTS = [
  'network connection lost',
  'storage caused object to be reset',
  'reset because its code was updated',
  'cannot resolve d1 db due to transient issue',
] as const;

export class ProfileAddressConflictError extends Error {
  constructor(cause: unknown) {
    super('This saved address cannot be changed. Save a new address instead.', { cause });
    this.name = 'ProfileAddressConflictError';
  }
}

function d1ErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error).toLowerCase();
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause || '');
  return `${error.message} ${cause}`.toLowerCase();
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
      if (attempt + 1 >= D1_WRITE_ATTEMPTS ||
        !RETRYABLE_D1_ERROR_PARTS.some((part) => d1ErrorText(error).includes(part))) throw error;
    }
  }
  throw new Error('D1 write retry failed.');
}

export async function saveProfileAddress(
  db: D1Database,
  address: D1ProfileAddress,
  storage: {
    profileTable: 'profiles' | 'ethereum_profiles';
    insertAddress: (db: D1Database, address: D1ProfileAddress) => D1PreparedStatement;
  },
  signal?: AbortSignal,
): Promise<ProfileAddress> {
  signal?.throwIfAborted();
  const saved = parseProfileAddress(address);
  const table = storage.profileTable;
  try {
    await runD1Write(signal, () => db.batch([
      db.prepare(`INSERT INTO ${table} (wallet, email, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (wallet) DO UPDATE SET
          email = CASE
            WHEN excluded.email IS NOT NULL AND (
              ${table}.email IS NULL OR excluded.updated_at_ms >= ${table}.updated_at_ms
            ) THEN excluded.email ELSE ${table}.email END,
          created_at_ms = MIN(${table}.created_at_ms, excluded.created_at_ms),
          updated_at_ms = CASE
            WHEN excluded.email IS NULL THEN ${table}.updated_at_ms
            WHEN ${table}.email IS NULL THEN excluded.updated_at_ms
            ELSE MAX(${table}.updated_at_ms, excluded.updated_at_ms) END`)
        .bind(address.wallet, saved.email ?? null, address.createdAtMs, address.updatedAtMs),
      storage.insertAddress(db, { ...address, ...saved }),
    ]));
  } catch (error) {
    if (d1ErrorText(error).includes('profile address id conflict')) throw new ProfileAddressConflictError(error);
    throw error;
  }
  return saved;
}
