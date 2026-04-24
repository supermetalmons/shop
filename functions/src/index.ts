import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { onCall, type CallableOptions, type CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import nacl from 'tweetnacl';
import { createHash, randomInt } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { fileURLToPath } from 'url';
// IMPORTANT (Node ESM): include `.js` extension so the compiled `lib/` output resolves at runtime.
import { FUNCTIONS_DROPS, normalizeDropBase, type DropFamily, type FunctionsDropConfig } from './config/deployment.js';
import {
  boxIdFromMetadataUri,
  canonicalMetadataBase,
  dudeIdFromMetadataUri,
  metadataBaseFromMetadataUri,
  metadataKindFromUri,
  selectMetadataUri,
} from './dropMetadataUri.js';

// Firebase/Google Secret Manager secrets (Cloud Functions v2).
// Configure via: `firebase functions:secrets:set COSIGNER_SECRET`
const COSIGNER_SECRET = defineSecret('COSIGNER_SECRET');
// Base64-encoded Curve25519 secret key for decrypting delivery addresses (TweetNaCl box).
const ADDRESS_DECRYPTION_SECRET = defineSecret('ADDRESS_DECRYPTION_SECRET');

function loadLocalEnv() {
  const envPaths = [
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../.env.local', import.meta.url)),
  ];

  // Prefer Node's built-in loader when available.
  const loadEnvFile = (process as any).loadEnvFile as ((path: string) => void) | undefined;

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    try {
      if (typeof loadEnvFile === 'function') {
        loadEnvFile(envPath);
        continue;
      }
    } catch {
      // Fall back to the minimal parser below.
    }

    try {
      const content = readFileSync(envPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
        const eq = withoutExport.indexOf('=');
        if (eq <= 0) continue;
        const key = withoutExport.slice(0, eq).trim();
        let value = withoutExport.slice(eq + 1).trim();
        if (!key) continue;
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch {
      // Ignore env loading failures; missing vars will be caught by runtime checks.
    }
  }
}

loadLocalEnv();

const app = getApps()[0] || initializeApp();
const db = getFirestore(app);

type CallableReq<T = any> = CallableRequest<T>;

function uidFromRequest(request: CallableReq<any>): string | null {
  return request.auth?.uid || null;
}

function requireAuth(request: CallableReq<any>): string {
  const uid = uidFromRequest(request);
  if (!request.auth || !uid) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  return uid;
}

const WALLET_SESSION_COLLECTION = 'authSessions';
const WALLET_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ITEMS_PER_BOX = 0;
const MIN_OPENABLE_ITEMS_PER_BOX = 1;
const MAX_ITEMS_PER_BOX = 5;
const MIN_DISCOUNT_MINTS_PER_WALLET = 1;
const MAX_DISCOUNT_MINTS_PER_WALLET = 3;
// Hardcoded (no env / no deployment config) to avoid config sprawl.
const RPC_TIMEOUT_MS = 8_000;
// Issue-receipts tx retry/confirm tuning.
// Hardcoded (no env) to keep deployments deterministic and avoid config sprawl.
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
const TX_MAX_SEND_ATTEMPTS = 3;
const FULFILLMENT_ORDER_LIMIT = 1000;

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type DropRuntime = {
  dropId: string;
  config: FunctionsDropConfig;
  canonicalMetadataBase: string;
  cluster: SolanaCluster;
  heliusRpcBase: string;
  connectionRpcUrl: string;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  collectionMintStr: string;
  receiptsMerkleTree: PublicKey;
  receiptsMerkleTreeStr: string;
  deliveryLookupTable: PublicKey;
  deliveryLookupTableStr: string;
  itemsPerBox: number;
  discountMintsPerWallet: number;
  maxSupply: number;
  maxDudeId: number;
};

function isDirectDeliveryItemsPerBox(itemsPerBox: number): boolean {
  return Math.floor(Number(itemsPerBox)) === 0;
}

function normalizeDeliveryUnitsPerBox(itemsPerBox: number): number {
  return isDirectDeliveryItemsPerBox(itemsPerBox) ? 1 : Math.max(MIN_OPENABLE_ITEMS_PER_BOX, Math.floor(Number(itemsPerBox)));
}

function isOpenableDrop(dropRuntime: Pick<DropRuntime, 'itemsPerBox'>): boolean {
  return dropRuntime.itemsPerBox >= MIN_OPENABLE_ITEMS_PER_BOX;
}

function assertOpenableDrop(dropRuntime: Pick<DropRuntime, 'itemsPerBox'>, message: string): void {
  if (!isOpenableDrop(dropRuntime)) {
    throw new HttpsError('failed-precondition', message);
  }
}

function normalizeDropId(dropId: string): string {
  const value = String(dropId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'Invalid dropId');
  }
  return value;
}

function heliusRpcBaseForCluster(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';
}

function requireConfiguredPubkey(label: string, value: string | undefined): PublicKey {
  const v = (value || '').trim();
  if (!v) return PublicKey.default;
  try {
    return new PublicKey(v);
  } catch (err) {
    throw new Error(`${label} is invalid in functions/src/config/deployment.ts: ${String(err)}`);
  }
}

function buildDropRuntime(config: FunctionsDropConfig): DropRuntime {
  const dropId = normalizeDropId(config.dropId);
  const cluster = config.solanaCluster as SolanaCluster;
  if (cluster !== 'devnet' && cluster !== 'testnet' && cluster !== 'mainnet-beta') {
    throw new Error(`solanaCluster is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.solanaCluster}`);
  }
  const itemsPerBox = Number(config.itemsPerBox);
  if (!Number.isInteger(itemsPerBox) || itemsPerBox < MIN_ITEMS_PER_BOX || itemsPerBox > MAX_ITEMS_PER_BOX) {
    throw new Error(
      `itemsPerBox is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.itemsPerBox} (expected integer ${MIN_ITEMS_PER_BOX}..${MAX_ITEMS_PER_BOX})`,
    );
  }
  const maxSupply = Number(config.maxSupply);
  if (!Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff) {
    throw new Error(`maxSupply is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.maxSupply}`);
  }
  const discountMintsPerWallet = Number(config.discountMintsPerWallet);
  if (
    !Number.isInteger(discountMintsPerWallet) ||
    discountMintsPerWallet < MIN_DISCOUNT_MINTS_PER_WALLET ||
    discountMintsPerWallet > MAX_DISCOUNT_MINTS_PER_WALLET
  ) {
    throw new Error(
      `discountMintsPerWallet is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.discountMintsPerWallet} (expected integer ${MIN_DISCOUNT_MINTS_PER_WALLET}..${MAX_DISCOUNT_MINTS_PER_WALLET})`,
    );
  }
  const maxDudeId = maxSupply * itemsPerBox;
  if (!Number.isFinite(maxDudeId) || maxDudeId > 0xffff) {
    throw new Error(
      `Configured max figure id is invalid in functions/src/config/deployment.ts for drop ${dropId}: maxSupply=${maxSupply}, itemsPerBox=${itemsPerBox}`,
    );
  }
  const boxMinterProgramId = requireConfiguredPubkey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId);
  const configuredBoxMinterConfigPda = String(config.boxMinterConfigPda || '').trim();
  const boxMinterConfigPda = configuredBoxMinterConfigPda
    ? requireConfiguredPubkey('BOX_MINTER_CONFIG_PDA', configuredBoxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from('config')], boxMinterProgramId)[0];
  const collectionMint = requireConfiguredPubkey('COLLECTION_MINT', config.collectionMint);
  const receiptsMerkleTree = requireConfiguredPubkey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree);
  const deliveryLookupTable = requireConfiguredPubkey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable);
  const heliusRpcBase = heliusRpcBaseForCluster(cluster);
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  const connectionRpcUrl = apiKey ? `${heliusRpcBase}/?api-key=${apiKey}` : '';
  return {
    dropId,
    config,
    canonicalMetadataBase: canonicalMetadataBase(config.metadataBase),
    cluster,
    heliusRpcBase,
    connectionRpcUrl,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint,
    collectionMintStr: collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58(),
    receiptsMerkleTree,
    receiptsMerkleTreeStr: receiptsMerkleTree.equals(PublicKey.default) ? '' : receiptsMerkleTree.toBase58(),
    deliveryLookupTable,
    deliveryLookupTableStr: deliveryLookupTable.equals(PublicKey.default) ? '' : deliveryLookupTable.toBase58(),
    itemsPerBox,
    discountMintsPerWallet,
    maxSupply,
    maxDudeId,
  };
}

const DROP_RUNTIMES: Record<string, DropRuntime> = {};
Object.entries(FUNCTIONS_DROPS).forEach(([dropIdKey, dropConfig]) => {
  const runtime = buildDropRuntime(dropConfig);
  DROP_RUNTIMES[normalizeDropId(dropIdKey)] = runtime;
});
if (!Object.keys(DROP_RUNTIMES).length) {
  throw new Error('functions/src/config/deployment.ts has no configured drops');
}
const DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION = new Map<string, number>();
const DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE = new Map<string, number>();
const DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION = new Map<string, number>();
Object.values(DROP_RUNTIMES).forEach((runtime) => {
  const clusterCollectionKey = dropRuntimeClusterCollectionKey(runtime);
  DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.set(
    clusterCollectionKey,
    (DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.get(clusterCollectionKey) || 0) + 1,
  );
  const scopeKey = revealScopeKey(runtime);
  DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE.set(scopeKey, (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE.get(scopeKey) || 0) + 1);
  const collectionScopeKey = revealScopeCollectionKey(runtime);
  DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION.set(
    collectionScopeKey,
    (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION.get(collectionScopeKey) || 0) + 1,
  );
});

function getDropRuntime(dropId: string): DropRuntime {
  const normalizedDropId = normalizeDropId(dropId);
  const runtime = DROP_RUNTIMES[normalizedDropId];
  if (!runtime) {
    throw new HttpsError('invalid-argument', `Unsupported dropId: ${normalizedDropId}`);
  }
  return runtime;
}

function normalizeConfiguredUriBaseForComparison(uriBase: string): string {
  const normalized = normalizeDropBase(uriBase);
  // Legacy singleton configs stored `${dropBase}/json/boxes/` instead of the canonical drop base.
  // Keep accepting that older shape so untouched singleton drops continue to work.
  return normalized.replace(/\/json\/boxes$/i, '');
}

function requiresRevealAssetDisambiguation(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox'>,
): boolean {
  const scopeKey = revealScopeKey(dropRuntime);
  return (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE.get(scopeKey) || 0) > 1;
}

function revealScopeKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox'>,
): string {
  return `${dropRuntime.cluster}:${dropRuntime.boxMinterProgramId.toBase58()}:${dropRuntime.itemsPerBox}`;
}

function dropRuntimeClusterCollectionKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'collectionMintStr'>,
): string {
  return `${dropRuntime.cluster}:${dropRuntime.collectionMintStr}`;
}

function revealScopeCollectionKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox' | 'collectionMintStr'>,
): string {
  return `${revealScopeKey(dropRuntime)}:${dropRuntime.collectionMintStr}`;
}

function clusterSharesCollectionMint(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'collectionMintStr'>,
): boolean {
  if (!dropRuntime.collectionMintStr) return false;
  return (DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.get(dropRuntimeClusterCollectionKey(dropRuntime)) || 0) > 1;
}

function revealScopeSharesCollectionMint(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox' | 'collectionMintStr'>,
): boolean {
  if (!dropRuntime.collectionMintStr) return false;
  return (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION.get(revealScopeCollectionKey(dropRuntime)) || 0) > 1;
}

function requireDropId(rawDropId: unknown): string {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) {
    throw new HttpsError('invalid-argument', 'dropId is required');
  }
  const dropId = normalizeDropId(rawDropId);
  if (!DROP_RUNTIMES[dropId]) throw new HttpsError('invalid-argument', `Unsupported dropId: ${dropId}`);
  return dropId;
}

function dropRootPath(dropId: string): string {
  return `drops/${dropId}`;
}

function dropBoxAssignmentPath(dropId: string, boxAssetId: string): string {
  return `${dropRootPath(dropId)}/boxAssignments/${boxAssetId}`;
}

function dropDudeAssignmentPath(dropId: string, dudeId: number): string {
  return `${dropRootPath(dropId)}/dudeAssignments/${dudeId}`;
}

function dropDudePoolPath(dropId: string): string {
  return `${dropRootPath(dropId)}/meta/dudePool`;
}

function dropDeliveryOrdersCollectionPath(dropId: string): string {
  return `${dropRootPath(dropId)}/deliveryOrders`;
}

function dropDeliveryOrderPath(dropId: string, deliveryId: number): string {
  return `${dropDeliveryOrdersCollectionPath(dropId)}/${deliveryId}`;
}

function normalizeWallet(wallet: string): string {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid wallet address');
  }
}

async function requireWalletSession(request: CallableReq<any>): Promise<{ uid: string; wallet: string }> {
  const uid = requireAuth(request);
  const snap = await db.doc(`${WALLET_SESSION_COLLECTION}/${uid}`).get();
  const data = snap.exists ? (snap.data() as any) : null;
  const wallet = typeof data?.wallet === 'string' ? data.wallet : null;

  // Backwards compatibility: if the caller is already authenticated as the wallet UID.
  if (!wallet) {
    try {
      return { uid, wallet: normalizeWallet(uid) };
    } catch {
      throw new HttpsError('unauthenticated', 'Sign in with your wallet first.');
    }
  }

  const expiresAt = data?.expiresAt;
  if (expiresAt && typeof expiresAt.toMillis === 'function' && expiresAt.toMillis() < Date.now()) {
    throw new HttpsError('unauthenticated', 'Wallet session expired. Sign in again.');
  }

  return { uid, wallet: normalizeWallet(wallet) };
}

const SHIPPER_DROP_IDS_BY_WALLET = new Map<string, Set<string>>();
[
  {
    wallet: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    dropIds: ['little_swag_boxes', 'poncho_drifella'],
  },
  {
    wallet: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    dropIds: ['poncho_drifella'],
  },
  {
    wallet: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    dropIds: ['little_swag_boxes', 'poncho_drifella'],
  },
].forEach(({ wallet: rawWallet, dropIds: rawDropIds }) => {
  try {
    const wallet = new PublicKey(rawWallet).toBase58();
    const normalizedDropIds = SHIPPER_DROP_IDS_BY_WALLET.get(wallet) || new Set<string>();
    rawDropIds.forEach((rawDropId) => {
      const dropId = normalizeDropId(rawDropId);
      if (!DROP_RUNTIMES[dropId]) {
        throw new Error(`Unsupported shipper dropId: ${dropId}`);
      }
      normalizedDropIds.add(dropId);
    });
    SHIPPER_DROP_IDS_BY_WALLET.set(wallet, normalizedDropIds);
  } catch (err) {
    console.error('[mons/functions] invalid shipper fulfillment access config', { rawWallet, rawDropIds, error: summarizeError(err) });
  }
});

const ADMIN_WALLETS = new Set<string>();
[
  'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
].forEach((raw) => {
  try {
    ADMIN_WALLETS.add(new PublicKey(raw).toBase58());
  } catch (err) {
    console.error('[mons/functions] invalid admin wallet', raw, summarizeError(err));
  }
});

function hasFulfillmentDropAccess(wallet: string, dropId: string): boolean {
  if (ADMIN_WALLETS.has(wallet)) return true;
  return Boolean(SHIPPER_DROP_IDS_BY_WALLET.get(wallet)?.has(dropId));
}

function canViewSensitiveFulfillmentAddress(wallet: string, dropId: string): boolean {
  return !ADMIN_WALLETS.has(wallet) && hasFulfillmentDropAccess(wallet, dropId);
}

async function requireFulfillmentDropAccess(request: CallableReq<any>, dropId: string): Promise<{ uid: string; wallet: string }> {
  const { uid, wallet } = await requireWalletSession(request);
  if (!hasFulfillmentDropAccess(wallet, dropId)) {
    throw new HttpsError('permission-denied', 'Fulfillment access denied.');
  }
  return { uid, wallet };
}

async function requireAdminAccess(request: CallableReq<any>): Promise<{ uid: string; wallet: string }> {
  const { uid, wallet } = await requireWalletSession(request);
  if (!ADMIN_WALLETS.has(wallet)) {
    throw new HttpsError('permission-denied', 'Admin access denied.');
  }
  return { uid, wallet };
}

// MPL Core program id (uncompressed Core assets).
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
// Solana SPL Noop program (commonly used as Metaplex "log wrapper").
const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
// Metaplex Noop program (used by Bubblegum v2).
const MPL_NOOP_PROGRAM_ID = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
// MPL Account Compression program (used by Bubblegum v2).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
// Bubblegum program (compressed NFTs).
const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
// Bubblegum -> MPL-Core CPI signer (used when minting cNFTs to an MPL-Core collection).
const MPL_CORE_CPI_SIGNER = new PublicKey('CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk');

// Anchor discriminator = sha256("global:finalize_open_box")[0..8]
const IX_FINALIZE_OPEN_BOX = Buffer.from('cf5e6dfd1544ed16', 'hex');
// Anchor discriminator = sha256("account:PendingOpenBox")[0..8]
const ACCOUNT_PENDING_OPEN_BOX = Buffer.from('4507451af00c43a1', 'hex');
// Anchor discriminator = sha256("account:DeliveryRecord")[0..8]
const ACCOUNT_DELIVERY_RECORD = Buffer.from('2b0f869afad50393', 'hex');
// Anchor discriminator = sha256("global:deliver")[0..8]
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
// Anchor discriminator = sha256("global:close_delivery")[0..8]
const IX_CLOSE_DELIVERY = Buffer.from('ae641ab98ea5f208', 'hex');
// Anchor discriminator = sha256("global:mint_receipts")[0..8]
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');

// Bubblegum v2 burn discriminator (kinobi generated).
const IX_BURN_V2 = Buffer.from([115, 210, 34, 240, 232, 143, 183, 16]);

const INTL_DELIVERY_BASE_LAMPORTS = 250_000_000;
const INTL_DELIVERY_EXTRA_LAMPORTS = 50_000_000;
const LITTLE_SWAG_BOXES_US_BASE_LAMPORTS = 100_000_000;
const LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS = 25_000_000;
const PONCHO_DRIFELLA_US_FLAT_LAMPORTS = 50_000_000;
const LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS = 600_000_000;
const LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS = 500_000_000;
const MAX_DELIVERY_ITEMS = 32;
const DELIVERY_RECOVERY_LEASE_MS = 90_000;
const DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS = 30_000;
const MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL = 2;
const DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS = [30_000, 2 * 60 * 1000, 10 * 60 * 1000] as const;
const MAX_PREPARED_DELIVERY_RECOVERY_CHECKS = DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length;
const MAX_CONFIGURED_ITEMS_PER_BOX = Math.max(
  1,
  ...Object.values(DROP_RUNTIMES).map((runtime) => normalizeDeliveryUnitsPerBox(runtime.itemsPerBox)),
);
const MAX_DELIVERY_FIGURES = MAX_DELIVERY_ITEMS * MAX_CONFIGURED_ITEMS_PER_BOX;
const MIN_DELIVERY_LAMPORTS = 0;
const MAX_GENERIC_DELIVERY_LAMPORTS =
  INTL_DELIVERY_BASE_LAMPORTS +
  Math.max(0, MAX_DELIVERY_FIGURES - MAX_CONFIGURED_ITEMS_PER_BOX) * INTL_DELIVERY_EXTRA_LAMPORTS;
const MAX_HOODIE_DELIVERY_LAMPORTS =
  LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS +
  Math.max(0, MAX_DELIVERY_ITEMS - 1) * LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS;
const MAX_DELIVERY_LAMPORTS = Math.max(MAX_GENERIC_DELIVERY_LAMPORTS, MAX_HOODIE_DELIVERY_LAMPORTS);

// Optional: Address Lookup Table to shrink delivery tx size (allows more items per tx).
// Should contain: config PDA, treasury, core collection, MPL core program id, system program id, SPL noop program id.
const DELIVERY_LUT_CACHE_TTL_MS = 10 * 60 * 1000;
const cachedDeliveryLutByDrop = new Map<string, { lut: AddressLookupTableAccount; cachedAtMs: number }>();

function assertConfiguredProgramId(key: PublicKey, label: string) {
  if (key.equals(PublicKey.default)) {
    throw new HttpsError('failed-precondition', `${label} is not configured (see functions/src/config/deployment.ts)`);
  }
}

function decodeSecretKey(secret: string | undefined, label: string) {
  const value = (secret || '').trim();
  if (!value) throw new Error(`${label} is not set`);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch (err) {
    throw new Error(`${label} must be valid base58: ${String(err)}`);
  }
  if (decoded.length !== 64) throw new Error(`${label} must decode to 64 bytes (got ${decoded.length})`);
  return decoded;
}

function decodeBase64Secret(secret: string | undefined, label: string, expectedBytes: number): Uint8Array {
  const value = (secret || '').trim();
  if (!value) throw new Error(`${label} is not set`);
  let decoded: Uint8Array;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch (err) {
    throw new Error(`${label} must be valid base64: ${String(err)}`);
  }
  if (decoded.length !== expectedBytes) {
    throw new Error(`${label} must decode to ${expectedBytes} bytes (got ${decoded.length})`);
  }
  return decoded;
}

let cachedCosigner: Keypair | null = null;
function cosigner() {
  if (!cachedCosigner) {
    cachedCosigner = Keypair.fromSecretKey(decodeSecretKey(COSIGNER_SECRET.value(), 'COSIGNER_SECRET'));
  }
  return cachedCosigner;
}

let cachedAddressDecryptKey: Uint8Array | null = null;
let cachedAddressDecryptKeyState: 'unset' | 'ready' | 'missing' = 'unset';
function addressDecryptKeyMaybe(): Uint8Array | null {
  if (cachedAddressDecryptKeyState === 'ready') return cachedAddressDecryptKey;
  if (cachedAddressDecryptKeyState === 'missing') return null;
  try {
    cachedAddressDecryptKey = decodeBase64Secret(
      ADDRESS_DECRYPTION_SECRET.value(),
      'ADDRESS_DECRYPTION_SECRET',
      nacl.box.secretKeyLength,
    );
    cachedAddressDecryptKeyState = 'ready';
    return cachedAddressDecryptKey;
  } catch (err) {
    cachedAddressDecryptKeyState = 'missing';
    console.warn('[mons/functions] ADDRESS_DECRYPTION_SECRET unavailable; returning encrypted addresses', summarizeError(err));
    return null;
  }
}

function decodeAddressCipherPart(part: string): Uint8Array | null {
  if (!part) return null;
  try {
    return Buffer.from(part, 'base64');
  } catch {
    return null;
  }
}

function decryptAddressPayload(payload: string): string | null {
  try {
    const raw = (payload || '').trim();
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [nonceRaw, pubRaw, cipherRaw] = parts;
    const nonce = decodeAddressCipherPart(nonceRaw);
    const pubkey = decodeAddressCipherPart(pubRaw);
    const cipher = decodeAddressCipherPart(cipherRaw);
    if (!nonce || !pubkey || !cipher) return null;
    if (nonce.length !== nacl.box.nonceLength || pubkey.length !== nacl.box.publicKeyLength) return null;
    const secret = addressDecryptKeyMaybe();
    if (!secret) return null;
    const opened = nacl.box.open(cipher, nonce, pubkey, secret);
    if (!opened) return null;
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

function ensureAuthorityKeys() {
  // Prepared transactions require a server-side cosigner signature.
  cosigner();
}

function parseRequest<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    throw new HttpsError('invalid-argument', details || 'Invalid request payload');
  }
  return parsed.data;
}

type ParsedSolanaSignInMessage = {
  wallet: string;
  domain: string;
  timestamp: string;
  session: string;
};

function parseSolanaSignInMessage(message: string): ParsedSolanaSignInMessage {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (!raw) throw new HttpsError('invalid-argument', 'Missing sign-in message');
  if (raw.length > 1024) throw new HttpsError('invalid-argument', 'Sign-in message too long');

  const lines = raw
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length);

  const header = lines[0] || '';
  const prefix = 'Sign in to mons.shop as ';
  if (!header.startsWith(prefix)) {
    throw new HttpsError('invalid-argument', 'Invalid sign-in message (bad header)');
  }
  const wallet = header.slice(prefix.length).trim();
  if (!wallet) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing wallet)');

  const kv: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (!(key in kv)) kv[key] = value;
  }

  const domain = kv.Domain || '';
  const timestamp = kv.Timestamp || '';
  const session = kv.Session || '';

  if (!domain) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing Domain)');
  if (!timestamp) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing Timestamp)');
  if (!session) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing Session)');

  return { wallet, domain, timestamp, session };
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateForLog(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeUrlOriginForLog(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  try {
    return new URL(s).origin;
  } catch {
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }
}

function hashForLog(value: string): string {
  const salt = process.env.LOG_HASH_SALT || '';
  return createHash('sha256').update(`${salt}${value}`).digest('hex').slice(0, 16);
}

function isExpectedHttpsErrorCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  return [
    'invalid-argument',
    'failed-precondition',
    'permission-denied',
    'unauthenticated',
    'not-found',
    'already-exists',
    'out-of-range',
    // Often thrown when the user/request rate is too high; still typically user-actionable.
    'resource-exhausted',
  ].includes(code);
}

function isGrpcAlreadyExists(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 6 || code === '6' || code === 'ALREADY_EXISTS';
}

function isGrpcAborted(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 10 || code === '10' || code === 'ABORTED';
}

function isGrpcDeadlineExceeded(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 4 || code === '4' || code === 'DEADLINE_EXCEEDED';
}

function isGrpcUnavailable(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 14 || code === '14' || code === 'UNAVAILABLE';
}

function isGrpcResourceExhausted(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 8 || code === '8' || code === 'RESOURCE_EXHAUSTED';
}

function summarizeValue(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

function summarizePayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return { type: summarizeValue(payload) };
  const obj = payload as Record<string, unknown>;
  const allKeys = Object.keys(obj);
  const keys = allKeys.slice(0, 30);
  const types: Record<string, string> = {};
  keys.forEach((k) => {
    types[k] = summarizeValue(obj[k]);
  });
  return { keys, types, truncated: allKeys.length > keys.length };
}

function callableMeta(request: CallableReq<any>) {
  const raw = (request as any).rawRequest as any;
  const headers = raw?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : raw?.ip;
  const origin = truncateForLog(headers.origin, 200);
  const refererOrigin = safeUrlOriginForLog(headers.referer, 200);
  const userAgent = truncateForLog(headers['user-agent'], 256);
  const trace = truncateForLog(headers['x-cloud-trace-context'], 200);
  return {
    uid: request.auth?.uid || null,
    origin,
    referer: refererOrigin,
    userAgent,
    // Hash IP instead of logging raw IP to reduce sensitivity of logs.
    ipHash: ip ? hashForLog(String(ip)) : null,
    trace,
  };
}

function summarizeError(err: unknown) {
  const anyErr = err as any;
  const isHttpsError = anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string' && anyErr.code !== 'UNKNOWN';
  if (isHttpsError) {
    return {
      kind: 'HttpsError',
      code: anyErr.code,
      message: anyErr.message,
      details: anyErr.details,
    };
  }
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack.slice(0, 4000) : undefined;
    return { kind: err.name, message: err.message, ...(stack ? { stack } : {}) };
  }
  return { kind: typeof err, message: String(err) };
}

function onCallLogged<TReq, TRes>(
  name: string,
  handler: (request: CallableReq<TReq>) => Promise<TRes>,
  options: CallableOptions = {},
) {
  return onCall(options, async (request: CallableReq<TReq>) => {
    const startedAt = Date.now();
    const debug = (request as any)?.data?.__debug as any;
    const debugCallId = typeof debug?.callId === 'string' ? debug.callId : null;
    const baseMeta = { ...callableMeta(request), debugCallId };
    try {
      logger.info(`${name}:call`, { ...baseMeta, data: summarizePayload((request as any).data) });
    } catch (logErr) {
      // Never fail the function because structured logging couldn't serialize something.
      console.error(`${name}:call logger failed`, { logError: summarizeError(logErr), meta: baseMeta });
    }
    try {
      const result = await handler(request);
      const ms = Date.now() - startedAt;
      try {
        logger.info(`${name}:ok`, { ...baseMeta, ms });
      } catch (logErr) {
        console.error(`${name}:ok logger failed`, { logError: summarizeError(logErr), meta: baseMeta, ms });
      }
      return result;
    } catch (err) {
      const ms = Date.now() - startedAt;
      try {
        const code = (err as any)?.code;
        const summary = summarizeError(err);
        if (isExpectedHttpsErrorCode(code)) {
          // Expected/user-actionable errors: avoid logging stacks and keep severity lower.
          logger.warn(`${name}:rejected`, { ...baseMeta, ms, error: summary });
        } else {
          const errorForLog = err instanceof Error ? err : new Error(String(err));
          logger.error(`${name}:error`, errorForLog, { ...baseMeta, ms, error: summary });
        }
      } catch (logErr) {
        console.error(`${name}:error logger failed`, {
          logError: summarizeError(logErr),
          meta: baseMeta,
          ms,
          error: summarizeError(err),
        });
      }
      throw err;
    }
  });
}

function onCallAuthed<TReq, TRes>(
  name: string,
  handler: (request: CallableReq<TReq>, uid: string) => Promise<TRes>,
  options: CallableOptions = {},
) {
  return onCallLogged<TReq, TRes>(name, async (request: CallableReq<TReq>) => {
    const uid = requireAuth(request);
    return handler(request, uid);
  }, options);
}

function heliusRpcEndpoint(runtime: DropRuntime) {
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing HELIUS_API_KEY');
  return `${runtime.heliusRpcBase}/?api-key=${apiKey}`;
}

function connection(runtime: DropRuntime) {
  const endpoint = runtime.connectionRpcUrl || heliusRpcEndpoint(runtime);
  return new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function txErrMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function txErrLogs(err: unknown): string[] {
  const logs = (err as any)?.logs;
  return Array.isArray(logs) ? logs.map((l) => String(l)) : [];
}

function looksLikeComputeLimitError(message: string, logs: string[]) {
  const haystack = `${message}\n${logs.join('\n')}`.toLowerCase();
  return (
    haystack.includes('computational budget exceeded') ||
    haystack.includes('exceeded maximum compute') ||
    haystack.includes('program failed to complete') ||
    haystack.includes('compute units') && haystack.includes('consumed') && haystack.includes('failed')
  );
}

function looksLikeAccountInUseError(message: string, logs: string[]) {
  const haystack = `${message}\n${logs.join('\n')}`.toLowerCase();
  return haystack.includes('account in use') || haystack.includes('already in use');
}

function looksLikeBlockhashError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes('blockhash not found') ||
    m.includes('blockhash expired') ||
    m.includes('transaction expired') ||
    m.includes('block height exceeded') ||
    m.includes('transactionexpiredblockheightexceedederror')
  );
}

function looksLikeRateLimitOrRpcError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('fetch failed') ||
    m.includes('socket hang up') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('service unavailable') ||
    m.includes('gateway timeout') ||
    m.includes('rpc') && m.includes('error')
  );
}

async function waitForSignature(
  conn: Connection,
  signature: string,
  opts: { timeoutMs: number; pollMs: number },
): Promise<{ ok: true } | { ok: false; err: any; logs?: string[]; tx?: any }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < opts.timeoutMs) {
    try {
      // Only hit full history lookups after we've waited a bit; it's slower and usually unnecessary.
      const searchHistory = Date.now() - startedAt > 6_000;
      const res = await withTimeout(
        conn.getSignatureStatuses([signature], { searchTransactionHistory: searchHistory }),
        RPC_TIMEOUT_MS,
        'getSignatureStatuses',
      );
      const st = res?.value?.[0] || null;
      if (st?.err) {
        // Best-effort fetch logs for debugging/classification.
        let tx: any = null;
        try {
          tx = await withTimeout(
            conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
            RPC_TIMEOUT_MS,
            'getTransaction:failedTx',
          );
        } catch {
          // ignore
        }
        const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
        return { ok: false, err: st.err, logs, tx };
      }
      const status = st?.confirmationStatus;
      if (status === 'confirmed' || status === 'finalized') return { ok: true };
    } catch {
      // ignore transient polling failures
    }

    await sleep(opts.pollMs);
  }

  // Timeout: try one last fetch to see if it landed.
  try {
    const tx = await withTimeout(conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }), RPC_TIMEOUT_MS, 'getTransaction:timeoutTx');
    if (tx?.meta && !tx.meta.err) return { ok: true };
    const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
    return { ok: false, err: tx?.meta?.err || 'timeout', logs, tx };
  } catch {
    return { ok: false, err: 'timeout' };
  }
}

async function sendAndConfirmSignedTx(
  conn: Connection,
  tx: VersionedTransaction,
  label: string,
  opts: { sendTimeoutMs?: number; confirmTimeoutMs?: number } = {},
): Promise<string> {
  const sig = bs58.encode(tx.signatures[0]);
  const sendTimeoutMs = opts.sendTimeoutMs ?? TX_SEND_TIMEOUT_MS;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? TX_CONFIRM_TIMEOUT_MS;

  let sendErr: unknown = null;
  try {
    await withTimeout(conn.sendTransaction(tx, { maxRetries: 2 }), sendTimeoutMs, `sendTransaction:${label}`);
  } catch (err) {
    sendErr = err;
  }

  if (sendErr) {
    const logs = txErrLogs(sendErr);
    // If preflight simulation produced logs, we can treat it as a deterministic failure (not "maybe submitted").
    if (logs.length) throw sendErr;

    // Unclear if it was submitted; wait briefly for it to land anyway.
    const maybe = await waitForSignature(conn, sig, { timeoutMs: 12_000, pollMs: TX_CONFIRM_POLL_MS });
    if (maybe.ok) return sig;
    throw sendErr;
  }

  const confirmed = await waitForSignature(conn, sig, { timeoutMs: confirmTimeoutMs, pollMs: TX_CONFIRM_POLL_MS });
  if (confirmed.ok) return sig;

  // TS narrowing can be finicky on boolean discriminants in some configs; use a structural guard.
  if (!('err' in confirmed)) return sig;

  const msg = txErrMessage(confirmed.err);
  const logs = Array.isArray(confirmed.logs) ? confirmed.logs : [];
  const code = /timeout/i.test(msg) ? 'deadline-exceeded' : 'failed-precondition';
  throw new HttpsError(code, `${label} transaction not confirmed (try again)`, {
    signature: sig,
    lastError: msg,
    lastLogs: logs.slice(0, 80),
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = sleep(ms).then(() => {
    throw new HttpsError('deadline-exceeded', `${label} timed out after ${ms}ms`);
  });
  return Promise.race([promise, timeout]);
}

function assertConfiguredPublicKey(key: PublicKey, label: string) {
  if (key.equals(PublicKey.default)) {
    throw new HttpsError('failed-precondition', `${label} is not configured (see functions/src/config/deployment.ts)`);
  }
}

const ONCHAIN_CONFIG_CHECK_TTL_MS = 5 * 60 * 1000;
const onchainConfigCheckByDrop = new Map<string, { lastCheckedMs: number; ok: boolean }>();

async function ensureOnchainCoreConfig(dropRuntime: DropRuntime, force = false) {
  const now = Date.now();
  const cached = onchainConfigCheckByDrop.get(dropRuntime.dropId);
  if (!force && cached?.ok && now - cached.lastCheckedMs < ONCHAIN_CONFIG_CHECK_TTL_MS) return;
  onchainConfigCheckByDrop.set(dropRuntime.dropId, { lastCheckedMs: now, ok: false });

  ensureAuthorityKeys();
  assertConfiguredProgramId(dropRuntime.boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');
  assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');

  const pubkeys = [dropRuntime.collectionMint, dropRuntime.boxMinterConfigPda];
  const infos = await withTimeout(
    connection(dropRuntime).getMultipleAccountsInfo(pubkeys, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo',
  );

  const missing: Record<string, string> = {};
  for (let i = 0; i < pubkeys.length; i += 1) {
    if (infos[i]) continue;
    const key = pubkeys[i];
    const label = key.equals(dropRuntime.collectionMint) ? 'COLLECTION_MINT' : 'BOX_MINTER_CONFIG_PDA';
    missing[label] = key.toBase58();
  }

  if (Object.keys(missing).length) {
    throw new HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or mismatched. Re-run `npm run deploy-all-onchain -- <dropId>`, update functions env, and redeploy.',
      {
        missing,
        collection: dropRuntime.collectionMint.toBase58(),
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }

  const collectionInfo = infos[0];
  const configInfo = infos[1];
  if (collectionInfo && !collectionInfo.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new HttpsError(
      'failed-precondition',
      'COLLECTION_MINT is not an MPL Core collection account for this cluster.',
      {
        collection: dropRuntime.collectionMint.toBase58(),
        expectedOwner: MPL_CORE_PROGRAM_ID.toBase58(),
        actualOwner: collectionInfo.owner.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }

  if (!configInfo?.data) {
    throw new HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or unreadable. Re-run `npm run deploy-all-onchain -- <dropId>`, update functions env, and redeploy.',
      { configPda: dropRuntime.boxMinterConfigPda.toBase58(), dropId: dropRuntime.dropId },
    );
  }
  const decoded = decodeBoxMinterConfigData(Buffer.from(configInfo.data));
  if (decoded.itemsPerBox !== dropRuntime.itemsPerBox) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain itemsPerBox value.',
      {
        configuredItemsPerBox: dropRuntime.itemsPerBox,
        onchainItemsPerBox: decoded.itemsPerBox,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (decoded.maxSupply !== dropRuntime.maxSupply) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain maxSupply value.',
      {
        configuredMaxSupply: dropRuntime.maxSupply,
        onchainMaxSupply: decoded.maxSupply,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (decoded.discountMintsPerWallet !== dropRuntime.discountMintsPerWallet) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain discountMintsPerWallet value.',
      {
        configuredDiscountMintsPerWallet: dropRuntime.discountMintsPerWallet,
        onchainDiscountMintsPerWallet: decoded.discountMintsPerWallet,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (normalizeConfiguredUriBaseForComparison(decoded.uriBase) !== normalizeDropBase(dropRuntime.config.metadataBase)) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain metadata base for this drop.',
      {
        configuredMetadataBase: normalizeDropBase(dropRuntime.config.metadataBase),
        onchainMetadataBase: normalizeConfiguredUriBaseForComparison(decoded.uriBase),
        onchainMetadataBaseRaw: decoded.uriBase,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }

  onchainConfigCheckByDrop.set(dropRuntime.dropId, { lastCheckedMs: now, ok: true });
}

function parseSignature(sig: number[] | string) {
  if (typeof sig === 'string') return bs58.decode(sig);
  return Uint8Array.from(sig);
}

async function heliusJson(url: string, label: string, retries = 3, backoffMs = 400) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fetch(url), RPC_TIMEOUT_MS, `heliusJson:${label}`);
      if (res.ok) return await res.json();

      const status = res.status;
      // 404 can be transient right after mint/transfer while the asset indexes.
      const retriable = status === 429 || status >= 500 || status === 404;
      if (retriable && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      if (status === 404) {
        throw new HttpsError('not-found', `${label}: not found (Helius 404)`, { status });
      }
      if (status === 400) {
        throw new HttpsError('invalid-argument', `${label}: bad request (Helius 400)`, { status });
      }
      if (status === 401 || status === 403) {
        throw new HttpsError('failed-precondition', `${label}: unauthorized (check Helius API key)`, {
          status,
        });
      }
      if (status === 429) {
        throw new HttpsError('resource-exhausted', `${label}: rate limited`, { status });
      }
      if (status >= 500) {
        throw new HttpsError('unavailable', `${label}: upstream unavailable`, { status });
      }
      throw new HttpsError('unknown', `${label}: HTTP ${status}`, { status });
    } catch (err) {
      const anyErr = err as any;
      const isHttpsError = anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string' && anyErr.code !== 'UNKNOWN';
      if (isHttpsError) {
        const code = String(anyErr.code);
        const retriableCode =
          code === 'unavailable' || code === 'resource-exhausted' || code === 'deadline-exceeded' || code === 'unknown';
        if (!retriableCode || attempt === retries) throw err;
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      if (attempt === retries) {
        throw new HttpsError('unavailable', `${label}: request failed`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(backoffMs * 2 ** attempt);
    }
  }
  // Unreachable, but keeps TS happy.
  throw new HttpsError('unavailable', `${label}: request failed`);
}

async function heliusRpc<T>(dropRuntime: DropRuntime, method: string, params: any, label: string): Promise<T> {
  const url = heliusRpcEndpoint(dropRuntime);
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: label, method, params }),
    }),
    RPC_TIMEOUT_MS,
    `heliusRpc:${method}`,
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const message = json?.error?.message || res.statusText || 'Unknown Helius RPC error';
    const upstreamCode = json?.error?.code;
    logger.warn('Helius RPC error', {
      method,
      label,
      status: res.status,
      upstreamCode,
      message,
    });
    throw new HttpsError('unavailable', `${label}: ${message}`, {
      method,
      status: res.status,
      upstreamCode,
    });
  }
  return json.result as T;
}

async function fetchAssetsOwned(owner: string, dropRuntime: DropRuntime) {
  // Helius DAS expects `grouping` as a tuple: [groupKey, groupValue]
  // (assets returned by the API use objects like { group_key, group_value }).
  //
  // NOTE: Newly minted assets can briefly miss collection-group indexing on devnet.
  // We first try the collection-group query (fast/small), then fall back to an ungrouped query
  // and filter locally by explicit collection identity from the asset payload.
  const baseParams = {
    ownerAddress: owner,
    page: 1,
    limit: 1000,
    displayOptions: {
      showCollectionMetadata: true,
      showUnverifiedCollections: true,
    },
  };

  if (dropRuntime.collectionMintStr) {
    const grouping = ['collection', dropRuntime.collectionMintStr] as const;
    const grouped = await heliusRpc<any>(dropRuntime, 'searchAssets', { ...baseParams, grouping }, 'Helius assets error');
    const items = Array.isArray(grouped?.items) ? grouped.items : [];
    if (items.length) return items;
    logger.warn('Helius searchAssets returned 0 items for collection grouping; falling back to ungrouped search', {
      owner,
      collection: dropRuntime.collectionMintStr,
      dropId: dropRuntime.dropId,
    });
  }

  const result = await heliusRpc<any>(dropRuntime, 'searchAssets', baseParams, 'Helius assets error');
  return Array.isArray(result?.items) ? result.items : [];
}

function looksBurntOrClosedInHelius(asset: any): boolean {
  if (!asset || typeof asset !== 'object') return true;
  const anyAsset = asset as any;
  const burntFlag =
    anyAsset?.burnt ??
    anyAsset?.burned ??
    anyAsset?.is_burnt ??
    anyAsset?.isBurnt ??
    anyAsset?.compression?.burnt ??
    anyAsset?.compression?.burned ??
    anyAsset?.compression?.is_burnt ??
    anyAsset?.compression?.isBurnt ??
    anyAsset?.ownership?.burnt ??
    anyAsset?.ownership?.burned;
  if (typeof burntFlag === 'boolean') return burntFlag;
  const ownershipState = String(
    anyAsset?.ownership?.ownership_state || anyAsset?.ownership?.ownershipState || anyAsset?.ownership?.state || '',
  ).toLowerCase();
  if (ownershipState && /burn/.test(ownershipState)) return true;
  return false;
}

async function fetchAsset(assetId: string, dropRuntime: DropRuntime) {
  // Use DAS RPC to keep behavior consistent with `searchAssets` (inventory).
  let asset: any;
  try {
    asset = await heliusRpc<any>(dropRuntime, 'getAsset', { id: assetId }, 'Helius asset error');
  } catch (err) {
    const anyErr = err as any;
    const upstreamCode = anyErr?.details?.upstreamCode;
    const msg = String(anyErr?.message || '');
    const looksLikeRpcMethodMismatch =
      upstreamCode === -32601 || upstreamCode === -32602 || /method not found|invalid params/i.test(msg);
    if (!looksLikeRpcMethodMismatch) throw err;
    // Fallback to legacy REST endpoint if RPC method signature isn't supported.
    const helius = process.env.HELIUS_API_KEY;
    const clusterParam = dropRuntime.cluster === 'mainnet-beta' ? '' : `&cluster=${dropRuntime.cluster}`;
    const url = `https://api.helius.xyz/v0/assets?ids[]=${assetId}&api-key=${helius}${clusterParam}`;
    const json = await heliusJson(url, 'Helius asset error');
    asset = Array.isArray(json) ? json[0] : (json as any)?.[0];
  }
  if (!asset) {
    throw new HttpsError(
      'not-found',
      'Asset not found. If you just minted/transferred/opened this item, wait a few seconds and retry.',
      { assetId },
    );
  }
  return asset;
}

async function fetchAssetProof(assetId: string, dropRuntime: DropRuntime) {
  let proof: any;
  try {
    proof = await heliusRpc<any>(dropRuntime, 'getAssetProof', { id: assetId }, 'Helius asset proof error');
  } catch (err) {
    const anyErr = err as any;
    const upstreamCode = anyErr?.details?.upstreamCode;
    const msg = String(anyErr?.message || '');
    const looksLikeRpcMethodMismatch =
      upstreamCode === -32601 || upstreamCode === -32602 || /method not found|invalid params/i.test(msg);
    if (!looksLikeRpcMethodMismatch) throw err;
    // Fallback to REST endpoint if RPC method signature isn't supported.
    const helius = process.env.HELIUS_API_KEY;
    const clusterParam = dropRuntime.cluster === 'mainnet-beta' ? '' : `&cluster=${dropRuntime.cluster}`;
    const url = `https://api.helius.xyz/v0/assets/${assetId}/proof?api-key=${helius}${clusterParam}`;
    proof = await heliusJson(url, 'Helius asset proof error');
  }
  if (!proof) {
    throw new HttpsError('not-found', 'Asset proof not found', { assetId });
  }
  return proof;
}

function getAssetKind(asset: any): 'box' | 'dude' | 'certificate' | null {
  const kindAttr = asset?.content?.metadata?.attributes?.find((a: any) => a?.trait_type === 'type');
  const value = kindAttr?.value;
  if (value === 'box' || value === 'dude' || value === 'certificate') return value;

  const kindFromUri = metadataKindFromUri(assetMetadataUri(asset));
  if (kindFromUri) return kindFromUri;

  const name: string = asset?.content?.metadata?.name || asset?.content?.metadata?.title || '';
  const lowerName = typeof name === 'string' ? name.toLowerCase() : '';
  if (lowerName.includes('blind box')) return 'box';
  if (lowerName.includes('receipt') || lowerName.includes('authenticity')) return 'certificate';
  if (lowerName.includes('figure')) return 'dude';

  // New compact on-chain metadata: allow very short names like `b123` or `box123`.
  const compact = lowerName.replace(/\s+/g, '');
  if (/^(b|box)#?\d+$/.test(compact)) return 'box';
  return null;
}

function getBoxIdFromAsset(asset: any): string | undefined {
  const boxAttr = asset?.content?.metadata?.attributes?.find((a: any) => a?.trait_type === 'box_id');
  const value = boxAttr?.value;
  if (typeof value === 'string' && value) return value;

  const uriBoxId = boxIdFromMetadataUri(assetMetadataUri(asset));
  if (uriBoxId) return uriBoxId;

  const name: string = asset?.content?.metadata?.name || asset?.content?.metadata?.title || '';
  const normalized = typeof name === 'string' ? name.toLowerCase().replace(/\s+/g, '') : '';
  const match = normalized.match(/^(b|box)#?(\d+)$/);
  if (match?.[2]) return match[2];
  return undefined;
}

function getDudeIdFromAsset(asset: any): number | undefined {
  const dudeAttr = asset?.content?.metadata?.attributes?.find((a: any) => a?.trait_type === 'dude_id');
  const num = Number(dudeAttr?.value);
  if (Number.isFinite(num)) return num;

  const idFromUri = dudeIdFromMetadataUri(assetMetadataUri(asset));
  if (typeof idFromUri === 'number') return idFromUri;
  return undefined;
}

function assetMetadataUri(asset: any): string {
  return selectMetadataUri(
    asset?.content?.json_uri,
    asset?.content?.jsonUri,
    asset?.content?.metadata?.json_uri,
    asset?.content?.metadata?.jsonUri,
    asset?.content?.metadata?.uri,
  );
}

function metadataBaseFromAsset(asset: any): string | null {
  const uri = assetMetadataUri(asset);
  return metadataBaseFromMetadataUri(uri);
}

function assetCollectionMints(asset: any): string[] {
  const out = new Set<string>();
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const group of grouped) {
      if (group?.group_key === 'collection' && typeof group?.group_value === 'string' && group.group_value) {
        out.add(group.group_value);
      }
    }
  }
  const collectionKey = asset?.content?.metadata?.collection?.key;
  if (typeof collectionKey === 'string' && collectionKey) out.add(collectionKey);
  return Array.from(out);
}

function assetMatchesDropMetadataBase(
  asset: any,
  dropRuntime: DropRuntime,
  allowedKinds?: ReadonlyArray<'box' | 'dude' | 'certificate'>,
): boolean | null {
  const kind = getAssetKind(asset);
  if (!kind) return false;
  if (allowedKinds && !allowedKinds.includes(kind)) return false;

  const collections = assetCollectionMints(asset);
  const collectionMatches = Boolean(dropRuntime.collectionMintStr) && collections.includes(dropRuntime.collectionMintStr);
  // Collection membership is mandatory. Metadata base only disambiguates assets that are
  // already in the expected collection.
  if (!collectionMatches) {
    return false;
  }

  const assetMetadataBase = metadataBaseFromAsset(asset);
  if (assetMetadataBase) {
    return assetMetadataBase === dropRuntime.canonicalMetadataBase;
  }

  return null;
}

function assetMatchesRequestedDrop(asset: any, dropRuntime: DropRuntime): boolean {
  const metadataMatch = assetMatchesDropMetadataBase(asset, dropRuntime);
  if (metadataMatch !== null) {
    return metadataMatch;
  }
  return !clusterSharesCollectionMint(dropRuntime);
}

function assetMatchesDropRuntime(asset: any, dropRuntime: DropRuntime): boolean {
  const metadataMatch = assetMatchesDropMetadataBase(asset, dropRuntime, ['box']);
  if (metadataMatch !== null) {
    return metadataMatch;
  }
  return !revealScopeSharesCollectionMint(dropRuntime);
}

async function fetchAssetRetry(assetId: string, dropRuntime: DropRuntime) {
  // DAS can be briefly inconsistent right after mint/transfer. Retry a few times so a newly minted
  // box that already shows in inventory can still be opened immediately.
  const startedAt = Date.now();
  const maxWaitMs = 12_000;
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts && Date.now() - startedAt < maxWaitMs; attempt++) {
    try {
      return await fetchAsset(assetId, dropRuntime);
    } catch (err) {
      lastErr = err;
      const anyErr = err as any;
      const isHttpsError = anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string' && anyErr.code !== 'UNKNOWN';
      // Only retry on transient upstream/indexing failures.
      const retriable =
        !isHttpsError ||
        anyErr.code === 'not-found' ||
        anyErr.code === 'unavailable' ||
        anyErr.code === 'resource-exhausted' ||
        anyErr.code === 'deadline-exceeded';
      if (!retriable) throw err;
      if (attempt < maxAttempts - 1) {
        await sleep(300 * 2 ** attempt);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function u16LE(value: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value & 0xffff, 0);
  return buf;
}

function u32LE(value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpsError('invalid-argument', `Invalid u64 value: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)), 0);
  return buf;
}

function borshOption(inner?: Buffer | null) {
  return inner ? Buffer.concat([Buffer.from([1]), inner]) : Buffer.from([0]);
}

function encodeDeliverArgs(args: { deliveryId: number; feeLamports: number; deliveryBump: number }): Buffer {
  const deliveryId = Number(args.deliveryId);
  const feeLamports = Number(args.feeLamports);
  const bump = Number(args.deliveryBump);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0 || deliveryId > 0xffff_ffff) {
    throw new HttpsError('invalid-argument', 'Invalid deliveryId');
  }
  if (!Number.isFinite(feeLamports) || feeLamports < MIN_DELIVERY_LAMPORTS || feeLamports > MAX_DELIVERY_LAMPORTS) {
    throw new HttpsError('invalid-argument', 'Invalid delivery_fee_lamports');
  }
  if (!Number.isFinite(bump) || bump < 0 || bump > 255) {
    throw new HttpsError('invalid-argument', 'Invalid delivery bump');
  }
  return Buffer.concat([IX_DELIVER, u32LE(deliveryId), u64LE(feeLamports), Buffer.from([bump & 0xff])]);
}

function decodeDeliverArgs(data: Buffer): { deliveryId: number; feeLamports: number; deliveryBump: number } {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  if (data.length < 8 + 4 + 8 + 1) {
    throw new HttpsError('invalid-argument', 'Invalid deliver instruction data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(IX_DELIVER)) {
    throw new HttpsError('invalid-argument', 'Transaction is not a box_minter deliver instruction');
  }
  const deliveryId = data.readUInt32LE(8);
  const feeLamportsBig = data.readBigUInt64LE(12);
  if (feeLamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpsError('failed-precondition', 'delivery_fee_lamports is too large');
  }
  const feeLamports = Number(feeLamportsBig);
  const deliveryBump = data.readUInt8(20);
  return { deliveryId, feeLamports, deliveryBump };
}

function encodeCloseDeliveryArgs(args: { deliveryId: number; deliveryBump: number }): Buffer {
  const deliveryId = Number(args.deliveryId);
  const bump = Number(args.deliveryBump);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0 || deliveryId > 0xffff_ffff) {
    throw new HttpsError('invalid-argument', 'Invalid deliveryId');
  }
  if (!Number.isFinite(bump) || bump < 0 || bump > 255) {
    throw new HttpsError('invalid-argument', 'Invalid delivery bump');
  }
  return Buffer.concat([IX_CLOSE_DELIVERY, u32LE(deliveryId), Buffer.from([bump & 0xff])]);
}

function isLegacySingletonConfigPda(programId: PublicKey, configPda: PublicKey): boolean {
  return configPda.equals(PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]);
}

function deriveDeliveryPda(
  programId: PublicKey,
  configPda: PublicKey,
  deliveryId: number,
): [PublicKey, number] {
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!isLegacySingletonConfigPda(programId, configPda)) {
    seeds.push(configPda.toBuffer());
  }
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function deriveDeliveryPdaForDrop(
  dropRuntime: Pick<DropRuntime, 'boxMinterProgramId' | 'boxMinterConfigPda'>,
  deliveryId: number,
): [PublicKey, number] {
  return deriveDeliveryPda(dropRuntime.boxMinterProgramId, dropRuntime.boxMinterConfigPda, deliveryId);
}

function deriveTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function mplCoreBurnV1Ix(args: { asset: PublicKey; coreCollection: PublicKey; authority: PublicKey; payer: PublicKey }) {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true }, // asset
      { pubkey: args.coreCollection, isSigner: false, isWritable: true }, // collection
      { pubkey: args.payer, isSigner: true, isWritable: true }, // payer
      { pubkey: args.authority, isSigner: true, isWritable: false }, // authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
    ],
    // BurnV1 discriminator=12, compression_proof=None (0)
    data: Buffer.from([12, 0]),
  });
}

function bs58Bytes32(value: string, label: string): Buffer {
  const text = String(value || '').trim();
  if (!text) {
    throw new HttpsError('failed-precondition', `Missing ${label}`);
  }
  let out: Uint8Array;
  try {
    out = bs58.decode(text);
  } catch (err) {
    throw new HttpsError('failed-precondition', `Invalid ${label} (base58 decode failed)`, {
      label,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (out.length !== 32) {
    throw new HttpsError('failed-precondition', `Invalid ${label} length (expected 32 bytes)`, {
      label,
      bytes: out.length,
    });
  }
  return Buffer.from(out);
}

function bubblegumBurnV2Ix(args: {
  payer: PublicKey;
  authority: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  merkleTree: PublicKey;
  coreCollection: PublicKey;
  root: Buffer; // 32 bytes
  dataHash: Buffer; // 32 bytes
  creatorHash: Buffer; // 32 bytes
  assetDataHash?: Buffer | null; // 32 bytes
  flags?: number | null; // u8
  nonce: number; // u64 (leaf_id)
  index: number; // u32
  proof: PublicKey[];
}) {
  const treeConfig = deriveTreeConfigPda(args.merkleTree);
  const nonce = Number(args.nonce);
  const index = Number(args.index);
  if (!Number.isFinite(nonce) || nonce < 0) {
    throw new HttpsError('failed-precondition', 'Invalid burn nonce');
  }
  if (!Number.isFinite(index) || index < 0) {
    throw new HttpsError('failed-precondition', 'Invalid burn index');
  }

  const root = Buffer.isBuffer(args.root) ? args.root : Buffer.from(args.root || []);
  const dataHash = Buffer.isBuffer(args.dataHash) ? args.dataHash : Buffer.from(args.dataHash || []);
  const creatorHash = Buffer.isBuffer(args.creatorHash) ? args.creatorHash : Buffer.from(args.creatorHash || []);
  if (root.length !== 32 || dataHash.length !== 32 || creatorHash.length !== 32) {
    throw new HttpsError('failed-precondition', 'Invalid burn hash lengths');
  }
  const assetDataHash = args.assetDataHash ? Buffer.from(args.assetDataHash) : null;
  if (assetDataHash && assetDataHash.length !== 32) {
    throw new HttpsError('failed-precondition', 'Invalid assetDataHash length');
  }
  const flagsNum = args.flags == null ? null : Number(args.flags);
  if (flagsNum != null && (!Number.isFinite(flagsNum) || flagsNum < 0 || flagsNum > 0xff)) {
    throw new HttpsError('failed-precondition', 'Invalid burn flags');
  }
  const proof = Array.isArray(args.proof) ? args.proof : [];

  const data = Buffer.concat([
    IX_BURN_V2,
    root,
    dataHash,
    creatorHash,
    borshOption(assetDataHash),
    borshOption(flagsNum == null ? null : Buffer.from([flagsNum & 0xff])),
    u64LE(nonce),
    u32LE(index),
  ]);

  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: treeConfig, isSigner: false, isWritable: true }, // treeConfig
      { pubkey: args.payer, isSigner: true, isWritable: true }, // payer
      { pubkey: args.authority, isSigner: true, isWritable: false }, // authority
      { pubkey: args.leafOwner, isSigner: false, isWritable: false }, // leafOwner
      { pubkey: args.leafDelegate, isSigner: false, isWritable: false }, // leafDelegate
      { pubkey: args.merkleTree, isSigner: false, isWritable: true }, // merkleTree
      { pubkey: args.coreCollection, isSigner: false, isWritable: true }, // coreCollection
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mplCoreCpiSigner
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // logWrapper
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compressionProgram
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mplCoreProgram
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // systemProgram
      ...proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data,
  });
}

const BOX_MINTER_CONFIG_ACCOUNT_SIZE_MIN =
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

type DecodedBoxMinterConfig = {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  discountMintsPerWallet: number;
  uriBase: string;
  dropSeed?: Buffer;
};

function normalizeDiscountMintsPerWallet(value: number | undefined): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_DISCOUNT_MINTS_PER_WALLET ||
    parsed > MAX_DISCOUNT_MINTS_PER_WALLET
  ) {
    return 1;
  }
  return parsed;
}

function readBorshString(data: Buffer, offset: number): { value: string; next: number } {
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  return { value: data.subarray(start, end).toString('utf8'), next: end };
}

function readU32Tuple(data: Buffer, offset: number): { next: number } {
  let next = offset;
  for (let i = 0; i < 3; i += 1) {
    next += 4;
  }
  return { next };
}

function hasAnyNonZeroByte(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== 0) return true;
  }
  return false;
}

function decodeOptionalTrailingDropSeed(data: Buffer, offset: number): Buffer | undefined {
  // RPC returns the full allocated account data, so legacy configs have trailing zero padding
  // after the serialized payload. Treat all-zero trailing bytes as padding, not v2 data.
  if (offset >= data.length) return undefined;
  const trailing = data.subarray(offset);
  if (!hasAnyNonZeroByte(trailing)) return undefined;
  if (trailing.length < 32) {
    throw new HttpsError('failed-precondition', 'Box minter config drop seed data is truncated');
  }
  const dropSeed = Buffer.from(data.subarray(offset, offset + 32));
  if (!hasAnyNonZeroByte(dropSeed)) {
    throw new HttpsError('failed-precondition', 'Unexpected trailing data after the box minter config payload');
  }
  if (hasAnyNonZeroByte(trailing.subarray(32))) {
    throw new HttpsError('failed-precondition', 'Unexpected trailing data after the box minter drop seed');
  }
  return dropSeed;
}

function decodeBoxMinterConfigData(data: Buffer | Uint8Array): DecodedBoxMinterConfig {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < BOX_MINTER_CONFIG_ACCOUNT_SIZE_MIN) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config uses an older schema. Re-run deploy-all-onchain for a fresh configurable-items deployment.',
      { expectedMinBytes: BOX_MINTER_CONFIG_ACCOUNT_SIZE_MIN, actualBytes: buf.length },
    );
  }

  let o = 8;
  const admin = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const treasury = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const coreCollection = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  o += 8; // priceLamports
  o += 8; // discountPriceLamports
  o += 32; // discountMerkleRoot
  const maxSupply = buf.readUInt32LE(o);
  o += 4;
  const maxPerTx = buf.readUInt8(o);
  o += 1;
  const itemsPerBox = buf.readUInt8(o);
  o += 1;
  o += 4; // minted
  o = readBorshString(buf, o).next;
  o = readBorshString(buf, o).next;
  const uriBase = readBorshString(buf, o);
  o = uriBase.next;
  o += 1; // started
  o += 1; // bump
  const discountMintsPerWallet = normalizeDiscountMintsPerWallet(buf[o]);
  o += 1;
  if (o + 4 <= buf.length) {
    o = readBorshString(buf, o).next; // figureNamePrefix
  }
  const mintVariantBytes = 1 + 4 * 3 * 3;
  if (o < buf.length) {
    if (o + mintVariantBytes > buf.length) {
      throw new HttpsError('failed-precondition', 'Box minter config variant data is truncated');
    }
    o += 1; // mintVariantKind
    o = readU32Tuple(buf, o).next;
    o = readU32Tuple(buf, o).next;
    o = readU32Tuple(buf, o).next;
  }
  const dropSeed = decodeOptionalTrailingDropSeed(buf, o);

  if (!Number.isFinite(itemsPerBox) || itemsPerBox < MIN_ITEMS_PER_BOX || itemsPerBox > MAX_ITEMS_PER_BOX) {
    throw new HttpsError('failed-precondition', 'On-chain config has invalid itemsPerBox', { itemsPerBox });
  }

  return {
    admin,
    treasury,
    coreCollection,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    discountMintsPerWallet,
    uriBase: uriBase.value,
    ...(dropSeed ? { dropSeed } : {}),
  };
}

async function fetchDecodedBoxMinterConfigAccount(params: {
  dropRuntime: DropRuntime;
  conn: Connection;
  context: string;
}): Promise<DecodedBoxMinterConfig> {
  const { dropRuntime, conn, context } = params;
  const cfgInfo = await withTimeout(
    conn.getAccountInfo(dropRuntime.boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    context,
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run deploy-all-onchain -- <dropId>`, update env, and redeploy.',
      { configPda: dropRuntime.boxMinterConfigPda.toBase58(), dropId: dropRuntime.dropId },
    );
  }
  return decodeBoxMinterConfigData(Buffer.from(cfgInfo.data));
}

function encodeFinalizeOpenBoxArgs(dudeIds: number[], dropRuntime: DropRuntime): Buffer {
  assertOpenableDrop(dropRuntime, 'This drop does not support opening.');
  if (!Array.isArray(dudeIds) || dudeIds.length !== dropRuntime.itemsPerBox) {
    throw new HttpsError('invalid-argument', `dudeIds must have length ${dropRuntime.itemsPerBox}`);
  }
  const ids = dudeIds.map((n) => Number(n));
  ids.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > dropRuntime.maxDudeId) {
      throw new HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    throw new HttpsError('invalid-argument', 'Duplicate dude ids');
  }
  return Buffer.concat([IX_FINALIZE_OPEN_BOX, u32LE(ids.length), ...ids.map(u16LE)]);
}

function encodeMintReceiptsArgs(args: { boxIds: number[]; dudeIds: number[] }, dropRuntime: DropRuntime): Buffer {
  const boxIds = Array.isArray(args.boxIds) ? args.boxIds.map((n) => Number(n)) : [];
  const dudeIds = Array.isArray(args.dudeIds) ? args.dudeIds.map((n) => Number(n)) : [];

  boxIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > 0xffff_ffff) {
      throw new HttpsError('invalid-argument', `Invalid box id: ${id}`);
    }
  });
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > dropRuntime.maxDudeId) {
      throw new HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });

  return Buffer.concat([
    IX_MINT_RECEIPTS,
    u32LE(boxIds.length),
    ...boxIds.map((id) => u32LE(Math.floor(id))),
    u32LE(dudeIds.length),
    ...dudeIds.map((id) => u16LE(Math.floor(id))),
  ]);
}

function decodePendingOpenBox(data: Buffer): {
  owner: PublicKey;
  boxAsset: PublicKey;
  dudeAssets: PublicKey[];
  createdSlot: bigint;
  bump: number;
  config?: PublicKey;
} {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const minLen = 8 + 32 + 32 + 4 + 8 + 1;
  if (data.length < minLen) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_PENDING_OPEN_BOX)) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account discriminator');
  }
  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const boxAsset = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const dudeCount = data.readUInt32LE(o);
  o += 4;
  if (data.length < 8 + 32 + 32 + 4 + 32 * dudeCount + 8 + 1) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (truncated vector)');
  }
  const dudeAssets: PublicKey[] = [];
  for (let i = 0; i < dudeCount; i += 1) {
    dudeAssets.push(new PublicKey(data.subarray(o, o + 32)));
    o += 32;
  }
  const createdSlot = data.readBigUInt64LE(o);
  o += 8;
  const bump = data.readUInt8(o);
  o += 1;
  let config: PublicKey | undefined;
  if (o < data.length) {
    const trailing = data.subarray(o);
    if (trailing.length < 32) {
      throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (truncated config)');
    }
    config = new PublicKey(trailing.subarray(0, 32));
    if (hasAnyNonZeroByte(trailing.subarray(32))) {
      throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (unexpected trailing bytes)');
    }
  }
  return { owner, boxAsset, dudeAssets, createdSlot, bump, ...(config ? { config } : {}) };
}

function decodeDeliveryRecord(data: Buffer): {
  payer: PublicKey;
  deliveryFeeLamports: number;
  itemCount: number;
} {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const expectedLen = 8 + 32 + 8 + 2;
  if (data.length < expectedLen) {
    throw new HttpsError('failed-precondition', 'Invalid DeliveryRecord account data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DELIVERY_RECORD)) {
    throw new HttpsError('failed-precondition', 'Invalid DeliveryRecord account discriminator');
  }
  let o = 8;
  const payer = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const feeLamportsBig = data.readBigUInt64LE(o);
  if (feeLamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpsError('failed-precondition', 'delivery_fee_lamports is too large');
  }
  const deliveryFeeLamports = Number(feeLamportsBig);
  o += 8;
  const itemCount = data.readUInt16LE(o);
  return { payer, deliveryFeeLamports, itemCount };
}

async function assignDudes(dropId: string, boxAssetId: string): Promise<number[]> {
  const dropRuntime = getDropRuntime(dropId);
  const itemsPerBox = dropRuntime.itemsPerBox;
  assertOpenableDrop(dropRuntime, 'This drop does not support figure assignment.');
  const maxDudeId = dropRuntime.maxDudeId;
  const ref = db.doc(dropBoxAssignmentPath(dropId, boxAssetId));
  const poolRef = db.doc(dropDudePoolPath(dropId));

  // Firestore `runTransaction` retries internally on contention, but under heavy concurrency it can still
  // surface transient gRPC errors. Add a small outer retry/backoff layer so callers get a clean
  // "try again" experience instead of occasional hard failures.
  const MAX_OUTER_ATTEMPTS = 6;
  for (let outerAttempt = 1; outerAttempt <= MAX_OUTER_ATTEMPTS; outerAttempt += 1) {
    let internalAttempts = 0;
    let lastAttemptMeta:
      | null
      | {
          boxAssetId: string;
          outerAttempt: number;
          internalAttempts: number;
          poolDocExists: boolean;
          usedDefaultPool: boolean;
          rawPoolLen: number | null;
          poolInitLen: number;
          invalidRemoved: number;
          dupRemoved: number;
          poolLenAfterSanitize: number;
          poolLenAfterWrite: number;
          candidatesChecked: number;
          staleAssigned: number;
          chosen: number[];
        } = null;

    try {
      const result = await db.runTransaction(async (tx) => {
        internalAttempts += 1;

        const existing = await tx.get(ref);
        if (existing.exists) {
          const dudeIdsRaw = (existing.data() as any)?.dudeIds;
          const dudeIds = Array.isArray(dudeIdsRaw) ? dudeIdsRaw.map((n) => Math.floor(Number(n))) : [];
          if (dudeIds.length !== itemsPerBox) {
            throw new HttpsError('failed-precondition', `Invalid stored dudeIds (expected ${itemsPerBox})`, {
              boxAssetId,
              dudeIds,
            });
          }
          dudeIds.forEach((id) => {
            if (!Number.isFinite(id) || id < 1 || id > maxDudeId) {
              throw new HttpsError('failed-precondition', 'Invalid stored dude id', { boxAssetId, dudeId: id });
            }
          });
          if (new Set(dudeIds).size !== dudeIds.length) {
            throw new HttpsError('failed-precondition', 'Duplicate stored dudeIds for box', { boxAssetId, dudeIds });
          }

          return dudeIds;
        }

        const poolSnap = await tx.get(poolRef);
        const rawPool = (poolSnap.data() as any)?.available;
        const usedDefaultPool = !Array.isArray(rawPool);
        const rawPoolLen = Array.isArray(rawPool) ? rawPool.length : null;

        let pool: number[] = Array.isArray(rawPool) ? rawPool.map((n) => Math.floor(Number(n))) : Array.from({ length: maxDudeId }, (_, i) => i + 1);
        const poolInitLen = pool.length;

        // Sanitize + de-dupe (in case the pool doc was manually edited/corrupted).
        const sanitized = pool.filter((id) => Number.isFinite(id) && id >= 1 && id <= maxDudeId);
        const invalidRemoved = poolInitLen - sanitized.length;
        pool = Array.from(new Set(sanitized));
        const dupRemoved = sanitized.length - pool.length;
        const poolLenAfterSanitize = pool.length;

        if (pool.length < itemsPerBox) {
          throw new HttpsError('resource-exhausted', 'No dudes remaining to assign', {
            boxAssetId,
            poolDocExists: poolSnap.exists,
            poolLen: pool.length,
            required: itemsPerBox,
          });
        }

        const chosen: number[] = [];
        const chosenSet = new Set<number>();
        let candidatesChecked = 0;
        let staleAssigned = 0;

        // NOTE: Firestore transactions automatically retry on contention. We also defensively guard uniqueness
        // across boxes *within the same drop* by reserving `dudeAssignments/{dudeId}` docs inside this transaction.
        while (chosen.length < itemsPerBox) {
          if (!pool.length) {
            throw new HttpsError('resource-exhausted', 'No dudes remaining to assign', {
              boxAssetId,
              chosen,
              candidatesChecked,
              staleAssigned,
            });
          }

          const pick = randomInt(0, pool.length);
          const candidate = pool[pick];
          pool.splice(pick, 1);
          candidatesChecked += 1;

          if (!Number.isFinite(candidate) || candidate < 1 || candidate > maxDudeId) continue;
          if (chosenSet.has(candidate)) continue;

          const dudeRef = db.doc(dropDudeAssignmentPath(dropId, candidate));
          const dudeSnap = await tx.get(dudeRef);
          if (dudeSnap.exists) {
            // Pool is stale/corrupt (it includes an already-assigned dude). Keep it removed from `pool` so the
            // pool doc gets self-healed on commit.
            staleAssigned += 1;
            continue;
          }

          chosen.push(candidate);
          chosenSet.add(candidate);
        }

        // Reserve dudes (uniqueness across boxes, even if the pool doc is corrupted).
        for (const dudeId of chosen) {
          const dudeRef = db.doc(dropDudeAssignmentPath(dropId, dudeId));
          tx.create(dudeRef, {
            dudeId,
            boxAssetId,
            assignedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(poolRef, { available: pool, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.set(ref, { dudeIds: chosen, createdAt: FieldValue.serverTimestamp() });

        // Capture high-signal debug meta for post-commit logging (only logged when something looks off).
        lastAttemptMeta = {
          boxAssetId,
          outerAttempt,
          internalAttempts,
          poolDocExists: poolSnap.exists,
          usedDefaultPool,
          rawPoolLen,
          poolInitLen,
          invalidRemoved,
          dupRemoved,
          poolLenAfterSanitize,
          poolLenAfterWrite: pool.length,
          candidatesChecked,
          staleAssigned,
          chosen,
        };
        return chosen;
      });

      // Log only on "interesting" paths to avoid noisy logs in normal operation.
      if (lastAttemptMeta) {
        const selfHealed =
          (lastAttemptMeta.poolDocExists && lastAttemptMeta.usedDefaultPool) ||
          lastAttemptMeta.invalidRemoved > 0 ||
          lastAttemptMeta.dupRemoved > 0 ||
          lastAttemptMeta.staleAssigned > 0;
        const retried = lastAttemptMeta.internalAttempts > 1 || lastAttemptMeta.outerAttempt > 1;
        if (selfHealed) {
          logger.warn('assignDudes:pool_self_heal', lastAttemptMeta);
        } else if (retried) {
          logger.info('assignDudes:retry', {
            boxAssetId,
            outerAttempt: lastAttemptMeta.outerAttempt,
            internalAttempts: lastAttemptMeta.internalAttempts,
          });
        }
      } else if (internalAttempts > 1 || outerAttempt > 1) {
        // The "existing assignment" fast-path doesn't populate `lastAttemptMeta`.
        logger.info('assignDudes:retry', { boxAssetId, outerAttempt, internalAttempts, path: 'existing_assignment' });
      }

      return result;
    } catch (err) {
      const retryable =
        isGrpcAlreadyExists(err) ||
        isGrpcAborted(err) ||
        isGrpcUnavailable(err) ||
        isGrpcDeadlineExceeded(err) ||
        isGrpcResourceExhausted(err);
      if (retryable && outerAttempt < MAX_OUTER_ATTEMPTS) {
        const delayMs = Math.min(150 * 2 ** Math.min(outerAttempt - 1, 4) + randomInt(0, 120), 2_500);
        logger.warn('assignDudes:transient_error_retrying', {
          boxAssetId,
          outerAttempt,
          internalAttempts,
          delayMs,
          error: summarizeError(err),
        });
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }

  throw new HttpsError('unavailable', 'Failed to assign dudes (try again)', { boxAssetId });
}

const IRL_CLAIM_CODE_DIGITS = 10;
const IRL_CLAIM_CODE_NAMESPACE = 'irl_v2';

function generateIrlClaimCode(): string {
  // 10 digits, including leading zeros.
  const max = 10 ** IRL_CLAIM_CODE_DIGITS;
  const n = randomInt(0, max);
  return String(n).padStart(IRL_CLAIM_CODE_DIGITS, '0');
}

function normalizeIrlClaimCode(code: string): string {
  // Accept common human formatting (spaces, dashes); store/use digits only.
  return String(code || '').replace(/\D/g, '');
}

function normalizeDropIdMaybe(rawDropId: unknown): string | null {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) return null;
  try {
    return normalizeDropId(rawDropId);
  } catch {
    return null;
  }
}

function claimCodeDocMatchesBox(claim: any, expected: { dropId: string; boxAssetId: string; boxId: number }): boolean {
  const claimDropId = normalizeDropIdMaybe(claim?.dropId);
  const claimBoxAssetId = typeof claim?.boxAssetId === 'string' ? String(claim.boxAssetId) : '';
  const claimBoxId = Number(claim?.boxId);
  return (
    claimDropId === expected.dropId &&
    claimBoxAssetId === expected.boxAssetId &&
    Number.isFinite(claimBoxId) &&
    Math.floor(claimBoxId) === Math.floor(expected.boxId)
  );
}

function buildIrlClaimCodeDoc(params: {
  code: string;
  dropId: string;
  boxId: number;
  boxAssetId: string;
  ownerWallet: string;
  deliveryId: number;
  dudeIds: number[];
}) {
  return {
    version: 2,
    namespace: IRL_CLAIM_CODE_NAMESPACE,
    code: params.code,
    dropId: params.dropId,
    boxId: params.boxId,
    boxAssetId: params.boxAssetId,
    owner: params.ownerWallet,
    deliveryId: params.deliveryId,
    dudeIds: params.dudeIds,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function buildIrlClaimAssignment(code: string, params: { dropId: string; boxId: number; deliveryId: number; ownerWallet: string; dudeIds: number[] }) {
  return {
    irlClaimCode: code,
    irlClaim: {
      namespace: IRL_CLAIM_CODE_NAMESPACE,
      code,
      dropId: params.dropId,
      boxId: params.boxId,
      deliveryId: params.deliveryId,
      owner: params.ownerWallet,
      dudeIds: params.dudeIds,
      createdAt: FieldValue.serverTimestamp(),
    },
  };
}

function dropIdFromBoxAssignmentPath(path: string): string | null {
  const parts = String(path || '').split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'drops' || parts[2] !== 'boxAssignments') return null;
  return normalizeDropIdMaybe(parts[1]);
}

async function resolveClaimDropIdForCode(code: string, claim: any): Promise<string> {
  const fromClaim = normalizeDropIdMaybe(claim?.dropId);
  if (fromClaim) return fromClaim;

  const byCodeSnap = await db.collectionGroup('boxAssignments').where('irlClaimCode', '==', code).limit(2).get();
  const dropIds = new Set<string>();
  byCodeSnap.docs.forEach((doc) => {
    const dropId = dropIdFromBoxAssignmentPath(doc.ref.path);
    if (dropId) dropIds.add(dropId);
  });
  if (dropIds.size === 1) return Array.from(dropIds)[0];
  if (dropIds.size > 1) {
    throw new HttpsError('failed-precondition', 'Claim code is linked to multiple drops; contact support.');
  }

  throw new HttpsError('failed-precondition', 'Claim code record is missing dropId and could not be resolved.');
}

async function ensureIrlClaimCodeForBox(params: {
  dropId: string;
  ownerWallet: string;
  deliveryId: number;
  boxAssetId: string;
  boxId: number;
  dudeIds: number[];
}): Promise<string> {
  const dropId = normalizeDropId(params.dropId);
  const dropRuntime = getDropRuntime(dropId);
  const ownerWallet = normalizeWallet(params.ownerWallet);
  const deliveryId = Number(params.deliveryId);
  const boxAssetId = String(params.boxAssetId || '');
  const boxId = Number(params.boxId);
  const dudeIds = Array.isArray(params.dudeIds) ? params.dudeIds.map((n) => Number(n)) : [];

  assertOpenableDrop(dropRuntime, 'This drop does not use IRL claim codes.');
  if (!boxAssetId) throw new HttpsError('failed-precondition', 'Missing boxAssetId for IRL claim code');
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    throw new HttpsError('failed-precondition', 'Invalid deliveryId for IRL claim code');
  }
  if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) {
    throw new HttpsError('failed-precondition', 'Invalid box id for IRL claim code');
  }
  if (dudeIds.length !== dropRuntime.itemsPerBox) {
    throw new HttpsError('failed-precondition', `Invalid dudeIds (expected ${dropRuntime.itemsPerBox})`);
  }
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > dropRuntime.maxDudeId) {
      throw new HttpsError('failed-precondition', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new HttpsError('failed-precondition', 'Duplicate dude ids for IRL claim code');
  }

  const assignmentRef = db.doc(dropBoxAssignmentPath(dropId, boxAssetId));
  return db.runTransaction(async (tx) => {
    const assignmentSnap = await tx.get(assignmentRef);
    const assignment = assignmentSnap.exists ? (assignmentSnap.data() as any) : {};

    const existingCodeRaw = assignment?.irlClaimCode;
    const existingCodeNormalized = typeof existingCodeRaw === 'string' ? normalizeIrlClaimCode(existingCodeRaw) : '';
    const existingCode = existingCodeNormalized.length === IRL_CLAIM_CODE_DIGITS ? existingCodeNormalized : '';
    if (existingCodeNormalized && !existingCode) {
      logger.warn('ensureIrlClaimCodeForBox:invalid_existing_claim_code_format', {
        dropId,
        boxAssetId,
        boxId,
        existingCodeRaw: String(existingCodeRaw),
      });
    }
    if (existingCode) {
      const existingRef = db.doc(`claimCodes/${existingCode}`);
      const existingSnap = await tx.get(existingRef);
      if (!existingSnap.exists) {
        // Backfill if the assignment doc was written but claimCodes doc was not.
        tx.set(existingRef, buildIrlClaimCodeDoc({ code: existingCode, dropId, boxId, boxAssetId, ownerWallet, deliveryId, dudeIds }));
        tx.set(assignmentRef, buildIrlClaimAssignment(existingCode, { dropId, boxId, deliveryId, ownerWallet, dudeIds }), { merge: true });
      }
      if (existingSnap.exists) {
        const existingClaim = existingSnap.data() as any;
        if (!claimCodeDocMatchesBox(existingClaim, { dropId, boxAssetId, boxId })) {
          logger.warn('ensureIrlClaimCodeForBox:mismatched_existing_claim_code', {
            dropId,
            boxAssetId,
            boxId,
            existingCode,
            claimDropId: normalizeDropIdMaybe(existingClaim?.dropId),
            claimBoxAssetId: typeof existingClaim?.boxAssetId === 'string' ? existingClaim.boxAssetId : null,
            claimBoxId: existingClaim?.boxId ?? null,
          });
        } else {
          return existingCode;
        }
      } else {
        return existingCode;
      }
    }

    // Allocate a unique 10-digit claim code.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const code = generateIrlClaimCode();
      const claimRef = db.doc(`claimCodes/${code}`);
      const snap = await tx.get(claimRef);
      if (snap.exists) continue;

      tx.set(claimRef, buildIrlClaimCodeDoc({ code, dropId, boxId, boxAssetId, ownerWallet, deliveryId, dudeIds }));
      tx.set(assignmentRef, buildIrlClaimAssignment(code, { dropId, boxId, deliveryId, ownerWallet, dudeIds }), { merge: true });
      return code;
    }

    throw new HttpsError('unavailable', 'Failed to allocate unique IRL claim code (try again)');
  });
}

function buildTx(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  recentBlockhash: string,
  signers: Keypair[] = [],
  addressLookupTables: AddressLookupTableAccount[] = [],
) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message(addressLookupTables);
  const tx = new VersionedTransaction(message);
  if (signers.length) tx.sign(signers);
  return tx;
}

async function getDeliveryLookupTable(conn: Connection, dropRuntime: DropRuntime): Promise<AddressLookupTableAccount[] | []> {
  if (!dropRuntime.deliveryLookupTableStr) return [];
  const now = Date.now();
  const cached = cachedDeliveryLutByDrop.get(dropRuntime.dropId);
  if (cached && now - cached.cachedAtMs < DELIVERY_LUT_CACHE_TTL_MS) return [cached.lut];

  const res = await withTimeout(
    conn.getAddressLookupTable(dropRuntime.deliveryLookupTable),
    RPC_TIMEOUT_MS,
    'getAddressLookupTable:delivery',
  );
  const lut = res?.value || null;
  if (!lut) {
    throw new HttpsError('failed-precondition', 'DELIVERY_LOOKUP_TABLE not found on-chain', {
      deliveryLookupTable: dropRuntime.deliveryLookupTableStr,
      cluster: dropRuntime.cluster,
      dropId: dropRuntime.dropId,
    });
  }
  cachedDeliveryLutByDrop.set(dropRuntime.dropId, { lut, cachedAtMs: now });
  return [lut];
}

function normalizeCountryCode(country?: string) {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s._-]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA' || compact === 'USA' || compact === 'US') {
    return 'US';
  }
  return '';
}

function countDeliveryFigures(items: Array<{ kind: 'box' | 'dude' }>, itemsPerBox: number): number {
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox);
  return items.reduce((total, item) => total + (item.kind === 'box' ? deliveryUnitsPerBox : 1), 0);
}

function calculateUsDeliveryLamports(figureCount: number, itemsPerBox: number, dropFamily: DropFamily): number {
  if (figureCount <= 0) return 0;
  if (isDirectDeliveryItemsPerBox(itemsPerBox)) return 0;
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox);
  if (dropFamily === 'little_swag_boxes') {
    const extraFigures = Math.max(0, figureCount - deliveryUnitsPerBox);
    return LITTLE_SWAG_BOXES_US_BASE_LAMPORTS + extraFigures * LITTLE_SWAG_BOXES_US_EXTRA_LAMPORTS;
  }
  if (dropFamily === 'poncho_drifella') {
    return PONCHO_DRIFELLA_US_FLAT_LAMPORTS;
  }
  return 0;
}

function calculateDeliveryLamports(
  items: Array<{ kind: 'box' | 'dude' }>,
  countryCode: string | undefined,
  itemsPerBox: number,
  dropFamily: DropFamily,
): number {
  const figureCount = countDeliveryFigures(items, itemsPerBox);
  if (figureCount <= 0) return 0;
  const normalized = normalizeCountryCode(countryCode);
  if (dropFamily === 'little_swag_hoodies') {
    if (normalized === 'US') return 0;
    const extraFigures = Math.max(0, figureCount - 1);
    return LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS + extraFigures * LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS;
  }
  if (normalized === 'US') return calculateUsDeliveryLamports(figureCount, itemsPerBox, dropFamily);
  const deliveryUnitsPerBox = normalizeDeliveryUnitsPerBox(itemsPerBox);
  const extraFigures = Math.max(0, figureCount - deliveryUnitsPerBox);
  return INTL_DELIVERY_BASE_LAMPORTS + extraFigures * INTL_DELIVERY_EXTRA_LAMPORTS;
}

const FULFILLMENT_STATUS_OPTIONS = ['Preparing', 'Shipped'] as const;
type FulfillmentStatus = (typeof FULFILLMENT_STATUS_OPTIONS)[number];

function normalizeFulfillmentStatus(value: unknown): FulfillmentStatus | undefined {
  return value === 'Preparing' || value === 'Shipped' ? value : undefined;
}

type DeliveryOrderItemSummary = { kind: 'box' | 'dude'; refId: number };
type DeliveryOrderSummary = {
  dropId: string;
  deliveryId: number;
  status: string;
  createdAt?: number;
  processingAt?: number;
  processedAt?: number;
  items: DeliveryOrderItemSummary[];
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentUpdatedAt?: number;
};

type DeliveryOrderOwnersCursor = {
  path: string;
};

function toMillisMaybe(value: any): number | undefined {
  if (!value) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return undefined;
}

function dropIdFromDeliveryOrderPath(path: string): string | null {
  const parts = String(path || '').split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'drops' || parts[2] !== 'deliveryOrders') return null;
  return normalizeDropIdMaybe(parts[1]);
}

function resolveDeliveryOrderDropId(order: any, docPath: string): string | null {
  return normalizeDropIdMaybe(order?.dropId) || dropIdFromDeliveryOrderPath(docPath);
}

function toDeliveryOrderSummary(docId: string, order: any, docPath: string): DeliveryOrderSummary | null {
  const deliveryIdRaw = order?.deliveryId ?? docId;
  const deliveryId = Number(deliveryIdRaw);
  if (!Number.isFinite(deliveryId)) return null;
  const dropId = resolveDeliveryOrderDropId(order, docPath);
  if (!dropId) return null;

  const itemsRaw = Array.isArray(order?.items) ? order.items : [];
  const items = itemsRaw
    .filter((item: any) => item && (item.kind === 'box' || item.kind === 'dude'))
    .map((item: any) => ({
      kind: item.kind as 'box' | 'dude',
      refId: Math.floor(Number(item.refId)),
    }))
    .filter((item: DeliveryOrderItemSummary) => Number.isFinite(item.refId) && item.refId > 0);

  return {
    dropId,
    deliveryId,
    status: typeof order?.status === 'string' ? order.status : 'unknown',
    createdAt: toMillisMaybe(order?.createdAt),
    processingAt: toMillisMaybe(order?.processingAt),
    processedAt: toMillisMaybe(order?.processedAt),
    items,
    fulfillmentStatus: normalizeFulfillmentStatus(order?.fulfillmentStatus),
    fulfillmentUpdatedAt: toMillisMaybe(order?.fulfillmentUpdatedAt),
  };
}

const DELIVERY_ORDER_SUMMARY_FIELDS = [
  'dropId',
  'deliveryId',
  'status',
  'createdAt',
  'processingAt',
  'processedAt',
  'items',
  'fulfillmentStatus',
  'fulfillmentUpdatedAt',
] as const;

function toDeliveryOrderSummaries(docs: Array<{ id: string; data(): any; ref: { path: string } }>): DeliveryOrderSummary[] {
  return docs
    .map((doc) => toDeliveryOrderSummary(doc.id, doc.data(), doc.ref.path))
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
}

async function fetchDeliveryOrderHistory(ownerWallet: string): Promise<DeliveryOrderSummary[]> {
  const [readySnap, processingSnap] = await Promise.all([
    db
      .collectionGroup('deliveryOrders')
      .where('owner', '==', ownerWallet)
      .where('status', '==', 'ready_to_ship')
      .select(...DELIVERY_ORDER_SUMMARY_FIELDS)
      .get(),
    db
      .collectionGroup('deliveryOrders')
      .where('owner', '==', ownerWallet)
      .where('status', '==', 'processing')
      .select(...DELIVERY_ORDER_SUMMARY_FIELDS)
      .get(),
  ]);

  const summaries = toDeliveryOrderSummaries([...readySnap.docs, ...processingSnap.docs]);
  summaries.sort(
    (a, b) => (b.processedAt ?? b.processingAt ?? b.createdAt ?? 0) - (a.processedAt ?? a.processingAt ?? a.createdAt ?? 0),
  );
  return summaries;
}

function encodeDeliveryOrderOwnersCursor(cursor: DeliveryOrderOwnersCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseDeliveryOrderOwnersCursor(rawCursor: unknown): DeliveryOrderOwnersCursor | null {
  if (typeof rawCursor !== 'string' || !rawCursor.trim()) return null;
  try {
    const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    const path = typeof parsed === 'string' ? parsed : (parsed as Partial<DeliveryOrderOwnersCursor>)?.path;
    if (typeof path !== 'string' || !dropIdFromDeliveryOrderPath(path)) throw new Error('path');
    return { path };
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid cursor');
  }
}

type FulfillmentOrderAddress = {
  label?: string;
  email?: string;
  country?: string;
  countryCode?: string;
  hint?: string;
  encrypted?: string;
  full?: string | null;
};

type FulfillmentOrderBox = {
  boxId: number;
  assetId?: string;
  claimCode?: string;
  dudeIds: number[];
};

type FulfillmentOrder = {
  deliveryId: number;
  owner: string;
  status: string;
  createdAt?: number;
  processedAt?: number;
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentUpdatedAt?: number;
  fulfillmentInternalStatus?: string;
  address: FulfillmentOrderAddress;
  boxes: FulfillmentOrderBox[];
  looseDudes: number[];
};

function toFulfillmentOrder(
  docId: string,
  order: any,
  options: { canViewSensitiveAddress: boolean },
): FulfillmentOrder | null {
  const deliveryIdRaw = order?.deliveryId ?? docId;
  const deliveryId = Number(deliveryIdRaw);
  if (!Number.isFinite(deliveryId)) return null;
  const owner = typeof order?.owner === 'string' ? order.owner : '';
  const status = typeof order?.status === 'string' ? order.status : 'unknown';

  const addressSnapshot = order?.addressSnapshot || {};
  const encrypted = typeof addressSnapshot?.encrypted === 'string' ? addressSnapshot.encrypted : '';
  const rawEmail = typeof addressSnapshot?.email === 'string' ? addressSnapshot.email : undefined;
  let full: string | null = null;
  let email = rawEmail;
  let encryptedPayload = encrypted || undefined;
  if (options.canViewSensitiveAddress) {
    if (encrypted) {
      full = decryptAddressPayload(encrypted);
    }
  } else {
    full = encrypted ? '***' : null;
    encryptedPayload = undefined;
  }

  const address: FulfillmentOrderAddress = {
    label: typeof addressSnapshot?.label === 'string' ? addressSnapshot.label : undefined,
    email,
    country: typeof addressSnapshot?.country === 'string' ? addressSnapshot.country : undefined,
    countryCode: typeof addressSnapshot?.countryCode === 'string' ? addressSnapshot.countryCode : undefined,
    hint: typeof addressSnapshot?.hint === 'string' ? addressSnapshot.hint : undefined,
    encrypted: encryptedPayload,
    full,
  };

  const itemsRaw = Array.isArray(order?.items) ? order.items : [];
  const boxItems = itemsRaw
    .filter((item: any) => item && item.kind === 'box')
    .map((item: any) => ({
      assetId: typeof item.assetId === 'string' ? item.assetId : undefined,
      refId: Math.floor(Number(item.refId)),
    }))
    .filter((item: any) => Number.isFinite(item.refId) && item.refId > 0);

  const looseDudes = itemsRaw
    .filter((item: any) => item && item.kind === 'dude')
    .map((item: any) => Math.floor(Number(item.refId)))
    .filter((refId: number) => Number.isFinite(refId) && refId > 0)
    .sort((a, b) => a - b);

  const claimsRaw = Array.isArray(order?.irlClaims) ? order.irlClaims : [];
  const claimsByBoxId = new Map<number, { code?: string; dudeIds?: number[]; boxAssetId?: string }>();
  for (const claim of claimsRaw) {
    const boxId = Math.floor(Number(claim?.boxId));
    if (!Number.isFinite(boxId) || boxId <= 0) continue;
    const dudeIdsRaw = Array.isArray(claim?.dudeIds) ? claim.dudeIds : [];
    const dudeIds = dudeIdsRaw.map((id: any) => Math.floor(Number(id))).filter((id: number) => Number.isFinite(id) && id > 0);
    claimsByBoxId.set(boxId, {
      code: typeof claim?.code === 'string' ? claim.code : undefined,
      dudeIds,
      boxAssetId: typeof claim?.boxAssetId === 'string' ? claim.boxAssetId : undefined,
    });
  }

  const boxes: FulfillmentOrderBox[] = boxItems
    .map((item) => {
      const claim = claimsByBoxId.get(item.refId);
      return {
        boxId: item.refId,
        assetId: item.assetId || claim?.boxAssetId,
        claimCode: claim?.code,
        dudeIds: Array.isArray(claim?.dudeIds) ? claim.dudeIds : [],
      };
    })
    .sort((a, b) => a.boxId - b.boxId);

  return {
    deliveryId,
    owner,
    status,
    createdAt: toMillisMaybe(order?.createdAt),
    processedAt: toMillisMaybe(order?.processedAt),
    fulfillmentStatus: normalizeFulfillmentStatus(order?.fulfillmentStatus),
    fulfillmentUpdatedAt: toMillisMaybe(order?.fulfillmentUpdatedAt),
    fulfillmentInternalStatus: typeof order?.fulfillmentInternalStatus === 'string' ? order.fulfillmentInternalStatus : undefined,
    address,
    boxes,
    looseDudes,
  };
}

function resolveInstructionAccounts(tx: any): PublicKey[] {
  if (!tx?.transaction?.message) return [];
  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const lookupWritable = (accountKeys?.accountKeysFromLookups?.writable || []).map((k: any) => new PublicKey(k));
  const lookupReadonly = (accountKeys?.accountKeysFromLookups?.readonly || []).map((k: any) => new PublicKey(k));
  const staticKeys = (accountKeys?.staticAccountKeys || []).map((k: any) => new PublicKey(k));
  return [...staticKeys, ...lookupWritable, ...lookupReadonly];
}

function getPayerFromTx(tx: any): PublicKey | null {
  const accounts = resolveInstructionAccounts(tx);
  return accounts.length ? accounts[0] : null;
}

type DeliveryRecoveryOutcome =
  | 'recovered'
  | 'failed'
  | 'lease_active'
  | 'attempt_capped'
  | 'not_eligible'
  | 'missing_delivery'
  | 'not_found'
  | 'skipped_status';

type RecoverMyDeliveryOrdersItemResult = {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
  outcome: DeliveryRecoveryOutcome;
  verification: 'delivery_pda';
  message?: string;
  errorCode?: string;
};

type RecoverMyDeliveryOrdersResult = {
  attempted: number;
  recovered: number;
  remainingProcessing: number;
  nextCheckAt?: number;
  results: RecoverMyDeliveryOrdersItemResult[];
};

type DeliveryRecoveryState = {
  nextCheckAt?: number;
};

type DeliveryOrderDoc = {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  data(): any;
};

function normalizeRecoveryErrorCode(err: unknown): string | undefined {
  const code = typeof (err as any)?.code === 'string' ? String((err as any).code) : '';
  const normalized = code.startsWith('functions/') ? code.slice('functions/'.length) : code;
  return normalized || undefined;
}

function normalizeRecoveryMessage(message: unknown): string | undefined {
  const value = String(message || '').trim();
  if (!value) return undefined;
  return value.slice(0, 300);
}

function processingDeliveryRecoveryReferenceMs(order: any): number {
  const createdAt = toMillisMaybe(order?.createdAt) ?? 0;
  const processingAt = toMillisMaybe(order?.processingAt) ?? 0;
  const lastAttemptAt = toMillisMaybe(order?.receiptRecovery?.lastAttemptAt) ?? 0;
  return Math.max(lastAttemptAt, processingAt, createdAt);
}

function preparedDeliveryRecoveryCheckCount(order: any): number {
  const raw = Number(order?.receiptRecovery?.preparedProbeCount || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function nextPreparedDeliveryRecoveryDelayMs(probeCount: number): number | null {
  return DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[probeCount] ?? null;
}

function preparedDeliveryRecoveryNextCheckMs(order: any): number | null {
  const probeCount = preparedDeliveryRecoveryCheckCount(order);
  if (probeCount >= MAX_PREPARED_DELIVERY_RECOVERY_CHECKS) return null;
  const scheduledAt = toMillisMaybe(order?.receiptRecovery?.nextPreparedProbeAt);
  if (scheduledAt && scheduledAt > 0) return scheduledAt;
  const createdAt = toMillisMaybe(order?.createdAt) ?? 0;
  if (createdAt <= 0) return Date.now();
  const initialDelayMs = nextPreparedDeliveryRecoveryDelayMs(probeCount) ?? 0;
  return createdAt + initialDelayMs;
}

function processingDeliveryRecoveryNextCheckMs(order: any, nowMs: number): number | null {
  const status = typeof order?.status === 'string' ? order.status : '';
  if (status !== 'processing') return null;
  const leaseExpiresAt = toMillisMaybe(order?.receiptRecovery?.leaseExpiresAt) ?? 0;
  const lastAttemptAt = toMillisMaybe(order?.receiptRecovery?.lastAttemptAt) ?? 0;
  const retryAt = lastAttemptAt > 0 ? lastAttemptAt + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS : nowMs;
  const nextCheckAt = Math.max(retryAt, leaseExpiresAt);
  return Math.max(nowMs, nextCheckAt);
}

function nextDeliveryRecoveryCheckMs(current: number | undefined, candidate: number | null): number | undefined {
  if (candidate == null || !Number.isFinite(candidate)) return current;
  if (current == null || candidate < current) return candidate;
  return current;
}

function deliveryRecoveryPriorityMs(order: any): number {
  const status = typeof order?.status === 'string' ? order.status : '';
  const createdAt = toMillisMaybe(order?.createdAt) ?? 0;
  if (status === 'processing') return processingDeliveryRecoveryReferenceMs(order);
  if (status === 'prepared') return preparedDeliveryRecoveryNextCheckMs(order) ?? createdAt;
  return createdAt;
}

function compareDeliveryRecoveryCandidates(left: DeliveryOrderDoc, right: DeliveryOrderDoc): number {
  const leftOrder = left.data() || {};
  const rightOrder = right.data() || {};
  const leftStatus = typeof leftOrder?.status === 'string' ? leftOrder.status : '';
  const rightStatus = typeof rightOrder?.status === 'string' ? rightOrder.status : '';
  if (leftStatus !== rightStatus) {
    if (leftStatus === 'processing') return -1;
    if (rightStatus === 'processing') return 1;
  }
  const leftPriority = deliveryRecoveryPriorityMs(leftOrder);
  const rightPriority = deliveryRecoveryPriorityMs(rightOrder);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.ref.path.localeCompare(right.ref.path);
}

function deliveryRecoveryEligibility(order: any, nowMs: number, force: boolean): {
  eligible: boolean;
  outcome?: DeliveryRecoveryOutcome;
  message?: string;
} {
  const status = typeof order?.status === 'string' ? order.status : 'unknown';
  if (status === 'processing') {
    if (force) return { eligible: true };
    const lastAttemptAt = toMillisMaybe(order?.receiptRecovery?.lastAttemptAt) ?? 0;
    if (lastAttemptAt > 0 && nowMs - lastAttemptAt < DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS) {
      return { eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active' };
    }
    return { eligible: true };
  }
  if (status === 'prepared') {
    if (force) return { eligible: true };
    const nextCheckAt = preparedDeliveryRecoveryNextCheckMs(order);
    if (nextCheckAt == null) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
    }
    if (nextCheckAt > nowMs) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order is not due for recovery yet' };
    }
    return { eligible: true };
  }
  if (status === 'prepared_abandoned') {
    if (force) return { eligible: true };
    return { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
  }
  return { eligible: false, outcome: 'skipped_status', message: `order status \`${status}\` is not recoverable` };
}

function orderResultBase(doc: DeliveryOrderDoc): {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
} | null {
  const order = doc.data() || {};
  const deliveryId = Number(order?.deliveryId ?? doc.id);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;
  const dropId = resolveDeliveryOrderDropId(order, doc.ref.path);
  if (!dropId) return null;
  return {
    dropId,
    deliveryId,
    statusBefore: typeof order?.status === 'string' ? order.status : 'unknown',
  };
}

async function listOwnedDeliveryOrdersByStatus(
  ownerWallet: string,
  status: 'prepared' | 'processing',
  filterDropId?: string,
): Promise<DeliveryOrderDoc[]> {
  const snap = await db
    .collectionGroup('deliveryOrders')
    .where('owner', '==', ownerWallet)
    .where('status', '==', status)
    .get();
  if (!filterDropId) return snap.docs;
  return snap.docs.filter((doc) => {
    const dropId = resolveDeliveryOrderDropId(doc.data(), doc.ref.path);
    return dropId === filterDropId;
  });
}

async function fetchConfirmedDeliveryRecordAccount(params: {
  dropRuntime: DropRuntime;
  conn: Connection;
  deliveryId: number;
  context: string;
  includeData?: boolean;
}) {
  const { dropRuntime, conn, deliveryId, context, includeData = true } = params;
  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  const deliveryInfo = await withTimeout(
    conn.getAccountInfo(
      expectedDeliveryPda,
      includeData ? { commitment: 'confirmed' } : { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
    ),
    RPC_TIMEOUT_MS,
    context,
  );
  if (!deliveryInfo) return null;
  if (!deliveryInfo.owner.equals(dropRuntime.boxMinterProgramId)) {
    throw new HttpsError('failed-precondition', 'Delivery record PDA is owned by the wrong program');
  }
  return { expectedDeliveryPda, expectedDeliveryBump, deliveryInfo };
}

async function hasConfirmedDeliveryRecord(dropId: string, deliveryId: number): Promise<boolean> {
  return hasConfirmedDeliveryRecordForDeliveryOrder({
    dropId,
    deliveryId,
  });
}

async function recordPreparedDeliveryRecoveryMiss(
  orderRef: FirebaseFirestore.DocumentReference,
  order: any,
  nowMs: number,
): Promise<number | null> {
  const probeCount = preparedDeliveryRecoveryCheckCount(order);
  const nextProbeCount = probeCount + 1;
  const nextDelayMs = nextPreparedDeliveryRecoveryDelayMs(nextProbeCount);
  await orderRef.update({
    'receiptRecovery.preparedProbeCount': nextProbeCount,
    'receiptRecovery.lastPreparedProbeAt': Timestamp.fromMillis(nowMs),
    'receiptRecovery.nextPreparedProbeAt':
      nextDelayMs != null ? Timestamp.fromMillis(nowMs + nextDelayMs) : FieldValue.delete(),
    ...(nextDelayMs == null ? { status: 'prepared_abandoned', preparedRecoveryAbandonedAt: Timestamp.fromMillis(nowMs) } : {}),
  });
  return nextDelayMs != null ? nowMs + nextDelayMs : null;
}

async function stopPreparedDeliveryRecoveryChecks(
  orderRef: FirebaseFirestore.DocumentReference,
  order: any,
  nowMs: number,
) {
  const probeCount = Math.max(preparedDeliveryRecoveryCheckCount(order), MAX_PREPARED_DELIVERY_RECOVERY_CHECKS);
  await orderRef.update({
    status: 'prepared_abandoned',
    preparedRecoveryAbandonedAt: Timestamp.fromMillis(nowMs),
    'receiptRecovery.preparedProbeCount': probeCount,
    'receiptRecovery.lastPreparedProbeAt': Timestamp.fromMillis(nowMs),
    'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
  });
}

async function fetchDeliveryRecoveryState(
  ownerWallet: string,
  filterDropId?: string,
): Promise<DeliveryRecoveryState & { remainingProcessing: number }> {
  const nowMs = Date.now();
  const [processingDocs, preparedDocs] = await Promise.all([
    listOwnedDeliveryOrdersByStatus(ownerWallet, 'processing', filterDropId),
    listOwnedDeliveryOrdersByStatus(ownerWallet, 'prepared', filterDropId),
  ]);

  let nextCheckAt: number | undefined;
  for (const doc of processingDocs) {
    nextCheckAt = nextDeliveryRecoveryCheckMs(nextCheckAt, processingDeliveryRecoveryNextCheckMs(doc.data(), nowMs));
  }
  for (const doc of preparedDocs) {
    nextCheckAt = nextDeliveryRecoveryCheckMs(nextCheckAt, preparedDeliveryRecoveryNextCheckMs(doc.data()));
  }

  return {
    remainingProcessing: processingDocs.length,
    ...(nextCheckAt != null ? { nextCheckAt } : {}),
  };
}

async function acquireDeliveryRecoveryLease(
  orderRef: FirebaseFirestore.DocumentReference,
  ownerWallet: string,
  nowMs: number,
  force: boolean,
): Promise<
  | { acquired: true }
  | {
      acquired: false;
      result: RecoverMyDeliveryOrdersItemResult;
    }
> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      const deliveryId = Number(orderRef.id);
      const dropId = dropIdFromDeliveryOrderPath(orderRef.path) || '';
      return {
        acquired: false as const,
        result: {
          dropId,
          deliveryId,
          statusBefore: 'missing',
          outcome: 'not_found' as const,
          verification: 'delivery_pda' as const,
          message: 'delivery order not found',
        },
      };
    }

    const order = snap.data() as any;
    const base = orderResultBase({
      id: snap.id,
      ref: snap.ref,
      data: () => order,
    });
    if (!base) {
      return {
        acquired: false as const,
        result: {
          dropId: '',
          deliveryId: Number(snap.id) || 0,
          statusBefore: typeof order?.status === 'string' ? order.status : 'unknown',
          outcome: 'failed' as const,
          verification: 'delivery_pda' as const,
          message: 'delivery order is missing recovery identifiers',
        },
      };
    }

    if (order?.owner && order.owner !== ownerWallet) {
      return {
        acquired: false as const,
        result: {
          ...base,
          outcome: 'failed' as const,
          verification: 'delivery_pda' as const,
          message: 'order belongs to a different wallet',
          errorCode: 'permission-denied',
        },
      };
    }

    const eligibility = deliveryRecoveryEligibility(order, nowMs, force);
    if (!eligibility.eligible) {
      return {
        acquired: false as const,
        result: {
          ...base,
          outcome: eligibility.outcome || 'not_eligible',
          verification: 'delivery_pda' as const,
          ...(eligibility.message ? { message: eligibility.message } : {}),
        },
      };
    }

    const leaseExpiresAt = toMillisMaybe(order?.receiptRecovery?.leaseExpiresAt) ?? 0;
    if (leaseExpiresAt > nowMs) {
      return {
        acquired: false as const,
        result: {
          ...base,
          outcome: 'lease_active' as const,
          verification: 'delivery_pda' as const,
          message: 'another client is already retrying this order',
        },
      };
    }

    const attemptCountRaw = Number(order?.receiptRecovery?.attemptCount || 0);
    const attemptCount = Number.isFinite(attemptCountRaw) && attemptCountRaw > 0 ? Math.floor(attemptCountRaw) + 1 : 1;
    tx.set(
      orderRef,
      {
        receiptRecovery: {
          leaseExpiresAt: Timestamp.fromMillis(nowMs + DELIVERY_RECOVERY_LEASE_MS),
          lastAttemptAt: Timestamp.fromMillis(nowMs),
          attemptCount,
        },
      },
      { merge: true },
    );
    return { acquired: true as const };
  });
}

async function finalizeDeliveryRecoveryAttempt(
  orderRef: FirebaseFirestore.DocumentReference,
  result: { errorCode?: string; message?: string },
) {
  await orderRef.update({
    'receiptRecovery.leaseExpiresAt': FieldValue.delete(),
    'receiptRecovery.lastErrorCode': result.errorCode ? result.errorCode : FieldValue.delete(),
    'receiptRecovery.lastErrorMessage': result.message ? result.message : FieldValue.delete(),
  });
}

async function buildProfileResponse(profileWallet: string, profileData: any, includeRecoveryState: boolean) {
  const [orders, deliveryRecoveryState] = await Promise.all([
    fetchDeliveryOrderHistory(profileWallet),
    includeRecoveryState ? fetchDeliveryRecoveryState(profileWallet) : Promise.resolve<DeliveryRecoveryState | null>(null),
  ]);
  const deliveryRecovery =
    deliveryRecoveryState?.nextCheckAt != null ? ({ nextCheckAt: deliveryRecoveryState.nextCheckAt } satisfies DeliveryRecoveryState) : null;

  return {
    profile: {
      ...profileData,
      wallet: profileWallet,
      email: profileData.email,
      orders,
      ...(deliveryRecovery ? { deliveryRecovery } : {}),
    },
  };
}

export const solanaAuth = onCallAuthed('solanaAuth', async (request, uid) => {
  const schema = z.object({
    wallet: z.string().min(32).max(64),
    message: z.string().min(1).max(1024),
    signature: z.array(z.number().int().min(0).max(255)).length(64),
  });
  const { wallet: rawWallet, message, signature } = parseRequest(schema, request.data);
  const wallet = normalizeWallet(rawWallet);

  const statement = parseSolanaSignInMessage(message);
  const statementWallet = normalizeWallet(statement.wallet);
  if (statementWallet !== wallet) {
    throw new HttpsError('invalid-argument', 'Wallet mismatch in signed message');
  }
  if (statement.session !== uid) {
    throw new HttpsError('permission-denied', 'Signed message does not match caller');
  }

  // Soft-ish sanity check: accept timestamps within ±2 days to avoid rejecting clients
  // with mildly incorrect clocks/timezones, while still preventing very stale replays.
  const tsMs = Date.parse(statement.timestamp);
  if (!Number.isFinite(tsMs)) {
    throw new HttpsError('invalid-argument', 'Invalid Timestamp in signed message');
  }
  const MAX_SKEW_MS = 2 * 24 * 60 * 60 * 1000;
  const skewMs = Math.abs(Date.now() - tsMs);
  if (skewMs > MAX_SKEW_MS) {
    throw new HttpsError('failed-precondition', 'Signed message timestamp is too far from current time');
  }

  const pubkey = new PublicKey(wallet);
  const verified = nacl.sign.detached.verify(new TextEncoder().encode(message), parseSignature(signature), pubkey.toBytes());
  if (!verified) throw new HttpsError('unauthenticated', 'Invalid signature');

  await db.doc(`${WALLET_SESSION_COLLECTION}/${uid}`).set(
    {
      wallet,
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + WALLET_SESSION_TTL_MS),
    },
    { merge: true },
  );

  const profileRef = db.doc(`profiles/${wallet}`);
  const snap = await profileRef.get();
  const profileData = snap.exists ? (snap.data() as any) : {};
  if (!snap.exists) await profileRef.set({ wallet }, { merge: true });
  return buildProfileResponse(wallet, profileData, true);
});

export const getProfile = onCallLogged('getProfile', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    ownerWallet: z.string().optional(),
  });
  const { ownerWallet: rawOwnerWallet } = parseRequest(schema, request.data || {});

  let profileWallet = wallet;
  if (typeof rawOwnerWallet === 'string' && rawOwnerWallet.trim()) {
    const requestedWallet = normalizeWallet(rawOwnerWallet.trim());
    if (requestedWallet !== wallet) {
      await requireAdminAccess(request);
    }
    profileWallet = requestedWallet;
  }

  const profileRef = db.doc(`profiles/${profileWallet}`);
  const snap = await profileRef.get();
  const profileData = snap.exists ? (snap.data() as any) : {};
  if (!snap.exists && profileWallet === wallet) {
    await profileRef.set({ wallet: profileWallet }, { merge: true });
  }
  return buildProfileResponse(profileWallet, profileData, profileWallet === wallet);
});

export const listDeliveryOrderOwners = onCallLogged('listDeliveryOrderOwners', async (request) => {
  await requireAdminAccess(request);
  const schema = z.object({
    cursor: z.string().min(1).max(2000).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
  });
  const { cursor: rawCursor, pageSize: rawPageSize } = parseRequest(schema, request.data || {});
  const owners: string[] = [];
  const seenOwners = new Set<string>();
  let cursor = parseDeliveryOrderOwnersCursor(rawCursor);
  const pageSize = rawPageSize ?? 200;
  const fetchLimit = Math.min(Math.max(pageSize * 3, pageSize + 1), 500);
  let hasMore = false;

  while (owners.length < pageSize) {
    let query = db
      .collectionGroup('deliveryOrders')
      .select('owner')
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(fetchLimit);
    if (cursor) {
      query = query.startAfter(cursor.path);
    }

    const snap = await query.get();
    if (snap.empty) {
      hasMore = false;
      cursor = null;
      break;
    }

    let lastProcessedCursor: DeliveryOrderOwnersCursor | null = null;
    let lastProcessedIndex = -1;
    for (let index = 0; index < snap.docs.length; index += 1) {
      const doc = snap.docs[index];
      lastProcessedCursor = { path: doc.ref.path };
      lastProcessedIndex = index;
      const rawOwner = doc.get('owner');

      if (typeof rawOwner !== 'string' || !rawOwner.trim()) continue;
      try {
        const owner = normalizeWallet(rawOwner.trim());
        if (seenOwners.has(owner)) continue;
        seenOwners.add(owner);
        owners.push(owner);
        if (owners.length >= pageSize) break;
      } catch {
        // Ignore malformed historical values.
      }
    }

    if (!lastProcessedCursor || lastProcessedIndex < 0) {
      hasMore = false;
      cursor = null;
      break;
    }

    cursor = lastProcessedCursor;
    const endedEarly = lastProcessedIndex < snap.docs.length - 1;
    if (owners.length >= pageSize) {
      hasMore = endedEarly || snap.size === fetchLimit;
      break;
    }

    if (snap.size < fetchLimit) {
      hasMore = false;
      cursor = null;
      break;
    }

    hasMore = true;
  }

  const nextCursor = hasMore && cursor ? encodeDeliveryOrderOwnersCursor(cursor) : null;
  return {
    owners,
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
});

export const saveAddress = onCallLogged('saveAddress', async (request) => {
  const { wallet } = await requireWalletSession(request);

  // Reject obviously oversized payloads early to reduce Firestore doc size/cost risk.
  const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
  const rawBytes = safeJsonByteLength((request as any)?.data);
  if (!Number.isFinite(rawBytes) || rawBytes > MAX_SAVE_ADDRESS_BYTES) {
    throw new HttpsError('invalid-argument', 'Request payload too large');
  }

  const schema = z.object({
    encrypted: z.string().max(4096),
    country: z.string().max(64),
    countryCode: z.string().max(32).optional(),
    hint: z.string().max(256),
    email: z.string().email().max(254).optional(),
  });
  const body = parseRequest(schema, request.data);
  const id = db.collection('tmp').doc().id;
  const countryCode = normalizeCountryCode(body.countryCode || body.country);
  const addressRef = db.doc(`profiles/${wallet}/addresses/${id}`);
  await addressRef.set(
    {
      ...body,
      countryCode: countryCode || body.countryCode,
      id,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await db.doc(`profiles/${wallet}`).set(
    { wallet, ...(body.email ? { email: body.email } : {}) },
    { merge: true },
  );
  return {
    id,
    country: body.country,
    countryCode: countryCode || body.countryCode,
    encrypted: body.encrypted,
    hint: body.hint,
    email: body.email,
  };
});

export const removeAddress = onCallLogged('removeAddress', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    addressId: z.string().min(4).max(128).regex(/^[A-Za-z0-9_-]+$/),
  });
  const { addressId } = parseRequest(schema, request.data);
  const addressRef = db.doc(`profiles/${wallet}/addresses/${addressId}`);
  const snap = await addressRef.get();
  if (!snap.exists) {
    return { id: addressId, removed: false };
  }
  await addressRef.delete();
  return { id: addressId, removed: true };
});

export const listFulfillmentOrders = onCallLogged(
  'listFulfillmentOrders',
  async (request) => {
    const schema = z.object({
      dropId: z.string().min(1).max(64),
      limit: z.number().int().min(1).max(FULFILLMENT_ORDER_LIMIT).optional(),
      cursor: z
        .object({
          processedAt: z.object({
            seconds: z.number().int().min(0),
            nanos: z.number().int().min(0).max(999_999_999),
          }),
          id: z.string().min(1).max(128),
        })
        .nullable()
        .optional(),
    });
    const { dropId: requestDropId, limit = FULFILLMENT_ORDER_LIMIT, cursor } = parseRequest(schema, request.data);
    const dropId = requireDropId(requestDropId);
    const { wallet } = await requireFulfillmentDropAccess(request, dropId);
    const allowSensitiveAddressView = canViewSensitiveFulfillmentAddress(wallet, dropId);

    let query = db
      .collection(dropDeliveryOrdersCollectionPath(dropId))
      .where('status', '==', 'ready_to_ship')
      .orderBy('processedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit + 1);

    if (cursor) {
      const ts = new Timestamp(cursor.processedAt.seconds, cursor.processedAt.nanos);
      query = query.startAfter(ts, cursor.id);
    }

    const snap = await query.get();
    const hasMore = snap.docs.length > limit;
    const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs;
    const orders = pageDocs
      .map((doc) => toFulfillmentOrder(doc.id, doc.data(), { canViewSensitiveAddress: allowSensitiveAddressView }))
      .filter((entry): entry is FulfillmentOrder => Boolean(entry));

    const last = hasMore ? pageDocs[pageDocs.length - 1] : null;
    const lastProcessedAt = last ? last.get('processedAt') : null;
    const lastSeconds = typeof lastProcessedAt?.seconds === 'number' ? lastProcessedAt.seconds : null;
    const lastNanos = typeof lastProcessedAt?.nanoseconds === 'number' ? lastProcessedAt.nanoseconds : null;
    const nextCursor =
      hasMore && last && lastSeconds != null && lastNanos != null
        ? { processedAt: { seconds: lastSeconds, nanos: lastNanos }, id: last.id }
        : null;

    return { orders, nextCursor };
  },
  { secrets: [ADDRESS_DECRYPTION_SECRET] },
);

export const updateFulfillmentStatus = onCallLogged('updateFulfillmentStatus', async (request) => {
  const schema = z.object({
    dropId: z.string().min(1).max(64),
    deliveryId: z.number().int().positive(),
    status: z.union([z.enum(FULFILLMENT_STATUS_OPTIONS), z.literal(''), z.null()]),
  });
  const { dropId: requestDropId, deliveryId, status } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const { wallet } = await requireFulfillmentDropAccess(request, dropId);
  const nextStatus = status || '';

  const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }

  const update: Record<string, unknown> = {
    dropId,
    fulfillmentUpdatedAt: FieldValue.serverTimestamp(),
    fulfillmentUpdatedBy: wallet,
  };
  if (nextStatus) {
    update.fulfillmentStatus = nextStatus;
  } else {
    update.fulfillmentStatus = FieldValue.delete();
  }

  await orderRef.set(update, { merge: true });
  return { deliveryId, fulfillmentStatus: nextStatus };
});

export const updateFulfillmentInternalStatus = onCallLogged('updateFulfillmentInternalStatus', async (request) => {
  const schema = z.object({
    dropId: z.string().min(1).max(64),
    deliveryId: z.number().int().positive(),
    status: z.enum(['🟢', '🟡', '🔴', '🏁']),
  });
  const { dropId: requestDropId, deliveryId, status } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const { wallet } = await requireFulfillmentDropAccess(request, dropId);

  const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }

  await orderRef.set(
    {
      dropId,
      fulfillmentInternalStatus: status,
      fulfillmentInternalUpdatedAt: FieldValue.serverTimestamp(),
      fulfillmentInternalUpdatedBy: wallet,
    },
    { merge: true },
  );

  return { deliveryId, fulfillmentInternalStatus: status };
});

export const revealDudes = onCallLogged(
  'revealDudes',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), boxAssetId: z.string(), dropId: z.string().min(1).max(64) });
  const { owner, boxAssetId, dropId: requestDropId } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const dropRuntime = getDropRuntime(dropId);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  await ensureOnchainCoreConfig(dropRuntime);

  let boxAssetPk: PublicKey;
  try {
    boxAssetPk = new PublicKey(boxAssetId);
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid boxAssetId');
  }

  const conn = connection(dropRuntime);

  // Load on-chain config and enforce server cosigner matches on-chain admin.
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig:reveal',
  });
  const cfgAdmin = cfg.admin;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');
  if (!dropRuntime.collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: dropRuntime.collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
      dropId,
    });
  }

  // Read pending open record from chain.
  const programId = dropRuntime.boxMinterProgramId;
  const pendingPda = PublicKey.findProgramAddressSync([Buffer.from('open'), boxAssetPk.toBuffer()], programId)[0];
  const pendingInfo = await withTimeout(
    conn.getAccountInfo(pendingPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:pendingOpenBox',
  );
  if (!pendingInfo?.data) {
    throw new HttpsError(
      'not-found',
      'Pending open not found. Start opening the box first (send it to the vault), then reveal.',
      { pending: pendingPda.toBase58(), boxAssetId },
    );
  }
  const pending = decodePendingOpenBox(pendingInfo.data);
  if (!pending.owner.equals(ownerPk) || !pending.boxAsset.equals(boxAssetPk)) {
    throw new HttpsError('permission-denied', 'Pending open belongs to a different wallet', {
      owner: ownerWallet,
      pendingOwner: pending.owner.toBase58(),
      boxAssetId,
      pending: pendingPda.toBase58(),
    });
  }
  if (pending.dudeAssets.length !== dropRuntime.itemsPerBox) {
    throw new HttpsError(
      'failed-precondition',
      `Pending open has invalid figure placeholder count (expected ${dropRuntime.itemsPerBox})`,
      {
        pending: pendingPda.toBase58(),
        boxAssetId,
        expected: dropRuntime.itemsPerBox,
        actual: pending.dudeAssets.length,
        dropId,
      },
    );
  }

  if (pending.config && !pending.config.equals(dropRuntime.boxMinterConfigPda)) {
    throw new HttpsError('failed-precondition', 'Pending open belongs to a different drop config', {
      boxAssetId,
      dropId,
      pending: pendingPda.toBase58(),
      pendingConfig: pending.config.toBase58(),
      expectedConfig: dropRuntime.boxMinterConfigPda.toBase58(),
    });
  }

  if (!pending.config && requiresRevealAssetDisambiguation(dropRuntime)) {
    const boxAsset = await fetchAssetRetry(boxAssetId, dropRuntime);
    if (getAssetKind(boxAsset) !== 'box') {
      throw new HttpsError('failed-precondition', 'Pending open asset is not a box', {
        boxAssetId,
        dropId,
        pending: pendingPda.toBase58(),
      });
    }
    if (!assetMatchesDropRuntime(boxAsset, dropRuntime)) {
      throw new HttpsError('failed-precondition', 'Box asset does not belong to the requested drop', {
        boxAssetId,
        dropId,
        pending: pendingPda.toBase58(),
        metadataBase: metadataBaseFromAsset(boxAsset),
      });
    }
  }

  // Assign dudes NOW (after the box has already been transferred away); keep this admin-only.
  const dudeIds = await assignDudes(dropId, boxAssetId);

  const finalizeIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: boxAssetPk, isSigner: false, isWritable: true },
      { pubkey: cfgCoreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pendingPda, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: false, isWritable: false },
      ...pending.dudeAssets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeFinalizeOpenBoxArgs(dudeIds, dropRuntime),
  });

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    finalizeIx,
  ];

  const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash:revealDudes');
  const tx = buildTx(instructions, signer.publicKey, blockhash, [signer]);

  const sig = await sendAndConfirmSignedTx(conn, tx, 'revealDudes');

  return { signature: sig, dudeIds };
  },
  { secrets: [COSIGNER_SECRET] },
);

export const prepareDeliveryTx = onCallLogged(
  'prepareDeliveryTx',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    owner: z.string(),
    itemIds: z.array(z.string()).min(1),
    addressId: z.string(),
    dropId: z.string().min(1).max(64),
  });
  const { owner, itemIds, addressId, dropId: requestDropId } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const dropRuntime = getDropRuntime(dropId);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');

  await ensureOnchainCoreConfig(dropRuntime);

  const uniqueItemIds = Array.from(new Set(itemIds));
  if (uniqueItemIds.length !== itemIds.length) {
    throw new HttpsError('invalid-argument', 'Duplicate itemIds are not allowed');
  }

  // Keep this comfortably above realistic tx-size limits while preventing accidental huge requests.
  if (uniqueItemIds.length > MAX_DELIVERY_ITEMS) {
    throw new HttpsError('invalid-argument', `Too many items in one delivery request (max ${MAX_DELIVERY_ITEMS})`);
  }

  const addressSnap = await db.doc(`profiles/${wallet}/addresses/${addressId}`).get();
  if (!addressSnap.exists) {
    throw new HttpsError('not-found', 'Address not found');
  }
  const addressData = addressSnap.data();
  const normalizedAddressCountry = normalizeCountryCode(addressData?.countryCode || addressData?.country);
  const addressCountry = normalizedAddressCountry || addressData?.countryCode || addressData?.country || '';

  // Validate assets are deliverable Mons items owned by the wallet.
  const assetPks: PublicKey[] = [];
  const orderItems: Array<{ assetId: string; kind: 'box' | 'dude'; refId: number }> = [];
  for (const assetId of uniqueItemIds) {
    let pk: PublicKey;
    try {
      pk = new PublicKey(assetId);
    } catch {
      throw new HttpsError('invalid-argument', 'Invalid asset id');
    }
    assetPks.push(pk);

    const asset = await fetchAssetRetry(assetId, dropRuntime);
    const kind = getAssetKind(asset);
    if (!kind) throw new HttpsError('failed-precondition', 'Unsupported asset type');
    if (kind === 'certificate') {
      throw new HttpsError('failed-precondition', 'Certificates cannot be delivered');
    }
    if (!assetMatchesRequestedDrop(asset, dropRuntime)) {
      throw new HttpsError('failed-precondition', 'Item does not belong to the requested drop');
    }
    const assetOwner = asset?.ownership?.owner;
    if (assetOwner !== ownerWallet) {
      throw new HttpsError('failed-precondition', 'Item not owned by wallet');
    }

    if (kind === 'box') {
      const boxIdStr = getBoxIdFromAsset(asset);
      const refId = Number(boxIdStr);
      if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
        throw new HttpsError('failed-precondition', 'Box id missing from metadata');
      }
      orderItems.push({
        assetId,
        kind: 'box',
        refId,
      });
    } else {
      const dudeId = getDudeIdFromAsset(asset);
      const refId = Number(dudeId);
      if (!Number.isFinite(refId) || refId <= 0 || refId > dropRuntime.maxDudeId) {
        throw new HttpsError('failed-precondition', 'Dude id missing from metadata');
      }
      orderItems.push({
        assetId,
        kind: 'dude',
        refId,
      });
    }
  }

  const deliveryLamports = calculateDeliveryLamports(
    orderItems,
    addressCountry,
    dropRuntime.itemsPerBox,
    dropRuntime.config.dropFamily,
  );
  const conn = connection(dropRuntime);

  // Ensure COSIGNER_SECRET matches on-chain admin, and COLLECTION_MINT matches configured core collection.
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig',
  });
  const cfgAdmin = cfg.admin;
  const cfgTreasury = cfg.treasury;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');
  if (!dropRuntime.collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: dropRuntime.collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
      dropId,
    });
  }

  const programId = dropRuntime.boxMinterProgramId;
  const ownerPk = new PublicKey(ownerWallet);
  const addressLookupTables = await getDeliveryLookupTable(conn, dropRuntime);

  // Allocate a unique, compact delivery id and its on-chain PDA.
  // IMPORTANT: we atomically reserve the Firestore doc via `create()` to avoid TOCTOU collisions under concurrency.
  const MAX_RAW_TX_BYTES = 1232;
  const MAX_DELIVERY_ID_ATTEMPTS = 16;
  const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

  for (let attempt = 0; attempt < MAX_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const [deliveryPda, deliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, candidate);

    const chainInfo = await withTimeout(
      conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
      RPC_TIMEOUT_MS,
      'getAccountInfo:deliveryPda',
    );
    if (chainInfo) continue;

    const deliverIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ownerPk, isSigner: true, isWritable: true },
        { pubkey: cfgTreasury, isSigner: false, isWritable: true },
        { pubkey: cfgCoreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        ...assetPks.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: encodeDeliverArgs({ deliveryId: candidate, feeLamports: deliveryLamports, deliveryBump }),
    });

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      deliverIx,
    ];

    // NOTE: use a dummy blockhash for the size check; it keeps the prepared transaction's real blockhash as fresh as possible.
    const sizeTx = buildTx(instructions, ownerPk, DUMMY_BLOCKHASH, [signer], addressLookupTables);
    const raw = sizeTx.serialize();

    if (raw.length > MAX_RAW_TX_BYTES) {
      let maxFit = 0;
      for (let n = assetPks.length - 1; n >= 1; n -= 1) {
        const candidateIx = new TransactionInstruction({
          programId,
          keys: [
            { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
            { pubkey: signer.publicKey, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: cfgTreasury, isSigner: false, isWritable: true },
            { pubkey: cfgCoreCollection, isSigner: false, isWritable: false },
            { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: deliveryPda, isSigner: false, isWritable: true },
            ...assetPks.slice(0, n).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
          ],
          data: encodeDeliverArgs({ deliveryId: candidate, feeLamports: deliveryLamports, deliveryBump }),
        });
        const candidateTx = buildTx(
          [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), candidateIx],
          ownerPk,
          DUMMY_BLOCKHASH,
          [signer],
          addressLookupTables,
        );
        if (candidateTx.serialize().length <= MAX_RAW_TX_BYTES) {
          maxFit = n;
          break;
        }
      }
      throw new HttpsError(
        'failed-precondition',
        `Delivery transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}). Try fewer items.` +
          (maxFit ? ` Estimated max that fits: ${maxFit}.` : ' Try 1 item.'),
        { rawBytes: raw.length, maxRawBytes: MAX_RAW_TX_BYTES, items: assetPks.length, maxFit },
      );
    }

    const orderRef = db.doc(dropDeliveryOrderPath(dropId, candidate));
    const nowMs = Date.now();
    try {
      await db.runTransaction(async (t) => {
        t.create(orderRef, {
          dropId,
          status: 'prepared',
          owner: ownerWallet,
          addressId,
          addressSnapshot: {
            ...addressData,
            id: addressId,
            countryCode: addressCountry || addressData?.countryCode,
          },
          itemIds: uniqueItemIds,
          items: orderItems,
          deliveryId: candidate,
          deliveryPda: deliveryPda.toBase58(),
          ...(dropRuntime.deliveryLookupTableStr ? { lookupTable: dropRuntime.deliveryLookupTableStr } : {}),
          deliveryLamports,
          createdAt: FieldValue.serverTimestamp(),
          receiptRecovery: {
            preparedProbeCount: 0,
            nextPreparedProbeAt: Timestamp.fromMillis(nowMs + DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[0]),
          },
        });
      });
    } catch (err) {
      if (isGrpcAlreadyExists(err)) continue;
      throw err;
    }

    try {
      const { blockhash } = await withTimeout(
        conn.getLatestBlockhash('confirmed'),
        RPC_TIMEOUT_MS,
        'getLatestBlockhash:prepareDeliveryTx',
      );
      const solanaTx = buildTx(instructions, ownerPk, blockhash, [signer], addressLookupTables);
      const rawTx = solanaTx.serialize();
      return { encodedTx: Buffer.from(rawTx).toString('base64'), deliveryLamports, deliveryId: candidate };
    } catch (err) {
      // If we fail after reserving the order doc (e.g. RPC timeout fetching blockhash),
      // clean up to avoid leaving orphan "prepared" orders around.
      try {
        await orderRef.delete();
      } catch (cleanupErr) {
        console.error('[mons/functions] prepareDeliveryTx cleanup failed', summarizeError(cleanupErr), { deliveryId: candidate });
      }
      throw err;
    }
  }

  throw new HttpsError('unavailable', 'Failed to allocate delivery id (try again)');
  },
  { secrets: [COSIGNER_SECRET] },
);

export type RetryIssueReceiptsArgs = {
  ownerWallet: string;
  deliveryId: number;
  dropId: string;
} & ({ verification: 'signature'; signature: string } | { verification: 'delivery_pda' });

export type RetryIssueReceiptsResult = {
  processed: true;
  deliveryId: number;
  receiptsMinted: number;
  receiptTxs: string[];
  closeDeliveryTx: string | null;
};

type VerifiedReceiptIssuanceTarget = {
  verification: 'signature' | 'delivery_pda';
  signature: string | null;
  expectedDeliveryPda: PublicKey;
  expectedDeliveryBump: number;
  targetAssetIds: string[];
};

export type FindConfirmedDeliverySignatureArgs = {
  ownerWallet: string;
  deliveryId: number;
  dropId: string;
  deliveryPda?: string | null;
  itemIds?: string[] | null;
  limit?: number;
};

export type HasConfirmedDeliveryRecordForDeliveryOrderArgs = {
  deliveryId: number;
  dropId: string;
  deliveryPda?: string | null;
};

type DeliverySignatureProbeFailureReason =
  | 'transaction_not_found_or_failed'
  | 'missing_target_deliver_instruction'
  | 'payer_mismatch'
  | 'delivery_id_mismatch'
  | 'delivery_pda_mismatch'
  | 'item_count_mismatch'
  | 'asset_list_mismatch'
  | 'missing_delivered_item_ids';

const IGNORABLE_DELIVERY_SIGNATURE_PROBE_FAILURES = new Set<DeliverySignatureProbeFailureReason>([
  'transaction_not_found_or_failed',
  'missing_target_deliver_instruction',
]);

function storedDeliverySignature(order: any): string | null {
  const signature = typeof order?.deliverySignature === 'string' ? order.deliverySignature.trim() : '';
  return signature || null;
}

function requirePositiveDeliveryId(rawDeliveryId: unknown): number {
  const deliveryId = Math.floor(Number(rawDeliveryId));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    throw new HttpsError('invalid-argument', 'deliveryId must be a positive integer');
  }
  return deliveryId;
}

function assertStoredDeliveryPdaMatchesExpected(storedDeliveryPda: unknown, expectedDeliveryPda: PublicKey) {
  const storedPda = typeof storedDeliveryPda === 'string' ? storedDeliveryPda.trim() : '';
  if (!storedPda) return;

  const expectedPda = expectedDeliveryPda.toBase58();
  if (storedPda !== expectedPda) {
    throw new HttpsError('failed-precondition', 'Stored delivery PDA does not match the expected delivery PDA', {
      expected: expectedPda,
      got: storedPda,
    });
  }
}

function deliverySignatureProbeFailedPrecondition(
  reason: DeliverySignatureProbeFailureReason,
  message: string,
  details?: Record<string, unknown>,
): HttpsError {
  return new HttpsError('failed-precondition', message, { ...(details || {}), reason });
}

function isIgnorableDeliverySignatureProbeError(err: unknown): boolean {
  const anyErr = err as any;
  if (anyErr?.code !== 'failed-precondition') return false;
  const reason = typeof anyErr?.details?.reason === 'string' ? anyErr.details.reason : '';
  return IGNORABLE_DELIVERY_SIGNATURE_PROBE_FAILURES.has(reason as DeliverySignatureProbeFailureReason);
}

export async function findConfirmedDeliverySignatureForDeliveryOrder(
  args: FindConfirmedDeliverySignatureArgs,
): Promise<string | null> {
  const ownerWallet = normalizeWallet(args.ownerWallet);
  const deliveryId = requirePositiveDeliveryId(args.deliveryId);
  const dropId = requireDropId(args.dropId);
  const dropRuntime = getDropRuntime(dropId);
  const conn = connection(dropRuntime);
  const [expectedDeliveryPda] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  assertStoredDeliveryPdaMatchesExpected(args.deliveryPda, expectedDeliveryPda);

  const itemIds = Array.isArray(args.itemIds) ? args.itemIds.filter((id): id is string => typeof id === 'string' && !!id) : [];
  const rawLimit = Math.floor(Number(args.limit ?? 100));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
  let remaining = limit;
  let before: string | undefined;

  while (remaining > 0) {
    const pageLimit = Math.min(remaining, 100);
    const sigInfos = await withTimeout(
      conn.getSignaturesForAddress(expectedDeliveryPda, before ? { before, limit: pageLimit } : { limit: pageLimit }),
      RPC_TIMEOUT_MS,
      'getSignaturesForAddress:deliveryPda',
    );
    if (!sigInfos.length) break;

    for (const sigInfo of sigInfos) {
      if (sigInfo?.err) continue;
      const signature = typeof sigInfo?.signature === 'string' ? sigInfo.signature.trim() : '';
      if (!signature) continue;

      try {
        await verifyReceiptIssuanceBySignature({
          order: itemIds.length ? { itemIds } : {},
          ownerWallet,
          deliveryId,
          signature,
          dropRuntime,
          conn,
        });
        return signature;
      } catch (err) {
        if (isIgnorableDeliverySignatureProbeError(err)) continue;
        throw err;
      }
    }

    remaining -= sigInfos.length;
    if (sigInfos.length < pageLimit) break;
    const lastSignature = typeof sigInfos[sigInfos.length - 1]?.signature === 'string' ? sigInfos[sigInfos.length - 1]?.signature.trim() : '';
    if (!lastSignature) break;
    before = lastSignature;
  }

  return null;
}

export async function hasConfirmedDeliveryRecordForDeliveryOrder(
  args: HasConfirmedDeliveryRecordForDeliveryOrderArgs,
): Promise<boolean> {
  const deliveryId = requirePositiveDeliveryId(args.deliveryId);
  const dropId = requireDropId(args.dropId);
  const dropRuntime = getDropRuntime(dropId);
  const conn = connection(dropRuntime);
  const [expectedDeliveryPda] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  assertStoredDeliveryPdaMatchesExpected(args.deliveryPda, expectedDeliveryPda);
  const deliveryRecord = await fetchConfirmedDeliveryRecordAccount({
    dropRuntime,
    conn,
    deliveryId,
    context: 'getAccountInfo:deliveryPda:scriptProbe',
    includeData: false,
  });
  return Boolean(deliveryRecord);
}

async function verifyReceiptIssuanceBySignature(params: {
  order: any;
  ownerWallet: string;
  deliveryId: number;
  signature: string;
  dropRuntime: DropRuntime;
  conn: Connection;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const { order, ownerWallet, deliveryId, signature, dropRuntime, conn } = params;
  const tx = await withTimeout(
    conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction:delivery',
  );
  if (!tx || tx.meta?.err) {
    throw deliverySignatureProbeFailedPrecondition('transaction_not_found_or_failed', 'Delivery transaction not found or failed');
  }

  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  const keys = resolveInstructionAccounts(tx);
  const FIXED_DELIVER_ACCOUNTS = 9;
  const deliverIxs = (tx?.transaction?.message?.compiledInstructions || []).filter((ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(dropRuntime.boxMinterProgramId)) return false;
    const dataField = (ix as any).data;
    const dataBuffer = typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
    return dataBuffer.subarray(0, 8).equals(IX_DELIVER);
  });
  let deliverIx: any = null;
  let deliverIxAccounts: PublicKey[] = [];
  for (const candidateIx of deliverIxs) {
    const accountKeyIndexesRaw: any = (candidateIx as any).accountKeyIndexes;
    const accountKeyIndexes: number[] = Array.isArray(accountKeyIndexesRaw)
      ? (accountKeyIndexesRaw as number[])
      : Array.from(accountKeyIndexesRaw || []);
    const ixAccounts = accountKeyIndexes.map((idx: number) => keys[idx]);
    if (ixAccounts.length < FIXED_DELIVER_ACCOUNTS) continue;
    if (ixAccounts[8]?.equals(expectedDeliveryPda)) {
      deliverIx = candidateIx;
      deliverIxAccounts = ixAccounts;
      break;
    }
  }
  if (!deliverIx) {
    throw deliverySignatureProbeFailedPrecondition(
      'missing_target_deliver_instruction',
      'Delivery transaction is missing a deliver instruction for the expected delivery PDA',
    );
  }

  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== ownerWallet) {
    throw deliverySignatureProbeFailedPrecondition('payer_mismatch', 'Signature payer does not match owner');
  }

  const deliverDataField = (deliverIx as any).data;
  const deliverData =
    typeof deliverDataField === 'string' ? Buffer.from(bs58.decode(deliverDataField)) : Buffer.from(deliverDataField || []);
  const decoded = decodeDeliverArgs(deliverData);
  if (decoded.deliveryId !== deliveryId) {
    throw deliverySignatureProbeFailedPrecondition('delivery_id_mismatch', 'Delivery id mismatch', {
      expectedId: deliveryId,
      got: decoded.deliveryId,
    });
  }

  const deliveryPdaFromIx = deliverIxAccounts[8];
  if (!deliveryPdaFromIx?.equals(expectedDeliveryPda)) {
    throw deliverySignatureProbeFailedPrecondition('delivery_pda_mismatch', 'Delivery PDA mismatch', {
      expected: expectedDeliveryPda.toBase58(),
      got: deliveryPdaFromIx?.toBase58(),
    });
  }

  const itemIds: string[] = Array.isArray(order?.itemIds) ? order.itemIds : [];
  const deliveredAssetsFromIx = deliverIxAccounts.slice(FIXED_DELIVER_ACCOUNTS).map((k: PublicKey) => k.toBase58());
  if (itemIds.length && deliveredAssetsFromIx.length && itemIds.length !== deliveredAssetsFromIx.length) {
    throw deliverySignatureProbeFailedPrecondition('item_count_mismatch', 'Delivery item count mismatch', {
      expected: itemIds.length,
      got: deliveredAssetsFromIx.length,
    });
  }
  if (itemIds.length) {
    for (let i = 0; i < itemIds.length; i += 1) {
      if (deliveredAssetsFromIx[i] && deliveredAssetsFromIx[i] !== itemIds[i]) {
        throw deliverySignatureProbeFailedPrecondition('asset_list_mismatch', 'Delivered asset list mismatch', {
          index: i,
          expected: itemIds[i],
          got: deliveredAssetsFromIx[i],
        });
      }
    }
  }

  const targetAssetIds = itemIds.length ? itemIds : deliveredAssetsFromIx;
  if (!targetAssetIds.length) {
    throw deliverySignatureProbeFailedPrecondition(
      'missing_delivered_item_ids',
      'Delivery order is missing delivered item ids',
    );
  }

  return {
    verification: 'signature',
    signature,
    expectedDeliveryPda,
    expectedDeliveryBump,
    targetAssetIds,
  };
}

async function verifyReceiptIssuanceByDeliveryRecord(params: {
  order: any;
  ownerWallet: string;
  deliveryId: number;
  dropRuntime: DropRuntime;
  conn: Connection;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const { order, ownerWallet, deliveryId, dropRuntime, conn } = params;
  const itemIds: string[] = Array.isArray(order?.itemIds) ? order.itemIds.filter((id: any) => typeof id === 'string' && id) : [];
  if (!itemIds.length) {
    throw new HttpsError('failed-precondition', 'Delivery order is missing itemIds for recovery');
  }

  const deliveryRecordAccount = await fetchConfirmedDeliveryRecordAccount({
    dropRuntime,
    conn,
    deliveryId,
    context: 'getAccountInfo:deliveryPda:recovery',
  });
  if (!deliveryRecordAccount) {
    throw new HttpsError('failed-precondition', 'Delivery record PDA not found');
  }
  const { expectedDeliveryPda, expectedDeliveryBump, deliveryInfo } = deliveryRecordAccount;
  assertStoredDeliveryPdaMatchesExpected(order?.deliveryPda, expectedDeliveryPda);

  const deliveryRecord = decodeDeliveryRecord(Buffer.from(deliveryInfo.data));
  if (deliveryRecord.payer.toBase58() !== ownerWallet) {
    throw new HttpsError('failed-precondition', 'Delivery record payer does not match owner');
  }
  if (deliveryRecord.itemCount !== itemIds.length) {
    throw new HttpsError('failed-precondition', 'Delivery record item count mismatch', {
      expected: itemIds.length,
      got: deliveryRecord.itemCount,
    });
  }

  const expectedLamports = Number(order?.deliveryLamports);
  if (Number.isFinite(expectedLamports) && expectedLamports >= 0 && deliveryRecord.deliveryFeeLamports !== expectedLamports) {
    throw new HttpsError('failed-precondition', 'Delivery record fee mismatch', {
      expected: expectedLamports,
      got: deliveryRecord.deliveryFeeLamports,
    });
  }

  return {
    verification: 'delivery_pda',
    signature: storedDeliverySignature(order),
    expectedDeliveryPda,
    expectedDeliveryBump,
    targetAssetIds: itemIds,
  };
}

async function verifyReceiptIssuanceTarget(params: {
  args: RetryIssueReceiptsArgs;
  order: any;
  ownerWallet: string;
  deliveryId: number;
  dropRuntime: DropRuntime;
  conn: Connection;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const { args, order, ownerWallet, deliveryId, dropRuntime, conn } = params;
  if (args.verification === 'signature') {
    const signature = String(args.signature || '').trim();
    if (!signature) {
      throw new HttpsError('invalid-argument', 'signature is required');
    }
    return verifyReceiptIssuanceBySignature({
      order,
      ownerWallet,
      deliveryId,
      signature,
      dropRuntime,
      conn,
    });
  }
  return verifyReceiptIssuanceByDeliveryRecord({
    order,
    ownerWallet,
    deliveryId,
    dropRuntime,
    conn,
  });
}

export async function retryIssueReceiptsForDeliveryOrder(
  args: RetryIssueReceiptsArgs,
): Promise<RetryIssueReceiptsResult> {
  const ownerWallet = normalizeWallet(args.ownerWallet);
  const deliveryId = requirePositiveDeliveryId(args.deliveryId);
  const dropId = requireDropId(args.dropId);
  const dropRuntime = getDropRuntime(dropId);

  await ensureOnchainCoreConfig(dropRuntime);
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
      { dropId },
    );
  }

  const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }
  const order = orderSnap.data() as any;
  if (order.owner && order.owner !== ownerWallet) {
    throw new HttpsError('permission-denied', 'Order belongs to a different wallet');
  }

  const conn = connection(dropRuntime);

  // Fast-path idempotency (already finalized).
  if (order.status === 'ready_to_ship') {
    const cfg = await fetchDecodedBoxMinterConfigAccount({
      dropRuntime,
      conn,
      context: 'getAccountInfo:boxMinterConfig:lateClose',
    });
    const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
    let closeDeliveryTx: string | null = order.closeDeliveryTx || null;
    if (!closeDeliveryTx) {
      // Best-effort late cleanup: if the delivery PDA still exists, close it now.
      const deliveryInfo = await withTimeout(
        conn.getAccountInfo(expectedDeliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
        RPC_TIMEOUT_MS,
        'getAccountInfo:deliveryPda:lateClose',
      );
      if (deliveryInfo) {
        try {
          const cfgAdmin = cfg.admin;
          const signer = cosigner();
          if (!signer.publicKey.equals(cfgAdmin)) {
            throw new HttpsError('failed-precondition', 'Server key does not match on-chain admin (late close)');
          }

          const closeIx = new TransactionInstruction({
            programId: dropRuntime.boxMinterProgramId,
            keys: [
              { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
              { pubkey: signer.publicKey, isSigner: true, isWritable: true },
              { pubkey: expectedDeliveryPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: encodeCloseDeliveryArgs({ deliveryId, deliveryBump: expectedDeliveryBump }),
          });
          const { blockhash } = await withTimeout(
            conn.getLatestBlockhash('confirmed'),
            RPC_TIMEOUT_MS,
            'getLatestBlockhash:lateClose',
          );
          const closeTx = buildTx(
            [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), closeIx],
            signer.publicKey,
            blockhash,
            [signer],
          );
          const closeSig = await sendAndConfirmSignedTx(conn, closeTx, 'lateCloseDelivery', {
            sendTimeoutMs: TX_SEND_TIMEOUT_MS,
            confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
          });
          closeDeliveryTx = closeSig;
          await orderRef.set({ dropId, closeDeliveryTx, deliveryClosedAt: FieldValue.serverTimestamp() }, { merge: true });
        } catch (err) {
          console.error('[mons/functions] late closeDelivery failed (non-fatal)', summarizeError(err), { deliveryId });
        }
      }
    }

    return {
      processed: true,
      deliveryId,
      receiptsMinted: Number(order.receiptsMinted || 0),
      receiptTxs: Array.isArray(order.receiptTxs) ? order.receiptTxs : [],
      closeDeliveryTx,
    };
  }

  const verified = await verifyReceiptIssuanceTarget({
    args,
    order,
    ownerWallet,
    deliveryId,
    dropRuntime,
    conn,
  });
  const signature = verified.signature;
  const expectedDeliveryPda = verified.expectedDeliveryPda;
  const expectedDeliveryBump = verified.expectedDeliveryBump;
  const targetAssetIds = verified.targetAssetIds;

  // Ensure the cosigner key matches the on-chain admin (custody vault).
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig',
  });
  const cfgAdmin = cfg.admin;
  const cfgTreasury = cfg.treasury;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfgAdmin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }

  // Best-effort processing lock (avoid concurrent minting).
  await orderRef.set(
    {
      dropId,
      status: 'processing',
      ...(signature ? { deliverySignature: signature } : {}),
      ...(order?.processingAt ? {} : { processingAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  await orderRef
    .update({
      'receiptRecovery.lastPreparedProbeAt': FieldValue.delete(),
      'receiptRecovery.preparedProbeCount': FieldValue.delete(),
      'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
    })
    .catch(() => {
      // Ignore cleanup races; prepared-order probing is operational only.
    });

  const expectedOrderItems: any[] = Array.isArray(order.items) ? order.items : [];
  const byAssetId = new Map<string, any>();
  expectedOrderItems.forEach((it) => {
    if (it && typeof it.assetId === 'string') byAssetId.set(it.assetId, it);
  });

  const targetAssetPks = targetAssetIds.map((id) => new PublicKey(id));
  const infos = await withTimeout(
    conn.getMultipleAccountsInfo(targetAssetPks, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo:deliveryAssets',
  );

  const ownerPk = new PublicKey(ownerWallet);
  const pending: Array<{ assetId: string; assetPk: PublicKey; kind: 'box' | 'dude'; refId: number }> = [];
  for (let i = 0; i < targetAssetIds.length; i += 1) {
    const info = infos[i];
    if (!info) continue; // already burned / reclaimed
    const assetId = targetAssetIds[i];
    const pk = targetAssetPks[i];
    const stored = byAssetId.get(assetId);
    const kind = stored?.kind;
    const refId = Number(stored?.refId);
    if (kind !== 'box' && kind !== 'dude') {
      throw new HttpsError('failed-precondition', 'Delivery order is missing item kind for receipt minting', {
        assetId,
        kind,
      });
    }
    if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
      throw new HttpsError('failed-precondition', 'Delivery order is missing item refId for receipt minting', {
        assetId,
        kind,
        refId,
      });
    }
    if (kind === 'dude' && refId > dropRuntime.maxDudeId) {
      throw new HttpsError('failed-precondition', 'Invalid dude id for receipt minting', { assetId, refId });
    }
    pending.push({ assetId, assetPk: pk, kind, refId });
  }

  const alreadyProcessed = targetAssetIds.length - pending.length;
  const receiptTxs: string[] = [];
  let totalProcessed = 0;

  // Process in as-large-as-possible batches, bounded by tx size + compute + transient RPC failures.
  // Strategy:
  // - start with a large batch size (<= 24)
  // - if tx is too large OR hits compute/simulation limits, shrink `n`
  // - if send/confirm has transient failures, retry the SAME batch (same `n`) with backoff
  // - if we can't confirm but the burned assets are gone, treat it as success (idempotent)
  while (pending.length) {
    // Start small (more reliable under congestion / compute variability).
    let n = Math.min(pending.length, 3);
    let lastErr: unknown = null;

    while (n >= 1) {
      const batch = pending.slice(0, n);
      const burnIxs = batch.map((it) =>
        mplCoreBurnV1Ix({
          asset: it.assetPk,
          coreCollection: cfgCoreCollection,
          authority: signer.publicKey,
          payer: signer.publicKey,
        }),
      );
      const boxIds = batch.filter((it) => it.kind === 'box').map((it) => Math.floor(it.refId));
      const dudeIds = batch.filter((it) => it.kind === 'dude').map((it) => Math.floor(it.refId));
      const treeConfig = deriveTreeConfigPda(dropRuntime.receiptsMerkleTree);
      const mintReceiptsIx = new TransactionInstruction({
        programId: dropRuntime.boxMinterProgramId,
        keys: [
          { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false }, // config
          { pubkey: signer.publicKey, isSigner: true, isWritable: true }, // cosigner
          { pubkey: ownerPk, isSigner: false, isWritable: false }, // user
          { pubkey: dropRuntime.receiptsMerkleTree, isSigner: false, isWritable: true }, // merkle_tree
          { pubkey: treeConfig, isSigner: false, isWritable: true }, // tree_config
          { pubkey: cfgCoreCollection, isSigner: false, isWritable: true }, // core_collection
          { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false }, // bubblegum_program
          { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
          { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compression_program
          { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mpl_core_program
          { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mpl_core_cpi_signer
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data: encodeMintReceiptsArgs({ boxIds, dudeIds }, dropRuntime),
      });
      const instructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...burnIxs,
        mintReceiptsIx,
      ];

      let succeeded = false;

      for (let attempt = 0; attempt < Math.max(1, TX_MAX_SEND_ATTEMPTS); attempt += 1) {
        // Fresh blockhash each send attempt.
        const { blockhash } = await withTimeout(
          conn.getLatestBlockhash('confirmed'),
          RPC_TIMEOUT_MS,
          'getLatestBlockhash:issueReceipts',
        );

        let txCandidate: VersionedTransaction;
        let rawLen = 0;
        try {
          txCandidate = buildTx(instructions, signer.publicKey, blockhash, [signer]);
          rawLen = txCandidate.serialize().length;
          if (rawLen > 1232) {
            lastErr = new RangeError(`Receipt issuance transaction too large (${rawLen} bytes)`);
            break; // shrink `n`
          }
        } catch (err) {
          const msg = txErrMessage(err);
          const anyErr = err as any;
          const tooLarge =
            err instanceof RangeError &&
            (/encoding overruns Uint8Array/i.test(msg) ||
              /offset.*out of range/i.test(msg) ||
              String(anyErr?.code || '') === 'ERR_OUT_OF_RANGE');
          if (!tooLarge) throw err;
          lastErr = err;
          break; // shrink `n`
        }

        const sig = bs58.encode(txCandidate.signatures[0]);

        let sendErr: unknown = null;
        try {
          await withTimeout(
            conn.sendTransaction(txCandidate, { maxRetries: 2 }),
            TX_SEND_TIMEOUT_MS,
            'sendTransaction:issueReceipts',
          );
        } catch (err) {
          sendErr = err;
        }

        if (sendErr) {
          const msg = txErrMessage(sendErr);
          const logs = txErrLogs(sendErr);
          lastErr = sendErr;

          // If preflight simulation failed (logs present), retrying with the same batch size often won't help.
          if (logs.length) {
            if (looksLikeAccountInUseError(msg, logs) || looksLikeRateLimitOrRpcError(msg) || looksLikeBlockhashError(msg)) {
              // transient: backoff + retry same `n`
              await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
              continue;
            }
            // likely compute or deterministic failure: shrink
            break;
          }

          // Unclear if it was submitted; wait briefly for it to land anyway.
          const maybe = await waitForSignature(conn, sig, { timeoutMs: 12_000, pollMs: TX_CONFIRM_POLL_MS });
          if (maybe.ok) {
            receiptTxs.push(sig);
            totalProcessed += n;
            pending.splice(0, n);
            succeeded = true;
            break;
          }
          // If we can't confirm, but the burned assets are gone, treat as success.
          const postInfos = await withTimeout(
            conn.getMultipleAccountsInfo(batch.map((b) => b.assetPk), {
              commitment: 'confirmed',
              dataSlice: { offset: 0, length: 0 },
            }),
            RPC_TIMEOUT_MS,
            'getMultipleAccountsInfo:postSend',
          );
          if (postInfos.every((ai) => !ai)) {
            receiptTxs.push(sig);
            totalProcessed += n;
            pending.splice(0, n);
            succeeded = true;
            break;
          }

          // retry same batch (transient)
          await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
          continue;
        }

        // Sent: confirm (polling is more reliable than a single confirmTransaction call).
        const confirmed = await waitForSignature(conn, sig, { timeoutMs: TX_CONFIRM_TIMEOUT_MS, pollMs: TX_CONFIRM_POLL_MS });
        if (confirmed.ok) {
          receiptTxs.push(sig);
          totalProcessed += n;
          pending.splice(0, n);
          succeeded = true;
          break;
        }

        // If we can't confirm, but the burned assets are gone, treat as success.
        const postInfos = await withTimeout(
          conn.getMultipleAccountsInfo(batch.map((b) => b.assetPk), {
            commitment: 'confirmed',
            dataSlice: { offset: 0, length: 0 },
          }),
          RPC_TIMEOUT_MS,
          'getMultipleAccountsInfo:postConfirm',
        );
        if (postInfos.every((ai) => !ai)) {
          receiptTxs.push(sig);
          totalProcessed += n;
          pending.splice(0, n);
          succeeded = true;
          break;
        }

        // Failed or still unknown.
        if (confirmed.ok === false) {
          lastErr = confirmed.err;
          const msg = txErrMessage(confirmed.err);
          const logs = Array.isArray(confirmed.logs) ? confirmed.logs : [];
          if (looksLikeComputeLimitError(msg, logs)) {
            // shrink batch size
            break;
          }
        }

        // retry same `n` (congestion / rpc flakiness)
        await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
      }

      if (succeeded) {
        break; // go to next `pending` chunk
      }

      // Shrink batch size and try again.
      n -= 1;
    }

    if (n < 1) {
      const msg = txErrMessage(lastErr);
      const logs = txErrLogs(lastErr);
      throw new HttpsError('failed-precondition', 'Unable to issue receipts (try fewer items or retry later)', {
        lastError: msg,
        lastLogs: logs.slice(0, 80),
      });
    }
  }

  const receiptsMinted = alreadyProcessed + totalProcessed;

  // Create IRL claim codes for each delivered box (so the admin can ship the secret code inside the physical box).
  const irlClaims: Array<{ code: string; boxId: number; boxAssetId: string; dudeIds: number[] }> = [];
  if (isOpenableDrop(dropRuntime)) {
    const deliveredItems: any[] = Array.isArray(order.items) ? order.items : [];
    const deliveredBoxes = deliveredItems.filter((it) => it && it.kind === 'box' && typeof it.assetId === 'string');
    for (const box of deliveredBoxes) {
      const boxAssetId = String(box.assetId);
      const boxId = Number(box.refId);
      if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) continue;
      const dudeIds = await assignDudes(dropId, boxAssetId);
      const code = await ensureIrlClaimCodeForBox({ dropId, ownerWallet, deliveryId, boxAssetId, boxId, dudeIds });
      irlClaims.push({ code, boxId, boxAssetId, dudeIds });
    }
  }

  // Mark Firestore ready-to-ship BEFORE closing on-chain delivery record.
  await orderRef.set(
    {
      dropId,
      status: 'ready_to_ship',
      ...(signature ? { deliverySignature: signature } : {}),
      receiptsMinted,
      receiptTxs,
      ...(irlClaims.length ? { irlClaims, irlClaimsUpdatedAt: FieldValue.serverTimestamp() } : {}),
      processedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await orderRef.update({
    'receiptRecovery.leaseExpiresAt': FieldValue.delete(),
    'receiptRecovery.lastErrorCode': FieldValue.delete(),
    'receiptRecovery.lastErrorMessage': FieldValue.delete(),
    'receiptRecovery.lastPreparedProbeAt': FieldValue.delete(),
    'receiptRecovery.preparedProbeCount': FieldValue.delete(),
    'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
  }).catch(() => {
    // Ignore cleanup races; recovery metadata is operational only.
  });

  // Close delivery PDA (reclaim rent) after burning + minting + Firestore marking.
  let closeDeliveryTx: string | null = null;
  const deliveryInfo = await withTimeout(
    conn.getAccountInfo(expectedDeliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:deliveryPda',
  );
  if (deliveryInfo) {
    const closeIx = new TransactionInstruction({
      programId: dropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: expectedDeliveryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeCloseDeliveryArgs({ deliveryId, deliveryBump: expectedDeliveryBump }),
    });
    const { blockhash } = await withTimeout(
      conn.getLatestBlockhash('confirmed'),
      RPC_TIMEOUT_MS,
      'getLatestBlockhash:closeDelivery',
    );
    const closeTx = buildTx(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), closeIx],
      signer.publicKey,
      blockhash,
      [signer],
    );
    try {
      closeDeliveryTx = await sendAndConfirmSignedTx(conn, closeTx, 'closeDelivery', {
        sendTimeoutMs: TX_SEND_TIMEOUT_MS,
        confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
      });
    } catch (err) {
      console.error('[mons/functions] closeDelivery failed (non-fatal)', summarizeError(err), { deliveryId });
    }
  }

  if (closeDeliveryTx) {
    await orderRef.set({ dropId, closeDeliveryTx, deliveryClosedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  return { processed: true, deliveryId, receiptsMinted, receiptTxs, closeDeliveryTx };
}

export const issueReceipts = onCallLogged(
  'issueReceipts',
  async (request) => {
    const { wallet } = await requireWalletSession(request);
    const schema = z.object({
      owner: z.string(),
      deliveryId: z.number().int().positive(),
      signature: z.string(),
      dropId: z.string().min(1).max(64),
    });
    const { owner, deliveryId, signature, dropId: requestDropId } = parseRequest(schema, request.data);
    const ownerWallet = normalizeWallet(owner);
    if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
    const dropId = requireDropId(requestDropId);
    const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
    const orderSnap = await orderRef.get();
    const order = orderSnap.exists ? orderSnap.data() as any : null;
    let leaseAcquired = false;

    if (order?.status !== 'ready_to_ship') {
      const lease = await acquireDeliveryRecoveryLease(orderRef, ownerWallet, Date.now(), true);
      if ('result' in lease) {
        if (lease.result.outcome === 'lease_active') {
          throw new HttpsError('aborted', lease.result.message || 'another client is already retrying this order');
        }
        if (lease.result.outcome === 'not_found') {
          throw new HttpsError('not-found', lease.result.message || 'Delivery order not found');
        }
        if (lease.result.errorCode === 'permission-denied') {
          throw new HttpsError('permission-denied', lease.result.message || 'Order belongs to a different wallet');
        }
        if (lease.result.outcome !== 'skipped_status') {
          throw new HttpsError('failed-precondition', lease.result.message || 'Unable to start receipt issuance');
        }
      } else {
        leaseAcquired = true;
      }
    }

    try {
      const result = await retryIssueReceiptsForDeliveryOrder({
        ownerWallet,
        deliveryId,
        dropId,
        verification: 'signature',
        signature,
      });
      if (leaseAcquired) {
        await finalizeDeliveryRecoveryAttempt(orderRef, {}).catch(() => {
          // Ignore cleanup races; recovery metadata is operational only.
        });
      }
      return result;
    } catch (err) {
      if (leaseAcquired) {
        await finalizeDeliveryRecoveryAttempt(orderRef, {
          errorCode: normalizeRecoveryErrorCode(err),
          message: normalizeRecoveryMessage(err instanceof Error ? err.message : String(err)),
        }).catch(() => {
          // Ignore cleanup races; recovery metadata is operational only.
        });
      }
      throw err;
    }
  },
  { secrets: [COSIGNER_SECRET] },
);

export const recoverMyDeliveryOrders = onCallLogged('recoverMyDeliveryOrders', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    dropId: z.string().min(1).max(64).optional(),
    deliveryId: z.number().int().positive().optional(),
    force: z.boolean().optional(),
  });
  const { dropId: rawDropId, deliveryId, force = false } = parseRequest(schema, request.data || {});
  if (deliveryId != null && !rawDropId) {
    throw new HttpsError('invalid-argument', 'deliveryId requires dropId');
  }
  const filterDropId = rawDropId ? requireDropId(rawDropId) : undefined;
  const nowMs = Date.now();
  const results: RecoverMyDeliveryOrdersItemResult[] = [];
  let attempted = 0;
  let recovered = 0;

  let candidateDocs: DeliveryOrderDoc[] = [];
  if (filterDropId && deliveryId != null) {
    const doc = await db.doc(dropDeliveryOrderPath(filterDropId, deliveryId)).get();
    if (!doc.exists) {
      const recoveryState = await fetchDeliveryRecoveryState(wallet, filterDropId);
      return {
        attempted,
        recovered,
        remainingProcessing: recoveryState.remainingProcessing,
        ...(recoveryState.nextCheckAt != null ? { nextCheckAt: recoveryState.nextCheckAt } : {}),
        results: [
          {
            dropId: filterDropId,
            deliveryId,
            statusBefore: 'missing',
            outcome: 'not_found',
            verification: 'delivery_pda',
            message: 'delivery order not found',
          },
        ],
      } satisfies RecoverMyDeliveryOrdersResult;
    }
    candidateDocs = [doc];
  } else {
    const [processingDocs, preparedDocs] = await Promise.all([
      listOwnedDeliveryOrdersByStatus(wallet, 'processing', filterDropId),
      listOwnedDeliveryOrdersByStatus(wallet, 'prepared', filterDropId),
    ]);
    candidateDocs = [...processingDocs, ...preparedDocs];
  }

  candidateDocs.sort(compareDeliveryRecoveryCandidates);

  for (const doc of candidateDocs) {
    const order = doc.data() || {};
    const base = orderResultBase(doc);
    if (!base) continue;

    if (order?.owner && order.owner !== wallet) {
      results.push({
        ...base,
        outcome: 'failed',
        verification: 'delivery_pda',
        errorCode: 'permission-denied',
        message: 'order belongs to a different wallet',
      });
      continue;
    }

    if (base.statusBefore === 'ready_to_ship') {
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: 'order is already ready to ship',
      });
      recovered += 1;
      continue;
    }

    if (base.statusBefore === 'prepared' && !force) {
      let hasDeliveryRecord: boolean | null = null;
      try {
        hasDeliveryRecord = await hasConfirmedDeliveryRecord(base.dropId, base.deliveryId);
      } catch (err) {
        logger.warn('recoverMyDeliveryOrders:eligibilityCheckFailed', {
          wallet,
          dropId: base.dropId,
          deliveryId: base.deliveryId,
          verification: 'delivery_pda',
          error: summarizeError(err),
        });
      }
      if (hasDeliveryRecord === false) {
        const nextPreparedCheckAt = await recordPreparedDeliveryRecoveryMiss(doc.ref, order, nowMs).catch((err) => {
          logger.warn('recoverMyDeliveryOrders:preparedProbeUpdateFailed', {
            wallet,
            dropId: base.dropId,
            deliveryId: base.deliveryId,
            verification: 'delivery_pda',
            error: summarizeError(err),
          });
          return null;
        });
        results.push({
          ...base,
          outcome: 'not_eligible',
          verification: 'delivery_pda',
          message:
            nextPreparedCheckAt != null
              ? 'prepared order has no confirmed on-chain delivery record yet'
              : 'prepared order never produced a confirmed on-chain delivery record',
        });
        continue;
      }
    }

    if (attempted >= MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) {
      results.push({
        ...base,
        outcome: 'attempt_capped',
        verification: 'delivery_pda',
        message: 'recovery attempt cap reached for this pass',
      });
      continue;
    }

    const lease = await acquireDeliveryRecoveryLease(doc.ref, wallet, nowMs, force);
    if ('result' in lease) {
      results.push(lease.result);
      continue;
    }

    attempted += 1;
    try {
      const retryResult = await retryIssueReceiptsForDeliveryOrder({
        ownerWallet: wallet,
        deliveryId: base.deliveryId,
        dropId: base.dropId,
        verification: 'delivery_pda',
      });
      recovered += 1;
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: retryResult.processed ? 'receipts issued' : 'order already processed',
      });
      await finalizeDeliveryRecoveryAttempt(doc.ref, {});
      logger.info('recoverMyDeliveryOrders:recovered', {
        wallet,
        dropId: base.dropId,
        deliveryId: base.deliveryId,
        verification: 'delivery_pda',
      });
    } catch (err) {
      const errorCode = normalizeRecoveryErrorCode(err);
      const message = normalizeRecoveryMessage(err instanceof Error ? err.message : String(err));
      const outcome =
        errorCode === 'failed-precondition' && /delivery record pda not found/i.test(String(err instanceof Error ? err.message : err))
          ? 'missing_delivery'
          : 'failed';
      if (base.statusBefore === 'prepared') {
        if (outcome === 'missing_delivery') {
          await recordPreparedDeliveryRecoveryMiss(doc.ref, order, nowMs).catch((probeErr) => {
            logger.warn('recoverMyDeliveryOrders:preparedProbeUpdateFailed', {
              wallet,
              dropId: base.dropId,
              deliveryId: base.deliveryId,
              verification: 'delivery_pda',
              error: summarizeError(probeErr),
            });
          });
        } else {
          await stopPreparedDeliveryRecoveryChecks(doc.ref, order, nowMs).catch((probeErr) => {
            logger.warn('recoverMyDeliveryOrders:preparedProbeStopFailed', {
              wallet,
              dropId: base.dropId,
              deliveryId: base.deliveryId,
              verification: 'delivery_pda',
              error: summarizeError(probeErr),
            });
          });
        }
      }
      results.push({
        ...base,
        outcome,
        verification: 'delivery_pda',
        ...(errorCode ? { errorCode } : {}),
        ...(message ? { message } : {}),
      });
      await finalizeDeliveryRecoveryAttempt(doc.ref, { errorCode, message });
      logger.warn('recoverMyDeliveryOrders:failed', {
        wallet,
        dropId: base.dropId,
        deliveryId: base.deliveryId,
        verification: 'delivery_pda',
        error: summarizeError(err),
      });
    }
  }

  const recoveryState = await fetchDeliveryRecoveryState(wallet, filterDropId);
  return {
    attempted,
    recovered,
    remainingProcessing: recoveryState.remainingProcessing,
    ...(recoveryState.nextCheckAt != null ? { nextCheckAt: recoveryState.nextCheckAt } : {}),
    results,
  } satisfies RecoverMyDeliveryOrdersResult;
});

export const prepareIrlClaimTx = onCallLogged(
  'prepareIrlClaimTx',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), code: z.string() });
  const { owner, code } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  const normalizedCode = normalizeIrlClaimCode(code);
  if (!normalizedCode || normalizedCode.length !== IRL_CLAIM_CODE_DIGITS) {
    throw new HttpsError('invalid-argument', `Invalid claim code (must be ${IRL_CLAIM_CODE_DIGITS} digits)`);
  }

  const claimRef = db.doc(`claimCodes/${normalizedCode}`);
  const claimDoc = await claimRef.get();
  if (!claimDoc.exists) {
    throw new HttpsError('not-found', 'Invalid claim code');
  }

  const claim = claimDoc.data() as any;
  const claimDropId = await resolveClaimDropIdForCode(normalizedCode, claim);
  const claimDropRuntime = getDropRuntime(claimDropId);
  assertOpenableDrop(claimDropRuntime, 'This drop does not use secret claim codes.');
  await ensureOnchainCoreConfig(claimDropRuntime);
  const boxIdNum = Number(claim?.boxId);
  const boxIdStr = claim?.boxId != null ? String(claim.boxId) : '';
  if (!Number.isFinite(boxIdNum) || boxIdNum <= 0 || boxIdNum > 0xffff_ffff || !boxIdStr) {
    throw new HttpsError('failed-precondition', 'Claim code is missing a valid box id');
  }

  const dudeIdsRaw = claim?.dudeIds ?? claim?.dude_ids ?? claim?.dudes ?? [];
  const dudeIds: number[] = Array.isArray(dudeIdsRaw) ? dudeIdsRaw.map((n: any) => Number(n)) : [];
  if (dudeIds.length !== claimDropRuntime.itemsPerBox) {
    throw new HttpsError('failed-precondition', `Claim has invalid dudeIds (expected ${claimDropRuntime.itemsPerBox})`);
  }
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > claimDropRuntime.maxDudeId) {
      throw new HttpsError('failed-precondition', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new HttpsError('failed-precondition', 'Duplicate dude ids in claim');
  }

  // Load wallet assets once and use it for both:
  // - detecting an already-claimed code (dude receipts already present)
  // - finding the matching box certificate in the wallet
  const ownedAssets = await fetchAssetsOwned(ownerWallet, claimDropRuntime);
  // Filter to certificates that belong to the requested drop before matching ids.
  // Shared collections can legitimately reuse box/dude number ranges across drops.
  const ownedRequestedDropCertificates = ownedAssets.filter(
    (asset: any) => getAssetKind(asset) === 'certificate' && assetMatchesRequestedDrop(asset, claimDropRuntime),
  );

  // If any of the expected dude receipts are already in the wallet, the claim is already done.
  // (The claim tx is atomic; once any of these exist, the box certificate must already be burned.)
  const dudeSet = new Set(dudeIds.map((n) => Number(n)));
  const mintedDudeReceipts = new Set<number>();
  for (const a of ownedRequestedDropCertificates) {
    const id = getDudeIdFromAsset(a);
    if (id != null && dudeSet.has(Number(id))) mintedDudeReceipts.add(Number(id));
  }
  if (mintedDudeReceipts.size > 0) {
    throw new HttpsError('failed-precondition', 'This IRL claim code has already been used');
  }

  // Locate the matching box certificate (receipt) in the requesting wallet.
  const certificate = ownedRequestedDropCertificates.find((asset: any) => getBoxIdFromAsset(asset) === boxIdStr) || null;
  if (!certificate) {
    throw new HttpsError('failed-precondition', 'Matching box certificate not found in wallet');
  }
  if (looksBurntOrClosedInHelius(certificate)) {
    throw new HttpsError('failed-precondition', 'This IRL claim code has already been used');
  }
  if (certificate?.ownership?.owner !== ownerWallet) {
    throw new HttpsError('failed-precondition', 'Matching box certificate not found in wallet');
  }
  const kind = getAssetKind(certificate);
  if (kind !== 'certificate') {
    throw new HttpsError('failed-precondition', 'Provided asset is not a certificate');
  }
  const certificateBoxId = getBoxIdFromAsset(certificate);
  if (!certificateBoxId) {
    throw new HttpsError('failed-precondition', 'Certificate missing box reference');
  }
  if (String(certificateBoxId) !== boxIdStr) {
    throw new HttpsError('failed-precondition', 'Certificate does not match claim box');
  }
  if (!assetMatchesRequestedDrop(certificate, claimDropRuntime)) {
    throw new HttpsError('failed-precondition', 'Certificate does not belong to the requested drop');
  }
  const certificateId = String(certificate.id || '');

  const conn = connection(claimDropRuntime);

  // Load on-chain config so we can build correct burn + mint instructions.
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime: claimDropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig:claimIrl',
  });
  const cfgAdmin = cfg.admin;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfgAdmin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  assertConfiguredPublicKey(claimDropRuntime.collectionMint, 'COLLECTION_MINT');
  if (!claimDropRuntime.collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: claimDropRuntime.collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
      dropId: claimDropId,
    });
  }

  if (!claimDropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
      { dropId: claimDropId },
    );
  }

  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];

  // All receipts/certificates in this repo are Bubblegum v2 compressed cNFTs.
  // (We intentionally do NOT support uncompressed receipt assets anymore.)
  const compression = (certificate as any)?.compression || {};
  const proof = await fetchAssetProof(certificateId, claimDropRuntime);
  const proofPath: string[] = Array.isArray(proof?.proof) ? proof.proof : [];
  const treeId = String(proof?.tree_id ?? proof?.treeId ?? '');
  const rootStr = String(proof?.root || '');
  if (!treeId || !rootStr) {
    throw new HttpsError('failed-precondition', 'Unable to fetch certificate proof for burn');
  }
  const merkleTree = new PublicKey(treeId);
  if (!merkleTree.equals(claimDropRuntime.receiptsMerkleTree)) {
    throw new HttpsError('failed-precondition', 'Certificate does not belong to the configured receipts tree', {
      certificateTree: merkleTree.toBase58(),
      receiptsTree: claimDropRuntime.receiptsMerkleTree.toBase58(),
      dropId: claimDropId,
    });
  }
  const root = bs58Bytes32(rootStr, 'assetProof.root');
  const dataHash = bs58Bytes32(String(compression?.data_hash || compression?.dataHash || ''), 'asset.compression.data_hash');
  const creatorHash = bs58Bytes32(String(compression?.creator_hash || compression?.creatorHash || ''), 'asset.compression.creator_hash');
  const assetDataHashStr = compression?.asset_data_hash || compression?.assetDataHash || '';
  const assetDataHash = assetDataHashStr ? bs58Bytes32(String(assetDataHashStr), 'asset.compression.asset_data_hash') : null;
  const flagsNum = compression?.flags == null ? null : Number(compression.flags);
  const nonce = Number(compression?.leaf_id ?? compression?.leafId);
  if (!Number.isFinite(nonce) || nonce < 0) {
    throw new HttpsError('failed-precondition', 'Unable to parse certificate leaf id');
  }
  const index = Math.floor(nonce);
  if (!Number.isFinite(index) || index < 0 || index > 0xffff_ffff) {
    throw new HttpsError('failed-precondition', 'Certificate leaf index out of range');
  }
  const proofAccountsFull = proofPath.map((p) => new PublicKey(p));
  const proofAccounts = proofAccountsFull;
  const leafOwner = new PublicKey(String(certificate?.ownership?.owner || ownerWallet));
  const leafDelegate = new PublicKey(String(certificate?.ownership?.delegate || certificate?.ownership?.owner || ownerWallet));

  // 1) Burn the box certificate cNFT (user-signed).
  instructions.push(
    bubblegumBurnV2Ix({
      payer: ownerPk,
      authority: ownerPk,
      leafOwner,
      leafDelegate,
      merkleTree,
      coreCollection: cfgCoreCollection,
      root,
      dataHash,
      creatorHash,
      assetDataHash,
      flags: flagsNum,
      nonce,
      index,
      proof: proofAccounts,
    }),
  );

  // 2) Mint the configured figure receipt cNFTs (server-cosigned via box_minter CPI to Bubblegum mintV2).
  const treeConfig = deriveTreeConfigPda(claimDropRuntime.receiptsMerkleTree);
  instructions.push(
    new TransactionInstruction({
      programId: claimDropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: claimDropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false }, // config
        { pubkey: signer.publicKey, isSigner: true, isWritable: true }, // cosigner
        { pubkey: ownerPk, isSigner: false, isWritable: false }, // user
        { pubkey: claimDropRuntime.receiptsMerkleTree, isSigner: false, isWritable: true }, // merkle_tree
        { pubkey: treeConfig, isSigner: false, isWritable: true }, // tree_config
        { pubkey: cfgCoreCollection, isSigner: false, isWritable: true }, // core_collection
        { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false }, // bubblegum_program
        { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
        { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compression_program
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mpl_core_program
        { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mpl_core_cpi_signer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: encodeMintReceiptsArgs({ boxIds: [], dudeIds }, claimDropRuntime),
    }),
  );

  // Prefer building without LUT first (wallet UX / preview tends to behave better),
  // but fall back to the delivery ALT if needed to fit under Solana's packet limit.
  let addressLookupTables: AddressLookupTableAccount[] = [];
  try {
    addressLookupTables = await getDeliveryLookupTable(conn, claimDropRuntime);
  } catch {
    addressLookupTables = [];
  }
  const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash:claimIrl');
  const MAX_RAW_TX_BYTES = 1232;

  const buildClaimTx = (luts: AddressLookupTableAccount[]) => buildTx(instructions, ownerPk, blockhash, [signer], luts);

  let tx: VersionedTransaction;
  try {
    // Try without LUT first.
    tx = buildClaimTx([]);
  } catch (err) {
    // web3.js can throw RangeError when the v0 message exceeds the fixed 1232-byte buffer.
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof RangeError && /encoding overruns Uint8Array/i.test(msg)) {
      if (!addressLookupTables.length) {
        throw new HttpsError(
          'failed-precondition',
          'Claim transaction is too large to encode. Re-run deploy-all to update functions/src/config/deployment.ts (deliveryLookupTable), then retry.',
          { receiptsMerkleTree: claimDropRuntime.receiptsMerkleTreeStr, dropId: claimDropId },
        );
      }
      tx = buildClaimTx(addressLookupTables);
    } else {
      throw err;
    }
  }

  let raw = tx.serialize();
  if (raw.length > MAX_RAW_TX_BYTES && addressLookupTables.length) {
    // If the no-LUT build encoded but exceeded the packet limit, retry with LUT.
    tx = buildClaimTx(addressLookupTables);
    raw = tx.serialize();
  }
  if (raw.length > MAX_RAW_TX_BYTES) {
    throw new HttpsError(
      'failed-precondition',
      `Claim transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}).`,
      {
        rawBytes: raw.length,
        maxRawBytes: MAX_RAW_TX_BYTES,
        deliveryLookupTable: claimDropRuntime.deliveryLookupTableStr,
        receiptsMerkleTree: claimDropRuntime.receiptsMerkleTreeStr,
        dropId: claimDropId,
      },
    );
  }

  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    dropId: claimDropId,
    certificates: dudeIds,
    certificateId,
    message: 'Sign and send to burn your box receipt and mint your dude receipts.',
  };
  },
  { secrets: [COSIGNER_SECRET] },
);
