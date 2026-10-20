import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionMessage } from '@solana/web3.js';
import {
  BINDER_ISSUANCE_AUTHORITY, BINDER_ISSUANCE_COLLECTION, BINDER_ISSUANCE_TREE,
  binderReceiptMetadataUri, buildBinderReceiptMintTransaction, validateSignedBinderReceiptMint,
} from '../scripts/shared/binderReceiptIssuanceOnchain.ts';
import { IX_BUBBLEGUM_MINT_V2 } from '../cloud/workers/api/src/bubblegum.ts';

const blockhash = '11111111111111111111111111111111';

test('replacement transaction mints exactly receipts 21 and 22 into the existing pool', () => {
  const transaction = buildBinderReceiptMintTransaction(blockhash);
  assert.ok(transaction.serialize().length <= 1232);
  const message = TransactionMessage.decompile(transaction.message);
  assert.equal(message.payerKey.toBase58(), BINDER_ISSUANCE_AUTHORITY);
  assert.equal(message.instructions.length, 3);
  assert.equal(transaction.message.header.numRequiredSignatures, 1);
  for (const [index, instruction] of message.instructions.slice(1).entries()) {
    assert.deepEqual(instruction.data.subarray(0, 8), IX_BUBBLEGUM_MINT_V2);
    assert.ok(instruction.data.includes(Buffer.from(binderReceiptMetadataUri(21 + index))));
    assert.equal(instruction.keys[4].pubkey.toBase58(), BINDER_ISSUANCE_AUTHORITY);
    assert.equal(instruction.keys[6].pubkey.toBase58(), BINDER_ISSUANCE_TREE);
    assert.equal(instruction.keys[7].pubkey.toBase58(), BINDER_ISSUANCE_COLLECTION);
    assert.deepEqual(instruction.keys.filter(key => key.isSigner).map(key => key.pubkey.toBase58()),
      [BINDER_ISSUANCE_AUTHORITY, BINDER_ISSUANCE_AUTHORITY, BINDER_ISSUANCE_AUTHORITY, BINDER_ISSUANCE_AUTHORITY, BINDER_ISSUANCE_AUTHORITY]);
  }
  assert.throws(() => binderReceiptMetadataUri(20));
  assert.throws(() => binderReceiptMetadataUri(23));
});

test('unsigned, wrong-authority and altered mint transactions cannot enter the submission journal', () => {
  const transaction = buildBinderReceiptMintTransaction(blockhash);
  assert.throws(() => validateSignedBinderReceiptMint(Buffer.from(transaction.serialize()).toString('base64'), blockhash));
  transaction.signatures[0] = new Uint8Array(64).fill(1);
  assert.throws(() => validateSignedBinderReceiptMint(Buffer.from(transaction.serialize()).toString('base64'), blockhash));
  assert.throws(() => validateSignedBinderReceiptMint(Buffer.from(transaction.serialize()).toString('base64'), Keypair.generate().publicKey.toBase58()));
});
