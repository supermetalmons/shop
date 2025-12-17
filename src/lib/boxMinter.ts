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
  return { minted, total, remaining, maxPerTx: cfg.maxPerTx, priceLamports: Number(cfg.priceLamports || 0n) };
}

function encodeMintBoxesData(quantity: number): Uint8Array {
  if (!Number.isFinite(quantity)) throw new Error('Invalid quantity');
  if (quantity < 1 || quantity > 30) throw new Error('Quantity must be between 1 and 30');
  const data = new Uint8Array(IX_MINT_BOXES.length + 1);
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
  const mintIx = buildMintBoxesIx(cfg, payer, quantity);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      // Optional: add setComputeUnitPrice here if you want priority fees.
      mintIx,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}


