import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDropSizeGuide } from '../src/lib/dropSizeGuide.ts';

test('resolves the Drifella shirt size guide with only the available sizes', () => {
  const guide = resolveDropSizeGuide('drifella_shirt_devnet');

  assert.equal(guide?.selectionAriaLabel, 'Shirt size');
  assert.deepEqual(guide?.rows, [
    { size: 'L', bodyLength: '27 3/8', chestWidth: '22 7/8', sleeveLength: '9' },
    { size: 'XL', bodyLength: '28 3/8', chestWidth: '24 7/8', sleeveLength: '9 1/4' },
    { size: '2XL', bodyLength: '29 3/8', chestWidth: '26 7/8', sleeveLength: '9 1/2' },
  ]);
});

test('keeps the Little Swag Hoodies size guide unchanged', () => {
  const guide = resolveDropSizeGuide('little_swag_hoodies');

  assert.equal(guide?.selectionAriaLabel, 'Hoodie size');
  assert.deepEqual(guide?.rows.map((row) => row.size), ['L', 'XL', '2XL']);
  assert.equal(guide?.rows[0]?.bodyLength, '28 1/2');
});

test('does not expose a size guide for unrelated drops', () => {
  assert.equal(resolveDropSizeGuide('card_nft_2'), null);
});
