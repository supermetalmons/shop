import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColorSchemeImage } from '../src/components/ColorSchemeImage.tsx';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';

test('color-scheme images preserve the original bare image layout', () => {
  const markup = renderToStaticMarkup(
    createElement(ColorSchemeImage, {
      dropId: 'clear_cards_devnet_v2',
      src: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`,
      alt: 'Clear Card #167',
      className: 'inventory__image',
    }),
  );

  assert.match(markup, /<img [^>]*class="inventory__image"/);
  assert.match(markup, new RegExp(`src="${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167\\.webp"`));
  assert.doesNotMatch(markup, /<picture|clean_dark/);
  assert.equal(markup.includes(CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL), false);
});
