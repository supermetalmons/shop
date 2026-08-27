import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import Stripe from 'stripe';
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
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
    vars: {
      STRIPE_WEBHOOK_SECRET_DEVNET: 'whsec_runtime_devnet',
      STRIPE_WEBHOOK_SECRET: 'whsec_runtime_mainnet',
    },
  };
  assert.equal(runtimeConfig.compatibility_date, productionConfig.compatibility_date);
  assert.deepEqual(runtimeConfig.compatibility_flags, productionConfig.compatibility_flags);
  delete runtimeConfig.$schema;
  delete runtimeConfig.secrets;
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{
      config: runtimeConfig,
    }],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('DATA_DB');
    await worker.applyD1Migrations('OPS_DB');
    await worker.applyD1Migrations('COMMERCE_DB');
    const runtimeEnv = await worker.getEnv();
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
    assert.equal(profilePreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF');

    for (const pathname of ['/auth/anonymous/session', '/auth/anonymous/logout', '/auth/solana', '/profile/reconcile', '/claims/irl/prepare', '/receipts/stripe/claim', '/receipts/transfer/prepare', '/delivery/prepare', '/delivery/receipts/issue', '/delivery/receipts/recover', '/admin/irl-redeem/prepare', '/admin/irl-redeem/finalize', '/boxes/reveal', '/staff/auth/challenge', '/staff/auth/session', '/staff/auth/refresh', '/staff/auth/logout']) {
      const lifecyclePreflight = await worker.fetch(`https://api.mons.shop${pathname}`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://mons.shop' },
      });
      assert.equal(lifecyclePreflight.status, 204);
      assert.equal(lifecyclePreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
      assert.equal(lifecyclePreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF');
    }

    const anonymousHeaders = {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
      'X-Mons-CSRF': '1',
    };
    const createdAnonymous = await worker.fetch('https://api.mons.shop/auth/anonymous/session', {
      method: 'POST',
      headers: anonymousHeaders,
      body: '{}',
    });
    assert.equal(createdAnonymous.status, 201);
    const anonymousCookie = createdAnonymous.headers.get('set-cookie') || '';
    assert.match(anonymousCookie, /^mons_anon_dev_v1=mons_anon_v1\./);
    assert.match(anonymousCookie, /HttpOnly/);
    assert.match(anonymousCookie, /SameSite=Strict/);
    assert.doesNotMatch(anonymousCookie, /Secure/);
    const anonymousSession = await createdAnonymous.json() as { subject: string; refreshedAt: number; expiresAt: number };
    assert.match(anonymousSession.subject, /^anon:/);
    const storedAnonymous = await runtimeEnv.OPS_DB.prepare(`SELECT secret_hash, auth_subject
      FROM anonymous_auth_sessions`).first<{ secret_hash: string; auth_subject: string }>();
    assert.equal(storedAnonymous?.auth_subject, anonymousSession.subject);
    assert.match(storedAnonymous?.secret_hash || '', /^[0-9a-f]{64}$/);
    assert.equal(anonymousCookie.includes(storedAnonymous?.secret_hash || 'missing'), false);

    const cookieHeader = anonymousCookie.split(';', 1)[0];
    const restoredAnonymous = await worker.fetch('https://api.mons.shop/auth/anonymous/session', {
      method: 'POST',
      headers: { ...anonymousHeaders, Cookie: cookieHeader },
      body: '{}',
    });
    assert.equal(restoredAnonymous.status, 200);
    assert.equal(((await restoredAnonymous.json()) as { subject: string }).subject, anonymousSession.subject);

    const cookieProfile = await worker.fetch('https://api.mons.shop/profile/state', {
      method: 'POST',
      headers: { ...anonymousHeaders, Cookie: cookieHeader },
      body: '{}',
    });
    assert.equal(cookieProfile.status, 200);
    assert.equal(((await cookieProfile.json()) as { sessionWallet: string | null }).sessionWallet, null);

    const missingCsrf = await worker.fetch('https://api.mons.shop/profile/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', Cookie: cookieHeader },
      body: '{}',
    });
    assert.equal(missingCsrf.status, 401);

    const loggedOut = await worker.fetch('https://api.mons.shop/auth/anonymous/logout', {
      method: 'POST',
      headers: { ...anonymousHeaders, Cookie: cookieHeader },
      body: '{}',
    });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get('set-cookie') || '', /Max-Age=0/);

    const staffChallenge = await worker.fetch('https://api.mons.shop/staff/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify({ wallet: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx' }),
    });
    assert.equal(staffChallenge.status, 200);
    const staffChallengeBody = await staffChallenge.json() as {
      challengeId: string;
      expiresAt: number;
      message: string;
    };
    assert.match(staffChallengeBody.challengeId, /^[0-9a-f-]{36}$/);
    assert.match(staffChallengeBody.message, new RegExp(`Session: staff:${staffChallengeBody.challengeId}$`));
    assert.ok(staffChallengeBody.expiresAt > Date.now());

    const workerEnv = await worker.getEnv();
    const seededChallengeId = crypto.randomUUID();
    const seededSessionId = crypto.randomUUID();
    const seededSecret = 'A'.repeat(43);
    const seededNowMs = Date.now();
    await workerEnv.OPS_DB.batch([
      workerEnv.OPS_DB.prepare(`INSERT INTO staff_auth_challenges VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          seededChallengeId,
          'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
          'mons.shop',
          seededNowMs,
          seededNowMs + 300_000,
          seededNowMs,
        ),
      workerEnv.OPS_DB.prepare(`INSERT INTO staff_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          seededSessionId,
          seededChallengeId,
          createHash('sha256').update(seededSecret).digest('hex'),
          'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
          seededNowMs,
          seededNowMs,
          seededNowMs + 30 * 24 * 60 * 60 * 1000,
        ),
    ]);
    const authenticatedStaffRoute = await worker.fetch('https://api.mons.shop/admin/future', {
      method: 'POST',
      headers: {
        Authorization: `Bearer mons_staff_v1.${seededSessionId}.${seededSecret}`,
        'Content-Type': 'application/json',
        Origin: 'https://mons.shop',
      },
      body: '{}',
    });
    assert.equal(authenticatedStaffRoute.status, 404);
    const authenticatedExistingStaffRoute = await worker.fetch('https://api.mons.shop/admin/delivery-order-owners', {
      method: 'POST',
      headers: {
        Authorization: `Bearer mons_staff_v1.${seededSessionId}.${seededSecret}`,
        'Content-Type': 'application/json',
        Origin: 'https://mons.shop',
      },
      body: JSON.stringify({ pageSize: 1 }),
    });
    assert.equal(authenticatedExistingStaffRoute.status, 200);
    assert.deepEqual(await authenticatedExistingStaffRoute.json(), {
      owners: [],
      nextCursor: null,
      hasMore: false,
    });

    const checkoutPreflight = await worker.fetch('https://api.mons.shop/checkout/session', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    });
    assert.equal(checkoutPreflight.status, 204);
    assert.equal(checkoutPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.equal(checkoutPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF');

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
      ['/auth/solana', {
        wallet: '11111111111111111111111111111111',
        message: 'smoke',
        signature: Array(64).fill(0),
      }],
      ['/profile/reconcile', {}],
      ['/claims/irl/prepare', {
        owner: '11111111111111111111111111111111',
        code: '0000000000',
      }],
      ['/receipts/stripe/claim', {
        code: 'ABCDEF-1234567890',
        recipient: '11111111111111111111111111111111',
      }],
      ['/receipts/transfer/prepare', {
        owner: '11111111111111111111111111111111',
        dropId: 'card_nft_2',
        receiptAssetId: '11111111111111111111111111111112',
        destination: '11111111111111111111111111111113',
      }],
      ['/delivery/prepare', {
        owner: '11111111111111111111111111111111',
        dropId: 'card_nft_2',
        itemIds: ['11111111111111111111111111111112'],
        addressId: 'AbCdEfGhIjKlMnOpQrSt',
      }],
      ['/delivery/receipts/issue', {
        owner: '11111111111111111111111111111111',
        dropId: 'card_nft_2',
        deliveryId: 1,
        signature: '1'.repeat(64),
      }],
      ['/delivery/receipts/recover', { dropId: 'card_nft_2' }],
      ['/admin/irl-redeem/prepare', {
        owner: '11111111111111111111111111111111',
        dropId: 'card_nft_2',
        itemIds: ['11111111111111111111111111111112'],
      }],
      ['/admin/irl-redeem/finalize', {
        requestId: 'AbCdEfGhIjKlMnOpQrSt',
        dropId: 'card_nft_2',
        transferSignature: '1'.repeat(64),
      }],
      ['/boxes/reveal', {
        owner: '11111111111111111111111111111111',
        boxAssetId: '11111111111111111111111111111112',
        dropId: 'clear_cards_devnet_v2',
      }],
    ] as const) {
      const response = await worker.fetch(`https://api.mons.shop${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthenticated');
    }

    const webhookPayload = JSON.stringify({
      id: 'evt_runtime_test',
      object: 'event',
      type: 'customer.created',
      data: { object: { id: 'cus_runtime_test' } },
    });
    const webhookSignature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: webhookPayload,
      secret: 'whsec_runtime_devnet',
      timestamp: Math.floor(Date.now() / 1000),
      cryptoProvider: Stripe.createSubtleCryptoProvider(crypto.subtle),
    });
    const signedWebhook = await worker.fetch('https://api.mons.shop/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': webhookSignature,
      },
      body: webhookPayload,
    });
    assert.equal(signedWebhook.status, 200);
    assert.deepEqual(await signedWebhook.json(), {
      received: true,
      ignored: true,
      reason: 'unsupported_event',
    });

    const invalidWebhook = await worker.fetch('https://api.mons.shop/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 't=1,v1=invalid',
      },
      body: webhookPayload,
    });
    assert.equal(invalidWebhook.status, 400);

    const webhookMethod = await worker.fetch('https://api.mons.shop/webhooks/stripe');
    assert.equal(webhookMethod.status, 405);
    assert.equal(webhookMethod.headers.get('allow'), 'POST');

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
