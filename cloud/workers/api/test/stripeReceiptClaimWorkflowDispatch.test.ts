import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureReceiptClaimWorkflowRunning, inspectReceiptClaimWorkflow, reconcileReceiptClaimWorkflows, ReceiptClaimWorkflowRecoveryPending } from '../src/stripeReceiptClaimWorkflowDispatch.ts';
import { StripeReceiptClaimError } from '../src/stripeReceiptClaimErrors.ts';
import type { ReceiptClaimWorkflowSnapshot } from '../src/stripeReceiptClaimWorkflowState.ts';
import { RECEIPT_OPERATION_ID, RECEIPT_REQUEST_ID, RECEIPT_RETRY_ID, RECEIPT_RESULT, receiptWorkflowSnapshot } from './stripeReceiptClaimWorkflowFixtures.ts';

function harness() {
  const snapshot = receiptWorkflowSnapshot();
  const created: string[] = [];
  const advances: Array<{ resetRetryWindow?: boolean; requestId?: string }> = [];
  let nowMs = 1000;
  let observation: Awaited<ReturnType<typeof inspectReceiptClaimWorkflow>> = 'missing';
  let createError: Error | undefined;
  const env = {
    COMMERCE_DB: {},
    STRIPE_RECEIPT_CLAIM_WORKFLOW: {
      async createBatch(values: Array<{ id: string }>) {
        created.push(...values.map((value) => value.id));
        if (createError) throw createError;
        return [];
      },
    },
  } as unknown as Env;
  const dependencies = {
    load: async () => structuredClone(snapshot),
    inspect: async () => observation,
    nowMs: () => nowMs,
    claimDispatch: async () => {
      if ((snapshot.operation.dispatchLeaseUntilMs || 0) > nowMs) return null;
      snapshot.operation.dispatchLeaseUntilMs = nowMs + 30_000;
      return structuredClone(snapshot);
    },
    markDispatched: async () => { snapshot.operation.dispatchLeaseUntilMs = null; },
    defer: async (_context: unknown, _snapshot: unknown, next: number) => { snapshot.operation.nextAttemptAtMs = next; },
    fail: async (_context: unknown, _snapshot: unknown, error: NonNullable<ReceiptClaimWorkflowSnapshot['operation']['error']>) => {
      snapshot.operation.phase = 'manual_review'; snapshot.operation.error = error;
    },
    advance: async (_context: unknown, _snapshot: unknown, _nowMs: number, options: { resetRetryWindow?: boolean; requestId?: string } = {}) => {
      advances.push(options);
      snapshot.operation.generation += 1;
      snapshot.operation.phase = 'pending';
      if (options.resetRetryWindow) snapshot.operation.deadlineAtMs = nowMs + 900_000;
      if (options.requestId) snapshot.operation.requestIds.push(options.requestId);
      return structuredClone(snapshot);
    },
  };
  const run = (requestId?: string) => ensureReceiptClaimWorkflowRunning(env, snapshot, new AbortController().signal, requestId, dependencies);
  return { snapshot, created, advances, env, dependencies, run,
    observe: (value: typeof observation) => { observation = value; },
    setTime: (value: number) => { nowMs = value; },
    loseCreateAcknowledgement: (value: boolean) => { createError = value ? new Error('lost acknowledgement') : undefined; } };
}

test('creation acknowledgement loss leaves dispatch recoverable with the same instance id', async () => {
  const fixture = harness();
  fixture.loseCreateAcknowledgement(true);
  await fixture.run();
  assert.equal(fixture.created.length, 1);
  await fixture.run();
  assert.equal(fixture.created.length, 1);
  fixture.setTime(32_000);
  fixture.loseCreateAcknowledgement(false);
  await fixture.run();
  assert.deepEqual(fixture.created, [`${RECEIPT_OPERATION_ID}-g1`, `${RECEIPT_OPERATION_ID}-g1`]);
  assert.equal(fixture.snapshot.operation.generation, 1);
});

test('active and unavailable observations never replace a generation', async () => {
  for (const observation of ['active', 'unavailable'] as const) {
    const fixture = harness();
    fixture.observe(observation);
    await fixture.run(RECEIPT_RETRY_ID);
    assert.equal(fixture.advances.length, 0);
    assert.ok(fixture.created.every((id) => id.endsWith('-g1')));
  }
});

test('active deferral reloads completion committed after the scheduling write', async () => {
  const fixture = harness();
  fixture.observe('active');
  const current = await ensureReceiptClaimWorkflowRunning(fixture.env, fixture.snapshot, new AbortController().signal, undefined, {
    ...fixture.dependencies,
    defer: async () => { fixture.snapshot.operation.phase = 'complete'; fixture.snapshot.operation.result = RECEIPT_RESULT; },
  });
  assert.equal(current.operation.phase, 'complete');
  assert.deepEqual(current.operation.result, RECEIPT_RESULT);
});

test('active deferral preserves infrastructure failures and aborts without a durable state change', async () => {
  for (const error of [new Error('D1 unavailable'), new StripeReceiptClaimError('unavailable', 'D1 unavailable'),
    new StripeReceiptClaimError('aborted', 'Unrelated abort')]) {
    const fixture = harness();
    fixture.observe('active');
    await assert.rejects(ensureReceiptClaimWorkflowRunning(fixture.env, fixture.snapshot, new AbortController().signal, undefined, {
      ...fixture.dependencies, defer: async () => { throw error; },
    }), (actual) => actual === error);
    assert.deepEqual(fixture.created, []);
  }
});

test('expiration preserves infrastructure failures and aborts without a durable state change', async () => {
  for (const observation of ['active', 'terminal'] as const) {
    for (const error of [new Error('D1 unavailable'), new StripeReceiptClaimError('unavailable', 'D1 unavailable'),
      new StripeReceiptClaimError('aborted', 'Unrelated abort')]) {
      const fixture = harness();
      fixture.observe(observation);
      fixture.setTime(fixture.snapshot.operation.deadlineAtMs);
      await assert.rejects(ensureReceiptClaimWorkflowRunning(fixture.env, fixture.snapshot, new AbortController().signal, undefined, {
        ...fixture.dependencies, fail: async () => { throw error; },
      }), (actual) => actual === error);
      assert.deepEqual(fixture.created, []);
    }
  }
});

test('expiration does not hide infrastructure failures when another generation advances', async () => {
  for (const error of [new Error('D1 unavailable'), new StripeReceiptClaimError('unavailable', 'D1 unavailable')]) {
    const fixture = harness();
    fixture.observe('terminal');
    fixture.setTime(fixture.snapshot.operation.deadlineAtMs);
    await assert.rejects(ensureReceiptClaimWorkflowRunning(fixture.env, fixture.snapshot, new AbortController().signal, undefined, {
      ...fixture.dependencies,
      fail: async () => { fixture.snapshot.operation.generation += 1; throw error; },
    }), (actual) => actual === error);
    assert.deepEqual(fixture.created, []);
  }
});

test('automatic repair replaces a terminal engine without extending the retry budget', async () => {
  const fixture = harness();
  fixture.observe('terminal');
  await fixture.run();
  assert.deepEqual(fixture.advances, [{ resetRetryWindow: false }]);
  assert.equal(fixture.snapshot.operation.deadlineAtMs, 901000);
  assert.deepEqual(fixture.created, [`${RECEIPT_OPERATION_ID}-g2`]);
});

test('only a fresh explicit request can restart a retryable terminal operation', async () => {
  const fixture = harness();
  fixture.snapshot.operation.phase = 'manual_review';
  fixture.snapshot.operation.error = { code: 'unavailable', message: 'try again', retryable: true };
  fixture.observe('terminal');
  await fixture.run();
  await fixture.run(RECEIPT_REQUEST_ID);
  assert.equal(fixture.advances.length, 0);
  fixture.setTime(1_000_000);
  await fixture.run(RECEIPT_RETRY_ID);
  assert.deepEqual(fixture.advances, [{ resetRetryWindow: true, requestId: RECEIPT_RETRY_ID }]);
  assert.equal(fixture.snapshot.operation.deadlineAtMs, 1_900_000);
});

test('a request that previously joined pending work cannot restart that failed operation', async () => {
  const fixture = harness();
  fixture.snapshot.operation.requestIds.push(RECEIPT_RETRY_ID);
  fixture.snapshot.operation.phase = 'failed';
  fixture.snapshot.operation.error = { code: 'unavailable', message: 'try again', retryable: true };
  fixture.observe('terminal');
  await fixture.run(RECEIPT_RETRY_ID);
  assert.equal(fixture.advances.length, 0);
});

test('a completed newer generation returns without recording another request', async () => {
  const fixture = harness();
  const original = receiptWorkflowSnapshot();
  fixture.snapshot.operation.generation = 2;
  fixture.snapshot.operation.phase = 'complete';
  const completed = await ensureReceiptClaimWorkflowRunning(fixture.env, original, new AbortController().signal, RECEIPT_RETRY_ID, {
    ...fixture.dependencies, join: async () => assert.fail('Completed results must not require a write'),
  });
  assert.equal(completed.operation.phase, 'complete');
  assert.equal(completed.operation.generation, 2);
  assert.deepEqual(fixture.created, []);
});

test('an expired undispatched operation still creates its original instance to settle safely', async () => {
  const fixture = harness();
  fixture.setTime(1_000_000);
  await fixture.run();
  assert.deepEqual(fixture.created, [`${RECEIPT_OPERATION_ID}-g1`]);
  assert.equal(fixture.advances.length, 0);
});

test('a retained failure recreates only its retired generation before verified terminal recovery', async () => {
  const fixture = harness();
  fixture.snapshot.operation.phase = 'manual_review';
  fixture.snapshot.operation.error = { code: 'unavailable', message: 'try again', retryable: true };
  await assert.rejects(fixture.run(RECEIPT_RETRY_ID), ReceiptClaimWorkflowRecoveryPending);
  assert.deepEqual(fixture.created, [`${RECEIPT_OPERATION_ID}-g1`]);
  assert.equal(fixture.snapshot.operation.phase, 'manual_review');
  assert.equal(fixture.advances.length, 0);
  fixture.observe('terminal');
  await fixture.run(RECEIPT_RETRY_ID);
  assert.deepEqual(fixture.created, [`${RECEIPT_OPERATION_ID}-g1`, `${RECEIPT_OPERATION_ID}-g2`]);
  assert.equal(fixture.advances.length, 1);
});

test('failed operations with unavailable inspection do not recreate or advance', async () => {
  const fixture = harness();
  fixture.snapshot.operation.phase = 'failed';
  fixture.snapshot.operation.error = { code: 'unavailable', message: 'try again', retryable: true };
  fixture.observe('unavailable');
  await assert.rejects(fixture.run(RECEIPT_RETRY_ID), ReceiptClaimWorkflowRecoveryPending);
  assert.deepEqual(fixture.created, []);
  assert.deepEqual(fixture.advances, []);
});

test('cron repairs persisted work without a client retry token', async () => {
  const fixture = harness();
  let called = 0;
  const count = await reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
    queryDue: async () => [RECEIPT_OPERATION_ID], load: fixture.dependencies.load,
    ensure: async (_env, snapshot, _signal, requestId) => { called += 1; assert.equal(requestId, undefined); return snapshot; },
  });
  assert.equal(called, 1);
  assert.equal(count, 1);
});

test('Workflow paused and unknown statuses are active; inspection errors are not absence', async () => {
  const snapshot = receiptWorkflowSnapshot();
  for (const status of ['paused', 'unknown', 'waiting', 'waitingForPause', 'queued', 'running']) {
    const binding = { get: async () => ({ status: async () => ({ status }) }) } as unknown as Env['STRIPE_RECEIPT_CLAIM_WORKFLOW'];
    assert.equal(await inspectReceiptClaimWorkflow(binding, snapshot, new AbortController().signal), 'active');
  }
  const binding = { get: async () => { throw { code: 10200 }; } } as unknown as Env['STRIPE_RECEIPT_CLAIM_WORKFLOW'];
  assert.equal(await inspectReceiptClaimWorkflow(binding, snapshot, new AbortController().signal), 'unavailable');
});
