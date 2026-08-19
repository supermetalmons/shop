import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createTestHarness } from 'wrangler';

test('Wrangler test harness starts the Worker in workerd and preserves route headers', async () => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const rootRequire = createRequire(import.meta.url);
  const wranglerPackagePath = rootRequire.resolve('wrangler/package.json');
  const wranglerRequire = createRequire(wranglerPackagePath);
  const miniflarePackagePath = wranglerRequire.resolve('miniflare/package.json');
  const miniflareRequire = createRequire(miniflarePackagePath);
  const wranglerPackage = JSON.parse(readFileSync(wranglerPackagePath, 'utf8'));
  const miniflarePackage = JSON.parse(readFileSync(miniflarePackagePath, 'utf8'));
  const wranglerWorkerdPackage = JSON.parse(readFileSync(wranglerRequire.resolve('workerd/package.json'), 'utf8'));
  const miniflareWorkerdPackage = JSON.parse(readFileSync(miniflareRequire.resolve('workerd/package.json'), 'utf8'));
  assert.equal(miniflarePackage.version, wranglerPackage.dependencies.miniflare);
  assert.equal(wranglerWorkerdPackage.version, wranglerPackage.dependencies.workerd);
  assert.equal(miniflareWorkerdPackage.version, miniflarePackage.dependencies.workerd);
  assert.equal(productionConfig.compatibility_date, '2026-08-08');
  assert.deepEqual(productionConfig.compatibility_flags, ['nodejs_compat']);
  const runtimeConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
  };
  assert.equal(runtimeConfig.compatibility_date, productionConfig.compatibility_date);
  assert.deepEqual(runtimeConfig.compatibility_flags, productionConfig.compatibility_flags);
  delete runtimeConfig.$schema;
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{
      config: runtimeConfig,
    }],
  });
  try {
    await server.listen();
    const worker = server.getWorker('mons-shop-api');
    const health = await worker.fetch('https://api.mons.shop/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.match(health.headers.get('cache-control') || '', /no-store/);
    assert.match(health.headers.get('server-timing') || '', /total;dur=/);

    const inventoryPreflight = await worker.fetch('https://api.mons.shop/inventory', { method: 'OPTIONS' });
    assert.equal(inventoryPreflight.status, 204);
    assert.equal(inventoryPreflight.headers.get('access-control-allow-origin'), '*');

    const notificationPreflight = await worker.fetch('https://api.mons.shop/notifications/subscribe', { method: 'OPTIONS' });
    assert.equal(notificationPreflight.status, 204);
    assert.equal(notificationPreflight.headers.get('access-control-allow-origin'), '*');

    const packStatusPreflight = await worker.fetch('https://api.mons.shop/pack-status/card_nft_2', { method: 'OPTIONS' });
    assert.equal(packStatusPreflight.status, 204);
    assert.equal(packStatusPreflight.headers.get('access-control-allow-origin'), '*');
    assert.match(packStatusPreflight.headers.get('cache-control') || '', /no-store/);

    const profilePreflight = await worker.fetch('https://api.mons.shop/profile/shipments', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    });
    assert.equal(profilePreflight.status, 204);
    assert.equal(profilePreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.equal(profilePreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');

    const checkoutPreflight = await worker.fetch('https://api.mons.shop/checkout/session', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    });
    assert.equal(checkoutPreflight.status, 204);
    assert.equal(checkoutPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.equal(checkoutPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');

    const unauthenticatedCheckout = await worker.fetch('https://api.mons.shop/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify({ dropId: 'card_nft_binder_devnet' }),
    });
    assert.equal(unauthenticatedCheckout.status, 401);
    assert.equal((await unauthenticatedCheckout.json() as { error: { code: string } }).error.code, 'unauthenticated');

    const unauthenticatedProfile = await worker.fetch('https://api.mons.shop/profile/anonymous-stripe-delivery-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: '{}',
    });
    assert.equal(unauthenticatedProfile.status, 401);
    assert.equal((await unauthenticatedProfile.json() as any).error.code, 'unauthenticated');

    for (const [pathname, body] of [
      ['/fulfillment/order-address', { dropId: 'card_nft_2', deliveryId: 7, full: 'address' }],
      ['/fulfillment/shipstation-label', { dropId: 'card_nft_2', deliveryId: 7 }],
      ['/fulfillment/shipstation-label-purchase', {
        dropId: 'card_nft_2',
        deliveryId: 7,
        rateId: 'rate-1',
        expectedTotal: { currency: 'usd', amount: 12 },
        requestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      }],
      ['/fulfillment/shipstation-label-void', {
        dropId: 'card_nft_2',
        deliveryId: 7,
        labelId: 'se-label',
      }],
      ['/fulfillment/shipstation-rates', { dropId: 'card_nft_2', deliveryId: 7 }],
    ] as const) {
      const response = await worker.fetch(`https://api.mons.shop${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthenticated');
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://mons.shop');
    }

    const invalidPackStatus = await worker.fetch('https://api.mons.shop/pack-status/unsupported');
    assert.equal(invalidPackStatus.status, 400);
    assert.deepEqual(await invalidPackStatus.json(), { ok: false, error: 'invalid-request' });

    const invalidNotification = await worker.fetch('https://api.mons.shop/notifications/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not an email' }),
    });
    assert.equal(invalidNotification.status, 400);
    assert.deepEqual(await invalidNotification.json(), { ok: false, error: 'invalid-email' });

    const allowedRpcPreflight = await worker.fetch('https://api.mons.shop/rpc/devnet', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://mons.shop',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,solana-client',
      },
    });
    assert.equal(allowedRpcPreflight.status, 204);
    assert.equal(allowedRpcPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.equal(allowedRpcPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Solana-Client');

    const deniedRpcPreflight = await worker.fetch('https://api.mons.shop/rpc/mainnet-beta', {
      method: 'OPTIONS',
      headers: { Origin: 'https://not-mons.example' },
    });
    assert.equal(deniedRpcPreflight.status, 403);
    assert.equal((await deniedRpcPreflight.json() as any).error.code, -32096);
  } finally {
    await server.close();
  }
});
