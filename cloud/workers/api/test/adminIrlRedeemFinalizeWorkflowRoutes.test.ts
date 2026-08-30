import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { createAdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.ts';
import {
  type AdminIrlRedeemFinalizeWorkflowOutput,
  type AdminIrlRedeemFinalizeWorkflowPayload,
} from '../src/adminIrlRedeemFinalize.ts';
import {
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  handleAdminIrlRedeemFinalizeWorkflowStart,
  handleAdminIrlRedeemFinalizeWorkflowStatus,
} from '../src/adminIrlRedeemFinalizeWorkflowRoutes.ts';
import {
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
  restartCalls = 0;

  constructor(public state: InstanceStatus) {}

  async status(): Promise<InstanceStatus> {
    return this.state;
  }

  async restart(): Promise<void> {
    this.restartCalls += 1;
    this.state = { status: 'running' };
  }
}

class FakeWorkflowBinding {
  readonly created: Array<{ id?: string; params?: AdminIrlRedeemFinalizeWorkflowPayload }> = [];
  instance?: FakeWorkflowInstance;
  createError?: unknown;
  getError?: unknown;
  missingGets = 0;

  async get(): Promise<WorkflowInstance> {
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
    if (this.createError) throw this.createError;
    if (this.instance) return [];
    this.created.push(...values);
    this.instance = new FakeWorkflowInstance({ status: 'running' });
    return [this.instance as unknown as WorkflowInstance];
  }
}

function apiRequest(path: string, body: unknown, method = 'POST'): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method,
    headers: {
      Authorization: internalStaffAuthorization(OWNER),
      'Content-Type': 'application/json',
    },
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

  binding.missingGets = 1;
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
  assert.equal((await status.response.json() as { operationId: string }).operationId, pending.operationId);
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

  const status = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    apiRequest(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH, { operationId }),
    activeEnv,
  );
  assert.equal(status.response.status, 500);
  assert.equal(JSON.stringify(await status.response.json()).includes('Workflow resource'), false);
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
      error: {
        code: 'unavailable',
        message: 'Admin IRL redeem finalization is temporarily unavailable.',
        retryable: true,
      },
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

  assert.equal(result.response.status, 500);
  const stored = await new D1CommerceRepository(harness.db)
    .getAdminIrlRedeemRequestForWorkflowStatus(operationId);
  assert.equal(stored?.data.status, 'processing');
  assert.equal(stored?.data.processingAttemptId, operationId);
  assert.equal(stored?.data.transferSignature, SIGNATURE);
});
