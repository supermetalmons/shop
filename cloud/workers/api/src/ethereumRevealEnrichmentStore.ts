import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { REVEAL_ENRICHMENT_VERSION, type EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import type { RevealSql } from './ethereumRevealStore.js';

export const REVEAL_ENRICHMENT_SLOTS = 4;
const CLAIM_MS = 60_000;

export const REVEAL_ENRICHMENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_enrichment (
    token_id TEXT NOT NULL REFERENCES assignments(token_id), version TEXT NOT NULL,assignment_revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','invalid','conflict')),
    next_check_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, claim_id TEXT, last_error TEXT,
    target_json TEXT, target_sha256 TEXT, PRIMARY KEY(token_id,version),
    CHECK((target_json IS NULL) = (target_sha256 IS NULL)), CHECK(status != 'published' OR target_json IS NOT NULL))`,
  `CREATE INDEX IF NOT EXISTS reveal_enrichment_due ON reveal_enrichment(version,next_check_ms,token_id) WHERE status='pending'`,
  `CREATE INDEX IF NOT EXISTS reveal_enrichment_health ON reveal_enrichment(version,status,last_error)`,
  `CREATE TABLE IF NOT EXISTS reveal_enrichment_acknowledgments (
    token_id TEXT NOT NULL, version TEXT NOT NULL, target_sha256 TEXT NOT NULL,assignment_revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(token_id,version),
    FOREIGN KEY(token_id,version) REFERENCES reveal_enrichment(token_id,version))`,
  `CREATE TRIGGER IF NOT EXISTS enqueue_reveal_enrichment AFTER UPDATE OF status ON publication
    WHEN OLD.status='pending' AND NEW.status='published' BEGIN
      INSERT INTO reveal_enrichment(token_id,version,assignment_revision)
      SELECT token_id,'${REVEAL_ENRICHMENT_VERSION}',assignment_revision FROM assignments WHERE token_id=NEW.token_id AND category!='egg'
      ON CONFLICT(token_id,version) DO NOTHING;
    END`,
];

export type RevealEnrichmentClaim = {
  token_id: string; category: EthereumArtworkCategory; asset_id: number; metadata_json: string;
  target_json: string | null; target_sha256: string | null; acknowledged_sha256: string | null; last_error: string | null;
  attempts: number; claim_id: string;
  assignment_revision: number; metadata_revision: number;
};

export type RevealEnrichmentOutcome = 'published' | 'invalid' | 'conflict' | 'source-unavailable' | 'publication-unavailable';

export function matchesEnrichmentChecksum(json: string | null, expected: string | null, acknowledged: string | null | undefined): boolean {
  return typeof json === 'string' && json.length > 0 && (acknowledged == null || acknowledged === expected) && bytesToHex(sha256(json)) === expected;
}

export function acknowledgedEnrichmentHash(sql: RevealSql, tokenId: string, version: string, assignmentRevision?: number): string | undefined {
  if (!sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment_acknowledgments'").toArray().length) return;
  const revisionColumn = assignmentRevision !== undefined && sql.exec<{ name: string }>('PRAGMA table_info(reveal_enrichment_acknowledgments)')
    .toArray().some(column => column.name === 'assignment_revision');
  return sql.exec<{ target_sha256: string }>(`SELECT target_sha256 FROM reveal_enrichment_acknowledgments WHERE token_id=? AND version=?
    ${assignmentRevision === undefined ? '' : `AND ${revisionColumn ? 'assignment_revision' : '0'}=?`}`,
    tokenId, version, ...(assignmentRevision === undefined ? [] : [assignmentRevision])).toArray()[0]?.target_sha256;
}

export class EthereumRevealEnrichmentStore {
  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T) {
    this.transaction(() => {
      for (const table of ['reveal_enrichment', 'reveal_enrichment_acknowledgments']) {
        const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
        if (columns.length && !columns.some(column => column.name === 'assignment_revision')) {
          this.sql.exec(`ALTER TABLE ${table} ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 0`);
        }
      }
      this.sql.exec('DROP TRIGGER IF EXISTS enqueue_reveal_enrichment');
      this.sql.exec(REVEAL_ENRICHMENT_SCHEMA.at(-1)!);
    });
  }

  claim(now: number, limit = REVEAL_ENRICHMENT_SLOTS): RevealEnrichmentClaim[] {
    return this.transaction(() => {
      const claimId = crypto.randomUUID();
      const jobs = this.sql.exec<RevealEnrichmentClaim>(`SELECT e.token_id,a.category,a.asset_id,a.metadata_json,e.target_json,e.target_sha256,
        e.assignment_revision,2*e.assignment_revision+1 AS metadata_revision,
        ack.target_sha256 AS acknowledged_sha256,e.last_error,
        e.attempts+1 AS attempts,? AS claim_id FROM reveal_enrichment e JOIN assignments a ON a.token_id=e.token_id
        LEFT JOIN reveal_enrichment_acknowledgments ack ON ack.token_id=e.token_id AND ack.version=e.version AND ack.assignment_revision=e.assignment_revision
        WHERE e.version=? AND e.status='pending' AND e.assignment_revision=a.assignment_revision AND e.next_check_ms<=? ORDER BY e.next_check_ms,e.token_id LIMIT ?`,
        claimId, REVEAL_ENRICHMENT_VERSION, now, limit).toArray();
      for (const job of jobs) {
        this.sql.exec(`UPDATE reveal_enrichment SET claim_id=?,attempts=?,next_check_ms=? WHERE token_id=? AND version=?`,
          claimId, job.attempts, now + CLAIM_MS, job.token_id, REVEAL_ENRICHMENT_VERSION);
      }
      return jobs;
    });
  }

  stage(job: RevealEnrichmentClaim, json: string, sha256: string): boolean {
    return this.sql.exec(`UPDATE reveal_enrichment SET target_json=?,target_sha256=?
      WHERE token_id=? AND version=? AND status='pending' AND claim_id=? AND assignment_revision=? AND target_json IS NULL
        AND EXISTS (SELECT 1 FROM assignments a WHERE a.token_id=reveal_enrichment.token_id AND a.assignment_revision=reveal_enrichment.assignment_revision)
      RETURNING token_id`, json, sha256, job.token_id, REVEAL_ENRICHMENT_VERSION, job.claim_id, job.assignment_revision).toArray().length === 1;
  }

  complete(job: RevealEnrichmentClaim, outcome: RevealEnrichmentOutcome, now: number): boolean {
    const retry = outcome === 'source-unavailable' || outcome === 'publication-unavailable';
    const next = retry ? now + Math.min(300_000, 1_000 * 2 ** Math.min(job.attempts, 9)) : 0;
    return this.sql.exec(`UPDATE reveal_enrichment SET status=?,next_check_ms=?,claim_id=NULL,
      last_error=CASE WHEN last_error='conflict-recheck' AND ? NOT IN ('published','conflict') THEN last_error ELSE ? END
      WHERE token_id=? AND version=? AND status='pending' AND claim_id=? AND assignment_revision=?
        AND EXISTS (SELECT 1 FROM assignments a WHERE a.token_id=reveal_enrichment.token_id AND a.assignment_revision=reveal_enrichment.assignment_revision)
      RETURNING token_id`,
      retry ? 'pending' : outcome, next, outcome, outcome === 'published' ? null : outcome,
      job.token_id, REVEAL_ENRICHMENT_VERSION, job.claim_id, job.assignment_revision).toArray().length === 1;
  }

  nextWake(now: number, busy: boolean): number | null {
    if (busy) return now + CLAIM_MS;
    return this.sql.exec<{ due: number | null }>(`SELECT MIN(next_check_ms) AS due FROM reveal_enrichment
      WHERE version=? AND status='pending'`, REVEAL_ENRICHMENT_VERSION).toArray()[0].due;
  }

  summary(): Record<string, number> {
    const rows = this.sql.exec<{ status: string; last_error: string | null; count: number }>(`SELECT status,last_error,COUNT(*) AS count
      FROM reveal_enrichment WHERE version=? GROUP BY status,last_error`, REVEAL_ENRICHMENT_VERSION).toArray();
    return Object.fromEntries(rows.map(row => [row.last_error ?? row.status, row.count]));
  }
}
