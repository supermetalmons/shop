import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../shared/solanaProgramAddresses.ts';

export function buildCollectionUriUpdate(args: { collection: string; authority: string; uri: string }): TransactionInstruction {
  if (typeof args.uri !== 'string' || !args.uri.trim()) throw new Error('Collection URI is required.');
  const core = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
  const authority = new PublicKey(args.authority);
  const uri = Buffer.from(args.uri, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(uri.length);
  return new TransactionInstruction({ programId: core, keys: [
    { pubkey: new PublicKey(args.collection), isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: core, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: core, isSigner: false, isWritable: false },
  ], data: Buffer.concat([Buffer.from([16, 0, 1]), length, uri]) });
}

function assertTransaction(transaction: VersionedTransaction, authority: string): void {
  const message = transaction.message;
  if (message.version !== 0 || message.addressTableLookups.length || message.header.numRequiredSignatures !== 1 ||
    message.header.numReadonlySignedAccounts !== 0 || !message.staticAccountKeys[0]?.equals(new PublicKey(authority)) ||
    transaction.signatures.length !== 1 || transaction.signatures[0].length !== 64) {
    throw new Error('Transaction must use v0, no lookup tables, and the authority as its only signer and payer.');
  }
  const keys = message.staticAccountKeys;
  if (!message.compiledInstructions.length || new Set(keys.map(key => key.toBase58())).size !== keys.length ||
    message.header.numReadonlyUnsignedAccounts > keys.length - 1 ||
    message.compiledInstructions.some(instruction => instruction.programIdIndex >= keys.length ||
      instruction.accountKeyIndexes.some(index => index >= keys.length)) || transaction.serialize().length > 1232) {
    throw new Error('Transaction has invalid accounts, instructions, or size.');
  }
}

export function buildTransaction(authority: string, instructions: TransactionInstruction[], blockhash: string): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: new PublicKey(authority), recentBlockhash: blockhash, instructions,
  }).compileToV0Message());
  assertUnsignedTransaction(transaction, authority);
  return transaction;
}

export function assertUnsignedTransaction(transaction: VersionedTransaction, authority: string): void {
  assertTransaction(transaction, authority);
  if (transaction.signatures[0].some(byte => byte !== 0)) throw new Error('Transaction must be unsigned.');
}

export function assertSignedTransaction(transaction: VersionedTransaction, expectedMessage: Uint8Array, authority: string): string {
  assertTransaction(transaction, authority);
  const message = transaction.message.serialize();
  if (!Buffer.from(message).equals(Buffer.from(expectedMessage))) throw new Error('Signed transaction differs from the approved message.');
  if (!nacl.sign.detached.verify(message, transaction.signatures[0], new PublicKey(authority).toBytes())) {
    throw new Error('Transaction has an invalid authority signature.');
  }
  return bs58.encode(transaction.signatures[0]);
}
