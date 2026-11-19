import { DurableObject } from 'cloudflare:workers';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getStandaloneOwnerHatchingBatch, requireOrdinaryCatalogTarget } from '../../../../shared/ethereum/ownerHatchingCatalog.ts';
import { getRevealCatalog, getRevealCatalogDescriptor, getSupportedRevealCatalogVersions } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { REVEAL_ASSET_FAMILIES } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { mixedAllocationCounts, type MixedAllocationDefinition } from '../../../../shared/ethereum/revealMixedAllocation.ts';
import { authorizeOwnerHatch } from '../src/ethereumOwnerHatching.ts';
import { EthereumRevealStore } from '../src/ethereumRevealStore.ts';
import { EthereumOwnerHatchingOperations } from '../src/ethereumOwnerHatchingOperations.ts';
import type { OwnerHatchingMaintenanceRequest } from '../../../../shared/ethereum/ownerHatchingMaintenance.ts';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.ts';
import type { MetadataWrite, PublicationScope } from '../src/ethereumRevealPublisherObject.ts';
export { EthereumRevealPublisherObject as LocalPublisher } from '../src/ethereumRevealPublisherObject.ts';
import type { EthereumRevealPublisherObject } from '../src/ethereumRevealPublisherObject.ts';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';

import { mixedAllocationScope, parseMixedAllocationMaintenanceRequest } from '../../../../shared/ethereum/mixedAllocationMaintenance.ts';
import { EthereumMixedAllocationOperation } from '../src/ethereumMixedAllocationOperation.ts';
import artworkTemplate from '../../../../scripts/ethereum-metadata/templates/artwork.json';
import { getMainnet111kArtists } from '../../../../shared/ethereum/mainnet111kArtists.ts';
const legacyBatch = 'previous-owner-batch';
const templateJson = JSON.stringify(artworkTemplate);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const observation = { transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 101 };
declare const REHEARSAL_DEFINITION: MixedAllocationDefinition;
const fixtureScope = mixedAllocationScope(REHEARSAL_DEFINITION);
const batchId = fixtureScope.batchId;
const deployment: EthereumRevealDeployment = {
  ...fixtureScope, dropId: fixtureScope.chainId === 1 ? '111k' : '111k_devnet',
  catalogVersion: REHEARSAL_DEFINITION.version === 1 ? '111k-v8' : REHEARSAL_DEFINITION.originCatalogVersion, templateJson, templateSha256: hash(templateJson), state: 'active',
  revision: 4, catalogRevision: 1, createdAtMs: 1, updatedAtMs: 3, activatedAtMs: 3, provisionedAtMs: 2, lastError: null
};
const fixtureCandidates = Array.from({ length: 424 }, (_, index) => String(index + 1));
const crateTokenIds = (start: number) => Array.from({ length: 20 }, (_, index) => String(start + index));
type FixtureEnv = { OPS_DB: D1Database; POOL: DurableObjectNamespace; DEFINITION: string; WALLET: string; ETHEREUM_REVEAL_METADATA: R2Bucket; ETHEREUM_REVEAL_PUBLISHER: DurableObjectNamespace<EthereumRevealPublisherObject> };
const fixtureRpcEnv = { ETHEREUM_111K_CHAIN_ID: String(deployment.chainId), ALCHEMY_MI_NOTE_API_KEY: 'local-fixture', ETHEREUM_PROVIDER_CONTROL_ENABLED: 'false' };
const nativeNow = Date.now;
let clockOffset = 0;
Date.now = () => nativeNow() + clockOffset;
type FixtureRequest = { expectedRevision?: number; definitionSha256?: string; offset?: number; signature?: string; kind?: 'animated' | 'painting' };
type FixtureChain = { reorg: number; head: number; clock_offset: number; redeemed_token: string | null };
const blockHash = (reorg: number, block: number) => `0x${(reorg * 10000 + block).toString(16).padStart(64, '0')}`;

globalThis.fetch = async () => { throw new Error('External requests are disabled in the mixed allocation rehearsal.'); };

export class LocalMixedPool extends DurableObject<FixtureEnv> {
  private readonly definition: MixedAllocationDefinition;
  private readonly store: EthereumRevealStore;
  private readonly choices: number[] = [];
  private readonly operations: EthereumOwnerHatchingOperations;
  private readonly registry: EthereumMixedAllocationOperation | undefined;

  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, env);
    this.definition = JSON.parse(env.DEFINITION);
    if (this.definition.version === 1) {
      assert.deepEqual(getSupportedRevealCatalogVersions(), [deployment.catalogVersion, this.definition.predecessor.catalogVersion, this.definition.target.catalogVersion]);
      assert.throws(() => getStandaloneOwnerHatchingBatch(this.definition.sourceSha256), /mixed/i);
      assert.throws(() => requireOrdinaryCatalogTarget(deployment.chainId, this.definition.target), /requires mixed allocation/);
    }
    let depth = 0;
    const transaction = <T>(work: () => T): T => depth ? work() : ctx.storage.transactionSync(() => {
      depth++;
      try { return work(); } finally { depth--; }
    });
    this.store = new EthereumRevealStore(ctx.storage.sql, transaction, max => {
      const value = this.choices.shift() ?? 0;
      assert.ok(value >= 0 && value < max, 'Invalid fixture random choice.');
      return value;
    });
    const release = { batchId, definition: this.definition, targetCatalog: getRevealCatalog(this.definition.target.catalogVersion, this.definition.target.manifestSha256)! };
    const operations = (requireCurrent: (expected?: number) => Promise<void>) => new EthereumOwnerHatchingOperations({
      env: { ...env, ...fixtureRpcEnv } as unknown as Env, sql: ctx.storage.sql, store: this.store, transaction,
      recover: async ids => this.store.frozen(ids).length === ids.length, requireCurrent, wake: async () => {},
    }, release);
    this.operations = operations(async revision => { if (revision !== undefined) assert.equal(revision, deployment.revision); });
    if (ctx.id.equals(env.POOL.idFromName(`${deployment.chainId}:${deployment.contractAddress}`))) {
      this.registry = new EthereumMixedAllocationOperation({ db: env.OPS_DB, storage: ctx.storage, sql: ctx.storage.sql,
        operations: (_current, requireCurrent) => operations(requireCurrent),
      }, release);
    }
  }

  private run(action: OwnerHatchingMaintenanceRequest['action'], expectedRevision = deployment.revision, definitionSha256?: string) {
    const request = { action, deploymentId: deployment.deploymentId, batchId, expectedRevision,
      ...(this.definition.version === 2 ? { definitionSha256 } : {}) };
    return this.registry ? this.registry.run(parseMixedAllocationMaintenanceRequest(request)) : this.operations.run(deployment, request);
  }

  private get update() { return this.store.catalogUpdate; }
  private get sql() { return this.ctx.storage.sql; }

  private seedPredecessor() {
    const catalog = getRevealCatalog(this.definition.predecessor.catalogVersion)!;
    const descriptor = JSON.stringify(this.definition.predecessor);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms,seeded,frozen_count,mode)
        VALUES('local-base',?,?,?,?,0,1,0,?,'complete',1,2,111111,0,'empty-rebuild')`, 'a'.repeat(64),
        JSON.stringify(getRevealCatalogDescriptor(deployment.catalogVersion)), descriptor, JSON.stringify(catalog), hash('[]'));
      for (const [category, family] of Object.entries(REVEAL_ASSET_FAMILIES)) {
        const { count, assetIds } = catalog.categories[family];
        this.sql.exec("INSERT INTO reveal_catalog_pools(generation,category,total,seeded,available) VALUES('local-base',?,?,?,?)", category, count, count, count);
        if (!count) continue;
        if (assetIds) this.sql.exec(`INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
          SELECT 'local-base',?,key,?,value,value FROM json_each(?)`, category, category, JSON.stringify(assetIds));
        else this.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
          INSERT INTO reveal_catalog_free(generation,category,slot,origin_category,origin_asset_id,asset_id)
          SELECT 'local-base',?,id-1,?,id,id FROM ids`, count, category, category);
      }
      this.sql.exec(`UPDATE settings SET active_catalog_generation='local-base',allocation_base_generation='local-base',catalog_revision=1,
        effective_catalog_version=?,effective_catalog_sha256=? WHERE id=1`, this.definition.predecessor.catalogVersion, this.definition.predecessor.manifestSha256);
    });
  }

  private seed() {
    this.sql.exec('CREATE TABLE fixture_chain(reorg INTEGER, head INTEGER, clock_offset INTEGER, redeemed_token TEXT)');
    this.sql.exec('INSERT INTO fixture_chain VALUES(0,1000,0,NULL)');
    this.store.configure(deployment);
    while (!this.store.initializeChunk()) { }
    if (deployment.catalogVersion !== this.definition.predecessor.catalogVersion) this.seedPredecessor();
    if (this.definition.version === 2) {
      let remaining = mixedAllocationCounts(this.definition).readyCount;
      for (let crate = 0; remaining > 0; crate++) {
        const pools = this.update.reader.pools().filter(pool => pool.available > 0);
        const egg = pools.find(pool => pool.category === 'egg');
        if (!egg || egg.available < remaining) throw new Error('Fixture predecessor has insufficient egg inventory.');
        const eggs = Math.min(remaining, 6);
        const eggOffset = pools.filter(pool => pool.category < 'egg').reduce((sum, pool) => sum + pool.total, 0);
        const ordinary = pools.find(pool => pool.category !== 'egg');
        if (!ordinary) throw new Error('Fixture predecessor cannot form a mixed crate.');
        for (let slot = 0; slot < 20; slot++) {
          const offset = slot < eggs ? eggOffset : ordinary.category < 'egg' || eggs === 6 ? 0 : egg.total;
          this.choices.push(offset, 0);
        }
        this.store.freeze(deployment, { ...observation, transactionHash: `0x${(crate + 1).toString(16).padStart(64, '0')}` },
          [{ crateTokenId: String(111112 + crate), tokenIds: crateTokenIds(1 + 20 * crate) }], 100);
        remaining -= eggs;
      }
      return;
    }
    this.ctx.storage.transactionSync(() => {
      for (let crate = 0; crate < 72; crate++) {
        const crateTokenId = String(111112 + crate);
        const eggOffset = this.update.reader.pools().filter(pool => pool.category < 'egg').reduce((sum, pool) => sum + pool.total, 0);
        for (let slot = 0; slot < 20; slot++) this.choices.push(slot < 6 ? eggOffset : 0, 0);
        this.store.freeze(deployment, { ...observation, transactionHash: `0x${(crate + 1).toString(16).padStart(64, '0')}` },
          [{ crateTokenId, tokenIds: crateTokenIds(1 + 20 * crate) }], 100);
      }
      this.update.ownerHatching.prepare({
        batchId: 'previous-drowee-grail', sourceSha256: 'c'.repeat(64), candidateTokenIds: ['424'],
        readyCount: 1, grails: [{ category: 'animated', assetId: 422, attributesJson: '[{"trait_type":"collection block","value":"DROWEE"}]' }], freshEggIds: []
      });
      assert.equal(this.update.ownerHatching.hatch('424').kind, 'hatched');
      this.update.ownerHatching.prepare({
        batchId: legacyBatch, sourceSha256: 'b'.repeat(64), candidateTokenIds: ['425', '426'],
        readyCount: 2, grails: [], freshEggIds: [76699, 76700]
      });
    });
    return this.inventory();
  }

  async validatePublication(scope: PublicationScope, job: MetadataWrite) {
    assert.equal(scope.chainId, deployment.chainId);
    assert.equal(scope.contractAddress, deployment.contractAddress);
    return this.update.reader.validateMetadataWrite(job);
  }

  private async seedMetadata() {
    const rows = this.sql.exec<{ token_id: string; metadata_json: string }>('SELECT token_id,metadata_json FROM assignments WHERE token_id IS NOT NULL').toArray();
    for (let offset = 0; offset < rows.length; offset += 16) {
      await Promise.all(rows.slice(offset, offset + 16).map(row => this.env.ETHEREUM_REVEAL_METADATA.put(
        new URL(ethereumTokenMetadataUri(deployment, row.token_id)).pathname.slice(1), row.metadata_json,
        { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } })));
    }
    this.sql.exec("UPDATE publication SET status='published'");
  }

  private inventory() {
    const pools = this.update.reader.pools();
    const generation = this.update.reader.settings()!.active_catalog_generation!;
    const count = this.sql.exec<{ free: number; reserved: number; frozen: number }>(`SELECT
      (SELECT COUNT(*) FROM reveal_catalog_free WHERE generation=?) AS free,
      (SELECT COUNT(*) FROM assignments WHERE token_id IS NULL) AS reserved,
      (SELECT COUNT(*) FROM assignments WHERE token_id IS NOT NULL) AS frozen`, generation).one();
    assert.equal(count.free, pools.reduce((sum, pool) => sum + pool.available, 0));
    assert.equal(count.free + count.reserved + count.frozen, 111111);
    assert.equal(pools.reduce((sum, pool) => sum + pool.total, 0), 111111);
    return { ...count, freeEggs: pools.find(pool => pool.category === 'egg')!.available, revision: this.update.reader.settings()!.catalog_revision };
  }

  private assignmentFingerprint() {
    const rows = this.sql.exec<{ category: 'egg' | 'animated' | 'painting' | '3d' | 'video'; asset_id: number; token_id: string | null; crate_token_id: string; slot: number; metadata_json: string | null }>(
      'SELECT category,asset_id,token_id,crate_token_id,slot,metadata_json FROM assignments ORDER BY category,asset_id').toArray();
    const values = rows.map(row => {
      const effective = this.update.reader.resolveUnit({ category: row.category, assetId: row.asset_id });
      return [row, effective.category, effective.assetId];
    });
    return hash(JSON.stringify(values));
  }

  private reserveEggFromCandidateTail() {
    const candidate = this.sql.exec<{ slot: number }>(`SELECT a.slot FROM reveal_catalog_free c JOIN reveal_catalog_free a
      ON a.origin_category=c.origin_category AND a.origin_asset_id=c.origin_asset_id
      WHERE c.generation=? AND c.category='egg' AND a.generation='local-base' AND a.category='egg' ORDER BY c.slot DESC LIMIT 1`, batchId).one();
    const categoryDraw = this.update.reader.pools().filter(pool => pool.category < 'egg' && pool.available).reduce((sum, pool) => sum + pool.total, 0);
    this.choices.push(categoryDraw, candidate.slot);
    this.store.reserve(['116661']);
    const slot = this.sql.exec<{ category: 'egg'; asset_id: number }>("SELECT category,asset_id FROM assignments WHERE crate_token_id='116661' AND slot=0").one();
    assert.equal(this.update.reader.resolveUnit({ category: slot.category, assetId: slot.asset_id }).category, 'egg');
  }

  private legacyHatchAfterActivation() {
    const free = this.update.reader.pools().filter(pool => pool.category !== 'egg' && pool.available > 0);
    const range = this.definition.groups.find(group => group.category === 'painting')!;
    const painting = this.sql.exec<{ slot: number; asset_id: number }>(`SELECT slot,asset_id FROM reveal_catalog_free
      WHERE generation=? AND category='painting' AND asset_id>=? ORDER BY slot LIMIT 1`, batchId, range.firstId).one();
    const picks = [free.slice(0, free.findIndex(pool => pool.category === 'painting')).reduce((sum, pool) => sum + pool.available, 0), painting.slot];
    const original = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues');
    Object.defineProperty(crypto, 'getRandomValues', {
      configurable: true, value: (bytes: Uint32Array) => {
        assert.equal(bytes.length, 1);
        const value = picks.shift();
        assert.notEqual(value, undefined);
        bytes[0] = value!;
        return bytes;
      }
    });
    try {
      const result = this.update.ownerHatching.hatch('426');
      assert.equal(result.kind, 'hatched');
      if (result.kind === 'hatched') assert.equal(result.artwork.image, `https://cdn.lil.org/nft/111k/paintings/${painting.asset_id}.png`);
      assert.match(this.update.ownerHatching.reader.canonical('426')!.metadataJson, /9007199254740993/);
      assert.equal(this.sql.exec("SELECT 1 FROM owner_hatching_enrichment WHERE token_id='426'").toArray().length, 0);
      assert.equal(picks.length, 0);
    } finally {
      if (original) Object.defineProperty(crypto, 'getRandomValues', original);
      else Reflect.deleteProperty(crypto, 'getRandomValues');
    }
  }

  private checkAllocation() {
    const counts = this.definition.groups.map(group => {
      const owner = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM owner_hatching_grails
        WHERE batch_id=? AND category=? AND asset_id BETWEEN ? AND ?`, batchId, group.category, group.firstId, group.lastId).one().n;
      const future = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM reveal_catalog_free
        WHERE generation=? AND category=? AND asset_id BETWEEN ? AND ?`, batchId, group.category, group.firstId, group.lastId).one().n;
      assert.equal(owner, group.ownerCount);
      assert.equal(owner + future, group.lastId - group.firstId + 1);
      return { collection: group.collectionBlock, owner, future };
    });
    assert.equal(this.sql.exec(`SELECT 1 FROM reveal_catalog_free f JOIN owner_hatching_grails g ON g.category=f.category AND g.asset_id=f.asset_id
      WHERE f.generation=? AND g.batch_id=? LIMIT 1`, batchId, batchId).toArray().length, 0);
    assert.equal(this.sql.exec(`SELECT COUNT(*) AS n FROM reveal_catalog_publications WHERE batch_id=?`, batchId).one().n, 0);
    const readyIds = this.sql.exec<{ token_id: string }>('SELECT token_id FROM owner_hatching_tokens WHERE batch_id=?', batchId).toArray().map(row => row.token_id);
    assert.ok(['424', '425', '426'].every(tokenId => !readyIds.includes(tokenId)));
    const chain = this.sql.exec<FixtureChain>('SELECT * FROM fixture_chain').one();
    assert.ok(chain.redeemed_token && !readyIds.includes(chain.redeemed_token));
    const cutoff = this.sql.exec<{ block_number: number; block_hash: string }>(
      'SELECT block_number,block_hash FROM owner_hatching_activation WHERE batch_id=?', batchId).one();
    assert.equal(cutoff.block_number, chain.head);
    assert.equal(cutoff.block_hash, blockHash(chain.reorg, chain.head));
    assert.match(this.store.frozen(['424'])[0].animation_url!, /animated\/422\.gif$/);
    const stagedOwners = this.store.frozen(readyIds);
    assert.equal(stagedOwners.length, fixtureCandidates.length);
    for (const artwork of stagedOwners) {
      assert.equal(artwork.category, 'egg');
      assert.equal(artwork.readyToHatch, true);
      assert.doesNotMatch(JSON.stringify(artwork), /grail|reward|futureCount|mainnet-mixed-20261117/);
    }
    this.update.reader.verifyGeneration(batchId);
    return counts;
  }

  private fixtureFetch(chain: FixtureChain): typeof fetch {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href.startsWith(deployment.metadataBaseUri)) {
        const object = await this.env.ETHEREUM_REVEAL_METADATA.get(url.pathname.slice(1));
        if (!object) return new Response(null, { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }
      if (url.origin === 'https://cdn.lil.org') {
        if (init?.method === 'GET' && new Headers(init.headers).get('Range') === 'bytes=0-32' && /^\/nft\/111k\/eggs\/[1-9]\d*\.png$/.test(url.pathname)) {
          return new Response('sample', { status: 206, headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } });
        }
        const match = /^\/nft\/111k\/(paintings|videos|3d|animated)\/json\/v0\/(\d+)\.json$/.exec(url.pathname);
        assert.ok(match);
        const category = match[1] === 'paintings' ? 'painting' : match[1] === 'videos' ? 'video' : match[1];
        const id = Number(match[2]);
        const group = this.definition.groups.find(g => g.category === category && id >= g.firstId && id <= g.lastId);
        assert.ok(group);
        return new Response(`{"collection block":${JSON.stringify(group.collectionBlock)},"attributes":[{"trait_type":"fixture serial","value":9007199254740993}]}`,
          { headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(url.href, `https://eth-${deployment.chainId === 1 ? 'mainnet' : 'sepolia'}.g.alchemy.com/v2/local-fixture`);
      type RpcRow = { id: number; method: string; params: [{ data: string } | string, string | { blockHash: string }] };
      const payload: RpcRow | RpcRow[] = JSON.parse(String(init!.body));
      const respond = (row: RpcRow) => {
        let result: unknown;
        if (row.method === 'eth_chainId') result = '0x' + deployment.chainId.toString(16);
        else if (row.method === 'eth_getBlockByNumber') {
          const block = row.params[0] === 'latest' ? chain.head : Number(row.params[0]);
          result = { number: `0x${block.toString(16)}`, hash: blockHash(chain.reorg, block) };
        } else if (row.method === 'eth_getCode') result = '0x';
        else if (row.method === 'eth_call' && typeof row.params[0] === 'object') {
          const data = row.params[0].data;
          if (data.startsWith(encodeCall(ETHEREUM_FUNCTIONS.stats, [], []))) {
            const minted = this.definition.version === 1 ? 1440 : this.sql.exec<{n: number}>('SELECT COUNT(*) AS n FROM assignments WHERE token_id IS NOT NULL').one().n;
            result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
              [Math.ceil(minted / 20), 0, minted, 1, 1, true, `0x${'0'.repeat(64)}`, 1, 1, 0, 0, 0, 0, 0, 0]);
          } else {
            assert.ok(data.startsWith(encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], [])));
            const [ids] = decodeReturn(['uint256[]'], `0x${data.slice(10)}`) as [bigint[]];
            const ref = row.params[1];
            const atHead = ref === 'latest' || (typeof ref === 'object' && ref.blockHash === blockHash(chain.reorg, chain.head));
            result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => atHead && String(id) === chain.redeemed_token
              ? [0, 0, `0x${'0'.repeat(40)}`] : [1, id, this.env.WALLET])]);
          }
        } else throw new Error(`Unexpected fixture RPC ${row.method}.`);
        return { jsonrpc: '2.0', id: row.id, result };
      };
      return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
    };
  }

  private async claim(kind: 'animated' | 'painting', signature: string) {
    const { token_id: tokenId, grail_asset_id: assetId } = this.sql.exec<{ token_id: string; grail_asset_id: number }>(
      'SELECT token_id,grail_asset_id FROM owner_hatching_tokens WHERE batch_id=? AND grail_category=? ORDER BY CAST(token_id AS INTEGER) LIMIT 1', batchId, kind).one();
    await authorizeOwnerHatch({ ...this.env, ...fixtureRpcEnv } as unknown as Env, deployment, tokenId, signature);
    const result = this.update.ownerHatching.hatch(tokenId);
    assert.equal(result.kind, 'hatched');
    if (result.kind !== 'hatched') throw new Error('Fixture claim failed.');
    const { artwork } = result;
    assert.equal(artwork.tokenId, tokenId);
    assert.equal(artwork.crateTokenId, String(111112 + Math.floor((Number(tokenId) - 1) / 20)));
    assert.deepEqual(artwork.observation, { ...observation, transactionHash: `0x${(Math.floor((Number(tokenId) - 1) / 20) + 1).toString(16).padStart(64, '0')}` });
    assert.equal(artwork.category, kind);
    const collection = this.definition.groups.find(group => group.category === kind && assetId >= group.firstId && assetId <= group.lastId)!;
    assert.equal(artwork.collectionBlock, collection.collectionBlock);
    const family = kind === 'animated' ? 'animated' : 'paintings';
    assert.equal(artwork.image, `https://cdn.lil.org/nft/111k/${family}/${assetId}.png`);
    if (kind === 'animated') assert.equal(artwork.animation_url, `https://cdn.lil.org/nft/111k/animated/${assetId}.mp4`);
    const canonical = this.update.ownerHatching.reader.canonical(tokenId)!;
    assert.equal(canonical.metadataJson.includes('9007199254740993'), true);
    assert.ok(!canonical.artwork.readyToHatch);
    const artists = deployment.chainId === 1 ? getMainnet111kArtists(collection.collectionBlock) : [];
    const { attributes } = JSON.parse(canonical.metadataJson);
    assert.deepEqual(attributes.filter((value: { trait_type: string }) => value.trait_type === 'artist'),
      artists.map(value => ({ trait_type: 'artist', value })));
    assert.deepEqual(attributes.slice(0, 1 + artists.length), [
      { trait_type: 'collection block', value: collection.collectionBlock }, ...artists.map(value => ({ trait_type: 'artist', value })),
    ]);
    return hash(JSON.stringify(result));
  }

  private leaveNearCapacity() {
    const keep = 6162;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE fixture_egg_reservations AS SELECT slot,origin_category,origin_asset_id
        FROM reveal_catalog_free WHERE generation='local-base' AND category='egg' AND slot>=?`, keep);
      this.sql.exec(`INSERT OR IGNORE INTO crates(crate_token_id) SELECT DISTINCT CAST(111190+CAST((slot-?)/6 AS INTEGER) AS TEXT) FROM fixture_egg_reservations`, keep);
      this.sql.exec(`DELETE FROM reveal_catalog_free WHERE generation='local-base' AND category='egg' AND slot>=?`, keep);
      this.sql.exec(`UPDATE reveal_catalog_pools SET available=? WHERE generation='local-base' AND category='egg'`, keep);
      this.sql.exec(`INSERT INTO assignments(category,asset_id,crate_token_id,slot)
        SELECT origin_category,origin_asset_id,CAST(111190+CAST((slot-?)/6 AS INTEGER) AS TEXT),(slot-?)%6 FROM fixture_egg_reservations`, keep, keep);
      this.sql.exec('DROP TABLE fixture_egg_reservations');
    });
    return this.inventory();
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname.slice(1);
    const input = await request.json<FixtureRequest>();
    const previousFetch = globalThis.fetch;
    try {
      let result: unknown;
      const mixed = this.update.mixed;
      if (path !== 'seed') {
        const state = this.sql.exec<FixtureChain>('SELECT * FROM fixture_chain').one();
        clockOffset = state.clock_offset;
        globalThis.fetch = this.fixtureFetch(state);
      }
      if (path.startsWith('operation/')) return Response.json(await this.run(path.slice('operation/'.length) as OwnerHatchingMaintenanceRequest['action'], input.expectedRevision, input.definitionSha256));
      switch (path) {
        case 'seed': result = this.seed(); break;
        case 'seed-metadata': await this.seedMetadata(); break;
        case 'near-capacity': result = this.leaveNearCapacity(); break;
        case 'capacity-before-begin':
          assert.throws(() => this.ctx.storage.transactionSync(() => {
            const eggOffset = this.update.reader.pools().filter(pool => pool.category < 'egg').reduce((sum, pool) => sum + pool.total, 0);
            this.choices.push(eggOffset, 0);
            this.store.reserve(['116660']);
            mixed.begin({ batchId, definition: this.definition, targetCatalog: getRevealCatalog(this.definition.target.catalogVersion)! });
          }), /free egg/i);
          break;
        case 'capacity-activate':
        case 'late-claim-after-free-slot-swap': {
          const eligible = this.sql.exec<{ token_id: string }>(`SELECT a.token_id FROM assignments a
            WHERE a.category='egg' AND a.token_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM owner_hatching_tokens t WHERE t.token_id=a.token_id)
            ORDER BY CAST(a.token_id AS INTEGER) LIMIT 424`).toArray();
          const activate = () => mixed.activate(batchId, eligible.map(row => row.token_id));
          if (path === 'capacity-activate') { result = activate(); break; }
          const rollback = new Error('End of independent late-claim fixture.');
          assert.throws(() => this.ctx.storage.transactionSync(() => {
            const origin = this.update.takeFree('painting', 0);
            const backing = this.update.reader.resolveUnit(origin);
            assert.equal(backing.category, 'painting');
            this.update.ownerHatching.protectOrdinaryReward(origin, { category: 'painting', assetId: backing.assetId });
            this.update.releaseFree(origin);
            activate();
            const exchanged = this.update.reader.resolveUnit(origin);
            assert.equal(exchanged.category, 'painting');
            assert.notEqual(exchanged.assetId, backing.assetId);
            const { sponsor } = this.sql.exec<{ sponsor: string }>('SELECT sponsor FROM owner_hatching_ordinary_backing').one();
            const claim = this.update.ownerHatching.hatch(sponsor);
            assert.equal(claim.kind, 'hatched');
            assert.equal(this.update.ownerHatching.reader.canonical(sponsor)?.assetId, backing.assetId);
            assert.deepEqual(this.update.ownerHatching.hatch(sponsor), claim);
            assert.deepEqual(this.update.reader.resolveUnit(origin), exchanged);
            mixed.verify(batchId);
            throw rollback;
          }), error => error === rollback);
          break;
        }
        case 'cancel': result = await this.operations.cancelMixed(deployment, { deploymentId: deployment.deploymentId, batchId, expectedRevision: deployment.revision }); break;
        case 'reorg': this.sql.exec('UPDATE fixture_chain SET reorg=reorg+1,head=head+1'); break;
        case 'redeem-selected': {
          const candidate = this.sql.exec<{ token_id: string }>(`SELECT token_id FROM owner_hatching_activation_candidates
            WHERE batch_id=? AND live=1 ORDER BY position LIMIT 1`, batchId).one();
          result = this.sql.exec<{ head: number }>('UPDATE fixture_chain SET head=head+1,redeemed_token=? RETURNING head', candidate.token_id).one().head;
          break;
        }
        case 'begin-reordered': result = await this.registry!.run(parseMixedAllocationMaintenanceRequest({
          expectedRevision: deployment.revision, batchId, deploymentId: deployment.deploymentId, action: 'begin'
        })); break;
        case 'advance-clock': this.sql.exec('UPDATE fixture_chain SET clock_offset=clock_offset+300001'); break;
        case 'later-catalog': {
          const target = { ...this.update.reader.activeCatalog(), catalogVersion: '111k-v11' };
          const descriptor = { catalogVersion: target.catalogVersion, manifestSha256: hash(JSON.stringify(target)) };
          this.ctx.storage.transactionSync(() => {
            this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
              source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms,seeded,frozen_count)
              VALUES('fixture-next',?,?,?,?,2,3,0,?,'complete',3,4,111111,0)`, 'b'.repeat(64), JSON.stringify(this.definition.target),
              JSON.stringify(descriptor), JSON.stringify(target), hash('[]'));
            this.sql.exec(`INSERT INTO reveal_catalog_pools(generation,category,total,seeded,available)
              SELECT 'fixture-next',category,total,seeded,available FROM reveal_catalog_pools WHERE generation=?`, batchId);
            this.sql.exec("UPDATE reveal_catalog_free SET generation='fixture-next' WHERE generation=?", batchId);
            this.sql.exec(`UPDATE settings SET active_catalog_generation='fixture-next',catalog_revision=3,
              effective_catalog_version=?,effective_catalog_sha256=? WHERE id=1`, descriptor.catalogVersion, descriptor.manifestSha256);
          });
          result = descriptor;
          break;
        }
        case 'activation-draw': result = hash(JSON.stringify(this.sql.exec('SELECT token_id FROM owner_hatching_activation_candidates WHERE batch_id=? ORDER BY position', batchId).toArray())); break;
        case 'complete-audit': {
          for (const table of ['owner_hatching_candidates', 'owner_hatching_trait_staging', 'owner_hatching_activation_candidates']) {
            assert.equal(this.sql.exec(`SELECT 1 FROM ${table} WHERE batch_id=? LIMIT 1`, batchId).toArray().length, 0);
          }
          assert.equal(this.sql.exec("SELECT 1 FROM reveal_catalog_free WHERE generation='local-base' LIMIT 1").toArray().length, 0);
          assert.equal(this.sql.exec('SELECT COUNT(*) AS n FROM reveal_mixed_artworks WHERE batch_id=? AND attributes_json IS NOT NULL', batchId).one().n, 6586);
          for (const table of ['reveal_catalog_mappings', 'owner_hatching_grails']) {
            assert.equal(this.sql.exec(`SELECT 1 FROM ${table} WHERE batch_id=? AND attributes_json IS NOT NULL`, batchId).toArray().length, 0);
          }
          result = this.sql.exec('SELECT verification_passes FROM owner_hatching_preparations WHERE batch_id=?', batchId).one();
          break;
        }
        case 'traits': {
          const first = input.offset ?? 0;
          const rows = this.definition.groups.flatMap(group => Array.from({ length: group.lastId - group.firstId + 1 }, (_, index) => ({
            category: group.category, assetId: group.firstId + index, collectionBlock: group.collectionBlock
          })));
          const page = rows.slice(first, first + 128).map(({ category, assetId, collectionBlock }) => {
            const attributesJson = `[{"trait_type":"collection block","value":${JSON.stringify(collectionBlock)}},{"trait_type":"fixture serial","value":9007199254740993}]`;
            return { category, assetId, attributesJson, sha256: hash(attributesJson) };
          });
          result = mixed.stageTraits(batchId, page);
          break;
        }
        case 'inventory': result = mixed.stageInventory(batchId, 4096); break;
        case 'seal': result = mixed.seal(batchId); break;
        case 'activate': result = mixed.activate(batchId, this.sql.exec<{ token_id: string }>('SELECT token_id FROM owner_hatching_tokens WHERE batch_id=?', batchId).toArray().map(row => row.token_id)); break;
        case 'changed-activation-replay': result = mixed.activate(batchId, [...fixtureCandidates.slice(1), '425']); break;
        case 'too-few-minted': result = mixed.activate(batchId, fixtureCandidates.slice(1)); break;
        case 'interrupt-activation':
          this.sql.exec(`CREATE TRIGGER fixture_fail_cutover BEFORE UPDATE OF active_catalog_generation ON settings
            WHEN NEW.active_catalog_generation!=OLD.active_catalog_generation BEGIN SELECT RAISE(ABORT,'fixture activation interruption'); END`);
          try { result = await this.run('activate'); }
          finally { this.sql.exec('DROP TRIGGER fixture_fail_cutover'); }
          break;
        case 'reserve-raced-egg': this.reserveEggFromCandidateTail(); break;
        case 'stage-traffic': {
          this.store.reserve(['115990']);
          const [reservation] = this.sql.exec<{ category: 'egg' | '3d' | 'animated' | 'video' | 'painting'; asset_id: number; slot: number }>(
            "SELECT category,asset_id,slot FROM assignments WHERE crate_token_id='115990' ORDER BY slot DESC LIMIT 1").toArray();
          this.ctx.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM assignments WHERE crate_token_id='115990' AND slot=? AND token_id IS NULL", reservation.slot);
            this.update.releaseFree({ category: reservation.category, assetId: reservation.asset_id });
          });
          this.store.freeze(deployment, observation, [{ crateTokenId: '115990', tokenIds: crateTokenIds(2001) }], 1000);
          assert.equal(this.update.ownerHatching.hatch('425').kind, 'hatched');
          assert.equal(this.store.frozen(crateTokenIds(2001)).length, 20);
          result = this.inventory();
          break;
        }
        case 'crate-claim': {
          const firstNew = this.definition.groups.find(group => group.category === 'painting')!.firstId;
          const free = this.sql.exec<{ slot: number; asset_id: number }>(`SELECT slot,asset_id FROM reveal_catalog_free WHERE generation=?
            AND category='painting' AND asset_id>=? ORDER BY slot LIMIT 1`, batchId, firstNew).one();
          const pools = this.update.reader.pools().filter(pool => pool.available);
          this.choices.push(pools.slice(0, pools.findIndex(pool => pool.category === 'painting')).reduce((sum, pool) => sum + pool.total, 0), free.slot);
          this.store.reserve(['115992']);
          this.store.freeze(deployment, observation, [{ crateTokenId: '115992', tokenIds: crateTokenIds(2021) }], 1001);
          const [artwork] = this.store.frozen(['2021'], { includeCollectionBlock: true });
          assert.equal(artwork.image, `https://cdn.lil.org/nft/111k/paintings/${free.asset_id}.png`);
          assert.equal(artwork.collectionBlock, this.definition.groups.find(group => group.category === 'painting' && free.asset_id >= group.firstId && free.asset_id <= group.lastId)!.collectionBlock);
          assert.equal(this.update.ownerHatching.reader.reservedGrail({ category: 'painting', assetId: free.asset_id }), false);
          break;
        }
        case 'crate-metadata': {
          const key = new URL(ethereumTokenMetadataUri(deployment, '2021')).pathname.slice(1);
          const object = await this.env.ETHEREUM_REVEAL_METADATA.get(key);
          assert.ok(object);
          const body = await object.text();
          const canonical = this.update.reader.canonicalMetadata(['2021'])[0];
          assert.equal(canonical.category, 'painting');
          assert.equal(canonical.artwork.crateTokenId, '115992');
          assert.equal(body, canonical.metadataJson);
          assert.match(body, /9007199254740993/);
          assert.doesNotMatch(body, /readyToHatch/);
          assert.equal(JSON.parse(body).image, `https://cdn.lil.org/nft/111k/paintings/${canonical.assetId}.png`);
          break;
        }
        case 'legacy-claim': this.legacyHatchAfterActivation(); break;
        case 'owner-claim': result = await this.claim(input.kind!, input.signature!); break;
        case 'inventory-only': result = this.inventory(); break;
        case 'assignment-fingerprint': result = this.assignmentFingerprint(); break;
        case 'draw-fingerprint': result = hash(JSON.stringify(this.sql.exec('SELECT category,asset_id,owner_reward,position FROM reveal_mixed_artworks WHERE batch_id=? ORDER BY owner_reward,position', batchId).toArray())); break;
        case 'snapshot': result = {
          inventory: this.inventory(), fingerprint: this.assignmentFingerprint(),
          ready: this.update.ownerHatching.reader.batchStatus(batchId)?.ready ?? 0,
          hatched: this.update.ownerHatching.reader.batchStatus(batchId)?.hatched ?? 0
        }; break;
        case 'assert-allocation': result = this.checkAllocation(); break;
        case 'publish-page': {
          const owner = this.update.ownerHatching;
          const jobs = this.store.claimPublications(Date.now(), this.definition.version === 1 ? 2 : 16);
          if (jobs.length) {
            const publisher = this.env.ETHEREUM_REVEAL_PUBLISHER.getByName(`${deployment.chainId}:${deployment.contractAddress}`);
            const outcomes = await publisher.publishBatch(deployment, jobs);
            assert.deepEqual(outcomes.map(row => row.status), jobs.map(() => 'published'));
            this.store.completePublications(jobs.map(job => ({ job, status: 'published' })), Date.now());
          }
          result = { ...owner.reader.batchStatus(batchId), cratePublished: this.sql.exec("SELECT 1 FROM publication WHERE token_id='2021' AND status='published'").toArray().length === 1 };
          break;
        }
        default: throw new Error('Unknown local rehearsal action.');
      }
      return Response.json(result ?? true);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
    } finally { globalThis.fetch = previousFetch; }
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv) {
    const fixture = new URL(request.url).searchParams.get('fixture') ?? 'full';
    assert.ok(fixture === 'full' || fixture === 'limited');
    return env.POOL.getByName(fixture === 'full' ? `${deployment.chainId}:${deployment.contractAddress}` : fixture).fetch(request);
  }
};
