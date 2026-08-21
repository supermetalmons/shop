import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decommissionFirebaseRevealDudes,
} from '../scripts/decommission-firebase-reveal-dudes.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const BOX_ASSET = '11111111111111111111111111111112';
const PENDING = '11111111111111111111111111111113';
const CURRENT = {
  apiVersionId: '11111111-1111-4111-8111-111111111111',
  frontendVersionId: '22222222-2222-4222-8222-222222222222',
};

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLOUDFLARE_API_TOKEN: 'cloudflare-token',
    HELIUS_API_KEY: 'helius-key',
    REVEAL_DUDES_SMOKE_FIREBASE_TOKEN: 'firebase-token',
    REVEAL_DUDES_SMOKE_OWNER: OWNER,
    SAFE_VALUE: 'preserved',
    ...overrides,
  };
}

function smokeResponse(overrides: Record<string, unknown> = {}, status = 404): Response {
  return Response.json({
    error: {
      code: 'not-found',
      message: 'Pending open not found. Start opening the box first, then reveal.',
      details: { pending: PENDING, boxAssetId: BOX_ASSET },
      ...overrides,
    },
  }, {
    status,
    headers: {
      'Access-Control-Allow-Origin': 'https://mons.shop',
      'Cache-Control': 'no-store',
    },
  });
}

test('reveal decommission verifies production, performs authenticated negative smoke, and strips credentials', async () => {
  let deleted = false;
  await decommissionFirebaseRevealDudes(environment(), {
    readManifest: () => ({ currentProduction: CURRENT, approvedRollback: CURRENT }),
    readLivePair: (wranglerEnvironment) => {
      assert.equal(wranglerEnvironment.CLOUDFLARE_API_TOKEN, 'cloudflare-token');
      assert.equal(wranglerEnvironment.WRANGLER_LOG_SANITIZE, 'true');
      return CURRENT;
    },
    randomBoxAssetId: () => BOX_ASSET,
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/boxes/reveal');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'manual');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer firebase-token');
      assert.equal(headers.get('origin'), 'https://mons.shop');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: OWNER,
        boxAssetId: BOX_ASSET,
        dropId: 'clear_cards_devnet_v2',
      });
      return smokeResponse();
    },
    runFirebaseDelete: (childEnvironment) => {
      deleted = true;
      assert.equal(childEnvironment.SAFE_VALUE, 'preserved');
      assert.equal(childEnvironment.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(childEnvironment.HELIUS_API_KEY, undefined);
      assert.equal(childEnvironment.REVEAL_DUDES_SMOKE_FIREBASE_TOKEN, undefined);
      assert.equal(childEnvironment.REVEAL_DUDES_SMOKE_OWNER, undefined);
      assert.equal(Object.keys(childEnvironment).some((name) => name.startsWith('WRANGLER_')), false);
    },
  });
  assert.equal(deleted, true);
});

test('reveal decommission rejects missing or invalid smoke credentials before production checks', async () => {
  let reads = 0;
  const dependencies = {
    readManifest: () => {
      reads += 1;
      return { currentProduction: CURRENT, approvedRollback: CURRENT };
    },
  };
  await assert.rejects(
    decommissionFirebaseRevealDudes(environment({ REVEAL_DUDES_SMOKE_FIREBASE_TOKEN: '' }), dependencies),
    /REVEAL_DUDES_SMOKE_FIREBASE_TOKEN is required/,
  );
  await assert.rejects(
    decommissionFirebaseRevealDudes(environment({ REVEAL_DUDES_SMOKE_OWNER: 'invalid' }), dependencies),
    /REVEAL_DUDES_SMOKE_OWNER must be a valid wallet/,
  );
  assert.equal(reads, 0);
});

test('reveal decommission rejects incompatible rollback metadata before live reads or smoke', async () => {
  let liveReads = 0;
  let fetches = 0;
  await assert.rejects(
    decommissionFirebaseRevealDudes(environment(), {
      readManifest: () => ({
        currentProduction: CURRENT,
        approvedRollback: { ...CURRENT, apiVersionId: '33333333-3333-4333-8333-333333333333' },
      }),
      readLivePair: () => {
        liveReads += 1;
        return CURRENT;
      },
      fetch: async () => {
        fetches += 1;
        return smokeResponse();
      },
    }),
    /Approved rollback still references a pre-cutover release pair/,
  );
  assert.equal(liveReads, 0);
  assert.equal(fetches, 0);
});

test('reveal decommission rejects live release drift before smoke or deletion', async () => {
  let fetches = 0;
  let deletions = 0;
  await assert.rejects(
    decommissionFirebaseRevealDudes(environment(), {
      readManifest: () => ({ currentProduction: CURRENT, approvedRollback: CURRENT }),
      readLivePair: () => ({ ...CURRENT, frontendVersionId: '44444444-4444-4444-8444-444444444444' }),
      fetch: async () => {
        fetches += 1;
        return smokeResponse();
      },
      runFirebaseDelete: () => {
        deletions += 1;
      },
    }),
    /Live Cloudflare production does not match the tracked release pair/,
  );
  assert.equal(fetches, 0);
  assert.equal(deletions, 0);
});

test('reveal decommission fails closed on any unexpected smoke response', async () => {
  for (const response of [
    smokeResponse({ code: 'unavailable' }, 503),
    smokeResponse({ message: 'changed' }),
    smokeResponse({ details: { pending: PENDING, boxAssetId: OWNER } }),
    Response.json({ error: { code: 'not-found' } }, { status: 404 }),
  ]) {
    let deleted = false;
    await assert.rejects(
      decommissionFirebaseRevealDudes(environment(), {
        readManifest: () => ({ currentProduction: CURRENT, approvedRollback: CURRENT }),
        readLivePair: () => CURRENT,
        randomBoxAssetId: () => BOX_ASSET,
        fetch: async () => response,
        runFirebaseDelete: () => {
          deleted = true;
        },
      }),
      /Authenticated reveal smoke returned an unexpected response/,
    );
    assert.equal(deleted, false);
  }
});
