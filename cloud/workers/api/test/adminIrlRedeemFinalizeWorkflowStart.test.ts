import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { createAdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.ts';
import type { AdminIrlRedeemFinalizeResponse } from '../src/adminIrlRedeemFinalize.ts';
import { ensureAdminIrlRedeemFinalizeWorkflowRunning } from '../src/adminIrlRedeemFinalizeWorkflowStart.ts';
import type { AdminIrlRedeemFinalizeWorkflowPayload } from '../src/adminIrlRedeemFinalizeWorkflowState.ts';
import { isSignalCancellationError } from '../src/boundedRequest.ts';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const STAFF_WALLET = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const BODY = {
  dropId: 'card_nft_2',
  requestId: 'AbCdEfGhIjKlMnOpQrSt',
  transferSignature: bs58.encode(new Uint8Array(64).fill(1)),
};

async function setup() {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(BODY.dropId, BODY.requestId),
    data: {
      adminWallet: STAFF_WALLET,
      dropId: BODY.dropId,
      owner: STAFF_WALLET,
      status: 'prepared',
      targetKind: 'pack',
      itemIds: [STAFF_WALLET],
      items: [{ assetId: STAFF_WALLET, kind: 'box', refId: 7 }],
      receiptTxs: [],
    },
  });
  const binding = {
    created: [] as Array<{ id?: string; params?: AdminIrlRedeemFinalizeWorkflowPayload }>,
    beforeCreate: undefined as (() => void | Promise<void>) | undefined,
    async get(): Promise<WorkflowInstance> {
      throw { code: 'instance.not_found' };
    },
    async create(): Promise<WorkflowInstance> {
      assert.fail('Workflow coordinator must use createBatch');
    },
    async createBatch(values: Array<{ id?: string; params?: AdminIrlRedeemFinalizeWorkflowPayload }>): Promise<WorkflowInstance[]> {
      this.created.push(...values);
      await this.beforeCreate?.();
      return [];
    },
  };
  const workflow: Workflow<AdminIrlRedeemFinalizeWorkflowPayload> = binding;
  const client = new AbortController();
  const deadline = new AbortController();
  const args: Parameters<typeof ensureAdminIrlRedeemFinalizeWorkflowRunning>[0] = {
    body: BODY,
    staffWallet: STAFF_WALLET,
    operationId: await createAdminIrlRedeemFinalizeOperationId([
      BODY.dropId, BODY.requestId, BODY.transferSignature, STAFF_WALLET,
    ]),
    env: {
      COMMERCE_DB: harness.db,
      ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW: workflow,
    } as Env,
    signal: AbortSignal.any([client.signal, deadline.signal]),
    clientCancellation: {
      signal: client.signal,
      isCancellationError: (error) => isSignalCancellationError(client.signal, error),
    },
  };
  const loadOperation = () => new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(args.operationId);
  return { args, binding, client, deadline, loadOperation };
}

test('Workflow coordinator returns pending after persisting the create claim and reconciles replay', async () => {
  const fixture = await setup();
  fixture.binding.beforeCreate = async () => {
    const stored = await fixture.loadOperation();
    assert.equal(stored?.data.processingAttemptId, fixture.args.operationId);
    assert.equal((stored?.data.workflowFinalizeV1 as { pendingEffect?: { kind?: unknown } })
      .pendingEffect?.kind, 'create');
  };

  assert.deepEqual(await ensureAdminIrlRedeemFinalizeWorkflowRunning(fixture.args), { status: 'pending' });
  assert.deepEqual(fixture.binding.created, [{
    id: fixture.args.operationId,
    params: { version: 1, dropId: BODY.dropId, requestId: BODY.requestId },
  }]);

  const replay = await ensureAdminIrlRedeemFinalizeWorkflowRunning(fixture.args);
  assert.equal(replay.status, 'reconciled');
  if (replay.status !== 'reconciled') assert.fail('Expected a reconciled replay');
  assert.equal(replay.reconciliation.decision, 'pending');
  assert.equal(replay.reconciliation.durable.state, 'effect-pending');
  assert.equal(fixture.binding.created.length, 1);
});

test('Workflow coordinator returns a completed reservation without creating an instance', async () => {
  const fixture = await setup();
  const result: AdminIrlRedeemFinalizeResponse = {
    processed: true,
    dropId: BODY.dropId,
    requestId: BODY.requestId,
    deliveryId: 7,
    receiptTxs: [],
    claimCodes: [],
    boxes: [{ boxId: 7 }],
    cards: [],
  };

  const completed = await ensureAdminIrlRedeemFinalizeWorkflowRunning(fixture.args, {
    reserveWorkflow: async () => ({ status: 'complete', result }),
    claimEffect: async () => assert.fail('Completed reservations must not claim a Workflow effect'),
  });

  assert.deepEqual(completed, { status: 'complete', result });
  assert.equal(fixture.binding.created.length, 0);
});

test('Workflow coordinator keeps an ambiguous create acknowledgement pending', async () => {
  const fixture = await setup();
  fixture.binding.beforeCreate = () => { throw new TypeError('Create acknowledgement lost'); };

  assert.deepEqual(await ensureAdminIrlRedeemFinalizeWorkflowRunning(fixture.args), { status: 'pending' });
  assert.equal((await fixture.loadOperation())?.data.processingAttemptId, fixture.args.operationId);
});

for (const cancellation of ['client', 'deadline'] as const) {
  test(`Workflow coordinator preserves the exact ${cancellation} cancellation during create`, async () => {
    const fixture = await setup();
    const reason = new DOMException(
      cancellation === 'client' ? 'Client disconnected' : 'Workflow request timed out',
      cancellation === 'client' ? 'AbortError' : 'TimeoutError',
    );
    fixture.binding.beforeCreate = () => {
      fixture[cancellation].abort(reason);
      throw new TypeError('Create acknowledgement lost');
    };

    await assert.rejects(
      () => ensureAdminIrlRedeemFinalizeWorkflowRunning(fixture.args),
      (error: unknown) => error === reason,
    );
    assert.equal(fixture.args.clientCancellation.isCancellationError(reason), cancellation === 'client');
    const stored = await fixture.loadOperation();
    assert.equal(stored?.data.processingAttemptId, fixture.args.operationId);
    assert.equal((stored?.data.workflowFinalizeV1 as { pendingEffect?: { kind?: unknown } })
      .pendingEffect?.kind, 'create');
    assert.equal(fixture.binding.created.length, 1);
  });
}
