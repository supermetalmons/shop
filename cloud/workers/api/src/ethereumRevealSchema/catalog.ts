import type { RevealSql } from '../ethereumRevealStore.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_catalog_generations (batch_id TEXT PRIMARY KEY,batch_sha256 TEXT NOT NULL,
    predecessor_json TEXT NOT NULL,target_json TEXT NOT NULL,target_manifest_json TEXT NOT NULL,
    source_revision INTEGER NOT NULL,target_revision INTEGER NOT NULL,mapping_count INTEGER NOT NULL,mapping_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('mapping','staging','ready','active','complete','cancelled')),
    started_at_ms INTEGER NOT NULL,activated_at_ms INTEGER,seeded INTEGER NOT NULL DEFAULT 0,frozen_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS reveal_catalog_mappings (batch_id TEXT NOT NULL REFERENCES reveal_catalog_generations(batch_id),
    egg_id INTEGER NOT NULL,category TEXT NOT NULL,asset_id INTEGER NOT NULL,attributes_json TEXT,attributes_sha256 TEXT,
    collection_block_validated INTEGER NOT NULL DEFAULT 0 CHECK(collection_block_validated IN (0,1)
      AND (collection_block_validated=0 OR attributes_json IS NOT NULL)),
    PRIMARY KEY(batch_id,egg_id),UNIQUE(batch_id,category,asset_id),CHECK((attributes_json IS NULL)=(attributes_sha256 IS NULL)))`,
  `CREATE INDEX IF NOT EXISTS reveal_catalog_origin ON reveal_catalog_mappings(egg_id,batch_id)`,
  `CREATE TABLE IF NOT EXISTS reveal_catalog_egg_claims (batch_id TEXT NOT NULL REFERENCES reveal_catalog_generations(batch_id),
    egg_id INTEGER NOT NULL,origin_category TEXT NOT NULL,origin_asset_id INTEGER NOT NULL,
    PRIMARY KEY(batch_id,egg_id),UNIQUE(batch_id,origin_category,origin_asset_id))`,
  `CREATE TABLE IF NOT EXISTS reveal_catalog_pools (generation TEXT NOT NULL REFERENCES reveal_catalog_generations(batch_id),
    category TEXT NOT NULL,total INTEGER NOT NULL,seeded INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(generation,category),CHECK(available>=0 AND available<=seeded AND seeded<=total))`,
  `CREATE TABLE IF NOT EXISTS reveal_catalog_free (generation TEXT NOT NULL,category TEXT NOT NULL,slot INTEGER NOT NULL,
    origin_category TEXT NOT NULL,origin_asset_id INTEGER NOT NULL,asset_id INTEGER NOT NULL,
    PRIMARY KEY(generation,category,slot),UNIQUE(generation,origin_category,origin_asset_id),UNIQUE(generation,category,asset_id),
    FOREIGN KEY(generation,category) REFERENCES reveal_catalog_pools(generation,category))`,
  `CREATE TABLE IF NOT EXISTS reveal_catalog_publications (batch_id TEXT NOT NULL,token_id TEXT NOT NULL,metadata_revision INTEGER NOT NULL,
    target_sha256 TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,next_check_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(batch_id,token_id),
    FOREIGN KEY(batch_id) REFERENCES reveal_catalog_generations(batch_id))`,
  `CREATE TRIGGER IF NOT EXISTS reveal_catalog_header_immutable BEFORE UPDATE ON reveal_catalog_generations
    WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.batch_sha256 IS NOT OLD.batch_sha256
      OR NEW.predecessor_json IS NOT OLD.predecessor_json OR NEW.target_json IS NOT OLD.target_json
      OR NEW.target_manifest_json IS NOT OLD.target_manifest_json OR NEW.source_revision IS NOT OLD.source_revision
      OR NEW.target_revision IS NOT OLD.target_revision OR NEW.mapping_count IS NOT OLD.mapping_count
      OR NEW.mapping_sha256 IS NOT OLD.mapping_sha256 OR NEW.started_at_ms IS NOT OLD.started_at_ms
      OR (OLD.activated_at_ms IS NOT NULL AND (NEW.activated_at_ms IS NOT OLD.activated_at_ms OR NEW.frozen_count IS NOT OLD.frozen_count))
    BEGIN SELECT RAISE(ABORT,'Catalog generation identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS reveal_catalog_no_delete BEFORE DELETE ON reveal_catalog_generations
    BEGIN SELECT RAISE(ABORT,'Catalog generation audit cannot be deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS reveal_catalog_mapping_immutable BEFORE UPDATE ON reveal_catalog_mappings
    WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.egg_id IS NOT OLD.egg_id OR NEW.category IS NOT OLD.category OR NEW.asset_id IS NOT OLD.asset_id
      OR (OLD.attributes_json IS NOT NULL AND (NEW.attributes_json IS NOT OLD.attributes_json OR NEW.attributes_sha256 IS NOT OLD.attributes_sha256))
    BEGIN SELECT RAISE(ABORT,'Catalog mapping is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS reveal_catalog_mapping_no_delete BEFORE DELETE ON reveal_catalog_mappings
    BEGIN SELECT RAISE(ABORT,'Catalog mapping audit cannot be deleted'); END`,
];

export function initializeRevealCatalogSchemaV1(sql: RevealSql, transaction: <T>(action: () => T) => T): void {
  transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement);
    const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(settings)').toArray().map(row => row.name));
    for (const [name, type] of [['effective_catalog_version', 'TEXT'], ['effective_catalog_sha256', 'TEXT'],
      ['catalog_revision', 'INTEGER NOT NULL DEFAULT 0'], ['active_catalog_generation', 'TEXT'], ['candidate_catalog_generation', 'TEXT'],
      ['allocation_base_generation', 'TEXT']]) {
      if (!columns.has(name)) sql.exec(`ALTER TABLE settings ADD COLUMN ${name} ${type}`);
    }
    if (!sql.exec<{ name: string }>('PRAGMA table_info(reveal_catalog_generations)').toArray().some(row => row.name === 'mode')) {
      sql.exec("ALTER TABLE reveal_catalog_generations ADD COLUMN mode TEXT NOT NULL DEFAULT 'online' CHECK(mode IN ('online','empty-rebuild'))");
    }
    for (const [table, name, type] of [
      ['reveal_catalog_generations', 'batch_version', 'INTEGER NOT NULL DEFAULT 1'],
      ['reveal_catalog_generations', 'egg_cutoff', 'INTEGER'],
      ['reveal_catalog_mappings', 'origin_category', 'TEXT'],
      ['reveal_catalog_mappings', 'origin_asset_id', 'INTEGER'],
      ['reveal_catalog_mappings', 'collection_block_validated', 'INTEGER NOT NULL DEFAULT 0 CHECK(collection_block_validated IN (0,1) AND (collection_block_validated=0 OR attributes_json IS NOT NULL))'],
    ]) {
      if (!sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === name)) {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS reveal_catalog_mapping_origin_unit ON reveal_catalog_mappings
        (batch_id,COALESCE(origin_category,'egg'),COALESCE(origin_asset_id,egg_id))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS reveal_catalog_metadata_validation ON reveal_catalog_mappings
        (batch_id,collection_block_validated,egg_id)`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_catalog_explicit_identity BEFORE UPDATE ON reveal_catalog_generations
        WHEN NEW.batch_version IS NOT OLD.batch_version OR NEW.egg_cutoff IS NOT OLD.egg_cutoff
        BEGIN SELECT RAISE(ABORT,'Catalog generation identity is immutable'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_catalog_mapping_origin_identity BEFORE UPDATE ON reveal_catalog_mappings
        WHEN NEW.origin_category IS NOT OLD.origin_category OR NEW.origin_asset_id IS NOT OLD.origin_asset_id
        BEGIN SELECT RAISE(ABORT,'Catalog mapping origin is immutable'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_catalog_mode_immutable BEFORE UPDATE ON reveal_catalog_generations
        WHEN NEW.mode IS NOT OLD.mode BEGIN SELECT RAISE(ABORT,'Catalog generation mode is immutable'); END`);
    for (const [table, name] of [['assignments', 'assignment_revision'], ['publication', 'metadata_revision']]) {
      if (!sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === name)) {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    if (!sql.exec("SELECT 1 FROM reveal_migrations WHERE name='online-catalog-generations-v1'").toArray().length) {
      sql.exec('DROP TRIGGER IF EXISTS frozen_assignment_update');
      sql.exec(`CREATE TRIGGER frozen_assignment_update BEFORE UPDATE ON assignments WHEN OLD.token_id IS NOT NULL
          BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot change'); END`);
      sql.exec('DROP TRIGGER IF EXISTS assignment_not_free');
      sql.exec(`CREATE TRIGGER assignment_not_free BEFORE INSERT ON assignments WHEN
          EXISTS(SELECT 1 FROM free_slots f,settings s WHERE s.id=1 AND s.active_catalog_generation IS NULL
            AND f.category=NEW.category AND f.asset_id=NEW.asset_id) OR EXISTS(SELECT 1 FROM reveal_catalog_free f,settings s
            WHERE s.id=1 AND f.generation=s.active_catalog_generation AND f.origin_category=NEW.category AND f.origin_asset_id=NEW.asset_id)
          BEGIN SELECT RAISE(ABORT,'Assigned reveal asset is still free'); END`);
      sql.exec('DROP TRIGGER IF EXISTS assignment_update_not_free');
      sql.exec(`CREATE TRIGGER assignment_update_not_free BEFORE UPDATE ON assignments WHEN
          EXISTS(SELECT 1 FROM free_slots f,settings s WHERE s.id=1 AND s.active_catalog_generation IS NULL
            AND f.category=NEW.category AND f.asset_id=NEW.asset_id) OR EXISTS(SELECT 1 FROM reveal_catalog_free f,settings s
            WHERE s.id=1 AND f.generation=s.active_catalog_generation AND f.origin_category=NEW.category AND f.origin_asset_id=NEW.asset_id)
          BEGIN SELECT RAISE(ABORT,'Assigned reveal asset is still free'); END`);
      for (const operation of ['INSERT', 'UPDATE']) sql.exec(`CREATE TRIGGER reveal_catalog_free_${operation.toLowerCase()} BEFORE ${operation} ON reveal_catalog_free
          WHEN EXISTS(SELECT 1 FROM assignments a WHERE a.category=NEW.origin_category AND a.asset_id=NEW.origin_asset_id)
          BEGIN SELECT RAISE(ABORT,'Reveal asset is already assigned'); END`);
      sql.exec("INSERT INTO reveal_migrations(name) VALUES('online-catalog-generations-v1')");
    }
  });
}
