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
import { deliveryReceiptRuntime, deriveDeliveryPda } from '../src/deliveryReceipts.ts';
import { sendAndConfirmSignedTransaction } from '../src/deliveryReceiptOnchain.ts';
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
  cleanupAdminIrlRedeemFinalizeWorkflow,
  confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation,
  loadAdminIrlRedeemFinalizeWorkflowResult,
  prepareAdminIrlRedeemFinalizeWorkflowDraft,
  publishAdminIrlRedeemFinalizeWorkflow,
  parseAdminIrlRedeemFinalizeWorkflowOutput,
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
  assert.equal((document?.fields.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending, true);

  assert.deepEqual(await confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation({
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
  }), { confirmed: true });
  document = await deliveryReceiptRuntime.readDocument(
    { commerceDb: harness.db, nowMs: 1_700_000_000_000, providerFetch: fetch, signal: new AbortController().signal },
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal((document?.fields.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending, undefined);
  assert.deepEqual(await confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation({
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
  }), { confirmed: false });

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
  assert.equal(replayExecution.failure, undefined);
  assert.equal(replayExecution.instanceCreationPending, undefined);

  assert.deepEqual(await confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation({
    env: { COMMERCE_DB: harness.db },
    operationId: expectedOperationId,
    signal: new AbortController().signal,
  }), { confirmed: false });
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
  assert.equal((document?.fields.workflowFinalizeV1 as { instanceCreationPending?: unknown }).instanceCreationPending, undefined);

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
    markInstanceCreationPending: true,
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
  assert.equal(replayExecution.failure, undefined);
  assert.equal(replayExecution.instanceCreationPending, true);

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
});

test('Admin IRL Workflow instance confirmation bounds a non-cooperative operation lookup', async () => {
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const statement = {
    bind() { return this; },
  } as unknown as D1PreparedStatement;
  const db = {
    prepare: () => statement,
    batch: async () => {
      lookupStarted();
      return new Promise<never>(() => undefined);
    },
  } as unknown as D1Database;
  const controller = new AbortController();
  const reason = new DOMException('Confirmation timed out.', 'TimeoutError');
  const confirmation = confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation({
    env: { COMMERCE_DB: db },
    operationId: `airf-v1-${'a'.repeat(64)}`,
    signal: controller.signal,
  });

  await started;
  controller.abort(reason);

  await assert.rejects(confirmation, (error: unknown) => error === reason);
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

  const args = {
    env: { COMMERCE_DB: harness.db } as Env,
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
  assert.deepEqual(await resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(args), { status: 'complete' });
  assert.deepEqual(await validateAdminIrlRedeemFinalizeWorkflow(args), { status: 'complete' });
  assert.deepEqual(await prepareAdminIrlRedeemFinalizeWorkflowDraft(args), { status: 'complete' });
  assert.deepEqual(await publishAdminIrlRedeemFinalizeWorkflow(args), {
    kind: 'admin-irl-redeem-finalize-v1',
    dropId: DROP_ID,
    requestId: REQUEST_ID,
  });
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
    const args = {
      env: { COMMERCE_DB: harness.db } as Env,
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
    const orders = await new D1CommerceRepository(harness.db).query({
      kind: 'delivery_order',
      dropId: DROP_ID,
    });
    assert.equal(orders.length, 1);
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
    error: { code: 'unavailable', message: 'Retry.', retryable: true },
    operationId: 'attempt',
    payload: { version: 1, dropId: DROP_ID, requestId: REQUEST_ID },
    signal: new AbortController().signal,
  }), { cleared: false });
  const document = await deliveryReceiptRuntime.readDocument(
    context,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(document?.fields.status, 'processing');
  assert.deepEqual(document?.fields.pendingFinalizeSubmission, pending);
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
});
