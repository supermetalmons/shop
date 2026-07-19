import test from 'node:test';
import assert from 'node:assert/strict';
import {
  heliusSearchAssetsHasNextPage,
  heliusSearchAssetsItems,
} from '../functions/src/shared/heliusDas.ts';

test('Helius search result helpers preserve pagination fallbacks and total handling', () => {
  assert.deepEqual(heliusSearchAssetsItems(null), []);
  assert.deepEqual(heliusSearchAssetsItems({ items: 'invalid' }), []);
  assert.deepEqual(heliusSearchAssetsItems({ items: [1, 2] }), [1, 2]);

  assert.equal(heliusSearchAssetsHasNextPage({}, 1, [], 1000), false);
  assert.equal(heliusSearchAssetsHasNextPage({}, 1, [1], 1000), false);
  assert.equal(
    heliusSearchAssetsHasNextPage(
      { limit: 2, total: 5, page: 1 },
      9,
      [1, 2],
      1000,
    ),
    true,
  );
  assert.equal(
    heliusSearchAssetsHasNextPage(
      { limit: 2, total: 4, page: 2 },
      1,
      [1, 2],
      1000,
    ),
    false,
  );
  assert.equal(
    heliusSearchAssetsHasNextPage(
      { limit: 'invalid' },
      1,
      Array.from({ length: 3 }),
      3,
    ),
    true,
  );

  const cappedFullPage = Array.from({ length: 1000 });
  assert.equal(
    heliusSearchAssetsHasNextPage(
      { limit: 1000, total: 1000, page: 1 },
      1,
      cappedFullPage,
      1000,
    ),
    false,
  );
  assert.equal(
    heliusSearchAssetsHasNextPage(
      { limit: 1000, total: 1000, page: 1 },
      1,
      cappedFullPage,
      1000,
      { totalPolicy: 'ignore' },
    ),
    true,
  );
  assert.equal(
    heliusSearchAssetsHasNextPage(
      { limit: 1000, total: 1000, page: 1 },
      1,
      Array.from({ length: 768 }),
      1000,
      { totalPolicy: 'ignore' },
    ),
    false,
  );
});
