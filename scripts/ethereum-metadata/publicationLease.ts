import { randomUUID } from 'node:crypto';
import { createAsyncD1MaintenanceQuery } from '../shared/asyncD1MaintenanceQuery.ts';
import { COMMERCE_D1_NOW_MS_SQL, sqlString, type CommerceAuthorityQuery } from '../shared/commerceD1Maintenance.ts';

const LEASE_MS = 120_000;
const DRAIN_MS = 65_000;
const WRITE_MS = 30_000;
export type MetadataWriteFence = { assertWritable(): void; signal: AbortSignal };
export type MetadataPublicationLease = MetadataWriteFence & {
  leaseId: string;
  beforePut(): Promise<void>;
  retireForRegistration(): Promise<void>;
  close(): Promise<void>;
};

export async function acquireMetadataPublicationLease(metadataBaseUri: string, options: {
  query?: CommerceAuthorityQuery; now?: () => number; wallNow?: () => number; leaseId?: string;
} = {}): Promise<MetadataPublicationLease> {
  const query = options.query ?? createAsyncD1MaintenanceQuery('ops');
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const leaseId = options.leaseId ?? randomUUID();
  const prefix = sqlString(metadataBaseUri);
  const owner = sqlString(leaseId);
  const owned = `metadata_base_uri = ${prefix} AND lease_id = ${owner}`;
  const clear = `NOT EXISTS (SELECT 1 FROM ethereum_reveal_deployments WHERE metadata_base_uri = ${prefix})`;
  let renewedAt = now();
  let renewedWall = wallNow();
  const rows = await query(`INSERT INTO ethereum_metadata_publication_leases(metadata_base_uri, lease_id, expires_at_ms, updated_at_ms)
    SELECT ${prefix}, ${owner}, ${COMMERCE_D1_NOW_MS_SQL} + ${LEASE_MS}, ${COMMERCE_D1_NOW_MS_SQL} WHERE ${clear}
    ON CONFLICT(metadata_base_uri) DO UPDATE SET lease_id = excluded.lease_id, expires_at_ms = excluded.expires_at_ms,
      updated_at_ms = excluded.updated_at_ms
    WHERE ethereum_metadata_publication_leases.expires_at_ms + ${DRAIN_MS} <= ${COMMERCE_D1_NOW_MS_SQL} AND ${clear}
    RETURNING lease_id`);
  if (rows.length !== 1 || rows[0].lease_id !== leaseId) throw new Error('Metadata prefix is reveal-managed or another publication is active.');
  const cancellation = new AbortController();
  let renewing: Promise<void> | undefined;
  let closed = false;
  let usedForWrites = false;
  let failure: Error | undefined;
  const poison = (message: string): Error => {
    failure ??= new Error(message);
    cancellation.abort(failure);
    return failure;
  };
  const elapsed = () => Math.max(now() - renewedAt, wallNow() - renewedWall);
  const assertOpen = () => {
    if (failure) throw failure;
    if (closed) throw new Error('Metadata publication lease is closed.');
  };
  const assertWritable = () => {
    assertOpen();
    if (elapsed() >= LEASE_MS - WRITE_MS) throw poison('Metadata publication lease expired before write dispatch.');
  };
  const renew = async () => {
    assertOpen();
    if (elapsed() < 30_000) return;
    renewing ??= (async () => {
      const started = now();
      const startedWall = wallNow();
      try {
        const result = await query(`UPDATE ethereum_metadata_publication_leases SET expires_at_ms = ${COMMERCE_D1_NOW_MS_SQL} + ${LEASE_MS},
          updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL} WHERE ${owned} AND ${clear} RETURNING lease_id`);
        if (result.length !== 1 || result[0].lease_id !== leaseId) throw new Error('lease lost');
        if (Math.max(now() - started, wallNow() - startedWall) >= 30_000) throw new Error('renewal timed out');
        renewedAt = started;
        renewedWall = startedWall;
      } catch { throw poison('Metadata publication lease was lost or renewal failed.'); }
    })();
    try { await renewing; } finally { renewing = undefined; }
    assertWritable();
  };
  return {
    leaseId, signal: cancellation.signal,
    assertWritable() { usedForWrites = true; assertWritable(); },
    async beforePut() { usedForWrites = true; await renew(); },
    async retireForRegistration() {
      await renew();
      if (usedForWrites) throw new Error('A metadata write lease must drain before registration.');
      assertWritable();
      closed = true;
      cancellation.abort(new Error('Metadata publication lease is being transferred.'));
      const result = await query(`UPDATE ethereum_metadata_publication_leases SET expires_at_ms=0,updated_at_ms=${COMMERCE_D1_NOW_MS_SQL}
        WHERE ${owned} AND ${clear} RETURNING lease_id`);
      if (result.length !== 1 || result[0].lease_id !== leaseId) throw poison('Metadata registration lease was lost.');
    },
    async close() {
      closed = true;
      cancellation.abort(new Error('Metadata publication lease is closed.'));
      await renewing?.catch(() => {});
      await query(usedForWrites
        ? `UPDATE ethereum_metadata_publication_leases SET expires_at_ms=${COMMERCE_D1_NOW_MS_SQL},updated_at_ms=${COMMERCE_D1_NOW_MS_SQL}
          WHERE ${owned} AND ${clear} RETURNING lease_id`
        : `DELETE FROM ethereum_metadata_publication_leases WHERE ${owned} RETURNING lease_id`);
    },
  };
}
