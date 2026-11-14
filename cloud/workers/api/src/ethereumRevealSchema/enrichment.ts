import type { RevealSql } from '../ethereumRevealStore.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../../shared/ethereum/reveal.js';

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

export function initializeRevealEnrichmentSchemaV1(sql: RevealSql, transaction: <T>(action: () => T) => T, ownerOverrides: boolean): void {
  transaction(() => {
    for (const table of ['reveal_enrichment', 'reveal_enrichment_acknowledgments']) {
      const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
      if (columns.length && !columns.some(column => column.name === 'assignment_revision')) {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 0`);
      }
    }
    sql.exec('DROP TRIGGER IF EXISTS enqueue_reveal_enrichment');
    const trigger = REVEAL_ENRICHMENT_SCHEMA.at(-1)!;
    sql.exec(ownerOverrides ? trigger.replace('ON CONFLICT(token_id,version)',
      `AND NOT EXISTS(SELECT 1 FROM owner_hatching_slot_overrides o WHERE o.origin_category=assignments.category AND o.origin_asset_id=assignments.asset_id)
        ON CONFLICT(token_id,version)`) : trigger);
  });
}
