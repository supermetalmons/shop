import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreorderConfig, preorderIdFromMetadataUri, preorderMetadataUri } from '../shared/preorders.ts';
import { listShopInventoryCollectionScopes, transformShopInventoryItem } from '../shared/shopDomain.ts';
import { isExactShopInventoryResponse } from '../shared/shopApi.ts';
import { canDeliverItemKind } from '../shared/shipping.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const asset = {
  id: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  interface: 'MplCoreAsset',
  burnt: false,
  grouping: [{ group_key: 'collection', group_value: config.collection }],
  content: { json_uri: preorderMetadataUri(config, 1395), metadata: { name: 'Preorder #1395' } },
};

test('preorders use exact trusted collection and canonical numeric metadata IDs', () => {
  const item = transformShopInventoryItem(asset, 'devnet');
  assert.deepEqual(item, {
    id: asset.id, dropId: config.preorderId, name: 'Preorder #1395', kind: 'preorder', preorderId: 1395,
    rawImage: 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1395.webp',
  });
  assert.equal(isExactShopInventoryResponse({ ok: true, items: [item] }), true);
  assert.equal(transformShopInventoryItem(asset, 'mainnet-beta'), null);
  assert.equal(transformShopInventoryItem(asset), null);
  assert.equal(transformShopInventoryItem({ ...asset, burnt: true }, 'devnet'), null);
  assert.equal(transformShopInventoryItem({ ...asset, interface: 'V1_NFT' }, 'devnet'), null);
  assert.equal(transformShopInventoryItem({ ...asset, grouping: [{ group_key: 'collection', group_value: asset.id }] }, 'devnet'), null);
  for (const suffix of ['0.json', '1396.json', '01.json', '1.0.json', 'f1.json', '1.json?v=1', '1.json#x', '../1.json']) {
    const uri = `${config.metadataBase}${suffix}`;
    assert.equal(preorderIdFromMetadataUri(config, uri), null, uri);
    assert.equal(transformShopInventoryItem({ ...asset, content: { json_uri: uri } }, 'devnet'), null, uri);
  }
  assert.equal(preorderIdFromMetadataUri(config, 'https://evil.example/preorder/json/1.json'), null);
});

test('both preorder collections are public while other devnet inventory stays hidden', () => {
  const publicDevnet = listShopInventoryCollectionScopes(false).filter((scope) => scope.solanaCluster === 'devnet');
  assert.deepEqual(publicDevnet, [{ solanaCluster: 'devnet', collectionMint: config.collection }]);
  const mainnet = getPreorderConfig('mi_note_cards')!;
  assert.equal(mainnet.enabled, true);
  assert.equal(mainnet.unitPriceLamports, 250_000_000);
  assert.equal(config.unitPriceLamports, mainnet.unitPriceLamports);
  assert.equal(listShopInventoryCollectionScopes(false).some((scope) => scope.collectionMint === mainnet.collection), true);
  const mainnetItem = transformShopInventoryItem({ ...asset, grouping: [{ group_key: 'collection', group_value: mainnet.collection }] }, 'mainnet-beta');
  assert.equal(mainnetItem?.dropId, mainnet.preorderId);
  assert.equal(isExactShopInventoryResponse({ ok: true, items: [mainnetItem] }), true);
});

test('preorder inventory cannot be mistaken for redeemable cards', () => {
  const item = transformShopInventoryItem(asset, 'devnet')!;
  assert.equal(canDeliverItemKind(undefined, 'preorder'), false);
  assert.equal(canDeliverItemKind('card_nft_2', 'preorder'), false);
  for (const invalid of [
    { ...item, preorderId: undefined }, { ...item, preorderId: 1396 },
    { ...item, dudeId: 1 }, { ...item, boxId: '1' },
    { ...item, dropId: 'card_nft_2' }, { ...item, kind: 'dude' },
  ]) assert.equal(isExactShopInventoryResponse({ ok: true, items: [invalid] }), false);
});
