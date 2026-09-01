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
  claimAdminIrlRedeemFinalizeWorkflowEffect,
  cleanupAdminIrlRedeemFinalizeWorkflow,
  dispatchAdminIrlRedeemFinalizeWorkflowRestart,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  reserveAdminIrlRedeemFinalizeWorkflow,
  retractAdminIrlRedeemFinalizeWorkflowRestartDispatch,
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
  createCalls = 0;
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
    this.createCalls += 1;
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

function startedWorkflowExecution(stored: Readonly<{ data: CommerceDocumentData }>): CommerceDocumentData {
  const execution = {
    ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
  };
  delete execution.instanceCreationPending;
  delete execution.restartPendingUntilMs;
  delete execution.pendingEffect;
  return execution;
}

function seedWorkflowStarted(
  harness: ReturnType<typeof createCommerceD1Harness>,
  stored: Readonly<{ data: CommerceDocumentData; version: number; createTime: string }>,
): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      workflowFinalizeV1: startedWorkflowExecution(stored),
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
}

function seedWorkflowCreateEffect(
  harness: ReturnType<typeof createCommerceD1Harness>,
  stored: Readonly<{ data: CommerceDocumentData; version: number; createTime: string }>,
  untilMs: number,
): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...startedWorkflowExecution(stored),
        pendingEffect: { kind: 'create', untilMs },
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
}

function seedWorkflowRestartClaim(
  harness: ReturnType<typeof createCommerceD1Harness>,
  stored: Readonly<{ data: CommerceDocumentData; version: number; createTime: string }>,
  claimId: string,
  untilMs: number,
): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...startedWorkflowExecution(stored),
        pendingEffect: { kind: 'restart-claim', claimId, untilMs },
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
}

async function clearPendingWorkflowEffect(
  harness: ReturnType<typeof createCommerceD1Harness>,
  operationId: string,
): Promise<void> {
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  seedWorkflowStarted(harness, stored);
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
        ...startedWorkflowExecution(stored),
        failure: TERMINAL_FAILURE,
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
}

function seedManualRecoveryFailure(
  harness: ReturnType<typeof createCommerceD1Harness>,
  stored: Readonly<{ data: CommerceDocumentData; version: number; createTime: string }>,
): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      status: 'processing',
      receiptTxs: [SIGNATURE],
      workflowFinalizeV1: {
        ...startedWorkflowExecution(stored),
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
  let claimCalls = 0;
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
    {
      claimEffect: async (args) => {
        claimCalls += 1;
        return claimAdminIrlRedeemFinalizeWorkflowEffect(args);
      },
    },
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
  assert.equal(claimCalls, 1);
  const operation = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(operation?.data.processingAttemptId, operationId);
  assert.equal((operation?.data.workflowFinalizeV1 as { operationId?: unknown }).operationId, operationId);
  assert.equal((operation?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');

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

test('Admin IRL Workflow status leaves an observed pending create unchanged', async () => {
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

  assert.equal(result.response.status, 202);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
});

test('Admin IRL starter leaves an observed pending create unchanged', async () => {
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
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
  );

  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(result.response.status, 202);
  assert.equal(binding.created.length, 0);
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
});

test('Admin IRL starter retries an expired create effect', async () => {
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
  seedWorkflowCreateEffect(harness, stored, 0);
  binding.instance = undefined;

  const retried = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(retried.response.status, 202);
  assert.equal(binding.createCalls, 2);
});

test('Admin IRL starter recovers a lost create-claim acknowledgement', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    env(harness, binding),
    {
      claimEffect: async (args) => {
        await claimAdminIrlRedeemFinalizeWorkflowEffect(args);
        throw new TypeError('claim acknowledgement was lost');
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(binding.createCalls, 0);
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
});

test('Admin IRL starter projects completion when a create claim loses its revision', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      claimEffect: async (args) => {
        const stored = await new D1CommerceRepository(harness.db)
          .getAdminIrlRedeemRequestForWorkflowStatus(args.operationId);
        assert.ok(stored);
        seedCompleted(harness, stored);
        return claimAdminIrlRedeemFinalizeWorkflowEffect(args);
      },
    },
  );

  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { deliveryId: number }).deliveryId, 7);
  assert.equal(binding.createCalls, 0);
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

test('Admin IRL Workflow status projects D1 completion and engine states', async () => {
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
  seedWorkflowStarted(harness, stored);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' });
  const terminated = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(terminated.response.status, 409);

  binding.instance = new FakeWorkflowInstance({ status: 'errored' });
  const errored = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(errored.response.status, 502);
  assert.deepEqual(await errored.response.json(), {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Admin IRL redeem Workflow is temporarily unavailable.',
      recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
    },
  });
  assert.equal(binding.instance.restartCalls, 0);

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

  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);
  seedCompleted(harness, confirmed);
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedCompleted(harness, confirmed);
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);

  binding.beforeGet = () => { seedCompleted(harness, confirmed); };
  binding.getError = new Error('Workflow inspection failed after publication.');
  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 200);
  assert.equal((await status.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL Workflow status requires an explicit start to recreate missing confirmed instances', async () => {
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
  seedWorkflowStarted(harness, stored);

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
  assert.equal(binding.created.length, 1);
});

test('Admin IRL starter recreates a missing confirmed Workflow instance', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(started.response.status, 202);
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );

  binding.instance = undefined;
  const recreated = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(recreated.response.status, 202);
  assert.equal(binding.created.length, 2);
});

test('Admin IRL starter explicitly recreates a retained manual operation without status mutation', async () => {
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
  seedManualRecoveryFailure(harness, stored);
  binding.instance = undefined;

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 409);
  assert.equal(binding.createCalls, 1);
  const afterStatus = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.deepEqual(
    (afterStatus?.data.workflowFinalizeV1 as { failure?: unknown }).failure,
    TERMINAL_FAILURE,
  );
  assert.equal((afterStatus?.data.workflowFinalizeV1 as { pendingEffect?: unknown }).pendingEffect, undefined);

  let pendingAtCreate: unknown;
  binding.beforeCreate = async () => {
    const current = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    pendingAtCreate = (current?.data.workflowFinalizeV1 as {
      pendingEffect?: { kind?: unknown };
    }).pendingEffect?.kind;
  };
  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(replayed.response.status, 202);
  assert.equal(binding.createCalls, 2);
  assert.equal(pendingAtCreate, 'create');
  const recovered = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal((recovered?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
  assert.deepEqual(
    (recovered?.data.workflowFinalizeV1 as { failure?: unknown }).failure,
    TERMINAL_FAILURE,
  );
});

test('Admin IRL starter keeps an ambiguous manual recreation pending', async () => {
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
  seedManualRecoveryFailure(harness, stored);
  binding.instance = undefined;
  let pendingAtCreate: unknown;
  binding.beforeCreate = async () => {
    const current = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    pendingAtCreate = (current?.data.workflowFinalizeV1 as {
      pendingEffect?: { kind?: unknown };
    }).pendingEffect?.kind;
  };
  binding.createError = new TypeError('connection closed before recreate acknowledgement');

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(replayed.response.status, 202);
  assert.equal(binding.createCalls, 2);
  assert.equal(pendingAtCreate, 'create');
  const current = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal((current?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
  assert.deepEqual(
    (current?.data.workflowFinalizeV1 as { failure?: unknown }).failure,
    TERMINAL_FAILURE,
  );
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
  assert.deepEqual(
    typeof (stored?.data.workflowFinalizeV1 as {
      pendingEffect?: { dispatchedAtMs?: unknown; kind?: unknown };
    }).pendingEffect?.dispatchedAtMs,
    'number',
  );
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'restart');
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
    pendingAtCreate = (stored?.data.workflowFinalizeV1 as {
      pendingEffect?: { kind?: unknown };
    }).pendingEffect?.kind;
  };

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(replayed.response.status, 202);
  assert.equal(pendingAtCreate, 'create');
  assert.equal(binding.created.length, 2);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
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
  assert.equal((stored?.data.workflowFinalizeV1 as { pendingEffect?: unknown }).pendingEffect, undefined);
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
  await clearPendingWorkflowEffect(harness, operationId);
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedTerminalFailure(harness, confirmed);
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
  await clearPendingWorkflowEffect(harness, operationId);
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
  await clearPendingWorkflowEffect(harness, operationId);
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);
  binding.beforeGet = () => { seedCompleted(harness, confirmed); };
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);
  binding.beforeGet = () => { seedCompleted(harness, confirmed); };
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
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
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
  await clearPendingWorkflowEffect(harness, operationId);
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);
  binding.beforeGet = () => { seedCompleted(harness, confirmed); };
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);

  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedCompleted(harness, confirmed);
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
  assert.equal(unavailable.response.status, 502);
  assert.equal(
    (await unavailable.response.json() as { error: { recovery?: string } }).error.recovery,
    ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  );
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
  const { operationId } = await started.response.json() as { operationId: string };
  await clearPendingWorkflowEffect(harness, operationId);
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

test('Admin IRL starter preserves explicit restart recovery through a transient second inspection', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;
  let getCalls = 0;
  binding.beforeGet = () => {
    getCalls += 1;
    if (getCalls === 2) binding.getError = new TypeError('Workflow inspection is temporarily unavailable.');
  };

  const unavailable = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(unavailable.response.status, 502);
  assert.equal(
    (await unavailable.response.json() as { error: { recovery?: string } }).error.recovery,
    ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  );
  assert.equal(instance.restartCalls, 0);

  binding.beforeGet = undefined;
  binding.getError = undefined;
  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(recovered.response.status, 202);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter preserves explicit create recovery through a transient second inspection', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );
  binding.instance = undefined;
  let getCalls = 0;
  binding.beforeGet = () => {
    getCalls += 1;
    if (getCalls === 2) binding.getError = new TypeError('Workflow inspection is temporarily unavailable.');
  };

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(result.response.status, 502);
  assert.equal(
    (await result.response.json() as { error: { recovery?: string } }).error.recovery,
    ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  );
  assert.equal(binding.createCalls, 1);
});

test('Admin IRL starter preserves D1 completion during a second inspection outage', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  binding.instance = new FakeWorkflowInstance({ status: 'errored' });
  let getCalls = 0;
  binding.beforeGet = async () => {
    getCalls += 1;
    if (getCalls !== 2) return;
    const stored = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    assert.ok(stored);
    seedCompleted(harness, stored);
    binding.getError = new TypeError('Workflow inspection is temporarily unavailable.');
  };

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { deliveryId: number }).deliveryId, 7);
});

test('Admin IRL starter preserves D1 terminal failure during a second inspection outage', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  binding.instance = new FakeWorkflowInstance({ status: 'errored' });
  let getCalls = 0;
  binding.beforeGet = async () => {
    getCalls += 1;
    if (getCalls !== 2) return;
    const stored = await new D1CommerceRepository(harness.db)
      .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
    assert.ok(stored);
    seedTerminalFailure(harness, stored);
    binding.getError = new TypeError('Workflow inspection is temporarily unavailable.');
  };

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(result.response.status, 409);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: TERMINAL_FAILURE.code,
      message: TERMINAL_FAILURE.message,
    },
  });
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
  const { operationId } = await started.response.json() as { operationId: string };
  await clearPendingWorkflowEffect(harness, operationId);
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
  seedWorkflowStarted(harness, stored);
  const confirmed = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(confirmed);
  binding.instance = new FakeWorkflowInstance({ status: 'terminated' }, () => {
    seedCompleted(harness, confirmed);
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

test('Admin IRL starter fences concurrent restart requests', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;
  let claimCalls = 0;
  let releaseClaims!: () => void;
  const claimsReady = new Promise<void>((resolve) => { releaseClaims = resolve; });
  let claimQueue = Promise.resolve();
  const claimEffect = async (
    args: Parameters<typeof claimAdminIrlRedeemFinalizeWorkflowEffect>[0],
  ) => {
    claimCalls += 1;
    if (claimCalls === 2) releaseClaims();
    await claimsReady;
    let releaseClaim!: () => void;
    const previousClaim = claimQueue;
    claimQueue = new Promise<void>((resolve) => { releaseClaim = resolve; });
    await previousClaim;
    try {
      return await claimAdminIrlRedeemFinalizeWorkflowEffect(args);
    } finally {
      releaseClaim();
    }
  };

  const results = await Promise.all([
    handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY),
      activeEnv,
      { claimEffect },
    ),
    handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY),
      activeEnv,
      { claimEffect },
    ),
  ]);

  assert.deepEqual(results.map((result) => result.response.status), [202, 202]);
  assert.equal(claimCalls, 2);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter retries a lost restart-claim acknowledgement with the same token', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;
  const claimIds: string[] = [];

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      claimEffect: async (args) => {
        assert.equal(args.kind, 'restart');
        claimIds.push(args.claimId);
        const claimed = await claimAdminIrlRedeemFinalizeWorkflowEffect(args);
        if (claimIds.length === 1) throw new TypeError('restart claim acknowledgement was lost');
        return claimed;
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(new Set(claimIds).size, 1);
  assert.equal(claimIds.length, 2);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter reclaims an expired undispatched restart claim', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;
  let claimId = '';
  let claimCalls = 0;
  let getCalls = 0;
  binding.beforeGet = () => {
    getCalls += 1;
    if (getCalls === 4) binding.getError = new TypeError('post-claim inspection unavailable');
  };
  const claimEffect = async (
    args: Parameters<typeof claimAdminIrlRedeemFinalizeWorkflowEffect>[0],
  ) => {
    claimCalls += 1;
    if (args.kind === 'restart') claimId = args.claimId;
    return claimAdminIrlRedeemFinalizeWorkflowEffect(args);
  };

  const unavailable = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    { claimEffect },
  );
  assert.equal(unavailable.response.status, 202);
  assert.equal(instance.restartCalls, 0);
  assert.equal(claimCalls, 1);

  const pending = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    { claimEffect },
  );
  assert.equal(pending.response.status, 202);
  assert.equal(claimCalls, 1);

  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  seedWorkflowRestartClaim(harness, stored, claimId, 0);
  binding.beforeGet = undefined;
  binding.getError = undefined;
  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    { claimEffect },
  );

  assert.equal(recovered.response.status, 202);
  assert.equal(claimCalls, 2);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter retries a lost dispatch acknowledgement idempotently', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;
  const dispatchClaimIds: string[] = [];

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      dispatchRestart: async (args) => {
        dispatchClaimIds.push(args.claimId);
        const dispatched = await dispatchAdminIrlRedeemFinalizeWorkflowRestart(args);
        if (dispatchClaimIds.length === 1) throw new TypeError('dispatch acknowledgement was lost');
        return dispatched;
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(dispatchClaimIds.length, 2);
  assert.equal(new Set(dispatchClaimIds).size, 1);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter rechecks the instance after dispatching restart', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;
  const retractClaimIds: string[] = [];

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      dispatchRestart: async (args) => {
        const dispatched = await dispatchAdminIrlRedeemFinalizeWorkflowRestart(args);
        instance.state = { status: 'running' };
        return dispatched;
      },
      retractRestart: async (args) => {
        retractClaimIds.push(args.claimId);
        const retracted = await retractAdminIrlRedeemFinalizeWorkflowRestartDispatch(args);
        if (retractClaimIds.length === 1) throw new TypeError('retract acknowledgement was lost');
        return retracted;
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 0);
  assert.equal(retractClaimIds.length, 2);
  assert.equal(new Set(retractClaimIds).size, 1);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'restart-claim');
});

test('Admin IRL starter retracts a dispatch when its instance becomes missing', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      dispatchRestart: async (args) => {
        const dispatched = await dispatchAdminIrlRedeemFinalizeWorkflowRestart(args);
        binding.instance = undefined;
        return dispatched;
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 0);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  const pending = (stored.data.workflowFinalizeV1 as {
    pendingEffect?: { claimId?: unknown; kind?: unknown };
  }).pendingEffect;
  assert.equal(pending?.kind, 'restart-claim');
  assert.equal(typeof pending?.claimId, 'string');
  seedWorkflowRestartClaim(harness, stored, String(pending?.claimId), 0);

  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(recovered.response.status, 202);
  assert.equal(binding.createCalls, 2);
  assert.equal(instance.restartCalls, 0);
});

test('Admin IRL starter retracts and reclaims a dispatch after an inspection outage', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      dispatchRestart: async (args) => {
        const dispatched = await dispatchAdminIrlRedeemFinalizeWorkflowRestart(args);
        binding.getError = new TypeError('post-dispatch inspection unavailable');
        return dispatched;
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 0);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  const pending = (stored.data.workflowFinalizeV1 as {
    pendingEffect?: { claimId?: unknown; kind?: unknown };
  }).pendingEffect;
  assert.equal(pending?.kind, 'restart-claim');
  assert.equal(typeof pending?.claimId, 'string');
  seedWorkflowRestartClaim(harness, stored, String(pending?.claimId), 0);
  binding.getError = undefined;
  const recovered = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(recovered.response.status, 202);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter rechecks the instance before claiming restart', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  let statusCalls = 0;
  let instance!: FakeWorkflowInstance;
  instance = new FakeWorkflowInstance({ status: 'errored' }, () => {
    statusCalls += 1;
    if (statusCalls === 3) instance.state = { status: 'running' };
  });
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      claimEffect: async () => assert.fail('pending pre-claim inspection must not claim restart'),
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 0);
});

test('Admin IRL starter rechecks the instance after claiming restart', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  await clearPendingWorkflowEffect(harness, operationId);
  const instance = new FakeWorkflowInstance({ status: 'errored' });
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
    {
      claimEffect: async (args) => {
        const claimed = await claimAdminIrlRedeemFinalizeWorkflowEffect(args);
        instance.state = { status: 'running' };
        return claimed;
      },
    },
  );

  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 0);
});

test('Admin IRL starter explicitly restarts active terminated and invalid instances', async () => {
  const states: readonly InstanceStatus[] = [
    { status: 'terminated' },
    { status: 'complete', output: { malformed: true } },
  ];
  for (const state of states) {
    const harness = createCommerceD1Harness();
    seedPrepared(harness);
    const binding = new FakeWorkflowBinding();
    const activeEnv = env(harness, binding);
    await handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY),
      activeEnv,
    );
    await clearPendingWorkflowEffect(
      harness,
      await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
    );
    const instance = new FakeWorkflowInstance(state);
    binding.instance = instance;

    const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY),
      activeEnv,
    );

    assert.equal(result.response.status, 202, state.status);
    assert.equal(instance.restartCalls, 1, state.status);
  }
});

test('Admin IRL starter restarts retryable outputs and engine failures but not terminal outputs', async () => {
  const retryHarness = createCommerceD1Harness();
  seedPrepared(retryHarness);
  const retryBinding = new FakeWorkflowBinding();
  const retryEnv = env(retryHarness, retryBinding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    retryEnv,
  );
  await clearPendingWorkflowEffect(
    retryHarness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
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
  await clearPendingWorkflowEffect(
    erroredHarness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );
  erroredBinding.instance = new FakeWorkflowInstance({ status: 'errored' });
  const errored = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    erroredEnv,
  );
  assert.equal(errored.response.status, 202);
  assert.equal(erroredBinding.instance.restartCalls, 1);

  const repeatedHarness = createCommerceD1Harness();
  seedPrepared(repeatedHarness);
  const repeatedBinding = new FakeWorkflowBinding();
  const repeatedEnv = env(repeatedHarness, repeatedBinding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    repeatedEnv,
  );
  await clearPendingWorkflowEffect(
    repeatedHarness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );
  let repeatedInstance!: FakeWorkflowInstance;
  repeatedInstance = new FakeWorkflowInstance({ status: 'errored' }, () => {
    if (repeatedInstance.restartCalls > 0) repeatedInstance.state = { status: 'errored' };
  });
  repeatedBinding.instance = repeatedInstance;
  const repeated = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    repeatedEnv,
  );
  assert.equal(repeated.response.status, 202);
  assert.equal(repeatedInstance.restartCalls, 1);
  const staleStatus = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, {
      operationId: await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
    }),
    repeatedEnv,
  );
  assert.equal(staleStatus.response.status, 202);
  assert.equal(repeatedInstance.restartCalls, 1);

  const terminalHarness = createCommerceD1Harness();
  seedPrepared(terminalHarness);
  const terminalBinding = new FakeWorkflowBinding();
  const terminalEnv = env(terminalHarness, terminalBinding);
  const terminalStarted = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    terminalEnv,
  );
  const terminalOperationId = (await terminalStarted.response.json() as { operationId: string }).operationId;
  const terminalStored = await new D1CommerceRepository(terminalHarness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(terminalOperationId);
  assert.ok(terminalStored);
  seedWorkflowStarted(terminalHarness, terminalStored);
  terminalBinding.instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: TERMINAL_FAILURE },
  });
  const terminal = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    terminalEnv,
  );
  assert.equal(terminal.response.status, 409);
  assert.equal(terminalBinding.instance.restartCalls, 0);
});

test('Admin IRL starter keeps a restart rejection pending behind its durable claim', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
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
  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter keeps an accepted manual restart pending through a stale terminal read', async () => {
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
  seedManualRecoveryFailure(harness, stored);
  let instance!: FakeWorkflowInstance;
  instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: TERMINAL_FAILURE },
  }, () => {
    if (instance.restartCalls > 0) {
      instance.state = {
        status: 'complete',
        output: { version: 1, ok: false, error: TERMINAL_FAILURE },
      };
    }
  });
  binding.instance = instance;

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );

  assert.equal(replayed.response.status, 202);
  assert.equal(instance.restartCalls, 1);
  const current = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.deepEqual(
    (current?.data.workflowFinalizeV1 as { failure?: unknown }).failure,
    TERMINAL_FAILURE,
  );
});

test('Admin IRL starter explicitly restarts retained errored, terminated, and invalid instances', async () => {
  const states: readonly InstanceStatus[] = [
    { status: 'errored' },
    { status: 'terminated' },
    { status: 'complete', output: { malformed: true } },
  ];
  for (const state of states) {
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
    seedManualRecoveryFailure(harness, stored);
    const instance = new FakeWorkflowInstance(state);
    binding.instance = instance;

    const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
      apiRequest('/admin/irl-redeem/finalize', BODY),
      activeEnv,
    );

    assert.equal(replayed.response.status, 202, state.status);
    assert.equal(instance.restartCalls, 1, state.status);
  }
});

test('Admin IRL Workflow keeps polling after an accepted manual restart inspection outage', async () => {
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
  seedManualRecoveryFailure(harness, stored);
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: TERMINAL_FAILURE },
  });
  instance.beforeRestart = () => {
    binding.getError = new TypeError('Workflow inspection is temporarily unavailable.');
  };
  binding.instance = instance;

  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(replayed.response.status, 202);
  assert.equal(instance.restartCalls, 1);

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 202);
  assert.equal(instance.restartCalls, 1);
});

test('Admin IRL starter keeps restart error 10200 pending behind its durable claim', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
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
  assert.equal(result.response.status, 202);
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
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
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

test('Admin IRL starter never reissues an ambiguous restart after its grace window', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  await clearPendingWorkflowEffect(
    harness,
    await adminIrlRedeemFinalizeOperationId(BODY, OWNER),
  );
  const deadline = new AbortController();
  const timeoutReason = new DOMException('Admin IRL redeem Workflow request timed out', 'TimeoutError');
  let releaseRestart!: () => void;
  const restartDelay = new Promise<void>((resolve) => { releaseRestart = resolve; });
  const instance = new FakeWorkflowInstance({
    status: 'complete',
    output: { version: 1, ok: false, error: RETRYABLE_FAILURE },
  });
  instance.beforeRestart = async () => {
    deadline.abort(timeoutReason);
    await restartDelay;
  };
  binding.instance = instance;

  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
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
    },
  );
  assert.equal(result.response.status, 504);
  assert.equal(instance.restartCalls, 1);

  const pending = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(pending.response.status, 202);
  const operationId = await adminIrlRedeemFinalizeOperationId(BODY, OWNER);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.ok(stored);
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
        pendingEffect: { kind: 'restart', dispatchedAtMs: 0 },
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
    updateTime: '2026-08-30T00:00:00.000Z',
  });
  const replayed = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  assert.equal(replayed.response.status, 502);
  assert.deepEqual(await replayed.response.json(), {
    ok: false,
    error: {
      code: RETRYABLE_FAILURE.code,
      message: RETRYABLE_FAILURE.message,
    },
  });
  assert.equal(instance.restartCalls, 1);
  assert.equal(binding.created.length, 1);
  releaseRestart();
});

test('Admin IRL status projects completion after a restart acknowledgement race', async () => {
  const harness = createCommerceD1Harness();
  seedPrepared(harness);
  const binding = new FakeWorkflowBinding();
  const activeEnv = env(harness, binding);
  const started = await handleAdminIrlRedeemFinalizeWorkflowStart(
    apiRequest('/admin/irl-redeem/finalize', BODY),
    activeEnv,
  );
  const { operationId } = await started.response.json() as { operationId: string };
  await clearPendingWorkflowEffect(harness, operationId);
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
  assert.equal(result.response.status, 202);
  assert.equal(instance.restartCalls, 1);
  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 200);
  assert.equal((await status.response.json() as { deliveryId: number }).deliveryId, 7);
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

  assert.equal(result.response.status, 202);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'processing');
  assert.equal(stored?.data.processingAttemptId, operationId);
  assert.equal(stored?.data.transferSignature, SIGNATURE);
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
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
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
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
  assert.equal((stored?.data.workflowFinalizeV1 as {
    pendingEffect?: { kind?: unknown };
  }).pendingEffect?.kind, 'create');
});
