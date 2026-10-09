import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.ts';
import { PREORDER_CARD_IDS } from '../../../../shared/preorderCardIds.generated.ts';
import { getPreorderConfig, preorderMetadataUri } from '../../../../shared/preorders.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { isExactShopInventoryResponse, SHOP_EXPECTED_ASSET_IDS_MAX, type ShopInventoryResponse } from '../../../../shared/shopApi.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';
import { PreorderStore, type StoredPreorder } from '../src/preorderStore.ts';
import { defaultDependencies, type ProviderFetch } from '../src/publicRouteSupport.ts';
import { handlePost } from '../src/shopInventory.ts';

const drop = DEPLOYMENT_DROPS.mi_note_cards_devnet;
const cardId = PREORDER_CARD_IDS.find(id => !drop.inventoryManifest!.cardIds.includes(id))!;
const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed)).toBase58();
const owner = key(61);
const address = key(62);
const mainnet = {
  id: key(63), interface: 'MplCoreAsset', burnt: false, ownership: { owner },
  grouping: [{ group_key: 'collection', group_value: DEPLOYMENT_DROPS.card_nft_2.collectionMint }],
  content: { json_uri: `${DEPLOYMENT_DROPS.card_nft_2.metadataBase}/b1.json` },
};

function metadata(converted: boolean, id = cardId, selectedDrop = drop) {
  return converted ? { name: `card ${id}`, uri: `${selectedDrop.metadataBase}/f${id}.json` }
    : { name: `Preorder #${id}`, uri: preorderMetadataUri(getPreorderConfig(selectedDrop.dropId)!, id) };
}

function indexed(converted: boolean, currentOwner = owner, asset = { id: cardId, address }, selectedDrop = drop) {
  const value = metadata(converted, asset.id, selectedDrop);
  return { id: asset.address, interface: 'MplCoreAsset', burnt: false, ownership: { owner: currentOwner },
    grouping: [{ group_key: 'collection', group_value: selectedDrop.collectionMint }],
    content: { json_uri: value.uri, metadata: { name: value.name } } };
}

function account(converted = true, overrides: { owner?: string; collection?: string; name?: string; uri?: string } = {}, selectedDrop = drop) {
  const selectedId = PREORDER_CARD_IDS.find(id => !selectedDrop.inventoryManifest!.cardIds.includes(id))!;
  const value = { ...metadata(converted, selectedId, selectedDrop), owner, collection: selectedDrop.collectionMint, ...overrides };
  const string = (text: string) => {
    const bytes = Buffer.from(text);
    const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const data = Buffer.concat([Buffer.from([1]), new PublicKey(value.owner).toBuffer(), Buffer.from([2]),
    new PublicKey(value.collection).toBuffer(), string(value.name), string(value.uri), Buffer.from([0])]);
  return { owner: MPL_CORE_PROGRAM_ADDRESS, executable: false, data: [data.toString('base64'), 'base64'] };
}

async function fixture(t: TestContext, submitted = false, confirmedSlot: number | null = 200,
  overrides: Partial<StoredPreorder> = {}, extraAssets: StoredPreorder['assets'] = [], selectedDrop = drop) {
  const config = getPreorderConfig(selectedDrop.dropId)!;
  const cardId = PREORDER_CARD_IDS.find(id => !selectedDrop.inventoryManifest!.cardIds.includes(id))!;
  const commerce = createCommerceD1Harness();
  t.after(() => commerce.database.close());
  const store = new PreorderStore(commerce.db);
  const prepared: StoredPreorder = {
    orderId: crypto.randomUUID(), requestId: crypto.randomUUID(), preorderId: config.preorderId,
    cluster: config.cluster, collection: config.collection, buyer: owner,
    ethereumAddress: '0x0000000000000000000000000000000000000001', status: 'prepared', cardIds: [cardId],
    assets: [{ id: cardId, address }], signature: null, signedTransaction: null, preparedTransaction: 'prepared',
    blockhash: address, blockhashContextSlot: 100, lastValidBlockHeight: 200,
    expiresAtMs: 121000, createdAtMs: 1000, revision: 1, ...overrides,
  };
  await store.reserve(prepared);
  const sent = await store.submit(prepared, { signature: bs58.encode(new Uint8Array(64).fill(1)), transactionBase64: 'signed' }, 2000);
  const order = submitted ? await store.confirm(sent, 200, 3000) : await store.finish(sent, 'succeeded', 3000, confirmedSlot ?? undefined);
  for (const [index, asset] of extraAssets.entries()) {
    const extra = await store.reserve({ ...prepared, orderId: crypto.randomUUID(), requestId: crypto.randomUUID(),
      cardIds: [asset.id], assets: [asset], createdAtMs: 1001 + index });
    const submittedExtra = await store.submit(extra, { signature: bs58.encode(new Uint8Array(64).fill(index + 2)), transactionBase64: 'signed' }, 2000);
    await store.finish(submittedExtra, 'succeeded', 3000, confirmedSlot ?? undefined);
  }
  const claims = await store.claims(config.cluster, config.collection);
  const state = { account: account(true, {}, selectedDrop) as ReturnType<typeof account> | null,
    indexed: [indexed(true, owner, { id: cardId, address }, selectedDrop)], slot: 250,
    unavailable: false, floor: 200, commitment: '', directBatches: [] as string[][],
    accounts: new Map<string, ReturnType<typeof account> | null>() };
  const providerFetch: ProviderFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getMultipleAccounts') {
      const addresses = body.params[0] as string[];
      if (!state.accounts.size) assert.deepEqual(addresses, [address]);
      state.directBatches.push([...addresses]);
      state.floor = body.params[1].minContextSlot;
      state.commitment = body.params[1].commitment;
      if (state.unavailable) throw new Error('RPC unavailable');
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: state.slot },
        value: state.accounts.size ? addresses.map(id => state.accounts.get(id) ?? null) : [state.account] } });
    }
    if (body.method === 'getAssetBatch') return Response.json({ jsonrpc: '2.0', id: body.id,
      result: state.indexed.filter(asset => body.params.ids.includes(asset.id)) });
    assert.equal(body.method, 'searchAssets');
    const collection = body.params.grouping?.[1];
    const items = body.params.cursor ? [] : collection === config.collection ? state.indexed
      : collection === DEPLOYMENT_DROPS.card_nft_2.collectionMint ? [mainnet] : [];
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      limit: body.params.limit, items, ...(items.length ? { cursor: collection } : {}),
    } });
  };
  const load = async (includeDevnet: boolean, capable = true, extra: Record<string, unknown> = {}) => {
    const body = { owner, includeDevnet, includePreorderResolutions: true, includePreorderResolutionSlots: true,
      ...(capable ? { supportsConvertedPreorders: true as const } : {}), ...extra };
    const { response } = await handlePost(new Request('https://api.mons.shop/inventory', {
      method: 'POST', headers: { Origin: 'https://mons.shop', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), { HELIUS_API_KEY: 'fixture-key', COMMERCE_DB: commerce.db,
      PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }, '/inventory', { ...defaultDependencies, providerFetch, log: () => {}, sleep: async () => {}, randomUint32: () => 0 },
    { upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0, expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0 });
    assert.equal(response.status, 200);
    const result = await response.json() as ShopInventoryResponse;
    assert.equal(isExactShopInventoryResponse(result, body), true);
    assert.deepEqual(await store.get(prepared.orderId), order);
    assert.deepEqual(await store.claims(config.cluster, config.collection), claims);
    assert.ok(result.items.some(item => item.id === mainnet.id));
    return result;
  };
  return { state, load };
}

const mainnetDrop = DEPLOYMENT_DROPS.mi_note_cards;
const mainnetCardId = PREORDER_CARD_IDS.find(id => !mainnetDrop.inventoryManifest!.cardIds.includes(id))!;

for (const includeDevnet of [false, true]) for (const capable of [false, true]) for (const das of ['missing', 'preorder', 'converted'] as const) {
  test(`mainnet converted cards remain visible with ${das} index metadata, devnet=${includeDevnet}, proofs=${capable}`, async t => {
    const f = await fixture(t, false, 200, {}, [], mainnetDrop);
    f.state.indexed = das === 'missing' ? [] : [indexed(das === 'converted', owner, { id: mainnetCardId, address }, mainnetDrop)];
    const body = await f.load(includeDevnet, capable);
    const item = body.items.find(item => item.id === address);
    assert.ok(item);
    assert.deepEqual([item.dropId, item.kind, item.dudeId, item.name], ['mi_note_cards', 'dude', mainnetCardId, `card ${mainnetCardId}`]);
    assert.deepEqual(body.preorderAssetResolutions, capable
      ? [{ id: address, slot: 250, owned: true, kind: 'dude', visible: true }] : []);
    assert.deepEqual(body.resolvedPreorderAssetIds, capable ? [address] : undefined);
    assert.equal(f.state.commitment, 'finalized');
  });
}

for (const includeDevnet of [false, true]) for (const capable of [false, true]) {
  test(`a new mainnet holder repairs stale preorders beyond the proof limit with devnet=${includeDevnet}, proofs=${capable}`, async t => {
    const assets = PREORDER_CARD_IDS.filter(id => !mainnetDrop.inventoryManifest!.cardIds.includes(id)).slice(0, 17)
      .map((id, index) => ({ id, address: index === 0 ? address : key(80 + index) }));
    const f = await fixture(t, false, null, {}, assets.slice(1), mainnetDrop);
    const currentOwner = key(64);
    f.state.indexed = assets.map(asset => indexed(false, currentOwner, asset, mainnetDrop));
    for (const asset of assets) {
      f.state.accounts.set(asset.address, account(true, { owner: currentOwner, ...metadata(true, asset.id, mainnetDrop) }, mainnetDrop));
    }
    for (const hinted of [false, true]) {
      f.state.directBatches.length = 0;
      const hint = assets.at(-1)!;
      const body = await f.load(includeDevnet, capable, { owner: currentOwner,
        ...(hinted ? { expectedAssetIds: { 'mainnet-beta': [hint.address] } } : {}) });
      assert.deepEqual(body.items.filter(item => item.dropId === mainnetDrop.dropId).map(item => [item.id, item.kind, item.dudeId]).sort(),
        assets.map(asset => [asset.address, 'dude', asset.id]).sort());
      assert.deepEqual(f.state.directBatches.flat().sort(), assets.map(asset => asset.address).sort());
      const proofs = body.preorderAssetResolutions ?? [];
      assert.ok(proofs.length <= SHOP_EXPECTED_ASSET_IDS_MAX);
      if (capable) {
        assert.equal(proofs.length, SHOP_EXPECTED_ASSET_IDS_MAX);
        assert.ok(proofs.every(proof => proof.kind === 'dude' && proof.owned && proof.visible));
        if (hinted) assert.ok(proofs.some(proof => proof.id === hint.address));
      } else {
        assert.deepEqual(proofs, []);
        assert.equal(body.resolvedPreorderAssetIds, undefined);
      }
    }
  });
}

test('a mainnet claimed asset cannot adopt a devnet metadata URI', async t => {
  const f = await fixture(t, false, 200, {}, [], mainnetDrop);
  f.state.indexed = [indexed(false, owner, { id: mainnetCardId, address }, mainnetDrop)];
  f.state.account = account(true, { uri: `${drop.metadataBase}/f${mainnetCardId}.json` }, mainnetDrop);
  const body = await f.load(false);
  assert.equal(body.items.find(item => item.id === address)?.kind, 'preorder');
  assert.deepEqual(body.preorderAssetResolutions, []);
  assert.equal(body.resolvedPreorderAssetIds, undefined);
});

for (const includeDevnet of [false, true]) for (const capable of [false, true]) {
  test(`a cold new owner repairs all22 stale indexed preorders with devnet=${includeDevnet}, converted proofs=${capable}`, async t => {
    const assets = PREORDER_CARD_IDS.filter(id => !drop.inventoryManifest!.cardIds.includes(id))
      .map((id, index) => ({ id, address: index === 0 ? address : key(80 + index) }));
    assert.equal(assets.length, 22);
    const f = await fixture(t, false, null, {}, assets.slice(1));
    const currentOwner = key(64);
    f.state.indexed = assets.map(asset => indexed(false, currentOwner, asset));
    for (const asset of assets) f.state.accounts.set(asset.address, account(true, { owner: currentOwner, ...metadata(true, asset.id) }));
    for (const hinted of [false, false, true]) {
      f.state.directBatches.length = 0;
      const hint = assets.at(-1)!;
      const body = await f.load(includeDevnet, capable, { owner: currentOwner,
        ...(hinted ? { expectedAssetIds: { devnet: [hint.address] } } : {}) });
      const actual = body.items.filter(item => item.dropId === drop.dropId);
      assert.deepEqual(actual.map(item => [item.id, item.kind, item.dudeId]).sort(), includeDevnet
        ? assets.map(asset => [asset.address, 'dude', asset.id]).sort() : []);
      const direct = f.state.directBatches.flat();
      assert.deepEqual([...new Set(direct)].sort(), assets.map(asset => asset.address).sort());
      assert.equal(direct.length, assets.length);
      assert.ok(f.state.directBatches.every(batch => batch.length <= 100));
      const proofs = body.preorderAssetResolutions ?? [];
      assert.ok(proofs.length <= SHOP_EXPECTED_ASSET_IDS_MAX);
      if (capable) {
        assert.ok(proofs.length > 0);
        assert.ok(proofs.every(proof => proof.kind === 'dude' && proof.owned && proof.visible === includeDevnet));
        if (hinted) assert.ok(proofs.some(proof => proof.id === hint.address), 'client hints must precede server-discovered candidates');
      } else {
        assert.deepEqual(proofs, []);
        assert.equal(body.resolvedPreorderAssetIds, undefined);
      }
    }
  });
}

for (const includeDevnet of [false, true]) for (const das of ['missing', 'preorder', 'converted'] as const) {
  test(`converted ownership survives ${das} DAS metadata with includeDevnet=${includeDevnet}`, async t => {
    const f = await fixture(t);
    f.state.indexed = das === 'missing' ? [] : [indexed(das === 'converted')];
    const body = await f.load(includeDevnet);
    const item = body.items.find(item => item.id === address);
    assert.deepEqual(body.preorderAssetResolutions, [{ id: address, slot: 250, owned: true, kind: 'dude', visible: includeDevnet }]);
    assert.deepEqual(body.resolvedPreorderAssetIds, [address]);
    assert.equal(item?.kind, includeDevnet ? 'dude' : undefined);
    if (item) assert.deepEqual([item.dudeId, item.name], [cardId, `card ${cardId}`]);
    assert.equal(f.state.commitment, 'finalized');
  });
}

test('legacy clients keep ordinary filtered inventory without converted resolution fields', async t => {
  const f = await fixture(t);
  for (const includeDevnet of [false, true]) {
    for (const flags of [{}, { includePreorderResolutionSlots: undefined },
      { includePreorderResolutions: undefined, includePreorderResolutionSlots: undefined }]) {
      const body = await f.load(includeDevnet, false, flags);
      assert.equal(body.items.find(item => item.id === address)?.kind, includeDevnet ? 'dude' : undefined);
      assert.equal(body.resolvedPreorderAssetIds, undefined);
      assert.deepEqual(body.preorderAssetResolutions, Object.hasOwn(flags, 'includePreorderResolutionSlots') ? undefined : []);
    }
  }
});

test('converted cards transferred to another owner resolve as converted and unowned', async t => {
  const f = await fixture(t);
  f.state.account = account(true, { owner: key(64) });
  const body = await f.load(true);
  assert.equal(body.items.some(item => item.id === address), false);
  assert.deepEqual(body.preorderAssetResolutions, [{ id: address, slot: 250, owned: false, kind: 'dude', visible: false }]);
});

for (const includeDevnet of [false, true]) for (const source of ['indexed-preorder', 'requested-address'] as const) {
  test(`the current owner recovers its ${source} with includeDevnet=${includeDevnet}`, async t => {
    const f = await fixture(t);
    const currentOwner = key(64);
    f.state.account = account(true, { owner: currentOwner });
    f.state.indexed = source === 'indexed-preorder' ? [indexed(false, currentOwner)] : [];
    const body = await f.load(includeDevnet, true, { owner: currentOwner,
      ...(source === 'requested-address' ? { expectedAssetIds: { devnet: [address] } } : {}) });
    assert.equal(body.items.find(item => item.id === address)?.kind, includeDevnet ? 'dude' : undefined);
    assert.deepEqual(body.preorderAssetResolutions, [{ id: address, slot: 250, owned: true, kind: 'dude', visible: includeDevnet }]);
  });
}

test('a requested historical claim cannot override the current on-chain owner', async t => {
  const f = await fixture(t);
  const currentOwner = key(64);
  f.state.indexed = [indexed(false, currentOwner)];
  const body = await f.load(true, true, { owner: currentOwner });
  assert.equal(body.items.some(item => item.id === address), false);
  assert.deepEqual(body.preorderAssetResolutions, [{ id: address, slot: 250, owned: false, kind: 'dude', visible: false }]);
});

test('another buyer cannot recover an order before its permanent success', async t => {
  const f = await fixture(t, true);
  f.state.indexed = [];
  const body = await f.load(true, true, { owner: key(64), expectedAssetIds: { devnet: [address] } });
  assert.equal(body.items.some(item => item.id === address), false);
  assert.deepEqual(body.preorderAssetResolutions, []);
  assert.equal(f.state.commitment, '');
});

test('an asset listed in an order needs its matching permanent claim', async t => {
  const f = await fixture(t, false, 200, { assets: [{ id: cardId + 1, address }] });
  const body = await f.load(true, true, { expectedAssetIds: { devnet: [address] } });
  assert.deepEqual(body.preorderAssetResolutions, []);
  assert.equal(f.state.commitment, '');
});

test('an order with a different registered cluster and collection cannot authorize recovery', async t => {
  const other = getPreorderConfig('mi_note_cards')!;
  const f = await fixture(t, false, 200, { cluster: other.cluster, collection: other.collection });
  const body = await f.load(true, true, { expectedAssetIds: { devnet: [address] } });
  assert.deepEqual(body.preorderAssetResolutions, []);
  assert.equal(f.state.commitment, '');
});

test('legacy succeeded orders receive converted proofs without an original confirmation slot', async t => {
  const f = await fixture(t, false, null);
  const body = await f.load(false);
  assert.deepEqual(body.preorderAssetResolutions, [{ id: address, slot: 250, owned: true, kind: 'dude', visible: false }]);
  f.state.account = null;
  assert.deepEqual((await f.load(false)).preorderAssetResolutions, []);
});

test('a newer converted proof repairs prior absence while respecting client slot floors', async t => {
  const f = await fixture(t);
  f.state.account = null;
  assert.deepEqual((await f.load(true)).preorderAssetResolutions, [{ id: address, slot: 250, owned: false }]);
  f.state.account = account();
  const request = { expectedAssetIds: { devnet: [address] }, preorderMinContextSlots: { [address]: 250 } };
  f.state.slot = 249;
  assert.deepEqual((await f.load(true, true, request)).preorderAssetResolutions, []);
  f.state.slot = 251;
  assert.deepEqual((await f.load(true, true, request)).preorderAssetResolutions,
    [{ id: address, slot: 251, owned: true, kind: 'dude', visible: true }]);
  assert.equal(f.state.floor, 250);
});

for (const failure of ['wrong-name', 'wrong-id', 'wrong-collection', 'wrong-program', 'malformed', 'unavailable'] as const) {
  test(`uncertain converted identity never becomes an absence proof: ${failure}`, async t => {
    const f = await fixture(t);
    if (failure === 'wrong-name') f.state.account = account(true, { name: `card ${cardId + 1}` });
    if (failure === 'wrong-id') f.state.account = account(true, { uri: `${drop.metadataBase}/f${cardId + 1}.json` });
    if (failure === 'wrong-collection') f.state.account = account(true, { collection: key(65) });
    if (failure === 'wrong-program') f.state.account!.owner = key(66);
    if (failure === 'malformed') f.state.account!.data = ['invalid base64', 'base64'];
    if (failure === 'unavailable') f.state.unavailable = true;
    const body = await f.load(true);
    assert.equal(body.items.find(item => item.id === address)?.kind, 'dude');
    assert.deepEqual(body.preorderAssetResolutions, []);
    assert.equal(body.resolvedPreorderAssetIds, undefined);
  });
}

test('confirmed-only conversion does not produce a finalized ownership proof', async t => {
  const f = await fixture(t, true);
  const body = await f.load(true);
  assert.equal(body.items.find(item => item.id === address)?.kind, 'dude');
  assert.equal(f.state.commitment, 'confirmed');
  assert.deepEqual(body.preorderAssetResolutions, []);
});

test('unconverted preorders retain their legacy proof and normal-route visibility', async t => {
  const f = await fixture(t);
  f.state.account = account(false);
  f.state.indexed = [indexed(false)];
  const body = await f.load(false);
  assert.equal(body.items.find(item => item.id === address)?.kind, 'preorder');
  assert.deepEqual(body.preorderAssetResolutions, [{ id: address, slot: 250, owned: true }]);
  f.state.indexed = [indexed(true)];
  assert.deepEqual((await f.load(false)).preorderAssetResolutions, [{ id: address, slot: 250, owned: true }]);
});
