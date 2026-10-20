import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { bubblegumMintV2Ix } from '../../cloud/workers/api/src/bubblegum.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS,
} from '../../shared/solanaProgramAddresses.ts';

export const BINDER_ISSUANCE_ID = 'card-nft-binder-packing-2026-10-20';
export const BINDER_ISSUANCE_AUTHORITY = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
export const BINDER_ISSUANCE_COLLECTION = '57rWZEQFtgsWf846fu9VjA89TkMkbmgbUvmqc8z56WLD';
export const BINDER_ISSUANCE_TREE = 'A84bJxATE2V1S3Gsr2VVoqLpitmfAGCXt7BAgLKp5QCF';
export const BINDER_ISSUANCE_RECEIPT_IDS = [21, 22] as const;

export function binderReceiptMetadataUri(receiptId: number): string {
  if (receiptId !== 21 && receiptId !== 22) throw new Error('This issuance is restricted to binder receipts 21 and 22.');
  return `https://cdn.lil.org/nft/card_nft_binder/json/rb${receiptId}.json`;
}

export function buildBinderReceiptMintTransaction(blockhash: string): VersionedTransaction {
  const authority = new PublicKey(BINDER_ISSUANCE_AUTHORITY);
  const tree = new PublicKey(BINDER_ISSUANCE_TREE);
  const bubblegum = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
  const treeConfig = PublicKey.findProgramAddressSync([tree.toBuffer()], bubblegum)[0];
  new PublicKey(blockhash);
  const instructions = BINDER_ISSUANCE_RECEIPT_IDS.map(receiptId => bubblegumMintV2Ix({
    bubblegumProgramId: bubblegum,
    mplNoopProgramId: new PublicKey(MPL_NOOP_PROGRAM_ADDRESS),
    mplAccountCompressionProgramId: new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS),
    mplCoreProgramId: new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
    mplCoreCpiSigner: new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS),
    treeConfig, payer: authority, treeCreatorOrDelegate: authority, collectionAuthority: authority,
    leafOwner: authority, leafDelegate: authority, merkleTree: tree,
    coreCollection: new PublicKey(BINDER_ISSUANCE_COLLECTION),
    name: `receipt · binder ${receiptId}`, symbol: 'receipts', uri: binderReceiptMetadataUri(receiptId),
  }));
  return new VersionedTransaction(new TransactionMessage({
    payerKey: authority, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions],
  }).compileToV0Message());
}

export function validateSignedBinderReceiptMint(transactionBase64: string, blockhash: string): {
  transaction: VersionedTransaction;
  signature: string;
} {
  const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  const expected = buildBinderReceiptMintTransaction(blockhash);
  if (transaction.signatures.length !== 1 || transaction.message.header.numRequiredSignatures !== 1 ||
    Buffer.from(transaction.serialize()).toString('base64') !== transactionBase64 ||
    !Buffer.from(transaction.message.serialize()).equals(Buffer.from(expected.message.serialize())) ||
    !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0],
      new PublicKey(BINDER_ISSUANCE_AUTHORITY).toBytes())) {
    throw new Error('Signed transaction does not match the authorized two-receipt issuance.');
  }
  return { transaction, signature: bs58.encode(transaction.signatures[0]) };
}
