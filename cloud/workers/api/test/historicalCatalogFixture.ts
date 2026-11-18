import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getOwnerHatchingGrail, requireOrdinaryCatalogTarget } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';
import type { EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.ts';
import type { RevealAssetCatalog, RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { validateRevealCatalogUpdateBatch, type RevealCatalogUpdateBatch, type RevealCatalogUpdateMapping } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { metadataNumber, parseMetadataJson } from '../src/ethereumMetadataJson.ts';
import { applyRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from '../src/ethereumRevealAttributes.ts';
import { buildNewRevealedArtwork, buildRevealedArtwork, REVEAL_ARTWORK_COUNT as TOTAL, REVEAL_CATEGORIES as CATEGORIES } from '../src/ethereumRevealCatalog.ts';
import { EthereumRevealCatalogReader, revealCatalogCounts as counts, validateCatalogPageSize as limit } from '../src/ethereumRevealCatalogReader.ts';
import { EthereumRevealCatalogUpdateStore } from '../src/ethereumRevealCatalogUpdateStore.ts';
import type { RevealCatalogMappingRow as Mapping, RevealCatalogMetadataStage, RevealCatalogUpdateStatus, RevealOriginUnit } from '../src/ethereumRevealCatalogTypes.ts';
import { EthereumRevealStore } from '../src/ethereumRevealStore.ts';

const hash = (value: string) => bytesToHex(sha256(value));

class HistoricalReader extends EthereumRevealCatalogReader {
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

  requireCutoffEgg(eggId: number): RevealOriginUnit {
    if (this.ownerHatching.hasProtectedEgg(eggId)) throw new Error('Cutoff egg is protected by owner hatching.');
    const unit = this.effectiveEggOrigin(eggId);
    if (!unit) throw new Error('Cutoff egg is not a live allocation.');
    return unit;
  }

}

class HistoricalCatalogFixture extends EthereumRevealCatalogUpdateStore {
  declare readonly reader: HistoricalReader;
  begin(batch: RevealCatalogUpdateBatch, now: number): RevealCatalogUpdateStatus {
    validateRevealCatalogUpdateBatch(batch);
    this.initialize();
    const existing = this.reader.status(batch.batchId);
    if (existing) {
      if (existing.batchSha256 !== batch.batchSha256 || existing.phase === 'cancelled') throw new Error('Catalog update replay does not match.');
      return existing;
    }
    return this.transaction(() => {
      const saved = this.reader.settings();
      const current = this.reader.effectiveCatalog();
      if (!saved || !current || saved.candidate_catalog_generation || current.catalogVersion !== batch.predecessor.descriptor.catalogVersion ||
        current.manifestSha256 !== batch.predecessor.descriptor.manifestSha256) throw new Error('Catalog update predecessor changed.');
      requireOrdinaryCatalogTarget((JSON.parse(saved.deployment_json) as EthereumRevealDeployment).chainId, batch.target.descriptor);
      if (!this.sql.exec('SELECT 1 FROM settings WHERE id=1 AND ready=1').toArray().length) throw new Error('Reveal inventory is not ready.');
      if (this.sql.exec("SELECT 1 FROM reveal_catalog_generations WHERE phase='active' LIMIT 1").toArray().length) throw new Error('Finish the previous catalog operation first.');
      const origins = batch.mappings.map(mapping => this.reader.requireCutoffEgg(mapping.eggId));
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,batch_version,egg_cutoff) VALUES(?,?,?,?,?,?,?,?,?,'mapping',?,?,?)`,
        batch.batchId, batch.batchSha256, JSON.stringify(batch.predecessor.descriptor), JSON.stringify(batch.target.descriptor),
        JSON.stringify(batch.target.manifest), current.catalogRevision, current.catalogRevision + 1, batch.mappings.length,
        hash(JSON.stringify(batch.mappings.map(row => ({ eggId: row.eggId, category: row.category, assetId: row.assetId })))), now,
        batch.version, batch.version === 2 ? batch.eggCutoff : null);
      const targetCounts = Object.fromEntries(this.reader.pools().map(pool => [pool.category, pool.total])) as Record<EthereumArtworkCategory, number>;
      for (const [index, mapping] of batch.mappings.entries()) {
        targetCounts.egg--;
        targetCounts[mapping.category]++;
        this.sql.exec('INSERT INTO reveal_catalog_egg_claims(batch_id,egg_id,origin_category,origin_asset_id) VALUES(?,?,?,?)',
          batch.batchId, mapping.eggId, origins[index].category, origins[index].assetId);
      }
      for (const category of CATEGORIES) this.sql.exec('INSERT INTO reveal_catalog_pools(generation,category,total) VALUES(?,?,?)',
        batch.batchId, category, targetCounts[category]);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=? WHERE id=1', batch.batchId);
      return this.reader.status(batch.batchId)!;
    });
  }

  stageMappings(batchId: string, mappings: RevealCatalogUpdateMapping[]): RevealCatalogUpdateStatus {
    limit(mappings.length);
    this.transaction(() => {
      const operation = this.reader.operation(batchId);
      if (operation.phase !== 'mapping') throw new Error('Catalog mapping is already sealed.');
      const target = JSON.parse(operation.target_manifest_json) as RevealAssetCatalog;
      const predecessor = this.reader.activeCatalog();
      const before = counts(predecessor), after = counts(target);
      for (const mapping of mappings) {
        if (!Number.isSafeInteger(mapping.eggId) || (operation.batch_version === 2
          ? mapping.eggId <= (operation.egg_cutoff ?? -1) || mapping.eggId > predecessor.importSettings.availableEggs
          : mapping.eggId <= after.egg || mapping.eggId > before.egg) ||
          mapping.category === ('egg' as string) || !Object.hasOwn(after, mapping.category) || !Number.isSafeInteger(mapping.assetId) ||
          mapping.assetId <= before[mapping.category] || mapping.assetId > after[mapping.category] ||
          getOwnerHatchingGrail(mapping.category, mapping.assetId)) throw new Error('Invalid replacement mapping.');
        const origin = this.reader.requireCutoffEgg(mapping.eggId);
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
    return this.reader.status(batchId)!;
  }

  sealMappings(batchId: string): RevealCatalogUpdateStatus {
    const operation = this.reader.operation(batchId);
    if (operation.phase !== 'mapping') return this.reader.status(batchId)!;
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
    return this.reader.status(batchId)!;
  }

  metadataStage(batchId: string, rows: RevealCatalogMetadataStage[]): RevealCatalogUpdateStatus {
    limit(rows.length);
    this.transaction(() => {
      const operation = this.reader.operation(batchId);
      if (operation.batch_version === 3) throw new Error('Use mixed allocation trait staging.');
      if (!['staging', 'ready'].includes(operation.phase)) throw new Error('Catalog metadata is not staging.');
      const deployment = JSON.parse(this.reader.settings()!.deployment_json) as EthereumRevealDeployment;
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
        if (!previous || operation.phase === 'ready' && previous.attributes_json === null ||
          previous.attributes_json !== null && (previous.attributes_json !== row.attributesJson || previous.attributes_sha256 !== row.sha256)) {
          throw new Error('Staged artwork attributes cannot change.');
        }
        const metadataInput = { templateJson: deployment.templateJson, tokenId: String(TOTAL), crateTokenId: '116666',
          category: row.category, assetId: row.assetId, catalog,
          observation: { transactionHash: `0x${'0'.repeat(64)}`, blockHash: `0x${'0'.repeat(64)}`, blockNumber: 0 } };
        applyRevealAttributePayload(buildRevealedArtwork(metadataInput).metadataJson, row.attributesJson);
        applyRevealAttributePayload(buildNewRevealedArtwork(metadataInput).metadataJson, row.attributesJson);
        this.sql.exec('UPDATE reveal_catalog_mappings SET attributes_json=?,attributes_sha256=?,collection_block_validated=1 WHERE batch_id=? AND category=? AND asset_id=?',
          row.attributesJson, row.sha256, batchId, row.category, row.assetId);
      }
    });
    return this.reader.status(batchId)!;
  }

  generationStage(batchId: string, pageSize = 256): RevealCatalogUpdateStatus {
    limit(pageSize);
    this.transaction(() => {
      const operation = this.reader.operation(batchId);
      if (operation.batch_version === 3) throw new Error('Use mixed allocation staging.');
      if (operation.mode === 'empty-rebuild') throw new Error('Use empty pool rebuild staging.');
      if (operation.phase !== 'staging') throw new Error('Catalog generation is not staging.');
      this.reader.requireValidatedMetadata(batchId);
      const last = Math.min(TOTAL, operation.seeded + pageSize);
      for (let index = operation.seeded + 1; index <= last; index++) {
        const unit = this.reader.unitAt(index);
        const effective = this.reader.resolveUnit(unit, operation.target_revision, batchId);
        const free = this.reader.isFree(unit);
        const assigned = this.sql.exec('SELECT 1 FROM assignments WHERE category=? AND asset_id=?', unit.category, unit.assetId).toArray().length;
        if (Number(free) + assigned !== 1) throw new Error('Allocation unit is missing or duplicated.');
        this.sql.exec('UPDATE reveal_catalog_pools SET seeded=seeded+1 WHERE generation=? AND category=?', batchId, effective.category);
        if (free) this.insertFree(batchId, unit);
      }
      this.sql.exec('UPDATE reveal_catalog_generations SET seeded=? WHERE batch_id=?', last, batchId);
    });
    return this.reader.status(batchId)!;
  }

  seal(batchId: string): RevealCatalogUpdateStatus {
    const operation = this.reader.operation(batchId);
    if (operation.batch_version === 3) throw new Error('Use mixed allocation sealing.');
    if (operation.mode === 'empty-rebuild') throw new Error('Use empty pool rebuild sealing.');
    if (!['staging', 'ready'].includes(operation.phase) || operation.seeded !== TOTAL) throw new Error('Catalog generation is incomplete.');
    this.reader.requireValidatedMetadata(batchId);
    if (operation.phase === 'ready') return this.reader.status(batchId)!;
    this.reader.verifyCutoffClaims(batchId);
    this.reader.verifyGeneration(batchId);
    this.sql.exec("UPDATE reveal_catalog_generations SET phase='ready' WHERE batch_id=?", batchId);
    return this.reader.status(batchId)!;
  }

  activate(batchId: string, now = Date.now()): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.reader.operation(batchId);
      if (operation.batch_version === 3) throw new Error('Use mixed allocation activation.');
      if (operation.mode === 'empty-rebuild') throw new Error('Use empty pool rebuild activation.');
      if (operation.activated_at_ms !== null) return this.reader.status(batchId)!;
      const saved = this.reader.settings()!;
      if (operation.phase !== 'ready' || saved.candidate_catalog_generation !== batchId || saved.catalog_revision !== operation.source_revision) {
        throw new Error('Catalog generation cannot activate.');
      }
      this.reader.requireValidatedMetadata(batchId);
      this.reader.verifyCutoffClaims(batchId);
      const frozen = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM assignments a JOIN reveal_catalog_mappings m
        ON a.category=COALESCE(m.origin_category,'egg') AND a.asset_id=COALESCE(m.origin_asset_id,m.egg_id)
        WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<?`, batchId, operation.target_revision).toArray()[0].count;
      const target = JSON.parse(operation.target_json) as RevealAssetCatalogDescriptor;
      this.sql.exec(`UPDATE reveal_catalog_generations SET phase='active',activated_at_ms=?,frozen_count=? WHERE batch_id=?`, now, frozen, batchId);
      this.sql.exec(`UPDATE settings SET active_catalog_generation=?,candidate_catalog_generation=NULL,effective_catalog_version=?,
        effective_catalog_sha256=?,catalog_revision=? WHERE id=1`, batchId, target.catalogVersion, target.manifestSha256, operation.target_revision);
      return this.reader.status(batchId)!;
    });
  }

  acknowledgePublication(batchId: string, tokenId: string, metadataRevision: number, targetSha256: string): RevealCatalogUpdateStatus {
    this.transaction(() => {
      const operation = this.reader.operation(batchId);
      const current = this.reader.canonicalMetadata([tokenId])[0];
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
    return this.reader.status(batchId)!;
  }

  failPublication(batchId: string, tokenId: string, metadataRevision: number, outcome: 'conflict' | 'retry', now: number): RevealCatalogUpdateStatus {
    const operation = this.reader.operation(batchId);
    const current = this.reader.canonicalMetadata([tokenId])[0];
    if (operation.activated_at_ms === null || !current?.migration || current.assignmentRevision !== operation.target_revision ||
      current.metadataRevision !== metadataRevision) return this.reader.status(batchId)!;
    const old = this.sql.exec<{ attempts: number }>('SELECT attempts FROM reveal_catalog_publications WHERE batch_id=? AND token_id=?', batchId, tokenId).toArray()[0];
    const attempts = (old?.attempts ?? 0) + 1;
    this.sql.exec(`INSERT INTO reveal_catalog_publications(batch_id,token_id,metadata_revision,target_sha256,attempts,next_check_ms,last_error)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(batch_id,token_id) DO UPDATE SET attempts=excluded.attempts,next_check_ms=excluded.next_check_ms,last_error=excluded.last_error
      WHERE reveal_catalog_publications.published=0`, batchId, tokenId, metadataRevision, current.targetSha256, attempts,
      now + (outcome === 'conflict' ? 300_000 : Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 9))), outcome);
    return this.reader.status(batchId)!;
  }

}

export class HistoricalRevealStore extends EthereumRevealStore {
  override readonly catalogUpdate: HistoricalCatalogFixture;

  constructor(...args: ConstructorParameters<typeof EthereumRevealStore>) {
    super(...args);
    this.catalogUpdate = new HistoricalCatalogFixture(args[0], this.transaction, new HistoricalReader(args[0]));
  }
}
