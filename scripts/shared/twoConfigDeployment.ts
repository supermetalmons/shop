import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses.ts';
import { IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1, mplCorePluginUpdateDelegate } from './mplCoreCollection.ts';

const CORE_PROGRAM = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
export type TwoConfigDeploymentCluster = 'devnet' | 'mainnet-beta';
export type TwoConfigDeploymentStep = 'delegates' | 'mint-config' | 'operations-config' | 'receipt-tree' | 'lookup-table';

export type TwoConfigDeploymentPlan = {
  version: 1;
  dropId: string;
  cluster: TwoConfigDeploymentCluster;
  authority: string;
  collection: string;
  programId: string;
  mintConfig: { configId: string; boxMinterConfigPda: string; maxSupply: number; itemsPerBox: 0 };
  operationsConfig: { configId: string; boxMinterConfigPda: string; maxSupply: number; itemsPerBox: 2 };
  receiptTree: { address: string; seed: string; space: number; maxDepth: 14; maxBufferSize: 64; canopyDepth: 0 };
  recipeSha256: string;
  manifestSha256: string;
};

export function buildTwoConfigDelegateUpdateInstruction(plan: TwoConfigDeploymentPlan, delegates: readonly string[]): TransactionInstruction {
  const union = [...new Set([...delegates, plan.mintConfig.boxMinterConfigPda, plan.operationsConfig.boxMinterConfigPda])];
  const authority = new PublicKey(plan.authority);
  return new TransactionInstruction({
    programId: CORE_PROGRAM,
    keys: [
      { pubkey: new PublicKey(plan.collection), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SPL_NOOP_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1]), mplCorePluginUpdateDelegate(union.map(value => new PublicKey(value)))]),
  });
}

export type TwoConfigJournalTransaction = {
  step: TwoConfigDeploymentStep;
  signature: string;
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  resources: string[];
  signedAt: string;
  status: 'signed' | 'finalized' | 'failed' | 'expired' | 'state-verified';
  finalizedSlot?: number;
};

export function validateTwoConfigJournalTransaction(entry: TwoConfigJournalTransaction, authority: string): VersionedTransaction {
  if (!['delegates', 'mint-config', 'operations-config', 'receipt-tree', 'lookup-table'].includes(entry.step) ||
    !['signed', 'finalized', 'failed', 'expired', 'state-verified'].includes(entry.status) ||
    !Number.isSafeInteger(entry.lastValidBlockHeight) || entry.lastValidBlockHeight < 0 ||
    !Array.isArray(entry.resources) || entry.resources.some(value => new PublicKey(value).toBase58() !== value) ||
    !Number.isFinite(Date.parse(entry.signedAt))) throw new Error('Invalid transaction journal entry.');
  const bytes = Buffer.from(entry.transactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(bytes);
  if (Buffer.from(transaction.serialize()).toString('base64') !== entry.transactionBase64 ||
    transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1 ||
    transaction.message.staticAccountKeys[0].toBase58() !== authority || transaction.message.recentBlockhash !== entry.blockhash ||
    bs58.encode(transaction.signatures[0]) !== entry.signature ||
    !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], new PublicKey(authority).toBytes())) {
    throw new Error('Journal transaction bytes or signature do not match the expected authority.');
  }
  return transaction;
}

export async function inspectTwoConfigJournalTransaction(connection: Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>,
  entry: TwoConfigJournalTransaction): Promise<{ status: 'finalized' | 'failed' | 'expired' | 'pending'; slot?: number }> {
  const read = () => connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true });
  let result = (await read()).value[0];
  if (result?.confirmationStatus === 'finalized') return { status: result.err ? 'failed' : 'finalized', slot: result.slot };
  if (result) return { status: 'pending' };
  if (await connection.getBlockHeight('finalized') <= entry.lastValidBlockHeight) return { status: 'pending' };
  result = (await read()).value[0];
  if (result?.confirmationStatus === 'finalized') return { status: result.err ? 'failed' : 'finalized', slot: result.slot };
  return { status: result ? 'pending' : 'expired' };
}
