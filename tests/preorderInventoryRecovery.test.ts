import assert from 'node:assert/strict';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import test, { beforeEach } from 'node:test';

beforeEach(context => { if ('after' in context) installBrowserLocks(context); });
import bs58 from 'bs58';
import { QueryClient } from '@tanstack/react-query';
import { getPreorderConfig, type PreorderOrder } from '../shared/preorders.ts';
import { isExactShopInventoryRequest, isExactShopInventoryResponse } from '../shared/shopApi.ts';
import { loadInventoryQuery, revokePreorderInventoryAssets } from '../src/lib/inventoryQuery.ts';
import { mergePreorderInventory, unresolvedPreorderInventoryAssets } from '../src/lib/preorderInventory.ts';
import type { PreorderRecoveryRecord } from '../src/lib/preorderRecovery.ts';
import { listPreorderRecoveries, resolvePreorderInventoryAssets, upsertPreorderRecovery } from '../src/lib/preorderRecovery.ts';
import type { InventoryItem } from '../src/types.ts';
import { prepareRecentExpectedInventoryAssets, registerRecentExpectedInventoryAssets } from '../src/lib/recentExpectedInventoryAssets.ts';

const owner = bs58.encode(new Uint8Array(32).fill(1));
const config = getPreorderConfig('mi_note_cards')!;
const address = (id: number) => bs58.encode(new Uint8Array(32).fill(id + 2));
function record(id: number, status: PreorderOrder['status'] = 'submitted', preorderId = config.preorderId): PreorderRecoveryRecord {
  return {
    order: { orderId: `order-${id}`, preorderId, buyer: owner, ethereumAddress: '0x0000000000000000000000000000000000000001',
      cardIds: [id], assets: [{ id, address: address(id) }], status, expiresAtMs: 1, signature: bs58.encode(new Uint8Array(64).fill(3)), confirmedSlot: 200 },
    resolvedAssetIds: [], failureNotified: false,
  };
}
const item = (id: number): InventoryItem => ({ id: address(id), kind: 'preorder', preorderId: id, dropId: config.preorderId, name: `Preorder #${id}` });
const proof = (id: number, owned: boolean, slot = 250) => ({ id: address(id), slot, owned });

test('preorder overlays survive old expiry times and ordinary empty or stale inventory responses', () => {
  const pending = record(1);
  const mainnet = mergePreorderInventory([], [pending]);
  assert.equal(mainnet.length, 1);
  assert.equal(mainnet[0].id, address(1));
  assert.equal(mainnet[0].image, `${config.imageBase}1.webp`);
  const canonical = item(1);
  assert.deepEqual(mergePreorderInventory([canonical], [pending]), [canonical]);
  assert.equal(mergePreorderInventory([], [{ ...pending, resolvedAssetIds: [address(1)] }]).length, 1);
  assert.deepEqual(mergePreorderInventory([], [{ ...pending, resolvedAssetIds: [address(1)], inventoryResolutionSlots: { [address(1)]: 250 } }]), []);
  assert.deepEqual(mergePreorderInventory([canonical], [record(1, 'failed')]), []);
  assert.deepEqual(mergePreorderInventory([canonical], [record(1, 'expired')]), []);
  assert.deepEqual(unresolvedPreorderInventoryAssets([{ ...pending, order: { ...pending.order, confirmedSlot: null } }]), []);
  assert.equal(mergePreorderInventory([], [record(2, 'submitted', 'mi_note_cards_devnet')])[0].dropId, 'mi_note_cards_devnet');
});

test('durable preorder hints rotate beyond fifteen assets and retire only explicit finalized receipts', async () => {
  let records = Array.from({ length: 18 }, (_, index) => record(index + 1));
  const batches: string[][] = [];
  const resolved: string[][] = [];
  const load = () => loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: () => records,
    resolvePreorders: (_owner, ids) => { resolved.push([...ids]); },
    fetchInventory: async (_owner, options) => {
      batches.push(options.expectedAssetIds?.['mainnet-beta'] ?? []);
      options.onPreorderAssetResolutions?.([]);
      return [item(1)];
    },
  });
  await load();
  await load();
  assert.equal(batches[0].length, 15);
  assert.equal(new Set(batches.flat()).size, 18);
  assert.deepEqual(resolved, []);
  records = [record(1, 'succeeded')];
  await loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: () => records,
    resolvePreorders: (_owner, ids) => { resolved.push([...ids]); },
    fetchInventory: async (_owner, options) => {
      options.onPreorderAssetResolutions?.([proof(1, false)]);
      return [];
    },
  });
  assert.deepEqual(resolved, [[address(1)]]);
});

test('durable devnet preorder hints preserve public inventory scope', async () => {
  await loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: () => [record(2, 'submitted', 'mi_note_cards_devnet')],
    resolvePreorders() {},
    fetchInventory: async (_owner, options) => {
      assert.equal(options.includeDevnet, false);
      assert.deepEqual(options.expectedAssetIds, { devnet: [address(2)] });
      assert.equal(typeof options.onPreorderAssetResolutions, 'function');
      return [];
    },
  });
  assert.equal(isExactShopInventoryRequest({ owner, expectedAssetIds: { devnet: [address(2)] } }), false);
  assert.equal(isExactShopInventoryRequest({ owner, includePreorderResolutions: true, expectedAssetIds: { devnet: [address(2)] } }), true);
});

test('inventory query suppresses a preorder that fails while its response is in flight', async () => {
  let records = [record(1)];
  const items = await loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: () => records,
    fetchInventory: async () => { records = [record(1, 'failed')]; return [item(1), item(2)]; },
  });
  assert.deepEqual(items, [item(2)]);
});

test('inventory query rechecks failed orders after waiting for an unrelated receipt lock', async () => {
  let records = [record(1), record(2, 'succeeded')];
  const items = await loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: () => records,
    resolvePreorders: async () => { await Promise.resolve(); records = [record(1, 'failed'), record(2, 'succeeded')]; },
    fetchInventory: async (_owner, options) => { options.onPreorderAssetResolutions?.([proof(2, true)]); return [item(1), item(2)]; },
  });
  assert.deepEqual(items, [item(2)]);
});

test('preorder rollback cancels stale fetches and evicts only its assets across owner caches', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['inventory', owner, false], [item(1), item(2)]);
  client.setQueryData(['inventory', owner, true], [item(1), item(3)]);
  client.setQueryData(['inventory', 'another-owner', false], [item(1)]);
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<InventoryItem[]>();
  const pending = client.fetchQuery({ queryKey: ['inventory', owner, false], queryFn: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    started.resolve();
    return late.promise;
  } }).catch(() => undefined);
  await started.promise;
  await revokePreorderInventoryAssets(client, owner, [address(1)]);
  assert.equal(aborted, true);
  late.resolve([item(1), item(2)]);
  await pending;
  assert.deepEqual(client.getQueryData(['inventory', owner, false]), [item(2)]);
  assert.deepEqual(client.getQueryData(['inventory', owner, true]), [item(3)]);
  assert.deepEqual(client.getQueryData(['inventory', 'another-owner', false]), [item(1)]);
  client.clear();
});

test('inventory resolution protocol rejects malformed, duplicate, or oversized receipts', () => {
  assert.equal(isExactShopInventoryResponse({ ok: true, items: [], resolvedPreorderAssetIds: [address(1)] }), true);
  for (const ids of [['invalid'], [address(1), address(1)], Array.from({ length: 16 }, (_, index) => address(index))]) {
    assert.equal(isExactShopInventoryResponse({ ok: true, items: [], resolvedPreorderAssetIds: ids }), false);
  }
});

test('preorder backlog shares hints with ordinary mints without skipping unsent recent assets', async () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  const records = Array.from({ length: 18 }, (_, index) => record(index + 1));
  const ordinary = Array.from({ length: 20 }, (_, index) => address(index + 100));
  const batches: string[][] = [];
  const now = 1_000;
  registerRecentExpectedInventoryAssets(owner, 'mainnet-beta', ordinary, { storage, now });
  for (let index = 0; index < 3; index += 1) {
    await loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
      prepare: (buyer, includeDevnet, options) => prepareRecentExpectedInventoryAssets(buyer, includeDevnet, { ...options, storage, now }),
      reconcile() {}, listPreorders: () => records, resolvePreorders() {},
      fetchInventory: async (_owner, options) => { batches.push(options.expectedAssetIds?.['mainnet-beta'] ?? []); return []; },
    });
  }
  assert.ok(batches.every((batch) => batch.length === 15 && batch.some((id) => ordinary.includes(id)) && batch.some((id) => !ordinary.includes(id))));
  assert.deepEqual(batches[0].filter((id) => ordinary.includes(id)), ordinary.slice(0, 7));
  assert.deepEqual(batches[1].filter((id) => ordinary.includes(id)), ordinary.slice(7, 14));
  assert.ok(ordinary.every((id) => batches.flat().includes(id)));
  assert.ok(records.every(({ order }) => batches.flat().includes(order.assets[0].address)));
});

test('aborted inventory responses neither retire recoveries nor commit stale items', async () => {
  const controller = new AbortController();
  await assert.rejects(loadInventoryQuery(owner, {
    includeDevnet: false, useRecentExpectedAssets: true, signal: controller.signal,
    commitInventory: () => assert.fail('Aborted response wrote inventory'),
  }, {
    prepare: () => ({ commit: () => assert.fail('Aborted response committed hints') }),
    reconcile: () => assert.fail('Aborted response reconciled hints'), listPreorders: () => [record(1, 'succeeded')],
    resolvePreorders: () => assert.fail('Aborted response retired recovery'),
    fetchInventory: async (_owner, options) => {
      options.onPreorderAssetResolutions?.([proof(1, false)]);
      controller.abort();
      return [item(1)];
    },
  }), /abort/i);
});

test('legacy resolved records are rechecked once and finalized absence requires a verified transfer back', async (t) => {
  const legacy = record(1, 'succeeded');
  legacy.resolvedAssetIds = [address(1)];
  const key = `mons:preorder-recovery:v1:${config.cluster}:${config.collection}:${owner}:${legacy.order.orderId}`;
  const stored = new Map([[key, JSON.stringify(legacy)]]);
  const storage = {
    get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => { stored.set(name, value); }, removeItem: (name: string) => { stored.delete(name); },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  assert.deepEqual(listPreorderRecoveries(owner)[0].resolvedAssetIds, []);
  assert.deepEqual(mergePreorderInventory([], listPreorderRecoveries(owner)), [{ ...item(1), image: `${config.imageBase}1.webp` }]);
  await resolvePreorderInventoryAssets(owner, [address(1)]);
  assert.equal(JSON.parse(stored.get(key.replace(':v1:', ':v3:'))!).inventoryResolutionVersion, 3);
  assert.deepEqual(listPreorderRecoveries(owner)[0].resolvedAssetIds, [address(1)]);
  assert.deepEqual(mergePreorderInventory([], listPreorderRecoveries(owner)), []);
  assert.deepEqual(mergePreorderInventory([item(1)], listPreorderRecoveries(owner)), []);
  await resolvePreorderInventoryAssets(owner, [address(1)], [address(1)]);
  assert.deepEqual(mergePreorderInventory([item(1)], listPreorderRecoveries(owner)), [item(1)]);
});

test('a cache missing a globally resolved owned asset requests fresh proof and retires it on finalized absence', async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(71));
  await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
  await resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)]);
  const emptyCache = new Set<string>();
  assert.equal(mergePreorderInventory([], listPreorderRecoveries(buyer), emptyCache).length, 1);
  const items = await loadInventoryQuery(buyer, {
    includeDevnet: false, useRecentExpectedAssets: true, acknowledgedPreorderAssetIds: emptyCache,
    commitInventory: (inventory) => assert.deepEqual(inventory, []),
  }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
    fetchInventory: async (_owner, options) => {
      assert.deepEqual(options.expectedAssetIds, { 'mainnet-beta': [address(1)] });
      options.onPreorderAssetResolutions?.([proof(1, false)]);
      return [];
    },
  });
  assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, []);
  assert.deepEqual(mergePreorderInventory(items, listPreorderRecoveries(buyer), emptyCache), []);
  assert.deepEqual(mergePreorderInventory([item(1)], listPreorderRecoveries(buyer), new Set([address(1)])), []);
  assert.deepEqual(unresolvedPreorderInventoryAssets(listPreorderRecoveries(buyer), new Set([address(1)])).map(asset => asset.address), [address(1)]);
});

test('late positive receipts cannot undo newer negative evidence from another query client', async context => {
  for (const initiallyOwned of [true, false]) await context.test(initiallyOwned ? 'new negative proof' : 'repeated negative proof', async () => {
    const buyer = bs58.encode(new Uint8Array(32).fill(initiallyOwned ? 72 : 73));
    await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
    await resolvePreorderInventoryAssets(buyer, [address(1)], initiallyOwned ? [address(1)] : []);
    const first = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const second = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ['inventory', buyer, false];
    first.setQueryData(queryKey, [item(1)]);
    second.setQueryData(queryKey, [item(1)]);
    const started = Promise.withResolvers<void>();
    const finishOld = Promise.withResolvers<void>();
    let proofSlot = 250;
    const fetch = (client: QueryClient, positive: boolean, wait = false) => client.fetchQuery({ queryKey,
      queryFn: () => loadInventoryQuery(buyer, {
        includeDevnet: false, useRecentExpectedAssets: true,
        acknowledgedPreorderAssetIds: new Set(client.getQueryData<InventoryItem[]>(queryKey)?.map(item => item.id)),
        commitInventory: items => { client.setQueryData(queryKey, items); },
      }, {
        prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
        fetchInventory: async (_owner, options) => {
          const slot = ++proofSlot;
          if (wait) { started.resolve(); await finishOld.promise; }
          options.onPreorderAssetResolutions?.([proof(1, positive, slot)]);
          return positive ? [item(1)] : [];
        },
      }),
    });
    const oldPositive = fetch(first, true, true);
    await started.promise;
    const initialRevision = listPreorderRecoveries(buyer)[0].inventoryResolutionRevisions![address(1)];
    await fetch(second, false);
    assert.ok(listPreorderRecoveries(buyer)[0].inventoryResolutionRevisions![address(1)] > initialRevision);
    finishOld.resolve();
    await oldPositive;
    assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, []);
    assert.deepEqual(mergePreorderInventory(first.getQueryData<InventoryItem[]>(queryKey)!, listPreorderRecoveries(buyer), new Set([address(1)])), []);
    await fetch(first, true);
    assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, [address(1)]);
    assert.deepEqual(mergePreorderInventory(first.getQueryData<InventoryItem[]>(queryKey)!, listPreorderRecoveries(buyer), new Set([address(1)])), [item(1)]);
    first.clear();
    second.clear();
  });
});

test('aborted positive readmission retains the prior negative proof', async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(74));
  await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
  await resolvePreorderInventoryAssets(buyer, [address(1)]);
  const before = listPreorderRecoveries(buyer);
  const controller = new AbortController();
  await assert.rejects(loadInventoryQuery(buyer, {
    includeDevnet: false, useRecentExpectedAssets: true, signal: controller.signal,
    acknowledgedPreorderAssetIds: new Set([address(1)]), commitInventory: () => assert.fail('Aborted readmission committed'),
  }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
    fetchInventory: async (_owner, options) => {
      options.onPreorderAssetResolutions?.([proof(1, true)]);
      controller.abort();
      return [item(1)];
    },
  }), /abort/i);
  assert.deepEqual(listPreorderRecoveries(buyer), before);
  assert.deepEqual(mergePreorderInventory([item(1)], before, new Set([address(1)])), []);
});

test('negative evidence from a client without a proof revision fences an older positive request', async t => {
  const buyer = bs58.encode(new Uint8Array(32).fill(75));
  const stored = new Map<string, string>();
  const storage = {
    get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => { stored.set(name, value); }, removeItem: (name: string) => { stored.delete(name); },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
  const initial = listPreorderRecoveries(buyer);
  const key = [...stored.keys()].find(key => key.includes(buyer))!;
  const negative = JSON.parse(stored.get(key)!);
  negative.resolvedAssetIds = [address(1)];
  negative.ownedResolvedAssetIds = [];
  delete negative.inventoryResolutionRevisions;
  stored.set(key, JSON.stringify(negative));
  await resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)], initial);
  assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, []);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)], []);
  assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, []);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)], listPreorderRecoveries(buyer));
  assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, [address(1)]);
});

test('negative receipts for a sibling card do not invalidate a transfer-back proof', async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(76));
  const order = { ...record(1, 'succeeded').order, buyer, cardIds: [1, 2, 3],
    assets: [1, 2, 3].map(id => ({ id, address: address(id) })) };
  await upsertPreorderRecovery(order);
  await resolvePreorderInventoryAssets(buyer, order.assets.map(asset => asset.address));
  const requestRecords = listPreorderRecoveries(buyer);
  const initialRevision = requestRecords[0].inventoryResolutionRevisions![address(1)];
  for (let index = 0; index < 3; index += 1) resolvePreorderInventoryAssets(buyer, [address(2)]);
  await upsertPreorderRecovery({ ...order, confirmedSlot: 201 });
  const current = listPreorderRecoveries(buyer)[0];
  assert.equal(current.inventoryResolutionRevisions![address(1)], initialRevision);
  assert.equal(current.inventoryResolutionRevisions![address(2)], initialRevision + 3);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)], requestRecords);
  const final = listPreorderRecoveries(buyer);
  assert.deepEqual(final[0].ownedResolvedAssetIds, [address(1)]);
  assert.deepEqual(mergePreorderInventory([item(1), item(2), item(3)], final, new Set(order.assets.map(asset => asset.address))), [item(1)]);
});

test('late negative receipts cannot undo newer positive evidence from another query client', async context => {
  for (const initiallyOwned of [false, true]) await context.test(initiallyOwned ? 'repeated positive proof' : 'verified transfer back', async () => {
    const buyer = bs58.encode(new Uint8Array(32).fill(initiallyOwned ? 77 : 78));
    await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
    await resolvePreorderInventoryAssets(buyer, [address(1)], initiallyOwned ? [address(1)] : []);
    const first = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const second = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ['inventory', buyer, false];
    first.setQueryData(queryKey, [item(1)]);
    second.setQueryData(queryKey, [item(1)]);
    const started = Promise.withResolvers<void>();
    const finishOld = Promise.withResolvers<void>();
    let proofSlot = 250;
    const fetch = (client: QueryClient, positive: boolean, wait = false) => client.fetchQuery({ queryKey,
      queryFn: () => loadInventoryQuery(buyer, {
        includeDevnet: false, useRecentExpectedAssets: true,
        acknowledgedPreorderAssetIds: new Set(client.getQueryData<InventoryItem[]>(queryKey)?.map(item => item.id)),
        commitInventory: items => { client.setQueryData(queryKey, items); },
      }, {
        prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
        fetchInventory: async (_owner, options) => {
          const slot = ++proofSlot;
          if (wait) { started.resolve(); await finishOld.promise; }
          options.onPreorderAssetResolutions?.([proof(1, positive, slot)]);
          return positive ? [item(1)] : [];
        },
      }),
    });
    const oldNegative = fetch(first, false, true);
    await started.promise;
    const initialRevision = listPreorderRecoveries(buyer)[0].inventoryResolutionRevisions![address(1)];
    await fetch(second, true);
    assert.ok(listPreorderRecoveries(buyer)[0].inventoryResolutionRevisions![address(1)] > initialRevision);
    finishOld.resolve();
    await oldNegative;
    assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, [address(1)]);
    const canonical = first.getQueryData<InventoryItem[]>(queryKey)!;
    assert.deepEqual(canonical, []);
    assert.deepEqual(mergePreorderInventory(canonical, listPreorderRecoveries(buyer), new Set()), [{ ...item(1), image: `${config.imageBase}1.webp` }]);
    await fetch(first, false);
    assert.deepEqual(listPreorderRecoveries(buyer)[0].ownedResolvedAssetIds, []);
    assert.deepEqual(mergePreorderInventory([], listPreorderRecoveries(buyer), new Set()), []);
    first.clear();
    second.clear();
  });
});

for (const initiallyOwned of [false, true]) test(`sequential ${initiallyOwned ? 'negative' : 'positive'} proof from an older finalized slot cannot replace newer ownership evidence`, async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(initiallyOwned ? 84 : 85));
  await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
  let canonical: InventoryItem[] = [];
  const sentFloors: Array<Record<string, number> | undefined> = [];
  const load = async (slot: number, owned: boolean) => {
    canonical = await loadInventoryQuery(buyer, {
      includeDevnet: false, useRecentExpectedAssets: true,
      acknowledgedPreorderAssetIds: new Set(canonical.map(item => item.id)),
      commitInventory: items => { canonical = items; },
    }, {
      prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries, resolvePreorders: resolvePreorderInventoryAssets,
      fetchInventory: async (_owner, options) => {
        assert.equal(options.onResolvedPreorderAssetIds, undefined);
        sentFloors.push(options.preorderMinContextSlots);
        options.onPreorderAssetResolutions?.([proof(1, owned, slot)]);
        return owned ? [item(1)] : [];
      },
    });
    return mergePreorderInventory(canonical, listPreorderRecoveries(buyer), new Set(canonical.map(item => item.id)));
  };
  assert.equal((await load(250, initiallyOwned)).length, initiallyOwned ? 1 : 0);
  assert.equal((await load(249, !initiallyOwned)).length, initiallyOwned ? 1 : 0);
  assert.equal(listPreorderRecoveries(buyer)[0].inventoryResolutionSlots?.[address(1)], 250);
  assert.equal((await load(251, !initiallyOwned)).length, initiallyOwned ? 0 : 1);
  assert.deepEqual(sentFloors[2], { [address(1)]: 250 });
  assert.equal(listPreorderRecoveries(buyer)[0].inventoryResolutionSlots?.[address(1)], 251);
});

test('new inventory recovery ignores slotless legacy receipts without losing existing negative proof', async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(86));
  await upsertPreorderRecovery({ ...record(1, 'succeeded').order, buyer });
  await resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, false)]);
  const before = listPreorderRecoveries(buyer);
  const items = await loadInventoryQuery(buyer, {
    includeDevnet: false, useRecentExpectedAssets: true, acknowledgedPreorderAssetIds: new Set([address(1)]),
  }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: listPreorderRecoveries,
    resolvePreorders: () => assert.fail('A legacy receipt cannot update proof state'),
    fetchInventory: async (_owner, options) => {
      assert.equal(options.onResolvedPreorderAssetIds, undefined);
      options.onResolvedPreorderAssetIds?.([address(1)]);
      return [item(1)];
    },
  });
  assert.deepEqual(listPreorderRecoveries(buyer), before);
  assert.deepEqual(mergePreorderInventory(items, before, new Set([address(1)])), []);
});

for (const initiallyOwned of [false, true]) test(`confirmed-submitted receipts preserve ${initiallyOwned ? 'owned' : 'absent'} slot evidence until a newer finalized read`, async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(initiallyOwned ? 87 : 88));
  const submitted = { ...record(1).order, buyer };
  await upsertPreorderRecovery(submitted);
  const initial = listPreorderRecoveries(buyer);
  await resolvePreorderInventoryAssets(buyer, [address(1)]);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, false, 199)]);
  assert.deepEqual(listPreorderRecoveries(buyer), initial);
  assert.equal(mergePreorderInventory([], initial, new Set()).length, 1);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, initiallyOwned, 250)]);
  const current = listPreorderRecoveries(buyer);
  assert.equal(current[0].order.status, 'submitted');
  assert.equal(current[0].inventoryResolutionSlots?.[address(1)], 250);
  assert.deepEqual(current[0].ownedResolvedAssetIds, initiallyOwned ? [address(1)] : []);
  for (const slot of [249, 250]) {
    await resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, !initiallyOwned, slot)]);
    assert.deepEqual(listPreorderRecoveries(buyer), current);
  }
  await resolvePreorderInventoryAssets(buyer, [address(1)], initiallyOwned ? [] : [address(1)]);
  assert.deepEqual(listPreorderRecoveries(buyer), current);
  assert.equal(mergePreorderInventory([item(1)], current, new Set([address(1)])).length, initiallyOwned ? 1 : 0);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, !initiallyOwned, 251)]);
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'submitted');
  assert.equal(listPreorderRecoveries(buyer)[0].inventoryResolutionSlots?.[address(1)], 251);
  assert.equal(mergePreorderInventory([item(1)], listPreorderRecoveries(buyer), new Set([address(1)])).length, initiallyOwned ? 0 : 1);
});

for (const status of ['failed', 'expired'] as const) test(`${status} orders reject late finalized inventory receipts`, async () => {
  const buyer = bs58.encode(new Uint8Array(32).fill(status === 'failed' ? 89 : 90));
  await upsertPreorderRecovery({ ...record(1).order, buyer });
  await resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, false, 250)]);
  await upsertPreorderRecovery({ ...record(1, status).order, buyer });
  const terminal = listPreorderRecoveries(buyer);
  await resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)], undefined, undefined, [proof(1, true, 251)]);
  assert.deepEqual(listPreorderRecoveries(buyer), terminal);
  assert.deepEqual(mergePreorderInventory([item(1)], terminal, new Set([address(1)])), []);
});

for (const fallbackMode of ['session', 'memory'] as const) test(`a submitted ${fallbackMode} shadow adopts newer finalized proof from another tab`, async context => {
  const buyer = bs58.encode(new Uint8Array(32).fill(fallbackMode === 'session' ? 91 : 92));
  const submitted = { ...record(1).order, buyer };
  const memoryStorage = () => {
    const entries = new Map<string, string>();
    return {
      get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); },
    };
  };
  const shared = memoryStorage();
  const local = memoryStorage();
  const otherLocal = memoryStorage();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const setTab = (sessionStorage: typeof local) => Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: shared, sessionStorage },
  });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  setTab(local);
  const first: typeof import('../src/lib/preorderRecovery.ts') = await import(`../src/lib/preorderRecovery.ts?submitted-shadow-${fallbackMode}`);
  const second: typeof import('../src/lib/preorderRecovery.ts') = await import(`../src/lib/preorderRecovery.ts?submitted-shared-${fallbackMode}`);
  await first.upsertPreorderRecovery(submitted);
  const key = `mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${buyer}:${submitted.orderId}`;
  const original = shared.getItem(key)!;
  const sharedWrite = shared.setItem;
  shared.setItem = () => { throw new Error('Shared write unavailable'); };
  if (fallbackMode === 'memory') local.setItem = () => { throw new Error('Session storage unavailable'); };
  await first.resolvePreorderInventoryAssets(buyer, [address(1)], [address(1)], undefined, undefined, [proof(1, true, 249)]);
  shared.setItem = sharedWrite;
  assert.equal(first.listPreorderRecoveries(buyer)[0].inventoryResolutionSlots?.[address(1)], 249);
  assert.equal(shared.getItem(key), original);
  setTab(otherLocal);
  await second.resolvePreorderInventoryAssets(buyer, [address(1)], [], undefined, undefined, [proof(1, false, 250)]);
  const newerShared = shared.getItem(key);
  setTab(local);
  const merged = first.listPreorderRecoveries(buyer);
  assert.equal(merged[0].order.status, 'submitted');
  assert.equal(merged[0].inventoryResolutionSlots?.[address(1)], 250);
  assert.deepEqual(merged[0].ownedResolvedAssetIds, []);
  assert.deepEqual(mergePreorderInventory([item(1)], merged, new Set([address(1)])), []);
  await first.hydratePreorderRecoveries(buyer);
  assert.equal(shared.getItem(key), newerShared);
  shared.setItem(key, original);
  assert.equal(first.listPreorderRecoveries(buyer)[0].inventoryResolutionSlots?.[address(1)], 250);
  assert.deepEqual(mergePreorderInventory([item(1)], first.listPreorderRecoveries(buyer), new Set([address(1)])), []);
});

test('slot floors are bounded to the actual selected hint batch', async () => {
  const records = Array.from({ length: 18 }, (_, index) => ({ ...record(index + 1, 'succeeded'),
    inventoryResolutionSlots: { [address(index + 1)]: 250 + index } }));
  const visited = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await loadInventoryQuery(owner, { includeDevnet: false, useRecentExpectedAssets: true }, {
      prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: () => records, resolvePreorders() {},
      fetchInventory: async (_owner, options) => {
        const expected = options.expectedAssetIds?.['mainnet-beta'] ?? [];
        assert.equal(expected.length, 15);
        assert.deepEqual(new Set(Object.keys(options.preorderMinContextSlots!)), new Set(expected));
        for (const id of expected) {
          visited.add(id);
          assert.equal(options.preorderMinContextSlots![id], records.find(record => record.order.assets[0].address === id)!.inventoryResolutionSlots[id]);
        }
        return [];
      },
    });
  }
  assert.equal(visited.size, 18);
});
