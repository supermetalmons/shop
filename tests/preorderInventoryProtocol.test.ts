import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { isExactShopInventoryRequest, isExactShopInventoryResponse, SHOP_EXPECTED_ASSET_IDS_MAX } from '../shared/shopApi.ts';

const owner = bs58.encode(new Uint8Array(32).fill(1));
const ids = Array.from({ length: 16 }, (_, index) => bs58.encode(new Uint8Array(32).fill(index + 2)));
const request = { owner, includePreorderResolutions: true, includePreorderResolutionSlots: true,
  expectedAssetIds: { 'mainnet-beta': ids.slice(0, SHOP_EXPECTED_ASSET_IDS_MAX) } };
const item = { id: ids[0], dropId: 'mi_note_cards', name: 'Preorder #1', kind: 'preorder', preorderId: 1 };

test('slot floors require opt-in and a bounded subset of selected asset addresses', () => {
  assert.equal(isExactShopInventoryRequest({ owner }), true);
  assert.equal(isExactShopInventoryRequest({ ...request, preorderMinContextSlots: {} }), true);
  assert.equal(isExactShopInventoryRequest({ ...request, preorderMinContextSlots: Object.fromEntries(ids.slice(0, 15).map(id => [id, Number.MAX_SAFE_INTEGER])) }), true);
  for (const value of [
    { ...request, includePreorderResolutions: false },
    { ...request, includePreorderResolutions: undefined },
    { ...request, includePreorderResolutionSlots: false },
    { ...request, includePreorderResolutionSlots: undefined, preorderMinContextSlots: {} },
    { ...request, preorderMinContextSlots: null },
    { ...request, preorderMinContextSlots: [] },
    { ...request, preorderMinContextSlots: { invalid: 250 } },
    { ...request, preorderMinContextSlots: { [ids[15]]: 250 } },
    { ...request, expectedAssetIds: undefined, preorderMinContextSlots: { [ids[0]]: 250 } },
    { ...request, preorderMinContextSlots: Object.fromEntries(ids.map(id => [id, 250])) },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '250'].map(slot => ({ ...request, preorderMinContextSlots: { [ids[0]]: slot } })),
  ]) assert.equal(isExactShopInventoryRequest(value), false);
});

test('slot receipts exactly match the legacy IDs and returned preorder ownership', () => {
  const absent = { ok: true, items: [], resolvedPreorderAssetIds: [ids[0]], preorderAssetResolutions: [{ id: ids[0], slot: 250, owned: false }] };
  const owned = { ...absent, items: [item], preorderAssetResolutions: [{ id: ids[0], slot: 251, owned: true }] };
  assert.equal(isExactShopInventoryResponse({ ok: true, items: [] }), true);
  assert.equal(isExactShopInventoryResponse({ ok: true, items: [], preorderAssetResolutions: [] }), true);
  assert.equal(isExactShopInventoryResponse(absent), true);
  assert.equal(isExactShopInventoryResponse(owned), true);
  for (const value of [
    { ...owned, resolvedPreorderAssetIds: undefined },
    { ...owned, resolvedPreorderAssetIds: [ids[1]] },
    { ...owned, preorderAssetResolutions: [] },
    { ...owned, preorderAssetResolutions: [...owned.preorderAssetResolutions, ...owned.preorderAssetResolutions] },
    { ...owned, preorderAssetResolutions: Array.from({ length: 16 }, (_, index) => ({ id: ids[index], slot: 250, owned: false })) },
    { ...owned, items: [] },
    { ...absent, items: [item] },
    { ...owned, items: [{ id: ids[0], dropId: 'card_nft_2', name: 'Pack', kind: 'box' }] },
    { ...owned, items: [item, item] },
    { ...owned, preorderAssetResolutions: [{ id: ids[0], slot: 251, owned: 'yes' }] },
    { ...owned, preorderAssetResolutions: [{ id: ids[0], slot: 251, owned: true, extra: true }] },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '250', undefined].map(slot => ({ ...owned,
      preorderAssetResolutions: [{ id: ids[0], slot, owned: true }] })),
  ]) assert.equal(isExactShopInventoryResponse(value), false);
});
