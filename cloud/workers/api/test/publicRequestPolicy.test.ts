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

test('public rate-limit observation never rejects or exposes the key', async () => {
  const logs: Record<string, unknown>[] = [];
  await observePublicRateLimit({
    binding: limiter(async () => ({ success: false })),
    keyScope: 'inventory',
    limit: 600,
    log: (entry) => logs.push(entry),
    request: new Request('https://api.mons.shop/inventory', {
      headers: { 'CF-Connecting-IP': '203.0.113.8' },
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
    binding: limiter(async () => ({ success: true })),
    keyScope: 'inventory',
    limit: 600,
    log: (entry) => logs.push(entry),
    request: new Request('https://api.mons.shop/inventory'),
    route: '/inventory',
  });
  await observePublicRateLimit({
    binding: limiter(async () => ({ success: false })),
    keyScope: 'inventory',
    limit: 600,
    log: () => {
      throw new Error('logger unavailable');
    },
    request: new Request('https://api.mons.shop/inventory', {
      headers: { 'CF-Connecting-IP': '203.0.113.8' },
    }),
    route: '/inventory',
  });
  assert.deepEqual(logs.map((entry) => entry.event), [
    'public_rate_limit_would_block',
    'public_rate_limit_check_failed',
    'public_rate_limit_key_missing',
  ]);
  assert.equal(JSON.stringify(logs).includes('203.0.113.8'), false);
});
