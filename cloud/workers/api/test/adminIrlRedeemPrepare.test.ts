import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  API_DROPS,
  type ApiDropConfig,
} from '../src/dropConfig.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import {
  ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER,
  ADMIN_IRL_REDEEM_PREPARE_PATH,
  adminIrlRedeemPrepareTestHooks,
  handleAdminIrlRedeemPrepare,
} from '../src/adminIrlRedeemPrepare.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { createDeferredWorkCollector, isDeferredWorkRegistrationError } from './deferredWork.ts';

const OWNER = new PublicKey('8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM');
const ADMIN = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;
const CONFIG = Keypair.generate().publicKey;
const COLLECTION = Keypair.generate().publicKey;
const RECEIPTS_TREE = Keypair.generate().publicKey;
const PACK = Keypair.generate().publicKey;
const RECEIPT = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const HASH = bs58.encode(new Uint8Array(32).fill(7));
const DROP_ID = 'admin_irl_redeem_prepare_test';
const METADATA_BASE = 'https://cdn.lil.org/nft/admin_irl_redeem_prepare_test/json';
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrSt';
const ATTEMPT_ID = '8dc66f5f-0f2d-46aa-85c3-f8744dc46ad5';
const REQUEST_UPDATE_TIME = '2026-08-20T00:00:01.000Z';

const DROP: ApiDropConfig = {
  ...API_DROPS.card_nft_2,
  dropId: DROP_ID,
  dropFamily: 'card_nft_2',
  solanaCluster: 'devnet',
  boxMinterProgramId: PROGRAM.toBase58(),
  boxMinterConfigPda: CONFIG.toBase58(),
  collectionMint: COLLECTION.toBase58(),
  receiptsMerkleTree: RECEIPTS_TREE.toBase58(),
  deliveryLookupTable: '',
  receiptsTreeMaxDepth: undefined,
  receiptsTreeCanopyDepth: undefined,
  metadataBase: METADATA_BASE,
  metadataBaseAliases: undefined,
  receiptPoolId: undefined,
  maxSupply: 100,
  receiptMaxId: 100,
  itemsPerBox: 3,
};

function packAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: PACK.toBase58(),
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    content: {
      json_uri: `${METADATA_BASE}/b7.json`,
      metadata: {
        attributes: [
          { trait_type: 'type', value: 'box' },
          { trait_type: 'box_id', value: '7' },
        ],
      },
    },
    ownership: { owner: OWNER.toBase58() },
    ...overrides,
  };
}

function receiptAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT.toBase58(),
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    content: {
      json_uri: `${METADATA_BASE}/rf9.json`,
      metadata: { attributes: [{ trait_type: 'type', value: 'certificate' }] },
    },
    ownership: { owner: OWNER.toBase58() },
    compression: {
      leaf_id: 4,
      data_hash: HASH,
      creator_hash: HASH,
    },
    ...overrides,
  };
}

function proof(overrides: Record<string, unknown> = {}) {
  return {
    tree_id: RECEIPTS_TREE.toBase58(),
    root: HASH,
    proof: [],
    ...overrides,
  };
}

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_PREPARE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function env(overrides: Record<string, string> = {}) {
  return {
    COMMERCE_DB: createCommerceD1(),
    HELIUS_API_KEY: 'helius-test-key',
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER.toBase58() }),
    getDrop: (dropId: string) => dropId === DROP_ID ? DROP : undefined,
    loadBoundWallet: async () => OWNER.toBase58(),
    loadReceiptMarker: async () => false,
    createRequest: async () => REQUEST_UPDATE_TIME,
    fetchAsset: async () => packAsset(),
    fetchAssetProof: async () => proof(),
    loadOnchainState: async () => ({ admin: ADMIN, coreCollection: COLLECTION }),
    loadPendingOpenAccounts: async (_context: unknown, _runtime: unknown, assets: PublicKey[]) => assets.map(() => false),
    loadLatestBlockhash: async () => BLOCKHASH,
    loadLookupTable: async () => [],
    autoId: () => REQUEST_ID,
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

test('Admin IRL preparation returns the exact unsigned pack transfer and request input', async () => {
  let created: Record<string, unknown> | undefined;
  const operations: string[] = [];
  const result = await handleAdminIrlRedeemPrepare(
    request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] }, {
      [ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER]: ATTEMPT_ID,
    }),
    env(),
    dependencies({
      createRequest: async (_context: unknown, input: Record<string, unknown>) => {
        operations.push('create');
        created = input;
        return REQUEST_UPDATE_TIME;
      },
      loadPendingOpenAccounts: async () => {
        operations.push('pending');
        return [false];
      },
      loadLatestBlockhash: async () => {
        operations.push('blockhash');
        return BLOCKHASH;
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.targetKind, 'pack');
  assert.equal(result.itemCount, 1);
  const payload = await result.response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    'adminWallet',
    'dropId',
    'encodedTx',
    'itemCount',
    'requestId',
    'targetKind',
  ]);
  assert.equal(payload.requestId, REQUEST_ID);
  assert.equal(payload.adminWallet, ADMIN.toBase58());
  assert.equal(payload.targetKind, 'pack');
  assert.deepEqual(operations, ['pending', 'blockhash', 'create']);
  assert.deepEqual(created, {
    requestId: REQUEST_ID,
    dropId: DROP_ID,
    owner: OWNER.toBase58(),
    targetKind: 'pack',
    adminWallet: ADMIN.toBase58(),
    itemIds: [PACK.toBase58()],
    items: [{ assetId: PACK.toBase58(), kind: 'box', refId: 7 }],
    prepareAttemptId: ATTEMPT_ID,
  });

  const transaction = VersionedTransaction.deserialize(Buffer.from(String(payload.encodedTx), 'base64'));
  const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  assert.deepEqual(signers.map((key) => key.toBase58()), [OWNER.toBase58()]);
  assert.equal(transaction.signatures[0].every((byte) => byte === 0), true);
  const programs = transaction.message.compiledInstructions.map((instruction) =>
    transaction.message.staticAccountKeys[instruction.programIdIndex].toBase58());
  assert.equal(programs.includes(MPL_CORE_PROGRAM_ADDRESS), true);
});

test('Admin IRL preparation supports one card receipt and checks its marker and proof', async () => {
  let markerAsset = '';
  const operations: string[] = [];
  const result = await handleAdminIrlRedeemPrepare(
    request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [RECEIPT.toBase58()] }),
    env(),
    dependencies({
      fetchAsset: async () => receiptAsset(),
      fetchAssetProof: async () => {
        operations.push('proof');
        return proof();
      },
      loadReceiptMarker: async (_context: unknown, _dropId: string, assetId: string) => {
        operations.push('marker');
        markerAsset = assetId;
        return false;
      },
      loadLatestBlockhash: async () => {
        operations.push('blockhash');
        return BLOCKHASH;
      },
      createRequest: async () => {
        operations.push('create');
        return REQUEST_UPDATE_TIME;
      },
    }),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as Record<string, unknown>;
  assert.equal(payload.targetKind, 'card_receipt');
  assert.equal(markerAsset, RECEIPT.toBase58());
  assert.deepEqual(operations, ['marker', 'proof', 'blockhash', 'create']);
  const transaction = VersionedTransaction.deserialize(Buffer.from(String(payload.encodedTx), 'base64'));
  const programs = transaction.message.compiledInstructions.map((instruction) =>
    transaction.message.staticAccountKeys[instruction.programIdIndex].toBase58());
  assert.equal(programs.includes(BUBBLEGUM_PROGRAM_ADDRESS), true);
});

test('Admin IRL preparation enforces exact requests, methods, authentication, and sessions', async () => {
  const body = { owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] };
  const wrongMethod = await handleAdminIrlRedeemPrepare(
    new Request(`https://api.mons.shop${ADMIN_IRL_REDEEM_PREPARE_PATH}`),
    env(),
    dependencies(),
  );
  assert.equal(wrongMethod.response.status, 405);

  const extra = await handleAdminIrlRedeemPrepare(request({ ...body, extra: true }), env(), dependencies());
  assert.equal(extra.response.status, 400);

  const duplicate = await handleAdminIrlRedeemPrepare(
    request({ ...body, itemIds: [PACK.toBase58(), PACK.toBase58()] }),
    env(),
    dependencies(),
  );
  assert.equal(duplicate.response.status, 400);

  const unauthenticated = await handleAdminIrlRedeemPrepare(request(body), env(), dependencies({
    verifyIdentity: async () => {
      throw new RequestIdentityError('invalid-token');
    },
  }));
  assert.equal(unauthenticated.response.status, 401);

  const anonymousOnly = await handleAdminIrlRedeemPrepare(request(body), env(), dependencies({
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-uid' }),
  }));
  assert.equal(anonymousOnly.response.status, 401);

  const wrongOwner = await handleAdminIrlRedeemPrepare(request(body), env(), dependencies({
    loadBoundWallet: async () => ADMIN.toBase58(),
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN.toBase58() }),
  }));
  assert.equal(wrongOwner.response.status, 403);
});

test('Admin IRL preparation rejects ownership, pending-open, marker, and proof failures', async () => {
  const packBody = { owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] };
  const wrongOwner = await handleAdminIrlRedeemPrepare(request(packBody), env(), dependencies({
    fetchAsset: async () => packAsset({ ownership: { owner: ADMIN.toBase58() } }),
  }));
  assert.equal(wrongOwner.response.status, 409);

  const pending = await handleAdminIrlRedeemPrepare(request(packBody), env(), dependencies({
    loadPendingOpenAccounts: async () => [true],
  }));
  assert.equal(pending.response.status, 409);

  const receiptBody = { owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [RECEIPT.toBase58()] };
  const marker = await handleAdminIrlRedeemPrepare(request(receiptBody), env(), dependencies({
    fetchAsset: async () => receiptAsset(),
    loadReceiptMarker: async () => true,
  }));
  assert.equal(marker.response.status, 409);

  const wrongTree = await handleAdminIrlRedeemPrepare(request(receiptBody), env(), dependencies({
    fetchAsset: async () => receiptAsset(),
    fetchAssetProof: async () => proof({ tree_id: PROGRAM.toBase58() }),
  }));
  assert.equal(wrongTree.response.status, 409);
});

test('Admin IRL preparation surfaces provider deadlines and conditional-create conflicts', async () => {
  const body = { owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] };
  const timeout = await handleAdminIrlRedeemPrepare(request(body), env(), dependencies({
    timeoutMs: 5,
    loadOnchainState: async (context: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    }),
  }));
  assert.equal(timeout.response.status, 504);

  const collisionHarness = createCommerceD1Harness();
  const collisionRepository = new D1CommerceRepository(collisionHarness.db);
  await collisionRepository.run(1_699_999_999_999, async (unit) => unit.create(
    commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID),
    { status: 'prepared' },
  ));
  await assert.rejects(
    adminIrlRedeemPrepareTestHooks.createRequest({
      nowMs: 1_700_000_000_000,
      repository: collisionRepository,
      signal: new AbortController().signal,
    }, {
      adminWallet: ADMIN.toBase58(),
      dropId: DROP_ID,
      itemIds: [PACK.toBase58()],
      items: [{ assetId: PACK.toBase58(), kind: 'box', refId: 7 }],
      owner: OWNER.toBase58(),
      requestId: REQUEST_ID,
      targetKind: 'pack',
    }),
    (error) => (error as { code?: unknown }).code === 'aborted',
  );
});

test('Admin IRL preparation cleans up an in-flight request write that lands after its deadline', async () => {
  const deferred = createDeferredWorkCollector();
  let finishWrite!: (updateTime: string) => void;
  let cleanup: { path: string; signalAborted: boolean; updateTime: string } | undefined;
  const write = new Promise<string>((resolve) => { finishWrite = resolve; });
  const result = await handleAdminIrlRedeemPrepare(
    request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] }),
    env(),
    dependencies({
      createRequest: () => write,
      defer: deferred.defer,
      deleteRequest: async (context: { signal: AbortSignal }, path: string, updateTime: string) => {
        cleanup = { path, signalAborted: context.signal.aborted, updateTime };
      },
      timeoutMs: 5,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal(deferred.promises.length, 1);
  finishWrite(REQUEST_UPDATE_TIME);
  await deferred.drain();
  assert.deepEqual(cleanup, {
    path: `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
    signalAborted: false,
    updateTime: REQUEST_UPDATE_TIME,
  });
});

test('Admin IRL preparation cleans up an in-flight request write after client cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected during Admin IRL request creation');
  const deferred = createDeferredWorkCollector();
  let finishWrite!: (updateTime: string) => void;
  let markStarted!: () => void;
  let cleanup: { path: string; signalAborted: boolean; updateTime: string } | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const write = new Promise<string>((resolve) => { finishWrite = resolve; });
  const pending = handleAdminIrlRedeemPrepare(
    new Request(request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] }), {
      signal: controller.signal,
    }),
    env(),
    dependencies({
      createRequest: () => {
        markStarted();
        return write;
      },
      defer: deferred.defer,
      deleteRequest: async (context: { signal: AbortSignal }, path: string, updateTime: string) => {
        cleanup = { path, signalAborted: context.signal.aborted, updateTime };
      },
    }),
  );

  await started;
  controller.abort(reason);
  finishWrite(REQUEST_UPDATE_TIME);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(deferred.promises.length, 0);
  assert.deepEqual(cleanup, {
    path: `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
    signalAborted: false,
    updateTime: REQUEST_UPDATE_TIME,
  });
});

test('Admin IRL preparation propagates late-write deferred registration failures', async () => {
  const cause = new Error('waitUntil rejected Admin IRL request cleanup');
  await assert.rejects(
    handleAdminIrlRedeemPrepare(
      request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] }),
      env(),
      dependencies({
        createRequest: () => new Promise<string>(() => undefined),
        defer: () => { throw cause; },
        timeoutMs: 5,
      }),
    ),
    (error) => isDeferredWorkRegistrationError(error, cause),
  );
});

test('Admin IRL preparation does not start its request write after the deadline', async () => {
  let createCalled = false;
  const result = await handleAdminIrlRedeemPrepare(
    request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [PACK.toBase58()] }),
    env(),
    dependencies({
      createRequest: async () => {
        createCalled = true;
        return REQUEST_UPDATE_TIME;
      },
      loadLatestBlockhash: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return BLOCKHASH;
      },
      timeoutMs: 1,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal(createCalled, false);
});

test('Admin IRL preparation bounds a non-cooperative receipt-marker read', async () => {
  const result = await handleAdminIrlRedeemPrepare(
    request({ owner: OWNER.toBase58(), dropId: DROP_ID, itemIds: [RECEIPT.toBase58()] }),
    env(),
    dependencies({
      fetchAsset: async () => receiptAsset(),
      loadReceiptMarker: () => new Promise<boolean>(() => undefined),
      timeoutMs: 5,
    }),
  );
  assert.equal(result.response.status, 504);
});

test('Admin IRL repository conditionally creates the exact prepared request schema', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const updateTime = await adminIrlRedeemPrepareTestHooks.createRequest({
    nowMs: 1_700_000_000_000,
    repository,
    signal: new AbortController().signal,
  }, {
    adminWallet: ADMIN.toBase58(),
    dropId: DROP_ID,
    itemIds: [PACK.toBase58()],
    items: [{ assetId: PACK.toBase58(), kind: 'box', refId: 7 }],
    owner: OWNER.toBase58(),
    prepareAttemptId: ATTEMPT_ID,
    requestId: REQUEST_ID,
    targetKind: 'pack',
  });
  assert.equal(Date.parse(updateTime), 1_700_000_000_000);
  const record = await repository.get(commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID));
  assert.deepEqual(record?.data, {
    dropId: DROP_ID,
    status: 'prepared',
    owner: OWNER.toBase58(),
    targetKind: 'pack',
    adminWallet: ADMIN.toBase58(),
    itemIds: [PACK.toBase58()],
    items: [{ assetId: PACK.toBase58(), kind: 'box', refId: 7 }],
    preparedExpiresAt: 1_700_604_800_000,
    prepareAttemptId: ATTEMPT_ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
});

test('Admin IRL repository reconciles a prepared request whose commit acknowledgement is lost', async () => {
  let loseAcknowledgement = true;
  const harness = createCommerceD1Harness({
    observeBatchAfterCommit: ({ statements }) => {
      if (
        loseAcknowledgement &&
        statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))
      ) {
        loseAcknowledgement = false;
        throw new TypeError('prepared request commit acknowledgement lost');
      }
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  const updateTime = await adminIrlRedeemPrepareTestHooks.createRequest({
    nowMs: 1_700_000_000_000,
    repository,
    signal: new AbortController().signal,
  }, {
    adminWallet: ADMIN.toBase58(),
    dropId: DROP_ID,
    itemIds: [PACK.toBase58()],
    items: [{ assetId: PACK.toBase58(), kind: 'box', refId: 7 }],
    owner: OWNER.toBase58(),
    prepareAttemptId: ATTEMPT_ID,
    requestId: REQUEST_ID,
    targetKind: 'pack',
  });

  assert.equal(Date.parse(updateTime), 1_700_000_000_000);
  assert.equal(loseAcknowledgement, false);
  assert.ok(await repository.get(commerceKeys.adminIrlRedeemRequest(DROP_ID, REQUEST_ID)));
});

test('Admin IRL provider retries one transient response and bounds provider JSON', async () => {
  const runtime = adminIrlRedeemPrepareTestHooks.buildRuntime(DROP);
  let calls = 0;
  const result = await adminIrlRedeemPrepareTestHooks.rpcCall({
    apiKey: 'helius-test-key',
    attemptTimeoutMs: 1000,
    providerFetch: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { id: string };
      return calls === 1
        ? new Response(null, { status: 503 })
        : Response.json({ jsonrpc: '2.0', id: body.id, result: { value: 7 } });
    },
    signal: new AbortController().signal,
  }, runtime, 'testMethod', []);
  assert.deepEqual(result, { value: 7 });
  assert.equal(calls, 2);

  await assert.rejects(
    adminIrlRedeemPrepareTestHooks.rpcCall({
      apiKey: 'helius-test-key',
      attemptTimeoutMs: 1000,
      providerFetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: string };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'x'.repeat(3_000_000) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
      signal: new AbortController().signal,
    }, runtime, 'testMethod', []),
    (error) => (error as { code?: unknown }).code === 'unavailable',
  );
});

test('Admin IRL provider preserves abort-first and provider-first outcomes', async () => {
  const runtime = adminIrlRedeemPrepareTestHooks.buildRuntime(DROP);
  const cancellation = new AbortController();
  const reason = new Error('client disconnected');
  await assert.rejects(
    adminIrlRedeemPrepareTestHooks.rpcCall({
      apiKey: 'helius-test-key',
      attemptTimeoutMs: 1000,
      providerFetch: async () => {
        cancellation.abort(reason);
        throw new Error('provider failed after cancellation');
      },
      signal: cancellation.signal,
    }, runtime, 'testMethod', []),
    (error: unknown) => error === reason,
  );

  const race = new AbortController();
  const providerError = new Error('provider failed first');
  let rejectProvider!: (error: unknown) => void;
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  const providerFirst = assert.rejects(
    adminIrlRedeemPrepareTestHooks.rpcCall({
      apiKey: 'helius-test-key',
      attemptTimeoutMs: 1000,
      providerFetch: () => new Promise((_resolve, reject) => {
        rejectProvider = reject;
        markProviderStarted();
      }),
      signal: race.signal,
    }, runtime, 'testMethod', []),
    (error: unknown) => error !== race.signal.reason &&
      (error as { code?: unknown }).code === 'unavailable',
  );
  await providerStarted;
  rejectProvider(providerError);
  queueMicrotask(() => race.abort(new Error('late client disconnect')));
  await providerFirst;
});

test('Admin IRL card lookup fallback preserves cancellation', async () => {
  const lookupKey = Keypair.generate().publicKey;
  const runtime = adminIrlRedeemPrepareTestHooks.buildRuntime({
    ...DROP,
    deliveryLookupTable: lookupKey.toBase58(),
  });
  const controller = new AbortController();
  const reason = new Error('client disconnected during lookup');
  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys: Array.from({ length: 40 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    })),
    data: Buffer.from([1]),
  });

  await assert.rejects(
    adminIrlRedeemPrepareTestHooks.serializeCardTransaction({
      context: {
        apiKey: 'helius-test-key',
        providerFetch: async () => {
          throw new Error('unexpected provider fetch');
        },
        signal: controller.signal,
      },
      runtime,
      owner: OWNER,
      blockhash: BLOCKHASH,
      instruction,
      loadLookupTable: async () => {
        controller.abort(reason);
        throw new Error('lookup aborted', { cause: reason });
      },
    }),
    (error: unknown) => error === reason,
  );
});

test('Admin IRL pack serialization rejects transactions above the Solana packet limit', () => {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...Array.from({ length: 32 }, () => adminIrlRedeemPrepareTestHooks.coreTransferInstruction({
      asset: Keypair.generate().publicKey,
      coreCollection: COLLECTION,
      owner: OWNER,
      admin: ADMIN,
    })),
  ];
  assert.throws(
    () => adminIrlRedeemPrepareTestHooks.serializePackTransaction(instructions, OWNER, BLOCKHASH),
    /too large/,
  );
});

test('Admin IRL helpers generate compatible ids and reject unsupported drop families', () => {
  for (let index = 0; index < 20; index += 1) {
    assert.match(adminIrlRedeemPrepareTestHooks.commerceAutoId(), /^[A-Za-z0-9]{20}$/);
  }
  const unsupported = {
    ...DROP,
    dropId: 'admin_irl_unsupported',
    dropFamily: 'clear_cards',
  } as ApiDropConfig;
  assert.throws(
    () => adminIrlRedeemPrepareTestHooks.assertSupportedRuntime(
      adminIrlRedeemPrepareTestHooks.buildRuntime(unsupported),
    ),
    /only available for card_nft_2 packs/,
  );
});
