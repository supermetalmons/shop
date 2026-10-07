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

test('paged reconciliation stops after thirty-two inspections and reports remaining due work', async () => {
  const remaining = new Set(Array.from({ length: 40 }, (_, index) => index));
  const pages: Array<{ startAfter: number | undefined; limit: number }> = [];
  const result = await drainReconciliationCandidates<number>({
    signal: new AbortController().signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      monotonicNowMs: () => 0,
      loadPage: async (startAfter, limit) => {
        pages.push({ startAfter, limit });
        return [...remaining].filter((value) => startAfter === undefined || value > startAfter).slice(0, limit);
      },
      candidateKey: String,
      probeBacklog: async () => ({ hasMore: remaining.size > 0, oldestDueAgeMs: remaining.size ? 500 : null }),
    },
    processCandidate: async (candidate) => { remaining.delete(candidate); return 'completed'; },
  });
  assert.deepEqual(pages, [undefined, 7, 15, 23].map((startAfter) => ({ startAfter, limit: 8 })));
  assert.deepEqual(result, {
    attempted: 32, completed: 32, deferred: 0, skipped: 0, failed: 0,
    inspected: 32, pages: 4, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 500,
  });
  assert.deepEqual([...remaining], [32, 33, 34, 35, 36, 37, 38, 39]);
});

test('paging passes stuck candidates and probes behind its cursor without hiding failures', async () => {
  const remaining = new Set(Array.from({ length: 10 }, (_, index) => index));
  const visited: number[] = [];
  const summaries: unknown[] = [];
  const failure = new Error('first row failed');
  await assert.rejects(drainReconciliationCandidates<number>({
    signal: new AbortController().signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      monotonicNowMs: () => 0,
      loadPage: async (startAfter, limit) => [...remaining]
        .filter((value) => startAfter === undefined || value > startAfter).slice(0, limit),
      candidateKey: String,
      probeBacklog: async () => ({ hasMore: remaining.size > 0, oldestDueAgeMs: 700 }),
    },
    processCandidate: async (candidate) => {
      visited.push(candidate);
      if (candidate === 0) throw failure;
      if (candidate === 1) return 'skipped';
      remaining.delete(candidate);
      return 'completed';
    },
    onResult: (value) => { summaries.push(value); },
  }), (error: unknown) => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
  assert.deepEqual(visited, Array.from({ length: 10 }, (_, index) => index));
  assert.deepEqual([...remaining], [0, 1]);
  assert.deepEqual(summaries, [{
    attempted: 10, completed: 8, deferred: 0, skipped: 1, failed: 1,
    inspected: 10, pages: 2, stopReason: 'failed', hasMore: true, oldestDueAgeMs: 700,
  }]);
});

test('rows that move forward are deduplicated and still consume the inspection cap', async () => {
  let published = 0;
  let nextPosition = 0;
  const cursors: Array<number | undefined> = [];
  const result = await drainReconciliationCandidates<{ key: string; position: number }>({
    signal: new AbortController().signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      monotonicNowMs: () => 0,
      loadPage: async (startAfter, limit) => {
        cursors.push(startAfter?.position);
        return Array.from({ length: limit }, () => ({ key: 'same-order', position: nextPosition++ }));
      },
      candidateKey: (candidate) => candidate.key,
      probeBacklog: async () => ({ hasMore: true, oldestDueAgeMs: 10 }),
    },
    processCandidate: async () => { published += 1; return 'deferred'; },
  });
  assert.equal(published, 1);
  assert.deepEqual(cursors, [undefined, 7, 15, 23]);
  assert.deepEqual(result, {
    attempted: 1, completed: 0, deferred: 1, skipped: 0, failed: 0,
    inspected: 32, pages: 4, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 10,
  });
});

test('the soft time budget lets an active publication finish and then probes without starting later work', async () => {
  let elapsedMs = 0;
  const visited: number[] = [];
  let finalized = false;
  let probed = false;
  const controller = new AbortController();
  const result = await drainReconciliationCandidates<number>({
    signal: controller.signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      monotonicNowMs: () => elapsedMs,
      loadPage: async () => [1, 2],
      candidateKey: String,
      probeBacklog: async () => {
        assert.equal(finalized, true);
        assert.equal(elapsedMs, 25_000);
        probed = true;
        return { hasMore: true, oldestDueAgeMs: 25_000 };
      },
    },
    processCandidate: async (candidate) => {
      visited.push(candidate);
      elapsedMs = 25_000;
      await Promise.resolve();
      finalized = true;
      return 'completed';
    },
  });
  assert.deepEqual(visited, [1]);
  assert.equal(controller.signal.aborted, false);
  assert.equal(probed, true);
  assert.deepEqual(result, {
    attempted: 1, completed: 1, deferred: 0, skipped: 0, failed: 0,
    inspected: 1, pages: 1, stopReason: 'time-limit', hasMore: true, oldestDueAgeMs: 25_000,
  });
});

test('a later page query failure retains previous outcomes and processing errors', async () => {
  const failure = new Error('processing failed');
  const queryFailure = new Error('query unavailable');
  const summaries: unknown[] = [];
  await assert.rejects(drainReconciliationCandidates<number>({
    signal: new AbortController().signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      monotonicNowMs: () => 0,
      loadPage: async (startAfter) => {
        if (startAfter !== undefined) throw queryFailure;
        return Array.from({ length: 8 }, (_, index) => index);
      },
      candidateKey: String,
      probeBacklog: async () => { throw new Error('probe unavailable'); },
    },
    processCandidate: async (candidate) => {
      if (candidate === 0) throw failure;
      return 'completed';
    },
    onResult: (value) => { summaries.push(value); },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure, queryFailure]);
    return true;
  });
  assert.deepEqual(summaries, [{
    attempted: 8, completed: 7, deferred: 0, skipped: 0, failed: 1,
    inspected: 8, pages: 2, stopReason: 'failed', hasMore: null, oldestDueAgeMs: null,
  }]);
});

test('backlog observation failure leaves a successful drain successful with unknown backlog', async () => {
  const result = await drainReconciliationCandidates<number>({
    signal: new AbortController().signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      loadPage: async () => [1], candidateKey: String,
      probeBacklog: async () => { throw new Error('probe failed'); },
    },
    processCandidate: async () => 'completed',
    onResult: () => { throw new Error('reporting failed'); },
  });
  assert.equal(result.completed, 1);
  assert.equal(result.stopReason, 'drained');
  assert.equal(result.hasMore, null);
  assert.equal(result.oldestDueAgeMs, null);
});

test('paged cancellation preserves finalized work and skips backlog probing', async () => {
  for (const isFinal of [false, true]) {
    const controller = new AbortController();
    const cancellation = new Error('cancelled');
    const summaries: Array<{ completed: number; hasMore?: boolean | null; oldestDueAgeMs?: number | null }> = [];
    const pass = drainReconciliationCandidates<number>({
      signal: controller.signal,
      failureMessage: 'paged reconciliation failed',
      paging: {
        loadPage: async () => isFinal ? [1] : [1, 2], candidateKey: String,
        probeBacklog: async () => assert.fail('aborted drain must not probe'),
      },
      processCandidate: async () => { controller.abort(cancellation); return 'completed'; },
      onResult: (value) => { summaries.push(value); },
    });
    if (isFinal) assert.equal((await pass).completed, 1);
    else await assert.rejects(pass, (error: unknown) => error instanceof AggregateError && error.errors[0] === cancellation);
    assert.equal(summaries[0].completed, 1);
    assert.equal(summaries[0].hasMore, null);
    assert.equal(summaries[0].oldestDueAgeMs, null);
  }
});

test('the outer cancellation bounds a pending backlog observation', async () => {
  const controller = new AbortController();
  const result = await drainReconciliationCandidates<number>({
    signal: controller.signal,
    failureMessage: 'paged reconciliation failed',
    paging: {
      loadPage: async () => [], candidateKey: String,
      probeBacklog: () => {
        controller.abort(new Error('cron deadline reached'));
        return new Promise(() => undefined);
      },
    },
    processCandidate: async () => assert.fail('no work'),
  });
  assert.equal(result.hasMore, null);
  assert.equal(result.oldestDueAgeMs, null);
  assert.equal(result.attempted, 0);
});

test('the outer cancellation bounds a pending page read and reports prior outcomes', async () => {
  for (const afterPage of [false, true]) {
    const controller = new AbortController();
    const cancellation = new Error('cron deadline reached');
    const summaries: Array<{ completed: number; pages?: number; stopReason?: string; hasMore?: boolean | null }> = [];
    await assert.rejects(drainReconciliationCandidates<number>({
      signal: controller.signal,
      failureMessage: 'paged reconciliation failed',
      paging: {
        monotonicNowMs: () => 0,
        loadPage: (startAfter) => {
          if (afterPage && startAfter === undefined) return Promise.resolve(Array.from({ length: 8 }, (_, index) => index));
          queueMicrotask(() => controller.abort(cancellation));
          return new Promise(() => undefined);
        },
        candidateKey: String,
        probeBacklog: async () => assert.fail('cancelled page must not probe'),
      },
      processCandidate: async () => 'completed',
      onResult: (value) => { summaries.push(value); },
    }), (error) => error === cancellation);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].completed, afterPage ? 8 : 0);
    assert.equal(summaries[0].pages, afterPage ? 2 : 1);
    assert.equal(summaries[0].stopReason, 'cancelled');
    assert.equal(summaries[0].hasMore, null);
  }
});
