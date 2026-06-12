import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDeliveryLamports } from '../src/lib/shipping.ts';

const dude = { kind: 'dude' as const };
const box = { kind: 'box' as const };

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
