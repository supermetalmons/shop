import bs58 from 'bs58';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { IX_BUBBLEGUM_TRANSFER_V2 } from './bubblegum.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';

const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);

export type TransferParties = {
  sender: string;
  recipient: string;
  collection: PublicKey;
};

export function transactionAccountKeys(transaction: VersionedTransactionResponse): PublicKey[] {
  const keys = transaction.transaction.message.getAccountKeys({
    accountKeysFromLookups: transaction.meta?.loadedAddresses,
  });
  return [
    ...keys.staticAccountKeys,
    ...(keys.accountKeysFromLookups?.writable || []),
    ...(keys.accountKeysFromLookups?.readonly || []),
  ];
}

function instructionAccounts(instruction: { accountKeyIndexes: Uint8Array | number[] }, keys: PublicKey[]): PublicKey[] {
  return Array.from(instruction.accountKeyIndexes).map((index) => keys[index]).filter((key): key is PublicKey => Boolean(key));
}

function instructionData(instruction: { data: string | Uint8Array }): Buffer {
  return typeof instruction.data === 'string'
    ? Buffer.from(bs58.decode(instruction.data))
    : Buffer.from(instruction.data);
}

export function coreTransferAssetIds(
  transaction: VersionedTransactionResponse,
  expected: TransferParties,
): string[] {
  const keys = transactionAccountKeys(transaction);
  const transferred: string[] = [];
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    if (!keys[instruction.programIdIndex]?.equals(MPL_CORE_PROGRAM_ID)) continue;
    const data = instructionData(instruction);
    if (data[0] !== 14 || data[1] !== 0) continue;
    const accounts = instructionAccounts(instruction, keys);
    if (
      accounts.length >= 7 && accounts[1]?.equals(expected.collection) &&
      accounts[2]?.toBase58() === expected.sender && accounts[3]?.toBase58() === expected.sender &&
      accounts[4]?.toBase58() === expected.recipient
    ) transferred.push(accounts[0].toBase58());
  }
  return transferred;
}

export function matchingReceiptTransferCount(
  transaction: VersionedTransactionResponse,
  expected: TransferParties & { merkleTree: PublicKey },
): number {
  const keys = transactionAccountKeys(transaction);
  let matches = 0;
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    if (!keys[instruction.programIdIndex]?.equals(BUBBLEGUM_PROGRAM_ID)) continue;
    const data = instructionData(instruction);
    if (!data.subarray(0, IX_BUBBLEGUM_TRANSFER_V2.length).equals(IX_BUBBLEGUM_TRANSFER_V2)) continue;
    const accounts = instructionAccounts(instruction, keys);
    const [, payer, authority, leafOwner, , newOwner, merkleTree, collection] = accounts;
    if (
      accounts.length >= 8 && payer?.toBase58() === expected.sender && authority?.toBase58() === expected.sender &&
      leafOwner?.toBase58() === expected.sender && newOwner?.toBase58() === expected.recipient &&
      merkleTree?.equals(expected.merkleTree) && collection?.equals(expected.collection)
    ) matches += 1;
  }
  return matches;
}

export function bubblegumReceiptAssetIds(transaction: VersionedTransactionResponse): string[] {
  const keys = transactionAccountKeys(transaction);
  const assetIds = new Set<string>();
  for (const group of transaction.meta?.innerInstructions || []) {
    for (const instruction of group.instructions) {
      const program = keys[instruction.programIdIndex];
      if (!program?.equals(MPL_NOOP_PROGRAM_ID)) continue;
      const data = instructionData(instruction);
      if (
        data.length < 41 || data[0] !== 1 || data[1] !== 0 ||
        data.readUInt32LE(2) !== data.length - 6 || data[6] !== 1 || data[7] !== 1 || data[8] !== 1
      ) continue;
      assetIds.add(new PublicKey(data.subarray(9, 41)).toBase58());
    }
  }
  return [...assetIds];
}
