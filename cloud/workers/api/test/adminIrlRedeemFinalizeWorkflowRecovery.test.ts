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
const revision = '2026-09-01T00:00:00.000Z';

const durableStates: ReadonlyArray<Readonly<{
  durable: AdminIrlRedeemFinalizeDurableState;
  expected: readonly AdminIrlRedeemFinalizeRecoveryDecision[];
}>> = [
  {
    durable: { state: 'absent' },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(9).fill('not-found'),
  },
  {
    durable: { state: 'active-confirmed', revision },
    expected: ['create', 'pending', 'complete', 'restart', 'restart', 'terminal', 'restart', 'restart', 'pending'],
  },
  {
    durable: { state: 'effect-pending', revision },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(9).fill('pending'),
  },
  {
    durable: { state: 'effect-expired', revision },
    expected: [
      'create',
      'pending',
      'complete',
      'restart',
      'restart',
      'restart',
      'restart',
      'restart',
      'ensure-running',
    ],
  },
  {
    durable: { state: 'restart-claim-pending', claimId: 'claim-1', revision },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(9).fill('pending'),
  },
  {
    durable: { state: 'restart-claim-expired', claimId: 'claim-1', revision },
    expected: [
      'create',
      'pending',
      'complete',
      'restart',
      'restart',
      'restart',
      'restart',
      'restart',
      'ensure-running',
    ],
  },
  {
    durable: { state: 'restart-dispatch-pending', revision },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(9).fill('pending'),
  },
  {
    durable: { state: 'restart-dispatched', revision },
    expected: [
      'terminal',
      'pending',
      'complete',
      'terminal',
      'terminal',
      'terminal',
      'terminal',
      'terminal',
      'pending',
    ],
  },
  {
    durable: { state: 'manual-recovery', failure: terminalFailure, revision },
    expected: [
      'create',
      'pending',
      'complete',
      'restart',
      'restart',
      'restart',
      'restart',
      'restart',
      'ensure-running',
    ],
  },
  {
    durable: { state: 'complete', revision },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(9).fill('complete'),
  },
  {
    durable: { state: 'failed', failure: retryableFailure, revision },
    expected: ['create', 'pending', 'complete', 'restart', 'restart', 'terminal', 'restart', 'restart', 'ensure-running'],
  },
  {
    durable: { state: 'failed', failure: terminalFailure, revision },
    expected: Array<AdminIrlRedeemFinalizeRecoveryDecision>(9).fill('terminal'),
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
  { state: 'terminal-failure', instance },
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

test('Admin IRL Workflow status projects only safe recovery decisions as ensure-running', () => {
  const cases: ReadonlyArray<Readonly<{
    durable: AdminIrlRedeemFinalizeDurableState;
    observation: AdminIrlRedeemFinalizeWorkflowInspection;
    expected: AdminIrlRedeemFinalizeRecoveryDecision;
  }>> = [
    { durable: { state: 'effect-expired', revision }, observation: { state: 'missing' }, expected: 'ensure-running' },
    { durable: { state: 'active-confirmed', revision }, observation: { state: 'missing' }, expected: 'terminal' },
    {
      durable: { state: 'active-confirmed', revision },
      observation: { state: 'retryable-failure', error: retryableFailure, instance },
      expected: 'ensure-running',
    },
    {
      durable: { state: 'active-confirmed', revision },
      observation: { state: 'terminal-failure', instance },
      expected: 'ensure-running',
    },
    {
      durable: { state: 'manual-recovery', failure: terminalFailure, revision },
      observation: { state: 'missing' },
      expected: 'terminal',
    },
    {
      durable: { state: 'manual-recovery', failure: terminalFailure, revision },
      observation: { state: 'retryable-failure', error: retryableFailure, instance },
      expected: 'terminal',
    },
    {
      durable: { state: 'manual-recovery', failure: terminalFailure, revision },
      observation: { state: 'terminal-failure', error: terminalFailure, instance },
      expected: 'terminal',
    },
    {
      durable: { state: 'manual-recovery', failure: terminalFailure, revision },
      observation: { state: 'terminated', instance },
      expected: 'terminal',
    },
    {
      durable: { state: 'manual-recovery', failure: terminalFailure, revision },
      observation: { state: 'invalid', instance },
      expected: 'terminal',
    },
    {
      durable: { state: 'manual-recovery', failure: terminalFailure, revision },
      observation: { state: 'unavailable', error: new Error('unavailable'), reason: 'inspection' },
      expected: 'terminal',
    },
    {
      durable: { state: 'effect-pending', revision },
      observation: { state: 'pending', instance },
      expected: 'pending',
    },
    {
      durable: { state: 'effect-expired', revision },
      observation: { state: 'terminal-failure', instance },
      expected: 'ensure-running',
    },
    { durable: { state: 'failed', failure: retryableFailure, revision }, observation: { state: 'missing' }, expected: 'ensure-running' },
    { durable: { state: 'active-confirmed', revision }, observation: { state: 'pending', instance }, expected: 'pending' },
    { durable: { state: 'active-confirmed', revision }, observation: { state: 'terminated', instance }, expected: 'terminal' },
    { durable: { state: 'effect-pending', revision }, observation: { state: 'terminated', instance }, expected: 'pending' },
    { durable: { state: 'restart-claim-pending', claimId: 'claim-1', revision }, observation: { state: 'terminated', instance }, expected: 'pending' },
    { durable: { state: 'restart-claim-expired', claimId: 'claim-1', revision }, observation: { state: 'missing' }, expected: 'ensure-running' },
    { durable: { state: 'restart-dispatch-pending', revision }, observation: { state: 'terminated', instance }, expected: 'pending' },
    { durable: { state: 'restart-dispatched', revision }, observation: { state: 'missing' }, expected: 'terminal' },
    { durable: { state: 'restart-dispatched', revision }, observation: { state: 'pending', instance }, expected: 'pending' },
    { durable: { state: 'effect-expired', revision }, observation: { state: 'missing' }, expected: 'ensure-running' },
    {
      durable: { state: 'effect-expired', revision },
      observation: { state: 'terminal-failure', error: terminalFailure, instance },
      expected: 'ensure-running',
    },
    {
      durable: { state: 'failed', failure: retryableFailure, revision },
      observation: { state: 'terminated', instance },
      expected: 'ensure-running',
    },
    {
      durable: { state: 'active-confirmed', revision },
      observation: { state: 'terminal-failure', error: terminalFailure, instance },
      expected: 'terminal',
    },
  ];
  for (const { durable, observation, expected } of cases) {
    const reconciliation = reconcileAdminIrlRedeemFinalizeInspection(durable, observation);
    assert.equal(
      projectAdminIrlRedeemFinalizeStatusDecision(reconciliation),
      expected,
      `${durable.state} + ${observation.state}`,
    );
  }
});
