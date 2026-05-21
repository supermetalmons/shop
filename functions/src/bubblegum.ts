import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const IX_BUBBLEGUM_TRANSFER_V2 = Buffer.from([119, 40, 6, 235, 234, 221, 248, 49]);

function u32LE(value: number): Buffer {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff_ffff) throw new Error('Invalid u32 value');
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Math.floor(n), 0);
  return buf;
}

function u64LE(value: number): Buffer {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid u64 value');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)), 0);
  return buf;
}

function borshOption(inner?: Buffer | null): Buffer {
  return inner ? Buffer.concat([Buffer.from([1]), inner]) : Buffer.from([0]);
}

function assertBytes32(value: Buffer | Uint8Array, label: string): Buffer {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buf.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return buf;
}

export function encodeBubblegumTransferV2Args(args: {
  root: Buffer | Uint8Array;
  dataHash: Buffer | Uint8Array;
  creatorHash: Buffer | Uint8Array;
  assetDataHash?: Buffer | Uint8Array | null;
  flags?: number | null;
  nonce: number;
  index: number;
}): Buffer {
  const assetDataHash = args.assetDataHash ? assertBytes32(args.assetDataHash, 'assetDataHash') : null;
  const flagsNum = args.flags == null ? null : Number(args.flags);
  if (flagsNum != null && (!Number.isFinite(flagsNum) || flagsNum < 0 || flagsNum > 0xff)) {
    throw new Error('flags must be a u8');
  }
  return Buffer.concat([
    IX_BUBBLEGUM_TRANSFER_V2,
    assertBytes32(args.root, 'root'),
    assertBytes32(args.dataHash, 'dataHash'),
    assertBytes32(args.creatorHash, 'creatorHash'),
    borshOption(assetDataHash),
    borshOption(flagsNum == null ? null : Buffer.from([flagsNum & 0xff])),
    u64LE(args.nonce),
    u32LE(args.index),
  ]);
}

export function bubblegumTransferV2Ix(args: {
  bubblegumProgramId: PublicKey;
  mplNoopProgramId: PublicKey;
  mplAccountCompressionProgramId: PublicKey;
  treeConfig: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  newLeafOwner: PublicKey;
  merkleTree: PublicKey;
  coreCollection: PublicKey;
  root: Buffer | Uint8Array;
  dataHash: Buffer | Uint8Array;
  creatorHash: Buffer | Uint8Array;
  assetDataHash?: Buffer | Uint8Array | null;
  flags?: number | null;
  nonce: number;
  index: number;
  proof: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.bubblegumProgramId,
    keys: [
      { pubkey: args.treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.leafOwner, isSigner: false, isWritable: false },
      { pubkey: args.leafDelegate, isSigner: false, isWritable: false },
      { pubkey: args.newLeafOwner, isSigner: false, isWritable: false },
      { pubkey: args.merkleTree, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: args.mplNoopProgramId, isSigner: false, isWritable: false },
      { pubkey: args.mplAccountCompressionProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...args.proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: encodeBubblegumTransferV2Args(args),
  });
}
