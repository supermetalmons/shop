import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureReceiptClaimWorkflowRunning, inspectReceiptClaimWorkflow, reconcileReceiptClaimWorkflows, ReceiptClaimWorkflowRecoveryPending } from '../src/stripeReceiptClaimWorkflowDispatch.ts';
import { StripeReceiptClaimError } from '../src/stripeReceiptClaimErrors.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { queryDueReceiptClaimWorkflows, type ReceiptClaimWorkflowDueCandidate } from '../src/stripeReceiptClaimWorkflowStore.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
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

function dueCandidate(index: number, operationId: unknown = `src-v1-123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`): ReceiptClaimWorkflowDueCandidate {
  return { documentPath: commerceKeys.claimCode(`ABCDEF-${String(index).padStart(10, '0')}`).path, nextAttemptAtMs: 1000, operationId };
}

function recoveryFixture(context: test.TestContext, count: number) {
  const fixture = createCommerceD1Harness();
  context.after(() => fixture.database.close());
  const env = { ...harness().env, COMMERCE_DB: fixture.db };
  const candidates = Array.from({ length: count }, (_, index) => dueCandidate(index));
  let version = 0;
  const save = (candidate: ReceiptClaimWorkflowDueCandidate, phase = 'pending') => {
    seedCommerceDocument(fixture, { key: commerceKeys.claimCode(candidate.documentPath.split('/')[1]), version: ++version, data: {
      receiptClaimWorkflowV1: { phase, nextAttemptAtMs: candidate.nextAttemptAtMs, operationId: candidate.operationId as string | null },
    } });
  };
  candidates.forEach((candidate) => save(candidate));
  const load = async (_context: unknown, operationId: string) => {
    const snapshot = receiptWorkflowSnapshot();
    snapshot.operation.operationId = operationId;
    return snapshot;
  };
  const complete = async (_env: unknown, snapshot: ReceiptClaimWorkflowSnapshot) => {
    save(candidates.find((candidate) => candidate.operationId === snapshot.operation.operationId)!, 'complete');
    snapshot.operation.phase = 'complete';
    return snapshot;
  };
  return { env, candidates, save, load, complete, database: fixture.database };
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
    queryDue: async () => [dueCandidate(0, RECEIPT_OPERATION_ID)], load: fixture.dependencies.load,
    nowMs: () => 1000,
    ensure: async (_env, snapshot, _signal, requestId) => { called += 1; assert.equal(requestId, undefined); return snapshot; },
  });
  assert.equal(called, 1);
  assert.deepEqual(count, { attempted: 1, completed: 0, deferred: 1, skipped: 0, failed: 0,
    inspected: 1, pages: 1, stopReason: 'drained', hasMore: true, oldestDueAgeMs: 0 });
});

test('receipt recovery advances past a failing first page and probes behind its cursor with a fixed cutoff', async (context) => {
  context.mock.method(console, 'error', () => {});
  const fixture = recoveryFixture(context, 13);
  fixture.save({ ...fixture.candidates[12], nextAttemptAtMs: 2001 });
  const failures = new Set(fixture.candidates.slice(0, 8).map((candidate) => candidate.operationId));
  const loaded: string[] = [];
  const queries: Array<{ cutoff: number; limit: number; after: string | undefined }> = [];
  let now = 2000;
  let summary: unknown;
  await assert.rejects(reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
    nowMs: () => now,
    queryDue: async (db, cutoff, limit = 20, cursor) => {
      queries.push({ cutoff, limit, after: cursor?.documentPath });
      return queryDueReceiptClaimWorkflows(db, cutoff, limit, cursor);
    },
    load: async (commerce, operationId) => {
      now = 3000;
      loaded.push(operationId);
      if (failures.has(operationId)) throw new Error('Recovery is temporarily unavailable');
      return fixture.load(commerce, operationId);
    },
    ensure: fixture.complete,
    onResult: (result) => { summary = result; },
  }), (error: unknown) => error instanceof AggregateError && error.errors.length === 8);
  assert.deepEqual(loaded, fixture.candidates.slice(0, 12).map((candidate) => candidate.operationId));
  assert.deepEqual(queries, [
    { cutoff: 2000, limit: 8, after: undefined },
    { cutoff: 2000, limit: 8, after: fixture.candidates[7].documentPath },
    { cutoff: 2000, limit: 1, after: undefined },
  ]);
  assert.deepEqual(summary, { attempted: 12, completed: 4, deferred: 0, skipped: 0, failed: 8,
    inspected: 12, pages: 2, stopReason: 'failed', hasMore: true, oldestDueAgeMs: 2000 });
});

test('invalid receipt operation IDs fail individually without hiding later rows or logging claim codes', async (context) => {
  const logs: unknown[] = [];
  context.mock.method(console, 'error', (entry: unknown) => { logs.push(entry); });
  const fixture = recoveryFixture(context, 9);
  for (const [index, candidate] of fixture.candidates.slice(0, 8).entries()) {
    fixture.save({ ...candidate, operationId: index === 0 ? 'private-invalid-operation' : null });
  }
  const loaded: string[] = [];
  let summary: unknown;
  await assert.rejects(reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
    nowMs: () => 2000,
    load: async (commerce, operationId) => { loaded.push(operationId); return fixture.load(commerce, operationId); },
    ensure: fixture.complete,
    onResult: (result) => { summary = result; },
  }), (error: unknown) => error instanceof AggregateError && error.errors.length === 8);
  assert.deepEqual(loaded, [fixture.candidates[8].operationId]);
  assert.deepEqual(summary, { attempted: 9, completed: 1, deferred: 0, skipped: 0, failed: 8,
    inspected: 9, pages: 2, stopReason: 'failed', hasMore: true, oldestDueAgeMs: 1000 });
  assert.equal(logs.length, 8);
  assert.doesNotMatch(JSON.stringify(logs), /claimCodes|ABCDEF|private-invalid-operation/);
});

for (const nextAttemptAtMs of [-1, 0.5]) for (const badCount of [1, 8]) {
  test(`receipt recovery advances past ${badCount} malformed timestamps of ${nextAttemptAtMs}`, async (context) => {
    const logs: unknown[] = [];
    context.mock.method(console, 'error', (entry: unknown) => { logs.push(entry); });
    const fixture = recoveryFixture(context, badCount + 1);
    for (const candidate of fixture.candidates.slice(0, badCount)) {
      fixture.save({ ...candidate, nextAttemptAtMs });
    }
    const loaded: string[] = [];
    const cursors: Array<{ documentPath: string; nextAttemptAtMs: number } | undefined> = [];
    let summary: unknown;
    await assert.rejects(reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
      nowMs: () => 2000,
      queryDue: async (db, cutoff, limit = 20, cursor) => {
        if (limit !== 1) cursors.push(cursor && { documentPath: cursor.documentPath, nextAttemptAtMs: cursor.nextAttemptAtMs });
        return queryDueReceiptClaimWorkflows(db, cutoff, limit, cursor);
      },
      load: async (commerce, operationId) => { loaded.push(operationId); return fixture.load(commerce, operationId); },
      ensure: fixture.complete,
      onResult: (result) => { summary = result; },
    }), (error: unknown) => error instanceof AggregateError && error.errors.length === badCount);
    assert.deepEqual(loaded, [fixture.candidates[badCount].operationId]);
    assert.deepEqual(cursors, badCount === 8
      ? [undefined, { documentPath: fixture.candidates[7].documentPath, nextAttemptAtMs }]
      : [undefined]);
    assert.deepEqual(summary, { attempted: badCount + 1, completed: 1, deferred: 0, skipped: 0, failed: badCount,
      inspected: badCount + 1, pages: badCount === 8 ? 2 : 1, stopReason: 'failed', hasMore: true, oldestDueAgeMs: null });
    assert.equal(logs.length, badCount);
    assert.doesNotMatch(JSON.stringify(logs), /claimCodes|ABCDEF/);
  });
}

test('receipt recovery excludes non-finite timestamps without blocking healthy work or its backlog probe', async (context) => {
  const fixture = recoveryFixture(context, 9);
  const poisoned = fixture.candidates.slice(0, 8);
  for (const candidate of poisoned) {
    const raw = `{"receiptClaimWorkflowV1":{"phase":"pending","nextAttemptAtMs":-1e999,"operationId":${JSON.stringify(candidate.operationId)}}}`;
    fixture.database.prepare('UPDATE commerce_documents SET document_json = ?, version = version + 1 WHERE document_path = ?')
      .run(raw, candidate.documentPath);
  }
  const readPoisoned = () => poisoned.map(candidate => fixture.database.prepare(
    'SELECT * FROM commerce_documents WHERE document_path = ?',
  ).get(candidate.documentPath));
  const before = readPoisoned();
  const loaded: string[] = [];
  const result = await reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
    nowMs: () => 2000,
    load: async (commerce, operationId) => { loaded.push(operationId); return fixture.load(commerce, operationId); },
    ensure: fixture.complete,
  });
  assert.deepEqual(loaded, [fixture.candidates[8].operationId]);
  assert.deepEqual(result, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0,
    inspected: 1, pages: 1, stopReason: 'drained', hasMore: false, oldestDueAgeMs: null });
  assert.deepEqual(readPoisoned(), before);
});

test('receipt recovery uses the shared inspection limit and reports a remaining backlog', async (context) => {
  const fixture = recoveryFixture(context, 33);
  let completed = 0;
  const result = await reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
    nowMs: () => 2000,
    load: fixture.load,
    ensure: async (env, snapshot) => { completed += 1; return fixture.complete(env, snapshot); },
  });
  assert.equal(completed, 32);
  assert.deepEqual(result, { attempted: 32, completed: 32, deferred: 0, skipped: 0, failed: 0,
    inspected: 32, pages: 4, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 1000 });
});

test('receipt recovery finishes active work at its soft time limit before probing the backlog', async (context) => {
  const fixture = recoveryFixture(context, 2);
  let monotonic = 0;
  const completed: string[] = [];
  const result = await reconcileReceiptClaimWorkflows(fixture.env, new AbortController().signal, {
    nowMs: () => 2000,
    monotonicNowMs: () => monotonic,
    load: fixture.load,
    ensure: async (env, snapshot) => {
      monotonic = 20_000;
      const result = await fixture.complete(env, snapshot);
      completed.push(result.operation.operationId);
      return result;
    },
  });
  assert.deepEqual(completed, [fixture.candidates[0].operationId]);
  assert.deepEqual(result, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0,
    inspected: 1, pages: 1, stopReason: 'time-limit', hasMore: true, oldestDueAgeMs: 1000 });
});

test('cron cancellation before discovery never queries and reports an empty result', async () => {
  const fixture = harness();
  const cancellation = new Error('cancelled');
  const summaries: unknown[] = [];
  await assert.rejects(reconcileReceiptClaimWorkflows(fixture.env, AbortSignal.abort(cancellation), {
    queryDue: async () => assert.fail('cancelled discovery must not query'),
    onResult: (result) => { summaries.push(result); },
  }), (error: unknown) => error === cancellation);
  assert.deepEqual(summaries, [{ attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0,
    inspected: 0, pages: 0, stopReason: 'cancelled', hasMore: null, oldestDueAgeMs: null }]);
});

test('cron cancellation between operations preserves its reason after an earlier failure', async () => {
  const fixture = harness();
  const controller = new AbortController();
  const cancellation = new Error('cancelled');
  const failure = new Error('load failed');
  const candidates = [0, 1, 2].map((index) => dueCandidate(index));
  const loaded: string[] = [];
  const summaries: unknown[] = [];
  await assert.rejects(reconcileReceiptClaimWorkflows(fixture.env, controller.signal, {
    queryDue: async () => candidates,
    load: async (_context, operationId) => {
      loaded.push(operationId);
      if (operationId === candidates[0].operationId) throw failure;
      return fixture.snapshot;
    },
    ensure: async (_env, snapshot) => { controller.abort(cancellation); return snapshot; },
    onResult: (result) => { summaries.push(result); },
  }), (error: unknown) => error === cancellation);
  assert.deepEqual(loaded, candidates.slice(0, 2).map((candidate) => candidate.operationId));
  assert.deepEqual(summaries, [{ attempted: 2, completed: 0, deferred: 1, skipped: 0, failed: 1,
    inspected: 2, pages: 1, stopReason: 'cancelled', hasMore: null, oldestDueAgeMs: null }]);
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
