import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  API_DROPS,
  type ApiDropConfig,
} from '../src/dropConfig.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
} from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { FirestoreWriteConflict, commerceDocumentRequest } from '../src/firestoreRest.ts';
import {
  DELIVERY_PREPARE_PATH,
  deliveryPrepareTestHooks,
  handleDeliveryPrepare,
} from '../src/deliveryPrepare.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';

const OWNER = Keypair.generate();
const COSIGNER = Keypair.generate();
const PROGRAM = Keypair.generate().publicKey;
const CONFIG = Keypair.generate().publicKey;
const COLLECTION = Keypair.generate().publicKey;
const TREASURY = Keypair.generate().publicKey;
const ASSET = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const BLOCKHASH_CONTEXT_SLOT = 123;
const DROP_ID = 'delivery_prepare_test';
const ADDRESS_ID = 'AbCdEfGhIjKlMnOpQrSt';
const NOW_MS = 1_700_000_000_000;

const baseDrop = Object.values(API_DROPS).find((drop) => drop.itemsPerBox > 0)!;
const DROP: ApiDropConfig = {
  ...baseDrop,
  dropId: DROP_ID,
  solanaCluster: 'devnet',
  boxMinterProgramId: PROGRAM.toBase58(),
  boxMinterConfigPda: CONFIG.toBase58(),
  collectionMint: COLLECTION.toBase58(),
  treasury: TREASURY.toBase58(),
  paymentRouting: undefined,
  deliveryLookupTable: '',
  maxSupply: 100,
  itemsPerBox: 3,
};

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET.toBase58(),
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    content: {
      metadata: {
        attributes: [
          { trait_type: 'type', value: 'box' },
          { trait_type: 'box_id', value: '7' },
        ],
      },
    },
    ownership: { owner: OWNER.publicKey.toBase58() },
    ...overrides,
  };
}

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64LE(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

function borshString(value: string): Buffer {
  const encoded = Buffer.from(value);
  return Buffer.concat([u32LE(encoded.length), encoded]);
}

function configData(overrides: { treasury?: PublicKey; collection?: PublicKey } = {}): Buffer {
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    COSIGNER.publicKey.toBuffer(),
    (overrides.treasury || TREASURY).toBuffer(),
    (overrides.collection || COLLECTION).toBuffer(),
    u64LE(1n),
    u64LE(1n),
    Buffer.alloc(32),
    u32LE(DROP.maxSupply),
    Buffer.from([DROP.maxPerTx, DROP.itemsPerBox]),
    u32LE(0),
    borshString(DROP.namePrefix),
    borshString(DROP.symbol),
    borshString(DROP.metadataBase),
    Buffer.from([1, 1, DROP.discountMintsPerWallet]),
    borshString(DROP.figureNamePrefix),
    Buffer.alloc(37),
  ]);
  assert.equal(payload.length <= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED, true);
  return Buffer.concat([
    payload,
    Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - payload.length),
  ]);
}

function collectionData(discriminator = 5): Buffer {
  return Buffer.concat([Buffer.from([discriminator]), Buffer.alloc(48)]);
}

function lookupTableData(deactivationSlot: bigint): Buffer {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(deactivationSlot, 4);
  return data;
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.mons.shop${DELIVERY_PREPARE_PATH}`, {
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
    owner: OWNER.publicKey.toBase58(),
    dropId: DROP_ID,
    itemIds: [ASSET.toBase58()],
    addressId: ADDRESS_ID,
  };
}

function env(overrides: Record<string, string> = {}) {
  return {
    COMMERCE_DB: createCommerceD1(),
    COSIGNER_SECRET: bs58.encode(COSIGNER.secretKey),
    HELIUS_API_KEY: 'helius-test-key',
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    requestCommerceDocument: commerceDocumentRequest,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
    getDrop: (dropId: string) => dropId === DROP_ID ? DROP : undefined,
    loadWalletSession: async () => OWNER.publicKey.toBase58(),
    loadAddress: async () => ({
      decoded: { id: ADDRESS_ID, country: 'US', countryCode: 'US', encrypted: 'cipher' },
      rawFields: {
        id: { stringValue: ADDRESS_ID },
        country: { stringValue: 'US' },
        countryCode: { stringValue: 'US' },
        encrypted: { stringValue: 'cipher' },
        createdAt: { timestampValue: '2026-08-20T00:00:00.000Z' },
      },
    }),
    fetchAsset: async () => asset(),
    loadOnchainState: async () => ({
      admin: COSIGNER.publicKey,
      treasury: TREASURY,
      coreCollection: COLLECTION,
    }),
    loadLookupTable: async () => [],
    deliveryPdaExists: async () => false,
    attemptId: () => '123e4567-e89b-42d3-a456-426614174000',
    candidateId: () => 7,
    createDeliveryOrder: async () => '2026-08-20T00:00:01.000Z',
    deleteDeliveryOrder: async () => undefined,
    loadLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
    }),
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    nowMs: () => NOW_MS,
    ...overrides,
  };
}

test('delivery preparation returns the server-signed owner transaction and exact order input', async () => {
  let created: Record<string, unknown> | undefined;
  const result = await handleDeliveryPrepare(request(requestBody(), {
    'X-Mons-Delivery-Prepare-Attempt': '8dc66f5f-0f2d-46aa-85c3-f8744dc46ad5',
  }), env(), dependencies({
    createDeliveryOrder: async (_context: unknown, input: Record<string, unknown>) => {
      created = input;
      return '2026-08-20T00:00:01.000Z';
    },
  }));
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    encodedTx: string;
    blockhashContextSlot: number;
    deliveryLamports: number;
    deliveryId: number;
  };
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['blockhashContextSlot', 'deliveryId', 'deliveryLamports', 'encodedTx'],
  );
  assert.equal(payload.blockhashContextSlot, BLOCKHASH_CONTEXT_SLOT);
  assert.equal(payload.deliveryId, 7);
  assert.equal(payload.deliveryLamports > 0, true);
  assert.equal(created?.path, `drops/${DROP_ID}/deliveryOrders/7`);
  assert.equal(created?.owner, OWNER.publicKey.toBase58());
  assert.equal(created?.itemIds, undefined);
  assert.deepEqual(created?.items, [{ assetId: ASSET.toBase58(), kind: 'box', refId: 7 }]);
  assert.equal(created?.nextPreparedProbeAtMs, NOW_MS + 30_000);
  assert.equal(created?.prepareAttemptId, '8dc66f5f-0f2d-46aa-85c3-f8744dc46ad5');

  const transaction = VersionedTransaction.deserialize(Buffer.from(payload.encodedTx, 'base64'));
  const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  assert.deepEqual(signers.map((key) => key.toBase58()), [OWNER.publicKey.toBase58(), COSIGNER.publicKey.toBase58()]);
  assert.equal(transaction.signatures[0].every((byte) => byte === 0), true);
  assert.equal(transaction.signatures[1].some((byte) => byte !== 0), true);
  assert.equal(
    nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[1], COSIGNER.publicKey.toBytes()),
    true,
  );
});

test('delivery preparation schedules recovery from the document reservation time', async () => {
  const times = [NOW_MS - 60_000, NOW_MS - 55_000, NOW_MS];
  let nextPreparedProbeAtMs: number | undefined;
  const result = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    nowMs: () => times.shift() ?? NOW_MS,
    createDeliveryOrder: async (_context: unknown, input: { nextPreparedProbeAtMs: number }) => {
      nextPreparedProbeAtMs = input.nextPreparedProbeAtMs;
      return '2026-08-20T00:00:01.000Z';
    },
  }));
  assert.equal(result.response.status, 200);
  assert.equal(nextPreparedProbeAtMs, NOW_MS + 30_000);
});

test('delivery preparation preserves raw address fields in the Firestore create', async () => {
  const harness = createCommerceD1Harness();
  const updateTime = await deliveryPrepareTestHooks.createDeliveryOrder({
    requestCommerceDocument: commerceDocumentRequest,
    commerceDb: harness.db,
    nowMs: NOW_MS,
    providerFetch: async () => assert.fail('D1 delivery creation reached a network provider'),
    signal: new AbortController().signal,
  }, {
    path: `drops/${DROP_ID}/deliveryOrders/7`,
    dropId: DROP_ID,
    owner: OWNER.publicKey.toBase58(),
    addressId: ADDRESS_ID,
    address: {
      decoded: { countryCode: 'US' },
      rawFields: {
        createdAt: { timestampValue: '2026-08-19T00:00:00.000Z' },
        encrypted: { stringValue: 'cipher' },
      },
    },
    addressCountry: 'US',
    items: [{ assetId: ASSET.toBase58(), kind: 'box', refId: 7 }],
    deliveryId: 7,
    deliveryPda: Keypair.generate().publicKey.toBase58(),
    deliveryLamports: 200_000_000,
    nextPreparedProbeAtMs: NOW_MS + 30_000,
    prepareAttemptId: '123e4567-e89b-42d3-a456-426614174000',
  });
  assert.equal(Date.parse(updateTime), NOW_MS);
  const row = harness.database.prepare(`SELECT fields_json FROM commerce_documents
    WHERE document_path = ?`).get(`drops/${DROP_ID}/deliveryOrders/7`) as { fields_json: string };
  const fields = JSON.parse(row.fields_json) as Record<string, unknown>;
  const snapshot = ((fields.addressSnapshot as Record<string, unknown>).mapValue as Record<string, unknown>).fields as Record<string, unknown>;
  assert.deepEqual(snapshot.createdAt, { timestampValue: '2026-08-19T00:00:00.000Z' });
  assert.deepEqual(snapshot.countryCode, { stringValue: 'US' });
  assert.deepEqual(fields.createdAt, { timestampValue: new Date(NOW_MS).toISOString() });
});

test('delivery preparation reconciles an applied D1 commit when its result is lost', async () => {
  const harness = createCommerceD1Harness();
  let batches = 0;
  const db = {
    ...harness.db,
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const result = await harness.db.batch<T>(statements);
      batches += 1;
      if (batches === 1) throw new TypeError('commit result lost');
      return result;
    },
  } as D1Database;
  const updateTime = await deliveryPrepareTestHooks.createDeliveryOrder({
    requestCommerceDocument: commerceDocumentRequest,
    commerceDb: db,
    nowMs: NOW_MS,
    providerFetch: async () => assert.fail('D1 delivery reconciliation reached a network provider'),
    signal: new AbortController().signal,
  }, {
    path: `drops/${DROP_ID}/deliveryOrders/7`,
    dropId: DROP_ID,
    owner: OWNER.publicKey.toBase58(),
    addressId: ADDRESS_ID,
    address: { decoded: { countryCode: 'US' }, rawFields: {} },
    addressCountry: 'US',
    items: [{ assetId: ASSET.toBase58(), kind: 'box', refId: 7 }],
    deliveryId: 7,
    deliveryPda: 'delivery-pda',
    deliveryLamports: 200_000_000,
    nextPreparedProbeAtMs: NOW_MS + 30_000,
    prepareAttemptId: '123e4567-e89b-42d3-a456-426614174000',
  });
  assert.equal(Date.parse(updateTime), NOW_MS);
  assert.equal(batches, 1);
});

test('delivery preparation retries Firestore collisions with a fresh delivery id', async () => {
  const candidates = [7, 8];
  const created: number[] = [];
  const result = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    candidateId: () => candidates.shift()!,
    createDeliveryOrder: async (_context: unknown, input: { deliveryId: number }) => {
      created.push(input.deliveryId);
      if (input.deliveryId === 7) throw new FirestoreWriteConflict();
      return '2026-08-20T00:00:01.000Z';
    },
  }));
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { deliveryId: number }).deliveryId, 8);
  assert.deepEqual(created, [7, 8]);
});

test('delivery preparation conditionally cleans up a reserved order after a blockhash failure', async () => {
  const deleted: unknown[][] = [];
  const result = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    loadLatestBlockhash: async () => {
      throw new Error('provider failed');
    },
    deleteDeliveryOrder: async (...args: unknown[]) => {
      deleted.push(args);
    },
  }));
  assert.equal(result.response.status, 500);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0][1], `drops/${DROP_ID}/deliveryOrders/7`);
  assert.equal(deleted[0][2], '2026-08-20T00:00:01.000Z');
});

test('delivery preparation uses a fresh signal to clean up after the overall deadline', async () => {
  let cleanupSignalAborted: boolean | undefined;
  const result = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    timeoutMs: 5,
    loadLatestBlockhash: async (context: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    }),
    deleteDeliveryOrder: async (context: { signal: AbortSignal }) => {
      cleanupSignalAborted = context.signal.aborted;
    },
  }));
  assert.equal(result.response.status, 504);
  assert.equal(cleanupSignalAborted, false);
});

test('delivery preparation reports an oversized transaction before reserving an order', async () => {
  const itemIds = Array.from({ length: 32 }, () => Keypair.generate().publicKey.toBase58());
  let createCalled = false;
  const result = await handleDeliveryPrepare(request({ ...requestBody(), itemIds }), env(), dependencies({
    fetchAsset: async (_context: unknown, _runtime: unknown, assetId: string) => asset({ id: assetId }),
    createDeliveryOrder: async () => {
      createCalled = true;
      return '2026-08-20T00:00:01.000Z';
    },
  }));
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as { error: { message: string; details: { maxFit: number } } };
  assert.match(payload.error.message, /transaction too large/i);
  assert.equal(payload.error.details.maxFit > 0, true);
  assert.equal(createCalled, false);
});

test('delivery asset reads request collection grouping and retain the legacy REST fallback', async () => {
  const runtime = deliveryPrepareTestHooks.buildRuntime(DROP);
  const requests: Array<{ url: string; body?: unknown }> = [];
  const result = await deliveryPrepareTestHooks.fetchAsset({
    apiKey: 'helius-test-key',
    providerFetch: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.includes('helius-rpc.com')) {
        return Response.json({
          jsonrpc: '2.0',
          id: 'delivery-prepare-getAsset',
          error: { code: -32601, message: 'method not found' },
        });
      }
      return Response.json([asset()]);
    },
    signal: new AbortController().signal,
  }, runtime, ASSET.toBase58());
  assert.equal(result.id, ASSET.toBase58());
  assert.deepEqual(requests[0].body, {
    jsonrpc: '2.0',
    id: 'delivery-prepare-getAsset',
    method: 'getAsset',
    params: {
      id: ASSET.toBase58(),
      options: { showUnverifiedCollections: true },
    },
  });
  assert.match(requests[1].url, /^https:\/\/api\.helius\.xyz\/v0\/assets\?/);
  assert.match(requests[1].url, /cluster=devnet/);
});

test('delivery asset reads tolerate multi-second indexing lag', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW_MS });
  const runtime = deliveryPrepareTestHooks.buildRuntime(DROP);
  let calls = 0;
  const pending = deliveryPrepareTestHooks.fetchAsset({
    apiKey: 'helius-test-key',
    providerFetch: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: calls >= 5 ? asset() : null,
      });
    },
    signal: new AbortController().signal,
  }, runtime, ASSET.toBase58());

  for (const [index, delay] of [300, 600, 1_200, 2_400].entries()) {
    for (let turn = 0; turn < 20 && calls < index + 1; turn += 1) await Promise.resolve();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    t.mock.timers.tick(delay);
  }

  assert.equal((await pending).id, ASSET.toBase58());
  assert.equal(calls, 5);
});

test('delivery asset reads return not-found after exhausting indexing retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW_MS });
  const runtime = deliveryPrepareTestHooks.buildRuntime(DROP);
  let calls = 0;
  const pending = deliveryPrepareTestHooks.fetchAsset({
    apiKey: 'helius-test-key',
    providerFetch: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: null });
    },
    signal: new AbortController().signal,
  }, runtime, ASSET.toBase58());
  const rejection = assert.rejects(pending, (error: unknown) =>
    Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'not-found');

  for (const [index, delay] of [300, 600, 1_200, 2_400, 4_800].entries()) {
    for (let turn = 0; turn < 20 && calls < index + 1; turn += 1) await Promise.resolve();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    t.mock.timers.tick(delay);
  }

  await rejection;
  assert.equal(calls, 6);
});

test('delivery asset reads preserve caller aborts during indexing backoff', async () => {
  const runtime = deliveryPrepareTestHooks.buildRuntime(DROP);
  const controller = new AbortController();
  const reason = new Error('stop delivery asset retry');
  let calls = 0;
  const pending = deliveryPrepareTestHooks.fetchAsset({
    apiKey: 'helius-test-key',
    providerFetch: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: null });
    },
    signal: controller.signal,
  }, runtime, ASSET.toBase58());
  const rejection = assert.rejects(pending, (error: unknown) => error === reason);

  for (let turn = 0; turn < 20 && calls < 1; turn += 1) await Promise.resolve();
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  controller.abort(reason);

  await rejection;
  assert.equal(calls, 1);
});

test('delivery on-chain validation accepts the committed config and rejects collection drift', async () => {
  const runtime = deliveryPrepareTestHooks.buildRuntime(DROP);
  const provider = (data: Buffer, coreCollectionData = collectionData()) => async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        value: [
          {
            owner: MPL_CORE_PROGRAM_ADDRESS,
            data: [coreCollectionData.toString('base64'), 'base64'],
          },
          {
            owner: PROGRAM.toBase58(),
            data: [data.toString('base64'), 'base64'],
          },
        ],
      },
    });
  };
  const context = {
    apiKey: 'helius-test-key',
    providerFetch: provider(configData()),
    signal: new AbortController().signal,
  };
  const state = await deliveryPrepareTestHooks.loadOnchainState(context, runtime);
  assert.equal(state.admin.toBase58(), COSIGNER.publicKey.toBase58());
  assert.equal(state.treasury.toBase58(), TREASURY.toBase58());
  assert.equal(state.coreCollection.toBase58(), COLLECTION.toBase58());

  let transientCalls = 0;
  const retriedState = await deliveryPrepareTestHooks.loadOnchainState({
    ...context,
    providerFetch: async (input, init) => {
      transientCalls += 1;
      if (transientCalls === 1) {
        return Response.json({
          jsonrpc: '2.0',
          id: 'delivery-prepare-getMultipleAccounts',
          error: { code: -32005, message: 'temporarily unavailable' },
        });
      }
      return provider(configData())(input, init);
    },
  }, runtime);
  assert.equal(retriedState.admin.toBase58(), COSIGNER.publicKey.toBase58());
  assert.equal(transientCalls, 2);

  await assert.rejects(
    () => deliveryPrepareTestHooks.loadOnchainState({
      ...context,
      providerFetch: provider(configData({ collection: Keypair.generate().publicKey })),
    }, runtime),
    /Committed drop configuration does not match/,
  );
  await assert.rejects(
    () => deliveryPrepareTestHooks.loadOnchainState({
      ...context,
      providerFetch: provider(configData(), collectionData(4)),
    }, runtime),
    /not an MPL Core collection/,
  );
});

test('delivery latest blockhash preserves the RPC context slot', async () => {
  const runtime = deliveryPrepareTestHooks.buildRuntime(DROP);
  const latestBlockhash = await deliveryPrepareTestHooks.loadLatestBlockhash({
    apiKey: 'helius-test-key',
    providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          context: { slot: BLOCKHASH_CONTEXT_SLOT },
          value: { blockhash: BLOCKHASH, lastValidBlockHeight: 456 },
        },
      });
    },
    signal: new AbortController().signal,
  }, runtime);
  assert.deepEqual(latestBlockhash, {
    blockhash: BLOCKHASH,
    blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
  });
});

test('delivery preparation rejects inactive lookup tables', async () => {
  const lookupTable = Keypair.generate().publicKey;
  const runtime = deliveryPrepareTestHooks.buildRuntime({
    ...DROP,
    deliveryLookupTable: lookupTable.toBase58(),
  });
  await assert.rejects(
    () => deliveryPrepareTestHooks.loadLookupTable({
      apiKey: 'helius-test-key',
      providerFetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: string };
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            value: {
              owner: AddressLookupTableProgram.programId.toBase58(),
              data: [lookupTableData(1n).toString('base64'), 'base64'],
            },
          },
        });
      },
      signal: new AbortController().signal,
    }, runtime),
    /DELIVERY_LOOKUP_TABLE is inactive/,
  );
});

test('delivery preparation enforces authentication, session ownership, exact requests, and asset boundaries', async () => {
  const unauthenticated = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    verifyIdentity: async () => {
      throw new RequestIdentityError('invalid-token');
    },
  }));
  assert.equal(unauthenticated.response.status, 401);

  const unsupportedUnauthenticated = await handleDeliveryPrepare(request({
    ...requestBody(),
    dropId: 'not_configured',
  }), env(), dependencies({
    verifyIdentity: async () => {
      throw new RequestIdentityError('invalid-token');
    },
  }));
  assert.equal(unsupportedUnauthenticated.response.status, 401);
  assert.equal(unsupportedUnauthenticated.dropId, undefined);

  const denied = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    loadWalletSession: async () => Keypair.generate().publicKey.toBase58(),
  }));
  assert.equal(denied.response.status, 403);

  const malformed = await handleDeliveryPrepare(request({ ...requestBody(), extra: true }), env(), dependencies());
  assert.equal(malformed.response.status, 400);

  const invalidAttempt = await handleDeliveryPrepare(request(requestBody(), {
    'X-Mons-Delivery-Prepare-Attempt': 'invalid',
  }), env(), dependencies());
  assert.equal(invalidAttempt.response.status, 400);

  const duplicate = await handleDeliveryPrepare(request({
    ...requestBody(),
    itemIds: [ASSET.toBase58(), ASSET.toBase58()],
  }), env(), dependencies());
  assert.equal(duplicate.response.status, 400);

  const wrongOwner = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    fetchAsset: async () => asset({ ownership: { owner: Keypair.generate().publicKey.toBase58() } }),
  }));
  assert.equal(wrongOwner.response.status, 409);

  let mismatchedAssetCreated = false;
  const mismatchedAsset = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    fetchAsset: async () => asset({ id: Keypair.generate().publicKey.toBase58() }),
    createDeliveryOrder: async () => {
      mismatchedAssetCreated = true;
      return '2026-08-20T00:00:01.000Z';
    },
  }));
  assert.equal(mismatchedAsset.response.status, 409);
  assert.equal(mismatchedAssetCreated, false);

  const certificate = await handleDeliveryPrepare(request(requestBody()), env(), dependencies({
    fetchAsset: async () => asset({
      content: { metadata: { attributes: [{ trait_type: 'type', value: 'certificate' }] } },
    }),
  }));
  assert.equal(certificate.response.status, 409);
  assert.equal((await certificate.response.json() as { error: { message: string } }).error.message, 'Certificates cannot be delivered');
});

test('delivery preparation rejects authentication before reading a stalled request body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull: () => new Promise<void>(() => undefined),
    cancel: () => {
      cancelled = true;
    },
  });
  const stalledRequest = new Request(`https://api.mons.shop${DELIVERY_PREPARE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const result = await handleDeliveryPrepare(stalledRequest, env(), {
    timeoutMs: 1000,
    verifyIdentity: async () => {
      throw new RequestIdentityError('invalid-token');
    },
  });
  assert.equal(result.response.status, 401);
  assert.equal(cancelled, true);
});

test('delivery preparation reports an authenticated stalled request body as a deadline', async () => {
  const body = new ReadableStream({
    pull: () => new Promise<void>(() => undefined),
  });
  const stalledRequest = new Request(`https://api.mons.shop${DELIVERY_PREPARE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const result = await handleDeliveryPrepare(stalledRequest, env(), {
    timeoutMs: 5,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
  });
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('delivery preparation cancels sibling asset reads after the first validation failure', async () => {
  const secondAsset = Keypair.generate().publicKey.toBase58();
  let siblingAborted = false;
  const result = await handleDeliveryPrepare(request({
    ...requestBody(),
    itemIds: [ASSET.toBase58(), secondAsset],
  }), env(), dependencies({
    fetchAsset: async (context: { signal: AbortSignal }, _runtime: unknown, assetId: string) => {
      if (assetId === ASSET.toBase58()) {
        return asset({ ownership: { owner: Keypair.generate().publicKey.toBase58() } });
      }
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          siblingAborted = true;
          reject(context.signal.reason);
        }, { once: true });
      });
    },
  }));
  assert.equal(result.response.status, 409);
  assert.equal(siblingAborted, true);
});

test('delivery runtime accepts every deployed drop and secure ids stay in range', () => {
  for (const drop of Object.values(API_DROPS)) {
    const runtime = deliveryPrepareTestHooks.buildRuntime(drop);
    assert.equal(runtime.dropId, drop.dropId);
  }
  for (let index = 0; index < 100; index += 1) {
    const deliveryId = deliveryPrepareTestHooks.secureDeliveryId();
    assert.equal(Number.isInteger(deliveryId), true);
    assert.equal(deliveryId > 0 && deliveryId < 2 ** 31, true);
  }
});
