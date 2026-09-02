import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  assert.deepEqual(productionConfig.compatibility_flags, ['nodejs_compat', 'enable_request_signal']);
  assert.deepEqual(productionConfig.workflows, [{
    binding: 'ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW',
    name: 'mons-shop-admin-irl-redeem-finalize-v1',
    class_name: 'AdminIrlRedeemFinalizeWorkflowV1',
  }]);
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
    await runtimeEnv.COMMERCE_DB.batch([
      runtimeEnv.COMMERCE_DB.prepare(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1, '00000000-0000-4000-8000-000000000306',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      )`),
      runtimeEnv.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL`),
      runtimeEnv.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused'`),
      runtimeEnv.COMMERCE_DB.prepare(`DELETE FROM commerce_authority_control_lease
        WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000306'`),
    ]);
    const missingAdminWorkflowOperationId = `airf-v1-${'a'.repeat(64)}`;
    await assert.rejects(
      runtimeEnv.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW.get(missingAdminWorkflowOperationId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'instance.not_found');
        return true;
      },
    );
    const health = await worker.fetch('https://api.mons.shop/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.match(health.headers.get('cache-control') || '', /no-store/);
    assert.match(health.headers.get('server-timing') || '', /total;dur=/);

    const inventoryPreflight = await worker.fetch('https://api.mons.shop/inventory', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    });
    assert.equal(inventoryPreflight.status, 204);
    assert.equal(inventoryPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');

    const notificationPreflight = await worker.fetch('https://api.mons.shop/notifications/subscribe', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mons.shop' },
    });
    assert.equal(notificationPreflight.status, 204);
    assert.equal(notificationPreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');

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
    assert.equal(profilePreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');

    for (const pathname of ['/auth/anonymous/session', '/auth/anonymous/logout', '/auth/solana', '/profile/reconcile', '/claims/irl/prepare', '/receipts/stripe/claim', '/receipts/transfer/prepare', '/delivery/prepare', '/delivery/receipts/issue', '/delivery/receipts/recover', '/admin/irl-redeem/prepare', '/admin/irl-redeem/finalize', '/admin/irl-redeem/finalize/status', '/boxes/reveal', '/staff/auth/challenge', '/staff/auth/session', '/staff/auth/refresh', '/staff/auth/logout']) {
      const lifecyclePreflight = await worker.fetch(`https://api.mons.shop${pathname}`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://mons.shop' },
      });
      assert.equal(lifecyclePreflight.status, 204);
      assert.equal(lifecyclePreflight.headers.get('access-control-allow-origin'), 'https://mons.shop');
      assert.equal(lifecyclePreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');
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
    const seededAuthorization = `Bearer mons_staff_v1.${seededSessionId}.${seededSecret}`;
    const missingAdminWorkflowStatus = await worker.fetch('https://api.mons.shop/admin/irl-redeem/finalize/status', {
      method: 'POST',
      headers: {
        Authorization: seededAuthorization,
        'Content-Type': 'application/json',
        Origin: 'https://mons.shop',
      },
      body: JSON.stringify({ operationId: missingAdminWorkflowOperationId }),
    });
    assert.equal(missingAdminWorkflowStatus.status, 404);
    assert.equal(missingAdminWorkflowStatus.headers.get('access-control-allow-origin'), 'https://mons.shop');
    assert.match(missingAdminWorkflowStatus.headers.get('cache-control') || '', /no-store/);
    assert.equal(
      (await missingAdminWorkflowStatus.json() as { error: { code: string } }).error.code,
      'not-found',
    );
    const adminWorkflowOperationId = `airf-v1-${'b'.repeat(64)}`;
    const adminWorkflowPayload = {
      version: 1 as const,
      dropId: 'card_nft_2',
      requestId: 'runtime-admin-request',
    };
    const adminWorkflowReference = {
      kind: 'admin-irl-redeem-finalize-v1',
      dropId: adminWorkflowPayload.dropId,
      requestId: adminWorkflowPayload.requestId,
    };
    const adminWorkflowSteps = [
      ['resume exact lease and reconcile WAL', { ok: true, value: { status: 'ready' } }],
      ['validate configuration and transfer', { ok: true, value: { status: 'ready' } }],
      ['prepare immutable publication draft', { ok: true, value: { status: 'drafted' } }],
      ['publish durable completion', { ok: true, value: adminWorkflowReference }],
    ] as const;
    const adminWorkflow = await worker.introspectWorkflow('ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW');
    try {
      await adminWorkflow.modifyAll(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.disableSleeps();
        for (const [name, result] of adminWorkflowSteps) {
          await modifier.mockStepResult({ name }, result);
        }
      });
      const createdAdminWorkflows = await runtimeEnv.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW.createBatch([{
        id: adminWorkflowOperationId,
        params: adminWorkflowPayload,
      }]);
      assert.equal(createdAdminWorkflows.length, 1);
      const instances = await adminWorkflow.get();
      assert.equal(instances.length, 1);
      const instance = instances[0];
      assert.ok(instance);
      await instance.waitForStatus('complete');
      for (const [name, result] of adminWorkflowSteps) {
        const observed = JSON.parse(JSON.stringify(await instance.waitForStepResult({ name })));
        if (name === 'prepare immutable publication draft') assert.equal(observed, '[REDACTED]');
        else assert.deepEqual(observed, result);
      }
      const output = JSON.parse(JSON.stringify(await instance.getOutput()));
      assert.deepEqual(output, {
        version: 1,
        ok: true,
        result: adminWorkflowReference,
      });
      assert.equal(JSON.stringify(output).includes('claimCode'), false);
    } finally {
      await adminWorkflow.dispose();
    }
    const authenticatedStaffRoute = await worker.fetch('https://api.mons.shop/admin/future', {
      method: 'POST',
      headers: {
        Authorization: seededAuthorization,
        'Content-Type': 'application/json',
        Origin: 'https://mons.shop',
      },
      body: '{}',
    });
    assert.equal(authenticatedStaffRoute.status, 404);
    const authenticatedExistingStaffRoute = await worker.fetch('https://api.mons.shop/admin/delivery-order-owners', {
      method: 'POST',
      headers: {
        Authorization: seededAuthorization,
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
    assert.equal(checkoutPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id');
    assert.equal(checkoutPreflight.headers.get('access-control-expose-headers'), 'X-Mons-Checkout-Retry');

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
      ['/admin/irl-redeem/finalize/status', {
        operationId: `airf-v1-${'a'.repeat(64)}`,
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
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://mons.shop',
      },
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

test('client socket disconnect reaches the API Worker through the frontend service binding', async () => {
  const frontendConfig = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  assert.deepEqual(frontendConfig.compatibility_flags, [
    'nodejs_compat',
    'enable_request_signal',
    'request_signal_passthrough',
  ]);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'mons-request-signal-'));
  const fixturePath = join(fixtureDirectory, 'signal-api.mjs');
  await writeFile(fixturePath, `
let clientAborted = false;

export default {
  fetch(request) {
    if (new URL(request.url).pathname === '/status') {
      return Response.json({ clientAborted });
    }

    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    request.signal.addEventListener('abort', () => {
      clientAborted = true;
      void writer.abort(request.signal.reason).catch(() => undefined);
    }, { once: true });
    void (async () => {
      try {
        const bytes = new TextEncoder().encode('ready\\n');
        for (;;) {
          await writer.write(bytes);
          await scheduler.wait(10);
        }
      } catch {}
    })();
    return new Response(readable, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
`, 'utf8');

  const server = createTestHarness({
    root: resolve('.'),
    workers: [
      {
        config: {
          name: 'signal-gateway',
          main: resolve('cloud/workers/frontend/src/index.ts'),
          compatibility_date: frontendConfig.compatibility_date,
          compatibility_flags: frontendConfig.compatibility_flags,
          services: [{ binding: 'MONS_API', service: 'signal-api' }],
        },
      },
      {
        config: {
          name: 'signal-api',
          main: fixturePath,
          compatibility_date: '2026-08-08',
          compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
        },
      },
    ],
  });
  let socket: Socket | undefined;
  try {
    const { url } = await server.listen();
    socket = createConnection({ host: url.hostname, port: Number(url.port) });
    await new Promise<void>((resolveReady, reject) => {
      let received = '';
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for streaming response')), 2_000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket?.off('data', onData);
        socket?.off('error', onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (!received.includes('ready')) return;
        cleanup();
        resolveReady();
      };
      socket?.on('data', onData);
      socket?.once('error', onError);
      socket?.once('connect', () => {
        socket?.write(`GET /api/signal HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`);
      });
    });
    socket.destroy();

    const api = server.getWorker('signal-api');
    let clientAborted = false;
    for (let attempt = 0; attempt < 100 && !clientAborted; attempt += 1) {
      const status = await api.fetch('https://signal-api/status');
      clientAborted = ((await status.json()) as { clientAborted: boolean }).clientAborted;
      if (!clientAborted) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal(clientAborted, true);
  } finally {
    socket?.destroy();
    await server.close();
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test('partial upload disconnect is logged as 499 through the frontend and API Workers', async () => {
  const frontendConfig = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const productionApiConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const apiConfig = {
    ...productionApiConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionApiConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete apiConfig.$schema;
  delete apiConfig.secrets;
  const server = createTestHarness({
    root: resolve('.'),
    workers: [
      { config: {
        name: 'mons-shop',
        main: resolve('cloud/workers/frontend/src/index.ts'),
        compatibility_date: frontendConfig.compatibility_date,
        compatibility_flags: frontendConfig.compatibility_flags,
        services: [{ binding: 'MONS_API', service: 'mons-shop-api' }],
      } },
      { config: apiConfig },
    ],
  });
  let socket: Socket | undefined;
  try {
    const { url } = await server.listen();
    server.clearLogs();
    socket = createConnection({ host: url.hostname, port: Number(url.port) });
    await new Promise<void>((resolveConnected, reject) => {
      socket?.once('connect', () => {
        socket?.write(`POST /api/rpc/devnet HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: https://mons.shop\r\nContent-Type: application/json\r\nContent-Length: 10000\r\nConnection: keep-alive\r\n\r\n{\"jsonrpc\":\"2.0\",\"partial\":`);
        setTimeout(resolveConnected, 100);
      });
      socket?.once('error', reject);
    });
    socket.destroy();
    let requestLog: string | undefined;
    for (let attempt = 0; attempt < 100 && !requestLog; attempt += 1) {
      for (const entry of server.getLogs()) {
        if (
          entry.message.includes("event: 'shop_api_request'") &&
          entry.message.includes("route: '/rpc/devnet'")
        ) requestLog = entry.message;
      }
      if (requestLog) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.ok(requestLog, JSON.stringify(server.getLogs(), null, 2));
    assert.match(requestLog, /status: 499/);
    assert.match(requestLog, /requestCancelled: true/);
  } finally {
    socket?.destroy();
    await server.close();
  }
});
