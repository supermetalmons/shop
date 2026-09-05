import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection, SignatureStatus } from '@solana/web3.js';
import {
  hasConfirmedSignatureCommitment,
  probeTransactionSubmission,
  type TransactionSubmissionOutcome,
} from '../src/transactionSubmissionRecovery.ts';

const SIGNATURE = 'submission-signature';
const BLOCKHASH = 'submission-blockhash';
type ProbeStage = 'status' | 'account-evidence' | 'blockhash';

function probeHarness(options: {
  status?: SignatureStatus | null;
  landed?: boolean;
  blockhashValid?: boolean;
  failure?: { stage: ProbeStage; reason: unknown };
} = {}) {
  const calls: ProbeStage[] = [];
  const enter = (stage: ProbeStage) => {
    calls.push(stage);
    if (options.failure?.stage === stage) throw options.failure.reason;
  };
  const connection: Pick<Connection, 'getSignatureStatuses' | 'isBlockhashValid'> = {
    getSignatureStatuses: async (signatures, config) => {
      assert.deepEqual(signatures, [SIGNATURE]);
      assert.deepEqual(config, { searchTransactionHistory: true });
      enter('status');
      return { context: { slot: 1 }, value: [options.status ?? null] };
    },
    isBlockhashValid: async (blockhash, config) => {
      assert.equal(blockhash, BLOCKHASH);
      assert.deepEqual(config, { commitment: 'confirmed' });
      enter('blockhash');
      return { context: { slot: 1 }, value: options.blockhashValid ?? true };
    },
  };
  return {
    calls,
    probe: () => probeTransactionSubmission({
      connection,
      signature: SIGNATURE,
      blockhash: BLOCKHASH,
      hasLanded: async () => {
        enter('account-evidence');
        return options.landed ?? false;
      },
    }),
  };
}

test('present signature statuses decide recovery before account or blockhash checks', async () => {
  const cases: Array<{
    name: string;
    status: Partial<SignatureStatus>;
    outcome: TransactionSubmissionOutcome;
  }> = [
    { name: 'confirmed', status: { confirmationStatus: 'confirmed' }, outcome: 'confirmed' },
    { name: 'finalized', status: { confirmationStatus: 'finalized' }, outcome: 'confirmed' },
    { name: 'legacy rooted', status: { confirmations: null }, outcome: 'confirmed' },
    { name: 'legacy confirmed', status: { confirmations: 2 }, outcome: 'confirmed' },
    { name: 'legacy unconfirmed', status: { confirmations: 0 }, outcome: 'unresolved' },
    { name: 'processed overrides rooted', status: { confirmationStatus: 'processed', confirmations: null }, outcome: 'unresolved' },
    { name: 'processed overrides confirmations', status: { confirmationStatus: 'processed', confirmations: 2 }, outcome: 'unresolved' },
    { name: 'error overrides confirmed', status: { confirmationStatus: 'confirmed', err: 'AccountNotFound' }, outcome: 'expired' },
    { name: 'error overrides rooted', status: { confirmations: null, err: 'AccountNotFound' }, outcome: 'expired' },
  ];
  for (const { name, status, outcome } of cases) {
    const harness = probeHarness({
      status: { slot: 1, confirmations: 0, err: null, ...status },
      landed: true,
    });
    assert.equal(await harness.probe(), outcome, name);
    assert.deepEqual(harness.calls, ['status'], name);
  }
});

test('absent signature statuses use account evidence before blockhash expiry', async () => {
  const cases: Array<{
    landed: boolean;
    blockhashValid: boolean;
    outcome: TransactionSubmissionOutcome;
  }> = [
    { landed: true, blockhashValid: false, outcome: 'confirmed' },
    { landed: false, blockhashValid: true, outcome: 'unresolved' },
    { landed: false, blockhashValid: false, outcome: 'expired' },
  ];
  for (const scenario of cases) {
    const harness = probeHarness(scenario);
    assert.equal(await harness.probe(), scenario.outcome);
    assert.deepEqual(harness.calls, scenario.landed
      ? ['status', 'account-evidence']
      : ['status', 'account-evidence', 'blockhash']);
  }
});

test('provider failures and cancellation reasons propagate without later probes', async () => {
  const stages: ProbeStage[] = ['status', 'account-evidence', 'blockhash'];
  for (const stage of stages) {
    for (const reason of [new Error(`${stage} failed`), new DOMException(`${stage} cancelled`, 'AbortError')]) {
      const harness = probeHarness({ failure: { stage, reason } });
      await assert.rejects(harness.probe(), (error: unknown) => error === reason);
      assert.deepEqual(harness.calls, stages.slice(0, stages.indexOf(stage) + 1));
    }
  }
});

test('legacy confirmation requires a rooted status or a positive safe integer', () => {
  assert.equal(hasConfirmedSignatureCommitment(null), false);
  assert.equal(hasConfirmedSignatureCommitment(undefined), false);
  for (const confirmations of [-1, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(hasConfirmedSignatureCommitment({ confirmations }), false);
  }
  assert.equal(hasConfirmedSignatureCommitment({ confirmations: null, confirmationStatus: 'unknown' }), false);
});
