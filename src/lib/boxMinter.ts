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
import type { FrontendDeploymentConfig, MintSelectionConfig } from '../config/deployment';

const CONFIG_SEED = 'config';
const BOX_ASSET_SEED = 'box';
const DISCOUNT_RECORD_SEED = 'discount';
const PENDING_OPEN_SEED = 'open';
const PENDING_DUDE_ASSET_SEED = 'pdude';
const MIN_CONFIGURED_ITEMS_PER_BOX = 0;
const MIN_OPENABLE_ITEMS_PER_BOX = 1;
const MAX_ITEMS_PER_BOX = 5;
const MINT_VARIANT_KIND_NONE = 0;
const MINT_VARIANT_KIND_SIZE = 1;
const MINT_VARIANT_OPTION_COUNT = 3;
const MINT_COMPUTE_UNIT_LIMIT = 1_400_000;
const SIZE_SELECTION_REQUIRED_ERROR = 'This drop requires a size selection before minting';

const TE = new TextEncoder();
const utf8 = (value: string) => TE.encode(value);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryRpc<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number; maxDelayMs: number },
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= Math.max(0, opts.retries); attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.retries) throw err;
      const delay = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'RPC failed'));
}

// Anchor discriminators (sha256("global:<name>")[0..8]).
// Computed in-repo to avoid shipping Anchor in the browser.
const IX_MINT_BOXES = Uint8Array.from([0xa7, 0xe1, 0xd5, 0xb1, 0x52, 0x1d, 0x55, 0x66]);
const IX_MINT_DISCOUNTED_BOX = Uint8Array.from([0x1d, 0xe3, 0xc9, 0x63, 0xa4, 0x40, 0x25, 0x8b]);
const IX_MINT_VARIANT_BOX = Uint8Array.from([0x0e, 0x56, 0x06, 0xf6, 0x1c, 0x1d, 0x02, 0x9b]);
const IX_MINT_DISCOUNTED_VARIANT_BOX = Uint8Array.from([0x02, 0x8d, 0x83, 0x46, 0x2f, 0x1f, 0x5b, 0x62]);
const IX_START_OPEN_BOX = Uint8Array.from([0xc6, 0x64, 0x6b, 0xb4, 0x1b, 0xf3, 0x28, 0x8f]);
const ACCOUNT_BOX_MINTER_CONFIG = Uint8Array.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]);
const ACCOUNT_DISCOUNT_MINT_RECORD = Uint8Array.from([0x63, 0xca, 0x74, 0x83, 0xde, 0x9f, 0x0f, 0x70]);

export const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');

export interface BoxMinterConfigAccount {
  pubkey: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMerkleRoot: Uint8Array;
  discountMintsPerWallet: number;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  started: boolean;
  minted: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  uriBase: string;
  bump: number;
  mintVariantKind: number;
  mintVariantStartIds: [number, number, number];
  mintVariantEndIds: [number, number, number];
  mintVariantNextIds: [number, number, number];
}

type DropProgramConfig = Pick<FrontendDeploymentConfig, 'boxMinterProgramId' | 'maxPerTx' | 'mintSelection'>;
type DropMintLimitsConfig = DropProgramConfig;

function normalizeMaxMintsPerTx(config: Pick<FrontendDeploymentConfig, 'maxPerTx'> | undefined): number {
  const parsed = Number(config?.maxPerTx);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

function normalizeDiscountMintsPerWallet(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

function isSizeMintSelection(selection: MintSelectionConfig | undefined): selection is MintSelectionConfig {
  return selection?.kind === 'size' && Array.isArray(selection.options) && selection.options.length === MINT_VARIANT_OPTION_COUNT;
}

function mapMintSelectionAvailability(
  selection: MintSelectionConfig | undefined,
  resolveRemaining: (option: MintSelectionConfig['options'][number], index: number) => number,
): Record<string, number> | undefined {
  if (!isSizeMintSelection(selection)) return undefined;
  return Object.fromEntries(selection.options.map((option, index) => [option.key, resolveRemaining(option, index)]));
}

function assertStandardMintConfig(cfg: BoxMinterConfigAccount): void {
  if (cfg.mintVariantKind !== MINT_VARIANT_KIND_NONE) {
    throw new Error(SIZE_SELECTION_REQUIRED_ERROR);
  }
}

async function buildMintTransaction(
  connection: Connection,
  payer: PublicKey,
  mintIx: TransactionInstruction,
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_COMPUTE_UNIT_LIMIT }), mintIx],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function boxMinterProgramId(dropConfig: DropProgramConfig): PublicKey {
  return new PublicKey(dropConfig.boxMinterProgramId);
}

export function boxMinterConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(CONFIG_SEED)], programId);
}

export function discountMintRecordPda(payer: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(DISCOUNT_RECORD_SEED), payer.toBuffer()], programId);
}

export function pendingOpenPda(boxAsset: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PENDING_OPEN_SEED), boxAsset.toBuffer()], programId);
}

export function pendingDudeAssetPda(
  pending: PublicKey,
  index: number,
  itemsPerBox: number,
  programId: PublicKey,
): [PublicKey, number] {
  const i = Number(index);
  if (!Number.isInteger(itemsPerBox) || itemsPerBox < MIN_OPENABLE_ITEMS_PER_BOX || itemsPerBox > MAX_ITEMS_PER_BOX) {
    throw new Error(`Invalid itemsPerBox in config (expected ${MIN_OPENABLE_ITEMS_PER_BOX}..${MAX_ITEMS_PER_BOX} for openable drops)`);
  }
  if (!Number.isFinite(i) || i < 0 || i >= itemsPerBox) throw new Error('Invalid pending dude index');
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

function readU32Tuple(
  buf: Uint8Array,
  offset: number,
): { value: [number, number, number]; next: number } {
  const value: [number, number, number] = [0, 0, 0];
  let next = offset;
  for (let i = 0; i < MINT_VARIANT_OPTION_COUNT; i += 1) {
    value[i] = readU32(buf, next);
    next += 4;
  }
  return { value, next };
}

function resolveMintSelectionAvailability(
  cfg: BoxMinterConfigAccount,
  selection: MintSelectionConfig | undefined,
): Record<string, number> | undefined {
  if (cfg.mintVariantKind !== MINT_VARIANT_KIND_SIZE) return undefined;
  return mapMintSelectionAvailability(selection, (option, index) => {
    const onchainStart = cfg.mintVariantStartIds[index];
    const onchainEnd = cfg.mintVariantEndIds[index];
    if (option.startId !== onchainStart || option.endId !== onchainEnd) {
      throw new Error('Drop mint selection is out of sync with on-chain variant ranges');
    }
    const nextId = cfg.mintVariantNextIds[index];
    return nextId > onchainEnd ? 0 : Math.max(0, onchainEnd - Math.max(nextId, onchainStart) + 1);
  });
}

export function deriveMintSelectionAvailabilityFromConfig(
  selection: MintSelectionConfig | undefined,
): Record<string, number> | undefined {
  return mapMintSelectionAvailability(selection, (option) => Math.max(0, option.endId - option.startId + 1));
}

function resolveMintVariantIndex(
  cfg: BoxMinterConfigAccount,
  dropConfig: DropProgramConfig,
  variantKey: string,
): number {
  if (cfg.mintVariantKind !== MINT_VARIANT_KIND_SIZE) {
    throw new Error('This drop does not use variant minting');
  }
  const selection = dropConfig.mintSelection;
  if (!isSizeMintSelection(selection)) {
    throw new Error('Missing drop mint selection configuration');
  }
  const index = selection.options.findIndex((option) => option.key === variantKey);
  if (index === -1) {
    throw new Error(`Unknown mint variant: ${variantKey}`);
  }
  if (
    selection.options[index].startId !== cfg.mintVariantStartIds[index] ||
    selection.options[index].endId !== cfg.mintVariantEndIds[index]
  ) {
    throw new Error('Drop mint selection is out of sync with on-chain variant ranges');
  }
  return index;
}

export function decodeBoxMinterConfigAccount(pubkey: PublicKey, data: Uint8Array): BoxMinterConfigAccount {
  if (data.length < 8) throw new Error('Invalid config account: empty');
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== ACCOUNT_BOX_MINTER_CONFIG[i]) {
      throw new Error('Invalid config account discriminator');
    }
  }

  const expectedMinLen =
    8 + // discriminator
    32 * 3 +
    8 +
    8 +
    32 +
    4 +
    1 +
    1 +
    4 +
    4 +
    8 +
    4 +
    10 +
    4 +
    96 +
    1 +
    1;
  if (data.length < expectedMinLen) {
    throw new Error('Unsupported box minter config schema. Re-run deploy-all-onchain for a fresh configurable-items deployment.');
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
  const discountPriceLamports = readU64(data, o);
  o += 8;
  const discountMerkleRoot = data.subarray(o, o + 32);
  o += 32;
  const maxSupply = readU32(data, o);
  o += 4;
  const maxPerTx = data[o];
  o += 1;
  const itemsPerBox = data[o];
  o += 1;
  if (!Number.isInteger(itemsPerBox) || itemsPerBox < MIN_CONFIGURED_ITEMS_PER_BOX || itemsPerBox > MAX_ITEMS_PER_BOX) {
    throw new Error(`Invalid on-chain itemsPerBox: ${itemsPerBox} (expected ${MIN_CONFIGURED_ITEMS_PER_BOX}..${MAX_ITEMS_PER_BOX})`);
  }
  const minted = readU32(data, o);
  o += 4;

  const namePrefix = readBorshString(data, o);
  o = namePrefix.next;
  const symbol = readBorshString(data, o);
  o = symbol.next;
  const uriBase = readBorshString(data, o);
  o = uriBase.next;
  const started = Boolean(data[o]);
  o += 1;
  const bump = data[o] ?? 0;
  o += 1;
  const discountMintsPerWallet = normalizeDiscountMintsPerWallet(data[o] ?? 1);
  o += 1;
  let figureNamePrefix = 'figure';
  if (o + 4 <= data.length) {
    const decoded = readBorshString(data, o);
    figureNamePrefix = decoded.value;
    o = decoded.next;
  }
  let mintVariantKind = MINT_VARIANT_KIND_NONE;
  let mintVariantStartIds: [number, number, number] = [0, 0, 0];
  let mintVariantEndIds: [number, number, number] = [0, 0, 0];
  let mintVariantNextIds: [number, number, number] = [0, 0, 0];
  const mintVariantBytes = 1 + 4 * MINT_VARIANT_OPTION_COUNT * 3;
  if (o < data.length) {
    if (o + mintVariantBytes > data.length) {
      throw new Error('Unsupported box minter config schema. Variant mint data is truncated.');
    }
    mintVariantKind = data[o] ?? MINT_VARIANT_KIND_NONE;
    o += 1;
    const startIds = readU32Tuple(data, o);
    mintVariantStartIds = startIds.value;
    o = startIds.next;
    const endIds = readU32Tuple(data, o);
    mintVariantEndIds = endIds.value;
    o = endIds.next;
    const nextIds = readU32Tuple(data, o);
    mintVariantNextIds = nextIds.value;
    o = nextIds.next;
  }

  return {
    pubkey,
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    discountMintsPerWallet,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    started,
    minted,
    namePrefix: namePrefix.value,
    figureNamePrefix,
    symbol: symbol.value,
    uriBase: uriBase.value,
    bump,
    mintVariantKind,
    mintVariantStartIds,
    mintVariantEndIds,
    mintVariantNextIds,
  };
}

export function decodeDiscountMintRecordUsedCount(data: Uint8Array): number {
  if (data.length < 8 + 32 + 1) {
    throw new Error('Invalid discount record account');
  }
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== ACCOUNT_DISCOUNT_MINT_RECORD[i]) {
      throw new Error('Invalid discount record discriminator');
    }
  }
  if (data.length >= 8 + 32 + 2) {
    const minted = Number(data[8 + 32] ?? 0);
    if (!Number.isInteger(minted) || minted < 0) return 0;
    return minted;
  }
  return 1;
}

export async function fetchDiscountMintRecordUsedCount(
  connection: Connection,
  payer: PublicKey,
  dropConfig: DropProgramConfig,
): Promise<number> {
  const programId = boxMinterProgramId(dropConfig);
  const [discountRecordPda] = discountMintRecordPda(payer, programId);
  const info = await retryRpc(() => connection.getAccountInfo(discountRecordPda, 'confirmed'), {
    retries: 3,
    baseDelayMs: 300,
    maxDelayMs: 2_000,
  });
  if (!info?.data) return 0;
  if (info.owner.equals(SystemProgram.programId)) {
    // The on-chain program can reclaim a pre-funded PDA stub, so treat it as unused here too.
    if (info.data.length === 0) return 0;
    throw new Error('Invalid discount record account owner');
  }
  if (!info.owner.equals(programId)) {
    throw new Error('Invalid discount record account owner');
  }
  return decodeDiscountMintRecordUsedCount(info.data);
}

export async function fetchBoxMinterConfig(
  connection: Connection,
  dropConfig: DropProgramConfig,
): Promise<BoxMinterConfigAccount> {
  const programId = boxMinterProgramId(dropConfig);
  const [pda] = boxMinterConfigPda(programId);
  const info = await retryRpc(() => connection.getAccountInfo(pda, 'confirmed'), {
    retries: 3,
    baseDelayMs: 300,
    maxDelayMs: 2_000,
  });
  if (!info?.data) throw new Error('Box minter is not initialized on this cluster');
  return decodeBoxMinterConfigAccount(pda, info.data);
}

export async function fetchMintStatsFromProgram(
  connection: Connection,
  dropConfig: DropMintLimitsConfig,
): Promise<MintStats> {
  const cfg = await fetchBoxMinterConfig(connection, dropConfig);
  const minted = Number(cfg.minted || 0);
  const total = Number(cfg.maxSupply || 0);
  const remaining = Math.max(0, total - minted);
  // Keep in sync with on-chain config; clamp to our deployment-config defaults for safety.
  const maxPerTx = Math.min(cfg.maxPerTx || 0, normalizeMaxMintsPerTx(dropConfig));
  const mintSelectionAvailability = resolveMintSelectionAvailability(cfg, dropConfig.mintSelection);
  return {
    minted,
    total,
    remaining,
    maxPerTx,
    priceLamports: Number(cfg.priceLamports || 0n),
    discountMintsPerWallet: cfg.discountMintsPerWallet,
    ...(mintSelectionAvailability ? { mintSelectionAvailability } : {}),
  };
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

function deriveMintPlan(payer: PublicKey, programId: PublicKey, quantity: number) {
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
  return { mintId, mintIdBytes, boxAccounts, boxBumps };
}

function encodeMintBoxesData(quantity: number, mintId: bigint, boxBumps: number[], maxMintsPerTx: number): Buffer {
  if (!Number.isFinite(quantity)) throw new Error('Invalid quantity');
  if (quantity < 1 || quantity > maxMintsPerTx) {
    throw new Error(`Quantity must be between 1 and ${maxMintsPerTx}`);
  }
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

function encodeMintDiscountedBoxData(mintId: bigint, boxBumps: number[], proof: Uint8Array[]): Buffer {
  if (!Array.isArray(boxBumps) || boxBumps.length < 1) {
    throw new Error('Discount mint requires at least one box bump');
  }
  if (!Array.isArray(proof)) {
    throw new Error('Missing discount proof');
  }
  const bumps = Buffer.from(boxBumps.map((b) => b & 0xff));
  const bumpsLen = u32LE(bumps.length);
  const proofLen = u32LE(proof.length);
  const proofBytes = Buffer.concat(
    proof.map((node) => {
      if (node.length !== 32) throw new Error('Invalid discount proof node');
      return Buffer.from(node);
    }),
  );
  return Buffer.concat([Buffer.from(IX_MINT_DISCOUNTED_BOX), u64LE(mintId), bumpsLen, bumps, proofLen, proofBytes]);
}

function encodeMintVariantBoxData(variantIndex: number, mintId: bigint, boxBump: number): Buffer {
  if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex >= MINT_VARIANT_OPTION_COUNT) {
    throw new Error('Invalid mint variant');
  }
  return Buffer.concat([Buffer.from(IX_MINT_VARIANT_BOX), Buffer.from([variantIndex & 0xff]), u64LE(mintId), Buffer.from([boxBump & 0xff])]);
}

function encodeMintDiscountedVariantBoxData(variantIndex: number, mintId: bigint, boxBump: number, proof: Uint8Array[]): Buffer {
  if (!Array.isArray(proof)) {
    throw new Error('Missing discount proof');
  }
  const proofLen = u32LE(proof.length);
  const proofBytes = Buffer.concat(
    proof.map((node) => {
      if (node.length !== 32) throw new Error('Invalid discount proof node');
      return Buffer.from(node);
    }),
  );
  return Buffer.concat([
    Buffer.from(IX_MINT_DISCOUNTED_VARIANT_BOX),
    Buffer.from([variantIndex & 0xff]),
    u64LE(mintId),
    Buffer.from([boxBump & 0xff]),
    proofLen,
    proofBytes,
  ]);
}

export function buildMintBoxesIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  dropConfig: DropMintLimitsConfig,
): TransactionInstruction {
  assertStandardMintConfig(cfg);
  const programId = boxMinterProgramId(dropConfig);
  const [configPda] = boxMinterConfigPda(programId);
  const maxMintsPerTx = normalizeMaxMintsPerTx(dropConfig);

  // IMPORTANT: derive box asset PDAs from (payer + random mintId), not from cfg.minted.
  // This avoids stale-PDA failures when many users mint concurrently.
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, quantity);

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
    data: encodeMintBoxesData(quantity, mintId, boxBumps, maxMintsPerTx),
  });
}

export function buildMintDiscountedBoxIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): TransactionInstruction {
  assertStandardMintConfig(cfg);
  const programId = boxMinterProgramId(dropConfig);
  const [configPda] = boxMinterConfigPda(programId);
  const [discountRecordPda] = discountMintRecordPda(payer, programId);
  const maxDiscountMints = Math.min(normalizeMaxMintsPerTx(dropConfig), cfg.discountMintsPerWallet);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > maxDiscountMints) {
    throw new Error(`Discount mint quantity must be between 1 and ${maxDiscountMints}`);
  }
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, quantity);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: discountRecordPda, isSigner: false, isWritable: true },
      { pubkey: cfg.treasury, isSigner: false, isWritable: true },
      { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...boxAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeMintDiscountedBoxData(mintId, boxBumps, proof),
  });
}

export function buildMintVariantBoxIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  dropConfig: DropMintLimitsConfig,
): TransactionInstruction {
  const programId = boxMinterProgramId(dropConfig);
  const [configPda] = boxMinterConfigPda(programId);
  const variantIndex = resolveMintVariantIndex(cfg, dropConfig, variantKey);
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, 1);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: cfg.treasury, isSigner: false, isWritable: true },
      { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: boxAccounts[0], isSigner: false, isWritable: true },
    ],
    data: encodeMintVariantBoxData(variantIndex, mintId, boxBumps[0]),
  });
}

export function buildMintDiscountedVariantBoxIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): TransactionInstruction {
  const programId = boxMinterProgramId(dropConfig);
  const [configPda] = boxMinterConfigPda(programId);
  const [discountRecordPda] = discountMintRecordPda(payer, programId);
  const variantIndex = resolveMintVariantIndex(cfg, dropConfig, variantKey);
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, 1);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: discountRecordPda, isSigner: false, isWritable: true },
      { pubkey: cfg.treasury, isSigner: false, isWritable: true },
      { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: boxAccounts[0], isSigner: false, isWritable: true },
    ],
    data: encodeMintDiscountedVariantBoxData(variantIndex, mintId, boxBumps[0], proof),
  });
}

export async function buildMintBoxesTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  dropConfig: DropMintLimitsConfig,
): Promise<VersionedTransaction> {
  assertStandardMintConfig(cfg);
  const maxMintsPerTx = normalizeMaxMintsPerTx(dropConfig);
  // Keep conservative; each Core mint creates a new account.
  if (quantity > maxMintsPerTx) {
    throw new Error(`Max ${maxMintsPerTx} boxes per transaction.`);
  }

  const mintIx = buildMintBoxesIx(cfg, payer, quantity, dropConfig);
  return buildMintTransaction(connection, payer, mintIx);
}

export async function buildMintDiscountedBoxTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): Promise<VersionedTransaction> {
  const mintIx = buildMintDiscountedBoxIx(cfg, payer, quantity, proof, dropConfig);
  return buildMintTransaction(connection, payer, mintIx);
}

export async function buildMintVariantBoxTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  dropConfig: DropMintLimitsConfig,
): Promise<VersionedTransaction> {
  const mintIx = buildMintVariantBoxIx(cfg, payer, variantKey, dropConfig);
  return buildMintTransaction(connection, payer, mintIx);
}

export async function buildMintDiscountedVariantBoxTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): Promise<VersionedTransaction> {
  const mintIx = buildMintDiscountedVariantBoxIx(cfg, payer, variantKey, proof, dropConfig);
  return buildMintTransaction(connection, payer, mintIx);
}

export function buildStartOpenBoxIx(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  boxAsset: PublicKey,
  dropConfig: DropProgramConfig,
): TransactionInstruction {
  if (cfg.itemsPerBox < MIN_OPENABLE_ITEMS_PER_BOX) {
    throw new Error('This drop does not support opening.');
  }
  const programId = boxMinterProgramId(dropConfig);
  const [configPda] = boxMinterConfigPda(programId);
  const [pendingPda] = pendingOpenPda(boxAsset, programId);
  const dudePdas = Array.from({ length: cfg.itemsPerBox }, (_, i) => pendingDudeAssetPda(pendingPda, i, cfg.itemsPerBox, programId)[0]);

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
      // MPL-Core log wrapper (SPL noop).
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pendingPda, isSigner: false, isWritable: true },
      ...dudePdas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(IX_START_OPEN_BOX),
  });
}

export async function buildStartOpenBoxTx(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  boxAsset: PublicKey,
  dropConfig: DropProgramConfig,
): Promise<VersionedTransaction> {
  const startIx = buildStartOpenBoxIx(cfg, payer, boxAsset, dropConfig);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      startIx,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}
