import assert from 'node:assert/strict';
import test from 'node:test';
import miNoteCatalog from '../mi_note_cards.json';
import { MI_NOTE_3_CONTRACT_ADDRESS, MI_NOTE_CONTRACT_ADDRESSES } from '../shared/miNoteCards.ts';
import { isPreorderCardId, PREORDER_CARD_COUNT } from '../shared/preorders.ts';

const ethereumCardIds = miNoteCatalog.ethereumCollections.flatMap(({ tokens }) => tokens.map(({ clean_card_id }) => clean_card_id));

test('the Ethereum catalog contains exactly the cards supported for preorder', () => {
  assert.deepEqual(
    miNoteCatalog.ethereumCollections.map(({ contractAddress }) => contractAddress).sort(),
    [...MI_NOTE_CONTRACT_ADDRESSES].sort(),
  );
  assert.equal(PREORDER_CARD_COUNT, 1422);
  assert.deepEqual([...ethereumCardIds].sort((left, right) => left - right), [
    ...Array.from({ length: 1400 }, (_, index) => index + 1),
    ...Array.from({ length: 22 }, (_, index) => index + 1409),
  ]);
  assert.ok(ethereumCardIds.every(isPreorderCardId));
});

test('preorder IDs include new Ethereum cards while excluding specials and invalid IDs', () => {
  for (const id of [1, 1400, ...Array.from({ length: 22 }, (_, index) => index + 1409)]) assert.equal(isPreorderCardId(id), true);
  for (const id of [0, 1401, 1402, 1403, 1404, 1405, 1406, 1407, 1408, 1431, 1409.5, '1409', NaN, Infinity]) {
    assert.equal(isPreorderCardId(id), false, String(id));
  }
});

test('new Mi Note 3 cards preserve their token identities, artwork names, and image URLs', () => {
  const cards = miNoteCatalog.ethereumCollections.find(({ contractAddress }) => contractAddress === MI_NOTE_3_CONTRACT_ADDRESS)!.tokens;
  assert.deepEqual(cards.filter(({ clean_card_id }) => clean_card_id >= 1414), [
    { id: '135', clean_card_id: 1414, name: 'Drifella of Death 999' },
    { id: '136', clean_card_id: 1415, name: 'SHADOW SAINT 5555' },
    { id: '137', clean_card_id: 1416, name: 'Lost Angel' },
    { id: '139', clean_card_id: 1417, name: 'Drifella Employee 333' },
    { id: '140', clean_card_id: 1418, name: 'Drifella Employee 444' },
    { id: '141', clean_card_id: 1419, name: 'Drifella Employee 555' },
    { id: '142', clean_card_id: 1420, name: 'Drifella Employee 666' },
    { id: '143', clean_card_id: 1421, name: 'Stuck in the Buffer' },
    { id: '144', clean_card_id: 1422, name: 'The Fallen Cat-Angel' },
    { id: '145', clean_card_id: 1423, name: 'The Gentle Harvest of the Poliwhirl Reaper' },
    { id: '146', clean_card_id: 1424, name: 'Dratini Niqab☆The Scream' },
    { id: '147', clean_card_id: 1425, name: 'Pika Niqab☆The Scream' },
    { id: '148', clean_card_id: 1426, name: 'Smiling Earth Silent Girl' },
    { id: '149', clean_card_id: 1427, name: 'Mi Note Silent Magician I' },
    { id: '150', clean_card_id: 1428, name: 'Mi Note Silent Magician II' },
    { id: '151', clean_card_id: 1429, name: 'The Reaper in a Umbreon Cloak' },
    { id: '152', clean_card_id: 1430, name: 'The Reaper in a Meowth Cloak' },
  ].map((card) => ({ ...card,
    original: `https://cdn.lil.org/player/mi_note_3/${card.id}.jpg`,
    mid: `https://cdn.lil.org/player/mi_note_3/mid/${card.id}.webp`,
  })));
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
