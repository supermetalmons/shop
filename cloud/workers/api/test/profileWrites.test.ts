import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  createCommerceD1Harness,
  seedCommerceDocument,
} from './commerceD1Harness.ts';
import {
  PROFILE_ADDRESSES_PATH,
  handleProfileWriteRequest,
  type ProfileWritePath,
} from '../src/profileWrites.ts';
import { setFulfillmentAddress } from '../src/fulfillmentAddressStore.ts';
import type { FulfillmentStoreContext } from '../src/profileWriteCommerce.ts';
import { claimShipStationRateRefresh } from '../src/shipstation/rateStore.ts';
import { transitionFulfillmentShipStationLabelPurchase } from '../src/shipstation/labelStore.ts';
import { createProfileAddressId } from '../../../../shared/profileD1.ts';
import {
  decryptAddressCipherText,
  parseAddressCipherPayload,
} from '../../../../shared/addressCipher.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES } from '../../../../shared/fulfillmentAccess.ts';
import {
  CommerceUnitOfWork,
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceUpdateValue,
} from '../src/commerceRepository.ts';

import {
  OWNER, ADMIN, ADDRESS_VIEWING_ADMIN, OTHER, UID, NOW_MS, ADDRESS_ID, ADDRESS_KEY_PAIR, ADDRESS_SECRET,
  SHIP_FROM, LABEL_PURCHASE_BODY, LABEL_VOID_BODY,
  FULFILLMENT_ORDER_ADDRESS_PATH, FULFILLMENT_ORDER_STATUS_PATH, FULFILLMENT_SHIPSTATION_LABEL_PATH,
  FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, FULFILLMENT_SHIPSTATION_RATES_PATH, FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, d1Dependencies, request, fulfillmentSettings, decodeBase64, encryptedAddress, orderFixture,
} from './profileWriteTestSupport.ts';

const defaultCommerce = createCommerceD1Harness();
after(() => defaultCommerce.database.close());
const env = { COMMERCE_DB: defaultCommerce.db };
const fulfillmentEnv = { ...fulfillmentSettings, ...env };

const ETHEREUM_SHIPSTATION_REQUESTS: Array<[ProfileWritePath, object]> = [
  [FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: '111k_devnet', deliveryId: 7 }],
  [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, { ...LABEL_PURCHASE_BODY, dropId: '111k_devnet' }],
  [FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, { ...LABEL_VOID_BODY, dropId: '111k_devnet' }],
  [FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: '111k_devnet', deliveryId: 7 }],
  [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: '111k_devnet', deliveryId: 7 }],
];

function notificationQueue(send: Queue['send']): Queue {
  return {
    send,
    sendBatch: async (messages) => {
      for (const message of messages) await send(message.body, { contentType: 'json' });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
}

test('profile writes preserve identity failure responses and rejected authentication outcomes', async (context) => {
  for (const expected of [
    {
      kind: 'invalid-token',
      status: 401,
      code: 'unauthenticated',
      message: 'Authentication is required.',
    },
    {
      kind: 'provider-timeout',
      status: 504,
      code: 'deadline-exceeded',
      message: 'Profile request timed out.',
    },
    {
      kind: 'provider-unavailable',
      status: 502,
      code: 'unavailable',
      message: 'Authentication is temporarily unavailable.',
    },
  ] as const) {
    await context.test(expected.kind, async () => {
      const result = await handleProfileWriteRequest(
        request(PROFILE_ADDRESSES_PATH, { encrypted: 'cipher', country: 'US', hint: 'hint' }),
        env,
        PROFILE_ADDRESSES_PATH,
        {},
        {
          nowMs: () => NOW_MS,
          verifyIdentity: async () => { throw new RequestIdentityError(expected.kind); },
          createCommerceRepository: () => assert.fail('Identity failure must not access Commerce'),
          resolveD1AuthWalletBinding: async () => assert.fail('Identity failure must not resolve a wallet'),
          saveProfileAddress: async () => assert.fail('Identity failure must not persist an address'),
          providerFetch: async () => assert.fail('Identity failure must not contact a provider'),
        },
      );
      assert.equal(result.response.status, expected.status);
      assert.deepEqual(await result.response.json(), {
        ok: false,
        error: { code: expected.code, message: expected.message },
      });
      assert.equal(result.authOutcome, 'rejected');
      assert.deepEqual(result.metrics, { upstreamCalls: 0, providerDurationMs: 0 });
    });
  }
});

for (const dropId of ['111k_devnet', 'mi_note_cards_devnet', 'card_nft_binder_devnet']) {
  test(`${dropId} fulfillment writes reject mainnet admin shippers and the address operator before accessing data or providers`, async () => {
    const requests: Array<[ProfileWritePath, object]> = [
      [FULFILLMENT_ORDER_STATUS_PATH, { dropId: '111k_devnet', deliveryId: 7, status: 'Preparing' }],
      [FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: '111k_devnet', deliveryId: 7, full: '100 Main St' }],
      ...ETHEREUM_SHIPSTATION_REQUESTS,
    ];
    for (const wallet of [OWNER, ...MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES, OTHER]) {
      for (const [path, body] of requests) {
        const label = `${wallet}: ${path}`;
        let dataAccesses = 0;
        let providerCalls = 0;
        const db = new Proxy({} as D1Database, {
          get: () => {
            dataAccesses += 1;
            assert.fail('Denied fulfillment must not access data');
          },
        });
        const result = await handleProfileWriteRequest(
          request(path, { ...body, dropId }),
          { ...fulfillmentEnv, COMMERCE_DB: db },
          path,
          {},
          d1Dependencies(async () => {
            providerCalls += 1;
            assert.fail('Denied fulfillment must not contact a provider');
          }, {
            verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet }),
          }),
        );
        assert.equal(result.response.status, 403, label);
        assert.deepEqual(await result.response.json(), {
          ok: false,
          error: { code: 'permission-denied', message: 'Fulfillment access denied.' },
        }, label);
        assert.equal(result.authOutcome, 'rejected', label);
        assert.equal(dataAccesses, 0, label);
        assert.equal(providerCalls, 0, label);
        assert.deepEqual(result.metrics, { upstreamCalls: 0, providerDurationMs: 0 }, label);
      }
    }
  });
}

test('Ethereum ShipStation operations remain disabled for the designated admin before accessing data', async () => {
  for (const [path, body] of ETHEREUM_SHIPSTATION_REQUESTS) {
    let dataAccesses = 0;
    const db = new Proxy({} as D1Database, {
      get: () => {
        dataAccesses += 1;
        assert.fail('Disabled Ethereum ShipStation must not access data');
      },
    });
    const result = await handleProfileWriteRequest(
      request(path, body),
      { ...fulfillmentEnv, COMMERCE_DB: db },
      path,
      {},
      d1Dependencies(async () => assert.fail('Disabled Ethereum ShipStation must not contact a provider'), {
        verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
      }),
    );
    assert.equal(result.response.status, 409, path);
    assert.deepEqual(await result.response.json(), {
      ok: false,
      error: { code: 'failed-precondition', message: 'ShipStation is disabled for Ethereum test orders.' },
    }, path);
    assert.equal(dataAccesses, 0, path);
    assert.deepEqual(result.metrics, { upstreamCalls: 0, providerDurationMs: 0 }, path);
  }
});

test('the designated admin can update Ethereum fulfillment status', async context => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const contractAddress = '0x1111111111111111111111111111111111111111';
  harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, revision = revision + 1,
    paused_at_ms = NULL, chain_id = 31337, contract_address = ?, updated_at_ms = 1000 WHERE singleton = 1`)
    .run(contractAddress);
  const key = commerceKeys.deliveryOrder('111k_devnet', '7');
  seedCommerceDocument(harness, {
    key,
    data: {
      dropId: '111k_devnet',
      source: 'ethereum',
      chainId: 31337,
      contractAddress,
      deliveryId: 7,
      owner: '0x1111111111111111111111111111111111111111',
      status: 'ready_to_ship',
      items: [],
    },
  });
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, { dropId: '111k_devnet', deliveryId: 7, status: 'Preparing' }),
    { COMMERCE_DB: harness.db, ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: contractAddress },
    FULFILLMENT_ORDER_STATUS_PATH,
    {},
    d1Dependencies(async () => assert.fail('Ethereum status update must not contact a provider'), {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { deliveryId: 7, fulfillmentStatus: 'Preparing' });
  const stored = await new D1CommerceRepository(harness.db).get(key);
  assert.equal(stored?.data.fulfillmentStatus, 'Preparing');
  assert.equal(stored?.data.fulfillmentUpdatedBy, ADMIN);
});

for (const maintenance of ['paused', 'scope-mismatch', 'late-pause'] as const) {
  test(`Ethereum fulfillment edits fail with unavailable for ${maintenance}`, async context => {
    for (const [path, body] of [
      [FULFILLMENT_ORDER_STATUS_PATH, { dropId: '111k_devnet', deliveryId: 7, status: 'Preparing' }],
      [FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: '111k_devnet', deliveryId: 7, full: '100 Main St' }],
    ] as const) {
      if (maintenance === 'late-pause' && path === FULFILLMENT_ORDER_ADDRESS_PATH) continue;
      let pauseOnCommit = false;
      const harness = createCommerceD1Harness({ observeCall: (operation) => {
        if (!pauseOnCommit || operation.method !== 'batch' ||
          !operation.statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
        pauseOnCommit = false;
        harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 1,
          paused_at_ms = 1001, revision = revision + 1 WHERE singleton = 1`).run();
      } });
      context.after(() => harness.database.close());
      const contractAddress = '0x1111111111111111111111111111111111111111';
      harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, revision = revision + 1,
        paused_at_ms = NULL, chain_id = 31337, contract_address = ?, updated_at_ms = 1000 WHERE singleton = 1`)
        .run(contractAddress);
      const key = commerceKeys.deliveryOrder('111k_devnet', '7');
      seedCommerceDocument(harness, { key, data: {
        source: 'ethereum', chainId: 31337, contractAddress, deliveryId: 7,
        owner: contractAddress, status: 'ready_to_ship', items: [],
      } });
      const repository = new D1CommerceRepository(harness.db);
      const original = await repository.get(key);
      if (maintenance === 'paused') {
        harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 1,
          paused_at_ms = 1001, revision = revision + 1 WHERE singleton = 1`).run();
      }
      pauseOnCommit = maintenance === 'late-pause';
      const result = await handleProfileWriteRequest(request(path, body), {
        COMMERCE_DB: harness.db, ADDRESS_DECRYPTION_SECRET: ADDRESS_SECRET, ETHEREUM_111K_CHAIN_ID: '31337',
        ETHEREUM_111K_CONTRACT_ADDRESS: maintenance === 'scope-mismatch' ? '0x9999999999999999999999999999999999999999' : contractAddress,
      }, path, {}, d1Dependencies(async () => assert.fail('Paused Ethereum fulfillment must not contact a provider'), {
        verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
      }));
      assert.equal(result.response.status, 503, path);
      assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unavailable');
      assert.deepEqual(await repository.get(key), original);
    }
  });
}

test('address route authenticates and atomically persists the exact D1 profile address', async () => {
  let persisted: Record<string, unknown> | undefined;
  const calls: Array<{ url: URL; authorization: string }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') || '' });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      id: ADDRESS_ID,
      encrypted: 'cipher-text',
      country: 'United States',
      hint: '100…01',
      email: 'owner@example.com',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(providerFetch, {
      autoId: () => assert.fail('client-supplied address id used the server generator'),
      saveProfileAddress: async (_db, address) => {
        persisted = address;
        return {
          id: address.id,
          country: address.country,
          ...(address.countryCode ? { countryCode: address.countryCode } : {}),
          encrypted: address.encrypted,
          hint: address.hint,
          ...(address.email ? { email: address.email } : {}),
        };
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(await result.response.json(), {
    id: ADDRESS_ID,
    country: 'United States',
    countryCode: 'US',
    encrypted: 'cipher-text',
    hint: '100…01',
    email: 'owner@example.com',
  });
  assert.deepEqual(persisted, {
    wallet: OWNER,
    id: ADDRESS_ID,
    country: 'United States',
    countryCode: 'US',
    encrypted: 'cipher-text',
    hint: '100…01',
    email: 'owner@example.com',
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.metrics.upstreamCalls, 0);
  assert.equal(calls.length, 0);
});

test('address route maps D1 failures to a generic unavailable response with one stable auto ID', async () => {
  let autoIds = 0;
  const providerFetch: typeof fetch = async () => {
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      countryCode: 'US',
      hint: 'hint',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(providerFetch, {
      autoId: () => {
        autoIds += 1;
        return ADDRESS_ID;
      },
      saveProfileAddress: async () => {
        throw new Error('private D1 details');
      },
    }),
  );
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Profile data is temporarily unavailable.' },
  });
  assert.equal(autoIds, 1);

  const controller = new AbortController();
  const d1Failure = new Error('D1 write failed first');
  const clientReason = new Error('late client disconnect');
  const raced = await handleProfileWriteRequest(
    new Request(request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      countryCode: 'US',
      hint: 'hint',
    }), { signal: controller.signal }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(providerFetch, {
      saveProfileAddress: () => new Promise((_resolve, reject) => {
        reject(d1Failure);
        controller.abort(clientReason);
      }),
    }),
  );
  assert.equal(raced.response.status, 502);
  assert.equal((await raced.response.json() as { error: { code: string } }).error.code, 'unavailable');
});

test('profile write wallet binding distinguishes cancellation from an earlier D1 failure', async () => {
  const providerFetch: ProfileProviderFetch = async () => Response.json({ error: 'unexpected' }, { status: 500 });
  const body = {
    encrypted: 'cipher-text',
    country: 'US',
    countryCode: 'US',
    hint: 'hint',
  };
  const racedController = new AbortController();
  const d1Failure = new Error('D1 wallet binding failed first');
  const lateReason = new Error('late client disconnect');
  const raced = await handleProfileWriteRequest(
    new Request(request(PROFILE_ADDRESSES_PATH, body), { signal: racedController.signal }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(providerFetch, {
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-user' }),
      resolveD1AuthWalletBinding: () => new Promise<never>((_resolve, reject) => {
        reject(d1Failure);
        setTimeout(() => racedController.abort(lateReason), 0);
      }),
    }),
  );
  assert.equal(raced.response.status, 503);
  assert.equal((await raced.response.json() as { error: { code: string } }).error.code, 'unavailable');

  const cancelledController = new AbortController();
  const cancellation = new Error('client disconnected during wallet binding');
  await assert.rejects(
    handleProfileWriteRequest(
      new Request(request(PROFILE_ADDRESSES_PATH, body), { signal: cancelledController.signal }),
      env,
      PROFILE_ADDRESSES_PATH,
      {},
      d1Dependencies(providerFetch, {
        verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-user' }),
        resolveD1AuthWalletBinding: async () => {
          cancelledController.abort(cancellation);
          throw cancellation;
        },
      }),
    ),
    (error: unknown) => error === cancellation,
  );
});

test('profile write wallet binding enforces the deadline before starting a mutation', async () => {
  let mutationStarts = 0;
  let deferred = 0;
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      hint: 'hint',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(async () => assert.fail('wallet binding deadline reached provider fetch'), {
      defer: () => { deferred += 1; },
      resolveD1AuthWalletBinding: async () => new Promise<never>(() => undefined),
      saveProfileAddress: async () => {
        mutationStarts += 1;
        assert.fail('mutation started after wallet binding deadline');
      },
      timeoutMs: 5,
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-user' }),
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
  assert.equal(mutationStarts, 0);
  assert.equal(deferred, 0);
});

test('address route uses D1 wallet sessions without requesting Commerce authSessions', async () => {
  let providerCalls = 0;
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      id: ADDRESS_ID,
      encrypted: 'cipher-text',
      country: 'United States',
      hint: '100…01',
    }),
    { ...env, OPS_DB: {} as D1Database },
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(async () => {
      providerCalls += 1;
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(providerCalls, 0);
});

test('address route applies the request deadline to D1 persistence', async () => {
  const providerFetch: typeof fetch = async () => {
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      hint: 'hint',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(providerFetch, {
      timeoutMs: 5,
      saveProfileAddress: async (_db, _address, signal) => new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    }),
  );
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('address deadline defers one non-cooperative write and preserves its late completion', async () => {
  let resolveWrite!: (address: {
    id: string;
    country: string;
    encrypted: string;
    hint: string;
  }) => void;
  let starts = 0;
  let completed = false;
  const write = new Promise<{
    id: string;
    country: string;
    encrypted: string;
    hint: string;
  }>((resolve) => {
    resolveWrite = resolve;
  });
  void write.then(() => { completed = true; });
  const deferred: Promise<unknown>[] = [];

  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      hint: 'hint',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(async () => assert.fail('address write reached provider fetch'), {
      defer: (promise) => { deferred.push(promise); },
      saveProfileAddress: async () => {
        starts += 1;
        return write;
      },
      timeoutMs: 5,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
  assert.equal(starts, 1);
  assert.equal(deferred.length, 1);
  assert.equal(completed, false);

  resolveWrite({
    id: ADDRESS_ID,
    country: 'US',
    encrypted: 'cipher-text',
    hint: 'hint',
  });
  await deferred[0];
  assert.equal(completed, true);
  assert.equal(starts, 1);
  assert.equal(deferred.length, 1);
});

test('status route persists its behavior through the current D1 repository', async () => {
  const harness = createCommerceD1Harness();
  const key = commerceKeys.deliveryOrder('card_nft_2', '7');
  seedCommerceDocument(harness, {
    key,
    data: {
      deliveryId: 7,
      fulfillmentTrackingCode: ' https://tracking.example/old ',
      items: [{ kind: 'dude', refId: 1 }],
      owner: OWNER,
      shipstation: {
        labelPurchase: { status: 'idle' },
        rateQuotes: [{ rateId: 'rate-1' }],
      },
      status: 'ready_to_ship',
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  let mutationAttempts = 0;
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Preparing',
    }),
    { COMMERCE_DB: harness.db },
    FULFILLMENT_ORDER_STATUS_PATH,
    {},
    d1Dependencies(async () => assert.fail('D1 status update reached a retired provider'), {
      createCommerceRepository: () => ({
        notificationOutbox: repository.notificationOutbox,
        get: (documentKey) => repository.get(documentKey),
        run: async <T>(nowMs: number, operation: (unit: CommerceUnitOfWork) => Promise<T>) => {
          mutationAttempts += 1;
          if (mutationAttempts === 1) throw new CommerceWriteConflict();
          return repository.run(nowMs, operation);
        },
      }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    fulfillmentStatus: 'Preparing',
    fulfillmentTrackingCode: 'https://tracking.example/old',
  });
  assert.equal(mutationAttempts, 2);
  const stored = await repository.get(key);
  assert.equal(stored?.data.fulfillmentStatus, 'Preparing');
  assert.equal(stored?.data.fulfillmentUpdatedAt, NOW_MS);
  assert.equal(stored?.data.fulfillmentUpdatedBy, OWNER);
  assert.deepEqual(stored?.data.shipstation, {
    labelPurchase: { status: 'idle' },
    rateQuotes: [{ rateId: 'rate-1' }],
  });

  const cleared = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: '',
    }),
    { COMMERCE_DB: harness.db },
    FULFILLMENT_ORDER_STATUS_PATH,
    {},
    d1Dependencies(async () => assert.fail('D1 status update reached a retired provider'), {
      createCommerceRepository: () => repository,
    }),
  );
  assert.equal(cleared.response.status, 200);
  assert.deepEqual(await cleared.response.json(), {
    deliveryId: 7,
    fulfillmentStatus: '',
    fulfillmentTrackingCode: 'https://tracking.example/old',
  });
  const clearedRecord = await repository.get(key);
  assert.equal(Object.hasOwn(clearedRecord?.data || {}, 'fulfillmentStatus'), false);
  assert.deepEqual(clearedRecord?.data.shipstation, stored?.data.shipstation);
});

test('profile-write D1 mutation matrix preserves nested shipment, rates, label, and recovery state', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.deliveryOrder('card_nft_2', '7');
  seedCommerceDocument(harness, {
    key,
    data: {
      deliveryId: 7,
      fulfillmentTrackingCode: 'tracking-old',
      owner: OWNER,
      shipstation: {
        claimId: 'shipment-claim',
        claimedAt: 1,
        customState: { preserved: true },
        label: { labelId: 'label-old', status: 'active' },
        labelPurchase: { requestId: 'purchase-one', status: 'purchased' },
        rateQuotes: [{ rateId: 'rate-old' }],
        rateRequest: { requestHash: 'request-old' },
        ratesClaimId: 'rates-claim',
        ratesClaimedAt: 2,
        shipmentId: 'shipment-old',
      },
      status: 'ready_to_ship',
    },
  });
  const update = (
    nowMs: number,
    values: Record<string, CommerceUpdateValue>,
  ) => repository.run(nowMs, async (unit) => unit.update(key, values));

  await update(NOW_MS, {
    'shipstation.claimId': commerceFieldValue.delete(),
    'shipstation.claimedAt': commerceFieldValue.serverTimestamp(),
    'shipstation.shipmentId': 'shipment-new',
  });
  await update(NOW_MS + 1, {
    'shipstation.rateQuotes': [{
      rateId: 'rate-new',
      shipmentId: 'shipment-new',
      totalAmount: { currency: 'usd', amount: 10 },
    }],
    'shipstation.ratesClaimId': commerceFieldValue.delete(),
    'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
    'shipstation.ratesUpdatedAt': commerceFieldValue.serverTimestamp(),
  });
  await update(NOW_MS + 2, {
    fulfillmentTrackingCode: 'tracking-new',
    'shipstation.label': { labelId: 'label-new', status: 'active' },
    'shipstation.labelPurchase': { requestId: 'purchase-two', status: 'purchased' },
  });
  await update(NOW_MS + 3, {
    fulfillmentTrackingCode: commerceFieldValue.delete(),
    'shipstation.label': { labelId: 'label-new', status: 'voided' },
  });
  await update(NOW_MS + 4, {
    'shipstation.lastErrorAt': commerceFieldValue.serverTimestamp(),
    'shipstation.rateRequest': commerceFieldValue.delete(),
  });

  const stored = await repository.get(key);
  assert.equal(Object.hasOwn(stored?.data || {}, 'fulfillmentTrackingCode'), false);
  assert.deepEqual(stored?.data.shipstation, {
    claimedAt: NOW_MS,
    customState: { preserved: true },
    label: { labelId: 'label-new', status: 'voided' },
    labelPurchase: { requestId: 'purchase-two', status: 'purchased' },
    lastErrorAt: NOW_MS + 4,
    rateQuotes: [{
      rateId: 'rate-new',
      shipmentId: 'shipment-new',
      totalAmount: { currency: 'usd', amount: 10 },
    }],
    ratesUpdatedAt: NOW_MS + 1,
    shipmentId: 'shipment-new',
  });

  const stale = await repository.begin(NOW_MS + 5);
  await stale.get(key);
  await stale.update(key, { 'shipstation.lastError': 'stale' });
  await update(NOW_MS + 6, { 'shipstation.lastError': 'fresh' });
  await assert.rejects(
    stale.commit(),
    (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
  );
  assert.equal(
    ((await repository.get(key))?.data.shipstation as Record<string, unknown>).lastError,
    'fresh',
  );
});

for (const queueFails of [false, true]) {
  test(`shipment status route persists its outbox and returns success when queueFails=${queueFails}`, async (context) => {
    const harness = createCommerceD1Harness();
    context.after(() => harness.database.close());
    const key = commerceKeys.deliveryOrder('card_nft_2', '7');
    seedCommerceDocument(harness, { key, data: {
      owner: OWNER, deliveryId: 7, status: 'ready_to_ship', fulfillmentStatus: 'Preparing',
      addressSnapshot: { email: 'buyer@example.com' }, items: [],
    } });
    const repository = new D1CommerceRepository(harness.db);
    const queued: unknown[] = [];
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_STATUS_PATH, {
        dropId: 'card_nft_2', deliveryId: 7, status: 'Shipped', trackingCode: 'https://tracking.example/new',
      }),
      {
        COMMERCE_DB: harness.db,
        NOTIFICATION_EMAIL_QUEUE: notificationQueue(async (body) => {
          queued.push(body);
          if (queueFails) throw new Error('queue unavailable');
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        }),
      },
      FULFILLMENT_ORDER_STATUS_PATH, {}, d1Dependencies(async () => { throw new Error('Unexpected provider call'); }),
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), {
      buyerOrderShippedEmailState: queueFails ? 'pending' : 'queued',
      deliveryId: 7, fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'https://tracking.example/new',
    });
    assert.equal(queued.length, 1);
    const job = queued[0] as { kind: string; idempotencyKey: string; text: string };
    assert.equal(job.kind, 'buyer_order_shipped');
    assert.equal(job.idempotencyKey, 'card_nft_2:7:order_shipped');
    assert.match(job.text, /Tracking: https:\/\/tracking.example\/new/);
    const stored = await repository.get(key);
    assert.equal(stored?.data.fulfillmentStatus, 'Shipped');
    assert.equal(Object.hasOwn(stored!.data, 'buyerOrderShippedEmailState'), false);
    assert.equal((await repository.notificationOutbox.get(key.path, 'shipped'))?.state, queueFails ? 'pending' : 'queued');
  });
}

test('ShipStation rejects an oversized valid JSON stream before authentication or side effects', async () => {
  const body = JSON.stringify(LABEL_PURCHASE_BODY).padEnd(4097, ' ');
  const chunks = [body.slice(0, 2048), body.slice(2048)];
  let cancelled = false;
  const input = new Request(`https://api.mons.shop${FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const result = await handleProfileWriteRequest(
    input,
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    {
      verifyIdentity: async () => assert.fail('Oversized requests must not authenticate'),
      createCommerceRepository: () => assert.fail('Oversized requests must not access Commerce'),
      providerFetch: async () => assert.fail('Oversized requests must not contact ShipStation'),
    },
  );
  assert.equal(result.response.status, 400);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'invalid-argument', message: 'Invalid request.' },
  });
  assert.equal(result.authOutcome, 'rejected');
  assert.equal(cancelled, true);
});

test('write routes reject invalid payloads, unauthorized wallets, and missing orders without Commerce configuration', async t => {
  const d1Access = t.mock.fn(() => assert.fail('Malformed request accessed D1'));
  const db = new Proxy({} as D1Database, { get: d1Access });
  const malformedEnv = { ...fulfillmentEnv, COMMERCE_DB: db, OPS_DB: db };
  let upstreamCalls = 0;
  const neverFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  for (const body of [
    { encrypted: 'cipher', country: 'US', hint: 'hint', extra: true },
    { id: 'invalid', encrypted: 'cipher', country: 'US', hint: 'hint' },
    { encrypted: 'cipher', country: 'US', hint: 'hint', email: 'not-an-email' },
    { encrypted: 'x'.repeat(11 * 1024), country: 'US', hint: 'hint' },
  ]) {
    const result = await handleProfileWriteRequest(
      request(PROFILE_ADDRESSES_PATH, body),
      malformedEnv,
      PROFILE_ADDRESSES_PATH,
      {},
      d1Dependencies(neverFetch),
    );
    assert.equal(result.response.status, 400);
  }
  for (const [path, body] of [
    [FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'address', extra: true }],
    [FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'x'.repeat(2049) }],
    [FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7, extra: true }],
    [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, { ...LABEL_PURCHASE_BODY, extra: true }],
    [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, { ...LABEL_PURCHASE_BODY, requestId: 'not-a-uuid' }],
    [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, {
      ...LABEL_PURCHASE_BODY,
      expectedTotal: { currency: 'usd', amount: Number.POSITIVE_INFINITY },
    }],
    [FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7, extra: true }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7, extra: true }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7, addressPatch: {} }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { name: ' ' },
    }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { address_line1: 'x'.repeat(51) },
    }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { country_code: 'USA' },
    }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { company_name: 'Private' },
    }],
  ] as const) {
    const result = await handleProfileWriteRequest(
      request(path, body),
      malformedEnv,
      path,
      {},
      d1Dependencies(neverFetch),
    );
    assert.equal(result.response.status, 400);
  }
  assert.equal(d1Access.mock.callCount(), 0);
  assert.equal(upstreamCalls, 0);

  const invalidToken = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, { encrypted: 'cipher', country: 'US', hint: 'hint' }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(neverFetch, {
      verifyIdentity: async () => {
        throw new RequestIdentityError('invalid-token');
      },
    }),
  );
  assert.equal(invalidToken.response.status, 401);
  assert.equal(upstreamCalls, 0);

  const anonymousOnlyStaffWrite = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Preparing',
    }),
    env,
    FULFILLMENT_ORDER_STATUS_PATH,
    {},
    d1Dependencies(neverFetch, {
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(anonymousOnlyStaffWrite.response.status, 401);

  const retiredSecret = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, { encrypted: 'cipher', country: 'US', hint: 'hint' }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(neverFetch),
  );
  assert.equal(retiredSecret.response.status, 200);
  assert.equal(upstreamCalls, 0);

  const deniedOrder = orderFixture(t);
  const before = deniedOrder.read();
  const denied = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, { dropId: 'card_nft_2', deliveryId: 7, status: 'Preparing' }),
    deniedOrder.env,
    FULFILLMENT_ORDER_STATUS_PATH,
    {},
    d1Dependencies(neverFetch, {
      resolveD1AuthWalletBinding: async () => ({ wallet: OTHER, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OTHER }),
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.deepEqual(deniedOrder.read(), before);

  const emptyStore = orderFixture(t, null);
  const missingOrder = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, { dropId: 'card_nft_2', deliveryId: 7, status: 'Preparing' }),
    emptyStore.env,
    FULFILLMENT_ORDER_STATUS_PATH,
    {},
    d1Dependencies(neverFetch),
  );
  assert.equal(missingOrder.response.status, 404);
  assert.equal(upstreamCalls, 0);
});

test('writer failures stay generic and never expose request or credential material', async () => {
  const providerFetch: typeof fetch = async () => assert.fail('Address writes must not contact providers');
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'private-cipher-text',
      country: 'US',
      hint: 'private-hint',
      email: 'private@example.com',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    {},
    d1Dependencies(providerFetch, {
      saveProfileAddress: async () => {
        throw new Error('private D1 writer-secret');
      },
    }),
  );
  assert.equal(result.response.status, 502);
  const text = await result.response.text();
  assert.deepEqual(JSON.parse(text), {
    ok: false,
    error: { code: 'unavailable', message: 'Profile data is temporarily unavailable.' },
  });
  for (const secret of ['private-cipher-text', 'private-hint', 'private@example.com', 'private-writer-credential', 'writer-secret']) {
    assert.equal(text.includes(secret), false);
  }
});


test('generated Commerce auto IDs are cryptographic-compatible document IDs', () => {
  const ids = Array.from({ length: 100 }, createProfileAddressId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[A-Za-z0-9]{20}$/.test(id)));
});

function assertFulfillmentStoreInputTypes(common: FulfillmentStoreContext): void {
  void setFulfillmentAddress({
    common,
    dropId: 'card_nft_binder',
    deliveryId: 1,
    full: 'Delivery address',
    encrypted: 'ciphertext',
    hint: 'Delivery address',
    wallet: OWNER,
    // @ts-expect-error Address persistence cannot apply arbitrary document patches.
    updates: { owner: OTHER },
  });
  void claimShipStationRateRefresh({
    common,
    dropId: 'card_nft_binder',
    deliveryId: 1,
    expected: { shipmentId: 'shipment', labelIdentity: '', purchaseIdentity: '', claimId: null, claimedBy: null },
    claimId: 'claim',
    wallet: OWNER,
    onWriteAttempt: () => undefined,
    // @ts-expect-error Rate claims own their mutation logic inside the store.
    build: () => ({ updates: { owner: OTHER } }),
  });
  void transitionFulfillmentShipStationLabelPurchase({
    common,
    dropId: 'card_nft_binder',
    shipmentId: 'shipment',
    body: { deliveryId: 1, rateId: 'rate', expectedTotal: { currency: 'usd', amount: 1 }, requestId: 'request' },
    message: 'Provider result unavailable',
    wallet: OWNER,
    // @ts-expect-error Failure persistence cannot mark an unconfirmed purchase complete.
    nextStatus: 'complete',
  });
  // @ts-expect-error Persistence contexts do not expose provider calls.
  void common.providerFetch;
}

void assertFulfillmentStoreInputTypes;

test('order fixture observes deletion as a write', async t => {
  const fixture = orderFixture(t);
  const events: string[] = [];
  fixture.afterRead = () => { events.push('read'); };
  fixture.beforeWrite = () => { events.push('beforeWrite'); };
  fixture.afterWrite = () => { events.push('afterWrite'); };
  await fixture.repository.run(NOW_MS, unit => unit.delete(fixture.key));
  assert.deepEqual(events, ['read', 'beforeWrite', 'afterWrite']);
  assert.equal(await fixture.repository.get(fixture.key), null);
});

test('a concurrent fixture patch preserves recovery and advances the order version and timestamp', async t => {
  const receiptRecovery = { pendingSubmission: true };
  const fixture = orderFixture(t, { receiptRecovery });
  await fixture.repository.run(NOW_MS, unit => unit.update(fixture.key, { operatorNote: 'first' }));
  const before = await fixture.repository.getRecoverySnapshot(fixture.key);
  assert.ok(before?.state);
  assert.equal(before.state.receiptRecoveryJson, JSON.stringify(receiptRecovery));

  await fixture.patch({ operatorNote: 'second' });
  const after = await fixture.repository.getRecoverySnapshot(fixture.key);
  assert.ok(after);
  assert.equal(after.order.data.operatorNote, 'second');
  assert.equal(after.order.version, before.order.version + 1);
  assert.equal(after.order.createTime, before.order.createTime);
  assert.ok(Date.parse(after.order.updateTime) > Date.parse(before.order.updateTime));
  assert.deepEqual(after.state, before.state);
});

function writeOrder(
  fixture: ReturnType<typeof orderFixture>,
  path: ProfileWritePath,
  providerFetch: ProfileProviderFetch = async () => assert.fail('Unexpected provider call'),
  body: object = { dropId: 'card_nft_2', deliveryId: 7 },
  overrides: Partial<Parameters<typeof handleProfileWriteRequest>[4]> = {},
) {
  return handleProfileWriteRequest(request(path, body), fixture.env, path, {}, d1Dependencies(providerFetch, overrides));
}

function shipmentFields() {
  return {
    addressSnapshot: {
      encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
      countryCode: 'TR',
    },
    items: [{ kind: 'box', refId: 1 }],
  };
}

test('status edits preserve omitted tracking, replace supplied tracking, and remove cleared fields', async (t) => {
  for (const entry of [
    { body: { status: 'Preparing' }, status: 'Preparing', tracking: 'https://tracking.example/old' },
    { body: { status: 'Shipped', trackingCode: '  https://tracking.example/new  ' }, status: 'Shipped', tracking: 'https://tracking.example/new' },
    { body: { status: 'Shipped', trackingCode: '   ' }, status: 'Shipped', tracking: undefined },
    { body: { status: null }, status: undefined, tracking: 'https://tracking.example/old' },
  ]) {
    const fixture = orderFixture(t, {
      ...(entry.body.status === null ? { fulfillmentStatus: 'Preparing' } : {}),
      fulfillmentTrackingCode: 'https://tracking.example/old',
      sibling: 'keep',
    });
    const result = await writeOrder(fixture, FULFILLMENT_ORDER_STATUS_PATH, undefined, {
      deliveryId: 7, dropId: 'card_nft_2', ...entry.body,
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), {
      deliveryId: 7,
      fulfillmentStatus: entry.status ?? '',
      ...(entry.tracking ? { fulfillmentTrackingCode: entry.tracking } : {}),
    });
    assert.equal(fixture.read().fulfillmentStatus, entry.status);
    assert.equal(fixture.read().fulfillmentTrackingCode, entry.tracking);
    assert.equal(fixture.read().fulfillmentUpdatedBy, OWNER);
    assert.equal(fixture.read().fulfillmentUpdatedAt, NOW_MS);
    assert.equal(fixture.read().sibling, 'keep');
  }
});

for (const wallet of [OWNER, ...MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES]) {
  test(`fulfillment address edits by ${wallet} encrypt the address and clear stale ShipStation rates`, async (t) => {
    const fixture = orderFixture(t, {
      addressSnapshot: { label: 'Home', email: 'owner@example.com', phone: '+15555550123', country: 'United States', countryCode: 'US' },
      shipstation: { rateQuotes: ['old'], ratesClaimId: 'old-claim', ratesClaimedAt: 1, ratesClaimedBy: OTHER, sibling: 'keep' },
    });
    const full = '界'.repeat(2048);
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full }),
      fixture.env,
      FULFILLMENT_ORDER_ADDRESS_PATH,
      {},
      d1Dependencies(async () => assert.fail(), {
        verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet }),
      }),
    );
    assert.equal(result.response.status, 200);
    const payload = await result.response.json() as {
      deliveryId: number;
      address: { encrypted: string; hint: string; full: string; label?: string; email?: string; phone?: string; country?: string; countryCode?: string };
    };
    assert.equal(payload.deliveryId, 7);
    assert.equal(payload.address.full, full);
    assert.equal(payload.address.hint, '界...界界');
    assert.equal(payload.address.label, 'Home');
    assert.equal(payload.address.email, 'owner@example.com');
    assert.equal(payload.address.phone, '+15555550123');
    assert.equal(payload.address.country, 'United States');
    assert.equal(payload.address.countryCode, 'US');
    const cipher = parseAddressCipherPayload(payload.address.encrypted, decodeBase64);
    assert.ok(cipher);
    assert.equal(decryptAddressCipherText(cipher, ADDRESS_KEY_PAIR.secretKey), full);
    assert.deepEqual(fixture.read().addressSnapshot, {
      encrypted: payload.address.encrypted, hint: payload.address.hint, label: 'Home',
      email: 'owner@example.com', phone: '+15555550123', country: 'United States', countryCode: 'US',
    });
    assert.equal(fixture.read().fulfillmentAddressUpdatedBy, wallet);
    assert.equal(fixture.read().fulfillmentAddressUpdatedAt, NOW_MS);
    assert.deepEqual(fixture.station(), { sibling: 'keep' });
  });
}

test('fulfillment address route retries the full read and validation after a Commerce precondition conflict', async (t) => {
  const fixture = orderFixture(t, { addressSnapshot: {}, shipstation: {} });
  let attempts = 0;
  fixture.beforeWrite = () => {
    if (++attempts === 1) return fixture.patch({ addressSnapshot: { label: 'Concurrent label' } });
  };
  const result = await writeOrder(fixture, FULFILLMENT_ORDER_ADDRESS_PATH, undefined, {
    dropId: 'card_nft_2', deliveryId: 7, full: 'Ivan\n100 Main St\nIstanbul, 34000\nTurkey',
  });
  assert.equal(result.response.status, 200);
  assert.equal(attempts, 2);
  assert.equal((await result.response.json() as { address: { label: string } }).address.label, 'Concurrent label');
});

test('fulfillment address route preserves authorization and order-state guards', async (t) => {
  let providerCalls = 0;
  for (const wallet of [ADMIN, OTHER]) {
    const fixture = orderFixture(t);
    fixture.afterRead = () => assert.fail('Unauthorized address edit read Commerce');
    fixture.beforeWrite = () => assert.fail('Unauthorized address edit wrote Commerce');
    const denied = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'address' }),
      fixture.env,
      FULFILLMENT_ORDER_ADDRESS_PATH,
      {},
      d1Dependencies(async () => {
        providerCalls += 1;
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }, {
        resolveD1AuthWalletBinding: async () => ({ wallet, source: 'binding' }),
        verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet }),
      }),
    );
    assert.equal(denied.response.status, 403, wallet);
    assert.deepEqual(await denied.response.json(), {
      ok: false,
      error: {
        code: 'permission-denied',
        message: wallet === ADMIN ? 'Fulfillment address admin access denied.' : 'Fulfillment access denied.',
      },
    }, wallet);
  }
  assert.equal(providerCalls, 0);

  for (const [orderFields, code] of [
    [{ addressSnapshot: {}, shipstation: { shipmentId: 'shipment-1' } }, 'failed-precondition'],
    [{ addressSnapshot: {}, shipstation: { labelPurchase: { status: 'purchasing' } } }, 'aborted'],
    [{
      addressSnapshot: {},
      shipstation: { label: { labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed' } },
    }, 'failed-precondition'],
    [{ addressSnapshot: {}, shipstation: { ratesClaimedAt: NOW_MS - 1000 } }, 'aborted'],
    [{ addressSnapshot: {}, shipstation: { claimedAt: NOW_MS - 1000 } }, 'aborted'],
    [{ addressSnapshot: {}, shipstation: {}, source: 'admin_irl_redeem' }, 'failed-precondition'],
  ] as const) {
    const fixture = orderFixture(t, orderFields);
    const guarded = await writeOrder(fixture, FULFILLMENT_ORDER_ADDRESS_PATH, undefined, {
      dropId: 'card_nft_2', deliveryId: 7, full: 'address',
    });
    assert.equal(guarded.response.status, 409);
    assert.equal((await guarded.response.json() as { error: { code: string } }).error.code, code);
  }
});

test('ShipStation shipment route returns an existing Commerce shipment without calling ShipStation', async (t) => {
  const fixture = orderFixture(t, { shipstation: { shipmentId: 'shipment-1', createdAt: NOW_MS - 5_000 } });
  fixture.beforeWrite = () => assert.fail('Existing shipment was modified');
  const result = await writeOrder(fixture, FULFILLMENT_SHIPSTATION_SHIPMENT_PATH);
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    alreadyAdded: true,
    shipstationAddedAt: NOW_MS - 5_000,
  });
});

test('ShipStation shipment route never cleans up a claim it did not acquire', async (t) => {
  for (const [orderFields, expectedCode] of [
    [{ shipstation: { claimedAt: NOW_MS - 1_000, claimedBy: OTHER } }, 'aborted'],
    [{ shipstation: {}, source: 'admin_irl_redeem' }, 'failed-precondition'],
  ] as const) {
    const fixture = orderFixture(t, orderFields);
    let writes = 0;
    fixture.beforeWrite = () => { writes++; };
    const providerFetch = t.mock.fn(async () => Response.error());
    const result = await writeOrder(fixture, FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, providerFetch);
    assert.equal(result.response.status, 409);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, expectedCode);
    assert.equal(writes, 0);
    assert.equal(providerFetch.mock.callCount(), 0);
    assert.deepEqual(fixture.station(), orderFields.shipstation);
  }
});

test('ShipStation shipment route fails before claiming when provider configuration is missing', async (t) => {
  for (const field of ['SHIPSTATION_API_KEY', 'SHIPSTATION_SHIP_FROM'] as const) {
    const fixture = orderFixture(t);
    fixture.env[field] = '';
    fixture.afterRead = () => assert.fail('Missing configuration reached Commerce');
    fixture.beforeWrite = () => assert.fail('Missing configuration started a claim');
    const result = await writeOrder(fixture, FULFILLMENT_SHIPSTATION_SHIPMENT_PATH);
    assert.equal(result.response.status, 409);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'failed-precondition');
    assert.equal(result.authOutcome, 'provider-failure');
  }
});

test('ShipStation shipment route safely releases a claim after its commit response is lost', async (t) => {
  for (const failure of ['transport', 'conflict'] as const) {
    const fixture = orderFixture(t);
    let lostClaim: unknown;
    fixture.afterWrite = () => {
      fixture.afterWrite = undefined;
      lostClaim = fixture.station().claimId;
      if (failure === 'conflict') throw new CommerceWriteConflict();
      throw new Error('Lost D1 commit acknowledgement');
    };
    let providerCalls = 0;
    const result = await writeOrder(fixture, FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, async () => {
      providerCalls++;
      return Response.error();
    });
    const expected = failure === 'conflict' ? { status: 409, code: 'aborted' } : { status: 500, code: 'internal' };
    assert.equal(result.response.status, expected.status, failure);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, expected.code);
    assert.ok(lostClaim);
    assert.equal(providerCalls, 0);
    assert.equal(fixture.station().claimId, undefined);
    assert.equal(fixture.station().claimFenceId, lostClaim);
  }
});

test('ShipStation shipment route claims, decrypts, creates, and conditionally persists one shipment', async (t) => {
  const fixture = orderFixture(t, {
    addressSnapshot: {
      encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
      countryCode: 'TR',
      email: 'owner@example.com',
      phone: '+905555555555',
    },
    items: [
      { kind: 'box', refId: 1 },
      { kind: 'dude', refId: 2 },
      { kind: 'box', refId: 0 },
      { kind: 'other', refId: 3 },
    ],
    shipstation: { lastError: 'previous' },
  });
  const commits: CommerceDocumentData[] = [];
  fixture.afterWrite = () => { commits.push(fixture.station()); };
  let claimId: unknown;
  let creates = 0;
  let createBody: unknown;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
    if (url.pathname === '/v2/shipments/external_shipment_id/mons-card_nft_2-7') {
      return Response.json({}, { status: 404 });
    }
    if (url.pathname === '/v2/shipments' && init?.method === 'POST') {
      creates++;
      claimId = fixture.station().claimId;
      createBody = JSON.parse(String(init.body));
      return Response.json({
        shipments: [{
          shipment_id: 'shipment-new',
          packages: [{
            weight: { value: 8, unit: 'ounce' },
            dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
          }],
        }],
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      package: { length: 10, width: 8, height: 3, weight: 8 },
    }),
    fixture.env,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-new',
    alreadyAdded: false,
    shipstationAddedAt: NOW_MS,
  });

  assert.equal(creates, 1);
  assert.match(String(claimId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(createBody, {
    shipments: [{
      external_shipment_id: 'mons-card_nft_2-7',
      shipment_number: '7',
      ship_to: {
        name: 'Ivan',
        address_line1: '100 Main St',
        city_locality: 'Istanbul',
        state_province: '',
        postal_code: '34000',
        country_code: 'TR',
        address_residential_indicator: 'yes',
        email: 'owner@example.com',
        phone: '+905555555555',
      },
      ship_from: SHIP_FROM,
      packages: [{
        content_description: 'Printed collectible art card',
        weight: { value: 8, unit: 'ounce' },
        dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
        products: [{
          description: 'Printed collectible art card',
          quantity: 4,
          value: { amount: 14.67, currency: 'usd' },
          weight: { value: 0.2, unit: 'ounce' },
          harmonized_tariff_code: '4911.99',
          country_of_origin: 'US',
          sku: 'card-nft-2',
        }],
      }],
      customs: {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      },
      create_sales_order: true,
      shipment_status: 'pending',
    }],
  });
  assert.equal(commits.length, 2);
  const [claimed, saved] = commits;
  assert.equal(claimed.claimId, claimId);
  assert.equal(claimed.shipmentId, undefined);
  assert.equal(saved.shipmentId, 'shipment-new');
  assert.equal(saved.externalShipmentId, 'mons-card_nft_2-7');
  const updated = await fixture.repository.get(fixture.key);
  assert.ok(updated);
  assert.equal(saved.createdAt, Date.parse(updated.updateTime));
  assert.equal(saved.lastError, undefined);
  assert.equal(saved.claimId, undefined);
  assert.equal(saved.claimedAt, undefined);
  assert.equal(saved.claimedBy, undefined);
});

test('ShipStation shipment route raises an international default parcel above declared net weight', async (t) => {
  const fixture = orderFixture(t, shipmentFields(), 'little_swag_hoodies');
  let createBody: { shipments: Array<Record<string, unknown>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
    if (url.pathname === '/v2/shipments' && init?.method === 'POST') {
      createBody = JSON.parse(String(init.body)) as { shipments: Array<Record<string, unknown>> };
      return Response.json({
        shipments: [{
          shipment_id: 'shipment-new',
          packages: createBody.shipments[0].packages,
        }],
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'little_swag_hoodies',
      deliveryId: 7,
    }),
    fixture.env,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(createBody?.shipments[0].packages, [{
    content_description: 'Printed cotton hooded sweatshirt',
    weight: { value: 25, unit: 'ounce' },
    dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
    products: [{
      description: 'Printed cotton hooded sweatshirt',
      quantity: 1,
      value: { amount: 219, currency: 'usd' },
      weight: { value: 24, unit: 'ounce' },
      harmonized_tariff_code: '6110.20',
      country_of_origin: 'US',
      sku: 'swag-hoodie',
    }],
  }]);
  assert.deepEqual(createBody?.shipments[0].customs, {
    contents: 'merchandise',
    non_delivery: 'return_to_sender',
    terms_of_trade_code: 'dap',
  });
});

function shipStationAddressRouteFixture(full: string, countryCode?: string, country?: string) {
  const harness = createCommerceD1Harness();
  const key = commerceKeys.deliveryOrder('card_nft_2', '7');
  const addressSnapshot = {
    encrypted: encryptedAddress(full),
    ...(countryCode ? { countryCode } : {}),
    ...(country ? { country } : {}),
  };
  seedCommerceDocument(harness, { key, data: {
    owner: OWNER,
    deliveryId: 7,
    status: 'ready_to_ship',
    addressSnapshot,
    items: [{ kind: 'dude', refId: 1 }],
  } });
  const shipments: Array<Record<string, unknown>> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
    assert.equal(url.pathname, '/v2/shipments');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init.body)) as { shipments: Array<Record<string, unknown>> };
    shipments.push(body.shipments[0]);
    return Response.json({ shipments: [{
      shipment_id: 'shipment-international',
      packages: body.shipments[0].packages,
    }] });
  };
  return {
    harness,
    key,
    addressSnapshot,
    shipments,
    repository: new D1CommerceRepository(harness.db),
    run: (addressPatch?: Record<string, string>) => handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
        dropId: 'card_nft_2',
        deliveryId: 7,
        ...(addressPatch ? { addressPatch } : {}),
      }),
      { ...fulfillmentEnv, COMMERCE_DB: harness.db },
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      {},
      d1Dependencies(providerFetch),
    ),
  };
}

test('ShipStation shipment route accepts international address formats and optional fields', async (context) => {
  const scenarios: Array<{
    name: string;
    full: string;
    countryCode?: string;
    country?: string;
    patch?: Record<string, string>;
    expected: Record<string, string>;
  }> = [
    {
      name: 'British country name without a saved ISO code',
      full: 'Alex\n1 Example Road\nLondon, Greater London SW1A 1AA\nUnited Kingdom',
      expected: { city_locality: 'London', state_province: 'Greater London', postal_code: 'SW1A 1AA', country_code: 'GB' },
    },
    {
      name: 'legacy Argentine postcode keeps its alphabetic suffix',
      full: 'Alex\n1 Example Road\nBuenos Aires, Buenos Aires C1425 FQB\nArgentina',
      countryCode: 'AR',
      expected: { city_locality: 'Buenos Aires', state_province: 'Buenos Aires', postal_code: 'C1425 FQB', country_code: 'AR' },
    },
    {
      name: 'legacy Ghana digital address stays in the postcode field',
      full: 'Alex\n1 Example Road\nAccra, Greater Accra GA-183-8164\nGhana',
      countryCode: 'GH',
      expected: { city_locality: 'Accra', state_province: 'Greater Accra', postal_code: 'GA-183-8164', country_code: 'GH' },
    },
    {
      name: 'legacy Saint Kitts and Nevis postcode stays separate from the region',
      full: 'Alex\n1 Example Road\nBasseterre, Saint George Basseterre KN0101\nKN',
      countryCode: 'KN',
      expected: { city_locality: 'Basseterre', state_province: 'Saint George Basseterre', postal_code: 'KN0101', country_code: 'KN' },
    },
    {
      name: 'legacy Saint Lucia postcode retains its prefix and spacing',
      full: 'Alex\n1 Example Road\nCastries, Castries LC03 101\nLC',
      countryCode: 'LC',
      expected: { city_locality: 'Castries', state_province: 'Castries', postal_code: 'LC03 101', country_code: 'LC' },
    },
    {
      name: 'legacy German postcode retains its country prefix',
      full: 'Alex\n1 Example Road\nBerlin, Berlin D-10115\nGermany',
      countryCode: 'DE',
      expected: { city_locality: 'Berlin', state_province: 'Berlin', postal_code: 'D-10115', country_code: 'DE' },
    },
    {
      name: 'alphabetic Bermuda postcode in a legacy locality line',
      full: 'Alex\nPO Box HM 2469\nHamilton, HM GX\nBermuda',
      expected: { address_line1: 'PO Box HM 2469', city_locality: 'Hamilton', state_province: '', postal_code: 'HM GX', country_code: 'BM' },
    },
    {
      name: 'alphabetic Bermuda postcode on a separate line',
      full: 'Alex\nPO Box HM 380\nHamilton\nHM BX\nBermuda',
      expected: { address_line1: 'PO Box HM 380', city_locality: 'Hamilton', state_province: '', postal_code: 'HM BX', country_code: 'BM' },
    },
    {
      name: 'compact Bermuda postcode in a legacy locality line',
      full: 'Alex\nPO Box HM 525\nHamilton, HMCX\nBermuda',
      expected: { address_line1: 'PO Box HM 525', city_locality: 'Hamilton', state_province: '', postal_code: 'HMCX', country_code: 'BM' },
    },
    {
      name: 'German postcode before city without a saved ISO code',
      full: 'Alex\n1 Example Road\n10115 Berlin\nGermany',
      expected: { city_locality: 'Berlin', state_province: '', postal_code: '10115', country_code: 'DE' },
    },
    {
      name: 'edited country overrides a stale country name when the saved code is absent',
      full: 'Alex\n1 Example Road\nBerlin, 10115\nDE',
      country: 'France',
      expected: { city_locality: 'Berlin', state_province: '', postal_code: '10115', country_code: 'DE' },
    },
    {
      name: 'edited country overrides a stale country name when the saved code is invalid',
      full: 'Alex\n1 Example Road\nBerlin, 10115\nDE',
      countryCode: 'INTL',
      country: 'France',
      expected: { city_locality: 'Berlin', state_province: '', postal_code: '10115', country_code: 'DE' },
    },
    {
      name: 'a valid saved country code retains precedence',
      full: 'Alex\n1 Example Road\nBerlin, 10115\nDE',
      countryCode: 'FR',
      country: 'France',
      expected: { city_locality: 'Berlin', state_province: '', postal_code: '10115', country_code: 'FR' },
    },
    {
      name: 'stored country name remains a fallback for unresolved address text',
      full: 'Alex\n1 Example Road\nParis, 75001\nOther (International)',
      countryCode: 'INTL',
      country: 'France',
      expected: { city_locality: 'Paris', state_province: '', postal_code: '75001', country_code: 'FR' },
    },
    {
      name: 'legacy comma-containing Irish region',
      full: 'Alex\n1 Example Road\nDublin, Dublin, Leinster D02 X285\nIreland',
      expected: { city_locality: 'Dublin', state_province: 'Dublin, Leinster', postal_code: 'D02 X285', country_code: 'IE' },
    },
    {
      name: 'legacy abbreviated Swiss region',
      full: 'Alex\n1 Example Road\nZürich, Zürich, ZH 8001\nSwitzerland',
      expected: { city_locality: 'Zürich', state_province: 'Zürich, ZH', postal_code: '8001', country_code: 'CH' },
    },
    {
      name: 'legacy abbreviated Brazilian region',
      full: 'Alex\n1 Example Road\nSão Paulo, São Paulo, SP 01310-100\nBrazil',
      expected: { city_locality: 'São Paulo', state_province: 'São Paulo, SP', postal_code: '01310-100', country_code: 'BR' },
    },
    {
      name: 'legacy abbreviated region outside the country postal patterns',
      full: 'Alex\n1 Example Road\nTijuana, Baja California, BC 22000\nMexico',
      expected: { city_locality: 'Tijuana', state_province: 'Baja California, BC', postal_code: '22000', country_code: 'MX' },
    },
    {
      name: 'legacy Italian province abbreviation preserves the leading-zero postcode',
      full: 'Alex\n1 Example Road\nRome, Lazio, RM 00100\nItaly',
      expected: { city_locality: 'Rome', state_province: 'Lazio, RM', postal_code: '00100', country_code: 'IT' },
    },
    {
      name: 'legacy split numeric postcode with repeated whitespace',
      full: 'Alex\n1 Example Road\nBeirut, Beirut 1107  \t2809\nLebanon',
      expected: { city_locality: 'Beirut', state_province: 'Beirut', postal_code: '1107 2809', country_code: 'LB' },
    },
    {
      name: 'legacy split numeric postcode outside the country pattern table',
      full: 'Alex\n1 Example Road\nAthens, Attica 105  \t58\nGreece',
      expected: { city_locality: 'Athens', state_province: 'Attica', postal_code: '105 58', country_code: 'GR' },
    },
    {
      name: 'separate split postcode keeps the preceding city out of the street address',
      full: 'Alex\n1 Example Road\nAthens\n105 58\nGreece',
      expected: { city_locality: 'Athens', state_province: '', postal_code: '105 58', country_code: 'GR' },
    },
    {
      name: 'Argentine numeric city without a postcode',
      full: 'Alex\n1 Example Road\n9 de Julio\nArgentina',
      expected: { city_locality: '9 de Julio', state_province: '', postal_code: '', country_code: 'AR' },
    },
    {
      name: 'Irish postcode with repeated whitespace',
      full: 'Alex\n1 Example Road\nDublin, , D02  X285\nIreland',
      expected: { city_locality: 'Dublin', state_province: '', postal_code: 'D02 X285', country_code: 'IE' },
    },
    {
      name: 'Hong Kong without postcode',
      full: 'Alex\n1 Example Road\nHong Kong, Kowloon\nHong Kong',
      countryCode: 'HK',
      expected: { city_locality: 'Hong Kong', state_province: 'Kowloon', postal_code: '', country_code: 'HK' },
    },
    {
      name: 'legacy nonzero placeholder stays separate from the region without a correction patch',
      full: 'Alex\n1 Example Road\nHong Kong, Kowloon 999077\nHong Kong',
      countryCode: 'HK',
      expected: { city_locality: 'Hong Kong', state_province: 'Kowloon', postal_code: '999077', country_code: 'HK' },
    },
    {
      name: 'legacy placeholder postcode and region can be corrected',
      full: 'Alex\n1 Example Road\nHong Kong, Kowloon 999077\nHong Kong',
      countryCode: 'HK',
      patch: { state_province: 'Kowloon', postal_code: '' },
      expected: { city_locality: 'Hong Kong', state_province: 'Kowloon', postal_code: '', country_code: 'HK' },
    },
    {
      name: 'optional region can be cleared',
      full: 'Alex\n1 Example Road\nLondon, Greater London SW1A 1AA\nUnited Kingdom',
      countryCode: 'GB',
      patch: { state_province: '' },
      expected: { city_locality: 'London', state_province: '', postal_code: 'SW1A 1AA', country_code: 'GB' },
    },
    {
      name: 'both optional region and postcode can be cleared',
      full: 'Alex\n1 Example Road\nDublin, Dublin D02 X285\nIreland',
      countryCode: 'IE',
      patch: { state_province: '', postal_code: '' },
      expected: { city_locality: 'Dublin', state_province: '', postal_code: '', country_code: 'IE' },
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async (subtest) => {
      const fixture = shipStationAddressRouteFixture(scenario.full, scenario.countryCode, scenario.country);
      subtest.after(() => fixture.harness.database.close());
      const result = await fixture.run(scenario.patch);
      assert.equal(result.response.status, 200, JSON.stringify(await result.response.json()));
      assert.equal(fixture.shipments.length, 1);
      assert.deepEqual(fixture.shipments[0].ship_to, {
        name: 'Alex',
        address_line1: '1 Example Road',
        ...scenario.expected,
        address_residential_indicator: 'yes',
      });
      assert.deepEqual(fixture.shipments[0].customs, {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      });
      const stored = await fixture.repository.get(fixture.key);
      assert.deepEqual(stored?.data.addressSnapshot, fixture.addressSnapshot);
      assert.equal((stored?.data.shipstation as Record<string, unknown>).shipmentId, 'shipment-international');
    });
  }
});

test('ShipStation explicit country corrections override saved codes and address text', async (context) => {
  const fixture = shipStationAddressRouteFixture('Alex\n1 Example Road\nBerlin, 10115\nDE', 'FR', 'France');
  context.after(() => fixture.harness.database.close());
  const result = await fixture.run({
    country_code: 'US', city_locality: 'Pittsburgh', state_province: 'PA', postal_code: '15222',
  });
  assert.equal(result.response.status, 200, JSON.stringify(await result.response.json()));
  assert.deepEqual(fixture.shipments[0].ship_to, {
    name: 'Alex', address_line1: '1 Example Road', city_locality: 'Pittsburgh', state_province: 'PA',
    postal_code: '15222', country_code: 'US', address_residential_indicator: 'yes',
  });
  assert.equal(Object.hasOwn(fixture.shipments[0], 'customs'), false);
  const stored = await fixture.repository.get(fixture.key);
  assert.deepEqual(stored?.data.addressSnapshot, fixture.addressSnapshot);
});

test('ShipStation shipment route requires confirmation of ambiguous numeric city names', async (context) => {
  for (const [country, city] of [['EG', '6th of October']]) {
    await context.test(city, async (subtest) => {
      const fixture = shipStationAddressRouteFixture(`Alex\n1 Example Road\n${city}\n${country}`, country);
      subtest.after(() => fixture.harness.database.close());
      const rejected = await fixture.run();
      assert.equal(rejected.response.status, 409);
      const payload = await rejected.response.json() as { error: { details: { kind: string; fields: string[] } } };
      assert.deepEqual(payload.error.details, { kind: 'shipstation-address-correction', fields: ['city_locality'] });
      assert.equal(fixture.shipments.length, 0);

      const corrected = await fixture.run({ city_locality: city });
      assert.equal(corrected.response.status, 200, JSON.stringify(await corrected.response.json()));
      assert.equal(fixture.shipments.length, 1);
      assert.deepEqual(fixture.shipments[0].ship_to, {
        name: 'Alex',
        address_line1: '1 Example Road',
        city_locality: city,
        state_province: '',
        postal_code: '',
        country_code: country,
        address_residential_indicator: 'yes',
      });
      const stored = await fixture.repository.get(fixture.key);
      assert.deepEqual(stored?.data.addressSnapshot, fixture.addressSnapshot);
    });
  }
});

test('ShipStation shipment route lets an operator repair a legacy international country before creating a shipment', async (context) => {
  const fixture = shipStationAddressRouteFixture(
    'Alex\n1 Example Road\nBerlin, Berlin 10115\nOther (International)',
    'INTL',
  );
  context.after(() => fixture.harness.database.close());
  const rejected = await fixture.run();
  assert.equal(rejected.response.status, 409);
  const payload = await rejected.response.json() as {
    error: { code: string; details: { kind: string; fields: string[] } };
  };
  assert.equal(payload.error.code, 'failed-precondition');
  assert.deepEqual(payload.error.details, { kind: 'shipstation-address-correction', fields: ['country_code'] });
  assert.doesNotMatch(JSON.stringify(payload), /Alex|Example Road|Berlin/);
  assert.equal(fixture.shipments.length, 0);
  const released = await fixture.repository.get(fixture.key);
  assert.equal((released?.data.shipstation as Record<string, unknown>).claimId, undefined);

  const corrected = await fixture.run({ country_code: 'de' });
  assert.equal(corrected.response.status, 200, JSON.stringify(await corrected.response.json()));
  assert.equal(fixture.shipments.length, 1);
  assert.deepEqual(fixture.shipments[0].ship_to, {
    name: 'Alex',
    address_line1: '1 Example Road',
    city_locality: 'Berlin',
    state_province: 'Berlin',
    postal_code: '10115',
    country_code: 'DE',
    address_residential_indicator: 'yes',
  });
  assert.ok(fixture.shipments[0].customs);
  const stored = await fixture.repository.get(fixture.key);
  assert.deepEqual(stored?.data.addressSnapshot, fixture.addressSnapshot);
});

test('ShipStation shipment route still requires a US postal code and exposes a repairable field', async (context) => {
  const fixture = shipStationAddressRouteFixture('Alex\n1 Example Road\nPittsburgh, PA\nUnited States', 'US');
  context.after(() => fixture.harness.database.close());
  const rejected = await fixture.run();
  assert.equal(rejected.response.status, 409);
  const payload = await rejected.response.json() as { error: { details: { kind: string; fields: string[] } } };
  assert.deepEqual(payload.error.details, { kind: 'shipstation-address-correction', fields: ['postal_code'] });
  assert.equal(fixture.shipments.length, 0);
  const corrected = await fixture.run({ postal_code: '15222' });
  assert.equal(corrected.response.status, 200, JSON.stringify(await corrected.response.json()));
  assert.equal(fixture.shipments.length, 1);
  assert.deepEqual(fixture.shipments[0].ship_to, {
    name: 'Alex',
    address_line1: '1 Example Road',
    city_locality: 'Pittsburgh',
    state_province: 'PA',
    postal_code: '15222',
    country_code: 'US',
    address_residential_indicator: 'yes',
  });
  assert.equal(Object.hasOwn(fixture.shipments[0], 'customs'), false);
});

test('ShipStation shipment route retains its claim when final persistence conflicts after creation', async (t) => {
  const fixture = orderFixture(t, shipmentFields());
  let persistenceAttempts = 0;
  const update = CommerceUnitOfWork.prototype.update;
  t.mock.method(CommerceUnitOfWork.prototype, 'update', async function (
    this: CommerceUnitOfWork, key: CommerceDocumentKey, values: Readonly<Record<string, CommerceUpdateValue>>,
  ) {
    if (values['shipstation.shipmentId'] === 'shipment-new') await fixture.patch({ concurrent: ++persistenceAttempts });
    return update.call(this, key, values);
  });
  let creates = 0;
  let claimAtCreate: unknown;
  const result = await writeOrder(fixture, FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, async (input, init) => {
    if (String(input).includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
    assert.equal(init?.method, 'POST');
    creates++;
    claimAtCreate = fixture.station().claimId;
    return Response.json({ shipments: [{ shipment_id: 'shipment-new', packages: [] }] });
  }, undefined, { timeoutMs: 10_000 });
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(creates, 1);
  assert.equal(persistenceAttempts, 6);
  assert.ok(claimAtCreate);
  assert.equal(fixture.station().claimId, claimAtCreate);
  assert.equal(fixture.station().claimedBy, OWNER);
  assert.ok(fixture.station().lastError);
});

test('ShipStation shipment route adopts an external-id match without creating a duplicate', async (t) => {
  const fixture = orderFixture(t, { shipstation: { claimedAt: NOW_MS - 120_001, claimedBy: OTHER } });
  let mutationCalls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/v2/shipments/external_shipment_id/mons-card_nft_2-7');
    if (init?.method && init.method !== 'GET') mutationCalls += 1;
    return Response.json({
      shipment: {
        shipment_id: 'shipment-adopted',
        shipment_status: 'pending',
        packages: [{
          weight: { value: 12, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
        }],
      },
    });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      package: { length: 10, width: 8, height: 3, weight: 8 },
      addressPatch: { state_province: 'PA' },
    }),
    fixture.env,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-adopted',
    alreadyAdded: true,
    shipstationAddedAt: NOW_MS,
  });
  assert.equal(mutationCalls, 0);
});

test('ShipStation shipment route retains only its own claim after an ambiguous create failure', async (t) => {
  for (const replacement of [undefined, { claimId: 'replacement-claim', claimedBy: OTHER, claimedAt: NOW_MS }]) {
    const fixture = orderFixture(t, shipmentFields());
    let claim: unknown;
    let creates = 0;
    let cleanupWrites = 0;
    const providerFetch: typeof fetch = async (input) => {
      if (String(input).includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
      creates++;
      claim = fixture.station().claimId;
      if (replacement) await fixture.patch({ shipstation: replacement });
      fixture.beforeWrite = () => { cleanupWrites++; };
      throw new Error('network failed after sending a private address');
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fixture.env,
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      {},
      d1Dependencies(providerFetch),
    );
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'aborted');
    assert.doesNotMatch(payload.error.message, /100 Main St|private address/);
    assert.equal(creates, 1);
    assert.ok(claim);
    assert.equal(cleanupWrites, replacement ? 0 : 1);
    if (replacement) {
      assert.deepEqual(fixture.station(), replacement);
      continue;
    }
    const retained = fixture.station();
    assert.equal(retained.claimId, claim);
    assert.equal(retained.claimedBy, OWNER);
    assert.equal(retained.lastError, 'Could not reach ShipStation');
    const updated = await fixture.repository.get(fixture.key);
    assert.ok(updated);
    assert.equal(retained.claimedAt, Date.parse(updated.updateTime));
  }
});

test('ShipStation shipment disconnect retains its ambiguity claim before rethrowing cancellation', async (t) => {
  const fixture = orderFixture(t, shipmentFields());
  const client = new AbortController();
  const reason = new DOMException('Client disconnected', 'AbortError');
  let claimAtPost: CommerceDocumentData | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
    assert.equal(init?.method, 'POST');
    claimAtPost = fixture.station();
    client.abort(reason);
    throw init?.signal?.reason ?? reason;
  };
  const disconnectedRequest = new Request(
    `https://api.mons.shop${FULFILLMENT_SHIPSTATION_SHIPMENT_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify({ dropId: 'card_nft_2', deliveryId: 7 }),
      signal: client.signal,
    },
  );

  await assert.rejects(
    handleProfileWriteRequest(
      disconnectedRequest,
      fixture.env,
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      {},
      d1Dependencies(providerFetch),
    ),
    (error) => error === reason,
  );
  assert.ok(claimAtPost && typeof claimAtPost.claimId === 'string' && claimAtPost.claimId.length > 0);
  const retained = fixture.station();
  assert.equal(retained.claimId, claimAtPost.claimId);
  assert.equal(retained.claimedBy, OWNER);
  assert.ok(typeof claimAtPost.claimedAt === 'number' && typeof retained.claimedAt === 'number' && retained.claimedAt > claimAtPost.claimedAt);
  assert.ok(retained.lastError);
});

test('ShipStation shipment route releases its claim after a definitive provider rejection', async (t) => {
  const fixture = orderFixture(t, shipmentFields());
  let claim: unknown;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    claim = fixture.station().claimId;
    if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
    return Response.json({
      errors: [{ error_code: 'invalid_address', message: 'Ivan, 100 Main St' }],
    }, { status: 400 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fixture.env,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as {
    error: { code: string; message: string; details?: { kind: string; fields: string[] } };
  };
  assert.equal(payload.error.code, 'failed-precondition');
  assert.match(payload.error.message, /invalid_address/);
  assert.doesNotMatch(payload.error.message, /100 Main St/);
  assert.deepEqual(payload.error.details, {
    kind: 'shipstation-address-correction',
    fields: [
      'name',
      'address_line1',
      'address_line2',
      'address_line3',
      'city_locality',
      'state_province',
      'postal_code',
      'country_code',
    ],
  });
  assert.ok(claim);
  assert.equal(fixture.station().claimFenceId, claim);
  assert.equal(fixture.station().claimId, undefined);
  assert.equal(fixture.station().claimedAt, undefined);
});

test('the new admin can correct a ShipStation address temporarily after rejection without editing the saved address', async (t) => {
  const fixture = orderFixture(t, {
    addressSnapshot: {
      encrypted: encryptedAddress('Ivan\n100 Main St\nSuite 4\nIstanbul, 34000\nTurkey'),
      countryCode: 'TR',
      email: 'owner@example.com',
      phone: '+905555555555',
    },
    items: [{ kind: 'box', refId: 1 }],
  });
  const initialAddress = fixture.read().addressSnapshot;
  let createCalls = 0;
  let correctedCreateBody: { shipments: Array<Record<string, unknown>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
    if (url.pathname === '/v2/shipments' && init?.method === 'POST') {
      createCalls += 1;
      if (createCalls === 1) {
        return Response.json({
          errors: [{
            error_code: 'unspecified',
            field_name: 'state_province',
            field_value: 'Private subdivision',
            message: 'Ivan at 100 Main St',
          }],
        }, { status: 500 });
      }
      correctedCreateBody = JSON.parse(String(init.body)) as { shipments: Array<Record<string, unknown>> };
      return Response.json({
        shipments: [{
          shipment_id: 'shipment-corrected',
          packages: correctedCreateBody.shipments[0].packages,
        }],
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const run = (body: Record<string, unknown>) => handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, body),
    fixture.env,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    {},
    d1Dependencies(providerFetch, {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADDRESS_VIEWING_ADMIN }),
    }),
  );

  const rejected = await run({ dropId: 'card_nft_2', deliveryId: 7 });
  assert.equal(rejected.response.status, 409);
  const rejectedPayload = await rejected.response.json() as {
    error: { message: string; details?: { kind: string; fields: string[] } };
  };
  assert.deepEqual(rejectedPayload.error.details, {
    kind: 'shipstation-address-correction',
    fields: ['state_province'],
  });
  assert.doesNotMatch(JSON.stringify(rejectedPayload), /Private subdivision|100 Main St/);
  assert.equal(fixture.station().claimId, undefined);

  const corrected = await run({
    dropId: 'card_nft_2',
    deliveryId: 7,
    addressPatch: { address_line2: '   ', state_province: ' PA ', country_code: ' us ' },
  });
  assert.equal(corrected.response.status, 200);
  assert.deepEqual(await corrected.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-corrected',
    alreadyAdded: false,
    shipstationAddedAt: NOW_MS,
  });
  assert.equal(createCalls, 2);
  const shipment = correctedCreateBody?.shipments[0];
  assert.deepEqual(shipment?.ship_to, {
    name: 'Ivan',
    address_line1: '100 Main St',
    city_locality: 'Istanbul',
    state_province: 'PA',
    postal_code: '34000',
    country_code: 'US',
    address_residential_indicator: 'yes',
    email: 'owner@example.com',
    phone: '+905555555555',
  });
  assert.equal(Object.hasOwn(shipment ?? {}, 'customs'), false);
  assert.equal(fixture.station().claimId, undefined);
  assert.deepEqual(fixture.read().addressSnapshot, initialAddress);
});

test('ShipStation shipment route preserves its sanitized provider error when claim cleanup fails', async (t) => {
  const fixture = orderFixture(t, shipmentFields());
  let cleanupAttempts = 0;
  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logged.push(values.map(String).join(' '));
  try {
    const result = await writeOrder(fixture, FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, async (input) => {
      if (String(input).includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
      fixture.beforeWrite = () => {
        cleanupAttempts++;
        throw new Error('Storage unavailable');
      };
      return Response.json({
        errors: [{ error_code: 'invalid_address', message: 'Ivan, 100 Main St' }],
      }, { status: 400 });
    });
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'failed-precondition');
    assert.match(payload.error.message, /invalid_address/);
    assert.doesNotMatch(payload.error.message, /100 Main St/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(cleanupAttempts, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /fulfillment_shipstation_shipment_claim_transition_failed/);
  assert.doesNotMatch(logged[0], /100 Main St/);
});
