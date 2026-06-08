import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadNewDropConfigById, newDropConfigUsage } from './shared/newDropLoader.ts';
import type { NewDropOnchainConfig, SolanaCluster } from './shared/newDropConfig.ts';
import { keypairFromBytes, parsePrivateKeyInput, promptMaskedInput } from './shared/interactive.ts';
import {
  defaultFrontendBoxMediaForDropFamily,
  defaultFrontendFigureMediaForDropFamily,
  normalizeDropBase,
  readFrontendDropRegistry,
  readFunctionsDropRegistry,
  resolveDropAssetUrl,
  requireDropFamily,
  writeFrontendDeploymentRegistryFile,
  writeFunctionsDeploymentRegistryFile,
  type DropFamily,
  type FrontendDropConfigSerialized,
  type FunctionsDropConfigSerialized,
  type MetadataPathFormat,
  type MintSelectionConfigSerialized,
} from './shared/deploymentRegistry.ts';
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
} from '@solana/web3.js';

// MPL Core program id.
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
// SPL Noop program (Metaplex "log wrapper").
const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
// Metaplex Noop program (Bubblegum v2 log wrapper).
const MPL_NOOP_PROGRAM_ID = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
// Metaplex Account Compression program (used by Bubblegum v2 trees).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
// Metaplex Bubblegum program.
const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
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

function getConcurrentMerkleTreeAccountSize(maxDepth: number, maxBufferSize: number, canopyDepth: number): number {
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

function writeTempKeypairFile(kp: Keypair): string {
  const filePath = path.join(tmpdir(), `mons-shop-deployer-${process.pid}-${Date.now()}.json`);
  // solana-cli expects a JSON array of 64 u8 values.
  writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return filePath;
}

function registerTempKeypairCleanup(filePath: string) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
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
    const cfg = decodeBoxMinterConfig(configData);
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

function requireRoyaltiesBps(value: number): number {
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

const MIN_ITEMS_PER_BOX = 0;
const MAX_ITEMS_PER_BOX = 5;
const MIN_DISCOUNT_MINTS_PER_WALLET = 1;
const MAX_DISCOUNT_MINTS_PER_WALLET = 3;
const MIN_STRIPE_UNIT_AMOUNT_CENTS = 50;
const MAX_STRIPE_UNIT_AMOUNT_CENTS = 99_999_999;

function requireItemsPerBox(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: MIN_ITEMS_PER_BOX,
    max: MAX_ITEMS_PER_BOX,
  });
}

function requireDiscountMintsPerWallet(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: MIN_DISCOUNT_MINTS_PER_WALLET,
    max: MAX_DISCOUNT_MINTS_PER_WALLET,
  });
}

function requireStripeLiveUnitAmountCents(value: number, label: string): number {
  return requireIntegerInRange({
    value,
    label,
    min: MIN_STRIPE_UNIT_AMOUNT_CENTS,
    max: MAX_STRIPE_UNIT_AMOUNT_CENTS,
  });
}

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < MIN_DISCOUNT_MINTS_PER_WALLET || parsed > MAX_DISCOUNT_MINTS_PER_WALLET) {
    return 1;
  }
  return parsed;
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

function prepareReceiptsTreeConfig(dropCfg: NewDropOnchainConfig): PreparedReceiptsTreeConfig {
  if (!dropCfg.receiptsTree || typeof dropCfg.receiptsTree !== 'object') {
    throw new Error(`Missing NEW_DROP.onchain.receiptsTree in ${getActiveNewDropConfigPath()}`);
  }
  const receiptsTreeCfg = dropCfg.receiptsTree;
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
  if (options.length !== 3) {
    throw new Error('NEW_DROP.onchain.mintSelection.options must contain exactly 3 size options.');
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
};

function prepareCollectionMetadata(dropCfg: NewDropOnchainConfig): PreparedCollectionMetadata {
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
  return {
    name,
    symbol,
    sellerFeeBasisPoints,
    description: trimToUndefined(collectionMetadataCfg.description),
    externalUrl: trimToUndefined(collectionMetadataCfg.externalUrl),
    image: trimToUndefined(collectionMetadataCfg.image),
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

async function assertCollectionMetadataJsonMatchesNewDrop(args: {
  metadataBase: string;
  expected: PreparedCollectionMetadata;
}) {
  const collectionJsonUrl = `${args.metadataBase}/collection.json`;
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

function writeDiscountMerkleJson(args: { root: Buffer; proofs: Record<string, string[]>; filePath: string }) {
  const payload = {
    root: args.root.toString('hex'),
    proofs: args.proofs,
  };
  writeTextFileIfChanged(args.filePath, JSON.stringify(payload, null, 2));
}

async function assertDropIdNotConfiguredInDeploymentFiles(args: {
  dropId: string;
  frontendConfigPath: string;
  functionsConfigPath: string;
}) {
  const normalizedDropId = normalizeDropId(args.dropId);
  if (!normalizedDropId) {
    throw new Error('Missing NEW_DROP.onchain.dropId');
  }
  const [frontendRegistry, functionsRegistry] = await Promise.all([
    readFrontendDropRegistry(args.frontendConfigPath),
    readFunctionsDropRegistry(args.functionsConfigPath),
  ]);
  const frontendHas = Boolean(frontendRegistry.drops[normalizedDropId]);
  const functionsHas = Boolean(functionsRegistry.drops[normalizedDropId]);
  if (!frontendHas && !functionsHas) return;
  const presentIn: string[] = [];
  if (frontendHas) presentIn.push(path.relative(process.cwd(), args.frontendConfigPath));
  if (functionsHas) presentIn.push(path.relative(process.cwd(), args.functionsConfigPath));
  throw new Error(
    `Drop ${normalizedDropId} already exists in deployment registry (${presentIn.join(', ')}).\n` +
      `This script only supports fresh deployments and will not update an existing drop.\n` +
      `Choose a new NEW_DROP.onchain.dropId in ${getActiveNewDropConfigPath()}.`,
  );
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

async function writeFrontendDeploymentConfig(args: {
  root: string;
  solanaCluster: string;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  mintSelection?: MintSelectionConfigSerialized;
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
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
}) {
  const filePath = path.join(args.root, 'src', 'config', 'deployment.ts');
  const normalizedDropId = normalizeDropId(args.dropId);
  if (!normalizedDropId) {
    throw new Error('Missing dropId while writing src/config/deployment.ts');
  }
  const existing = await readFrontendDropRegistry(filePath);
  if (existing.drops[normalizedDropId]) {
    throw new Error(`Drop ${normalizedDropId} already exists in ${filePath}. Append-only deploy refuses duplicates.`);
  }
  const nextDrops = { ...existing.drops };
  const collectionName = String(args.collectionName ?? '').trim() || normalizedDropId;
  const dropFamily = requireDropFamily(args.dropFamily, 'dropFamily');
  const figureMedia = defaultFrontendFigureMediaForDropFamily(dropFamily);
  const boxMedia = defaultFrontendBoxMediaForDropFamily(dropFamily);
  nextDrops[normalizedDropId] = {
    solanaCluster: args.solanaCluster,
    dropId: normalizedDropId,
    dropFamily,
    collectionName,
    metadataBase: normalizeDropBase(args.metadataBase),
    metadataPathFormat: args.metadataPathFormat,
    ...(args.mintSelection ? { mintSelection: args.mintSelection } : {}),
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMedia ? { boxMedia } : {}),
    treasury: args.treasury,
    priceSol: Number(args.priceSol),
    discountPriceSol: Number(args.discountPriceSol),
    ...(args.stripeCheckoutEnabled === true ? { stripeCheckoutEnabled: true } : {}),
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
  };
  writeFrontendDeploymentRegistryFile({ filePath, drops: nextDrops });
  return filePath;
}

async function writeFunctionsDeploymentConfig(args: {
  root: string;
  solanaCluster: string;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  mintSelection?: MintSelectionConfigSerialized;
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
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
  deliveryLookupTable: string;
}) {
  const filePath = path.join(args.root, 'functions', 'src', 'config', 'deployment.ts');
  const normalizedDropId = normalizeDropId(args.dropId);
  if (!normalizedDropId) {
    throw new Error('Missing dropId while writing functions/src/config/deployment.ts');
  }
  const existing = await readFunctionsDropRegistry(filePath);
  if (existing.drops[normalizedDropId]) {
    throw new Error(`Drop ${normalizedDropId} already exists in ${filePath}. Append-only deploy refuses duplicates.`);
  }
  const nextDrops = { ...existing.drops };
  const collectionName = String(args.collectionName ?? '').trim() || normalizedDropId;
  const dropFamily = requireDropFamily(args.dropFamily, 'dropFamily');
  const stripeLiveUnitAmountCents =
    args.stripeLiveUnitAmountCents == null
      ? undefined
      : requireStripeLiveUnitAmountCents(args.stripeLiveUnitAmountCents, 'stripeLiveUnitAmountCents');
  const stripeProductTaxCode = trimToUndefined(args.stripeProductTaxCode);
  nextDrops[normalizedDropId] = {
    solanaCluster: args.solanaCluster,
    dropId: normalizedDropId,
    dropFamily,
    collectionName,
    metadataBase: normalizeDropBase(args.metadataBase),
    metadataPathFormat: args.metadataPathFormat,
    ...(args.mintSelection ? { mintSelection: args.mintSelection } : {}),
    treasury: args.treasury,
    priceSol: Number(args.priceSol),
    discountPriceSol: Number(args.discountPriceSol),
    ...(args.stripeCheckoutEnabled === true ? { stripeCheckoutEnabled: true } : {}),
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
    deliveryLookupTable: args.deliveryLookupTable,
  };
  writeFunctionsDeploymentRegistryFile({ filePath, drops: nextDrops });
  return filePath;
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
  const zeroArray = Array.from({ length: 3 }, () => u32LE(0));
  if (!mintSelection) {
    return Buffer.concat([u8(0), ...zeroArray, ...zeroArray, ...zeroArray]);
  }
  if (mintSelection.kind !== 'size' || mintSelection.options.length !== 3) {
    throw new Error('Invalid mintSelection config for initialize');
  }
  const startIds = mintSelection.options.map((option) => u32LE(option.startId));
  const endIds = mintSelection.options.map((option) => u32LE(option.endId));
  const nextIds = mintSelection.options.map((option) => u32LE(option.startId));
  return Buffer.concat([u8(1), ...startIds, ...endIds, ...nextIds]);
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
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`Invalid creator percentage: ${percentage}`);
  return Buffer.concat([address.toBuffer(), u8(pct)]);
}

function mplCorePluginRoyalties(args: { basisPoints: number; creators: { address: PublicKey; percentage: number }[] }): Buffer {
  const bps = Number(args.basisPoints);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error(`Invalid royalties basisPoints: ${args.basisPoints}`);
  const creators = Array.isArray(args.creators) ? args.creators : [];

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
function buildCreateMplCoreCollectionV2Ix(args: {
  collection: PublicKey;
  updateAuthority: PublicKey;
  updateDelegates: PublicKey[];
  payer: PublicKey;
  systemProgram: PublicKey;
  name: string;
  uri: string;
  royaltiesBps: number;
  royaltiesRecipient: PublicKey;
}): TransactionInstruction {
  const pluginsOpt = borshOption(
    encodeUmiArray([
      // Collection-level royalties to the same treasury used for primary mint payments.
      // IMPORTANT: we set the *plugin authority* to the deployer key so this script can later
      // update royalties if the on-chain payment treasury is changed.
      mplCorePluginAuthorityPairRoyalties({
        basisPoints: args.royaltiesBps,
        creators: [{ address: args.royaltiesRecipient, percentage: 100 }],
        authority: args.payer,
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
  royaltiesRecipient: PublicKey;
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: args.royaltiesBps,
    creators: [{ address: args.royaltiesRecipient, percentage: 100 }],
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
  royaltiesRecipient: PublicKey;
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: args.royaltiesBps,
    creators: [{ address: args.royaltiesRecipient, percentage: 100 }],
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
  royaltiesRecipient: PublicKey;
}) {
  const { connection, payer, collection, royaltiesBps, royaltiesRecipient } = args;

  // Try update first (common path once the plugin exists).
  try {
    const updateIx = buildUpdateMplCoreCollectionRoyaltiesV1Ix({
      collection,
      payer: payer.publicKey,
      authority: payer.publicKey,
      royaltiesBps,
      royaltiesRecipient,
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
    royaltiesRecipient,
  });
  const tx = new Transaction().add(addIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(add core collection royalties)', () => connection.getLatestBlockhash('confirmed'))).blockhash;
  const sig = await sendAndConfirmTx({ connection, tx, signers: [payer], label: 'add core collection royalties', commitment: 'confirmed' });
  console.log('✅ Collection royalties added:', sig);
}

function readBorshString(buf: Buffer, offset: number): { value: string; offset: number } {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  return { value: buf.subarray(start, end).toString('utf8'), offset: end };
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

function decodeMplCoreCollectionRoyalties(data: Buffer): {
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

async function assertMplCoreCollectionRoyalties(args: {
  connection: Connection;
  coreCollection: PublicKey;
  treasury: PublicKey;
  royaltiesBps: number;
}) {
  const { connection, coreCollection, treasury, royaltiesBps } = args;
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
    royalties.creators.length === 1 &&
    royalties.creators[0].address.equals(treasury) &&
    royalties.creators[0].percentage === 100;

  if (!ok) {
    throw new Error(
      `Core collection royalties mismatch.\n` +
        `Collection: ${coreCollection.toBase58()}\n` +
        `Expected: ${royaltiesBps} bps -> ${treasury.toBase58()} (100%)\n` +
        `Actual  : ${royalties.basisPoints} bps -> ${royalties.creators.map((c) => `${c.address.toBase58()} (${c.percentage}%)`).join(', ') || '(none)'}\n`,
    );
  }

  console.log('\n✅ Core collection royalties verified');
  console.log(`  basisPoints: ${royalties.basisPoints}`);
  console.log(`  recipient : ${treasury.toBase58()} (100%)`);
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
  treasury: PublicKey;
  royaltiesBps: number;
}) {
  const { connection, payer, collection, treasury, royaltiesBps } = args;
  try {
    await assertMplCoreCollectionRoyalties({
      connection,
      coreCollection: collection,
      treasury,
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
    royaltiesRecipient: treasury,
  });
  await assertMplCoreCollectionRoyalties({
    connection,
    coreCollection: collection,
    treasury,
    royaltiesBps,
  });
}

function decodeBoxMinterConfig(data: Buffer) {
  const expectedMinLen =
    8 + // anchor discriminator
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
    throw new Error(
      `Existing on-chain config uses an older schema and cannot be reused.\n` +
        `- expected config account size >= ${expectedMinLen} bytes\n` +
        `- actual config account size      : ${data.length} bytes\n` +
        `\n` +
        `This configurable items-per-box change requires a fresh deployment/init.\n` +
        `Fix: deploy to a fresh program id and rerun this script.`,
    );
  }
  // Anchor account discriminator is the first 8 bytes.
  let o = 8;
  const admin = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const treasury = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const coreCollection = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const priceLamports = data.readBigUInt64LE(o);
  o += 8;
  const discountPriceLamports = data.readBigUInt64LE(o);
  o += 8;
  const discountMerkleRoot = data.subarray(o, o + 32);
  o += 32;
  const maxSupply = data.readUInt32LE(o);
  o += 4;
  const maxPerTx = data[o];
  o += 1;
  const itemsPerBox = data[o];
  o += 1;
  const minted = data.readUInt32LE(o);
  o += 4;
  const namePrefix = readBorshString(data, o);
  o = namePrefix.offset;
  const symbol = readBorshString(data, o);
  o = symbol.offset;
  const uriBase = readBorshString(data, o);
  o = uriBase.offset;
  const started = Boolean(data[o]);
  o += 1;
  const bump = data[o];
  o += 1;
  const discountMintsPerWallet = normalizeDiscountMintsPerWallet(data[o]);

  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    started,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    bump,
    discountMintsPerWallet,
  };
}

function boxMinterConfigPda(programId: PublicKey, dropSeed?: Buffer): PublicKey {
  return (dropSeed?.length === 32
    ? PublicKey.findProgramAddressSync([Buffer.from('config'), dropSeed], programId)
    : PublicKey.findProgramAddressSync([Buffer.from('config')], programId))[0];
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
  const frontendPath = path.join(args.root, 'src', 'config', 'deployment.ts');
  const functionsPath = path.join(args.root, 'functions', 'src', 'config', 'deployment.ts');
  const [frontendRegistry, functionsRegistry] = await Promise.all([
    readFrontendDropRegistry(frontendPath),
    readFunctionsDropRegistry(functionsPath),
  ]);

  const matches = [
    ...Object.values(frontendRegistry.drops).map((drop) => ({ source: 'frontend', filePath: frontendPath, drop })),
    ...Object.values(functionsRegistry.drops).map((drop) => ({ source: 'functions', filePath: functionsPath, drop })),
  ].filter(
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
        `Fix src/config/deployment.ts and functions/src/config/deployment.ts before reusing this program id.`,
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
// Anchor instruction discriminator: sha256("global:set_treasury")[0..8]
const IX_SET_TREASURY = createHash('sha256').update('global:set_treasury').digest().subarray(0, 8);

function buildInitializeIx(args: {
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

function buildSetTreasuryIx(args: {
  programId: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  configPda?: PublicKey;
  dropSeed?: Buffer;
}): TransactionInstruction {
  const configPda = args.configPda || boxMinterConfigPda(args.programId, args.dropSeed);
  const data = Buffer.concat([IX_SET_TREASURY, args.treasury.toBuffer()]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: false },
    ],
    data,
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
      console.warn(`⚠️  Could not dump deployed program ${args.programId} for hash comparison.${stderr ? ` ${stderr}` : ''}`);
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

function readProgramId(onchainDir: string): string {
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const content = readFileSync(libPath, 'utf8');
  const match = content.match(/declare_id!\(\"([1-9A-HJ-NP-Za-km-z]{32,44})\"\)/);
  if (!match?.[1]) {
    throw new Error(`Could not find declare_id!(\"...\") in ${libPath}`);
  }
  return match[1];
}

function readProgramIdFromKeypair(programKeypairPath: string): string {
  if (!existsSync(programKeypairPath)) {
    throw new Error(`Missing program keypair: ${programKeypairPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(programKeypairPath, 'utf8'));
  } catch {
    throw new Error(`Invalid program keypair JSON: ${programKeypairPath}`);
  }
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
    throw new Error(`Invalid program keypair format: ${programKeypairPath}`);
  }
  return keypairFromBytes(Uint8Array.from(parsed as number[])).publicKey.toBase58();
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
    // Bubblegum -> MPL-Core CPI signer.
    new PublicKey('CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk'),
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

function bubblegumTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function buildCreateBubblegumTreeConfigV2Ix(args: {
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

async function main() {
  const extraArgs = process.argv.slice(2);
  if (extraArgs.length !== 1) {
    throw new Error(
      `This script requires exactly one dropId argument so it can load scripts/newDrops/<dropId>.ts.\n` +
        `${newDropConfigUsage()}`,
    );
  }
  const requestedDropId = String(extraArgs[0] || '').trim().toLowerCase();
  if (!requestedDropId) {
    throw new Error(`Missing dropId.\n${newDropConfigUsage()}`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const frontendDeploymentCfgPath = path.join(root, 'src', 'config', 'deployment.ts');
  const functionsDeploymentCfgPath = path.join(root, 'functions', 'src', 'config', 'deployment.ts');
  const { config: newDropConfig, configPath } = await loadNewDropConfigById({
    root,
    dropId: requestedDropId,
  });
  setActiveNewDropConfigPath(root, configPath);
  const deployCfg = newDropConfig.deploy;
  const dropCfg = newDropConfig.onchain;
  const metadataPathFormat: MetadataPathFormat = 'compact';
  const dropId = normalizeDropId(requireNonEmptyString(dropCfg.dropId, 'NEW_DROP.onchain.dropId'));
  const dropFamily = requireDropFamily(dropCfg.dropFamily, 'NEW_DROP.onchain.dropFamily');
  const dropSeed = deriveDropSeed(dropId);
  await assertDropIdNotConfiguredInDeploymentFiles({
    dropId,
    frontendConfigPath: frontendDeploymentCfgPath,
    functionsConfigPath: functionsDeploymentCfgPath,
  });
  const dropMetadataBase = normalizeDropBase(requireNonEmptyString(dropCfg.metadataBase, 'NEW_DROP.onchain.metadataBase'));
  const collectionMetadata = prepareCollectionMetadata(dropCfg);
  const receiptsTreeConfig = prepareReceiptsTreeConfig(dropCfg);
  const coreCollectionRoyaltiesBps = requireRoyaltiesBps(dropCfg.coreCollectionRoyaltiesBps);
  if (collectionMetadata.sellerFeeBasisPoints !== coreCollectionRoyaltiesBps) {
    throw new Error(
      `Mismatch in ${getActiveNewDropConfigPath()} for collection royalties.\n` +
        `- NEW_DROP.onchain.collectionMetadata.sellerFeeBasisPoints: ${collectionMetadata.sellerFeeBasisPoints}\n` +
        `- NEW_DROP.onchain.coreCollectionRoyaltiesBps            : ${coreCollectionRoyaltiesBps}\n` +
        `\n` +
        `These values must match before deploying.`,
    );
  }
  const programKeypair = path.join(onchainDir, 'target', 'deploy', 'box_minter-keypair.json');
  const programBinary = path.join(onchainDir, 'target', 'deploy', 'box_minter.so');

  const cluster: SolanaCluster = deployCfg.solanaCluster;
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
  console.log('collection metadata url:', `${dropMetadataBase}/collection.json`);
  if (deployCfg.coreCollectionPubkey) console.log('core collection:', deployCfg.coreCollectionPubkey);
  if (solanaBinDir) console.log('solana bin:', solanaBinDir);
  console.log('');

  await assertCollectionMetadataJsonMatchesNewDrop({
    metadataBase: dropMetadataBase,
    expected: collectionMetadata,
  });
  console.log(`✅ collection.json preflight matches ${getActiveNewDropConfigPath()}`);

  // Fail fast if the target cluster/RPC does not have the Metaplex programs we depend on.
  const connection = new Connection(rpcUrlForApps, { commitment: 'confirmed' });
  await assertExternalProgramsDeployed(connection, cluster);

  console.log('Enter the deployer wallet private key (input is hidden).');
  console.log('Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).');
  const payer = parsePrivateKeyInput(await promptMaskedInput('deployer private key: '));
  console.log('deployer pubkey:', payer.publicKey.toBase58());

  const tempKeypairPath = writeTempKeypairFile(payer);
  registerTempKeypairCleanup(tempKeypairPath);
  const toolEnv = {
    ...(solanaBinDir ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` } : {}),
    // Keep anchor + solana cli aligned with the deployer wallet.
    ANCHOR_WALLET: tempKeypairPath,
  };

  const reuseProgramId = deployCfg.reuseProgramId;
  let expectedProgramId: string | undefined;
  let freshProgramKeypair: Keypair | null = null;
  if (reuseProgramId) {
    if (!existsSync(programKeypair)) {
      throw new Error(
        `Missing program keypair: ${programKeypair}\n` +
          `Either create it first, or set NEW_DROP.deploy.reuseProgramId=false in ${getActiveNewDropConfigPath()} to deploy a fresh shared program id.\n` +
          `Generate it with:\n` +
          `  solana-keygen new --no-bip39-passphrase -o ${programKeypair}\n`,
      );
    }
    console.log('Reusing existing program keypair:', programKeypair);
  } else {
    freshProgramKeypair = Keypair.generate();
    expectedProgramId = freshProgramKeypair.publicKey.toBase58();
  }

  // Safety preflight: validate target drop/admin and required NEW_DROP init fields before any build/deploy side effects.
  const preflightProgramId = reuseProgramId ? readProgramIdFromKeypair(programKeypair) : expectedProgramId!;
  const preflightProgramPk = new PublicKey(preflightProgramId);
  if (reuseProgramId) {
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
    throwFreshDeployOnlyForExistingConfig({
      stage: 'preflight',
      dropId,
      programId: preflightProgramId,
      configPda: preflightConfigPda,
      configData: preflightCfgInfo.data,
    });
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

  const hasSolanaCargo = canRunSolanaCargo();
  if (hasSolanaCargo) {
    console.log('solana cargo toolchain:', 'cargo +solana');
  } else {
    console.warn('⚠️  Missing rustup `solana` toolchain (`cargo +solana`). Anchor may fail if your Cargo.lock is too new.');
  }

  // 1) Build + deploy program via Anchor.
  removeStaleAnchorGeneratedArtifacts(onchainDir);
  run('anchor', ['keys', 'sync'], { cwd: onchainDir, env: toolEnv });
  const syncedProgramId = readProgramId(onchainDir);
  const requiredProgramId = reuseProgramId ? preflightProgramId : expectedProgramId;
  if (requiredProgramId && syncedProgramId !== requiredProgramId) {
    throw new Error(
      `Program id sync mismatch.\n` +
        `Expected: ${requiredProgramId}\n` +
        `Synced  : ${syncedProgramId}\n` +
        `\n` +
        `This usually means 'anchor keys sync' did not update the program source/Anchor.toml.\n` +
        `Try running it manually in ${onchainDir} and re-run this script.`,
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

  const programId = readProgramId(onchainDir);
  const canSkipRedeploy =
    reuseProgramId &&
    deployedProgramMatchesBinary({
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

  // 2) Deploy on-chain prerequisites + initialize config PDA.
  // ---------------------------------------------------------------------------
  const programPk = new PublicKey(programId);
  const configPda = boxMinterConfigPda(programPk, dropSeed);
  const existingCfg = await retryRpcRead(`getAccountInfo(post-deploy config ${configPda.toBase58()})`, () =>
    connection.getAccountInfo(configPda, { commitment: 'confirmed' }),
  );
  if (existingCfg) {
    throwFreshDeployOnlyForExistingConfig({
      stage: 'post-deploy',
      dropId,
      programId,
      configPda,
      configData: existingCfg.data,
    });
  }
  const requiredDropMetadataBase = initDropInputs.requiredDropMetadataBase;
  const discountMerkle = initDropInputs.discountMerkle;
  const discountMerkleJsonPath = path.join(root, 'src', 'drops', 'discountMerkles', `${dropId}.json`);
  writeDiscountMerkleJson({
    root: discountMerkle.root,
    proofs: discountMerkle.proofs,
    filePath: discountMerkleJsonPath,
  });

  const boxMinterConfig = {
    // Payment + mint caps
    // Payments: SOL from box mints + delivery fees go here.
    // Custody/vault: boxes and delivered assets still transfer to the deployer/admin key (config.admin).
    // Set to `undefined` to default payments to the deployer/admin key.
    treasury: dropCfg.treasury,
    priceSol: dropCfg.priceSol,
    discountPriceSol: dropCfg.discountPriceSol,
    stripeCheckoutEnabled: dropCfg.stripeCheckoutEnabled,
    stripeLiveUnitAmountCents: dropCfg.stripeLiveUnitAmountCents,
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
    symbol: dropCfg.symbol,
    // Canonical drop base. The on-chain program derives:
    // - boxes   : `${metadataBase}/b{id}.json`
    // - figures : `${metadataBase}/f{id}.json`
    // - receipts: `${metadataBase}/rb{id}.json` and `${metadataBase}/rf{id}.json`
    // Existing legacy drops stay on their current shared-program lineage.
    metadataBase: requiredDropMetadataBase,
    mintSelection: prepareMintSelectionConfig(dropCfg),
  };

  // Payment treasury (defaults to deployer/admin key if unset).
  const treasury = new PublicKey(boxMinterConfig.treasury || payer.publicKey.toBase58());
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
  const coreCollection = deployCfg.coreCollectionPubkey ? new PublicKey(deployCfg.coreCollectionPubkey) : undefined;
  const collectionUpdateAuthority = payer.publicKey;
  const requiredCollectionUpdateDelegates = uniquePubkeys([configPda, payer.publicKey]);

  const coreCollectionConfig = {
    name: collectionMetadata.name,
    uri: `${requiredDropMetadataBase}/collection.json`,
  };

  let resolvedCoreCollection: PublicKey;
  if (coreCollection) {
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
      royaltiesRecipient: treasury,
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

  // If we are using a pre-existing collection (NEW_DROP.deploy.coreCollectionPubkey), enforce royalties here.
  // For freshly created collections, royalties are already set in `create_collection_v2`.
  if (coreCollection) {
    await ensureMplCoreCollectionRoyalties({
      connection,
      payer,
      collection: resolvedCoreCollection,
      treasury,
      royaltiesBps: coreCollectionRoyaltiesBps,
    });
  }
  if (!coreCollection) {
    // Read-only check: newly-created collections should already contain the expected royalties plugin.
    await assertMplCoreCollectionRoyalties({
      connection,
      coreCollection: resolvedCoreCollection,
      treasury,
      royaltiesBps: coreCollectionRoyaltiesBps,
    });
  }

  console.log('\n[3/3] Initializing box minter…');

  const initIx = buildInitializeIx({
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
  });

  const setupTx = new Transaction().add(initIx);
  setupTx.feePayer = payer.publicKey;
  setupTx.recentBlockhash = (await retryRpcRead('getLatestBlockhash(initialize box minter)', () => connection.getLatestBlockhash('confirmed'))).blockhash;
  const setupSig = await sendAndConfirmTx({ connection, tx: setupTx, signers: [payer], label: 'initialize box minter', commitment: 'confirmed' });
  console.log('✅ Box minter configured:', setupSig);
  console.log('  Config PDA:', configPda.toBase58());
  console.log('  Payment treasury:', treasury.toBase58());
  console.log('  Price (lamports):', priceLamports.toString());
  console.log('  Discount price (lamports):', discountPriceLamports.toString());
  console.log('  Discount mints per wallet:', boxMinterConfig.discountMintsPerWallet);
  console.log('');

  let receiptsTree: PublicKey;
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
    console.warn('⚠️  Failed to create/reuse delivery ALT:', errorMessage(err));
  }

  const receiptsTreeStr = receiptsTree.toBase58();
  // For fresh deployments, never reuse a previous drop's LUT: use the newly created LUT or leave empty.
  const deliveryLutStr = deliveryLut?.toBase58() || '';

  const frontendCfgPath = await writeFrontendDeploymentConfig({
    root,
    solanaCluster: cluster,
    dropId,
    dropFamily,
    collectionName: collectionMetadata.name,
    metadataBase: requiredDropMetadataBase,
    metadataPathFormat,
    mintSelection: boxMinterConfig.mintSelection,
    treasury: treasury.toBase58(),
    priceSol: Number(boxMinterConfig.priceSol),
    discountPriceSol: Number(boxMinterConfig.discountPriceSol),
    stripeCheckoutEnabled: boxMinterConfig.stripeCheckoutEnabled,
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
  });
  const functionsCfgWrittenPath = await writeFunctionsDeploymentConfig({
    root,
    solanaCluster: cluster,
    dropId,
    dropFamily,
    collectionName: collectionMetadata.name,
    metadataBase: requiredDropMetadataBase,
    metadataPathFormat,
    mintSelection: boxMinterConfig.mintSelection,
    treasury: treasury.toBase58(),
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
    deliveryLookupTable: deliveryLutStr,
  });

  console.log('');
  console.log('--- updated tracked config ---');
  console.log(`- ${path.relative(root, frontendCfgPath)}`);
  console.log(`- ${path.relative(root, functionsCfgWrittenPath)}`);
  console.log('');

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
