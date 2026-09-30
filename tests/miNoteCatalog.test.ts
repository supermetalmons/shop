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
  assert.deepEqual([...ethereumCardIds].sort((left, right) => left - right),
    Array.from({ length: PREORDER_CARD_COUNT }, (_, index) => index + 1));
  assert.ok(ethereumCardIds.every(isPreorderCardId));
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
