import assert from 'node:assert/strict';
import test from 'node:test';
import { createFulfillmentApiClient } from '../src/api/fulfillment.ts';
import { manualReviewDocumentCursor } from '../shared/fulfillmentManualReviewPagination.ts';

const DROP = 'card_nft_2';
const cursor = manualReviewDocumentCursor(DROP, {
  key: { documentId: 'cs_test', path: `drops/${DROP}/stripeCheckouts/cs_test` },
  data: { failedAt: 123 },
});

test('manual-review client serializes pagination and validates its next cursor', async () => {
  const api = createFulfillmentApiClient(async (path, body) => {
    assert.equal(path, '/fulfillment/manual-review-checkouts');
    assert.deepEqual(body, { dropId: DROP, limit: 25, cursor: null });
    return { checkouts: [], nextCursor: cursor };
  });
  assert.deepEqual(await api.listFulfillmentManualReviewCheckouts({ dropId: DROP, limit: 25, cursor: null }), {
    checkouts: [], nextCursor: cursor,
  });
});

test('manual-review client rejects malformed, cross-drop, or non-advancing cursors', async () => {
  for (const nextCursor of [undefined, {}, { ...cursor, dropId: 'other' }, { ...cursor, version: 2 }, { ...cursor, sortAtMs: NaN }, cursor]) {
    const api = createFulfillmentApiClient(async () => ({ checkouts: [], nextCursor }));
    await assert.rejects(api.listFulfillmentManualReviewCheckouts({ dropId: DROP, cursor }), /Invalid fulfillment manual-review response/);
  }
  const api = createFulfillmentApiClient(async () => ({ checkouts: [], nextCursor: null }));
  assert.deepEqual(await api.listFulfillmentManualReviewCheckouts({ dropId: DROP, cursor }), { checkouts: [], nextCursor: null });
});
