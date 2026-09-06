import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { ColorSchemeImage } = await import('../src/components/ColorSchemeImage.tsx');
const darkQuery = '(prefers-color-scheme: dark)';

afterEach(() => {
  cleanup();
  setMediaQueryMatches(darkQuery, false);
});
after(() => dom.window.close());

test('color-scheme changes update the same image while preserving its layout and callbacks', () => {
  let failures = 0;
  const view = render(createElement(ColorSchemeImage, {
    dropId: 'clear_cards_devnet_v2',
    src: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`,
    alt: 'Clear Card #167',
    className: 'inventory__image',
    onError: () => { failures += 1; },
  }));
  const image = view.getByRole('img', { name: 'Clear Card #167' }) as HTMLImageElement;
  assert.equal(view.container.firstElementChild, image);
  assert.equal(image.classList.contains('inventory__image'), true);
  assert.equal(image.src, `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`);

  act(() => setMediaQueryMatches(darkQuery, true));
  assert.equal(view.getByRole('img'), image);
  assert.equal(image.src, `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/167.webp`);

  act(() => setMediaQueryMatches(darkQuery, false));
  assert.equal(image.src, `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`);
  fireEvent.error(image);
  assert.equal(failures, 1);
});

test('unmapped images keep their source in dark mode', () => {
  setMediaQueryMatches(darkQuery, true);
  const view = render(createElement(ColorSchemeImage, {
    dropId: 'little_swag_boxes',
    src: 'https://cdn.lil.org/nft/little_swag_boxes/figures/1.webp',
    alt: 'Figure 1',
  }));
  const image = view.getByRole('img', { name: 'Figure 1' }) as HTMLImageElement;
  assert.equal(image.src, 'https://cdn.lil.org/nft/little_swag_boxes/figures/1.webp');
});
