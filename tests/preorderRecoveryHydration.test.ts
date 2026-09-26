import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import bs58 from 'bs58';
import { getPreorderConfig } from '../shared/preorders.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import { mergePreorderInventory, unresolvedPreorderInventoryAssets } from '../src/lib/preorderInventory.ts';

const { dom } = setupFrontendDom();
const { cleanup, renderHook, waitFor, act } = await import('@testing-library/react');
const { usePreorderRecoveryRecords } = await import('../src/hooks/usePreorderRecoveryRecords.ts');
const config = getPreorderConfig('mi_note_cards')!;
const owner = bs58.encode(new Uint8Array(32).fill(40));
const signature = bs58.encode(new Uint8Array(64).fill(41));

beforeEach(t => { if ('after' in t) installBrowserLocks(t); });
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });
after(() => dom.window.close());

for (const version of ['v1', 'v2']) test(`the recovery hook hydrates terminal ${version} records without requiring a mutation`, async () => {
  const seeds = ['succeeded', 'failed'].map((status, index) => {
    const address = bs58.encode(new Uint8Array(32).fill(index + 42));
    const order = { orderId: `hydrate-${status}`, preorderId: config.preorderId, buyer: owner, ethereumAddress: null,
      status, cardIds: [index + 1], assets: [{ id: index + 1, address }], confirmedSlot: 200, expiresAtMs: 1, signature };
    const record = { order, resolvedAssetIds: status === 'succeeded' ? [address] : [], ownedResolvedAssetIds: [],
      inventoryResolutionRevisions: status === 'succeeded' ? { [address]: 1 } : {},
      inventoryResolutionVersion: 3, failureNotified: status === 'failed' };
    const key = `mons:preorder-recovery:${version}:${config.cluster}:${config.collection}:${owner}:${order.orderId}`;
    const value = JSON.stringify(record);
    window.localStorage.setItem(key, value);
    return { key, value, record, currentKey: key.replace(`:${version}:`, ':v3:') };
  });
  const { result } = renderHook(() => usePreorderRecoveryRecords(owner));
  const before = JSON.stringify(result.current);
  await waitFor(() => assert.ok(seeds.every(seed => window.localStorage.getItem(seed.currentKey))));
  assert.equal(JSON.stringify(result.current), before);
  for (const seed of seeds) assert.equal(window.localStorage.getItem(seed.key), seed.value);
  await act(async () => {
    for (const seed of seeds) {
      window.localStorage.setItem(seed.key, JSON.stringify({ ...seed.record, order: { ...seed.record.order, status: 'submitted' },
        ownedResolvedAssetIds: seed.record.order.assets.map(asset => asset.address) }));
      window.dispatchEvent(new dom.window.StorageEvent('storage', { key: seed.key }));
    }
  });
  assert.equal(JSON.stringify(result.current), before);
});

for (const owned of [false, true]) test(`the recovery hook observes newer shared ${owned ? 'absence' : 'ownership'} through a local shadow and saves it only locally`, async context => {
  const address = bs58.encode(new Uint8Array(32).fill(44));
  const order = { orderId: 'shared-proof-hydration', preorderId: config.preorderId, buyer: owner, ethereumAddress: null,
    status: 'succeeded', cardIds: [1], assets: [{ id: 1, address }], confirmedSlot: 200, expiresAtMs: 1, signature };
  const key = `mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${owner}:${order.orderId}`;
  const local = { order, resolvedAssetIds: [address], ownedResolvedAssetIds: owned ? [address] : [],
    inventoryResolutionRevisions: { [address]: 1 }, inventoryResolutionSlots: { [address]: 249 }, inventoryResolutionVersion: 3, failureNotified: false };
  const originalSet = dom.window.Storage.prototype.setItem;
  window.sessionStorage.setItem(key, JSON.stringify(local));
  const originalShared = JSON.stringify({ ...local, resolvedAssetIds: [], ownedResolvedAssetIds: [], inventoryResolutionSlots: {} });
  window.localStorage.setItem(key, originalShared);
  let sharedWrites = 0;
  context.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (this === window.localStorage) sharedWrites += 1;
    return originalSet.call(this, key, value);
  });
  const raw = [{ id: address, dropId: config.preorderId, kind: 'preorder' as const, name: 'Preorder #1', preorderId: 1 }];
  const { result } = renderHook(() => {
    const records = usePreorderRecoveryRecords(owner);
    const acknowledged = new Set([address]);
    return { records, visible: mergePreorderInventory(raw, records, acknowledged),
      targets: unresolvedPreorderInventoryAssets(records, acknowledged) };
  });
  assert.equal(result.current.visible.length, owned ? 1 : 0);
  const stronger = JSON.stringify({ ...local, ownedResolvedAssetIds: owned ? [] : [address],
    inventoryResolutionRevisions: { [address]: 2 }, inventoryResolutionSlots: { [address]: 250 } });
  await act(async () => {
    originalSet.call(window.localStorage, key, stronger);
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key, oldValue: originalShared, newValue: stronger }));
  });
  assert.equal(result.current.visible.length, owned ? 0 : 1);
  assert.deepEqual(result.current.targets.map(asset => asset.address), owned ? [address] : []);
  await waitFor(() => assert.equal(JSON.parse(window.sessionStorage.getItem(key)!).inventoryResolutionSlots[address], 250));
  assert.equal(sharedWrites, 0);
  assert.equal(window.localStorage.getItem(key), stronger);
  await act(async () => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key, oldValue: stronger, newValue: null }));
  });
  assert.equal(result.current.records[0].inventoryResolutionSlots?.[address], 250);
  assert.equal(result.current.visible.length, owned ? 0 : 1);
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new DOMException('Blocked', 'SecurityError'); } });
  try {
    await act(async () => { window.dispatchEvent(new dom.window.StorageEvent('storage', { key })); });
    assert.equal(result.current.records[0].inventoryResolutionSlots?.[address], 250);
    assert.equal(result.current.visible.length, owned ? 0 : 1);
  } finally { Object.defineProperty(window, 'localStorage', localStorageDescriptor); }
});
