import {
  WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
  canonicalWalletAddress,
  resolveWalletSessionBinding,
  type WalletSessionResolution,
} from '../../../../shared/walletLifecycle.js';

const WALLET_SESSION_RECONCILE_LEASE_MS = 120_000;
const WALLET_SESSION_WRITE_ATTEMPTS = 5;

export type D1WalletSession = {
  firebaseUid: string;
  wallet: string;
  expiresAtMs: number;
  updatedAtMs: number;
  walletRevision: number;
  reconcileLeaseId: string | null;
  reconcileLeaseExpiresAtMs: number | null;
};

export type WalletSessionLease = {
  id: string;
  wallet: string;
  expiresAtMs: number;
};

class WalletSessionD1InvalidDataError extends Error {
  constructor() {
    super('Wallet-session data is invalid.');
    this.name = 'WalletSessionD1InvalidDataError';
  }
}

export class WalletSessionD1SupersededError extends Error {
  constructor() {
    super('A newer wallet sign-in superseded this request.');
    this.name = 'WalletSessionD1SupersededError';
  }
}

export class WalletSessionD1BusyError extends Error {
  constructor() {
    super('Wallet session is busy. Try again.');
    this.name = 'WalletSessionD1BusyError';
  }
}

function safeInteger(value: unknown, minimum = 0): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= minimum ? normalized : null;
}

function sessionFromRow(row: Record<string, unknown> | null): D1WalletSession | null {
  if (!row) return null;
  const firebaseUid = typeof row.firebase_uid === 'string' ? row.firebase_uid : '';
  const wallet = canonicalWalletAddress(row.wallet);
  const expiresAtMs = safeInteger(row.expires_at_ms);
  const updatedAtMs = safeInteger(row.updated_at_ms);
  const walletRevision = safeInteger(row.wallet_revision, 1);
  const reconcileLeaseId = row.reconcile_lease_id === null
    ? null
    : typeof row.reconcile_lease_id === 'string' && row.reconcile_lease_id.length === 36
      ? row.reconcile_lease_id
      : undefined;
  const reconcileLeaseExpiresAtMs = row.reconcile_lease_expires_at_ms === null
    ? null
    : safeInteger(row.reconcile_lease_expires_at_ms);
  if (
    !firebaseUid ||
    firebaseUid.length > 128 ||
    !wallet ||
    expiresAtMs === null ||
    updatedAtMs === null ||
    walletRevision === null ||
    reconcileLeaseId === undefined ||
    reconcileLeaseExpiresAtMs === null !== (reconcileLeaseId === null)
  ) {
    throw new WalletSessionD1InvalidDataError();
  }
  return {
    firebaseUid,
    wallet,
    expiresAtMs,
    updatedAtMs,
    walletRevision,
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

export async function loadD1WalletSession(
  db: D1Database,
  firebaseUid: string,
  signal?: AbortSignal,
): Promise<D1WalletSession | null> {
  throwIfAborted(signal);
  const row = await db.prepare(`SELECT
      firebase_uid,
      wallet,
      expires_at_ms,
      updated_at_ms,
      wallet_revision,
      reconcile_lease_id,
      reconcile_lease_expires_at_ms
    FROM wallet_sessions
    WHERE firebase_uid = ?`)
    .bind(firebaseUid)
    .first<Record<string, unknown>>();
  throwIfAborted(signal);
  return sessionFromRow(row);
}

export async function resolveD1WalletSession(
  db: D1Database,
  firebaseUid: string,
  signal?: AbortSignal,
): Promise<WalletSessionResolution> {
  const session = await loadD1WalletSession(db, firebaseUid, signal);
  return resolveWalletSessionBinding({
    uid: firebaseUid,
    sessionExists: session !== null,
    sessionData: session,
  });
}

function leaseActive(session: D1WalletSession, nowMs: number): boolean {
  return session.reconcileLeaseId !== null &&
    session.reconcileLeaseExpiresAtMs !== null &&
    session.reconcileLeaseExpiresAtMs > nowMs;
}

async function requireD1WalletSession(
  db: D1Database,
  firebaseUid: string,
  signal?: AbortSignal,
): Promise<D1WalletSession> {
  const session = await loadD1WalletSession(db, firebaseUid, signal);
  if (!session) throw new WalletSessionD1InvalidDataError();
  return session;
}

export async function establishD1WalletSession(args: {
  baseline: D1WalletSession | null;
  db: D1Database;
  firebaseUid: string;
  nowMs: number;
  signal?: AbortSignal;
  wallet: string;
}): Promise<D1WalletSession> {
  throwIfAborted(args.signal);
  const wallet = canonicalWalletAddress(args.wallet);
  if (
    typeof args.firebaseUid !== 'string' ||
    args.firebaseUid.length < 1 ||
    args.firebaseUid.length > 128 ||
    wallet !== args.wallet ||
    !Number.isSafeInteger(args.nowMs) ||
    args.nowMs < 0 ||
    args.nowMs > WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS
  ) {
    throw new WalletSessionD1InvalidDataError();
  }
  for (let attempt = 0; attempt < WALLET_SESSION_WRITE_ATTEMPTS; attempt += 1) {
    throwIfAborted(args.signal);
    const current = await loadD1WalletSession(args.db, args.firebaseUid, args.signal);
    if (!current) {
      if (args.baseline) throw new WalletSessionD1SupersededError();
      const inserted = await args.db.prepare(`INSERT INTO wallet_sessions (
          firebase_uid,
          wallet,
          expires_at_ms,
          updated_at_ms,
          wallet_revision,
          reconcile_lease_id,
          reconcile_lease_expires_at_ms
        ) VALUES (?, ?, ?, ?, 1, NULL, NULL)
        ON CONFLICT (firebase_uid) DO NOTHING`)
        .bind(
          args.firebaseUid,
          wallet,
          WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
          args.nowMs,
        )
        .run();
      if (changed(inserted)) {
        return requireD1WalletSession(args.db, args.firebaseUid, args.signal);
      }
      continue;
    }
    if (current.wallet === wallet) {
      const renewed = await args.db.prepare(`UPDATE wallet_sessions
        SET
          expires_at_ms = ?,
          updated_at_ms = MAX(updated_at_ms, ?),
          wallet_revision = wallet_revision + 1
        WHERE firebase_uid = ? AND wallet = ?`)
        .bind(
          WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
          args.nowMs,
          args.firebaseUid,
          wallet,
        )
        .run();
      if (changed(renewed)) {
        return requireD1WalletSession(args.db, args.firebaseUid, args.signal);
      }
      continue;
    }
    if (
      !args.baseline ||
      current.wallet !== args.baseline.wallet ||
      current.walletRevision !== args.baseline.walletRevision
    ) {
      throw new WalletSessionD1SupersededError();
    }
    if (leaseActive(current, args.nowMs)) throw new WalletSessionD1BusyError();
    const rebound = await args.db.prepare(`UPDATE wallet_sessions
      SET
        wallet = ?,
        expires_at_ms = ?,
        updated_at_ms = MAX(updated_at_ms, ?),
        wallet_revision = wallet_revision + 1,
        reconcile_lease_id = NULL,
        reconcile_lease_expires_at_ms = NULL
      WHERE
        firebase_uid = ? AND
        wallet = ? AND
        wallet_revision = ? AND
        (
          reconcile_lease_id IS NULL OR
          reconcile_lease_expires_at_ms <= ?
        )`)
      .bind(
        wallet,
        WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
        args.nowMs,
        args.firebaseUid,
        current.wallet,
        current.walletRevision,
        args.nowMs,
      )
      .run();
    if (changed(rebound)) {
      return requireD1WalletSession(args.db, args.firebaseUid, args.signal);
    }
  }
  throw new WalletSessionD1SupersededError();
}

async function ensureLegacyD1WalletSession(
  db: D1Database,
  firebaseUid: string,
  nowMs: number,
  signal?: AbortSignal,
): Promise<D1WalletSession | null> {
  const existing = await loadD1WalletSession(db, firebaseUid, signal);
  if (existing) return existing;
  const wallet = canonicalWalletAddress(firebaseUid);
  if (!wallet) return null;
  throwIfAborted(signal);
  await db.prepare(`INSERT INTO wallet_sessions (
      firebase_uid,
      wallet,
      expires_at_ms,
      updated_at_ms,
      wallet_revision,
      reconcile_lease_id,
      reconcile_lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, NULL, NULL)
    ON CONFLICT (firebase_uid) DO NOTHING`)
    .bind(firebaseUid, wallet, WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS, nowMs)
    .run();
  return loadD1WalletSession(db, firebaseUid, signal);
}

export async function acquireWalletSessionReconcileLease(args: {
  db: D1Database;
  firebaseUid: string;
  leaseId?: string;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<WalletSessionLease | null> {
  const session = await ensureLegacyD1WalletSession(
    args.db,
    args.firebaseUid,
    args.nowMs,
    args.signal,
  );
  if (!session) return null;
  const id = args.leaseId || crypto.randomUUID();
  const expiresAtMs = args.nowMs + WALLET_SESSION_RECONCILE_LEASE_MS;
  throwIfAborted(args.signal);
  const result = await args.db.prepare(`UPDATE wallet_sessions
    SET
      reconcile_lease_id = ?,
      reconcile_lease_expires_at_ms = ?
    WHERE
      firebase_uid = ? AND
      wallet = ? AND
      wallet_revision = ? AND
      (
        reconcile_lease_id IS NULL OR
        reconcile_lease_expires_at_ms <= ?
      )`)
    .bind(
      id,
      expiresAtMs,
      args.firebaseUid,
      session.wallet,
      session.walletRevision,
      args.nowMs,
    )
    .run();
  throwIfAborted(args.signal);
  if (!changed(result)) throw new WalletSessionD1BusyError();
  return { id, wallet: session.wallet, expiresAtMs };
}

export async function releaseWalletSessionReconcileLease(
  db: D1Database,
  firebaseUid: string,
  leaseId: string,
): Promise<void> {
  await db.prepare(`UPDATE wallet_sessions
    SET
      reconcile_lease_id = NULL,
      reconcile_lease_expires_at_ms = NULL
    WHERE firebase_uid = ? AND reconcile_lease_id = ?`)
    .bind(firebaseUid, leaseId)
    .run();
}
