import assert from 'node:assert/strict';
import test from 'node:test';
import type { RevealSubmissionRecord } from '../src/revealSubmissionD1.ts';
import { resolveRevealSubmission } from '../src/revealSubmissionLifecycle.ts';

const submission: RevealSubmissionRecord = {
  owner: 'owner',
  signature: 'signature',
  recentBlockhash: 'blockhash',
  blockhashContextSlot: 1,
  dudeIds: [9],
  reservationId: 'reservation',
  status: 'pending',
};

test('terminal submissions resolve without provider reads or status writes', async () => {
  for (const status of ['confirmed', 'failed'] as const) {
    const unexpected = async (): Promise<never> => {
      assert.fail('terminal submissions must not invoke lifecycle operations');
    };
    assert.equal(await resolveRevealSubmission({
      submission: { ...submission, status },
      reconcile: unexpected,
      confirm: unexpected,
      fail: unexpected,
    }), status);
  }
});

test('observed outcomes confirm success and leave failures for the caller to handle', async () => {
  for (const outcome of ['confirmed', 'failed', 'expired', 'unknown'] as const) {
    const calls: string[] = [];
    assert.equal(await resolveRevealSubmission({
      submission,
      reconcile: async () => {
        calls.push('reconcile');
        return outcome;
      },
      confirm: async () => {
        calls.push('confirm');
      },
    }), outcome);
    assert.deepEqual(calls, outcome === 'confirmed' ? ['reconcile', 'confirm'] : ['reconcile']);
  }
});

test('conditional failure writes preserve concurrent confirmation and stale reservations', async () => {
  for (const outcome of ['failed', 'expired'] as const) {
    for (const persisted of ['confirmed', 'failed', 'stale'] as const) {
      const calls: string[] = [];
      assert.equal(await resolveRevealSubmission({
        submission,
        reconcile: async () => {
          calls.push('reconcile');
          return outcome;
        },
        confirm: async () => {
          assert.fail('a concurrent confirmation must not be written again');
        },
        fail: async () => {
          calls.push('fail');
          return persisted;
        },
      }), persisted);
      assert.deepEqual(calls, ['reconcile', 'fail']);
    }
  }
});

test('confirmed and unknown observations never attempt failure writes', async () => {
  for (const outcome of ['confirmed', 'unknown'] as const) {
    assert.equal(await resolveRevealSubmission({
      submission,
      reconcile: async () => outcome,
      confirm: async () => undefined,
      fail: async () => {
        assert.fail('confirmation and uncertainty must not mark a submission failed');
      },
    }), outcome);
  }
});

test('reconciliation and status-write failures preserve the exact cancellation reason', async () => {
  for (const operation of ['reconcile', 'confirm', 'fail'] as const) {
    const reason = new DOMException(`${operation} cancelled`, 'AbortError');
    await assert.rejects(resolveRevealSubmission({
      submission,
      reconcile: async () => {
        if (operation === 'reconcile') throw reason;
        return operation === 'confirm' ? 'confirmed' : 'expired';
      },
      confirm: async () => {
        throw reason;
      },
      fail: async () => {
        throw reason;
      },
    }), (error: unknown) => error === reason);
  }
});
