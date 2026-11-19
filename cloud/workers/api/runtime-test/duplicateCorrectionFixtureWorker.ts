import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { duplicateCorrectionDefinition as definition, duplicateCorrectionDefinitionSha256 as digest } from '../../../../shared/ethereum/installedDuplicateCorrection.ts';
import { computeRevealCatalogDescriptor, REVEAL_ASSET_FAMILIES } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumRevealStore } from '../src/ethereumRevealStore.ts';
import { buildNewRevealedArtwork } from '../src/ethereumRevealCatalog.ts';
import { EthereumDuplicateCorrectionStore } from '../src/ethereumDuplicateCorrectionStore.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';
import artworkTemplate from '../../../../scripts/ethereum-metadata/templates/artwork.json';

const deployment = { ...definition, dropId: '111k', catalogVersion: definition.originCatalogVersion,
  templateJson: JSON.stringify(artworkTemplate), templateSha256: createHash('sha256').update(JSON.stringify(artworkTemplate)).digest('hex'),
  state: 'active', revision: 12, catalogRevision: 2, createdAtMs: 1, updatedAtMs: 2, activatedAtMs: 2,
  provisionedAtMs: 1, lastError: null } satisfies EthereumRevealDeployment;

export class CorrectionFixture extends DurableObject {
  private depth = 0;
  private readonly transaction = <T>(action: () => T): T => {
    if (this.depth) return action();
    return this.ctx.storage.transactionSync(() => {
      this.depth++;
      try { return action(); } finally { this.depth--; }
    });
  };
  private readonly store = new EthereumRevealStore(this.ctx.storage.sql, this.transaction);
  private get sql() { return this.ctx.storage.sql; }

  private seed() {
    this.store.configure(deployment);
    const v9 = getRevealCatalog('111k-v9')!;
    const v10 = getRevealCatalog(definition.catalogVersion)!;
    const frozen = definition.groups.slice(0, 200).flatMap((group, index) => group.slice(0, index < 44 ? 2 : 1));
    this.transaction(() => {
      for (const [batch, revision, manifest] of [['base', 1, v9], ['active', 2, v10]] as const) {
        const descriptor = JSON.stringify(getRevealCatalogDescriptor(manifest.catalogVersion));
        this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
          source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms,seeded,frozen_count,mode)
          VALUES(?,?,?,?,?,?,?,0,?,'complete',1,2,111111,0,?)`, batch, digest, descriptor, descriptor, JSON.stringify(manifest),
        revision - 1, revision, digest, revision === 1 ? 'empty-rebuild' : 'online');
      }
      for (const [category, family] of Object.entries(REVEAL_ASSET_FAMILIES)) {
        const count = v9.categories[family].count;
        this.sql.exec("INSERT INTO reveal_catalog_pools(generation,category,total,seeded,available) VALUES('active',?,?,?,?)", category, count, count, count);
        this.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
          INSERT INTO reveal_catalog_free SELECT 'active',?,id-1,?,id,id FROM ids`, count, category, category);
      }
      this.sql.exec(`UPDATE settings SET ready=1,active_catalog_generation='active',allocation_base_generation='base',catalog_revision=2,
        effective_catalog_version=?,effective_catalog_sha256=? WHERE id=1`, definition.catalogVersion, definition.manifestSha256);
      this.sql.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
      this.sql.exec('CREATE TABLE fixture_frozen(id INTEGER PRIMARY KEY)');
      this.sql.exec('INSERT INTO fixture_frozen SELECT value FROM json_each(?)', JSON.stringify(frozen));
      this.sql.exec(`INSERT INTO fixture_frozen SELECT asset_id FROM reveal_catalog_free WHERE category='painting' AND asset_id%2=0
        AND asset_id NOT IN (SELECT value FROM json_each(?))`, JSON.stringify(definition.groups.flat()));
      this.sql.exec("DELETE FROM reveal_catalog_free WHERE generation='active' AND category='painting'");
      this.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
        INSERT INTO reveal_catalog_free SELECT 'active','painting',row_number() OVER(ORDER BY id)-1,'painting',id,id
        FROM ids WHERE NOT EXISTS(SELECT 1 FROM fixture_frozen WHERE fixture_frozen.id=ids.id)`, v9.categories.paintings.count);
      this.sql.exec(`UPDATE reveal_catalog_pools SET available=total-(SELECT COUNT(*) FROM fixture_frozen)
        WHERE generation='active' AND category='painting'`);
      this.sql.exec(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,
        frozen_at_ms,assignment_revision) SELECT 'painting',id,'111112',id,CAST(id AS TEXT),json_object('name','Painting '||id),
        json_object('name','Painting '||id),'{}',2,1 FROM fixture_frozen`);
      const exchanges = 6_162;
      const firstEgg = v9.categories.eggs.count - exchanges + 1;
      this.sql.exec(`INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id,attributes_json,attributes_sha256)
        SELECT 'active',asset_id,'painting',?+asset_id-?,'[]',? FROM reveal_catalog_free
        WHERE generation='active' AND category='egg' AND asset_id>=?`,
      v9.categories.paintings.count + 1, firstEgg, digest, firstEgg);
      this.sql.exec("DELETE FROM reveal_catalog_free WHERE generation='active' AND category='egg' AND asset_id>=?", firstEgg);
      this.sql.exec(`INSERT INTO reveal_catalog_free SELECT 'active','painting',p.available+m.egg_id-?,
        'egg',m.egg_id,m.asset_id FROM reveal_catalog_mappings m JOIN reveal_catalog_pools p ON p.generation='active' AND p.category='painting'
        WHERE m.batch_id='active'`, firstEgg);
      for (const [category, delta] of [['egg', -exchanges], ['painting', exchanges]] as const) {
        this.sql.exec("UPDATE reveal_catalog_pools SET total=total+?,seeded=seeded+?,available=available+? WHERE generation='active' AND category=?",
          delta, delta, delta, category);
      }
    });
  }

  private reserve(id: number) {
    const slot = this.sql.exec<{ slot: number }>("SELECT slot FROM reveal_catalog_free WHERE generation='active' AND category='painting' AND asset_id=?", id).one().slot;
    const origin = this.store.catalogUpdate.takeFree('painting', slot);
    this.sql.exec("INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,'111112',?)", origin.category, origin.assetId, id);
  }

  private release(id: number) {
    this.sql.exec("DELETE FROM assignments WHERE category='painting' AND asset_id=? AND token_id IS NULL", id);
    this.store.catalogUpdate.releaseFree({ category: 'painting', assetId: id });
  }

  private prepareHolder() {
    const updates = this.store.catalogUpdate;
    const sponsor = '111111';
    const origin = updates.takeFree('egg', 0);
    const artwork = buildNewRevealedArtwork({ tokenId: sponsor, crateTokenId: '111112', templateJson: deployment.templateJson,
      assetId: origin.assetId, category: 'egg', catalog: getRevealCatalog(definition.catalogVersion)!,
      observation: { transactionHash: `0x${'a'.repeat(64)}`, blockHash: `0x${'b'.repeat(64)}`, blockNumber: 100 } });
    this.sql.exec(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,
      frozen_at_ms,assignment_revision) VALUES('egg',?,'111112',0,?,?,?,?,3,2)`, origin.assetId, sponsor,
    JSON.stringify(artwork.artwork), artwork.metadataJson, artwork.placeholderJson);
    this.sql.exec("INSERT INTO publication(token_id,status) VALUES(?,'published')", sponsor);
    updates.ownerHatching.prepare({ batchId: 'fixture-holder', sourceSha256: digest, candidateTokenIds: [sponsor],
      readyCount: 1, grails: [], freshEggIds: [definition.eggCandidates[0]] }, 4);
    const id = definition.groups[201][1];
    const slot = this.sql.exec<{ slot: number }>("SELECT slot FROM reveal_catalog_free WHERE generation='active' AND category='painting' AND asset_id=?", id).one().slot;
    const painting = updates.takeFree('painting', slot);
    updates.ownerHatching.protectOrdinaryReward(painting, { category: 'painting', assetId: id }, 5);
    updates.releaseFree(painting);
  }

  private correction(action: 'inspect' | 'apply' | 'verify', injectFailure = false) {
    let inserted = 0;
    const sql: RevealSql = injectFailure ? { exec: (query, ...bindings) => {
      if (query.includes('INSERT INTO reveal_duplicate_replacements') && ++inserted === 15) throw new Error('injected mapping failure');
      return this.sql.exec(query, ...bindings);
    } } : this.sql;
    return new EthereumDuplicateCorrectionStore(sql, this.transaction, this.store.catalogUpdate).run(action, definition, digest, 2);
  }

  private digestFrozen() {
    const hash = createHash('sha256');
    for (const row of this.sql.exec("SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY category,asset_id")) hash.update(JSON.stringify(row));
    return hash.digest('hex');
  }

  private immutability() {
    for (const query of ["UPDATE reveal_duplicate_replacements SET egg_id=egg_id", "DELETE FROM reveal_duplicate_replacements",
      "DELETE FROM reveal_duplicate_corrections","UPDATE reveal_duplicate_corrections SET replaced=0"]) {
      try { this.sql.exec(query); } catch { continue; }
      throw new Error('Expected immutable audit rows.');
    }
    return true;
  }

  private nextCatalog() {
    const next = { ...getRevealCatalog(definition.catalogVersion)!, catalogVersion: '111k-v11' };
    const descriptor = computeRevealCatalogDescriptor(next);
    this.transaction(() => {
      this.sql.exec(`INSERT INTO reveal_catalog_generations(batch_id,batch_sha256,predecessor_json,target_json,target_manifest_json,
        source_revision,target_revision,mapping_count,mapping_sha256,phase,started_at_ms,activated_at_ms,seeded,frozen_count)
        VALUES('next',?,?,?,?,3,4,0,?,'complete',5,6,111111,0)`, digest, JSON.stringify(getRevealCatalogDescriptor(definition.catalogVersion)),
      JSON.stringify(descriptor), JSON.stringify(next), digest);
      this.sql.exec(`INSERT INTO reveal_catalog_pools SELECT 'next',category,total,seeded,available FROM reveal_catalog_pools WHERE generation='active'`);
      this.sql.exec(`INSERT INTO reveal_catalog_free SELECT 'next',category,slot,origin_category,origin_asset_id,asset_id FROM reveal_catalog_free WHERE generation='active'`);
      this.sql.exec("UPDATE settings SET active_catalog_generation='next',catalog_revision=4,effective_catalog_sha256=?,effective_catalog_version=? WHERE id=1",
        descriptor.manifestSha256, next.catalogVersion);
    });
  }

  fetch(request: Request): Response {
    const command = new URL(request.url).pathname.slice(1);
    try {
      const emptyGroup = definition.groups[200];
      const revealedGroup = definition.groups[155];
      if (command === 'seed') { this.seed(); return Response.json(true); }
      if (command === 'fingerprint') return Response.json(this.digestFrozen());
      if (command === 'has-schema') return Response.json(this.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='reveal_duplicate_replacements'").toArray().length);
      if (command === 'reserve-conflict') { this.transaction(() => this.reserve(revealedGroup[1])); return Response.json(true); }
      if (command === 'release-conflict') { this.transaction(() => this.release(revealedGroup[1])); return Response.json(true); }
      if (command === 'reserve-keeper') { this.transaction(() => this.reserve(emptyGroup[1])); return Response.json(true); }
      if (command === 'release-keeper') { this.transaction(() => this.release(emptyGroup[1])); return Response.json(true); }
      if (command === 'prepare-holder') { this.transaction(() => this.prepareHolder()); return Response.json(true); }
      if (command === 'claim-holder') {
        const result = this.store.catalogUpdate.ownerHatching.hatch('111111', 7);
        return Response.json(result.kind === 'hatched' && result.artwork.image.endsWith(`/paintings/${definition.groups[201][1]}.png`));
      }
      if (command === 'failure') return Response.json(this.correction('apply', true));
      if (command === 'unrelated-corruption') return this.transaction(() => {
        this.sql.exec(`INSERT INTO reveal_catalog_mappings(batch_id,egg_id,category,asset_id,attributes_json,attributes_sha256)
          VALUES('active',2,'painting',1,'[]',?)`, digest);
        return Response.json(this.correction('apply'));
      });
      if (command === 'immutability') return Response.json(this.immutability());
      if (command === 'next-catalog') { this.nextCatalog(); return Response.json(true); }
      if (command === 'full-verify') { this.store.catalogUpdate.reader.verifyGeneration('active'); return Response.json(true); }
      if (command === 'apply' || command === 'inspect' || command === 'verify') return Response.json(this.correction(command));
      return new Response(null, { status: 404 });
    } catch (e) { return Response.json(String(e), { status: 500 }); }
  }
}

export default {
  fetch(request: Request, env: { POOL: DurableObjectNamespace }) { return env.POOL.getByName('correction').fetch(request); }
};
