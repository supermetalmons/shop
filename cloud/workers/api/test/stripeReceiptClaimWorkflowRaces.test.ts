import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.js';
import { ensureReceiptClaimWorkflowRunning } from '../src/stripeReceiptClaimWorkflowDispatch.js';
import { handleStripeReceiptClaimWorkflowStart } from '../src/stripeReceiptClaimWorkflowRoutes.js';
import {
  advanceReceiptClaimWorkflowGeneration,
  completeReceiptClaimWorkflow,
  failReceiptClaimWorkflow,
  joinReceiptClaimWorkflowGeneration,
  loadReceiptClaimWorkflow,
  reserveReceiptClaimWorkflow,
} from '../src/stripeReceiptClaimWorkflowStore.js';
import type { ReceiptClaimWorkflowSnapshot } from '../src/stripeReceiptClaimWorkflowState.js';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const CODE = 'ABCDEF-1234567890';
const DROP = 'card_nft_2';
const RECIPIENT = '11111111111111111111111111111111';
const NOW = 1_800_000_000_000;
const RETRYABLE_FAILURE = { code: 'unavailable' as const, message: 'Retry later.', retryable: true };

function setup(options: Parameters<typeof createCommerceD1Harness>[0] = {}) {
  const harness = createCommerceD1Harness(options);
  seedCommerceDocument(harness, { key: commerceKeys.claimCode(CODE), data: {
    namespace: 'stripe_receipt_v1', code: CODE, dropId: DROP, deliveryId: 7, boxId: 16, status: 'unclaimed',
  } });
  seedCommerceDocument(harness, { key: commerceKeys.deliveryOrder(DROP, '7'), data: {
    dropId: DROP, deliveryId: 7, source: 'stripe_offchain', irlClaims: [],
    stripeReceiptClaim: { namespace: 'stripe_receipt_v1', code: CODE, boxId: 16, status: 'unclaimed' },
  } });
  const context = { repository: new D1CommerceRepository(harness.db), signal: new AbortController().signal, nowMs: NOW };
  const created: string[] = [];
  const env = {
    COMMERCE_DB: harness.db,
    STRIPE_RECEIPT_CLAIM_WORKFLOW: { async createBatch(values: Array<{ id: string }>) {
      created.push(...values.map(({ id }) => id));
      return [];
    } },
  } as unknown as Env;
  const reserve = async (requestId = crypto.randomUUID()) => {
    const reserved = await reserveReceiptClaimWorkflow(context, CODE, RECIPIENT, NOW, { requestId });
    assert.equal(reserved.status, 'pending');
    if (reserved.status !== 'pending') return assert.fail();
    return reserved.snapshot;
  };
  const ensure = (snapshot: ReceiptClaimWorkflowSnapshot, requestId?: string,
    overrides: Parameters<typeof ensureReceiptClaimWorkflowRunning>[4] = {}) =>
    ensureReceiptClaimWorkflowRunning(env, snapshot, context.signal, requestId, {
      nowMs: () => NOW, inspect: async () => 'terminal', ...overrides,
    });
  return { ...harness, context, created, env, reserve, ensure };
}

test('automatic recovery preserves failures committed while engine status is inspected', async (t) => {
  for (const [retryable, observation] of [[false, 'terminal'], [true, 'terminal'], [false, 'active'], [true, 'active']] as const) {
    const fixture = setup();
    t.after(() => fixture.database.close());
    const reserved = await fixture.reserve();
    const error = { code: retryable ? 'unavailable' as const : 'failed-precondition' as const, message: 'Claim failed.', retryable };
    const result = await fixture.ensure(reserved, undefined, { inspect: async () => {
      await failReceiptClaimWorkflow(fixture.context, reserved, error, retryable);
      return observation;
    } });
    assert.equal(result.operation.generation, 1);
    assert.equal(result.operation.phase, retryable ? 'manual_review' : 'failed');
    assert.deepEqual(result.operation.error, error);
    assert.deepEqual(fixture.created, []);
  }
});

test('start returns completion committed before active Workflow deferral', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await fixture.reserve();
  const completion = { processed: true, dropId: DROP, deliveryId: 7, receiptKind: 'box' as const, receiptsTransferred: 1, receiptTxs: [] };
  const response = await handleStripeReceiptClaimWorkflowStart(new Request('https://api.mons.shop/receipts/stripe/claim/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mons-Receipt-Claim-Request': crypto.randomUUID() },
    body: JSON.stringify({ code: CODE, recipient: RECIPIENT }),
  }), fixture.env, {}, {
    nowMs: () => NOW,
    verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'anon' }),
    ensure: (_env, snapshot, _signal, requestId) => fixture.ensure(snapshot, requestId, {
      inspect: async () => {
        await completeReceiptClaimWorkflow(fixture.context, snapshot, completion);
        return 'active';
      },
    }),
  });
  assert.equal(response.response.status, 200);
  assert.deepEqual(await response.response.json(), completion);
  assert.equal((await loadReceiptClaimWorkflow(fixture.context, reserved.operation.operationId))?.operation.phase, 'complete');
  assert.deepEqual(fixture.created, []);
});

test('active Workflow deferral returns a concurrently advanced generation without changing its schedule', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const reserved = await fixture.reserve();
  const current = await fixture.ensure(reserved, undefined, {
    inspect: async () => {
      assert.ok(await advanceReceiptClaimWorkflowGeneration(fixture.context, reserved, NOW));
      return 'active';
    },
  });
  assert.equal(current.operation.generation, 2);
  assert.equal(current.operation.phase, 'pending');
  assert.equal(current.operation.nextAttemptAtMs, NOW);
  assert.deepEqual(fixture.created, []);
});

for (const complete of [false, true]) {
  test(`start returns the ${complete ? 'completed' : 'pending'} generation that wins an expiration race`, async (t) => {
    const fixture = setup();
    t.after(() => fixture.database.close());
    const reserved = await fixture.reserve();
    const nowMs = reserved.operation.deadlineAtMs + 1;
    const context = { ...fixture.context, nowMs };
    const completion = { processed: true, dropId: DROP, deliveryId: 7, receiptKind: 'box' as const, receiptsTransferred: 1, receiptTxs: [] };
    const response = await handleStripeReceiptClaimWorkflowStart(new Request('https://api.mons.shop/receipts/stripe/claim/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mons-Receipt-Claim-Request': crypto.randomUUID() },
      body: JSON.stringify({ code: CODE, recipient: RECIPIENT }),
    }), fixture.env, {}, {
      nowMs: () => nowMs,
      verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'anon' }),
      ensure: (_env, snapshot, _signal, requestId) => fixture.ensure(snapshot, requestId, {
        nowMs: () => nowMs,
        inspect: async () => {
          await failReceiptClaimWorkflow(context, snapshot, {
            code: 'deadline-exceeded', message: 'Retry with the same receiver.', retryable: true,
          }, true);
          const retryId = crypto.randomUUID();
          const retry = await fixture.ensure(await fixture.reserve(retryId), retryId, { nowMs: () => nowMs });
          assert.equal(retry.operation.generation, 2);
          if (complete) await completeReceiptClaimWorkflow(context, retry, completion);
          return 'terminal';
        },
      }),
    });
    assert.equal(response.response.status, complete ? 200 : 202);
    assert.deepEqual(await response.response.json(), complete ? completion : {
      accepted: true, operationId: reserved.operation.operationId, status: 'pending', retryAfterMs: 2000,
    });
    const current = await loadReceiptClaimWorkflow(context, reserved.operation.operationId);
    assert.equal(current?.operation.generation, 2);
    assert.equal(current?.operation.phase, complete ? 'complete' : 'pending');
    assert.equal(current?.operation.deadlineAtMs, nowMs + 900_000);
    assert.equal(current?.operation.nextAttemptAtMs, complete ? null : nowMs + 60_000);
    assert.deepEqual(fixture.created, [`${reserved.operation.operationId}-g2`]);
  });
}

test('concurrent retry requests join one generation and neither replay restarts its failure', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const original = await fixture.reserve();
  await failReceiptClaimWorkflow(fixture.context, original, RETRYABLE_FAILURE, false);
  const requestIds = [crypto.randomUUID(), crypto.randomUUID()];
  const reserved = await Promise.all(requestIds.map(fixture.reserve));
  let inspections = 0;
  let release!: () => void;
  const inspected = new Promise<void>((resolve) => { release = resolve; });
  const results = await Promise.all(reserved.map((snapshot, index) => fixture.ensure(snapshot, requestIds[index], {
    inspect: async () => {
      if (++inspections === 2) release();
      await inspected;
      return 'terminal';
    },
  })));
  assert.deepEqual(results.map(({ operation }) => operation.generation), [2, 2]);
  const joined = await loadReceiptClaimWorkflow(fixture.context, original.operation.operationId);
  assert.ok(joined);
  for (const requestId of requestIds) assert.ok(joined.operation.requestIds.includes(requestId));
  await failReceiptClaimWorkflow(fixture.context, joined, RETRYABLE_FAILURE, false);
  for (const requestId of requestIds) {
    const replay = await fixture.ensure(await fixture.reserve(requestId), requestId, { inspect: async () => assert.fail('Replays must not restart') });
    assert.equal(replay.operation.generation, 2);
    assert.equal(replay.operation.phase, 'failed');
  }
  assert.equal(fixture.created.length, 1);
  const freshId = crypto.randomUUID();
  const fresh = await fixture.ensure(await fixture.reserve(freshId), freshId);
  assert.equal(fresh.operation.generation, 3);
});

test('requests register against generations advanced before the initial reload', async (t) => {
  for (const alreadyFailed of [false, true]) {
    const fixture = setup();
    t.after(() => fixture.database.close());
    const original = await fixture.reserve();
    await failReceiptClaimWorkflow(fixture.context, original, RETRYABLE_FAILURE, false);
    const winnerId = crypto.randomUUID();
    const joinedId = crypto.randomUUID();
    const joining = await fixture.reserve(joinedId);
    const winner = await fixture.ensure(await fixture.reserve(winnerId), winnerId);
    if (alreadyFailed) await failReceiptClaimWorkflow(fixture.context, winner, RETRYABLE_FAILURE, false);
    const joined = await fixture.ensure(joining, joinedId, { inspect: async () => 'active' });
    assert.equal(joined.operation.generation, 2);
    assert.equal(joined.operation.phase, alreadyFailed ? 'failed' : 'pending');
    assert.ok(joined.operation.requestIds.includes(joinedId));
    if (!alreadyFailed) await failReceiptClaimWorkflow(fixture.context, joined, RETRYABLE_FAILURE, false);
    const replay = await fixture.ensure(await fixture.reserve(joinedId), joinedId, { inspect: async () => assert.fail('Replays must not restart') });
    assert.equal(replay.operation.generation, 2);
    assert.equal(replay.operation.phase, 'failed');
    assert.equal(fixture.created.length, 1);
  }
});

test('losing retries register even when the winning generation fails before they join', async (t) => {
  const fixture = setup();
  t.after(() => fixture.database.close());
  const original = await fixture.reserve();
  await failReceiptClaimWorkflow(fixture.context, original, RETRYABLE_FAILURE, false);
  const winnerId = crypto.randomUUID();
  const joinedId = crypto.randomUUID();
  const joining = await fixture.reserve(joinedId);
  const joined = await fixture.ensure(joining, joinedId, { inspect: async () => {
    const winner = await fixture.ensure(await fixture.reserve(winnerId), winnerId);
    await failReceiptClaimWorkflow(fixture.context, winner, RETRYABLE_FAILURE, false);
    return 'terminal';
  } });
  assert.equal(joined.operation.generation, 2);
  assert.equal(joined.operation.phase, 'failed');
  assert.ok(joined.operation.requestIds.includes(joinedId));
  const replay = await fixture.ensure(await fixture.reserve(joinedId), joinedId, { inspect: async () => assert.fail('Replays must not restart') });
  assert.equal(replay.operation.generation, 2);
  assert.equal(fixture.created.length, 1);
});

test('joining reconciles a lost acknowledgement without consuming a fresh retry prematurely', async (t) => {
  let loseNextCommit = false;
  const fixture = setup({ observeBatchAfterCommit: ({ statements }) => {
    if (loseNextCommit && statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) {
      loseNextCommit = false;
      throw new TypeError('commit acknowledgement lost');
    }
  } });
  t.after(() => fixture.database.close());
  const original = await fixture.reserve();
  await failReceiptClaimWorkflow(fixture.context, original, RETRYABLE_FAILURE, false);
  const joinedId = crypto.randomUUID();
  const sameGeneration = await joinReceiptClaimWorkflowGeneration(fixture.context, original, joinedId);
  assert.ok(!sameGeneration.operation.requestIds.includes(joinedId));
  const winnerId = crypto.randomUUID();
  await fixture.ensure(await fixture.reserve(winnerId), winnerId);
  loseNextCommit = true;
  const joined = await joinReceiptClaimWorkflowGeneration(fixture.context, original, joinedId);
  assert.equal(loseNextCommit, false);
  assert.equal(joined.operation.generation, 2);
  assert.ok(joined.operation.requestIds.includes(joinedId));
});
