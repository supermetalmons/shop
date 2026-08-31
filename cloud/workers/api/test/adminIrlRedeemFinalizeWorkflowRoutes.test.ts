import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import {
  ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  createAdminIrlRedeemFinalizeOperationId,
} from '../../../../shared/contracts.ts';
import {
  AdminIrlRedeemFinalizeError,
  cleanupAdminIrlRedeemFinalizeWorkflow,
  confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  reserveAdminIrlRedeemFinalizeWorkflow,
  type AdminIrlRedeemFinalizeWorkflowOutput,
  type AdminIrlRedeemFinalizeWorkflowPayload,
} from '../src/adminIrlRedeemFinalize.ts';
import {
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  handleAdminIrlRedeemFinalizeWorkflowStart,
  handleAdminIrlRedeemFinalizeWorkflowStatus,
} from '../src/adminIrlRedeemFinalizeWorkflowRoutes.ts';
import {
  CommerceRepositoryError,
  commerceKeys,
  D1CommerceRepository,
  type CommerceDocumentData,
} from '../src/commerceRepository.ts';
import { internalStaffAuthorization } from '../src/requestIdentity.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

const OWNER = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const OTHER_STAFF = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
const DROP_ID = 'card_nft_2';
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrSt';
const SIGNATURE = bs58.encode(Keypair.generate().secretKey);
const BODY = { dropId: DROP_ID, requestId: REQUEST_ID, transferSignature: SIGNATURE };
const TERMINAL_FAILURE = {
  code: 'failed-precondition' as const,
  message: 'Admin IRL redeem finalization requirements are not satisfied.',
  retryable: false,
};
const RETRYABLE_FAILURE = {
  code: 'unavailable' as const,
  message: 'Admin IRL redeem finalization is temporarily unavailable.',
  retryable: true,
};

function adminIrlRedeemFinalizeOperationId(
  body: typeof BODY,
  staffWallet: string,
) {
  return createAdminIrlRedeemFinalizeOperationId([
    body.dropId,
    body.requestId,
    body.transferSignature,
    staffWallet,
  ]);
}

class FakeWorkflowInstance {
  beforeRestart?: () => void | Promise<void>;
  restartError?: unknown;
  restartCalls = 0;

  constructor(
    public state: InstanceStatus,
    private readonly beforeStatus?: () => void | Promise<void>,
  ) {}

  async status(): Promise<InstanceStatus> {
    await this.beforeStatus?.();
    return this.state;
  }

  async restart(): Promise<void> {
    this.restartCalls += 1;
    await this.beforeRestart?.();
    if (this.restartError) throw this.restartError;
    this.state = { status: 'running' };
  }
}

class FakeWorkflowBinding {
  readonly created: Array<{ id?: string; params?: AdminIrlRedeemFinalizeWorkflowPayload }> = [];
  instance?: FakeWorkflowInstance;
  createError?: unknown;
  getError?: unknown;
  beforeCreate?: () => void | Promise<void>;
  beforeGet?: () => void | Promise<void>;
  missingGets = 0;

  async get(): Promise<WorkflowInstance> {
    await this.beforeGet?.();
    if (this.getError) throw this.getError;
    if (this.missingGets > 0) {
      this.missingGets -= 1;
      throw { code: 'instance.not_found' };
    }
    if (!this.instance) throw { code: 'instance.not_found' };
    return this.instance as unknown as WorkflowInstance;
  }

  async createBatch(
    values: Array<{ id?: string; params?: AdminIrlRedeemFinalizeWorkflowPayload }>,
  ): Promise<WorkflowInstance[]> {
    await this.beforeCreate?.();
    if (this.createError) throw this.createError;
    if (this.instance) return [];
    this.created.push(...values);
    this.instance = new FakeWorkflowInstance({ status: 'running' });
    return [this.instance as unknown as WorkflowInstance];
  }
}

function apiRequest(path: string, body: unknown, method = 'POST', signal?: AbortSignal): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method,
    headers: {
      Authorization: internalStaffAuthorization(OWNER),
      'Content-Type': 'application/json',
    },
    ...(signal ? { signal } : {}),
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

function seedPrepared(harness: ReturnType<typeof createCommerceD1Harness>): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      adminWallet: OWNER,
      dropId: DROP_ID,
      owner: OWNER,
      status: 'prepared',
      targetKind: 'pack',
      itemIds: [OWNER],
      items: [{ assetId: OWNER, kind: 'box', refId: 7 }],
      receiptTxs: [],
    },
  });
}

function seedCompleted(
  harness: ReturnType<typeof createCommerceD1Harness>,
  stored: Readonly<{ data: CommerceDocumentData; version: number; createTime: string }>,
): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      status: 'complete',
      deliveryId: 7,
      claimCodes: ['ABCDEF-1234567890'],
      boxes: [{
        boxId: 7,
        originalAssetId: OWNER,
        receiptAssetId: OWNER,
        claimCode: 'ABCDEF-1234567890',
        dudeIds: [1, 2, 3],
      }],
      cards: [],
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
}

function seedTerminalFailure(
  harness: ReturnType<typeof createCommerceD1Harness>,
  stored: Readonly<{ data: CommerceDocumentData; version: number; createTime: string }>,
): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      status: 'prepared',
      workflowFinalizeV1: {
        ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
        failure: TERMINAL_FAILURE,
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
}

function env(
  harness: ReturnType<typeof createCommerceD1Harness>,
  binding: FakeWorkflowBinding,
): Env {
  return {
    COMMERCE_DB: harness.db,
    ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW: binding as unknown as Workflow<AdminIrlRedeemFinalizeWorkflowPayload>,
  } as Env;
}

function pauseCommerce(harness: ReturnType<typeof createCommerceD1Harness>): void {
  const nowMsSql = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
  harness.database.exec(`INSERT INTO commerce_authority_control_lease (
    singleton, lease_token, acquired_at_ms, expires_at_ms
  ) VALUES (
    1, '123e4567-e89b-42d3-a456-426614174000',
    ${nowMsSql}, ${nowMsSql} + 60000
  )`);
  harness.database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL,
    updated_at_ms = ${nowMsSql}
    WHERE singleton = 1`);
  harness.database.exec('DELETE FROM commerce_authority_control_lease');
}

test('Admin IRL Workflow starter reserves D1 then creates one opaque instance', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);

  assert.equal(result.response.status, 202);
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.response.headers.get('retry-after'), '2');
  assert.deepEqual(await result.response.json(), {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: 2_000,
  });
  assert.deepEqual(binding.created, [{
    id: operationId,
    params: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
  }]);
  const operation = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(operation?.data.processingAttemptId, operationId);
  assert.equal((operation?.data.workflowFinalizeV1 as { operationId?: unknown }).operationId, operationId);
  assert.equal(
    (operation?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );
  assert.equal(replayed.response.status, 202);
  assert.equal((await replayed.response.json() as { operationId: string }).operationId, operationId);
  assert.equal(binding.created.length, 1);
});

test('Admin IRL Workflow status remains readable while commerce is paused', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const pending = await started.response.json() as { operationId: string };
  pauseCommerce(harness);

  const statusRequest = apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId: pending.operationId });
  statusRequest.headers.set('Authorization', internalStaffAuthorization(OTHER_STAFF));
  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    statusRequest,
    activeEnv,
  );
  assert.equal(status.response.status, 202);
  assert.equal(status.dropId, undefined);
  assert.equal((await status.response.json() as { operationId: string }).operationId, pending.operationId);
});

test('Admin IRL Workflow status does not confirm an observed unconfirmed instance', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  binding.instance = new FakeWorkflowInstance({ status: 'running' });
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body: BODY,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });

  const result = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    env(harness, binding),
  );

  assert.equal(result.response.status, 502);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    true,
  );
});

test('Admin IRL starter confirms an observed instance before propagating client cancellation', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  binding.instance = new FakeWorkflowInstance({ status: 'running' });
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body: BODY,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  const controller = new AbortController();
  const reason = new DOMException('Client disconnected.', 'AbortError');

  await assert.rejects(
    () => handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY, 'POST', controller.signal),
      env(harness, binding),
      {
        confirmInstanceCreation: async (args) => {
          controller.abort(reason);
          assert.equal(args.signal.aborted, false);
          return confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation(args);
        },
      },
    ),
    (error: unknown) => error === reason,
  );

  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(binding.created.length, 0);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL Workflow status defers transient authentication failures', async () => {
  const harness = createCommerceD1Harness();
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const result = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId }),
    }),
    env(harness, new FakeWorkflowBinding()),
  );

  assert.equal(result.response.status, 202);
  assert.equal(result.authOutcome, 'provider-failure');
  assert.equal(result.outcome, 'pending-unavailable');
});

test('Admin IRL Workflow status projects D1 completion and terminal engine states', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' });
  const terminated = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(terminated.response.status, 409);

  binding.instance = new FakeWorkflowInstance({ status: 'complete', output: { raw: 'provider response' } });
  const malformed = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(malformed.response.status, 500);
  assert.equal(JSON.stringify(await malformed.response.json()).includes('provider response'), false);

  binding.instance = new FakeWorkflowInstance({ status: 'unknown' });
  const unknown = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(unknown.response.status, 202);

  binding.instance = new FakeWorkflowInstance({
    status: 'complete',
    output: {
      version: 1,
      ok: false,
      error: RETRYABLE_FAILURE,
    },
  });
  const retryableOutput = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(retryableOutput.response.status, 502);
  assert.deepEqual(await retryableOutput.response.json(), {
    ok: false,
    error: {
      code: RETRYABLE_FAILURE.code,
      message: RETRYABLE_FAILURE.message,
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });

  seedCompleted(harness, stored);
  const successOutput: AdminIrlRedeemFinalizeWorkflowOutput = {
    version: 1,
    ok: true,
    result: { kind: 'admin-irl-redeem-finalize-v1', dropId: DROP_ID, requestId: REQUEST_ID },
  };
  binding.instance = new FakeWorkflowInstance({ status: 'complete', output: successOutput });
  const success = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(success.response.status, 200);
  assert.equal((await success.response.json() as { deliveryId: number }).deliveryId, 7);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' });
  const completedDespiteTermination = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(completedDespiteTermination.response.status, 200);
  assert.equal((await completedDespiteTermination.response.json() as { deliveryId: number }).deliveryId, 7);

  const repeated = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(repeated.response.status, 200);
  assert.equal((await repeated.response.json() as { deliveryId: number }).deliveryId, 7);

  const completed = await new D1CommerceRepository(harness.db).get(
    commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
  );
  assert.ok(completed);
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...completed.data,
      boxes: [
        ...(completed.data.boxes as CommerceDocumentData[]),
        (completed.data.boxes as CommerceDocumentData[])[0],
      ],
    },
    version: completed.version + 1,
    createTime: completed.createTime,
  });
  binding.instance = new FakeWorkflowInstance({ status: 'complete', output: successOutput });
  const corrupt = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(corrupt.response.status, 500);
});

test('Admin IRL Workflow status rechecks D1 after a terminal engine result', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedCompleted(harness, stored);
  });
  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 200);
  assert.equal((await status.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL Workflow status rechecks D1 after an engine inspection error', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);

  binding.beforeGet = () => { seedCompleted(harness, stored); };
  binding.getError = new Error('Workflow inspection failed after publication.');
  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 200);
  assert.equal((await status.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL Workflow status distinguishes unavailable and missing active instances', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };

  binding.getError = new AdminIrlRedeemFinalizeError('unavailable', 'Workflow inspection failed.');
  const unavailable = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(unavailable.response.status, 202);

  binding.getError = undefined;
  binding.instance = undefined;
  const missing = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(missing.response.status, 409);
  assert.deepEqual(await missing.response.json(), {
    ok: false,
    error: {
      code: 'aborted',
      message: 'Admin IRL redeem Workflow operation is no longer available.',
    },
  });
});

test('Admin IRL Workflow status surfaces a persisted retryable failure when its instance is missing', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  assert.deepEqual(await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: activeEnv,
    error: RETRYABLE_FAILURE,
    operationId,
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  }), { cleared: true });
  binding.instance = undefined;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 502);
  assert.deepEqual(await status.response.json(), {
    ok: false,
    error: {
      code: RETRYABLE_FAILURE.code,
      message: RETRYABLE_FAILURE.message,
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });

  binding.getError = { code: 10200, message: 'instance.not_found' };
  const resourceUnavailable = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(resourceUnavailable.response.status, 502);
  assert.deepEqual(await resourceUnavailable.response.json(), {
    ok: false,
    error: {
      code: RETRYABLE_FAILURE.code,
      message: RETRYABLE_FAILURE.message,
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
});

test('Admin IRL starter preserves confirmed history while restarting a persisted retryable failure', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: activeEnv,
    error: RETRYABLE_FAILURE,
    operationId,
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  });
  binding.instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(replayed.response.status, 202);
  assert.equal(binding.instance.restartCalls, 1);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL starter recreates a genuinely missing persisted retryable Workflow', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: activeEnv,
    error: RETRYABLE_FAILURE,
    operationId,
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  });
  binding.instance = undefined;
  let pendingAtCreate: unknown;
  binding.beforeCreate = async () => {
    const stored = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    pendingAtCreate = (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown })
      .instanceCreationPending;
  };

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(replayed.response.status, 202);
  assert.equal(pendingAtCreate, true);
  assert.equal(binding.created.length, 2);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL starter leaves an unavailable persisted retryable failure unchanged', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: activeEnv,
    error: RETRYABLE_FAILURE,
    operationId,
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  });
  binding.getError = new TypeError('Workflow inspection is unavailable.');

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      reserveWorkflow: async () => assert.fail('unavailable inspection must not reserve'),
    },
  );

  assert.equal(replayed.response.status, 502);
  assert.deepEqual(await replayed.response.json(), {
    ok: false,
    error: {
      code: RETRYABLE_FAILURE.code,
      message: RETRYABLE_FAILURE.message,
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.deepEqual((stored?.data.workflowFinalizeV1 as { failure?: unknown }).failure, RETRYABLE_FAILURE);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL starter cannot erase a terminal failure that lands during reservation', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  binding.instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      reserveWorkflow: async (args) => {
        const stored = await new D1CommerceRepository(harness.db)
          .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
        assert.ok(stored);
        seedTerminalFailure(harness, stored);
        return reserveAdminIrlRedeemFinalizeWorkflow(args);
      },
    },
  );

  assert.equal(replayed.response.status, 409);
  assert.deepEqual(await replayed.response.json(), {
    ok: false,
    error: {
      code: TERMINAL_FAILURE.code,
      message: TERMINAL_FAILURE.message,
    },
  });
  assert.equal(binding.instance.restartCalls, 0);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.deepEqual((stored?.data.workflowFinalizeV1 as { failure?: unknown }).failure, TERMINAL_FAILURE);
});

test('Admin IRL Workflow status keeps initial and completion-result D1 outages pending', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);

  const initial = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
    {
      loadOperation: async () => {
        throw new CommerceRepositoryError('unavailable', 'Commerce is temporarily unavailable.');
      },
    },
  );
  assert.equal(initial.response.status, 202);

  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  seedCompleted(harness, stored);
  const unavailableEnv = {
    ...activeEnv,
    COMMERCE_DB: {
      prepare: () => { throw new Error('D1 unavailable'); },
    } as unknown as D1Database,
  } as Env;
  const completion = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    unavailableEnv,
    {
      loadOperation: ({ operationId: currentOperationId }) => loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: activeEnv,
        operationId: currentOperationId,
      }),
    },
  );
  assert.equal(completion.response.status, 202);
  assert.equal(started.response.status, 202);
});

test('Admin IRL Workflow status projects persisted terminal failures on recheck and initial load', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedTerminalFailure(harness, stored);
  });
  const rechecked = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(rechecked.response.status, 409);
  assert.deepEqual(await rechecked.response.json(), {
    ok: false,
    error: {
      code: TERMINAL_FAILURE.code,
      message: TERMINAL_FAILURE.message,
    },
  });

  binding.instance = undefined;
  const initial = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(initial.response.status, 409);
  assert.deepEqual(await initial.response.json(), {
    ok: false,
    error: {
      code: TERMINAL_FAILURE.code,
      message: TERMINAL_FAILURE.message,
    },
  });
});

test('Admin IRL Workflow status stays pending when an engine error recheck fails', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  binding.getError = new AdminIrlRedeemFinalizeError('unavailable', 'Workflow inspection failed.');
  let operationReads = 0;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
    {
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads === 1) return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        throw new CommerceRepositoryError('unavailable', 'Completion recheck failed.');
      },
    },
  );
  assert.equal(status.response.status, 202);
  assert.deepEqual(await status.response.json(), {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: 2_000,
  });
  assert.equal(operationReads, 2);
});

test('Admin IRL Workflow status stays pending when a terminal engine result recheck fails', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  binding.instance = new FakeWorkflowInstance({ status: 'terminated' });
  let operationReads = 0;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
    {
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads === 1) return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        throw new CommerceRepositoryError('unavailable', 'Completion recheck failed.');
      },
    },
  );
  assert.equal(status.response.status, 202);
  assert.deepEqual(await status.response.json(), {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: 2_000,
  });
  assert.equal(operationReads, 2);
});

test('Admin IRL Workflow status stays pending when its deadline wins after authorization', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const deadline = new AbortController();
  const timeoutReason = new DOMException('Admin IRL redeem Workflow status request timed out', 'TimeoutError');
  let deadlineDisposed = false;
  let operationReads = 0;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
    {
      createDeadline: () => ({
        signal: deadline.signal,
        timeoutSignal: deadline.signal,
        timedOut: () => deadline.signal.aborted,
        clientAborted: () => false,
        dispose: () => { deadlineDisposed = true; },
      }),
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads !== 1) assert.fail('completion recheck started after deadline');
        const operation = await loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        deadline.abort(timeoutReason);
        return operation;
      },
    },
  );
  assert.equal(status.response.status, 202);
  assert.deepEqual(await status.response.json(), {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: 2_000,
  });
  assert.equal(operationReads, 1);
  assert.equal(deadlineDisposed, true);
});

test('Admin IRL Workflow routes enforce exact bodies, methods, and missing-instance classification', async () => {
  const harness = createCommerceD1Harness();
  const binding = new FakeWorkflowBinding();
  const wrongMethod = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, {}, 'GET'),
    env(harness, binding),
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'POST, OPTIONS');

  const invalid = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId: `airf-v1-${'a'.repeat(64)}`, extra: true }),
    env(harness, binding),
  );
  assert.equal(invalid.response.status, 400);

  const missing = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId: `airf-v1-${'a'.repeat(64)}` }),
    env(harness, binding),
  );
  assert.equal(missing.response.status, 404);
});

test('Admin IRL Workflow starter preserves immediate public error contracts', async () => {
  const unsupportedContentType = await handleAdminIrlRedeemFinalizeWorkflowStart(
    new Request('https://api.mons.shop/admin/irl-redeem/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    }),
    {} as Env,
  );
  assert.equal(unsupportedContentType.response.status, 400);
  assert.deepEqual(await unsupportedContentType.response.json(), {
    ok: false,
    error: {
      code: 'invalid-argument',
      message: 'Content-Type must be application/json.',
    },
  });

  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const details = { expected: 1, got: 0 };
  const detailsError = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, new FakeWorkflowBinding()),
    {
      reserveWorkflow: async () => {
        throw new AdminIrlRedeemFinalizeError(
          'failed-precondition',
          'Admin IRL redeem pack receipt is not uniquely indexed yet.',
          details,
        );
      },
    },
  );
  assert.equal(detailsError.response.status, 409);
  assert.deepEqual(await detailsError.response.json(), {
    ok: false,
    error: {
      code: 'failed-precondition',
      message: 'Admin IRL redeem pack receipt is not uniquely indexed yet.',
    },
  });

  const unknownError = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, new FakeWorkflowBinding()),
    {
      reserveWorkflow: async () => {
        throw {
          code: 'failed-precondition',
          message: 'raw provider response with secrets',
          details: { secret: true },
        };
      },
    },
  );
  assert.equal(unknownError.response.status, 500);
  assert.deepEqual(await unknownError.response.json(), {
    ok: false,
    error: {
      code: 'internal',
      message: 'Admin IRL redeem finalization failed unexpectedly.',
    },
  });
});

test('Admin IRL Workflow does not classify Wrangler resource error 10200 as a missing instance', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  binding.getError = { code: 10200, message: 'instance.not_found' };

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(replayed.response.status, 202);

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 202);
  assert.equal(JSON.stringify(await status.response.json()).includes('Workflow resource'), false);
});

test('Admin IRL starter rechecks D1 after Workflow inspection error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  binding.beforeGet = () => { seedCompleted(harness, stored); };
  binding.getError = { code: 10200, message: 'instance.not_found' };

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(replayed.response.status, 200);
  assert.equal((await replayed.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL starter rechecks D1 after post-reservation Workflow inspection error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  binding.beforeGet = async () => {
    const stored = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    assert.ok(stored);
    seedCompleted(harness, stored);
  };
  binding.getError = { code: 10200, message: 'instance.not_found' };

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL Workflow status rechecks D1 after Workflow inspection error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  binding.beforeGet = () => { seedCompleted(harness, stored); };
  binding.getError = { code: 10200, message: 'instance.not_found' };

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 200);
  assert.equal((await status.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL starter keeps D1 recheck outages retryable after Workflow error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  binding.getError = { code: 10200, message: 'instance.not_found' };
  let operationReads = 0;

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads === 1) return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        throw new CommerceRepositoryError('unavailable', 'Completion recheck failed.');
      },
    },
  );
  assert.equal(replayed.response.status, 502);
  assert.equal((await replayed.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(operationReads, 2);
});

test('Admin IRL Workflow status keeps D1 recheck outages pending after Workflow error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  binding.getError = { code: 10200, message: 'instance.not_found' };
  let operationReads = 0;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
    {
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads === 1) return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        throw new CommerceRepositoryError('unavailable', 'Completion recheck failed.');
      },
    },
  );
  assert.equal(status.response.status, 202);
  assert.deepEqual(await status.response.json(), {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: 2_000,
  });
  assert.equal(operationReads, 2);
});

test('Admin IRL starter keeps completion-read outages retryable after Workflow error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  binding.beforeGet = () => { seedCompleted(harness, stored); };
  binding.getError = { code: 10200, message: 'instance.not_found' };
  const unavailableEnv = {
    ...activeEnv,
    COMMERCE_DB: {
      prepare: () => { throw new Error('D1 unavailable'); },
    } as unknown as D1Database,
  } as Env;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    unavailableEnv,
    {
      loadOperation: ({ operationId: currentOperationId }) => loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: activeEnv,
        operationId: currentOperationId,
      }),
    },
  );
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unavailable');
});

test('Admin IRL Workflow status keeps completion-read outages pending after Workflow error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  binding.beforeGet = () => { seedCompleted(harness, stored); };
  binding.getError = { code: 10200, message: 'instance.not_found' };
  const unavailableEnv = {
    ...activeEnv,
    COMMERCE_DB: {
      prepare: () => { throw new Error('D1 unavailable'); },
    } as unknown as D1Database,
  } as Env;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    unavailableEnv,
    {
      loadOperation: ({ operationId: currentOperationId }) => loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: activeEnv,
        operationId: currentOperationId,
      }),
    },
  );
  assert.equal(status.response.status, 202);
});

test('Admin IRL starter projects existing terminal failures before reserving again', async () => {
  const harness = createCommerceD1Harness();
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const output: AdminIrlRedeemFinalizeWorkflowOutput = {
    version: 1,
    ok: false,
    error: {
      code: 'failed-precondition',
      message: 'Admin IRL redeem finalization requirements are not satisfied.',
      retryable: false,
    },
  };
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      adminWallet: OWNER,
      dropId: DROP_ID,
      owner: OWNER,
      status: 'prepared',
      targetKind: 'pack',
      itemIds: [OWNER],
      items: [{ assetId: OWNER, kind: 'box', refId: 7 }],
      receiptTxs: [],
      workflowFinalizeV1: {
        version: 1,
        operationId,
        owner: OWNER,
        transferSignature: SIGNATURE,
        adminWallet: OWNER,
        failure: output.error,
      },
    },
  });
  const binding = new FakeWorkflowBinding();
  binding.instance = new FakeWorkflowInstance({ status: 'complete', output });

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );
  assert.equal(result.response.status, 409);
  assert.equal(binding.created.length, 0);
  assert.equal(binding.instance.restartCalls, 0);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'prepared');
  assert.equal(stored?.data.processingAttemptId, undefined);
  binding.instance = undefined;
  const repeated = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );
  assert.equal(repeated.response.status, 409);
  assert.equal(binding.created.length, 0);
});

test('Admin IRL starter rechecks D1 before projecting a terminal engine state', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedCompleted(harness, stored);
  });
  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(replayed.response.status, 200);
  assert.equal((await replayed.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL starter exposes an initial completion-read outage as retryable and succeeds on replay', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  seedCompleted(harness, stored);
  const unavailableEnv = {
    ...activeEnv,
    COMMERCE_DB: {
      prepare: () => { throw new Error('D1 unavailable'); },
    } as unknown as D1Database,
  } as Env;

  const unavailable = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    unavailableEnv,
    {
      loadOperation: ({ operationId: currentOperationId }) => loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: activeEnv,
        operationId: currentOperationId,
      }),
    },
  );
  assert.equal(unavailable.response.status, 502);
  assert.equal((await unavailable.response.json() as { error: { code: string } }).error.code, 'unavailable');

  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(recovered.response.status, 200);
  assert.equal((await recovered.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL starter keeps existing operations recoverable after inspection outages', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(started.response.status, 202);

  binding.getError = new TypeError('Workflow binding unavailable');
  const unavailable = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(unavailable.response.status, 202);

  binding.getError = undefined;
  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(recovered.response.status, 202);
  assert.equal(binding.created.length, 1);
});

test('Admin IRL starter keeps newly reserved operations recoverable after inspection outages', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  binding.getError = new TypeError('Workflow binding unavailable');

  const unavailable = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(unavailable.response.status, 202);
  assert.equal(binding.created.length, 0);

  binding.getError = undefined;
  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(recovered.response.status, 202);
  assert.equal(binding.created.length, 1);
});

test('Admin IRL starter exposes unavailable terminal-state rechecks as retryable', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await started.response.json();
  binding.instance = new FakeWorkflowInstance({ status: 'terminated' });
  let operationReads = 0;

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads === 1) return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        throw new CommerceRepositoryError('unavailable', 'Completion recheck failed.');
      },
    },
  );
  assert.equal(replayed.response.status, 502);
  assert.equal((await replayed.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(operationReads, 2);
});

test('Admin IRL starter exposes terminal-state recheck deadlines as retryable', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await started.response.json();
  binding.instance = new FakeWorkflowInstance({ status: 'terminated' });
  const deadline = new AbortController();
  const timeoutReason = new DOMException('Admin IRL redeem Workflow request timed out', 'TimeoutError');
  let operationReads = 0;

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      createDeadline: () => ({
        signal: deadline.signal,
        timeoutSignal: deadline.signal,
        timedOut: () => deadline.signal.aborted,
        clientAborted: () => false,
        dispose: () => undefined,
      }),
      loadOperation: async (args) => {
        operationReads += 1;
        if (operationReads === 1) return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
        deadline.abort(timeoutReason);
        return loadAdminIrlRedeemFinalizeWorkflowOperation(args);
      },
    },
  );
  assert.equal(replayed.response.status, 504);
  assert.equal((await replayed.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
  assert.equal(operationReads, 2);
});

test('Admin IRL starter exposes rechecked completion-read outages as retryable', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedCompleted(harness, stored);
  });
  const unavailableEnv = {
    ...activeEnv,
    COMMERCE_DB: {
      prepare: () => { throw new Error('D1 unavailable'); },
    } as unknown as D1Database,
  } as Env;

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    unavailableEnv,
    {
      loadOperation: ({ operationId: currentOperationId }) => loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: activeEnv,
        operationId: currentOperationId,
      }),
    },
  );
  assert.equal(replayed.response.status, 502);
  assert.equal((await replayed.response.json() as { error: { code: string } }).error.code, 'unavailable');
});

test('Admin IRL starter restarts only an explicit retryable Workflow output', async () => {
  const retryHarness = createCommerceD1Harness();
  seedPrepared(retryHarness);
  const retryBinding = new FakeWorkflowBinding();
  const retryEnv = env(retryHarness, retryBinding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    retryEnv,
  );
  retryBinding.instance = new FakeWorkflowInstance({
    status: 'complete',
    output: {
      version: 1,
      ok: false,
      error: RETRYABLE_FAILURE,
    },
  });
  const retried = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    retryEnv,
  );
  assert.equal(retried.response.status, 202);
  assert.equal(retryBinding.instance.restartCalls, 1);

  const erroredHarness = createCommerceD1Harness();
  seedPrepared(erroredHarness);
  const erroredBinding = new FakeWorkflowBinding();
  const erroredEnv = env(erroredHarness, erroredBinding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    erroredEnv,
  );
  erroredBinding.instance = new FakeWorkflowInstance({ status: 'errored' });
  const errored = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    erroredEnv,
  );
  assert.equal(errored.response.status, 500);
  assert.equal(erroredBinding.instance.restartCalls, 0);
});

test('Admin IRL starter keeps an unchanged retryable completion recoverable after restart rejection', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });
  instance.restartError = new TypeError('Workflow restart transport failed.');
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter marks an unchanged retryable completion after restart error 10200', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });
  instance.restartError = { code: 10200, message: 'Workflow resource unavailable.' };
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: RETRYABLE_FAILURE.code,
      message: RETRYABLE_FAILURE.message,
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter keeps a restart acknowledgement failure pending during a follow-up outage', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });
  instance.beforeRestart = () => {
    binding.getError = new TypeError('Workflow follow-up inspection failed.');
  };
  instance.restartError = { code: 10200, message: 'Workflow resource unavailable.' };
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter does not recreate a confirmed instance that disappears after restart', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });
  instance.beforeRestart = () => {
    binding.instance = undefined;
  };
  instance.restartError = { code: 10200, message: 'Workflow resource unavailable.' };
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(result.response.status, 409);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'aborted',
      message: 'Admin IRL redeem Workflow operation is no longer available.',
    },
  });
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter projects D1 completion when Workflow status stays stale after restart rejection', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });
  instance.beforeRestart = async () => {
    const stored = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    assert.ok(stored);
    seedCompleted(harness, stored);
  };
  instance.restartError = new TypeError('Workflow restart acknowledgement failed.');
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { deliveryId: number }).deliveryId, 7);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter clears only its no-progress lease after definitive create failure', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  binding.createError = Object.assign(new Error('Workflow binding is unavailable'), { code: 10200 });
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);

  assert.equal(result.response.status, 500);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'internal',
      message: 'Admin IRL redeem finalization failed unexpectedly.',
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'prepared');
  assert.equal(stored?.data.processingAttemptId, undefined);
  assert.equal(stored?.data.transferSignature, SIGNATURE);
  assert.deepEqual((stored?.data.workflowFinalizeV1 as { failure?: unknown }).failure, {
    code: 'internal',
    message: 'Admin IRL redeem finalization failed unexpectedly.',
    retryable: true,
  });
});

test('Admin IRL starter requests recovery when definitive create cleanup retains progress', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  binding.beforeCreate = async () => {
    const stored = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    assert.ok(stored);
    seedCommerceDocument(harness, {
      key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
      data: { ...stored.data, receiptTxs: [SIGNATURE] },
      version: stored.version + 1,
      createTime: stored.createTime,
      updateTime: '2026-08-30T00:00:00.000Z',
    });
  };
  binding.createError = Object.assign(new Error('Workflow binding is unavailable'), { code: 10200 });

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );

  assert.equal(result.response.status, 500);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'internal',
      message: 'Admin IRL redeem finalization failed unexpectedly.',
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'processing');
  assert.equal(stored?.data.processingAttemptId, operationId);
});

test('Admin IRL starter finishes definitive create cleanup after its request deadline expires', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  binding.createError = Object.assign(new Error('Workflow binding is unavailable'), { code: 10200 });
  const requestDeadline = new AbortController();
  const recovery = new AbortController();
  let deadlineDisposed = false;
  let recoveryDisposed = false;
  const timeoutReason = new DOMException('Admin IRL redeem Workflow request timed out', 'TimeoutError');
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
    {
      createDeadline: () => ({
        signal: requestDeadline.signal,
        timeoutSignal: requestDeadline.signal,
        timedOut: () => requestDeadline.signal.aborted,
        clientAborted: () => false,
        dispose: () => { deadlineDisposed = true; },
      }),
      createRecoveryScope: () => {
        requestDeadline.abort(timeoutReason);
        return {
          signal: recovery.signal,
          timedOut: () => false,
          dispose: () => { recoveryDisposed = true; },
        };
      },
    },
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);

  assert.equal(result.response.status, 504);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'deadline-exceeded',
      message: 'Admin IRL redeem finalization timed out.',
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  assert.equal(deadlineDisposed, true);
  assert.equal(recoveryDisposed, true);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'prepared');
  assert.equal(stored?.data.processingAttemptId, undefined);
  assert.deepEqual((stored?.data.workflowFinalizeV1 as { failure?: unknown }).failure, {
    code: 'internal',
    message: 'Admin IRL redeem finalization failed unexpectedly.',
    retryable: true,
  });
});

test('Admin IRL starter retains its exact lease after an ambiguous create failure', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  binding.createError = new TypeError('connection closed before create acknowledgement');
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);

  assert.equal(result.response.status, 502);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'processing');
  assert.equal(stored?.data.processingAttemptId, operationId);
  assert.equal(stored?.data.transferSignature, SIGNATURE);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    true,
  );
});

test('Admin IRL starter confirms a successful create before propagating client cancellation', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const controller = new AbortController();
  const reason = new DOMException('Client disconnected.', 'AbortError');

  await assert.rejects(
    () => handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY, 'POST', controller.signal),
      env(harness, binding),
      {
        confirmInstanceCreation: async (args) => {
          controller.abort(reason);
          assert.equal(args.signal.aborted, false);
          return confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation(args);
        },
      },
    ),
    (error: unknown) => error === reason,
  );

  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(binding.created.length, 1);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL starter confirms a successful create before projecting its deadline', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const deadline = new AbortController();
  const reason = new DOMException('Admin IRL redeem Workflow request timed out', 'TimeoutError');

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
    {
      createDeadline: () => ({
        signal: deadline.signal,
        timeoutSignal: deadline.signal,
        timedOut: () => deadline.signal.aborted,
        clientAborted: () => false,
        dispose: () => undefined,
      }),
      confirmInstanceCreation: async (args) => {
        deadline.abort(reason);
        assert.equal(args.signal.aborted, false);
        return confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation(args);
      },
    },
  );

  assert.equal(result.response.status, 504);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'deadline-exceeded',
      message: 'Admin IRL redeem finalization timed out.',
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(binding.created.length, 1);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL starter preserves client cancellation during ambiguous create recovery', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const controller = new AbortController();
  const reason = new DOMException('Client disconnected.', 'AbortError');
  binding.beforeCreate = () => controller.abort(reason);
  binding.createError = new TypeError('connection closed before create acknowledgement');

  await assert.rejects(
    () => handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY, 'POST', controller.signal),
      env(harness, binding),
    ),
    (error: unknown) => error === reason,
  );

  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'processing');
  assert.equal(stored?.data.processingAttemptId, operationId);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    true,
  );
});

test('Admin IRL starter preserves client cancellation when create recovery finds the instance', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const controller = new AbortController();
  const reason = new DOMException('Client disconnected.', 'AbortError');
  binding.beforeCreate = () => {
    binding.instance = new FakeWorkflowInstance({ status: 'running' });
    controller.abort(reason);
  };
  binding.createError = new TypeError('connection closed before create acknowledgement');

  await assert.rejects(
    () => handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY, 'POST', controller.signal),
      env(harness, binding),
    ),
    (error: unknown) => error === reason,
  );

  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'processing');
  assert.equal(stored?.data.processingAttemptId, operationId);
  assert.equal(
    (stored?.data.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
});

test('Admin IRL starter completes definitive create cleanup before propagating client cancellation', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const controller = new AbortController();
  const reason = new DOMException('Client disconnected.', 'AbortError');
  let getCalls = 0;
  binding.beforeGet = () => {
    getCalls += 1;
    if (getCalls === 2) controller.abort(reason);
  };
  binding.createError = Object.assign(new Error('Workflow binding is unavailable'), { code: 10200 });

  await assert.rejects(
    () => handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY, 'POST', controller.signal),
      env(harness, binding),
    ),
    (error: unknown) => error === reason,
  );

  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'prepared');
  assert.equal(stored?.data.processingAttemptId, undefined);
  assert.deepEqual((stored?.data.workflowFinalizeV1 as { failure?: unknown }).failure, {
    code: 'internal',
    message: 'Admin IRL redeem finalization failed unexpectedly.',
    retryable: true,
  });
});
