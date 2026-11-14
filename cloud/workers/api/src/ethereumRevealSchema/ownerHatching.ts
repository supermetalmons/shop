import type { RevealSql } from '../ethereumRevealStore.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owner_hatching_batches (
    batch_id TEXT PRIMARY KEY,source_sha256 TEXT NOT NULL,input_sha256 TEXT NOT NULL,
    ready_count INTEGER NOT NULL CHECK(ready_count>0),grail_count INTEGER NOT NULL CHECK(grail_count>=0 AND grail_count<=ready_count),
    fresh_egg_count INTEGER NOT NULL CHECK(fresh_egg_count=ready_count-grail_count),created_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_grails (
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,batch_id TEXT NOT NULL REFERENCES owner_hatching_batches(batch_id),
    attributes_json TEXT,PRIMARY KEY(category,asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_tokens (
    token_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES owner_hatching_batches(batch_id),egg_id INTEGER NOT NULL UNIQUE,
    original_json TEXT NOT NULL,grail_category TEXT,grail_asset_id INTEGER,status TEXT NOT NULL CHECK(status IN ('ready','hatched')),
    canonical_json TEXT NOT NULL,metadata_revision INTEGER NOT NULL,hatched_at_ms INTEGER,
    CHECK((grail_category IS NULL)=(grail_asset_id IS NULL)),
    CHECK((status='hatched')=(hatched_at_ms IS NOT NULL)),
    FOREIGN KEY(grail_category,grail_asset_id) REFERENCES owner_hatching_grails(category,asset_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS owner_hatching_grail_token ON owner_hatching_tokens(grail_category,grail_asset_id)
    WHERE grail_asset_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_ready ON owner_hatching_tokens(status,CAST(token_id AS INTEGER))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_fresh_eggs (
    egg_id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES owner_hatching_batches(batch_id),
    token_id TEXT UNIQUE REFERENCES owner_hatching_tokens(token_id))`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_fresh_batch ON owner_hatching_fresh_eggs(batch_id,egg_id) WHERE token_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_retired_eggs (
    egg_id INTEGER PRIMARY KEY,token_id TEXT NOT NULL UNIQUE REFERENCES owner_hatching_tokens(token_id),retired_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_artwork_claims (
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,token_id TEXT NOT NULL UNIQUE REFERENCES owner_hatching_tokens(token_id),
    claimed_at_ms INTEGER NOT NULL,PRIMARY KEY(category,asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_slot_overrides (
    origin_category TEXT NOT NULL,origin_asset_id INTEGER NOT NULL,category TEXT NOT NULL,asset_id INTEGER NOT NULL,
    token_id TEXT NOT NULL REFERENCES owner_hatching_tokens(token_id),
    PRIMARY KEY(origin_category,origin_asset_id),UNIQUE(category,asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_slot_history (
    token_id TEXT NOT NULL REFERENCES owner_hatching_tokens(token_id),origin_category TEXT NOT NULL,origin_asset_id INTEGER NOT NULL,
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(token_id,origin_category,origin_asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_enrichment (
    token_id TEXT PRIMARY KEY REFERENCES owner_hatching_tokens(token_id),metadata_revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
    attempts INTEGER NOT NULL DEFAULT 0,next_check_ms INTEGER NOT NULL DEFAULT 0,last_error TEXT)`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_enrichment_due ON owner_hatching_enrichment(status,next_check_ms)`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_publication (
    token_id TEXT PRIMARY KEY REFERENCES owner_hatching_tokens(token_id),metadata_revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','conflict')),
    attempts INTEGER NOT NULL DEFAULT 0,next_check_ms INTEGER NOT NULL DEFAULT 0,claim_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_publication_due ON owner_hatching_publication(status,next_check_ms)`,
  `CREATE TRIGGER IF NOT EXISTS owner_hatching_batch_immutable BEFORE UPDATE ON owner_hatching_batches
    BEGIN SELECT RAISE(ABORT,'Owner hatching batch is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS owner_hatching_token_identity BEFORE UPDATE ON owner_hatching_tokens
    WHEN NEW.token_id IS NOT OLD.token_id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.egg_id IS NOT OLD.egg_id
      OR NEW.original_json IS NOT OLD.original_json OR NEW.grail_category IS NOT OLD.grail_category OR NEW.grail_asset_id IS NOT OLD.grail_asset_id
      OR NEW.status!='hatched' OR NEW.metadata_revision<=OLD.metadata_revision
      OR (OLD.status='hatched' AND (NEW.hatched_at_ms IS NOT OLD.hatched_at_ms
        OR json_extract(NEW.canonical_json,'$.category') IS NOT json_extract(OLD.canonical_json,'$.category')
        OR json_extract(NEW.canonical_json,'$.assetId') IS NOT json_extract(OLD.canonical_json,'$.assetId')))
    BEGIN SELECT RAISE(ABORT,'Owner hatching result is immutable'); END`,
  ...['owner_hatching_batches', 'owner_hatching_grails', 'owner_hatching_tokens', 'owner_hatching_fresh_eggs',
    'owner_hatching_retired_eggs', 'owner_hatching_artwork_claims', 'owner_hatching_slot_history'].map(table =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Owner hatching history cannot be deleted'); END`),
  ...['owner_hatching_grails', 'owner_hatching_retired_eggs', 'owner_hatching_artwork_claims', 'owner_hatching_slot_history'].map(table =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Owner hatching history is immutable'); END`),
  `CREATE TRIGGER IF NOT EXISTS owner_hatching_fresh_once BEFORE UPDATE ON owner_hatching_fresh_eggs
    WHEN NEW.egg_id IS NOT OLD.egg_id OR NEW.batch_id IS NOT OLD.batch_id OR OLD.token_id IS NOT NULL OR NEW.token_id IS NULL
    BEGIN SELECT RAISE(ABORT,'Fresh egg can only be used once'); END`,
];

export function initializeOwnerHatchingSchemaV1(sql: RevealSql, transaction: <T>(action: () => T) => T): void {
  transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement);
    if (!sql.exec<{ name: string }>('PRAGMA table_info(owner_hatching_enrichment)').toArray().some(row => row.name === 'last_error')) {
      sql.exec('ALTER TABLE owner_hatching_enrichment ADD COLUMN last_error TEXT');
    }
  });
}
