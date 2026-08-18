import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { profileApiTestHooks } from '../src/lib/api.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

test('profile API client sends bearer JSON without caching and refreshes once after 401', async () => {
  const refreshes: boolean[] = [];
  const authorizations: string[] = [];
  let calls = 0;
  const payload = await profileApiTestHooks.requestProfileApi(
    '/profile/shipments',
    { ownerWallet: OWNER },
    {
      fetch: async (input, init) => {
        calls += 1;
        assert.equal(String(input), 'https://api.mons.shop/profile/shipments');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.cache, 'no-store');
        assert.deepEqual(JSON.parse(String(init?.body)), { ownerWallet: OWNER });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('content-type'), 'application/json');
        authorizations.push(headers.get('authorization') || '');
        return calls === 1
          ? Response.json({ ok: false, error: { code: 'unauthenticated', message: 'Expired.' } }, { status: 401 })
          : Response.json({ responseMode: 'shipments', wallet: OWNER, orders: [] });
      },
      getToken: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'cached-token';
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(payload, { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(authorizations, ['Bearer cached-token', 'Bearer fresh-token']);
});

test('profile API client preserves stable error codes and rejects malformed JSON', async () => {
  await assert.rejects(
    profileApiTestHooks.requestProfileApi(
      '/admin/profile',
      { ownerWallet: OWNER },
      {
        fetch: async () => Response.json({
          ok: false,
          error: { code: 'permission-denied', message: 'Admin access denied.', details: { reason: 'wallet' } },
        }, { status: 403 }),
        getToken: async () => 'token',
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => {
      const value = error as { code?: unknown; message?: unknown; details?: unknown };
      return value.code === 'permission-denied' &&
        value.message === 'Admin access denied.' &&
        JSON.stringify(value.details) === JSON.stringify({ reason: 'wallet' });
    },
  );

  await assert.rejects(
    profileApiTestHooks.requestProfileApi(
      '/profile/anonymous-stripe-delivery-history',
      {},
      {
        fetch: async () => new Response('not-json', { status: 200 }),
        getToken: async () => 'token',
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => (error as { code?: unknown }).code === 'unavailable',
  );
});

test('profile API client summary validator accepts only exact shipment summaries', () => {
  const order = {
    dropId: 'card_nft_2',
    deliveryId: 7,
    status: 'ready_to_ship',
    items: [{ kind: 'box', refId: 3 }],
  };
  assert.deepEqual(profileApiTestHooks.profileOrders([order]), [order]);
  assert.equal(profileApiTestHooks.profileOrders([{ ...order, deliveryId: 0 }]), null);
  assert.equal(profileApiTestHooks.profileOrders({}), null);
});

test('migrated profile reads are absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  for (const name of ['getProfile', 'getAdminProfileView', 'getAnonymousStripeDeliveryHistory']) {
    assert.doesNotMatch(functionsSource, new RegExp(`export const ${name}\\b`));
    assert.doesNotMatch(packageJson, new RegExp(`functions:${name}(?:,|\\\")`));
  }
});
