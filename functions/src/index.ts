import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
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
import nacl from 'tweetnacl';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// IMPORTANT (Node ESM): include `.js` extension so the compiled `lib/` output resolves at runtime.
import { FUNCTIONS_DROPS, normalizeDropBase, type FunctionsDropConfig } from './config/deployment.js';
import {
  dropDeliveryOrderPath,
} from './dropPaths.js';
import {
  countDeliveryOrderDudeItems,
  countDeliveryOrderBoxItems,
  countNormalIrlPackStatus,
} from './packStatus.js';
import {
  assignDudesForBox,
  ensureIrlClaimCodeForBox as ensureIrlClaimCodeForBoxShared,
} from './cardAssignment.js';
import { normalizeCountryCode } from './normalizers.js';
import {
  STRIPE_CHECKOUT_STATUS,
  shouldProcessStripeCheckoutFulfillmentWrite,
} from './stripeCheckout/contract.js';
import {
  normalizeNotificationEmailRecipient,
} from './notifications.js';
import {
  buildStripeCheckoutManualReviewEmailContent,
  type StripeCheckoutManualReviewEmailMessage,
} from './notificationEmails.js';
import { enqueueNotificationEmailJob } from './cloudflareNotifications.js';
import { createStripeReadyToShipNotificationJobs } from './stripeReadyNotifications.js';
import {
  createNotificationEmailJobV1,
  type NotificationEmailJobV1,
  type NotificationEmailJobContext,
  type NotificationEmailKind,
} from './shared/notificationEmailJob.js';
import {
  processStripeCheckoutFulfillmentDocument,
  requireStripeCheckoutSessionId,
  type StripeCheckoutFlowDeps,
  type StripeCheckoutOnchainConfig,
} from './stripeCheckout/service.js';
import { toMillisMaybe } from './time.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeBoxMinterMetadataBaseForComparison,
  normalizeDropId as normalizeDropIdShared,
} from './shared/deploymentCore.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET as MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX as MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX as MIN_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET as MIN_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX as MIN_OPENABLE_ITEMS_PER_BOX,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
  type BoxMinterMintVariantTuple,
} from './shared/boxMinterProtocol.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
} from './shared/fulfillmentAccess.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData as decodeBoxMinterConfigDataShared,
} from './shared/boxMinterConfigCodec.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  encryptAddressCipherText,
  serializeAddressCipherPayload,
} from './shared/addressCipher.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from './shared/solanaProgramAddresses.js';

// Firebase/Google Secret Manager secrets (Cloud Functions v2).
// Configure via: `firebase functions:secrets:set COSIGNER_SECRET`
const COSIGNER_SECRET = defineSecret('COSIGNER_SECRET');
// Base64-encoded Curve25519 secret key for decrypting delivery addresses (TweetNaCl box).
const ADDRESS_DECRYPTION_SECRET = defineSecret('ADDRESS_DECRYPTION_SECRET');
const NOTIFICATION_ENQUEUE_SECRET = defineSecret('NOTIFICATION_ENQUEUE_SECRET');
const STRIPE_RESTRICTED_KEY = defineSecret('STRIPE_RESTRICTED_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_RESTRICTED_KEY_LIVE = defineSecret('STRIPE_RESTRICTED_KEY_LIVE');
const STRIPE_SECRET_KEY_LIVE = defineSecret('STRIPE_SECRET_KEY_LIVE');

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

// Hardcoded (no env / no deployment config) to avoid config sprawl.
const RPC_TIMEOUT_MS = 8_000;
// Issue-receipts tx retry/confirm tuning.
// Hardcoded (no env) to keep deployments deterministic and avoid config sprawl.
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
const TX_MAX_SEND_ATTEMPTS = 3;
type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type DropRuntime = {
  dropId: string;
  config: FunctionsDropConfig;
  cluster: SolanaCluster;
  heliusRpcBase: string;
  connectionRpcUrl: string;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  collectionMintStr: string;
  receiptsMerkleTree: PublicKey;
  receiptsMerkleTreeStr: string;
  receiptsTreeMaxDepth?: number;
  receiptsTreeCanopyDepth: number;
  deliveryLookupTable: PublicKey;
  deliveryLookupTableStr: string;
  itemsPerBox: number;
  discountMintsPerWallet: number;
  maxSupply: number;
  receiptMaxId: number;
  maxDudeId: number;
};

function isOpenableDrop(dropRuntime: Pick<DropRuntime, 'itemsPerBox'>): boolean {
  return dropRuntime.itemsPerBox >= MIN_OPENABLE_ITEMS_PER_BOX;
}

function normalizeDropId(dropId: string): string {
  const value = normalizeDropIdShared(dropId);
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
  if (!isConfiguredBoxMinterItemsPerBox(itemsPerBox)) {
    throw new Error(
      `itemsPerBox is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.itemsPerBox} (expected integer ${MIN_ITEMS_PER_BOX}..${MAX_ITEMS_PER_BOX})`,
    );
  }
  const maxSupply = Number(config.maxSupply);
  if (!Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff) {
    throw new Error(`maxSupply is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.maxSupply}`);
  }
  const receiptMaxId = Number(config.receiptMaxId ?? maxSupply);
  if (
    !Number.isInteger(receiptMaxId) ||
    receiptMaxId < maxSupply ||
    receiptMaxId > 0xffff_ffff
  ) {
    throw new Error(
      `receiptMaxId is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.receiptMaxId}`,
    );
  }
  const discountMintsPerWalletRaw = Number(config.discountMintsPerWallet);
  if (!isBoxMinterDiscountMintsPerWallet(discountMintsPerWalletRaw)) {
    throw new Error(
      `discountMintsPerWallet is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.discountMintsPerWallet} (expected integer ${MIN_DISCOUNT_MINTS_PER_WALLET}..${MAX_DISCOUNT_MINTS_PER_WALLET})`,
    );
  }
  const discountMintsPerWallet = discountMintsPerWalletRaw;
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
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  const collectionMint = requireConfiguredPubkey('COLLECTION_MINT', config.collectionMint);
  const receiptsMerkleTree = requireConfiguredPubkey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree);
  const deliveryLookupTable = requireConfiguredPubkey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable);
  const receiptsTreeMaxDepthRaw = Number((config as FunctionsDropConfig & {
    receiptsTreeMaxDepth?: number;
  }).receiptsTreeMaxDepth);
  const receiptsTreeCanopyDepthRaw = Number((config as FunctionsDropConfig & {
    receiptsTreeCanopyDepth?: number;
  }).receiptsTreeCanopyDepth ?? 0);
  const receiptsTreeMaxDepth = Number.isInteger(receiptsTreeMaxDepthRaw) && receiptsTreeMaxDepthRaw > 0
    ? receiptsTreeMaxDepthRaw
    : undefined;
  const receiptsTreeCanopyDepth = Number.isInteger(receiptsTreeCanopyDepthRaw) && receiptsTreeCanopyDepthRaw >= 0
    ? receiptsTreeCanopyDepthRaw
    : 0;
  if (receiptsTreeMaxDepth != null && receiptsTreeCanopyDepth >= receiptsTreeMaxDepth) {
    throw new Error(
      `Receipt tree canopy depth is invalid in functions/src/config/deployment.ts for drop ${dropId}`,
    );
  }
  const heliusRpcBase = heliusRpcBaseForCluster(cluster);
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  const connectionRpcUrl = apiKey ? `${heliusRpcBase}/?api-key=${apiKey}` : '';
  return {
    dropId,
    config,
    cluster,
    heliusRpcBase,
    connectionRpcUrl,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint,
    collectionMintStr: collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58(),
    receiptsMerkleTree,
    receiptsMerkleTreeStr: receiptsMerkleTree.equals(PublicKey.default) ? '' : receiptsMerkleTree.toBase58(),
    ...(receiptsTreeMaxDepth != null ? { receiptsTreeMaxDepth } : {}),
    receiptsTreeCanopyDepth,
    deliveryLookupTable,
    deliveryLookupTableStr: deliveryLookupTable.equals(PublicKey.default) ? '' : deliveryLookupTable.toBase58(),
    itemsPerBox,
    discountMintsPerWallet,
    maxSupply,
    receiptMaxId,
    maxDudeId,
  };
}

const DROP_RUNTIMES: Record<string, DropRuntime> = Object.create(null);
Object.entries(FUNCTIONS_DROPS).forEach(([dropIdKey, dropConfig]) => {
  const runtime = buildDropRuntime(dropConfig);
  DROP_RUNTIMES[normalizeDropId(dropIdKey)] = runtime;
});
if (!Object.keys(DROP_RUNTIMES).length) {
  throw new Error('functions/src/config/deployment.ts has no configured drops');
}
const DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION = new Map<string, number>();
Object.values(DROP_RUNTIMES).forEach((runtime) => {
  const clusterCollectionKey = dropRuntimeClusterCollectionKey(runtime);
  DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.set(
    clusterCollectionKey,
    (DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.get(clusterCollectionKey) || 0) + 1,
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

function dropRuntimeClusterCollectionKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'collectionMintStr'>,
): string {
  return `${dropRuntime.cluster}:${dropRuntime.collectionMintStr}`;
}


function requireDropId(rawDropId: unknown): string {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) {
    throw new HttpsError('invalid-argument', 'dropId is required');
  }
  const dropId = normalizeDropId(rawDropId);
  if (!DROP_RUNTIMES[dropId]) throw new HttpsError('invalid-argument', `Unsupported dropId: ${dropId}`);
  return dropId;
}

function normalizeWallet(wallet: string): string {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid wallet address');
  }
}


const SHIPPER_DROP_IDS_BY_WALLET = new Map<string, Set<string>>();
SHIPPER_FULFILLMENT_ACCESS.forEach(({ wallet: rawWallet, dropIds: rawDropIds }) => {
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
FULFILLMENT_ADMIN_WALLET_ADDRESSES.forEach((raw) => {
  try {
    ADMIN_WALLETS.add(new PublicKey(raw).toBase58());
  } catch (err) {
    console.error('[mons/functions] invalid admin wallet', raw, summarizeError(err));
  }
});

// MPL Core program id (uncompressed Core assets).
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
// Solana SPL Noop program (commonly used as Metaplex "log wrapper").
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
// Metaplex Noop program (used by Bubblegum v2).
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
// MPL Account Compression program (used by Bubblegum v2).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
// Bubblegum program (compressed NFTs).
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
// Bubblegum -> MPL-Core CPI signer (used when minting cNFTs to an MPL-Core collection).
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

// Anchor discriminator = sha256("account:DeliveryRecord")[0..8]
const ACCOUNT_DELIVERY_RECORD = Buffer.from('2b0f869afad50393', 'hex');
// Anchor discriminator = sha256("global:deliver")[0..8]
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
// Anchor discriminator = sha256("global:close_delivery")[0..8]
const IX_CLOSE_DELIVERY = Buffer.from('ae641ab98ea5f208', 'hex');
// Anchor discriminator = sha256("global:mint_receipts")[0..8]
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');

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
      ADDRESS_CIPHER_SECRET_KEY_LENGTH,
    );
    cachedAddressDecryptKeyState = 'ready';
    return cachedAddressDecryptKey;
  } catch (err) {
    cachedAddressDecryptKeyState = 'missing';
    console.warn('[mons/functions] ADDRESS_DECRYPTION_SECRET unavailable; returning encrypted addresses', summarizeError(err));
    return null;
  }
}

function encryptAddressPayloadForFulfillment(plaintext: string): { encrypted: string; hint: string } | null {
  try {
    const messageText = String(plaintext || '').trim();
    if (!messageText) return null;
    const secret = addressDecryptKeyMaybe();
    if (!secret) {
      throw new HttpsError('unavailable', 'ADDRESS_DECRYPTION_SECRET is not configured for Stripe fulfillment');
    }
    const recipient = nacl.box.keyPair.fromSecretKey(secret).publicKey;
    const parts = encryptAddressCipherText(messageText, recipient);
    const encrypted = serializeAddressCipherPayload(
      parts,
      (value) => Buffer.from(value).toString('base64'),
    );
    const hint = addressCipherHint(messageText);
    return { encrypted, hint };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.warn('[mons/functions] failed to encrypt webhook shipping address', summarizeError(err));
    throw new HttpsError('unavailable', 'Stripe checkout shipping address could not be encrypted', {
      error: summarizeError(err),
    });
  }
}

function ensureAuthorityKeys() {
  // Prepared transactions require a server-side cosigner signature.
  cosigner();
}

function secretParamValueMaybe(secret: { value: () => string }): string {
  try {
    return (secret.value() || '').trim();
  } catch {
    return '';
  }
}

function envOrSecretValue(envName: string, secret: { value: () => string }): string {
  return (process.env[envName] || '').trim() || secretParamValueMaybe(secret);
}

function stripeApiKeys(): string[] {
  const values = [
    envOrSecretValue('STRIPE_SECRET_KEY', STRIPE_SECRET_KEY),
    envOrSecretValue('STRIPE_RESTRICTED_KEY', STRIPE_RESTRICTED_KEY),
    envOrSecretValue('STRIPE_SECRET_KEY_LIVE', STRIPE_SECRET_KEY_LIVE),
    envOrSecretValue('STRIPE_RESTRICTED_KEY_LIVE', STRIPE_RESTRICTED_KEY_LIVE),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function isGrpcAlreadyExists(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 6 || code === '6' || code === 'ALREADY_EXISTS';
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

function transactionPreflightError(label: string, signature: string, err: unknown, logs: string[]): HttpsError {
  const message = txErrMessage(err);
  let code: 'aborted' | 'failed-precondition' | 'unavailable' = 'failed-precondition';
  if (looksLikeBlockhashError(message) || looksLikeAccountInUseError(message, logs)) {
    code = 'aborted';
  } else if (looksLikeRateLimitOrRpcError(message)) {
    code = 'unavailable';
  }
  return new HttpsError(code, `${label} transaction preflight failed`, {
    signature,
    lastError: message,
    lastLogs: logs.slice(0, 80),
  });
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
    if (logs.length) throw transactionPreflightError(label, sig, sendErr, logs);

    // Unclear if it was submitted; wait briefly for it to land anyway.
    const maybe = await waitForSignature(conn, sig, { timeoutMs: 12_000, pollMs: TX_CONFIRM_POLL_MS });
    if (maybe.ok) return sig;
    const code = (sendErr as any)?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'unavailable';
    throw new HttpsError(code, `${label} transaction submission status unknown (try again)`, {
      signature: sig,
      lastError: txErrMessage(sendErr),
      maybeSubmitted: true,
    });
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
type OnchainConfigCheck =
  | { lastCheckedMs: number; ok: false }
  | { lastCheckedMs: number; ok: true; config: DecodedBoxMinterConfig };
const onchainConfigCheckByDrop = new Map<string, OnchainConfigCheck>();

async function ensureOnchainCoreConfig(dropRuntime: DropRuntime, force = false): Promise<DecodedBoxMinterConfig> {
  const now = Date.now();
  const cached = onchainConfigCheckByDrop.get(dropRuntime.dropId);
  if (!force && cached?.ok && now - cached.lastCheckedMs < ONCHAIN_CONFIG_CHECK_TTL_MS) return cached.config;
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
  if (!configInfo.owner.equals(dropRuntime.boxMinterProgramId)) {
    throw new HttpsError(
      'failed-precondition',
      'BOX_MINTER_CONFIG_PDA is not owned by the configured box minter program.',
      {
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        expectedOwner: dropRuntime.boxMinterProgramId.toBase58(),
        actualOwner: configInfo.owner.toBase58(),
        dropId: dropRuntime.dropId,
      },
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
  if (!boxMinterMetadataBaseMatchesDrop(
    decoded.uriBase,
    dropRuntime.config.metadataBase,
    dropRuntime.config.metadataBaseAliases,
  )) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain metadata base for this drop.',
      {
        configuredMetadataBase: normalizeDropBase(dropRuntime.config.metadataBase),
        onchainMetadataBase: normalizeBoxMinterMetadataBaseForComparison(decoded.uriBase),
        onchainMetadataBaseRaw: decoded.uriBase,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  assertConfiguredPaymentRoutingMatchesOnchain(dropRuntime, decoded);

  onchainConfigCheckByDrop.set(dropRuntime.dropId, { lastCheckedMs: now, ok: true, config: decoded });
  return decoded;
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
  return configPda.equals(
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0],
  );
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

type DecodedBoxMinterConfig = {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  started: boolean;
  discountMintsPerWallet: number;
  mintVariantKind: number;
  mintVariantStartIds: BoxMinterMintVariantTuple;
  mintVariantEndIds: BoxMinterMintVariantTuple;
  mintVariantNextIds: BoxMinterMintVariantTuple;
  paymentRouting: DecodedBoxMinterPaymentRouting;
  uriBase: string;
  dropSeed?: Buffer;
};

type DecodedBoxMinterPaymentRouting =
  | {
      schema: 'legacy';
      mintProceeds: Array<{ address: PublicKey; percentage: number }>;
      deliveryPaymentReceiver: PublicKey;
    }
  | {
      schema: 'split-payments-v1';
      version: 1;
      mintProceeds: Array<{ address: PublicKey; percentage: number }>;
      deliveryPaymentReceiver: PublicKey;
    };

function assertConfiguredPaymentRoutingMatchesOnchain(
  dropRuntime: DropRuntime,
  cfg: DecodedBoxMinterConfig,
): void {
  const configured = dropRuntime.config;
  if (cfg.treasury.toBase58() !== configured.treasury) {
    throw new HttpsError(
      'failed-precondition',
      'Configured delivery payment receiver does not match the on-chain config.',
      {
        configured: configured.treasury,
        onchain: cfg.treasury.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (!configured.paymentRouting) {
    if (cfg.paymentRouting.schema !== 'legacy') {
      throw new HttpsError(
        'failed-precondition',
        'Configured payment routing is missing for an on-chain split-payment drop.',
        { dropId: dropRuntime.dropId },
      );
    }
    return;
  }
  if (cfg.paymentRouting.schema !== 'split-payments-v1') {
    throw new HttpsError(
      'failed-precondition',
      'Configured split payment routing does not match the legacy on-chain config.',
      { dropId: dropRuntime.dropId },
    );
  }
  if (
    cfg.paymentRouting.deliveryPaymentReceiver.toBase58() !==
      configured.paymentRouting.deliveryPaymentReceiver ||
    cfg.paymentRouting.mintProceeds.length !==
      configured.paymentRouting.mintProceeds.length
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Configured payment routing does not match the on-chain config.',
      { dropId: dropRuntime.dropId },
    );
  }
  for (
    let index = 0;
    index < configured.paymentRouting.mintProceeds.length;
    index += 1
  ) {
    const actual = cfg.paymentRouting.mintProceeds[index];
    const expected = configured.paymentRouting.mintProceeds[index];
    if (
      actual.address.toBase58() !== expected.address ||
      actual.percentage !== expected.percentage
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Configured payment routing does not match the on-chain config.',
        { dropId: dropRuntime.dropId, recipientIndex: index },
      );
    }
  }
}

function throwBoxMinterConfigHttpsError(error: BoxMinterConfigCodecError): never {
  switch (error.reason) {
    case 'config-truncated':
      throw new HttpsError(
        'failed-precondition',
        'Box minter config data is truncated.',
        error.details,
      );
    case 'invalid-items-per-box':
      throw new HttpsError(
        'failed-precondition',
        'On-chain config has invalid itemsPerBox',
        { itemsPerBox: error.details?.itemsPerBox },
      );
    case 'variant-data-truncated':
      throw new HttpsError(
        'failed-precondition',
        'Box minter config variant data is truncated',
      );
    case 'drop-seed-truncated':
      throw new HttpsError(
        'failed-precondition',
        'Box minter config drop seed data is truncated',
      );
    case 'unexpected-config-trailing-data':
      throw new HttpsError(
        'failed-precondition',
        'Unexpected trailing data after the box minter config payload',
      );
    case 'unexpected-drop-seed-trailing-data':
      throw new HttpsError(
        'failed-precondition',
        'Unexpected trailing data after the box minter drop seed',
      );
    case 'empty':
    case 'invalid-discriminator':
    case 'unsupported-config-account-size':
    case 'invalid-payment-routing-magic':
    case 'unsupported-payment-routing-version':
    case 'invalid-payment-routing-recipient-count':
    case 'invalid-payment-routing-recipient':
    case 'invalid-payment-routing-percentage':
    case 'invalid-payment-routing-reserved-data':
      throw new HttpsError(
        'failed-precondition',
        error.message,
        error.details,
      );
    default:
      throw error;
  }
}

function decodeBoxMinterConfigData(data: Buffer | Uint8Array): DecodedBoxMinterConfig {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let decoded;
  try {
    decoded = decodeBoxMinterConfigDataShared(buf, {
      validateDiscriminator: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throwBoxMinterConfigHttpsError(error);
    }
    throw error;
  }

  const dropSeed = decoded.dropSeed ? Buffer.from(decoded.dropSeed) : undefined;
  if (!decoded.paymentRouting) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter payment routing was not decoded.',
    );
  }
  const paymentRouting: DecodedBoxMinterPaymentRouting = {
    ...decoded.paymentRouting,
    mintProceeds: decoded.paymentRouting.mintProceeds.map((recipient) => ({
      address: new PublicKey(recipient.address),
      percentage: recipient.percentage,
    })),
    deliveryPaymentReceiver: new PublicKey(
      decoded.paymentRouting.deliveryPaymentReceiver,
    ),
  };
  return {
    admin: new PublicKey(decoded.admin),
    treasury: new PublicKey(decoded.treasury),
    coreCollection: new PublicKey(decoded.coreCollection),
    maxSupply: decoded.maxSupply,
    maxPerTx: decoded.maxPerTx,
    itemsPerBox: decoded.itemsPerBox,
    minted: decoded.minted,
    started: decoded.started,
    discountMintsPerWallet: decoded.discountMintsPerWallet,
    mintVariantKind: decoded.mintVariantKind,
    mintVariantStartIds: decoded.mintVariantStartIds,
    mintVariantEndIds: decoded.mintVariantEndIds,
    mintVariantNextIds: decoded.mintVariantNextIds,
    paymentRouting,
    uriBase: decoded.uriBase,
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
  if (!cfgInfo.owner.equals(dropRuntime.boxMinterProgramId)) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA has an unexpected owner.',
      {
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        expectedOwner: dropRuntime.boxMinterProgramId.toBase58(),
        actualOwner: cfgInfo.owner.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  return decodeBoxMinterConfigData(Buffer.from(cfgInfo.data));
}

function requireStripeCheckoutCollectionMatchesConfig(
  dropRuntime: DropRuntime,
  cfg: DecodedBoxMinterConfig,
  code: 'failed-precondition' | 'unavailable' = 'failed-precondition',
): void {
  if (dropRuntime.collectionMint.equals(cfg.coreCollection)) return;
  throw new HttpsError(code, 'COLLECTION_MINT does not match on-chain config', {
    configured: dropRuntime.collectionMint.toBase58(),
    onchain: cfg.coreCollection.toBase58(),
    dropId: dropRuntime.dropId,
  });
}

function stripeCheckoutFlowDeps(): StripeCheckoutFlowDeps<DropRuntime, DecodedBoxMinterConfig & StripeCheckoutOnchainConfig> {
  return {
    requireDropId,
    getDropRuntime,
    connection,
    fetchCheckoutConfig: fetchDecodedBoxMinterConfigAccount,
    ensureOnchainCoreConfig,
    requireStripeCheckoutCollectionMatchesConfig,
    cosigner,
    encryptAddress: encryptAddressPayloadForFulfillment,
    normalizeCountryCode,
    buildTx,
    sendAndConfirmSignedTx,
    withTimeout,
    isAlreadyExistsError: isGrpcAlreadyExists,
    summarizeError,
    programs: {
      bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
      mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
      mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      mplCoreProgramId: MPL_CORE_PROGRAM_ID,
      mplCoreCpiSigner: MPL_CORE_CPI_SIGNER,
    },
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    txSendTimeoutMs: TX_SEND_TIMEOUT_MS,
    txConfirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
  };
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

function buildMintReceiptsIx(args: {
  dropRuntime: DropRuntime;
  cosignerPk: PublicKey;
  recipientPk: PublicKey;
  coreCollection: PublicKey;
  boxIds: number[];
  dudeIds: number[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.dropRuntime.boxMinterProgramId,
    keys: [
      { pubkey: args.dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.cosignerPk, isSigner: true, isWritable: true },
      { pubkey: args.recipientPk, isSigner: false, isWritable: false },
      { pubkey: args.dropRuntime.receiptsMerkleTree, isSigner: false, isWritable: true },
      { pubkey: deriveTreeConfigPda(args.dropRuntime.receiptsMerkleTree), isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeMintReceiptsArgs({ boxIds: args.boxIds, dudeIds: args.dudeIds }, args.dropRuntime),
  });
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
  return assignDudesForBox({
    db,
    dropRuntime: getDropRuntime(dropId),
    boxAssetId,
    logger,
    summarizeError,
  });
}

async function ensureIrlClaimCodeForBox(params: {
  dropId: string;
  ownerWallet: string;
  deliveryId: number;
  boxAssetId: string;
  boxId: number;
  dudeIds: number[];
}): Promise<string> {
  return ensureIrlClaimCodeForBoxShared({
    db,
    dropRuntime: getDropRuntime(params.dropId),
    ownerWallet: params.ownerWallet,
    deliveryId: params.deliveryId,
    boxAssetId: params.boxAssetId,
    boxId: params.boxId,
    dudeIds: params.dudeIds,
    logger,
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

const SOLANA_MAX_RAW_TX_BYTES = 1232;
function transactionEncodingTooLarge(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    err instanceof RangeError &&
    (/encoding overruns Uint8Array/i.test(msg) ||
      /offset.*out of range/i.test(msg) ||
      String((err as any)?.code || '') === 'ERR_OUT_OF_RANGE')
  );
}

const STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL = 'ivan@ivan.lol';

async function enqueueRenderedNotificationEmail(params: {
  kind: NotificationEmailKind;
  idempotencyKey: string;
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  context: NotificationEmailJobContext;
}): Promise<void> {
  const job = createNotificationEmailJobV1(params);
  return enqueuePreparedNotificationEmail(job);
}

async function enqueuePreparedNotificationEmail(job: NotificationEmailJobV1): Promise<void> {
  try {
    await enqueueNotificationEmailJob({
      job,
      secret: envOrSecretValue('NOTIFICATION_ENQUEUE_SECRET', NOTIFICATION_ENQUEUE_SECRET),
    });
    logger.info('notificationEmail:queued', {
      jobId: job.jobId,
      kind: job.kind,
      recipientCount: job.recipients.length,
      ...job.context,
    });
  } catch (error) {
    logger.error('notificationEmail:enqueueFailed', error instanceof Error ? error : new Error(String(error)), {
      jobId: job.jobId,
      kind: job.kind,
      recipientCount: job.recipients.length,
      ...job.context,
      error: summarizeError(error),
    });
    throw error;
  }
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function sendStripeCheckoutManualReviewEmail(
  message: StripeCheckoutManualReviewEmailMessage,
): Promise<void> {
  const email = buildStripeCheckoutManualReviewEmailContent(message);
  return enqueueRenderedNotificationEmail({
    kind: 'stripe_checkout_manual_review',
    idempotencyKey: message.idempotencyKey,
    recipients: message.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
    context: { dropId: message.dropId, sessionId: message.sessionId },
  });
}

async function sendStripeReadyToShipNotifications(
  dropId: string,
  deliveryId: number,
): Promise<void> {
  const orderSnap = await db.doc(dropDeliveryOrderPath(dropId, deliveryId)).get();
  if (!orderSnap.exists) throw new Error('Stripe delivery order is missing after fulfillment');
  const jobs = await createStripeReadyToShipNotificationJobs({
    order: orderSnap.data() as Record<string, unknown>,
    dropId,
    deliveryId,
  });
  await Promise.all(jobs.map(enqueuePreparedNotificationEmail));
}

export const notifyStripeCheckoutManualReview = onDocumentUpdated(
  {
    document: 'drops/{dropId}/stripeCheckouts/{sessionId}',
    secrets: [NOTIFICATION_ENQUEUE_SECRET],
    retry: true,
  },
  async (event) => {
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    if (!beforeSnap || !afterSnap) return;
    if (
      afterSnap.get('status') === STRIPE_CHECKOUT_STATUS.FULFILLED &&
      beforeSnap.get('status') !== STRIPE_CHECKOUT_STATUS.FULFILLED
    ) {
      const dropId = requireDropId(event.params.dropId);
      const deliveryId = requirePositiveDeliveryId(afterSnap.get('deliveryId'));
      await sendStripeReadyToShipNotifications(dropId, deliveryId);
      return;
    }
    if (
      afterSnap.get('status') !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED ||
      afterSnap.get('manualRefundReviewRequired') !== true
    ) {
      return;
    }
    if (
      beforeSnap.get('status') === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
      beforeSnap.get('manualRefundReviewRequired') === true
    ) {
      return;
    }

    let dropId: string;
    let dropName: string;
    let sessionId: string;
    try {
      dropId = requireDropId(event.params.dropId);
      sessionId = requireStripeCheckoutSessionId(event.params.sessionId);
      const dropRuntime = getDropRuntime(dropId);
      dropName = dropRuntime.config.displayName || dropRuntime.config.collectionName || dropId;
    } catch (err) {
      logger.warn('notifyStripeCheckoutManualReview:invalidParams', {
        dropId: event.params.dropId,
        sessionId: event.params.sessionId,
        error: summarizeError(err),
      });
      return;
    }

    const recipient = normalizeNotificationEmailRecipient(STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL);
    if (!recipient) {
      logger.warn('notifyStripeCheckoutManualReview:invalidRecipient', { email: STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL });
      return;
    }
    const recipients = [recipient];
    const checkout = afterSnap.data() as any;
    const checkoutRef = afterSnap.ref;
    const idempotencyKey = `${dropId}:${sessionId}:stripe_manual_review`;

    await sendStripeCheckoutManualReviewEmail({
      idempotencyKey,
      recipients,
      dropId,
      dropName,
      sessionId,
      checkoutPath: checkoutRef.path,
      livemode: checkout?.livemode === true,
      variantKey: optionalTrimmedString(checkout?.variantKey),
      owner: optionalTrimmedString(checkout?.owner),
      firebaseUid: optionalTrimmedString(checkout?.firebaseUid || checkout?.uid),
      manualRefundReviewReason: optionalTrimmedString(checkout?.manualRefundReviewReason),
      lastFulfillmentError: checkout?.lastFulfillmentError,
      createdAt: toMillisMaybe(checkout?.createdAt),
      fulfillmentRequestedAt: toMillisMaybe(checkout?.fulfillmentRequestedAt),
      processingStartedAt: toMillisMaybe(checkout?.processingStartedAt),
      failedAt: toMillisMaybe(checkout?.failedAt),
    });
  },
);

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

export const processStripeCheckoutFulfillment = onDocumentWritten(
  {
    document: 'drops/{dropId}/stripeCheckouts/{sessionId}',
    secrets: [
      STRIPE_SECRET_KEY,
      STRIPE_RESTRICTED_KEY,
      STRIPE_SECRET_KEY_LIVE,
      STRIPE_RESTRICTED_KEY_LIVE,
      COSIGNER_SECRET,
      ADDRESS_DECRYPTION_SECRET,
    ],
    retry: true,
    timeoutSeconds: 180,
  },
  async (event) => {
    const beforeSnap = event.data?.before;
    const checkoutSnap = event.data?.after;
    if (!checkoutSnap?.exists) return;
    if (
      !shouldProcessStripeCheckoutFulfillmentWrite({
        beforeStatus: beforeSnap?.exists ? beforeSnap.get('status') : undefined,
        afterStatus: checkoutSnap.get('status'),
      })
    ) {
      return;
    }

    const dropId = requireDropId(event.params.dropId);
    const sessionId = requireStripeCheckoutSessionId(event.params.sessionId);
    const checkoutRef = checkoutSnap.ref;
    const result = await processStripeCheckoutFulfillmentDocument({
      db,
      dropId,
      sessionId,
      checkoutRef,
      apiKeys: stripeApiKeys(),
      deps: stripeCheckoutFlowDeps(),
    });
    if (result.status === 'ignored') {
      logger.info('processStripeCheckoutFulfillment:notProcessed', {
        dropId,
        sessionId,
        reason: result.reason,
      });
      return;
    }
    if (result.status === 'fulfilled') {
      logger.info('processStripeCheckoutFulfillment:fulfilled', {
        dropId: result.dropId || dropId,
        sessionId,
        deliveryId: result.deliveryId || null,
        metadataId: result.metadataId || null,
        metadataIds: result.metadataIds || null,
      });
      return;
    }
    logger.warn('processStripeCheckoutFulfillment:manualReviewRequired', {
      dropId,
      sessionId,
      error: result.error,
    });
  },
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
      'receiptRecovery.status': FieldValue.delete(),
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
      const mintReceiptsIx = buildMintReceiptsIx({
        dropRuntime,
        cosignerPk: signer.publicKey,
        recipientPk: ownerPk,
        coreCollection: cfgCoreCollection,
        boxIds,
        dudeIds,
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
          if (rawLen > SOLANA_MAX_RAW_TX_BYTES) {
            lastErr = new RangeError(`Receipt issuance transaction too large (${rawLen} bytes)`);
            break; // shrink `n`
          }
        } catch (err) {
          if (!transactionEncodingTooLarge(err)) throw err;
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
  void countNormalIrlPackStatus({
    db,
    dropRuntime,
    deliveryId,
    packQuantity: countDeliveryOrderBoxItems(order.items),
    unsealedCardQuantity: countDeliveryOrderDudeItems(order.items),
  }).catch((err) => {
    logger.warn('retryIssueReceiptsForDeliveryOrder:packStatusCountFailed', {
      dropId,
      deliveryId,
      error: summarizeError(err),
    });
  });
  await orderRef.update({
    'receiptRecovery.leaseExpiresAt': FieldValue.delete(),
    'receiptRecovery.lastErrorCode': FieldValue.delete(),
    'receiptRecovery.lastErrorMessage': FieldValue.delete(),
    'receiptRecovery.lastPreparedProbeAt': FieldValue.delete(),
    'receiptRecovery.preparedProbeCount': FieldValue.delete(),
    'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
    'receiptRecovery.status': FieldValue.delete(),
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
