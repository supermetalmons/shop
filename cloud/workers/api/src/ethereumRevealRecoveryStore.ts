import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealedArtwork, EthereumRevealObservation, EthereumRevealTokensResponse } from '../../../../shared/ethereum/reveal.js';
import type { EthereumRevealCrateRecovery, EthereumRevealTokenRecovery, EthereumRevealTransactionInspection } from './ethereumRevealChain.js';
import type { RevealCrate, RevealSearchRange, RevealSql } from './ethereumRevealStore.js';

export type RevealWorkLane = 'active' | 'background';
export type RevealReceiptClaim = { hash: string; claimId: string; startedAtMs: number; leaseUntilMs: number; active: boolean };
export type RevealDispatchState = { limit: number; inFlight: number; active: number; background: number;
  pauseUntilMs: number; nextRecoveryMs: number | null; earliestLeaseUntilMs: number | null };
export type RevealScanClaim = { kind: 'crate' | 'tokens'; id: string; claimId: string; leaseUntilMs: number;
  active: boolean; range: RevealSearchRange; crateTokenIds: string[]; tokenIds: string[] };

type ReceiptRow = { hash: string; requested_all: number; observed: number; opaque: number; active_until_ms: number;
  next_check_ms: number; last_checked_ms: number; attempts: number; claim_id: string | null; lease_until_ms: number;
  claim_active: number;
  created_at_ms: number; request_pending: number; resolved: number; legacy_pending: number; result_json: string | null };
type DispatchRow = { concurrency_limit: number; pause_until_ms: number; recovery_at_ms: number };
type CrateRow = { crate_token_id: string; mode: string; observed_hash: string | null; active_until_ms: number;
  receipt_due_ms: number; scan_due_ms: number | null; receipt_served_ms: number; scan_served_ms: number;
  generation: number; from_block: number; ranges_json: string; scan_attempts: number;
  scan_claim_id: string | null; scan_lease_until_ms: number; scan_claim_generation: number; updated_at_ms: number };
type TokenJob = { id: string; token_ids_json: string; ranges_json: string; next_check_ms: number; attempts: number;
  active_until_ms: number; claim_id: string | null; lease_until_ms: number; generation: number; claimed_generation: number;
  served_ms: number };
type LegacyTransaction = { hash: string; status: string; crates_json: string; tokens_json: string; from_block: number;
  requested_all: number; receipt_seen: number; created_at_ms: number; last_requested_at_ms: number; observation_json: string | null; failure_json: string | null; dormant: number };
type MigrationRow = { phase: string; cursor: string; row_key: string | null; offset: number };
type CrateReceiptSnapshot = { crate_token_id: string; generation: number; evidence_version: number };
type RecoveryHooks = {
  freeze(deployment: EthereumRevealDeployment, observation: EthereumRevealObservation, crates: RevealCrate[], now: number, allCrates: boolean): number;
  reserve(crateTokenIds: string[]): void;
  frozen(tokenIds: string[]): EthereumRevealedArtwork[];
};

const ACTIVE_MS = 30_000;
const COOLDOWN_MS = 2_000;
const OPAQUE_LIMIT = 10_000;
const UNKNOWN_MS = 15 * 60_000;
const RECEIPT_LEASE_MS = 30_000;
const RECEIPT_CONCURRENCY = 64;
const RECEIPT_MIN_CONCURRENCY = 4;
const CONCURRENCY_RECOVERY_MS = 30_000;
const SCAN_LEASE_MS = 60_000;
const DAY_MS = 86_400_000;
const ELIGIBLE_CANDIDATE = "(j.mode!='observed' OR j.observed_hash=c.hash OR c.evidence_version>c.checked_version)";
const LIFECYCLE_REPAIR = 'reveal-recovery-lifecycle-v1';
const UNSCOPED_REQUEST = `w.requested_all=1
  AND EXISTS(SELECT 1 FROM transactions t WHERE t.hash=w.hash AND t.crates_json='[]')
  AND NOT EXISTS(SELECT 1 FROM crate_candidates c WHERE c.hash=w.hash)`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_recovery_migration (id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL,
    cursor TEXT NOT NULL DEFAULT '',row_key TEXT,offset INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS crate_recovery_jobs (crate_token_id TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'recovering',
    observed_hash TEXT,active_until_ms INTEGER NOT NULL DEFAULT 0,receipt_due_ms INTEGER NOT NULL DEFAULT 9007199254740991,
    scan_due_ms INTEGER,receipt_served_ms INTEGER NOT NULL DEFAULT 0,scan_served_ms INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,from_block INTEGER NOT NULL,ranges_json TEXT NOT NULL DEFAULT '[]',
    scan_attempts INTEGER NOT NULL DEFAULT 0,scan_claim_id TEXT,scan_lease_until_ms INTEGER NOT NULL DEFAULT 0,
    scan_claim_generation INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS crate_receipt_due ON crate_recovery_jobs(receipt_due_ms,receipt_served_ms,crate_token_id)`,
  `CREATE INDEX IF NOT EXISTS crate_scan_due ON crate_recovery_jobs(scan_due_ms,scan_served_ms,crate_token_id)`,
  `CREATE TABLE IF NOT EXISTS receipt_work (hash TEXT PRIMARY KEY REFERENCES transactions(hash),requested_all INTEGER NOT NULL DEFAULT 0,
    observed INTEGER NOT NULL DEFAULT 0,opaque INTEGER NOT NULL DEFAULT 0,active_until_ms INTEGER NOT NULL DEFAULT 0,
    next_check_ms INTEGER NOT NULL DEFAULT 0,last_checked_ms INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
    claim_id TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,claim_active INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,request_pending INTEGER NOT NULL DEFAULT 0,resolved INTEGER NOT NULL DEFAULT 0,
    legacy_pending INTEGER NOT NULL DEFAULT 0,result_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS receipt_opaque_due ON receipt_work(next_check_ms,last_checked_ms,hash) WHERE opaque=1 AND resolved=0`,
  `CREATE TABLE IF NOT EXISTS reveal_dispatch_control (id INTEGER PRIMARY KEY CHECK(id=1),
    concurrency_limit INTEGER NOT NULL DEFAULT 64 CHECK(concurrency_limit BETWEEN 4 AND 64),
    pause_until_ms INTEGER NOT NULL DEFAULT 0,recovery_at_ms INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO reveal_dispatch_control(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS reveal_overflow_claims (hash TEXT PRIMARY KEY,claim_id TEXT NOT NULL UNIQUE,
    started_at_ms INTEGER NOT NULL,lease_until_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reveal_overflow_lease ON reveal_overflow_claims(lease_until_ms)`,
  `CREATE INDEX IF NOT EXISTS receipt_unresolved_due ON receipt_work(next_check_ms,last_checked_ms,hash) WHERE resolved=0`,
  `CREATE TABLE IF NOT EXISTS crate_candidates (crate_token_id TEXT NOT NULL REFERENCES crate_recovery_jobs(crate_token_id),
    hash TEXT NOT NULL REFERENCES receipt_work(hash),evidence_version INTEGER NOT NULL DEFAULT 0,checked_version INTEGER NOT NULL DEFAULT 0,
    evidence_key TEXT,next_check_ms INTEGER NOT NULL DEFAULT 0,last_checked_ms INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(crate_token_id,hash))`,
  `CREATE INDEX IF NOT EXISTS crate_candidate_hash ON crate_candidates(hash,crate_token_id)`,
  `CREATE INDEX IF NOT EXISTS crate_candidate_due ON crate_candidates(crate_token_id,next_check_ms,last_checked_ms,hash)`,
  `CREATE TABLE IF NOT EXISTS receipt_claim_crates (hash TEXT NOT NULL,claim_id TEXT NOT NULL,crate_token_id TEXT NOT NULL,
    evidence_version INTEGER NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(hash,claim_id,crate_token_id))`,
  `CREATE TABLE IF NOT EXISTS receipt_token_interest (hash TEXT NOT NULL REFERENCES receipt_work(hash),token_id TEXT NOT NULL,
    PRIMARY KEY(hash,token_id))`,
  `CREATE INDEX IF NOT EXISTS receipt_interest_token ON receipt_token_interest(token_id,hash)`,
  `CREATE TABLE IF NOT EXISTS receipt_claim_tokens (hash TEXT NOT NULL,claim_id TEXT NOT NULL,token_id TEXT NOT NULL,
    PRIMARY KEY(hash,claim_id,token_id))`,
];

function validCrate(id: unknown): id is string {
  return typeof id === 'string' && /^[1-9]\d*$/.test(id) && Number(id) >= 111_112 && Number(id) <= 116_666;
}

function array(value: string): unknown[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function quietDelay(attempts: number): number { return Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8)); }

export class EthereumRevealRecoveryStore {
  constructor(private readonly sql: RevealSql, private readonly atomic: <T>(action: () => T) => T, private readonly hooks: RecoveryHooks) {
    this.atomic(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      if (!this.sql.exec<{ name: string }>('PRAGMA table_info(receipt_work)').toArray().some(row => row.name === 'request_pending')) {
        this.sql.exec('ALTER TABLE receipt_work ADD COLUMN request_pending INTEGER NOT NULL DEFAULT 0');
      }
      if (!this.sql.exec<{ name: string }>('PRAGMA table_info(receipt_work)').toArray().some(row => row.name === 'claim_active')) {
        this.sql.exec('ALTER TABLE receipt_work ADD COLUMN claim_active INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE receipt_work SET claim_active=1 WHERE claim_id IS NOT NULL AND active_until_ms>last_checked_ms');
      }
      this.sql.exec(`CREATE INDEX IF NOT EXISTS receipt_live_claims ON receipt_work(lease_until_ms,claim_active)
        WHERE claim_id IS NOT NULL`);
      if (!this.sql.exec<{ name: string }>('PRAGMA table_info(crate_recovery_jobs)').toArray().some(row => row.name === 'updated_at_ms')) {
        this.sql.exec('ALTER TABLE crate_recovery_jobs ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0');
      }
      const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(recovery_jobs)').toArray().map(row => row.name));
      for (const [name, definition] of [['active_until_ms', 'INTEGER NOT NULL DEFAULT 0'], ['claim_id', 'TEXT'],
        ['lease_until_ms', 'INTEGER NOT NULL DEFAULT 0'], ['generation', 'INTEGER NOT NULL DEFAULT 0'],
        ['claimed_generation', 'INTEGER NOT NULL DEFAULT 0'], ['served_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE recovery_jobs ADD COLUMN ${name} ${definition}`);
      }
      if (!this.sql.exec('SELECT id FROM reveal_recovery_migration WHERE id=1').toArray().length) {
        const legacy = this.sql.exec(`SELECT 1 AS found WHERE EXISTS(SELECT 1 FROM transactions) OR EXISTS(SELECT 1 FROM crates)
          OR EXISTS(SELECT 1 FROM recovery_jobs) OR EXISTS(SELECT 1 FROM replacement_candidates) OR EXISTS(SELECT 1 FROM observations)`).toArray().length;
        this.sql.exec('INSERT INTO reveal_recovery_migration(id,phase) VALUES(1,?)', legacy ? 'transactions' : 'ready');
        if (!legacy) this.sql.exec('INSERT OR IGNORE INTO reveal_migrations(name) VALUES(?)', LIFECYCLE_REPAIR);
      } else if (!this.sql.exec('SELECT 1 FROM reveal_migrations WHERE name=?', LIFECYCLE_REPAIR).toArray().length) {
        this.sql.exec("UPDATE reveal_recovery_migration SET phase='repair-watches',cursor='',row_key=NULL,offset=0 WHERE id=1 AND phase='ready'");
      }
    });
  }

  private fromBlock(): number {
    return this.sql.exec<{ block: number }>(`SELECT CAST(json_extract(deployment_json,'$.deploymentBlock') AS INTEGER) AS block
      FROM settings WHERE id=1`).toArray()[0]?.block ?? 0;
  }

  private history(hash: string, fromBlock: number, requestedAll = false): void {
    this.sql.exec(`INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms,incarnation,transient)
      VALUES(?,?,?,?,?,?,0) ON CONFLICT(hash) DO UPDATE SET requested_all=MAX(requested_all,excluded.requested_all)`,
    hash, fromBlock, requestedAll ? 1 : 0, Date.now(), Date.now(), crypto.randomUUID());
  }

  private work(hash: string, now: number): ReceiptRow {
    this.history(hash, this.fromBlock());
    this.sql.exec('INSERT OR IGNORE INTO receipt_work(hash,created_at_ms) VALUES(?,?)', hash, now);
    return this.sql.exec<ReceiptRow>('SELECT * FROM receipt_work WHERE hash=?', hash).toArray()[0];
  }

  private ensureCrate(id: string, fromBlock: number, now: number, activeUntil = 0): void {
    if (!validCrate(id)) throw new Error('Invalid recovery crate.');
    this.sql.exec(`INSERT INTO crate_recovery_jobs(crate_token_id,from_block,scan_due_ms,active_until_ms,receipt_due_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(crate_token_id) DO UPDATE SET active_until_ms=MAX(active_until_ms,excluded.active_until_ms)`,
    id, Math.max(this.fromBlock(), fromBlock), now, activeUntil, Number.MAX_SAFE_INTEGER);
  }

  private candidate(id: string, hash: string, now: number, evidenceKey?: string): void {
    const work = this.work(hash, now);
    this.sql.exec('UPDATE crate_recovery_jobs SET active_until_ms=MAX(active_until_ms,?) WHERE crate_token_id=?', work.active_until_ms, id);
    this.sql.exec('UPDATE receipt_work SET opaque=0,observed=MAX(observed,?) WHERE hash=?', evidenceKey ? 1 : 0, hash);
    this.sql.exec(`INSERT INTO crate_candidates(crate_token_id,hash,evidence_version,evidence_key) VALUES(?,?,?,?)
      ON CONFLICT(crate_token_id,hash) DO UPDATE SET
      evidence_version=CASE WHEN excluded.evidence_key IS NOT NULL AND excluded.evidence_key IS NOT crate_candidates.evidence_key
        THEN crate_candidates.evidence_version+1 ELSE crate_candidates.evidence_version END,
      evidence_key=COALESCE(excluded.evidence_key,crate_candidates.evidence_key),
      next_check_ms=CASE WHEN excluded.evidence_key IS NOT NULL AND excluded.evidence_key IS NOT crate_candidates.evidence_key
        THEN MIN(crate_candidates.next_check_ms,?) ELSE crate_candidates.next_check_ms END`, id, hash, evidenceKey ? 1 : 0, evidenceKey ?? null, now);
    this.rescheduleCrate(id);
  }

  migrationReady(): boolean { return this.sql.exec<MigrationRow>('SELECT * FROM reveal_recovery_migration WHERE id=1').toArray()[0].phase === 'ready'; }

  migrateChunk(now: number, limit = 128): { ready: boolean; processed: number } {
    return this.atomic(() => {
      let processed = 0;
      const next = (phase: string) => this.sql.exec("UPDATE reveal_recovery_migration SET phase=?,cursor='',row_key=NULL,offset=0 WHERE id=1", phase);
      while (processed < Math.min(128, limit)) {
        const state = this.sql.exec<MigrationRow>('SELECT * FROM reveal_recovery_migration WHERE id=1').toArray()[0];
        if (state.phase === 'ready') break;
        if (state.phase === 'repair-watches') {
          const rows = this.sql.exec<{ hash: string }>('SELECT hash FROM receipt_work WHERE hash>? ORDER BY hash LIMIT ?',
            state.cursor, Math.min(128, limit) - processed).toArray();
          if (!rows.length) { next('repair-crates'); continue; }
          for (const row of rows) {
            this.sql.exec(`UPDATE receipt_work AS w SET opaque=1 WHERE hash=? AND resolved=0 AND ${UNSCOPED_REQUEST}`, row.hash);
            this.sql.exec('UPDATE reveal_recovery_migration SET cursor=? WHERE id=1', row.hash);
            processed++;
          }
          continue;
        }
        if (state.phase === 'repair-crates') {
          const rows = this.sql.exec<{ crate_token_id: string }>('SELECT crate_token_id FROM crate_recovery_jobs WHERE crate_token_id>? ORDER BY crate_token_id LIMIT ?',
            state.cursor, Math.min(128, limit) - processed).toArray();
          if (!rows.length) { next('repair-interests'); continue; }
          for (const row of rows) {
            this.rescheduleCrate(row.crate_token_id);
            this.sql.exec('UPDATE reveal_recovery_migration SET cursor=? WHERE id=1', row.crate_token_id);
            processed++;
          }
          continue;
        }
        if (state.phase === 'repair-interests') {
          const rows = this.sql.exec<{ rowid: number }>('SELECT rowid FROM receipt_token_interest WHERE rowid>? ORDER BY rowid LIMIT ?',
            Number(state.cursor || 0), Math.min(128, limit) - processed).toArray();
          if (!rows.length) {
            this.sql.exec('INSERT OR IGNORE INTO reveal_migrations(name) VALUES(?)', LIFECYCLE_REPAIR);
            next('ready');
            continue;
          }
          for (const row of rows) {
            this.sql.exec(`DELETE FROM receipt_token_interest WHERE rowid=? AND (
              NOT EXISTS(SELECT 1 FROM token_recovery t JOIN recovery_jobs j ON j.id=t.job_id
                WHERE t.token_id=receipt_token_interest.token_id AND t.status='recovering')
              OR EXISTS(SELECT 1 FROM assignments a WHERE a.token_id=receipt_token_interest.token_id))`, row.rowid);
            this.sql.exec('UPDATE reveal_recovery_migration SET cursor=? WHERE id=1', String(row.rowid));
            processed++;
          }
          continue;
        }
        if (state.phase === 'transactions') {
          const row = state.row_key ? this.sql.exec<LegacyTransaction>('SELECT * FROM transactions WHERE hash=?', state.row_key).toArray()[0]
            : this.sql.exec<LegacyTransaction>('SELECT * FROM transactions WHERE hash>? ORDER BY hash LIMIT 1', state.cursor).toArray()[0];
          if (!row) { next('candidates'); continue; }
          const crates = [...new Set([...array(row.crates_json), ...array(row.tokens_json).map(value =>
            value && typeof value === 'object' && 'crateTokenId' in value ? value.crateTokenId : null)].filter(validCrate))];
          if (state.offset === 0) {
            this.work(row.hash, now);
            let stableFailure = false;
            try {
              const failure = row.failure_json ? JSON.parse(row.failure_json) as { confirmations?: number; source?: string } : null;
              stableFailure = (row.status === 'reverted' || row.status === 'not_unpack') &&
                (Number(failure?.confirmations) >= 64 || failure?.source === 'input' || row.status === 'not_unpack' && row.dormant === 1 && !row.receipt_seen);
            } catch {}
            const unresolved = !crates.length && row.requested_all && row.status !== 'revealed' && !stableFailure;
            this.sql.exec(`UPDATE receipt_work SET requested_all=MAX(requested_all,?),observed=MAX(observed,?),
              opaque=MAX(opaque,?),active_until_ms=MAX(active_until_ms,?),legacy_pending=?,created_at_ms=MIN(created_at_ms,?),
              resolved=CASE WHEN ? THEN 1 ELSE resolved END WHERE hash=?`,
            row.requested_all, row.receipt_seen || row.status === 'revealed' ? 1 : 0,
            unresolved ? 1 : 0, row.last_requested_at_ms + ACTIVE_MS, unresolved ? 1 : 0, row.created_at_ms, stableFailure ? 1 : 0, row.hash);
          } else {
            const crate = crates[state.offset - 1];
            this.ensureCrate(crate, this.fromBlock(), now, row.last_requested_at_ms + ACTIVE_MS);
            this.candidate(crate, row.hash, now);
          }
          processed++;
          if (state.offset >= crates.length) this.sql.exec('UPDATE reveal_recovery_migration SET cursor=?,row_key=NULL,offset=0 WHERE id=1', row.hash);
          else this.sql.exec('UPDATE reveal_recovery_migration SET row_key=?,offset=? WHERE id=1', row.hash, state.offset + 1);
          continue;
        }
        if (state.phase === 'candidates' || state.phase === 'observations') {
          const table = state.phase === 'candidates' ? 'replacement_candidates' : 'observations';
          const cost = state.phase === 'candidates' ? 2 : 1;
          const available = Math.floor((Math.min(128, limit) - processed) / cost);
          if (!available) break;
          const rows = this.sql.exec<{ rowid: number; original_hash?: string; transaction_hash: string; crate_token_id: string; block_hash?: string } & Record<string, string | number | null | ArrayBuffer>>(
            `SELECT rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`, Number(state.cursor || 0), available).toArray();
          if (!rows.length) { next(state.phase === 'candidates' ? 'observations' : 'chunks'); continue; }
          for (const row of rows) {
            if (validCrate(row.crate_token_id)) {
              this.ensureCrate(row.crate_token_id, this.fromBlock(), now);
              this.candidate(row.crate_token_id, row.transaction_hash, now, typeof row.block_hash === 'string' ? row.block_hash : undefined);
              if (typeof row.original_hash === 'string') this.candidate(row.crate_token_id, row.original_hash, now);
            }
            processed += cost;
            this.sql.exec('UPDATE reveal_recovery_migration SET cursor=? WHERE id=1', String(row.rowid));
          }
          continue;
        }
        if (state.phase === 'chunks') {
          const row = state.row_key ? this.sql.exec<{ rowid: number; original_hash: string; crate_ids_json: string }>('SELECT rowid,* FROM replacement_chunks WHERE rowid=?', Number(state.row_key)).toArray()[0]
            : this.sql.exec<{ rowid: number; original_hash: string; crate_ids_json: string }>('SELECT rowid,* FROM replacement_chunks WHERE rowid>? ORDER BY rowid LIMIT 1', Number(state.cursor || 0)).toArray()[0];
          if (!row) { next('crates'); continue; }
          const crates = array(row.crate_ids_json).filter(validCrate);
          const crate = crates[state.offset];
          if (crate) { this.ensureCrate(crate, this.fromBlock(), now); this.candidate(crate, row.original_hash, now); }
          processed++;
          if (state.offset + 1 >= crates.length) this.sql.exec('UPDATE reveal_recovery_migration SET cursor=?,row_key=NULL,offset=0 WHERE id=1', String(row.rowid));
          else this.sql.exec('UPDATE reveal_recovery_migration SET row_key=?,offset=? WHERE id=1', String(row.rowid), state.offset + 1);
          continue;
        }
        if (state.phase === 'crates') {
          const rows = this.sql.exec<{ sequence: number; crate_token_id: string }>('SELECT * FROM crates WHERE sequence>? ORDER BY sequence LIMIT ?', Number(state.cursor || 0), Math.min(128, limit) - processed).toArray();
          if (!rows.length) { next('provenance'); continue; }
          for (const row of rows) {
            this.ensureCrate(row.crate_token_id, this.fromBlock(), now);
            this.sql.exec('UPDATE reveal_recovery_migration SET cursor=? WHERE id=1', String(row.sequence));
            processed++;
          }
          continue;
        }
        const rows = this.sql.exec<{ rowid: number; token_id: string; transaction_hash: string }>(`SELECT p.rowid,p.token_id,p.transaction_hash FROM provenance p
          JOIN token_recovery r ON r.token_id=p.token_id WHERE p.rowid>? AND r.status='recovering'
          ORDER BY p.rowid LIMIT ?`, Number(state.cursor || 0), Math.min(128, limit) - processed).toArray();
        if (!rows.length) { next('repair-watches'); continue; }
        for (const row of rows) {
          if (!this.hooks.frozen([row.token_id]).length) {
            this.work(row.transaction_hash, now);
            this.sql.exec('INSERT OR IGNORE INTO receipt_token_interest(hash,token_id) VALUES(?,?)', row.transaction_hash, row.token_id);
            this.sql.exec('UPDATE receipt_work SET observed=1 WHERE hash=?', row.transaction_hash);
          }
          this.sql.exec('UPDATE reveal_recovery_migration SET cursor=? WHERE id=1', String(row.rowid));
          processed++;
        }
      }
      return { ready: this.migrationReady(), processed };
    });
  }

  knownTransaction(hash: string): boolean {
    return !!this.sql.exec<{ requested_all: number }>('SELECT requested_all FROM transactions WHERE hash=?', hash).toArray()[0]?.requested_all;
  }

  admitTransaction(hash: string, fromBlock: number, now: number): 'accepted' | 'capacity' {
    return this.atomic(() => {
      const existing = this.sql.exec<ReceiptRow>('SELECT * FROM receipt_work WHERE hash=?', hash).toArray()[0];
      const historical = this.sql.exec<LegacyTransaction>('SELECT * FROM transactions WHERE hash=?', hash).toArray()[0];
      const associated = this.sql.exec<{ crate_token_id: string }>('SELECT crate_token_id FROM crate_candidates WHERE hash=?', hash).toArray();
      const crates = [...new Set([...(historical ? array(historical.crates_json).filter(validCrate) : []),
        ...associated.map(row => row.crate_token_id)])];
      const opaque = !crates.length;
      const counted = existing?.opaque === 1 && existing.resolved === 0 ||
        existing?.requested_all === 1 && existing.resolved === 0 && opaque && !this.migrationReady() ||
        !existing && historical?.requested_all === 1 && !this.migrationReady();
      if (opaque && !counted && this.opaqueCount() >= OPAQUE_LIMIT) return 'capacity';
      this.history(hash, fromBlock, true);
      this.work(hash, now);
      this.sql.exec(`UPDATE receipt_work SET requested_all=1,opaque=?,resolved=0,request_pending=1,
        active_until_ms=MAX(active_until_ms,?),next_check_ms=MIN(next_check_ms,MAX(?,last_checked_ms+?)) WHERE hash=?`,
      opaque ? 1 : 0, now + ACTIVE_MS, now, COOLDOWN_MS, hash);
      this.sql.exec('UPDATE transactions SET requested_all=1,last_requested_at_ms=? WHERE hash=?', now, hash);
      for (const crate of crates) {
        this.ensureCrate(crate, this.fromBlock(), now, now + ACTIVE_MS);
        this.candidate(crate, hash, now);
        this.sql.exec(`UPDATE crate_candidates SET next_check_ms=MIN(next_check_ms,MAX(?,last_checked_ms+?)) WHERE crate_token_id=? AND hash=?`, now, COOLDOWN_MS, crate, hash);
        this.sql.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=MIN(receipt_due_ms,?),scan_due_ms=CASE WHEN mode=\'recovering\' THEN MIN(COALESCE(scan_due_ms,?),MAX(?,scan_served_ms+?)) ELSE scan_due_ms END WHERE crate_token_id=?', now, now, now, COOLDOWN_MS, crate);
      }
      return 'accepted';
    });
  }

  opaqueCount(): number {
    const migrating = !this.migrationReady();
    const current = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM receipt_work w WHERE resolved=0
      AND (opaque=1${migrating ? ` OR (${UNSCOPED_REQUEST})` : ''})`).toArray()[0].count;
    if (!migrating) return current;
    const legacy = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM transactions t
      WHERE t.requested_all=1 AND t.crates_json='[]' AND NOT EXISTS(SELECT 1 FROM receipt_work w WHERE w.hash=t.hash)`).toArray()[0].count;
    return current + legacy;
  }

  knownTokens(tokenIds: string[], now: number): boolean {
    const known = new Set(this.hooks.frozen(tokenIds).map(row => row.tokenId));
    for (let offset = 0; offset < tokenIds.length; offset += 100) {
      const ids = tokenIds.slice(offset, offset + 100);
      for (const row of this.sql.exec<{ token_id: string; status: string; checked_at_ms: number }>(
        `SELECT token_id,status,checked_at_ms FROM token_recovery WHERE token_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray()) {
        if (row.status === 'recovering' || now - row.checked_at_ms < COOLDOWN_MS) known.add(row.token_id);
      }
    }
    return tokenIds.every(id => known.has(id));
  }

  admitTokens(tokenIds: string[], fromBlock: number, now: number): void {
    this.atomic(() => {
      const frozen = new Set(this.hooks.frozen(tokenIds).map(row => row.tokenId));
      const existing = new Map<string, { job_id: string | null; checked_at_ms: number; status: string }>();
      for (let offset = 0; offset < tokenIds.length; offset += 100) {
        const ids = tokenIds.slice(offset, offset + 100);
        for (const row of this.sql.exec<{ token_id: string; job_id: string | null; checked_at_ms: number; status: string }>(
          `SELECT * FROM token_recovery WHERE token_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray()) existing.set(row.token_id, row);
      }
      const missing = tokenIds.filter(id => !frozen.has(id) && (!existing.has(id) || !existing.get(id)!.job_id && now - existing.get(id)!.checked_at_ms >= COOLDOWN_MS));
      for (let offset = 0; offset < missing.length; offset += 100) {
        const ids = missing.slice(offset, offset + 100), id = crypto.randomUUID();
        this.sql.exec('INSERT INTO recovery_jobs(id,token_ids_json,ranges_json,active_until_ms) VALUES(?,?,?,?)', id, JSON.stringify(ids), JSON.stringify([{ fromBlock }]), now + ACTIVE_MS);
        for (const token of ids) this.sql.exec(`INSERT INTO token_recovery(token_id,job_id,status,checked_at_ms) VALUES(?,?,'recovering',?)
          ON CONFLICT(token_id) DO UPDATE SET job_id=excluded.job_id,status='recovering',checked_at_ms=excluded.checked_at_ms`, token, id, now);
      }
      for (const id of new Set([...existing.values()].flatMap(row => row.job_id ? [row.job_id] : []))) {
        this.sql.exec('UPDATE recovery_jobs SET active_until_ms=MAX(active_until_ms,?),next_check_ms=MIN(next_check_ms,MAX(?,served_ms+?)) WHERE id=?', now + ACTIVE_MS, now, COOLDOWN_MS, id);
      }
      for (let offset = 0; offset < tokenIds.length; offset += 100) {
        const ids = tokenIds.slice(offset, offset + 100);
        this.sql.exec(`UPDATE receipt_work SET active_until_ms=MAX(active_until_ms,?),next_check_ms=MIN(next_check_ms,MAX(?,last_checked_ms+?))
          WHERE hash IN (SELECT transaction_hash FROM provenance WHERE token_id IN (${ids.map(() => '?').join(',')}))`, now + ACTIVE_MS, now, COOLDOWN_MS, ...ids);
      }
    });
  }

  tokensResponse(deployment: EthereumRevealDeployment, tokenIds: string[]): EthereumRevealTokensResponse {
    const artworks = this.hooks.frozen(tokenIds), found = new Set(artworks.map(row => row.tokenId));
    const statuses = new Map<string, string>();
    for (let offset = 0; offset < tokenIds.length; offset += 100) {
      const ids = tokenIds.slice(offset, offset + 100);
      for (const row of this.sql.exec<{ token_id: string; status: string }>(`SELECT token_id,status FROM token_recovery
        WHERE token_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray()) statuses.set(row.token_id, row.status);
    }
    const unresolved = tokenIds.filter(id => !found.has(id)).map(tokenId => ({ tokenId, status: statuses.get(tokenId) === 'unminted' ? 'unminted' as const : 'recovering' as const }));
    return { deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
      contractAddress: deployment.contractAddress, artworks, unresolved, retryAfterMs: unresolved.some(row => row.status === 'recovering') ? COOLDOWN_MS : 0 };
  }

  dispatchState(now: number): RevealDispatchState {
    return this.atomic(() => {
      this.sql.exec('DELETE FROM reveal_overflow_claims WHERE lease_until_ms<=?', now);
      const control = this.sql.exec<DispatchRow>('SELECT * FROM reveal_dispatch_control WHERE id=1').toArray()[0];
      if (control.concurrency_limit < RECEIPT_CONCURRENCY && control.recovery_at_ms > 0 && now >= control.recovery_at_ms) {
        const intervals = Math.floor((now - control.recovery_at_ms) / CONCURRENCY_RECOVERY_MS) + 1;
        control.concurrency_limit = Math.min(RECEIPT_CONCURRENCY, control.concurrency_limit + intervals * 4);
        control.recovery_at_ms = control.concurrency_limit === RECEIPT_CONCURRENCY ? 0
          : control.recovery_at_ms + intervals * CONCURRENCY_RECOVERY_MS;
        this.sql.exec('UPDATE reveal_dispatch_control SET concurrency_limit=?,recovery_at_ms=? WHERE id=1',
          control.concurrency_limit, control.recovery_at_ms);
      }
      const running = this.sql.exec<{ in_flight: number; active: number; earliest: number | null }>(`SELECT COUNT(*) AS in_flight,
        COALESCE(SUM(active),0) AS active,MIN(lease_until_ms) AS earliest FROM (
          SELECT claim_active AS active,lease_until_ms FROM receipt_work WHERE claim_id IS NOT NULL AND lease_until_ms>?
          UNION ALL SELECT 1 AS active,lease_until_ms FROM reveal_overflow_claims)`, now).toArray()[0];
      return { limit: control.concurrency_limit, inFlight: running.in_flight, active: running.active,
        background: running.in_flight - running.active, pauseUntilMs: control.pause_until_ms,
        nextRecoveryMs: control.recovery_at_ms || null, earliestLeaseUntilMs: running.earliest };
    });
  }

  recordThrottle(now: number, retryAfterMs: number): void {
    this.atomic(() => {
      const state = this.dispatchState(now);
      const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.max(1_000, Math.ceil(retryAfterMs)) : COOLDOWN_MS;
      const pauseUntilMs = Math.max(state.pauseUntilMs, Math.min(8_640_000_000_000_000 - CONCURRENCY_RECOVERY_MS, now + delay));
      const limit = state.pauseUntilMs > now ? state.limit : Math.max(RECEIPT_MIN_CONCURRENCY, Math.floor(state.limit / 2));
      this.sql.exec('UPDATE reveal_dispatch_control SET concurrency_limit=?,pause_until_ms=?,recovery_at_ms=? WHERE id=1',
        limit, pauseUntilMs, pauseUntilMs + CONCURRENCY_RECOVERY_MS);
    });
  }

  claimOverflow(hash: string, now: number, deadlineMs: number): RevealReceiptClaim | null {
    if (!this.migrationReady() || !Number.isFinite(deadlineMs) || deadlineMs <= now) return null;
    return this.atomic(() => {
      const state = this.dispatchState(now);
      if (state.pauseUntilMs > now || state.inFlight >= state.limit ||
        this.sql.exec('SELECT 1 FROM receipt_work WHERE hash=? AND claim_id IS NOT NULL AND lease_until_ms>?', hash, now).toArray().length ||
        this.sql.exec('SELECT 1 FROM reveal_overflow_claims WHERE hash=?', hash).toArray().length) return null;
      const claim = { hash, claimId: crypto.randomUUID(), startedAtMs: now,
        leaseUntilMs: Math.min(now + RECEIPT_LEASE_MS, deadlineMs), active: true };
      this.sql.exec('INSERT INTO reveal_overflow_claims(hash,claim_id,started_at_ms,lease_until_ms) VALUES(?,?,?,?)',
        claim.hash, claim.claimId, claim.startedAtMs, claim.leaseUntilMs);
      return claim;
    });
  }

  validOverflow(claim: RevealReceiptClaim, now: number): boolean {
    return this.sql.exec('SELECT 1 FROM reveal_overflow_claims WHERE hash=? AND claim_id=? AND lease_until_ms>?',
      claim.hash, claim.claimId, now).toArray().length > 0;
  }

  releaseOverflow(claim: RevealReceiptClaim): boolean {
    return this.sql.exec('DELETE FROM reveal_overflow_claims WHERE hash=? AND claim_id=? RETURNING hash',
      claim.hash, claim.claimId).toArray().length > 0;
  }

  claimReceipt(now: number, lane: RevealWorkLane, preferredHash?: string, excludeHashes: string[] = []): RevealReceiptClaim | null {
    if (!this.migrationReady() || preferredHash && excludeHashes.includes(preferredHash)) return null;
    return this.atomic(() => {
      const state = this.dispatchState(now);
      if (state.pauseUntilMs > now || state.inFlight >= state.limit) return null;
      const laneSql = lane === 'active' ? '>?' : '<=?';
      const hashFilter = ` AND NOT EXISTS(SELECT 1 FROM reveal_overflow_claims o WHERE o.hash=w.hash)${preferredHash ? ' AND w.hash=?' : ''}${excludeHashes.length ? ` AND w.hash NOT IN (${excludeHashes.map(() => '?').join(',')})` : ''}`;
      const hashBindings = [...(preferredHash ? [preferredHash] : []), ...excludeHashes];
      const choices: Array<{ hash: string; served: number }> = [];
      const opaque = this.sql.exec<{ hash: string; served: number }>(`SELECT w.hash,w.last_checked_ms AS served FROM receipt_work w
        WHERE w.resolved=0 AND (w.opaque=1 OR w.request_pending=1 OR EXISTS(SELECT 1 FROM receipt_token_interest i WHERE i.hash=w.hash))
        AND w.active_until_ms${laneSql} AND w.next_check_ms<=? AND w.lease_until_ms<=?
        AND (w.attempts=0 OR w.last_checked_ms<=?)${hashFilter} ORDER BY w.last_checked_ms,w.next_check_ms,w.hash LIMIT 1`,
      now, now, now, now - COOLDOWN_MS, ...hashBindings).toArray()[0];
      if (opaque) choices.push(opaque);
      const crate = this.sql.exec<{ crate_token_id: string; served: number }>(`SELECT j.crate_token_id,j.receipt_served_ms AS served FROM crate_recovery_jobs j
        WHERE j.active_until_ms${laneSql} AND j.receipt_due_ms<=? AND EXISTS(
          SELECT 1 FROM crate_candidates c JOIN receipt_work w ON w.hash=c.hash WHERE c.crate_token_id=j.crate_token_id
          AND c.next_check_ms<=? AND w.lease_until_ms<=? AND (w.resolved=0 OR c.evidence_version>c.checked_version) AND (w.attempts=0 OR w.last_checked_ms<=?)
          AND ${ELIGIBLE_CANDIDATE}${hashFilter})
        ORDER BY j.receipt_served_ms,j.receipt_due_ms,j.crate_token_id LIMIT 1`, now, now, now, now, now - COOLDOWN_MS, ...hashBindings).toArray()[0];
      if (crate) {
        const candidate = this.sql.exec<{ hash: string }>(`SELECT c.hash FROM crate_candidates c JOIN receipt_work w ON w.hash=c.hash
          JOIN crate_recovery_jobs j ON j.crate_token_id=c.crate_token_id WHERE c.crate_token_id=? AND c.next_check_ms<=?
          AND w.lease_until_ms<=? AND (w.resolved=0 OR c.evidence_version>c.checked_version) AND (w.attempts=0 OR w.last_checked_ms<=?) AND ${ELIGIBLE_CANDIDATE}${hashFilter}
          ORDER BY (c.evidence_version>c.checked_version) DESC,c.last_checked_ms,c.hash LIMIT 1`, crate.crate_token_id, now, now, now - COOLDOWN_MS, ...hashBindings).toArray()[0];
        if (candidate) choices.push({ hash: candidate.hash, served: crate.served });
      }
      const hash = choices.sort((a, b) => a.served - b.served || a.hash.localeCompare(b.hash))[0]?.hash;
      if (!hash) return null;
      const claimId = crypto.randomUUID(), leaseUntilMs = now + RECEIPT_LEASE_MS;
      this.sql.exec('DELETE FROM receipt_claim_crates WHERE hash=?', hash);
      this.sql.exec('DELETE FROM receipt_claim_tokens WHERE hash=?', hash);
      this.sql.exec(`INSERT INTO receipt_claim_crates(hash,claim_id,crate_token_id,evidence_version,generation)
        SELECT ?,?,c.crate_token_id,c.evidence_version,j.generation FROM crate_candidates c JOIN crate_recovery_jobs j ON j.crate_token_id=c.crate_token_id WHERE c.hash=?`, hash, claimId, hash);
      this.sql.exec('INSERT INTO receipt_claim_tokens(hash,claim_id,token_id) SELECT ?,?,token_id FROM receipt_token_interest WHERE hash=?', hash, claimId, hash);
      this.sql.exec('UPDATE receipt_work SET claim_id=?,lease_until_ms=?,claim_active=?,last_checked_ms=?,request_pending=0,resolved=0,attempts=attempts+1 WHERE hash=?',
        claimId, leaseUntilMs, lane === 'active' ? 1 : 0, now, hash);
      this.sql.exec('UPDATE crate_candidates SET last_checked_ms=?,attempts=attempts+1 WHERE hash=?', now, hash);
      this.sql.exec(`UPDATE crate_recovery_jobs SET receipt_due_ms=?,receipt_served_ms=? WHERE crate_token_id IN
        (SELECT crate_token_id FROM receipt_claim_crates WHERE hash=? AND claim_id=?)`, leaseUntilMs, now, hash, claimId);
      return { hash, claimId, startedAtMs: now, leaseUntilMs, active: lane === 'active' };
    });
  }

  private validReceipt(claim: RevealReceiptClaim, now: number): ReceiptRow | undefined {
    return this.sql.exec<ReceiptRow>('SELECT * FROM receipt_work WHERE hash=? AND claim_id=? AND lease_until_ms>?', claim.hash, claim.claimId, now).toArray()[0];
  }

  validReceiptClaim(claim: RevealReceiptClaim, now: number): boolean { return !!this.validReceipt(claim, now); }

  recordReceiptPresence(claim: RevealReceiptClaim, now: number): boolean {
    return this.sql.exec<{ hash: string }>('UPDATE receipt_work SET observed=1,legacy_pending=0 WHERE hash=? AND claim_id=? AND lease_until_ms>? RETURNING hash', claim.hash, claim.claimId, now).toArray().length > 0;
  }

  private releaseReceipt(claim: RevealReceiptClaim, next: number): void {
    this.sql.exec('UPDATE receipt_work SET claim_id=NULL,lease_until_ms=0,claim_active=0,next_check_ms=?,legacy_pending=0 WHERE hash=? AND claim_id=?', next, claim.hash, claim.claimId);
    const crates = this.sql.exec<{ crate_token_id: string }>('SELECT crate_token_id FROM crate_candidates WHERE hash=?', claim.hash).toArray();
    this.sql.exec('DELETE FROM receipt_claim_crates WHERE hash=? AND claim_id=?', claim.hash, claim.claimId);
    this.sql.exec('DELETE FROM receipt_claim_tokens WHERE hash=? AND claim_id=?', claim.hash, claim.claimId);
    this.sql.exec(`DELETE FROM receipt_token_interest WHERE hash=? AND EXISTS(SELECT 1 FROM assignments a
      WHERE a.token_id=receipt_token_interest.token_id)`, claim.hash);
    for (const crate of crates) this.rescheduleCrate(crate.crate_token_id);
  }

  seedConfirmed(deployment: EthereumRevealDeployment, observation: EthereumRevealObservation, crates: RevealCrate[], now: number, confirmations = 1): void {
    const work = this.work(observation.transactionHash, now);
    this.sql.exec('UPDATE receipt_work SET observed=1,opaque=0,resolved=0 WHERE hash=?', observation.transactionHash);
    for (const crate of crates) {
      this.ensureCrate(crate.crateTokenId, deployment.deploymentBlock, now, work.active_until_ms);
      this.candidate(crate.crateTokenId, observation.transactionHash, now, observation.blockHash);
      this.sql.exec(`UPDATE crate_recovery_jobs SET mode='observed',observed_hash=?,receipt_due_ms=?,scan_due_ms=NULL,
        generation=generation+1,scan_claim_id=NULL,scan_lease_until_ms=0,scan_attempts=0,updated_at_ms=? WHERE crate_token_id=?`,
      observation.transactionHash, now + (confirmations >= 64 ? DAY_MS : 15_000), now, crate.crateTokenId);
      this.sql.exec('UPDATE crate_candidates SET checked_version=evidence_version,next_check_ms=?,attempts=0 WHERE crate_token_id=? AND hash=?',
        now + (confirmations >= 64 ? DAY_MS : 15_000), crate.crateTokenId, observation.transactionHash);
      this.rescheduleCrate(crate.crateTokenId);
    }
  }

  private canUpdateCrate(current: CrateRow | undefined, snapshot: CrateReceiptSnapshot | undefined,
    candidate: { evidence_version: number } | undefined, startedAtMs: number): boolean {
    return !current || (snapshot
      ? snapshot.generation === current.generation && (!candidate || candidate.evidence_version <= snapshot.evidence_version)
      : current.updated_at_ms < startedAtMs);
  }

  completeReceipt(deployment: EthereumRevealDeployment, claim: RevealReceiptClaim, result: EthereumRevealTransactionInspection, now: number): boolean {
    return this.atomic(() => {
      const work = this.validReceipt(claim, now);
      if (!work) return false;
      const snapshots = this.sql.exec<CrateReceiptSnapshot>('SELECT crate_token_id,generation,evidence_version FROM receipt_claim_crates WHERE hash=? AND claim_id=?', claim.hash, claim.claimId).toArray();
      const terminal = result.status !== 'pending' && result.status !== 'confirmed' &&
        (result.source === 'input' || result.confirmations >= 64);
      if (result.status === 'confirmed' || terminal) {
        for (const snapshot of snapshots) this.sql.exec('UPDATE crate_candidates SET checked_version=MAX(checked_version,?) WHERE crate_token_id=? AND hash=?',
          snapshot.evidence_version, snapshot.crate_token_id, claim.hash);
      }
      const selected = new Set(snapshots.map(row => row.crate_token_id));
      const tokens = new Set(this.sql.exec<{ token_id: string }>(`SELECT c.token_id FROM receipt_claim_tokens c
        JOIN receipt_token_interest i ON i.hash=c.hash AND i.token_id=c.token_id
        JOIN token_recovery t ON t.token_id=c.token_id JOIN recovery_jobs j ON j.id=t.job_id
        WHERE c.hash=? AND c.claim_id=? AND t.status='recovering'
        AND NOT EXISTS(SELECT 1 FROM assignments a WHERE a.token_id=c.token_id)`, claim.hash, claim.claimId).toArray().map(row => row.token_id));
      const activeUntil = Math.max(work.active_until_ms, this.sql.exec<{ until: number | null }>(`SELECT MAX(j.active_until_ms) AS until
        FROM receipt_claim_crates c JOIN crate_recovery_jobs j ON j.crate_token_id=c.crate_token_id WHERE c.hash=? AND c.claim_id=?`, claim.hash, claim.claimId).toArray()[0]?.until ?? 0);
      const delay = result.status !== 'pending' && result.status !== 'confirmed' && result.source === 'receipt' && result.confirmations < 64
        ? 15_000 : activeUntil > now ? COOLDOWN_MS : quietDelay(work.attempts);
      this.sql.exec('UPDATE receipt_work SET result_json=? WHERE hash=?', JSON.stringify(result), claim.hash);
      if (result.status === 'confirmed') {
        const crates = work.requested_all ? result.crates : result.crates.filter(crate => selected.has(crate.crateTokenId) || crate.tokenIds.some(token => tokens.has(token)));
        if (crates.length) {
          this.hooks.freeze(deployment, result.observation, crates, now, crates.length === result.crates.length);
          for (const crate of crates) {
            const current = this.sql.exec<CrateRow>('SELECT * FROM crate_recovery_jobs WHERE crate_token_id=?', crate.crateTokenId).toArray()[0];
            const snapshot = snapshots.find(row => row.crate_token_id === crate.crateTokenId);
            const candidate = this.sql.exec<{ evidence_version: number }>('SELECT evidence_version FROM crate_candidates WHERE crate_token_id=? AND hash=?', crate.crateTokenId, claim.hash).toArray()[0];
            if (this.canUpdateCrate(current, snapshot, candidate, claim.startedAtMs)) {
              this.seedConfirmed(deployment, result.observation, [crate], now, result.confirmations);
            } else {
              if (!candidate || snapshot && candidate.evidence_version <= snapshot.evidence_version) {
                this.candidate(crate.crateTokenId, claim.hash, now, result.observation.blockHash);
              }
              this.rescheduleCrate(crate.crateTokenId);
            }
          }
        }
        this.sql.exec('UPDATE receipt_work SET observed=1,opaque=0,resolved=0 WHERE hash=?', claim.hash);
        for (const snapshot of snapshots.filter(row => !crates.some(crate => crate.crateTokenId === row.crate_token_id))) this.settleCandidate(claim.hash, snapshot, now, delay);
        this.releaseReceipt(claim, now + COOLDOWN_MS);
        return true;
      }
      if (result.status === 'pending') {
        this.sql.exec("UPDATE transactions SET status=CASE WHEN status='revealed' THEN status ELSE 'pending' END WHERE hash=?", claim.hash);
        this.sql.exec('UPDATE receipt_work SET resolved=0 WHERE hash=?', claim.hash);
        if (result.seen) this.recordReceiptPresence(claim, now);
        const pendingCrates = (result.crates ?? []).filter(crate => work.requested_all || selected.has(crate));
        if (pendingCrates.length) {
          const history = this.sql.exec<{ crates_json: string }>('SELECT crates_json FROM transactions WHERE hash=?', claim.hash).toArray()[0];
          const crates = [...new Set([...array(history.crates_json).filter(validCrate), ...pendingCrates])];
          this.sql.exec('UPDATE transactions SET crates_json=? WHERE hash=?', JSON.stringify(crates), claim.hash);
          this.sql.exec('UPDATE receipt_work SET opaque=0,observed=1 WHERE hash=?', claim.hash);
          for (const crate of pendingCrates) {
            const previous = this.sql.exec<CrateRow>('SELECT * FROM crate_recovery_jobs WHERE crate_token_id=?', crate).toArray()[0];
            const snapshot = snapshots.find(row => row.crate_token_id === crate);
            const candidate = this.sql.exec<{ evidence_version: number }>('SELECT evidence_version FROM crate_candidates WHERE crate_token_id=? AND hash=?', crate, claim.hash).toArray()[0];
            if (!this.canUpdateCrate(previous, snapshot, candidate, claim.startedAtMs)) {
              this.candidate(crate, claim.hash, now);
              if (work.requested_all) this.sql.exec('UPDATE receipt_work SET request_pending=1 WHERE hash=?', claim.hash);
              continue;
            }
            this.hooks.reserve([crate]);
            this.ensureCrate(crate, Math.max(deployment.deploymentBlock, (result.fromBlock ?? deployment.deploymentBlock) - 64), now, activeUntil);
            this.candidate(crate, claim.hash, now);
            const current = this.sql.exec<CrateRow>('SELECT * FROM crate_recovery_jobs WHERE crate_token_id=?', crate).toArray()[0];
            if (result.fromBlock !== undefined && result.fromBlock < current.from_block - 64) {
              this.sql.exec(`UPDATE crate_recovery_jobs SET from_block=?,ranges_json='[]',generation=generation+1,
                scan_claim_id=NULL,scan_lease_until_ms=0,scan_due_ms=?,receipt_due_ms=?,mode='recovering',updated_at_ms=? WHERE crate_token_id=?`,
              deployment.deploymentBlock, now, now + delay, now, crate);
            } else this.recoverCrate(crate, current.generation, now, delay);
          }
        } else if (!result.seen && !work.observed && work.opaque && now >= work.created_at_ms + UNKNOWN_MS) {
          this.releaseReceipt(claim, now);
          this.sql.exec('DELETE FROM receipt_work WHERE hash=?', claim.hash);
          if (!this.sql.exec('SELECT 1 AS found FROM replacement_candidates WHERE original_hash=? OR transaction_hash=? LIMIT 1', claim.hash, claim.hash).toArray().length) this.sql.exec('DELETE FROM transactions WHERE hash=?', claim.hash);
          return true;
        }
      } else {
        const receipt = result.source === 'receipt';
        this.sql.exec(`UPDATE transactions SET status=CASE WHEN status='revealed' THEN status ELSE ? END,
          receipt_seen=MAX(receipt_seen,?),failure_json=? WHERE hash=?`, result.status, receipt ? 1 : 0, receipt ? JSON.stringify(result) : null, claim.hash);
        if (receipt) this.recordReceiptPresence(claim, now);
        if (terminal) this.sql.exec('UPDATE receipt_work SET resolved=1,opaque=0 WHERE hash=?', claim.hash);
      }
      for (const snapshot of snapshots) this.settleCandidate(claim.hash, snapshot, now, delay);
      this.releaseReceipt(claim, now + delay);
      return true;
    });
  }

  private settleCandidate(hash: string, snapshot: CrateReceiptSnapshot, now: number, delay: number): void {
    const candidate = this.sql.exec<{ evidence_version: number }>('SELECT evidence_version FROM crate_candidates WHERE crate_token_id=? AND hash=?', snapshot.crate_token_id, hash).toArray()[0];
    const due = candidate && candidate.evidence_version > snapshot.evidence_version ? now : now + delay;
    this.recoverCrate(snapshot.crate_token_id, snapshot.generation, now, due - now, hash);
    this.sql.exec('UPDATE crate_candidates SET next_check_ms=? WHERE crate_token_id=? AND hash=?', due, snapshot.crate_token_id, hash);
  }

  private recoverCrate(crate: string, generation: number, now: number, delay: number, hash?: string): void {
    this.sql.exec(`UPDATE crate_recovery_jobs SET mode='recovering',receipt_due_ms=?,scan_due_ms=COALESCE(scan_due_ms,?),
      from_block=CASE WHEN mode='observed' THEN ? ELSE from_block END,
      ranges_json=CASE WHEN mode='observed' THEN '[]' ELSE ranges_json END,
      generation=generation+CASE WHEN mode='observed' THEN 1 ELSE 0 END,
      scan_claim_id=CASE WHEN mode='observed' THEN NULL ELSE scan_claim_id END,
      scan_lease_until_ms=CASE WHEN mode='observed' THEN 0 ELSE scan_lease_until_ms END,updated_at_ms=?
      WHERE crate_token_id=? AND generation=? AND (? IS NULL OR mode!='observed' OR observed_hash=?)`,
      now + delay, now, this.fromBlock(), now, crate, generation, hash ?? null, hash ?? null);
  }

  failReceipt(claim: RevealReceiptClaim, now: number): boolean {
    return this.atomic(() => {
      const work = this.validReceipt(claim, now);
      if (!work) return false;
      const delay = work.active_until_ms > now ? COOLDOWN_MS : quietDelay(work.attempts);
      for (const row of this.sql.exec<CrateReceiptSnapshot>('SELECT crate_token_id,generation,evidence_version FROM receipt_claim_crates WHERE hash=? AND claim_id=?', claim.hash, claim.claimId).toArray()) this.settleCandidate(claim.hash, row, now, delay);
      this.releaseReceipt(claim, now + delay);
      return true;
    });
  }

  acceptVerified(deployment: EthereumRevealDeployment, hash: string, result: EthereumRevealTransactionInspection, startedAtMs: number, now: number): boolean {
    if (result.status !== 'confirmed' && !(result.status === 'pending' && result.crates?.length)) return false;
    return this.atomic(() => {
      const existing = this.sql.exec<ReceiptRow>('SELECT * FROM receipt_work WHERE hash=?', hash).toArray()[0];
      if (existing && (existing.lease_until_ms > now || existing.last_checked_ms >= startedAtMs)) return false;
      this.history(hash, deployment.deploymentBlock, true);
      this.work(hash, now);
      this.sql.exec('UPDATE receipt_work SET requested_all=1,observed=1,opaque=0,active_until_ms=? WHERE hash=?', now + ACTIVE_MS, hash);
      const claimId = crypto.randomUUID();
      this.sql.exec('UPDATE receipt_work SET claim_id=?,lease_until_ms=?,claim_active=1,last_checked_ms=?,request_pending=0,attempts=attempts+1 WHERE hash=?',
        claimId, now + RECEIPT_LEASE_MS, startedAtMs, hash);
      return this.completeReceipt(deployment, { hash, claimId, startedAtMs, leaseUntilMs: now + RECEIPT_LEASE_MS, active: true }, result, now);
    });
  }

  claimScan(now: number, lane: RevealWorkLane, scope?: { tokenIds?: string[] }): RevealScanClaim | null {
    if (!this.migrationReady()) return null;
    return this.atomic(() => {
      if (this.dispatchState(now).pauseUntilMs > now) return null;
      const condition = lane === 'active' ? '>?' : '<=?';
      const tokenIds = scope?.tokenIds;
      const tokenFilter = tokenIds?.length ? ` AND EXISTS(SELECT 1 FROM token_recovery t WHERE t.job_id=r.id AND t.token_id IN (SELECT value FROM json_each(?)))` : '';
      const token = this.sql.exec<TokenJob>(`SELECT r.* FROM recovery_jobs r WHERE r.active_until_ms${condition}
        AND r.next_check_ms<=? AND r.lease_until_ms<=?${tokenFilter} ORDER BY r.served_ms,r.next_check_ms,r.id LIMIT 1`, now, now, now, ...(tokenIds?.length ? [JSON.stringify(tokenIds)] : [])).toArray()[0];
      const crate = tokenIds?.length ? undefined : this.sql.exec<CrateRow>(`SELECT * FROM crate_recovery_jobs WHERE active_until_ms${condition}
        AND scan_due_ms IS NOT NULL AND scan_due_ms<=? AND scan_lease_until_ms<=? ORDER BY scan_served_ms,scan_due_ms,crate_token_id LIMIT 1`, now, now, now).toArray()[0];
      const claimId = crypto.randomUUID(), leaseUntilMs = now + SCAN_LEASE_MS;
      if (token && (!crate || token.served_ms <= crate.scan_served_ms)) {
        const ids = array(token.token_ids_json).filter((id): id is string => typeof id === 'string');
        const frozen = new Set(this.hooks.frozen(ids).map(row => row.tokenId));
        const needed = ids.filter(id => !frozen.has(id));
        if (!needed.length) { this.sql.exec('DELETE FROM token_recovery WHERE job_id=?', token.id); this.sql.exec('DELETE FROM recovery_jobs WHERE id=?', token.id); return null; }
        const ranges = JSON.parse(token.ranges_json) as RevealSearchRange[];
        const range = ranges[0] ?? { fromBlock: this.fromBlock() };
        this.sql.exec('UPDATE recovery_jobs SET claim_id=?,lease_until_ms=?,claimed_generation=generation,served_ms=?,attempts=attempts+1 WHERE id=?', claimId, leaseUntilMs, now, token.id);
        return { kind: 'tokens', id: token.id, claimId, leaseUntilMs, active: token.active_until_ms > now, range, tokenIds: needed, crateTokenIds: [] };
      }
      if (!crate) return null;
      const ranges = JSON.parse(crate.ranges_json) as RevealSearchRange[];
      const range = ranges[0] ?? { fromBlock: Math.max(this.fromBlock(), crate.from_block - 64) };
      this.sql.exec('UPDATE crate_recovery_jobs SET scan_claim_id=?,scan_lease_until_ms=?,scan_claim_generation=generation,scan_served_ms=?,scan_attempts=scan_attempts+1 WHERE crate_token_id=?', claimId, leaseUntilMs, now, crate.crate_token_id);
      return { kind: 'crate', id: crate.crate_token_id, claimId, leaseUntilMs, active: crate.active_until_ms > now, range, tokenIds: [], crateTokenIds: [crate.crate_token_id] };
    });
  }

  completeCrateScan(claim: RevealScanClaim, result: EthereumRevealCrateRecovery, now: number): boolean {
    return this.atomic(() => {
      if (claim.kind !== 'crate') return false;
      const job = this.sql.exec<CrateRow>('SELECT * FROM crate_recovery_jobs WHERE crate_token_id=?', claim.id).toArray()[0];
      if (!job) return false;
      const current = job.scan_claim_id === claim.claimId && job.scan_lease_until_ms > now && job.scan_claim_generation === job.generation;
      let learned = false;
      for (const observation of result.provenance) if (observation.crateTokenIds.includes(claim.id)) {
        const previous = this.sql.exec<{ evidence_key: string | null }>('SELECT evidence_key FROM crate_candidates WHERE crate_token_id=? AND hash=?',
          claim.id, observation.transactionHash).toArray()[0];
        learned ||= previous?.evidence_key !== observation.blockHash;
        this.candidate(claim.id, observation.transactionHash, now, observation.blockHash);
      }
      if (learned) this.sql.exec('UPDATE crate_recovery_jobs SET generation=generation+1,updated_at_ms=? WHERE crate_token_id=?', now, claim.id);
      if (!current) return false;
      const oldRanges = JSON.parse(job.ranges_json) as RevealSearchRange[];
      const remaining = [...result.remainingRanges, ...oldRanges.slice(oldRanges.length ? 1 : 0)];
      const next = remaining.length ? now : now + (job.active_until_ms > now ? COOLDOWN_MS : quietDelay(job.scan_attempts));
      this.sql.exec(`UPDATE crate_recovery_jobs SET ranges_json=?,from_block=?,scan_due_ms=?,scan_served_ms=?,scan_claim_id=NULL,scan_lease_until_ms=0 WHERE crate_token_id=?`,
        JSON.stringify(remaining), Math.max(job.from_block, result.scannedRange?.toBlock ?? job.from_block), next, now, claim.id);
      return true;
    });
  }

  completeTokenScan(claim: RevealScanClaim, result: EthereumRevealTokenRecovery, now: number): boolean {
    return this.atomic(() => {
      if (claim.kind !== 'tokens') return false;
      const job = this.sql.exec<TokenJob>('SELECT * FROM recovery_jobs WHERE id=?', claim.id).toArray()[0];
      const current = job?.claim_id === claim.claimId && job.lease_until_ms > now && job.claimed_generation === job.generation;
      const admitted = new Set(this.sql.exec<{ token_id: string }>(`SELECT t.token_id FROM token_recovery t
        JOIN recovery_jobs j ON j.id=t.job_id WHERE t.status='recovering' AND t.token_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(claim.tokenIds)).toArray().map(row => row.token_id));
      const frozen = new Set(this.hooks.frozen(claim.tokenIds).map(row => row.tokenId));
      for (const observation of result.provenance) for (const token of observation.tokenIds) {
        if (!admitted.has(token) || frozen.has(token)) continue;
        this.work(observation.transactionHash, now);
        this.sql.exec('INSERT OR IGNORE INTO receipt_token_interest(hash,token_id) VALUES(?,?)', observation.transactionHash, token);
        if (current) this.sql.exec(`INSERT INTO provenance(token_id,transaction_hash,block_number,block_hash) VALUES(?,?,?,?)
          ON CONFLICT(token_id) DO UPDATE SET transaction_hash=excluded.transaction_hash,block_number=excluded.block_number,block_hash=excluded.block_hash`, token, observation.transactionHash, observation.blockNumber, observation.blockHash);
        this.sql.exec('UPDATE receipt_work SET observed=1,resolved=0,active_until_ms=MAX(active_until_ms,?),next_check_ms=MIN(next_check_ms,?) WHERE hash=?', job?.active_until_ms ?? 0, now, observation.transactionHash);
      }
      if (!current) return false;
      const unminted = claim.tokenIds.filter(token => !frozen.has(token) && Number(token) > result.mintedThrough);
      const remainingIds = claim.tokenIds.filter(token => !frozen.has(token) && Number(token) <= result.mintedThrough);
      for (const token of unminted) {
        const closed = this.sql.exec<{ token_id: string }>(`UPDATE token_recovery SET status='unminted',job_id=NULL,checked_at_ms=?
          WHERE token_id=? AND job_id=? RETURNING token_id`, now, token, job.id).toArray().length;
        if (closed) this.sql.exec('DELETE FROM receipt_token_interest WHERE token_id=?', token);
      }
      if (!remainingIds.length) { this.sql.exec('DELETE FROM token_recovery WHERE job_id=?', job.id); this.sql.exec('DELETE FROM recovery_jobs WHERE id=?', job.id); return true; }
      const oldRanges = JSON.parse(job.ranges_json) as RevealSearchRange[];
      const ranges = [...result.remainingRanges, ...oldRanges.slice(oldRanges.length ? 1 : 0)];
      this.sql.exec(`UPDATE recovery_jobs SET token_ids_json=?,ranges_json=?,claim_id=NULL,lease_until_ms=0,next_check_ms=?,served_ms=? WHERE id=?`,
        JSON.stringify(remainingIds), JSON.stringify(ranges.length ? ranges : [{ fromBlock: this.fromBlock() }]),
        ranges.length ? now : now + (job.active_until_ms > now ? COOLDOWN_MS : quietDelay(job.attempts)), now, job.id);
      return true;
    });
  }

  failScan(claim: RevealScanClaim, now: number): boolean {
    if (claim.kind === 'crate') {
      const job = this.sql.exec<CrateRow>('SELECT * FROM crate_recovery_jobs WHERE crate_token_id=? AND scan_claim_id=? AND scan_lease_until_ms>? AND scan_claim_generation=generation', claim.id, claim.claimId, now).toArray()[0];
      if (!job) return false;
      this.sql.exec('UPDATE crate_recovery_jobs SET scan_claim_id=NULL,scan_lease_until_ms=0,scan_due_ms=?,scan_served_ms=? WHERE crate_token_id=?', now + (job.active_until_ms > now ? COOLDOWN_MS : quietDelay(job.scan_attempts)), now, claim.id);
      return true;
    }
    const job = this.sql.exec<TokenJob>('SELECT * FROM recovery_jobs WHERE id=? AND claim_id=? AND lease_until_ms>? AND claimed_generation=generation', claim.id, claim.claimId, now).toArray()[0];
    if (!job) return false;
    this.sql.exec('UPDATE recovery_jobs SET claim_id=NULL,lease_until_ms=0,next_check_ms=?,served_ms=? WHERE id=?', now + (job.active_until_ms > now ? COOLDOWN_MS : quietDelay(job.attempts)), now, claim.id);
    return true;
  }

  private rescheduleCrate(crate: string): void {
    const due = this.sql.exec<{ due: number | null }>(`SELECT MIN(MAX(c.next_check_ms,w.lease_until_ms,
      CASE WHEN w.attempts>0 THEN w.last_checked_ms+2000 ELSE 0 END)) AS due FROM crate_candidates c
      JOIN receipt_work w ON w.hash=c.hash JOIN crate_recovery_jobs j ON j.crate_token_id=c.crate_token_id
      WHERE c.crate_token_id=? AND (w.resolved=0 OR c.evidence_version>c.checked_version)
      AND ${ELIGIBLE_CANDIDATE}`, crate).toArray()[0]?.due;
    this.sql.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=? WHERE crate_token_id=?', due ?? Number.MAX_SAFE_INTEGER, crate);
  }

  nextWake(now: number): number | null {
    if (!this.migrationReady()) return now + 250;
    const state = this.dispatchState(now);
    const receipt = this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT MIN(MAX(w.next_check_ms,w.lease_until_ms,CASE WHEN w.attempts>0 THEN w.last_checked_ms+2000 ELSE 0 END)) AS due
        FROM receipt_work w WHERE w.resolved=0 AND (w.opaque=1 OR w.request_pending=1 OR EXISTS(SELECT 1 FROM receipt_token_interest i WHERE i.hash=w.hash))
      UNION ALL SELECT MIN(receipt_due_ms) FROM crate_recovery_jobs WHERE receipt_due_ms<9007199254740991)`).toArray()[0]?.due;
    const scan = this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT MIN(MAX(scan_due_ms,scan_lease_until_ms)) AS due FROM crate_recovery_jobs WHERE scan_due_ms IS NOT NULL
      UNION ALL SELECT MIN(MAX(next_check_ms,lease_until_ms)) FROM recovery_jobs)`).toArray()[0];
    const overflow = this.sql.exec<{ due: number | null }>('SELECT MIN(lease_until_ms) AS due FROM reveal_overflow_claims').toArray()[0]?.due;
    const times: number[] = [];
    if (receipt != null) {
      const capacityAt = state.inFlight < state.limit ? now
        : Math.min(state.earliestLeaseUntilMs ?? Infinity, state.nextRecoveryMs ?? Infinity);
      times.push(Math.max(receipt, state.pauseUntilMs, capacityAt));
    }
    if (scan?.due != null) times.push(Math.max(scan.due, state.pauseUntilMs));
    if (overflow != null) times.push(overflow);
    return times.length ? Math.max(now + 250, Math.min(...times)) : null;
  }

  summary() {
    const now = Date.now();
    const migration = this.sql.exec<MigrationRow>('SELECT * FROM reveal_recovery_migration WHERE id=1').toArray()[0];
    const crates = this.sql.exec<{ mode: string; count: number }>('SELECT mode,COUNT(*) AS count FROM crate_recovery_jobs GROUP BY mode').toArray();
    const pending = this.sql.exec<{ active: number; receipt_jobs: number; scan_jobs: number; oldest: number | null }>(`SELECT active,
      SUM(receipt_jobs) AS receipt_jobs,SUM(scan_jobs) AS scan_jobs,MIN(oldest) AS oldest FROM (
      SELECT (active_until_ms>?) AS active,COUNT(*) AS receipt_jobs,0 AS scan_jobs,MIN(CASE WHEN receipt_due_ms>0 THEN receipt_due_ms ELSE ? END) AS oldest
        FROM crate_recovery_jobs WHERE receipt_due_ms<=? GROUP BY active
      UNION ALL SELECT (w.active_until_ms>?),COUNT(*),0,MIN(CASE WHEN w.next_check_ms>0 THEN w.next_check_ms ELSE w.created_at_ms END)
        FROM receipt_work w WHERE w.resolved=0 AND w.next_check_ms<=? AND (w.opaque=1 OR w.request_pending=1
          OR EXISTS(SELECT 1 FROM receipt_token_interest i WHERE i.hash=w.hash)) GROUP BY (w.active_until_ms>?)
      UNION ALL SELECT (active_until_ms>?),0,COUNT(*),MIN(scan_due_ms) FROM crate_recovery_jobs WHERE scan_due_ms<=? GROUP BY (active_until_ms>?)
      UNION ALL SELECT (active_until_ms>?),0,COUNT(*),MIN(CASE WHEN next_check_ms>0 THEN next_check_ms ELSE ? END)
        FROM recovery_jobs WHERE next_check_ms<=? GROUP BY (active_until_ms>?)) GROUP BY active`,
    now, now, now, now, now, now, now, now, now, now, now, now, now).toArray();
    const due = (active: number) => {
      const row = pending.find(value => value.active === active);
      return { receiptJobs: row?.receipt_jobs ?? 0, scanJobs: row?.scan_jobs ?? 0,
        oldestDueAgeMs: row?.oldest == null ? 0 : Math.max(0, now - row.oldest) };
    };
    const opaque = this.opaqueCount();
    return { migrationReady: migration.phase === 'ready', migration: { phase: migration.phase, cursor: migration.cursor,
      rowKey: migration.row_key, offset: migration.offset }, opaque, opaqueCapacity: { used: opaque, limit: OPAQUE_LIMIT,
      available: Math.max(0, OPAQUE_LIMIT - opaque) }, crates: Object.fromEntries(crates.map(row => [row.mode, row.count])),
      due: { active: due(1), background: due(0) }, dispatch: this.dispatchState(now) };
  }
}
