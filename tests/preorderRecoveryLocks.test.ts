import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import { getPreorderConfig, type PreorderOrder } from '../shared/preorders.ts';
import { createBrowserLockManager, installBrowserLocks } from './helpers/browserLocks.ts';
import { loadInventoryQuery } from '../src/lib/inventoryQuery.ts';
import { mergePreorderInventory, unresolvedPreorderInventoryAssets } from '../src/lib/preorderInventory.ts';

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

let nextId = 80;
async function fixture(context: TestContext) {
  const id = nextId++;
  const buyer = bs58.encode(new Uint8Array(32).fill(id));
  const address = bs58.encode(new Uint8Array(32).fill(id + 10));
  const config = getPreorderConfig('mi_note_cards')!;
  const order: PreorderOrder = { orderId: `locked-${id}`, preorderId: config.preorderId, buyer, ethereumAddress: null,
    status: 'succeeded', cardIds: [1], assets: [{ id: 1, address }], confirmedSlot: 200,
    expiresAtMs: 1, signature: bs58.encode(new Uint8Array(64).fill(1)) };
  const shared = new MemoryStorage();
  const session = new MemoryStorage();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: shared, sessionStorage: session } });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const locks = installBrowserLocks(context, createBrowserLockManager());
  const first: typeof import('../src/lib/preorderRecovery.ts') = await import(`../src/lib/preorderRecovery.ts?lock-first-${id}`);
  const second: typeof import('../src/lib/preorderRecovery.ts') = await import(`../src/lib/preorderRecovery.ts?lock-second-${id}`);
  assert.notEqual(first.upsertPreorderRecovery, second.upsertPreorderRecovery);
  const key = `mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${buyer}:${order.orderId}`;
  const lockKey = `mons:preorder-recovery-mutation:${key}`;
  await first.upsertPreorderRecovery(order);
  const hold = async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const held = locks.request(lockKey, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    return { release: () => release.resolve(), held };
  };
  return { first, second, order, address, key, lockKey, locks, shared, session, hold };
}

test('independent recovery modules serialize proof checks and status merges under the same browser lock', async context => {
  const f = await fixture(context);
  const initial = f.first.listPreorderRecoveries(f.order.buyer);
  const before = f.shared.getItem(f.key);
  const held = await f.hold();
  const negative = f.second.resolvePreorderInventoryAssets(f.order.buyer, [f.address], [], initial);
  const status = f.first.upsertPreorderRecovery({ ...f.order, confirmedSlot: 201 });
  const oldPositive = f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address], [f.address], initial);
  await Promise.resolve();
  assert.equal(f.shared.getItem(f.key), before);
  held.release();
  await Promise.all([held.held, negative, status, oldPositive]);
  const record = f.first.listPreorderRecoveries(f.order.buyer)[0];
  assert.equal(record.order.confirmedSlot, 201);
  assert.deepEqual(record.ownedResolvedAssetIds, []);
  assert.equal(record.inventoryResolutionRevisions?.[f.address], 1);
  assert.equal(f.session.length, 0);
});

test('failure acknowledgements and status updates merge the current locked record', async context => {
  const f = await fixture(context);
  const failed = { ...f.order, orderId: `${f.order.orderId}-failed`, status: 'failed' as const };
  await f.first.upsertPreorderRecovery(failed);
  const initial = f.first.listPreorderRecoveries(f.order.buyer).find(record => record.order.orderId === failed.orderId)!;
  const key = f.key.replace(f.order.orderId, failed.orderId);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = f.locks.request(`mons:preorder-recovery-mutation:${key}`, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const ack = f.first.acknowledgePreorderFailure(f.order.buyer, failed.preorderId, failed.orderId);
  const staleStatus = f.second.upsertPreorderRecovery(initial.order);
  release.resolve();
  await Promise.all([held, ack, staleStatus]);
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer).find(record => record.order.orderId === failed.orderId)?.failureNotified, true);
});

test('an inventory request aborted while waiting for its proof lock cannot publish a receipt', { timeout: 1000 }, async context => {
  const f = await fixture(context);
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address]);
  const before = f.first.listPreorderRecoveries(f.order.buyer);
  const held = await f.hold();
  const controller = new AbortController();
  const committed = Promise.withResolvers<void>();
  const pending = loadInventoryQuery(f.order.buyer, {
    includeDevnet: false, useRecentExpectedAssets: true, signal: controller.signal,
    acknowledgedPreorderAssetIds: new Set([f.address]), commitInventory: () => committed.resolve(),
  }, {
    prepare: () => ({ commit() {} }), reconcile() {}, listPreorders: f.first.listPreorderRecoveries,
    resolvePreorders: f.first.resolvePreorderInventoryAssets,
    fetchInventory: async (_buyer, options) => {
      options.onPreorderAssetResolutions?.([{ id: f.address, slot: 250, owned: true }]);
      return [{ id: f.address, kind: 'preorder', name: 'Preorder #1', dropId: f.order.preorderId, preorderId: 1 }];
    },
  });
  await committed.promise;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  held.release();
  await held.held;
  assert.deepEqual(f.first.listPreorderRecoveries(f.order.buyer), before);
});

test('late unlocked legacy writers cannot overwrite the new locked recovery record', async context => {
  const f = await fixture(context);
  const legacyKey = f.key.replace(':v3:', ':v1:');
  const legacy = f.shared.getItem(f.key)!;
  f.shared.setItem(legacyKey, legacy);
  f.shared.removeItem(f.key);
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer).length, 1);
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address]);
  assert.ok(f.shared.getItem(f.key));
  assert.equal(f.shared.getItem(legacyKey), legacy);
  const stalePositive = JSON.parse(legacy);
  stalePositive.resolvedAssetIds = [f.address];
  stalePositive.ownedResolvedAssetIds = [f.address];
  f.shared.setItem(legacyKey, JSON.stringify(stalePositive));
  const current = f.second.listPreorderRecoveries(f.order.buyer);
  assert.equal(current.length, 1);
  assert.deepEqual(current[0].ownedResolvedAssetIds, []);
  assert.equal(current[0].inventoryResolutionRevisions?.[f.address], 1);
});

test('unavailable shared reads preserve recovery in isolated tab storage', async context => {
  const f = await fixture(context);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { length: 0, key: () => null, getItem: () => { throw new Error('Read blocked'); },
      setItem: () => assert.fail('A failed shared read must not overwrite shared recovery') },
    sessionStorage: f.session,
  } });
  await f.first.upsertPreorderRecovery(f.order);
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address]);
  assert.deepEqual(f.first.listPreorderRecoveries(f.order.buyer)[0].resolvedAssetIds, [f.address]);
  assert.equal(f.session.length, 1);
});

test('unavailable browser storage retains recovery in process-local memory', async context => {
  const f = await fixture(context);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw new Error('Storage blocked'); }, get sessionStorage() { throw new Error('Storage blocked'); },
  } });
  await f.first.upsertPreorderRecovery(f.order);
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address]);
  assert.deepEqual(f.first.listPreorderRecoveries(f.order.buyer)[0].resolvedAssetIds, [f.address]);
  assert.equal(f.second.listPreorderRecoveries(f.order.buyer).length, 0);
});

for (const mode of ['unsupported', 'denied'] as const) test(`${mode} browser locks isolate writes in reloadable tab storage`, async context => {
  const f = await fixture(context);
  const original = f.shared.getItem(f.key);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: mode === 'unsupported' ? undefined
    : { request: () => Promise.reject(new DOMException('Denied', 'SecurityError')) } });
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address]);
  assert.equal(f.shared.getItem(f.key), original);
  assert.equal(f.session.length, 1);
  const reloaded = f.second.listPreorderRecoveries(f.order.buyer)[0];
  assert.deepEqual(reloaded.resolvedAssetIds, [f.address]);
  assert.deepEqual(reloaded.ownedResolvedAssetIds, []);
  await f.second.upsertPreorderRecovery({ ...f.order, confirmedSlot: 201 });
  assert.equal(f.shared.getItem(f.key), original);
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].order.confirmedSlot, 201);
});

for (const version of ['v1', 'v2'] as const) for (const mutation of ['status', 'ignored-proof', 'hydrate'] as const) {
  test(`${mutation} materializes an unchanged ${version} negative proof before a legacy writer can replace it`, async context => {
    const f = await fixture(context);
    await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address]);
    const negative = f.shared.getItem(f.key)!;
    const legacyKey = f.key.replace(':v3:', `:${version}:`);
    f.shared.setItem(legacyKey, negative);
    f.shared.removeItem(f.key);
    const before = f.first.preorderRecoverySnapshot(f.order.buyer);
    assert.equal(f.shared.getItem(f.key), null);
    if (mutation === 'status') await f.first.upsertPreorderRecovery(f.order);
    else if (mutation === 'ignored-proof') await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address], [f.address], []);
    else await f.first.hydratePreorderRecoveries(f.order.buyer);
    assert.ok(f.shared.getItem(f.key));
    assert.equal(f.shared.getItem(legacyKey), negative);
    const stalePositive = JSON.parse(negative);
    stalePositive.ownedResolvedAssetIds = [f.address];
    f.shared.setItem(legacyKey, JSON.stringify(stalePositive));
    assert.equal(f.second.preorderRecoverySnapshot(f.order.buyer), before);
  });
}

test('hydration prefers v2 seeds and materializes terminal records without changing their state', async context => {
  const f = await fixture(context);
  const confirmed = JSON.parse(f.shared.getItem(f.key)!);
  confirmed.order.status = 'submitted';
  const failed = { ...confirmed, order: { ...confirmed.order, status: 'failed' }, failureNotified: true };
  f.shared.setItem(f.key.replace(':v3:', ':v1:'), JSON.stringify(confirmed));
  f.shared.setItem(f.key.replace(':v3:', ':v2:'), JSON.stringify(failed));
  f.shared.removeItem(f.key);
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].order.status, 'failed');
  await f.first.hydratePreorderRecoveries(f.order.buyer);
  assert.equal(JSON.parse(f.shared.getItem(f.key)!).order.status, 'failed');
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].failureNotified, true);
  f.shared.setItem(f.key.replace(':v3:', ':v2:'), JSON.stringify(confirmed));
  assert.equal(f.second.listPreorderRecoveries(f.order.buyer)[0].order.status, 'failed');
});

for (const initiallyOwned of [false, true]) {
  test(`finalized slot evidence is monotonic after ${initiallyOwned ? 'owned' : 'absent'} slot 250`, async context => {
    const f = await fixture(context);
    const initial = f.first.listPreorderRecoveries(f.order.buyer);
    const prove = (slot: number, owned: boolean) => f.first.resolvePreorderInventoryAssets(f.order.buyer,
      [f.address], owned ? [f.address] : [], initial, undefined, [{ id: f.address, slot, owned }]);
    await prove(199, initiallyOwned);
    assert.deepEqual(f.first.listPreorderRecoveries(f.order.buyer)[0].resolvedAssetIds, []);
    await prove(250, initiallyOwned);
    const at250 = f.first.preorderRecoverySnapshot(f.order.buyer);
    await prove(249, !initiallyOwned);
    await prove(250, !initiallyOwned);
    await prove(250, initiallyOwned);
    await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address], initiallyOwned ? [] : [f.address]);
    assert.equal(f.first.preorderRecoverySnapshot(f.order.buyer), at250);
    await prove(251, !initiallyOwned);
    const current = f.first.listPreorderRecoveries(f.order.buyer)[0];
    assert.equal(current.inventoryResolutionSlots?.[f.address], 251);
    assert.deepEqual(current.ownedResolvedAssetIds, initiallyOwned ? [] : [f.address]);
    assert.equal(current.inventoryResolutionRevisions?.[f.address], 2);
    await f.first.upsertPreorderRecovery({ ...f.order, confirmedSlot: 260 });
    await prove(259, initiallyOwned);
    assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].inventoryResolutionSlots?.[f.address], 251);
    await prove(260, initiallyOwned);
    assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].inventoryResolutionSlots?.[f.address], 260);
  });
}

for (const newerFirst of [false, true]) {
  test(`concurrent proofs keep the higher slot when ${newerFirst ? 'newer' : 'older'} evidence obtains the lock first`, async context => {
    const f = await fixture(context);
    const initial = f.first.listPreorderRecoveries(f.order.buyer);
    const held = await f.hold();
    const newer = () => f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address], [f.address], initial, undefined,
      [{ id: f.address, slot: 251, owned: true }]);
    const older = () => f.second.resolvePreorderInventoryAssets(f.order.buyer, [f.address], [], initial, undefined,
      [{ id: f.address, slot: 250, owned: false }]);
    const pending = newerFirst ? [newer(), older()] : [older(), newer()];
    held.release();
    await Promise.all([held.held, ...pending]);
    const current = f.first.listPreorderRecoveries(f.order.buyer)[0];
    assert.equal(current.inventoryResolutionSlots?.[f.address], 251);
    assert.deepEqual(current.ownedResolvedAssetIds, [f.address]);
  });
}

test('slot floors apply independently to sibling assets and survive status updates', async context => {
  const f = await fixture(context);
  const sibling = bs58.encode(new Uint8Array(32).fill(150));
  const order = { ...f.order, orderId: `${f.order.orderId}-siblings`, cardIds: [1, 2], assets: [f.order.assets[0], { id: 2, address: sibling }] };
  await f.first.upsertPreorderRecovery(order);
  const initial = f.first.listPreorderRecoveries(f.order.buyer);
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address, sibling], [sibling], initial, undefined,
    [{ id: f.address, slot: 250, owned: false }, { id: sibling, slot: 500, owned: true }]);
  await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address, sibling], [f.address], initial, undefined,
    [{ id: f.address, slot: 251, owned: true }, { id: sibling, slot: 499, owned: false }]);
  await f.first.upsertPreorderRecovery(order);
  const current = f.first.listPreorderRecoveries(f.order.buyer).find(record => record.order.orderId === order.orderId)!;
  assert.deepEqual(current.inventoryResolutionSlots, { [f.address]: 251, [sibling]: 500 });
  assert.deepEqual(current.ownedResolvedAssetIds, [f.address, sibling]);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function withOtherTab<T>(f: Fixture, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')!;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: f.shared, sessionStorage: new MemoryStorage() } });
  try { return await run(); } finally { Object.defineProperty(globalThis, 'window', previous); }
}

async function localProof(f: Fixture, slot: number, owned: boolean, mode: 'quota' | 'denied' = 'quota') {
  const originalWrite = f.shared.setItem;
  const originalLocks = navigator.locks;
  if (mode === 'quota') f.shared.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  else Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: () => Promise.reject(new DOMException('Denied', 'SecurityError')) } });
  try {
    await f.first.resolvePreorderInventoryAssets(f.order.buyer, [f.address], owned ? [f.address] : [], undefined, undefined,
      [{ id: f.address, slot, owned }]);
  } finally {
    f.shared.setItem = originalWrite;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks });
  }
}

for (const owned of [false, true]) for (const mode of ['quota', 'denied'] as const) {
  test(`${mode} local ${owned ? 'ownership' : 'absence'} at 249 incorporates shared opposite proof at 250 without writing shared state`, async context => {
    const f = await fixture(context);
    const originalShared = f.shared.getItem(f.key);
    await localProof(f, 249, owned, mode);
    assert.equal(f.shared.getItem(f.key), originalShared);
    assert.equal(JSON.parse(f.session.getItem(f.key)!).inventoryResolutionSlots[f.address], 249);
    await withOtherTab(f, () => f.second.resolvePreorderInventoryAssets(f.order.buyer, [f.address], owned ? [] : [f.address], undefined, undefined,
      [{ id: f.address, slot: 250, owned: !owned }]));
    const shared = f.shared.getItem(f.key);
    const records = f.first.listPreorderRecoveries(f.order.buyer);
    assert.equal(records[0].inventoryResolutionSlots?.[f.address], 250);
    assert.deepEqual(records[0].ownedResolvedAssetIds, owned ? [] : [f.address]);
    const raw = [{ id: f.address, dropId: f.order.preorderId, kind: 'preorder' as const, name: 'Preorder #1', preorderId: 1 }];
    assert.equal(mergePreorderInventory(raw, records, new Set([f.address])).length, owned ? 0 : 1);
    assert.deepEqual(unresolvedPreorderInventoryAssets(records, new Set([f.address])).map(asset => asset.address), owned ? [f.address] : []);
    if (mode === 'quota') await f.first.upsertPreorderRecovery(f.order);
    else await f.first.hydratePreorderRecoveries(f.order.buyer);
    assert.equal(f.shared.getItem(f.key), shared);
    assert.equal(JSON.parse(f.session.getItem(f.key)!).inventoryResolutionSlots[f.address], 250);
    f.shared.removeItem(f.key);
    assert.deepEqual(f.second.listPreorderRecoveries(f.order.buyer)[0].ownedResolvedAssetIds, owned ? [] : [f.address]);
    f.shared.getItem = () => { throw new Error('Shared storage blocked'); };
    assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].inventoryResolutionSlots?.[f.address], 250);
  });
}

for (const owned of [false, true]) test(`local ${owned ? 'ownership' : 'absence'} at 251 wins over older and equal conflicting shared proof`, async context => {
  const f = await fixture(context);
  await localProof(f, 251, owned);
  for (const slot of [250, 251]) {
    await withOtherTab(f, () => f.second.resolvePreorderInventoryAssets(f.order.buyer, [f.address], owned ? [] : [f.address], undefined, undefined,
      [{ id: f.address, slot, owned: !owned }]));
    const current = f.first.listPreorderRecoveries(f.order.buyer)[0];
    assert.equal(current.inventoryResolutionSlots?.[f.address], 251);
    assert.deepEqual(current.ownedResolvedAssetIds, owned ? [f.address] : []);
  }
});

test('local and shared records merge sibling proof slots independently', async context => {
  const f = await fixture(context);
  const sibling = bs58.encode(new Uint8Array(32).fill(170));
  const order = { ...f.order, assets: [...f.order.assets, { id: 2, address: sibling }], cardIds: [1, 2] };
  await f.first.upsertPreorderRecovery(order);
  const originalWrite = f.shared.setItem;
  f.shared.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  await f.first.resolvePreorderInventoryAssets(order.buyer, [f.address, sibling], [f.address], undefined, undefined,
    [{ id: f.address, slot: 249, owned: true }, { id: sibling, slot: 500, owned: false }]);
  f.shared.setItem = originalWrite;
  await withOtherTab(f, () => f.second.resolvePreorderInventoryAssets(order.buyer, [f.address, sibling], [sibling], undefined, undefined,
    [{ id: f.address, slot: 250, owned: false }, { id: sibling, slot: 499, owned: true }]));
  let current = f.first.listPreorderRecoveries(order.buyer)[0];
  assert.deepEqual(current.inventoryResolutionSlots, { [f.address]: 250, [sibling]: 500 });
  assert.deepEqual(current.ownedResolvedAssetIds, []);
  await withOtherTab(f, () => f.second.resolvePreorderInventoryAssets(order.buyer, [sibling], [sibling], undefined, undefined,
    [{ id: sibling, slot: 501, owned: true }]));
  current = f.first.listPreorderRecoveries(order.buyer)[0];
  assert.deepEqual(current.inventoryResolutionSlots, { [f.address]: 250, [sibling]: 501 });
  assert.deepEqual(current.ownedResolvedAssetIds, [sibling]);
});

for (const status of ['succeeded', 'failed', 'expired'] as const) test(`a shared ${status} result advances an isolated submitted order and preserves acknowledgements`, async context => {
  const f = await fixture(context);
  const submitted = { ...f.order, status: 'submitted' as const };
  const source = JSON.parse(f.shared.getItem(f.key)!);
  f.shared.removeItem(f.key);
  f.session.setItem(f.key, JSON.stringify({ ...source, order: submitted }));
  await withOtherTab(f, async () => {
    await f.second.upsertPreorderRecovery({ ...submitted, status, confirmedSlot: 201 });
    if (status !== 'succeeded') await f.second.acknowledgePreorderFailure(submitted.buyer, submitted.preorderId, submitted.orderId);
  });
  const shared = f.shared.getItem(f.key);
  let current = f.first.listPreorderRecoveries(submitted.buyer)[0];
  assert.equal(current.order.status, status);
  assert.equal(current.order.confirmedSlot, 201);
  assert.equal(current.failureNotified, status !== 'succeeded');
  await f.first.upsertPreorderRecovery(submitted);
  assert.equal(f.shared.getItem(f.key), shared);
  f.shared.setItem(f.key, JSON.stringify({ ...source, order: submitted }));
  current = f.first.listPreorderRecoveries(submitted.buyer)[0];
  assert.equal(current.order.status, status);
  assert.equal(current.failureNotified, status !== 'succeeded');
});

test('fallback merge ignores malformed, mismatched and legacy shared evidence', async context => {
  const f = await fixture(context);
  await localProof(f, 249, true);
  const local = JSON.parse(f.session.getItem(f.key)!);
  const stronger = { ...local, ownedResolvedAssetIds: [], inventoryResolutionSlots: { [f.address]: 250 } };
  const mismatches = [
    '{',
    JSON.stringify({ ...stronger, order: { ...f.order, orderId: 'different-order' } }),
    JSON.stringify({ ...stronger, order: { ...f.order, signature: bs58.encode(new Uint8Array(64).fill(4)) } }),
    JSON.stringify({ ...stronger, order: { ...f.order, ethereumAddress: '0x0000000000000000000000000000000000000001' } }),
    JSON.stringify({ ...stronger, order: { ...f.order, assets: [{ id: 1, address: bs58.encode(new Uint8Array(32).fill(171)) }] } }),
  ];
  for (const value of mismatches) {
    f.shared.setItem(f.key, value);
    assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].inventoryResolutionSlots?.[f.address], 249);
    assert.deepEqual(f.first.listPreorderRecoveries(f.order.buyer)[0].ownedResolvedAssetIds, [f.address]);
  }
  f.shared.removeItem(f.key);
  for (const version of ['v1', 'v2']) f.shared.setItem(f.key.replace(':v3:', `:${version}:`), JSON.stringify(stronger));
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].inventoryResolutionSlots?.[f.address], 249);
  f.shared.setItem(f.key, JSON.stringify(stronger));
  for (const invalidLocal of ['{', JSON.stringify({ ...local, order: { ...f.order, orderId: 'wrong-local-order' } })]) {
    f.session.setItem(f.key, invalidLocal);
    assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].inventoryResolutionSlots?.[f.address], 250);
    const before = f.shared.getItem(f.key);
    await f.first.hydratePreorderRecoveries(f.order.buyer);
    assert.equal(f.shared.getItem(f.key), before);
    assert.equal(JSON.parse(f.session.getItem(f.key)!).inventoryResolutionSlots[f.address], 250);
  }
});

for (const localStatus of ['succeeded', 'failed'] as const) test(`conflicting shared terminal status cannot replace local ${localStatus}`, async context => {
  const f = await fixture(context);
  const source = JSON.parse(f.shared.getItem(f.key)!);
  const local = { ...source, order: { ...f.order, status: localStatus }, failureNotified: localStatus === 'failed' };
  f.session.setItem(f.key, JSON.stringify(local));
  f.shared.setItem(f.key, JSON.stringify({ ...source, order: { ...f.order, status: localStatus === 'failed' ? 'succeeded' : 'failed', confirmedSlot: 201 } }));
  const current = f.first.listPreorderRecoveries(f.order.buyer)[0];
  assert.equal(current.order.status, localStatus);
  assert.equal(current.failureNotified, localStatus === 'failed');
  assert.equal(current.order.confirmedSlot, 200);
});

test('a local failure acknowledgement survives an unacknowledged shared terminal record', async context => {
  const f = await fixture(context);
  const source = JSON.parse(f.shared.getItem(f.key)!);
  const failed = { ...source, order: { ...f.order, status: 'failed' }, failureNotified: false };
  const shared = JSON.stringify(failed);
  f.shared.setItem(f.key, shared);
  f.session.setItem(f.key, JSON.stringify({ ...failed, failureNotified: true }));
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].failureNotified, true);
  await f.first.upsertPreorderRecovery(failed.order);
  assert.equal(f.first.listPreorderRecoveries(f.order.buyer)[0].failureNotified, true);
  assert.equal(f.shared.getItem(f.key), shared);
});
