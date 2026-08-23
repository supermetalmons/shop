import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
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
import { FirebaseIdTokenError } from '../src/firebaseIdToken.ts';
import {
  ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER,
  ADMIN_IRL_REDEEM_PREPARE_PATH,
  adminIrlRedeemPrepareTestHooks,
  handleAdminIrlRedeemPrepare,
} from '../src/adminIrlRedeemPrepare.ts';

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
      Authorization: 'Bearer firebase-token',
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function env(overrides: Record<string, string> = {}) {
  return {
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '{"credential":"test"}',
    HELIUS_API_KEY: 'helius-test-key',
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdToken: async () => ({ uid: 'firebase-uid' }),
    getDrop: (dropId: string) => dropId === DROP_ID ? DROP : undefined,
    loadWalletSession: async () => OWNER.toBase58(),
    loadReceiptMarker: async () => false,
    createRequest: async () => undefined,
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
    verifyIdToken: async () => {
      throw new FirebaseIdTokenError('invalid-token');
    },
  }));
  assert.equal(unauthenticated.response.status, 401);

  const wrongOwner = await handleAdminIrlRedeemPrepare(request(body), env(), dependencies({
    loadWalletSession: async () => ADMIN.toBase58(),
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

  await assert.rejects(
    adminIrlRedeemPrepareTestHooks.createRequest({
      accessTokenProvider: {
        get: async () => 'token',
        invalidate: () => undefined,
      },
      nowMs: 1_700_000_000_000,
      providerFetch: async () => Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 }),
      serviceAccountJson: '{"credential":"test"}',
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

test('Admin IRL Firestore adapter conditionally creates the exact prepared request schema', async () => {
  let commit: Record<string, unknown> | undefined;
  await adminIrlRedeemPrepareTestHooks.createRequest({
    accessTokenProvider: {
      get: async () => 'token',
      invalidate: () => undefined,
    },
    nowMs: 1_700_000_000_000,
    providerFetch: async (input, init) => {
      assert.match(String(input), /documents:commit$/);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
      commit = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ writeResults: [{ updateTime: '2026-08-21T00:00:00.000Z' }] });
    },
    serviceAccountJson: '{"credential":"test"}',
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
  const writes = commit?.writes;
  assert.ok(Array.isArray(writes));
  const write = writes[0] as Record<string, unknown>;
  assert.deepEqual(write.currentDocument, { exists: false });
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
  const update = write.update as { name: string; fields: Record<string, unknown> };
  assert.match(update.name, new RegExp(`drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}$`));
  assert.deepEqual(update.fields, {
    dropId: { stringValue: DROP_ID },
    status: { stringValue: 'prepared' },
    owner: { stringValue: OWNER.toBase58() },
    targetKind: { stringValue: 'pack' },
    adminWallet: { stringValue: ADMIN.toBase58() },
    itemIds: { arrayValue: { values: [{ stringValue: PACK.toBase58() }] } },
    items: { arrayValue: { values: [{ mapValue: { fields: {
      assetId: { stringValue: PACK.toBase58() },
      kind: { stringValue: 'box' },
      refId: { integerValue: '7' },
    } } }] } },
    preparedExpiresAt: { timestampValue: '2023-11-21T22:13:20.000Z' },
    prepareAttemptId: { stringValue: ATTEMPT_ID },
  });
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
    assert.match(adminIrlRedeemPrepareTestHooks.firestoreAutoId(), /^[A-Za-z0-9]{20}$/);
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
