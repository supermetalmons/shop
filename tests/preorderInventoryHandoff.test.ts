import assert from 'node:assert/strict';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import test, { beforeEach } from 'node:test';

beforeEach(context => { if ('after' in context) installBrowserLocks(context); });
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { getPreorderConfig, preorderMetadataUri } from '../shared/preorders.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';
import { d1Database as sqliteD1Database } from '../cloud/workers/api/test/commerceD1Harness.ts';

const { handlePost } = await import(new URL('../cloud/workers/api/src/shopInventory.ts', import.meta.url).href);
const { defaultDependencies } = await import(new URL('../cloud/workers/api/src/publicRouteSupport.ts', import.meta.url).href);
type ProviderFetch = typeof fetch;

const SIGNATURE = bs58.encode(new Uint8Array(64).fill(1));
const assetId = (seed: string) => bs58.encode(createHash('sha256').update(seed).digest());
const rpcResult = (id: string | number, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
const quietDependencies = (providerFetch: ProviderFetch) => ({ ...defaultDependencies,
  providerFetch, randomUint32: () => 0, sleep: async () => {}, log: () => {} });
const env = ({ commerceDb }: { commerceDb: ReturnType<typeof sqliteD1Database> }) => ({ COMMERCE_DB: commerceDb,
  HELIUS_API_KEY: 'test-key', PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
const request = (pathname: string, body: unknown) => new Request(`https://api.mons.shop${pathname}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' }, body: JSON.stringify(body),
});
async function handleRequest(request: Request, environment: ReturnType<typeof env>, dependencies: ReturnType<typeof quietDependencies>): Promise<Response> {
  return (await handlePost(request, environment, '/inventory', dependencies, {
    upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0, expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0,
  })).response;
}
function rpcCursorSearchResult(body: { id: string | number; params: { cursor?: string; limit: number } }, items: unknown[]) {
  const pageItems = body.params.cursor ? [] : items;
  return rpcResult(body.id, { limit: body.params.limit, total: pageItems.length,
    ...(pageItems.length ? { cursor: 'preorder-search' } : {}), items: pageItems });
}
function preorderInventoryAccount(preorderId: string, id: number, owner: string) {
  const config = getPreorderConfig(preorderId)!;
  const string = (value: string) => {
    const bytes = Buffer.from(value), size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const data = Buffer.concat([Buffer.from([1]), Buffer.from(bs58.decode(owner)), Buffer.from([2]),
    Buffer.from(bs58.decode(config.collection)), string(`Preorder #${id}`), string(preorderMetadataUri(config, id)), Buffer.from([0])]);
  return { owner: MPL_CORE_PROGRAM_ADDRESS, executable: false, data: [data.toString('base64'), 'base64'] };
}

test('eighteen finalized preorders remain visible until collection search catches up with account and asset-batch reads', async (t) => {
  const { loadInventoryQuery } = await import('../src/lib/inventoryQuery.ts');
  const { mergePreorderInventory, unresolvedPreorderInventoryAssets } = await import('../src/lib/preorderInventory.ts');
  const { listPreorderRecoveries, resolvePreorderInventoryAssets, upsertPreorderRecovery } = await import('../src/lib/preorderRecovery.ts');
  const config = getPreorderConfig('mi_note_cards')!;
  const owner = assetId('preorder-index-handoff-owner');
  const assets = Array.from({ length: 18 }, (_, index) => ({ id: index + 1, address: assetId(`preorder-index-handoff-${index}`) }));
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`CREATE TABLE commerce_preorder_orders (
    buyer TEXT, preorder_id TEXT, status TEXT, confirmed_slot INTEGER, assets_json TEXT, created_at_ms INTEGER
  )`);
  for (const asset of assets) {
    database.prepare('INSERT INTO commerce_preorder_orders VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, config.preorderId, 'succeeded', 200, JSON.stringify([asset]), asset.id);
    await upsertPreorderRecovery({ orderId: `handoff-${String(asset.id).padStart(2, '0')}`, preorderId: config.preorderId,
      buyer: owner, ethereumAddress: null, cardIds: [asset.id], assets: [asset], status: 'succeeded',
      confirmedSlot: 200, expiresAtMs: 1, signature: SIGNATURE });
  }
  const indexed = assets.map((asset) => ({ id: asset.address, interface: 'MplCoreAsset', burnt: false, ownership: { owner },
    grouping: [{ group_key: 'collection', group_value: config.collection }], content: { json_uri: preorderMetadataUri(config, asset.id) } }));
  let searchCaughtUp = false;
  let failAccountRead = false;
  const expectedBatches: string[][] = [];
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getMultipleAccounts') {
      if (failAccountRead) throw new Error('Temporary account read failure');
      return rpcResult(body.id, { context: { slot: 200 }, value: (body.params[0] as string[]).map((address) =>
        preorderInventoryAccount(config.preorderId, assets.find((asset) => asset.address === address)!.id, owner)) });
    }
    if (body.method === 'getAssetBatch') return rpcResult(body.id, indexed.filter((asset) => body.params.ids.includes(asset.id)));
    return rpcCursorSearchResult(body, searchCaughtUp && body.params?.grouping?.[1] === config.collection ? indexed : []);
  };
  const load = () => loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
    fetchInventory: async (_owner, options) => {
      expectedBatches.push(options.expectedAssetIds?.['mainnet-beta'] ?? []);
      const response = await handleRequest(request('/inventory', { owner, includePreorderResolutions: true, includePreorderResolutionSlots: true,
        ...(options.preorderMinContextSlots ? { preorderMinContextSlots: options.preorderMinContextSlots } : {}),
        ...(options.expectedAssetIds ? { expectedAssetIds: options.expectedAssetIds } : {}) }),
      env({ commerceDb: sqliteD1Database(database) }), quietDependencies(providerFetch));
      assert.equal(response.status, 200);
      const body = await response.json() as import('../shared/shopApi.ts').ShopInventoryResponse;
      if (!searchCaughtUp || failAccountRead) assert.equal(body.resolvedPreorderAssetIds, undefined);
      options.onPreorderAssetResolutions?.(body.preorderAssetResolutions ?? []);
      return body.items;
    },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    failAccountRead = attempt === 2;
    const items = await load();
    assert.equal(mergePreorderInventory(items, listPreorderRecoveries(owner)).length, 18);
    assert.equal(unresolvedPreorderInventoryAssets(listPreorderRecoveries(owner)).length, 18);
  }
  assert.equal(new Set(expectedBatches.flat()).size, 18);
  searchCaughtUp = true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const items = await load();
    assert.equal(items.length, 18);
    assert.equal(mergePreorderInventory(items, listPreorderRecoveries(owner)).length, 18);
  }
  assert.equal(unresolvedPreorderInventoryAssets(listPreorderRecoveries(owner)).length, 0);
  assert.equal((await load()).length, 18);
  assert.deepEqual(expectedBatches.at(-1), []);
});

test('older finalized negative proofs reject stale indexing until a new account read verifies transfer back', async (t) => {
  const { loadInventoryQuery } = await import('../src/lib/inventoryQuery.ts');
  const { mergePreorderInventory } = await import('../src/lib/preorderInventory.ts');
  const { listPreorderRecoveries, resolvePreorderInventoryAssets, upsertPreorderRecovery } = await import('../src/lib/preorderRecovery.ts');
  const config = getPreorderConfig('mi_note_cards')!;
  const owner = assetId('preorder-negative-handoff-owner');
  const assets = Array.from({ length: 18 }, (_, index) => ({ id: index + 1, address: assetId(`preorder-negative-handoff-${index}`) }));
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`CREATE TABLE commerce_preorder_orders (
    buyer TEXT, preorder_id TEXT, status TEXT, confirmed_slot INTEGER, assets_json TEXT, created_at_ms INTEGER
  )`);
  for (const asset of assets) {
    database.prepare('INSERT INTO commerce_preorder_orders VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, config.preorderId, 'succeeded', 200, JSON.stringify([asset]), asset.id);
    await upsertPreorderRecovery({ orderId: `negative-handoff-${String(asset.id).padStart(2, '0')}`, preorderId: config.preorderId,
      buyer: owner, ethereumAddress: null, cardIds: [asset.id], assets: [asset], status: 'succeeded',
      confirmedSlot: 200, expiresAtMs: 1, signature: SIGNATURE });
  }
  await resolvePreorderInventoryAssets(owner, assets.map(asset => asset.address), assets.map(asset => asset.address));
  const indexed = assets.map((asset) => ({ id: asset.address, interface: 'MplCoreAsset', burnt: false, ownership: { owner },
    grouping: [{ group_key: 'collection', group_value: config.collection }], content: { json_uri: preorderMetadataUri(config, asset.id) } }));
  let transferredBack = false;
  let accountFailure: 'none' | 'error' | 'stale' = 'none';
  let accountReads: string[][] = [];
  let expectedIds: string[] = [];
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getMultipleAccounts') {
      accountReads.push(body.params[0]);
      if (accountFailure === 'error') throw new Error('Temporary RPC failure');
      return rpcResult(body.id, { context: { slot: accountFailure === 'stale' ? 199 : transferredBack ? 251 : 250 }, value: (body.params[0] as string[]).map((address) =>
        address === assets[0].address && !transferredBack ? null
          : preorderInventoryAccount(config.preorderId, assets.find(asset => asset.address === address)!.id, owner)) });
    }
    if (body.method === 'getAssetBatch') return rpcResult(body.id, indexed.filter(asset => body.params.ids.includes(asset.id)));
    return rpcCursorSearchResult(body, body.params?.grouping?.[1] === config.collection ? indexed : []);
  };
  let inventory: import('../src/types.ts').InventoryItem[] = assets.slice(1).map(asset => ({
    id: asset.address, dropId: config.preorderId, name: `Preorder #${asset.id}`, kind: 'preorder', preorderId: asset.id,
  }));
  const visible = () => mergePreorderInventory(inventory, listPreorderRecoveries(owner), new Set(inventory.map(item => item.id)));
  const load = async () => {
    inventory = await loadInventoryQuery(owner, {
      includeDevnet: false, useRecentExpectedAssets: true,
      acknowledgedPreorderAssetIds: new Set(inventory.map(item => item.id)),
    }, {
      prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
      fetchInventory: async (_owner, options) => {
        expectedIds = options.expectedAssetIds?.['mainnet-beta'] ?? [];
        accountReads = [];
        const response = await handleRequest(request('/inventory', { owner, includePreorderResolutions: true, includePreorderResolutionSlots: true,
          ...(options.preorderMinContextSlots ? { preorderMinContextSlots: options.preorderMinContextSlots } : {}),
          ...(options.expectedAssetIds ? { expectedAssetIds: options.expectedAssetIds } : {}) }),
        env({ commerceDb: sqliteD1Database(database) }), quietDependencies(providerFetch));
        assert.equal(response.status, 200);
        const body = await response.json() as import('../shared/shopApi.ts').ShopInventoryResponse;
        options.onPreorderAssetResolutions?.(body.preorderAssetResolutions ?? []);
        return body.items;
      },
    });
  };
  await load();
  assert.deepEqual(expectedIds, [assets[0].address]);
  assert.equal(visible().some(item => item.id === assets[0].address), false);
  await load();
  assert.equal(accountReads.flat().includes(assets[0].address), false);
  assert.equal(inventory.some(item => item.id === assets[0].address), true);
  assert.equal(visible().some(item => item.id === assets[0].address), false);
  transferredBack = true;
  for (const failure of ['error', 'stale'] as const) {
    accountFailure = failure;
    await load();
    assert.deepEqual(expectedIds, [assets[0].address]);
    assert.equal(visible().some(item => item.id === assets[0].address), false);
  }
  accountFailure = 'none';
  await load();
  assert.deepEqual(expectedIds, [assets[0].address]);
  assert.equal(accountReads.flat().includes(assets[0].address), true);
  assert.equal(visible().some(item => item.id === assets[0].address), true);
});
