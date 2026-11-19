import { checkRevealMedia } from '../../../../shared/ethereum/revealMediaPreflight.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import collectionBlocks from '../../../../scripts/ethereum-metadata/reveal-assets/111k_devnet/collection-blocks.json';
import supplement from '../../../../shared/ethereum/ownerHatchingCatalog.json';
import { isMainnet111kArtistDeployment, requireMainnet111kArtistCoverage } from '../../../../shared/ethereum/mainnet111kArtists.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { validateRevealAssetCatalog, type RevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { drawMixedAllocation, mixedAllocationCounts, validateMixedAllocationDefinition, validateMixedAllocationRelease, type MixedAllocationArtwork, type MixedAllocationDefinition } from '../../../../shared/ethereum/revealMixedAllocation.js';
import { validateStagedRevealMetadata } from './ethereumRevealAttributes.js';
import { buildNewRevealedArtwork, REVEAL_ARTWORK_COUNT, revealRandomInteger } from './ethereumRevealCatalog.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import type { EthereumRevealCatalogReader } from './ethereumRevealCatalogReader.js';
import { validateCatalogPageSize } from './ethereumRevealCatalogReader.js';
import type { RevealCatalogMetadataStage, RevealCatalogUpdateStatus } from './ethereumRevealCatalogTypes.js';
import type { EthereumOwnerHatchingStore } from './ethereumOwnerHatchingStore.js';
import type { RevealSql } from './ethereumRevealStore.js';

const hash = (data: string) => bytesToHex(sha256(data));
const schema = [
  `CREATE TABLE IF NOT EXISTS reveal_mixed_operations (batch_id TEXT PRIMARY KEY REFERENCES reveal_catalog_generations(batch_id),
    definition_json TEXT NOT NULL,ready_count INTEGER NOT NULL,owner_candidates_sha256 TEXT)`,
  `CREATE TABLE IF NOT EXISTS reveal_mixed_fresh_eggs(batch_id TEXT NOT NULL REFERENCES reveal_mixed_operations(batch_id),
    egg_id INTEGER NOT NULL,checked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(batch_id,egg_id))`,
  `CREATE TABLE IF NOT EXISTS reveal_mixed_artworks (batch_id TEXT NOT NULL REFERENCES reveal_mixed_operations(batch_id),
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,owner_reward INTEGER NOT NULL CHECK(owner_reward IN (0,1)),
    position INTEGER NOT NULL,attributes_json TEXT,attributes_sha256 TEXT,
    PRIMARY KEY(batch_id,category,asset_id),UNIQUE(batch_id,owner_reward,position),CHECK((attributes_json IS NULL)=(attributes_sha256 IS NULL)))`,
  `CREATE TRIGGER IF NOT EXISTS reveal_mixed_definition_immutable BEFORE UPDATE ON reveal_mixed_operations
    WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.definition_json IS NOT OLD.definition_json OR NEW.ready_count IS NOT OLD.ready_count
      OR OLD.owner_candidates_sha256 IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Mixed allocation identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS reveal_mixed_artwork_immutable BEFORE UPDATE ON reveal_mixed_artworks
    WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.category IS NOT OLD.category OR NEW.asset_id IS NOT OLD.asset_id
      OR NEW.owner_reward IS NOT OLD.owner_reward OR NEW.position IS NOT OLD.position OR OLD.attributes_json IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Mixed artwork identity and staged traits are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS reveal_mixed_artwork_no_delete BEFORE DELETE ON reveal_mixed_artworks
    WHEN (SELECT phase FROM reveal_catalog_generations WHERE batch_id=OLD.batch_id)!='cancelled'
    BEGIN SELECT RAISE(ABORT,'Mixed artwork history is immutable'); END`,
  `CREATE INDEX IF NOT EXISTS reveal_mixed_staged_count ON reveal_mixed_artworks(batch_id) WHERE attributes_sha256 IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS reveal_mixed_unstaged ON reveal_mixed_artworks(batch_id,category,asset_id) WHERE attributes_json IS NULL`,
];

type Header = {
  batch_id: string; batch_sha256: string; phase: RevealCatalogUpdateStatus['phase']; seeded: number; mapping_count: number;
  source_revision: number; target_revision: number; activated_at_ms: number | null; definition_json: string; ready_count: number; owner_candidates_sha256: string | null
};
type Asset = MixedAllocationArtwork;

export type MixedAllocationInput = { batchId: string; definition: MixedAllocationDefinition; targetCatalog: RevealAssetCatalog };

export class EthereumRevealMixedAllocation {
  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T,
    private readonly reader: EthereumRevealCatalogReader, private readonly owner: EthereumOwnerHatchingStore) { }

  private header(batchId: string): Header {
    const header = this.sql.exec<Header>(`SELECT g.batch_id,g.batch_sha256,g.phase,g.seeded,g.mapping_count,g.source_revision,g.target_revision,
      g.activated_at_ms,m.definition_json,m.ready_count,m.owner_candidates_sha256 FROM reveal_catalog_generations g
      JOIN reveal_mixed_operations m USING(batch_id) WHERE g.batch_id=? AND g.batch_version=3`, batchId).toArray()[0];
    if (!header) throw new Error('Unknown mixed allocation.');
    return header;
  }

  private checkCandidate(header: Header): string | null {
    const settings = this.reader.settings()!;
    if (settings.candidate_catalog_generation !== header.batch_id ||
      settings.catalog_revision !== header.source_revision) throw new Error('Mixed allocation predecessor changed.');
    return settings.active_catalog_generation;
  }

  private drawFreshEggs(batchId: string, count: number) {
    if (!count) return;
    const { lastIssued, maximum, used } = this.reader.requireFreshEggInventory(count);
    const eligible = [];
    for (let id = lastIssued + 1; id <= maximum; id++) if (!used.has(id)) eligible.push(id);
    const chosen = [];
    for (let i = 0; i < count; i++) {
      const index = revealRandomInteger(eligible.length);
      chosen.push(eligible[index]);
      eligible[index] = eligible.at(-1)!;
      eligible.pop();
    }
    this.sql.exec('INSERT INTO reveal_mixed_fresh_eggs(batch_id,egg_id) SELECT ?,value FROM json_each(?)', batchId, JSON.stringify(chosen));
  }

  async checkFreshMediaPage(release: MixedAllocationInput, fetchSource: typeof fetch = fetch): Promise<boolean> {
    if (!mixedAllocationCounts(release.definition).ordinaryCount) return false;
    const ids = this.sql.exec<{egg_id: number}>(
      'SELECT egg_id FROM reveal_mixed_fresh_eggs WHERE batch_id=? AND checked=0 ORDER BY egg_id LIMIT 8', release.batchId).toArray();
    if (!ids.length) return false;
    const eggs = release.targetCatalog.categories.eggs;
    await Promise.all(ids.map(({ egg_id }) => {
      const url = (eggs.baseUrl ?? release.targetCatalog.baseUrl) + eggs.pathTemplate.replace('{id}', String(egg_id));
      return checkRevealMedia(url, ['image/png'], fetchSource);
    }));
    this.transaction(() => {
      this.checkCandidate(this.header(release.batchId));
      this.sql.exec('UPDATE reveal_mixed_fresh_eggs SET checked=1 WHERE batch_id=? AND egg_id IN (SELECT value FROM json_each(?))',
        release.batchId, JSON.stringify(ids.map(row => row.egg_id)));
    });
    return true;
  }

  begin({ batchId, definition, targetCatalog }: MixedAllocationInput, now = Date.now()) {
    if (typeof batchId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(batchId) || !Number.isSafeInteger(now) || now < 1) throw new Error('Invalid mixed allocation identity.');
    validateMixedAllocationDefinition(definition);
    validateRevealAssetCatalog(targetCatalog, definition.target);
    const json = JSON.stringify(definition);
    const digest = hash(json);
    this.transaction(() => {
      for (const statement of schema) this.sql.exec(statement);
      if (this.sql.exec('SELECT 1 FROM reveal_catalog_generations WHERE batch_id=?', batchId).toArray().length) {
        const previous = this.header(batchId);
        if (previous.batch_sha256 !== digest || previous.phase === 'cancelled') throw new Error('Mixed allocation replay changed.');
        return;
      }
      const before = getRevealCatalog(definition.predecessor.catalogVersion, definition.predecessor.manifestSha256);
      if (!before || !getRevealCatalog(definition.target.catalogVersion, definition.target.manifestSha256)) throw new Error('Mixed allocation catalog support is missing.');
      validateMixedAllocationRelease(definition, before, targetCatalog, collectionBlocks, supplement);
      const settings = this.reader.settings();
      const current = this.reader.effectiveCatalog();
      if (!settings || !current ||
        settings.candidate_catalog_generation || current.catalogVersion !== definition.predecessor.catalogVersion ||
        current.manifestSha256 !== definition.predecessor.manifestSha256 || !this.sql.exec('SELECT 1 FROM settings WHERE id=1 AND ready=1').toArray().length ||
        this.sql.exec("SELECT 1 FROM reveal_catalog_generations WHERE phase='active' LIMIT 1").toArray().length ||
        this.owner.reader.batchStatus(batchId)) throw new Error('Mixed allocation requires its ready predecessor and a free operation identity.');
      const deployment: EthereumRevealDeployment = JSON.parse(settings.deployment_json);
      if (definition.version === 2 && (definition.deploymentId !== deployment.deploymentId || definition.chainId !== deployment.chainId ||
        definition.contractAddress.toLowerCase() !== deployment.contractAddress.toLowerCase() || definition.deploymentBlock !== deployment.deploymentBlock ||
        definition.metadataBaseUri !== deployment.metadataBaseUri || definition.originCatalogVersion !== deployment.catalogVersion || definition.batchId !== batchId) ||
        definition.version === 1 && deployment.chainId !== 1) throw new Error('Mixed allocation deployment does not match.');
      if (isMainnet111kArtistDeployment(deployment)) requireMainnet111kArtistCoverage(revealCollectionBlocks(definition.target));
      if (this.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='reveal_duplicate_replacements' AND type='table'").toArray().length &&
        this.sql.exec(`SELECT 1 FROM json_each(?) g JOIN reveal_duplicate_replacements r ON r.origin_category='painting'
          AND r.origin_asset_id BETWEEN json_extract(g.value,'$.firstId') AND json_extract(g.value,'$.lastId')
          WHERE json_extract(g.value,'$.category')='painting' LIMIT 1`, JSON.stringify(definition.groups)).toArray().length) {
        throw new Error('Mixed allocation contains a retired painting.');
      }
      const draw = drawMixedAllocation(definition, revealRandomInteger);
      this.reader.requireMixedCapacity(draw.future.length, mixedAllocationCounts(definition).ordinaryCount);
      for (let index = draw.owner.length - 1; index > 0; index--) {
        const next = revealRandomInteger(index + 1);
        [draw.owner[next], draw.owner[index]] = [draw.owner[index], draw.owner[next]];
      }
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,batch_version) VALUES(?,?,?,?,?,?,?,?,?,'staging',?,3)`,
        batchId, digest, JSON.stringify(definition.predecessor), JSON.stringify(definition.target), JSON.stringify(targetCatalog), current.catalogRevision,
        current.catalogRevision + 1, draw.future.length, hash(JSON.stringify(draw.future)), now);
      this.sql.exec('INSERT INTO reveal_mixed_operations(batch_id,definition_json,ready_count) VALUES(?,?,?)', batchId, json, mixedAllocationCounts(definition).readyCount);
      this.drawFreshEggs(batchId, mixedAllocationCounts(definition).ordinaryCount);
      for (const [ownerReward, assets] of [draw.future, draw.owner].entries()) {
        for (let start = 0; start < assets.length; start += 256) this.sql.exec(`INSERT INTO reveal_mixed_artworks(batch_id,category,asset_id,owner_reward,position)
          SELECT ?,json_extract(value,'$.category'),json_extract(value,'$.assetId'),?,key+? FROM json_each(?)`,
          batchId, ownerReward, start, JSON.stringify(assets.slice(start, start + 256)));
      }
      for (const pool of this.reader.pools()) this.sql.exec(
        'INSERT INTO reveal_catalog_pools(generation,category,total,seeded) VALUES(?,?,?,?)', batchId, pool.category, pool.total, pool.total);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=? WHERE id=1', batchId);
    });
    return this.status(batchId);
  }

  status(batchId: string) {
    const header = this.header(batchId);
    const owner = this.owner.reader.batchStatus(batchId);
    const metadataStaged = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reveal_mixed_artworks WHERE batch_id=? AND attributes_sha256 IS NOT NULL', batchId).toArray()[0].n;
    return {
      batchId, phase: header.phase, readyCount: header.ready_count, futureCount: header.mapping_count,
      metadataStaged, generationSeeded: header.seeded, activatedAtMs: header.activated_at_ms, ready: owner?.ready ?? 0,
      hatched: owner?.hatched ?? 0, published: owner?.published ?? 0
    };
  }

  pendingTraits(batchId: string, pageSize = 8): Asset[] {
    validateCatalogPageSize(pageSize);
    return this.sql.exec<Asset>(`SELECT category,asset_id AS assetId FROM reveal_mixed_artworks
      WHERE batch_id=? AND attributes_json IS NULL ORDER BY category,asset_id LIMIT ?`, batchId, pageSize).toArray();
  }

  stageTraits(batchId: string, rows: RevealCatalogMetadataStage[]) {
    validateCatalogPageSize(rows.length);
    this.transaction(() => {
      const header = this.header(batchId);
      this.checkCandidate(header);
      if (header.phase !== 'staging' && header.phase !== 'ready') throw new Error('Mixed allocation traits cannot be staged.');
      const definition: MixedAllocationDefinition = JSON.parse(header.definition_json);
      const catalog = getRevealCatalog(definition.target.catalogVersion, definition.target.manifestSha256)!;
      const deployment: EthereumRevealDeployment = JSON.parse(this.reader.settings()!.deployment_json);
      for (const row of rows) {
        const previous = this.sql.exec<{ attributes_sha256: string | null }>(`SELECT attributes_sha256 FROM reveal_mixed_artworks
          WHERE batch_id=? AND category=? AND asset_id=?`, batchId, row.category, row.assetId).toArray()[0];
        if (!previous || hash(row.attributesJson) !== row.sha256 || previous.attributes_sha256 !== null && previous.attributes_sha256 !== row.sha256) {
          throw new Error('Mixed allocation trait identity or checksum changed.');
        }
        if (previous.attributes_sha256 !== null) continue;
        if (header.phase !== 'staging') throw new Error('Sealed mixed allocation is missing traits.');
        const base = buildNewRevealedArtwork({
          templateJson: deployment.templateJson, tokenId: String(REVEAL_ARTWORK_COUNT), crateTokenId: '116666',
          category: row.category, assetId: row.assetId, catalog, deployment, ownerHatching: row.category === 'animated',
          observation: { transactionHash: `0x${'0'.repeat(64)}`, blockHash: `0x${'0'.repeat(64)}`, blockNumber: 0 }
        });
        validateStagedRevealMetadata(base, row.attributesJson, isMainnet111kArtistDeployment(deployment));
        this.sql.exec('UPDATE reveal_mixed_artworks SET attributes_json=?,attributes_sha256=? WHERE batch_id=? AND category=? AND asset_id=?',
          row.attributesJson, row.sha256, batchId, row.category, row.assetId);
      }
    });
    return this.status(batchId);
  }

  stageInventory(batchId: string, pageSize = 1024) {
    validateCatalogPageSize(pageSize, 4096);
    this.transaction(() => {
      const header = this.header(batchId);
      const active = this.checkCandidate(header);
      if (header.phase === 'ready' || header.seeded === REVEAL_ARTWORK_COUNT) return;
      if (header.phase !== 'staging') throw new Error('Mixed inventory is not staging.');
      const page = this.reader.originPage(header.seeded + 1, pageSize);
      const source = active ? 'reveal_catalog_free' : 'free_slots';
      const origin = active ? 'f.origin_category' : 'f.category';
      const asset = active ? 'f.origin_asset_id' : 'f.asset_id';
      const where = `${active ? 'f.generation=? AND ' : ''}${origin}=? AND ${asset} BETWEEN ? AND ?`;
      const args = [...(active ? [active] : []), page.category, page.firstId, page.lastId];
      this.sql.exec(`INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
        SELECT ?,f.category,p.available+ROW_NUMBER() OVER (PARTITION BY f.category ORDER BY ${asset})-1,
          ${origin},${asset},f.asset_id FROM ${source} f JOIN reveal_catalog_pools p ON p.generation=? AND p.category=f.category
        WHERE ${where}`, batchId, batchId, ...args);
      this.sql.exec(`UPDATE reveal_catalog_pools AS p SET available=available+(SELECT COUNT(*) FROM ${source} f
        WHERE ${where} AND f.category=p.category) WHERE generation=?`, ...args, batchId);
      this.sql.exec('UPDATE reveal_catalog_generations SET seeded=seeded+? WHERE batch_id=?', page.count, batchId);
    });
    return this.status(batchId);
  }

  seal(batchId: string) {
    this.transaction(() => {
      const header = this.header(batchId);
      this.checkCandidate(header);
      if (header.phase === 'ready') return;
      if (header.phase !== 'staging' || header.seeded !== REVEAL_ARTWORK_COUNT || this.pendingTraits(batchId, 1).length) {
        throw new Error('Mixed allocation staging is incomplete.');
      }
      this.reader.verifyGeneration(batchId);
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='ready' WHERE batch_id=?", batchId);
    });
    return this.status(batchId);
  }

  activate(batchId: string, candidateTokenIds: string[], now = Date.now()) {
    return this.transaction(() => {
      const header = this.header(batchId);
      if (!Number.isSafeInteger(now) || now < 1 || !Array.isArray(candidateTokenIds) || candidateTokenIds.length !== header.ready_count ||
        new Set(candidateTokenIds).size !== candidateTokenIds.length || candidateTokenIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || Number(id) > REVEAL_ARTWORK_COUNT)) {
        throw new Error('Mixed allocation requires its exact eligible minted token cohort.');
      }
      const definition: MixedAllocationDefinition = JSON.parse(header.definition_json);
      const ordinaryCount = mixedAllocationCounts(definition).ordinaryCount;
      const candidatesHash = hash(JSON.stringify(ordinaryCount ? candidateTokenIds : [...candidateTokenIds].sort((a, b) => Number(a) - Number(b))));
      if (header.activated_at_ms !== null) {
        if (header.owner_candidates_sha256 !== candidatesHash) throw new Error('Mixed activation replay changed.');
        return this.status(batchId);
      }
      const freshEggIds = ordinaryCount ? this.sql.exec<{ egg_id: number }>(
        'SELECT egg_id FROM reveal_mixed_fresh_eggs WHERE batch_id=? AND checked=1 ORDER BY egg_id', batchId).toArray().map(row => row.egg_id) : [];
      if (freshEggIds.length !== ordinaryCount) throw new Error('Private fresh egg media validation is incomplete.');
      const active = this.checkCandidate(header);
      if (header.phase !== 'ready' || this.owner.reader.batchStatus(batchId)) throw new Error('Mixed allocation is not ready to activate.');
      const available = (category: string) => this.sql.exec<{ n: number }>('SELECT available AS n FROM reveal_catalog_pools WHERE generation=? AND category=?',
        batchId, category).toArray()[0].n;
      this.reader.requireMixedCapacity(header.mapping_count, freshEggIds.length);
      const eggStart = available('egg') - header.mapping_count;
      if (eggStart < 0) throw new Error('Not enough free eggs for mixed allocation.');
      const grants = this.sql.exec<Asset>('SELECT category,asset_id AS assetId FROM reveal_mixed_artworks WHERE batch_id=? AND owner_reward=1 ORDER BY position', batchId).toArray();
      if (header.ready_count) this.owner.prepare({ batchId, sourceSha256: definition.sourceSha256, readyCount: header.ready_count,
        candidateTokenIds, grails: grants, freshEggIds }, now, { frozenOrder: true });
      const liveJoin = active
        ? `JOIN reveal_catalog_free live ON live.generation=? AND live.category='egg' AND live.asset_id=f.asset_id
          AND live.origin_category=f.origin_category AND live.origin_asset_id=f.origin_asset_id`
        : `JOIN free_slots live ON live.category='egg' AND live.asset_id=f.asset_id AND f.origin_category=live.category AND f.origin_asset_id=live.asset_id`;
      this.sql.exec(`INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id,origin_category,origin_asset_id)
        SELECT ?,f.asset_id,a.category,a.asset_id,f.origin_category,f.origin_asset_id
        FROM reveal_mixed_artworks a JOIN reveal_catalog_free f ON f.generation=? AND f.category='egg' AND f.slot=?+a.position
        ${liveJoin} WHERE a.batch_id=? AND a.owner_reward=0`, batchId, batchId, eggStart, ...(active ? [active] : []), batchId);
      const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reveal_catalog_mappings WHERE batch_id=?', batchId).toArray()[0].n;
      if (count !== header.mapping_count || this.sql.exec(`SELECT 1 FROM reveal_catalog_mappings m JOIN assignments a
        ON a.category=m.origin_category AND a.asset_id=m.origin_asset_id WHERE m.batch_id=? LIMIT 1`, batchId).toArray().length) {
        throw new Error('Mixed allocation free egg reconciliation failed.');
      }
      this.reader.verifyCutoffClaims(batchId);
      const categories = this.sql.exec<{ category: Asset['category']; count: number }>(
        'SELECT category,COUNT(*) AS count FROM reveal_catalog_mappings WHERE batch_id=? GROUP BY category', batchId).toArray();
      for (const category of categories) {
        this.sql.exec(`WITH swaps AS MATERIALIZED (SELECT m.egg_id,m.asset_id,?+ROW_NUMBER() OVER (ORDER BY a.position)-1 AS slot
          FROM reveal_catalog_mappings m JOIN reveal_mixed_artworks a USING(batch_id,category,asset_id)
          WHERE m.batch_id=? AND m.category=?)
          UPDATE reveal_catalog_free AS f SET category=?,slot=s.slot,asset_id=s.asset_id FROM swaps s
          WHERE f.generation=? AND f.category='egg' AND f.slot>=? AND f.asset_id=s.egg_id`,
          available(category.category), batchId, category.category, category.category, batchId, eggStart);
        if (this.sql.exec<{ n: number }>('SELECT changes() AS n').toArray()[0].n !== category.count) {
          throw new Error('Mixed allocation did not exchange every free egg.');
        }
      }
      for (const { category, count: delta } of [...categories, { category: 'egg', count: -count }]) this.sql.exec(`UPDATE reveal_catalog_pools
        SET available=available+?,total=total+?,seeded=seeded+? WHERE generation=? AND category=?`, delta, delta, delta, batchId, category);
      if (ordinaryCount) this.sql.exec('DELETE FROM reveal_mixed_fresh_eggs WHERE batch_id=?', batchId);
      this.sql.exec('UPDATE reveal_mixed_operations SET owner_candidates_sha256=? WHERE batch_id=?', candidatesHash, batchId);
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='active',activated_at_ms=? WHERE batch_id=?", now, batchId);
      this.sql.exec(`UPDATE settings SET active_catalog_generation=?,candidate_catalog_generation=NULL,effective_catalog_version=?,
        effective_catalog_sha256=?,catalog_revision=? WHERE id=1`, batchId, definition.target.catalogVersion, definition.target.manifestSha256, header.target_revision);
      return this.status(batchId);
    });
  }

  verify(batchId: string) {
    const header = this.header(batchId);
    if (header.activated_at_ms === null) throw new Error('Mixed allocation is not active.');
    const catalog = this.reader.verify(batchId);
    const status = this.status(batchId);
    const owner = this.owner.reader.batchStatus(batchId);
    const definition: MixedAllocationDefinition = JSON.parse(header.definition_json);
    const expected = mixedAllocationCounts(definition);
    if (catalog.frozen !== 0 || catalog.mapped !== expected.futureCount || status.futureCount !== expected.futureCount ||
      status.readyCount !== expected.readyCount || status.ready + status.hatched !== status.readyCount ||
      (owner?.grailCount ?? 0) !== expected.preassignedCount || (owner?.freshEggCount ?? 0) !== expected.ordinaryCount ||
      status.metadataStaged !== expected.totalCount) {
      throw new Error('Mixed allocation conservation failed.');
    }
    const backing = this.sql.exec<{ pending: number; unclaimed: number; inconsistent: number }>(`SELECT
      COUNT(CASE WHEN t.status='ready' THEN 1 END) AS pending,COUNT(CASE WHEN b.claimed_by IS NULL THEN 1 END) AS unclaimed,
      COUNT(CASE WHEN t.batch_id!=f.batch_id OR t.grail_asset_id IS NOT NULL
        OR (t.status='ready')!=(f.token_id IS NULL) OR (f.token_id IS NOT NULL AND f.token_id!=b.sponsor)
        OR b.claimed_by IS NOT c.token_id THEN 1 END) AS inconsistent
      FROM owner_hatching_ordinary_backing b JOIN owner_hatching_tokens t ON t.token_id=b.sponsor
      JOIN owner_hatching_fresh_eggs f ON f.egg_id=b.egg_id LEFT JOIN owner_hatching_artwork_claims c ON c.category=b.category AND c.asset_id=b.asset_id`).toArray()[0];
    if (backing.pending !== backing.unclaimed || backing.inconsistent) throw new Error('Ordinary hatch backing is inconsistent.');
    const poolBalances = new Map<string, number>();
    for (const group of definition.groups) {
      const counts = this.sql.exec<{ reserved: number; future: number }>(`SELECT
        COUNT(CASE WHEN a.owner_reward=1 AND g.asset_id IS NOT NULL AND m.asset_id IS NULL THEN 1 END) AS reserved,
        COUNT(CASE WHEN a.owner_reward=0 AND g.asset_id IS NULL AND m.asset_id IS NOT NULL THEN 1 END) AS future
        FROM reveal_mixed_artworks a
        LEFT JOIN owner_hatching_grails g ON g.batch_id=a.batch_id AND g.category=a.category AND g.asset_id=a.asset_id
        LEFT JOIN reveal_catalog_mappings m ON m.batch_id=a.batch_id AND m.category=a.category AND m.asset_id=a.asset_id
        WHERE a.batch_id=? AND a.category=? AND a.asset_id BETWEEN ? AND ?`, batchId, group.category, group.firstId, group.lastId).toArray()[0];
      const pool = group.pool !== undefined ? 'pool:' + group.pool : `range:${group.category}:${group.firstId}`;
      poolBalances.set(pool, (poolBalances.get(pool) ?? 0) + counts.reserved - group.ownerCount);
      if (counts.reserved + counts.future !== group.lastId - group.firstId + 1) {
        throw new Error('Mixed allocation groups do not match the frozen draw.');
      }
    }
    if ([...poolBalances.values()].some(balance => balance !== 0)) throw new Error('Mixed allocation quota did not match the frozen draw.');
    if (this.sql.exec(`SELECT 1 FROM owner_hatching_tokens t LEFT JOIN owner_hatching_grails g
      ON g.batch_id=t.batch_id AND g.category=t.grail_category AND g.asset_id=t.grail_asset_id
      WHERE t.batch_id=? AND t.grail_asset_id IS NOT NULL AND g.asset_id IS NULL LIMIT 1`, batchId).toArray().length) {
      throw new Error('Mixed owner token is missing its private reward.');
    }
    if (this.sql.exec(`SELECT 1 FROM reveal_catalog_mappings m JOIN assignments a ON a.category=m.origin_category AND a.asset_id=m.origin_asset_id
      WHERE m.batch_id=? AND a.token_id IS NOT NULL AND a.assignment_revision<? LIMIT 1`, batchId, header.target_revision).toArray().length) {
      throw new Error('Mixed allocation changed an existing frozen assignment.');
    }
    return status;
  }

  cancel(batchId: string) {
    return this.transaction(() => {
      const header = this.header(batchId);
      if (header.phase === 'cancelled') return this.status(batchId);
      if (header.activated_at_ms !== null) throw new Error('An activated mixed allocation must resume forward.');
      this.checkCandidate(header);
      if (JSON.parse(header.definition_json).ordinaryCount) this.sql.exec('DELETE FROM reveal_mixed_fresh_eggs WHERE batch_id=?', batchId);
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='cancelled' WHERE batch_id=?", batchId);
      this.sql.exec('UPDATE settings SET candidate_catalog_generation=NULL WHERE id=1 AND candidate_catalog_generation=?', batchId);
      return this.status(batchId);
    });
  }

  finalize(batchId: string) {
    return this.transaction(() => {
      if (this.header(batchId).phase === 'complete') return this.status(batchId);
      const status = this.verify(batchId);
      const publication = this.owner.reader.batchStatus(batchId);
      if (publication && (publication.published !== status.readyCount || publication.pendingPublication || publication.pendingEnrichment ||
        publication.failedEnrichment || publication.conflicts)) throw new Error('Mixed allocation owner publication is incomplete.');
      this.sql.exec("UPDATE reveal_catalog_generations SET phase='complete' WHERE batch_id=? AND phase='active'", batchId);
      return this.status(batchId);
    });
  }
}
