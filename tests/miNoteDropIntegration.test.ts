import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPLOYMENT_DROPS } from '../shared/deploymentRegistry.ts';
import { getPreorderConfig, preorderMetadataUri } from '../shared/preorders.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';

const drop = miNoteDropFixture();
DEPLOYMENT_DROPS[drop.dropId] = drop;
const { listShopPendingOpenProgramScopes, resolvePendingOpenDropId, transformShopInventoryItem } = await import('../shared/shopDomain.ts');
const { resolveAppRoute } = await import('../src/routes.ts');
const { FRONTEND_DROPS } = await import('../src/config/deployment.ts');
const { normalizeBoxDisplayImage, normalizeCertificateDisplayImage, normalizeFigureDisplayImage,
  mintPanelPreviewImage, resolveDropContent } = await import('../src/lib/dropContent.ts');
const preorder = getPreorderConfig(drop.dropId)!;

function asset(uri: string) {
  return {
    id: 'asset-address', interface: 'MplCoreAsset', burnt: false,
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: { json_uri: uri },
  };
}

test('one registered devnet drop activates only its own route and preserves the mainnet announcement', () => {
  const mainnet = resolveAppRoute({ pathname: '/mi_note_cards' });
  assert.equal(mainnet.kind, 'upcoming');
  assert.equal(mainnet.walletCluster, 'mainnet-beta');
  assert.equal(mainnet.preorderId, null);
  for (const pathname of ['/mi_note_cards_devnet', '/mi_note_cards_devnet/']) {
    const route = resolveAppRoute({ pathname });
    assert.equal(route.kind, 'drop');
    assert.equal(route.walletCluster, 'devnet');
    assert.equal(route.drop?.dropId, drop.dropId);
    assert.equal(route.drop?.itemsPerBox, 2);
    assert.equal(route.drop?.maxSupply, 704);
    assert.equal(route.preorderId, null);
  }
});

test('a shared Mi Note collection distinguishes unchanged preorders, cards, packs, and receipts', () => {
  assert.equal(transformShopInventoryItem(asset(preorderMetadataUri(preorder, 1)), 'devnet')?.kind, 'preorder');
  for (const [file, kind, name, idField, id] of [
    ['b628', 'box', 'Pack #628', 'boxId', '628'],
    ['b704', 'box', 'Pack #704', 'boxId', '704'],
    ['f1401', 'dude', 'Card #1401', 'dudeId', 1401],
    ['f1430', 'dude', 'Card #1430', 'dudeId', 1430],
    ['rb704', 'certificate', 'Pack #704 Receipt', 'boxId', '704'],
    ['rf1430', 'certificate', 'Card #1430 Receipt', 'dudeId', 1430],
  ] as const) {
    const item = transformShopInventoryItem(asset(`${drop.metadataBase}/${file}.json`), 'devnet');
    assert.ok(item);
    assert.equal(item.dropId, drop.dropId);
    assert.equal(item.kind, kind);
    assert.equal(item.name, name);
    assert.equal(item[idField], id);
  }
});

test('shared-collection regular metadata never admits malformed preorder or noncanonical drop URIs', () => {
  for (const suffix of ['0.json', '01.json', '1401.json', '1431.json', 'f1.json', 'b1.json', 'rb1.json', 'rf1.json',
    '1.json?x=1', '1.json#x', '../1.json']) {
    assert.equal(transformShopInventoryItem(asset(`${preorder.metadataBase}${suffix}`), 'devnet'), null, suffix);
  }
  for (const suffix of ['b0.json', 'b01.json', 'b705.json', 'rb705.json', 'f1431.json', 'rf1431.json',
    'b1.json?x=1', 'f1.json#x', 'B1.json', 'f1.0.json', '../f1.json', 'f9007199254740992.json']) {
    assert.equal(transformShopInventoryItem(asset(`${drop.metadataBase}/${suffix}`), 'devnet'), null, suffix);
  }
  assert.equal(transformShopInventoryItem(asset('https://example.com/b1.json'), 'devnet'), null);
  assert.equal(transformShopInventoryItem(asset(`${drop.metadataBase}/b1.json`), 'mainnet-beta'), null);
  assert.equal(transformShopInventoryItem(asset(`${drop.metadataBase}/b1.json`)), null);
  assert.equal(transformShopInventoryItem({ ...asset(preorderMetadataUri(preorder, 1)), interface: 'V1_NFT' }, 'devnet'), null);
});

test('pending opens from operations config B resolve to the logical drop and mint config A is rejected', () => {
  const scope = listShopPendingOpenProgramScopes(true).find(scope => scope.solanaCluster === 'devnet' &&
    scope.boxMinterProgramId === drop.boxMinterProgramId)!;
  const pending = {
    solanaCluster: 'devnet' as const, pendingPda: 'pending', boxAssetId: 'pack',
    dudeAssetIds: ['first-card', 'second-card'], candidateDrops: scope.drops,
    configPda: drop.operationsConfig!.boxMinterConfigPda,
  };
  assert.equal(resolvePendingOpenDropId(pending), drop.dropId);
  assert.equal(resolvePendingOpenDropId({ ...pending, configPda: drop.boxMinterConfigPda }), null);
  assert.equal(resolvePendingOpenDropId({ ...pending, dudeAssetIds: ['one-card'] }), null);
});

test('Mi Note media stays usable without pack JSONs above 627 and preserves PNG card images', () => {
  assert.deepEqual(FRONTEND_DROPS[drop.dropId].boxMedia, { strategy: 'cyclic', count: 9 });
  for (const [id, variant] of [[1, 1], [9, 9], [10, 1], [627, 6], [628, 7], [704, 2]]) {
    assert.equal(normalizeBoxDisplayImage({ dropId: drop.dropId, boxId: id }),
      `https://cdn.lil.org/nft/mi_note_cards/packs/${variant}.webp`);
    assert.equal(normalizeCertificateDisplayImage({ dropId: drop.dropId, boxId: id }),
      `https://cdn.lil.org/nft/mi_note_cards/receipts/packs/${variant}.webp`);
  }
  for (const id of [1, 1401, 1430]) {
    assert.equal(normalizeFigureDisplayImage(drop.dropId, undefined, id),
      `https://cdn.lil.org/nft/mi_note_cards/clean/${id}.png`);
    assert.equal(normalizeCertificateDisplayImage({ dropId: drop.dropId, figureId: id }),
      `https://cdn.lil.org/nft/mi_note_cards/receipts/cards/${id}.webp`);
  }
  assert.equal(mintPanelPreviewImage(drop.dropId), 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/1.webp');
  const content = resolveDropContent(drop.dropId);
  assert.equal(content.reveal.mode, 'static');
  assert.equal(content.reveal.renderer, 'default');
  assert.equal(content.figures.revealPresentation, 'metadata_stills');
});
