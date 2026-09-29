import assert from 'node:assert/strict';
import test from 'node:test';
import { drainNotificationCandidates } from '../src/notificationReconciliation.ts';

test('an aborted pass never queries and preserves the original cancellation', async () => {
  const cancellation = new Error('cancelled');
  await assert.rejects(drainNotificationCandidates({
    signal: AbortSignal.abort(cancellation),
    loadCandidates: async () => assert.fail('cancelled pass must not query'),
    processCandidate: async () => assert.fail('cancelled pass must not publish'),
    failureMessage: 'reconciliation failed',
  }), (error: unknown) => error === cancellation);
});

test('candidate query failures propagate without being wrapped', async () => {
  const failure = new Error('database unavailable');
  await assert.rejects(drainNotificationCandidates({
    signal: new AbortController().signal,
    loadCandidates: async () => { throw failure; },
    processCandidate: async () => assert.fail('failed query must not publish'),
    failureMessage: 'reconciliation failed',
  }), (error: unknown) => error === failure);
});

test('a bounded pass preserves weighted counts, skipped candidates, and the stop boundary', async () => {
  const visited: number[] = [];
  assert.equal(await drainNotificationCandidates({
    signal: new AbortController().signal,
    loadCandidates: async () => [2, 0, 3, -1, 4],
    processCandidate: async (candidate) => {
      visited.push(candidate);
      return candidate < 0 ? 'stop' : candidate;
    },
    failureMessage: 'reconciliation failed',
  }), 5);
  assert.deepEqual(visited, [2, 0, 3, -1]);
});

test('a failed candidate does not block later work and cancellation retains prior failures', async () => {
  const controller = new AbortController();
  const failure = new Error('queue unavailable');
  const cancellation = new Error('cancelled');
  const visited: number[] = [];
  const failures: Array<{ candidate: number; error: unknown }> = [];
  await assert.rejects(drainNotificationCandidates({
    signal: controller.signal,
    loadCandidates: async () => [1, 2, 3],
    processCandidate: async (candidate) => {
      visited.push(candidate);
      if (candidate === 1) throw failure;
      controller.abort(cancellation);
      return 1;
    },
    onFailure: (candidate, error) => { failures.push({ candidate, error }); },
    failureMessage: 'reconciliation failed',
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'reconciliation failed');
    assert.deepEqual(error.errors, [failure, cancellation]);
    return true;
  });
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(failures, [{ candidate: 1, error: failure }]);
});

test('cancellation during the final successful publication does not discard its result', async () => {
  const controller = new AbortController();
  assert.equal(await drainNotificationCandidates({
    signal: controller.signal,
    loadCandidates: async () => [1],
    processCandidate: async () => {
      controller.abort(new Error('cancelled after enqueue'));
      return 2;
    },
    failureMessage: 'reconciliation failed',
  }), 2);
});
