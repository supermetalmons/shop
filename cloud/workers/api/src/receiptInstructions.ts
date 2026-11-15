import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';

const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

function u16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

export function buildMintReceiptsInstruction(args: {
  programId: PublicKey;
  configPda: PublicKey;
  receiptsMerkleTree: PublicKey;
  signer: PublicKey;
  recipient: PublicKey;
  coreCollection: PublicKey;
  boxIds: readonly number[];
  dudeIds: readonly number[];
}): TransactionInstruction {
  const treeConfig = PublicKey.findProgramAddressSync(
    [args.receiptsMerkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID,
  )[0];
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.configPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: false },
      { pubkey: args.receiptsMerkleTree, isSigner: false, isWritable: true },
      { pubkey: treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX_MINT_RECEIPTS,
      u32LE(args.boxIds.length),
      ...args.boxIds.map(u32LE),
      u32LE(args.dudeIds.length),
      ...args.dudeIds.map(u16LE),
    ]),
  });
}
