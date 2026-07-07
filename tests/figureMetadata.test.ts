import test from 'node:test';
import assert from 'node:assert/strict';
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
