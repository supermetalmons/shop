import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.js';
import type { RevealAssetCatalog, RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { validateRevealCatalogUpdateBatch, type RevealCatalogUpdateBatch, type RevealCatalogUpdateMapping } from '../../../../shared/ethereum/revealCatalogUpdate.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { RevealSql } from './ethereumRevealStore.js';
import { buildRevealedArtwork, revealRandomInteger } from './ethereumRevealCatalog.js';
import { metadataNumber, parseMetadataJson } from './ethereumMetadataJson.js';
import { applyRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import { EthereumOwnerHatchingStore } from './ethereumOwnerHatchingStore.js';
import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.js';

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
  mode?: 'empty-rebuild'; categoryCounts?: Record<EthereumArtworkCategory, number>;
};
type Operation = {
  batch_id: string; batch_sha256: string; predecessor_json: string; target_json: string; target_manifest_json: string;
  source_revision: number; target_revision: number; mapping_count: number; mapping_sha256: string; phase: RevealCatalogUpdateStatus['phase'];
  started_at_ms: number; activated_at_ms: number | null; seeded: number; frozen_count: number; mode?: 'online' | 'empty-rebuild';
  batch_version: number; egg_cutoff: number | null;
};
type Mapping = { batch_id: string; egg_id: number; category: EthereumArtworkCategory; asset_id: number;
  attributes_json: string | null; attributes_sha256: string | null; origin_category: EthereumArtworkCategory | null; origin_asset_id: number | null };
type Assignment = { category: EthereumArtworkCategory; asset_id: number; token_id: string; crate_token_id: string;
  artwork_json: string; metadata_json: string; placeholder_json: string; frozen_at_ms: number; assignment_revision: number };
const CATEGORIES = ['egg', 'painting', 'video', '3d', 'animated'] as const;
const TOTAL = 111_111;
const ALLOCATION_BASE_REVISION = `COALESCE((SELECT target_revision FROM reveal_catalog_generations
  WHERE batch_id=(SELECT allocation_base_generation FROM settings WHERE id=1)),0)`;
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

export class EthereumRevealCatalogUpdateStore {
  private originCounts: { generation: string | null; counts: Record<EthereumArtworkCategory, number> } | undefined;
  private mappingOriginsAvailable: boolean | undefined;
  private readonly catalogs = new Map<string, RevealAssetCatalog>();
  readonly ownerHatching: EthereumOwnerHatchingStore;
  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T) {
    this.ownerHatching = new EthereumOwnerHatchingStore(sql, transaction, {
      canonical: tokenId => this.canonicalMetadataBase([tokenId])[0] ?? null,
      originForToken: tokenId => {
        const row = this.sql.exec<Assignment>('SELECT * FROM assignments WHERE token_id=?', tokenId).toArray()[0];
        if (!row) throw new Error('Owner hatch origin is unavailable.');
        return { category: row.category, assetId: row.asset_id };
      },
      build: (tokenId, asset, original) => {
        const deployment = JSON.parse(this.settings()!.deployment_json) as EthereumRevealDeployment;
        const built = buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId,
          crateTokenId: original.artwork.crateTokenId, category: asset.category, assetId: asset.assetId,
          observation: original.artwork.observation, catalog: this.activeCatalog(), ownerHatching: true });
        const grail = getOwnerHatchingGrail(asset.category, asset.assetId);
        const block = grail?.collectionBlock ?? lookupRevealCollectionBlock(revealCollectionBlocks(this.effectiveCatalog()), asset.category, asset.assetId);
        built.artwork.collectionBlock = block;
        return { artwork: built.artwork,
          metadataJson: asset.attributesJson ? applyRevealAttributePayload(built.metadataJson, asset.attributesJson).metadataJson : built.metadataJson };
      },
      takeOrdinary: () => {
        const pools = this.pools().filter(pool => pool.category !== 'egg' && pool.available > 0);
        const available = pools.reduce((sum, pool) => sum + pool.available, 0);
        if (!available) return null;
        let selection = revealRandomInteger(available);
        const pool = pools.find(value => { selection -= value.available; return selection < 0; })!;
        const origin = this.takeFree(pool.category, revealRandomInteger(pool.available));
        const effective = this.resolveUnit(origin);
        if (effective.category === 'egg' || getOwnerHatchingGrail(effective.category, effective.assetId)) {
          throw new Error('Ordinary hatch inventory is inconsistent.');
        }
        return { origin, effective: { category: effective.category, assetId: effective.assetId } };
      },
      transitionSlot: (origin, before, after) => this.transitionOwnerSlot(origin, before, after),
      releaseReplacement: origin => this.releaseFree(origin),
      freshEggAvailable: eggId => this.freshOwnerEggAvailable(eggId),
      eligibleEgg: (_tokenId, eggId) => Boolean(this.settings()?.active_catalog_generation) &&
        !this.sql.exec(`SELECT 1 FROM (SELECT batch_id,egg_id FROM reveal_catalog_egg_claims
          UNION ALL SELECT batch_id,egg_id FROM reveal_catalog_mappings) m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
          WHERE m.egg_id=? AND g.phase IN ('mapping','staging','ready') LIMIT 1`, eggId).toArray().length,
    });
  }

  freshOwnerEggAvailable(eggId: number): boolean {
    const saved = this.settings();
    if (!saved) return false;
    const deployment = JSON.parse(saved.deployment_json) as EthereumRevealDeployment;
    const original = getRevealCatalog(deployment.catalogVersion);
    return Number.isSafeInteger(eggId) && eggId > Math.max(original?.categories.eggs.count ?? Infinity,
      this.activeCatalog().categories.eggs.count) && eggId <= this.activeCatalog().importSettings.availableEggs &&
      !this.ownerHatching.usedFreshEgg(eggId) && !this.ownerHatching.isRetiredEgg(eggId);
  }

  private transitionOwnerSlot(origin: RevealOriginUnit, before: RevealOriginUnit, after: RevealOriginUnit): void {
    if (before.category === after.category) return;
    const saved = this.settings()!;
    if (!saved.active_catalog_generation) throw new Error('Owner hatching requires a canonical inventory generation.');
    for (const generation of [saved.active_catalog_generation, saved.candidate_catalog_generation].filter((value): value is string => Boolean(value))) {
      const seeded = generation === saved.active_catalog_generation || this.ordinal(origin) <= this.operation(generation).seeded;
      this.sql.exec('UPDATE reveal_catalog_pools SET total=total+1,seeded=seeded+? WHERE generation=? AND category=?',
        Number(seeded), generation, after.category);
      this.sql.exec('UPDATE reveal_catalog_pools SET total=total-1,seeded=seeded-? WHERE generation=? AND category=?',
        Number(seeded), generation, before.category);
    }
  }

  initialize(): void {
    this.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(settings)').toArray().map(row => row.name));
      for (const [name, type] of [['effective_catalog_version', 'TEXT'], ['effective_catalog_sha256', 'TEXT'],
        ['catalog_revision', 'INTEGER NOT NULL DEFAULT 0'], ['active_catalog_generation', 'TEXT'], ['candidate_catalog_generation', 'TEXT'],
        ['allocation_base_generation', 'TEXT']]) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE settings ADD COLUMN ${name} ${type}`);
      }
      if (!this.sql.exec<{ name: string }>('PRAGMA table_info(reveal_catalog_generations)').toArray().some(row => row.name === 'mode')) {
        this.sql.exec("ALTER TABLE reveal_catalog_generations ADD COLUMN mode TEXT NOT NULL DEFAULT 'online' CHECK(mode IN ('online','empty-rebuild'))");
      }
      for (const [table, name, type] of [
        ['reveal_catalog_generations', 'batch_version', 'INTEGER NOT NULL DEFAULT 1'],
        ['reveal_catalog_generations', 'egg_cutoff', 'INTEGER'],
        ['reveal_catalog_mappings', 'origin_category', 'TEXT'],
        ['reveal_catalog_mappings', 'origin_asset_id', 'INTEGER'],
      ]) {
        if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === name)) {
          this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        }
      }
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS reveal_catalog_mapping_origin_unit ON reveal_catalog_mappings
        (batch_id,COALESCE(origin_category,'egg'),COALESCE(origin_asset_id,egg_id))`);
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_catalog_explicit_identity BEFORE UPDATE ON reveal_catalog_generations
        WHEN NEW.batch_version IS NOT OLD.batch_version OR NEW.egg_cutoff IS NOT OLD.egg_cutoff
        BEGIN SELECT RAISE(ABORT,'Catalog generation identity is immutable'); END`);
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_catalog_mapping_origin_identity BEFORE UPDATE ON reveal_catalog_mappings
        WHEN NEW.origin_category IS NOT OLD.origin_category OR NEW.origin_asset_id IS NOT OLD.origin_asset_id
        BEGIN SELECT RAISE(ABORT,'Catalog mapping origin is immutable'); END`);
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS reveal_catalog_mode_immutable BEFORE UPDATE ON reveal_catalog_generations
        WHEN NEW.mode IS NOT OLD.mode BEGIN SELECT RAISE(ABORT,'Catalog generation mode is immutable'); END`);
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
    this.mappingOriginsAvailable = true;
    this.ownerHatching.initialize();
  }

  private hasTable(name: string): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", name).toArray().length > 0;
  }

  private mappingOriginJoin(): string {
    if (!this.mappingOriginsAvailable) {
      const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(reveal_catalog_mappings)').toArray();
      this.mappingOriginsAvailable = columns.some(row => row.name === 'origin_category') && columns.some(row => row.name === 'origin_asset_id');
    }
    return this.mappingOriginsAvailable
      ? "a.category=COALESCE(m.origin_category,'egg') AND a.asset_id=COALESCE(m.origin_asset_id,m.egg_id)"
      : "a.category='egg' AND a.asset_id=m.egg_id";
  }

  private settings(): { deployment_json: string; catalog_revision: number; active_catalog_generation: string | null;
    candidate_catalog_generation: string | null; allocation_base_generation: string | null;
    effective_catalog_version: string | null; effective_catalog_sha256: string | null } | null {
    if (!this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='settings'").toArray().length) return null;
    const row = this.sql.exec<{ deployment_json: string; catalog_revision?: number; active_catalog_generation?: string | null;
      candidate_catalog_generation?: string | null; allocation_base_generation?: string | null;
      effective_catalog_version?: string | null; effective_catalog_sha256?: string | null }>(
      'SELECT * FROM settings WHERE id=1').toArray()[0];
    return row ? { deployment_json: row.deployment_json, catalog_revision: row.catalog_revision ?? 0,
      active_catalog_generation: row.active_catalog_generation ?? null, candidate_catalog_generation: row.candidate_catalog_generation ?? null,
      allocation_base_generation: row.allocation_base_generation ?? null,
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
    const saved = this.settings();
    const generation = saved?.allocation_base_generation ?? null;
    if (this.originCounts?.generation === generation) return this.originCounts.counts;
    const origin = saved && JSON.parse(saved.deployment_json) as EthereumRevealDeployment | null;
    const catalog = generation ? JSON.parse(this.operation(generation).target_manifest_json) as RevealAssetCatalog
      : origin && getRevealCatalog(origin.catalogVersion);
    if (!catalog) throw new Error('Original catalog is unavailable.');
    this.originCounts = { generation, counts: counts(catalog) };
    return this.originCounts.counts;
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
    unit = this.ownerHatching.available ? this.ownerHatching.slotOverride(unit) ?? unit : unit;
    if (unit.category !== 'egg') return;
    return this.sql.exec<Mapping & { target_revision: number }>(`SELECT m.*,g.target_revision FROM reveal_catalog_mappings m
      JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id WHERE m.egg_id=? AND
      g.target_revision>${ALLOCATION_BASE_REVISION} AND (g.activated_at_ms IS NOT NULL OR g.batch_id=?) ORDER BY g.target_revision DESC LIMIT 1`,
      unit.assetId, candidate ?? '').toArray()[0];
  }

  resolveUnit(unit: RevealOriginUnit, assignmentRevision = this.settings()?.catalog_revision ?? 0, candidate?: string): RevealEffectiveUnit {
    unit = this.ownerHatching.available ? this.ownerHatching.slotOverride(unit) ?? unit : unit;
    const mapping = unit.category === 'egg' ? this.sql.exec<{ category: EthereumArtworkCategory; asset_id: number; target_revision: number }>(
      `SELECT m.category,m.asset_id,g.target_revision FROM reveal_catalog_mappings m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
        WHERE m.egg_id=? AND g.target_revision>${ALLOCATION_BASE_REVISION} AND (g.activated_at_ms IS NOT NULL OR g.batch_id=?) ORDER BY g.target_revision DESC LIMIT 1`,
      unit.assetId, candidate ?? '').toArray()[0] : undefined;
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
        const owner = this.ownerHatching.canonical(row.token_id);
        if (owner) {
          values.set(row.token_id, owner.artwork);
          continue;
        }
        const effective = this.resolveUnit({ category: row.category, assetId: row.asset_id }, row.assignment_revision ?? 0);
        let artwork = JSON.parse(row.artwork_json) as EthereumRevealedArtwork;
        if (effective.category !== row.category || effective.assetId !== row.asset_id) {
          catalog ??= this.activeCatalog();
          artwork = buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId: row.token_id, crateTokenId: row.crate_token_id,
            category: effective.category, assetId: effective.assetId, observation: artwork.observation, catalog,
            ownerHatching: this.ownerHatching.slotOverride({ category: row.category, assetId: row.asset_id }) !== null }).artwork;
        }
        const metadataRevision = 2 * effective.assignmentRevision;
        const canonical = { ...artwork, ...(metadataRevision ? { metadataRevision } : {}) };
        if (options?.includeCollectionBlock) canonical.collectionBlock = getOwnerHatchingGrail(effective.category, effective.assetId)?.collectionBlock
          ?? lookupRevealCollectionBlock(collectionBlocks, effective.category, effective.assetId);
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
      if (saved.candidate_catalog_generation && this.operation(saved.candidate_catalog_generation).mode === 'empty-rebuild') {
        throw new Error('Empty pool rebuild is fenced.');
      }
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
      if (saved.candidate_catalog_generation && this.operation(saved.candidate_catalog_generation).mode === 'empty-rebuild') {
        throw new Error('Empty pool rebuild is fenced.');
      }
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

  private assertEmptyRebuildInventory(): void {
    const saved = this.settings();
    if (!saved || (JSON.parse(saved.deployment_json) as EthereumRevealDeployment).chainId !== 1) {
      throw new Error('Empty pool rebuild requires a mainnet deployment.');
    }
    if (this.sql.exec('SELECT 1 FROM assignments LIMIT 1').toArray().length ||
      this.sql.exec('SELECT 1 FROM publication LIMIT 1').toArray().length) {
      throw new Error('Empty pool rebuild requires zero assignments, reservations, and publications.');
    }
  }

  private emptyRebuildOperation(operationId: string): Operation {
    const operation = this.operation(operationId);
    if (operation.mode !== 'empty-rebuild') throw new Error('Catalog operation is not an empty pool rebuild.');
    return operation;
  }

  beginEmptyRebuild(input: { operationId: string; batch: RevealCatalogUpdateBatch; now?: number }): RevealCatalogUpdateStatus {
    const { operationId, batch, now = Date.now() } = input;
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(operationId) || operationId === batch.batchId) {
      throw new Error('Empty pool rebuild requires a distinct operation identity.');
    }
    validateRevealCatalogUpdateBatch(batch);
    this.initialize();
    const existing = this.status(operationId);
    if (existing) {
      if (existing.mode !== 'empty-rebuild' || existing.batchSha256 !== batch.batchSha256 || existing.phase === 'cancelled') {
        throw new Error('Empty pool rebuild replay does not match.');
      }
      return existing;
    }
    return this.transaction(() => {
      this.assertEmptyRebuildInventory();
      const saved = this.settings()!;
      const current = this.effectiveCatalog()!;
      if (saved.candidate_catalog_generation || current.catalogVersion !== batch.predecessor.descriptor.catalogVersion ||
        current.manifestSha256 !== batch.predecessor.descriptor.manifestSha256) throw new Error('Empty pool rebuild predecessor changed.');
      if (!getRevealCatalog(batch.target.descriptor.catalogVersion, batch.target.descriptor.manifestSha256)) {
        throw new Error('Empty pool rebuild target is not supported.');
      }
      if (!this.sql.exec('SELECT 1 FROM settings WHERE id=1 AND ready=1').toArray().length) throw new Error('Reveal inventory is not ready.');
      if (this.sql.exec("SELECT 1 FROM reveal_catalog_generations WHERE phase='active' LIMIT 1").toArray().length) {
        throw new Error('Finish the previous catalog operation first.');
      }
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,mode)
        VALUES(?,?,?,?,?,?,?,0,?,'staging',?,'empty-rebuild')`, operationId, batch.batchSha256,
        JSON.stringify(batch.predecessor.descriptor), JSON.stringify(batch.target.descriptor), JSON.stringify(batch.target.manifest),
        current.catalogRevision, current.catalogRevision + 1, hash('[]'), now);
      const target = counts(batch.target.manifest);
      for (const category of CATEGORIES) this.sql.exec('INSERT INTO reveal_catalog_pools(generation,category,total) VALUES(?,?,?)',
        operationId, category, target[category]);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=? WHERE id=1', operationId);
      return this.status(operationId)!;
    });
  }

  stageEmptyRebuild(operationId: string, pageSize = 4096): RevealCatalogUpdateStatus {
    limit(pageSize, 4096);
    return this.transaction(() => {
      const operation = this.emptyRebuildOperation(operationId);
      if (['ready', 'active', 'complete'].includes(operation.phase)) return this.status(operationId)!;
      this.assertEmptyRebuildInventory();
      const saved = this.settings()!;
      if (operation.phase !== 'staging' || saved.candidate_catalog_generation !== operationId ||
        saved.catalog_revision !== operation.source_revision) throw new Error('Empty pool rebuild is not staging.');
      let remaining = pageSize;
      let seeded = operation.seeded;
      const pools = this.sql.exec<RevealPool>('SELECT category,total,seeded,available FROM reveal_catalog_pools WHERE generation=? ORDER BY category', operationId).toArray();
      if (pools.length !== CATEGORIES.length || pools.reduce((sum, pool) => sum + pool.seeded, 0) !== seeded) {
        throw new Error('Empty pool rebuild counters are inconsistent.');
      }
      for (const pool of pools) {
        const count = Math.min(remaining, pool.total - pool.seeded);
        if (!count) continue;
        if (count < 0 || pool.seeded !== pool.available) throw new Error('Empty pool rebuild counters are inconsistent.');
        this.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT ? UNION ALL SELECT id+1 FROM ids WHERE id<?)
          INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
          SELECT ?,?,id-1,?,id,id FROM ids`, pool.seeded + 1, pool.seeded + count, operationId, pool.category, pool.category);
        this.sql.exec('UPDATE reveal_catalog_pools SET seeded=seeded+?,available=available+? WHERE generation=? AND category=?',
          count, count, operationId, pool.category);
        seeded += count;
        remaining -= count;
        if (!remaining) break;
      }
      this.sql.exec('UPDATE reveal_catalog_generations SET seeded=? WHERE batch_id=?', seeded, operationId);
      return this.status(operationId)!;
    });
  }

  verifyEmptyRebuild(operationId: string): RevealCatalogUpdateStatus {
    const operation = this.emptyRebuildOperation(operationId);
    this.assertEmptyRebuildInventory();
    const saved = this.settings()!;
    if (operation.seeded !== TOTAL || operation.phase === 'cancelled' ||
      (operation.activated_at_ms === null
        ? saved.candidate_catalog_generation !== operationId || saved.catalog_revision !== operation.source_revision
        : saved.active_catalog_generation !== operationId || saved.allocation_base_generation !== operationId ||
          saved.catalog_revision !== operation.target_revision)) throw new Error('Empty pool rebuild generation is incomplete or stale.');
    this.verifyGeneration(operationId);
    if (operation.mapping_count !== 0 || operation.mapping_sha256 !== hash('[]') || operation.frozen_count !== 0 ||
      this.sql.exec('SELECT 1 FROM reveal_catalog_mappings WHERE batch_id=? LIMIT 1', operationId).toArray().length ||
      this.sql.exec('SELECT 1 FROM reveal_catalog_publications WHERE batch_id=? LIMIT 1', operationId).toArray().length) {
      throw new Error('Empty pool rebuild cannot contain mappings or publications.');
    }
    if (this.sql.exec(`SELECT 1 FROM reveal_catalog_free f JOIN reveal_catalog_pools p
      ON p.generation=f.generation AND p.category=f.category WHERE f.generation=? AND
      (f.origin_category!=f.category OR f.origin_asset_id!=f.asset_id OR f.asset_id<1 OR f.asset_id>p.total OR f.slot!=f.asset_id-1) LIMIT 1`,
      operationId).toArray().length) throw new Error('Empty pool rebuild asset identities are inconsistent.');
    return this.status(operationId)!;
  }

  sealEmptyRebuild(operationId: string): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.emptyRebuildOperation(operationId);
      if (operation.phase === 'ready') return this.verifyEmptyRebuild(operationId);
      if (operation.phase !== 'staging') throw new Error('Empty pool rebuild is not staging.');
      this.verifyEmptyRebuild(operationId);
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='ready' WHERE batch_id=?", operationId);
      return this.status(operationId)!;
    });
  }

  activateEmptyRebuild(operationId: string, now = Date.now()): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.emptyRebuildOperation(operationId);
      if (operation.activated_at_ms !== null) return this.status(operationId)!;
      if (operation.phase !== 'ready') throw new Error('Empty pool rebuild is not ready.');
      this.verifyEmptyRebuild(operationId);
      const target = JSON.parse(operation.target_json) as RevealAssetCatalogDescriptor;
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='active',activated_at_ms=? WHERE batch_id=?", now, operationId);
      this.sql.exec(`UPDATE settings SET active_catalog_generation=?,allocation_base_generation=?,candidate_catalog_generation=NULL,
        effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=? WHERE id=1`,
        operationId, operationId, target.catalogVersion, target.manifestSha256, operation.target_revision);
      this.originCounts = undefined;
      return this.status(operationId)!;
    });
  }

  pruneEmptyRebuild(operationId: string, pageSize = 4096): { remaining: number } {
    this.emptyRebuildOperation(operationId);
    return this.prune(operationId, pageSize);
  }

  private effectiveEggOrigin(eggId: number): RevealOriginUnit | null {
    const override = this.sql.exec<{ origin_category: EthereumArtworkCategory; origin_asset_id: number }>(
      "SELECT origin_category,origin_asset_id FROM owner_hatching_slot_overrides WHERE category='egg' AND asset_id=?", eggId).toArray()[0];
    const unit: RevealOriginUnit = override ? { category: override.origin_category, assetId: override.origin_asset_id } : { category: 'egg', assetId: eggId };
    if (!override && eggId > this.originalCounts().egg) return null;
    const effective = this.resolveUnit(unit);
    if (effective.category !== 'egg' || effective.assetId !== eggId || !this.isFree(unit) &&
      !this.sql.exec('SELECT 1 FROM assignments WHERE category=? AND asset_id=?', unit.category, unit.assetId).toArray().length) return null;
    return unit;
  }

  eligibleCutoffEggs(cutoff: number, afterEggId = cutoff, pageSize = 256): number[] {
    limit(pageSize);
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isSafeInteger(afterEggId) || afterEggId < cutoff) throw new Error('Invalid cutoff egg page.');
    const settings = this.settings();
    if (!settings) return [];
    const active = settings.active_catalog_generation;
    const owner = this.ownerHatching.available;
    const mapped = this.hasTable('reveal_catalog_mappings');
    const claimed = this.hasTable('reveal_catalog_egg_claims');
    const free = active ? 'SELECT asset_id AS egg_id FROM reveal_catalog_free WHERE generation=? AND category=\'egg\''
      : 'SELECT asset_id AS egg_id FROM free_slots WHERE category=\'egg\'';
    const assigned = owner ? `SELECT COALESCE(o.asset_id,a.asset_id) AS egg_id FROM assignments a LEFT JOIN owner_hatching_slot_overrides o
      ON o.origin_category=a.category AND o.origin_asset_id=a.asset_id WHERE COALESCE(o.category,a.category)='egg'`
      : "SELECT asset_id AS egg_id FROM assignments WHERE category='egg'";
    return this.sql.exec<{ egg_id: number }>(`WITH candidates AS (${free} UNION ${assigned})
      SELECT egg_id FROM candidates c WHERE egg_id>?
        ${owner ? `AND NOT EXISTS(SELECT 1 FROM owner_hatching_tokens t WHERE t.egg_id=c.egg_id)
          AND NOT EXISTS(SELECT 1 FROM owner_hatching_retired_eggs r WHERE r.egg_id=c.egg_id)` : ''}
        ${mapped ? `AND NOT EXISTS(SELECT 1 FROM reveal_catalog_mappings m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
          WHERE m.egg_id=c.egg_id AND (g.target_revision>${ALLOCATION_BASE_REVISION} AND g.activated_at_ms IS NOT NULL
            OR g.phase IN ('mapping','staging','ready')))` : ''}
        ${claimed ? `AND NOT EXISTS(SELECT 1 FROM reveal_catalog_egg_claims m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
          WHERE m.egg_id=c.egg_id AND g.phase IN ('mapping','staging','ready'))` : ''}
        ORDER BY egg_id LIMIT ?`, ...(active ? [active] : []), afterEggId, pageSize).toArray().map(row => row.egg_id);
  }

  private requireCutoffEgg(eggId: number): RevealOriginUnit {
    if (this.ownerHatching.hasProtectedEgg(eggId)) throw new Error('Cutoff egg is protected by owner hatching.');
    const unit = this.effectiveEggOrigin(eggId);
    if (!unit) throw new Error('Cutoff egg is not a live allocation.');
    return unit;
  }

  private verifyCutoffClaims(batchId: string): void {
    if (!this.ownerHatching.hasBatch()) return;
    const active = this.settings()?.active_catalog_generation;
    const free = active ? `SELECT 1 FROM reveal_catalog_free f WHERE f.generation=? AND f.origin_category=b.origin_category AND f.origin_asset_id=b.origin_asset_id`
      : 'SELECT 1 FROM free_slots f WHERE f.category=b.origin_category AND f.asset_id=b.origin_asset_id';
    const invalid = this.sql.exec(`WITH bases AS (SELECT m.egg_id,COALESCE(m.origin_category,'egg') AS origin_category,
        COALESCE(m.origin_asset_id,m.egg_id) AS origin_asset_id,COALESCE(o.category,m.origin_category,'egg') AS effective_category,
        COALESCE(o.asset_id,m.origin_asset_id,m.egg_id) AS effective_asset_id FROM reveal_catalog_mappings m
        LEFT JOIN owner_hatching_slot_overrides o ON o.origin_category=COALESCE(m.origin_category,'egg')
          AND o.origin_asset_id=COALESCE(m.origin_asset_id,m.egg_id) WHERE m.batch_id=?)
      SELECT 1 FROM bases b WHERE b.effective_category!='egg' OR b.effective_asset_id!=b.egg_id
        OR EXISTS(SELECT 1 FROM owner_hatching_tokens t WHERE t.egg_id=b.egg_id)
        OR EXISTS(SELECT 1 FROM owner_hatching_retired_eggs r WHERE r.egg_id=b.egg_id)
        OR EXISTS(SELECT 1 FROM reveal_catalog_mappings m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
          WHERE m.egg_id=b.egg_id AND g.activated_at_ms IS NOT NULL AND g.target_revision>${ALLOCATION_BASE_REVISION})
        OR (NOT EXISTS(SELECT 1 FROM assignments a WHERE a.category=b.origin_category AND a.asset_id=b.origin_asset_id)
          AND NOT EXISTS(${free})) LIMIT 1`, batchId, ...(active ? [active] : [])).toArray().length;
    if (invalid) throw new Error('Cutoff egg allocation changed or became protected.');
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
      const origins = batch.mappings.map(mapping => this.requireCutoffEgg(mapping.eggId));
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,batch_version,egg_cutoff) VALUES(?,?,?,?,?,?,?,?,?,'mapping',?,?,?)`,
        batch.batchId, batch.batchSha256, JSON.stringify(batch.predecessor.descriptor), JSON.stringify(batch.target.descriptor),
        JSON.stringify(batch.target.manifest), current.catalogRevision, current.catalogRevision + 1, batch.mappings.length,
        hash(JSON.stringify(batch.mappings.map(row => ({ eggId: row.eggId, category: row.category, assetId: row.assetId })))), now,
        batch.version, batch.version === 2 ? batch.eggCutoff : null);
      const targetCounts = Object.fromEntries(this.pools().map(pool => [pool.category, pool.total])) as Record<EthereumArtworkCategory, number>;
      for (const [index, mapping] of batch.mappings.entries()) {
        targetCounts.egg--;
        targetCounts[mapping.category]++;
        this.sql.exec('INSERT INTO reveal_catalog_egg_claims(batch_id,egg_id,origin_category,origin_asset_id) VALUES(?,?,?,?)',
          batch.batchId, mapping.eggId, origins[index].category, origins[index].assetId);
      }
      for (const category of CATEGORIES) this.sql.exec('INSERT INTO reveal_catalog_pools(generation,category,total) VALUES(?,?,?)',
        batch.batchId, category, targetCounts[category]);
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
        if (!Number.isSafeInteger(mapping.eggId) || (operation.batch_version === 2
          ? mapping.eggId <= (operation.egg_cutoff ?? -1) || mapping.eggId > predecessor.importSettings.availableEggs
          : mapping.eggId <= after.egg || mapping.eggId > before.egg) ||
          mapping.category === ('egg' as string) || !Object.hasOwn(after, mapping.category) || !Number.isSafeInteger(mapping.assetId) ||
          mapping.assetId <= before[mapping.category] || mapping.assetId > after[mapping.category] ||
          getOwnerHatchingGrail(mapping.category, mapping.assetId)) throw new Error('Invalid replacement mapping.');
        const origin = this.requireCutoffEgg(mapping.eggId);
        const claim = this.sql.exec<{ origin_category: EthereumArtworkCategory; origin_asset_id: number }>(
          'SELECT origin_category,origin_asset_id FROM reveal_catalog_egg_claims WHERE batch_id=? AND egg_id=?', batchId, mapping.eggId).toArray()[0];
        if (claim && (claim.origin_category !== origin.category || claim.origin_asset_id !== origin.assetId) || operation.batch_version === 2 && !claim) {
          throw new Error('Cutoff mapping does not match its frozen egg claim.');
        }
        const previous = this.sql.exec<Mapping>('SELECT * FROM reveal_catalog_mappings WHERE batch_id=? AND egg_id=?', batchId, mapping.eggId).toArray()[0];
        if (previous) {
          if (previous.category !== mapping.category || previous.asset_id !== mapping.assetId) throw new Error('Catalog mapping replay changed.');
        } else this.sql.exec('INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id,origin_category,origin_asset_id) VALUES(?,?,?,?,?,?)',
          batchId, mapping.eggId, mapping.category, mapping.assetId, origin.category, origin.assetId);
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
        if (new TextEncoder().encode(row.attributesJson).byteLength > MAX_REVEAL_METADATA_BYTES || hash(row.attributesJson) !== row.sha256 ||
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
      if (operation.mode === 'empty-rebuild') throw new Error('Use empty pool rebuild staging.');
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
    if (operation.mode === 'empty-rebuild') throw new Error('Use empty pool rebuild sealing.');
    if (operation.phase === 'ready') return this.status(batchId)!;
    if (operation.phase !== 'staging' || operation.seeded !== TOTAL) throw new Error('Catalog generation is incomplete.');
    this.verifyCutoffClaims(batchId);
    this.verifyGeneration(batchId);
    this.sql.exec("UPDATE reveal_catalog_generations SET phase='ready' WHERE batch_id=?", batchId);
    return this.status(batchId)!;
  }

  activate(batchId: string, now = Date.now()): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.operation(batchId);
      if (operation.mode === 'empty-rebuild') throw new Error('Use empty pool rebuild activation.');
      if (operation.activated_at_ms !== null) return this.status(batchId)!;
      const saved = this.settings()!;
      if (operation.phase !== 'ready' || saved.candidate_catalog_generation !== batchId || saved.catalog_revision !== operation.source_revision) {
        throw new Error('Catalog generation cannot activate.');
      }
      this.verifyCutoffClaims(batchId);
      const frozen = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM assignments a JOIN reveal_catalog_mappings m
        ON a.category=COALESCE(m.origin_category,'egg') AND a.asset_id=COALESCE(m.origin_asset_id,m.egg_id)
        WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<?`, batchId, operation.target_revision).toArray()[0].count;
      const target = JSON.parse(operation.target_json) as RevealAssetCatalogDescriptor;
      this.sql.exec(`UPDATE reveal_catalog_generations SET phase='active',activated_at_ms=?,frozen_count=? WHERE batch_id=?`, now, frozen, batchId);
      this.sql.exec(`UPDATE settings SET active_catalog_generation=?,candidate_catalog_generation=NULL,effective_catalog_version=?,
        effective_catalog_sha256=?,catalog_revision=? WHERE id=1`, batchId, target.catalogVersion, target.manifestSha256, operation.target_revision);
      return this.status(batchId)!;
    });
  }

  canonicalMetadata(tokenIds: readonly string[]): RevealCanonicalMetadata[] {
    return tokenIds.flatMap(tokenId => {
      const owner = this.ownerHatching.canonical(tokenId);
      return owner ? [owner] : this.canonicalMetadataBase([tokenId]);
    });
  }

  private canonicalMetadataBase(tokenIds: readonly string[]): RevealCanonicalMetadata[] {
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
      const effective = this.resolveUnit({ category, assetId }, row.assignment_revision);
      if (!mapping && (effective.category !== category || effective.assetId !== assetId)) {
        category = effective.category;
        assetId = effective.assetId;
      }
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
      ON ${this.mappingOriginJoin()}
      WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<?
      AND m.egg_id>? ORDER BY m.egg_id LIMIT ?`, batchId, operation.target_revision, afterEggId, pageSize).toArray();
    const canonical = new Map(this.canonicalMetadata(rows.map(row => row.token_id)).map(row => [row.tokenId, row]));
    return rows.map(row => ({ ...canonical.get(row.token_id)!, eggId: row.egg_id }));
  }

  pendingPublications(batchId: string, pageSize = 8, now = Date.now()): RevealCatalogUpdatePublication[] {
    limit(pageSize);
    const operation = this.operation(batchId);
    if (operation.activated_at_ms === null) return [];
    const rows = this.sql.exec<{ egg_id: number; token_id: string }>(`SELECT m.egg_id,a.token_id FROM reveal_catalog_mappings m JOIN assignments a
      ON ${this.mappingOriginJoin()}
      LEFT JOIN reveal_catalog_publications p ON p.batch_id=m.batch_id AND p.token_id=a.token_id
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

  private generationAllocationContext(operation: Operation): { baseRevision: number; targetRevision: number } {
    const baseRevision = operation.mode === 'empty-rebuild' ? operation.target_revision : operation.mode === undefined ? 0
      : this.sql.exec<{ revision: number }>(`SELECT COALESCE(MAX(target_revision),0) AS revision FROM reveal_catalog_generations
        WHERE mode='empty-rebuild' AND activated_at_ms IS NOT NULL AND target_revision<=?`, operation.source_revision).toArray()[0].revision;
    return { baseRevision, targetRevision: operation.target_revision };
  }

  private verifyGeneration(batchId: string): void {
    const allocation = this.generationAllocationContext(this.operation(batchId));
    const categories = this.sql.exec<{ category: EthereumArtworkCategory; total: number; distinct_assets: number }>(
      `WITH units AS (SELECT origin_category AS category,origin_asset_id AS asset_id FROM reveal_catalog_free WHERE generation=?
        UNION ALL SELECT category,asset_id FROM assignments),
      overlay AS (${this.ownerHatching.available ? `SELECT COALESCE(o.category,u.category) AS category,COALESCE(o.asset_id,u.asset_id) AS asset_id FROM units u
        LEFT JOIN owner_hatching_slot_overrides o ON o.origin_category=u.category AND o.origin_asset_id=u.asset_id` : 'SELECT category,asset_id FROM units'}),
      effective AS (SELECT COALESCE(m.category,o.category) AS category,COALESCE(m.asset_id,o.asset_id) AS asset_id FROM overlay o
        LEFT JOIN reveal_catalog_mappings m ON m.rowid=(SELECT candidate.rowid FROM reveal_catalog_mappings candidate
          JOIN reveal_catalog_generations g ON g.batch_id=candidate.batch_id WHERE o.category='egg' AND candidate.egg_id=o.asset_id
            AND g.target_revision>? AND g.target_revision<=? AND (g.activated_at_ms IS NOT NULL OR g.batch_id=?)
          ORDER BY g.target_revision DESC LIMIT 1))
      SELECT category,COUNT(*) AS total,COUNT(DISTINCT asset_id) AS distinct_assets FROM effective GROUP BY category`,
      batchId, allocation.baseRevision, allocation.targetRevision, batchId).toArray();
    const target = Object.fromEntries(CATEGORIES.map(category => [category, 0])) as Record<EthereumArtworkCategory, number>;
    for (const row of categories) {
      if (!Object.hasOwn(target, row.category) || row.distinct_assets !== row.total) throw new Error('Catalog effective artwork identity is duplicated.');
      target[row.category] = row.total;
    }
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
      LEFT JOIN reveal_catalog_mappings m ON m.batch_id=p.batch_id AND ${this.mappingOriginJoin()}
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
    const operation = this.operation(batchId);
    limit(pageSize, operation.mode === 'empty-rebuild' ? 4096 : 256);
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
      metadataStaged: progress.staged, generationSeeded: row.seeded, frozen: row.frozen_count, ...publications,
      ...(row.mode === 'empty-rebuild' ? { mode: row.mode, categoryCounts: counts(JSON.parse(row.target_manifest_json) as RevealAssetCatalog) } : {}) };
  }
}
