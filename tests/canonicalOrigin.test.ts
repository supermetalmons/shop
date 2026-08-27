import assert from 'node:assert/strict';
import test from 'node:test';
import { runBrowserBootstrap } from '../src/bootstrap.ts';
import { canonicalProductionUrl } from '../src/lib/canonicalOrigin.ts';

test('www production URLs redirect to the canonical origin without changing the route', () => {
  assert.equal(
    canonicalProductionUrl('https://www.mons.shop/card_nft_2?code=123#claim'),
    'https://mons.shop/card_nft_2?code=123#claim',
  );
  assert.equal(canonicalProductionUrl('https://mons.shop/card_nft_2?code=123#claim'), null);
  assert.equal(canonicalProductionUrl('http://localhost:5173/card_nft_2'), null);
});

test('the canonical redirect prevents browser setup and app mounting', () => {
  const calls: string[] = [];
  const result = runBrowserBootstrap('https://mons.shop/card_nft_2', {
    redirect: (url) => calls.push(`redirect:${url}`),
    setup: () => calls.push('setup'),
    mount: () => calls.push('mount'),
  });

  assert.equal(result, 'redirected');
  assert.deepEqual(calls, ['redirect:https://mons.shop/card_nft_2']);
});

test('browser setup completes before mounting when no redirect is needed', () => {
  const calls: string[] = [];
  const result = runBrowserBootstrap(null, {
    redirect: (url) => calls.push(`redirect:${url}`),
    setup: () => calls.push('setup'),
    mount: () => calls.push('mount'),
  });

  assert.equal(result, 'mounted');
  assert.deepEqual(calls, ['setup', 'mount']);
});
