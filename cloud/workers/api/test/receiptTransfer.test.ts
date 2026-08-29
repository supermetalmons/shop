import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  API_DROPS,
  type ApiDropConfig,
} from '../src/dropConfig.ts';
import { BUBBLEGUM_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION } from '../src/receiptTransferRateLimit.ts';
import {
  handleReceiptTransferPrepare,
  RECEIPT_TRANSFER_PREPARE_PATH,
  receiptTransferTestHooks,
} from '../src/receiptTransfer.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';

const OWNER = Keypair.generate().publicKey;
const DESTINATION = Keypair.generate().publicKey;
const COLLECTION = Keypair.generate().publicKey;
const RECEIPTS_TREE = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;
const CONFIG = Keypair.generate().publicKey;
const CERTIFICATE = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const HASH = bs58.encode(new Uint8Array(32).fill(7));
const DROP_ID = 'receipt_transfer_test';
const METADATA_BASE = 'https://cdn.lil.org/nft/receipt_transfer_test/json';

function testPublicKey(index: number): PublicKey {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, index + 1);
  return new PublicKey(bytes);
}

const baseDrop = Object.values(API_DROPS).find((drop) => drop.itemsPerBox > 0)!;
const DROP: ApiDropConfig = {
  ...baseDrop,
  dropId: DROP_ID,
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
  receiptPoolId: 'receipt_transfer_test',
  maxSupply: 100,
  receiptMaxId: 100,
  itemsPerBox: 3,
};

function receiptAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: CERTIFICATE.toBase58(),
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    content: {
      json_uri: `${METADATA_BASE}/rb7.json`,
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

function unusedOpsDb(): D1Database {
  const database = {} as D1Database;
  database.prepare = () => {
    throw new Error('unexpected OPS_DB prepare');
  };
  database.batch = async () => {
    throw new Error('unexpected OPS_DB batch');
  };
  return database;
}

function env(overrides: Partial<Pick<Env, 'HELIUS_API_KEY' | 'OPS_DB'>> = {}) {
  return {
    HELIUS_API_KEY: 'helius-test-key',
    OPS_DB: unusedOpsDb(),
    ...overrides,
  };
}

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`https://api.mons.shop${RECEIPT_TRANSFER_PREPARE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function requestBody() {
  return {
    owner: OWNER.toBase58(),
    dropId: DROP_ID,
    receiptAssetId: CERTIFICATE.toBase58(),
    destination: DESTINATION.toBase58(),
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-uid' }),
    getDrop: (dropId: string) => dropId === DROP_ID ? DROP : undefined,
    enforceRateLimit: async () => undefined,
    fetchAsset: async () => receiptAsset(),
    fetchAssetProof: async () => proof(),
    loadOnchainState: async () => ({ coreCollection: COLLECTION }),
    loadLatestBlockhash: async () => BLOCKHASH,
    loadLookupTable: async () => [],
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

test('receipt transfer handler returns the exact unsigned owner transaction', async () => {
  const scopes: string[] = [];
  const result = await handleReceiptTransferPrepare(
    request(requestBody()),
    env(),
    dependencies({
      enforceRateLimit: async (_context: unknown, bucket: { scope: string }) => {
        scopes.push(bucket.scope);
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP_ID);
  assert.deepEqual(scopes, ['caller', 'asset']);
  const payload = await result.response.json() as {
    encodedTx: string;
    dropId: string;
    certificateId: string;
  };
  assert.deepEqual(payload, {
    encodedTx: payload.encodedTx,
    dropId: DROP_ID,
    certificateId: CERTIFICATE.toBase58(),
  });
  const raw = Buffer.from(payload.encodedTx, 'base64');
  assert.ok(raw.length <= 1232);
  const transaction = VersionedTransaction.deserialize(raw);
  const signerKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  assert.deepEqual(signerKeys.map((key) => key.toBase58()), [OWNER.toBase58()]);
  assert.equal(transaction.signatures[0].every((byte) => byte === 0), true);
  const programs = transaction.message.compiledInstructions.map((instruction) =>
    transaction.message.staticAccountKeys[instruction.programIdIndex].toBase58());
  assert.equal(programs[1], BUBBLEGUM_PROGRAM_ADDRESS);
});

test('receipt transfer runtime accepts every deployed drop configuration', () => {
  for (const drop of Object.values(API_DROPS)) {
    assert.doesNotThrow(() => receiptTransferTestHooks.buildRuntime(drop), drop.dropId);
  }
});

test('receipt transfer handler enforces exact bounded requests and methods', async () => {
  const wrongMethod = await handleReceiptTransferPrepare(
    new Request(`https://api.mons.shop${RECEIPT_TRANSFER_PREPARE_PATH}`),
    env(),
    dependencies(),
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'POST, OPTIONS');

  for (const invalid of [
    new Request(`https://api.mons.shop${RECEIPT_TRANSFER_PREPARE_PATH}`, { method: 'POST', body: '{}' }),
    request({ ...requestBody(), extra: true }),
    request({ ...requestBody(), destination: OWNER.toBase58() }),
    request({ ...requestBody(), destination: PublicKey.default.toBase58() }),
    request({ ...requestBody(), receiptAssetId: 'invalid' }),
  ]) {
    const result = await handleReceiptTransferPrepare(invalid, env(), dependencies());
    assert.equal(result.response.status, 400);
    assert.equal(result.authOutcome, 'rejected');
  }
});

test('receipt transfer handler rejects invalid authentication and missing configuration', async () => {
  const unauthenticated = await handleReceiptTransferPrepare(
    request(requestBody()),
    env(),
    dependencies({
      verifyIdentity: async () => {
        throw new RequestIdentityError('invalid-token');
      },
    }),
  );
  assert.equal(unauthenticated.response.status, 401);
  assert.equal((await unauthenticated.response.json() as { error: { code: string } }).error.code, 'unauthenticated');

  const unavailable = await handleReceiptTransferPrepare(
    request(requestBody()),
    env({ HELIUS_API_KEY: '' }),
    dependencies(),
  );
  assert.equal(unavailable.response.status, 502);
  assert.equal(unavailable.authOutcome, 'provider-failure');
});

test('receipt transfer handler keeps the overall deadline authoritative', async () => {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  const stalledBody = await handleReceiptTransferPrepare(
    new Request(`https://api.mons.shop${RECEIPT_TRANSFER_PREPARE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
    env(),
    dependencies({ timeoutMs: 5 }),
  );
  assert.equal(stalledBody.response.status, 504);

  const stalledRateLimit = await handleReceiptTransferPrepare(
    request(requestBody()),
    env(),
    dependencies({
      timeoutMs: 5,
      enforceRateLimit: async (context: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(new RequestIdentityError('provider-unavailable'));
          context.signal.addEventListener('abort', fail, { once: true });
          if (context.signal.aborted) fail();
        }),
    }),
  );
  assert.equal(stalledRateLimit.response.status, 504);
  assert.equal((await stalledRateLimit.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('receipt transfer returns its deadline and retains only the started rate-limit write', async () => {
  const deferred = createDeferredWorkCollector();
  let finishWrite!: () => void;
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  let calls = 0;
  const result = await handleReceiptTransferPrepare(
    request(requestBody()),
    env(),
    dependencies({
      defer: deferred.defer,
      enforceRateLimit: () => {
        calls += 1;
        return write;
      },
      timeoutMs: 5,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal(calls, 1);
  assert.equal(deferred.promises.length, 1);
  finishWrite();
  await deferred.drain();
});

test('receipt transfer does not start its asset rate-limit write after the deadline', async () => {
  let calls = 0;
  const result = await handleReceiptTransferPrepare(
    request(requestBody()),
    env(),
    dependencies({
      enforceRateLimit: async () => { calls += 1; },
      fetchAsset: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return receiptAsset();
      },
      timeoutMs: 1,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal(calls, 1);
});

test('receipt transfer handler preserves asset, owner, metadata, and proof rejection boundaries', async () => {
  for (const [overrides, expectedMessage] of [
    [{ fetchAsset: async () => receiptAsset({ burnt: true }) }, 'no longer transferable'],
    [{ fetchAsset: async () => receiptAsset({ content: { metadata: { attributes: [{ trait_type: 'type', value: 'box' }] } } }) }, 'not a receipt'],
    [{ fetchAsset: async () => receiptAsset({ ownership: { owner: DESTINATION.toBase58() } }) }, 'not owned'],
    [{ fetchAsset: async () => receiptAsset({ grouping: [{ group_key: 'collection', group_value: DESTINATION.toBase58() }] }) }, 'requested drop'],
    [{ fetchAssetProof: async () => proof({ tree_id: DESTINATION.toBase58() }) }, 'receipts tree'],
  ] as const) {
    const result = await handleReceiptTransferPrepare(
      request(requestBody()),
      env(),
      dependencies(overrides),
    );
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { message: string } };
    assert.match(payload.error.message, new RegExp(expectedMessage, 'i'));
  }
});

test('receipt transfer provider adapter retries transient JSON-RPC reads and bounds responses', async () => {
  const runtime = receiptTransferTestHooks.buildRuntime(DROP);
  let calls = 0;
  const blockhash = await receiptTransferTestHooks.loadLatestBlockhash({
    apiKey: 'helius-key',
    signal: new AbortController().signal,
    providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
      const body = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { value: { blockhash: BLOCKHASH } } });
    },
  }, runtime);
  assert.equal(blockhash, BLOCKHASH);
  assert.equal(calls, 2);

  await assert.rejects(
    () => receiptTransferTestHooks.rpcCall({
      apiKey: 'helius-key',
      signal: new AbortController().signal,
      providerFetch: async () => new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(8 * 1024 * 1024 + 1),
        },
      }),
    }, runtime, 'getLatestBlockhash', []),
    (error) => (error as { code?: unknown }).code === 'unavailable',
  );
});

test('receipt transfer provider preserves abort-first and provider-first outcomes', async () => {
  const runtime = receiptTransferTestHooks.buildRuntime(DROP);
  const cancellation = new AbortController();
  const reason = new Error('client disconnected');
  await assert.rejects(
    receiptTransferTestHooks.rpcCall({
      apiKey: 'helius-key',
      providerFetch: async () => {
        cancellation.abort(reason);
        throw new Error('provider failed after cancellation');
      },
      signal: cancellation.signal,
    }, runtime, 'getLatestBlockhash', []),
    (error: unknown) => error === reason,
  );

  const race = new AbortController();
  const providerError = new Error('provider failed first');
  let rejectProvider!: (error: unknown) => void;
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  const providerFirst = assert.rejects(
    receiptTransferTestHooks.rpcCall({
      apiKey: 'helius-key',
      providerFetch: () => new Promise((_resolve, reject) => {
        rejectProvider = reject;
        markProviderStarted();
      }),
      signal: race.signal,
    }, runtime, 'getLatestBlockhash', []),
    (error: unknown) => error !== race.signal.reason &&
      (error as { code?: unknown }).code === 'unavailable',
  );
  await providerStarted;
  rejectProvider(providerError);
  queueMicrotask(() => race.abort(new Error('late client disconnect')));
  await providerFirst;
});

test('receipt transfer D1 limiter maps atomic batch admissions and denials', async () => {
  const subjectHash = 'a'.repeat(64);
  const nowMs = 1_700_000_000_000;
  const row = {
    scope: 'caller',
    subject_hash: subjectHash,
    schema_version: RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION,
    cluster: null,
    owner_wallet: null,
    receipt_asset_id: null,
    window_started_at_ms: nowMs,
    expires_at_ms: nowMs + 600_000,
    request_count: 1,
  };
  const batches = [
    [[row], [row]],
    [[], [row]],
  ];
  const prepared = new WeakMap<D1PreparedStatement, { query: string; values: unknown[] }>();
  const batchCalls: Array<Array<{ query: string; values: unknown[] }>> = [];
  const database = {} as D1Database;
  database.prepare = (query) => {
    const statement = {} as D1PreparedStatement;
    prepared.set(statement, { query, values: [] });
    statement.bind = (...values) => {
      prepared.set(statement, { query, values });
      return statement;
    };
    return statement;
  };
  database.batch = (async <T>(statements: D1PreparedStatement[]) => {
    batchCalls.push(statements.map((statement) => prepared.get(statement)!));
    const results = batches.shift();
    if (!results) throw new Error('unexpected D1 batch');
    return results.map((rows) => ({ success: true, meta: {}, results: rows as T[] }));
  }) as D1Database['batch'];
  const context = {
    database,
    nowMs,
    signal: new AbortController().signal,
  };
  const bucket = {
    scope: 'caller' as const,
    subjectHash,
    limit: 1,
  };
  await receiptTransferTestHooks.enforceRateLimit(context, bucket);
  await assert.rejects(
    () => receiptTransferTestHooks.enforceRateLimit(context, bucket),
    (error) => {
      assert.equal((error as { code?: unknown }).code, 'resource-exhausted');
      assert.deepEqual((error as { details?: unknown }).details, { retryAfterMs: 600_000 });
      return true;
    },
  );
  assert.equal(batchCalls.length, 2);
  assert.equal(batchCalls.every((call) => call.length === 2), true);
  assert.match(batchCalls[0][0].query, /ON CONFLICT\(scope, subject_hash\).*RETURNING/s);
  assert.match(batchCalls[0][1].query, /SELECT[\s\S]*FROM rate_limit_buckets/);
  assert.doesNotMatch(JSON.stringify(batchCalls), /auth-uid/);
});

test('receipt transfer D1 limiter fails closed without retrying ambiguous writes', async () => {
  let batches = 0;
  const database = {} as D1Database;
  database.prepare = () => {
    const statement = {} as D1PreparedStatement;
    statement.bind = () => statement;
    return statement;
  };
  database.batch = async () => {
    batches += 1;
    throw new Error('D1 write outcome is unknown');
  };
  const context = {
    database,
    nowMs: 1_700_000_000_000,
    signal: new AbortController().signal,
  };
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      () => receiptTransferTestHooks.enforceRateLimit(context, {
        scope: 'caller',
        subjectHash: 'b'.repeat(64),
        limit: 2,
      }),
      (error) => (error as { code?: unknown }).code === 'unavailable',
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(batches, 1);
});

test('receipt transfer transaction builder uses a lookup table for oversized packets', async () => {
  const lookupKey = Keypair.generate().publicKey;
  const addresses = Array.from({ length: 40 }, (_, index) => testPublicKey(index + 100));
  const runtime = receiptTransferTestHooks.buildRuntime({ ...DROP, deliveryLookupTable: lookupKey.toBase58() });
  const lookup = new AddressLookupTableAccount({
    key: lookupKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: OWNER, isSigner: true, isWritable: true },
      ...addresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from([1]),
  });
  let lookupLoads = 0;
  const raw = await receiptTransferTestHooks.buildPreparedTransaction({
    context: {
      apiKey: 'helius-key',
      signal: new AbortController().signal,
      providerFetch: async () => {
        throw new Error('unexpected provider fetch');
      },
    },
    runtime,
    instruction,
    owner: OWNER,
    blockhash: BLOCKHASH,
    loadLookupTable: async () => {
      lookupLoads += 1;
      return [lookup];
    },
  });
  assert.equal(lookupLoads, 1);
  assert.ok(raw.length <= 1232);
  assert.equal(VersionedTransaction.deserialize(raw).message.addressTableLookups.length, 1);
});

test('receipt transfer lookup fallback preserves cancellation', async () => {
  const lookupKey = Keypair.generate().publicKey;
  const addresses = Array.from({ length: 40 }, (_, index) => testPublicKey(index + 200));
  const runtime = receiptTransferTestHooks.buildRuntime({ ...DROP, deliveryLookupTable: lookupKey.toBase58() });
  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: OWNER, isSigner: true, isWritable: true },
      ...addresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from([1]),
  });
  const controller = new AbortController();
  const reason = new Error('client disconnected during lookup');

  await assert.rejects(
    receiptTransferTestHooks.buildPreparedTransaction({
      context: {
        apiKey: 'helius-key',
        signal: controller.signal,
        providerFetch: async () => {
          throw new Error('unexpected provider fetch');
        },
      },
      runtime,
      instruction,
      owner: OWNER,
      blockhash: BLOCKHASH,
      loadLookupTable: async () => {
        controller.abort(reason);
        throw new Error('lookup aborted', { cause: reason });
      },
    }),
    (error: unknown) => error === reason,
  );
});
