import assert from 'node:assert/strict';
import test from 'node:test';
import { drainReconciliationCandidates } from '../src/reconciliationPass.ts';

test('an aborted pass never queries and preserves the original cancellation', async () => {
  const cancellation = new Error('cancelled');
  const summaries: unknown[] = [];
  await assert.rejects(drainReconciliationCandidates({
    signal: AbortSignal.abort(cancellation),
    loadCandidates: async () => assert.fail('cancelled pass must not query'),
    processCandidate: async () => assert.fail('cancelled pass must not publish'),
    failureMessage: 'reconciliation failed',
    onResult: (result) => { summaries.push(result); },
  }), (error: unknown) => error === cancellation);
  assert.deepEqual(summaries, [{ attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 }]);
});

test('candidate query failures propagate without being wrapped', async () => {
  const failure = new Error('database unavailable');
  const summaries: unknown[] = [];
  await assert.rejects(drainReconciliationCandidates({
    signal: new AbortController().signal,
    loadCandidates: async () => { throw failure; },
    processCandidate: async () => assert.fail('failed query must not publish'),
    failureMessage: 'reconciliation failed',
    onResult: (result) => { summaries.push(result); throw new Error('reporter unavailable'); },
  }), (error: unknown) => error === failure);
  assert.deepEqual(summaries, [{ attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 }]);
});

test('a bounded pass counts candidate outcomes and preserves the stop boundary', async () => {
  const visited: number[] = [];
  assert.deepEqual(await drainReconciliationCandidates({
    signal: new AbortController().signal,
    loadCandidates: async () => [2, 0, 3, -1, 4],
    processCandidate: async (candidate) => {
      visited.push(candidate);
      return candidate < 0 ? 'stop' : candidate === 0 ? 'skipped' : 'completed';
    },
    failureMessage: 'reconciliation failed',
  }), { attempted: 3, completed: 2, deferred: 0, skipped: 1, failed: 0 });
  assert.deepEqual(visited, [2, 0, 3, -1]);
});

test('a failed candidate does not block later work and cancellation retains prior failures', async () => {
  const controller = new AbortController();
  const failure = new Error('queue unavailable');
  const cancellation = new Error('cancelled');
  const visited: number[] = [];
  const failures: Array<{ candidate: number; error: unknown }> = [];
  const summaries: unknown[] = [];
  await assert.rejects(drainReconciliationCandidates({
    signal: controller.signal,
    loadCandidates: async () => [1, 2, 3],
    processCandidate: async (candidate) => {
      visited.push(candidate);
      if (candidate === 1) throw failure;
      controller.abort(cancellation);
      return 'completed';
    },
    onFailure: (candidate, error) => { failures.push({ candidate, error }); },
    onResult: (result) => { summaries.push(result); },
    failureMessage: 'reconciliation failed',
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'reconciliation failed');
    assert.deepEqual(error.errors, [failure, cancellation]);
    return true;
  });
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(failures, [{ candidate: 1, error: failure }]);
  assert.deepEqual(summaries, [{ attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 }]);
});

test('cancellation during the final successful publication does not discard its result', async () => {
  const controller = new AbortController();
  assert.deepEqual(await drainReconciliationCandidates({
    signal: controller.signal,
    loadCandidates: async () => [1],
    processCandidate: async () => {
      controller.abort(new Error('cancelled after enqueue'));
      return 'completed';
    },
    failureMessage: 'reconciliation failed',
    onResult: () => { throw new Error('reporter unavailable'); },
  }), { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
});

test('failure logging cannot stop the next candidate or replace its original error', async () => {
  const failure = { privateDetail: 'original rejection' };
  const visited: number[] = [];
  const summaries: unknown[] = [];
  await assert.rejects(drainReconciliationCandidates({
    signal: new AbortController().signal,
    loadCandidates: async () => [1, 2],
    processCandidate: async (candidate) => {
      visited.push(candidate);
      if (candidate === 1) throw failure;
      return 'deferred';
    },
    onFailure: () => { throw new Error('logger unavailable'); },
    onResult: (result) => { summaries.push(result); },
    failureMessage: 'reconciliation failed',
  }), (error: unknown) => error instanceof AggregateError && error.errors[0] === failure);
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(summaries, [{ attempted: 2, completed: 0, deferred: 1, skipped: 0, failed: 1 }]);
});

test('throw cancellation mode preserves the original reason and earlier outcome counts', async () => {
  const controller = new AbortController();
  const failure = new Error('processing failed');
  const cancellation = new Error('cancelled');
  const visited: number[] = [];
  const summaries: unknown[] = [];
  await assert.rejects(drainReconciliationCandidates({
    signal: controller.signal,
    cancellationMode: 'throw',
    loadCandidates: async () => [1, 2, 3],
    processCandidate: async (candidate) => {
      visited.push(candidate);
      if (candidate === 1) throw failure;
      controller.abort(cancellation);
      return 'deferred';
    },
    failureMessage: 'reconciliation failed',
    onResult: (result) => { summaries.push(result); },
  }), (error: unknown) => error === cancellation);
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(summaries, [{ attempted: 2, completed: 0, deferred: 1, skipped: 0, failed: 1 }]);
});

test('disabled pre-load cancellation still loads candidates and checks before processing', async () => {
  const cancellation = new Error('cancelled');
  for (const candidates of [[], [1]]) {
    let loaded = false;
    const summaries: unknown[] = [];
    const pass = drainReconciliationCandidates({
      signal: AbortSignal.abort(cancellation),
      checkAbortedBeforeLoad: false,
      cancellationMode: 'throw',
      loadCandidates: async () => { loaded = true; return candidates; },
      processCandidate: async () => assert.fail('cancelled pass must not process candidates'),
      failureMessage: 'reconciliation failed',
      onResult: (result) => { summaries.push(result); },
    });
    if (candidates.length) await assert.rejects(pass, (error: unknown) => error === cancellation);
    else assert.deepEqual(await pass, { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 });
    assert.equal(loaded, true);
    assert.deepEqual(summaries, [{ attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 }]);
  }
});

test('failed outcomes resolve but thrown failures reject after later candidates finish', async () => {
  for (const cancellationMode of ['aggregate', 'throw'] as const) {
    const observedFailures: unknown[] = [];
    assert.deepEqual(await drainReconciliationCandidates({
      signal: new AbortController().signal,
      cancellationMode,
      loadCandidates: async () => [1, 2],
      processCandidate: async (candidate) => candidate === 1 ? 'failed' : 'completed',
      onFailure: (_candidate, error) => { observedFailures.push(error); },
      failureMessage: 'reconciliation failed',
    }), { attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 });
    assert.deepEqual(observedFailures, []);

    const failure = new Error('processing failed');
    const visited: number[] = [];
    const summaries: unknown[] = [];
    await assert.rejects(drainReconciliationCandidates({
      signal: new AbortController().signal,
      cancellationMode,
      loadCandidates: async () => [1, 2],
      processCandidate: async (candidate) => {
        visited.push(candidate);
        if (candidate === 1) throw failure;
        return 'completed';
      },
      failureMessage: 'reconciliation failed',
      onResult: (result) => { summaries.push(result); },
    }), (error: unknown) => error instanceof AggregateError && error.message === 'reconciliation failed' &&
      error.errors.length === 1 && error.errors[0] === failure);
    assert.deepEqual(visited, [1, 2]);
    assert.deepEqual(summaries, [{ attempted: 2, completed: 1, deferred: 0, skipped: 0, failed: 1 }]);
  }
});

test('final-candidate cancellation never replaces a completed outcome or thrown failure', async () => {
  for (const cancellationMode of ['aggregate', 'throw'] as const) {
    for (const fails of [false, true]) {
      const controller = new AbortController();
      const failure = new Error('final processing failed');
      const pass = drainReconciliationCandidates({
        signal: controller.signal,
        cancellationMode,
        loadCandidates: async () => [1],
        processCandidate: async () => {
          controller.abort(new Error('cancelled'));
          if (fails) throw failure;
          return 'completed';
        },
        failureMessage: 'reconciliation failed',
      });
      if (fails) {
        await assert.rejects(pass, (error: unknown) => error instanceof AggregateError &&
          error.errors.length === 1 && error.errors[0] === failure);
      } else {
        assert.deepEqual(await pass, { attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0 });
      }
    }
  }
});
