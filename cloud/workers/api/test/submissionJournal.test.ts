import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys } from '../src/commerceRepository.js';
import type { CommerceRepositoryContext } from '../src/commerceTransactions.js';
import { mutateSubmissionJournal } from '../src/submissionJournal.js';
import { createCommerceD1Harness, seedCommerceDocuments } from './commerceD1Harness.js';

const key = commerceKeys.deliveryOrder('card_nft_2', '7');

function journalContext(testContext: TestContext, status: string | number = 'applied'): CommerceRepositoryContext {
  const harness = createCommerceD1Harness();
  testContext.after(() => harness.database.close());
  seedCommerceDocuments(harness, [{ key, data: { status } }]);
  return {
    repository: new D1CommerceRepository(harness.db),
    nowMs: 100,
    signal: new AbortController().signal,
  };
}

for (const phase of ['persist', 'settle'] as const) {
  for (const recovery of ['read-failure', 'malformed', 'not-applied', 'missing'] as const) {
    test(`${phase} preserves the original error after ${recovery} recovery with a cancelled request`, async (t) => {
      const context = journalContext(t, recovery === 'malformed' ? 123 : 'pending');
      const controller = new AbortController();
      context.signal = controller.signal;
      const original = new Error('mutation acknowledgement lost');
      t.mock.method(context.repository, 'run', async () => {
        controller.abort(original);
        throw original;
      });
      if (recovery === 'read-failure') {
        t.mock.method(context.repository, 'get', async () => { throw new Error('recovery read failed'); });
      } else if (recovery === 'missing') {
        t.mock.method(context.repository, 'get', async () => null);
      }
      let cleanupCount = 0;

      await assert.rejects(mutateSubmissionJournal({
        context,
        key,
        phase,
        createCleanupContext: () => {
          cleanupCount += 1;
          return { ...context, signal: new AbortController().signal };
        },
        plan: () => assert.fail('the failed transaction cannot plan a mutation'),
        isApplied: (document) => {
          if (!document) return false;
          if (typeof document.data.status !== 'string') throw new Error('malformed recovery state');
          return document.data.status === 'applied';
        },
      }), (error: unknown) => error === original);
      assert.equal(context.signal.aborted, true);
      assert.equal(cleanupCount, 1);
    });
  }

  test(`${phase} accepts verified persisted state after request cancellation`, async (t) => {
    const context = journalContext(t);
    const cancellation = new Error('request cancelled after commit');
    const controller = new AbortController();
    context.signal = controller.signal;
    t.mock.method(context.repository, 'run', async () => {
      controller.abort(cancellation);
      throw cancellation;
    });
    let verified = false;
    await mutateSubmissionJournal({
      context,
      key,
      phase,
      createCleanupContext: () => {
        assert.equal(context.signal.aborted, true);
        return { ...context, signal: new AbortController().signal };
      },
      plan: () => assert.fail('the failed transaction cannot plan a mutation'),
      isApplied: (document) => {
        verified = true;
        return document?.data.status === 'applied';
      },
    });
    assert.equal(verified, true);
  });

  test(`${phase} ${phase === 'persist' ? 'rejects' : 'reconciles'} an exhausted write conflict`, async (t) => {
    const context = journalContext(t);
    const conflict = new CommerceWriteConflict();
    const run = t.mock.method(context.repository, 'run', async () => { throw conflict; });
    let cleanupCount = 0;
    const mutation = mutateSubmissionJournal({
      context,
      key,
      phase,
      createCleanupContext: () => {
        cleanupCount += 1;
        return { ...context, signal: new AbortController().signal };
      },
      plan: () => assert.fail('the conflicting transaction cannot plan a mutation'),
      isApplied: (document) => document?.data.status === 'applied',
    });
    if (phase === 'persist') {
      await assert.rejects(mutation, (error: unknown) => error === conflict);
      assert.equal(cleanupCount, 0);
    } else {
      await mutation;
      assert.equal(cleanupCount, 1);
    }
    assert.equal(run.mock.callCount(), 6);
  });
}
