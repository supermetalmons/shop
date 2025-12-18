import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { MintStats } from '../types';

const CONFIG_SEED = 'config';
const TE = new TextEncoder();
const utf8 = (value: string) => TE.encode(value);

// Anchor discriminators (sha256("global:<name>")[0..8]).
// Computed in-repo to avoid shipping Anchor in the browser.
const IX_MINT_BOXES = Uint8Array.from([0xa7, 0xe1, 0xd5, 0xb1, 0x52, 0x1d, 0x55, 0x66]);
const IX_DELIVER = Uint8Array.from([0xfa, 0x83, 0xde, 0x39, 0xd3, 0xe5, 0xd1, 0x93]);
const ACCOUNT_BOX_MINTER_CONFIG = Uint8Array.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]);

// Canonical program IDs (pulled from Metaplex/SPL sources).
export const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
export const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');

export interface BoxMinterConfigAccount {
  pubkey: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  merkleTree: PublicKey;
  collectionMint: PublicKey;
  collectionMetadata: PublicKey;
  collectionMasterEdition: PublicKey;
  priceLamports: bigint;
  maxSupply: number;
  maxPerTx: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  bump: number;
}

export type DeliverItemKind = 'box' | 'dude';

export interface DeliverItemInput {
  kind: DeliverItemKind;
  // Numeric id used for receipt metadata (box id or dude id).
  refId: number;
  // Bubblegum burn args:
  root: Uint8Array; // 32 bytes
  dataHash: Uint8Array; // 32 bytes
  creatorHash: Uint8Array; // 32 bytes
  nonce: bigint; // u64
  index: number; // u32
  // Truncated proof node pubkeys (each 32 bytes).
  proof: PublicKey[];
}

function requireEnvPubkey(name: string): PublicKey {
  const raw = (import.meta.env as any)?.[name] as string | undefined;
  const value = (raw || '').trim();
  if (!value) throw new Error(`Missing ${name}`);
  return new PublicKey(value);
}

export function boxMinterProgramId(): PublicKey {
  return requireEnvPubkey('VITE_BOX_MINTER_PROGRAM_ID');
}

export function boxMinterConfigPda(programId = boxMinterProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CONFIG_SEED)], programId);
}

function readU32(buf: Uint8Array, offset: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getUint32(offset, true);
}

function readU64(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getBigUint64(offset, true);
}

function readPubkey(buf: Uint8Array, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

function readBorshString(buf: Uint8Array, offset: number): { value: string; next: number } {
  const len = readU32(buf, offset);
  const start = offset + 4;
  const end = start + len;
  const value = new TextDecoder().decode(buf.subarray(start, end));
  return { value, next: end };
}

export function decodeBoxMinterConfigAccount(pubkey: PublicKey, data: Uint8Array): BoxMinterConfigAccount {
  if (data.length < 8) throw new Error('Invalid config account: empty');
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== ACCOUNT_BOX_MINTER_CONFIG[i]) {
      throw new Error('Invalid config account discriminator');
    }
  }

  let o = 8;
  const admin = readPubkey(data, o);
  o += 32;
  const treasury = readPubkey(data, o);
  o += 32;
  const merkleTree = readPubkey(data, o);
  o += 32;
  const collectionMint = readPubkey(data, o);
  o += 32;
  const collectionMetadata = readPubkey(data, o);
  o += 32;
  const collectionMasterEdition = readPubkey(data, o);
  o += 32;

  const priceLamports = readU64(data, o);
  o += 8;
  const maxSupply = readU32(data, o);
  o += 4;
  const maxPerTx = data[o];
  o += 1;
  const minted = readU32(data, o);
  o += 4;

  const namePrefix = readBorshString(data, o);
  o = namePrefix.next;
  const symbol = readBorshString(data, o);
  o = symbol.next;
  const uriBase = readBorshString(data, o);
  o = uriBase.next;
  const bump = data[o] ?? 0;

  return {
    pubkey,
    admin,
    treasury,
    merkleTree,
    collectionMint,
    collectionMetadata,
    collectionMasterEdition,
    priceLamports,
    maxSupply,
    maxPerTx,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    bump,
  };
}

export async function fetchBoxMinterConfig(connection: Connection): Promise<BoxMinterConfigAccount> {
  const [pda] = boxMinterConfigPda();
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info?.data) throw new Error('Box minter is not initialized on this cluster');
  return decodeBoxMinterConfigAccount(pda, info.data);
}

export async function fetchMintStatsFromProgram(connection: Connection): Promise<MintStats> {
  const cfg = await fetchBoxMinterConfig(connection);
  const minted = Number(cfg.minted || 0);
  const total = Number(cfg.maxSupply || 0);
  const remaining = Math.max(0, total - minted);
  // Hard cap (see on-chain MAX_SAFE_MINTS_PER_TX): Bubblegum hits Solana's max instruction trace length above 15.
  const maxPerTx = Math.min(cfg.maxPerTx || 0, 15);
  return { minted, total, remaining, maxPerTx, priceLamports: Number(cfg.priceLamports || 0n) };
}

function encodeMintBoxesData(quantity: number): Buffer {
  if (!Number.isFinite(quantity)) throw new Error('Invalid quantity');
  if (quantity < 1 || quantity > 30) throw new Error('Quantity must be between 1 and 30');
  const data = Buffer.alloc(IX_MINT_BOXES.length + 1);
  data.set(IX_MINT_BOXES, 0);
  data[8] = quantity & 0xff;
  return data;
}

function collectionAuthorityRecordPda(collectionMint: PublicKey, authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      utf8('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBytes(),
      collectionMint.toBytes(),
      utf8('collection_authority'),
      authority.toBytes(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function bubblegumSignerPda(): PublicKey {
  return PublicKey.findProgramAddressSync([utf8('collection_cpi')], BUBBLEGUM_PROGRAM_ID)[0];
}

function treeAuthorityPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBytes()], BUBBLEGUM_PROGRAM_ID)[0];
}

function u32LE(value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function encodeDeliverData(args: {
  deliveryId: number;
  deliveryFeeLamports: number;
  items: DeliverItemInput[];
}): Buffer {
  const deliveryId = Number(args.deliveryId);
  const fee = Number(args.deliveryFeeLamports);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0 || deliveryId > 0xffff_ffff) {
    throw new Error('Invalid deliveryId');
  }
  if (!Number.isFinite(fee) || fee < 0 || fee > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid deliveryFeeLamports');
  }
  const items = args.items || [];
  if (!Array.isArray(items) || !items.length) throw new Error('No delivery items');

  const parts: Buffer[] = [];
  parts.push(Buffer.from(IX_DELIVER));
  parts.push(u32LE(deliveryId));
  parts.push(u64LE(BigInt(fee)));
  parts.push(u32LE(items.length));

  for (const item of items) {
    const kindByte = item.kind === 'box' ? 0 : item.kind === 'dude' ? 1 : 255;
    if (kindByte === 255) throw new Error(`Invalid item kind: ${String((item as any).kind)}`);
    const refId = Number(item.refId);
    if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) throw new Error('Invalid item refId');

    const root = Buffer.from(item.root || []);
    const dataHash = Buffer.from(item.dataHash || []);
    const creatorHash = Buffer.from(item.creatorHash || []);
    if (root.length !== 32 || dataHash.length !== 32 || creatorHash.length !== 32) {
      throw new Error('Invalid burn hashes (expected 32-byte root/dataHash/creatorHash)');
    }

    const nonce = item.nonce;
    if (typeof nonce !== 'bigint' || nonce < 0n) throw new Error('Invalid burn nonce');
    const index = Number(item.index);
    if (!Number.isFinite(index) || index < 0 || index > 0xffff_ffff) throw new Error('Invalid burn leaf index');

    const proof = item.proof || [];
    if (!Array.isArray(proof)) throw new Error('Invalid proof');
    if (proof.length > 255) throw new Error('Proof too long');

    parts.push(Buffer.from([kindByte]));
    parts.push(u32LE(refId));
    parts.push(root);
    parts.push(dataHash);
    parts.push(creatorHash);
    parts.push(u64LE(nonce));
    parts.push(u32LE(index));
    parts.push(Buffer.from([proof.length & 0xff]));
  }

  return Buffer.concat(parts);
}

export function buildDeliverIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  args: { deliveryId: number; deliveryFeeLamports: number; items: DeliverItemInput[] },
): TransactionInstruction {
  const programId = boxMinterProgramId();
  const [configPda] = boxMinterConfigPda(programId);

  const treeAuthority = treeAuthorityPda(cfg.merkleTree);
  const bubblegumSigner = bubblegumSignerPda();
  const collectionAuthorityRecord = collectionAuthorityRecordPda(cfg.collectionMint, configPda);

  const keys = [
    { pubkey: configPda, isSigner: false, isWritable: false },
    // Server cosigner (must match config.admin). Backend fills this signature.
    { pubkey: cfg.admin, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: cfg.treasury, isSigner: false, isWritable: true },
    { pubkey: cfg.merkleTree, isSigner: false, isWritable: true },
    { pubkey: treeAuthority, isSigner: false, isWritable: true },
    { pubkey: cfg.collectionMint, isSigner: false, isWritable: false },
    { pubkey: cfg.collectionMetadata, isSigner: false, isWritable: true },
    { pubkey: cfg.collectionMasterEdition, isSigner: false, isWritable: false },
    { pubkey: collectionAuthorityRecord, isSigner: false, isWritable: false },
    { pubkey: bubblegumSigner, isSigner: false, isWritable: false },
    { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  // Remaining accounts: concatenated proof nodes for each burn.
  for (const item of args.items || []) {
    for (const p of item.proof || []) {
      keys.push({ pubkey: p, isSigner: false, isWritable: false });
    }
  }

  return new TransactionInstruction({
    programId,
    keys,
    data: encodeDeliverData({
      deliveryId: args.deliveryId,
      deliveryFeeLamports: args.deliveryFeeLamports,
      items: args.items,
    }),
  });
}

export function buildMintBoxesIx(cfg: BoxMinterConfigAccount, payer: PublicKey, quantity: number): TransactionInstruction {
  const programId = boxMinterProgramId();
  const [configPda] = boxMinterConfigPda(programId);

  const treeAuthority = treeAuthorityPda(cfg.merkleTree);
  const bubblegumSigner = bubblegumSignerPda();
  const collectionAuthorityRecord = collectionAuthorityRecordPda(cfg.collectionMint, configPda);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: cfg.treasury, isSigner: false, isWritable: true },
      { pubkey: cfg.merkleTree, isSigner: false, isWritable: true },
      { pubkey: treeAuthority, isSigner: false, isWritable: true },
      { pubkey: cfg.collectionMint, isSigner: false, isWritable: false },
      { pubkey: cfg.collectionMetadata, isSigner: false, isWritable: true },
      { pubkey: cfg.collectionMasterEdition, isSigner: false, isWritable: false },
      { pubkey: collectionAuthorityRecord, isSigner: false, isWritable: false },
      { pubkey: bubblegumSigner, isSigner: false, isWritable: false },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeMintBoxesData(quantity),
  });
}

export async function buildMintBoxesTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
): Promise<VersionedTransaction> {
  const MAX_MINTS_PER_TX = 15;
  if (quantity > MAX_MINTS_PER_TX) {
    throw new Error(`Max ${MAX_MINTS_PER_TX} boxes per transaction.`);
  }

  const mintIx = buildMintBoxesIx(cfg, payer, quantity);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      // Bubblegum CPI allocates; larger batches need a bigger heap frame to avoid OOM.
      // 256 KiB is the max supported heap frame size.
      ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      // Optional: add setComputeUnitPrice here if you want priority fees.
      mintIx,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

export async function buildDeliverTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  args: { deliveryId: number; deliveryFeeLamports: number; items: DeliverItemInput[] },
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  return buildDeliverTxWithBlockhash(cfg, payer, args, blockhash);
}

export function buildDeliverTxWithBlockhash(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  args: { deliveryId: number; deliveryFeeLamports: number; items: DeliverItemInput[] },
  recentBlockhash: string,
): VersionedTransaction {
  const deliverIx = buildDeliverIx(cfg, payer, args);
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: [
      // Bubblegum CPI allocates; request max heap frame to avoid OOM.
      ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      deliverIx,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

export function truncateProofByCanopy(proof: string[], canopyDepth: number): string[] {
  const drop = Math.max(0, Math.floor(canopyDepth || 0));
  if (!drop) return proof;
  if (proof.length <= drop) return [];
  return proof.slice(0, proof.length - drop);
}

export function normalizeLeafIndex(args: { nodeIndex: number; maxDepth: number }): number {
  const nodeIndex = Number(args.nodeIndex);
  if (!Number.isFinite(nodeIndex) || nodeIndex < 0) return 0;

  // Helius `node_index` is the index in the *full binary tree* where leaf nodes start at 2^depth.
  // Bubblegum/compression expects the leaf index 0..(2^depth - 1).
  const depth = Number(args.maxDepth || 0);
  if (!depth) return nodeIndex >>> 0;
  const leafOffset = Math.pow(2, depth);
  const leafIndex = nodeIndex >= leafOffset ? nodeIndex - leafOffset : nodeIndex;
  return leafIndex >>> 0;
}


