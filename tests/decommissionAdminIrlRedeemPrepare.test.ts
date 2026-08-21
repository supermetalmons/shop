import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getFunctionsDrop } from '../functions/src/config/deployment.ts';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../functions/src/shared/solanaProgramAddresses.ts';
import {
  adminIrlRedeemDecommissionTestHooks,
  decommissionFirebasePrepareAdminIrlRedeem,
  smokeAndCleanupAdminIrlRedeemPrepare,
} from '../scripts/decommission-firebase-prepare-admin-irl-redeem.ts';

const OWNER = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const DROP_ID = 'card_nft_2';
const ASSET = 'xLspeJ7C3RnSibBjAdPH8ae4ertRf4bNDqjN759V6rJ';
const REQUEST_ID = 'AbCdEfGhIjKlMnOpQrSt';
const ADMIN = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const CURRENT = {
  apiVersionId: '11111111-1111-4111-8111-111111111111',
  frontendVersionId: '22222222-2222-4222-8222-222222222222',
};

function environment(): NodeJS.ProcessEnv {
  return {
    ADMIN_IRL_REDEEM_PREPARE_SMOKE_FIREBASE_TOKEN: 'firebase-token',
    ADMIN_IRL_REDEEM_PREPARE_SMOKE_OWNER: OWNER,
    ADMIN_IRL_REDEEM_PREPARE_SMOKE_DROP_ID: DROP_ID,
    ADMIN_IRL_REDEEM_PREPARE_SMOKE_ITEM_IDS: JSON.stringify([ASSET]),
    CLOUDFLARE_API_TOKEN: 'cloudflare-token',
  };
}

function encodedTransaction(owner = OWNER): string {
  const config = getFunctionsDrop(DROP_ID)!;
  const ownerKey = new PublicKey(owner);
  const instruction = new TransactionInstruction({
    programId: new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
    keys: [
      { pubkey: new PublicKey(ASSET), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(config.collectionMint), isSigner: false, isWritable: false },
      { pubkey: ownerKey, isSigner: true, isWritable: true },
      { pubkey: ownerKey, isSigner: true, isWritable: false },
      { pubkey: ADMIN, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SPL_NOOP_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: ownerKey,
    recentBlockhash: BLOCKHASH,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
  }).compileToV0Message());
  return Buffer.from(transaction.serialize()).toString('base64');
}

function preparedFields(attemptId: string) {
  return {
    adminWallet: ADMIN.toBase58(),
    createdAt: 1_700_000_000_000,
    dropId: DROP_ID,
    itemIds: [ASSET],
    items: [{ assetId: ASSET, kind: 'box', refId: 674 }],
    owner: OWNER,
    prepareAttemptId: attemptId,
    preparedExpiresAt: 1_700_604_800_000,
    status: 'prepared',
    targetKind: 'pack',
    updatedAt: 1_700_000_000_000,
  };
}

test('Admin IRL smoke validates the route, document, transaction, simulation, and cleanup', async () => {
  let attemptId = '';
  let deleted: { path: string; updateTime: string } | undefined;
  let simulated = false;
  await smokeAndCleanupAdminIrlRedeemPrepare(environment(), {
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/admin/irl-redeem/prepare');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer firebase-token');
      attemptId = headers.get('x-mons-admin-irl-redeem-prepare-attempt') || '';
      assert.match(attemptId, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: OWNER,
        dropId: DROP_ID,
        itemIds: [ASSET],
      });
      return Response.json({
        encodedTx: encodedTransaction(),
        requestId: REQUEST_ID,
        dropId: DROP_ID,
        adminWallet: ADMIN.toBase58(),
        itemCount: 1,
        targetKind: 'pack',
      });
    },
    loadPreparedDocument: async () => ({
      fields: preparedFields(attemptId),
      updateTime: '2026-08-21T00:00:00.000Z',
    }),
    deletePreparedDocument: async (_credential, path, updateTime) => {
      deleted = { path, updateTime };
    },
    readWriterCredential: () => 'credential',
    simulatePreparedTransaction: async (_fetch, encodedTx, cluster) => {
      assert.equal(encodedTx, encodedTransaction());
      assert.equal(cluster, 'mainnet-beta');
      simulated = true;
    },
  });
  assert.equal(simulated, true);
  assert.deepEqual(deleted, {
    path: `drops/${DROP_ID}/adminIrlRedeemRequests/${REQUEST_ID}`,
    updateTime: '2026-08-21T00:00:00.000Z',
  });
});

test('Admin IRL smoke always cleans up after post-write validation failure', async () => {
  let attemptId = '';
  let deleted = false;
  await assert.rejects(
    smokeAndCleanupAdminIrlRedeemPrepare(environment(), {
      fetch: async (_input, init) => {
        attemptId = new Headers(init?.headers).get('x-mons-admin-irl-redeem-prepare-attempt') || '';
        return Response.json({
          encodedTx: encodedTransaction(),
          requestId: REQUEST_ID,
          dropId: DROP_ID,
          adminWallet: ADMIN.toBase58(),
          itemCount: 1,
          targetKind: 'pack',
        });
      },
      loadPreparedDocument: async () => ({
        fields: preparedFields(attemptId),
        updateTime: '2026-08-21T00:00:00.000Z',
      }),
      deletePreparedDocument: async () => {
        deleted = true;
      },
      readWriterCredential: () => 'credential',
      simulatePreparedTransaction: async () => {
        throw new Error('simulation failed');
      },
    }),
    /simulation failed/,
  );
  assert.equal(deleted, true);
});

test('Admin IRL decommission requires an approved live pair and strips credentials before deletion', async () => {
  let liveReads = 0;
  let attemptId = '';
  let deletedEnvironment: NodeJS.ProcessEnv | undefined;
  await decommissionFirebasePrepareAdminIrlRedeem(environment(), {
    readManifest: () => ({ currentProduction: CURRENT, approvedRollback: CURRENT }),
    readLiveReleasePair: () => {
      liveReads += 1;
      return CURRENT;
    },
    fetch: async (_input, init) => {
      attemptId = new Headers(init?.headers).get('x-mons-admin-irl-redeem-prepare-attempt') || '';
      return Response.json({
        encodedTx: encodedTransaction(),
        requestId: REQUEST_ID,
        dropId: DROP_ID,
        adminWallet: ADMIN.toBase58(),
        itemCount: 1,
        targetKind: 'pack',
      });
    },
    loadPreparedDocument: async () => ({
      fields: preparedFields(attemptId),
      updateTime: '2026-08-21T00:00:00.000Z',
    }),
    deletePreparedDocument: async () => undefined,
    simulatePreparedTransaction: async () => undefined,
    runFirebaseDelete: (childEnvironment) => {
      deletedEnvironment = childEnvironment;
    },
    readWriterCredential: () => 'credential',
  });
  assert.equal(liveReads, 2);
  assert.ok(deletedEnvironment);
  assert.equal(deletedEnvironment.ADMIN_IRL_REDEEM_PREPARE_SMOKE_FIREBASE_TOKEN, undefined);
  assert.equal(deletedEnvironment.ADMIN_IRL_REDEEM_PREPARE_SMOKE_OWNER, undefined);
  assert.equal(deletedEnvironment.ADMIN_IRL_REDEEM_PREPARE_SMOKE_DROP_ID, undefined);
  assert.equal(deletedEnvironment.ADMIN_IRL_REDEEM_PREPARE_SMOKE_ITEM_IDS, undefined);
  assert.equal(deletedEnvironment.CLOUDFLARE_API_TOKEN, undefined);

  await assert.rejects(
    decommissionFirebasePrepareAdminIrlRedeem(environment(), {
      readManifest: () => ({
        currentProduction: CURRENT,
        approvedRollback: { ...CURRENT, apiVersionId: '33333333-3333-4333-8333-333333333333' },
      }),
    }),
    /Approved rollback still references a pre-cutover release pair/,
  );
});

test('Admin IRL smoke validators reject altered transactions and documents', () => {
  const payload = {
    encodedTx: encodedTransaction(Keypair.generate().publicKey.toBase58()),
    requestId: REQUEST_ID,
    dropId: DROP_ID,
    adminWallet: ADMIN.toBase58(),
    itemCount: 1,
    targetKind: 'pack' as const,
  };
  assert.throws(
    () => adminIrlRedeemDecommissionTestHooks.validatePreparedTransaction(payload, {
      owner: OWNER,
      itemIds: [ASSET],
    }),
    /signer state/,
  );
  assert.throws(
    () => adminIrlRedeemDecommissionTestHooks.validatePreparedDocument({
      fields: { ...preparedFields('attempt'), status: 'processing' },
      updateTime: '2026-08-21T00:00:00.000Z',
    }, {
      requestId: REQUEST_ID,
      dropId: DROP_ID,
      owner: OWNER,
      adminWallet: ADMIN.toBase58(),
      itemIds: [ASSET],
      prepareAttemptId: 'attempt',
    }),
    /did not match/,
  );
});
