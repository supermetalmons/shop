import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { computeRevealCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import { revealCatalogUpdateHash, type RevealCatalogUpdateBody } from '../../../../shared/ethereum/revealCatalogUpdate.ts';
import { parseEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { RevealSql } from '../src/ethereumRevealStore.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { d1Database } from './commerceD1Harness.ts';

const source = getRevealCatalog('111k-v5')!;
const ancestor = { ...source, catalogVersion: '111k-v4' };
const target = structuredClone(source);
target.catalogVersion = '111k-v6';
target.categories.eggs.count -= 2;
target.categories.videos.count += 2;
target.categories.videos.aspectRatioIndexById = [...target.categories.videos.aspectRatioIndexById!, 0, 0];
const catalogs = [ancestor, source, target].map(manifest => ({ manifest, descriptor: computeRevealCatalogDescriptor(manifest) }));
const registry = `const catalogs=${JSON.stringify(catalogs)};
  export function getRevealCatalog(version,hash) { const entry=catalogs.find(row=>row.manifest.catalogVersion===version);
    return entry && (hash===undefined || hash===entry.descriptor.manifestSha256) ? entry.manifest : undefined; }
  export function getRevealCatalogDescriptor(version) { return catalogs.find(row=>row.manifest.catalogVersion===version)?.descriptor; }
  export function getSupportedRevealCatalogVersions() { return catalogs.map(row=>row.manifest.catalogVersion); }`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  return /revealCatalogRegistry\.(?:js|ts)$/.test(specifier)
    ? { shortCircuit: true, url: `data:text/javascript;base64,${Buffer.from(registry).toString('base64')}` }
    : next(specifier, context);
} });
const { EthereumRevealObject, EthereumRevealStore } = await (async () => {
  try {
    const object = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealObject.ts'));
    const store = await import('../src/ethereumRevealStore.ts');
    return { ...object, ...store };
  } finally { hooks.deregister(); }
})();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const contract = `0x${'ab'.repeat(20)}`;

test('replacement samples use amended artwork while retaining immutable original assignment proof and read-only inspection', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${migration}.sql`, 'utf8'));
  }
  const template = '{"name":"{{tokenId}}","description":"111k","image":"https://cdn.lil.org/nft/111k/placeholder.png","attributes":[]}';
  database.prepare(`INSERT INTO ethereum_reveal_deployments(deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,
    deployment_block,catalog_version,template_json,template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES('amended-replacement','111k_devnet',11155111,?,'https://cdn.mons.shop/111k-sepolia/amended-replacement/',100,
      '111k-v5',?,?,'active',3,1,3,2,3)`).run(contract, template, digest(template));
  const current = () => parseEthereumRevealDeployment(database.prepare('SELECT * FROM ethereum_reveal_deployments').get()!);
  let inspecting = false;
  const sql: RevealSql = { exec(query, ...bindings) {
    if (inspecting) assert.match(query, /^SELECT\b/i);
    const statement = database.prepare(query);
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as never[], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const transaction = <T>(action: () => T): T => {
    assert.equal(inspecting, false);
    database.exec('BEGIN');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const store = new EthereumRevealStore(sql, transaction, () => 0);
  store.configure(current());
  while (!store.initializeChunk()) {}
  const reserve = (crate: string, egg: number) => {
    database.prepare('INSERT INTO crates(crate_token_id) VALUES(?)').run(crate);
    const slot = Number(database.prepare("SELECT slot FROM free_slots WHERE category='egg' AND asset_id=?").get(egg)!.slot);
    const unit = store.catalogUpdate.takeFree('egg', slot);
    database.prepare('INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,?,0)').run(unit.category, unit.assetId, crate);
  };
  const freeze = (crateTokenId: string, first: number) => {
    const tokenIds = Array.from({ length: 20 }, (_, index) => String(first + index));
    store.freeze(current(), { transactionHash: `0x${String(first).padStart(64, '0')}`, blockHash: `0x${'1'.repeat(64)}`, blockNumber: 101 },
      [{ crateTokenId, tokenIds }], 1000);
    for (const tokenId of tokenIds) store.publicationComplete(tokenId);
  };
  reserve('111112', source.categories.eggs.count);
  reserve('111113', source.categories.eggs.count - 1);
  freeze('111112', 21);
  const control = { paused: 0, revision: 1, paused_at_ms: null, chain_id: 11155111, contract_address: contract,
    reset_guard_id: null, last_reset_id: null, updated_at_ms: 1 };
  const env = { OPS_DB: d1Database(database), COMMERCE_DB: { prepare: () => ({ first: async () => control }) },
    ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: contract,
    ETHEREUM_111K_METADATA_BASE_URI: current().metadataBaseUri, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
    ETHEREUM_REVEAL: { idFromName: (name: string) => ({ toString: () => name }) } } as unknown as Env;
  const context = { id: { equals: (other: DurableObjectId) => other.toString() === `11155111:${contract}` },
    storage: { sql, transactionSync: transaction } } as unknown as DurableObjectState;
  const inspect = async () => {
    const changes = database.prepare('SELECT total_changes() AS total').get()!.total;
    inspecting = true;
    try {
      const value = await new EthereumRevealObject(context, env).inspectReplacement({ deploymentId: current().deploymentId,
        expectedRevision: current().revision, frozenThroughMs: 1000 });
      assert.equal(database.prepare('SELECT total_changes() AS total').get()!.total, changes);
      return value;
    } finally { inspecting = false; }
  };
  const before = await inspect();
  const originalRows = database.prepare('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id').all();
  const body: RevealCatalogUpdateBody = { version: 1, nonce: '10000000-0000-4000-8000-000000000001',
    predecessor: catalogs[1], target: catalogs[2], mappings: [1, 2].map(index => ({ eggId: target.categories.eggs.count + index,
      category: 'video', assetId: source.categories.videos.count + index })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  const batch = { ...body, batchSha256, batchId: `catalog-${batchSha256.slice(0, 32)}` };
  store.catalogUpdate.begin(batch, 2000);
  store.catalogUpdate.stageMappings(batch.batchId, batch.mappings);
  store.catalogUpdate.sealMappings(batch.batchId);
  const attributesJson = '[{"trait_type":"collection block","value":"Replacement artwork"}]';
  store.catalogUpdate.metadataStage(batch.batchId, batch.mappings.map(mapping => ({ ...mapping, attributesJson, sha256: digest(attributesJson) })));
  while (store.catalogUpdate.generationStage(batch.batchId).generationSeeded < 111111) {}
  store.catalogUpdate.seal(batch.batchId);
  store.catalogUpdate.activate(batch.batchId, 2001);
  const canonical = store.catalogUpdate.canonicalMetadata(['21'])[0];
  store.catalogUpdate.acknowledgePublication(batch.batchId, '21', canonical.metadataRevision, canonical.targetSha256);
  store.catalogUpdate.finalize(batch.batchId);
  database.exec("UPDATE ethereum_reveal_deployments SET catalog_update_id='catalog-update',catalog_update_started_at_ms=2000,revision=4");
  database.prepare(`UPDATE ethereum_reveal_deployments SET effective_catalog_version='111k-v6',effective_catalog_sha256=?,catalog_revision=1,revision=5`)
    .run(catalogs[2].descriptor.manifestSha256);
  database.exec('UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,catalog_update_started_at_ms=NULL,revision=6');
  const amended = await inspect();
  assert.equal(amended.frozenMetadataSha256, before.frozenMetadataSha256);
  assert.deepEqual(database.prepare('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id').all(), originalRows);
  assert.equal(amended.frozenSamples[0].tokenId, '21');
  assert.equal(amended.frozenSamples[0].metadataSha256, canonical.targetSha256);
  assert.notEqual(amended.frozenSamples[0].metadataSha256, before.frozenSamples[0].metadataSha256);
  assert.equal(amended.frozenSamples[0].enrichment, undefined);
  freeze('111113', 1);
  const newlyFrozen = await inspect();
  const newCanonical = store.catalogUpdate.canonicalMetadata(['1'])[0];
  assert.equal(newCanonical.migration, false);
  assert.equal(newlyFrozen.frozenSamples[0].tokenId, '1');
  assert.equal(newlyFrozen.frozenSamples[0].metadataSha256, newCanonical.targetSha256);
  assert.notEqual(newCanonical.targetSha256, digest(String(database.prepare("SELECT metadata_json FROM assignments WHERE token_id='1'").get()!.metadata_json)));
});
