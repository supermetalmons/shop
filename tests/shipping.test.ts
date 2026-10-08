import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDeliveryLamports,
  canDeliverItemKind,
  countDeliveryFigures,
  isDirectDeliveryItemsPerBox,
  normalizeDeliveryUnitsPerBox,
} from '../shared/shipping.ts';

const dude = { kind: 'dude' as const };
const box = { kind: 'box' as const };
const certificate = { kind: 'certificate' as const };

test('clear cards delivery accepts unpacked cards but rejects packs', () => {
  assert.equal(canDeliverItemKind('clear_cards', 'dude'), true);
  assert.equal(canDeliverItemKind('clear_cards', 'box'), false);
  assert.equal(canDeliverItemKind('clear_cards', 'certificate'), false);
  assert.equal(canDeliverItemKind('card_nft_2', 'box'), true);
  assert.equal(canDeliverItemKind('poncho_drifella', 'dude'), true);
});

test('card_nft_2 delivery charges 0.12 SOL in the US up to three cards plus 0.03 SOL per extra card', () => {
  assert.equal(calculateDeliveryLamports([dude], 'US', 3, 'card_nft_2'), 120_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude], 'US', 3, 'card_nft_2'), 120_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude, dude], 'US', 3, 'card_nft_2'), 150_000_000);
  assert.equal(calculateDeliveryLamports([box, dude], 'US', 3, 'card_nft_2'), 150_000_000);
});

test('card_nft_2 delivery charges 0.24 SOL internationally up to three cards plus 0.03 SOL per extra card', () => {
  assert.equal(calculateDeliveryLamports([dude], 'CA', 3, 'card_nft_2'), 240_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude], 'GB', 3, 'card_nft_2'), 240_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude, dude], 'TR', 3, 'card_nft_2'), 270_000_000);
  assert.equal(calculateDeliveryLamports([box, dude], 'INTL', 3, 'card_nft_2'), 270_000_000);
});

test('clear_cards delivery uses the card_nft_2 redeem fees', () => {
  assert.equal(calculateDeliveryLamports([dude], 'US', 1, 'clear_cards'), 120_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude], 'US', 1, 'clear_cards'), 120_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude, dude], 'US', 1, 'clear_cards'), 150_000_000);
  assert.equal(calculateDeliveryLamports([dude], 'TR', 1, 'clear_cards'), 240_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude], 'TR', 1, 'clear_cards'), 240_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude, dude], 'TR', 1, 'clear_cards'), 270_000_000);
});

test('mi_note_cards delivery includes two cards and charges 0.03 SOL per extra card', () => {
  for (const [country, baseLamports] of [['US', 120_000_000], ['TR', 240_000_000]] as const) {
    assert.equal(calculateDeliveryLamports([], country, 2, 'mi_note_cards'), 0);
    assert.equal(calculateDeliveryLamports([dude], country, 2, 'mi_note_cards'), baseLamports);
    assert.equal(calculateDeliveryLamports([dude, dude], country, 2, 'mi_note_cards'), baseLamports);
    assert.equal(calculateDeliveryLamports([dude, dude, dude], country, 2, 'mi_note_cards'), baseLamports + 30_000_000);
    assert.equal(calculateDeliveryLamports([box], country, 2, 'mi_note_cards'), baseLamports);
    assert.equal(calculateDeliveryLamports([box, dude], country, 2, 'mi_note_cards'), baseLamports + 30_000_000);
    assert.equal(calculateDeliveryLamports([box, box], country, 2, 'mi_note_cards'), baseLamports + 60_000_000);
    assert.equal(calculateDeliveryLamports([dude, dude, dude], country, undefined, 'mi_note_cards'), baseLamports + 30_000_000);
  }
});

test('drifella_shirt delivery is flat at 0.1 SOL in the US and 0.25 SOL internationally', () => {
  assert.equal(calculateDeliveryLamports([box], 'US', 0, 'drifella_shirt'), 100_000_000);
  assert.equal(calculateDeliveryLamports([box, box, box], 'US', 0, 'drifella_shirt'), 100_000_000);
  assert.equal(calculateDeliveryLamports([box], 'CA', 0, 'drifella_shirt'), 250_000_000);
  assert.equal(calculateDeliveryLamports([box, box, box], 'TR', 0, 'drifella_shirt'), 250_000_000);
  assert.equal(calculateDeliveryLamports([], 'US', 0, 'drifella_shirt'), 0);
  assert.equal(calculateDeliveryLamports([], 'TR', 0, 'drifella_shirt'), 0);
});

test('delivery formulas preserve every drop-family pricing branch', () => {
  assert.equal(calculateDeliveryLamports([box], 'US', 3, 'little_swag_boxes'), 100_000_000);
  assert.equal(calculateDeliveryLamports([box, dude], 'US', 3, 'little_swag_boxes'), 125_000_000);
  assert.equal(calculateDeliveryLamports([dude], 'US', 1, 'poncho_drifella'), 50_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude], 'US', 1, 'poncho_drifella'), 50_000_000);
  assert.equal(calculateDeliveryLamports([dude], 'US', 1, 'little_swag_hoodies'), 0);
  assert.equal(calculateDeliveryLamports([dude], 'TR', 1, 'little_swag_hoodies'), 600_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude], 'TR', 1, 'little_swag_hoodies'), 1_100_000_000);
  assert.equal(calculateDeliveryLamports([box, dude], 'TR', 3, 'default'), 300_000_000);
  assert.equal(calculateDeliveryLamports([], 'TR', 3, 'default'), 0);
});

test('direct delivery, certificate counting, and invalid-input policies remain explicit', () => {
  assert.equal(calculateDeliveryLamports([box], 'US', 0, 'poncho_drifella'), 0);
  assert.equal(countDeliveryFigures([box, certificate], 3), 4);

  assert.equal(normalizeDeliveryUnitsPerBox(undefined), 1);
  assert.equal(normalizeDeliveryUnitsPerBox(Number.NaN), 1);
  assert.equal(normalizeDeliveryUnitsPerBox(Number.POSITIVE_INFINITY), 1);
  assert.equal(normalizeDeliveryUnitsPerBox(Number.NEGATIVE_INFINITY), 1);
  assert.equal(normalizeDeliveryUnitsPerBox(2.9), 2);
  assert.equal(normalizeDeliveryUnitsPerBox(0), 1);
  assert.equal(isDirectDeliveryItemsPerBox(0), true);
  assert.equal(isDirectDeliveryItemsPerBox(0.9), true);

  assert.equal(
    Number.isNaN(normalizeDeliveryUnitsPerBox(Number.NaN, 'arithmetic')),
    true,
  );
  assert.equal(
    normalizeDeliveryUnitsPerBox(Number.POSITIVE_INFINITY, 'arithmetic'),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(
    normalizeDeliveryUnitsPerBox(Number.NEGATIVE_INFINITY, 'arithmetic'),
    1,
  );
  assert.equal(normalizeDeliveryUnitsPerBox(2.9, 'arithmetic'), 2);
  assert.equal(normalizeDeliveryUnitsPerBox(0, 'arithmetic'), 1);
});
