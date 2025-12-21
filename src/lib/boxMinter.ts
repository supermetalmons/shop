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
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

const CONFIG_SEED = 'config';
const BOX_ASSET_SEED = 'box';
const PENDING_OPEN_SEED = 'open';
const PENDING_DUDE_ASSET_SEED = 'pdude';

const TE = new TextEncoder();
const utf8 = (value: string) => TE.encode(value);

// Anchor discriminators (sha256("global:<name>")[0..8]).
// Computed in-repo to avoid shipping Anchor in the browser.
const IX_MINT_BOXES = Uint8Array.from([0xa7, 0xe1, 0xd5, 0xb1, 0x52, 0x1d, 0x55, 0x66]);
const IX_START_OPEN_BOX = Uint8Array.from([0xc6, 0x64, 0x6b, 0xb4, 0x1b, 0xf3, 0x28, 0x8f]);
const ACCOUNT_BOX_MINTER_CONFIG = Uint8Array.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]);

export const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

export interface BoxMinterConfigAccount {
  pubkey: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  maxSupply: number;
  maxPerTx: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  bump: number;
}

export function boxMinterProgramId(): PublicKey {
  return new PublicKey(FRONTEND_DEPLOYMENT.boxMinterProgramId);
}

export function boxMinterConfigPda(programId = boxMinterProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CONFIG_SEED)], programId);
}

export function boxAssetPda(index: number, programId = boxMinterProgramId()): [PublicKey, number] {
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx <= 0 || idx > 0xffff_ffff) throw new Error('Invalid box index');
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(idx >>> 0, 0);
  return PublicKey.findProgramAddressSync([Buffer.from(BOX_ASSET_SEED), buf], programId);
}

export function pendingOpenPda(boxAsset: PublicKey, programId = boxMinterProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PENDING_OPEN_SEED), boxAsset.toBuffer()], programId);
}

export function pendingDudeAssetPda(pending: PublicKey, index: number, programId = boxMinterProgramId()): [PublicKey, number] {
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0 || i >= 3) throw new Error('Invalid pending dude index');
  return PublicKey.findProgramAddressSync([Buffer.from(PENDING_DUDE_ASSET_SEED), pending.toBuffer(), Buffer.from([i & 0xff])], programId);
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

  // Layout matches `onchain/programs/box_minter/src/lib.rs` BoxMinterConfig.
  let o = 8;
  const admin = readPubkey(data, o);
  o += 32;
  const treasury = readPubkey(data, o);
  o += 32;
  const coreCollection = readPubkey(data, o);
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
    coreCollection,
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
  // Keep in sync with on-chain MAX_SAFE_MINTS_PER_TX.
  const maxPerTx = Math.min(cfg.maxPerTx || 0, 15);
  return { minted, total, remaining, maxPerTx, priceLamports: Number(cfg.priceLamports || 0n) };
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

function randomU64(): bigint {
  // Uniqueness is the goal (not cryptographic security); still prefer WebCrypto when available.
  const g: any = globalThis as any;
  const cryptoObj: Crypto | undefined = g?.crypto;
  const arr = new Uint32Array(2);
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(arr);
  } else {
    // Fallback (should be rare in modern browsers).
    arr[0] = (Math.random() * 2 ** 32) >>> 0;
    arr[1] = (Math.random() * 2 ** 32) >>> 0;
  }
  return (BigInt(arr[0]) | (BigInt(arr[1]) << 32n)) & 0xffff_ffff_ffff_ffffn;
}

function encodeMintBoxesData(quantity: number, mintId: bigint, boxBumps: number[]): Buffer {
  if (!Number.isFinite(quantity)) throw new Error('Invalid quantity');
  if (quantity < 1 || quantity > 15) throw new Error('Quantity must be between 1 and 15');
  if (!Array.isArray(boxBumps) || boxBumps.length !== quantity) {
    throw new Error('Invalid box bumps');
  }
  // Anchor args: (quantity: u8, mint_id: u64, box_bumps: Vec<u8>)
  // Borsh layout: u8 + u64 + u32(len) + [u8; len]
  const bumps = Buffer.from(boxBumps.map((b) => b & 0xff));
  const len = u32LE(bumps.length);
  const header = Buffer.alloc(IX_MINT_BOXES.length + 1);
  header.set(IX_MINT_BOXES, 0);
  header[8] = quantity & 0xff;
  return Buffer.concat([header, u64LE(mintId), len, bumps]);
}

export function buildMintBoxesIx(cfg: BoxMinterConfigAccount, payer: PublicKey, quantity: number): TransactionInstruction {
  const programId = boxMinterProgramId();
  const [configPda] = boxMinterConfigPda(programId);

  // IMPORTANT: derive box asset PDAs from (payer + random mintId), not from cfg.minted.
  // This avoids stale-PDA failures when many users mint concurrently.
  const mintId = randomU64();
  const mintIdBytes = u64LE(mintId);
  const boxAccounts: PublicKey[] = [];
  const boxBumps: number[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(BOX_ASSET_SEED), payer.toBuffer(), mintIdBytes, Buffer.from([i & 0xff])],
      programId,
    );
    boxAccounts.push(pda);
    boxBumps.push(bump);
  }

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: cfg.treasury, isSigner: false, isWritable: true },
      { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...boxAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeMintBoxesData(quantity, mintId, boxBumps),
  });
}

export async function buildMintBoxesTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
): Promise<VersionedTransaction> {
  // Keep conservative; each Core mint creates a new account.
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
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      // Optional: add setComputeUnitPrice here if you want priority fees.
      mintIx,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

export function buildStartOpenBoxIx(cfg: BoxMinterConfigAccount, payer: PublicKey, boxAsset: PublicKey): TransactionInstruction {
  const programId = boxMinterProgramId();
  const [configPda] = boxMinterConfigPda(programId);
  const [pendingPda] = pendingOpenPda(boxAsset, programId);
  const dudePdas = [0, 1, 2].map((i) => pendingDudeAssetPda(pendingPda, i, programId)[0]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: boxAsset, isSigner: false, isWritable: true },
      // Vault/custody address for opened boxes (admin/deployer). Payments go to `cfg.treasury`.
      { pubkey: cfg.admin, isSigner: false, isWritable: false },
      { pubkey: cfg.coreCollection, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_ID, isSigner: false, isWritable: false },
      { pubkey: pendingPda, isSigner: false, isWritable: true },
      ...dudePdas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(IX_START_OPEN_BOX),
  });
}

export function buildTransferBoxToVaultIx(cfg: BoxMinterConfigAccount, payer: PublicKey, boxAsset: PublicKey): TransactionInstruction {
  // MPL-Core TransferV1 discriminator=14, compression_proof=None (0)
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: boxAsset, isSigner: false, isWritable: true },
      { pubkey: cfg.coreCollection, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      // Vault/custody address (admin/deployer). Payments go to `cfg.treasury`.
      { pubkey: cfg.admin, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  });
}

export async function buildStartOpenBoxTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  boxAsset: PublicKey,
): Promise<VersionedTransaction> {
  const startIx = buildStartOpenBoxIx(cfg, payer, boxAsset);
  const transferIx = buildTransferBoxToVaultIx(cfg, payer, boxAsset);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      startIx,
      // MUST be immediately after startIx (on-chain verifies it).
      transferIx,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}
