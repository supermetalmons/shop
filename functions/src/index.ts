import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
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
import { FUNCTIONS_DEPLOYMENT, FUNCTIONS_PATHS } from './config/deployment.js';

// Firebase/Google Secret Manager secrets (Cloud Functions v2).
// Configure via: `firebase functions:secrets:set COSIGNER_SECRET`
const COSIGNER_SECRET = defineSecret('COSIGNER_SECRET');

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

const app = initializeApp();
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

const DUDES_PER_BOX = 3;
const MAX_DUDE_ID = 999;
// Hardcoded (no env / no deployment config) to avoid config sprawl.
const RPC_TIMEOUT_MS = 8_000;
// Issue-receipts tx retry/confirm tuning.
// Hardcoded (no env) to keep deployments deterministic and avoid config sprawl.
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
const TX_MAX_SEND_ATTEMPTS = 3;

const cluster: 'devnet' | 'testnet' | 'mainnet-beta' = FUNCTIONS_DEPLOYMENT.solanaCluster;
const HELIUS_RPC_BASE =
  cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';

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

function heliusRpcUrl() {
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing HELIUS_API_KEY');
  return `${HELIUS_RPC_BASE}/?api-key=${apiKey}`;
}

const rpcUrl = heliusRpcUrl();

function requireConfiguredPubkey(label: string, value: string | undefined): PublicKey {
  const v = (value || '').trim();
  if (!v) return PublicKey.default;
  try {
    return new PublicKey(v);
  } catch (err) {
    throw new Error(`${label} is invalid in functions/src/config/deployment.ts: ${String(err)}`);
  }
}

// Required: MPL-Core collection address (uncompressed collection).
const collectionMint = requireConfiguredPubkey('COLLECTION_MINT', FUNCTIONS_DEPLOYMENT.collectionMint);
const collectionMintStr = collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58();
// Drop metadata base (collection.json + json/* + images/*)
const metadataBase = FUNCTIONS_PATHS.base;

// Bubblegum receipts tree (required to mint receipt cNFTs).
const receiptsMerkleTree = requireConfiguredPubkey('RECEIPTS_MERKLE_TREE', FUNCTIONS_DEPLOYMENT.receiptsMerkleTree);
const receiptsMerkleTreeStr = receiptsMerkleTree.equals(PublicKey.default) ? '' : receiptsMerkleTree.toBase58();

const boxMinterProgramId = requireConfiguredPubkey('BOX_MINTER_PROGRAM_ID', FUNCTIONS_DEPLOYMENT.boxMinterProgramId);
const boxMinterConfigPda = PublicKey.findProgramAddressSync([Buffer.from('config')], boxMinterProgramId)[0];
// Anchor discriminator = sha256("global:finalize_open_box")[0..8]
const IX_FINALIZE_OPEN_BOX = Buffer.from('cf5e6dfd1544ed16', 'hex');
// Anchor discriminator = sha256("account:PendingOpenBox")[0..8]
const ACCOUNT_PENDING_OPEN_BOX = Buffer.from('4507451af00c43a1', 'hex');
// Anchor discriminator = sha256("global:deliver")[0..8]
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
// Anchor discriminator = sha256("global:close_delivery")[0..8]
const IX_CLOSE_DELIVERY = Buffer.from('ae641ab98ea5f208', 'hex');
// Anchor discriminator = sha256("global:mint_receipts")[0..8]
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');

// Bubblegum v2 burn discriminator (kinobi generated).
const IX_BURN_V2 = Buffer.from([115, 210, 34, 240, 232, 143, 183, 16]);

const MIN_DELIVERY_LAMPORTS = 1_000_000; // 0.001 SOL
const MAX_DELIVERY_LAMPORTS = 3_000_000; // 0.003 SOL

// Optional: Address Lookup Table to shrink delivery tx size (allows more items per tx).
// Should contain: config PDA, treasury, core collection, MPL core program id, system program id, SPL noop program id.
const deliveryLookupTable = requireConfiguredPubkey('DELIVERY_LOOKUP_TABLE', FUNCTIONS_DEPLOYMENT.deliveryLookupTable);
const deliveryLookupTableStr = deliveryLookupTable.equals(PublicKey.default) ? '' : deliveryLookupTable.toBase58();
const DELIVERY_LUT_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedDeliveryLut: AddressLookupTableAccount | null = null;
let cachedDeliveryLutAtMs = 0;

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

let cachedCosigner: Keypair | null = null;
function cosigner() {
  if (!cachedCosigner) {
    cachedCosigner = Keypair.fromSecretKey(decodeSecretKey(COSIGNER_SECRET.value(), 'COSIGNER_SECRET'));
  }
  return cachedCosigner;
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

function heliusRpcEndpoint() {
  return heliusRpcUrl();
}

function connection() {
  return new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
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
let lastOnchainConfigCheckMs = 0;
let onchainConfigOk = false;

async function ensureOnchainCoreConfig(force = false) {
  const now = Date.now();
  if (!force && onchainConfigOk && now - lastOnchainConfigCheckMs < ONCHAIN_CONFIG_CHECK_TTL_MS) return;
  lastOnchainConfigCheckMs = now;

  ensureAuthorityKeys();
  assertConfiguredProgramId(boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');

  const pubkeys = [collectionMint, boxMinterConfigPda];
  const infos = await withTimeout(
    connection().getMultipleAccountsInfo(pubkeys, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo',
  );

  const missing: Record<string, string> = {};
  for (let i = 0; i < pubkeys.length; i += 1) {
    if (infos[i]) continue;
    const key = pubkeys[i];
    const label = key.equals(collectionMint) ? 'COLLECTION_MINT' : 'BOX_MINTER_CONFIG_PDA';
    missing[label] = key.toBase58();
  }

  if (Object.keys(missing).length) {
    onchainConfigOk = false;
    throw new HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or mismatched. Re-run `npm run deploy-all-onchain`, update functions env, and redeploy.',
      {
        missing,
        collection: collectionMint.toBase58(),
        configPda: boxMinterConfigPda.toBase58(),
      },
    );
  }

  const collectionInfo = infos[0];
  if (collectionInfo && !collectionInfo.owner.equals(MPL_CORE_PROGRAM_ID)) {
    onchainConfigOk = false;
    throw new HttpsError(
      'failed-precondition',
      'COLLECTION_MINT is not an MPL Core collection account for this cluster.',
      {
        collection: collectionMint.toBase58(),
        expectedOwner: MPL_CORE_PROGRAM_ID.toBase58(),
        actualOwner: collectionInfo.owner.toBase58(),
      },
    );
  }

  onchainConfigOk = true;
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

async function heliusRpc<T>(method: string, params: any, label: string): Promise<T> {
  const url = heliusRpcEndpoint();
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

async function fetchAssetsOwned(owner: string) {
  // Helius DAS expects `grouping` as a tuple: [groupKey, groupValue]
  // (assets returned by the API use objects like { group_key, group_value }).
  //
  // NOTE: Newly minted assets can briefly miss collection-group indexing on devnet.
  // We first try the collection-group query (fast/small), then fall back to an ungrouped query
  // and filter locally by merkle tree + metadata patterns.
  const baseParams = {
    ownerAddress: owner,
    page: 1,
    limit: 1000,
    displayOptions: {
      showCollectionMetadata: true,
      showUnverifiedCollections: true,
    },
  };

  if (collectionMintStr) {
    const grouping = ['collection', collectionMintStr] as const;
    const grouped = await heliusRpc<any>('searchAssets', { ...baseParams, grouping }, 'Helius assets error');
    const items = Array.isArray(grouped?.items) ? grouped.items : [];
    if (items.length) return items;
    logger.warn('Helius searchAssets returned 0 items for collection grouping; falling back to ungrouped search', {
      owner,
      collection: collectionMintStr,
    });
  }

  const result = await heliusRpc<any>('searchAssets', baseParams, 'Helius assets error');
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

async function fetchAsset(assetId: string) {
  // Use DAS RPC to keep behavior consistent with `searchAssets` (inventory).
  let asset: any;
  try {
    asset = await heliusRpc<any>('getAsset', { id: assetId }, 'Helius asset error');
  } catch (err) {
    const anyErr = err as any;
    const upstreamCode = anyErr?.details?.upstreamCode;
    const msg = String(anyErr?.message || '');
    const looksLikeRpcMethodMismatch =
      upstreamCode === -32601 || upstreamCode === -32602 || /method not found|invalid params/i.test(msg);
    if (!looksLikeRpcMethodMismatch) throw err;
    // Fallback to legacy REST endpoint if RPC method signature isn't supported.
    const helius = process.env.HELIUS_API_KEY;
    const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
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

async function fetchAssetProof(assetId: string) {
  let proof: any;
  try {
    proof = await heliusRpc<any>('getAssetProof', { id: assetId }, 'Helius asset proof error');
  } catch (err) {
    const anyErr = err as any;
    const upstreamCode = anyErr?.details?.upstreamCode;
    const msg = String(anyErr?.message || '');
    const looksLikeRpcMethodMismatch =
      upstreamCode === -32601 || upstreamCode === -32602 || /method not found|invalid params/i.test(msg);
    if (!looksLikeRpcMethodMismatch) throw err;
    // Fallback to REST endpoint if RPC method signature isn't supported.
    const helius = process.env.HELIUS_API_KEY;
    const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
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

  const uri: string =
    asset?.content?.json_uri ||
    asset?.content?.jsonUri ||
    asset?.content?.metadata?.uri ||
    asset?.content?.metadata?.json_uri ||
    asset?.content?.metadata?.jsonUri ||
    '';
  const lowerUri = typeof uri === 'string' ? uri.toLowerCase() : '';
  if (lowerUri.includes('/json/boxes/')) return 'box';
  if (lowerUri.includes('/json/figures/')) return 'dude';
  if (lowerUri.includes('/json/receipts/')) return 'certificate';

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

  const uri: string =
    asset?.content?.json_uri ||
    asset?.content?.jsonUri ||
    asset?.content?.metadata?.uri ||
    asset?.content?.metadata?.json_uri ||
    asset?.content?.metadata?.jsonUri ||
    '';
  if (typeof uri === 'string' && uri) {
    const matchBoxes = uri.match(/\/json\/boxes\/(\d+)\.json/i);
    if (matchBoxes?.[1]) return matchBoxes[1];
    const matchReceiptBoxes = uri.match(/\/json\/receipts\/boxes\/([^/?#]+)\.json/i);
    if (matchReceiptBoxes?.[1]) return matchReceiptBoxes[1];
  }

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

  const uri: string =
    asset?.content?.json_uri ||
    asset?.content?.jsonUri ||
    asset?.content?.metadata?.uri ||
    asset?.content?.metadata?.json_uri ||
    asset?.content?.metadata?.jsonUri ||
    '';
  if (typeof uri === 'string' && uri) {
    const match = uri.match(/\/json\/figures\/(\d+)\.json/i) || uri.match(/\/json\/receipts\/figures\/(\d+)\.json/i);
    const n = Number(match?.[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isMonsAsset(asset: any): boolean {
  const kind = getAssetKind(asset);
  if (!kind) return false;

  // Primary: collection grouping match (if configured).
  if (collectionMintStr) {
    const groupingMatch = (asset?.grouping || []).some(
      (g: any) => g?.group_key === 'collection' && g?.group_value === collectionMintStr,
    );
    if (groupingMatch) return true;
  }

  // Fallbacks: allow inventory to work during collection-indexing delays.
  const uri: string = asset?.content?.json_uri || asset?.content?.jsonUri || '';
  if (typeof uri === 'string' && uri && uri.startsWith(metadataBase)) return true;

  return false;
}

async function fetchAssetRetry(assetId: string) {
  // DAS can be briefly inconsistent right after mint/transfer. Retry a few times so a newly minted
  // box that already shows in inventory can still be opened immediately.
  const startedAt = Date.now();
  const maxWaitMs = 12_000;
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts && Date.now() - startedAt < maxWaitMs; attempt++) {
    try {
      return await fetchAsset(assetId);
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

function deriveDeliveryPda(programId: PublicKey, deliveryId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('delivery'), u32LE(deliveryId)], programId);
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

function encodeFinalizeOpenBoxArgs(dudeIds: number[]): Buffer {
  if (!Array.isArray(dudeIds) || dudeIds.length !== DUDES_PER_BOX) {
    throw new HttpsError('invalid-argument', `dudeIds must have length ${DUDES_PER_BOX}`);
  }
  const ids = dudeIds.map((n) => Number(n));
  ids.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > MAX_DUDE_ID) {
      throw new HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    throw new HttpsError('invalid-argument', 'Duplicate dude ids');
  }
  return Buffer.concat([IX_FINALIZE_OPEN_BOX, ...ids.map(u16LE)]);
}

function encodeMintReceiptsArgs(args: { boxIds: number[]; dudeIds: number[] }): Buffer {
  const boxIds = Array.isArray(args.boxIds) ? args.boxIds.map((n) => Number(n)) : [];
  const dudeIds = Array.isArray(args.dudeIds) ? args.dudeIds.map((n) => Number(n)) : [];

  boxIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > 0xffff_ffff) {
      throw new HttpsError('invalid-argument', `Invalid box id: ${id}`);
    }
  });
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > MAX_DUDE_ID) {
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
} {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const minLen = 8 + 32 + 32 + 32 * DUDES_PER_BOX + 8 + 1;
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
  const dudeAssets: PublicKey[] = [];
  for (let i = 0; i < DUDES_PER_BOX; i += 1) {
    dudeAssets.push(new PublicKey(data.subarray(o, o + 32)));
    o += 32;
  }
  const createdSlot = data.readBigUInt64LE(o);
  o += 8;
  const bump = data.readUInt8(o);
  return { owner, boxAsset, dudeAssets, createdSlot, bump };
}

async function assignDudes(boxId: string): Promise<number[]> {
  const ref = db.doc(`boxAssignments/${boxId}`);
  const poolRef = db.doc('meta/dudePool');
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return (existing.data() as any).dudeIds as number[];
    const poolSnap = await tx.get(poolRef);
    const pool = (poolSnap.data() as any)?.available || Array.from({ length: MAX_DUDE_ID }, (_, i) => i + 1);
    if (pool.length < DUDES_PER_BOX) throw new Error('No dudes remaining to assign');
    const chosen: number[] = [];
    for (let i = 0; i < DUDES_PER_BOX; i += 1) {
      const pick = randomInt(0, pool.length);
      chosen.push(pool[pick]);
      pool.splice(pick, 1);
    }
    tx.set(poolRef, { available: pool }, { merge: true });
    tx.set(ref, { dudeIds: chosen, createdAt: FieldValue.serverTimestamp() });
    return chosen;
  });
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

async function ensureIrlClaimCodeForBox(params: {
  ownerWallet: string;
  deliveryId: number;
  boxAssetId: string;
  boxId: number;
  dudeIds: number[];
}): Promise<string> {
  const ownerWallet = normalizeWallet(params.ownerWallet);
  const deliveryId = Number(params.deliveryId);
  const boxAssetId = String(params.boxAssetId || '');
  const boxId = Number(params.boxId);
  const dudeIds = Array.isArray(params.dudeIds) ? params.dudeIds.map((n) => Number(n)) : [];

  if (!boxAssetId) throw new HttpsError('failed-precondition', 'Missing boxAssetId for IRL claim code');
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    throw new HttpsError('failed-precondition', 'Invalid deliveryId for IRL claim code');
  }
  if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) {
    throw new HttpsError('failed-precondition', 'Invalid box id for IRL claim code');
  }
  if (dudeIds.length !== DUDES_PER_BOX) {
    throw new HttpsError('failed-precondition', `Invalid dudeIds (expected ${DUDES_PER_BOX})`);
  }
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > MAX_DUDE_ID) {
      throw new HttpsError('failed-precondition', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new HttpsError('failed-precondition', 'Duplicate dude ids for IRL claim code');
  }

  const assignmentRef = db.doc(`boxAssignments/${boxAssetId}`);
  return db.runTransaction(async (tx) => {
    const assignmentSnap = await tx.get(assignmentRef);
    const assignment = assignmentSnap.exists ? (assignmentSnap.data() as any) : {};

    const existingCodeRaw = assignment?.irlClaimCode;
    const existingCode = typeof existingCodeRaw === 'string' ? normalizeIrlClaimCode(existingCodeRaw) : '';
    if (existingCode) {
      const existingRef = db.doc(`claimCodes/${existingCode}`);
      const existingSnap = await tx.get(existingRef);
      if (!existingSnap.exists) {
        // Backfill if the assignment doc was written but claimCodes doc was not.
        tx.set(existingRef, {
          version: 2,
          namespace: IRL_CLAIM_CODE_NAMESPACE,
          code: existingCode,
          boxId,
          boxAssetId,
          owner: ownerWallet,
          deliveryId,
          dudeIds,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return existingCode;
    }

    // Allocate a unique 10-digit claim code.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const code = generateIrlClaimCode();
      const claimRef = db.doc(`claimCodes/${code}`);
      const snap = await tx.get(claimRef);
      if (snap.exists) continue;

      tx.set(claimRef, {
        version: 2,
        namespace: IRL_CLAIM_CODE_NAMESPACE,
        code,
        boxId,
        boxAssetId,
        owner: ownerWallet,
        deliveryId,
        dudeIds,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        assignmentRef,
        {
          irlClaimCode: code,
          irlClaim: {
            namespace: IRL_CLAIM_CODE_NAMESPACE,
            code,
            boxId,
            deliveryId,
            owner: ownerWallet,
            dudeIds,
            createdAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
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

async function getDeliveryLookupTable(conn: Connection): Promise<AddressLookupTableAccount[] | []> {
  if (!deliveryLookupTableStr) return [];
  const now = Date.now();
  if (cachedDeliveryLut && now - cachedDeliveryLutAtMs < DELIVERY_LUT_CACHE_TTL_MS) return [cachedDeliveryLut];

  const res = await withTimeout(conn.getAddressLookupTable(deliveryLookupTable), RPC_TIMEOUT_MS, 'getAddressLookupTable:delivery');
  const lut = res?.value || null;
  if (!lut) {
    throw new HttpsError('failed-precondition', 'DELIVERY_LOOKUP_TABLE not found on-chain', {
      deliveryLookupTable: deliveryLookupTableStr,
      cluster,
    });
  }
  cachedDeliveryLut = lut;
  cachedDeliveryLutAtMs = now;
  return [lut];
}

function normalizeCountryCode(country?: string) {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s.]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA') return 'US';
  return '';
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

export const solanaAuth = onCallAuthed('solanaAuth', async (request, uid) => {
  const schema = z.object({ wallet: z.string(), message: z.string(), signature: z.array(z.number()) });
  const { wallet: rawWallet, message, signature } = parseRequest(schema, request.data);
  const wallet = normalizeWallet(rawWallet);
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
  const addressesSnap = await db.collection(`profiles/${wallet}/addresses`).get();
  const addresses = addressesSnap.docs.map((doc) => doc.data());
  const profileData = snap.exists ? (snap.data() as any) : {};
  if (!snap.exists) await profileRef.set({ wallet }, { merge: true });
  return {
    profile: {
      ...profileData,
      wallet,
      email: profileData.email,
      addresses,
    },
  };
});

export const getProfile = onCallLogged('getProfile', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const profileRef = db.doc(`profiles/${wallet}`);
  const snap = await profileRef.get();
  const addressesSnap = await db.collection(`profiles/${wallet}/addresses`).get();
  const addresses = addressesSnap.docs.map((doc) => doc.data());
  const profileData = snap.exists ? (snap.data() as any) : {};
  if (!snap.exists) await profileRef.set({ wallet }, { merge: true });
  return {
    profile: {
      ...profileData,
      wallet,
      email: profileData.email,
      addresses,
    },
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
    label: z.string().max(64).default('Home'),
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
    label: body.label,
    country: body.country,
    countryCode: countryCode || body.countryCode,
    encrypted: body.encrypted,
    hint: body.hint,
    email: body.email,
  };
});

export const revealDudes = onCallLogged(
  'revealDudes',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), boxAssetId: z.string() });
  const { owner, boxAssetId } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  await ensureOnchainCoreConfig();

  let boxAssetPk: PublicKey;
  try {
    boxAssetPk = new PublicKey(boxAssetId);
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid boxAssetId');
  }

  const conn = connection();

  // Load on-chain config and enforce server cosigner matches on-chain admin.
  const cfgInfo = await withTimeout(
    conn.getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig:reveal',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run deploy-all-onchain`, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  if (!collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
    });
  }

  // Read pending open record from chain.
  const programId = boxMinterProgramId;
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

  // Assign dudes NOW (after the box has already been transferred away); keep this admin-only.
  const dudeIds = await assignDudes(boxAssetId);

  const finalizeIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
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
    data: encodeFinalizeOpenBoxArgs(dudeIds),
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
  const schema = z.object({ owner: z.string(), itemIds: z.array(z.string()).min(1), addressId: z.string() });
  const { owner, itemIds, addressId } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');

  await ensureOnchainCoreConfig();

  const uniqueItemIds = Array.from(new Set(itemIds));
  if (uniqueItemIds.length !== itemIds.length) {
    throw new HttpsError('invalid-argument', 'Duplicate itemIds are not allowed');
  }

  // Keep this comfortably above realistic tx-size limits while preventing accidental huge requests.
  const MAX_ITEMS_REQUESTED = 32;
  if (uniqueItemIds.length > MAX_ITEMS_REQUESTED) {
    throw new HttpsError('invalid-argument', `Too many items in one delivery request (max ${MAX_ITEMS_REQUESTED})`);
  }

  const addressSnap = await db.doc(`profiles/${wallet}/addresses/${addressId}`).get();
  if (!addressSnap.exists) {
    throw new HttpsError('not-found', 'Address not found');
  }
  const addressData = addressSnap.data();
  const addressCountry = addressData?.countryCode || normalizeCountryCode(addressData?.country) || addressData?.country || '';

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

    const asset = await fetchAssetRetry(assetId);
    const kind = getAssetKind(asset);
    if (!kind) throw new HttpsError('failed-precondition', 'Unsupported asset type');
    if (kind === 'certificate') {
      throw new HttpsError('failed-precondition', 'Certificates cannot be delivered');
    }
    if (!isMonsAsset(asset)) {
      throw new HttpsError('failed-precondition', 'Item is not part of the Mons collection');
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
      if (!Number.isFinite(refId) || refId <= 0 || refId > MAX_DUDE_ID) {
        throw new HttpsError('failed-precondition', 'Dude id missing from metadata');
      }
      orderItems.push({
        assetId,
        kind: 'dude',
        refId,
      });
    }
  }

  // Ensure COSIGNER_SECRET matches on-chain admin, and COLLECTION_MINT matches configured core collection.
  const cfgInfo = await withTimeout(
    connection().getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run deploy-all-onchain`, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgTreasury = new PublicKey(cfgInfo.data.subarray(8 + 32, 8 + 32 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  if (!collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
    });
  }

  const programId = boxMinterProgramId;
  const ownerPk = new PublicKey(ownerWallet);
  const conn = connection();
  const addressLookupTables = await getDeliveryLookupTable(conn);

  // Allocate a unique, compact delivery id and its on-chain PDA.
  // IMPORTANT: we atomically reserve the Firestore doc via `create()` to avoid TOCTOU collisions under concurrency.
  const MAX_RAW_TX_BYTES = 1232;
  const MAX_DELIVERY_ID_ATTEMPTS = 16;
  const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

  for (let attempt = 0; attempt < MAX_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const [deliveryPda, deliveryBump] = PublicKey.findProgramAddressSync([Buffer.from('delivery'), u32LE(candidate)], programId);

    const chainInfo = await withTimeout(
      conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
      RPC_TIMEOUT_MS,
      'getAccountInfo:deliveryPda',
    );
    if (chainInfo) continue;

    const deliveryLamports = randomInt(MIN_DELIVERY_LAMPORTS, MAX_DELIVERY_LAMPORTS + 1);

    const deliverIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
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
            { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
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

    const orderRef = db.doc(`deliveryOrders/${candidate}`);
    try {
      await db.runTransaction(async (t) => {
        t.create(orderRef, {
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
          ...(deliveryLookupTableStr ? { lookupTable: deliveryLookupTableStr } : {}),
          deliveryLamports,
          createdAt: FieldValue.serverTimestamp(),
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

export const issueReceipts = onCallLogged(
  'issueReceipts',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), deliveryId: z.number().int().positive(), signature: z.string() });
  const { owner, deliveryId, signature } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');

  await ensureOnchainCoreConfig();
  if (!receiptsMerkleTreeStr) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
    );
  }

  const orderRef = db.doc(`deliveryOrders/${deliveryId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }
  const order = orderSnap.data() as any;
  if (order.owner && order.owner !== ownerWallet) {
    throw new HttpsError('permission-denied', 'Order belongs to a different wallet');
  }

  // Fast-path idempotency.
  if (order.status === 'ready_to_ship' || order.status === 'processed') {
    const conn = connection();
    const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPda(boxMinterProgramId, deliveryId);
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
          const cfgInfo = await withTimeout(
            conn.getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
            RPC_TIMEOUT_MS,
            'getAccountInfo:boxMinterConfig:lateClose',
          );
          if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
            throw new HttpsError('failed-precondition', 'Box minter config PDA not found (late close)');
          }
          const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
          const signer = cosigner();
          if (!signer.publicKey.equals(cfgAdmin)) {
            throw new HttpsError('failed-precondition', 'Server key does not match on-chain admin (late close)');
          }

          const closeIx = new TransactionInstruction({
            programId: boxMinterProgramId,
            keys: [
              { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
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
          await orderRef.set({ closeDeliveryTx, deliveryClosedAt: FieldValue.serverTimestamp() }, { merge: true });
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

  const conn = connection();
  const tx = await withTimeout(
    conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction:delivery',
  );
  if (!tx || tx.meta?.err) {
    throw new HttpsError('failed-precondition', 'Delivery transaction not found or failed');
  }

  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== ownerWallet) {
    throw new HttpsError('failed-precondition', 'Signature payer does not match owner');
  }

  // Find the deliver instruction and decode delivery id + bump.
  const keys = resolveInstructionAccounts(tx);
  const deliverIx = (tx?.transaction?.message?.compiledInstructions || []).find((ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(boxMinterProgramId)) return false;
    const dataField = (ix as any).data;
    const dataBuffer = typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
    return dataBuffer.subarray(0, 8).equals(IX_DELIVER);
  });
  if (!deliverIx) {
    throw new HttpsError('failed-precondition', 'Delivery transaction is missing box_minter deliver instruction');
  }
  const deliverDataField = (deliverIx as any).data;
  const deliverData =
    typeof deliverDataField === 'string' ? Buffer.from(bs58.decode(deliverDataField)) : Buffer.from(deliverDataField || []);
  const decoded = decodeDeliverArgs(deliverData);
  if (decoded.deliveryId !== deliveryId) {
    throw new HttpsError('failed-precondition', 'Delivery id mismatch', {
      expectedId: deliveryId,
      got: decoded.deliveryId,
    });
  }

  const accountKeyIndexesRaw: any = (deliverIx as any).accountKeyIndexes;
  const accountKeyIndexes: number[] = Array.isArray(accountKeyIndexesRaw)
    ? (accountKeyIndexesRaw as number[])
    : Array.from(accountKeyIndexesRaw || []);
  const ixAccounts = accountKeyIndexes.map((idx: number) => keys[idx]);
  const FIXED_DELIVER_ACCOUNTS = 9;
  if (ixAccounts.length < FIXED_DELIVER_ACCOUNTS) {
    throw new HttpsError('failed-precondition', 'Invalid deliver instruction accounts');
  }

  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPda(boxMinterProgramId, deliveryId);
  const deliveryPdaFromIx = ixAccounts[8];
  if (!deliveryPdaFromIx?.equals(expectedDeliveryPda)) {
    throw new HttpsError('failed-precondition', 'Delivery PDA mismatch', {
      expected: expectedDeliveryPda.toBase58(),
      got: deliveryPdaFromIx?.toBase58(),
    });
  }

  // Determine expected delivered assets (prefer order.itemIds; fall back to tx accounts).
  const itemIds: string[] = Array.isArray(order.itemIds) ? order.itemIds : [];
  const deliveredAssetsFromIx = ixAccounts.slice(FIXED_DELIVER_ACCOUNTS).map((k: PublicKey) => k.toBase58());
  if (itemIds.length && deliveredAssetsFromIx.length && itemIds.length !== deliveredAssetsFromIx.length) {
    throw new HttpsError('failed-precondition', 'Delivery item count mismatch', {
      expected: itemIds.length,
      got: deliveredAssetsFromIx.length,
    });
  }
  if (itemIds.length) {
    for (let i = 0; i < itemIds.length; i += 1) {
      if (deliveredAssetsFromIx[i] && deliveredAssetsFromIx[i] !== itemIds[i]) {
        throw new HttpsError('failed-precondition', 'Delivered asset list mismatch', {
          index: i,
          expected: itemIds[i],
          got: deliveredAssetsFromIx[i],
        });
      }
    }
  }

  // Ensure the cosigner key matches the on-chain admin (custody vault).
  const cfgInfo = await withTimeout(
    conn.getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run deploy-all, update env, and redeploy.',
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgTreasury = new PublicKey(cfgInfo.data.subarray(8 + 32, 8 + 32 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfgAdmin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }

  // Best-effort processing lock (avoid concurrent minting).
  await orderRef.set(
    { status: 'processing', deliverySignature: signature, processingAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  const expectedOrderItems: any[] = Array.isArray(order.items) ? order.items : [];
  const byAssetId = new Map<string, any>();
  expectedOrderItems.forEach((it) => {
    if (it && typeof it.assetId === 'string') byAssetId.set(it.assetId, it);
  });

  const targetAssetIds = itemIds.length ? itemIds : deliveredAssetsFromIx;
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
    if (kind === 'dude' && refId > MAX_DUDE_ID) {
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
        mplCoreBurnV1Ix({ asset: it.assetPk, coreCollection: cfgCoreCollection, authority: signer.publicKey, payer: signer.publicKey }),
      );
      const boxIds = batch.filter((it) => it.kind === 'box').map((it) => Math.floor(it.refId));
      const dudeIds = batch.filter((it) => it.kind === 'dude').map((it) => Math.floor(it.refId));
      const treeConfig = deriveTreeConfigPda(receiptsMerkleTree);
      const mintReceiptsIx = new TransactionInstruction({
        programId: boxMinterProgramId,
        keys: [
          { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false }, // config
          { pubkey: signer.publicKey, isSigner: true, isWritable: true }, // cosigner
          { pubkey: ownerPk, isSigner: false, isWritable: false }, // user
          { pubkey: receiptsMerkleTree, isSigner: false, isWritable: true }, // merkle_tree
          { pubkey: treeConfig, isSigner: false, isWritable: true }, // tree_config
          { pubkey: cfgCoreCollection, isSigner: false, isWritable: true }, // core_collection
          { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false }, // bubblegum_program
          { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
          { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compression_program
          { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mpl_core_program
          { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mpl_core_cpi_signer
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data: encodeMintReceiptsArgs({ boxIds, dudeIds }),
      });
      const instructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...burnIxs,
        mintReceiptsIx,
      ];

      let succeeded = false;

      for (let attempt = 0; attempt < Math.max(1, TX_MAX_SEND_ATTEMPTS); attempt += 1) {
        // Fresh blockhash each send attempt.
        const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash:issueReceipts');

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
          await withTimeout(conn.sendTransaction(txCandidate, { maxRetries: 2 }), TX_SEND_TIMEOUT_MS, 'sendTransaction:issueReceipts');
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
            conn.getMultipleAccountsInfo(
              batch.map((b) => b.assetPk),
              { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
            ),
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
          conn.getMultipleAccountsInfo(
            batch.map((b) => b.assetPk),
            { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
          ),
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
  const deliveredItems: any[] = Array.isArray(order.items) ? order.items : [];
  const deliveredBoxes = deliveredItems.filter((it) => it && it.kind === 'box' && typeof it.assetId === 'string');
  for (const box of deliveredBoxes) {
    const boxAssetId = String(box.assetId);
    const boxId = Number(box.refId);
    if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) continue;
    const dudeIds = await assignDudes(boxAssetId);
    const code = await ensureIrlClaimCodeForBox({ ownerWallet, deliveryId, boxAssetId, boxId, dudeIds });
    irlClaims.push({ code, boxId, boxAssetId, dudeIds });
  }

  // Mark Firestore ready-to-ship BEFORE closing on-chain delivery record.
  await orderRef.set(
    {
      status: 'ready_to_ship',
      deliverySignature: signature,
      receiptsMinted,
      receiptTxs,
      ...(irlClaims.length ? { irlClaims, irlClaimsUpdatedAt: FieldValue.serverTimestamp() } : {}),
      processedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  // Close delivery PDA (reclaim rent) after burning + minting + Firestore marking.
  let closeDeliveryTx: string | null = null;
  const deliveryInfo = await withTimeout(
    conn.getAccountInfo(expectedDeliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:deliveryPda',
  );
  if (deliveryInfo) {
    const closeIx = new TransactionInstruction({
      programId: boxMinterProgramId,
      keys: [
        { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: expectedDeliveryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeCloseDeliveryArgs({ deliveryId, deliveryBump: expectedDeliveryBump }),
    });
    const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash:closeDelivery');
    const closeTx = buildTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), closeIx], signer.publicKey, blockhash, [signer]);
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
    await orderRef.set({ closeDeliveryTx, deliveryClosedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  return { processed: true, deliveryId, receiptsMinted, receiptTxs, closeDeliveryTx };
  },
  { secrets: [COSIGNER_SECRET] },
);

export const prepareIrlClaimTx = onCallLogged(
  'prepareIrlClaimTx',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), code: z.string() });
  const { owner, code } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  await ensureOnchainCoreConfig();

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
  const boxIdNum = Number(claim?.boxId);
  const boxIdStr = claim?.boxId != null ? String(claim.boxId) : '';
  if (!Number.isFinite(boxIdNum) || boxIdNum <= 0 || boxIdNum > 0xffff_ffff || !boxIdStr) {
    throw new HttpsError('failed-precondition', 'Claim code is missing a valid box id');
  }

  const dudeIdsRaw = claim?.dudeIds ?? claim?.dude_ids ?? claim?.dudes ?? [];
  const dudeIds: number[] = Array.isArray(dudeIdsRaw) ? dudeIdsRaw.map((n: any) => Number(n)) : [];
  if (dudeIds.length !== DUDES_PER_BOX) {
    throw new HttpsError('failed-precondition', `Claim has invalid dudeIds (expected ${DUDES_PER_BOX})`);
  }
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > MAX_DUDE_ID) {
      throw new HttpsError('failed-precondition', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new HttpsError('failed-precondition', 'Duplicate dude ids in claim');
  }

  // Load wallet assets once and use it for both:
  // - detecting an already-claimed code (dude receipts already present)
  // - finding the matching box certificate in the wallet
  const ownedAssets = await fetchAssetsOwned(ownerWallet);

  // If any of the expected dude receipts are already in the wallet, the claim is already done.
  // (The claim tx is atomic; once any of these exist, the box certificate must already be burned.)
  const dudeSet = new Set(dudeIds.map((n) => Number(n)));
  const mintedDudeReceipts = new Set<number>();
  for (const a of ownedAssets) {
    if (getAssetKind(a) !== 'certificate') continue;
    const id = getDudeIdFromAsset(a);
    if (id != null && dudeSet.has(Number(id))) mintedDudeReceipts.add(Number(id));
  }
  if (mintedDudeReceipts.size > 0) {
    throw new HttpsError('failed-precondition', 'This IRL claim code has already been used');
  }

  // Locate the matching box certificate (receipt) in the requesting wallet.
  const certificate =
    ownedAssets.find((asset: any) => getAssetKind(asset) === 'certificate' && getBoxIdFromAsset(asset) === boxIdStr) || null;
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
  if (!isMonsAsset(certificate)) {
    throw new HttpsError('failed-precondition', 'Certificate is outside the Mons collection');
  }
  const certificateId = String(certificate.id || '');

  // Load on-chain config so we can build correct burn + mint instructions.
  const cfgInfo = await withTimeout(
    connection().getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig:claimIrl',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run deploy-all, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfgAdmin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  if (!collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
    });
  }

  const conn = connection();
  if (!receiptsMerkleTreeStr) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
    );
  }

  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];

  // All receipts/certificates in this repo are Bubblegum v2 compressed cNFTs.
  // (We intentionally do NOT support uncompressed receipt assets anymore.)
  const compression = (certificate as any)?.compression || {};
  const proof = await fetchAssetProof(certificateId);
  const proofPath: string[] = Array.isArray(proof?.proof) ? proof.proof : [];
  const treeId = String(proof?.tree_id ?? proof?.treeId ?? '');
  const rootStr = String(proof?.root || '');
  if (!treeId || !rootStr) {
    throw new HttpsError('failed-precondition', 'Unable to fetch certificate proof for burn');
  }
  const merkleTree = new PublicKey(treeId);
  if (!merkleTree.equals(receiptsMerkleTree)) {
    throw new HttpsError('failed-precondition', 'Certificate does not belong to the configured receipts tree', {
      certificateTree: merkleTree.toBase58(),
      receiptsTree: receiptsMerkleTree.toBase58(),
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

  // 2) Mint the 3 dude receipt cNFTs (server-cosigned via box_minter CPI to Bubblegum mintV2).
  const treeConfig = deriveTreeConfigPda(receiptsMerkleTree);
  instructions.push(
    new TransactionInstruction({
      programId: boxMinterProgramId,
      keys: [
        { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false }, // config
        { pubkey: signer.publicKey, isSigner: true, isWritable: true }, // cosigner
        { pubkey: ownerPk, isSigner: false, isWritable: false }, // user
        { pubkey: receiptsMerkleTree, isSigner: false, isWritable: true }, // merkle_tree
        { pubkey: treeConfig, isSigner: false, isWritable: true }, // tree_config
        { pubkey: cfgCoreCollection, isSigner: false, isWritable: true }, // core_collection
        { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false }, // bubblegum_program
        { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
        { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compression_program
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mpl_core_program
        { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mpl_core_cpi_signer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: encodeMintReceiptsArgs({ boxIds: [], dudeIds }),
    }),
  );

  // Prefer building without LUT first (wallet UX / preview tends to behave better),
  // but fall back to the delivery ALT if needed to fit under Solana's packet limit.
  let addressLookupTables: AddressLookupTableAccount[] = [];
  try {
    addressLookupTables = await getDeliveryLookupTable(conn);
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
          { receiptsMerkleTree: receiptsMerkleTreeStr },
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
        deliveryLookupTable: deliveryLookupTableStr,
        receiptsMerkleTree: receiptsMerkleTreeStr,
      },
    );
  }

  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    certificates: dudeIds,
    certificateId,
    message: 'Sign and send to burn your box receipt and mint your dude receipts.',
  };
  },
  { secrets: [COSIGNER_SECRET] },
);
