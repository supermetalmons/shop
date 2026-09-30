import assert from 'node:assert/strict';
import test from 'node:test';
import miNoteCatalog from '../mi_note_cards.json';
import { MI_NOTE_CONTRACT_ADDRESSES } from '../shared/miNoteCards.ts';
import { isPreorderCardId, PREORDER_CARD_COUNT } from '../shared/preorders.ts';

const ethereumCardIds = miNoteCatalog.ethereumCollections.flatMap(({ tokens }) => tokens.map(({ clean_card_id }) => clean_card_id));

test('the Ethereum catalog contains exactly the cards supported for preorder', () => {
  assert.deepEqual(
    miNoteCatalog.ethereumCollections.map(({ contractAddress }) => contractAddress).sort(),
    [...MI_NOTE_CONTRACT_ADDRESSES].sort(),
  );
  assert.equal(PREORDER_CARD_COUNT, 1405);
  assert.deepEqual([...ethereumCardIds].sort((left, right) => left - right), [
    ...Array.from({ length: 1400 }, (_, index) => index + 1), 1409, 1410, 1411, 1412, 1413,
  ]);
  assert.ok(ethereumCardIds.every(isPreorderCardId));
});

test('preorder IDs include new Ethereum cards while excluding specials and invalid IDs', () => {
  for (const id of [1, 1400, 1409, 1410, 1411, 1412, 1413]) assert.equal(isPreorderCardId(id), true);
  for (const id of [0, 1401, 1402, 1403, 1404, 1405, 1406, 1407, 1408, 1414, 1409.5, '1409', NaN, Infinity]) {
    assert.equal(isPreorderCardId(id), false, String(id));
  }
});

test('standalone special cards retain their reserved IDs and names without preorder eligibility', () => {
  assert.deepEqual(miNoteCatalog.specialCards, [
    { clean_card_id: 1401, name: 'Drifella’s Sharp Bite' },
    { clean_card_id: 1402, name: 'Emo Red Drifella' },
    { clean_card_id: 1403, name: 'Drifella’s Rainy Day' },
    { clean_card_id: 1404, name: 'Drifella the Pink Angel' },
    { clean_card_id: 1405, name: 'Blue Drifella Hat on Monday' },
    { clean_card_id: 1406, name: 'Drifella’s Little Bandage' },
    { clean_card_id: 1407, name: 'Slumber Black Drifella' },
    { clean_card_id: 1408, name: 'Drifella the Reaper' },
  ]);
  for (const { clean_card_id } of miNoteCatalog.specialCards) assert.equal(isPreorderCardId(clean_card_id), false);
});

test('card IDs are unique across Ethereum collections and standalone specials', () => {
  const cardIds = [...ethereumCardIds, ...miNoteCatalog.specialCards.map(({ clean_card_id }) => clean_card_id)];
  assert.equal(new Set(cardIds).size, cardIds.length);
  assert.ok(cardIds.every((id) => Number.isSafeInteger(id) && id > 0));
});
