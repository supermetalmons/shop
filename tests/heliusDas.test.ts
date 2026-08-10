import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HELIUS_SEARCH_ASSETS_MAX_CURSOR_BYTES,
  heliusSearchAssetsCursorPageInfo,
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

test('cursor pagination ignores changing totals and continues every nonempty page', () => {
  const first = heliusSearchAssetsCursorPageInfo(
    { items: [{}], cursor: 'cursor-one', page: 99, total: 1, grand_total: 500, last_indexed_slot: 10 },
    1,
    250,
  );
  assert.deepEqual(first, { hasMore: true, cursor: 'cursor-one' });
  const seen = new Set(['cursor-one']);
  const second = heliusSearchAssetsCursorPageInfo(
    { items: [{}], cursor: 'cursor-two', page: 1, limit: 250, total: 20, grand_total: 0 },
    1,
    250,
    seen,
  );
  assert.deepEqual(second, { hasMore: true, cursor: 'cursor-two' });
  assert.deepEqual(
    heliusSearchAssetsCursorPageInfo({ items: [], total: 30 }, 0, 250, seen),
    { hasMore: false },
  );
});

test('cursor pagination rejects missing, repeated, cyclic, oversized, and impossible pages', () => {
  const seen = new Set(['cursor-one', 'cursor-two']);
  for (const result of [
    {},
    { items: 'invalid' },
    { items: [{}] },
    { items: [{}], cursor: '' },
    { items: [{}], cursor: 'cursor-two' },
    { items: [{}], cursor: 'x'.repeat(HELIUS_SEARCH_ASSETS_MAX_CURSOR_BYTES + 1) },
    { items: [{}], cursor: 'é'.repeat(HELIUS_SEARCH_ASSETS_MAX_CURSOR_BYTES) },
    { items: [{}], cursor: 'next', limit: 0 },
    { items: [{}], cursor: 'next', limit: 251 },
    { items: [{}], cursor: 'next', total: -1 },
    { items: [{}], cursor: 'next', grand_total: 1.5 },
    { items: [{}], cursor: 'next', last_indexed_slot: '10' },
  ]) {
    assert.throws(
      () => heliusSearchAssetsCursorPageInfo(result, 1, 250, seen),
      /invalid-helius-pagination/,
    );
  }
  assert.throws(
    () => heliusSearchAssetsCursorPageInfo({ items: Array.from({ length: 251 }), cursor: 'next' }, 251, 250, seen),
    /invalid-helius-pagination/,
  );
  assert.throws(
    () => heliusSearchAssetsCursorPageInfo({ items: [{}, {}], cursor: 'next', limit: 1 }, 2, 250, seen),
    /invalid-helius-pagination/,
  );
  assert.throws(
    () => heliusSearchAssetsCursorPageInfo({ items: [], cursor: 'next' }, 0, 0, seen),
    /invalid-helius-pagination/,
  );
});
