import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { decommissionFirebasePrepareReceiptTransfer } from '../scripts/decommission-firebase-prepare-receipt-transfer.ts';

const OWNER = Keypair.generate();
const DESTINATION = Keypair.generate();
const ASSET = Keypair.generate();
const VERSION = '72bfa410-5c85-4e3c-b1e0-5ce0cfdb1108';

function preparedResponse() {
  const instruction = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [
      { pubkey: OWNER.publicKey, isSigner: true, isWritable: true },
      { pubkey: DESTINATION.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: OWNER.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message());
  return {
    encodedTx: Buffer.from(transaction.serialize()).toString('base64'),
    dropId: 'card_nft_2',
    certificateId: ASSET.publicKey.toBase58(),
  };
}

function environment() {
  return {
    RECEIPT_TRANSFER_SMOKE_FIREBASE_TOKEN: 'firebase-token',
    RECEIPT_TRANSFER_SMOKE_OWNER: OWNER.publicKey.toBase58(),
    RECEIPT_TRANSFER_SMOKE_DROP_ID: 'card_nft_2',
    RECEIPT_TRANSFER_SMOKE_ASSET_ID: ASSET.publicKey.toBase58(),
    RECEIPT_TRANSFER_SMOKE_DESTINATION: DESTINATION.publicKey.toBase58(),
    RETAINED_VALUE: 'retained',
  };
}

test('receipt transfer decommission requires a valid authenticated production preparation', async () => {
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  await decommissionFirebasePrepareReceiptTransfer(environment(), {
    readManifest: () => ({
      currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
      approvedRollback: { apiVersionId: VERSION, frontendVersionId: VERSION },
    }),
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/receipts/transfer/prepare');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer firebase-token');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: OWNER.publicKey.toBase58(),
        dropId: 'card_nft_2',
        receiptAssetId: ASSET.publicKey.toBase58(),
        destination: DESTINATION.publicKey.toBase58(),
      });
      return Response.json(preparedResponse());
    },
    runFirebaseDelete: (value) => {
      childEnvironment = value;
    },
  });
  assert.equal(childEnvironment?.RETAINED_VALUE, 'retained');
  assert.equal(childEnvironment?.RECEIPT_TRANSFER_SMOKE_FIREBASE_TOKEN, undefined);
  assert.equal(childEnvironment?.RECEIPT_TRANSFER_SMOKE_OWNER, undefined);
  assert.equal(childEnvironment?.RECEIPT_TRANSFER_SMOKE_DROP_ID, undefined);
  assert.equal(childEnvironment?.RECEIPT_TRANSFER_SMOKE_ASSET_ID, undefined);
  assert.equal(childEnvironment?.RECEIPT_TRANSFER_SMOKE_DESTINATION, undefined);
});

test('receipt transfer decommission rejects incompatible rollback metadata before smoke or deletion', async () => {
  let fetchCalled = false;
  let deleteCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareReceiptTransfer(environment(), {
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

test('receipt transfer decommission rejects signed or malformed transactions without deletion', async () => {
  for (const response of [
    { ...preparedResponse(), encodedTx: 'invalid' },
    (() => {
      const value = preparedResponse();
      const transaction = VersionedTransaction.deserialize(Buffer.from(value.encodedTx, 'base64'));
      transaction.sign([OWNER]);
      return { ...value, encodedTx: Buffer.from(transaction.serialize()).toString('base64') };
    })(),
  ]) {
    let deleteCalled = false;
    await assert.rejects(
      () => decommissionFirebasePrepareReceiptTransfer(environment(), {
        readManifest: () => ({
          currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
          approvedRollback: { apiVersionId: VERSION, frontendVersionId: VERSION },
        }),
        fetch: async () => Response.json(response),
        runFirebaseDelete: () => {
          deleteCalled = true;
        },
      }),
      /invalid transaction|signer state/,
    );
    assert.equal(deleteCalled, false);
  }
});
