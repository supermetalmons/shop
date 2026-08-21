import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../../../functions/src/shared/pendingOpenCodec.ts';
import { FirebaseIdTokenError } from '../src/firebaseIdToken.ts';
import {
  REVEAL_DUDES_PATH,
  RevealDudesError,
  handleRevealDudes,
  revealDudesTestHooks,
} from '../src/revealDudes.ts';

const OWNER = Keypair.generate().publicKey;
const BOX_ASSET = Keypair.generate().publicKey;
const COSIGNER = Keypair.generate();
const PLACEHOLDER = Keypair.generate().publicKey;
const PENDING = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const DROP_ID = 'clear_cards_devnet_v2';

function queue(): Queue {
  return {
    send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function env(signer = COSIGNER): Env {
  return {
    NOTIFICATION_EMAIL_QUEUE: queue(),
    HELIUS_API_KEY: 'helius-test-key',
    COSIGNER_SECRET: bs58.encode(signer.secretKey),
    RESEND_API_KEY: '',
    RESEND_CONTACTS_API_KEY: '',
    NOTIFICATION_ENQUEUE_SECRET: '',
    FIRESTORE_SERVICE_ACCOUNT_JSON: '',
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '{"credential":"test"}',
    ADDRESS_DECRYPTION_SECRET: '',
    SHIPSTATION_API_KEY: '',
    SHIPSTATION_SHIP_FROM: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_RESTRICTED_KEY: '',
    STRIPE_SECRET_KEY_LIVE: '',
    STRIPE_RESTRICTED_KEY_LIVE: '',
    STRIPE_WEBHOOK_SECRET_DEVNET: '',
    STRIPE_WEBHOOK_SECRET: '',
  };
}

function request(body: unknown, init: { method?: string; headers?: HeadersInit } = {}): Request {
  return new Request(`https://api.mons.shop${REVEAL_DUDES_PATH}`, {
    method: init.method ?? 'POST',
    headers: {
      Authorization: 'Bearer firebase-token',
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    verifyIdToken: async () => ({ uid: 'firebase-uid' }),
    loadWalletSession: async () => OWNER.toBase58(),
    validateOnchainConfig: async () => ({
      admin: COSIGNER.publicKey,
      coreCollection: new PublicKey(revealDudesTestHooks.runtimeForDrop(DROP_ID).config.collectionMint),
    }),
    loadPendingOpen: async () => ({
      pendingPda: PENDING,
      dudeAssets: [PLACEHOLDER],
      layout: 'vec' as const,
    }),
    assignDudes: async () => ({ dudeIds: [9], outcome: 'created' as const }),
    loadLatestBlockhash: async () => BLOCKHASH,
    sendAndConfirmTransaction: async (_context: unknown, _runtime: unknown, transaction: VersionedTransaction) => {
      assert.equal(transaction.signatures.length, 1);
      assert.equal(transaction.signatures[0].some((byte) => byte !== 0), true);
      return SIGNATURE;
    },
    countOnlineRevealPackStatus: async () => undefined,
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    nowMs: () => 1_700_000_000_000,
    randomInt: () => 0,
    sleep: async () => undefined,
    ...overrides,
  };
}

test('reveal handler returns the confirmed signature and assigned ids', async () => {
  let background: Promise<unknown> | undefined;
  let counted = false;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      countOnlineRevealPackStatus: async () => {
        counted = true;
      },
    }),
    (promise) => {
      background = promise;
    },
  );

  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.boxAssetId, BOX_ASSET.toBase58());
  assert.equal(result.assignmentOutcome, 'created');
  assert.equal(result.transactionOutcome, 'confirmed');
  assert.deepEqual(await result.response.json(), { signature: SIGNATURE, dudeIds: [9] });
  assert.ok(background);
  await background;
  assert.equal(counted, true);
});

test('reveal handler rejects wallet-session mismatches before any reveal work', async () => {
  let onchainCalls = 0;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      loadWalletSession: async () => Keypair.generate().publicKey.toBase58(),
      validateOnchainConfig: async () => {
        onchainCalls += 1;
        throw new Error('unexpected');
      },
    }),
  );

  assert.equal(result.response.status, 403);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'permission-denied');
  assert.equal(onchainCalls, 0);
});

test('reveal handler maps invalid and unavailable Firebase authentication', async () => {
  for (const [kind, status, code] of [
    ['invalid-token', 401, 'unauthenticated'],
    ['provider-timeout', 504, 'deadline-exceeded'],
    ['provider-unavailable', 503, 'unavailable'],
  ] as const) {
    const result = await handleRevealDudes(
      request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
      env(),
      dependencies({
        verifyIdToken: async () => {
          throw new FirebaseIdTokenError(kind);
        },
      }),
    );
    assert.equal(result.response.status, status);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, code);
  }
});

test('reveal handler rejects methods and malformed exact request bodies', async () => {
  const method = await handleRevealDudes(request({}, { method: 'GET' }), env(), dependencies());
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST, OPTIONS');

  for (const body of [
    {},
    { owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID, extra: true },
    { owner: 'invalid', boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID },
    { owner: OWNER.toBase58(), boxAssetId: 'invalid', dropId: DROP_ID },
    { owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: 'unsupported' },
  ]) {
    const result = await handleRevealDudes(request(body), env(), dependencies());
    assert.equal(result.response.status, 400);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'invalid-argument');
  }
});

test('reveal handler preserves ambiguous submission metadata and skips pack status', async () => {
  let counted = false;
  const result = await handleRevealDudes(
    request({ owner: OWNER.toBase58(), boxAssetId: BOX_ASSET.toBase58(), dropId: DROP_ID }),
    env(),
    dependencies({
      sendAndConfirmTransaction: async () => {
        throw new RevealDudesError('unavailable', 'unknown', { signature: SIGNATURE, maybeSubmitted: true });
      },
      countOnlineRevealPackStatus: async () => {
        counted = true;
      },
    }),
  );

  assert.equal(result.response.status, 503);
  assert.equal(result.transactionOutcome, 'unknown');
  assert.equal(counted, false);
});

function firestoreDocument(fields: Record<string, unknown>): Response {
  return Response.json({
    name: 'projects/mons-shop/databases/(default)/documents/test',
    fields,
  });
}

function firestoreContext(providerFetch: typeof fetch) {
  return {
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    nowMs: 1_700_000_000_000,
    providerFetch,
    serviceAccountJson: '{"credential":"test"}',
    signal: new AbortController().signal,
  };
}

test('Firestore assignment atomically creates markers, updates the pool, and creates the box assignment', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    if (url.endsWith('documents:beginTransaction')) return Response.json({ transaction: 'tx-1' });
    if (url.includes('/boxAssignments/')) return new Response(null, { status: 404 });
    if (url.includes('/meta/dudePool')) {
      return firestoreDocument({ available: { arrayValue: { values: [1, 2, 3].map((id) => ({ integerValue: String(id) })) } } });
    }
    if (url.includes('/dudeAssignments/')) return new Response(null, { status: 404 });
    if (url.endsWith('documents:commit')) return Response.json({ writeResults: [{ updateTime: '2026-08-21T00:00:00Z' }] });
    throw new Error(`Unexpected Firestore request: ${method} ${url}`);
  };
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => undefined,
  };

  const result = await revealDudesTestHooks.assignDudes(
    firestoreContext(fetcher),
    runtime,
    BOX_ASSET.toBase58(),
    dependencySubset,
  );

  assert.deepEqual(result, { dudeIds: [1], outcome: 'created' });
  const commit = calls.find((call) => call.url.endsWith('documents:commit'));
  assert.ok(commit);
  const writes = (commit.body as { writes: Array<Record<string, unknown>> }).writes;
  assert.equal(writes.length, 3);
  assert.match(JSON.stringify(writes), /dudeAssignments\/1/);
  assert.match(JSON.stringify(writes), /boxAssignments/);
  assert.match(JSON.stringify(writes), /"available"/);
});

test('Firestore assignment returns an existing valid assignment without touching the pool', async () => {
  let poolReads = 0;
  let commits = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('documents:beginTransaction')) return Response.json({ transaction: 'tx-1' });
    if (url.includes('/boxAssignments/')) {
      return firestoreDocument({ dudeIds: { arrayValue: { values: [{ integerValue: '7' }] } } });
    }
    if (url.includes('/meta/dudePool')) poolReads += 1;
    if (url.endsWith('documents:commit')) commits += 1;
    if (url.endsWith('documents:rollback')) return Response.json({});
    throw new Error(`Unexpected Firestore request: ${init?.method || 'GET'} ${url}`);
  };
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => undefined,
  };

  const result = await revealDudesTestHooks.assignDudes(
    firestoreContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    BOX_ASSET.toBase58(),
    dependencySubset,
  );

  assert.deepEqual(result, { dudeIds: [7], outcome: 'existing' });
  assert.equal(poolReads, 0);
  assert.equal(commits, 0);
});

test('Firestore assignment removes stale markers and retries commit conflicts', async () => {
  let attempt = 0;
  let sleeps = 0;
  let committedBody: { writes: Array<Record<string, unknown>> } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('documents:beginTransaction')) {
      attempt += 1;
      return Response.json({ transaction: `tx-${attempt}` });
    }
    if (url.includes('/boxAssignments/')) return new Response(null, { status: 404 });
    if (url.includes('/meta/dudePool')) {
      return firestoreDocument({
        available: { arrayValue: { values: [{ integerValue: '1' }, { integerValue: '2' }] } },
      });
    }
    if (url.includes('/dudeAssignments/1')) {
      return firestoreDocument({ dudeId: { integerValue: '1' }, boxAssetId: { stringValue: 'stale-box' } });
    }
    if (url.includes('/dudeAssignments/2')) return new Response(null, { status: 404 });
    if (url.endsWith('documents:rollback')) return Response.json({});
    if (url.endsWith('documents:commit')) {
      if (attempt === 1) return Response.json({ error: { status: 'ABORTED' } }, { status: 409 });
      committedBody = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      return Response.json({ writeResults: [{}] });
    }
    throw new Error(`Unexpected Firestore request: ${init?.method || 'GET'} ${url}`);
  };
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => {
      sleeps += 1;
    },
  };

  const result = await revealDudesTestHooks.assignDudes(
    firestoreContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    BOX_ASSET.toBase58(),
    dependencySubset,
  );

  assert.deepEqual(result, { dudeIds: [2], outcome: 'created' });
  assert.equal(attempt, 2);
  assert.equal(sleeps, 1);
  assert.ok(committedBody);
  assert.match(JSON.stringify(committedBody), /dudeAssignments\/2/);
  assert.doesNotMatch(JSON.stringify(committedBody), /dudeAssignments\/1/);
});

test('Firestore assignment fails closed when the pool is exhausted', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('documents:beginTransaction')) return Response.json({ transaction: 'tx-1' });
    if (url.includes('/boxAssignments/')) return new Response(null, { status: 404 });
    if (url.includes('/meta/dudePool')) {
      return firestoreDocument({ available: { arrayValue: { values: [] } } });
    }
    if (url.endsWith('documents:rollback')) return Response.json({});
    throw new Error(`Unexpected Firestore request: ${url}`);
  };
  const dependencySubset = {
    randomInt: () => 0,
    sleep: async () => undefined,
  };

  await assert.rejects(
    revealDudesTestHooks.assignDudes(
      firestoreContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      BOX_ASSET.toBase58(),
      dependencySubset,
    ),
    (error: unknown) => error instanceof RevealDudesError && error.code === 'resource-exhausted',
  );
});

function rpcResponse(body: Record<string, unknown>, result?: unknown, error?: Record<string, unknown>): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: body.id,
    ...(error ? { error } : { result }),
  });
}

function providerContext(fetcher: typeof fetch) {
  return {
    apiKey: 'helius-test-key',
    fetch: fetcher,
    signal: new AbortController().signal,
  };
}

function signedTransaction(): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: COSIGNER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [],
  }).compileToV0Message());
  transaction.sign([COSIGNER]);
  return transaction;
}

test('transaction submission confirms the exact signed transaction signature', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    methods.push(body.method);
    if (body.method === 'sendTransaction') return rpcResponse(body, expectedSignature);
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, { value: [{ err: null, confirmationStatus: 'confirmed' }] });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const signature = await revealDudesTestHooks.sendAndConfirmTransaction(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    transaction,
  );

  assert.equal(signature, expectedSignature);
  assert.deepEqual(methods, ['sendTransaction', 'getSignatureStatuses']);
});

test('ambiguous transaction submission succeeds when its derived signature confirms', async () => {
  const transaction = signedTransaction();
  const expectedSignature = bs58.encode(transaction.signatures[0]);
  let sendCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      sendCalls += 1;
      throw new Error('network reset');
    }
    if (body.method === 'getSignatureStatuses') {
      return rpcResponse(body, { value: [{ err: null, confirmationStatus: 'confirmed' }] });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  const signature = await revealDudesTestHooks.sendAndConfirmTransaction(
    providerContext(fetcher),
    revealDudesTestHooks.runtimeForDrop(DROP_ID),
    transaction,
  );

  assert.equal(signature, expectedSignature);
  assert.equal(sendCalls, 1);
});

test('transaction preflight errors preserve provider logs and never poll status', async () => {
  const transaction = signedTransaction();
  let statusCalls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    if (body.method === 'sendTransaction') {
      return rpcResponse(body, undefined, {
        code: -32002,
        message: 'simulation failed',
        data: { logs: ['program failed'] },
      });
    }
    if (body.method === 'getSignatureStatuses') statusCalls += 1;
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.sendAndConfirmTransaction(
      providerContext(fetcher),
      revealDudesTestHooks.runtimeForDrop(DROP_ID),
      transaction,
    ),
    (error: unknown) => {
      if (!(error instanceof RevealDudesError)) return false;
      assert.equal(error.code, 'failed-precondition');
      assert.deepEqual((error.details as { lastLogs: string[] }).lastLogs, ['program failed']);
      return true;
    },
  );
  assert.equal(statusCalls, 0);
});

function pendingAccountData(args: {
  owner?: PublicKey;
  boxAsset?: PublicKey;
  dudeAssets?: PublicKey[];
  config?: PublicKey;
  layout?: 'legacyFixed' | 'vec';
} = {}): Uint8Array {
  const owner = args.owner ?? OWNER;
  const boxAsset = args.boxAsset ?? BOX_ASSET;
  const dudeAssets = args.dudeAssets ?? [PLACEHOLDER];
  const layout = args.layout ?? 'vec';
  const vectorPrefix = layout === 'vec' ? 4 : 0;
  const configBytes = args.config ? 32 : 0;
  const data = new Uint8Array(8 + 32 + 32 + vectorPrefix + dudeAssets.length * 32 + 8 + 1 + configBytes);
  let offset = 0;
  data.set(PENDING_OPEN_BOX_DISCRIMINATOR, offset);
  offset += 8;
  data.set(owner.toBytes(), offset);
  offset += 32;
  data.set(boxAsset.toBytes(), offset);
  offset += 32;
  if (layout === 'vec') {
    new DataView(data.buffer).setUint32(offset, dudeAssets.length, true);
    offset += 4;
  }
  for (const dudeAsset of dudeAssets) {
    data.set(dudeAsset.toBytes(), offset);
    offset += 32;
  }
  offset += 8;
  data[offset] = 1;
  offset += 1;
  if (args.config) data.set(args.config.toBytes(), offset);
  return data;
}

function rpcAccount(owner: PublicKey, data: Uint8Array): Record<string, unknown> {
  return { owner: owner.toBase58(), data: [Buffer.from(data).toString('base64'), 'base64'] };
}

test('pending-open validation accepts the exact owner, box, config, and placeholder count', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    assert.equal(body.method, 'getAccountInfo');
    return rpcResponse(body, {
      value: rpcAccount(runtime.boxMinterProgramId, pendingAccountData({ config: runtime.boxMinterConfigPda })),
    });
  };

  const pending = await revealDudesTestHooks.loadPendingOpen(
    providerContext(fetcher),
    runtime,
    OWNER,
    BOX_ASSET,
  );

  assert.equal(pending.layout, 'vec');
  assert.deepEqual(pending.dudeAssets.map((key) => key.toBase58()), [PLACEHOLDER.toBase58()]);
});

test('pending-open validation rejects another owner and mismatched config', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  for (const data of [
    pendingAccountData({ owner: Keypair.generate().publicKey, config: runtime.boxMinterConfigPda }),
    pendingAccountData({ config: Keypair.generate().publicKey }),
  ]) {
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return rpcResponse(body, { value: rpcAccount(runtime.boxMinterProgramId, data) });
    };
    await assert.rejects(
      revealDudesTestHooks.loadPendingOpen(providerContext(fetcher), runtime, OWNER, BOX_ASSET),
      (error: unknown) => error instanceof RevealDudesError &&
        (error.code === 'permission-denied' || error.code === 'failed-precondition'),
    );
  }
});

test('legacy pending-open disambiguation rejects an asset from another configured drop', async () => {
  const runtime = revealDudesTestHooks.runtimeForDrop(DROP_ID);
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { method: string };
    calls += 1;
    if (body.method === 'getAccountInfo') {
      return rpcResponse(body, {
        value: rpcAccount(runtime.boxMinterProgramId, pendingAccountData({ layout: 'legacyFixed' })),
      });
    }
    if (body.method === 'getAsset') {
      const other = revealDudesTestHooks.runtimeForDrop('clear_cards_devnet_v3');
      return rpcResponse(body, {
        id: BOX_ASSET.toBase58(),
        interface: 'MplCoreAsset',
        burnt: false,
        grouping: [{ group_key: 'collection', group_value: other.config.collectionMint }],
        content: {
          json_uri: `${other.config.metadataBase}/b1.json`,
          metadata: { name: 'pack 1', attributes: [{ trait_type: 'type', value: 'box' }] },
        },
      });
    }
    throw new Error(`Unexpected RPC method: ${body.method}`);
  };

  await assert.rejects(
    revealDudesTestHooks.loadPendingOpen(providerContext(fetcher), runtime, OWNER, BOX_ASSET),
    (error: unknown) => error instanceof RevealDudesError && error.code === 'failed-precondition',
  );
  assert.equal(calls, 2);
});

test('online reveal pack status creates one idempotency event and increments the aggregate', async () => {
  let commitBody: unknown;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('documents:beginTransaction')) return Response.json({ transaction: 'tx-pack' });
    if (url.includes('/packStatusEvents/')) return new Response(null, { status: 404 });
    if (url.endsWith('documents:commit')) {
      commitBody = JSON.parse(String(init?.body)) as unknown;
      return Response.json({ writeResults: [{}] });
    }
    throw new Error(`Unexpected Firestore request: ${url}`);
  };

  await revealDudesTestHooks.countOnlineRevealPackStatus(
    firestoreContext(fetcher),
    revealDudesTestHooks.runtimeForDrop('card_nft_2'),
    BOX_ASSET.toBase58(),
    SIGNATURE,
  );

  assert.match(JSON.stringify(commitBody), /unsealedOnline/);
  assert.match(JSON.stringify(commitBody), /onlineReveal_/);
  assert.match(JSON.stringify(commitBody), new RegExp(SIGNATURE));
});
