import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDropConfigRole } from '../shared/dropConfigRoles.ts';
import { resolveDropMaxFigureId } from '../shared/dropFigureIds.ts';
import { resolveDropInventoryManifest } from '../shared/dropInventoryManifest.ts';

const drop = {
  dropId: 'mi_note_cards_devnet',
  boxMinterConfigPda: 'mint-config',
  maxSupply: 704,
  itemsPerBox: 2,
  operationsConfig: {
    configId: 'mi_note_cards_devnet_operations',
    boxMinterConfigPda: 'operations-config',
    maxSupply: 715,
  },
};

test('dual config roles preserve logical pack supply and isolate opening', () => {
  assert.deepEqual(resolveDropConfigRole(drop, 'mint'), {
    configId: drop.dropId,
    boxMinterConfigPda: 'mint-config',
    maxSupply: 704,
    itemsPerBox: 0,
  });
  assert.deepEqual(resolveDropConfigRole(drop, 'operations'), {
    ...drop.operationsConfig,
    itemsPerBox: 2,
  });
  assert.equal(resolveDropMaxFigureId(drop), 1430);
  assert.equal(drop.itemsPerBox, 2);
});

test('single config and direct delivery retain their existing behavior', () => {
  for (const itemsPerBox of [0, 1, 2, 3, 5]) {
    const legacy = { dropId: 'existing', boxMinterConfigPda: 'existing-config', maxSupply: 20, itemsPerBox };
    assert.deepEqual(resolveDropConfigRole(legacy, 'mint'), resolveDropConfigRole(legacy, 'operations'));
    assert.equal(resolveDropMaxFigureId(legacy), 20 * itemsPerBox);
  }
});

test('mainnet roles keep a 627 pack cap while allowing original card IDs', () => {
  const mainnet = { ...drop, maxSupply: 627 };
  assert.equal(resolveDropConfigRole(mainnet, 'mint').maxSupply, 627);
  assert.equal(resolveDropConfigRole(mainnet, 'operations').maxSupply, 715);
  assert.equal(resolveDropMaxFigureId(mainnet), 1430);
});

test('inventory size uses logical supply rather than operations capacity', () => {
  const small = { ...drop, maxSupply: 2, operationsConfig: { ...drop.operationsConfig, maxSupply: 715 } };
  const inventoryManifest = { sha256: 'a'.repeat(64), cardIds: [3, 13, 1409, 1430] };
  assert.equal(resolveDropInventoryManifest({ ...small, inventoryManifest }), inventoryManifest);
  for (const cardIds of [[1, 2], [3, 13, 13, 1430], [3, 13, 1409, 1431]]) {
    assert.throws(() => resolveDropInventoryManifest({ ...small, inventoryManifest: { ...inventoryManifest, cardIds } }));
  }
  assert.throws(() => resolveDropMaxFigureId({ ...drop, operationsConfig: { maxSupply: 703 } }));
});
