import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowStepConfig, WorkflowStepContext } from 'cloudflare:workers';
import { runWorkflowStage, workflowRetryError, workflowRetryErrorCode } from '../src/workflowStage.ts';

const marker = {
  name: 'TestWorkflowRetry',
  messagePrefix: 'test-workflow-retry:',
  isCode: (value: unknown): value is 'aborted' | 'unavailable' => value === 'aborted' || value === 'unavailable',
  fallbackCode: 'unavailable',
} as const;

test('retry codes survive named and RPC errors and reject invalid or unrelated markers', () => {
  const encoded = workflowRetryError(marker, 'aborted');
  const serialized = JSON.parse(JSON.stringify({ name: encoded.name, message: encoded.message }));
  assert.equal(workflowRetryErrorCode(serialized, marker), 'aborted');
  assert.equal(workflowRetryErrorCode(new Error(`${encoded.name}: ${encoded.message}`), marker), 'aborted');
  assert.equal(workflowRetryErrorCode(workflowRetryError(marker, 'permission-denied'), marker), 'unavailable');
  for (const error of [
    null, 'aborted', {}, new Error('aborted'),
    new Error(encoded.message),
    new Error(`OtherWorkflowRetry: ${encoded.message}`),
    new Error(`${marker.name}: ${marker.messagePrefix}permission-denied`),
    new Error(`${marker.name}: ${marker.messagePrefix}aborted:provider details`),
    { ...serialized, name: 'OtherWorkflowRetry' },
    { ...serialized, message: 'other-workflow-retry:aborted' },
    { ...serialized, message: `${marker.messagePrefix}permission-denied` },
    { ...serialized, message: `${marker.messagePrefix}aborted:provider details` },
    { get name() { throw new Error('Unreadable error'); } },
    { name: marker.name, get message() { throw new Error('Unreadable error'); } },
  ]) {
    assert.equal(workflowRetryErrorCode(error, marker), null);
  }
});

const config = { timeout: 60_000, retries: { limit: 4, delay: '2 seconds', backoff: 'exponential' } } as const;

const step = {
  async do<T>(name: string, passedConfig: WorkflowStepConfig, action: (context: WorkflowStepContext) => Promise<T>) {
    assert.equal(name, 'business step');
    assert.strictEqual(passedConfig, config);
    return action({ attempt: 1, step: { name, count: 1 }, config: passedConfig });
  },
};

test('a throwing stage logger cannot retry a successful action or replace its failure', async () => {
  let calls = 0;
  const options = {
    step: step as never,
    name: 'business step',
    config,
    actionTimeoutMs: 55_000,
    retryErrorMarker: marker,
    log: () => { throw new Error('Logger unavailable'); },
    normalizeError: () => ({ code: 'aborted' as const, retryable: true, message: 'Retry later.' }),
  };
  assert.deepEqual(await runWorkflowStage({
    ...options,
    action: async () => { calls += 1; return { reference: 'stored' }; },
  }), { ok: true, value: { reference: 'stored' } });
  assert.equal(calls, 1);
  await assert.rejects(runWorkflowStage({
    ...options,
    action: async () => { throw new Error('Provider failure'); },
  }), (error) => workflowRetryErrorCode(error, marker) === 'aborted');
});

test('step rejection outside the callback escapes without normalization or logging', async () => {
  const failure = new Error('Aborting engine: paused');
  await assert.rejects(runWorkflowStage({
    step: { do: async () => { throw failure; } },
    name: 'business step',
    config,
    actionTimeoutMs: 55_000,
    retryErrorMarker: marker,
    normalizeError: () => assert.fail('Unexpected error normalization'),
    log: () => assert.fail('Unexpected logging'),
    action: async () => assert.fail('Unexpected action execution'),
  }), (error) => error === failure);
});
