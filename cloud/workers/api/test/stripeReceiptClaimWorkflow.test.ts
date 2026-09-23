import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { StripeReceiptClaimError } from '../src/stripeReceiptClaimErrors.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { RECEIPT_OPERATION_ID, RECEIPT_RESULT, receiptWorkflowSnapshot, receiptWorkflowSubmission } from './stripeReceiptClaimWorkflowFixtures.ts';

const { runStripeReceiptClaimWorkflow } = await loadCloudflareWorkersModule(() => import('../src/stripeReceiptClaimWorkflow.ts'));
const env = { COMMERCE_DB: {} } as Env;
const event = {
  instanceId: `${RECEIPT_OPERATION_ID}-g1`, timestamp: new Date(1000),
  payload: { version: 1 as const, operationId: RECEIPT_OPERATION_ID, generation: 1 },
} as WorkflowEvent<{ version: 1; operationId: string; generation: number }>;

function harness() {
  const snapshot = receiptWorkflowSnapshot();
  const calls: string[] = [];
  const outputs: unknown[] = [];
  const attempts: Array<{ name: string; attempt: number }> = [];
  const boundaryErrors: Array<{ name: string; message: string }> = [];
  let nowMs = 1000;
  const steps = {
    async do(name: string, config: { retries: { limit: number } }, callback: (context: { attempt: number }) => Promise<unknown>) {
      let failure: unknown;
      for (let attempt = 1; attempt <= config.retries.limit + 1; attempt += 1) {
        calls.push(name);
        attempts.push({ name, attempt });
        try {
          const output = await callback({ attempt });
          outputs.push(output);
          return output;
        } catch (error) {
          const value = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : {};
          const message = typeof value.message === 'string' ? value.message : 'Workflow step failed.';
          const name = typeof value.name === 'string' ? value.name : 'Error';
          const boundaryError = new Error(name === 'Error' ? message : `${name}: ${message}`);
          boundaryErrors.push({ name: boundaryError.name, message: boundaryError.message });
          failure = boundaryError;
        }
      }
      throw failure;
    },
    async sleep() { nowMs += 5000; },
  };
  const dependencies = {
    load: async () => structuredClone(snapshot),
    authority: async () => ({ state: 'd1' as const, revision: 1, documentsRevision: 0 }),
    nowMs: () => nowMs,
    reconcile: async () => snapshot.operation.submission
      ? { status: 'complete' as const, result: RECEIPT_RESULT }
      : { status: 'prepare' as const },
    prepare: async () => { calls.push('prepare'); return receiptWorkflowSubmission(); },
    persist: async (_context: unknown, _snapshot: unknown, submission: ReturnType<typeof receiptWorkflowSubmission>) => {
      calls.push('persist'); snapshot.operation.submission = submission;
    },
    broadcast: async () => {
      assert.equal(snapshot.operation.submission?.signature, 'signature'); calls.push('broadcast');
    },
    complete: async () => { snapshot.operation.phase = 'complete'; snapshot.operation.result = RECEIPT_RESULT; },
    fail: async (_context: unknown, _snapshot: unknown, error: NonNullable<typeof snapshot.operation.error>, manual: boolean) => {
      snapshot.operation.phase = manual ? 'manual_review' : 'failed'; snapshot.operation.error = error;
    },
  };
  const run = (overrides: Partial<typeof dependencies> = {}) => runStripeReceiptClaimWorkflow(
    env, event, steps as unknown as Pick<WorkflowStep, 'do' | 'sleep'>, { ...dependencies, ...overrides },
  );
  return { snapshot, calls, outputs, attempts, boundaryErrors, steps, dependencies, run, expire: () => { nowMs = 902000; } };
}

test('Workflow journals before broadcast and returns only references from durable steps', async () => {
  const fixture = harness();
  assert.equal((await fixture.run()).status, 'complete');
  assert.ok(fixture.calls.indexOf('persist') < fixture.calls.indexOf('broadcast'));
  assert.doesNotMatch(JSON.stringify(fixture.outputs), /signed-bytes|ABCDEF-1234567890/);
});

test('lost journal acknowledgement reuses the persisted transaction on step retry', async () => {
  const fixture = harness();
  await fixture.run({ persist: async (...args) => { await fixture.dependencies.persist(...args); throw new Error('lost acknowledgement'); } });
  assert.equal(fixture.calls.filter((entry) => entry === 'prepare').length, 1);
  assert.equal(fixture.calls.filter((entry) => entry === 'broadcast').length, 1);
  assert.equal(fixture.snapshot.operation.phase, 'complete');
});

test('lost completion acknowledgement still resolves from durable completion', async () => {
  const fixture = harness();
  const result = await fixture.run({ complete: async () => { await fixture.dependencies.complete(); throw new Error('lost acknowledgement'); } });
  assert.equal(result.status, 'complete');
  assert.equal(fixture.snapshot.operation.phase, 'complete');
});

test('confirmation deadline retains the operation for explicit recovery without broadcast', async () => {
  const fixture = harness();
  fixture.expire();
  assert.equal((await fixture.run()).status, 'failed');
  assert.equal(fixture.snapshot.operation.phase, 'manual_review');
  assert.equal(fixture.snapshot.operation.error?.code, 'deadline-exceeded');
  assert.ok(!fixture.calls.includes('broadcast'));
});

test('transient stages retry four times then persist a retryable terminal outcome', async () => {
  const fixture = harness();
  await fixture.run({ reconcile: async () => { throw new Error('provider unavailable'); } });
  assert.equal(fixture.calls.filter((name) => name === 'reconcile receipt 0').length, 5);
  assert.equal(fixture.snapshot.operation.error?.retryable, true);
});

const RETRYABLE_CODES = ['aborted', 'deadline-exceeded', 'unavailable', 'internal', 'resource-exhausted'] as const;
const RETRY_MESSAGE = 'Receipt claiming is temporarily unavailable. Retry with the same receiver address.';

for (const code of RETRYABLE_CODES) {
  test(`receipt Workflow preserves ${code} across retry exhaustion without exposing provider details`, async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const fixture = harness();
    const rawMessage = `private ${code} provider response`;
    const result = await fixture.run({
      reconcile: async () => { throw new StripeReceiptClaimError(code, rawMessage); },
    });

    assert.equal(result.status, 'failed');
    assert.equal(fixture.snapshot.operation.phase, 'manual_review');
    assert.deepEqual(fixture.snapshot.operation.error, { code, message: RETRY_MESSAGE, retryable: true });
    assert.deepEqual(fixture.attempts.filter(({ name }) => name === 'reconcile receipt 0').map(({ attempt }) => attempt), [1, 2, 3, 4, 5]);
    assert.equal(fixture.boundaryErrors.length, 5);
    assert.equal(JSON.stringify(fixture.boundaryErrors).includes(rawMessage), false);
    assert.equal(JSON.stringify(log.mock.calls.map(({ arguments: args }) => args)).includes(rawMessage), false);
  });
}

test('terminal receipt Workflow failures execute once and retain their domain result', async () => {
  const fixture = harness();
  const failure = { code: 'failed-precondition' as const, message: 'Receipt configuration no longer matches.', retryable: false };
  const result = await fixture.run({
    reconcile: async () => { throw new StripeReceiptClaimError(failure.code, failure.message); },
  });

  assert.equal(result.status, 'failed');
  assert.equal(fixture.snapshot.operation.phase, 'failed');
  assert.deepEqual(fixture.snapshot.operation.error, failure);
  assert.equal(fixture.calls.filter((name) => name === 'reconcile receipt 0').length, 1);
  assert.deepEqual(fixture.outputs[0], { ok: false, error: failure });
  assert.equal(fixture.boundaryErrors.length, 0);
});

test('legacy generic receipt step errors retain the safe unavailable fallback', async () => {
  const fixture = harness();
  const originalDo = fixture.steps.do.bind(fixture.steps);
  fixture.steps.do = async (name, config, callback) => {
    if (name === 'reconcile receipt 0') throw new Error('Receipt claim Workflow stage is temporarily unavailable.');
    return originalDo(name, config, callback);
  };

  assert.equal((await fixture.run()).status, 'failed');
  assert.deepEqual(fixture.snapshot.operation.error, { code: 'unavailable', message: RETRY_MESSAGE, retryable: true });
});

test('receipt Workflow logs one-indexed retry attempts and resets attempts for the next step', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const fixture = harness();
  let failures = 2;
  const result = await fixture.run({
    reconcile: async () => {
      if (failures-- > 0) throw new StripeReceiptClaimError('unavailable', 'Provider unavailable.');
      return fixture.dependencies.reconcile();
    },
  });
  const entries = log.mock.calls.map(({ arguments: args }) => args[0] as Record<string, unknown>);

  assert.equal(result.status, 'complete');
  assert.deepEqual(entries.filter((entry) => entry.stage === 'reconcile receipt 0').map((entry) => ({
    attempt: entry.retryAttempt,
    outcome: entry.outcome,
  })), [
    { attempt: 1, outcome: 'retryable_failure' },
    { attempt: 2, outcome: 'retryable_failure' },
    { attempt: 3, outcome: 'succeeded' },
  ]);
  assert.equal(entries.find((entry) => entry.stage === 'journal receipt transaction 0')?.retryAttempt, 1);
});

test('receipt Workflow logging failures leave success and failure persistence unchanged', async (t) => {
  t.mock.method(console, 'log', () => { throw new Error('Console unavailable.'); });
  const success = harness();
  assert.equal((await success.run()).status, 'complete');
  assert.equal(success.calls.filter((name) => name === 'broadcast').length, 1);

  const failure = harness();
  assert.equal((await failure.run({
    reconcile: async () => { throw new StripeReceiptClaimError('failed-precondition', 'Receipt configuration changed.'); },
  })).status, 'failed');
  assert.equal(failure.snapshot.operation.error?.code, 'failed-precondition');
  assert.equal(failure.calls.filter((name) => name === 'persist receipt claim failure').length, 1);
});

test('a receipt dependency error with an engine-abort message is still retried', async () => {
  const fixture = harness();
  const result = await fixture.run({ reconcile: async () => { throw new Error('Aborting engine: provider message'); } });

  assert.equal(result.status, 'failed');
  assert.equal(fixture.calls.filter((name) => name === 'reconcile receipt 0').length, 5);
  assert.deepEqual(fixture.snapshot.operation.error, { code: 'unavailable', message: RETRY_MESSAGE, retryable: true });
});

test('receipt Workflow keeps its business and cleanup action timeout margins', async (t) => {
  const timeout = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const success = harness();
  assert.equal((await success.run()).status, 'complete');
  assert.deepEqual(timeout.mock.calls.map(({ arguments: args }) => args[0]), Array(5).fill(55_000));
  timeout.mock.resetCalls();

  const failure = harness();
  await failure.run({
    reconcile: async () => { throw new StripeReceiptClaimError('failed-precondition', 'Receipt configuration changed.'); },
  });
  assert.deepEqual(timeout.mock.calls.map(({ arguments: args }) => args[0]), [55_000, 25_000]);
});

test('a stale generation cannot publish failure over its replacement', async () => {
  const fixture = harness();
  fixture.snapshot.operation.generation = 2;
  assert.equal((await fixture.run()).status, 'superseded');
  assert.equal(fixture.snapshot.operation.phase, 'pending');
  assert.ok(!fixture.calls.includes('broadcast'));
});

test('Workflow engine cancellation escapes without changing durable operation state', async () => {
  const fixture = harness();
  fixture.steps.do = async () => { throw new Error('Aborting engine: test'); };
  await assert.rejects(fixture.run(), /Aborting engine/);
  assert.equal(fixture.snapshot.operation.phase, 'pending');
});

test('recreated terminal generations finish without preparing or broadcasting a transfer', async () => {
  const fixture = harness();
  fixture.snapshot.operation.phase = 'manual_review';
  fixture.snapshot.operation.error = { code: 'unavailable', message: 'Retry later.', retryable: true };
  assert.equal((await fixture.run()).status, 'failed');
  assert.ok(!fixture.calls.includes('prepare'));
  assert.ok(!fixture.calls.includes('broadcast'));
  assert.equal(fixture.snapshot.operation.phase, 'manual_review');
});
