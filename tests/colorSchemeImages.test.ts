import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL,
  CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
  CLEAR_CARDS_RECEIPT_IMAGE_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';
import { resolveColorSchemeImageSources } from '../src/lib/colorSchemeImages.ts';

test('clear cards clean images resolve to matching light and dark sources', () => {
  assert.deepEqual(
    resolveColorSchemeImageSources(
      'clear_cards_devnet_v2',
      `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`,
    ),
    {
      lightSrc: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`,
      darkSrc: `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/167.webp`,
    },
  );
});

test('clear cards dark images normalize to the same source pair and preserve suffixes', () => {
  const suffix = '167.webp?v=2#card';
  assert.deepEqual(
    resolveColorSchemeImageSources(
      'clear_cards_devnet_v2',
      `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/${suffix}`,
    ),
    {
      lightSrc: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/${suffix}`,
      darkSrc: `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/${suffix}`,
    },
  );
});

test('color-scheme image resolution leaves unrelated media unchanged', () => {
  for (const [dropId, src] of [
    ['clear_cards_devnet_v2', CLEAR_CARDS_PACK_CLEAN_IMAGE_URL],
    ['clear_cards_devnet_v2', `${CLEAR_CARDS_RECEIPT_IMAGE_BASE_URL}/167.webp`],
    ['card_nft_2', `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`],
    ['clear_cards_devnet_v2', 'https://metadata.example.com/card.webp'],
  ] as const) {
    assert.deepEqual(resolveColorSchemeImageSources(dropId, src), { lightSrc: src });
  }
});
