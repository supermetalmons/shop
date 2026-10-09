import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPLOYMENT_DROPS } from '../shared/deploymentRegistry.ts';
import { getPreorderConfig, preorderMetadataUri } from '../shared/preorders.ts';
import { preorderCardMetadata, resolveClaimedPreorderAsset } from '../shared/preorderAssetIdentity.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const publicDrop = DEPLOYMENT_DROPS[config.preorderId];
const claim = { id: 1, address: 'claimed-asset' };
const original = { address: claim.address, collection: config.collection,
  name: 'Preorder #1', uri: preorderMetadataUri(config, 1) };
const target = { ...original, name: 'card 1', uri: 'https://cdn.lil.org/nft/mi_note_cards/json/pre/f1.json' };
const resolve = (actual = target) => resolveClaimedPreorderAsset({ config, cluster: config.cluster, claim, actual, publicDrop });

test('ledger-bound preorder identity recognizes exact original and converted metadata for the same card', () => {
  assert.deepEqual(preorderCardMetadata({ config, publicDrop, id: 1 }), { name: target.name, uri: target.uri });
  assert.deepEqual(resolve(original), { kind: 'preorder', id: 1 });
  assert.deepEqual(resolve(), { kind: 'dude', id: 1 });
  assert.deepEqual(resolveClaimedPreorderAsset({ config, cluster: config.cluster, claim, actual: original }), { kind: 'preorder', id: 1 });
  assert.equal(resolveClaimedPreorderAsset({ config, cluster: config.cluster, claim, actual: target }), null);
});

test('converted identity rejects mismatched IDs, names, URIs, addresses, collections and clusters', () => {
  for (const changed of [{ name: 'Card #1' }, { name: 'card 2' }, { uri: target.uri.replace('f1', 'f2') },
    { uri: `${target.uri}?x=1` }, { uri: target.uri.replace('f1', 'f01') }, { address: 'other-asset' }, { collection: 'other-collection' }]) {
    assert.equal(resolve({ ...target, ...changed }), null);
  }
  assert.equal(resolveClaimedPreorderAsset({ config, cluster: 'mainnet-beta', claim, actual: target, publicDrop }), null);
  assert.equal(resolveClaimedPreorderAsset({ config, cluster: config.cluster, claim: { ...claim, id: 2 }, actual: target, publicDrop }), null);
});

test('conversion requires the matching frozen public drop and permanently excluded preorder card', () => {
  for (const changed of [{ dropId: 'another-drop' }, { dropFamily: 'card_nft_2' as const }, { solanaCluster: 'mainnet-beta' as const },
    { collectionMint: 'another-collection' }, { inventoryManifest: undefined }, { operationsConfig: undefined },
    { figureNamePrefix: ' card' }, { metadataPathFormat: undefined }]) {
    assert.equal(preorderCardMetadata({ config, publicDrop: { ...publicDrop, ...changed }, id: 1 }), null);
  }
  assert.equal(preorderCardMetadata({ config, publicDrop, id: publicDrop.inventoryManifest!.cardIds[0] }), null);
  assert.equal(preorderCardMetadata({ config, publicDrop, id: 1431 }), null);
});
