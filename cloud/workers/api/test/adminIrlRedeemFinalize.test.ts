import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import { createAdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.ts';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type CompiledInnerInstruction,
  type Connection,
} from '@solana/web3.js';
import { IX_BUBBLEGUM_TRANSFER_V2 } from '../src/bubblegum.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.ts';
import { API_DROPS } from '../src/dropConfig.ts';
import { deliveryReceiptRuntime } from '../src/deliveryReceipts.ts';
import { deriveDeliveryPda, sendAndConfirmSignedTransaction } from '../src/deliveryReceiptOnchain.ts';
import { adminIrlRedeemPrepareTestHooks } from '../src/adminIrlRedeemPrepare.ts';
import {
  buildAdminIrlRedeemDeliveryOrderDocument,
  buildAdminIrlRedeemMarkerDocument,
  buildAdminIrlRedeemSelectionKey,
} from '../src/adminIrlRedeem.ts';
import { dropAdminIrlRedeemPackMarkerPath } from '../src/dropPaths.ts';
import {
  commerceKeyFromPath,
  commerceKeys,
  D1CommerceRepository,
  type CommerceDocumentData,
} from '../src/commerceRepository.ts';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
  adminIrlRedeemFinalizeTestHooks,
  claimAdminIrlRedeemFinalizeWorkflowEffect,
  cleanupAdminIrlRedeemFinalizeWorkflow,
  dispatchAdminIrlRedeemFinalizeWorkflowRestart,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  loadAdminIrlRedeemFinalizeWorkflowResult,
  prepareAdminIrlRedeemFinalizeWorkflowDraft,
  publishAdminIrlRedeemFinalizeWorkflow,
  parseAdminIrlRedeemFinalizeWorkflowOutput,
  retractAdminIrlRedeemFinalizeWorkflowRestartDispatch,
  reserveAdminIrlRedeemFinalizeWorkflow,
  resumeAndReconcileAdminIrlRedeemFinalizeWorkflow,
  validateAdminIrlRedeemFinalizeWorkflow,
} from '../src/adminIrlRedeemFinalize.ts';

const OWNER = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const DROP_ID = 'card_nft_2';
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrSt';
const SIGNATURE = bs58.encode(Keypair.generate().secretKey);

function adminIrlRedeemFinalizeOperationId(
  body: { dropId: string; requestId: string; transferSignature: string },
  staffWallet: string,
) {
  return createAdminIrlRedeemFinalizeOperationId([
    body.dropId,
    body.requestId,
    body.transferSignature,
    staffWallet,
  ]);
}

function confirmedTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  innerInstructions: CompiledInnerInstruction[] = [],
): NonNullable<Awaited<ReturnType<Connection['getTransaction']>>> {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message());
  return {
    blockTime: null,
    meta: {
      computeUnitsConsumed: undefined,
      costUnits: undefined,
      err: null,
      fee: 0,
      innerInstructions,
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
    },
    slot: 1,
    transaction: {
      message: transaction.message,
      signatures: [],
    },
    version: 0,
  };
}

function commerceContext(
  fields: Record<string, unknown>,
  options: Parameters<typeof createCommerceD1Harness>[0] = {},
) {
  const harness = createCommerceD1Harness(options);
  seedCommerceDocument(harness, {
    key: commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    data: fields as CommerceDocumentData,
    updateTime: '2026-08-22T00:00:00.000Z',
  });
  return {
    commerceDb: harness.db,
    nowMs: 1_700_000_000_000,
    providerFetch: async () => assert.fail('commerce persistence must not use provider fetch'),
    signal: new AbortController().signal,
  };
}

function projectionDataDb() {
  let attempts = 0;
  let applied = 0;
  let hasEvent = false;
  const statement = {
    bind() {
      return this;
    },
    async run() {
      attempts += 1;
      const changes = hasEvent ? 0 : 1;
      if (changes) {
        hasEvent = true;
        applied += 1;
      }
      return { success: true, results: [], meta: { changes } };
    },
  };
  return {
    db: { prepare: () => statement } as unknown as Env['DATA_DB'],
    get applied() { return applied; },
    get attempts() { return attempts; },
  };
}

test('Admin IRL Workflow errors use fixed public projections and strict parsing', () => {
  const unavailable = adminIrlRedeemFinalizeWorkflowError(
    new AdminIrlRedeemFinalizeError('unavailable', 'provider response containing sensitive text'),
  );
  assert.deepEqual(unavailable, {
    code: 'unavailable',
    message: 'Admin IRL redeem finalization is temporarily unavailable.',
    retryable: true,
  });
  assert.deepEqual(adminIrlRedeemFinalizeWorkflowError({
    code: 'failed-precondition',
    message: 'duck-typed provider response',
  }), {
    code: 'internal',
    message: 'Admin IRL redeem finalization failed unexpectedly.',
    retryable: true,
  });

  const valid = { version: 1, ok: false, error: unavailable };
  assert.deepEqual(parseAdminIrlRedeemFinalizeWorkflowOutput(valid), valid);
  assert.equal(parseAdminIrlRedeemFinalizeWorkflowOutput({
    ...valid,
    error: { ...unavailable, message: 'Retry shortly.' },
  }), null);
  assert.equal(parseAdminIrlRedeemFinalizeWorkflowOutput({
    ...valid,
    error: { ...unavailable, retryable: false },
  }), null);
});

test('Admin IRL Workflow reserves a deterministic exact-owner lease without a migration', async () => {
  const harness = createCommerceD1Harness();
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const expectedDigest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([DROP_ID, REQUEST_ID, SIGNATURE, OWNER])),
  );
  const expectedOperationId = `airf-v1-${Array.from(
    new Uint8Array(expectedDigest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
  assert.equal(await adminIrlRedeemFinalizeOperationId(body, OWNER), expectedOperationId);

  const reserved = await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_000_000_000,
  });
  assert.deepEqual(reserved, {
    status: 'reserved',
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
  });
  let document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_000_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.processingAttemptId, expectedOperationId);
  assert.equal(document?.fields.processingLeaseExpiresAt, 1_700_001_800_000);
  assert.equal((document?.fields.workflowFinalizeV1 as { version?: unknown }).version, 1);
  assert.deepEqual((document?.fields.workflowFinalizeV1 as { pendingEffect?: unknown }).pendingEffect, {
    kind: 'create',
    untilMs: 0,
  });

  if (reserved.status !== 'reserved') return;
  const workflowArgs = {
    env: { COMMERCE_DB: harness.db, HELIUS_API_KEY: 'test' } as Env,
    operationId: expectedOperationId,
    payload: reserved.payload,
    signal: new AbortController().signal,
  };
  const entryStartedAtMs = Date.now();
  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(workflowArgs), { status: 'ready' });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_000_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  const enteredEffect = (document?.fields.workflowFinalizeV1 as { pendingEffect?: {
    kind?: unknown;
    untilMs?: unknown;
  } }).pendingEffect;
  assert.equal(enteredEffect?.kind, 'create');
  assert.equal(typeof enteredEffect?.untilMs, 'number');
  assert.ok(Number(enteredEffect?.untilMs) >= entryStartedAtMs + 30_000);

  const requestKey = commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID);
  const repository = new D1CommerceRepository(harness.db);
  let stored = await repository.get(requestKey);
  assert.ok(stored);
  const initialExecution = stored.data.workflowFinalizeV1 as CommerceDocumentData;
  const pinnedOnchain = {
    adminWallet: OWNER,
    coreCollection: Keypair.generate().publicKey.toBase58(),
    treasury: Keypair.generate().publicKey.toBase58(),
  };
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...initialExecution,
        onchain: pinnedOnchain,
        failure: {
          code: 'unavailable',
          message: 'Admin IRL redeem finalization is temporarily unavailable.',
          retryable: true,
        },
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
  });

  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_000_010_000,
  });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_010_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.processingLeaseExpiresAt, 1_700_001_810_000);
  let replayExecution = document?.fields.workflowFinalizeV1 as Record<string, unknown>;
  assert.deepEqual(replayExecution.config, initialExecution.config);
  assert.deepEqual(replayExecution.onchain, pinnedOnchain);
  assert.deepEqual(replayExecution.failure, {
    code: 'unavailable',
    message: 'Admin IRL redeem finalization is temporarily unavailable.',
    retryable: true,
  });
  assert.equal((replayExecution.pendingEffect as { kind?: unknown }).kind, 'create');

  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(workflowArgs), { status: 'ready' });
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_000_015_000,
  });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_015_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(
    ((document?.fields.workflowFinalizeV1 as { pendingEffect?: { kind?: unknown } }).pendingEffect)?.kind,
    'create',
  );

  stored = await repository.get(requestKey);
  assert.ok(stored);
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...stored.data,
      processingLeaseExpiresAt: 1_700_000_019_999,
      workflowFinalizeV1: {
        ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
        failure: {
          code: 'deadline-exceeded',
          message: 'Admin IRL redeem finalization timed out.',
          retryable: true,
        },
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
  });
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_000_020_000,
  });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_020_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.processingLeaseExpiresAt, 1_700_001_820_000);
  replayExecution = document?.fields.workflowFinalizeV1 as Record<string, unknown>;
  assert.deepEqual(replayExecution.config, initialExecution.config);
  assert.deepEqual(replayExecution.onchain, pinnedOnchain);
  assert.deepEqual(replayExecution.failure, {
    code: 'deadline-exceeded',
    message: 'Admin IRL redeem finalization timed out.',
    retryable: true,
  });
  assert.equal((replayExecution.pendingEffect as { kind?: unknown }).kind, 'create');

  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(workflowArgs), { status: 'ready' });
  stored = await repository.get(requestKey);
  assert.ok(stored);
  const manualFailure = {
    code: 'resource-exhausted' as const,
    message: 'Admin IRL redeem finalization resources are exhausted.',
    retryable: false,
  };
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
        failure: manualFailure,
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
  });
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_000_024_000,
  });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_024_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  replayExecution = document?.fields.workflowFinalizeV1 as Record<string, unknown>;
  assert.deepEqual(replayExecution.failure, manualFailure);
  assert.equal((replayExecution.pendingEffect as { kind?: unknown }).kind, 'create');
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_000_025_000,
  });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_025_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  replayExecution = document?.fields.workflowFinalizeV1 as Record<string, unknown>;
  assert.deepEqual(replayExecution.failure, manualFailure);
  assert.equal((replayExecution.pendingEffect as { kind?: unknown }).kind, 'create');
  let operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
  });
  assert.ok(operation);
  assert.equal(operation.dropId, DROP_ID);
  assert.deepEqual(operation.failure, manualFailure);
  assert.equal(operation.pendingEffect?.kind, 'create');
  assert.equal(operation.owner, OWNER);
  assert.equal(operation.requestId, REQUEST_ID);
  assert.equal(operation.status, 'processing');

  const changedBody = { ...body, transferSignature: bs58.encode(Keypair.generate().secretKey) };
  const changedOperationId = await adminIrlRedeemFinalizeOperationId(changedBody, OWNER);
  await assert.rejects(() => reserveAdminIrlRedeemFinalizeWorkflow({
    body: changedBody,
    env: { COMMERCE_DB: harness.db },
    operationId: changedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_001_900_000,
  }), /transfer signature changed/i);
  const otherStaffWallet = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
  const otherOperationId = await adminIrlRedeemFinalizeOperationId(body, otherStaffWallet);
  await assert.rejects(() => reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: otherOperationId,
    signal: new AbortController().signal,
    staffWallet: otherStaffWallet,
    nowMs: 1_700_001_900_000,
  }), /Only the requesting admin wallet/);
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
  });
  assert.ok(operation);
  const createEffect = operation.pendingEffect;
  assert.equal(createEffect?.kind, 'create');
  if (createEffect?.kind !== 'create') return;
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'main-cleanup',
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    nowMs: createEffect.untilMs,
  }), { status: 'claimed' });
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    claimId: 'main-cleanup',
    signal: new AbortController().signal,
    nowMs: createEffect.untilMs,
  }), { status: 'dispatched' });

  const cleaned = await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: { COMMERCE_DB: harness.db },
    error: { code: 'failed-precondition', message: 'Invalid transfer.', retryable: false },
    operationId: expectedOperationId,
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  });
  assert.deepEqual(cleaned, { cleared: true });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: Date.now(), providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.status, 'prepared');
  assert.equal(document?.fields.processingAttemptId, undefined);
  assert.equal((document?.fields.workflowFinalizeV1 as { operationId?: unknown }).operationId, expectedOperationId);
  assert.deepEqual((document?.fields.workflowFinalizeV1 as { failure?: unknown }).failure, {
    code: 'failed-precondition',
    message: 'Admin IRL redeem finalization requirements are not satisfied.',
    retryable: false,
  });
  assert.equal(
    (document?.fields.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );
  assert.equal(
    (document?.fields.workflowFinalizeV1 as { pendingEffect?: unknown }).pendingEffect,
    undefined,
  );
  await assert.rejects(() => reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 1_700_001_910_000,
  }), /requirements are not satisfied/i);
});

test('Admin IRL Workflow effect claims serialize by revision and only create expires', async () => {
  const harness = createCommerceD1Harness();
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  let operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, { kind: 'create', untilMs: 0 });
  const initialRevision = operation.revision;
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: initialRevision,
    kind: 'create',
    operationId,
    signal: new AbortController().signal,
    nowMs: 1_000,
  }), { status: 'claimed' });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: initialRevision,
    kind: 'restart',
    claimId: 'claim-a',
    operationId,
    signal: new AbortController().signal,
    nowMs: 1_000,
  }), { status: 'changed' });
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, { kind: 'create', untilMs: 31_000 });
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 2_000,
  });
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, { kind: 'create', untilMs: 31_000 });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'claim-a',
    operationId,
    signal: new AbortController().signal,
    nowMs: 30_999,
  }), { status: 'busy' });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'claim-a',
    operationId,
    signal: new AbortController().signal,
    nowMs: 31_000,
  }), { status: 'claimed' });
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, {
    kind: 'restart-claim',
    claimId: 'claim-a',
    untilMs: 61_000,
  });
  const claimRevision = operation.revision;
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
    nowMs: 32_000,
  });
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, {
    kind: 'restart-claim',
    claimId: 'claim-a',
    untilMs: 61_000,
  });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: claimRevision,
    kind: 'restart',
    claimId: 'claim-a',
    operationId,
    signal: new AbortController().signal,
    nowMs: 32_000,
  }), { status: 'claimed' });
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, {
    kind: 'restart-claim',
    claimId: 'claim-a',
    untilMs: 62_000,
  });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'claim-b',
    operationId,
    signal: new AbortController().signal,
    nowMs: 61_999,
  }), { status: 'busy' });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'claim-b',
    operationId,
    signal: new AbortController().signal,
    nowMs: 62_000,
  }), { status: 'claimed' });
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-a',
    signal: new AbortController().signal,
    nowMs: 62_001,
  }), { status: 'changed' });
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-b',
    signal: new AbortController().signal,
    nowMs: 62_001,
  }), { status: 'dispatched' });
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-b',
    signal: new AbortController().signal,
    nowMs: 62_002,
  }), { status: 'dispatched' });
  assert.deepEqual(await retractAdminIrlRedeemFinalizeWorkflowRestartDispatch({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-a',
    signal: new AbortController().signal,
    nowMs: 63_000,
  }), { status: 'changed' });
  assert.deepEqual(await retractAdminIrlRedeemFinalizeWorkflowRestartDispatch({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-b',
    signal: new AbortController().signal,
    nowMs: 63_000,
  }), { status: 'retracted' });
  assert.deepEqual(await retractAdminIrlRedeemFinalizeWorkflowRestartDispatch({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-b',
    signal: new AbortController().signal,
    nowMs: 64_000,
  }), { status: 'retracted' });
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'claim-b',
    signal: new AbortController().signal,
    nowMs: 65_000,
  }), { status: 'dispatched' });
  operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(operation.pendingEffect, {
    kind: 'restart',
    claimId: 'claim-b',
    dispatchedAtMs: 65_000,
  });
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'create',
    operationId,
    signal: new AbortController().signal,
    nowMs: 31_000 + 10 * 365 * 24 * 60 * 60 * 1_000,
  }), { status: 'busy' });
});

test('Admin IRL Workflow effect claims report changed operations', async () => {
  const harness = createCommerceD1Harness();
  const operationId = `airf-v1-${'a'.repeat(64)}`;
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: 'missing',
    kind: 'restart',
    claimId: 'missing-claim',
    operationId,
    signal: new AbortController().signal,
    nowMs: 1_000,
  }), { status: 'changed' });
});

test('Admin IRL Workflow restart claim and dispatch recover lost D1 acknowledgements', async () => {
  let loseAcknowledgement = false;
  const harness = createCommerceD1Harness({
    observeBatchAfterCommit: ({ statements }) => {
      if (
        loseAcknowledgement &&
        statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))
      ) {
        loseAcknowledgement = false;
        throw new TypeError('effect acknowledgement lost');
      }
    },
  });
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  const operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);

  loseAcknowledgement = true;
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'lost-ack-claim',
    operationId,
    signal: new AbortController().signal,
    nowMs: 1_000,
  }), { status: 'claimed' });
  assert.equal(loseAcknowledgement, false);

  loseAcknowledgement = true;
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'lost-ack-claim',
    signal: new AbortController().signal,
    nowMs: 1_001,
  }), { status: 'dispatched' });
  assert.equal(loseAcknowledgement, false);
  loseAcknowledgement = true;
  assert.deepEqual(await retractAdminIrlRedeemFinalizeWorkflowRestartDispatch({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'lost-ack-claim',
    signal: new AbortController().signal,
    nowMs: 1_002,
  }), { status: 'retracted' });
  assert.equal(loseAcknowledgement, false);
  assert.deepEqual(await retractAdminIrlRedeemFinalizeWorkflowRestartDispatch({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'lost-ack-claim',
    signal: new AbortController().signal,
    nowMs: 1_003,
  }), { status: 'retracted' });
  assert.deepEqual((await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  }))?.pendingEffect, {
    kind: 'restart-claim',
    claimId: 'lost-ack-claim',
    untilMs: 31_003,
  });
});

test('Admin IRL Workflow rejects coexisting legacy and unified effects', async () => {
  const harness = createCommerceD1Harness();
  const requestKey = commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID);
  seedCommerceDocument(harness, {
    key: requestKey,
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  const repository = new D1CommerceRepository(harness.db);
  const stored = await repository.get(requestKey);
  assert.ok(stored);
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
        instanceCreationPending: true,
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
  });
  await assert.rejects(
    loadAdminIrlRedeemFinalizeWorkflowOperation({ env: { COMMERCE_DB: harness.db }, operationId }),
    /stored Admin IRL redeem Workflow operation is invalid/i,
  );
});

test('Admin IRL Workflow entry migrates legacy create intent and retains the unified effect', async () => {
  const harness = createCommerceD1Harness();
  const requestKey = commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID);
  seedCommerceDocument(harness, {
    key: requestKey,
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  const reserved = await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  assert.equal(reserved.status, 'reserved');
  if (reserved.status !== 'reserved') return;
  const repository = new D1CommerceRepository(harness.db);
  let stored = await repository.get(requestKey);
  assert.ok(stored);
  const retryableFailure = {
    code: 'unavailable' as const,
    message: 'Admin IRL redeem finalization is temporarily unavailable.',
    retryable: true,
  };
  const legacyExecution = structuredClone(stored.data.workflowFinalizeV1 as CommerceDocumentData);
  delete legacyExecution.pendingEffect;
  legacyExecution.instanceCreationPending = true;
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...legacyExecution,
        failure: retryableFailure,
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
  });
  const args = {
    env: { COMMERCE_DB: harness.db, HELIUS_API_KEY: 'test' } as Env,
    operationId,
    payload: reserved.payload,
    signal: new AbortController().signal,
  };
  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(args), { status: 'ready' });
  stored = await repository.get(requestKey);
  let execution = stored?.data.workflowFinalizeV1 as CommerceDocumentData;
  assert.equal(execution.failure, undefined);
  assert.equal(execution.instanceCreationPending, undefined);
  const enteredEffect = execution.pendingEffect as { kind: string; untilMs: number };
  assert.equal(enteredEffect.kind, 'create');
  assert.ok(enteredEffect.untilMs >= Date.now());

  let operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
    env: { COMMERCE_DB: harness.db },
    operationId,
  });
  assert.ok(operation);
  assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
    env: { COMMERCE_DB: harness.db },
    expectedRevision: operation.revision,
    kind: 'restart',
    claimId: 'entry-claim',
    operationId,
    signal: new AbortController().signal,
    nowMs: enteredEffect.untilMs,
  }), { status: 'claimed' });
  stored = await repository.get(requestKey);
  assert.ok(stored);
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...stored.data,
      workflowFinalizeV1: {
        ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
        failure: retryableFailure,
      },
    },
    version: stored.version + 1,
    createTime: stored.createTime,
  });
  await assert.rejects(publishAdminIrlRedeemFinalizeWorkflow(args), /publication draft is missing/i);
  stored = await repository.get(requestKey);
  execution = stored?.data.workflowFinalizeV1 as CommerceDocumentData;
  assert.deepEqual(execution.failure, retryableFailure);
  const restartClaim = execution.pendingEffect;
  assert.deepEqual(restartClaim, {
    kind: 'restart-claim',
    claimId: 'entry-claim',
    untilMs: enteredEffect.untilMs + 30_000,
  });

  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(args), { status: 'ready' });
  stored = await repository.get(requestKey);
  execution = stored?.data.workflowFinalizeV1 as CommerceDocumentData;
  assert.equal(execution.failure, undefined);
  assert.equal(execution.instanceCreationPending, undefined);
  assert.deepEqual(execution.pendingEffect, restartClaim);
  assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
    env: { COMMERCE_DB: harness.db },
    operationId,
    claimId: 'entry-claim',
    signal: new AbortController().signal,
    nowMs: enteredEffect.untilMs + 1,
  }), { status: 'dispatched' });
  const dispatched = {
    kind: 'restart',
    claimId: 'entry-claim',
    dispatchedAtMs: enteredEffect.untilMs + 1,
  };
  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(args), { status: 'ready' });
  stored = await repository.get(requestKey);
  execution = stored?.data.workflowFinalizeV1 as CommerceDocumentData;
  assert.deepEqual(execution.pendingEffect, dispatched);
});

test('Admin IRL Workflow on-chain pinning preserves concurrent execution field deletion', async () => {
  const harness = createCommerceD1Harness();
  const requestKey = commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID);
  seedCommerceDocument(harness, {
    key: requestKey,
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  const reserved = await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  assert.equal(reserved.status, 'reserved');
  const repository = new D1CommerceRepository(harness.db);
  const beforeEntry = await repository.get(requestKey);
  assert.ok(beforeEntry);
  seedCommerceDocument(harness, {
    key: requestKey,
    data: {
      ...beforeEntry.data,
      workflowFinalizeV1: {
        ...(beforeEntry.data.workflowFinalizeV1 as CommerceDocumentData),
        failure: {
          code: 'unavailable',
          message: 'Admin IRL redeem finalization is temporarily unavailable.',
          retryable: true,
        },
      },
    },
    version: beforeEntry.version + 1,
    createTime: beforeEntry.createTime,
  });
  const withFailure = await repository.get(requestKey);
  assert.ok(withFailure);
  const staleExecution = structuredClone(withFailure.data.workflowFinalizeV1 as CommerceDocumentData);
  assert.deepEqual(staleExecution.pendingEffect, { kind: 'create', untilMs: 0 });
  if (reserved.status !== 'reserved') return;
  await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow({
    env: { COMMERCE_DB: harness.db, HELIUS_API_KEY: 'test' } as Env,
    operationId,
    payload: reserved.payload,
    signal: new AbortController().signal,
  });
  const onchain = {
    adminWallet: OWNER,
    coreCollection: Keypair.generate().publicKey.toBase58(),
    treasury: Keypair.generate().publicKey.toBase58(),
  };
  await adminIrlRedeemFinalizeTestHooks.persistWorkflowOnchain({
    status: 'started',
    body,
    commerce: {
      commerceDb: harness.db,
      nowMs: Date.now(),
      providerFetch: fetch,
      signal: new AbortController().signal,
    },
    request: {},
    execution: staleExecution,
  } as never, onchain);

  const stored = await repository.get(requestKey);
  const execution = stored?.data.workflowFinalizeV1 as CommerceDocumentData;
  assert.equal(execution.failure, undefined);
  assert.equal(execution.instanceCreationPending, undefined);
  assert.equal((execution.pendingEffect as { kind?: unknown }).kind, 'create');
  assert.deepEqual(execution.onchain, onchain);
});

test('Admin IRL marker reuse is drafted before its D1-only publication step', async () => {
  const harness = createCommerceD1Harness();
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  const reserved = await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  assert.equal(reserved.status, 'reserved');
  if (reserved.status !== 'reserved') return;

  const deliveryId = 77;
  const sourceRequestId = 'ExistingRequest123';
  const receiptAssetId = Keypair.generate().publicKey.toBase58();
  const receiptClaimCode = 'ABCDEF-1234567890';
  const box = {
    boxId: 7,
    originalAssetId: OWNER,
    receiptAssetId,
    receiptClaimCode,
    dudeIds: [1, 2, 3],
  };
  const selectionKey = buildAdminIrlRedeemSelectionKey({ dropId: DROP_ID, originalAssetIds: [OWNER] });
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder(DROP_ID, String(deliveryId)),
    data: {
      ...buildAdminIrlRedeemDeliveryOrderDocument({
        dropId: DROP_ID,
        deliveryId,
        requestId: sourceRequestId,
        owner: OWNER,
        receiptOwner: OWNER,
        transferSignature: SIGNATURE,
        receiptTxs: [SIGNATURE],
        boxes: [box],
      }),
      packStatusProjectionState: 'pending',
      packStatusProjectionNextAttemptAtMs: 0,
      packStatusProjectionFailureCount: 0,
    } as CommerceDocumentData,
  });
  const markerKey = commerceKeyFromPath(dropAdminIrlRedeemPackMarkerPath(DROP_ID, OWNER));
  assert.ok(markerKey);
  const markerDocument = buildAdminIrlRedeemMarkerDocument({
    dropId: DROP_ID,
    deliveryId,
    requestId: sourceRequestId,
    owner: OWNER,
    transferSignature: SIGNATURE,
    selectionKey,
    box,
  }) as CommerceDocumentData;
  seedCommerceDocument(harness, {
    key: markerKey,
    data: markerDocument,
  });

  const projection = projectionDataDb();
  const args = {
    env: { COMMERCE_DB: harness.db, DATA_DB: projection.db } as Env,
    operationId,
    payload: reserved.payload,
    signal: new AbortController().signal,
  };
  assert.deepEqual(await prepareAdminIrlRedeemFinalizeWorkflowDraft(args), { status: 'drafted' });
  let request = await new D1CommerceRepository(harness.db).get(
    commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
  );
  assert.equal(request?.data.status, 'processing');
  const draft = request?.data.workflowPublicationDraftV1 as Record<string, unknown>;
  assert.equal(draft.mode, 'marker_reuse');
  assert.equal(draft.deliveryId, deliveryId);
  assert.equal(JSON.stringify(draft).includes(receiptClaimCode), false);

  const storedMarker = await new D1CommerceRepository(harness.db).get(markerKey);
  assert.ok(storedMarker);
  seedCommerceDocument(harness, {
    key: markerKey,
    data: buildAdminIrlRedeemMarkerDocument({
      dropId: DROP_ID,
      deliveryId,
      requestId: sourceRequestId,
      owner: OWNER,
      transferSignature: SIGNATURE,
      selectionKey,
      box: { ...box, receiptClaimCode: 'FEDCBA-0987654321' },
    }) as CommerceDocumentData,
    version: storedMarker.version + 1,
    createTime: storedMarker.createTime,
  });
  await assert.rejects(
    publishAdminIrlRedeemFinalizeWorkflow(args),
    (error) => {
      const details = (error as { details?: unknown }).details;
      return Boolean(details && typeof details === 'object' &&
        (details as { reason?: unknown }).reason === 'marker reuse state changed after draft');
    },
  );
  seedCommerceDocument(harness, {
    key: markerKey,
    data: markerDocument,
    version: storedMarker.version + 2,
    createTime: storedMarker.createTime,
  });

  assert.deepEqual(await publishAdminIrlRedeemFinalizeWorkflow(args), {
    kind: 'admin-irl-redeem-finalize-v1',
    dropId: DROP_ID,
    requestId: REQUEST_ID,
  });
  request = await new D1CommerceRepository(harness.db).get(
    commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
  );
  assert.equal(request?.data.status, 'complete');
  assert.equal(request?.data.deliveryId, deliveryId);
  assert.equal(request?.data.workflowPublicationDraftV1, undefined);
  assert.equal(projection.applied, 1);
  assert.equal((await new D1CommerceRepository(harness.db).get(
    commerceKeys.deliveryOrder(DROP_ID, String(deliveryId)),
  ))?.data.packStatusProjectionState, 'completed');
  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(args), { status: 'complete' });
  assert.deepEqual(await validateAdminIrlRedeemFinalizeWorkflow(args), { status: 'complete' });
  assert.deepEqual(await prepareAdminIrlRedeemFinalizeWorkflowDraft(args), { status: 'complete' });
  assert.deepEqual(await publishAdminIrlRedeemFinalizeWorkflow(args), {
    kind: 'admin-irl-redeem-finalize-v1',
    dropId: DROP_ID,
    requestId: REQUEST_ID,
  });
  assert.equal(projection.attempts, 1);
});

test('Admin IRL marker reuse reconciles a pending WAL submission before drafting', async () => {
  const harness = createCommerceD1Harness();
  const requestKey = commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID);
  seedCommerceDocument(harness, {
    key: requestKey,
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
  const reserved = await reserveAdminIrlRedeemFinalizeWorkflow({
    body,
    env: { COMMERCE_DB: harness.db },
    operationId,
    signal: new AbortController().signal,
    staffWallet: OWNER,
  });
  assert.equal(reserved.status, 'reserved');
  if (reserved.status !== 'reserved') return;

  const deliveryId = 81;
  const sourceRequestId = 'ExistingRequest456';
  const box = {
    boxId: 7,
    originalAssetId: OWNER,
    receiptAssetId: Keypair.generate().publicKey.toBase58(),
    receiptClaimCode: 'ABCDEF-1234567890',
    dudeIds: [1, 2, 3],
  };
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder(DROP_ID, String(deliveryId)),
    data: buildAdminIrlRedeemDeliveryOrderDocument({
      dropId: DROP_ID,
      deliveryId,
      requestId: sourceRequestId,
      owner: OWNER,
      receiptOwner: OWNER,
      transferSignature: SIGNATURE,
      receiptTxs: [SIGNATURE],
      boxes: [box],
    }) as CommerceDocumentData,
  });
  const markerKey = commerceKeyFromPath(dropAdminIrlRedeemPackMarkerPath(DROP_ID, OWNER));
  assert.ok(markerKey);
  seedCommerceDocument(harness, {
    key: markerKey,
    data: buildAdminIrlRedeemMarkerDocument({
      dropId: DROP_ID,
      deliveryId,
      requestId: sourceRequestId,
      owner: OWNER,
      transferSignature: SIGNATURE,
      selectionKey: buildAdminIrlRedeemSelectionKey({ dropId: DROP_ID, originalAssetIds: [OWNER] }),
      box,
    }) as CommerceDocumentData,
  });

  const pending = {
    kind: 'internal_delivery' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    deliveryId: 91,
    deliveryPda: Keypair.generate().publicKey.toBase58(),
  };
  const repository = new D1CommerceRepository(harness.db);
  const stored = await repository.get(requestKey);
  assert.ok(stored);
  seedCommerceDocument(harness, {
    key: requestKey,
    data: { ...stored.data, pendingFinalizeSubmission: pending },
    version: stored.version + 1,
    createTime: stored.createTime,
  });

  const rpcMethods: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: string; method: string };
    rpcMethods.push(request.method);
    assert.equal(request.method, 'getSignatureStatuses');
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
      },
    });
  };
  try {
    assert.deepEqual(await prepareAdminIrlRedeemFinalizeWorkflowDraft({
      env: { COMMERCE_DB: harness.db, HELIUS_API_KEY: 'test' } as Env,
      operationId,
      payload: reserved.payload,
      signal: new AbortController().signal,
    }), { status: 'drafted' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(rpcMethods, ['getSignatureStatuses']);
  const request = await repository.get(requestKey);
  assert.equal(request?.data.pendingFinalizeSubmission, undefined);
  assert.equal(request?.data.internalDeliveryId, pending.deliveryId);
  assert.equal(request?.data.internalDeliveryPda, pending.deliveryPda);
  assert.equal(request?.data.internalDeliveryTx, pending.signature);
  assert.equal((request?.data.workflowPublicationDraftV1 as { mode?: unknown }).mode, 'marker_reuse');
});

test('Admin IRL D1-only publication is idempotent for card and prepared-pack drafts', async () => {
  const cases = [
    { requestId: 'CardPublishRequest1', targetKind: 'card_receipt' as const, refId: 9 },
    { requestId: 'PackPublishRequest1', targetKind: 'pack' as const, refId: 7 },
  ];
  for (const testCase of cases) {
    const harness = createCommerceD1Harness();
    const originalAssetId = Keypair.generate().publicKey.toBase58();
    const receiptAssetId = testCase.targetKind === 'card_receipt'
      ? originalAssetId
      : Keypair.generate().publicKey.toBase58();
    const body = {
      requestId: testCase.requestId,
      dropId: DROP_ID,
      transferSignature: SIGNATURE,
    };
    const requestKey = commerceKeys.adminIrlRedeemRequest(DROP_ID, testCase.requestId);
    seedCommerceDocument(harness, {
      key: requestKey,
      data: {
        adminWallet: OWNER,
        dropId: DROP_ID,
        owner: OWNER,
        status: 'prepared',
        targetKind: testCase.targetKind,
        itemIds: [originalAssetId],
        items: [{ assetId: originalAssetId, kind: testCase.targetKind === 'pack' ? 'box' : 'card_receipt', refId: testCase.refId }],
        receiptTxs: [],
      },
    });
    const operationId = await adminIrlRedeemFinalizeOperationId(body, OWNER);
    const reserved = await reserveAdminIrlRedeemFinalizeWorkflow({
      body,
      env: { COMMERCE_DB: harness.db },
      operationId,
      signal: new AbortController().signal,
      staffWallet: OWNER,
    });
    assert.equal(reserved.status, 'reserved');
    if (reserved.status !== 'reserved') continue;
    if (testCase.targetKind === 'pack') {
      const effectOperation = await loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: { COMMERCE_DB: harness.db },
        operationId,
      });
      assert.ok(effectOperation);
      assert.deepEqual(await claimAdminIrlRedeemFinalizeWorkflowEffect({
        env: { COMMERCE_DB: harness.db },
        expectedRevision: effectOperation.revision,
        kind: 'restart',
        claimId: 'completion-claim',
        operationId,
        signal: new AbortController().signal,
        nowMs: 1_000,
      }), { status: 'claimed' });
      assert.deepEqual(await dispatchAdminIrlRedeemFinalizeWorkflowRestart({
        env: { COMMERCE_DB: harness.db },
        operationId,
        claimId: 'completion-claim',
        signal: new AbortController().signal,
        nowMs: 1_001,
      }), { status: 'dispatched' });
    }
    const stored = await new D1CommerceRepository(harness.db).get(requestKey);
    assert.ok(stored);
    const runtime = adminIrlRedeemPrepareTestHooks.buildRuntime(API_DROPS[DROP_ID]);
    const internalDeliveryId = 55;
    const [internalDeliveryPda] = deriveDeliveryPda(runtime, internalDeliveryId);
    let workflowPublicationDraftV1: CommerceDocumentData;
    if (testCase.targetKind === 'card_receipt') {
      workflowPublicationDraftV1 = {
        version: 1,
        targetKind: 'card_receipt',
        receiptOwner: OWNER,
        card: { figureId: testCase.refId, receiptAssetId },
      };
    } else {
      workflowPublicationDraftV1 = {
        version: 1,
        targetKind: 'pack',
        mode: 'prepared',
        receiptOwner: OWNER,
        internalDelivery: {
          deliveryId: internalDeliveryId,
          deliveryPda: internalDeliveryPda.toBase58(),
          deliveryTx: null,
        },
        closeDeliveryTx: null,
        receiptTxs: [SIGNATURE],
        boxes: [{
          boxId: testCase.refId,
          originalAssetId,
          receiptAssetId,
          dudeIds: [1, 2, 3],
        }],
      };
    }
    seedCommerceDocument(harness, {
      key: requestKey,
      data: {
        ...stored.data,
        workflowFinalizeV1: {
          ...(stored.data.workflowFinalizeV1 as CommerceDocumentData),
          failure: {
            code: 'resource-exhausted',
            message: 'Admin IRL redeem finalization resources are exhausted.',
            retryable: false,
          },
        },
        ...(testCase.targetKind === 'pack' ? {
          internalDeliveryId,
          internalDeliveryPda: internalDeliveryPda.toBase58(),
          receiptTxs: [SIGNATURE],
        } : {}),
        workflowPublicationDraftV1,
      },
      version: stored.version + 1,
      createTime: stored.createTime,
    });
    const projection = projectionDataDb();
    const args = {
      env: { COMMERCE_DB: harness.db, DATA_DB: projection.db } as Env,
      operationId,
      payload: reserved.payload,
      signal: new AbortController().signal,
    };
    const expectedReference = {
      kind: 'admin-irl-redeem-finalize-v1' as const,
      dropId: DROP_ID,
      requestId: testCase.requestId,
    };
    assert.deepEqual(await publishAdminIrlRedeemFinalizeWorkflow(args), expectedReference);
    assert.deepEqual(await publishAdminIrlRedeemFinalizeWorkflow(args), expectedReference);
    const result = await loadAdminIrlRedeemFinalizeWorkflowResult({ env: args.env, operationId });
    assert.equal(result.processed, true);
    assert.equal(result.cards.length, testCase.targetKind === 'card_receipt' ? 1 : 0);
    assert.equal(result.boxes.length, testCase.targetKind === 'pack' ? 1 : 0);
    const repository = new D1CommerceRepository(harness.db);
    const completed = await repository.get(requestKey);
    const completedExecution = completed?.data.workflowFinalizeV1 as CommerceDocumentData;
    assert.equal(completedExecution.failure, undefined);
    assert.equal(completedExecution.instanceCreationPending, undefined);
    assert.equal(completedExecution.pendingEffect, undefined);
    const orders = await repository.query({
      kind: 'delivery_order',
      dropId: DROP_ID,
    });
    assert.equal(orders.length, 1);
    assert.equal(projection.applied, testCase.targetKind === 'pack' ? 1 : 0);
    assert.equal(projection.attempts, testCase.targetKind === 'pack' ? 1 : 0);
    assert.equal(
      orders[0]?.data.packStatusProjectionState,
      testCase.targetKind === 'pack' ? 'completed' : undefined,
    );
  }
});

test('Admin IRL receipt owner scans finish pagination before checking uniqueness', async () => {
  const pages: number[] = [];
  const visited: string[] = [];
  const providerFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      id: string;
      params: { page: number };
    };
    pages.push(body.params.page);
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        page: body.params.page,
        limit: 1,
        total: 2,
        items: [{ id: body.params.page === 1 ? 'first-match' : 'later-duplicate' }],
      },
    });
  };
  await adminIrlRedeemFinalizeTestHooks.scanAssetsByOwner(
    { apiKey: 'helius', providerFetch, signal: new AbortController().signal },
    { cluster: 'devnet' } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.scanAssetsByOwner>[1],
    OWNER,
    (asset) => {
      if (asset && typeof asset === 'object' && 'id' in asset) visited.push(String(asset.id));
    },
  );
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(visited, ['first-match', 'later-duplicate']);

  let callsAfterDeadline = 0;
  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.scanAssetsByOwner(
    {
      apiKey: 'helius',
      providerFetch: async () => {
        callsAfterDeadline += 1;
        return Response.json({});
      },
      signal: new AbortController().signal,
    },
    { cluster: 'devnet' } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.scanAssetsByOwner>[1],
    OWNER,
    () => undefined,
    undefined,
    Date.now() - 1,
  ), /indexing timed out/);
  assert.equal(callsAfterDeadline, 0);
});

test('Admin IRL receipt indexing preserves exact request cancellation', async () => {
  const cardController = new AbortController();
  const cardReason = new Error('card receipt lookup cancelled');
  await assert.rejects(
    adminIrlRedeemFinalizeTestHooks.waitForCardReceipt(
      {
        apiKey: 'helius',
        providerFetch: async () => {
          cardController.abort(cardReason);
          throw cardReason;
        },
        signal: cardController.signal,
      },
      { cluster: 'devnet' } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.waitForCardReceipt>[1],
      OWNER,
      9,
      OWNER,
    ),
    (error) => error === cardReason,
  );

  const packController = new AbortController();
  const packReason = new Error('pack receipt transaction lookup cancelled');
  await assert.rejects(
    adminIrlRedeemFinalizeTestHooks.findReceiptAssets(
      {
        getTransactions: async () => {
          packController.abort(packReason);
          throw packReason;
        },
      } as unknown as Connection,
      {
        apiKey: 'helius',
        providerFetch: async () => assert.fail('cancelled lookup reached owner scan'),
        signal: packController.signal,
      },
      { dropId: DROP_ID } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.findReceiptAssets>[2],
      OWNER,
      [{ assetId: OWNER, kind: 'box', refId: 7 }],
      [SIGNATURE],
    ),
    (error) => error === packReason,
  );

  await assert.rejects(
    adminIrlRedeemFinalizeTestHooks.findReceiptAssets(
      {
        getTransactions: async () => [confirmedTransaction(new PublicKey(OWNER), [])],
      } as unknown as Connection,
      {
        apiKey: 'helius',
        providerFetch: async () => assert.fail('mismatched transaction reached owner scan'),
        signal: new AbortController().signal,
      },
      { dropId: DROP_ID } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.findReceiptAssets>[2],
      OWNER,
      [{ assetId: OWNER, kind: 'box', refId: 7 }],
      [SIGNATURE],
    ),
    /transaction assets do not match/,
  );
});

test('Admin IRL finalization normalizes prepared pack and card requests strictly', () => {
  assert.deepEqual(adminIrlRedeemFinalizeTestHooks.normalizeItems({
    targetKind: 'pack',
    itemIds: [OWNER],
    items: [{ assetId: OWNER, kind: 'box', refId: 7 }],
  }), {
    targetKind: 'pack',
    itemIds: [OWNER],
    items: [{ assetId: OWNER, kind: 'box', refId: 7 }],
  });
  assert.deepEqual(adminIrlRedeemFinalizeTestHooks.normalizeItems({
    targetKind: 'card_receipt',
    itemIds: [OWNER],
    items: [{ assetId: OWNER, kind: 'card_receipt', refId: 9 }],
  }).targetKind, 'card_receipt');
  assert.throws(() => adminIrlRedeemFinalizeTestHooks.normalizeItems({
    targetKind: 'pack',
    itemIds: [OWNER, OWNER],
    items: [
      { assetId: OWNER, kind: 'box', refId: 7 },
      { assetId: OWNER, kind: 'box', refId: 8 },
    ],
  }), /duplicate/);
  assert.throws(() => adminIrlRedeemFinalizeTestHooks.normalizeItems({
    targetKind: 'pack',
    itemIds: [OWNER],
    items: [{ assetId: OWNER, kind: 'card_receipt', refId: 9 }],
  }), /target kind mismatch/);
});

test('Admin IRL finalization acquires, rejects, and recovers processing leases', async () => {
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const prepared = {
    adminWallet: OWNER,
    dropId: DROP_ID,
    owner: OWNER,
    status: 'prepared',
    targetKind: 'pack',
    itemIds: [OWNER],
    items: [{ assetId: OWNER, kind: 'box', refId: 7 }],
    receiptTxs: [],
  };
  const startedContext = commerceContext(prepared);
  const started = await adminIrlRedeemFinalizeTestHooks.startFinalize(
    startedContext,
    body,
    OWNER,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(started.status, 'started');
  const startedDocument = await deliveryReceiptRuntime.readDocument(
    startedContext,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(startedDocument?.fields.status, 'processing');
  assert.equal(startedDocument?.fields.processingAttemptId, 'attempt');

  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.startFinalize(
    commerceContext({
      ...prepared,
      status: 'processing',
      processingLeaseExpiresAt: 1_700_000_100_000,
    }),
    body,
    OWNER,
    'another-attempt',
    1_700_000_000_000,
  ), /already being finalized/);

  const recovered = await adminIrlRedeemFinalizeTestHooks.startFinalize(
    commerceContext({
      ...prepared,
      status: 'processing',
      processingLeaseExpiresAt: 1_699_999_999_999,
    }),
    body,
    OWNER,
    'recovered-attempt',
    1_700_000_000_000,
  );
  assert.equal(recovered.status, 'started');
});

test('Admin IRL finalization reconciles an applied processing lease whose acknowledgement is lost', async () => {
  let loseAcknowledgement = false;
  const context = commerceContext({
    adminWallet: OWNER,
    dropId: DROP_ID,
    owner: OWNER,
    status: 'prepared',
    targetKind: 'pack',
    itemIds: [OWNER],
    items: [{ assetId: OWNER, kind: 'box', refId: 7 }],
    receiptTxs: [],
  }, {
    observeBatchAfterCommit: ({ statements }) => {
      if (
        loseAcknowledgement &&
        statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))
      ) {
        loseAcknowledgement = false;
        throw new TypeError('processing lease acknowledgement lost');
      }
    },
  });
  loseAcknowledgement = true;

  const started = await adminIrlRedeemFinalizeTestHooks.startFinalize(
    context,
    { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE },
    OWNER,
    'reconciled-attempt',
    1_700_000_000_000,
  );

  assert.equal(started.status, 'started');
  assert.equal(loseAcknowledgement, false);
  const document = await deliveryReceiptRuntime.readDocument(
    context,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.status, 'processing');
  assert.equal(document?.fields.processingAttemptId, 'reconciled-attempt');
});

test('Admin IRL finalization writes submission intent before broadcast and keeps its fence', async () => {
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
    processingLeaseExpiresAt: 1_700_000_100_000,
    workflowFinalizeV1: { instanceCreationPending: true },
  });
  const pending = {
    kind: 'internal_delivery' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    deliveryId: 7,
    deliveryPda: Keypair.generate().publicKey.toBase58(),
  };
  await adminIrlRedeemFinalizeTestHooks.persistPendingFinalizeSubmission(
    context,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
    'attempt',
    pending,
  );
  assert.deepEqual(await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: { COMMERCE_DB: context.commerceDb },
    error: { code: 'resource-exhausted', message: 'No figures remain.', retryable: false },
    operationId: 'attempt',
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  }), { cleared: false });
  let document = await deliveryReceiptRuntime.readDocument(
    context,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.status, 'processing');
  assert.deepEqual(document?.fields.pendingFinalizeSubmission, pending);
  assert.deepEqual(document?.fields.lastFinalizeError, {
    kind: 'workflow',
    code: 'resource-exhausted',
    recovery: 'manual',
  });
  assert.deepEqual((document?.fields.workflowFinalizeV1 as { failure?: unknown }).failure, {
    code: 'resource-exhausted',
    message: 'Admin IRL redeem finalization resources are exhausted.',
    retryable: false,
  });
  assert.equal(
    (document?.fields.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending,
    undefined,
  );

  assert.deepEqual(await cleanupAdminIrlRedeemFinalizeWorkflow({
    env: { COMMERCE_DB: context.commerceDb },
    error: { code: 'unavailable', message: 'Provider unavailable.', retryable: true },
    operationId: 'attempt',
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  }), { cleared: false });
  document = await deliveryReceiptRuntime.readDocument(
    context,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.deepEqual(document?.fields.lastFinalizeError, {
    kind: 'workflow',
    code: 'unavailable',
    recovery: 'automatic',
  });
  assert.deepEqual((document?.fields.workflowFinalizeV1 as { failure?: unknown }).failure, {
    code: 'unavailable',
    message: 'Admin IRL redeem finalization is temporarily unavailable.',
    retryable: true,
  });
});

test('Admin IRL submission intent recovers a lost D1 commit acknowledgement', async () => {
  let armed = false;
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
  }, {
    observeBatchAfterCommit: (observation) => {
      if (!armed || !observation.statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
      armed = false;
      throw new Error('lost D1 commit acknowledgement');
    },
  });
  const path = `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`;
  const pending = {
    kind: 'receipt_mint' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };

  armed = true;
  await adminIrlRedeemFinalizeTestHooks.persistPendingFinalizeSubmission(
    context,
    path,
    'attempt',
    pending,
  );

  const document = await deliveryReceiptRuntime.readDocument(context, path);
  assert.deepEqual(document?.fields.pendingFinalizeSubmission, pending);
});

test('Admin IRL submission settlement survives a lost D1 acknowledgement', async () => {
  let armed = false;
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
  }, {
    observeBatchAfterCommit: (observation) => {
      if (!armed || !observation.statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
      armed = false;
      throw new Error('lost D1 settlement acknowledgement');
    },
  });
  const path = `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`;
  const pending = {
    kind: 'receipt_mint' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  await adminIrlRedeemFinalizeTestHooks.persistPendingFinalizeSubmission(context, path, 'attempt', pending);

  armed = true;
  await adminIrlRedeemFinalizeTestHooks.settlePendingFinalizeSubmission(
    context,
    path,
    'attempt',
    pending,
    'confirmed',
  );
  await adminIrlRedeemFinalizeTestHooks.settlePendingFinalizeSubmission(
    context,
    path,
    'attempt',
    pending,
    'confirmed',
  );

  const document = await deliveryReceiptRuntime.readDocument(context, path);
  assert.equal(document?.fields.pendingFinalizeSubmission, undefined);
  assert.deepEqual(document?.fields.receiptTxs, [pending.signature]);
});

test('Admin IRL pre-broadcast cancellation clears only its exact submission intent', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before Admin IRL broadcast');
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
  });
  context.signal = controller.signal;
  const path = `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`;
  const pending = {
    kind: 'receipt_mint' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  await adminIrlRedeemFinalizeTestHooks.persistPendingFinalizeSubmission(context, path, 'attempt', pending);
  controller.abort(reason);

  await assert.rejects(
    adminIrlRedeemFinalizeTestHooks.rethrowUnbroadcastFinalizeCancellation({
      broadcastStarted: false,
      commerce: context,
      error: reason,
      path,
      attemptId: 'attempt',
      pending,
    }),
    (error) => error === reason,
  );
  const document = await deliveryReceiptRuntime.readDocument(
    { ...context, signal: new AbortController().signal },
    path,
  );
  assert.equal(document?.fields.pendingFinalizeSubmission, undefined);
});

test('Admin IRL receipt mint rethrows cancellation on its final retry', { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled on final receipt mint attempt');
  const asset = Keypair.generate().publicKey;
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
  });
  context.signal = controller.signal;
  let blockhashCalls = 0;
  const connection = {
    getLatestBlockhash: async () => {
      blockhashCalls += 1;
      if (blockhashCalls < 3) throw new Error('retry receipt mint');
      controller.abort(reason);
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      };
    },
    getMultipleAccountsInfo: async () => [{ data: Buffer.alloc(2) }],
  } as unknown as Connection;
  const runtime = adminIrlRedeemPrepareTestHooks.buildRuntime(API_DROPS[DROP_ID]);

  await assert.rejects(
    adminIrlRedeemFinalizeTestHooks.mintPackReceipts(
      connection,
      { apiKey: 'helius', providerFetch: async () => assert.fail('unexpected provider fetch'), signal: controller.signal },
      runtime,
      Keypair.generate(),
      Keypair.generate().publicKey,
      [{ assetId: asset.toBase58(), kind: 'box', refId: 7 }],
      context,
      `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
      'attempt',
      [],
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(blockhashCalls, 3);
});

test('Admin IRL finalization clears definitive preflight submissions without tombstone recovery', async () => {
  const path = `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`;
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
  });
  const pending = {
    kind: 'receipt_mint' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  await adminIrlRedeemFinalizeTestHooks.persistPendingFinalizeSubmission(context, path, 'attempt', pending);
  const signer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message());
  transaction.sign([signer]);
  const preflightFailure = Object.assign(new Error('simulation failed'), { logs: ['Program failed'] });
  let failure: unknown;
  try {
    await sendAndConfirmSignedTransaction({
      sendTransaction: async () => { throw preflightFailure; },
    } as unknown as Connection, transaction, context.signal, 'Admin IRL receipt mint');
    assert.fail('definitive preflight unexpectedly succeeded');
  } catch (error) {
    failure = error;
  }
  assert.equal(adminIrlRedeemFinalizeTestHooks.isDefinitiveTransactionFailure(failure), true);
  let postStateChecked = false;
  assert.equal(await adminIrlRedeemFinalizeTestHooks.receiptBatchConfirmedByPostState(
    failure,
    {
      getMultipleAccountsInfo: async () => {
        postStateChecked = true;
        return [null];
      },
    } as unknown as Pick<Connection, 'getMultipleAccountsInfo'>,
    [Keypair.generate().publicKey],
  ), false);
  assert.equal(postStateChecked, false);

  await adminIrlRedeemFinalizeTestHooks.clearDefinitiveFinalizeSubmission({
    commerce: context,
    path,
    attemptId: 'attempt',
    pending,
  });

  const document = await deliveryReceiptRuntime.readDocument(context, path);
  assert.equal(document?.fields.pendingFinalizeSubmission, undefined);
  assert.equal(document?.fields.status, 'processing');
});

test('Admin IRL finalization promotes only confirmed pending submissions', async () => {
  const path = `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`;
  const context = commerceContext({
    dropId: DROP_ID,
    owner: OWNER,
    status: 'processing',
    processingAttemptId: 'attempt',
    receiptTxs: [SIGNATURE],
  });
  const confirmedSignature = bs58.encode(Keypair.generate().secretKey);
  const pending = {
    kind: 'receipt_mint' as const,
    signature: confirmedSignature,
    blockhash: Keypair.generate().publicKey.toBase58(),
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  await adminIrlRedeemFinalizeTestHooks.persistPendingFinalizeSubmission(context, path, 'attempt', pending);
  let document = await deliveryReceiptRuntime.readDocument(context, path);
  assert.deepEqual(document?.fields.receiptTxs, [SIGNATURE]);
  await adminIrlRedeemFinalizeTestHooks.settlePendingFinalizeSubmission(
    context,
    path,
    'attempt',
    pending,
    'confirmed',
  );
  document = await deliveryReceiptRuntime.readDocument(context, path);
  assert.deepEqual(document?.fields.receiptTxs, [SIGNATURE, confirmedSignature]);
  assert.equal(document?.fields.pendingFinalizeSubmission, undefined);
  assert.equal(document?.fields.status, 'processing');
});

test('Admin IRL finalization distinguishes confirmed, expired, and unresolved submissions', async () => {
  const pending = {
    kind: 'internal_delivery' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    deliveryId: 7,
    deliveryPda: Keypair.generate().publicKey.toBase58(),
  };
  const connection = (overrides: Partial<Pick<Connection,
    'getAccountInfo' | 'getMultipleAccountsInfo' | 'getSignatureStatuses' | 'isBlockhashValid'
  >>) => ({
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async () => [{ data: Buffer.alloc(2) } as never],
    getSignatureStatuses: async () => ({ context: { apiVersion: 'test', slot: 1 }, value: [null] }),
    isBlockhashValid: async () => ({ context: { apiVersion: 'test', slot: 1 }, value: true }),
    ...overrides,
  }) as unknown as Connection;
  assert.equal(await adminIrlRedeemFinalizeTestHooks.probePendingFinalizeSubmission(
    connection({ getAccountInfo: async () => ({ data: Buffer.alloc(0) }) as never }),
    pending,
  ), 'confirmed');
  for (const confirmations of [null, 2]) {
    let postStateChecks = 0;
    assert.equal(await adminIrlRedeemFinalizeTestHooks.probePendingFinalizeSubmission(
      connection({
        getAccountInfo: async () => {
          postStateChecks += 1;
          return null;
        },
        getSignatureStatuses: async () => ({
          context: { apiVersion: 'test', slot: 1 },
          value: [{ confirmations, err: null, slot: 1 }],
        }),
      }),
      pending,
    ), 'confirmed');
    assert.equal(postStateChecks, 0);
  }
  assert.equal(await adminIrlRedeemFinalizeTestHooks.probePendingFinalizeSubmission(
    connection({ isBlockhashValid: async () => ({ context: { apiVersion: 'test', slot: 1 }, value: false }) }),
    pending,
  ), 'expired');
  assert.equal(await adminIrlRedeemFinalizeTestHooks.probePendingFinalizeSubmission(connection({}), pending), 'unresolved');

  const failedReceipt = {
    kind: 'receipt_mint' as const,
    signature: bs58.encode(Keypair.generate().secretKey),
    blockhash: Keypair.generate().publicKey.toBase58(),
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  assert.equal(await adminIrlRedeemFinalizeTestHooks.probePendingFinalizeSubmission(
    connection({
      getMultipleAccountsInfo: async () => [null],
      getSignatureStatuses: async () => ({
        context: { apiVersion: 'test', slot: 1 },
        value: [{ confirmations: null, err: { InstructionError: [0, 'Custom'] }, slot: 1 } as never],
      }),
    }),
    failedReceipt,
  ), 'expired');
});

test('Admin IRL finalization rebuilds completed responses idempotently', () => {
  const response = adminIrlRedeemFinalizeTestHooks.completeResponse(DROP_ID, REQUEST_ID, {
    deliveryId: 7,
    receiptTxs: [SIGNATURE, SIGNATURE],
    claimCodes: ['ABCDEF-1234567890'],
    boxes: [{ boxId: 3, receiptAssetId: OWNER, claimCode: 'ABCDEF-1234567890', dudeIds: [1, 2] }],
    cards: [],
  });
  assert.equal(response.processed, true);
  assert.deepEqual(response.receiptTxs, [SIGNATURE]);
  assert.equal(response.boxes[0].boxId, 3);
});

test('Admin IRL finalization verifies the exact ordered Core transfer', async () => {
  const owner = new PublicKey(OWNER);
  const admin = Keypair.generate().publicKey;
  const collection = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const transaction = confirmedTransaction(owner, [new TransactionInstruction({
    programId: new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: admin, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  })]);
  const connection: Pick<Connection, 'getTransaction'> = {
    getTransaction: (async () => transaction) as Connection['getTransaction'],
  };
  await adminIrlRedeemFinalizeTestHooks.verifyPackTransfer(
    connection,
    SIGNATURE,
    owner.toBase58(),
    admin.toBase58(),
    collection,
    [asset.toBase58()],
  );
  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.verifyPackTransfer(
    connection,
    SIGNATURE,
    owner.toBase58(),
    admin.toBase58(),
    collection,
    [Keypair.generate().publicKey.toBase58()],
  ), /asset mismatch/);

  const secondAsset = Keypair.generate().publicKey;
  const secondTransaction = confirmedTransaction(owner, [asset, secondAsset].map((id) => new TransactionInstruction({
    programId: new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
    keys: [
      { pubkey: id, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: admin, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  })));
  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.verifyPackTransfer(
    { getTransaction: (async () => secondTransaction) as Connection['getTransaction'] },
    SIGNATURE,
    owner.toBase58(),
    admin.toBase58(),
    collection,
    [secondAsset.toBase58(), asset.toBase58()],
  ), (error: unknown) => {
    assert.ok(error instanceof AdminIrlRedeemFinalizeError);
    assert.equal(error.code, 'failed-precondition');
    assert.equal(error.message, 'Admin IRL redeem transfer asset mismatch.');
    assert.deepEqual(error.details, {
      expected: [secondAsset.toBase58(), asset.toBase58()],
      got: [asset.toBase58(), secondAsset.toBase58()],
    });
    return true;
  });
});

test('Admin IRL finalization verifies the exact Bubblegum receipt leaf transfer', async () => {
  const owner = new PublicKey(OWNER);
  const admin = Keypair.generate().publicKey;
  const collection = Keypair.generate().publicKey;
  const merkleTree = Keypair.generate().publicKey;
  const receipt = Keypair.generate().publicKey;
  const bubblegum = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
  const noop = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
  const transfer = new TransactionInstruction({
    programId: bubblegum,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: admin, isSigner: false, isWritable: false },
      { pubkey: merkleTree, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: false },
    ],
    data: IX_BUBBLEGUM_TRANSFER_V2,
  });
  const noopInstruction = new TransactionInstruction({ programId: noop, keys: [], data: Buffer.alloc(0) });
  const base = confirmedTransaction(owner, [transfer, noopInstruction]);
  const noopProgramIndex = base.transaction.message.staticAccountKeys.findIndex((key) => key.equals(noop));
  const event = Buffer.alloc(41);
  event[0] = 1;
  event[1] = 0;
  event.writeUInt32LE(35, 2);
  event[6] = 1;
  event[7] = 1;
  event[8] = 1;
  receipt.toBuffer().copy(event, 9);
  base.meta!.innerInstructions = [{
    index: 0,
    instructions: [{ programIdIndex: noopProgramIndex, accounts: [], data: bs58.encode(event) }],
  }];
  const connection: Pick<Connection, 'getTransaction'> = {
    getTransaction: (async () => base) as Connection['getTransaction'],
  };
  const runtime = { receiptsMerkleTree: merkleTree } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.verifyCardTransfer>[1];
  await adminIrlRedeemFinalizeTestHooks.verifyCardTransfer(
    connection,
    runtime,
    SIGNATURE,
    owner.toBase58(),
    admin.toBase58(),
    collection,
    receipt.toBase58(),
  );

  base.transaction.message.compiledInstructions.push(base.transaction.message.compiledInstructions[0]);
  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.verifyCardTransfer(
    connection,
    runtime,
    SIGNATURE,
    owner.toBase58(),
    admin.toBase58(),
    collection,
    receipt.toBase58(),
  ), (error: unknown) => {
    assert.ok(error instanceof AdminIrlRedeemFinalizeError);
    assert.equal(error.code, 'failed-precondition');
    assert.equal(error.message, 'Card receipt transfer asset mismatch.');
    assert.deepEqual(error.details, { expected: receipt.toBase58(), got: [receipt.toBase58()] });
    return true;
  });

  base.meta!.innerInstructions![0].instructions[0].data = '0';
  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.verifyCardTransfer(
    connection,
    runtime,
    SIGNATURE,
    owner.toBase58(),
    admin.toBase58(),
    collection,
    receipt.toBase58(),
  ), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof AdminIrlRedeemFinalizeError));
    assert.match(error.message, /Non-base58 character/);
    return true;
  });
});

test('Admin transfer verification preserves RPC errors and fee-payer errors', async () => {
  const owner = new PublicKey(OWNER);
  const admin = Keypair.generate().publicKey;
  const collection = Keypair.generate().publicKey;
  const receipt = Keypair.generate().publicKey.toBase58();
  const runtime = { receiptsMerkleTree: Keypair.generate().publicKey } as Parameters<typeof adminIrlRedeemFinalizeTestHooks.verifyCardTransfer>[1];
  for (const kind of ['pack', 'card'] as const) {
    const verify = (connection: Pick<Connection, 'getTransaction'>) => kind === 'pack'
      ? adminIrlRedeemFinalizeTestHooks.verifyPackTransfer(connection, SIGNATURE, OWNER, admin.toBase58(), collection, [receipt])
      : adminIrlRedeemFinalizeTestHooks.verifyCardTransfer(connection, runtime, SIGNATURE, OWNER, admin.toBase58(), collection, receipt);
    await assert.rejects(() => verify({
      getTransaction: async (signature, config) => {
        assert.equal(signature, SIGNATURE);
        assert.deepEqual(config, { maxSupportedTransactionVersion: 0 });
        return null;
      },
    }), {
      name: 'AdminIrlRedeemFinalizeError',
      code: 'unavailable',
      message: 'Admin IRL redeem transfer transaction not found yet; retry shortly.',
    });
    const failed = confirmedTransaction(owner, []);
    const transactionError = { InstructionError: [0, 'Custom'] };
    failed.meta!.err = transactionError;
    await assert.rejects(() => verify({ getTransaction: (async () => failed) as Connection['getTransaction'] }), {
      code: 'failed-precondition',
      message: 'Admin IRL redeem transfer transaction failed.',
      details: { err: transactionError },
    });
    await assert.rejects(() => verify({ getTransaction: (async () => confirmedTransaction(admin, [])) as Connection['getTransaction'] }), {
      code: 'failed-precondition',
      message: kind === 'pack'
        ? 'Admin IRL redeem transfer payer does not match requester.'
        : 'Card receipt transfer payer does not match sender.',
    });
  }
});
