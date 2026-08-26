import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, firestoreProviderCommerceRequester } from './commerceD1Harness.ts';
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
import { FIRESTORE_DOCUMENT_NAME_PREFIX } from '../src/firestoreRest.ts';
import { deliveryReceiptRuntime } from '../src/deliveryReceipts.ts';
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

function env() {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    COMMERCE_DB: createCommerceD1(),
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
    requestCommerceDocument: firestoreProviderCommerceRequester,
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    providerFetch: async () => { throw new Error('unexpected provider fetch'); },
    nowMs: () => 1_700_000_000_000,
    timeoutMs: 1_000,
    finalize: async () => ({ response: RESPONSE, targetKind: 'pack' as const, outcome: 'completed' }),
    ...overrides,
  };
}

function firestoreContext(
  fields: Record<string, unknown>,
  calls: Array<{ url: string; init?: RequestInit }> = [],
) {
  return {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs: 1_700_000_000_000,
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(':beginTransaction')) return Response.json({ transaction: 'transaction' });
      if (url.includes('/documents/') && init?.method === 'GET') {
        return Response.json({
          name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
          fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, deliveryReceiptRuntime.firestoreValue(value)])),
          updateTime: '2026-08-22T00:00:00.000Z',
        });
      }
      if (url.endsWith(':commit') || url.endsWith(':rollback')) return Response.json({});
      throw new Error(`Unexpected Firestore request: ${url}`);
    },
    signal: new AbortController().signal,
  };
}

test('Admin IRL finalization returns the exact synchronous response and metrics', async () => {
  const deferred: Promise<unknown>[] = [];
  const result = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    (promise) => deferred.push(promise),
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
  assert.deepEqual(deferred, []);
});

test('Admin IRL finalization enforces method, content type, and exact bounded input', async () => {
  const wrongMethod = await handleAdminIrlRedeemFinalize(
    new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_FINALIZE_PATH}`),
    env(),
    () => undefined,
    dependencies(),
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'POST, OPTIONS');

  const wrongType = await handleAdminIrlRedeemFinalize(
    request(undefined, { headers: { 'Content-Type': 'text/plain' } }),
    env(),
    () => undefined,
    dependencies(),
  );
  assert.equal(wrongType.response.status, 400);

  const extra = await handleAdminIrlRedeemFinalize(
    request({ requestId: REQUEST_ID, dropId: DROP_ID, transferSignature: SIGNATURE, extra: true }),
    env(),
    () => undefined,
    dependencies(),
  );
  assert.equal(extra.response.status, 400);

  const oversized = new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_FINALIZE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' },
    body: '{}',
  });
  const tooLarge = await handleAdminIrlRedeemFinalize(oversized, env(), () => undefined, dependencies());
  assert.equal(tooLarge.response.status, 400);
});

test('Admin IRL finalization maps authentication, business, provider, and deadline failures', async () => {
  const unauthenticated = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    () => undefined,
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
    () => undefined,
    dependencies({ verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }) }),
  );
  assert.equal(anonymousOnly.response.status, 401);

  const conflict = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    () => undefined,
    dependencies({
      finalize: async () => { throw new AdminIrlRedeemFinalizeError('aborted', 'Already processing.'); },
    }),
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.outcome, 'aborted');

  const unavailable = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    () => undefined,
    dependencies({
      finalize: async () => { throw new AdminIrlRedeemFinalizeError('unavailable', 'Provider unavailable.'); },
    }),
  );
  assert.equal(unavailable.response.status, 502);
  assert.equal(unavailable.authOutcome, 'provider-failure');

  const sessionStoreUnavailable = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    () => undefined,
    dependencies({ finalize: adminIrlRedeemFinalizeTestHooks.finalizeAdminIrlRedeem }),
  );
  assert.equal(sessionStoreUnavailable.response.status, 502);
  assert.deepEqual(await sessionStoreUnavailable.response.json(), {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Profile data is temporarily unavailable.',
    },
  });

  const deferred: Promise<unknown>[] = [];
  let finalizeAborted = false;
  let cleanupSettled = false;
  let releaseCleanup: (() => void) | undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const deadline = await handleAdminIrlRedeemFinalize(
    request(),
    env(),
    (promise) => deferred.push(promise),
    dependencies({
      timeoutMs: 1,
      finalize: async (...args: Parameters<typeof adminIrlRedeemFinalizeTestHooks.finalizeAdminIrlRedeem>) => {
        const firestore = args[3];
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            finalizeAborted = true;
            resolve();
          };
          firestore.signal.addEventListener('abort', onAbort, { once: true });
          if (firestore.signal.aborted) onAbort();
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
  assert.equal(deferred.length, 1);
  assert.equal(cleanupSettled, false);
  assert.ok(releaseCleanup);
  releaseCleanup();
  await Promise.all(deferred);
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
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const started = await adminIrlRedeemFinalizeTestHooks.startFinalize(
    firestoreContext(prepared, calls),
    body,
    OWNER,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(started.status, 'started');
  const commit = calls.find((call) => call.url.endsWith(':commit'));
  const commitBody = JSON.parse(String(commit?.init?.body)) as {
    writes: Array<{ update: { fields: Record<string, { stringValue?: string; timestampValue?: string }> } }>;
  };
  assert.equal(commitBody.writes[0].update.fields.status.stringValue, 'processing');
  assert.equal(commitBody.writes[0].update.fields.processingAttemptId.stringValue, 'attempt');

  await assert.rejects(() => adminIrlRedeemFinalizeTestHooks.startFinalize(
    firestoreContext({
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
    firestoreContext({
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

  const cleanupCalls: Array<{ url: string; init?: RequestInit }> = [];
  await adminIrlRedeemFinalizeTestHooks.clearProcessing(
    firestoreContext({ ...prepared, status: 'processing', processingAttemptId: 'attempt' }, cleanupCalls),
    body,
    'attempt',
    new Error('failed'),
  );
  const cleanupCommit = cleanupCalls.find((call) => call.url.endsWith(':commit'));
  const cleanupBody = JSON.parse(String(cleanupCommit?.init?.body)) as {
    writes: Array<{ update: { fields: Record<string, { stringValue?: string }> }; updateMask: { fieldPaths: string[] } }>;
  };
  assert.equal(cleanupBody.writes[0].update.fields.status.stringValue, 'prepared');
  assert.equal(cleanupBody.writes[0].updateMask.fieldPaths.includes('processingLeaseExpiresAt'), true);
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
