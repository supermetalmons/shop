import test from 'node:test';
import assert from 'node:assert/strict';
import { LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL } from '../src/config/dropMediaDefaults.ts';
import { cardNft2AssetUrl } from '../src/lib/cardNft2Assets.ts';
import { getCachedFigureMetadata, loadFigureMetadata } from '../src/lib/figureMetadata.ts';

test('card_nft_2 figure metadata resolves from derived CDN image without fetching json', async () => {
  const originalFetch = globalThis.fetch;
  const calls: unknown[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input);
    throw new Error('unexpected metadata fetch');
  }) as typeof fetch;

  try {
    const record = await loadFigureMetadata('card_nft_2', 2);

    assert.deepEqual(record, {
      id: 2,
      dropId: 'card_nft_2',
      image: cardNft2AssetUrl('img', 2),
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(getCachedFigureMetadata('card_nft_2', 2), record);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('little_swag_boxes figure metadata resolves from derived CDN image without fetching json', async () => {
  const originalFetch = globalThis.fetch;
  const calls: unknown[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input);
    throw new Error('unexpected metadata fetch');
  }) as typeof fetch;

  try {
    const record = await loadFigureMetadata('little_swag_boxes', 504);

    assert.deepEqual(record, {
      id: 504,
      dropId: 'little_swag_boxes',
      image: `${LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL}/171.webp`,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(getCachedFigureMetadata('little_swag_boxes', 504), record);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
