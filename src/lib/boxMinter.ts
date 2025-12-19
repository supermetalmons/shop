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
const BOX_ASSET_SEED = 'box';
const DUDE_ASSET_SEED = 'dude';
const RECEIPT_ASSET_SEED = 'receipt';

const TE = new TextEncoder();
const utf8 = (value: string) => TE.encode(value);

// Anchor discriminators (sha256("global:<name>")[0..8]).
// Computed in-repo to avoid shipping Anchor in the browser.
const IX_MINT_BOXES = Uint8Array.from([0xa7, 0xe1, 0xd5, 0xb1, 0x52, 0x1d, 0x55, 0x66]);
const IX_DELIVER = Uint8Array.from([0xfa, 0x83, 0xde, 0x39, 0xd3, 0xe5, 0xd1, 0x93]);
const ACCOUNT_BOX_MINTER_CONFIG = Uint8Array.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]);

export const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');

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

export type DeliverItemKind = 'box' | 'dude';

export interface DeliverItemInput {
  kind: DeliverItemKind;
  // Numeric id used for receipt metadata (box id or dude id).
  refId: number;
  // Existing Core asset account to burn.
  asset: PublicKey;
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

export function boxAssetPda(index: number, programId = boxMinterProgramId()): [PublicKey, number] {
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx <= 0 || idx > 0xffff_ffff) throw new Error('Invalid box index');
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(idx >>> 0, 0);
  return PublicKey.findProgramAddressSync([Buffer.from(BOX_ASSET_SEED), buf], programId);
}

export function dudeAssetPda(dudeId: number, programId = boxMinterProgramId()): [PublicKey, number] {
  const id = Number(dudeId);
  if (!Number.isFinite(id) || id <= 0 || id > 0xffff) throw new Error('Invalid dude id');
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(id & 0xffff, 0);
  return PublicKey.findProgramAddressSync([Buffer.from(DUDE_ASSET_SEED), buf], programId);
}

export function receiptAssetPda(kind: DeliverItemKind, refId: number, programId = boxMinterProgramId()): [PublicKey, number] {
  const kindByte = kind === 'box' ? 0 : 1;
  const ref = Number(refId);
  if (!Number.isFinite(ref) || ref <= 0 || ref > 0xffff_ffff) throw new Error('Invalid receipt refId');
  const refBuf = Buffer.alloc(4);
  refBuf.writeUInt32LE(ref >>> 0, 0);
  return PublicKey.findProgramAddressSync([Buffer.from(RECEIPT_ASSET_SEED), Buffer.from([kindByte]), refBuf], programId);
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

function encodeDeliverData(args: {
  deliveryId: number;
  deliveryFeeLamports: number;
  items: Array<{ kind: DeliverItemKind; refId: number }>;
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
    parts.push(Buffer.from([kindByte]));
    parts.push(u32LE(refId));
  }

  return Buffer.concat(parts);
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

export function buildDeliverIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  args: { deliveryId: number; deliveryFeeLamports: number; items: DeliverItemInput[] },
): TransactionInstruction {
  const programId = boxMinterProgramId();
  const [configPda] = boxMinterConfigPda(programId);

  const keys = [
    { pubkey: configPda, isSigner: false, isWritable: false },
    // Server cosigner (must match config.admin). Backend fills this signature.
    { pubkey: cfg.admin, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: cfg.treasury, isSigner: false, isWritable: true },
    { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
    { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_ID, isSigner: false, isWritable: false },
  ];

  // Remaining accounts: for each item => (asset_to_burn, receipt_asset_pda_to_create).
  for (const item of args.items || []) {
    const [receiptPda] = receiptAssetPda(item.kind, item.refId, programId);
    keys.push({ pubkey: item.asset, isSigner: false, isWritable: true });
    keys.push({ pubkey: receiptPda, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId,
    keys,
    data: encodeDeliverData({
      deliveryId: args.deliveryId,
      deliveryFeeLamports: args.deliveryFeeLamports,
      items: (args.items || []).map((i) => ({ kind: i.kind, refId: i.refId })),
    }),
  });
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
  const transferIxs = (args.items || []).map(
    (item) =>
      new TransactionInstruction({
        programId: MPL_CORE_PROGRAM_ID,
        keys: [
          // TransferV1 accounts (kinobi order):
          // 0 asset, 1 collection, 2 payer, 3 authority, 4 newOwner, 5 systemProgram, 6 logWrapper
          { pubkey: item.asset, isSigner: false, isWritable: true },
          { pubkey: cfg.coreCollection, isSigner: false, isWritable: false },
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: payer, isSigner: true, isWritable: false },
          { pubkey: cfg.treasury, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        // TransferV1 discriminator=14, compression_proof=None (0)
        data: Buffer.from([14, 0]),
      }),
  );
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    // Order matters: on-chain `deliver` enforces that the subsequent instructions are transfers to the vault.
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), deliverIx, ...transferIxs],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}


