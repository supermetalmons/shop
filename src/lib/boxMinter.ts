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
import { normalizeDropBase, type FrontendDeploymentConfig, type MintSelectionConfig } from '../config/deployment.ts';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
} from '../../functions/src/shared/boxMinterConfigCodec.ts';
import {
  BOX_MINTER_CONFIG_SEED as CONFIG_SEED,
  BOX_MINTER_MAX_ITEMS_PER_BOX as MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX as MIN_OPENABLE_ITEMS_PER_BOX,
  BOX_MINTER_MINT_VARIANT_KIND_NONE as MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_KIND_SIZE as MINT_VARIANT_KIND_SIZE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT as MINT_VARIANT_OPTION_COUNT,
  BOX_MINTER_PENDING_OPEN_SEED as PENDING_OPEN_SEED,
  isOpenableBoxMinterItemsPerBox,
  type BoxMinterMintVariantTuple,
} from '../../functions/src/shared/boxMinterProtocol.ts';
import { normalizeBoxMinterMetadataBaseForComparison } from '../../functions/src/shared/deploymentCore.ts';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../functions/src/shared/solanaProgramAddresses.ts';

const BOX_ASSET_SEED = 'box';
const DISCOUNT_RECORD_SEED = 'discount';
const PENDING_DUDE_ASSET_SEED = 'pdude';
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
const ACCOUNT_DISCOUNT_MINT_RECORD = Uint8Array.from([0x63, 0xca, 0x74, 0x83, 0xde, 0x9f, 0x0f, 0x70]);

const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

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
  mintVariantStartIds: BoxMinterMintVariantTuple;
  mintVariantEndIds: BoxMinterMintVariantTuple;
  mintVariantNextIds: BoxMinterMintVariantTuple;
  dropSeed?: Uint8Array;
}

export interface BuiltMintTx {
  tx: VersionedTransaction;
  boxAccounts: PublicKey[];
}

export interface BuiltStartOpenBoxTx {
  tx: VersionedTransaction;
  pendingPda: PublicKey;
}

type BuiltMintInstructionPlan = {
  instruction: TransactionInstruction;
  boxAccounts: PublicKey[];
};

type BuiltStartOpenBoxInstructionPlan = {
  instruction: TransactionInstruction;
  pendingPda: PublicKey;
};

type DropProgramScopeConfig = Pick<FrontendDeploymentConfig, 'boxMinterProgramId' | 'boxMinterConfigPda'>;
type DropProgramValidationConfig = Partial<Pick<FrontendDeploymentConfig, 'collectionMint' | 'metadataBase'>>;
type DropProgramConfig = DropProgramScopeConfig &
  DropProgramValidationConfig &
  Pick<FrontendDeploymentConfig, 'maxPerTx' | 'mintSelection'>;
type ScopedConfigPda = Pick<BoxMinterConfigAccount, 'pubkey'>;

function normalizeMaxMintsPerTx(config: Pick<FrontendDeploymentConfig, 'maxPerTx'> | undefined): number {
  const parsed = Number(config?.maxPerTx);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
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

async function buildComputeBudgetTransaction(
  connection: Connection,
  payer: PublicKey,
  instruction: TransactionInstruction,
  units = MINT_COMPUTE_UNIT_LIMIT,
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), instruction],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function boxMinterProgramId(dropConfig: DropProgramScopeConfig): PublicKey {
  return new PublicKey(dropConfig.boxMinterProgramId);
}

export function boxMinterConfigPda(programId: PublicKey, dropSeed?: Uint8Array): [PublicKey, number] {
  return dropSeed?.length === 32
    ? PublicKey.findProgramAddressSync([utf8(CONFIG_SEED), Buffer.from(dropSeed)], programId)
    : PublicKey.findProgramAddressSync([utf8(CONFIG_SEED)], programId);
}

function isLegacySingletonConfigPda(programId: PublicKey, configPda: PublicKey): boolean {
  return configPda.equals(boxMinterConfigPda(programId)[0]);
}

function scopedConfigPubkey(programId: PublicKey, cfg?: ScopedConfigPda): PublicKey | undefined {
  if (!cfg || isLegacySingletonConfigPda(programId, cfg.pubkey)) return undefined;
  return cfg.pubkey;
}

function resolveConfiguredBoxMinterConfigPda(dropConfig: DropProgramScopeConfig, programId: PublicKey): PublicKey {
  const configured = String(dropConfig.boxMinterConfigPda || '').trim();
  return configured ? new PublicKey(configured) : boxMinterConfigPda(programId)[0];
}

export function assertBoxMinterConfigMatchesDropConfig(
  cfg: Pick<BoxMinterConfigAccount, 'coreCollection' | 'uriBase'>,
  dropConfig: DropProgramValidationConfig,
): void {
  const expectedCollectionMint =
    typeof dropConfig.collectionMint === 'string' ? dropConfig.collectionMint.trim() : '';
  if (expectedCollectionMint && cfg.coreCollection.toBase58() !== expectedCollectionMint) {
    throw new Error('Deployment config is out of sync with the on-chain collection mint');
  }

  const expectedMetadataBase =
    typeof dropConfig.metadataBase === 'string' ? normalizeDropBase(dropConfig.metadataBase) : '';
  if (expectedMetadataBase && normalizeBoxMinterMetadataBaseForComparison(cfg.uriBase) !== expectedMetadataBase) {
    throw new Error('Deployment config is out of sync with the on-chain metadata base');
  }
}

export function boxAssetPda(
  payer: PublicKey,
  mintId: bigint,
  index: number,
  programId: PublicKey,
  cfg?: ScopedConfigPda,
): [PublicKey, number] {
  const seeds: Uint8Array[] = [Buffer.from(BOX_ASSET_SEED)];
  const configPubkey = scopedConfigPubkey(programId, cfg);
  if (configPubkey) {
    seeds.push(configPubkey.toBuffer());
  }
  seeds.push(payer.toBuffer(), u64LE(mintId), Buffer.from([index & 0xff]));
  return PublicKey.findProgramAddressSync(seeds, programId);
}

export function discountMintRecordPda(
  payer: PublicKey,
  programId: PublicKey,
  cfg?: ScopedConfigPda,
): [PublicKey, number] {
  const seeds: Uint8Array[] = [utf8(DISCOUNT_RECORD_SEED)];
  const configPubkey = scopedConfigPubkey(programId, cfg);
  if (configPubkey) {
    seeds.push(configPubkey.toBuffer());
  }
  seeds.push(payer.toBuffer());
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function pendingOpenPda(boxAsset: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PENDING_OPEN_SEED), boxAsset.toBuffer()], programId);
}

function pendingDudeAssetPda(
  pending: PublicKey,
  index: number,
  itemsPerBox: number,
  programId: PublicKey,
): [PublicKey, number] {
  const i = Number(index);
  if (!isOpenableBoxMinterItemsPerBox(itemsPerBox)) {
    throw new Error(`Invalid itemsPerBox in config (expected ${MIN_OPENABLE_ITEMS_PER_BOX}..${MAX_ITEMS_PER_BOX} for openable drops)`);
  }
  if (!Number.isFinite(i) || i < 0 || i >= itemsPerBox) throw new Error('Invalid pending dude index');
  return PublicKey.findProgramAddressSync([Buffer.from(PENDING_DUDE_ASSET_SEED), pending.toBuffer(), Buffer.from([i & 0xff])], programId);
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
  let decoded;
  try {
    decoded = decodeBoxMinterConfigData(data);
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new Error(error.message);
    }
    throw error;
  }
  const dropSeed = decoded.dropSeed;

  return {
    pubkey,
    admin: new PublicKey(decoded.admin),
    treasury: new PublicKey(decoded.treasury),
    coreCollection: new PublicKey(decoded.coreCollection),
    priceLamports: decoded.priceLamports,
    discountPriceLamports: decoded.discountPriceLamports,
    discountMerkleRoot: decoded.discountMerkleRoot,
    discountMintsPerWallet: decoded.discountMintsPerWallet,
    maxSupply: decoded.maxSupply,
    maxPerTx: decoded.maxPerTx,
    itemsPerBox: decoded.itemsPerBox,
    started: decoded.started,
    minted: decoded.minted,
    namePrefix: decoded.namePrefix,
    figureNamePrefix: decoded.figureNamePrefix,
    symbol: decoded.symbol,
    uriBase: decoded.uriBase,
    bump: decoded.bump,
    mintVariantKind: decoded.mintVariantKind,
    mintVariantStartIds: decoded.mintVariantStartIds,
    mintVariantEndIds: decoded.mintVariantEndIds,
    mintVariantNextIds: decoded.mintVariantNextIds,
    ...(dropSeed ? { dropSeed } : {}),
  };
}

function decodeDiscountMintRecordUsedCount(data: Uint8Array): number {
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
  dropConfig: DropProgramScopeConfig & DropProgramValidationConfig,
): Promise<number> {
  const programId = boxMinterProgramId(dropConfig);
  const cfg = await fetchBoxMinterConfig(connection, dropConfig);
  const [discountRecordPda] = discountMintRecordPda(payer, programId, cfg);
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
  dropConfig: DropProgramScopeConfig & DropProgramValidationConfig,
): Promise<BoxMinterConfigAccount> {
  const programId = boxMinterProgramId(dropConfig);
  const pda = resolveConfiguredBoxMinterConfigPda(dropConfig, programId);
  const info = await retryRpc(() => connection.getAccountInfo(pda, 'confirmed'), {
    retries: 3,
    baseDelayMs: 300,
    maxDelayMs: 2_000,
  });
  if (!info?.data) throw new Error('Box minter is not initialized on this cluster');
  const cfg = decodeBoxMinterConfigAccount(pda, info.data);
  assertBoxMinterConfigMatchesDropConfig(cfg, dropConfig);
  return cfg;
}

export async function fetchMintStatsFromProgram(
  connection: Connection,
  dropConfig: DropProgramConfig,
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

function deriveMintPlan(
  payer: PublicKey,
  programId: PublicKey,
  quantity: number,
  cfg?: ScopedConfigPda,
) {
  const mintId = randomU64();
  const boxAccounts: PublicKey[] = [];
  const boxBumps: number[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const [pda, bump] = boxAssetPda(payer, mintId, i, programId, cfg);
    boxAccounts.push(pda);
    boxBumps.push(bump);
  }
  return { mintId, boxAccounts, boxBumps };
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

function buildMintBoxesInstructionPlan(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  dropConfig: DropProgramConfig,
): BuiltMintInstructionPlan {
  assertStandardMintConfig(cfg);
  const programId = boxMinterProgramId(dropConfig);
  const maxMintsPerTx = normalizeMaxMintsPerTx(dropConfig);

  // IMPORTANT: derive box asset PDAs from (payer + random mintId), not from cfg.minted.
  // This avoids stale-PDA failures when many users mint concurrently.
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, quantity, cfg);

  return {
    instruction: new TransactionInstruction({
      programId,
      keys: [
        { pubkey: cfg.pubkey, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: cfg.treasury, isSigner: false, isWritable: true },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...boxAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: encodeMintBoxesData(quantity, mintId, boxBumps, maxMintsPerTx),
    }),
    boxAccounts,
  };
}

function buildMintDiscountedBoxInstructionPlan(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): BuiltMintInstructionPlan {
  assertStandardMintConfig(cfg);
  const programId = boxMinterProgramId(dropConfig);
  const [discountRecordPda] = discountMintRecordPda(payer, programId, cfg);
  const maxDiscountMints = Math.min(normalizeMaxMintsPerTx(dropConfig), cfg.discountMintsPerWallet);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > maxDiscountMints) {
    throw new Error(`Discount mint quantity must be between 1 and ${maxDiscountMints}`);
  }
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, quantity, cfg);

  return {
    instruction: new TransactionInstruction({
      programId,
      keys: [
        { pubkey: cfg.pubkey, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: discountRecordPda, isSigner: false, isWritable: true },
        { pubkey: cfg.treasury, isSigner: false, isWritable: true },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...boxAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: encodeMintDiscountedBoxData(mintId, boxBumps, proof),
    }),
    boxAccounts,
  };
}

function buildMintVariantInstructionPlan(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  dropConfig: DropProgramConfig,
): BuiltMintInstructionPlan {
  const programId = boxMinterProgramId(dropConfig);
  const variantIndex = resolveMintVariantIndex(cfg, dropConfig, variantKey);
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, 1, cfg);
  return {
    instruction: new TransactionInstruction({
      programId,
      keys: [
        { pubkey: cfg.pubkey, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: cfg.treasury, isSigner: false, isWritable: true },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: boxAccounts[0], isSigner: false, isWritable: true },
      ],
      data: encodeMintVariantBoxData(variantIndex, mintId, boxBumps[0]),
    }),
    boxAccounts,
  };
}

function buildMintDiscountedVariantInstructionPlan(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): BuiltMintInstructionPlan {
  const programId = boxMinterProgramId(dropConfig);
  const [discountRecordPda] = discountMintRecordPda(payer, programId, cfg);
  const variantIndex = resolveMintVariantIndex(cfg, dropConfig, variantKey);
  const { mintId, boxAccounts, boxBumps } = deriveMintPlan(payer, programId, 1, cfg);
  return {
    instruction: new TransactionInstruction({
      programId,
      keys: [
        { pubkey: cfg.pubkey, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: discountRecordPda, isSigner: false, isWritable: true },
        { pubkey: cfg.treasury, isSigner: false, isWritable: true },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: true },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: boxAccounts[0], isSigner: false, isWritable: true },
      ],
      data: encodeMintDiscountedVariantBoxData(variantIndex, mintId, boxBumps[0], proof),
    }),
    boxAccounts,
  };
}

async function buildMintTxFromPlan(
  connection: Connection,
  payer: PublicKey,
  plan: BuiltMintInstructionPlan,
): Promise<BuiltMintTx> {
  return {
    tx: await buildComputeBudgetTransaction(connection, payer, plan.instruction),
    boxAccounts: plan.boxAccounts,
  };
}

export async function buildMintBoxesTxWithAccounts(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  dropConfig: DropProgramConfig,
): Promise<BuiltMintTx> {
  assertStandardMintConfig(cfg);
  const maxMintsPerTx = normalizeMaxMintsPerTx(dropConfig);
  // Keep conservative; each Core mint creates a new account.
  if (quantity > maxMintsPerTx) {
    throw new Error(`Max ${maxMintsPerTx} boxes per transaction.`);
  }

  return buildMintTxFromPlan(connection, payer, buildMintBoxesInstructionPlan(cfg, payer, quantity, dropConfig));
}

export async function buildMintDiscountedBoxTxWithAccounts(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  quantity: number,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): Promise<BuiltMintTx> {
  return buildMintTxFromPlan(connection, payer, buildMintDiscountedBoxInstructionPlan(cfg, payer, quantity, proof, dropConfig));
}

export async function buildMintVariantBoxTxWithAccounts(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  dropConfig: DropProgramConfig,
): Promise<BuiltMintTx> {
  return buildMintTxFromPlan(connection, payer, buildMintVariantInstructionPlan(cfg, payer, variantKey, dropConfig));
}

export async function buildMintDiscountedVariantBoxTxWithAccounts(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  variantKey: string,
  proof: Uint8Array[],
  dropConfig: DropProgramConfig,
): Promise<BuiltMintTx> {
  return buildMintTxFromPlan(
    connection,
    payer,
    buildMintDiscountedVariantInstructionPlan(cfg, payer, variantKey, proof, dropConfig),
  );
}

function buildStartOpenBoxInstructionPlan(
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  boxAsset: PublicKey,
  dropConfig: DropProgramConfig,
): BuiltStartOpenBoxInstructionPlan {
  if (cfg.itemsPerBox < MIN_OPENABLE_ITEMS_PER_BOX) {
    throw new Error('This drop does not support opening.');
  }
  const programId = boxMinterProgramId(dropConfig);
  const [pendingPda] = pendingOpenPda(boxAsset, programId);
  const dudePdas = Array.from({ length: cfg.itemsPerBox }, (_, i) => pendingDudeAssetPda(pendingPda, i, cfg.itemsPerBox, programId)[0]);

  return {
    instruction: new TransactionInstruction({
      programId,
      keys: [
        { pubkey: cfg.pubkey, isSigner: false, isWritable: false },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: boxAsset, isSigner: false, isWritable: true },
        { pubkey: cfg.admin, isSigner: false, isWritable: false },
        { pubkey: cfg.coreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: pendingPda, isSigner: false, isWritable: true },
        ...dudePdas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: Buffer.from(IX_START_OPEN_BOX),
    }),
    pendingPda,
  };
}

export async function buildStartOpenBoxTxWithPending(
  connection: Connection,
  cfg: BoxMinterConfigAccount,
  payer: PublicKey,
  boxAsset: PublicKey,
  dropConfig: DropProgramConfig,
): Promise<BuiltStartOpenBoxTx> {
  const { instruction, pendingPda } = buildStartOpenBoxInstructionPlan(cfg, payer, boxAsset, dropConfig);
  return {
    tx: await buildComputeBudgetTransaction(connection, payer, instruction),
    pendingPda,
  };
}
