import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
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
import type { DecodedBoxMinterConfigData } from '../../../../shared/boxMinterConfigCodec.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import {
  handleIrlClaimPrepare,
  IRL_CLAIM_PREPARE_PATH,
  irlClaimTestHooks,
} from '../src/irlClaim.ts';

const OWNER = Keypair.generate().publicKey;
const COSIGNER = Keypair.generate();
const COLLECTION = Keypair.generate().publicKey;
const RECEIPTS_TREE = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;
const CONFIG = Keypair.generate().publicKey;
const TREASURY = Keypair.generate().publicKey;
const CERTIFICATE = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const BLOCKHASH_CONTEXT_SLOT = 123;
const HASH = bs58.encode(new Uint8Array(32).fill(7));
const DROP_ID = 'irl_claim_test';

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
  treasury: TREASURY.toBase58(),
  paymentRouting: undefined,
  maxSupply: 100,
  receiptMaxId: 100,
  itemsPerBox: 3,
  discountMintsPerWallet: 1,
};

const ONCHAIN_CONFIG: DecodedBoxMinterConfigData = {
  admin: COSIGNER.publicKey.toBytes(),
  treasury: TREASURY.toBytes(),
  coreCollection: COLLECTION.toBytes(),
  priceLamports: 1n,
  discountPriceLamports: 1n,
  discountMerkleRoot: new Uint8Array(32),
  discountMintsPerWallet: DROP.discountMintsPerWallet,
  maxSupply: DROP.maxSupply,
  maxPerTx: DROP.maxPerTx,
  itemsPerBox: DROP.itemsPerBox,
  started: true,
  minted: 1,
  namePrefix: DROP.namePrefix,
  figureNamePrefix: DROP.figureNamePrefix,
  symbol: DROP.symbol,
  uriBase: DROP.metadataBase,
  bump: 1,
  mintVariantKind: 0,
  mintVariantStartIds: [0, 0, 0],
  mintVariantEndIds: [0, 0, 0],
  mintVariantNextIds: [0, 0, 0],
  paymentRouting: {
    schema: 'legacy',
    mintProceeds: [{ address: TREASURY.toBytes(), percentage: 100 }],
    deliveryPaymentReceiver: TREASURY.toBytes(),
  },
};

function certificateAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: CERTIFICATE.toBase58(),
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    content: {
      metadata: {
        attributes: [
          { trait_type: 'type', value: 'certificate' },
          { trait_type: 'box_id', value: '7' },
        ],
      },
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

function env() {
  return {
    COMMERCE_DB: createCommerceD1(),
    COSIGNER_SECRET: bs58.encode(COSIGNER.secretKey),
    HELIUS_API_KEY: 'helius-test-key',
  };
}

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`https://api.mons.shop${IRL_CLAIM_PREPARE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
    loadWalletSession: async () => OWNER.toBase58(),
    loadClaim: async () => ({ dropId: DROP_ID, boxId: 7, dudeIds: [1, 2, 3] }),
    resolveLegacyDropIds: async () => [],
    getDrop: (dropId: string) => dropId === DROP_ID ? DROP : undefined,
    fetchOwnedAssets: async () => [certificateAsset()],
    fetchAssetProof: async () => ({ tree_id: RECEIPTS_TREE.toBase58(), root: HASH, proof: [] }),
    loadOnchainState: async () => ({ config: ONCHAIN_CONFIG, coreCollection: COLLECTION }),
    loadLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
    }),
    loadLookupTable: async () => [],
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

test('IRL claim handler returns the expected partially signed transaction', async () => {
  const result = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '123-456 7890' }),
    env(),
    dependencies(),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP_ID);
  const payload = await result.response.json() as {
    encodedTx: string;
    blockhashContextSlot: number;
    dropId: string;
    certificates: number[];
    certificateId: string;
    message: string;
  };
  assert.deepEqual(payload, {
    encodedTx: payload.encodedTx,
    blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
    dropId: DROP_ID,
    certificates: [1, 2, 3],
    certificateId: CERTIFICATE.toBase58(),
    message: 'Sign and send to burn your box receipt and mint your dude receipts.',
  });
  const raw = Buffer.from(payload.encodedTx, 'base64');
  assert.ok(raw.length <= 1232);
  const transaction = VersionedTransaction.deserialize(raw);
  const requiredSignerKeys = transaction.message.staticAccountKeys.slice(
    0,
    transaction.message.header.numRequiredSignatures,
  );
  assert.equal(requiredSignerKeys[0].toBase58(), OWNER.toBase58());
  const ownerIndex = requiredSignerKeys.findIndex((key) => key.equals(OWNER));
  const cosignerIndex = requiredSignerKeys.findIndex((key) => key.equals(COSIGNER.publicKey));
  assert.ok(ownerIndex >= 0);
  assert.ok(cosignerIndex >= 0);
  assert.equal(transaction.signatures[ownerIndex].every((byte) => byte === 0), true);
  assert.equal(transaction.signatures[cosignerIndex].some((byte) => byte !== 0), true);
  const programIds = transaction.message.compiledInstructions.map((instruction) =>
    transaction.message.staticAccountKeys[instruction.programIdIndex].toBase58());
  assert.deepEqual(programIds, [
    ComputeBudgetProgram.programId.toBase58(),
    BUBBLEGUM_PROGRAM_ADDRESS,
    PROGRAM.toBase58(),
  ]);
});

test('IRL claim reads wallet sessions from D1 and preserves legacy collection-group resolution', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    name: 'projects/mons-shop/databases/(default)/documents/claimCodes/1234567890',
    fields: {
      dropId: { stringValue: DROP_ID },
      boxId: { integerValue: '7' },
      dudeIds: { arrayValue: { values: [1, 2, 3].map((id) => ({ integerValue: String(id) })) } },
    },
  });
  seedCommerceDocument(harness, {
    name: `projects/mons-shop/databases/(default)/documents/drops/${DROP_ID}/boxAssignments/asset-1`,
    fields: { irlClaimCode: { stringValue: '1234567890' } },
  });
  const context = {
    commerceDb: harness.db,
    nowMs: 1_700_000_000_000,
    providerFetch: async () => assert.fail('commerce reads must not use provider fetch'),
    signal: new AbortController().signal,
  };
  const firestoreSourceDb = {
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
    prepare: () => {
      let statement: D1PreparedStatement;
      statement = {
        all: async () => { throw new Error('Unexpected D1 all'); },
        bind: () => statement,
        first: async () => ({
          auth_subject: 'firebase-uid',
          wallet: OWNER.toBase58(),
          expires_at_ms: 253_402_300_799_999,
          updated_at_ms: 1_700_000_000_000,
          wallet_revision: 1,
          reconcile_lease_id: null,
          reconcile_lease_expires_at_ms: null,
        }),
        raw: async () => { throw new Error('Unexpected D1 raw'); },
        run: async () => { throw new Error('Unexpected D1 run'); },
      } as D1PreparedStatement;
      return statement;
    },
    withSession: () => {
      throw new Error('Unexpected D1 session');
    },
  } as D1Database;
  assert.equal(await irlClaimTestHooks.loadWalletSession(context, firestoreSourceDb, 'firebase-uid'), OWNER.toBase58());
  assert.deepEqual(await irlClaimTestHooks.loadClaim(context, '1234567890'), {
    dropId: DROP_ID,
    boxId: 7,
    dudeIds: [1, 2, 3],
  });
  assert.deepEqual(await irlClaimTestHooks.resolveLegacyDropIds(context, '1234567890'), [DROP_ID]);
});

test('IRL claim provider adapters bound responses and retry transient reads once', async () => {
  const runtime = irlClaimTestHooks.buildRuntime(DROP);
  let calls = 0;
  const blockhash = await irlClaimTestHooks.loadLatestBlockhash({
    apiKey: 'helius-key',
    signal: new AbortController().signal,
    providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
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
  }, runtime);
  assert.deepEqual(blockhash, {
    blockhash: BLOCKHASH,
    blockhashContextSlot: BLOCKHASH_CONTEXT_SLOT,
  });
  assert.equal(calls, 2);

  await assert.rejects(
    () => irlClaimTestHooks.rpcCall({
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

test('IRL claim provider attempt scope aborts independently of the overall request', async () => {
  const overall = new AbortController();
  const scope = irlClaimTestHooks.createProviderAttemptScope(overall.signal, 5);
  await new Promise<void>((resolve) => {
    scope.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  assert.equal(scope.timedOut(), true);
  assert.equal(overall.signal.aborted, false);
  scope.dispose();
});

test('IRL claim asset search cursor-paginates within the candidate budget', async () => {
  const runtime = irlClaimTestHooks.buildRuntime(DROP);
  const cursors: Array<string | undefined> = [];
  const assets = await irlClaimTestHooks.fetchOwnedAssets({
    apiKey: 'helius-key',
    signal: new AbortController().signal,
    providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: string; params: { cursor?: string } };
      cursors.push(body.params.cursor);
      const result = body.params.cursor === undefined
        ? { limit: 250, cursor: 'cursor-1', items: [{ id: 'asset-1' }] }
        : body.params.cursor === 'cursor-1'
          ? { limit: 250, cursor: 'cursor-2', items: [{ id: 'asset-2' }] }
          : { limit: 250, items: [] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  }, runtime, OWNER.toBase58());
  assert.deepEqual(cursors, [undefined, 'cursor-1', 'cursor-2']);
  assert.deepEqual(assets.map((asset) => asset.id), ['asset-1', 'asset-2']);
});

test('IRL claim on-chain compatibility check rejects committed configuration drift', () => {
  const runtime = irlClaimTestHooks.buildRuntime(DROP);
  assert.equal(
    irlClaimTestHooks.validateOnchainConfig(runtime, ONCHAIN_CONFIG).toBase58(),
    COLLECTION.toBase58(),
  );
  assert.throws(
    () => irlClaimTestHooks.validateOnchainConfig(runtime, {
      ...ONCHAIN_CONFIG,
      maxSupply: ONCHAIN_CONFIG.maxSupply + 1,
    }),
    (error) => (error as { code?: unknown }).code === 'failed-precondition',
  );
  assert.throws(
    () => irlClaimTestHooks.validateOnchainConfig(runtime, {
      ...ONCHAIN_CONFIG,
      treasury: Keypair.generate().publicKey.toBytes(),
    }),
    (error) => (error as { code?: unknown }).code === 'failed-precondition',
  );
});

test('IRL claim transaction builder uses the delivery lookup table when the static packet is oversized', async () => {
  const lookupKey = Keypair.generate().publicKey;
  const addresses = Array.from({ length: 40 }, (_, index) => testPublicKey(index + 100));
  const runtime = irlClaimTestHooks.buildRuntime({
    ...DROP,
    deliveryLookupTable: lookupKey.toBase58(),
  });
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
      { pubkey: COSIGNER.publicKey, isSigner: true, isWritable: false },
      ...addresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from([1]),
  });
  let lookupLoads = 0;
  const raw = await irlClaimTestHooks.buildPreparedTransaction({
    context: {
      apiKey: 'helius-key',
      signal: new AbortController().signal,
      providerFetch: async () => {
        throw new Error('unexpected provider fetch');
      },
    },
    runtime,
    instructions: [instruction],
    owner: OWNER,
    cosigner: COSIGNER,
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

test('IRL claim transaction builder maps an ineffective lookup table to a stable size error', async () => {
  const lookupKey = Keypair.generate().publicKey;
  const runtime = irlClaimTestHooks.buildRuntime({ ...DROP, deliveryLookupTable: lookupKey.toBase58() });
  const addresses = Array.from({ length: 70 }, (_, index) => testPublicKey(index + 200));
  const ineffectiveLookup = new AddressLookupTableAccount({
    key: lookupKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [testPublicKey(999)],
    },
  });
  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: OWNER, isSigner: true, isWritable: true },
      { pubkey: COSIGNER.publicKey, isSigner: true, isWritable: false },
      ...addresses.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from([1]),
  });
  await assert.rejects(
    () => irlClaimTestHooks.buildPreparedTransaction({
      context: {
        apiKey: 'helius-key',
        signal: new AbortController().signal,
        providerFetch: async () => {
          throw new Error('unexpected provider fetch');
        },
      },
      runtime,
      instructions: [instruction],
      owner: OWNER,
      cosigner: COSIGNER,
      blockhash: BLOCKHASH,
      loadLookupTable: async () => [ineffectiveLookup],
    }),
    (error) => (error as { code?: unknown }).code === 'failed-precondition',
  );
});

test('IRL claim handler enforces exact bounded requests and method handling', async () => {
  const wrongMethod = await handleIrlClaimPrepare(
    new Request(`https://api.mons.shop${IRL_CLAIM_PREPARE_PATH}`),
    env(),
    dependencies(),
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'POST, OPTIONS');

  for (const invalid of [
    new Request(`https://api.mons.shop${IRL_CLAIM_PREPARE_PATH}`, { method: 'POST', body: '{}' }),
    request({ owner: OWNER.toBase58(), code: '1234567890', extra: true }),
    request({ owner: OWNER.toBase58(), code: 'abc1234567890' }),
    request({ owner: OWNER.toBase58(), code: '1'.repeat(2048) }),
  ]) {
    const result = await handleIrlClaimPrepare(invalid, env(), dependencies());
    assert.equal(result.response.status, 400);
    assert.equal(result.authOutcome, 'rejected');
  }
});

test('IRL claim handler rejects authentication and wallet-session mismatches', async () => {
  const unauthenticated = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({
      verifyIdentity: async () => {
        throw new RequestIdentityError('invalid-token');
      },
    }),
  );
  assert.equal(unauthenticated.response.status, 401);
  assert.equal((await unauthenticated.response.json() as { error: { code: string } }).error.code, 'unauthenticated');

  const mismatch = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({ loadWalletSession: async () => Keypair.generate().publicKey.toBase58() }),
  );
  assert.equal(mismatch.response.status, 403);
  assert.equal((await mismatch.response.json() as { error: { code: string } }).error.code, 'permission-denied');
});

test('IRL claim handler preserves missing and legacy claim resolution outcomes', async () => {
  const missing = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({ loadClaim: async () => null }),
  );
  assert.equal(missing.response.status, 404);

  const legacy = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({
      loadClaim: async () => ({ boxId: 7, dudeIds: [1, 2, 3] }),
      resolveLegacyDropIds: async () => [DROP_ID],
    }),
  );
  assert.equal(legacy.response.status, 200);

  const ambiguous = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({
      loadClaim: async () => ({ boxId: 7, dudeIds: [1, 2, 3] }),
      resolveLegacyDropIds: async () => [DROP_ID, 'other_drop'],
    }),
  );
  assert.equal(ambiguous.response.status, 409);
});

test('IRL claim handler rejects already-used, invalid proof, and cosigner mismatch states', async () => {
  const alreadyUsed = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({
      fetchOwnedAssets: async () => [
        certificateAsset(),
        certificateAsset({
          id: Keypair.generate().publicKey.toBase58(),
          content: { metadata: { attributes: [
            { trait_type: 'type', value: 'certificate' },
            { trait_type: 'dude_id', value: 1 },
          ] } },
        }),
      ],
    }),
  );
  assert.equal(alreadyUsed.response.status, 409);
  assert.match(JSON.stringify(await alreadyUsed.response.json()), /already been used/);

  const wrongTree = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({
      fetchAssetProof: async () => ({
        tree_id: Keypair.generate().publicKey.toBase58(),
        root: HASH,
        proof: [],
      }),
    }),
  );
  assert.equal(wrongTree.response.status, 409);

  const wrongCosigner = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    { ...env(), COSIGNER_SECRET: bs58.encode(Keypair.generate().secretKey) },
    dependencies(),
  );
  assert.equal(wrongCosigner.response.status, 409);
  const wrongCosignerBody = JSON.stringify(await wrongCosigner.response.json());
  assert.equal(wrongCosignerBody.includes(env().COSIGNER_SECRET), false);
});

test('IRL claim handler returns a stable deadline error', async () => {
  const timedOut = await handleIrlClaimPrepare(
    request({ owner: OWNER.toBase58(), code: '1234567890' }),
    env(),
    dependencies({
      timeoutMs: 5,
      verifyIdentity: async (_authorization: string | null, _fetch: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(signal.reason);
          signal.addEventListener('abort', fail, { once: true });
          if (signal.aborted) fail();
        }),
    }),
  );
  assert.equal(timedOut.response.status, 504);
  assert.equal((await timedOut.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});
