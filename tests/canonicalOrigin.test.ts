import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalProductionUrl } from '../src/lib/canonicalOrigin.ts';

test('www production URLs redirect to the canonical origin without changing the route', () => {
  assert.equal(
    canonicalProductionUrl('https://www.mons.shop/card_nft_2?code=123#claim'),
    'https://mons.shop/card_nft_2?code=123#claim',
  );
  assert.equal(canonicalProductionUrl('https://mons.shop/card_nft_2?code=123#claim'), null);
  assert.equal(canonicalProductionUrl('http://localhost:5173/card_nft_2'), null);
});

test('the canonical redirect happens before browser setup or React initialization', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const redirect = source.indexOf('window.location.replace(canonicalUrl)');
  const browserSetup = source.indexOf('installMobileInteractionGuards()');
  const appInitialization = source.indexOf('const queryClient = new QueryClient()');
  assert.ok(redirect > 0 && browserSetup > redirect && appInitialization > browserSetup);
  assert.match(source, /if \(!canonicalUrl\) \{\s*const queryClient = new QueryClient\(\)/);
});
