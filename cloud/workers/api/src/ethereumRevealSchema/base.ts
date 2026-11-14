import type { RevealSql } from '../ethereumRevealStore.js';
import { REVEAL_ENRICHMENT_SCHEMA } from './enrichment.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), deployment_json TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS reveal_migrations (name TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS pools (category TEXT PRIMARY KEY CHECK(category IN ('egg','painting','video','3d','animated')),
    total INTEGER NOT NULL, seeded INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 0,
    CHECK(available >= 0 AND available <= seeded AND seeded <= total))`,
  `CREATE TABLE IF NOT EXISTS free_slots (category TEXT NOT NULL, slot INTEGER NOT NULL, asset_id INTEGER NOT NULL,
    PRIMARY KEY(category,slot), UNIQUE(category,asset_id), FOREIGN KEY(category) REFERENCES pools(category))`,
  `CREATE TABLE IF NOT EXISTS crates (sequence INTEGER PRIMARY KEY AUTOINCREMENT, crate_token_id TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS assignments (category TEXT NOT NULL, asset_id INTEGER NOT NULL,
    crate_token_id TEXT NOT NULL, slot INTEGER NOT NULL, token_id TEXT UNIQUE, artwork_json TEXT,
    metadata_json TEXT, placeholder_json TEXT, frozen_at_ms INTEGER,
    PRIMARY KEY(category,asset_id), FOREIGN KEY(crate_token_id) REFERENCES crates(crate_token_id),
    CHECK((token_id IS NULL AND artwork_json IS NULL AND metadata_json IS NULL AND frozen_at_ms IS NULL) OR
      (token_id IS NOT NULL AND artwork_json IS NOT NULL AND metadata_json IS NOT NULL AND placeholder_json IS NOT NULL AND frozen_at_ms IS NOT NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS private_slot ON assignments(crate_token_id,slot) WHERE token_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS assignments_crate ON assignments(crate_token_id,token_id)`,
  `CREATE TRIGGER IF NOT EXISTS frozen_assignment_update BEFORE UPDATE ON assignments WHEN OLD.token_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot change'); END`,
  `CREATE TRIGGER IF NOT EXISTS frozen_assignment_delete BEFORE DELETE ON assignments WHEN OLD.token_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot be deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS assignment_not_free BEFORE INSERT ON assignments WHEN
    EXISTS(SELECT 1 FROM free_slots WHERE category=NEW.category AND asset_id=NEW.asset_id)
    BEGIN SELECT RAISE(ABORT,'Assigned reveal asset is still free'); END`,
  `CREATE TRIGGER IF NOT EXISTS free_not_assigned BEFORE INSERT ON free_slots WHEN
    EXISTS(SELECT 1 FROM assignments WHERE category=NEW.category AND asset_id=NEW.asset_id)
    BEGIN SELECT RAISE(ABORT,'Reveal asset is already assigned'); END`,
  `CREATE TRIGGER IF NOT EXISTS free_update_not_assigned BEFORE UPDATE ON free_slots WHEN
    EXISTS(SELECT 1 FROM assignments WHERE category=NEW.category AND asset_id=NEW.asset_id)
    BEGIN SELECT RAISE(ABORT,'Reveal asset is already assigned'); END`,
  `CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
    crates_json TEXT NOT NULL DEFAULT '[]', from_block INTEGER NOT NULL, next_check_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, observation_json TEXT, tokens_json TEXT NOT NULL DEFAULT '[]', revealed_all INTEGER NOT NULL DEFAULT 0,
    requested_all INTEGER NOT NULL DEFAULT 0, replacement_ranges_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL, last_requested_at_ms INTEGER NOT NULL, checked_at_ms INTEGER NOT NULL DEFAULT 0,
    lease_until_ms INTEGER NOT NULL DEFAULT 0, dormant INTEGER NOT NULL DEFAULT 0,
    tracking_generation INTEGER NOT NULL DEFAULT 0, receipt_seen INTEGER NOT NULL DEFAULT 0, failure_json TEXT,
    incarnation TEXT NOT NULL DEFAULT '', transient INTEGER NOT NULL DEFAULT 1, admission_expires_at_ms INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS transactions_active_due ON transactions(next_check_ms,hash) WHERE dormant=0`,
  `DROP INDEX IF EXISTS transactions_due`,
  `CREATE TABLE IF NOT EXISTS crate_recovery_trackers (crate_token_id TEXT PRIMARY KEY,
    transaction_hash TEXT NOT NULL REFERENCES transactions(hash))`,
  `CREATE INDEX IF NOT EXISTS crate_recovery_tracker_transaction ON crate_recovery_trackers(transaction_hash)`,
  `CREATE TABLE IF NOT EXISTS replacement_candidates (original_hash TEXT NOT NULL REFERENCES transactions(hash),
    transaction_hash TEXT NOT NULL, crate_token_id TEXT NOT NULL, checked_at_ms INTEGER NOT NULL DEFAULT 0,
    verified_at_ms INTEGER NOT NULL DEFAULT 0, discovered_at_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(original_hash,transaction_hash,crate_token_id))`,
  `CREATE INDEX IF NOT EXISTS replacement_candidate_transaction ON replacement_candidates(transaction_hash)`,
  `CREATE TABLE IF NOT EXISTS replacement_chunks (original_hash TEXT NOT NULL REFERENCES transactions(hash),
    chunk_index INTEGER NOT NULL, crate_ids_json TEXT NOT NULL, from_block INTEGER NOT NULL,
    ranges_json TEXT NOT NULL DEFAULT '[]', generation INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    checked_at_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(original_hash,chunk_index))`,
  `CREATE TABLE IF NOT EXISTS observations (transaction_hash TEXT NOT NULL, block_hash TEXT NOT NULL, crate_token_id TEXT NOT NULL,
    block_number INTEGER NOT NULL, token_ids_json TEXT NOT NULL, PRIMARY KEY(transaction_hash,block_hash,crate_token_id))`,
  `CREATE TABLE IF NOT EXISTS publication (token_id TEXT PRIMARY KEY REFERENCES assignments(token_id),
    status TEXT NOT NULL DEFAULT 'pending', next_check_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,claim_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS publication_due_numeric ON publication(status,next_check_ms,CAST(token_id AS INTEGER))`,
  `DROP INDEX IF EXISTS publication_due`,
  ...REVEAL_ENRICHMENT_SCHEMA,
  `CREATE TABLE IF NOT EXISTS recovery_jobs (id TEXT PRIMARY KEY, token_ids_json TEXT NOT NULL, ranges_json TEXT NOT NULL,
    next_check_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS recovery_due ON recovery_jobs(next_check_ms)`,
  `CREATE TABLE IF NOT EXISTS token_recovery (token_id TEXT PRIMARY KEY, job_id TEXT, status TEXT NOT NULL,
    checked_at_ms INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS provenance (token_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL, block_hash TEXT NOT NULL)`,
];

export function initializeRevealBaseSchemaV1(sql: RevealSql, transaction: <T>(action: () => T) => T): void {
  transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement);
    const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(transactions)').toArray().map(row => row.name));
    for (const [name, definition] of [['tracking_generation', 'INTEGER NOT NULL DEFAULT 0'],
      ['receipt_seen', 'INTEGER NOT NULL DEFAULT 0'], ['failure_json', 'TEXT'], ['incarnation', "TEXT NOT NULL DEFAULT ''"],
      ['transient', 'INTEGER NOT NULL DEFAULT 1'], ['admission_expires_at_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!columns.has(name)) sql.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${definition}`);
    }
    if (!sql.exec<{ name: string }>('PRAGMA table_info(publication)').toArray().some(row => row.name === 'claim_id')) {
      sql.exec('ALTER TABLE publication ADD COLUMN claim_id TEXT');
    }
  });
}
