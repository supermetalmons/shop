import {
  canonicalWalletAddress,
  resolveAuthWalletBinding,
  type AuthWalletBindingResolution,
} from '../../../../shared/walletLifecycle.js';

const AUTH_WALLET_BINDING_RECONCILE_LEASE_MS = 120_000;
const AUTH_WALLET_BINDING_WRITE_ATTEMPTS = 5;
const AUTH_WALLET_BINDING_COLUMNS = `
  auth_subject,
  wallet,
  updated_at_ms,
  revision,
  reconcile_lease_id,
  reconcile_lease_expires_at_ms`;

export type D1AuthWalletBinding = {
  authSubject: string;
  wallet: string;
  updatedAtMs: number;
  revision: number;
  reconcileLeaseId: string | null;
  reconcileLeaseExpiresAtMs: number | null;
};

export type AuthWalletBindingLease = {
  id: string;
  wallet: string;
  expiresAtMs: number;
};

class AuthWalletBindingD1InvalidDataError extends Error {
  constructor() {
    super('Auth-wallet binding data is invalid.');
    this.name = 'AuthWalletBindingD1InvalidDataError';
  }
}

export class AuthWalletBindingD1SupersededError extends Error {
  constructor() {
    super('A newer wallet sign-in superseded this request.');
    this.name = 'AuthWalletBindingD1SupersededError';
  }
}

export class AuthWalletBindingD1BusyError extends Error {
  constructor() {
    super('Wallet session is busy. Try again.');
    this.name = 'AuthWalletBindingD1BusyError';
  }
}

function safeInteger(value: unknown, minimum = 0): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= minimum ? normalized : null;
}

function bindingFromRow(row: Record<string, unknown> | null): D1AuthWalletBinding | null {
  if (!row) return null;
  const authSubject = typeof row.auth_subject === 'string' ? row.auth_subject : '';
  const wallet = canonicalWalletAddress(row.wallet);
  const updatedAtMs = safeInteger(row.updated_at_ms);
  const revision = safeInteger(row.revision, 1);
  const reconcileLeaseId = row.reconcile_lease_id === null
    ? null
    : typeof row.reconcile_lease_id === 'string' && row.reconcile_lease_id.length === 36
      ? row.reconcile_lease_id
      : undefined;
  const reconcileLeaseExpiresAtMs = row.reconcile_lease_expires_at_ms === null
    ? null
    : safeInteger(row.reconcile_lease_expires_at_ms);
  if (
    !authSubject ||
    authSubject.length > 128 ||
    !wallet ||
    updatedAtMs === null ||
    revision === null ||
    reconcileLeaseId === undefined ||
    reconcileLeaseExpiresAtMs === null !== (reconcileLeaseId === null)
  ) {
    throw new AuthWalletBindingD1InvalidDataError();
  }
  return {
    authSubject,
    wallet,
    updatedAtMs,
    revision,
    reconcileLeaseId,
    reconcileLeaseExpiresAtMs,
  };
}

function changed(result: D1Result): boolean {
  return Number(result.meta.changes || 0) === 1;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

export async function loadD1AuthWalletBinding(
  db: D1Database,
  authSubject: string,
  signal?: AbortSignal,
): Promise<D1AuthWalletBinding | null> {
  throwIfAborted(signal);
  const row = await db.prepare(`SELECT ${AUTH_WALLET_BINDING_COLUMNS}
    FROM auth_wallet_bindings
    WHERE auth_subject = ?`)
    .bind(authSubject)
    .first<Record<string, unknown>>();
  throwIfAborted(signal);
  return bindingFromRow(row);
}

export async function resolveD1AuthWalletBinding(
  db: D1Database,
  authSubject: string,
  signal?: AbortSignal,
): Promise<AuthWalletBindingResolution> {
  return resolveAuthWalletBinding(await loadD1AuthWalletBinding(db, authSubject, signal));
}

function leaseActive(binding: D1AuthWalletBinding, nowMs: number): boolean {
  return binding.reconcileLeaseId !== null &&
    binding.reconcileLeaseExpiresAtMs !== null &&
    binding.reconcileLeaseExpiresAtMs > nowMs;
}

async function writeD1AuthWalletBinding(
  statement: D1PreparedStatement,
  signal?: AbortSignal,
): Promise<D1AuthWalletBinding | null> {
  throwIfAborted(signal);
  const row = await statement.first<Record<string, unknown>>();
  throwIfAborted(signal);
  return bindingFromRow(row);
}

export async function establishD1AuthWalletBinding(args: {
  baseline: D1AuthWalletBinding | null;
  db: D1Database;
  authSubject: string;
  nowMs: number;
  signal?: AbortSignal;
  wallet: string;
}): Promise<D1AuthWalletBinding> {
  throwIfAborted(args.signal);
  const wallet = canonicalWalletAddress(args.wallet);
  if (
    typeof args.authSubject !== 'string' ||
    args.authSubject.length < 1 ||
    args.authSubject.length > 128 ||
    wallet !== args.wallet ||
    !Number.isSafeInteger(args.nowMs) ||
    args.nowMs < 0 ||
    args.nowMs > 253_402_300_799_999
  ) {
    throw new AuthWalletBindingD1InvalidDataError();
  }
  for (let attempt = 0; attempt < AUTH_WALLET_BINDING_WRITE_ATTEMPTS; attempt += 1) {
    throwIfAborted(args.signal);
    const current = await loadD1AuthWalletBinding(args.db, args.authSubject, args.signal);
    if (!current) {
      if (args.baseline) throw new AuthWalletBindingD1SupersededError();
      const inserted = await writeD1AuthWalletBinding(args.db.prepare(`INSERT INTO auth_wallet_bindings (
          auth_subject,
          wallet,
          updated_at_ms,
          revision,
          reconcile_lease_id,
          reconcile_lease_expires_at_ms
        ) VALUES (?, ?, ?, 1, NULL, NULL)
        ON CONFLICT (auth_subject) DO NOTHING
        RETURNING ${AUTH_WALLET_BINDING_COLUMNS}`)
        .bind(
          args.authSubject,
          wallet,
          args.nowMs,
        ), args.signal);
      if (inserted) return inserted;
      continue;
    }
    if (current.wallet === wallet) {
      const renewed = await writeD1AuthWalletBinding(args.db.prepare(`UPDATE auth_wallet_bindings
        SET
          updated_at_ms = MAX(updated_at_ms, ?),
          revision = revision + 1
        WHERE auth_subject = ? AND wallet = ?
        RETURNING ${AUTH_WALLET_BINDING_COLUMNS}`)
        .bind(
          args.nowMs,
          args.authSubject,
          wallet,
        ), args.signal);
      if (renewed) return renewed;
      continue;
    }
    if (
      !args.baseline ||
      current.wallet !== args.baseline.wallet ||
      current.revision !== args.baseline.revision
    ) {
      throw new AuthWalletBindingD1SupersededError();
    }
    if (leaseActive(current, args.nowMs)) throw new AuthWalletBindingD1BusyError();
    const rebound = await writeD1AuthWalletBinding(args.db.prepare(`UPDATE auth_wallet_bindings
      SET
        wallet = ?,
        updated_at_ms = MAX(updated_at_ms, ?),
        revision = revision + 1,
        reconcile_lease_id = NULL,
        reconcile_lease_expires_at_ms = NULL
      WHERE
        auth_subject = ? AND
        wallet = ? AND
        revision = ? AND
        (
          reconcile_lease_id IS NULL OR
          reconcile_lease_expires_at_ms <= ?
        )
      RETURNING ${AUTH_WALLET_BINDING_COLUMNS}`)
      .bind(
        wallet,
        args.nowMs,
        args.authSubject,
        current.wallet,
        current.revision,
        args.nowMs,
      ), args.signal);
    if (rebound) return rebound;
  }
  throw new AuthWalletBindingD1SupersededError();
}

export async function acquireAuthWalletBindingReconcileLease(args: {
  db: D1Database;
  authSubject: string;
  leaseId?: string;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<AuthWalletBindingLease | null> {
  const binding = await loadD1AuthWalletBinding(args.db, args.authSubject, args.signal);
  if (!binding) return null;
  const id = args.leaseId || crypto.randomUUID();
  const expiresAtMs = args.nowMs + AUTH_WALLET_BINDING_RECONCILE_LEASE_MS;
  throwIfAborted(args.signal);
  const result = await args.db.prepare(`UPDATE auth_wallet_bindings
    SET
      reconcile_lease_id = ?,
      reconcile_lease_expires_at_ms = ?
    WHERE
      auth_subject = ? AND
      wallet = ? AND
      revision = ? AND
      (
        reconcile_lease_id IS NULL OR
        reconcile_lease_expires_at_ms <= ?
      )`)
    .bind(
      id,
      expiresAtMs,
      args.authSubject,
      binding.wallet,
      binding.revision,
      args.nowMs,
    )
    .run();
  throwIfAborted(args.signal);
  if (!changed(result)) throw new AuthWalletBindingD1BusyError();
  return { id, wallet: binding.wallet, expiresAtMs };
}

export async function releaseAuthWalletBindingReconcileLease(
  db: D1Database,
  authSubject: string,
  leaseId: string,
): Promise<void> {
  await db.prepare(`UPDATE auth_wallet_bindings
    SET
      reconcile_lease_id = NULL,
      reconcile_lease_expires_at_ms = NULL
    WHERE auth_subject = ? AND reconcile_lease_id = ?`)
    .bind(authSubject, leaseId)
    .run();
}
