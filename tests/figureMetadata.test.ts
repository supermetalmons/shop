import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';
import { cardNft2AssetUrl } from '../shared/cardNft2Assets.ts';
import { getCachedFigureMetadata, loadFigureMetadata } from '../src/lib/figureMetadata.ts';

for (const dropId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${dropId} card images resolve and cache without metadata JSON`, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('unexpected metadata fetch');
    });
    for (const figureId of [1, 9, 1401, 1430]) {
      const record = await loadFigureMetadata(dropId, figureId);
      assert.deepEqual(record, {
        id: figureId,
        dropId,
        image: `https://cdn.lil.org/nft/mi_note_cards/clean/${figureId}.webp`,
      });
      assert.deepEqual(getCachedFigureMetadata(dropId, figureId), record);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

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

test('clear_cards figure metadata resolves from the direct clean card asset without fetching json', async () => {
  const originalFetch = globalThis.fetch;
  const calls: unknown[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input);
    throw new Error('unexpected metadata fetch');
  }) as typeof fetch;

  try {
    const record = await loadFigureMetadata('clear_cards_devnet_v2', 192);

    assert.deepEqual(record, {
      id: 192,
      dropId: 'clear_cards_devnet_v2',
      image: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/192.webp`,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(getCachedFigureMetadata('clear_cards_devnet_v2', 192), record);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
