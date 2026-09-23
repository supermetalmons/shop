import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { FULFILLMENT_MANUAL_REVIEW_PATH, handleStaffReadRequest } from '../src/staffReads.ts';
import type { FulfillmentManualReviewPage } from '../../../../shared/contracts.ts';
import { manualReviewDocumentCursor } from '../../../../shared/fulfillmentManualReviewPagination.ts';

const DROP = 'card_nft_2';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';

function fixture() {
  const harness = createCommerceD1Harness();
  return {
    seed(id: string, failedAt: number, sessionId = id) {
      seedCommerceDocument(harness, {
        key: commerceKeys.stripeCheckout(DROP, id),
        data: { owner: ADMIN, ownerKind: 'wallet', status: 'fulfillment_failed', manualRefundReviewRequired: true,
          failedAt, sessionId, quantity: 1 },
      });
    },
    async request(body: Record<string, unknown>, overrides: Parameters<typeof handleStaffReadRequest>[4] = {}, signal?: AbortSignal) {
      return handleStaffReadRequest(new Request(`https://api.mons.shop${FULFILLMENT_MANUAL_REVIEW_PATH}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
        body: JSON.stringify({ dropId: DROP, ...body }), signal,
      }), { COMMERCE_DB: harness.db, STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_SECRET_KEY_LIVE: 'sk_live_fixture' }, FULFILLMENT_MANUAL_REVIEW_PATH, {}, {
        timeoutMs: 5_000,
        verifyIdentity: async () => ({ kind: 'staff-wallet', wallet: ADMIN }),
        providerFetch: async () => Response.json({}),
        ...overrides,
      });
    },
  };
}

test('manual review uses a bounded page, advances past filtered records, and does not hydrate lookahead', async () => {
  const state = fixture();
  state.seed('cs_old', 1);
  state.seed('cs_filtered', 2, 'invalid session');
  state.seed('cs_new', 3);
  const fetched: string[] = [];
  const dependencies = { providerFetch: async (input: RequestInfo | URL) => { fetched.push(String(input)); return Response.json({}); } };
  const first = await state.request({ limit: 2 }, dependencies);
  assert.equal(first.response.status, 200);
  const page = await first.response.json() as FulfillmentManualReviewPage;
  assert.deepEqual(page.checkouts.map((entry) => entry.sessionId), ['cs_new']);
  assert.equal(page.nextCursor?.sessionId, 'invalid session');
  assert.equal(fetched.length, 1);
  state.seed('cs_inserted', 4);
  const second = await state.request({ limit: 2, cursor: page.nextCursor }, dependencies);
  const last = await second.response.json() as FulfillmentManualReviewPage;
  assert.deepEqual(last.checkouts.map((entry) => entry.sessionId), ['cs_old']);
  assert.equal(last.nextCursor, null);
  assert.equal(fetched.length, 2);
});

test('oversized session IDs and document paths cannot block later pages', async () => {
  const state = fixture();
  state.seed('cs_old', 1);
  state.seed('cs_maximum', 2, 'x'.repeat(256));
  state.seed('cs_new', 3);
  for (const [index, sessionId] of [
    'x'.repeat(4100),
    `cs_bad\0${'x'.repeat(4100)}`,
    'é'.repeat(2050),
    'x'.repeat(257),
  ].entries()) state.seed(`cs_invalid_${index}`, 2.5 + index, sessionId);
  state.seed('x'.repeat(4100), 6, 'cs_valid');

  const visited: string[] = [];
  let cursor: FulfillmentManualReviewPage['nextCursor'] = null;
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const body = { dropId: DROP, limit: 1, cursor };
    assert.ok(new TextEncoder().encode(JSON.stringify(body)).byteLength <= 4096);
    const result = await state.request(body);
    assert.equal(result.response.status, 200);
    const page = await result.response.json() as FulfillmentManualReviewPage;
    visited.push(...page.checkouts.map((checkout) => checkout.sessionId));
    cursor = page.nextCursor;
  }
  assert.deepEqual(visited, ['cs_new', 'x'.repeat(256), 'cs_old']);
  assert.equal(cursor, null);
});

test('manual review defaults to 25 and caps Stripe hydration at four in-flight requests', async () => {
  const state = fixture();
  for (let index = 0; index < 27; index++) state.seed(`cs_${String(index).padStart(2, '0')}`, index);
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const result = await state.request({}, {
    providerFetch: async () => {
      calls += 1;
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return Response.json({});
    },
  });
  const page = await result.response.json() as FulfillmentManualReviewPage;
  assert.equal(result.response.status, 200);
  assert.equal(page.checkouts.length, 25);
  assert.ok(page.nextCursor);
  assert.equal(calls, 25);
  assert.equal(maximum, 4);
});

test('manual review rejects invalid limits and cursors before reading providers', async () => {
  const state = fixture();
  const cursor = manualReviewDocumentCursor(DROP, { key: commerceKeys.stripeCheckout(DROP, 'cs_test'), data: { failedAt: 1 } });
  for (const body of [
    ...[0, -1, 101, 1.5, '25', null].map((limit) => ({ limit })),
    ...[{}, 'cursor', { ...cursor, version: 2 }, { ...cursor, dropId: 'other' },
      { ...cursor, sortAtMs: null }, { ...cursor, documentPath: 'drops/other/stripeCheckouts/cs_test' },
      { ...cursor, extra: true }].map((value) => ({ cursor: value })),
  ]) {
    const result = await state.request(body, { providerFetch: async () => assert.fail('Unexpected provider call') });
    assert.equal(result.response.status, 400, JSON.stringify(body));
  }
});

test('manual review preserves fallback summaries after provider failures and stops new hydration after its deadline', async () => {
  const state = fixture();
  for (let index = 0; index < 9; index++) state.seed(`cs_${index}`, index);
  let calls = 0;
  const result = await state.request({ limit: 9 }, {
    timeoutMs: 30,
    providerFetch: async (_input, init) => {
      calls += 1;
      const signal = init?.signal;
      await new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return Response.json({});
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as FulfillmentManualReviewPage).checkouts.length, 9);
  assert.equal(calls, 4);
});

test('manual review cancels queued hydration when the client disconnects', async () => {
  const state = fixture();
  for (let index = 0; index < 9; index++) state.seed(`cs_${index}`, index);
  const controller = new AbortController();
  const reason = new Error('Client disconnected');
  let calls = 0;
  const result = state.request({ limit: 9 }, {
    providerFetch: async (_input, init) => {
      calls += 1;
      if (calls === 4) queueMicrotask(() => controller.abort(reason));
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      return Response.json({});
    },
  }, controller.signal);
  await assert.rejects(result, (error) => error === reason);
  assert.equal(calls, 4);
});
