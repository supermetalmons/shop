import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedPublicOrigin,
  observePublicRateLimit,
} from '../src/publicRequestPolicy.ts';

function limiter(limit: RateLimit['limit']): RateLimit {
  return { limit };
}

test('public origin policy allows only mons.shop and local development origins', () => {
  for (const origin of [
    'https://mons.shop',
    'https://www.mons.shop',
    'http://localhost:5173',
    'https://127.0.0.1:8787',
  ]) assert.equal(isAllowedPublicOrigin(origin), true, origin);
  for (const origin of [
    '',
    'https://candidate-mons-shop.lil-org.workers.dev',
    'https://evil.example',
    'https://mons.shop/path',
    'ftp://localhost',
  ]) assert.equal(isAllowedPublicOrigin(origin), false, origin);
});

test('public request IP validation returns canonical IPv4 and IPv6 keys', async () => {
  for (const [value, expected] of [
    ['203.0.113.8', '203.0.113.8'],
    [' 203.0.113.8 ', '203.0.113.8'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::ffff:192.0.2.128', '::ffff:c000:280'],
    ['::1', '::1'],
  ] as const) {
    let key = '';
    await observePublicRateLimit({
      binding: limiter(async (options) => {
        key = options.key;
        return { success: true };
      }),
      limit: 1,
      log: () => undefined,
      request: new Request('https://api.mons.shop/inventory', {
        headers: { 'CF-Connecting-IP': value },
      }),
      route: '/inventory',
    });
    assert.equal(key, expected, value);
  }
  for (const value of [
    '',
    'deadbeef',
    '999.999.999.999',
    '01.2.3.4',
    '1.2.3',
    '1.2.3.4.5',
    '::::',
    '2001:db8::1::',
    'fe80::1%eth0',
    '[::1]',
  ]) {
    let calls = 0;
    await observePublicRateLimit({
      binding: limiter(async () => {
        calls += 1;
        return { success: true };
      }),
      limit: 1,
      log: () => undefined,
      request: new Request('https://api.mons.shop/inventory', {
        headers: { 'CF-Connecting-IP': value },
      }),
      route: '/inventory',
    });
    assert.equal(calls, 0, value);
  }
});

test('public rate-limit observation never rejects or exposes the key', async () => {
  const logs: Record<string, unknown>[] = [];
  const keys: string[] = [];
  await observePublicRateLimit({
    binding: limiter(async ({ key }) => {
      keys.push(key);
      return { success: false };
    }),
    keyScope: 'inventory',
    limit: 600,
    log: (entry) => logs.push(entry),
    request: new Request('https://api.mons.shop/inventory', {
      headers: { 'CF-Connecting-IP': '2001:0DB8:0000:0000:0000:0000:0000:0001' },
    }),
    route: '/inventory',
  });
  await observePublicRateLimit({
    binding: limiter(async () => {
      throw new Error('unavailable');
    }),
    keyScope: 'inventory',
    limit: 600,
    log: (entry) => logs.push(entry),
    request: new Request('https://api.mons.shop/inventory', {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    }),
    route: '/inventory',
  });
  await observePublicRateLimit({
    binding: limiter(async ({ key }) => {
      keys.push(key);
      return { success: true };
    }),
    limit: 600,
    log: (entry) => logs.push(entry),
    request: new Request('https://api.mons.shop/inventory', {
      headers: { 'CF-Connecting-IP': '203.0.113.8' },
    }),
    route: '/inventory',
  });
  let invalidKeyCalls = 0;
  await observePublicRateLimit({
    binding: limiter(async () => {
      invalidKeyCalls += 1;
      return { success: false };
    }),
    keyScope: 'inventory',
    limit: 600,
    log: (entry) => logs.push(entry),
    request: new Request('https://api.mons.shop/inventory', {
      headers: { 'CF-Connecting-IP': '999.999.999.999' },
    }),
    route: '/inventory',
  });
  await observePublicRateLimit({
    binding: limiter(async () => ({ success: false })),
    keyScope: 'inventory',
    limit: 600,
    log: () => {
      throw new Error('logger unavailable');
    },
    request: new Request('https://api.mons.shop/inventory'),
    route: '/inventory',
  });
  assert.deepEqual(logs.map((entry) => entry.event), [
    'public_rate_limit_would_block',
    'public_rate_limit_check_failed',
    'public_rate_limit_key_missing',
  ]);
  assert.deepEqual(keys, ['inventory:2001:db8::1', '203.0.113.8']);
  assert.equal(invalidKeyCalls, 0);
  assert.equal(JSON.stringify(logs).includes('203.0.113.8'), false);
});
