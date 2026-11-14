import type { RevealSql } from '../ethereumRevealStore.js';

export const LIFECYCLE_REPAIR = 'reveal-recovery-lifecycle-v1';

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

export function initializeRevealRecoverySchemaV1(sql: RevealSql, transaction: <T>(action: () => T) => T): void {
  transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement);
    if (!sql.exec<{ name: string }>('PRAGMA table_info(receipt_work)').toArray().some(row => row.name === 'request_pending')) {
      sql.exec('ALTER TABLE receipt_work ADD COLUMN request_pending INTEGER NOT NULL DEFAULT 0');
    }
    if (!sql.exec<{ name: string }>('PRAGMA table_info(receipt_work)').toArray().some(row => row.name === 'claim_active')) {
      sql.exec('ALTER TABLE receipt_work ADD COLUMN claim_active INTEGER NOT NULL DEFAULT 0');
      sql.exec('UPDATE receipt_work SET claim_active=1 WHERE claim_id IS NOT NULL AND active_until_ms>last_checked_ms');
    }
    sql.exec(`CREATE INDEX IF NOT EXISTS receipt_live_claims ON receipt_work(lease_until_ms,claim_active)
        WHERE claim_id IS NOT NULL`);
    if (!sql.exec<{ name: string }>('PRAGMA table_info(crate_recovery_jobs)').toArray().some(row => row.name === 'updated_at_ms')) {
      sql.exec('ALTER TABLE crate_recovery_jobs ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0');
    }
    const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(recovery_jobs)').toArray().map(row => row.name));
    for (const [name, definition] of [['active_until_ms', 'INTEGER NOT NULL DEFAULT 0'], ['claim_id', 'TEXT'],
      ['lease_until_ms', 'INTEGER NOT NULL DEFAULT 0'], ['generation', 'INTEGER NOT NULL DEFAULT 0'],
      ['claimed_generation', 'INTEGER NOT NULL DEFAULT 0'], ['served_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!columns.has(name)) sql.exec(`ALTER TABLE recovery_jobs ADD COLUMN ${name} ${definition}`);
    }
    if (!sql.exec('SELECT id FROM reveal_recovery_migration WHERE id=1').toArray().length) {
      const legacy = sql.exec(`SELECT 1 AS found WHERE EXISTS(SELECT 1 FROM transactions) OR EXISTS(SELECT 1 FROM crates)
          OR EXISTS(SELECT 1 FROM recovery_jobs) OR EXISTS(SELECT 1 FROM replacement_candidates) OR EXISTS(SELECT 1 FROM observations)`).toArray().length;
      sql.exec('INSERT INTO reveal_recovery_migration(id,phase) VALUES(1,?)', legacy ? 'transactions' : 'ready');
      if (!legacy) sql.exec('INSERT OR IGNORE INTO reveal_migrations(name) VALUES(?)', LIFECYCLE_REPAIR);
    } else if (!sql.exec('SELECT 1 FROM reveal_migrations WHERE name=?', LIFECYCLE_REPAIR).toArray().length) {
      sql.exec("UPDATE reveal_recovery_migration SET phase='repair-watches',cursor='',row_key=NULL,offset=0 WHERE id=1 AND phase='ready'");
    }
  });
}
