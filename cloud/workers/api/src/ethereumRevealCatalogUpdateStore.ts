import { emptyPoolRelease } from '../../../../shared/ethereum/installedMixedAllocation.js';
import type { EmptyPoolBatch } from '../../../../shared/ethereum/revealMaintenance.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getOwnerHatchingGrail, requireOrdinaryCatalogTarget } from '../../../../shared/ethereum/ownerHatchingCatalog.js';
import type { EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ASSET_FAMILIES, type RevealAssetCatalog, type RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { validateRevealCatalogUpdateBatch } from '../../../../shared/ethereum/revealCatalogUpdate.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumRevealMixedAllocation } from './ethereumRevealMixedAllocation.js';
import { EthereumOwnerHatchingStore } from './ethereumOwnerHatchingStore.js';
import { applyRevealAttributePayload } from './ethereumRevealAttributes.js';
import {
  buildNewRevealedArtwork,
  REVEAL_CATEGORIES as CATEGORIES,
  revealRandomInteger,
} from './ethereumRevealCatalog.js';
import { revealCatalogCounts as counts, EthereumRevealCatalogReader, validateCatalogPageSize as limit } from './ethereumRevealCatalogReader.js';
import type {
  RevealCatalogAssignmentRow as Assignment,
  RevealCatalogUpdateStatus,
  RevealOriginUnit,
  RevealPool,
} from './ethereumRevealCatalogTypes.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import { initializeRevealCatalogSchemaV1 } from './ethereumRevealSchema/catalog.js';
import type { RevealSql } from './ethereumRevealStore.js';

const hash = (json: string) => bytesToHex(sha256(json));

export class EthereumRevealCatalogUpdateStore {
  readonly ownerHatching: EthereumOwnerHatchingStore;
  readonly mixed: EthereumRevealMixedAllocation;
  constructor(protected readonly sql: RevealSql, protected readonly transaction: <T>(action: () => T) => T,
    readonly reader = new EthereumRevealCatalogReader(sql)) {
    this.ownerHatching = new EthereumOwnerHatchingStore(sql, transaction, {
      canonical: tokenId => this.reader.canonicalMetadataBase([tokenId])[0] ?? null,
      originForToken: tokenId => {
        const row = this.sql.exec<Assignment>('SELECT * FROM assignments WHERE token_id=?', tokenId).toArray()[0];
        if (!row) throw new Error('Owner hatch origin is unavailable.');
        return { category: row.category, assetId: row.asset_id };
      },
      build: (tokenId, asset, original) => {
        const deployment = JSON.parse(this.reader.settings()!.deployment_json) as EthereumRevealDeployment;
        const built = buildNewRevealedArtwork({ templateJson: deployment.templateJson, tokenId,
          crateTokenId: original.artwork.crateTokenId, category: asset.category, assetId: asset.assetId,
          observation: original.artwork.observation, catalog: this.reader.activeCatalog(), ownerHatching: true });
        const grail = getOwnerHatchingGrail(asset.category, asset.assetId);
        const block = grail?.collectionBlock ?? lookupRevealCollectionBlock(revealCollectionBlocks(this.reader.effectiveCatalog()), asset.category, asset.assetId);
        built.artwork.collectionBlock = block;
        return { artwork: built.artwork,
          metadataJson: asset.attributesJson ? applyRevealAttributePayload(built.metadataJson, asset.attributesJson).metadataJson : built.metadataJson };
      },
      reservedAttributes: (batchId, asset) => this.reader.mixedAttributes(batchId, asset),
      takeOrdinary: () => {
        const pools = this.reader.pools().filter(pool => pool.category !== 'egg' && pool.available > 0);
        const available = pools.reduce((sum, pool) => sum + pool.available, 0);
        if (!available) return null;
        let selection = revealRandomInteger(available);
        const pool = pools.find(value => { selection -= value.available; return selection < 0; })!;
        const origin = this.takeFree(pool.category, revealRandomInteger(pool.available));
        const effective = this.reader.resolveUnit(origin);
        if (effective.category === 'egg' || getOwnerHatchingGrail(effective.category, effective.assetId)) {
          throw new Error('Ordinary hatch inventory is inconsistent.');
        }
        const attributesJson = this.reader.mixedFutureAttributes(effective);
        return { origin, effective: { category: effective.category, assetId: effective.assetId, ...(attributesJson ? { attributesJson } : {}) } };
      },
      transitionSlot: (origin, before, after) => this.transitionOwnerSlot(origin, before, after),
      releaseReplacement: origin => this.releaseFree(origin),
      freshEggAvailable: eggId => this.reader.freshOwnerEggAvailable(eggId),
      eligibleEgg: (_tokenId, eggId) => Boolean(this.reader.settings()) &&
        !this.sql.exec(`SELECT 1 FROM (SELECT batch_id,egg_id FROM reveal_catalog_egg_claims
          UNION ALL SELECT batch_id,egg_id FROM reveal_catalog_mappings) m JOIN reveal_catalog_generations g ON g.batch_id=m.batch_id
          WHERE m.egg_id=? AND g.phase IN ('mapping','staging','ready') LIMIT 1`, eggId).toArray().length,
    }, revealRandomInteger, this.reader.ownerHatching);
    this.mixed = new EthereumRevealMixedAllocation(sql, transaction, this.reader, this.ownerHatching);
  }

  private candidateProgress(batchId: string | null) {
    if (!batchId) return null;
    const row = this.sql.exec<{ batch_id: string; batch_version: number; mode: string; seeded: number }>(
      'SELECT batch_id,batch_version,mode,seeded FROM reveal_catalog_generations WHERE batch_id=?', batchId).toArray()[0];
    if (!row) throw new Error('Unknown candidate catalog generation.');
    return row;
  }

  private transitionOwnerSlot(origin: RevealOriginUnit, before: RevealOriginUnit, after: RevealOriginUnit): void {
    if (before.category === after.category) return;
    const saved = this.reader.settings()!;
    if (!saved.active_catalog_generation) throw new Error('Owner hatching requires a canonical inventory generation.');
    for (const generation of [saved.active_catalog_generation, saved.candidate_catalog_generation].filter((value): value is string => Boolean(value))) {
      const candidate = generation === saved.active_catalog_generation ? null : this.candidateProgress(generation);
      const seeded = !candidate || candidate.batch_version === 3 || this.reader.ordinal(origin) <= candidate.seeded;
      this.sql.exec('UPDATE reveal_catalog_pools SET total=total+1,seeded=seeded+? WHERE generation=? AND category=?',
        Number(seeded), generation, after.category);
      this.sql.exec('UPDATE reveal_catalog_pools SET total=total-1,seeded=seeded-? WHERE generation=? AND category=?',
        Number(seeded), generation, before.category);
    }
  }

  initialize(): void {
    initializeRevealCatalogSchemaV1(this.sql, this.transaction);
    this.reader.noteSchemaInitialized();
    this.ownerHatching.initialize();
  }

  protected insertFree(generation: string, unit: RevealOriginUnit): void {
    const effective = this.reader.resolveUnit(unit, 0, generation);
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

  replaceFreePaintingWithEgg(origin: RevealOriginUnit, eggId: number, persist: () => void): void {
    this.transaction(() => {
      const saved = this.reader.settings();
      if (!saved?.active_catalog_generation || saved.candidate_catalog_generation || origin.category !== 'painting' ||
        !this.reader.freshOwnerEggAvailable(eggId)) throw new Error('Painting cannot be exchanged for this egg.');
      const free = this.sql.exec(`SELECT 1 FROM reveal_catalog_free WHERE generation=? AND origin_category='painting' AND origin_asset_id=?
        AND category='painting' AND asset_id=?`, saved.active_catalog_generation, origin.assetId, origin.assetId).toArray().length;
      const effective = this.reader.resolveUnit(origin);
      if (!free || effective.category !== 'painting' || effective.assetId !== origin.assetId) throw new Error('Painting is no longer free.');
      this.removeFree(saved.active_catalog_generation, origin);
      persist();
      const egg = this.reader.resolveUnit(origin);
      if (egg.category !== 'egg' || egg.assetId !== eggId) throw new Error('Replacement egg did not resolve.');
      this.transitionOwnerSlot(origin, effective, egg);
      this.insertFree(saved.active_catalog_generation, origin);
    });
  }

  takeFree(category: EthereumArtworkCategory, index: number): RevealOriginUnit {
    return this.transaction(() => {
      const saved = this.reader.settings()!;
      const candidate = this.candidateProgress(saved.candidate_catalog_generation);
      if (candidate && candidate.mode === 'empty-rebuild') {
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
      if (candidate && this.reader.ordinal(unit) <= candidate.seeded) {
        this.removeFree(candidate.batch_id, unit);
      }
      return unit;
    });
  }

  releaseFree(unit: RevealOriginUnit): void {
    this.transaction(() => {
      const saved = this.reader.settings()!;
      const candidate = this.candidateProgress(saved.candidate_catalog_generation);
      if (candidate && candidate.mode === 'empty-rebuild') {
        throw new Error('Empty pool rebuild is fenced.');
      }
      if (saved.active_catalog_generation) this.insertFree(saved.active_catalog_generation, unit);
      else {
        const pool = this.sql.exec<{ available: number }>('SELECT available FROM pools WHERE category=?', unit.category).toArray()[0];
        this.sql.exec('INSERT INTO free_slots(category,slot,asset_id) VALUES(?,?,?)', unit.category, pool.available, unit.assetId);
        this.sql.exec('UPDATE pools SET available=available+1 WHERE category=?', unit.category);
      }
      if (candidate && this.reader.ordinal(unit) <= candidate.seeded) {
        this.insertFree(candidate.batch_id, unit);
      }
    });
  }

  beginEmptyRebuild(input: { operationId: string; batch: EmptyPoolBatch; now?: number }): RevealCatalogUpdateStatus {
    const { operationId, now = Date.now() } = input;
    const request = input.batch;
    const batch = request.version === 'mixed'
      ? emptyPoolRelease(request.batchId, request.batchSha256, (JSON.parse(this.reader.settings()!.deployment_json) as EthereumRevealDeployment).deploymentId)
      : request;
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(operationId) || operationId === batch.batchId) {
      throw new Error('Empty pool rebuild requires a distinct operation identity.');
    }
    if (request.version !== 'mixed') validateRevealCatalogUpdateBatch(request);
    this.initialize();
    const existing = this.reader.status(operationId);
    if (existing) {
      if (existing.mode !== 'empty-rebuild' || existing.batchSha256 !== batch.batchSha256 || existing.phase === 'cancelled') {
        throw new Error('Empty pool rebuild replay does not match.');
      }
      return existing;
    }
    return this.transaction(() => {
      this.reader.assertEmptyRebuildInventory();
      const saved = this.reader.settings()!;
      requireOrdinaryCatalogTarget((JSON.parse(saved.deployment_json) as EthereumRevealDeployment).chainId, batch.target.descriptor);
      const current = this.reader.effectiveCatalog()!;
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
      return this.reader.status(operationId)!;
    });
  }

  stageEmptyRebuild(operationId: string, pageSize = 4096): RevealCatalogUpdateStatus {
    limit(pageSize, 4096);
    return this.transaction(() => {
      const operation = this.reader.emptyRebuildOperation(operationId);
      if (['ready', 'active', 'complete'].includes(operation.phase)) return this.reader.status(operationId)!;
      this.reader.assertEmptyRebuildInventory();
      const saved = this.reader.settings()!;
      if (operation.phase !== 'staging' || saved.candidate_catalog_generation !== operationId ||
        saved.catalog_revision !== operation.source_revision) throw new Error('Empty pool rebuild is not staging.');
      let remaining = pageSize;
      let seeded = operation.seeded;
      const target: RevealAssetCatalog = JSON.parse(operation.target_manifest_json);
      const pools = this.sql.exec<RevealPool>('SELECT category,total,seeded,available FROM reveal_catalog_pools WHERE generation=? ORDER BY category', operationId).toArray();
      if (pools.length !== CATEGORIES.length || pools.reduce((sum, pool) => sum + pool.seeded, 0) !== seeded) {
        throw new Error('Empty pool rebuild counters are inconsistent.');
      }
      for (const pool of pools) {
        const count = Math.min(remaining, pool.total - pool.seeded);
        if (!count) continue;
        if (count < 0 || pool.seeded !== pool.available) throw new Error('Empty pool rebuild counters are inconsistent.');
        const ids = target.categories[REVEAL_ASSET_FAMILIES[pool.category]].assetIds;
        if (ids) this.sql.exec(`INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
          SELECT ?,?,?+key,?,value,value FROM json_each(?)`, operationId, pool.category, pool.seeded, pool.category,
          JSON.stringify(ids.slice(pool.seeded, pool.seeded + count)));
        else this.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT ? UNION ALL SELECT id+1 FROM ids WHERE id<?)
          INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
          SELECT ?,?,id-1,?,id,id FROM ids`, pool.seeded + 1, pool.seeded + count, operationId, pool.category, pool.category);
        this.sql.exec('UPDATE reveal_catalog_pools SET seeded=seeded+?,available=available+? WHERE generation=? AND category=?',
          count, count, operationId, pool.category);
        seeded += count;
        remaining -= count;
        if (!remaining) break;
      }
      this.sql.exec('UPDATE reveal_catalog_generations SET seeded=? WHERE batch_id=?', seeded, operationId);
      return this.reader.status(operationId)!;
    });
  }

  sealEmptyRebuild(operationId: string): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.reader.emptyRebuildOperation(operationId);
      if (operation.phase === 'ready') return this.reader.verifyEmptyRebuild(operationId);
      if (operation.phase !== 'staging') throw new Error('Empty pool rebuild is not staging.');
      this.reader.verifyEmptyRebuild(operationId);
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='ready' WHERE batch_id=?", operationId);
      return this.reader.status(operationId)!;
    });
  }

  activateEmptyRebuild(operationId: string, now = Date.now()): RevealCatalogUpdateStatus {
    return this.transaction(() => {
      const operation = this.reader.emptyRebuildOperation(operationId);
      if (operation.activated_at_ms !== null) return this.reader.status(operationId)!;
      if (operation.phase !== 'ready') throw new Error('Empty pool rebuild is not ready.');
      this.reader.verifyEmptyRebuild(operationId);
      const target = JSON.parse(operation.target_json) as RevealAssetCatalogDescriptor;
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='active',activated_at_ms=? WHERE batch_id=?", now, operationId);
      this.sql.exec(`UPDATE settings SET active_catalog_generation=?,allocation_base_generation=?,candidate_catalog_generation=NULL,
        effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=? WHERE id=1`,
        operationId, operationId, target.catalogVersion, target.manifestSha256, operation.target_revision);
      this.reader.invalidateAllocationCounts();
      return this.reader.status(operationId)!;
    });
  }

  pruneEmptyRebuild(operationId: string, pageSize = 4096): { remaining: number } {
    this.reader.emptyRebuildOperation(operationId);
    return this.prune(operationId, pageSize);
  }

  finalize(batchId: string): RevealCatalogUpdateStatus {
    if (this.reader.operation(batchId).batch_version === 3) throw new Error('Use mixed allocation finalization.');
    this.reader.verify(batchId);
    this.sql.exec("UPDATE reveal_catalog_generations SET phase='complete' WHERE batch_id=? AND phase='active'", batchId);
    return this.reader.status(batchId)!;
  }

  cancel(batchId: string): RevealCatalogUpdateStatus {
    this.transaction(() => {
      const operation = this.reader.operation(batchId);
      if (operation.batch_version === 3) throw new Error('Use mixed allocation cancellation.');
      if (operation.activated_at_ms !== null) throw new Error('An activated catalog update must resume forward.');
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='cancelled' WHERE batch_id=?", batchId);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=NULL WHERE id=1 AND candidate_catalog_generation=?', batchId);
    });
    return this.reader.status(batchId)!;
  }

  prune(batchId: string, pageSize = 256): { remaining: number } {
    const operation = this.reader.operation(batchId);
    limit(pageSize, operation.mode === 'empty-rebuild' ? 4096 : 256);
    if (!['complete', 'cancelled'].includes(operation.phase)) throw new Error('Finish or cancel the operation before pruning.');
    const saved = this.reader.settings()!;
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
    let mixed = 0;
    if (operation.batch_version === 3 && operation.phase === 'cancelled') {
      this.sql.exec(`DELETE FROM reveal_mixed_artworks WHERE rowid IN (SELECT rowid FROM reveal_mixed_artworks WHERE batch_id=? LIMIT ?)`,
        batchId, Math.min(pageSize, 8));
      mixed = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM reveal_mixed_artworks WHERE batch_id=?', batchId).toArray()[0].count;
    }
    return { remaining: count + legacy + mixed };
  }

  pruneObsolete(pageSize = 256): { remaining: number } {
    const row = this.sql.exec<{ batch_id: string }>("SELECT batch_id FROM reveal_catalog_generations WHERE phase IN ('complete','cancelled') ORDER BY rowid DESC LIMIT 1").toArray()[0];
    return row ? this.prune(row.batch_id, pageSize) : { remaining: 0 };
  }
}
