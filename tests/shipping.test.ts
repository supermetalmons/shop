import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDeliveryLamports,
  isDirectDeliveryItemsPerBox,
  normalizeDeliveryUnitsPerBox,
} from '../src/lib/shipping.ts';
import {
  countDeliveryFigures,
  normalizeDeliveryUnitsPerBox as normalizeDeliveryUnitsPerBoxShared,
} from '../functions/src/shared/shipping.ts';

const dude = { kind: 'dude' as const };
const box = { kind: 'box' as const };
const certificate = { kind: 'certificate' as const };

test('card_nft_2 delivery charges 0.2 SOL in the US up to three cards plus 0.06 SOL per extra card', () => {
  assert.equal(calculateDeliveryLamports([dude], 'US', 3, 'card_nft_2'), 200_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude], 'US', 3, 'card_nft_2'), 200_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude, dude], 'US', 3, 'card_nft_2'), 260_000_000);
  assert.equal(calculateDeliveryLamports([box, dude], 'US', 3, 'card_nft_2'), 260_000_000);
});

test('card_nft_2 delivery charges 0.4 SOL internationally up to three cards plus 0.06 SOL per extra card', () => {
  assert.equal(calculateDeliveryLamports([dude], 'CA', 3, 'card_nft_2'), 400_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude], 'GB', 3, 'card_nft_2'), 400_000_000);
  assert.equal(calculateDeliveryLamports([dude, dude, dude, dude], 'TR', 3, 'card_nft_2'), 460_000_000);
  assert.equal(calculateDeliveryLamports([box, dude], 'INTL', 3, 'card_nft_2'), 460_000_000);
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
    Number.isNaN(normalizeDeliveryUnitsPerBoxShared(Number.NaN, 'arithmetic')),
    true,
  );
  assert.equal(
    normalizeDeliveryUnitsPerBoxShared(Number.POSITIVE_INFINITY, 'arithmetic'),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(
    normalizeDeliveryUnitsPerBoxShared(Number.NEGATIVE_INFINITY, 'arithmetic'),
    1,
  );
  assert.equal(normalizeDeliveryUnitsPerBoxShared(2.9, 'arithmetic'), 2);
  assert.equal(normalizeDeliveryUnitsPerBoxShared(0, 'arithmetic'), 1);
});
