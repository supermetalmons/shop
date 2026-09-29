import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1Harness, seedCommerceDocuments, type CommerceD1Harness } from './commerceD1Harness.ts';
import { commerceKeys, D1CommerceRepository, CommerceRepositoryError, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { deliveryOrderSummaryFromDocument } from '../src/deliveryOrderSummaries.ts';
import {
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH, SHIPMENT_PRESENCE_PATH, handleProfileReadRequest, type ProfileReadPath,
} from '../src/profileReads.ts';
import { ADMIN_PROFILE_PATH, handleStaffReadRequest } from '../src/staffReads.ts';
import type { ShipmentHistoryCursor, ShipmentHistoryPage } from '../../../../shared/shipmentHistory.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const OTHER = 'So11111111111111111111111111111111111111112';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const ANONYMOUS = 'anonymous:shipment-test';
const shipmentEndpoints = [
  { path: PROFILE_STATE_PATH, body: {}, owner: OWNER, offset: 0 },
  { path: PROFILE_SHIPMENTS_PATH, body: { ownerWallet: OWNER }, owner: OWNER, offset: 0 },
  { path: ADMIN_PROFILE_PATH, body: { ownerWallet: OWNER }, owner: OWNER, offset: 0 },
  { path: ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, body: {}, owner: ANONYMOUS, offset: 1000 },
] as const;

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

async function readShipmentEndpoint(
  harness: CommerceD1Harness,
  path: typeof shipmentEndpoints[number]['path'],
  body: unknown,
) {
  return path === ADMIN_PROFILE_PATH
    ? handleStaffReadRequest(new Request(`https://api.mons.shop${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), { COMMERCE_DB: harness.db, OPS_DB: {} as D1Database }, path, {}, {
        nowMs: () => 1000,
        loadProfileEmail: async () => undefined,
        verifyIdentity: async () => ({ kind: 'staff-wallet', wallet: ADMIN }),
      })
    : read(harness, path, body);
}

type ShipmentEndpointPayload = {
  orders?: ShipmentHistoryPage['orders'];
  shipments?: { value: ShipmentHistoryPage['orders'] };
  profile?: { orders: ShipmentHistoryPage['orders'] };
  nextCursor: ShipmentHistoryCursor | null;
};

function shipmentOrders(payload: ShipmentEndpointPayload): ShipmentHistoryPage['orders'] {
  const orders = payload.orders ?? payload.shipments?.value ?? payload.profile?.orders;
  assert.ok(orders);
  assert.ok(Object.hasOwn(payload, 'nextCursor'));
  return orders;
}

test('shipment page projection preserves summary coercion without private document fields', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seed(harness, [
    { id: 1, data: { processedAt: true, processingAt: '9', createdAt: 0, privateAddress: 'private' } },
    { id: 2, data: { source: 'admin_irl_redeem' } },
    { id: 3, data: { owner: OTHER } },
  ]);
  const repository = new D1CommerceRepository(harness.db);
  const original = await repository.get(commerceKeys.deliveryOrder('card_nft_2', '1'));
  const narrow = await repository.queryShipmentHistoryPage({ owner: OWNER, limit: 50 });
  assert.equal(narrow.orders.length, 1);
  assert.doesNotMatch(JSON.stringify(narrow), /privateAddress|private/);
  assert.deepEqual(narrow.orders, [deliveryOrderSummaryFromDocument(original!)]);
  assert.equal(narrow.nextCursor, null);
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

test('all shipment endpoints default to 50 and continue through bounded owner-scoped pages', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const [owner, offset] of [[OWNER, 0], [ANONYMOUS, 1000]] as const) {
    seed(harness, Array.from({ length: 105 }, (_, index) => ({ id: offset + index + 1, data: { owner } })));
    seed(harness, [
      { id: offset + 200, data: { owner, source: 'admin_irl_redeem' } },
      { id: offset + 201, data: { owner, status: 'failed' } },
    ]);
  }
  seed(harness, [{ id: 2000, data: { owner: OTHER } }]);
  for (const { path, body, owner, offset } of shipmentEndpoints) {
    const load = async (requestBody: unknown) => {
      const result = await readShipmentEndpoint(harness, path, requestBody);
      assert.equal(result.response.status, 200, path);
      return await result.response.json() as ShipmentEndpointPayload;
    };
    const first = await load(body);
    assert.deepEqual(first, await load({ ...body, shipmentsPage: {} }), path);
    assert.equal(shipmentOrders(first).length, 50, path);
    assert.equal(first.nextCursor?.owner, owner, path);
    const second = await load({ ...body, shipmentsPage: { cursor: first.nextCursor } });
    assert.equal(shipmentOrders(second).length, 50, path);
    assert.equal(second.nextCursor?.owner, owner, path);
    const last = await load({ ...body, shipmentsPage: { cursor: second.nextCursor } });
    assert.equal(shipmentOrders(last).length, 5, path);
    assert.equal(last.nextCursor, null, path);
    assert.deepEqual(
      [first, second, last].flatMap((payload) => shipmentOrders(payload).map((order) => order.deliveryId)),
      Array.from({ length: 105 }, (_, index) => offset + 105 - index),
      path,
    );
    for (const limit of [1, 100]) {
      const limited = await load({ ...body, shipmentsPage: { limit } });
      assert.equal(shipmentOrders(limited).length, limit, path);
      assert.equal(limited.nextCursor?.owner, owner, path);
    }
  }
});

test('all shipment endpoints return an explicit terminal cursor for empty histories', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const { path, body } of shipmentEndpoints) {
    for (const page of [{}, { shipmentsPage: {} }]) {
      const result = await readShipmentEndpoint(harness, path, { ...body, ...page });
      assert.equal(result.response.status, 200, path);
      const payload = await result.response.json() as ShipmentEndpointPayload;
      assert.deepEqual(shipmentOrders(payload), [], path);
      assert.equal(payload.nextCursor, null, path);
    }
  }
});

test('all shipment endpoints advance across invalid rows and preserve tie and zero ordering', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const [owner, offset] of [[OWNER, 0], [ANONYMOUS, 1000]] as const) {
    seed(harness, [
      { id: offset + 1, data: { owner, processedAt: 0, processingAt: 999 } },
      { id: offset + 2, data: { owner, processingAt: 10, createdAt: 99 } },
      { id: offset + 3, data: { owner, processedAt: 10 } },
      { id: offset + 4, data: { owner, processedAt: true, processingAt: 5 } },
      { id: offset + 5, data: { owner, createdAt: 20, deliveryId: 999 } },
    ]);
  }
  for (const { path, body, owner, offset } of shipmentEndpoints) {
    let cursor: ShipmentHistoryCursor | null = null;
    const ids: number[] = [];
    for (let page = 0; page < 5; page += 1) {
      const result = await readShipmentEndpoint(harness, path, { ...body, shipmentsPage: { limit: 1, cursor } });
      assert.equal(result.response.status, 200, path);
      const payload = await result.response.json() as ShipmentEndpointPayload;
      if (page === 0) {
        assert.deepEqual(shipmentOrders(payload), [], path);
        assert.equal(payload.nextCursor?.documentPath, `drops/card_nft_2/deliveryOrders/${offset + 5}`, path);
        assert.equal(payload.nextCursor?.owner, owner, path);
      }
      ids.push(...shipmentOrders(payload).map((order) => order.deliveryId));
      cursor = payload.nextCursor;
    }
    assert.deepEqual(ids, [3, 2, 4, 1].map((id) => offset + id), path);
    assert.equal(cursor, null, path);
  }
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
  for (const { path, body } of shipmentEndpoints) {
    for (const shipmentsPage of [null, { limit: 0 }, { limit: 101 }, { limit: null }, { limit: 1.5 }, { cursor: {} }, {
      cursor: { version: 1, owner: OTHER, sortAtMs: 1, documentPath: 'drops/card_nft_2/deliveryOrders/1' },
    }]) {
      const result = await readShipmentEndpoint(harness, path, { ...body, shipmentsPage });
      assert.equal(result.response.status, 400, path);
    }
  }
  for (const body of [
    { scope: 'wallet', expectedWallet: OWNER }, { scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: null },
    { scope: 'wallet', expectedWallet: OWNER, stripeSessionIds: Array.from({ length: 51 }, (_, i) => `cs_${i}`) },
    { scope: 'wallet', expectedWallet: OWNER, deliveries: [{ dropId: 'card_nft_2', deliveryId: 0 }] },
  ]) assert.equal((await read(harness, SHIPMENT_PRESENCE_PATH, body)).response.status, 400);
  for (const body of [{}, { shipmentsPage: {} }]) {
    const missingWallet = await read(harness, PROFILE_STATE_PATH, body, {
      resolveD1AuthWalletBinding: async () => ({ wallet: null, reason: 'missing-binding' }),
    });
    assert.deepEqual(await missingWallet.response.json(), {
      responseMode: 'profile-state', sessionWallet: null, profile: null, shipments: null, nextCursor: null,
    });
  }
  for (const binding of [OWNER, null]) {
    const state = await read(harness, PROFILE_STATE_PATH, {
      shipmentsPage: { cursor: { version: 1, owner: OTHER, sortAtMs: 1, documentPath: 'drops/card_nft_2/deliveryOrders/1' } },
    }, {
      resolveD1AuthWalletBinding: async () => binding ? { wallet: binding, source: 'binding' } : { wallet: null, reason: 'missing-binding' },
    });
    assert.equal(state.response.status, 400);
  }
  for (const body of [{}, { shipmentsPage: {} }]) {
    const failing = await read(harness, PROFILE_STATE_PATH, body, {
      createCommerceRepository: (db) => Object.assign(new D1CommerceRepository(db), {
        queryShipmentHistoryPage: async () => { throw new CommerceRepositoryError('unavailable', 'Unavailable'); },
      }),
    });
    assert.equal(failing.response.status, 200);
    const payload = await failing.response.json() as { shipments: { status: string }; nextCursor?: unknown };
    assert.equal(payload.shipments.status, 'error');
    assert.equal('nextCursor' in payload, false);
  }
});
