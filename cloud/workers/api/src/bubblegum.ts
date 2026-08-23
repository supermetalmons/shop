import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const IX_BUBBLEGUM_TRANSFER_V2 = Buffer.from([119, 40, 6, 235, 234, 221, 248, 49]);
export const IX_BUBBLEGUM_MINT_V2 = Buffer.from([120, 121, 23, 146, 173, 110, 199, 205]);
export const IX_BUBBLEGUM_BURN_V2 = Buffer.from([115, 210, 34, 240, 232, 143, 183, 16]);

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

function borshString(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(encoded.length), encoded]);
}

function assertBytes32(value: Buffer | Uint8Array, label: string): Buffer {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buf.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return buf;
}

export function encodeBubblegumMintV2Args(args: {
  name: string;
  symbol?: string;
  uri: string;
  coreCollection: PublicKey;
}): Buffer {
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(0, 0);
  return Buffer.concat([
    IX_BUBBLEGUM_MINT_V2,
    borshString(args.name),
    borshString(args.symbol || ''),
    borshString(args.uri),
    fee,
    Buffer.from([0, 1, 1, 0]),
    u32LE(0),
    Buffer.from([1]),
    args.coreCollection.toBuffer(),
    Buffer.from([0, 0]),
  ]);
}

export function bubblegumMintV2Ix(args: {
  bubblegumProgramId: PublicKey;
  mplNoopProgramId: PublicKey;
  mplAccountCompressionProgramId: PublicKey;
  mplCoreProgramId: PublicKey;
  mplCoreCpiSigner: PublicKey;
  treeConfig: PublicKey;
  payer: PublicKey;
  treeCreatorOrDelegate: PublicKey;
  collectionAuthority: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  merkleTree: PublicKey;
  coreCollection: PublicKey;
  name: string;
  symbol?: string;
  uri: string;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.bubblegumProgramId,
    keys: [
      { pubkey: args.treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.treeCreatorOrDelegate, isSigner: true, isWritable: false },
      { pubkey: args.collectionAuthority, isSigner: true, isWritable: false },
      { pubkey: args.leafOwner, isSigner: false, isWritable: false },
      { pubkey: args.leafDelegate, isSigner: false, isWritable: false },
      { pubkey: args.merkleTree, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: args.mplCoreCpiSigner, isSigner: false, isWritable: false },
      { pubkey: args.mplNoopProgramId, isSigner: false, isWritable: false },
      { pubkey: args.mplAccountCompressionProgramId, isSigner: false, isWritable: false },
      { pubkey: args.mplCoreProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeBubblegumMintV2Args(args),
  });
}

function encodeBubblegumTransferV2Args(args: {
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

function encodeBubblegumBurnV2Args(args: {
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
    IX_BUBBLEGUM_BURN_V2,
    assertBytes32(args.root, 'root'),
    assertBytes32(args.dataHash, 'dataHash'),
    assertBytes32(args.creatorHash, 'creatorHash'),
    borshOption(assetDataHash),
    borshOption(flagsNum == null ? null : Buffer.from([flagsNum & 0xff])),
    u64LE(args.nonce),
    u32LE(args.index),
  ]);
}

export function bubblegumBurnV2Ix(args: {
  bubblegumProgramId: PublicKey;
  mplNoopProgramId: PublicKey;
  mplAccountCompressionProgramId: PublicKey;
  mplCoreProgramId: PublicKey;
  mplCoreCpiSigner: PublicKey;
  treeConfig: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
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
      { pubkey: args.merkleTree, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: args.mplCoreCpiSigner, isSigner: false, isWritable: false },
      { pubkey: args.mplNoopProgramId, isSigner: false, isWritable: false },
      { pubkey: args.mplAccountCompressionProgramId, isSigner: false, isWritable: false },
      { pubkey: args.mplCoreProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...args.proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: encodeBubblegumBurnV2Args(args),
  });
}
