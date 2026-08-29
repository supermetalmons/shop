import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  createDeferredWorkCollector,
  failOnDeferredWork,
  isDeferredWorkRegistrationError,
} from './deferredWork.ts';
import bs58 from 'bs58';
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
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { registerDeferredWork } from '../src/deferredWork.ts';
import { API_DROPS } from '../src/dropConfig.ts';
import { deliveryReceiptRuntime } from '../src/deliveryReceipts.ts';
import { sendAndConfirmSignedTransaction } from '../src/deliveryReceiptOnchain.ts';
import { adminIrlRedeemPrepareTestHooks } from '../src/adminIrlRedeemPrepare.ts';
import { commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import {
  ADMIN_IRL_REDEEM_FINALIZE_PATH,
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeTestHooks,
  handleAdminIrlRedeemFinalize,
  type AdminIrlRedeemFinalizeResponse,
} from '../src/adminIrlRedeemFinalize.ts';

const OWNER = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const DROP_ID = 'card_nft_2';
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrSt';
const SIGNATURE = Keypair.generate().publicKey.toBase58().repeat(2).slice(0, 88);
const RESPONSE: AdminIrlRedeemFinalizeResponse = {
  processed: true,
  dropId: DROP_ID,
  requestId: REQUEST_ID,
  deliveryId: 7,
  receiptTxs: [],
  claimCodes: [],
  boxes: [],
  cards: [],
};

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

function request(body: unknown = {
  requestId: REQUEST_ID,
  dropId: DROP_ID,
  transferSignature: SIGNATURE,
}, init: RequestInit = {}): Request {
  return new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_FINALIZE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function env(commerceDb = createCommerceD1()) {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    COMMERCE_DB: commerceDb,
    COSIGNER_SECRET: 'cosigner',
    HELIUS_API_KEY: 'helius',
    REVEAL_BACKGROUND_QUEUE: {
      send: async () => ({ metadata: { metrics } }),
      sendBatch: async () => ({ metadata: { metrics } }),
      metrics: async () => metrics,
    } satisfies Queue,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    providerFetch: async () => { throw new Error('unexpected provider fetch'); },
    nowMs: () => 1_700_000_000_000,
    timeoutMs: 1_000,
    finalize: async () => ({ response: RESPONSE, targetKind: 'pack' as const, outcome: 'completed' }),
    ...overrides,
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

test('Admin IRL finalization returns the exact synchronous response and metrics', async () => {
  const deferred = createDeferredWorkCollector();
  const result = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    deferred.defer,
    dependencies(),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), RESPONSE);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.targetKind, 'pack');
  assert.equal(result.deliveryId, 7);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.metrics, { upstreamCalls: 0, providerDurationMs: 0 });
  assert.deepEqual(deferred.promises, []);
});

test('Admin IRL finalization propagates deferred-work registration failures', async () => {
  const cause = new Error('waitUntil rejected finalization work');
  await assert.rejects(
    handleAdminIrlRedeemFinalize(
      request(),
      env(),
      () => { throw cause; },
      dependencies({
        finalize: async (...args: Parameters<typeof adminIrlRedeemFinalizeTestHooks.finalizeAdminIrlRedeem>) => {
          registerDeferredWork(args[5], Promise.resolve());
          assert.fail('registration failure must stop finalization');
        },
      }),
    ),
    (error: unknown) =>
      isDeferredWorkRegistrationError(error, cause),
  );
});

test('Admin IRL finalization enforces method, content type, and exact bounded input', async () => {
  const wrongMethod = await handleAdminIrlRedeemFinalize(
    new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_FINALIZE_PATH}`),
    env(),
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'POST, OPTIONS');

  const wrongType = await handleAdminIrlRedeemFinalize(
    request(undefined, { headers: { 'Content-Type': 'text/plain' } }),
    env(),
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(wrongType.response.status, 400);

  const extra = await handleAdminIrlRedeemFinalize(
    request({ requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE, extra: true }),
    env(),
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(extra.response.status, 400);

  const oversized = new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_FINALIZE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' },
    body: '{}',
  });
  const tooLarge = await handleAdminIrlRedeemFinalize(oversized, env(), failOnDeferredWork, dependencies());
  assert.equal(tooLarge.response.status, 400);
});

test('Admin IRL finalization maps authentication, business, provider, and deadline failures', async () => {
  const unauthenticated = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    failOnDeferredWork,
    dependencies({ verifyIdentity: async () => { throw new RequestIdentityError('invalid-token'); } }),
  );
  assert.equal(unauthenticated.response.status, 401);
  assert.deepEqual(await unauthenticated.response.json(), {
    ok: false,
    error: { code: 'unauthenticated', message: 'Authentication is required.' },
  });

  const anonymousOnly = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    failOnDeferredWork,
    dependencies({ verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-uid' }) }),
  );
  assert.equal(anonymousOnly.response.status, 401);

  const conflict = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    failOnDeferredWork,
    dependencies({
      finalize: async () => { throw new AdminIrlRedeemFinalizeError('aborted', 'Already processing.'); },
    }),
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.outcome, 'aborted');

  const unavailable = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    failOnDeferredWork,
    dependencies({
      finalize: async () => { throw new AdminIrlRedeemFinalizeError('unavailable', 'Provider unavailable.'); },
    }),
  );
  assert.equal(unavailable.response.status, 502);
  assert.equal(unavailable.authOutcome, 'provider-failure');

  const deferred = createDeferredWorkCollector();
  let finalizeAborted = false;
  let cleanupSettled = false;
  let releaseCleanup: (() => void) | undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const deadline = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    deferred.defer,
    dependencies({
      timeoutMs: 1,
      finalize: async (...args: Parameters<typeof adminIrlRedeemFinalizeTestHooks.finalizeAdminIrlRedeem>) => {
        const commerce = args[3];
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            finalizeAborted = true;
            resolve();
          };
          commerce.signal.addEventListener('abort', onAbort, { once: true });
          if (commerce.signal.aborted) onAbort();
        });
        await cleanupGate;
        cleanupSettled = true;
        throw new AdminIrlRedeemFinalizeError('deadline-exceeded', 'Timed out.');
      },
    }),
  );
  assert.equal(deadline.response.status, 504);
  assert.equal(deadline.outcome, 'deadline-exceeded');
  assert.equal(finalizeAborted, true);
  assert.equal(deferred.promises.length, 1);
  assert.equal(cleanupSettled, false);
  assert.ok(releaseCleanup);
  releaseCleanup();
  await deferred.drain();
  assert.equal(cleanupSettled, true);
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

test('Admin IRL finalization acquires, rejects, recovers, and clears processing leases', async () => {
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
  const prepared = {
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

  const cleanupContext = commerceContext({ ...prepared, status: 'processing', processingAttemptId: 'attempt' });
  await adminIrlRedeemFinalizeTestHooks.clearProcessing(
    cleanupContext,
    body,
    'attempt',
    new Error('failed'),
  );
  const cleanupDocument = await deliveryReceiptRuntime.readDocument(
    cleanupContext,
    `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
  );
  assert.equal(cleanupDocument?.fields.status, 'prepared');
  assert.equal(cleanupDocument?.fields.processingLeaseExpiresAt, undefined);
});

test('Admin IRL finalization reconciles an applied processing lease whose acknowledgement is lost', async () => {
  let loseAcknowledgement = false;
  const context = commerceContext({
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
  const body = { requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE };
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
  await adminIrlRedeemFinalizeTestHooks.clearProcessing(context, body, 'attempt', new Error('cancelled'));
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
