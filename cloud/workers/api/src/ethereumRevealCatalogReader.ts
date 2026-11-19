import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.js';
import type { EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ASSET_FAMILIES, revealCatalogAssetId, revealCatalogAssetOrdinal, type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import { EthereumOwnerHatchingReader } from './ethereumOwnerHatchingReader.js';
import { applyRevealAttributePayload } from './ethereumRevealAttributes.js';
import { buildRevealedArtwork, REVEAL_CATEGORIES as CATEGORIES, REVEAL_ARTWORK_COUNT as TOTAL } from './ethereumRevealCatalog.js';
import type {
  RevealCatalogAssignmentRow as Assignment,
  RevealCanonicalMappingRow as CanonicalMapping,
  RevealCatalogMappingRow as Mapping,
  RevealCatalogOperation as Operation,
  RevealArtworkReadOptions,
  RevealCanonicalMetadata,
  RevealCatalogMetadataStage,
  RevealCatalogUpdatePublication,
  RevealCatalogUpdateStatus,
  RevealEffectiveUnit,
  RevealOriginUnit,
  RevealPool,
} from './ethereumRevealCatalogTypes.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import { revealSlotOverrideTable, type RevealSlotOverrideTable } from './ethereumRevealSlotOverrides.js';
import type { RevealSql } from './ethereumRevealStore.js';

const REPEATED_MAINNET_EGG_IMAGES = { first: 62_511, last: 76_700 } as const;
const CANONICAL_METADATA_PAGE_SIZE = 99;
const CANONICAL_METADATA_PAGE_BYTES = 1024 * 1024;
const ALLOCATION_BASE_REVISION = `COALESCE((SELECT target_revision FROM reveal_catalog_generations
  WHERE batch_id=(SELECT allocation_base_generation FROM settings WHERE id=1)),0)`;
const hash = (json: string) => bytesToHex(sha256(json));
export const revealCatalogCounts = (catalog: RevealAssetCatalog): Record<EthereumArtworkCategory, number> => ({ egg: catalog.categories.eggs.count,
  painting: catalog.categories.paintings.count, video: catalog.categories.videos.count, '3d': catalog.categories['3d'].count,
  animated: catalog.categories.animated.count });
export function validateCatalogPageSize(value: number, maximum = 256): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid catalog page size.');
}

export class EthereumRevealCatalogReader {
  private originCounts: { generation: string | null; catalog: RevealAssetCatalog; counts: Record<EthereumArtworkCategory, number> } | undefined;
  private mappingOriginsAvailable: boolean | undefined;
  private mixedAssetsAvailable = false;
  private slotOverrideSource: RevealSlotOverrideTable = 'owner_hatching_slot_overrides';
  private readonly catalogs = new Map<string, RevealAssetCatalog>();
  readonly ownerHatching: EthereumOwnerHatchingReader;

  constructor(protected readonly sql: RevealSql) {
    this.ownerHatching = new EthereumOwnerHatchingReader(sql);
  }

  noteSchemaInitialized(): void {
    this.mappingOriginsAvailable = true;
  }

  invalidateAllocationCounts(): void {
    this.originCounts = undefined;
  }

  freshEggBounds(): { lastIssued: number; maximum: number } {
    const saved = this.settings();
    if (!saved) return { lastIssued: 0, maximum: 0 };
    const original = getRevealCatalog((JSON.parse(saved.deployment_json) as EthereumRevealDeployment).catalogVersion);
    if (!original) throw new Error('Original catalog is unavailable.');
    const current = this.activeCatalog();
    return { lastIssued: Math.max(original.categories.eggs.count, this.originalCounts().egg, current.categories.eggs.count),
      maximum: current.importSettings.availableEggs };
  }

  requireMixedCapacity(futureCount: number, ordinaryCount: number): void {
    const pools = this.pools();
    if ((pools.find(pool => pool.category === 'egg')?.available ?? 0) < futureCount) throw new Error('Not enough free eggs for mixed allocation.');
    if (ordinaryCount) {
      const nonEgg = pools.reduce((sum, pool) => sum + (pool.category === 'egg' ? 0 : pool.available), 0);
      if (nonEgg + futureCount < this.ownerHatching.unbackedOrdinaryCount() + ordinaryCount) {
        throw new Error('Not enough available artworks for ordinary owner hatches.');
      }
    }
  }

  requireFreshEggInventory(count: number) {
    const { lastIssued, maximum } = this.freshEggBounds();
    const used = new Set(this.ownerHatching.available ? this.sql.exec<{ egg_id: number }>(`
      SELECT egg_id FROM owner_hatching_fresh_eggs WHERE egg_id>? AND egg_id<=?
      UNION SELECT egg_id FROM owner_hatching_retired_eggs WHERE egg_id>? AND egg_id<=?`,
      lastIssued, maximum, lastIssued, maximum).toArray().map(row => row.egg_id) : []);
    if (this.slotOverrideSource === 'reveal_effective_slot_overrides') {
      for (const row of this.sql.exec<{ egg_id: number }>('SELECT egg_id FROM reveal_duplicate_replacements WHERE egg_id>? AND egg_id<=?',
        lastIssued, maximum).toArray()) used.add(row.egg_id);
      const lastRepeated = Math.min(maximum, REPEATED_MAINNET_EGG_IMAGES.last);
      for (let id = Math.max(lastIssued + 1, REPEATED_MAINNET_EGG_IMAGES.first); id <= lastRepeated; id++) used.add(id);
    }
    if (Math.max(0, maximum - lastIssued - used.size) < count) throw new Error('Insufficient unused fresh egg inventory.');
    return { lastIssued, maximum, used };
  }

  freshOwnerEggAvailable(eggId: number): boolean {
    const { lastIssued, maximum } = this.freshEggBounds();
    return Number.isSafeInteger(eggId) && eggId > lastIssued && eggId <= maximum &&
      !this.ownerHatching.usedFreshEgg(eggId) && !this.ownerHatching.isRetiredEgg(eggId) &&
      (this.slotOverrideSource !== 'reveal_effective_slot_overrides' ||
        (eggId < REPEATED_MAINNET_EGG_IMAGES.first || eggId > REPEATED_MAINNET_EGG_IMAGES.last) &&
        !this.sql.exec('SELECT 1 FROM reveal_duplicate_replacements WHERE egg_id=?', eggId).toArray().length);
  }

  mixedAttributes(batchId: string, asset: RevealOriginUnit): string | undefined {
    if (!this.mixedAssetsAvailable) return undefined;
    const result = this.sql.exec<{ attributes_json: string | null }>(`SELECT a.attributes_json FROM reveal_mixed_operations m
      LEFT JOIN reveal_mixed_artworks a ON a.batch_id=m.batch_id AND a.owner_reward=1 AND a.category=? AND a.asset_id=?
      WHERE m.batch_id=?`, asset.category, asset.assetId, batchId).toArray()[0];
    if (result?.attributes_json === null) throw new Error('Mixed owner reward traits are missing.');
    return result?.attributes_json;
  }

  mixedFutureAttributes(asset: RevealOriginUnit): string | undefined {
    if (!this.mixedAssetsAvailable) return undefined;
    return this.sql.exec<{ attributes_json: string }>(`SELECT a.attributes_json FROM reveal_catalog_generations g
      JOIN reveal_mixed_artworks a ON a.batch_id=g.batch_id AND a.category=? AND a.asset_id=? AND a.owner_reward=0
      WHERE g.batch_version=3 AND g.activated_at_ms IS NOT NULL`, asset.category, asset.assetId).toArray()[0]?.attributes_json;
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

  settings(): { deployment_json: string; catalog_revision: number; active_catalog_generation: string | null;
    candidate_catalog_generation: string | null; allocation_base_generation: string | null;
    effective_catalog_version: string | null; effective_catalog_sha256: string | null } | null {
    const tables = this.sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE name IN ('settings','reveal_mixed_artworks','reveal_effective_slot_overrides')").toArray();
    this.slotOverrideSource = tables.some(table => table.name === 'reveal_effective_slot_overrides')
      ? 'reveal_effective_slot_overrides' : 'owner_hatching_slot_overrides';
    this.mixedAssetsAvailable = tables.some(table => table.name === 'reveal_mixed_artworks');
    if (!tables.some(table => table.name === 'settings')) return null;
    const row = this.sql.exec<{ deployment_json: string; catalog_revision?: number; active_catalog_generation?: string | null;
      candidate_catalog_generation?: string | null; allocation_base_generation?: string | null;
      effective_catalog_version?: string | null; effective_catalog_sha256?: string | null }>(
      'SELECT * FROM settings WHERE id=1').toArray()[0];
    return row ? { deployment_json: row.deployment_json, catalog_revision: row.catalog_revision ?? 0,
      active_catalog_generation: row.active_catalog_generation ?? null, candidate_catalog_generation: row.candidate_catalog_generation ?? null,
      allocation_base_generation: row.allocation_base_generation ?? null,
      effective_catalog_version: row.effective_catalog_version ?? null, effective_catalog_sha256: row.effective_catalog_sha256 ?? null } : null;
  }

  operation(batchId: string): Operation {
    if (!this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_catalog_generations'").toArray().length) throw new Error('Unknown catalog update.');
    const row = this.sql.exec<Operation>('SELECT * FROM reveal_catalog_generations WHERE batch_id=?', batchId).toArray()[0];
    if (!row) throw new Error('Unknown catalog update.');
    return row;
  }

  effectiveCatalog(): (RevealAssetCatalogDescriptor & { catalogRevision: number; generation: string | null }) | null {
    const saved = this.settings();
    if (!saved) return null;
    const origin = JSON.parse(saved.deployment_json) as EthereumRevealDeployment;
    const descriptor = saved.active_catalog_generation ? JSON.parse(this.sql.exec<{ target_json: string }>(
      'SELECT target_json FROM reveal_catalog_generations WHERE batch_id=?', saved.active_catalog_generation).toArray()[0].target_json) as RevealAssetCatalogDescriptor
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

  private originalInventory() {
    const saved = this.settings();
    const generation = saved?.allocation_base_generation ?? null;
    if (this.originCounts?.generation === generation) return this.originCounts;
    const origin = saved && JSON.parse(saved.deployment_json) as EthereumRevealDeployment | null;
    const catalog = generation ? JSON.parse(this.operation(generation).target_manifest_json) as RevealAssetCatalog
      : origin && getRevealCatalog(origin.catalogVersion);
    if (!catalog) throw new Error('Original catalog is unavailable.');
    this.originCounts = { generation, catalog, counts: revealCatalogCounts(catalog) };
    return this.originCounts;
  }

  originalCounts(): Record<EthereumArtworkCategory, number> {
    return this.originalInventory().counts;
  }

  ordinal(unit: RevealOriginUnit): number {
    const { catalog, counts } = this.originalInventory();
    let offset = 0;
    for (const category of CATEGORIES) {
      if (unit.category === category) {
        const ordinal = revealCatalogAssetOrdinal(catalog.categories[REVEAL_ASSET_FAMILIES[category]], unit.assetId);
        if (!ordinal) throw new Error('Unknown allocation asset.');
        return offset + ordinal;
      }
      offset += counts[category];
    }
    throw new Error('Unknown allocation unit.');
  }

  originPage(index: number, maximum: number) {
    const { catalog, counts } = this.originalInventory();
    for (const category of CATEGORIES) {
      if (index >= 1 && index <= counts[category]) {
        const pool = catalog.categories[REVEAL_ASSET_FAMILIES[category]];
        const count = Math.min(maximum, counts[category] - index + 1);
        return { category, firstId: revealCatalogAssetId(pool, index), lastId: revealCatalogAssetId(pool, index + count - 1), count };
      }
      index -= counts[category];
    }
    throw new Error('Invalid allocation unit.');
  }

  unitAt(index: number): RevealOriginUnit {
    const { category, firstId } = this.originPage(index, 1);
    return { category, assetId: firstId };
  }

  private canonicalMappings<T extends { egg_id: number }>(units: readonly RevealOriginUnit[], projection: 'bytes' | 'metadata'): Map<number, T> {
    const eggIds = [...new Set(units.filter(unit => unit.category === 'egg').map(unit => unit.assetId))];
    if (!eggIds.length) return new Map();
    const payload = this.mixedAssetsAvailable
      ? `COALESCE(m.attributes_json,(SELECT a.attributes_json FROM reveal_mixed_artworks a
          WHERE a.batch_id=m.batch_id AND a.category=m.category AND a.asset_id=m.asset_id))` : 'm.attributes_json';
    const fields = projection === 'bytes' ? `m.egg_id,COALESCE(length(CAST(${payload} AS BLOB)),0) AS bytes`
      : `m.egg_id,m.category,m.asset_id,${payload} AS attributes_json`;
    const rows = this.sql.exec<T>(`SELECT * FROM (
      SELECT ${fields},g.target_revision,ROW_NUMBER() OVER (PARTITION BY m.egg_id ORDER BY g.target_revision DESC) AS ordinal
      FROM reveal_catalog_mappings m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
      WHERE m.egg_id IN (${eggIds.map(() => '?').join(',')}) AND g.target_revision>${ALLOCATION_BASE_REVISION}
        AND (g.activated_at_ms IS NOT NULL OR g.batch_id='')) WHERE ordinal=1`, ...eggIds).toArray();
    return new Map(rows.map(row => [row.egg_id, row]));
  }

  resolveUnit(unit: RevealOriginUnit, assignmentRevision = this.settings()?.catalog_revision ?? 0, candidate?: string): RevealEffectiveUnit {
    unit = this.ownerHatching.available ? this.ownerHatching.slotOverride(unit, this.slotOverrideSource) ?? unit : unit;
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
            category: effective.category, assetId: effective.assetId, observation: artwork.observation, catalog, allocatedEgg: effective.category === 'egg',
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

  isFree(unit: RevealOriginUnit): boolean {
    const active = this.settings()?.active_catalog_generation;
    return (active ? this.sql.exec('SELECT 1 FROM reveal_catalog_free WHERE generation=? AND origin_category=? AND origin_asset_id=?', active, unit.category, unit.assetId)
      : this.sql.exec('SELECT 1 FROM free_slots WHERE category=? AND asset_id=?', unit.category, unit.assetId)).toArray().length === 1;
  }

  assertEmptyRebuildInventory(): void {
    const saved = this.settings();
    if (!saved || (JSON.parse(saved.deployment_json) as EthereumRevealDeployment).chainId !== 1) {
      throw new Error('Empty pool rebuild requires a mainnet deployment.');
    }
    if (this.sql.exec('SELECT 1 FROM assignments LIMIT 1').toArray().length ||
      this.sql.exec('SELECT 1 FROM publication LIMIT 1').toArray().length) {
      throw new Error('Empty pool rebuild requires zero assignments, reservations, and publications.');
    }
  }

  emptyRebuildOperation(operationId: string): Operation {
    const operation = this.operation(operationId);
    if (operation.mode !== 'empty-rebuild') throw new Error('Catalog operation is not an empty pool rebuild.');
    return operation;
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
    const catalog: RevealAssetCatalog = JSON.parse(operation.target_manifest_json);
    for (const category of CATEGORIES) {
      const family = catalog.categories[REVEAL_ASSET_FAMILIES[category]];
      const expectedId = family.assetIds ? "json_extract(?,'$['||f.slot||']')" : 'f.slot+1';
      if (this.sql.exec(`SELECT 1 FROM reveal_catalog_free f WHERE generation=? AND category=? AND
        (origin_category!=category OR origin_asset_id!=asset_id OR slot<0 OR slot>=? OR asset_id IS NOT (${expectedId})) LIMIT 1`,
        operationId, category, family.count, ...(family.assetIds ? [JSON.stringify(family.assetIds)] : [])).toArray().length) {
        throw new Error('Empty pool rebuild asset identities are inconsistent.');
      }
    }
    return this.status(operationId)!;
  }

  verifyCutoffClaims(batchId: string): void {
    if (!this.ownerHatching.hasBatch()) return;
    const active = this.settings()?.active_catalog_generation;
    const free = active ? `SELECT 1 FROM reveal_catalog_free f WHERE f.generation=? AND f.origin_category=b.origin_category AND f.origin_asset_id=b.origin_asset_id`
      : 'SELECT 1 FROM free_slots f WHERE f.category=b.origin_category AND f.asset_id=b.origin_asset_id';
    const invalid = this.sql.exec(`WITH bases AS (SELECT m.egg_id,COALESCE(m.origin_category,'egg') AS origin_category,
        COALESCE(m.origin_asset_id,m.egg_id) AS origin_asset_id,COALESCE(o.category,m.origin_category,'egg') AS effective_category,
        COALESCE(o.asset_id,m.origin_asset_id,m.egg_id) AS effective_asset_id FROM reveal_catalog_mappings m
        LEFT JOIN ${this.slotOverrideSource} o ON o.origin_category=COALESCE(m.origin_category,'egg')
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

  private unvalidatedMetadataCondition(): string {
    return this.sql.exec("SELECT name FROM pragma_table_info('reveal_catalog_mappings') WHERE name='collection_block_validated'").toArray().length
      ? 'collection_block_validated=0' : '1';
  }

  requireValidatedMetadata(batchId: string): void {
    if (this.sql.exec(`SELECT 1 FROM reveal_catalog_mappings WHERE batch_id=?
        AND ${this.unvalidatedMetadataCondition()} LIMIT 1`, batchId).toArray().length) {
      throw new Error('Stage every new artwork and validate its collection block before proceeding.');
    }
  }

  metadataPreparationPage(batchId: string, pageSize = 8): Array<RevealOriginUnit | RevealCatalogMetadataStage> {
    validateCatalogPageSize(pageSize);
    if (this.operation(batchId).activated_at_ms !== null) return [];
    return this.sql.exec<Mapping>(`SELECT category,asset_id,attributes_json,attributes_sha256 FROM reveal_catalog_mappings
      WHERE batch_id=? AND ${this.unvalidatedMetadataCondition()} ORDER BY egg_id LIMIT ?`, batchId, pageSize)
      .toArray().map(row => ({ category: row.category, assetId: row.asset_id,
        ...(row.attributes_json !== null ? { attributesJson: row.attributes_json, sha256: row.attributes_sha256! } : {}) }));
  }

  canonicalMetadata(tokenIds: readonly string[]): RevealCanonicalMetadata[] {
    const values = this.ownerHatching.canonicals(tokenIds);
    const remaining = [...new Set(tokenIds)].filter(tokenId => !values.has(tokenId));
    for (const value of this.canonicalMetadataBase(remaining)) values.set(value.tokenId, value);
    return tokenIds.flatMap(tokenId => values.has(tokenId) ? [values.get(tokenId)!] : []);
  }

  canonicalMetadataBase(tokenIds: readonly string[]): RevealCanonicalMetadata[] {
    if (!tokenIds.length) return [];
    const saved = this.settings();
    if (!saved) return [];
    const deployment = JSON.parse(saved.deployment_json) as EthereumRevealDeployment;
    const values = new Map<string, RevealCanonicalMetadata>();
    let catalog: RevealAssetCatalog | undefined;
    const hasEnrichment = this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment'").toArray().length > 0;
    const unique = [...new Set(tokenIds)];
    for (let offset = 0; offset < unique.length; offset += CANONICAL_METADATA_PAGE_SIZE) {
      const page = unique.slice(offset, offset + CANONICAL_METADATA_PAGE_SIZE);
      const sizes = this.sql.exec<Pick<Assignment, 'token_id' | 'category' | 'asset_id'> & { bytes: number }>(
        `SELECT a.token_id,a.category,a.asset_id,
          COALESCE(length(CAST(a.artwork_json AS BLOB)),0)+COALESCE(length(CAST(a.metadata_json AS BLOB)),0)
          +COALESCE(length(CAST(a.placeholder_json AS BLOB)),0)
          ${hasEnrichment ? '+COALESCE(length(CAST(e.target_json AS BLOB)),0)' : ''} AS bytes
          FROM assignments a ${hasEnrichment ? 'LEFT JOIN reveal_enrichment e ON e.token_id=a.token_id AND e.version=?' : ''}
          WHERE a.token_id IN (${page.map(() => '?').join(',')})`, ...(hasEnrichment ? [REVEAL_ENRICHMENT_VERSION] : []), ...page).toArray();
      if (!sizes.length) continue;
      const overrides = this.ownerHatching.slotOverrides(sizes.map(row => ({ category: row.category, assetId: row.asset_id })), this.slotOverrideSource);
      const units = new Map(sizes.map((row, index) => [row.token_id, overrides[index] ?? { category: row.category, assetId: row.asset_id }]));
      const mappingSizes = this.canonicalMappings<{ egg_id: number; bytes: number }>([...units.values()],
        'bytes');
      for (const row of sizes) {
        const unit = units.get(row.token_id)!;
        if (unit.category === 'egg') row.bytes += mappingSizes.get(unit.assetId)?.bytes ?? 0;
      }
      for (let start = 0; start < sizes.length;) {
        let end = start + 1, bytes = sizes[start].bytes;
        while (end < sizes.length && bytes + sizes[end].bytes <= CANONICAL_METADATA_PAGE_BYTES) bytes += sizes[end++].bytes;
        const ids = sizes.slice(start, end).map(row => row.token_id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.sql.exec<Assignment>(`SELECT * FROM assignments WHERE token_id IN (${placeholders})`, ...ids).toArray();
        const mappings = this.canonicalMappings<CanonicalMapping>(ids.map(tokenId => units.get(tokenId)!), 'metadata');
        const publications = new Map(this.sql.exec<{ token_id: string; status: string }>(
          `SELECT token_id,status FROM publication WHERE token_id IN (${placeholders})`, ...ids).toArray().map(row => [row.token_id, row]));
        const enrichments = new Map(hasEnrichment ? this.sql.exec<{ token_id: string; target_json: string | null;
          target_sha256: string | null; assignment_revision?: number }>(
          `SELECT * FROM reveal_enrichment WHERE token_id IN (${placeholders}) AND version=?`,
          ...ids, REVEAL_ENRICHMENT_VERSION).toArray().map(row => [row.token_id, row]) : []);
        for (const row of rows) {
          const tokenId = row.token_id;
          const unit = units.get(tokenId)!;
          const mapping = unit.category === 'egg' ? mappings.get(unit.assetId) : undefined;
          const revision = Math.max(row.assignment_revision ?? 0, mapping?.target_revision ?? 0);
          let artwork = JSON.parse(row.artwork_json) as EthereumRevealedArtwork;
          let metadataJson = row.metadata_json;
          let metadataRevision = 2 * revision;
          let category = unit.category, assetId = unit.assetId;
          if (mapping) {
            if (mapping.attributes_json === null) throw new Error('Activated artwork attributes are missing.');
            category = mapping.category;
            assetId = mapping.asset_id;
            catalog ??= this.activeCatalog();
            const built = row.assignment_revision >= mapping.target_revision && artwork.attributes?.some(attribute => attribute.trait_type === 'collection block')
              ? { artwork, metadataJson: row.metadata_json }
              : buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId, crateTokenId: row.crate_token_id,
                category, assetId, observation: artwork.observation, catalog });
            metadataJson = applyRevealAttributePayload(built.metadataJson, mapping.attributes_json).metadataJson;
            artwork = built.artwork;
            metadataRevision++;
          } else {
            const enriched = enrichments.get(tokenId);
            if (enriched?.target_json != null && (enriched.assignment_revision ?? 0) === revision && hash(enriched.target_json) === enriched.target_sha256) {
              metadataJson = enriched.target_json;
              metadataRevision++;
            }
          }
          const metadata = parseMetadataJson(metadataJson) as { attributes?: EthereumRevealedArtwork['attributes'] };
          artwork = { ...artwork, attributes: metadata.attributes, ...(metadataRevision ? { metadataRevision } : {}) };
          values.set(tokenId, { tokenId, category, assetId, assignmentRevision: revision, metadataRevision, artwork, metadataJson,
            targetSha256: hash(metadataJson), expectedJsons: [...new Set([row.placeholder_json, row.metadata_json])],
            allowMissing: publications.get(tokenId)?.status !== 'published', migration: Boolean(mapping && (row.assignment_revision ?? 0) < mapping.target_revision) });
        }
        start = end;
      }
    }
    return tokenIds.flatMap(tokenId => values.has(tokenId) ? [values.get(tokenId)!] : []);
  }

  validateMetadataWrite(job: { tokenId: string; metadataRevision: number; metadataJson: string; expectedJsons: string[]; allowMissing: boolean }): boolean {
    const current = this.canonicalMetadata([job.tokenId])[0];
    return Boolean(current && current.metadataRevision === job.metadataRevision && current.metadataJson === job.metadataJson &&
      (!job.allowMissing || current.allowMissing) && job.expectedJsons.every(value => current.expectedJsons.includes(value)));
  }

  publicationPage(batchId: string, afterEggId = 0, pageSize = 8): RevealCatalogUpdatePublication[] {
    validateCatalogPageSize(pageSize);
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
    validateCatalogPageSize(pageSize);
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

  private generationAllocationContext(operation: Operation): { baseRevision: number; targetRevision: number } {
    const baseRevision = operation.mode === 'empty-rebuild' ? operation.target_revision : operation.mode === undefined ? 0
      : this.sql.exec<{ revision: number }>(`SELECT COALESCE(MAX(target_revision),0) AS revision FROM reveal_catalog_generations
        WHERE mode='empty-rebuild' AND activated_at_ms IS NOT NULL AND target_revision<=?`, operation.source_revision).toArray()[0].revision;
    return { baseRevision, targetRevision: operation.target_revision };
  }

  verifyGeneration(batchId: string): void {
    const allocation = this.generationAllocationContext(this.operation(batchId));
    const overrides = revealSlotOverrideTable(this.sql);
    const categories = this.sql.exec<{ category: EthereumArtworkCategory; total: number; distinct_assets: number }>(
      `WITH units AS (SELECT origin_category AS category,origin_asset_id AS asset_id FROM reveal_catalog_free WHERE generation=?
        UNION ALL SELECT category,asset_id FROM assignments),
      overlay AS (${overrides ? `SELECT COALESCE(o.category,u.category) AS category,COALESCE(o.asset_id,u.asset_id) AS asset_id FROM units u
        LEFT JOIN ${overrides} o ON o.origin_category=u.category AND o.origin_asset_id=u.asset_id` : 'SELECT category,asset_id FROM units'}),
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

  status(batchId?: string): RevealCatalogUpdateStatus | null {
    if (!this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_catalog_generations'").toArray().length) return null;
    const row = batchId ? this.sql.exec<Operation>('SELECT * FROM reveal_catalog_generations WHERE batch_id=?', batchId).toArray()[0]
      : this.sql.exec<Operation>('SELECT * FROM reveal_catalog_generations ORDER BY rowid DESC LIMIT 1').toArray()[0];
    if (!row) return null;
    const staged = row.batch_version === 3 ? '1' : row.activated_at_ms === null ? `NOT (${this.unvalidatedMetadataCondition()})` : 'attributes_json IS NOT NULL';
    const progress = this.sql.exec<{ mapped: number; staged: number }>(`SELECT COUNT(*) AS mapped,
      COALESCE(SUM(${staged}),0) AS staged FROM reveal_catalog_mappings WHERE batch_id=?`, row.batch_id).toArray()[0];
    const publications = this.sql.exec<{ published: number; retrying: number; conflicts: number }>(`SELECT COALESCE(SUM(published),0) AS published,
      COALESCE(SUM(published=0 AND last_error='retry'),0) AS retrying,COALESCE(SUM(published=0 AND last_error='conflict'),0) AS conflicts
      FROM reveal_catalog_publications WHERE batch_id=?`, row.batch_id).toArray()[0];
    return { batchId: row.batch_id, batchSha256: row.batch_sha256, predecessor: JSON.parse(row.predecessor_json), target: JSON.parse(row.target_json),
      sourceRevision: row.source_revision, targetRevision: row.target_revision, startedAtMs: row.started_at_ms,
      activatedAtMs: row.activated_at_ms, phase: row.phase, total: row.mapping_count, mapped: progress.mapped,
      metadataStaged: progress.staged, generationSeeded: row.seeded, frozen: row.frozen_count, ...publications,
      ...(row.mode === 'empty-rebuild' ? { mode: row.mode, categoryCounts: revealCatalogCounts(JSON.parse(row.target_manifest_json) as RevealAssetCatalog) } : {}) };
  }
}
