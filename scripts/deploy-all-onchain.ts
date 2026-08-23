import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { isDeepStrictEqual } from 'node:util';
import { loadNewDropConfigById, newDropConfigUsage } from './shared/newDropLoader.ts';
import type { NewDropOnchainConfig, SolanaCluster } from './shared/newDropConfig.ts';
import { parsePrivateKeyInput, promptMaskedInput } from './shared/interactive.ts';
import {
  requireDiscountMerkleDatasetIdentity,
  validateDiscountMerkleFamilyRootInvariant,
  type DiscountMerkleDatasetReference,
} from './shared/discountMerkleDataset.ts';
import {
  acquireDeploymentRegistryMutationLock,
  assertReceiptPoolDropRelations,
  DeploymentRegistryPostCommitVerificationError,
  normalizeDropBase,
  normalizeDropSalesMode,
  normalizeAndValidateDropId,
  readDeploymentDropRegistry,
  renderDeploymentRegistryFileFromSource,
  resolveDropAssetUrl,
  resolveStripeCheckoutEnabledForDropFamily,
  resolveStripeProductTaxCodeForDropFamily,
  requireDropFamily,
  writeDeploymentRegistryFile,
  type DeploymentDropConfigSerialized,
  type DropFamily,
  type DropSalesMode,
  type MetadataPathFormat,
  type MintSelectionConfigSerialized,
  type PaymentRoutingConfig,
  type ReceiptPoolDeployment,
} from './shared/deploymentRegistry.ts';
import {
  requireReceiptPoolSpec,
  type ReceiptPoolSpec,
} from './shared/receiptPoolConfig.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS,
  decodeBoxMinterConfigData,
} from '../shared/boxMinterConfigCodec.ts';
import {
  assertStripeLivePriceConfigured,
  STRIPE_UNIT_AMOUNT_CENTS_MAX,
  STRIPE_UNIT_AMOUNT_CENTS_MIN,
} from '../shared/stripeCheckoutCore.ts';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_KIND_SIZE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT,
} from '../shared/boxMinterProtocol.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../shared/solanaProgramAddresses.ts';
import {
  clusterApiUrl,
  AddressLookupTableProgram,
  Connection,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Commitment,
} from '@solana/web3.js';

// MPL Core program id.
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
// SPL Noop program (Metaplex "log wrapper").
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
// Metaplex Noop program (Bubblegum v2 log wrapper).
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
// Metaplex Account Compression program (used by Bubblegum v2 trees).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
);
// Metaplex Bubblegum program.
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
// Bubblegum -> MPL-Core CPI signer.
const MPL_CORE_CPI_SIGNER_ID = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);
// NOTE: This repo uses uncompressed MPL-Core for boxes/figures and Bubblegum v2 cNFTs for receipts.

const MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY = 2;

// ---------------------------------------------------------------------------
// Edit scripts/newDrops/<dropId>.ts to change deploy + drop behavior.
// This script requires the target dropId so it can load that config file.
// NOTE: Metaplex programs (MPL Core/Bubblegum/etc) are often NOT deployed on Solana testnet.
// If you hit "Attempt to load a program that does not exist", use devnet or mainnet-beta.
// ---------------------------------------------------------------------------

const DEFAULT_NEW_DROP_CONFIG_PATH = 'scripts/newDrops/<dropId>.ts';

let activeNewDropConfigPath = DEFAULT_NEW_DROP_CONFIG_PATH;

function setActiveNewDropConfigPath(root: string, configPath: string) {
  const relativePath = path.relative(root, configPath);
  activeNewDropConfigPath = relativePath || configPath;
}

function getActiveNewDropConfigPath(): string {
  return activeNewDropConfigPath;
}

export function getConcurrentMerkleTreeAccountSize(maxDepth: number, maxBufferSize: number, canopyDepth: number): number {
  // Matches @solana/spl-account-compression sizing (ConcurrentMerkleTreeHeaderDataV1 + tree + optional canopy).
  const headerSize = 4 + 4 + 32 + 8 + 1 + 5;
  const nodeSize = 40 + 32 * maxDepth;
  const treeSize = 24 + (maxBufferSize + 1) * nodeSize;
  const canopySize = canopyDepth > 0 ? Math.max((Math.pow(2, canopyDepth + 1) - 2) * 32, 0) : 0;
  return 2 + headerSize + treeSize + canopySize;
}

async function assertExecutableProgram(args: {
  connection: Connection;
  cluster: SolanaCluster;
  programId: PublicKey;
  name: string;
}) {
  const { connection, cluster, programId, name } = args;
  const info = await retryRpcRead(`getAccountInfo(${name})`, () => connection.getAccountInfo(programId, { commitment: 'confirmed' }));
  if (!info) {
    const hint =
      cluster === 'testnet'
        ? `\nNote: Metaplex programs are often not deployed on Solana testnet. Use devnet instead (set NEW_DROP.shared.isMainnet=false in ${getActiveNewDropConfigPath()}).`
        : '';
    throw new Error(
      `${name} program is not deployed on this cluster.\n` +
        `- cluster: ${cluster}\n` +
        `- rpc    : ${connection.rpcEndpoint}\n` +
        `- program: ${programId.toBase58()}` +
        hint,
    );
  }
  if (!info.executable) {
    throw new Error(
      `${name} program account exists but is not executable.\n` +
        `- cluster: ${cluster}\n` +
        `- rpc    : ${connection.rpcEndpoint}\n` +
        `- program: ${programId.toBase58()}\n` +
        `- owner  : ${info.owner.toBase58()}`,
    );
  }
}

async function assertExternalProgramsDeployed(connection: Connection, cluster: SolanaCluster) {
  await assertExecutableProgram({ connection, cluster, programId: MPL_CORE_PROGRAM_ID, name: 'MPL Core' });
  await assertExecutableProgram({ connection, cluster, programId: BUBBLEGUM_PROGRAM_ID, name: 'Metaplex Bubblegum' });
  await assertExecutableProgram({
    connection,
    cluster,
    programId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    name: 'Metaplex Account Compression',
  });
  await assertExecutableProgram({
    connection,
    cluster,
    programId: MPL_NOOP_PROGRAM_ID,
    name: 'Metaplex Noop (Bubblegum log wrapper)',
  });
}

async function sendAndConfirmTx(args: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
  label: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}): Promise<string> {
  const { connection, tx, signers, label, commitment = 'confirmed' } = args;
  try {
    return await sendAndConfirmTransaction(connection, tx, signers, { commitment });
  } catch (err) {
    const anyErr = err as any;
    const msg =
      (typeof anyErr?.transactionMessage === 'string' && anyErr.transactionMessage) ||
      (anyErr instanceof Error ? anyErr.message : String(anyErr));
    const programIds = Array.from(new Set(tx.instructions.map((ix) => ix.programId.toBase58())));

    console.error(`\n❌ Transaction failed (${label})`);
    console.error('RPC:', connection.rpcEndpoint);
    console.error('Program IDs in tx:', programIds.join(', ') || '(none)');
    if (msg) console.error('Error:', msg);

    // Try to print simulation logs (web3.js attaches `getLogs()` to SendTransactionError).
    if (typeof anyErr?.getLogs === 'function') {
      try {
        const logs = await anyErr.getLogs(connection);
        if (Array.isArray(logs) && logs.length) {
          console.error('--- logs ---');
          for (const l of logs) console.error(l);
        }
      } catch {
        // ignore
      }
    } else if (Array.isArray(anyErr?.transactionLogs) && anyErr.transactionLogs.length) {
      console.error('--- logs ---');
      for (const l of anyErr.transactionLogs) console.error(l);
    }

    if (typeof msg === 'string' && msg.includes('Attempt to load a program that does not exist')) {
      console.error('\nTip: one of the program IDs above is missing on this cluster/RPC.');
    }
    throw err;
  }
}

function writeTempKeypairFile(kp: Keypair, prefix = 'mons-shop-deployer'): string {
  const filePath = path.join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  // solana-cli expects a JSON array of 64 u8 values.
  writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return filePath;
}

type DeploymentCleanupEvent = 'exit' | 'SIGINT' | 'SIGTERM';

type DeploymentCleanupRuntime = {
  once: (event: DeploymentCleanupEvent, listener: () => void) => void;
  off: (event: DeploymentCleanupEvent, listener: () => void) => void;
  exit: (code: number) => void;
};

export function registerDeploymentCleanup(args: {
  releaseDeploymentRegistryLock: () => boolean;
  runtime?: DeploymentCleanupRuntime;
}): {
  setTempKeypairPath: (filePath: string) => void;
  cleanup: () => boolean;
} {
  const runtime =
    args.runtime ||
    ({
      once: (event, listener) => process.once(event, listener),
      off: (event, listener) => process.off(event, listener),
      exit: (code) => process.exit(code),
    } satisfies DeploymentCleanupRuntime);
  let tempKeypairPath: string | undefined;
  let complete = false;
  let terminating = false;

  const removeTempKeypair = (): boolean => {
    if (!tempKeypairPath) return true;
    try {
      unlinkSync(tempKeypairPath);
      tempKeypairPath = undefined;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        tempKeypairPath = undefined;
        return true;
      }
      try {
        console.warn(
          `⚠️  Failed to remove temporary deployer keypair ${tempKeypairPath}: ${errorMessage(err)}`,
        );
      } catch {
        // Cleanup warnings must not disrupt the caller.
      }
      return false;
    }
  };

  const onExit = () => {
    cleanup();
  };
  const terminate = (exitCode: number) => {
    if (terminating) return;
    terminating = true;
    cleanup();
    runtime.exit(exitCode);
  };
  const onSigint = () => terminate(130);
  const onSigterm = () => terminate(143);
  const detach = () => {
    runtime.off('exit', onExit);
    runtime.off('SIGINT', onSigint);
    runtime.off('SIGTERM', onSigterm);
  };
  const cleanup = (): boolean => {
    if (complete) return true;
    const tempKeypairRemoved = removeTempKeypair();
    let lockReleased = false;
    try {
      lockReleased = args.releaseDeploymentRegistryLock();
    } catch (err) {
      try {
        console.warn(`⚠️  Failed to release deployment-registry lock: ${errorMessage(err)}`);
      } catch {
        // Cleanup warnings must not disrupt the caller.
      }
    }
    if (tempKeypairRemoved && lockReleased) {
      complete = true;
      detach();
    }
    return complete;
  };

  runtime.once('exit', onExit);
  runtime.once('SIGINT', onSigint);
  runtime.once('SIGTERM', onSigterm);

  return {
    setTempKeypairPath: (filePath) => {
      if (complete) {
        throw new Error('Cannot register a temporary deployer keypair after deployment cleanup completed');
      }
      tempKeypairPath = filePath;
    },
    cleanup,
  };
}

function normalizeDropId(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function deriveDropSeed(dropId: string): Buffer {
  return sha256(Buffer.from(normalizeDropId(dropId), 'utf8'));
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

function describeExistingBoxMinterConfig(configData: Buffer): string {
  try {
    const cfg = decodeBoxMinterConfigForDeployPreflight(configData);
    return (
      `- existing admin   : ${cfg.admin.toBase58()}\n` +
      `- existing minted  : ${cfg.minted}/${cfg.maxSupply}\n` +
      `- existing uriBase : ${cfg.uriBase}`
    );
  } catch (err) {
    return (
      `- existing bytes   : ${configData.length}\n` +
      `- existing decode  : ${errorMessage(err)}`
    );
  }
}

function requireNonEmptyString(value: string, label: string): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    throw new Error(`Missing ${label} in ${getActiveNewDropConfigPath()}`);
  }
  return trimmed;
}

function requireRoyaltiesBps(value: number | undefined): number {
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`Invalid NEW_DROP.onchain.coreCollectionRoyaltiesBps: ${value} (expected an integer from 0 to 10000)`);
  }
  return bps;
}

function requireIntegerInRange(args: {
  value: number;
  label: string;
  min: number;
  max?: number;
}): number {
  const n = Number(args.value);
  if (!Number.isInteger(n) || n < args.min || (typeof args.max === 'number' && n > args.max)) {
    const range = typeof args.max === 'number' ? `${args.min}..${args.max}` : `>= ${args.min}`;
    throw new Error(`Invalid ${args.label}: ${args.value} (expected an integer in ${range})`);
  }
  return n;
}

type PreparedReceiptsTreeConfig = {
  maxDepth: number;
  maxBufferSize: number;
  canopyDepth: number;
};

function formatReceiptsTreeConfig(tree: PreparedReceiptsTreeConfig): string {
  return `maxDepth=${tree.maxDepth}, maxBufferSize=${tree.maxBufferSize}, canopyDepth=${tree.canopyDepth}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryRpcRead<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 4);
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 4_000);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      console.warn(`⚠️  ${label} failed (${errorMessage(err)}). Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} failed after ${retries + 1} attempts: ${errorMessage(lastErr)}`);
}

function requireItemsPerBox(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
    max: BOX_MINTER_MAX_ITEMS_PER_BOX,
  });
}

function requireDiscountMintsPerWallet(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
    max: BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  });
}

function requireStripeLiveUnitAmountCents(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: STRIPE_UNIT_AMOUNT_CENTS_MIN,
    max: STRIPE_UNIT_AMOUNT_CENTS_MAX,
  });
}

type PreparedStripeCheckoutConfig = {
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
};

export function prepareStripeCheckoutConfig(args: {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
}): PreparedStripeCheckoutConfig {
  const stripeCheckout = resolveStripeCheckoutEnabledForDropFamily(args.stripeCheckoutEnabled, args.dropFamily);
  const stripeLiveUnitAmountCents =
    args.stripeLiveUnitAmountCents == null
      ? undefined
      : requireStripeLiveUnitAmountCents(args.stripeLiveUnitAmountCents, 'stripeLiveUnitAmountCents');

  assertStripeLivePriceConfigured({
    dropId: normalizeDropId(args.dropId),
    solanaCluster: args.solanaCluster,
    stripeCheckoutEnabled: stripeCheckout.enabled,
    stripeLiveUnitAmountCents,
  });

  return {
    ...(stripeCheckout.enabled ? { stripeCheckoutEnabled: true } : stripeCheckout.disabledOverride ? { stripeCheckoutEnabled: false } : {}),
    ...(stripeLiveUnitAmountCents != null ? { stripeLiveUnitAmountCents } : {}),
  };
}

function requireMaxFigureIdWithinU16(args: {
  maxSupply: number;
  maxSupplyLabel: string;
  itemsPerBox: number;
  itemsPerBoxLabel: string;
}) {
  const maxSupply = requireIntegerInRange({
    value: args.maxSupply,
    label: args.maxSupplyLabel,
    min: 1,
    max: 0xffff_ffff,
  });
  const itemsPerBox = requireItemsPerBox(args.itemsPerBox, args.itemsPerBoxLabel);
  const maxFigureId = maxSupply * itemsPerBox;
  if (!Number.isSafeInteger(maxFigureId) || maxFigureId > 0xffff) {
    throw new Error(
      `Configured figure id space exceeds on-chain u16 capacity.\n` +
        `- ${args.maxSupplyLabel}: ${maxSupply}\n` +
        `- ${args.itemsPerBoxLabel}: ${itemsPerBox}\n` +
        `- max figure id (maxSupply * itemsPerBox): ${maxFigureId}\n` +
        `- maximum supported                     : 65535\n` +
        `\n` +
        `Fix: lower maxSupply or itemsPerBox in ${getActiveNewDropConfigPath()}.`,
    );
  }
}

function prepareReceiptsTreeConfig(
  dropCfg: NewDropOnchainConfig,
  receiptPoolSpec?: ReceiptPoolSpec | null,
): PreparedReceiptsTreeConfig {
  const configuredTree =
    receiptPoolSpec?.receiptsTree || dropCfg.receiptsTree;
  if (!configuredTree || typeof configuredTree !== 'object') {
    throw new Error(`Missing NEW_DROP.onchain.receiptsTree in ${getActiveNewDropConfigPath()}`);
  }
  const receiptsTreeCfg = configuredTree;
  const maxDepth = requireIntegerInRange({
    value: receiptsTreeCfg.maxDepth,
    label: 'NEW_DROP.onchain.receiptsTree.maxDepth',
    min: 1,
    max: 30,
  });
  const maxBufferSize = requireIntegerInRange({
    value: receiptsTreeCfg.maxBufferSize,
    label: 'NEW_DROP.onchain.receiptsTree.maxBufferSize',
    min: 1,
  });
  const canopyDepth = requireIntegerInRange({
    value: receiptsTreeCfg.canopyDepth,
    label: 'NEW_DROP.onchain.receiptsTree.canopyDepth',
    min: 0,
    max: maxDepth - 1,
  });

  return { maxDepth, maxBufferSize, canopyDepth };
}

function assertReceiptsTreeCapacityForMaxSupply(args: {
  tree: PreparedReceiptsTreeConfig;
  maxSupply: number;
  maxSupplyLabel: string;
  itemsPerBox: number;
  itemsPerBoxLabel: string;
}) {
  const maxSupply = requireIntegerInRange({
    value: args.maxSupply,
    label: args.maxSupplyLabel,
    min: 1,
    max: 0xffff_ffff,
  });
  const itemsPerBox = requireItemsPerBox(args.itemsPerBox, args.itemsPerBoxLabel);
  requireMaxFigureIdWithinU16({
    maxSupply,
    maxSupplyLabel: args.maxSupplyLabel,
    itemsPerBox,
    itemsPerBoxLabel: args.itemsPerBoxLabel,
  });
  // Receipts are minted as one item/box receipt plus one figure receipt per revealed figure.
  // Direct-delivery drops have itemsPerBox=0, so each supply unit needs exactly one receipt leaf.
  const receiptLeavesPerSupplyUnit = 1 + itemsPerBox;
  const requiredLeaves = maxSupply * receiptLeavesPerSupplyUnit;
  const treeCapacity = 2 ** args.tree.maxDepth;
  if (treeCapacity < requiredLeaves) {
    throw new Error(
      `NEW_DROP.onchain.receiptsTree is too small for this drop.\n` +
        `- max supply source                       : ${args.maxSupplyLabel}\n` +
        `- itemsPerBox source                      : ${args.itemsPerBoxLabel}\n` +
        `- required leaves (maxSupply * ${receiptLeavesPerSupplyUnit}) : ${requiredLeaves}\n` +
        `- configured capacity (2^maxDepth)               : ${treeCapacity}\n` +
        `\n` +
        `Fix: increase NEW_DROP.onchain.receiptsTree.maxDepth in ${getActiveNewDropConfigPath()}.`,
    );
  }
}

function assertReceiptPoolDeploymentMatchesSpec(args: {
  deployment: ReceiptPoolDeployment;
  spec: ReceiptPoolSpec;
  solanaCluster: SolanaCluster;
}): void {
  const expected: Omit<
    ReceiptPoolDeployment,
    'collectionMint' | 'receiptsMerkleTree'
  > = {
    solanaCluster: args.solanaCluster,
    receiptPoolId: args.spec.receiptPoolId,
    authority: args.spec.authority,
    collectionMetadataUri: args.spec.collectionMetadataUri,
    collectionName: args.spec.collectionName,
    collectionSymbol: args.spec.collectionSymbol,
    royaltiesBasisPoints: args.spec.royaltiesBasisPoints,
    royaltiesRecipient: args.spec.royaltiesRecipient,
    receiptsTreeMaxDepth: args.spec.receiptsTree.maxDepth,
    receiptsTreeMaxBufferSize: args.spec.receiptsTree.maxBufferSize,
    receiptsTreeCanopyDepth: args.spec.receiptsTree.canopyDepth,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (
      args.deployment[field as keyof ReceiptPoolDeployment] !== value
    ) {
      throw new Error(
        `Receipt pool ${args.solanaCluster}:${args.spec.receiptPoolId} ${field} mismatch`,
      );
    }
  }
  new PublicKey(args.deployment.collectionMint);
  new PublicKey(args.deployment.receiptsMerkleTree);
}

export function assertReceiptPoolCapacity(args: {
  solanaCluster: SolanaCluster;
  receiptPoolId: string;
  metadataBase: string;
  maxSupply: number;
  treeMaxDepth: number;
  existingDrops: Record<string, DeploymentDropConfigSerialized>;
  onchainNumMinted?: number;
}): { reservedLeaves: number; capacity: number } {
  const members = Object.values(args.existingDrops).filter(
    (drop) =>
      drop.solanaCluster === args.solanaCluster &&
      drop.receiptPoolId === args.receiptPoolId,
  );
  if (
    members.some(
      (drop) =>
        normalizeDropBase(drop.metadataBase) ===
        normalizeDropBase(args.metadataBase),
    )
  ) {
    throw new Error(
      `Receipt pool ${args.solanaCluster}:${args.receiptPoolId} already has a drop using metadataBase ${args.metadataBase}`,
    );
  }
  const existingReservation = members.reduce(
    (sum, drop) => sum + drop.maxSupply,
    0,
  );
  const maxSupply = requireIntegerInRange({
    value: args.maxSupply,
    label: 'receipt pool maxSupply',
    min: 1,
    max: 0xffff_ffff,
  });
  const reservedLeaves = existingReservation + maxSupply;
  const capacity = 2 ** args.treeMaxDepth;
  if (reservedLeaves > capacity) {
    throw new Error(
      `Receipt pool ${args.solanaCluster}:${args.receiptPoolId} capacity exceeded: ${reservedLeaves}/${capacity} reserved leaves`,
    );
  }
  if (
    args.onchainNumMinted != null &&
    args.onchainNumMinted > existingReservation
  ) {
    throw new Error(
      `Receipt pool ${args.solanaCluster}:${args.receiptPoolId} has ${args.onchainNumMinted} minted leaves but only ${existingReservation} registered leaves before this drop`,
    );
  }
  return { reservedLeaves, capacity };
}

type PreparedInitDropInputs = {
  requiredDropMetadataBase: string;
  discountMerkle: { root: Buffer; proofs: Record<string, string[]> };
};

function prepareMintSelectionConfig(dropCfg: NewDropOnchainConfig): MintSelectionConfigSerialized | undefined {
  const selection = dropCfg.mintSelection;
  if (!selection) return undefined;
  if (selection.kind !== 'size') {
    throw new Error(`Unsupported NEW_DROP.onchain.mintSelection.kind: ${String((selection as { kind?: unknown }).kind ?? '')}`);
  }
  if (dropCfg.itemsPerBox !== 0) {
    throw new Error(
      `NEW_DROP.onchain.mintSelection.kind='size' currently supports direct-delivery drops only.\n` +
        `Fix: set NEW_DROP.onchain.itemsPerBox=0 for this drop.`,
    );
  }
  const options = Array.isArray(selection.options) ? selection.options : [];
  if (options.length !== BOX_MINTER_MINT_VARIANT_OPTION_COUNT) {
    throw new Error(
      `NEW_DROP.onchain.mintSelection.options must contain exactly ${BOX_MINTER_MINT_VARIANT_OPTION_COUNT} size options.`,
    );
  }
  const normalized = options.map((option, index) => {
    const key = requireNonEmptyString(option.key, `NEW_DROP.onchain.mintSelection.options[${index}].key`);
    const label = requireNonEmptyString(option.label, `NEW_DROP.onchain.mintSelection.options[${index}].label`);
    const startId = requireIntegerInRange({
      value: option.startId,
      label: `NEW_DROP.onchain.mintSelection.options[${index}].startId`,
      min: 1,
      max: 0xffff_ffff,
    });
    const endId = requireIntegerInRange({
      value: option.endId,
      label: `NEW_DROP.onchain.mintSelection.options[${index}].endId`,
      min: startId,
      max: 0xffff_ffff,
    });
    return { key, label, startId, endId };
  });
  const seenKeys = new Set<string>();
  normalized.forEach((option, index) => {
    if (seenKeys.has(option.key)) {
      throw new Error(`Duplicate NEW_DROP.onchain.mintSelection.options[${index}].key: ${option.key}`);
    }
    seenKeys.add(option.key);
  });
  normalized.forEach((option, index) => {
    if (index === 0 && option.startId !== 1) {
      throw new Error('NEW_DROP.onchain.mintSelection.options[0].startId must be 1.');
    }
    if (index > 0) {
      const prev = normalized[index - 1];
      if (option.startId !== prev.endId + 1) {
        throw new Error(
          `NEW_DROP.onchain.mintSelection.options[${index}] must start immediately after the previous range ends.\n` +
            `- previous endId: ${prev.endId}\n` +
            `- current startId: ${option.startId}`,
        );
      }
    }
  });
  const lastEndId = normalized[normalized.length - 1]?.endId || 0;
  if (lastEndId !== dropCfg.maxSupply) {
    throw new Error(
      `NEW_DROP.onchain.mintSelection ranges must exactly cover 1..maxSupply.\n` +
        `- configured maxSupply: ${dropCfg.maxSupply}\n` +
        `- final endId        : ${lastEndId}`,
    );
  }
  return {
    kind: 'size',
    options: normalized,
  };
}

type PreparedCollectionMetadata = {
  name: string;
  symbol: string;
  sellerFeeBasisPoints: number;
  description?: string;
  externalUrl?: string;
  image?: string;
  creators?: MplCoreRoyaltyCreator[];
};

function prepareCollectionMetadata(
  dropCfg: NewDropOnchainConfig,
  receiptPoolSpec?: ReceiptPoolSpec | null,
): PreparedCollectionMetadata {
  if (receiptPoolSpec) {
    return {
      name: receiptPoolSpec.collectionName,
      symbol: receiptPoolSpec.collectionSymbol,
      sellerFeeBasisPoints: receiptPoolSpec.royaltiesBasisPoints,
      description: receiptPoolSpec.collectionDescription,
      externalUrl: receiptPoolSpec.collectionExternalUrl,
      image: receiptPoolSpec.collectionImage,
    };
  }
  if (!dropCfg.collectionMetadata || typeof dropCfg.collectionMetadata !== 'object') {
    throw new Error(`Missing NEW_DROP.onchain.collectionMetadata in ${getActiveNewDropConfigPath()}`);
  }
  const collectionMetadataCfg = dropCfg.collectionMetadata;
  const name = requireNonEmptyString(collectionMetadataCfg.name, 'NEW_DROP.onchain.collectionMetadata.name');
  const symbol = requireNonEmptyString(collectionMetadataCfg.symbol, 'NEW_DROP.onchain.collectionMetadata.symbol');
  const sellerFeeBasisPoints = requireIntegerInRange({
    value: collectionMetadataCfg.sellerFeeBasisPoints,
    label: 'NEW_DROP.onchain.collectionMetadata.sellerFeeBasisPoints',
    min: 0,
    max: 10_000,
  });
  const creators = collectionMetadataCfg.creators
    ? parseCollectionRoyaltyCreators({
        properties: { creators: collectionMetadataCfg.creators },
      })
    : undefined;
  return {
    name,
    symbol,
    sellerFeeBasisPoints,
    description: trimToUndefined(collectionMetadataCfg.description),
    externalUrl: trimToUndefined(collectionMetadataCfg.externalUrl),
    image: trimToUndefined(collectionMetadataCfg.image),
    ...(creators ? { creators } : {}),
  };
}

function formatJsonValueForError(value: unknown): string {
  if (typeof value === 'undefined') return '(missing)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTrimmedStringField(value: unknown): string | undefined {
  return typeof value === 'string' ? trimToUndefined(value) : undefined;
}

function extractIntegerField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export type MplCoreRoyaltyCreator = {
  address: PublicKey;
  percentage: number;
};

export function parseCollectionRoyaltyCreators(
  collectionJson: unknown,
): MplCoreRoyaltyCreator[] {
  if (
    !collectionJson ||
    typeof collectionJson !== 'object' ||
    Array.isArray(collectionJson)
  ) {
    throw new Error('collection.json must be an object');
  }
  const json = collectionJson as Record<string, unknown>;
  if (
    !json.properties ||
    typeof json.properties !== 'object' ||
    Array.isArray(json.properties)
  ) {
    throw new Error('collection.json properties must be an object');
  }
  const properties = json.properties as Record<string, unknown>;
  if (!Array.isArray(properties.creators) || properties.creators.length === 0) {
    throw new Error('collection.json properties.creators must contain at least one creator');
  }

  const seen = new Set<string>();
  const creators = properties.creators.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`collection.json properties.creators[${index}] must be an object`);
    }
    const creator = value as Record<string, unknown>;
    const addressValue = extractTrimmedStringField(creator.address);
    if (!addressValue) {
      throw new Error(`collection.json properties.creators[${index}].address must be a Solana address`);
    }
    let address: PublicKey;
    try {
      address = new PublicKey(addressValue);
    } catch {
      throw new Error(`collection.json properties.creators[${index}].address is not a valid Solana address`);
    }
    if (address.equals(PublicKey.default)) {
      throw new Error(`collection.json properties.creators[${index}].address must not be the default address`);
    }
    const normalizedAddress = address.toBase58();
    if (seen.has(normalizedAddress)) {
      throw new Error(`collection.json properties.creators contains duplicate address ${normalizedAddress}`);
    }
    seen.add(normalizedAddress);
    const percentage = extractIntegerField(creator.share);
    if (percentage == null || percentage <= 0 || percentage > 100) {
      throw new Error(`collection.json properties.creators[${index}].share must be a positive whole percentage`);
    }
    return { address, percentage };
  });
  const total = creators.reduce((sum, creator) => sum + creator.percentage, 0);
  if (total !== 100) {
    throw new Error(`collection.json properties.creators shares must total 100, got ${total}`);
  }
  return creators;
}

export function assertCollectionRoyaltyCreatorsUnchanged(
  expected: readonly MplCoreRoyaltyCreator[],
  actual: readonly MplCoreRoyaltyCreator[],
): void {
  const expectedFingerprint = collectionRoyaltyCreatorsFingerprint(expected);
  const actualFingerprint = collectionRoyaltyCreatorsFingerprint(actual);
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(
      `collection.json properties.creators changed during deployment: expected ${expectedFingerprint}, got ${actualFingerprint}`,
    );
  }
}

function collectionRoyaltyCreatorsFingerprint(
  creators: readonly MplCoreRoyaltyCreator[],
): string {
  return JSON.stringify(
    creators.map((creator) => [
      creator.address.toBase58(),
      creator.percentage,
    ]),
  );
}

async function assertCollectionMetadataJsonMatchesNewDrop(args: {
  metadataBase: string;
  collectionMetadataUri?: string;
  expectedCreator?: string;
  expected: PreparedCollectionMetadata;
}): Promise<{ creators: MplCoreRoyaltyCreator[] }> {
  const collectionJsonUrl =
    trimToUndefined(args.collectionMetadataUri) ||
    `${args.metadataBase}/collection.json`;
  const collectionJsonFetchUrl = resolveDropAssetUrl(collectionJsonUrl);
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetch(collectionJsonFetchUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `Failed to fetch collection metadata JSON for preflight validation.\n` +
        `- url: ${collectionJsonUrl}\n` +
        `- fetch url: ${collectionJsonFetchUrl}\n` +
        `- error: ${errorMessage(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch collection metadata JSON for preflight validation.\n` +
        `- url: ${collectionJsonUrl}\n` +
        `- fetch url: ${collectionJsonFetchUrl}\n` +
        `- http status: ${response.status} ${response.statusText}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Error(
      `Invalid JSON at collection metadata URL.\n` +
        `- url: ${collectionJsonUrl}\n` +
        `- fetch url: ${collectionJsonFetchUrl}\n` +
        `- error: ${errorMessage(err)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid collection metadata payload at ${collectionJsonUrl} (expected a JSON object at top-level).`,
    );
  }

  const json = parsed as Record<string, unknown>;
  let creators: MplCoreRoyaltyCreator[];
  try {
    creators = parseCollectionRoyaltyCreators(json);
  } catch (err) {
    throw new Error(
      `collection.json preflight validation failed.\n` +
        `- url: ${collectionJsonUrl}\n` +
        `- fetch url: ${collectionJsonFetchUrl}\n` +
        `- ${errorMessage(err)}`,
    );
  }
  const mismatches: string[] = [];
  const checkStringField = (field: string, expected: string, actualValue: unknown) => {
    const actual = extractTrimmedStringField(actualValue);
    if (actual !== expected) {
      mismatches.push(`${field}: expected "${expected}", got ${formatJsonValueForError(actualValue)}`);
    }
  };

  checkStringField('name', args.expected.name, json.name);
  checkStringField('symbol', args.expected.symbol, json.symbol);

  const actualSellerFeeBps = extractIntegerField(json.seller_fee_basis_points);
  if (actualSellerFeeBps !== args.expected.sellerFeeBasisPoints) {
    mismatches.push(
      `seller_fee_basis_points: expected ${args.expected.sellerFeeBasisPoints}, got ${formatJsonValueForError(
        json.seller_fee_basis_points,
      )}`,
    );
  }

  if (typeof args.expected.description === 'string') {
    checkStringField('description', args.expected.description, json.description);
  }
  if (typeof args.expected.externalUrl === 'string') {
    checkStringField('external_url', args.expected.externalUrl, json.external_url);
  }
  if (typeof args.expected.image === 'string') {
    checkStringField('image', args.expected.image, json.image);
  }
  if (args.expectedCreator) {
    if (
      creators.length !== 1 ||
      creators[0].address.toBase58() !== args.expectedCreator ||
      creators[0].percentage !== 100
    ) {
      mismatches.push(
        `properties.creators: expected ${args.expectedCreator} (100%)`,
      );
    }
  }
  if (
    args.expected.creators &&
    collectionRoyaltyCreatorsFingerprint(creators) !==
      collectionRoyaltyCreatorsFingerprint(args.expected.creators)
  ) {
    mismatches.push(
      `properties.creators: expected ${collectionRoyaltyCreatorsFingerprint(args.expected.creators)}, got ${collectionRoyaltyCreatorsFingerprint(creators)}`,
    );
  }

  if (mismatches.length) {
    throw new Error(
      `collection.json preflight validation failed.\n` +
        `- url: ${collectionJsonUrl}\n` +
        `- fetch url: ${collectionJsonFetchUrl}\n` +
        mismatches.map((line) => `- ${line}`).join('\n') +
        `\n` +
        `Fix ${getActiveNewDropConfigPath()} or the collection.json content before deploying.`,
    );
  }
  return { creators };
}

export async function assertReceiptMetadataRange(args: {
  metadataBase: string;
  maxSupply: number;
  treeCapacity: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const treeCapacity = requireIntegerInRange({
    value: args.treeCapacity,
    label: 'receipt metadata treeCapacity',
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const maxSupply = requireIntegerInRange({
    value: args.maxSupply,
    label: 'receipt metadata maxSupply',
    min: 1,
    max: treeCapacity,
  });
  const fetchImpl = args.fetchImpl ?? fetch;
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const validateNext = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= maxSupply) return;
      const expectedId = index + 1;
      const url = `${args.metadataBase}/rb${expectedId}.json`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await fetchImpl(resolveDropAssetUrl(url), {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        if (!failed) {
          firstError = new Error(
            `Receipt metadata ${expectedId} returned ${response.status}: ${url}`,
          );
        }
        failed = true;
        return;
      }
      let value: Record<string, unknown>;
      try {
        value = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.id !== expectedId ||
        !extractTrimmedStringField(value.name) ||
        !extractTrimmedStringField(value.image)
      ) {
        if (!failed) {
          firstError = new Error(
            `Receipt metadata ${expectedId} is missing sequential id, name, or image: ${url}`,
          );
        }
        failed = true;
        return;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(16, maxSupply) },
      () => validateNext(),
    ),
  );
  if (failed) throw firstError;
}

function prepareInitDropInputs(args: {
  root: string;
  dropCfg: NewDropOnchainConfig;
  dropMetadataBase: string;
}): PreparedInitDropInputs {
  const discountWhitelistCsvRelativePath = requireNonEmptyString(
    args.dropCfg.discountWhitelistCsvRelativePath,
    'NEW_DROP.onchain.discountWhitelistCsvRelativePath',
  );
  const requiredDropMetadataBase = requireNonEmptyString(args.dropMetadataBase, 'NEW_DROP.onchain.metadataBase');
  const discountCsvPath = path.join(args.root, discountWhitelistCsvRelativePath);
  const discountAddresses = readDiscountList(discountCsvPath);
  const discountMerkle = buildDiscountMerkleData(discountAddresses);
  return {
    requiredDropMetadataBase,
    discountMerkle,
  };
}

function writeTextFileIfChanged(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const next = content.endsWith('\n') ? content : `${content}\n`;
  const prev = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (prev === next) return;
  writeFileSync(filePath, next, 'utf8');
}

function readDiscountList(filePath: string): string[] {
  if (!existsSync(filePath)) {
    throw new Error(`Missing discount whitelist CSV: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalized = lines.map((addr) => new PublicKey(addr).toBase58());
  return Array.from(new Set(normalized));
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function hashLeafAddress(address: string): Buffer {
  return sha256(new PublicKey(address).toBuffer());
}

function hashSortedPair(left: Buffer, right: Buffer): Buffer {
  const ordered = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return sha256(Buffer.concat(ordered));
}

function buildMerkleTree(leaves: Buffer[]): Buffer[][] {
  if (!leaves.length) return [];
  const levels: Buffer[][] = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(hashSortedPair(left, right));
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

function buildMerkleProof(levels: Buffer[][], leafIndex: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = leafIndex;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    const siblingIndex = isRight ? idx - 1 : idx + 1;
    const sibling = nodes[siblingIndex] ?? nodes[idx];
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function buildDiscountMerkleData(addresses: string[]) {
  const leaves = addresses
    .map((address) => ({ address, hash: hashLeafAddress(address) }))
    .sort((a, b) => Buffer.compare(a.hash, b.hash));
  const leafHashes = leaves.map((leaf) => leaf.hash);
  const levels = buildMerkleTree(leafHashes);
  const root = levels.length ? levels[levels.length - 1][0] : Buffer.alloc(32);
  const proofs: Record<string, string[]> = {};
  leaves.forEach((leaf, index) => {
    proofs[leaf.address] = buildMerkleProof(levels, index).map((buf) => buf.toString('hex'));
  });
  return { root, proofs };
}

function renderDiscountMerkleJson(args: { root: Buffer; proofs: Record<string, string[]> }): string {
  return `${JSON.stringify(discountMerkleJsonValue(args), null, 2)}\n`;
}

function discountMerkleJsonValue(args: { root: Buffer; proofs: Record<string, string[]> }) {
  return {
    root: args.root.toString('hex'),
    proofs: args.proofs,
  };
}

function assertExistingDiscountMerkleJsonMatches(args: {
  root: Buffer;
  proofs: Record<string, string[]>;
  filePath: string;
}): void {
  const existingSource = readFileSync(args.filePath, 'utf8');
  let existingValue: unknown;
  try {
    existingValue = JSON.parse(existingSource);
  } catch (err) {
    throw new Error(
      `Existing discount Merkle dataset is not valid JSON: ${args.filePath} (${errorMessage(err)})`,
    );
  }
  if (!isDeepStrictEqual(existingValue, discountMerkleJsonValue(args))) {
    throw new Error(
      `Existing discount Merkle dataset conflicts with the generated dataset for root ${args.root.toString('hex')}: ${args.filePath}`,
    );
  }
}

function discountMerkleRegistryReferences(
  root: string,
  registryPath: string,
  drops: Record<string, { dropId: string; dropFamily: string; discountMerkleRoot: string }>,
): DiscountMerkleDatasetReference[] {
  const registryLabel = path.relative(root, registryPath);
  return Object.values(drops).map((drop) => ({
    dropFamily: drop.dropFamily,
    rootHex: drop.discountMerkleRoot,
    source: `${registryLabel}:${drop.dropId}`,
  }));
}

export async function validateDiscountMerkleDatasetForDeploy(args: {
  root: string;
  dropId: string;
  dropFamily: DropFamily;
  merkleRoot: Buffer;
  proofs: Record<string, string[]>;
}): Promise<{
  dropFamily: string;
  rootHex: string;
  fileName: string;
  relativePath: string;
  filePath: string;
}> {
  const desired = requireDiscountMerkleDatasetIdentity({
    dropFamily: args.dropFamily,
    rootHex: args.merkleRoot.toString('hex'),
    source: `${getActiveNewDropConfigPath()}:${args.dropId}`,
  });
  const registryPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry = await readDeploymentDropRegistry(registryPath);
  validateDiscountMerkleFamilyRootInvariant([
    ...discountMerkleRegistryReferences(
      args.root,
      registryPath,
      registry.drops,
    ),
    {
      dropFamily: desired.dropFamily,
      rootHex: desired.rootHex,
      source: `${getActiveNewDropConfigPath()}:${args.dropId}`,
    },
  ]);

  const filePath = path.join(args.root, desired.relativePath);
  if (existsSync(filePath)) {
    assertExistingDiscountMerkleJsonMatches({
      root: args.merkleRoot,
      proofs: args.proofs,
      filePath,
    });
  }
  return { ...desired, filePath };
}

function writeDiscountMerkleJson(args: {
  root: Buffer;
  proofs: Record<string, string[]>;
  filePath: string;
}): void {
  const payload = renderDiscountMerkleJson(args);
  mkdirSync(path.dirname(args.filePath), { recursive: true });
  if (existsSync(args.filePath)) {
    assertExistingDiscountMerkleJsonMatches(args);
    return;
  }
  try {
    writeFileSync(args.filePath, payload, { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
  assertExistingDiscountMerkleJsonMatches(args);
}

export async function finalizeDiscountMerkleAndDeploymentRegistry<T>(args: {
  root: Buffer;
  proofs: Record<string, string[]>;
  filePath: string;
  commitRegistryChanges: () => Promise<T>;
}): Promise<T> {
  // The initialize transaction may already have committed this root. Registry
  // rollback must never remove the only data capable of producing its proofs.
  writeDiscountMerkleJson(args);
  return args.commitRegistryChanges();
}

type TextFileSnapshot =
  | { exists: false }
  | {
      exists: true;
      content: string;
    };
type ExistingTextFileSnapshot = Extract<
  TextFileSnapshot,
  { exists: true }
>;

function snapshotTextFile(filePath: string): TextFileSnapshot {
  return existsSync(filePath)
    ? { exists: true, content: readFileSync(filePath, 'utf8') }
    : { exists: false };
}

function textFileSnapshotsMatch(left: TextFileSnapshot, right: TextFileSnapshot): boolean {
  return left.exists === right.exists && (!left.exists || (right.exists && left.content === right.content));
}

type DeploymentRegistryCommitIo = {
  snapshot: typeof snapshotTextFile;
  write: typeof writeDeploymentRegistryFile;
};

const DEFAULT_DEPLOYMENT_REGISTRY_COMMIT_IO: DeploymentRegistryCommitIo = {
  snapshot: snapshotTextFile,
  write: writeDeploymentRegistryFile,
};

export async function commitDeploymentRegistry(args: {
  registryPath: string;
  expectedSnapshot: ExistingTextFileSnapshot;
  expectedWrittenSnapshot: ExistingTextFileSnapshot;
}, ioOverrides: Partial<DeploymentRegistryCommitIo> = {}): Promise<string> {
  const io = {
    ...DEFAULT_DEPLOYMENT_REGISTRY_COMMIT_IO,
    ...ioOverrides,
  };
  const before = io.snapshot(args.registryPath);
  if (!textFileSnapshotsMatch(before, args.expectedSnapshot)) {
    throw new Error(
      `Canonical deployment registry changed after it was prepared: ${args.registryPath}`,
    );
  }

  io.write({
    filePath: args.registryPath,
    expectedContent: args.expectedSnapshot.content,
    nextContent: args.expectedWrittenSnapshot.content,
  });

  // Verification failures occur after the same inode has been committed.
  // Never restore older bytes here: on-chain deployment work has already
  // landed, and a later reader failure must not erase its registry row.
  try {
    const written = io.snapshot(args.registryPath);
    if (!textFileSnapshotsMatch(written, args.expectedWrittenSnapshot)) {
      throw new Error(
        `Canonical deployment registry write did not produce the prepared content: ${args.registryPath}`,
      );
    }
  } catch (verificationError) {
    throw new DeploymentRegistryPostCommitVerificationError(
      args.registryPath,
      verificationError,
    );
  }
  return args.registryPath;
}

async function assertDropIdNotConfiguredInDeploymentRegistry(args: {
  dropId: string;
  registryPath: string;
}) {
  const normalizedDropId = normalizeAndValidateDropId(
    args.dropId,
    'NEW_DROP.onchain.dropId',
  );
  const registry = await readDeploymentDropRegistry(args.registryPath);
  if (
    Object.prototype.hasOwnProperty.call(
      registry.drops,
      normalizedDropId,
    )
  ) {
    throw new Error(
      `Drop ${normalizedDropId} already exists in deployment registry (${path.relative(process.cwd(), args.registryPath)}).\n` +
        `This script only supports fresh deployments and will not update an existing drop.\n` +
      `Choose a new NEW_DROP.onchain.dropId in ${getActiveNewDropConfigPath()}.`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      registry.tombstones,
      normalizedDropId,
    )
  ) {
    throw new Error(
      `Drop ${normalizedDropId} has a tombstoned BoxMinter config in the deployment registry (${path.relative(process.cwd(), args.registryPath)}).\n` +
        `Choose a new NEW_DROP.onchain.dropId in ${getActiveNewDropConfigPath()}.`,
    );
  }
  // A no-op conditional write opens the existing target with r+ and checks
  // the prepared bytes without changing timestamps or content. Do this before
  // credentials or RPC mutations so a read-only registry cannot strand an
  // otherwise successful fresh deployment.
  writeDeploymentRegistryFile({
    filePath: args.registryPath,
    expectedContent: registry.sourceContent,
    nextContent: registry.sourceContent,
  });
}

function throwFreshDeployOnlyForExistingConfig(args: {
  stage: 'preflight' | 'post-deploy';
  dropId: string;
  programId: string;
  configPda: PublicKey;
  configData: Buffer;
}) {
  const existingConfigDetails = describeExistingBoxMinterConfig(args.configData);
  throw new Error(
    `Fresh deploy only: found an existing box minter config during ${args.stage}.\n` +
      `- requested dropId : ${args.dropId}\n` +
      `- program id       : ${args.programId}\n` +
      `- config PDA       : ${args.configPda.toBase58()}\n` +
      `${existingConfigDetails}\n` +
      `\n` +
      `This script no longer updates existing deployments.\n` +
      `Fix: choose a new NEW_DROP.onchain.dropId in ${getActiveNewDropConfigPath()} and rerun this script.`,
  );
}

async function prepareDeploymentRegistry(args: {
  root: string;
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  displayName?: string;
  salesMode?: DropSalesMode;
  receiptPoolId?: string;
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  mintSelection?: MintSelectionConfigSerialized;
  treasury?: string;
  paymentRouting?: PaymentRoutingConfig;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  receiptsTreeMaxDepth?: number;
  receiptsTreeCanopyDepth?: number;
  deliveryLookupTable: string;
  stripeProductTaxCode?: string;
}): Promise<{
  filePath: string;
  drops: Record<string, DeploymentDropConfigSerialized>;
  sourceSnapshot: ExistingTextFileSnapshot;
  expectedWrittenSnapshot: ExistingTextFileSnapshot;
}> {
  const filePath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const normalizedDropId = normalizeAndValidateDropId(
    args.dropId,
    'deployment registry dropId',
  );
  const existing = await readDeploymentDropRegistry(filePath);
  const sourceSnapshot: ExistingTextFileSnapshot = {
    exists: true,
    content: existing.sourceContent,
  };
  if (
    Object.prototype.hasOwnProperty.call(
      existing.drops,
      normalizedDropId,
    )
  ) {
    throw new Error(
      `Drop ${normalizedDropId} already exists in ${filePath}. Append-only deploy refuses duplicates.`,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      existing.tombstones,
      normalizedDropId,
    )
  ) {
    throw new Error(
      `Drop ${normalizedDropId} has a tombstoned BoxMinter config in ${filePath}. Append-only deploy refuses reuse.`,
    );
  }
  const nextDrops = { ...existing.drops };
  const collectionName =
    String(args.collectionName ?? '').trim() || normalizedDropId;
  const dropFamily = requireDropFamily(args.dropFamily, 'dropFamily');
  const stripeCheckout = resolveStripeCheckoutEnabledForDropFamily(args.stripeCheckoutEnabled, dropFamily);
  const stripeLiveUnitAmountCents =
    args.stripeLiveUnitAmountCents == null
      ? undefined
      : requireStripeLiveUnitAmountCents(args.stripeLiveUnitAmountCents, 'stripeLiveUnitAmountCents');
  assertStripeLivePriceConfigured({
    dropId: normalizedDropId,
    solanaCluster: args.solanaCluster,
    stripeCheckoutEnabled: stripeCheckout.enabled,
    stripeLiveUnitAmountCents,
  });
  const stripeProductTaxCode = resolveStripeProductTaxCodeForDropFamily(
    args.stripeProductTaxCode,
    dropFamily,
    stripeCheckout.enabled,
  );
  nextDrops[normalizedDropId] = {
    solanaCluster: args.solanaCluster,
    dropId: normalizedDropId,
    dropFamily,
    collectionName,
    ...(trimToUndefined(args.displayName)
      ? { displayName: trimToUndefined(args.displayName) }
      : {}),
    ...(args.salesMode && args.salesMode !== 'standard'
      ? { salesMode: args.salesMode }
      : {}),
    ...(trimToUndefined(args.receiptPoolId)
      ? { receiptPoolId: trimToUndefined(args.receiptPoolId) }
      : {}),
    metadataBase: normalizeDropBase(args.metadataBase),
    metadataPathFormat: args.metadataPathFormat,
    ...(args.mintSelection ? { mintSelection: args.mintSelection } : {}),
    ...(args.paymentRouting
      ? { paymentRouting: args.paymentRouting }
      : { treasury: requireNonEmptyString(args.treasury, 'treasury') }),
    priceSol: Number(args.priceSol),
    discountPriceSol: Number(args.discountPriceSol),
    ...(stripeCheckout.enabled ? { stripeCheckoutEnabled: true } : stripeCheckout.disabledOverride ? { stripeCheckoutEnabled: false } : {}),
    ...(stripeLiveUnitAmountCents != null ? { stripeLiveUnitAmountCents } : {}),
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
    discountMintsPerWallet: requireDiscountMintsPerWallet(args.discountMintsPerWallet, 'discountMintsPerWallet'),
    discountMerkleRoot: args.discountMerkleRoot,
    maxSupply: Math.floor(Number(args.maxSupply)),
    itemsPerBox: Math.floor(Number(args.itemsPerBox)),
    maxPerTx: Math.floor(Number(args.maxPerTx)),
    namePrefix: args.namePrefix,
    figureNamePrefix: args.figureNamePrefix,
    symbol: args.symbol,
    boxMinterProgramId: args.boxMinterProgramId,
    ...(trimToUndefined(args.boxMinterConfigPda) ? { boxMinterConfigPda: trimToUndefined(args.boxMinterConfigPda) } : {}),
    collectionMint: args.collectionMint,
    receiptsMerkleTree: args.receiptsMerkleTree,
    ...(args.receiptsTreeMaxDepth != null
      ? {
          receiptsTreeMaxDepth: Math.floor(
            Number(args.receiptsTreeMaxDepth),
          ),
        }
      : {}),
    ...(args.receiptsTreeCanopyDepth != null
      ? {
          receiptsTreeCanopyDepth: Math.floor(
            Number(args.receiptsTreeCanopyDepth),
          ),
        }
      : {}),
    deliveryLookupTable: args.deliveryLookupTable,
  };
  assertReceiptPoolDropRelations({
    drops: nextDrops,
    receiptPools: existing.receiptPools,
  });
  const expectedWrittenContent = renderDeploymentRegistryFileFromSource({
    filePath,
    existingContent: sourceSnapshot.content,
    drops: nextDrops,
    tombstones: existing.tombstones,
  });
  return {
    filePath,
    drops: nextDrops,
    sourceSnapshot,
    expectedWrittenSnapshot: {
      exists: true,
      content: expectedWrittenContent,
    },
  };
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function u16LE(value: number): Buffer {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new Error(`Invalid u16: ${value}`);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n & 0xffff);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function encodeMintSelectionInitializeArgs(mintSelection: MintSelectionConfigSerialized | undefined): Buffer {
  const zeroArray = Array.from(
    { length: BOX_MINTER_MINT_VARIANT_OPTION_COUNT },
    () => u32LE(0),
  );
  if (!mintSelection) {
    return Buffer.concat([
      u8(BOX_MINTER_MINT_VARIANT_KIND_NONE),
      ...zeroArray,
      ...zeroArray,
      ...zeroArray,
    ]);
  }
  if (
    mintSelection.kind !== 'size' ||
    mintSelection.options.length !== BOX_MINTER_MINT_VARIANT_OPTION_COUNT
  ) {
    throw new Error('Invalid mintSelection config for initialize');
  }
  const startIds = mintSelection.options.map((option) => u32LE(option.startId));
  const endIds = mintSelection.options.map((option) => u32LE(option.endId));
  const nextIds = mintSelection.options.map((option) => u32LE(option.startId));
  return Buffer.concat([
    u8(BOX_MINTER_MINT_VARIANT_KIND_SIZE),
    ...startIds,
    ...endIds,
    ...nextIds,
  ]);
}

function borshOption(value: Buffer | null | undefined): Buffer {
  if (!value) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), value]);
}

function encodeUmiArray(items: Buffer[]): Buffer {
  return Buffer.concat([u32LE(items.length), ...items]);
}

// MPL-Core plugin encoding helpers (Umi dataEnum + option layouts).
// We need BubblegumV2 + UpdateDelegate so Bubblegum can mint cNFT receipts into this collection
// while the deployer/admin wallet remains the root collection update authority for marketplace verification.
function mplCoreBasePluginAuthorityAddress(address: PublicKey): Buffer {
  // BasePluginAuthority::Address enum index = 3 (None=0, Owner=1, UpdateAuthority=2, Address=3)
  return Buffer.concat([u8(3), address.toBuffer()]);
}

function mplCorePluginBubblegumV2(): Buffer {
  // Plugin::BubblegumV2 enum index = 15 (see mpl-core PluginType order).
  return u8(15);
}

function mplCorePluginUpdateDelegate(additionalDelegates: PublicKey[]): Buffer {
  // Plugin::UpdateDelegate enum index = 4 (Royalties=0, FreezeDelegate=1, BurnDelegate=2, TransferDelegate=3, UpdateDelegate=4)
  // UpdateDelegate data: { additionalDelegates: Vec<Pubkey> }
  return Buffer.concat([u8(4), encodeUmiArray(additionalDelegates.map((k) => k.toBuffer()))]);
}

function mplCoreBaseRuleSetNone(): Buffer {
  // BaseRuleSet::None enum index = 0 (None=0, ProgramAllowList=1, ProgramDenyList=2).
  return u8(0);
}

function mplCoreCreator(address: PublicKey, percentage: number): Buffer {
  const pct = Number(percentage);
  if (!Number.isInteger(pct) || pct <= 0 || pct > 100) throw new Error(`Invalid creator percentage: ${percentage}`);
  return Buffer.concat([address.toBuffer(), u8(pct)]);
}

function mplCorePluginRoyalties(args: { basisPoints: number; creators: { address: PublicKey; percentage: number }[] }): Buffer {
  const bps = Number(args.basisPoints);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error(`Invalid royalties basisPoints: ${args.basisPoints}`);
  const creators = Array.isArray(args.creators) ? args.creators : [];
  const creatorAddresses = new Set<string>();
  let creatorPercentageTotal = 0;
  for (const creator of creators) {
    if (creator.address.equals(PublicKey.default)) {
      throw new Error('Royalty creator must not be the default address');
    }
    const address = creator.address.toBase58();
    if (creatorAddresses.has(address)) {
      throw new Error(`Duplicate royalty creator: ${address}`);
    }
    creatorAddresses.add(address);
    if (!Number.isInteger(creator.percentage) || creator.percentage <= 0) {
      throw new Error(`Invalid creator percentage: ${creator.percentage}`);
    }
    creatorPercentageTotal += creator.percentage;
  }
  if (creators.length === 0 || creatorPercentageTotal !== 100) {
    throw new Error(`Royalty creator percentages must total 100, got ${creatorPercentageTotal}`);
  }

  // BaseRoyalties = { basisPoints: u16, creators: Vec<Creator>, ruleSet: BaseRuleSet }
  const baseRoyalties = Buffer.concat([
    u16LE(bps),
    encodeUmiArray(creators.map((c) => mplCoreCreator(c.address, c.percentage))),
    mplCoreBaseRuleSetNone(),
  ]);

  // Plugin::Royalties enum index = 0. Payload = BaseRoyalties (no extra wrapper beyond tuple(1)).
  return Buffer.concat([u8(0), baseRoyalties]);
}

function mplCorePluginAuthorityPairRoyalties(args: {
  basisPoints: number;
  creators: { address: PublicKey; percentage: number }[];
  authority?: PublicKey | null;
}): Buffer {
  const authority = args.authority ? mplCoreBasePluginAuthorityAddress(args.authority) : null;
  return Buffer.concat([mplCorePluginRoyalties({ basisPoints: args.basisPoints, creators: args.creators }), borshOption(authority)]);
}

function mplCorePluginAuthorityPairBubblegumV2(): Buffer {
  // PluginAuthorityPair = { plugin: Plugin, authority: Option<BasePluginAuthority> }
  // BubblegumV2 authority is fixed to the Bubblegum program (mpl-core enforces this at creation time).
  // We omit the authority field (None) so mpl-core uses the default manager authority.
  return Buffer.concat([mplCorePluginBubblegumV2(), borshOption(null)]);
}

function mplCorePluginAuthorityPairUpdateDelegate(additionalDelegates: PublicKey[]): Buffer {
  // Let the program config PDA mint/update collection assets while the deployer/admin key remains
  // marketplace-verifiable as the root collection update authority.
  // Bubblegum’s own checks will pass as long as the admin/cosigner collection_authority is in `additionalDelegates`.
  return Buffer.concat([mplCorePluginUpdateDelegate(additionalDelegates), borshOption(null)]);
}

/**
 * MPL-Core instruction: create_collection_v2 (discriminator = 21, mpl-core 1.7.0).
 *
 * Data layout (umi-serializers, which are Borsh-compatible here):
 * - u8 discriminator (21)
 * - string name
 * - string uri
 * - Option<Vec<PluginAuthorityPair>> plugins
 * - Option<Vec<BaseExternalPluginAdapterInitInfo>> externalPluginAdapters
 *
 * NOTE: BubblegumV2 plugin can ONLY be added at creation time (it is permanent and rejects addCollectionPlugin).
 * We include it here so Bubblegum v2 can mint receipt cNFTs into this MPL-Core collection.
 */
const IX_MPL_CORE_CREATE_COLLECTION_V2 = 21;
export function buildCreateMplCoreCollectionV2Ix(args: {
  collection: PublicKey;
  updateAuthority: PublicKey;
  updateDelegates: PublicKey[];
  payer: PublicKey;
  systemProgram: PublicKey;
  name: string;
  uri: string;
  royaltiesBps: number;
  royaltiesCreators?: MplCoreRoyaltyCreator[];
  royaltiesRecipient?: PublicKey;
  royaltiesAuthority?: PublicKey | null;
}): TransactionInstruction {
  const royaltiesAuthority =
    args.royaltiesAuthority === undefined
      ? args.payer
      : args.royaltiesAuthority;
  const royaltiesCreators =
    args.royaltiesCreators ||
    (args.royaltiesRecipient
      ? [{ address: args.royaltiesRecipient, percentage: 100 }]
      : []);
  if (royaltiesCreators.length === 0) {
    throw new Error('At least one royalties creator is required');
  }
  const pluginsOpt = borshOption(
    encodeUmiArray([
      mplCorePluginAuthorityPairRoyalties({
        basisPoints: args.royaltiesBps,
        creators: royaltiesCreators,
        authority: royaltiesAuthority,
      }),
      mplCorePluginAuthorityPairBubblegumV2(),
      mplCorePluginAuthorityPairUpdateDelegate(uniquePubkeys(args.updateDelegates)),
    ]),
  );
  const externalAdaptersOpt = borshOption(encodeUmiArray([]));

  const data = Buffer.concat([
    u8(IX_MPL_CORE_CREATE_COLLECTION_V2),
    borshString(args.name),
    borshString(args.uri),
    pluginsOpt,
    externalAdaptersOpt,
  ]);

  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: true, isWritable: true },
      { pubkey: args.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.systemProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// MPL-Core instructions used to keep collection-level royalties in sync.
const IX_MPL_CORE_ADD_COLLECTION_PLUGIN_V1 = 3;
const IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1 = 7;

function buildUpdateMplCoreCollectionRoyaltiesV1Ix(args: {
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  royaltiesBps: number;
  royaltiesCreators: MplCoreRoyaltyCreator[];
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: args.royaltiesBps,
    creators: args.royaltiesCreators,
  });
  const data = Buffer.concat([u8(IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1), plugin]);
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildAddMplCoreCollectionRoyaltiesV1Ix(args: {
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  royaltiesBps: number;
  royaltiesCreators: MplCoreRoyaltyCreator[];
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: args.royaltiesBps,
    creators: args.royaltiesCreators,
  });
  // initAuthority: Some(BasePluginAuthority::Address(authority))
  const initAuthority = borshOption(mplCoreBasePluginAuthorityAddress(args.authority));
  const data = Buffer.concat([u8(IX_MPL_CORE_ADD_COLLECTION_PLUGIN_V1), plugin, initAuthority]);
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function upsertMplCoreCollectionRoyalties(args: {
  connection: Connection;
  payer: Keypair;
  collection: PublicKey;
  royaltiesBps: number;
  royaltiesCreators: MplCoreRoyaltyCreator[];
}) {
  const { connection, payer, collection, royaltiesBps, royaltiesCreators } = args;

  // Try update first (common path once the plugin exists).
  try {
    const updateIx = buildUpdateMplCoreCollectionRoyaltiesV1Ix({
      collection,
      payer: payer.publicKey,
      authority: payer.publicKey,
      royaltiesBps,
      royaltiesCreators,
    });
    const tx = new Transaction().add(updateIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(update core collection royalties)', () => connection.getLatestBlockhash('confirmed'))).blockhash;
    const sig = await sendAndConfirmTx({
      connection,
      tx,
      signers: [payer],
      label: 'update core collection royalties',
      commitment: 'confirmed',
    });
    console.log('✅ Collection royalties updated:', sig);
    return;
  } catch (err) {
    console.warn('⚠️  updateCollectionPluginV1 failed (will try addCollectionPluginV1):', err instanceof Error ? err.message : String(err));
  }

  // If update failed (e.g. plugin missing), try to add.
  const addIx = buildAddMplCoreCollectionRoyaltiesV1Ix({
    collection,
    payer: payer.publicKey,
    authority: payer.publicKey,
    royaltiesBps,
    royaltiesCreators,
  });
  const tx = new Transaction().add(addIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(add core collection royalties)', () => connection.getLatestBlockhash('confirmed'))).blockhash;
  const sig = await sendAndConfirmTx({ connection, tx, signers: [payer], label: 'add core collection royalties', commitment: 'confirmed' });
  console.log('✅ Collection royalties added:', sig);
}

function canRead(buf: Buffer, offset: number, length: number): boolean {
  return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 && offset + length <= buf.length;
}

function skipBorshString(buf: Buffer, offset: number): number | null {
  if (!canRead(buf, offset, 4)) return null;
  const len = buf.readUInt32LE(offset);
  const end = offset + 4 + len;
  if (!canRead(buf, offset + 4, len)) return null;
  return end;
}

type MplCoreCollectionPluginRecord = {
  pluginType: number;
  authorityKind: number;
  authorityAddress?: PublicKey;
  offset: number;
};

function readMplCoreCollectionPluginRecords(data: Buffer): MplCoreCollectionPluginRecord[] | null {
  let o = 0;
  if (!canRead(data, o, 1)) return null;
  const key = data[o];
  o += 1;
  if (key !== 5) return null; // Not a CollectionV1 account.

  // updateAuthority pubkey
  if (!canRead(data, o, 32)) return null;
  o += 32;
  // name + uri
  const afterName = skipBorshString(data, o);
  if (afterName == null) return null;
  o = afterName;
  const afterUri = skipBorshString(data, o);
  if (afterUri == null) return null;
  o = afterUri;
  // numMinted + currentSize
  if (!canRead(data, o, 8)) return null;
  o += 8;

  // No plugins section.
  if (o >= data.length) return null;

  // PluginHeaderV1 (key=3, pluginRegistryOffset=u64)
  if (!canRead(data, o, 9)) return null;
  const pluginHeaderKey = data[o];
  o += 1;
  if (pluginHeaderKey !== 3) return null;
  const pluginRegistryOffset = Number(data.readBigUInt64LE(o));
  if (!Number.isFinite(pluginRegistryOffset) || pluginRegistryOffset < 0 || pluginRegistryOffset >= data.length) return null;

  // PluginRegistryV1 (key=4)
  let r = pluginRegistryOffset;
  if (!canRead(data, r, 5)) return null;
  const regKey = data[r];
  r += 1;
  if (regKey !== 4) return null;
  const registryLen = data.readUInt32LE(r);
  r += 4;

  const records: MplCoreCollectionPluginRecord[] = [];
  for (let i = 0; i < registryLen; i++) {
    if (!canRead(data, r, 2)) return null;
    const pluginType = data[r];
    r += 1;

    const authorityKind = data[r];
    r += 1;
    let authorityAddress: PublicKey | undefined;
    if (authorityKind === 3) {
      if (!canRead(data, r, 32)) return null;
      authorityAddress = new PublicKey(data.subarray(r, r + 32));
      r += 32;
    } else if (authorityKind < 0 || authorityKind > 3) {
      return null;
    }

    if (!canRead(data, r, 8)) return null;
    const offset = Number(data.readBigUInt64LE(r));
    r += 8;
    if (!Number.isFinite(offset) || offset < 0 || offset >= data.length) return null;

    records.push({ pluginType, authorityKind, authorityAddress, offset });
  }

  return records;
}

export function decodeMplCoreCollectionRoyalties(data: Buffer): {
  basisPoints: number;
  creators: { address: PublicKey; percentage: number }[];
  ruleSetKind: number;
  authorityKind: number;
  authorityAddress?: PublicKey;
} | null {
  const records = readMplCoreCollectionPluginRecords(data);
  const royaltiesRecord = records?.find((record) => record.pluginType === 0);
  if (!royaltiesRecord) return null;

  let p = royaltiesRecord.offset;
  if (!canRead(data, p, 1)) return null;
  const pluginVariant = data[p];
  p += 1;
  // Plugin variant must match Royalties (0).
  if (pluginVariant !== 0) return null;

  if (!canRead(data, p, 6)) return null;
  const basisPoints = data.readUInt16LE(p);
  p += 2;
  const creatorsLen = data.readUInt32LE(p);
  p += 4;
  const creators: { address: PublicKey; percentage: number }[] = [];
  for (let i = 0; i < creatorsLen; i++) {
    if (!canRead(data, p, 33)) return null;
    const address = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const percentage = data[p];
    p += 1;
    creators.push({ address, percentage });
  }
  if (!canRead(data, p, 1)) return null;
  const ruleSetKind = data[p];

  return {
    basisPoints,
    creators,
    ruleSetKind,
    authorityKind: royaltiesRecord.authorityKind,
    authorityAddress: royaltiesRecord.authorityAddress,
  };
}

export function decodeMplCoreCollectionUpdateDelegates(data: Buffer): {
  delegates: PublicKey[];
  authorityKind: number;
  authorityAddress?: PublicKey;
} | null {
  const records = readMplCoreCollectionPluginRecords(data);
  const updateDelegateRecord = records?.find((record) => record.pluginType === 4);
  if (!updateDelegateRecord) return null;

  let p = updateDelegateRecord.offset;
  if (!canRead(data, p, 5)) return null;
  const pluginVariant = data[p];
  p += 1;
  // Plugin variant must match UpdateDelegate (4).
  if (pluginVariant !== 4) return null;

  const delegateLen = data.readUInt32LE(p);
  p += 4;
  const delegates: PublicKey[] = [];
  for (let i = 0; i < delegateLen; i++) {
    if (!canRead(data, p, 32)) return null;
    delegates.push(new PublicKey(data.subarray(p, p + 32)));
    p += 32;
  }

  return {
    delegates,
    authorityKind: updateDelegateRecord.authorityKind,
    authorityAddress: updateDelegateRecord.authorityAddress,
  };
}

export function assertMplCoreCollectionHasUpdateDelegates(args: {
  data: Buffer;
  collection: PublicKey | string;
  requiredDelegates: PublicKey[];
}) {
  const collection = typeof args.collection === 'string' ? args.collection : args.collection.toBase58();
  const updateDelegate = decodeMplCoreCollectionUpdateDelegates(args.data);
  if (!updateDelegate) {
    throw new Error(`Missing/undecodable UpdateDelegate plugin on core collection: ${collection}`);
  }
  if (updateDelegate.authorityKind !== MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY) {
    const actualAuthority =
      updateDelegate.authorityKind === 3 && updateDelegate.authorityAddress
        ? `Address(${updateDelegate.authorityAddress.toBase58()})`
        : `kind=${updateDelegate.authorityKind}`;
    throw new Error(
      `Core collection UpdateDelegate plugin authority mismatch.\n` +
        `Collection: ${collection}\n` +
        `Expected authority: UpdateAuthority\n` +
        `Actual authority  : ${actualAuthority}\n` +
        `Fix: recreate the collection through ${getActiveNewDropConfigPath()}, or update the collection UpdateDelegate plugin authority to UpdateAuthority before pinning it.`,
    );
  }

  const missing = uniquePubkeys(args.requiredDelegates).filter(
    (required) => !updateDelegate.delegates.some((actual) => actual.equals(required)),
  );
  if (!missing.length) return updateDelegate;

  throw new Error(
    `Core collection UpdateDelegate missing required delegate(s).\n` +
      `Collection: ${collection}\n` +
      `Expected delegates: ${uniquePubkeys(args.requiredDelegates).map((delegate) => delegate.toBase58()).join(', ')}\n` +
      `Actual delegates  : ${updateDelegate.delegates.map((delegate) => delegate.toBase58()).join(', ') || '(none)'}\n` +
      `Missing delegates : ${missing.map((delegate) => delegate.toBase58()).join(', ')}`,
  );
}

export function assertReceiptPoolCollectionUpdateDelegatePolicy(args: {
  data: Buffer;
  authority: PublicKey;
}): void {
  const updateDelegate = decodeMplCoreCollectionUpdateDelegates(args.data);
  if (
    !updateDelegate ||
    updateDelegate.authorityKind !==
      MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY ||
    updateDelegate.delegates.length !== 1 ||
    !updateDelegate.delegates[0].equals(args.authority)
  ) {
    throw new Error(
      'Receipt pool collection must delegate only to its fixed authority',
    );
  }
}

async function assertMplCoreCollectionRoyalties(args: {
  connection: Connection;
  coreCollection: PublicKey;
  creators: MplCoreRoyaltyCreator[];
  royaltiesBps: number;
}) {
  const { connection, coreCollection, creators, royaltiesBps } = args;
  const info = await retryRpcRead(`getAccountInfo(core collection royalties ${coreCollection.toBase58()})`, () =>
    connection.getAccountInfo(coreCollection, { commitment: 'confirmed' }),
  );
  if (!info?.data) throw new Error(`Missing core collection account: ${coreCollection.toBase58()}`);

  const royalties = decodeMplCoreCollectionRoyalties(info.data);
  if (!royalties) {
    throw new Error(`Missing/undecodable Royalties plugin on core collection: ${coreCollection.toBase58()}`);
  }

  const ok =
    royalties.basisPoints === royaltiesBps &&
    royalties.ruleSetKind === 0 &&
    royalties.creators.length === creators.length &&
    royalties.creators.every(
      (creator, index) =>
        creator.address.equals(creators[index].address) &&
        creator.percentage === creators[index].percentage,
    );

  const expectedCreators = creators
    .map((creator) => `${creator.address.toBase58()} (${creator.percentage}%)`)
    .join(', ');

  if (!ok) {
    throw new Error(
      `Core collection royalties mismatch.\n` +
        `Collection: ${coreCollection.toBase58()}\n` +
        `Expected: ${royaltiesBps} bps -> ${expectedCreators}\n` +
        `Actual  : ${royalties.basisPoints} bps -> ${royalties.creators.map((c) => `${c.address.toBase58()} (${c.percentage}%)`).join(', ') || '(none)'}\n`,
    );
  }

  console.log('\n✅ Core collection royalties verified');
  console.log(`  basisPoints: ${royalties.basisPoints}`);
  console.log(`  creators  : ${expectedCreators}`);
  console.log(`  ruleSet   : ${royalties.ruleSetKind === 0 ? 'None' : `kind=${royalties.ruleSetKind}`}`);
}

async function assertMplCoreCollectionUpdateDelegates(args: {
  connection: Connection;
  coreCollection: PublicKey;
  requiredDelegates: PublicKey[];
}) {
  const { connection, coreCollection, requiredDelegates } = args;
  const info = await retryRpcRead(`getAccountInfo(core collection update delegates ${coreCollection.toBase58()})`, () =>
    connection.getAccountInfo(coreCollection, { commitment: 'confirmed' }),
  );
  if (!info?.data) throw new Error(`Missing core collection account: ${coreCollection.toBase58()}`);

  const updateDelegate = assertMplCoreCollectionHasUpdateDelegates({
    data: Buffer.from(info.data),
    collection: coreCollection,
    requiredDelegates,
  });

  console.log('\n✅ Core collection UpdateDelegate verified');
  console.log(`  delegates: ${updateDelegate.delegates.map((delegate) => delegate.toBase58()).join(', ')}`);
}

async function ensureMplCoreCollectionRoyalties(args: {
  connection: Connection;
  payer: Keypair;
  collection: PublicKey;
  creators: MplCoreRoyaltyCreator[];
  royaltiesBps: number;
}) {
  const { connection, payer, collection, creators, royaltiesBps } = args;
  try {
    await assertMplCoreCollectionRoyalties({
      connection,
      coreCollection: collection,
      creators,
      royaltiesBps,
    });
    return;
  } catch (err) {
    console.warn(
      '⚠️  Core collection royalties are not in the desired state (will attempt to upsert):',
      err instanceof Error ? err.message : String(err),
    );
  }

  await upsertMplCoreCollectionRoyalties({
    connection,
    payer,
    collection,
    royaltiesBps,
    royaltiesCreators: creators,
  });
  await assertMplCoreCollectionRoyalties({
    connection,
    coreCollection: collection,
    creators,
    royaltiesBps,
  });
}

export function decodeBoxMinterConfigForDeployPreflight(data: Buffer) {
  if (data.length < BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS) {
    throw new Error(
      `Existing on-chain config uses an older schema and cannot be reused.\n` +
        `- expected config account size >= ${BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS} bytes\n` +
        `- actual config account size      : ${data.length} bytes\n` +
        `\n` +
        `This configurable items-per-box change requires a fresh deployment/init.\n` +
        `Fix: deploy to a fresh program id and rerun this script.`,
    );
  }
  // Preserve the historical deploy preflight policy: the discriminator is not
  // consulted here because ownership is validated by the caller.
  const decoded = decodeBoxMinterConfigData(data, {
    validateDiscriminator: false,
    validateItemsPerBox: false,
    decodeExtensions: false,
  });
  return {
    ...decoded,
    admin: new PublicKey(decoded.admin),
    treasury: new PublicKey(decoded.treasury),
    coreCollection: new PublicKey(decoded.coreCollection),
    discountMerkleRoot: Buffer.from(decoded.discountMerkleRoot),
  };
}

export function assertExistingConfigMatchesResume(args: {
  data: Buffer;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMintsPerWallet: number;
  discountMerkleRoot: Buffer;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  metadataBase: string;
  mintSelection?: MintSelectionConfigSerialized;
  mintProceeds?: MplCoreRoyaltyCreator[];
  dropSeed: Buffer;
}): void {
  const decodedRaw = decodeBoxMinterConfigData(args.data, {
    validateDiscriminator: true,
    validateItemsPerBox: true,
    decodeExtensions: true,
  });
  const decoded = {
    ...decodedRaw,
    admin: new PublicKey(decodedRaw.admin),
    treasury: new PublicKey(decodedRaw.treasury),
    coreCollection: new PublicKey(decodedRaw.coreCollection),
    discountMerkleRoot: Buffer.from(decodedRaw.discountMerkleRoot),
  };
  const expectedVariantKind = args.mintSelection
    ? BOX_MINTER_MINT_VARIANT_KIND_SIZE
    : BOX_MINTER_MINT_VARIANT_KIND_NONE;
  const expectedStarts = args.mintSelection
    ? args.mintSelection.options.map((option) => option.startId)
    : [0, 0, 0];
  const expectedEnds = args.mintSelection
    ? args.mintSelection.options.map((option) => option.endId)
    : [0, 0, 0];
  const expectedNext = expectedStarts;
  const routingMatches = args.mintProceeds
    ? decodedRaw.paymentRouting?.schema === 'split-payments-v1' &&
      decodedRaw.paymentRouting.mintProceeds.length === args.mintProceeds.length &&
      decodedRaw.paymentRouting.mintProceeds.every(
        (recipient, index) =>
          new PublicKey(recipient.address).equals(
            args.mintProceeds![index].address,
          ) &&
          recipient.percentage === args.mintProceeds![index].percentage,
      ) &&
      new PublicKey(
        decodedRaw.paymentRouting.deliveryPaymentReceiver,
      ).equals(args.treasury)
    : decodedRaw.paymentRouting?.schema === 'legacy';
  const mismatches = [
    decoded.admin.equals(args.admin) ? '' : 'admin',
    decoded.treasury.equals(args.treasury) ? '' : 'treasury',
    decoded.coreCollection.equals(args.coreCollection)
      ? ''
      : 'coreCollection',
    decoded.priceLamports === args.priceLamports ? '' : 'priceLamports',
    decoded.discountPriceLamports === args.discountPriceLamports
      ? ''
      : 'discountPriceLamports',
    decoded.discountMintsPerWallet === args.discountMintsPerWallet
      ? ''
      : 'discountMintsPerWallet',
    decoded.discountMerkleRoot.equals(args.discountMerkleRoot)
      ? ''
      : 'discountMerkleRoot',
    decoded.maxSupply === args.maxSupply ? '' : 'maxSupply',
    decoded.itemsPerBox === args.itemsPerBox ? '' : 'itemsPerBox',
    decoded.maxPerTx === args.maxPerTx ? '' : 'maxPerTx',
    decoded.namePrefix === args.namePrefix ? '' : 'namePrefix',
    decoded.figureNamePrefix === args.figureNamePrefix
      ? ''
      : 'figureNamePrefix',
    decoded.symbol === args.symbol ? '' : 'symbol',
    normalizeDropBase(decoded.uriBase) ===
    normalizeDropBase(args.metadataBase)
      ? ''
      : 'metadataBase',
    decoded.mintVariantKind === expectedVariantKind
      ? ''
      : 'mintVariantKind',
    isDeepStrictEqual(decoded.mintVariantStartIds, expectedStarts)
      ? ''
      : 'mintVariantStartIds',
    isDeepStrictEqual(decoded.mintVariantEndIds, expectedEnds)
      ? ''
      : 'mintVariantEndIds',
    isDeepStrictEqual(decoded.mintVariantNextIds, expectedNext)
      ? ''
      : 'mintVariantNextIds',
    decoded.dropSeed &&
    Buffer.from(decoded.dropSeed).equals(args.dropSeed)
      ? ''
      : 'dropSeed',
    routingMatches ? '' : 'paymentRouting',
    !decoded.started ? '' : 'started',
    decoded.minted === 0 ? '' : 'minted',
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(
      `Existing unregistered config cannot be resumed because ${mismatches.join(', ')} differ`,
    );
  }
}

function boxMinterConfigPda(programId: PublicKey, dropSeed?: Buffer): PublicKey {
  return (dropSeed?.length === 32
    ? PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed], programId)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId))[0];
}

async function assertLegacySingletonConfigAbsentForSharedProgramReuse(args: {
  connection: Connection;
  programId: PublicKey;
  programIdString: string;
}): Promise<void> {
  const legacyConfigPda = boxMinterConfigPda(args.programId);
  const legacyConfigInfo = await retryRpcRead(`getAccountInfo(legacy singleton config ${legacyConfigPda.toBase58()})`, () =>
    args.connection.getAccountInfo(legacyConfigPda, { commitment: 'confirmed' }),
  );
  if (!legacyConfigInfo?.data?.length) return;

  throw new Error(
    `Cannot reuse program id ${args.programIdString} for the shared-program lineage.\n` +
      `A legacy singleton config already exists at ${legacyConfigPda.toBase58()}.\n` +
      `${describeExistingBoxMinterConfig(Buffer.from(legacyConfigInfo.data))}\n` +
      `\n` +
      `Existing singleton drops must keep their original program ids unchanged.\n` +
      `Fix: set NEW_DROP.deploy.reuseProgramId=false once in ${getActiveNewDropConfigPath()} to generate and deploy a fresh shared program id for this drop, then switch reuseProgramId back to true for later shared drops.`,
  );
}

async function assertProgramReuseMatchesMetadataPathFormat(args: {
  root: string;
  solanaCluster: string;
  dropId: string;
  programId: string;
  desiredMetadataPathFormat: MetadataPathFormat;
}): Promise<void> {
  const registryPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry = await readDeploymentDropRegistry(registryPath);
  const matches = Object.values(registry.drops).map((drop) => ({
    source: 'canonical',
    filePath: registryPath,
    drop,
  })).filter(
    ({ drop }) =>
      drop.dropId !== args.dropId &&
      drop.solanaCluster === args.solanaCluster &&
      drop.boxMinterProgramId === args.programId,
  );

  if (!matches.length) return;

  const formatsByDropId = new Map<string, Set<MetadataPathFormat>>();
  matches.forEach(({ drop }) => {
    const next = formatsByDropId.get(drop.dropId) || new Set<MetadataPathFormat>();
    next.add(drop.metadataPathFormat);
    formatsByDropId.set(drop.dropId, next);
  });

  const inconsistentDrops = Array.from(formatsByDropId.entries()).filter(([, formats]) => formats.size > 1);
  if (inconsistentDrops.length) {
    throw new Error(
      `Deployment registry metadata path formats are inconsistent for program ${args.programId} on ${args.solanaCluster}.\n` +
        inconsistentDrops.map(([dropId, formats]) => `- ${dropId}: ${Array.from(formats).sort().join(', ')}`).join('\n') +
        `\n` +
        `Fix shared/deploymentRegistry.ts before reusing this program id.`,
    );
  }

  const mismatches = matches.filter(({ drop }) => drop.metadataPathFormat !== args.desiredMetadataPathFormat);
  if (!mismatches.length) return;

  throw new Error(
    `Cannot reuse program id ${args.programId} for ${args.dropId} on ${args.solanaCluster}.\n` +
      `This deploy would write the ${args.desiredMetadataPathFormat} metadata layout, but the registry already maps that program id to a different layout:\n` +
      mismatches
        .map(
          ({ drop, source, filePath }) =>
            `- ${drop.dropId}: ${drop.metadataPathFormat} (${source}: ${path.relative(args.root, filePath)})`,
        )
        .join('\n') +
      `\n` +
      `Fix: set NEW_DROP.deploy.reuseProgramId=false in ${getActiveNewDropConfigPath()} to start a fresh compact-format lineage.`,
  );
}

// Anchor instruction discriminator: sha256("global:initialize")[0..8]
const IX_INITIALIZE = Buffer.from('afaf6d1f0d989bed', 'hex');
export const IX_INITIALIZE_SPLIT_PAYMENTS_V1 = createHash('sha256')
  .update('global:initialize_split_payments_v1')
  .digest()
  .subarray(0, 8);
export const IX_SPLIT_PAYMENTS_V1_CAPABILITY = createHash('sha256')
  .update('global:split_payments_v1_capability')
  .digest()
  .subarray(0, 8);

export function buildSplitPaymentsV1CapabilityIx(
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [],
    data: IX_SPLIT_PAYMENTS_V1_CAPABILITY,
  });
}

async function assertSplitPaymentsV1Capability(args: {
  connection: Connection;
  programId: PublicKey;
  feePayer: PublicKey;
}): Promise<void> {
  const tx = new Transaction().add(
    buildSplitPaymentsV1CapabilityIx(args.programId),
  );
  tx.feePayer = args.feePayer;
  tx.recentBlockhash = (
    await retryRpcRead('getLatestBlockhash(split payments v1 capability)', () =>
      args.connection.getLatestBlockhash('confirmed'),
    )
  ).blockhash;
  const simulated = await args.connection.simulateTransaction(tx);
  if (simulated.value.err) {
    throw new Error(
      `Program ${args.programId.toBase58()} does not support split-payments-v1.\n` +
        `Upgrade the shared program with upgrade-onchain before deploying this drop.\n` +
        `Simulation error: ${JSON.stringify(simulated.value.err)}\n` +
        `Logs:\n${(simulated.value.logs || []).join('\n')}`,
    );
  }
  console.log('✅ split-payments-v1 program capability verified');
}

export function buildInitializeIx(args: {
  programId: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMintsPerWallet: number;
  discountMerkleRoot: Buffer;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  mintSelection?: MintSelectionConfigSerialized;
  dropSeed: Buffer;
  /**
   * Canonical drop base, e.g. `https://assets.example.com/drops/your-drop` or `ipfs://bafy...`.
   *
   * The on-chain program derives per-asset JSON URIs from this base.
   */
  metadataBase: string;
}): TransactionInstruction {
  const configPda = boxMinterConfigPda(args.programId, args.dropSeed);
  const data = Buffer.concat([
    IX_INITIALIZE,
    u64LE(args.priceLamports),
    u64LE(args.discountPriceLamports),
    Buffer.from(args.discountMerkleRoot),
    u32LE(args.maxSupply),
    Buffer.from([args.maxPerTx & 0xff]),
    Buffer.from([args.itemsPerBox & 0xff]),
    borshString(args.namePrefix),
    borshString(args.symbol),
    borshString(args.metadataBase),
    Buffer.from([requireDiscountMintsPerWallet(args.discountMintsPerWallet, 'initialize discountMintsPerWallet') & 0xff]),
    borshString(args.figureNamePrefix),
    encodeMintSelectionInitializeArgs(args.mintSelection),
    Buffer.from(args.dropSeed),
  ]);

  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: true },
      { pubkey: args.treasury, isSigner: false, isWritable: false },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeSplitPaymentsV1Ix(
  args: Parameters<typeof buildInitializeIx>[0] & {
    mintProceeds: MplCoreRoyaltyCreator[];
  },
): TransactionInstruction {
  if (args.treasury.equals(PublicKey.default)) {
    throw new Error(
      'split-payments-v1 delivery receiver must not be the default address',
    );
  }
  if (args.mintProceeds.length < 2 || args.mintProceeds.length > 3) {
    throw new Error('split-payments-v1 requires 2 or 3 mint recipients');
  }
  const seen = new Set<string>();
  let totalPercentage = 0;
  for (const [index, recipient] of args.mintProceeds.entries()) {
    if (recipient.address.equals(PublicKey.default)) {
      throw new Error(`split-payments-v1 recipient ${index} must not be the default address`);
    }
    const address = recipient.address.toBase58();
    if (seen.has(address)) {
      throw new Error(`split-payments-v1 recipient ${index} duplicates ${address}`);
    }
    seen.add(address);
    if (
      !Number.isInteger(recipient.percentage) ||
      recipient.percentage <= 0 ||
      recipient.percentage > 100
    ) {
      throw new Error(`split-payments-v1 recipient ${index} has an invalid percentage`);
    }
    totalPercentage += recipient.percentage;
  }
  if (totalPercentage !== 100) {
    throw new Error(`split-payments-v1 percentages must total 100, got ${totalPercentage}`);
  }

  const legacy = buildInitializeIx(args);
  const recipients = [
    ...args.mintProceeds.map((recipient) => recipient.address),
    ...Array.from(
      { length: 3 - args.mintProceeds.length },
      () => PublicKey.default,
    ),
  ];
  const percentages = [
    ...args.mintProceeds.map((recipient) => recipient.percentage),
    ...Array.from({ length: 3 - args.mintProceeds.length }, () => 0),
  ];
  return new TransactionInstruction({
    programId: legacy.programId,
    keys: legacy.keys,
    data: Buffer.concat([
      IX_INITIALIZE_SPLIT_PAYMENTS_V1,
      legacy.data.subarray(IX_INITIALIZE.length),
      u8(args.mintProceeds.length),
      ...recipients.map((recipient) => recipient.toBuffer()),
      Buffer.from(percentages),
    ]),
  });
}

function canRunSolanaCargo(): boolean {
  // Anchor uses the rustup toolchain directive `cargo +solana ...`.
  // If we have that toolchain, we can generate a v3 Cargo.lock that's compatible
  // with Solana's older Rust toolchain (1.72.x).
  const res = spawnSync('cargo', ['+solana', '--version'], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
  return res.status === 0;
}

function readSolanaActiveReleaseBinDir(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const configPath = path.join(home, '.config', 'solana', 'install', 'config.yml');
  if (existsSync(configPath)) {
    const cfg = readFileSync(configPath, 'utf8');
    const match = cfg.match(/^\s*active_release_dir:\s*(.+)\s*$/m);
    if (match?.[1]) {
      return path.join(match[1].trim(), 'bin');
    }
  }
  // Default install location for both legacy solana-install and agave-install.
  return path.join(home, '.local', 'share', 'solana', 'install', 'active_release', 'bin');
}

function ensureAnchorCompatibleCargoLock(onchainDir: string) {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;

  const head = readFileSync(lockPath, 'utf8').slice(0, 4096);
  const match = head.match(/^\s*version\s*=\s*(\d+)\s*$/m);
  const version = match?.[1] ? Number(match[1]) : undefined;
  if (!version || Number.isNaN(version)) return false;

  // Solana/Anchor toolchains often bundle an older Cargo that can't parse lockfile v4
  // ("lock file version 4 requires -Znext-lockfile-bump"). If we detect that, move it
  // aside so `anchor build` can regenerate a compatible lockfile.
  if (version >= 4) {
    const backupPath = path.join(onchainDir, `Cargo.lock.v${version}.bak`);
    console.warn(
      `⚠️  Detected on-chain Cargo.lock version ${version} (incompatible with the Solana/Anchor toolchain cargo).\n` +
        `   Renaming it to ${backupPath} so Anchor can regenerate a compatible lockfile...`,
    );
    try {
      renameSync(lockPath, backupPath);
    } catch {
      const fallback = path.join(onchainDir, `Cargo.lock.bak.${Date.now()}`);
      renameSync(lockPath, fallback);
    }
    return true;
  }
  return false;
}

function removeStaleAnchorGeneratedArtifacts(onchainDir: string) {
  // Anchor 0.32.x fails to parse legacy target/idl + target/types artifacts emitted by
  // older Anchor versions during `anchor keys sync`. They are regenerated by the later build.
  for (const relPath of ['target/idl', 'target/types']) {
    const artifactPath = path.join(onchainDir, relPath);
    if (!existsSync(artifactPath)) continue;
    rmSync(artifactPath, { recursive: true, force: true });
    console.log(`Removed stale Anchor generated artifacts: ${artifactPath}`);
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function deployedProgramMatchesBinary(args: {
  programId: string;
  programBinary: string;
  solanaUrl: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}): boolean {
  const env = args.env ? { ...process.env, ...args.env } : process.env;
  const dumpPath = path.join(tmpdir(), `mons-shop-program-dump-${process.pid}-${Date.now()}.so`);
  try {
    const res = spawnSync('solana', ['program', 'dump', args.programId, dumpPath, '--url', args.solanaUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: args.cwd,
      env,
      encoding: 'utf8',
    });
    if (res.status !== 0 || !existsSync(dumpPath)) {
      const stderr = String(res.stderr || '').trim();
      const message = `Could not dump deployed program ${args.programId} for hash comparison.${stderr ? ` ${stderr}` : ''}`;
      console.warn(`⚠️  ${message}`);
      return false;
    }

    const localHash = sha256File(args.programBinary);
    const deployedHash = sha256File(dumpPath);
    return localHash === deployedHash;
  } finally {
    try {
      if (existsSync(dumpPath)) unlinkSync(dumpPath);
    } catch {
      // ignore
    }
  }
}

const DECLARE_ID_RE = /declare_id!\(\"([1-9A-HJ-NP-Za-km-z]{32,44})\"\)/;

function readProgramId(onchainDir: string): string {
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const content = readFileSync(libPath, 'utf8');
  const match = content.match(DECLARE_ID_RE);
  if (!match?.[1]) {
    throw new Error(`Could not find declare_id!(\"...\") in ${libPath}`);
  }
  return match[1];
}

function writeProgramIdToSource(onchainDir: string, programId: string) {
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const content = readFileSync(libPath, 'utf8');
  const existing = content.match(DECLARE_ID_RE);
  if (!existing?.[1]) {
    throw new Error(`Could not find declare_id!(...) in ${libPath}`);
  }
  if (existing[1] === programId) return;
  const next = content.replace(DECLARE_ID_RE, `declare_id!("${programId}")`);
  if (!next.includes(`declare_id!("${programId}")`)) {
    throw new Error(`Could not update declare_id!(...) in ${libPath}`);
  }
  writeTextFileIfChanged(libPath, next);
  console.log('Synced program id in source:', programId);
}

function anchorProgramSectionForCluster(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta' ? 'mainnet' : cluster;
}

function writeProgramIdToAnchorToml(onchainDir: string, cluster: SolanaCluster, programId: string) {
  const anchorTomlPath = path.join(onchainDir, 'Anchor.toml');
  const content = readFileSync(anchorTomlPath, 'utf8');
  const sectionName = anchorProgramSectionForCluster(cluster);
  const sectionRe = new RegExp(`(\\[programs\\.${sectionName}\\]\\s*\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  const match = content.match(sectionRe);
  if (!match) {
    throw new Error(`Missing [programs.${sectionName}] section in ${anchorTomlPath}`);
  }
  const existing = match[2].match(/box_minter\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
  if (!existing?.[1]) {
    throw new Error(`Could not find box_minter in [programs.${sectionName}] in ${anchorTomlPath}`);
  }
  if (existing[1] === programId) return;
  const nextSectionBody = match[2].replace(/box_minter\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/, `box_minter = "${programId}"`);
  const next = content.replace(sectionRe, `${match[1]}${nextSectionBody}`);
  writeTextFileIfChanged(anchorTomlPath, next);
  console.log(`Synced [programs.${sectionName}] box_minter:`, programId);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

type ReusableProgramResolution = {
  programId: string;
  source: string;
};

async function resolveReusableProgramId(args: {
  root: string;
  solanaCluster: SolanaCluster;
  dropId: string;
  desiredMetadataPathFormat: MetadataPathFormat;
  referenceDropId?: string;
}): Promise<ReusableProgramResolution> {
  const dropId = normalizeAndValidateDropId(args.dropId);
  const rawReferenceDropId = trimToUndefined(args.referenceDropId);
  const referenceDropId = rawReferenceDropId
    ? normalizeAndValidateDropId(
        rawReferenceDropId,
        'NEW_DROP.deploy.reuseProgramIdFromDropId',
      )
    : undefined;
  const registryPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const registry = await readDeploymentDropRegistry(registryPath);
  const entries = Object.values(registry.drops).map((drop) => ({
    source: path.relative(args.root, registryPath),
    drop,
  }));

  if (referenceDropId) {
    const matches = entries.filter(({ drop }) => drop.dropId === referenceDropId && drop.solanaCluster === args.solanaCluster);
    if (!matches.length) {
      throw new Error(
        `NEW_DROP.deploy.reuseProgramIdFromDropId=${referenceDropId} did not match any ${args.solanaCluster} deployment registry entry.\n` +
          `Fix ${getActiveNewDropConfigPath()} or deploy that reference drop first.`,
      );
    }
    const programIds = uniqueStrings(matches.map(({ drop }) => drop.boxMinterProgramId));
    if (programIds.length !== 1) {
      throw new Error(
        `Reference drop ${referenceDropId} has inconsistent program ids on ${args.solanaCluster}: ${programIds.join(', ') || '(none)'}.`,
      );
    }
    new PublicKey(programIds[0]);
    return {
      programId: programIds[0],
      source: `${referenceDropId} (${uniqueStrings(matches.map((match) => match.source)).join(', ')})`,
    };
  }

  const candidates = entries.filter(
    ({ drop }) =>
      drop.dropId !== dropId &&
      drop.solanaCluster === args.solanaCluster &&
      drop.metadataPathFormat === args.desiredMetadataPathFormat &&
      String(drop.boxMinterProgramId || '').trim(),
  );
  const programIds = uniqueStrings(candidates.map(({ drop }) => drop.boxMinterProgramId));
  if (programIds.length === 1) {
    new PublicKey(programIds[0]);
    return {
      programId: programIds[0],
      source: `existing ${args.desiredMetadataPathFormat} ${args.solanaCluster} drops`,
    };
  }
  if (!programIds.length) {
    throw new Error(
      `NEW_DROP.deploy.reuseProgramId=true, but no existing ${args.desiredMetadataPathFormat} drop was found on ${args.solanaCluster}.\n` +
        `Set NEW_DROP.deploy.reuseProgramId=false for the first shared-program drop, or set NEW_DROP.deploy.reuseProgramIdFromDropId.`,
    );
  }
  throw new Error(
    `NEW_DROP.deploy.reuseProgramId=true is ambiguous on ${args.solanaCluster}; found multiple reusable program ids: ${programIds.join(', ')}.\n` +
      `Set NEW_DROP.deploy.reuseProgramIdFromDropId in ${getActiveNewDropConfigPath()}.`,
  );
}

export async function revalidateReusableProgramResolution(args: {
  root: string;
  solanaCluster: SolanaCluster;
  dropId: string;
  desiredMetadataPathFormat: MetadataPathFormat;
  referenceDropId?: string;
  expected: ReusableProgramResolution;
}): Promise<ReusableProgramResolution> {
  const current = await resolveReusableProgramId(args);
  const expectedProgramId = new PublicKey(args.expected.programId);
  const currentProgramId = new PublicKey(current.programId);
  if (!currentProgramId.equals(expectedProgramId)) {
    throw new Error(
      `Reusable program selection changed while waiting for deployer credentials.\n` +
        `- before prompt: ${expectedProgramId.toBase58()} (${args.expected.source})\n` +
        `- under lock   : ${currentProgramId.toBase58()} (${current.source})\n` +
        `No deployment mutation was started. Rerun to review and validate the current program lineage.`,
    );
  }
  await assertProgramReuseMatchesMetadataPathFormat({
    root: args.root,
    solanaCluster: args.solanaCluster,
    dropId: args.dropId,
    programId: current.programId,
    desiredMetadataPathFormat: args.desiredMetadataPathFormat,
  });
  return current;
}

async function assertReusedProgramDeployed(args: {
  connection: Connection;
  cluster: SolanaCluster;
  programId: PublicKey;
}) {
  await assertExecutableProgram({
    connection: args.connection,
    cluster: args.cluster,
    programId: args.programId,
    name: 'box_minter reused program',
  });
}

function uniquePubkeys(keys: PublicKey[]) {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const k of keys) {
    const s = k.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

async function ensureDeliveryLookupTable(args: {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  configPda: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  receiptsMerkleTree?: PublicKey;
}): Promise<PublicKey> {
  const { connection, payer, programId, configPda, treasury, coreCollection, receiptsMerkleTree } = args;
  const required = uniquePubkeys([
    programId,
    configPda,
    treasury,
    coreCollection,
    MPL_CORE_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    SPL_NOOP_PROGRAM_ID,
    // Also include Bubblegum v2 + compression + sysvar programs used by IRL claim txs,
    // so `DELIVERY_LOOKUP_TABLE` can be reused to shrink them below tx-size limits.
    MPL_NOOP_PROGRAM_ID,
    MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    BUBBLEGUM_PROGRAM_ID,
    MPL_CORE_CPI_SIGNER_ID,
    // Also include the receipt tree + its Bubblegum PDA so claim txs can stay tiny.
    ...(receiptsMerkleTree ? [receiptsMerkleTree, bubblegumTreeConfigPda(receiptsMerkleTree)] : []),
  ]);

  // Create a fresh LUT + extend with required addresses (no caching; clean deployments).
  // IMPORTANT: Address Lookup Tables require a *recent rooted slot* (present in the SlotHashes sysvar).
  // Using `confirmed` can return a slot that's not yet rooted, which fails with:
  //   "<slot> is not a recent slot" (InvalidInstructionData)
  const recentSlot = await retryRpcRead('getSlot(create delivery ALT)', () => connection.getSlot('finalized'));
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    recentSlot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses: required,
  });

  const tx = new Transaction().add(createIx, extendIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(create delivery ALT)', () => connection.getLatestBlockhash('finalized'))).blockhash;
  const sig = await sendAndConfirmTx({ connection, tx, signers: [payer], label: 'create delivery ALT', commitment: 'confirmed' });
  console.log('✅ Delivery ALT created:', sig);
  console.log('  ALT:', lutAddress.toBase58());
  return lutAddress;
}

// ---------------------------------------------------------------------------
// Receipt cNFT Merkle tree sizing (Bubblegum v2).
//
// This tree ONLY stores *compressed receipt NFTs* minted by the box minter receipt instructions.
// The uncompressed MPL-Core assets (boxes + revealed figures) are NOT stored in this tree.
//
// Sizing is configured in the selected NEW_DROP.onchain.receiptsTree config and validated
// against NEW_DROP.onchain.maxSupply before deploy side effects begin.
// ---------------------------------------------------------------------------
const IX_BUBBLEGUM_CREATE_TREE_CONFIG_V2 = Buffer.from([55, 99, 95, 215, 142, 203, 227, 205]);

export function bubblegumTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

export function buildCreateBubblegumTreeConfigV2Ix(args: {
  merkleTree: PublicKey;
  payer: PublicKey;
  treeCreator: PublicKey;
  maxDepth: number;
  maxBufferSize: number;
  // If undefined/null, encodes Option::None (private tree).
  isPublic?: boolean | null;
}): TransactionInstruction {
  const treeConfig = bubblegumTreeConfigPda(args.merkleTree);
  const publicOpt = args.isPublic == null ? Buffer.from([0]) : Buffer.from([1, args.isPublic ? 1 : 0]);
  const data = Buffer.concat([
    IX_BUBBLEGUM_CREATE_TREE_CONFIG_V2,
    u32LE(args.maxDepth),
    u32LE(args.maxBufferSize),
    publicOpt,
  ]);

  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.merkleTree, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.treeCreator, isSigner: true, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function createReceiptsMerkleTree(args: {
  connection: Connection;
  payer: Keypair;
  tree: PreparedReceiptsTreeConfig;
}): Promise<PublicKey> {
  const { connection, payer, tree } = args;
  const merkleTree = Keypair.generate();
  const space = getConcurrentMerkleTreeAccountSize(tree.maxDepth, tree.maxBufferSize, tree.canopyDepth);
  const lamports = await retryRpcRead('getMinimumBalanceForRentExemption(create receipts Merkle tree)', () =>
    connection.getMinimumBalanceForRentExemption(space, 'confirmed'),
  );

  const createTreeAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: merkleTree.publicKey,
    lamports,
    space,
    programId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  });
  const createTreeConfigIx = buildCreateBubblegumTreeConfigV2Ix({
    merkleTree: merkleTree.publicKey,
    payer: payer.publicKey,
    treeCreator: payer.publicKey,
    maxDepth: tree.maxDepth,
    maxBufferSize: tree.maxBufferSize,
    isPublic: null,
  });

  const tx = new Transaction().add(createTreeAccountIx).add(createTreeConfigIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(create receipts Merkle tree)', () => connection.getLatestBlockhash('confirmed'))).blockhash;
  const sig = await sendAndConfirmTx({
    connection,
    tx,
    signers: [payer, merkleTree],
    label: 'create receipts Merkle tree',
    commitment: 'confirmed',
  });
  console.log('✅ Receipt cNFT Merkle tree created:', sig);
  console.log('  RECEIPTS_MERKLE_TREE:', merkleTree.publicKey.toBase58());
  return merkleTree.publicKey;
}

function writeFreshProgramKeypair(programKeypairPath: string, kp: Keypair): { backupPath?: string } {
  mkdirSync(path.dirname(programKeypairPath), { recursive: true });

  let backupPath: string | undefined;
  if (existsSync(programKeypairPath)) {
    // Keep a copy so you can still upgrade older deployments if needed.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = programKeypairPath.replace(/\.json$/i, `.${ts}.bak.json`);
    try {
      renameSync(programKeypairPath, backupPath);
    } catch {
      // Fallback: best-effort unique name.
      backupPath = programKeypairPath.replace(/\.json$/i, `.bak.${Date.now()}.json`);
      renameSync(programKeypairPath, backupPath);
    }
  }

  // solana-cli expects a JSON array of 64 u8 values.
  writeFileSync(programKeypairPath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600 });
  return { backupPath };
}

export function formatFreshProgramKeypairNotice(args: {
  programId: string;
  programKeypairPath: string;
  backupPath?: string;
}): string {
  const lines = [
    '',
    '================================================================================',
    'IMPORTANT: FRESH SHARED PROGRAM KEYPAIR CREATED',
    '================================================================================',
    `Program id:   ${args.programId}`,
    `Keypair path: ${path.resolve(args.programKeypairPath)}`,
    '',
    'Back up this keypair file immediately. It is not tracked by git, and losing it means',
    'this shared program id cannot be upgraded or reused later.',
  ];

  if (args.backupPath) {
    lines.push('', `Previous keypair backup: ${path.resolve(args.backupPath)}`);
  }

  lines.push('================================================================================', '');
  return lines.join('\n');
}

function cargoLockHasPackage(onchainDir: string, name: string, version: string): boolean {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;
  const content = readFileSync(lockPath, 'utf8');
  const re = new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${name}"\\s*\\nversion = "${version}"`, 'm');
  return re.test(content);
}

async function assertMplCoreCollection(connection: Connection, coreCollection: PublicKey) {
  const info = await retryRpcRead(`getAccountInfo(core collection ${coreCollection.toBase58()})`, () =>
    connection.getAccountInfo(coreCollection, { commitment: 'confirmed' }),
  );
  if (!info) {
    throw new Error(
      `Missing core collection account: ${coreCollection.toBase58()}\n` +
        `Make sure NEW_DROP.shared.isMainnet / NEW_DROP.deploy.solanaRpcUrl are correct (${getActiveNewDropConfigPath()}).`,
    );
  }
  if (!info.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new Error(
      `coreCollection ${coreCollection.toBase58()} is not owned by the MPL-Core program.\n` +
        `Expected owner: ${MPL_CORE_PROGRAM_ID.toBase58()}\n` +
        `Actual owner  : ${info.owner.toBase58()}\n` +
        `If you set NEW_DROP.deploy.coreCollectionPubkey, it must be an MPL-Core collection address (not a Token Metadata mint).`,
    );
  }
}

function decodeMplCoreCollectionUpdateAuthority(data: Buffer): PublicKey {
  // mpl-core BaseCollectionV1 starts with `Key` enum (u8). CollectionV1 = 5.
  const key = data[0];
  if (key !== 5) {
    throw new Error(`Not an MPL-Core collection account (unexpected Key enum ${key})`);
  }
  // BaseCollectionV1::update_authority is the next 32 bytes.
  return new PublicKey(data.subarray(1, 1 + 32));
}

async function getMplCoreCollectionUpdateAuthority(connection: Connection, coreCollection: PublicKey): Promise<PublicKey> {
  const info = await retryRpcRead(`getAccountInfo(core collection update authority ${coreCollection.toBase58()})`, () =>
    connection.getAccountInfo(coreCollection, { commitment: 'confirmed' }),
  );
  if (!info?.data) {
    throw new Error(`Missing core collection account: ${coreCollection.toBase58()}`);
  }
  return decodeMplCoreCollectionUpdateAuthority(info.data);
}

export function decodeMplCoreCollectionBase(data: Buffer): {
  updateAuthority: PublicKey;
  name: string;
  uri: string;
} {
  if (data[0] !== 5 || data.length < 33) {
    throw new Error('Not an MPL-Core CollectionV1 account');
  }
  let offset = 33;
  const readString = (label: string): string => {
    if (!canRead(data, offset, 4)) {
      throw new Error(`Truncated MPL-Core collection ${label}`);
    }
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (!canRead(data, offset, length)) {
      throw new Error(`Truncated MPL-Core collection ${label}`);
    }
    const value = data.subarray(offset, offset + length).toString('utf8');
    offset += length;
    return value;
  };
  return {
    updateAuthority: new PublicKey(data.subarray(1, 33)),
    name: readString('name'),
    uri: readString('uri'),
  };
}

export type DecodedReceiptTreeState = {
  maxDepth: number;
  maxBufferSize: number;
  authority: PublicKey;
  creator: PublicKey;
  delegate: PublicKey;
  totalCapacity: number;
  numMinted: number;
  isPublic: boolean;
  version: number;
};

const BUBBLEGUM_TREE_CONFIG_V2_DISCRIMINATOR = Buffer.from([
  122, 245, 175, 248, 171, 34, 0, 207,
]);

function readSafeU64(data: Buffer, offset: number, label: string): number {
  if (!canRead(data, offset, 8)) {
    throw new Error(`Truncated ${label}`);
  }
  const value = data.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  return Number(value);
}

export function decodeReceiptTreeState(args: {
  merkleTreeData: Buffer;
  treeConfigData: Buffer;
}): DecodedReceiptTreeState {
  const merkle = args.merkleTreeData;
  const config = args.treeConfigData;
  if (merkle.length < 56 || merkle[0] !== 1 || merkle[1] !== 0) {
    throw new Error('Invalid concurrent Merkle tree account header');
  }
  if (
    config.length < 96 ||
    !config
      .subarray(0, BUBBLEGUM_TREE_CONFIG_V2_DISCRIMINATOR.length)
      .equals(BUBBLEGUM_TREE_CONFIG_V2_DISCRIMINATOR)
  ) {
    throw new Error('Invalid Bubblegum TreeConfig account');
  }
  return {
    maxBufferSize: merkle.readUInt32LE(2),
    maxDepth: merkle.readUInt32LE(6),
    authority: new PublicKey(merkle.subarray(10, 42)),
    creator: new PublicKey(config.subarray(8, 40)),
    delegate: new PublicKey(config.subarray(40, 72)),
    totalCapacity: readSafeU64(config, 72, 'TreeConfig totalCapacity'),
    numMinted: readSafeU64(config, 80, 'TreeConfig numMinted'),
    isPublic: config[88] !== 0,
    version: config[90],
  };
}

export async function validateReceiptPoolDeploymentOnchain(args: {
  connection: Connection;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  authority: PublicKey;
  collectionMetadataUri: string;
  collectionName: string;
  royaltiesBasisPoints: number;
  royaltiesRecipient: PublicKey;
  receiptsTreeMaxDepth: number;
  receiptsTreeMaxBufferSize: number;
  receiptsTreeCanopyDepth: number;
  commitment?: Commitment;
}): Promise<DecodedReceiptTreeState> {
  const commitment = args.commitment || 'confirmed';
  const treeConfig = bubblegumTreeConfigPda(args.receiptsMerkleTree);
  const [collectionInfo, merkleTreeInfo, treeConfigInfo] =
    await retryRpcRead('getMultipleAccountsInfo(receipt pool)', () =>
      args.connection.getMultipleAccountsInfo(
        [args.collectionMint, args.receiptsMerkleTree, treeConfig],
        { commitment },
      ),
    );
  if (!collectionInfo) {
    throw new Error(
      `Missing receipt pool collection ${args.collectionMint.toBase58()}`,
    );
  }
  if (!collectionInfo.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new Error('Receipt pool collection has the wrong owner');
  }
  if (!merkleTreeInfo) {
    throw new Error(
      `Missing receipt pool Merkle tree ${args.receiptsMerkleTree.toBase58()}`,
    );
  }
  if (!merkleTreeInfo.owner.equals(MPL_ACCOUNT_COMPRESSION_PROGRAM_ID)) {
    throw new Error('Receipt pool Merkle tree has the wrong owner');
  }
  if (!treeConfigInfo) {
    throw new Error(`Missing receipt pool TreeConfig ${treeConfig.toBase58()}`);
  }
  if (!treeConfigInfo.owner.equals(BUBBLEGUM_PROGRAM_ID)) {
    throw new Error('Receipt pool TreeConfig has the wrong owner');
  }

  const collection = decodeMplCoreCollectionBase(
    Buffer.from(collectionInfo.data),
  );
  if (!collection.updateAuthority.equals(args.authority)) {
    throw new Error('Receipt pool collection update authority mismatch');
  }
  if (
    collection.name !== args.collectionName ||
    collection.uri !== args.collectionMetadataUri
  ) {
    throw new Error(
      `Receipt pool collection identity mismatch: ${collection.name} ${collection.uri}`,
    );
  }
  const pluginRecords = readMplCoreCollectionPluginRecords(
    Buffer.from(collectionInfo.data),
  );
  if (!pluginRecords?.some((record) => record.pluginType === 15)) {
    throw new Error('Receipt pool collection is missing BubblegumV2');
  }
  const royalties = decodeMplCoreCollectionRoyalties(
    Buffer.from(collectionInfo.data),
  );
  if (
    !royalties ||
    royalties.basisPoints !== args.royaltiesBasisPoints ||
    royalties.ruleSetKind !== 0 ||
    royalties.authorityKind !==
      MPL_CORE_BASE_PLUGIN_AUTHORITY_UPDATE_AUTHORITY ||
    royalties.creators.length !== 1 ||
    !royalties.creators[0].address.equals(args.royaltiesRecipient) ||
    royalties.creators[0].percentage !== 100
  ) {
    throw new Error('Receipt pool collection royalties mismatch');
  }
  assertReceiptPoolCollectionUpdateDelegatePolicy({
    data: Buffer.from(collectionInfo.data),
    authority: args.authority,
  });

  const tree = decodeReceiptTreeState({
    merkleTreeData: Buffer.from(merkleTreeInfo.data),
    treeConfigData: Buffer.from(treeConfigInfo.data),
  });
  const expectedTreeSize = getConcurrentMerkleTreeAccountSize(
    args.receiptsTreeMaxDepth,
    args.receiptsTreeMaxBufferSize,
    args.receiptsTreeCanopyDepth,
  );
  if (merkleTreeInfo.data.length !== expectedTreeSize) {
    throw new Error(
      `Receipt pool Merkle tree size mismatch: expected ${expectedTreeSize}, got ${merkleTreeInfo.data.length}`,
    );
  }
  if (
    tree.maxDepth !== args.receiptsTreeMaxDepth ||
    tree.maxBufferSize !== args.receiptsTreeMaxBufferSize ||
    !tree.authority.equals(treeConfig) ||
    !tree.creator.equals(args.authority) ||
    !tree.delegate.equals(args.authority) ||
    tree.totalCapacity !== 2 ** args.receiptsTreeMaxDepth ||
    tree.numMinted > tree.totalCapacity ||
    tree.isPublic ||
    tree.version !== 1
  ) {
    throw new Error('Receipt pool Merkle tree configuration mismatch');
  }
  return tree;
}

async function main() {
  const extraArgs = process.argv.slice(2);
  if (extraArgs.length !== 1) {
    throw new Error(
      `This script requires exactly one dropId argument so it can load scripts/newDrops/<dropId>.ts.\n` +
        `${newDropConfigUsage()}`,
    );
  }
  if (!String(extraArgs[0] || '').trim()) {
    throw new Error(`Missing dropId.\n${newDropConfigUsage()}`);
  }
  const requestedDropId = normalizeAndValidateDropId(
    extraArgs[0],
    'requested dropId',
  );

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const deploymentRegistryPath = path.join(
    root,
    'shared',
    'deploymentRegistry.ts',
  );
  const { config: newDropConfig, configPath } = await loadNewDropConfigById({
    root,
    dropId: requestedDropId,
  });
  setActiveNewDropConfigPath(root, configPath);
  const deployCfg = newDropConfig.deploy;
  const dropCfg = newDropConfig.onchain;
  const metadataPathFormat: MetadataPathFormat = 'compact';
  const cluster: SolanaCluster = deployCfg.solanaCluster;
  const dropId = normalizeAndValidateDropId(
    requireNonEmptyString(dropCfg.dropId, 'NEW_DROP.onchain.dropId'),
    'NEW_DROP.onchain.dropId',
  );
  const dropFamily = requireDropFamily(dropCfg.dropFamily, 'NEW_DROP.onchain.dropFamily');
  const stripeCheckoutConfig = prepareStripeCheckoutConfig({
    solanaCluster: cluster,
    dropId,
    dropFamily,
    stripeCheckoutEnabled: dropCfg.stripeCheckoutEnabled,
    stripeLiveUnitAmountCents: dropCfg.stripeLiveUnitAmountCents,
  });
  const salesMode = normalizeDropSalesMode(dropCfg.salesMode);
  const receiptPoolId = trimToUndefined(dropCfg.receiptPoolId);
  if (
    (salesMode === 'stripe_receipt_only') !== Boolean(receiptPoolId)
  ) {
    throw new Error(
      'NEW_DROP.onchain.receiptPoolId must be paired with salesMode=stripe_receipt_only',
    );
  }
  const receiptPoolSpec = receiptPoolId
    ? requireReceiptPoolSpec(receiptPoolId)
    : null;
  const dropSeed = deriveDropSeed(dropId);
  await assertDropIdNotConfiguredInDeploymentRegistry({
    dropId,
    registryPath: deploymentRegistryPath,
  });
  const dropMetadataBase = normalizeDropBase(requireNonEmptyString(dropCfg.metadataBase, 'NEW_DROP.onchain.metadataBase'));
  const collectionMetadata = prepareCollectionMetadata(
    dropCfg,
    receiptPoolSpec,
  );
  const effectiveDropSymbol =
    receiptPoolSpec?.collectionSymbol ||
    requireNonEmptyString(
      dropCfg.symbol || '',
      'NEW_DROP.onchain.symbol',
    );
  const receiptsTreeConfig = prepareReceiptsTreeConfig(
    dropCfg,
    receiptPoolSpec,
  );
  const coreCollectionRoyaltiesBps = requireRoyaltiesBps(
    receiptPoolSpec?.royaltiesBasisPoints ??
      dropCfg.coreCollectionRoyaltiesBps,
  );
  if (collectionMetadata.sellerFeeBasisPoints !== coreCollectionRoyaltiesBps) {
    throw new Error(
      `Mismatch in ${getActiveNewDropConfigPath()} for collection royalties.\n` +
        `- NEW_DROP.onchain.collectionMetadata.sellerFeeBasisPoints: ${collectionMetadata.sellerFeeBasisPoints}\n` +
        `- NEW_DROP.onchain.coreCollectionRoyaltiesBps            : ${coreCollectionRoyaltiesBps}\n` +
        `\n` +
        `These values must match before deploying.`,
    );
  }
  const preflightRegistry = await readDeploymentDropRegistry(
    deploymentRegistryPath,
  );
  let receiptMetadataTreeCapacity: number | null = null;
  const receiptPoolDeployment = receiptPoolSpec
    ? preflightRegistry.receiptPools[
        `${cluster}:${receiptPoolSpec.receiptPoolId}`
      ]
    : undefined;
  if (receiptPoolSpec && !receiptPoolDeployment) {
    throw new Error(
      `Receipt pool ${cluster}:${receiptPoolSpec.receiptPoolId} is not deployed.\nRun: npm run deploy-receipt-pool -- ${receiptPoolSpec.receiptPoolId} ${cluster}`,
    );
  }
  if (receiptPoolSpec && receiptPoolDeployment) {
    if (
      dropCfg.collectionMetadata ||
      dropCfg.receiptsTree ||
      dropCfg.coreCollectionRoyaltiesBps != null
    ) {
      throw new Error(
        'Receipt pool drops must derive collection metadata, royalties, and tree dimensions exclusively from the pool spec',
      );
    }
    assertReceiptPoolDeploymentMatchesSpec({
      deployment: receiptPoolDeployment,
      spec: receiptPoolSpec,
      solanaCluster: cluster,
    });
    if (
      !stripeCheckoutConfig.stripeCheckoutEnabled ||
      dropCfg.itemsPerBox !== 0 ||
      dropCfg.maxPerTx !== 1 ||
      dropCfg.mintSelection ||
      dropCfg.priceSol !== 1_000_000 ||
      dropCfg.discountPriceSol !== 1_000_000
    ) {
      throw new Error(
        'stripe_receipt_only requires Stripe enabled, itemsPerBox=0, maxPerTx=1, no mintSelection, and sentinel SOL prices of 1_000_000',
      );
    }
    if (deployCfg.coreCollectionPubkey) {
      throw new Error(
        'Receipt pool drops resolve their collection from the canonical pool and must not set coreCollectionPubkey',
      );
    }
    receiptMetadataTreeCapacity = assertReceiptPoolCapacity({
      solanaCluster: cluster,
      receiptPoolId: receiptPoolSpec.receiptPoolId,
      metadataBase: dropMetadataBase,
      maxSupply: dropCfg.maxSupply,
      treeMaxDepth: receiptPoolSpec.receiptsTree.maxDepth,
      existingDrops: preflightRegistry.drops,
    }).capacity;
  }
  const programKeypair = path.join(onchainDir, 'target', 'deploy', 'box_minter-keypair.json');
  const programBinary = path.join(onchainDir, 'target', 'deploy', 'box_minter.so');

  const rpcUrlForApps = deployCfg.solanaRpcUrl || clusterApiUrl(cluster);
  const solanaUrl = deployCfg.solanaRpcUrl || cluster;
  const solanaBinDir = readSolanaActiveReleaseBinDir();

  console.log('--- deploy ALL (program + MPL Core collection + config) ---');
  console.log('cluster:', cluster);
  console.log('rpc url :', rpcUrlForApps);
  console.log(
    'receipts tree:',
    `depth=${receiptsTreeConfig.maxDepth}, buffer=${receiptsTreeConfig.maxBufferSize}, canopy=${receiptsTreeConfig.canopyDepth}`,
  );
  console.log('config  :', getActiveNewDropConfigPath());
  console.log(
    'collection metadata url:',
    receiptPoolSpec?.collectionMetadataUri ||
      `${dropMetadataBase}/collection.json`,
  );
  if (deployCfg.coreCollectionPubkey) console.log('core collection:', deployCfg.coreCollectionPubkey);
  if (solanaBinDir) console.log('solana bin:', solanaBinDir);
  console.log('');

  let collectionMetadataJson = await assertCollectionMetadataJsonMatchesNewDrop({
    metadataBase: dropMetadataBase,
    collectionMetadataUri: receiptPoolSpec?.collectionMetadataUri,
    expectedCreator: receiptPoolSpec?.royaltiesRecipient,
    expected: collectionMetadata,
  });
  if (receiptPoolSpec) {
    await assertReceiptMetadataRange({
      metadataBase: dropMetadataBase,
      maxSupply: dropCfg.maxSupply,
      treeCapacity: receiptMetadataTreeCapacity!,
    });
  }
  console.log(`✅ collection.json preflight matches ${getActiveNewDropConfigPath()}`);

  // Fail fast if the target cluster/RPC does not have the Metaplex programs we depend on.
  const connection = new Connection(rpcUrlForApps, { commitment: 'confirmed' });
  await assertExternalProgramsDeployed(connection, cluster);
  if (receiptPoolSpec && receiptPoolDeployment) {
    const treeState = await validateReceiptPoolDeploymentOnchain({
      connection,
      collectionMint: new PublicKey(
        receiptPoolDeployment.collectionMint,
      ),
      receiptsMerkleTree: new PublicKey(
        receiptPoolDeployment.receiptsMerkleTree,
      ),
      authority: new PublicKey(receiptPoolSpec.authority),
      collectionMetadataUri: receiptPoolSpec.collectionMetadataUri,
      collectionName: receiptPoolSpec.collectionName,
      royaltiesBasisPoints: receiptPoolSpec.royaltiesBasisPoints,
      royaltiesRecipient: new PublicKey(
        receiptPoolSpec.royaltiesRecipient,
      ),
      receiptsTreeMaxDepth: receiptPoolSpec.receiptsTree.maxDepth,
      receiptsTreeMaxBufferSize:
        receiptPoolSpec.receiptsTree.maxBufferSize,
      receiptsTreeCanopyDepth:
        receiptPoolSpec.receiptsTree.canopyDepth,
    });
    assertReceiptPoolCapacity({
      solanaCluster: cluster,
      receiptPoolId: receiptPoolSpec.receiptPoolId,
      metadataBase: dropMetadataBase,
      maxSupply: dropCfg.maxSupply,
      treeMaxDepth: receiptPoolSpec.receiptsTree.maxDepth,
      existingDrops: preflightRegistry.drops,
      onchainNumMinted: treeState.numMinted,
    });
  }

  const reuseProgramId = deployCfg.reuseProgramId;
  let expectedProgramId: string | undefined;
  let reusableProgram: ReusableProgramResolution | null = null;
  let freshProgramKeypair: Keypair | null = null;
  if (reuseProgramId) {
    reusableProgram = await resolveReusableProgramId({
      root,
      solanaCluster: cluster,
      dropId,
      desiredMetadataPathFormat: metadataPathFormat,
      referenceDropId: deployCfg.reuseProgramIdFromDropId,
    });
    expectedProgramId = reusableProgram.programId;
    console.log('Reusing deployed program id:', expectedProgramId);
    console.log('  source:', reusableProgram.source);
  } else {
    freshProgramKeypair = Keypair.generate();
    expectedProgramId = freshProgramKeypair.publicKey.toBase58();
  }

  // Safety preflight: validate target drop/admin and required NEW_DROP init fields before any build/deploy side effects.
  const preflightProgramId = expectedProgramId!;
  const preflightProgramPk = new PublicKey(preflightProgramId);
  if (reuseProgramId) {
    await assertReusedProgramDeployed({
      connection,
      cluster,
      programId: preflightProgramPk,
    });
    await assertLegacySingletonConfigAbsentForSharedProgramReuse({
      connection,
      programId: preflightProgramPk,
      programIdString: preflightProgramId,
    });
    await assertProgramReuseMatchesMetadataPathFormat({
      root,
      solanaCluster: cluster,
      dropId,
      programId: preflightProgramId,
      desiredMetadataPathFormat: metadataPathFormat,
    });
  }
  const preflightConfigPda = boxMinterConfigPda(preflightProgramPk, dropSeed);
  const preflightCfgInfo = await retryRpcRead(`getAccountInfo(preflight config ${preflightConfigPda.toBase58()})`, () =>
    connection.getAccountInfo(preflightConfigPda, { commitment: 'confirmed' }),
  );
  if (preflightCfgInfo) {
    const decoded = decodeBoxMinterConfigForDeployPreflight(
      preflightCfgInfo.data,
    );
    if (decoded.started || decoded.minted !== 0) {
      throwFreshDeployOnlyForExistingConfig({
        stage: 'preflight',
        dropId,
        programId: preflightProgramId,
        configPda: preflightConfigPda,
        configData: preflightCfgInfo.data,
      });
    }
    console.log(
      `Resumable unstarted config found: ${preflightConfigPda.toBase58()}`,
    );
  }
  assertReceiptsTreeCapacityForMaxSupply({
    tree: receiptsTreeConfig,
    maxSupply: dropCfg.maxSupply,
    maxSupplyLabel: 'NEW_DROP.onchain.maxSupply',
    itemsPerBox: dropCfg.itemsPerBox,
    itemsPerBoxLabel: 'NEW_DROP.onchain.itemsPerBox',
  });
  const initDropInputs = prepareInitDropInputs({
    root,
    dropCfg,
    dropMetadataBase,
  });
  let discountMerkleDataset = await validateDiscountMerkleDatasetForDeploy({
    root,
    dropId,
    dropFamily,
    merkleRoot: initDropInputs.discountMerkle.root,
    proofs: initDropInputs.discountMerkle.proofs,
  });

  console.log('Enter the deployer wallet private key (input is hidden).');
  console.log('Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).');
  const payer = parsePrivateKeyInput(await promptMaskedInput('deployer private key: '));
  console.log('deployer pubkey:', payer.publicKey.toBase58());
  if (
    receiptPoolSpec &&
    !payer.publicKey.equals(new PublicKey(receiptPoolSpec.authority))
  ) {
    throw new Error(
      `Receipt pool drops must use admin ${receiptPoolSpec.authority}`,
    );
  }

  const releaseDeploymentRegistryLock = acquireDeploymentRegistryMutationLock({
    root,
    operation: `deploy ${dropId}`,
  });
  const deploymentCleanup = registerDeploymentCleanup({
    releaseDeploymentRegistryLock,
  });
  try {
  // The first check happened before the private-key prompt. Recheck under the
  // repository lock so another completed deployment cannot slip through.
  await assertDropIdNotConfiguredInDeploymentRegistry({
    dropId,
    registryPath: deploymentRegistryPath,
  });
  if (receiptPoolSpec && receiptPoolDeployment) {
    const lockedRegistry = await readDeploymentDropRegistry(
      deploymentRegistryPath,
    );
    const lockedPool =
      lockedRegistry.receiptPools[
        `${cluster}:${receiptPoolSpec.receiptPoolId}`
      ];
    if (
      !lockedPool ||
      lockedPool.collectionMint !== receiptPoolDeployment.collectionMint ||
      lockedPool.receiptsMerkleTree !==
        receiptPoolDeployment.receiptsMerkleTree
    ) {
      throw new Error(
        `Receipt pool ${cluster}:${receiptPoolSpec.receiptPoolId} changed while awaiting credentials`,
      );
    }
    assertReceiptPoolDeploymentMatchesSpec({
      deployment: lockedPool,
      spec: receiptPoolSpec,
      solanaCluster: cluster,
    });
    const treeState = await validateReceiptPoolDeploymentOnchain({
      connection,
      collectionMint: new PublicKey(lockedPool.collectionMint),
      receiptsMerkleTree: new PublicKey(
        lockedPool.receiptsMerkleTree,
      ),
      authority: new PublicKey(receiptPoolSpec.authority),
      collectionMetadataUri: receiptPoolSpec.collectionMetadataUri,
      collectionName: receiptPoolSpec.collectionName,
      royaltiesBasisPoints: receiptPoolSpec.royaltiesBasisPoints,
      royaltiesRecipient: new PublicKey(
        receiptPoolSpec.royaltiesRecipient,
      ),
      receiptsTreeMaxDepth: receiptPoolSpec.receiptsTree.maxDepth,
      receiptsTreeMaxBufferSize:
        receiptPoolSpec.receiptsTree.maxBufferSize,
      receiptsTreeCanopyDepth:
        receiptPoolSpec.receiptsTree.canopyDepth,
    });
    assertReceiptPoolCapacity({
      solanaCluster: cluster,
      receiptPoolId: receiptPoolSpec.receiptPoolId,
      metadataBase: dropMetadataBase,
      maxSupply: dropCfg.maxSupply,
      treeMaxDepth: receiptPoolSpec.receiptsTree.maxDepth,
      existingDrops: lockedRegistry.drops,
      onchainNumMinted: treeState.numMinted,
    });
  }
  if (reusableProgram) {
    await revalidateReusableProgramResolution({
      root,
      solanaCluster: cluster,
      dropId,
      desiredMetadataPathFormat: metadataPathFormat,
      referenceDropId: deployCfg.reuseProgramIdFromDropId,
      expected: reusableProgram,
    });
  }
  discountMerkleDataset = await validateDiscountMerkleDatasetForDeploy({
    root,
    dropId,
    dropFamily,
    merkleRoot: initDropInputs.discountMerkle.root,
    proofs: initDropInputs.discountMerkle.proofs,
  });

  const tempKeypairPath = writeTempKeypairFile(payer);
  deploymentCleanup.setTempKeypairPath(tempKeypairPath);
  const toolEnv = {
    ...(solanaBinDir ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` } : {}),
    // Keep anchor + solana cli aligned with the deployer wallet.
    ANCHOR_WALLET: tempKeypairPath,
    NO_DNA: '1',
  };

  if (freshProgramKeypair) {
    const { backupPath } = writeFreshProgramKeypair(programKeypair, freshProgramKeypair);
    console.log(
      formatFreshProgramKeypairNotice({
        programId: expectedProgramId!,
        programKeypairPath: programKeypair,
        backupPath,
      }),
    );
  }

  // 1) Build + deploy the program only for fresh shared-program lineages.
  // Reused drops intentionally skip program build/deploy; program upgrades must use upgrade-onchain.
  let programId = preflightProgramId;
  if (reuseProgramId) {
    console.log('\nReusing deployed program; skipping program build/deploy.');
    console.log('Program deployed:', programId);
  } else {
    const hasSolanaCargo = canRunSolanaCargo();
    if (hasSolanaCargo) {
      console.log('solana cargo toolchain:', 'cargo +solana');
    } else {
      console.warn('⚠️  Missing rustup `solana` toolchain (`cargo +solana`). Anchor may fail if your Cargo.lock is too new.');
    }

    writeProgramIdToSource(onchainDir, programId);
    writeProgramIdToAnchorToml(onchainDir, cluster, programId);

    removeStaleAnchorGeneratedArtifacts(onchainDir);
    const syncedProgramId = readProgramId(onchainDir);
    if (syncedProgramId !== programId) {
      throw new Error(
        `Program id sync mismatch.\n` +
          `Expected: ${programId}\n` +
          `Synced  : ${syncedProgramId}\n` +
          `\n` +
          `This usually means the program source did not update correctly.\n` +
          `Try fixing ${path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs')} and re-run this script.`,
      );
    }

    // Ensure Cargo.lock is compatible with the Solana toolchain (cargo 1.72.x).
    const lockMoved = ensureAnchorCompatibleCargoLock(onchainDir);

    // Only (re)generate a lockfile if it's missing (fresh clone) or if we moved aside an incompatible v4 lockfile.
    // If a compatible Cargo.lock already exists, keep it as-is so dependency versions remain pinned.
    if (hasSolanaCargo && (lockMoved || !existsSync(path.join(onchainDir, 'Cargo.lock')))) {
      run('cargo', ['+solana', 'generate-lockfile'], { cwd: onchainDir });

      // Cargo can pick newer crates that exceed Solana's pinned Rust toolchain MSRV.
      // In particular, borsh 1.6.x requires rustc >= 1.77; pin borsh to 1.5.5 if needed.
      if (cargoLockHasPackage(onchainDir, 'borsh', '1.6.0')) {
        run('cargo', ['+solana', 'update', '-p', 'borsh@1.6.0', '--precise', '1.5.5'], { cwd: onchainDir });
      }
    }

    // Build with Anchor "lean" features to reduce binary size (no on-chain IDL + no auto instruction-name logs).
    // `--no-idl` skips Anchor's separate IDL generation step, which otherwise requires an
    // `idl-build` feature on Anchor 0.32.x even when the Rust `no-idl` feature is enabled.
    run('anchor', ['build', '--no-idl', '--arch', 'sbf', '--', '--features', 'no-idl,no-log-ix-name'], {
      cwd: onchainDir,
      env: toolEnv,
    });
    if (!existsSync(programBinary)) {
      throw new Error(`Missing program binary after build: ${programBinary}`);
    }

    const canSkipRedeploy = deployedProgramMatchesBinary({
      programId,
      programBinary,
      solanaUrl,
      cwd: onchainDir,
      env: toolEnv,
    });

    if (canSkipRedeploy) {
      console.log('\nProgram already deployed with matching binary; skipping upgrade.');
      console.log('Program deployed:', programId);
    } else {
      // Deploy program via Solana CLI (Agave). This avoids `anchor deploy` rebuilding with the wrong arch/tooling.
      const deployArgs = ['program', 'deploy', programBinary, '--program-id', programKeypair, '--url', solanaUrl, '--keypair', tempKeypairPath];
      run('solana', deployArgs, { cwd: onchainDir, env: toolEnv });
      console.log('\nProgram deployed:', programId);
    }
  }

  if (dropCfg.paymentRouting) {
    await assertSplitPaymentsV1Capability({
      connection,
      programId: new PublicKey(programId),
      feePayer: payer.publicKey,
    });
  }
  const refreshedCollectionMetadataJson =
    await assertCollectionMetadataJsonMatchesNewDrop({
      metadataBase: dropMetadataBase,
      collectionMetadataUri: receiptPoolSpec?.collectionMetadataUri,
      expectedCreator: receiptPoolSpec?.royaltiesRecipient,
      expected: collectionMetadata,
    });
  assertCollectionRoyaltyCreatorsUnchanged(
    collectionMetadataJson.creators,
    refreshedCollectionMetadataJson.creators,
  );
  collectionMetadataJson = refreshedCollectionMetadataJson;

  // 2) Deploy on-chain prerequisites + initialize config PDA.
  // ---------------------------------------------------------------------------
  const programPk = new PublicKey(programId);
  const configPda = boxMinterConfigPda(programPk, dropSeed);
  const existingCfg = await retryRpcRead(`getAccountInfo(post-deploy config ${configPda.toBase58()})`, () =>
    connection.getAccountInfo(configPda, { commitment: 'confirmed' }),
  );
  if (existingCfg && !existingCfg.owner.equals(programPk)) {
    throw new Error(
      `Existing config PDA has unexpected owner ${existingCfg.owner.toBase58()}`,
    );
  }
  const requiredDropMetadataBase = initDropInputs.requiredDropMetadataBase;
  const discountMerkle = initDropInputs.discountMerkle;

  const boxMinterConfig = {
    // Payment + mint caps
    // Payments: SOL from box mints + delivery fees go here.
    // Custody/vault: boxes and delivered assets still transfer to the deployer/admin key (config.admin).
    // Set to `undefined` to default payments to the deployer/admin key.
    treasury: dropCfg.treasury,
    paymentRouting: dropCfg.paymentRouting,
    priceSol: dropCfg.priceSol,
    discountPriceSol: dropCfg.discountPriceSol,
    stripeCheckoutEnabled: stripeCheckoutConfig.stripeCheckoutEnabled,
    stripeLiveUnitAmountCents: stripeCheckoutConfig.stripeLiveUnitAmountCents,
    stripeProductTaxCode: dropCfg.stripeProductTaxCode,
    discountMintsPerWallet: requireDiscountMintsPerWallet(
      dropCfg.discountMintsPerWallet,
      'NEW_DROP.onchain.discountMintsPerWallet',
    ),
    discountMerkleRoot: discountMerkle.root,
    maxSupply: dropCfg.maxSupply,
    itemsPerBox: requireItemsPerBox(dropCfg.itemsPerBox, 'NEW_DROP.onchain.itemsPerBox'),
    maxPerTx: dropCfg.maxPerTx,

    // Box metadata (stored on-chain)
    namePrefix: dropCfg.namePrefix,
    figureNamePrefix: dropCfg.figureNamePrefix,
    symbol: effectiveDropSymbol,
    // Canonical drop base. The on-chain program derives:
    // - boxes   : `${metadataBase}/b{id}.json`
    // - figures : `${metadataBase}/f{id}.json`
    // - receipts: `${metadataBase}/rb{id}.json` and `${metadataBase}/rf{id}.json`
    // Existing legacy drops stay on their current shared-program lineage.
    metadataBase: requiredDropMetadataBase,
    mintSelection: prepareMintSelectionConfig(dropCfg),
  };

  const mintProceeds = boxMinterConfig.paymentRouting?.mintProceeds.map(
    (recipient) => ({
      address: new PublicKey(recipient.address),
      percentage: recipient.percentage,
    }),
  );
  const treasury = new PublicKey(
    boxMinterConfig.paymentRouting?.deliveryPaymentReceiver ||
      boxMinterConfig.treasury ||
      payer.publicKey.toBase58(),
  );
  const priceLamports = BigInt(Math.round(Number(boxMinterConfig.priceSol) * LAMPORTS_PER_SOL));
  const discountPriceLamports = BigInt(Math.round(Number(boxMinterConfig.discountPriceSol) * LAMPORTS_PER_SOL));
  const discountMerkleRoot = boxMinterConfig.discountMerkleRoot;
  const maxSupply = Number(boxMinterConfig.maxSupply);
  const itemsPerBox = Number(boxMinterConfig.itemsPerBox);
  const maxPerTx = Number(boxMinterConfig.maxPerTx);
  // 2) Create or reuse an MPL-Core collection (uncompressed).
  // IMPORTANT: root collection update authority stays with the deployer/admin wallet for marketplace
  // verification. The program config PDA must be an UpdateDelegate so the on-chain program can mint
  // and update collection assets through PDA-signed MPL-Core CPIs.
  const decodedExistingConfig = existingCfg
    ? decodeBoxMinterConfigForDeployPreflight(existingCfg.data)
    : null;
  const coreCollection = receiptPoolDeployment
    ? new PublicKey(receiptPoolDeployment.collectionMint)
    : deployCfg.coreCollectionPubkey
      ? new PublicKey(deployCfg.coreCollectionPubkey)
      : decodedExistingConfig?.coreCollection;
  const collectionUpdateAuthority = payer.publicKey;
  const requiredCollectionUpdateDelegates = uniquePubkeys([configPda, payer.publicKey]);

  const coreCollectionConfig = {
    name: collectionMetadata.name,
    uri: `${requiredDropMetadataBase}/collection.json`,
  };

  let resolvedCoreCollection: PublicKey;
  if (receiptPoolDeployment) {
    resolvedCoreCollection = new PublicKey(
      receiptPoolDeployment.collectionMint,
    );
    console.log('\n[2/3] Using shared receipt pool collection…');
    console.log('  core collection:', resolvedCoreCollection.toBase58());
  } else if (coreCollection) {
    resolvedCoreCollection = coreCollection;
    await assertMplCoreCollection(connection, resolvedCoreCollection);
    const updateAuthority = await getMplCoreCollectionUpdateAuthority(connection, resolvedCoreCollection);
    if (!updateAuthority.equals(collectionUpdateAuthority)) {
      throw new Error(
        `NEW_DROP.deploy.coreCollectionPubkey is not configured for this deployment.\n` +
          `Collection: ${resolvedCoreCollection.toBase58()}\n` +
          `Expected update authority (deployer/admin): ${collectionUpdateAuthority.toBase58()}\n` +
          `Actual update authority: ${updateAuthority.toBase58()}\n` +
          `\n` +
          `Fix: unset NEW_DROP.deploy.coreCollectionPubkey in ${getActiveNewDropConfigPath()} to auto-create one, or transfer collection update authority to the deployer/admin wallet.`,
      );
    }
    await assertMplCoreCollectionUpdateDelegates({
      connection,
      coreCollection: resolvedCoreCollection,
      requiredDelegates: requiredCollectionUpdateDelegates,
    });
    console.log('\n[2/3] Using existing MPL-Core collection…');
    console.log('  core collection:', resolvedCoreCollection.toBase58());
    console.log('  collection update authority (deployer/admin):', collectionUpdateAuthority.toBase58());
    console.log(
      '  required UpdateDelegate entries:',
      requiredCollectionUpdateDelegates.map((delegate) => delegate.toBase58()).join(', '),
    );
  } else {
    console.log('\n[2/3] Creating MPL-Core collection (uncompressed)…');
    const collection = Keypair.generate();
    const createCollectionIx = buildCreateMplCoreCollectionV2Ix({
      collection: collection.publicKey,
      updateAuthority: collectionUpdateAuthority,
      updateDelegates: requiredCollectionUpdateDelegates,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
      name: coreCollectionConfig.name,
      uri: coreCollectionConfig.uri,
      royaltiesBps: coreCollectionRoyaltiesBps,
      royaltiesCreators: collectionMetadataJson.creators,
    });
    const createCollectionTx = new Transaction().add(createCollectionIx);
    createCollectionTx.feePayer = payer.publicKey;
    createCollectionTx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(create MPL-Core collection)', () =>
      connection.getLatestBlockhash('confirmed'),
    )).blockhash;
    createCollectionTx.partialSign(collection);
    const sig = await sendAndConfirmTx({
      connection,
      tx: createCollectionTx,
      signers: [payer, collection],
      label: 'create MPL-Core collection',
      commitment: 'confirmed',
    });
    console.log('✅ Collection created:', sig);
    console.log('  Collection:', collection.publicKey.toBase58());
    console.log('  Collection update authority (deployer/admin):', collectionUpdateAuthority.toBase58());
    console.log(
      '  UpdateDelegate entries:',
      requiredCollectionUpdateDelegates.map((delegate) => delegate.toBase58()).join(', '),
    );
    resolvedCoreCollection = collection.publicKey;
    await assertMplCoreCollection(connection, resolvedCoreCollection);
    const updateAuthority = await getMplCoreCollectionUpdateAuthority(connection, resolvedCoreCollection);
    if (!updateAuthority.equals(collectionUpdateAuthority)) {
      throw new Error(
        `Fresh MPL-Core collection update authority mismatch.\n` +
          `Collection: ${resolvedCoreCollection.toBase58()}\n` +
          `Expected update authority (deployer/admin): ${collectionUpdateAuthority.toBase58()}\n` +
          `Actual update authority: ${updateAuthority.toBase58()}`,
      );
    }
    await assertMplCoreCollectionUpdateDelegates({
      connection,
      coreCollection: resolvedCoreCollection,
      requiredDelegates: requiredCollectionUpdateDelegates,
    });
  }

  if (existingCfg) {
    assertExistingConfigMatchesResume({
      data: existingCfg.data,
      admin: payer.publicKey,
      treasury,
      coreCollection: resolvedCoreCollection,
      priceLamports,
      discountPriceLamports,
      discountMintsPerWallet:
        boxMinterConfig.discountMintsPerWallet,
      discountMerkleRoot,
      maxSupply,
      itemsPerBox,
      maxPerTx,
      namePrefix: boxMinterConfig.namePrefix,
      figureNamePrefix: boxMinterConfig.figureNamePrefix,
      symbol: boxMinterConfig.symbol,
      metadataBase: normalizeDropBase(boxMinterConfig.metadataBase),
      mintSelection: boxMinterConfig.mintSelection,
      ...(mintProceeds ? { mintProceeds } : {}),
      dropSeed,
    });
    console.log('✅ Existing unstarted box minter config matches exactly');
  }

  // If we are using a pre-existing collection (NEW_DROP.deploy.coreCollectionPubkey), enforce royalties here.
  // For freshly created collections, royalties are already set in `create_collection_v2`.
  if (coreCollection && !receiptPoolDeployment) {
    await ensureMplCoreCollectionRoyalties({
      connection,
      payer,
      collection: resolvedCoreCollection,
      creators: collectionMetadataJson.creators,
      royaltiesBps: coreCollectionRoyaltiesBps,
    });
  }
  if (!coreCollection && !receiptPoolDeployment) {
    // Read-only check: newly-created collections should already contain the expected royalties plugin.
    await assertMplCoreCollectionRoyalties({
      connection,
      coreCollection: resolvedCoreCollection,
      creators: collectionMetadataJson.creators,
      royaltiesBps: coreCollectionRoyaltiesBps,
    });
  }

  console.log('\n[3/3] Initializing box minter…');

  const initializeArgs = {
    programId: programPk,
    admin: payer.publicKey,
    treasury,
    coreCollection: resolvedCoreCollection,
    priceLamports,
    discountPriceLamports,
    discountMintsPerWallet: boxMinterConfig.discountMintsPerWallet,
    discountMerkleRoot,
    maxSupply,
    itemsPerBox,
    maxPerTx,
    namePrefix: boxMinterConfig.namePrefix,
    figureNamePrefix: boxMinterConfig.figureNamePrefix,
    symbol: boxMinterConfig.symbol,
    metadataBase: normalizeDropBase(boxMinterConfig.metadataBase),
    mintSelection: boxMinterConfig.mintSelection,
    dropSeed,
  };
  const initIx = mintProceeds
    ? buildInitializeSplitPaymentsV1Ix({
        ...initializeArgs,
        mintProceeds,
      })
    : buildInitializeIx(initializeArgs);

  writeDiscountMerkleJson({
    root: discountMerkleRoot,
    proofs: discountMerkle.proofs,
    filePath: discountMerkleDataset.filePath,
  });
  if (!existingCfg) {
    const setupTx = new Transaction().add(initIx);
    setupTx.feePayer = payer.publicKey;
    setupTx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(initialize box minter)', () => connection.getLatestBlockhash('confirmed'))).blockhash;
    try {
      const setupSig = await sendAndConfirmTx({
        connection,
        tx: setupTx,
        signers: [payer],
        label: 'initialize box minter',
        commitment: 'confirmed',
      });
      console.log('✅ Box minter configured:', setupSig);
    } catch (err) {
      try {
        console.warn(
          `⚠️  Preserved discount proof because initialize may have landed: ${discountMerkleDataset.filePath}\n` +
            `Verify config PDA ${configPda.toBase58()} before retrying or deleting this file.`,
        );
      } catch {}
      throw err;
    }
  }
  console.log('  Config PDA:', configPda.toBase58());
  console.log('  Delivery payment receiver:', treasury.toBase58());
  if (mintProceeds) {
    console.log(
      '  Mint proceeds:',
      mintProceeds
        .map(
          (recipient) =>
            `${recipient.address.toBase58()} (${recipient.percentage}%)`,
        )
        .join(', '),
    );
  }
  console.log('  Price (lamports):', priceLamports.toString());
  console.log('  Discount price (lamports):', discountPriceLamports.toString());
  console.log('  Discount mints per wallet:', boxMinterConfig.discountMintsPerWallet);
  console.log('');

  let receiptsTree: PublicKey;
  if (receiptPoolDeployment) {
    receiptsTree = new PublicKey(
      receiptPoolDeployment.receiptsMerkleTree,
    );
    console.log(`RECEIPTS_MERKLE_TREE=${receiptsTree.toBase58()}`);
  } else {
    try {
      receiptsTree = await createReceiptsMerkleTree({
        connection,
        payer,
        tree: receiptsTreeConfig,
      });
      console.log(`RECEIPTS_MERKLE_TREE=${receiptsTree.toBase58()}`);
    } catch (err) {
      throw new Error(
        `Failed to create receipts Merkle tree for a fresh deployment.\n` +
          `- configured tree : ${formatReceiptsTreeConfig(receiptsTreeConfig)}\n` +
          `- error           : ${errorMessage(err)}\n` +
          `\n` +
          `Aborting to avoid writing stale receipts tree values from previous deployments.\n` +
          `Fix NEW_DROP.onchain.receiptsTree in ${getActiveNewDropConfigPath()} and rerun.`,
      );
    }
  }

  let deliveryLut: PublicKey | null = null;
  try {
    deliveryLut = await ensureDeliveryLookupTable({
      connection,
      payer,
      programId: programPk,
      configPda,
      treasury,
      coreCollection: resolvedCoreCollection,
      receiptsMerkleTree: receiptsTree,
    });
    console.log(`DELIVERY_LOOKUP_TABLE=${deliveryLut.toBase58()}`);
  } catch (err) {
    throw new Error(
      `Failed to create delivery ALT: ${errorMessage(err)}`,
    );
  }

  const receiptsTreeStr = receiptsTree.toBase58();
  // For fresh deployments, never reuse a previous drop's LUT: use the newly created LUT or leave empty.
  if (!deliveryLut) {
    throw new Error('Delivery ALT is required before registry commit');
  }
  const deliveryLutStr = deliveryLut.toBase58();

  const preparedRegistry = await prepareDeploymentRegistry({
    root,
    solanaCluster: cluster,
    dropId,
    dropFamily,
    collectionName: collectionMetadata.name,
    displayName: dropCfg.displayName,
    salesMode,
    receiptPoolId,
    metadataBase: requiredDropMetadataBase,
    metadataPathFormat,
    mintSelection: boxMinterConfig.mintSelection,
    ...(boxMinterConfig.paymentRouting
      ? { paymentRouting: boxMinterConfig.paymentRouting }
      : { treasury: treasury.toBase58() }),
    priceSol: Number(boxMinterConfig.priceSol),
    discountPriceSol: Number(boxMinterConfig.discountPriceSol),
    stripeCheckoutEnabled: boxMinterConfig.stripeCheckoutEnabled,
    stripeLiveUnitAmountCents: boxMinterConfig.stripeLiveUnitAmountCents,
    stripeProductTaxCode: boxMinterConfig.stripeProductTaxCode,
    discountMintsPerWallet: Number(boxMinterConfig.discountMintsPerWallet),
    discountMerkleRoot: discountMerkleRoot.toString('hex'),
    maxSupply: Number(boxMinterConfig.maxSupply),
    itemsPerBox: Number(boxMinterConfig.itemsPerBox),
    maxPerTx: Number(boxMinterConfig.maxPerTx),
    namePrefix: boxMinterConfig.namePrefix,
    figureNamePrefix: boxMinterConfig.figureNamePrefix,
    symbol: boxMinterConfig.symbol,
    boxMinterProgramId: programPk.toBase58(),
    boxMinterConfigPda: configPda.toBase58(),
    collectionMint: resolvedCoreCollection.toBase58(),
    receiptsMerkleTree: receiptsTreeStr,
    receiptsTreeMaxDepth: receiptsTreeConfig.maxDepth,
    receiptsTreeCanopyDepth: receiptsTreeConfig.canopyDepth,
    deliveryLookupTable: deliveryLutStr,
  });
  const registryWrittenPath = await finalizeDiscountMerkleAndDeploymentRegistry({
    root: discountMerkleRoot,
    proofs: discountMerkle.proofs,
    filePath: discountMerkleDataset.filePath,
    commitRegistryChanges: async () => {
      return commitDeploymentRegistry({
        registryPath: preparedRegistry.filePath,
        expectedSnapshot: preparedRegistry.sourceSnapshot,
        expectedWrittenSnapshot: preparedRegistry.expectedWrittenSnapshot,
      });
    },
  });

  console.log('');
  console.log('--- updated tracked config ---');
  console.log(`- ${path.relative(root, registryWrittenPath)}`);
  console.log('');
  } finally {
    deploymentCleanup.cleanup();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
