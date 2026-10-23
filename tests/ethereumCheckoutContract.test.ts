import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutEntryUrl, checkoutReturnUrl, normalizeCheckoutCallback, normalizeCheckoutTokenIds, parseCheckoutEntry } from '../shared/ethereum/checkout.ts';

const origin = 'https://mons.shop';
const checkoutId = '78f6e575-2779-43be-9829-03e8df204532';

test('checkout entry uses exact decimal onchain IDs and preserves an opaque caller state', () => {
  const search = '?drop=111k_devnet&ids=553,332,214&callback_url=https%3A%2F%2Fvvv.so%2Fcallback&state=request%2B42%2Fnext';
  assert.deepEqual(parseCheckoutEntry(search, origin), {
    dropId: '111k_devnet', tokenIds: ['214', '332', '553'], callbackUrl: 'https://vvv.so/callback', state: 'request+42/next',
  });
  assert.equal(checkoutEntryUrl(['553', '214']), '/checkout?drop=111k_devnet&ids=214%2C553');
  assert.deepEqual(parseCheckoutEntry('?drop=111k_devnet&ids=1', origin), {
    dropId: '111k_devnet', tokenIds: ['1'], callbackUrl: 'https://mons.shop/111k_devnet',
  });
});

test('checkout entry rejects unsupported drops, duplicate query parameters and malformed selections', () => {
  for (const search of ['', '?drop=111&ids=1', '?drop=111k_mainnet&ids=1', '?drop=111k_devnet&ids=1&ids=2',
    '?drop=111k_devnet&ids=1&drop=111k_devnet', '?drop=111k_devnet&ids=1&contract=0x123',
    '?drop=111k_devnet&ids=1,1', '?drop=111k_devnet&ids=01', '?drop=111k_devnet&ids=0x1',
    '?drop=111k_devnet&ids=0', '?drop=111k_devnet&ids=-1', '?drop=111k_devnet&ids=1,,2',
    '?drop=111k_devnet&ids=1&state=%00', `?drop=111k_devnet&ids=1&state=${'a'.repeat(513)}`]) {
    assert.throws(() => parseCheckoutEntry(search, origin), undefined, search);
  }
  assert.throws(() => normalizeCheckoutTokenIds(Array.from({ length: 51 }, (_, index) => String(index + 1))));
  assert.throws(() => normalizeCheckoutTokenIds([(1n << 256n).toString()]));
  assert.deepEqual(normalizeCheckoutTokenIds(['9007199254740993', '2']), ['2', '9007199254740993']);
});

test('checkout callbacks allow every path on both VVV origins and explicit Mons returns', () => {
  for (const host of ['vvv.so', 'www.vvv.so']) {
    for (const path of ['', '/', '/callback', '/111k', '/111k/floor', '/111k-sepolia-test', '/111k-sepolia-test/floor', '/any/nested/path/']) {
      const callback = `https://${host}${path}`;
      assert.equal(normalizeCheckoutCallback(callback, origin), new URL(callback).href);
      const search = new URLSearchParams({ drop: '111k_devnet', ids: '1', callback_url: callback });
      assert.equal(parseCheckoutEntry(`?${search}`, origin).callbackUrl, new URL(callback).href);
    }
  }
  for (const callback of ['/111k_devnet', 'https://mons.shop/111k_devnet']) {
    assert.equal(normalizeCheckoutCallback(callback, origin), new URL(callback, origin).href);
  }
  assert.equal(normalizeCheckoutCallback(undefined, 'http://localhost:5173'), 'http://localhost:5173/111k_devnet');
  assert.equal(normalizeCheckoutCallback('/111k_devnet', 'https://candidate-mons-shop.lil-org.workers.dev'),
    'https://candidate-mons-shop.lil-org.workers.dev/111k_devnet');
  for (const callback of ['https://evil.example/callback', 'https://vvv.so.evil.example/callback',
    'https://vvv.so@evil.example/callback', 'https://user@vvv.so/callback', 'https://vvv.so/callback?next=https://evil.example',
    'https://vvv.so/callback#fragment', 'https://other.vvv.so/111k', 'http://vvv.so/callback', 'https://vvv.so:8443/callback',
    'http://www.vvv.so/111k', 'https://www.vvv.so.evil.example/111k', 'https://user:pass@www.vvv.so/111k',
    'https://www.vvv.so:8443/111k', 'https://www.vvv.so/111k?next=elsewhere', 'https://www.vvv.so/111k#fragment',
    'https://vvv.so/111k?', 'https://www.vvv.so/111k#', '//vvv.so/111k',
    '//evil.example', '/111k_devnet?next=evil', 'javascript:alert(1)', 'data:text/html,test',
    'https://mons.shop/other', 'https://localhost/111k_devnet', ' https://vvv.so/callback']) {
    assert.throws(() => normalizeCheckoutCallback(callback, origin), undefined, callback);
  }
  assert.throws(() => normalizeCheckoutCallback('/111k_devnet', 'https://evil.example'));
});

test('callback construction encodes correlation state and reports pending independently from eventual completion', () => {
  const pending = new URL(checkoutReturnUrl({ callbackUrl: 'https://vvv.so/callback', state: 'x&result=success',
    checkoutId, result: 'pending', chainId: 11155111, transactionHash: `0x${'ab'.repeat(32)}` }));
  assert.equal(pending.origin, 'https://vvv.so');
  assert.equal(pending.searchParams.get('result'), 'pending');
  assert.equal(pending.searchParams.get('state'), 'x&result=success');
  assert.equal(pending.searchParams.get('checkout_id'), checkoutId);
  assert.equal(pending.searchParams.getAll('result').length, 1);
  const canceled = new URL(checkoutReturnUrl({ callbackUrl: 'https://mons.shop/111k_devnet',
    checkoutId, result: 'canceled', chainId: 11155111 }));
  assert.equal(canceled.searchParams.has('tx_hash'), false);
  assert.equal(canceled.searchParams.has('state'), false);
});
