import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.js';
import type { RevealAssetCatalog, RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { validateRevealCatalogUpdateBatch, type RevealCatalogUpdateBatch, type RevealCatalogUpdateMapping } from '../../../../shared/ethereum/revealCatalogUpdate.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { RevealSql } from './ethereumRevealStore.js';
import { buildRevealedArtwork } from './ethereumRevealCatalog.js';
import { metadataNumber, parseMetadataJson } from './ethereumMetadataJson.js';
import { applyRevealAttributePayload } from './ethereumRevealAttributes.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';

export type RevealOriginUnit = { category: EthereumArtworkCategory; assetId: number };
export type RevealArtworkReadOptions = { includeCollectionBlock?: boolean };
export type RevealEffectiveUnit = RevealOriginUnit & { assignmentRevision: number };
export type RevealPool = { category: EthereumArtworkCategory; total: number; seeded: number; available: number };
export type RevealCatalogMetadataStage = RevealOriginUnit & { attributesJson: string; sha256: string };
export type RevealCanonicalMetadata = {
  tokenId: string; category: EthereumArtworkCategory; assetId: number; assignmentRevision: number; metadataRevision: number;
  artwork: EthereumRevealedArtwork; metadataJson: string; targetSha256: string; expectedJsons: string[]; allowMissing: boolean; migration: boolean;
};
export type RevealCatalogUpdatePublication = RevealCanonicalMetadata & { eggId: number };
export type RevealCatalogUpdateStatus = {
  batchId: string; batchSha256: string; predecessor: RevealAssetCatalogDescriptor; target: RevealAssetCatalogDescriptor;
  sourceRevision: number; targetRevision: number; startedAtMs: number; activatedAtMs: number | null;
  phase: 'mapping' | 'staging' | 'ready' | 'active' | 'complete' | 'cancelled';
  total: number; mapped: number; metadataStaged: number; generationSeeded: number; frozen: number; published: number; retrying: number; conflicts: number;
};
type Operation = {
  batch_id: string; batch_sha256: string; predecessor_json: string; target_json: string; target_manifest_json: string;
  source_revision: number; target_revision: number; mapping_count: number; mapping_sha256: string; phase: RevealCatalogUpdateStatus['phase'];
  started_at_ms: number; activated_at_ms: number | null; seeded: number; frozen_count: number;
};
type Mapping = { batch_id: string; egg_id: number; category: EthereumArtworkCategory; asset_id: number;
  attributes_json: string | null; attributes_sha256: string | null };
type Assignment = { category: EthereumArtworkCategory; asset_id: number; token_id: string; crate_token_id: string;
  artwork_json: string; metadata_json: string; placeholder_json: string; frozen_at_ms: number; assignment_revision: number };
const CATEGORIES = ['egg', 'painting', 'video', '3d', 'animated'] as const;
const TOTAL = 111_111;
const hash = (json: string) => bytesToHex(sha256(json));
const counts = (catalog: RevealAssetCatalog): Record<EthereumArtworkCategory, number> => ({ egg: catalog.categories.eggs.count,
  painting: catalog.categories.paintings.count, video: catalog.categories.videos.count, '3d': catalog.categories['3d'].count,
  animated: catalog.categories.animated.count });
function limit(value: number, maximum = 256): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid catalog page size.');
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reveal_catalog_generations (batch_id TEXT PRIMARY KEY,batch_sha256 TEXT NOT NULL,
    predecessor_json TEXT NOT NULL,target_json TEXT NOT NULL,target_manifest_json TEXT NOT NULL,
    source_revision INTEGER NOT NULL,target_revision INTEGER NOT NULL,mapping_count INTEGER NOT NULL,mapping_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('mapping','staging','ready','active','complete','cancelled')),
    started_at_ms INTEGER NOT NULL,activated_at_ms INTEGER,seeded INTEGER NOT NULL DEFAULT 0,frozen_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS reveal_catalog_mappings (batch_id TEXT NOT NULL REFERENCES reveal_catalog_generations(batch_id),
    egg_id INTEGER NOT NULL,category TEXT NOT NULL,asset_id INTEGER NOT NULL,attributes_json TEXT,attributes_sha256 TEXT,
    PRIMARY KEY(batch_id,egg_id),UNIQUE(batch_id,category,asset_id),CHECK((attributes_json IS NULL)=(attributes_sha256 IS NULL)))`,
  `CREATE INDEX IF NOT EXISTS reveal_catalog_origin ON reveal_catalog_mappings(egg_id,batch_id)`,
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

export class EthereumRevealCatalogUpdateStore {
  private originCounts: Record<EthereumArtworkCategory, number> | undefined;
  private readonly catalogs = new Map<string, RevealAssetCatalog>();
  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T) {}

  initialize(): void {
    this.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(settings)').toArray().map(row => row.name));
      for (const [name, type] of [['effective_catalog_version', 'TEXT'], ['effective_catalog_sha256', 'TEXT'],
        ['catalog_revision', 'INTEGER NOT NULL DEFAULT 0'], ['active_catalog_generation', 'TEXT'], ['candidate_catalog_generation', 'TEXT']]) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE settings ADD COLUMN ${name} ${type}`);
      }
      for (const [table, name] of [['assignments', 'assignment_revision'], ['publication', 'metadata_revision']]) {
        if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === name)) {
          this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
        }
      }
      if (!this.sql.exec("SELECT 1 FROM reveal_migrations WHERE name='online-catalog-generations-v1'").toArray().length) {
        this.sql.exec('DROP TRIGGER IF EXISTS frozen_assignment_update');
        this.sql.exec(`CREATE TRIGGER frozen_assignment_update BEFORE UPDATE ON assignments WHEN OLD.token_id IS NOT NULL
          BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot change'); END`);
        this.sql.exec('DROP TRIGGER IF EXISTS assignment_not_free');
        this.sql.exec(`CREATE TRIGGER assignment_not_free BEFORE INSERT ON assignments WHEN
          EXISTS(SELECT 1 FROM free_slots f,settings s WHERE s.id=1 AND s.active_catalog_generation IS NULL
            AND f.category=NEW.category AND f.asset_id=NEW.asset_id) OR EXISTS(SELECT 1 FROM reveal_catalog_free f,settings s
            WHERE s.id=1 AND f.generation=s.active_catalog_generation AND f.origin_category=NEW.category AND f.origin_asset_id=NEW.asset_id)
          BEGIN SELECT RAISE(ABORT,'Assigned reveal asset is still free'); END`);
        this.sql.exec('DROP TRIGGER IF EXISTS assignment_update_not_free');
        this.sql.exec(`CREATE TRIGGER assignment_update_not_free BEFORE UPDATE ON assignments WHEN
          EXISTS(SELECT 1 FROM free_slots f,settings s WHERE s.id=1 AND s.active_catalog_generation IS NULL
            AND f.category=NEW.category AND f.asset_id=NEW.asset_id) OR EXISTS(SELECT 1 FROM reveal_catalog_free f,settings s
            WHERE s.id=1 AND f.generation=s.active_catalog_generation AND f.origin_category=NEW.category AND f.origin_asset_id=NEW.asset_id)
          BEGIN SELECT RAISE(ABORT,'Assigned reveal asset is still free'); END`);
        for (const operation of ['INSERT', 'UPDATE']) this.sql.exec(`CREATE TRIGGER reveal_catalog_free_${operation.toLowerCase()} BEFORE ${operation} ON reveal_catalog_free
          WHEN EXISTS(SELECT 1 FROM assignments a WHERE a.category=NEW.origin_category AND a.asset_id=NEW.origin_asset_id)
          BEGIN SELECT RAISE(ABORT,'Reveal asset is already assigned'); END`);
        this.sql.exec("INSERT INTO reveal_migrations(name) VALUES('online-catalog-generations-v1')");
      }
    });
  }

  private settings(): { deployment_json: string; catalog_revision: number; active_catalog_generation: string | null;
    candidate_catalog_generation: string | null; effective_catalog_version: string | null; effective_catalog_sha256: string | null } | null {
    if (!this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='settings'").toArray().length) return null;
    const row = this.sql.exec<{ deployment_json: string; catalog_revision?: number; active_catalog_generation?: string | null;
      candidate_catalog_generation?: string | null; effective_catalog_version?: string | null; effective_catalog_sha256?: string | null }>(
      'SELECT * FROM settings WHERE id=1').toArray()[0];
    return row ? { deployment_json: row.deployment_json, catalog_revision: row.catalog_revision ?? 0,
      active_catalog_generation: row.active_catalog_generation ?? null, candidate_catalog_generation: row.candidate_catalog_generation ?? null,
      effective_catalog_version: row.effective_catalog_version ?? null, effective_catalog_sha256: row.effective_catalog_sha256 ?? null } : null;
  }

  private operation(batchId: string): Operation {
    if (!this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_catalog_generations'").toArray().length) throw new Error('Unknown catalog update.');
    const row = this.sql.exec<Operation>('SELECT * FROM reveal_catalog_generations WHERE batch_id=?', batchId).toArray()[0];
    if (!row) throw new Error('Unknown catalog update.');
    return row;
  }

  effectiveCatalog(): (RevealAssetCatalogDescriptor & { catalogRevision: number; generation: string | null }) | null {
    const saved = this.settings();
    if (!saved) return null;
    const origin = JSON.parse(saved.deployment_json) as EthereumRevealDeployment;
    const descriptor = saved.active_catalog_generation ? JSON.parse(this.operation(saved.active_catalog_generation).target_json) as RevealAssetCatalogDescriptor
      : getRevealCatalogDescriptor(origin.catalogVersion);
    if (!descriptor) throw new Error('Reveal catalog is not supported.');
    return { ...descriptor, catalogRevision: saved.catalog_revision, generation: saved.active_catalog_generation };
  }

  activeCatalog(): RevealAssetCatalog {
    const saved = this.settings();
    if (!saved) throw new Error('Reveal inventory is not configured.');
    if (saved.active_catalog_generation) {
      let catalog = this.catalogs.get(saved.active_catalog_generation);
      if (!catalog) {
        catalog = JSON.parse(this.operation(saved.active_catalog_generation).target_manifest_json) as RevealAssetCatalog;
        this.catalogs.set(saved.active_catalog_generation, catalog);
      }
      return catalog;
    }
    const value = getRevealCatalog((JSON.parse(saved.deployment_json) as EthereumRevealDeployment).catalogVersion);
    if (!value) throw new Error('Reveal catalog is not supported.');
    return value;
  }

  effectiveDeployment(deployment: EthereumRevealDeployment): EthereumRevealDeployment {
    const effective = this.effectiveCatalog();
    return effective ? { ...deployment, effectiveCatalogVersion: effective.catalogVersion,
      effectiveCatalogSha256: effective.manifestSha256, catalogRevision: effective.catalogRevision } : deployment;
  }

  private originalCounts(): Record<EthereumArtworkCategory, number> {
    if (this.originCounts) return this.originCounts;
    const saved = this.settings();
    const origin = saved && JSON.parse(saved.deployment_json) as EthereumRevealDeployment | null;
    const catalog = origin && getRevealCatalog(origin.catalogVersion);
    if (!catalog) throw new Error('Original catalog is unavailable.');
    return this.originCounts = counts(catalog);
  }

  private ordinal(unit: RevealOriginUnit): number {
    const original = this.originalCounts();
    let offset = 0;
    for (const category of CATEGORIES) {
      if (unit.category === category) return offset + unit.assetId;
      offset += original[category];
    }
    throw new Error('Unknown allocation unit.');
  }

  private unitAt(index: number): RevealOriginUnit {
    const original = this.originalCounts();
    for (const category of CATEGORIES) {
      if (index <= original[category]) return { category, assetId: index };
      index -= original[category];
    }
    throw new Error('Invalid allocation unit.');
  }

  private mapping(unit: RevealOriginUnit, candidate?: string): (Mapping & { target_revision: number }) | undefined {
    if (unit.category !== 'egg') return;
    return this.sql.exec<Mapping & { target_revision: number }>(`SELECT m.*,g.target_revision FROM reveal_catalog_mappings m
      JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id WHERE m.egg_id=? AND
      (g.activated_at_ms IS NOT NULL OR g.batch_id=?) ORDER BY g.target_revision DESC LIMIT 1`, unit.assetId, candidate ?? '').toArray()[0];
  }

  resolveUnit(unit: RevealOriginUnit, assignmentRevision = this.settings()?.catalog_revision ?? 0, candidate?: string): RevealEffectiveUnit {
    const mapping = unit.category === 'egg' ? this.sql.exec<{ category: EthereumArtworkCategory; asset_id: number; target_revision: number }>(
      `SELECT m.category,m.asset_id,g.target_revision FROM reveal_catalog_mappings m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
        WHERE m.egg_id=? AND (g.activated_at_ms IS NOT NULL OR g.batch_id=?) ORDER BY g.target_revision DESC LIMIT 1`, unit.assetId, candidate ?? '').toArray()[0] : undefined;
    return mapping ? { category: mapping.category, assetId: mapping.asset_id,
      assignmentRevision: Math.max(assignmentRevision, mapping.target_revision) } : { ...unit, assignmentRevision };
  }

  canonicalArtworks(tokenIds: readonly string[], options?: RevealArtworkReadOptions): EthereumRevealedArtwork[] {
    const saved = this.settings();
    if (!saved || !tokenIds.length) return [];
    const deployment = JSON.parse(saved.deployment_json) as EthereumRevealDeployment;
    const collectionBlocks = options?.includeCollectionBlock ? revealCollectionBlocks(
      saved.effective_catalog_version === null && saved.effective_catalog_sha256 === null && !saved.active_catalog_generation
        ? getRevealCatalogDescriptor(deployment.catalogVersion)
        : saved.effective_catalog_version && saved.effective_catalog_sha256
          ? { catalogVersion: saved.effective_catalog_version, manifestSha256: saved.effective_catalog_sha256 } : null) : null;
    let catalog: RevealAssetCatalog | undefined;
    const values = new Map<string, EthereumRevealedArtwork>();
    for (let offset = 0; offset < tokenIds.length; offset += 100) {
      const ids = tokenIds.slice(offset, offset + 100);
      const rows = this.sql.exec<Pick<Assignment, 'category' | 'asset_id' | 'assignment_revision' | 'token_id' | 'crate_token_id' | 'artwork_json'>>(
        `SELECT category,asset_id,assignment_revision,token_id,crate_token_id,artwork_json FROM assignments WHERE token_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray();
      for (const row of rows) {
        const effective = this.resolveUnit({ category: row.category, assetId: row.asset_id }, row.assignment_revision ?? 0);
        let artwork = JSON.parse(row.artwork_json) as EthereumRevealedArtwork;
        if (effective.category !== row.category || effective.assetId !== row.asset_id) {
          catalog ??= this.activeCatalog();
          artwork = buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId: row.token_id, crateTokenId: row.crate_token_id,
            category: effective.category, assetId: effective.assetId, observation: artwork.observation, catalog }).artwork;
        }
        const metadataRevision = 2 * effective.assignmentRevision;
        const canonical = { ...artwork, ...(metadataRevision ? { metadataRevision } : {}) };
        if (options?.includeCollectionBlock) canonical.collectionBlock = lookupRevealCollectionBlock(collectionBlocks, effective.category, effective.assetId);
        values.set(row.token_id, canonical);
      }
    }
    return tokenIds.flatMap(tokenId => values.has(tokenId) ? [values.get(tokenId)!] : []);
  }

  pools(): RevealPool[] {
    const active = this.settings()?.active_catalog_generation;
    return active ? this.sql.exec<RevealPool>('SELECT category,total,seeded,available FROM reveal_catalog_pools WHERE generation=? ORDER BY category', active).toArray()
      : this.sql.exec<RevealPool>('SELECT * FROM pools ORDER BY category').toArray();
  }

  private isFree(unit: RevealOriginUnit): boolean {
    const active = this.settings()?.active_catalog_generation;
    return (active ? this.sql.exec('SELECT 1 FROM reveal_catalog_free WHERE generation=? AND origin_category=? AND origin_asset_id=?', active, unit.category, unit.assetId)
      : this.sql.exec('SELECT 1 FROM free_slots WHERE category=? AND asset_id=?', unit.category, unit.assetId)).toArray().length === 1;
  }

  private insertFree(generation: string, unit: RevealOriginUnit): void {
    const effective = this.resolveUnit(unit, 0, generation);
    const pool = this.sql.exec<{ available: number }>('SELECT available FROM reveal_catalog_pools WHERE generation=? AND category=?', generation, effective.category).toArray()[0];
    this.sql.exec(`INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
      VALUES(?,?,?,?,?,?)`, generation, effective.category, pool.available, unit.category, unit.assetId, effective.assetId);
    this.sql.exec('UPDATE reveal_catalog_pools SET available=available+1 WHERE generation=? AND category=?', generation, effective.category);
  }

  private removeFree(generation: string, unit: RevealOriginUnit): void {
    const selected = this.sql.exec<{ category: EthereumArtworkCategory; slot: number }>(
      'SELECT category,slot FROM reveal_catalog_free WHERE generation=? AND origin_category=? AND origin_asset_id=?', generation, unit.category, unit.assetId).toArray()[0];
    if (!selected) throw new Error('Catalog free unit is missing.');
    const pool = this.sql.exec<{ available: number }>('SELECT available FROM reveal_catalog_pools WHERE generation=? AND category=?', generation, selected.category).toArray()[0];
    const last = this.sql.exec<{ origin_category: EthereumArtworkCategory; origin_asset_id: number; asset_id: number }>(
      'SELECT origin_category,origin_asset_id,asset_id FROM reveal_catalog_free WHERE generation=? AND category=? AND slot=?', generation, selected.category, pool.available - 1).toArray()[0];
    this.sql.exec('DELETE FROM reveal_catalog_free WHERE generation=? AND category=? AND slot=?', generation, selected.category, pool.available - 1);
    if (selected.slot !== pool.available - 1) this.sql.exec(`UPDATE reveal_catalog_free SET origin_category=?,origin_asset_id=?,asset_id=?
      WHERE generation=? AND category=? AND slot=?`, last.origin_category, last.origin_asset_id, last.asset_id, generation, selected.category, selected.slot);
    this.sql.exec('UPDATE reveal_catalog_pools SET available=available-1 WHERE generation=? AND category=?', generation, selected.category);
  }

  takeFree(category: EthereumArtworkCategory, index: number): RevealOriginUnit {
    return this.transaction(() => {
      const saved = this.settings()!;
      let unit: RevealOriginUnit;
      if (saved.active_catalog_generation) {
        const row = this.sql.exec<{ origin_category: EthereumArtworkCategory; origin_asset_id: number }>(
          'SELECT origin_category,origin_asset_id FROM reveal_catalog_free WHERE generation=? AND category=? AND slot=?',
          saved.active_catalog_generation, category, index).toArray()[0];
        if (!row) throw new Error('Reveal free pool is inconsistent.');
        unit = { category: row.origin_category, assetId: row.origin_asset_id };
        this.removeFree(saved.active_catalog_generation, unit);
      } else {
        const chosen = this.sql.exec<{ asset_id: number }>('SELECT asset_id FROM free_slots WHERE category=? AND slot=?', category, index).toArray()[0];
        const pool = this.sql.exec<{ available: number }>('SELECT available FROM pools WHERE category=?', category).toArray()[0];
        const last = this.sql.exec<{ asset_id: number }>('SELECT asset_id FROM free_slots WHERE category=? AND slot=?', category, pool.available - 1).toArray()[0];
        if (!chosen || !last) throw new Error('Reveal free pool is inconsistent.');
        unit = { category, assetId: chosen.asset_id };
        this.sql.exec('DELETE FROM free_slots WHERE category=? AND slot=?', category, pool.available - 1);
        if (index !== pool.available - 1) this.sql.exec('UPDATE free_slots SET asset_id=? WHERE category=? AND slot=?', last.asset_id, category, index);
        this.sql.exec('UPDATE pools SET available=available-1 WHERE category=?', category);
      }
      if (saved.candidate_catalog_generation && this.ordinal(unit) <= this.operation(saved.candidate_catalog_generation).seeded) {
        this.removeFree(saved.candidate_catalog_generation, unit);
      }
      return unit;
    });
  }

  releaseFree(unit: RevealOriginUnit): void {
    this.transaction(() => {
      const saved = this.settings()!;
      if (saved.active_catalog_generation) this.insertFree(saved.active_catalog_generation, unit);
      else {
        const pool = this.sql.exec<{ available: number }>('SELECT available FROM pools WHERE category=?', unit.category).toArray()[0];
        this.sql.exec('INSERT INTO free_slots(category,slot,asset_id) VALUES(?,?,?)', unit.category, pool.available, unit.assetId);
        this.sql.exec('UPDATE pools SET available=available+1 WHERE category=?', unit.category);
      }
      if (saved.candidate_catalog_generation && this.ordinal(unit) <= this.operation(saved.candidate_catalog_generation).seeded) {
        this.insertFree(saved.candidate_catalog_generation, unit);
      }
    });
  }

  begin(batch: RevealCatalogUpdateBatch, now: number): RevealCatalogUpdateStatus {
    validateRevealCatalogUpdateBatch(batch);
    this.initialize();
    const existing = this.status(batch.batchId);
    if (existing) {
      if (existing.batchSha256 !== batch.batchSha256 || existing.phase === 'cancelled') throw new Error('Catalog update replay does not match.');
      return existing;
    }
    return this.transaction(() => {
      const saved = this.settings();
      const current = this.effectiveCatalog();
      if (!saved || !current || saved.candidate_catalog_generation || current.catalogVersion !== batch.predecessor.descriptor.catalogVersion ||
        current.manifestSha256 !== batch.predecessor.descriptor.manifestSha256) throw new Error('Catalog update predecessor changed.');
      if (!this.sql.exec('SELECT 1 FROM settings WHERE id=1 AND ready=1').toArray().length) throw new Error('Reveal inventory is not ready.');
      if (this.sql.exec("SELECT 1 FROM reveal_catalog_generations WHERE phase='active' LIMIT 1").toArray().length) throw new Error('Finish the previous catalog operation first.');
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'mapping',?)`,
        batch.batchId, batch.batchSha256, JSON.stringify(batch.predecessor.descriptor), JSON.stringify(batch.target.descriptor),
        JSON.stringify(batch.target.manifest), current.catalogRevision, current.catalogRevision + 1, batch.mappings.length,
        hash(JSON.stringify(batch.mappings.map(row => ({ eggId: row.eggId, category: row.category, assetId: row.assetId })))), now);
      for (const category of CATEGORIES) this.sql.exec('INSERT INTO reveal_catalog_pools(generation,category,total) VALUES(?,?,?)',
        batch.batchId, category, counts(batch.target.manifest)[category]);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=? WHERE id=1', batch.batchId);
      return this.status(batch.batchId)!;
    });
  }

  stageMappings(batchId: string, mappings: RevealCatalogUpdateMapping[]): RevealCatalogUpdateStatus {
    limit(mappings.length);
    this.transaction(() => {
      const operation = this.operation(batchId);
      if (operation.phase !== 'mapping') throw new Error('Catalog mapping is already sealed.');
      const target = JSON.parse(operation.target_manifest_json) as RevealAssetCatalog;
      const predecessor = this.activeCatalog();
      const before = counts(predecessor), after = counts(target);
      for (const mapping of mappings) {
        if (!Number.isSafeInteger(mapping.eggId) || mapping.eggId <= after.egg || mapping.eggId > before.egg ||
          mapping.category === ('egg' as string) || !Object.hasOwn(after, mapping.category) || !Number.isSafeInteger(mapping.assetId) ||
          mapping.assetId <= before[mapping.category] || mapping.assetId > after[mapping.category]) throw new Error('Invalid replacement mapping.');
        const previous = this.sql.exec<Mapping>('SELECT * FROM reveal_catalog_mappings WHERE batch_id=? AND egg_id=?', batchId, mapping.eggId).toArray()[0];
        if (previous) {
          if (previous.category !== mapping.category || previous.asset_id !== mapping.assetId) throw new Error('Catalog mapping replay changed.');
        } else this.sql.exec('INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id) VALUES(?,?,?,?)', batchId, mapping.eggId, mapping.category, mapping.assetId);
      }
    });
    return this.status(batchId)!;
  }

  sealMappings(batchId: string): RevealCatalogUpdateStatus {
    const operation = this.operation(batchId);
    if (operation.phase !== 'mapping') return this.status(batchId)!;
    const digest = sha256.create();
    digest.update('[');
    let count = 0, after = 0;
    for (;;) {
      const rows = this.sql.exec<Mapping>('SELECT egg_id,category,asset_id FROM reveal_catalog_mappings WHERE batch_id=? AND egg_id>? ORDER BY egg_id LIMIT 256', batchId, after).toArray();
      for (const row of rows) {
        if (count++) digest.update(',');
        digest.update(JSON.stringify({ eggId: row.egg_id, category: row.category, assetId: row.asset_id }));
        after = row.egg_id;
      }
      if (rows.length < 256) break;
    }
    digest.update(']');
    if (count !== operation.mapping_count || bytesToHex(digest.digest()) !== operation.mapping_sha256) throw new Error('Catalog mapping checksum does not match.');
    this.sql.exec("UPDATE reveal_catalog_generations SET phase='staging' WHERE batch_id=? AND phase='mapping'", batchId);
    return this.status(batchId)!;
  }

  metadataPreparationPage(batchId: string, pageSize = 8): RevealOriginUnit[] {
    limit(pageSize);
    this.operation(batchId);
    return this.sql.exec<Mapping>('SELECT category,asset_id FROM reveal_catalog_mappings WHERE batch_id=? AND attributes_json IS NULL ORDER BY egg_id LIMIT ?', batchId, pageSize)
      .toArray().map(row => ({ category: row.category, assetId: row.asset_id }));
  }

  metadataStage(batchId: string, rows: RevealCatalogMetadataStage[]): RevealCatalogUpdateStatus {
    limit(rows.length);
    this.transaction(() => {
      const operation = this.operation(batchId);
      if (operation.phase !== 'staging') throw new Error('Catalog metadata is not staging.');
      const deployment = JSON.parse(this.settings()!.deployment_json) as EthereumRevealDeployment;
      const catalog = JSON.parse(operation.target_manifest_json) as RevealAssetCatalog;
      for (const row of rows) {
        const attributes: unknown = parseMetadataJson(row.attributesJson);
        if (new TextEncoder().encode(row.attributesJson).byteLength > 128 * 1024 || hash(row.attributesJson) !== row.sha256 ||
          !Array.isArray(attributes) || !attributes.length || !attributes.every(value => value && typeof value === 'object' &&
            typeof value.trait_type === 'string' && value.trait_type && (typeof value.value === 'string' || Number.isFinite(metadataNumber(value.value)))) ||
          attributes[0].trait_type !== 'collection block' || typeof attributes[0].value !== 'string' || !attributes[0].value.trim()) {
          throw new Error('Invalid staged artwork attributes.');
        }
        const previous = this.sql.exec<Mapping>('SELECT * FROM reveal_catalog_mappings WHERE batch_id=? AND category=? AND asset_id=?', batchId, row.category, row.assetId).toArray()[0];
        if (!previous || previous.attributes_json !== null && (previous.attributes_json !== row.attributesJson || previous.attributes_sha256 !== row.sha256)) {
          throw new Error('Staged artwork attributes cannot change.');
        }
        const largestMetadata = buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId: '111111', crateTokenId: '116666',
          category: row.category, assetId: row.assetId, catalog,
          observation: { transactionHash: `0x${'0'.repeat(64)}`, blockHash: `0x${'0'.repeat(64)}`, blockNumber: 0 } });
        applyRevealAttributePayload(largestMetadata.metadataJson, row.attributesJson);
        this.sql.exec('UPDATE reveal_catalog_mappings SET attributes_json=?,attributes_sha256=? WHERE batch_id=? AND category=? AND asset_id=?',
          row.attributesJson, row.sha256, batchId, row.category, row.assetId);
      }
    });
    return this.status(batchId)!;
  }

  generationStage(batchId: string, pageSize = 256): RevealCatalogUpdateStatus {
    limit(pageSize);
    this.transaction(() => {
      const operation = this.operation(batchId);
      if (operation.phase !== 'staging') throw new Error('Catalog generation is not staging.');
      if (this.sql.exec('SELECT 1 FROM reveal_catalog_mappings WHERE batch_id=? AND attributes_json IS NULL LIMIT 1', batchId).toArray().length) {
        throw new Error('Stage every new artwork before building the candidate pool.');
      }
      const last = Math.min(TOTAL, operation.seeded + pageSize);
      for (let index = operation.seeded + 1; index <= last; index++) {
        const unit = this.unitAt(index);
        const effective = this.resolveUnit(unit, operation.target_revision, batchId);
        const free = this.isFree(unit);
        const assigned = this.sql.exec('SELECT 1 FROM assignments WHERE category=? AND asset_id=?', unit.category, unit.assetId).toArray().length;
        if (Number(free) + assigned !== 1) throw new Error('Allocation unit is missing or duplicated.');
        this.sql.exec('UPDATE reveal_catalog_pools SET seeded=seeded+1 WHERE generation=? AND category=?', batchId, effective.category);
        if (free) this.insertFree(batchId, unit);
      }
      this.sql.exec('UPDATE reveal_catalog_generations SET seeded=? WHERE batch_id=?', last, batchId);
    });
    return this.status(batchId)!;
  }

  seal(batchId: string): RevealCatalogUpdateStatus {
    const operation = this.operation(batchId);
    if (operation.phase === 'ready') return this.status(batchId)!;
    if (operation.phase !== 'staging' || operation.seeded !== TOTAL) throw new Error('Catalog generation is incomplete.');
    this.verifyGeneration(batchId);
    this.sql.exec("UPDATE reveal_catalog_generations SET phase='ready' WHERE batch_id=?", batchId);
    return this.status(batchId)!;
  }

  activate(batchId: string, now = Date.now()): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.operation(batchId);
      if (operation.activated_at_ms !== null) return this.status(batchId)!;
      const saved = this.settings()!;
      if (operation.phase !== 'ready' || saved.candidate_catalog_generation !== batchId || saved.catalog_revision !== operation.source_revision) {
        throw new Error('Catalog generation cannot activate.');
      }
      const frozen = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM assignments a JOIN reveal_catalog_mappings m
        ON a.category='egg' AND a.asset_id=m.egg_id WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<?`, batchId, operation.target_revision).toArray()[0].count;
      const target = JSON.parse(operation.target_json) as RevealAssetCatalogDescriptor;
      this.sql.exec(`UPDATE reveal_catalog_generations SET phase='active',activated_at_ms=?,frozen_count=? WHERE batch_id=?`, now, frozen, batchId);
      this.sql.exec(`UPDATE settings SET active_catalog_generation=?,candidate_catalog_generation=NULL,effective_catalog_version=?,
        effective_catalog_sha256=?,catalog_revision=? WHERE id=1`, batchId, target.catalogVersion, target.manifestSha256, operation.target_revision);
      return this.status(batchId)!;
    });
  }

  canonicalMetadata(tokenIds: readonly string[]): RevealCanonicalMetadata[] {
    const saved = this.settings();
    if (!saved || !tokenIds.length) return [];
    const deployment = JSON.parse(saved.deployment_json) as EthereumRevealDeployment;
    const values: RevealCanonicalMetadata[] = [];
    let catalog: RevealAssetCatalog | undefined;
    const hasEnrichment = this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment'").toArray().length > 0;
    for (const tokenId of tokenIds) {
      const row = this.sql.exec<Assignment>('SELECT * FROM assignments WHERE token_id=?', tokenId).toArray()[0];
      if (!row) continue;
      const mapping = this.mapping({ category: row.category, assetId: row.asset_id });
      const revision = Math.max(row.assignment_revision ?? 0, mapping?.target_revision ?? 0);
      const publication = this.sql.exec<{ status: string; metadata_revision: number }>('SELECT status,metadata_revision FROM publication WHERE token_id=?', tokenId).toArray()[0];
      let artwork = JSON.parse(row.artwork_json) as EthereumRevealedArtwork;
      let metadataJson = row.metadata_json;
      let metadataRevision = 2 * revision;
      let category = row.category, assetId = row.asset_id;
      if (mapping) {
        if (mapping.attributes_json === null) throw new Error('Activated artwork attributes are missing.');
        category = mapping.category;
        assetId = mapping.asset_id;
        catalog ??= this.activeCatalog();
        const built = buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId, crateTokenId: row.crate_token_id,
          category, assetId, observation: artwork.observation, catalog });
        metadataJson = applyRevealAttributePayload(built.metadataJson, mapping.attributes_json).metadataJson;
        artwork = built.artwork;
        metadataRevision++;
      } else {
        const enriched = hasEnrichment ? this.sql.exec<{ target_json: string | null; target_sha256: string | null; assignment_revision?: number }>(
          'SELECT * FROM reveal_enrichment WHERE token_id=? AND version=?', tokenId, REVEAL_ENRICHMENT_VERSION).toArray()[0] : undefined;
        if (enriched?.target_json != null && (enriched.assignment_revision ?? 0) === revision && hash(enriched.target_json) === enriched.target_sha256) {
          metadataJson = enriched.target_json;
          metadataRevision++;
        }
      }
      const metadata = parseMetadataJson(metadataJson) as { attributes?: EthereumRevealedArtwork['attributes'] };
      artwork = { ...artwork, attributes: metadata.attributes, ...(metadataRevision ? { metadataRevision } : {}) };
      values.push({ tokenId, category, assetId, assignmentRevision: revision, metadataRevision, artwork, metadataJson,
        targetSha256: hash(metadataJson), expectedJsons: [...new Set([row.placeholder_json, row.metadata_json])],
        allowMissing: publication?.status !== 'published', migration: Boolean(mapping && (row.assignment_revision ?? 0) < mapping.target_revision) });
    }
    return values;
  }

  validateMetadataWrite(job: { tokenId: string; metadataRevision: number; metadataJson: string; expectedJsons: string[]; allowMissing: boolean }): boolean {
    const current = this.canonicalMetadata([job.tokenId])[0];
    return Boolean(current && current.metadataRevision === job.metadataRevision && current.metadataJson === job.metadataJson &&
      (!job.allowMissing || current.allowMissing) && job.expectedJsons.every(value => current.expectedJsons.includes(value)));
  }

  publicationPage(batchId: string, afterEggId = 0, pageSize = 8): RevealCatalogUpdatePublication[] {
    limit(pageSize);
    const operation = this.operation(batchId);
    if (operation.activated_at_ms === null) return [];
    const rows = this.sql.exec<{ egg_id: number; token_id: string }>(`SELECT m.egg_id,a.token_id FROM reveal_catalog_mappings m JOIN assignments a
      ON a.category='egg' AND a.asset_id=m.egg_id WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<?
      AND m.egg_id>? ORDER BY m.egg_id LIMIT ?`, batchId, operation.target_revision, afterEggId, pageSize).toArray();
    const canonical = new Map(this.canonicalMetadata(rows.map(row => row.token_id)).map(row => [row.tokenId, row]));
    return rows.map(row => ({ ...canonical.get(row.token_id)!, eggId: row.egg_id }));
  }

  pendingPublications(batchId: string, pageSize = 8, now = Date.now()): RevealCatalogUpdatePublication[] {
    limit(pageSize);
    const operation = this.operation(batchId);
    if (operation.activated_at_ms === null) return [];
    const rows = this.sql.exec<{ egg_id: number; token_id: string }>(`SELECT m.egg_id,a.token_id FROM reveal_catalog_mappings m JOIN assignments a
      ON a.category='egg' AND a.asset_id=m.egg_id LEFT JOIN reveal_catalog_publications p ON p.batch_id=m.batch_id AND p.token_id=a.token_id
      WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<? AND COALESCE(p.published,0)=0
      AND COALESCE(p.next_check_ms,0)<=? ORDER BY m.egg_id LIMIT ?`, batchId, operation.target_revision, now, pageSize).toArray();
    const canonical = new Map(this.canonicalMetadata(rows.map(row => row.token_id)).map(row => [row.tokenId, row]));
    return rows.map(row => ({ ...canonical.get(row.token_id)!, eggId: row.egg_id }));
  }

  acknowledgePublication(batchId: string, tokenId: string, metadataRevision: number, targetSha256: string): RevealCatalogUpdateStatus {
    this.transaction(() => {
      const operation = this.operation(batchId);
      const current = this.canonicalMetadata([tokenId])[0];
      if (operation.activated_at_ms === null || !current?.migration || current.assignmentRevision !== operation.target_revision ||
        current.metadataRevision !== metadataRevision || current.targetSha256 !== targetSha256) throw new Error('Stale catalog publication acknowledgment.');
      const previous = this.sql.exec<{ metadata_revision: number; target_sha256: string }>(
        'SELECT metadata_revision,target_sha256 FROM reveal_catalog_publications WHERE batch_id=? AND token_id=?', batchId, tokenId).toArray()[0];
      if (previous && (previous.metadata_revision !== metadataRevision || previous.target_sha256 !== targetSha256)) throw new Error('Catalog publication evidence changed.');
      this.sql.exec(`INSERT INTO reveal_catalog_publications(batch_id,token_id,metadata_revision,target_sha256,published)
        VALUES(?,?,?,?,1) ON CONFLICT(batch_id,token_id) DO UPDATE SET published=1,last_error=NULL,next_check_ms=0`,
        batchId, tokenId, metadataRevision, targetSha256);
      this.sql.exec("UPDATE publication SET status='published',metadata_revision=?,claim_id=NULL,last_error=NULL WHERE token_id=?", metadataRevision, tokenId);
    });
    return this.status(batchId)!;
  }

  failPublication(batchId: string, tokenId: string, metadataRevision: number, outcome: 'conflict' | 'retry', now: number): RevealCatalogUpdateStatus {
    const operation = this.operation(batchId);
    const current = this.canonicalMetadata([tokenId])[0];
    if (operation.activated_at_ms === null || !current?.migration || current.assignmentRevision !== operation.target_revision ||
      current.metadataRevision !== metadataRevision) return this.status(batchId)!;
    const old = this.sql.exec<{ attempts: number }>('SELECT attempts FROM reveal_catalog_publications WHERE batch_id=? AND token_id=?', batchId, tokenId).toArray()[0];
    const attempts = (old?.attempts ?? 0) + 1;
    this.sql.exec(`INSERT INTO reveal_catalog_publications(batch_id,token_id,metadata_revision,target_sha256,attempts,next_check_ms,last_error)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(batch_id,token_id) DO UPDATE SET attempts=excluded.attempts,next_check_ms=excluded.next_check_ms,last_error=excluded.last_error
      WHERE reveal_catalog_publications.published=0`, batchId, tokenId, metadataRevision, current.targetSha256, attempts,
      now + (outcome === 'conflict' ? 300_000 : Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 9))), outcome);
    return this.status(batchId)!;
  }

  private verifyGeneration(batchId: string): void {
    const operation = this.operation(batchId);
    const target = counts(JSON.parse(operation.target_manifest_json) as RevealAssetCatalog);
    const pools = this.sql.exec<RevealPool & { free: number; minimum: number | null; maximum: number | null }>(`SELECT p.category,p.total,p.seeded,p.available,
      (SELECT COUNT(*) FROM reveal_catalog_free f WHERE f.generation=p.generation AND f.category=p.category) AS free,
      (SELECT MIN(slot) FROM reveal_catalog_free f WHERE f.generation=p.generation AND f.category=p.category) AS minimum,
      (SELECT MAX(slot) FROM reveal_catalog_free f WHERE f.generation=p.generation AND f.category=p.category) AS maximum
      FROM reveal_catalog_pools p WHERE generation=?`, batchId).toArray();
    if (pools.length !== CATEGORIES.length || pools.some(row => row.total !== target[row.category] || row.seeded !== row.total ||
      row.available !== row.free || row.free > 0 && (row.minimum !== 0 || row.maximum !== row.free - 1)) ||
      pools.reduce((sum, row) => sum + row.total, 0) !== TOTAL) throw new Error('Catalog generation counters are inconsistent.');
    const assigned = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments').toArray()[0].count;
    if (pools.reduce((sum, row) => sum + row.available, 0) + assigned !== TOTAL ||
      this.sql.exec(`SELECT 1 FROM reveal_catalog_free f JOIN assignments a ON a.category=f.origin_category AND a.asset_id=f.origin_asset_id
        WHERE f.generation=? LIMIT 1`, batchId).toArray().length) throw new Error('Catalog allocation conservation failed.');
  }

  verify(batchId: string): RevealCatalogUpdateStatus {
    const operation = this.operation(batchId);
    const active = this.settings()?.active_catalog_generation;
    if (operation.activated_at_ms === null || !active) throw new Error('Catalog update is not active.');
    this.verifyGeneration(active);
    const status = this.status(batchId)!;
    if (status.published !== status.frozen) throw new Error('Catalog metadata publication is incomplete.');
    if (this.sql.exec(`SELECT 1 FROM reveal_catalog_publications p LEFT JOIN assignments a ON a.token_id=p.token_id
      LEFT JOIN reveal_catalog_mappings m ON m.batch_id=p.batch_id AND a.category='egg' AND a.asset_id=m.egg_id
      WHERE p.batch_id=? AND p.published=1 AND (m.egg_id IS NULL OR a.assignment_revision>=? OR p.metadata_revision!=?) LIMIT 1`,
      batchId, operation.target_revision, 2 * operation.target_revision + 1).toArray().length) throw new Error('Catalog publication evidence is inconsistent.');
    return status;
  }

  finalize(batchId: string): RevealCatalogUpdateStatus {
    this.verify(batchId);
    this.sql.exec("UPDATE reveal_catalog_generations SET phase='complete' WHERE batch_id=? AND phase='active'", batchId);
    return this.status(batchId)!;
  }

  cancel(batchId: string): RevealCatalogUpdateStatus {
    this.transaction(() => {
      const operation = this.operation(batchId);
      if (operation.activated_at_ms !== null) throw new Error('An activated catalog update must resume forward.');
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='cancelled' WHERE batch_id=?", batchId);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=NULL WHERE id=1 AND candidate_catalog_generation=?', batchId);
    });
    return this.status(batchId)!;
  }

  prune(batchId: string, pageSize = 256): { remaining: number } {
    limit(pageSize);
    const operation = this.operation(batchId);
    if (!['complete', 'cancelled'].includes(operation.phase)) throw new Error('Finish or cancel the operation before pruning.');
    const saved = this.settings()!;
    this.transaction(() => {
      this.sql.exec(`DELETE FROM reveal_catalog_free WHERE rowid IN (SELECT rowid FROM reveal_catalog_free WHERE generation!=?
        AND generation!=? LIMIT ?)`, saved.active_catalog_generation ?? '', saved.candidate_catalog_generation ?? '', pageSize);
      this.sql.exec(`DELETE FROM reveal_catalog_pools WHERE generation!=? AND generation!=? AND
        NOT EXISTS(SELECT 1 FROM reveal_catalog_free f WHERE f.generation=reveal_catalog_pools.generation)`,
        saved.active_catalog_generation ?? '', saved.candidate_catalog_generation ?? '');
      if (saved.active_catalog_generation) {
        this.sql.exec('DELETE FROM free_slots WHERE rowid IN (SELECT rowid FROM free_slots LIMIT ?)', pageSize);
        if (!this.sql.exec('SELECT 1 FROM free_slots LIMIT 1').toArray().length) this.sql.exec('DELETE FROM pools');
      }
    });
    const count = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM reveal_catalog_free WHERE generation!=? AND generation!=?`,
      saved.active_catalog_generation ?? '', saved.candidate_catalog_generation ?? '').toArray()[0].count;
    const legacy = saved.active_catalog_generation ? this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM free_slots').toArray()[0].count : 0;
    return { remaining: count + legacy };
  }

  pruneObsolete(pageSize = 256): { remaining: number } {
    const row = this.sql.exec<{ batch_id: string }>("SELECT batch_id FROM reveal_catalog_generations WHERE phase IN ('complete','cancelled') ORDER BY rowid DESC LIMIT 1").toArray()[0];
    return row ? this.prune(row.batch_id, pageSize) : { remaining: 0 };
  }

  status(batchId?: string): RevealCatalogUpdateStatus | null {
    if (!this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_catalog_generations'").toArray().length) return null;
    const row = batchId ? this.sql.exec<Operation>('SELECT * FROM reveal_catalog_generations WHERE batch_id=?', batchId).toArray()[0]
      : this.sql.exec<Operation>('SELECT * FROM reveal_catalog_generations ORDER BY rowid DESC LIMIT 1').toArray()[0];
    if (!row) return null;
    const progress = this.sql.exec<{ mapped: number; staged: number }>(`SELECT COUNT(*) AS mapped,
      COALESCE(SUM(attributes_json IS NOT NULL),0) AS staged FROM reveal_catalog_mappings WHERE batch_id=?`, row.batch_id).toArray()[0];
    const publications = this.sql.exec<{ published: number; retrying: number; conflicts: number }>(`SELECT COALESCE(SUM(published),0) AS published,
      COALESCE(SUM(published=0 AND last_error='retry'),0) AS retrying,COALESCE(SUM(published=0 AND last_error='conflict'),0) AS conflicts
      FROM reveal_catalog_publications WHERE batch_id=?`, row.batch_id).toArray()[0];
    return { batchId: row.batch_id, batchSha256: row.batch_sha256, predecessor: JSON.parse(row.predecessor_json), target: JSON.parse(row.target_json),
      sourceRevision: row.source_revision, targetRevision: row.target_revision, startedAtMs: row.started_at_ms,
      activatedAtMs: row.activated_at_ms, phase: row.phase, total: row.mapping_count, mapped: progress.mapped,
      metadataStaged: progress.staged, generationSeeded: row.seeded, frozen: row.frozen_count, ...publications };
  }
}
