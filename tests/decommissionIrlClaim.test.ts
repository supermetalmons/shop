import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { decommissionFirebasePrepareIrlClaim } from '../scripts/decommission-firebase-prepare-irl-claim.ts';

const OWNER = Keypair.generate();
const COSIGNER = Keypair.generate();
const VERSION = '72bfa410-5c85-4e3c-b1e0-5ce0cfdb1108';

function preparedResponse() {
  const instruction = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [
      { pubkey: OWNER.publicKey, isSigner: true, isWritable: true },
      { pubkey: COSIGNER.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: OWNER.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message());
  transaction.sign([COSIGNER]);
  return {
    encodedTx: Buffer.from(transaction.serialize()).toString('base64'),
    dropId: 'card_nft_2',
    certificates: [1, 2, 3],
    certificateId: Keypair.generate().publicKey.toBase58(),
    message: 'Sign and send.',
  };
}

function environment() {
  return {
    IRL_CLAIM_SMOKE_FIREBASE_TOKEN: 'firebase-token',
    IRL_CLAIM_SMOKE_OWNER: OWNER.publicKey.toBase58(),
    IRL_CLAIM_SMOKE_CODE: '1234567890',
    RETAINED_VALUE: 'retained',
  };
}

test('IRL claim decommission requires a valid authenticated production preparation', async () => {
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  await decommissionFirebasePrepareIrlClaim(environment(), {
    readManifest: () => ({
      currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
      approvedRollback: { apiVersionId: VERSION, frontendVersionId: VERSION },
    }),
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/claims/irl/prepare');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer firebase-token');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: OWNER.publicKey.toBase58(),
        code: '1234567890',
      });
      return Response.json(preparedResponse());
    },
    runFirebaseDelete: (value) => {
      childEnvironment = value;
    },
  });
  assert.equal(childEnvironment?.RETAINED_VALUE, 'retained');
  assert.equal(childEnvironment?.IRL_CLAIM_SMOKE_FIREBASE_TOKEN, undefined);
  assert.equal(childEnvironment?.IRL_CLAIM_SMOKE_OWNER, undefined);
  assert.equal(childEnvironment?.IRL_CLAIM_SMOKE_CODE, undefined);
});

test('IRL claim decommission rejects incompatible rollback metadata before smoke or deletion', async () => {
  let fetchCalled = false;
  let deleteCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareIrlClaim(environment(), {
      readManifest: () => ({
        currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
        approvedRollback: { apiVersionId: VERSION, frontendVersionId: 'd310f1bc-8ee3-4032-8360-ded742f2bec4' },
      }),
      fetch: async () => {
        fetchCalled = true;
        return Response.json(preparedResponse());
      },
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
    }),
    /Approved rollback/,
  );
  assert.equal(fetchCalled, false);
  assert.equal(deleteCalled, false);
});

test('IRL claim decommission rejects an invalid prepared transaction without deletion', async () => {
  let deleteCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareIrlClaim(environment(), {
      readManifest: () => ({
        currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
        approvedRollback: { apiVersionId: VERSION, frontendVersionId: VERSION },
      }),
      fetch: async () => Response.json({ ...preparedResponse(), encodedTx: 'invalid' }),
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
    }),
    /invalid transaction/,
  );
  assert.equal(deleteCalled, false);
});
