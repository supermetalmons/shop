import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
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
  let nowMs = 1000;
  const steps = {
    async do(name: string, config: { retries: { limit: number } }, callback: () => Promise<unknown>) {
      let failure: unknown;
      for (let attempt = 0; attempt <= config.retries.limit; attempt += 1) {
        calls.push(name);
        try {
          const output = await callback();
          outputs.push(output);
          return output;
        } catch (error) { failure = error; }
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
  return { snapshot, calls, outputs, steps, dependencies, run, expire: () => { nowMs = 902000; } };
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
