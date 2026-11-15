import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.ts';
import { DeliveryReceiptError, mintReceiptsInstruction, runtimeForDrop } from '../src/deliveryReceiptOnchain.ts';
import { irlClaimTestHooks } from '../src/irlClaim.ts';

const key = (value: number) => new PublicKey(new Uint8Array(32).fill(value));
const runtime = {
  ...runtimeForDrop('card_nft_2'),
  boxMinterProgramId: key(1),
  boxMinterConfigPda: key(2),
  receiptsMerkleTree: key(3),
  receiptsTreeCanopyDepth: 0,
  maxDudeId: 0xffff,
};
const signer = key(4);
const recipient = key(5);
const coreCollection = key(6);
const treeConfig = PublicKey.findProgramAddressSync(
  [runtime.receiptsMerkleTree.toBuffer()], new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS),
)[0];

function assertMintInstruction(instruction: TransactionInstruction, dataHex: string): void {
  assert.equal(instruction.programId.toBase58(), runtime.boxMinterProgramId.toBase58());
  assert.equal(instruction.data.toString('hex'), dataHex);
  assert.deepEqual(instruction.keys.map(({ pubkey, isSigner, isWritable }) =>
    [pubkey.toBase58(), isSigner, isWritable]), [
    [runtime.boxMinterConfigPda.toBase58(), false, false],
    [signer.toBase58(), true, true],
    [recipient.toBase58(), false, false],
    [runtime.receiptsMerkleTree.toBase58(), false, true],
    [treeConfig.toBase58(), false, true],
    [coreCollection.toBase58(), false, true],
    [BUBBLEGUM_PROGRAM_ADDRESS, false, false],
    [MPL_NOOP_PROGRAM_ADDRESS, false, false],
    [MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, false, false],
    [MPL_CORE_PROGRAM_ADDRESS, false, false],
    [MPL_CORE_CPI_SIGNER_ADDRESS, false, false],
    [SystemProgram.programId.toBase58(), false, false],
  ]);
}

test('delivery receipt mint preserves mixed box/figure ABI bytes and account privileges', () => {
  assertMintInstruction(mintReceiptsInstruction({
    runtime, signer, recipient, coreCollection, boxIds: [1, 0xffff_ffff], dudeIds: [1, 0xffff],
  }), 'c7c2556f92996a770200000001000000ffffffff020000000100ffff');
});

test('IRL and delivery figure receipt mints preserve the same ABI and account privileges', () => {
  const expected = 'c7c2556f92996a7700000000020000000100ffff';
  assertMintInstruction(irlClaimTestHooks.mintReceiptsInstruction(runtime, signer, recipient, coreCollection, [1, 0xffff]), expected);
  assertMintInstruction(mintReceiptsInstruction({
    runtime, signer, recipient, coreCollection, boxIds: [], dudeIds: [1, 0xffff],
  }), expected);
});

test('delivery receipt mint preserves box-first validation and figure bounds', () => {
  assert.throws(() => mintReceiptsInstruction({
    runtime, signer, recipient, coreCollection, boxIds: [0], dudeIds: [0],
  }), (error) => error instanceof DeliveryReceiptError && error.code === 'invalid-argument' && error.message === 'Invalid box id: 0');
  assert.throws(() => mintReceiptsInstruction({
    runtime, signer, recipient, coreCollection, boxIds: [1], dudeIds: [0x1_0000],
  }), (error) => error instanceof DeliveryReceiptError && error.code === 'invalid-argument' && error.message === 'Invalid figure id: 65536');
});

for (const includeOptions of [false, true]) {
  test(`IRL receipt burn preserves ABI bytes and account privileges with options ${includeOptions ? 'present' : 'absent'}`, () => {
    const delegate = key(7);
    const proofAccounts = [key(9), key(10)];
    const instruction = irlClaimTestHooks.burnInstruction(recipient, coreCollection, {
      merkleTree: runtime.receiptsMerkleTree,
      root: Buffer.alloc(32, 1),
      dataHash: Buffer.alloc(32, 2),
      creatorHash: Buffer.alloc(32, 3),
      assetDataHash: includeOptions ? Buffer.alloc(32, 4) : null,
      flags: includeOptions ? 1 : null,
      nonce: 12,
      index: 12,
      proofAccounts,
      leafOwner: recipient,
      leafDelegate: delegate,
    });
    assert.equal(instruction.programId.toBase58(), BUBBLEGUM_PROGRAM_ADDRESS);
    assert.equal(instruction.data.toString('hex'),
      '73d222f0e88fb710' + '01'.repeat(32) + '02'.repeat(32) + '03'.repeat(32) +
      (includeOptions ? '01' + '04'.repeat(32) + '0101' : '0000') + '0c000000000000000c000000');
    assert.deepEqual(instruction.keys.map(({ pubkey, isSigner, isWritable }) =>
      [pubkey.toBase58(), isSigner, isWritable]), [
      [treeConfig.toBase58(), false, true],
      [recipient.toBase58(), true, true],
      [recipient.toBase58(), true, false],
      [recipient.toBase58(), false, false],
      [delegate.toBase58(), false, false],
      [runtime.receiptsMerkleTree.toBase58(), false, true],
      [coreCollection.toBase58(), false, true],
      [MPL_CORE_CPI_SIGNER_ADDRESS, false, false],
      [MPL_NOOP_PROGRAM_ADDRESS, false, false],
      [MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, false, false],
      [MPL_CORE_PROGRAM_ADDRESS, false, false],
      [SystemProgram.programId.toBase58(), false, false],
      ...proofAccounts.map((pubkey) => [pubkey.toBase58(), false, false]),
    ]);
  });
}
