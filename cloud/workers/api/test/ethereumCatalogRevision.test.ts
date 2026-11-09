import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { resolveEthereum111kConfig } from '../../../../shared/ethereum/config.ts';
import { ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE, ethereumCatalogSnapshot, requireEthereumCatalogSnapshot } from '../src/ethereumCatalogRevision.ts';
import { EthereumApiError } from '../src/ethereumError.ts';
import { ethereumInventoryItems } from '../src/ethereumRead.ts';
import type { EthereumContext, EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { d1Database } from './commerceD1Harness.ts';

const contract = `0x${'11'.repeat(20)}`;

function fixture(t: TestContext, legacy = false) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement',
    ...(!legacy ? ['0012_ethereum_reveal_catalog_updates'] : [])]) {
    database.exec(readFileSync(`cloud/workers/api/ops-migrations/${migration}.sql`, 'utf8'));
  }
  const db = d1Database(database);
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: db, COMMERCE_DB: db, ALCHEMY_MI_NOTE_API_KEY: '', ETHEREUM_111K_CHAIN_ID: '11155111',
    ETHEREUM_111K_CONTRACT_ADDRESS: contract, ETHEREUM_111K_DEPLOYMENT_BLOCK: '1', ETHEREUM_111K_RPC_URL: '',
    ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/catalog-test/',
    PUBLIC_SHOP_RATE_LIMITER: limiter, STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter,
  };
  const context: EthereumContext = { env, config: resolveEthereum111kConfig({ contractAddress: contract }),
    nowMs: 1, signal: new AbortController().signal, fetch: async () => assert.fail('Catalog inspection must not request chain or CDN metadata') };
  const register = () => database.prepare(`INSERT INTO ethereum_reveal_deployments
    (deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,deployment_block,catalog_version,template_json,
      template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES('catalog-test','111k_devnet',11155111,?,'https://cdn.mons.shop/111k-sepolia/catalog-test/',1,'111k-v5',?,?,'active',1,1,1,1,1)`)
    .run(contract, JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] }), '0'.repeat(64));
  const begin = () => database.exec(`UPDATE ethereum_reveal_deployments SET catalog_update_id='batch-one',
    catalog_update_started_at_ms=2,revision=revision+1`);
  const finish = () => database.exec(`UPDATE ethereum_reveal_deployments SET effective_catalog_version='111k-v6',
    effective_catalog_sha256='${'1'.repeat(64)}',catalog_revision=1,revision=revision+1`);
  return { context, register, begin, finish, database };
}

const unavailable = (error: unknown) => error instanceof EthereumApiError && error.code === 'unavailable';

test('unregistered and legacy catalogs retain revision zero without initializing a coordinator', async t => {
  const f = fixture(t, true);
  assert.deepEqual(await ethereumCatalogSnapshot(f.context), { deploymentId: null, catalogRevision: 0, artworks: [] });
  f.register();
  const captured = await ethereumCatalogSnapshot(f.context);
  assert.deepEqual(captured, { deploymentId: 'catalog-test', catalogRevision: 0, artworks: [] });
  await requireEthereumCatalogSnapshot(f.context, captured);
});

test('online snapshots resolve the coordinator revision and token metadata before the registry mirror advances', async t => {
  const f = fixture(t);
  f.register();
  f.begin();
  const snapshot = { deploymentId: 'catalog-test', catalogRevision: 1, artworks: [] };
  let reads = 0;
  f.context.env.ETHEREUM_REVEAL = { getByName(name: string) {
    assert.equal(name, `11155111:${contract}`);
    return { async catalogSnapshot(deployment: { catalogRevision?: number }, ids: string[]) {
      reads++;
      assert.equal(deployment.catalogRevision, reads === 1 ? 0 : 1);
      assert.deepEqual(ids, ['7']);
      return snapshot;
    } };
  } } as unknown as NonNullable<EthereumEnvironment['ETHEREUM_REVEAL']>;
  const captured = await ethereumCatalogSnapshot(f.context, ['7']);
  assert.equal(captured, snapshot);
  f.finish();
  await requireEthereumCatalogSnapshot(f.context, captured);
  assert.equal(await ethereumCatalogSnapshot(f.context, ['7']), snapshot);
  assert.equal(reads, 2);
  assert.equal(f.database.prepare('SELECT state FROM ethereum_reveal_deployments').get()!.state, 'active');
});

test('catalog staging and activation do not reject an already captured inventory read', async t => {
  const f = fixture(t);
  f.register();
  const captured = await ethereumCatalogSnapshot(f.context);
  f.begin();
  await requireEthereumCatalogSnapshot(f.context, captured);
  f.finish();
  await requireEthereumCatalogSnapshot(f.context, captured);
});

test('snapshot RPC pages stay bounded and restart internally when activation crosses a page boundary', async t => {
  const f = fixture(t);
  f.register();
  f.begin();
  const tokenIds = Array.from({ length: 2 * ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE + 1 }, (_, index) => String(index + 1));
  const requests: string[][] = [];
  f.context.env.ETHEREUM_REVEAL = { getByName: () => ({ async catalogSnapshot(_deployment: unknown, ids: string[]) {
    requests.push(ids);
    assert.ok(ids.length <= ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE);
    const catalogRevision = requests.length === 1 ? 0 : 1;
    return { deploymentId: 'catalog-test', catalogRevision, artworks: ids.map(tokenId => ({ tokenId,
      metadataRevision: catalogRevision ? 3 : 0, metadataJson: JSON.stringify({ name: catalogRevision ? 'New artwork' : 'Old egg' }) })) };
  } }) } as unknown as NonNullable<EthereumEnvironment['ETHEREUM_REVEAL']>;
  const snapshot = await ethereumCatalogSnapshot(f.context, tokenIds);
  assert.deepEqual(requests.map(ids => ids.length), [16, 16, 16, 16, 1]);
  assert.deepEqual(requests[0], requests[2]);
  assert.equal(snapshot.catalogRevision, 1);
  assert.deepEqual(snapshot.artworks.map(artwork => artwork.tokenId), tokenIds);
  assert.equal(snapshot.artworks.every(artwork => artwork.metadataRevision === 3 && JSON.parse(artwork.metadataJson).name === 'New artwork'), true);
  assert.equal(f.database.prepare('SELECT state FROM ethereum_reveal_deployments').get()!.state, 'active');
});

test('an online operation cannot fall back to stale registry metadata when the coordinator binding is missing', async t => {
  const f = fixture(t);
  f.register();
  f.begin();
  await assert.rejects(ethereumCatalogSnapshot(f.context), unavailable);
  f.finish();
  await assert.rejects(ethereumCatalogSnapshot(f.context), unavailable);
});

test('deployment identity changes still invalidate a captured read', async t => {
  const f = fixture(t);
  const captured = await ethereumCatalogSnapshot(f.context);
  f.register();
  await assert.rejects(requireEthereumCatalogSnapshot(f.context, captured), unavailable);
});

for (const initiallyAssigned of [true, false]) {
  test(`inventory prefers canonical replacement metadata ${initiallyAssigned ? 'without fetching stale CDN bytes' : 'when activation races a CDN read'}`, async t => {
    const f = fixture(t);
    f.register();
    f.begin();
    const metadataJson = '{"name":"New artwork","image":"https://cdn.lil.org/nft/111k/paintings/30991.png","category":"painting","revealStatus":"revealed","attributes":[{"trait_type":"serial","value":9007199254740993}]}';
    let snapshots = 0;
    let cdnReads = 0;
    f.context.fetch = async () => {
      cdnReads++;
      return Response.json({ name: 'Old egg', image: 'https://cdn.lil.org/nft/111k/eggs/76642.png', category: 'egg', revealStatus: 'revealed' });
    };
    f.context.env.ETHEREUM_REVEAL = { getByName: () => ({ async catalogSnapshot(_deployment: unknown, ids: string[]) {
      assert.deepEqual(ids, ['7']);
      const assigned = initiallyAssigned || ++snapshots > 1;
      return { deploymentId: 'catalog-test', catalogRevision: assigned ? 1 : 0,
        artworks: assigned ? [{ tokenId: '7', metadataJson, metadataRevision: 3 }] : [] };
    } }) } as unknown as NonNullable<EthereumEnvironment['ETHEREUM_REVEAL']>;
    const items = await ethereumInventoryItems(f.context, [{ tokenId: '7', kind: 'artwork', displayId: 7, owner: `0x${'22'.repeat(20)}` }]);
    assert.equal(items[0].category, 'painting');
    assert.equal(items[0].metadataRevision, 3);
    assert.equal(items[0].image, 'https://cdn.lil.org/nft/111k/paintings/30991.png');
    assert.match(JSON.stringify(items[0]), /9007199254740993/);
    assert.equal(cdnReads, initiallyAssigned ? 0 : 1);
    assert.equal(f.database.prepare('SELECT catalog_revision FROM ethereum_reveal_deployments').get()!.catalog_revision, 0);
  });
}
