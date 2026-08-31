import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminIrlRedeemFinalizeWorkflowError } from '../src/adminIrlRedeemFinalize.ts';
import {
  projectAdminIrlRedeemFinalizeStatusDecision,
  reconcileAdminIrlRedeemFinalizeInspection,
  type AdminIrlRedeemFinalizeDurableState,
  type AdminIrlRedeemFinalizeRecoveryDecision,
  type AdminIrlRedeemFinalizeWorkflowInspection,
} from '../src/adminIrlRedeemFinalizeWorkflowRecovery.ts';

const retryableFailure: AdminIrlRedeemFinalizeWorkflowError = {
  code: 'unavailable',
  message: 'Admin IRL redeem finalization is temporarily unavailable.',
  retryable: true,
};
const terminalFailure: AdminIrlRedeemFinalizeWorkflowError = {
  code: 'failed-precondition',
  message: 'Admin IRL redeem finalization requirements are not satisfied.',
  retryable: false,
};

const durableStates: ReadonlyArray<Readonly<{
  durable: AdminIrlRedeemFinalizeDurableState;
  expected: readonly AdminIrlRedeemFinalizeRecoveryDecision[];
}>> = [
  {
    durable: { state: 'absent' },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(8).fill('not-found'),
  },
  {
    durable: { state: 'active-confirmed' },
    expected: ['terminal', 'pending', 'complete', 'restart', 'terminal', 'terminal', 'terminal', 'pending'],
  },
  {
    durable: { state: 'active-unconfirmed' },
    expected: [
      'create',
      'confirm-instance',
      'confirm-instance',
      'confirm-instance',
      'confirm-instance',
      'confirm-instance',
      'confirm-instance',
      'pending',
    ],
  },
  {
    durable: { state: 'complete' },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(8).fill('complete'),
  },
  {
    durable: { state: 'failed', failure: retryableFailure },
    expected: ['ensure-running', 'pending', 'complete', 'restart', 'terminal', 'terminal', 'terminal', 'ensure-running'],
  },
  {
    durable: { state: 'failed', failure: terminalFailure },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(8).fill('terminal'),
  },
];

const instance = {} as WorkflowInstance;
const observations: readonly AdminIrlRedeemFinalizeWorkflowInspection[] = [
  { state: 'missing' },
  { state: 'pending', instance },
  {
    state: 'succeeded',
    instance,
    output: {
      version: 1,
      ok: true,
      result: {
        kind: 'admin-irl-redeem-finalize-v1',
        dropId: 'card_nft_2',
        requestId: 'AbCdEfGhIjKlMnOpQrSt',
      },
    },
  },
  { state: 'retryable-failure', error: retryableFailure, instance },
  { state: 'terminal-failure', error: terminalFailure, instance },
  { state: 'terminated', instance },
  { state: 'invalid', instance },
  { state: 'unavailable', error: new Error('unavailable'), reason: 'inspection' },
];

test('Admin IRL Workflow recovery reducer covers every durable and Workflow state', () => {
  for (const { durable, expected } of durableStates) {
    observations.forEach((observation, index) => {
      assert.equal(
        reconcileAdminIrlRedeemFinalizeInspection(durable, observation).decision,
        expected[index],
        `${durable.state} + ${observation.state}`,
      );
    });
  }
});

test('Admin IRL Workflow status projects mutation decisions as ensure-running', () => {
  const expected: Record<AdminIrlRedeemFinalizeRecoveryDecision, AdminIrlRedeemFinalizeRecoveryDecision> = {
    complete: 'complete',
    terminal: 'terminal',
    pending: 'pending',
    create: 'ensure-running',
    restart: 'ensure-running',
    'confirm-instance': 'ensure-running',
    'ensure-running': 'ensure-running',
    'not-found': 'not-found',
  };
  for (const [decision, projected] of Object.entries(expected)) {
    assert.equal(
      projectAdminIrlRedeemFinalizeStatusDecision(decision as AdminIrlRedeemFinalizeRecoveryDecision),
      projected,
    );
  }
});
