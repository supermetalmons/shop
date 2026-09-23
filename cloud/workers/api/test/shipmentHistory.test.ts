import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1Harness, seedCommerceDocuments, type CommerceD1Harness } from './commerceD1Harness.ts';
import { commerceKeys, D1CommerceRepository, CommerceRepositoryError, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { deliveryOrderSummaryFromDocument } from '../src/deliveryOrderSummaries.ts';
import {
  ADMIN_PROFILE_PATH, ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH, SHIPMENT_PRESENCE_PATH, handleProfileReadRequest, type ProfileReadPath,
} from '../src/profileReads.ts';
import type { ShipmentHistoryCursor } from '../../../../shared/shipmentHistory.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const OTHER = 'So11111111111111111111111111111111111111112';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const ANONYMOUS = 'anonymous:shipment-test';

function seed(harness: CommerceD1Harness, rows: Array<{ id: number; data?: CommerceDocumentData }>): void {
  seedCommerceDocuments(harness, rows.map(({ id, data }) => ({
    key: commerceKeys.deliveryOrder('card_nft_2', String(id)),
    data: { owner: OWNER, status: 'ready_to_ship', items: [{ kind: 'box', refId: id }], createdAt: id, ...data },
  })));
}

async function read(harness: CommerceD1Harness, path: ProfileReadPath, body: unknown,
  overrides: Partial<NonNullable<Parameters<typeof handleProfileReadRequest>[4]>> = {}) {
  return handleProfileReadRequest(new Request(`https://api.mons.shop${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { COMMERCE_DB: harness.db, OPS_DB: {} as D1Database }, path, {}, {
    nowMs: () => 1000,
    loadProfileEmail: async () => undefined,
    resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
    verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'shipment-test' }),
    ...overrides,
  });
}

test('shipment projection preserves summaries and JSON types without private document fields', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [
    { id: 1, data: { processedAt: true, processingAt: '9', createdAt: 0, privateAddress: 'private' } },
    { id: 2, data: { source: 'admin_irl_redeem' } },
    { id: 3, data: { owner: OTHER } },
  ]);
  const repository = new D1CommerceRepository(harness.db);
  const original = await repository.get(commerceKeys.deliveryOrder('card_nft_2', '1'));
  const narrow = await repository.queryDeliveryHistory({ owners: [OWNER] });
  assert.equal(narrow.length, 1);
  assert.equal(narrow[0].data.privateAddress, undefined);
  assert.equal(narrow[0].data.processedAt, true);
  assert.equal(narrow[0].data.processingAt, '9');
  assert.deepEqual(deliveryOrderSummaryFromDocument(narrow[0]), deliveryOrderSummaryFromDocument(original!));
});

test('shipment pages preserve zero, resolve ties, and advance through invalid summary rows', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [
    { id: 1, data: { processedAt: 0, processingAt: 999 } },
    { id: 2, data: { processingAt: 10, createdAt: 99 } },
    { id: 3, data: { processedAt: 10 } },
    { id: 4, data: { processedAt: true, processingAt: 5 } },
    { id: 5, data: { createdAt: 20, deliveryId: 999 } },
  ]);
  const repository = new D1CommerceRepository(harness.db);
  let cursor: ShipmentHistoryCursor | null = null;
  const ids: number[] = [];
  for (let page = 0; page < 5; page += 1) {
    const result = await repository.queryShipmentHistoryPage({ owner: OWNER, limit: 1, ...(cursor ? { startAfter: cursor } : {}) });
    if (page === 0) {
      assert.deepEqual(result.orders, []);
      assert.equal(result.nextCursor?.documentPath, 'drops/card_nft_2/deliveryOrders/5');
    }
    ids.push(...result.orders.map((order) => order.deliveryId));
    cursor = result.nextCursor;
  }
  assert.deepEqual(ids, [3, 2, 4, 1]);
  assert.equal(cursor, null);
  await assert.rejects(repository.queryShipmentHistoryPage({
    owner: OTHER, limit: 1, startAfter: { version: 1, owner: OWNER, sortAtMs: 10, documentPath: 'drops/card_nft_2/deliveryOrders/3' },
  }), /Invalid shipment pagination/);
});

test('all shipment endpoints opt into pagination while legacy responses remain complete', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, Array.from({ length: 52 }, (_, i) => ({ id: i + 1 })));
  seed(harness, [{ id: 100, data: { owner: ANONYMOUS } }, { id: 101, data: { owner: ANONYMOUS } }]);
  for (const [path, body] of [
    [PROFILE_STATE_PATH, {}], [PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }], [ADMIN_PROFILE_PATH, { ownerWallet: OWNER }],
  ] as const) {
    const overrides = path === ADMIN_PROFILE_PATH ? { verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }) } : {};
    const legacy = await read(harness, path, body, overrides);
    assert.equal(legacy.response.status, 200);
    const oldPayload = await legacy.response.json() as any;
    assert.equal('nextCursor' in oldPayload, false);
    assert.equal((oldPayload.orders ?? oldPayload.shipments?.value ?? oldPayload.profile?.orders).length, 52);
    const paged = await read(harness, path, { ...body, shipmentsPage: {} }, overrides);
    const payload = await paged.response.json() as any;
    assert.equal((payload.orders ?? payload.shipments?.value ?? payload.profile?.orders).length, 50);
    assert.equal(payload.nextCursor.owner, OWNER);
  }
  const anonymous = await read(harness, ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, { shipmentsPage: { limit: 1 } });
  const payload = await anonymous.response.json() as any;
  assert.equal(payload.orders[0].deliveryId, 101);
  assert.equal(payload.nextCursor.owner, ANONYMOUS);
});

test('shipment presence checks older sessions and delivery refs independently of page coverage and owner scope', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, Array.from({ length: 52 }, (_, i) => ({ id: i + 1, data: { stripeCheckoutSessionId: `cs_${i + 1}` } })));
  seed(harness, [
    { id: 100, data: { owner: ANONYMOUS, stripeCheckoutSessionId: 'cs_anon' } },
    { id: 101, data: { owner: OTHER, stripeCheckoutSessionId: 'cs_other' } },
    { id: 102, data: { source: 'admin_irl_redeem', stripeCheckoutSessionId: 'cs_admin' } },
  ]);
  const result = await read(harness, SHIPMENT_PRESENCE_PATH, {
    scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: ['cs_1', 'cs_1', 'cs_other', 'cs_admin', 'cs_anon'],
    deliveries: [{ dropId: 'card_nft_2', deliveryId: 1 }, { dropId: 'card_nft_2', deliveryId: 101 }],
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { stripeSessionIds: ['cs_1'], deliveries: [{ dropId: 'card_nft_2', deliveryId: 1 }] });
  const anonymous = await read(harness, SHIPMENT_PRESENCE_PATH, { scope: 'anonymous', stripeSessionIds: ['cs_anon', 'cs_1'] });
  assert.deepEqual(await anonymous.response.json(), { stripeSessionIds: ['cs_anon'], deliveries: [] });
});

test('wallet shipment presence requires a bound wallet session', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [{ id: 1, data: { stripeCheckoutSessionId: 'cs_wallet' } }]);
  const result = await read(harness, SHIPMENT_PRESENCE_PATH, {
    scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: ['cs_wallet'],
  }, {
    resolveD1AuthWalletBinding: async () => ({ wallet: null, reason: 'missing-binding' }),
    createCommerceRepository: (db) => Object.assign(new D1CommerceRepository(db), {
      queryShipmentPresence: async () => assert.fail('Missing wallet binding must prevent shipment reads'),
    }),
  });
  assert.equal(result.response.status, 401);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unauthenticated');
});

test('shipment presence requires a valid expected wallet only for wallet scope', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const body of [
    ...[undefined, null, '', 'not-a-wallet', '1'.repeat(31)].map((expectedWallet) => ({
      scope: 'wallet', expectedWallet, stripeSessionIds: ['cs_wallet'],
    })),
    ...[OWNER, null].map((expectedWallet) => ({
      scope: 'anonymous', expectedWallet, stripeSessionIds: ['cs_anon'],
    })),
  ]) {
    const result = await read(harness, SHIPMENT_PRESENCE_PATH, body, {
      createCommerceRepository: () => assert.fail('Invalid expected wallet must prevent repository access'),
    });
    assert.equal(result.response.status, 400);
  }
});

test('shipment presence rejects a changed wallet binding before reading another wallet', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [{ id: 1, data: { owner: OTHER, stripeCheckoutSessionId: 'cs_target' } }]);
  for (const identity of [{ kind: 'anonymous' as const, authSubject: 'shipment-test' }, { kind: 'staff-wallet' as const, wallet: OTHER }]) {
    const result = await read(harness, SHIPMENT_PRESENCE_PATH, {
      scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: ['cs_target'],
    }, {
      verifyIdentity: async () => identity,
      resolveD1AuthWalletBinding: async () => ({ wallet: OTHER, source: 'binding' }),
      createCommerceRepository: (db) => Object.assign(new D1CommerceRepository(db), {
        queryShipmentPresence: async () => assert.fail('A changed wallet must prevent shipment reads'),
      }),
    });
    assert.equal(result.response.status, 401);
    assert.deepEqual(await result.response.json(), {
      ok: false, error: { code: 'unauthenticated', message: 'Wallet session changed. Sign in again.' },
    });
  }
});

test('shipment presence accepts the matching staff wallet without reading anonymous bindings', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [{ id: 1, data: { owner: ADMIN, stripeCheckoutSessionId: 'cs_staff' } }]);
  const result = await read(harness, SHIPMENT_PRESENCE_PATH, {
    scope: 'wallet', expectedWallet: ADMIN, stripeSessionIds: ['cs_staff'],
  }, {
    verifyIdentity: async () => ({ kind: 'staff-wallet', wallet: ADMIN }),
    resolveD1AuthWalletBinding: async () => assert.fail('Staff identity must not read an anonymous wallet binding'),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { stripeSessionIds: ['cs_staff'], deliveries: [] });
});

test('anonymous shipment presence stays anonymous when the session has a wallet binding', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [
    { id: 1, data: { stripeCheckoutSessionId: 'cs_wallet' } },
    { id: 2, data: { owner: ANONYMOUS, stripeCheckoutSessionId: 'cs_anon' } },
  ]);
  let bindingReads = 0;
  const result = await read(harness, SHIPMENT_PRESENCE_PATH, {
    scope: 'anonymous', stripeSessionIds: ['cs_wallet', 'cs_anon'],
    deliveries: [{ dropId: 'card_nft_2', deliveryId: 1 }, { dropId: 'card_nft_2', deliveryId: 2 }],
  }, {
    resolveD1AuthWalletBinding: async () => {
      bindingReads += 1;
      return { wallet: OWNER, source: 'binding' };
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(bindingReads, 0);
  assert.deepEqual(await result.response.json(), {
    stripeSessionIds: ['cs_anon'], deliveries: [{ dropId: 'card_nft_2', deliveryId: 2 }],
  });
});

test('shipment presence rejects caller-supplied ownership fields before repository access', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const scope of ['wallet', 'anonymous']) {
    for (const field of ['owner', 'ownerWallet']) {
      const result = await read(harness, SHIPMENT_PRESENCE_PATH, {
        scope, ...(scope === 'wallet' ? { expectedWallet: OWNER } : {}), stripeSessionIds: ['cs_other'], [field]: OTHER,
      }, {
        createCommerceRepository: () => assert.fail('Invalid presence request must prevent repository access'),
      });
      assert.equal(result.response.status, 400);
    }
  }
});

test('shipment requests reject invalid limits, cross-owner cursors, and excessive presence selectors', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const shipmentsPage of [{ limit: 0 }, { limit: 101 }, { limit: null }, { cursor: {} }, {
    cursor: { version: 1, owner: OTHER, sortAtMs: 1, documentPath: 'drops/card_nft_2/deliveryOrders/1' },
  }]) {
    const result = await read(harness, PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER, shipmentsPage });
    assert.equal(result.response.status, 400);
  }
  for (const body of [
    { scope: 'wallet', expectedWallet: OWNER }, { scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: null },
    { scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: Array.from({ length: 51 }, (_, i) => `cs_${i}`) },
    { scope: 'wallet', expectedWallet: OWNER, deliveries: [{ dropId: 'card_nft_2', deliveryId: 0 }] },
  ]) assert.equal((await read(harness, SHIPMENT_PRESENCE_PATH, body)).response.status, 400);
  const missingWallet = await read(harness, PROFILE_STATE_PATH, { shipmentsPage: {} }, {
    resolveD1AuthWalletBinding: async () => ({ wallet: null, reason: 'missing-binding' }),
  });
  assert.equal((await missingWallet.response.json() as any).nextCursor, null);
  for (const binding of [OWNER, null]) {
    const state = await read(harness, PROFILE_STATE_PATH, {
      shipmentsPage: { cursor: { version: 1, owner: OTHER, sortAtMs: 1, documentPath: 'drops/card_nft_2/deliveryOrders/1' } },
    }, {
      resolveD1AuthWalletBinding: async () => binding ? { wallet: binding, source: 'binding' } : { wallet: null, reason: 'missing-binding' },
    });
    assert.equal(state.response.status, 400);
  }
  const failing = await read(harness, PROFILE_STATE_PATH, { shipmentsPage: {} }, {
    createCommerceRepository: (db) => Object.assign(new D1CommerceRepository(db), {
      queryShipmentHistoryPage: async () => { throw new CommerceRepositoryError('unavailable', 'Unavailable'); },
    }),
  });
  assert.equal(failing.response.status, 200);
  assert.equal('nextCursor' in (await failing.response.json() as object), false);
});
