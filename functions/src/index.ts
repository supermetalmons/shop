import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import * as functions from 'firebase-functions';
import {
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import nacl from 'tweetnacl';
import { randomBytes, randomInt } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { fileURLToPath } from 'url';

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
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

type CallableReq<T = any> = functions.https.CallableRequest<T>;

function uidFromRequest(request: CallableReq<any>): string | null {
  return request.auth?.uid || null;
}

function requireAuth(request: CallableReq<any>): string {
  const uid = uidFromRequest(request);
  if (!request.auth || !uid) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  return uid;
}

const WALLET_SESSION_COLLECTION = 'authSessions';
const WALLET_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeWallet(wallet: string): string {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid wallet address');
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
      throw new functions.https.HttpsError('unauthenticated', 'Sign in with your wallet first.');
    }
  }

  const expiresAt = data?.expiresAt;
  if (expiresAt && typeof expiresAt.toMillis === 'function' && expiresAt.toMillis() < Date.now()) {
    throw new functions.https.HttpsError('unauthenticated', 'Wallet session expired. Sign in again.');
  }

  return { uid, wallet: normalizeWallet(wallet) };
}

const DUDES_PER_BOX = 3;
const MAX_DUDE_ID = 999;
const CLAIM_LOCK_WINDOW_MS = 5 * 60 * 1000;
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 8_000);

// Hardcode devnet for now to avoid cluster mismatches while iterating.
const cluster: 'devnet' | 'testnet' | 'mainnet-beta' = 'devnet';
const HELIUS_DEVNET_RPC = 'https://devnet.helius-rpc.com';

// MPL Core program id (uncompressed Core assets).
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

function heliusRpcUrl() {
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing HELIUS_API_KEY');
  return `${HELIUS_DEVNET_RPC}/?api-key=${apiKey}`;
}

const rpcUrl = heliusRpcUrl();

// Required: MPL-Core collection address (uncompressed collection).
const collectionMint = new PublicKey(process.env.COLLECTION_MINT || PublicKey.default.toBase58());
const collectionMintStr = collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58();
const shippingVault = new PublicKey(process.env.DELIVERY_VAULT || PublicKey.default.toBase58());
const DEFAULT_METADATA_BASE = 'https://assets.mons.link/shop/drops/1';
const metadataBase = (process.env.METADATA_BASE || DEFAULT_METADATA_BASE).replace(/\/$/, '');

const boxMinterProgramId = new PublicKey(process.env.BOX_MINTER_PROGRAM_ID || PublicKey.default.toBase58());
const boxMinterConfigPda = PublicKey.findProgramAddressSync([Buffer.from('config')], boxMinterProgramId)[0];
// Anchor discriminator = sha256("global:open_box")[0..8]
const IX_OPEN_BOX = Buffer.from('e1dc0a68ad97d6c7', 'hex');
// Anchor discriminator = sha256("global:deliver")[0..8]
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
// Anchor discriminator = sha256("global:mint_receipts")[0..8]
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');

const MIN_DELIVERY_LAMPORTS = 1_000_000; // 0.001 SOL
const MAX_DELIVERY_LAMPORTS = 3_000_000; // 0.003 SOL

function assertConfiguredProgramId(key: PublicKey, label: string) {
  if (key.equals(PublicKey.default)) {
    throw new functions.https.HttpsError('failed-precondition', `${label} is not configured (missing env var)`);
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
    cachedCosigner = Keypair.fromSecretKey(decodeSecretKey(process.env.COSIGNER_SECRET, 'COSIGNER_SECRET'));
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
    throw new functions.https.HttpsError('invalid-argument', details || 'Invalid request payload');
  }
  return parsed.data;
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
  return {
    uid: request.auth?.uid || null,
    origin: headers.origin || null,
    referer: headers.referer || null,
    userAgent: headers['user-agent'] || null,
    ip: ip || null,
    trace: headers['x-cloud-trace-context'] || null,
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
    return { kind: err.name, message: err.message, stack: err.stack };
  }
  return { kind: typeof err, message: String(err) };
}

function onCallLogged<TReq, TRes>(
  name: string,
  handler: (request: CallableReq<TReq>) => Promise<TRes>,
) {
  return functions.https.onCall(async (request: CallableReq<TReq>) => {
    const startedAt = Date.now();
    const debug = (request as any)?.data?.__debug as any;
    const debugCallId = typeof debug?.callId === 'string' ? debug.callId : null;
    const baseMeta = { ...callableMeta(request), debugCallId };
    try {
      functions.logger.info(`${name}:call`, { ...baseMeta, data: summarizePayload((request as any).data) });
    } catch (logErr) {
      // Never fail the function because structured logging couldn't serialize something.
      console.error(`${name}:call logger failed`, { logError: summarizeError(logErr), meta: baseMeta });
    }
    try {
      const result = await handler(request);
      const ms = Date.now() - startedAt;
      try {
        functions.logger.info(`${name}:ok`, { ...baseMeta, ms });
      } catch (logErr) {
        console.error(`${name}:ok logger failed`, { logError: summarizeError(logErr), meta: baseMeta, ms });
      }
      return result;
    } catch (err) {
      const ms = Date.now() - startedAt;
      try {
        const errorForLog = err instanceof Error ? err : new Error(String(err));
        functions.logger.error(`${name}:error`, errorForLog, { ...baseMeta, ms, error: summarizeError(err) });
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
) {
  return onCallLogged<TReq, TRes>(name, async (request: CallableReq<TReq>) => {
    const uid = requireAuth(request);
    return handler(request, uid);
  });
}

function heliusRpcEndpoint() {
  return heliusRpcUrl();
}

function memoInstruction(data: string) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(data),
  });
}

function connection() {
  return new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = sleep(ms).then(() => {
    throw new functions.https.HttpsError('deadline-exceeded', `${label} timed out after ${ms}ms`);
  });
  return Promise.race([promise, timeout]);
}

function assertConfiguredPublicKey(key: PublicKey, label: string) {
  if (key.equals(PublicKey.default)) {
    throw new functions.https.HttpsError('failed-precondition', `${label} is not configured (missing env var)`);
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
    throw new functions.https.HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or mismatched. Re-run `npm run box-minter:deploy-all`, update functions env, and redeploy.',
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
    throw new functions.https.HttpsError(
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

function isTxSizeError(err: unknown) {
  const anyErr = err as any;
  const message = typeof anyErr?.message === 'string' ? anyErr.message : '';
  if (anyErr instanceof RangeError && message.includes('encoding overruns Uint8Array')) return true;
  const lower = message.toLowerCase();
  return lower.includes('transaction too large') || lower.includes('encoding overruns') || lower.includes('too large');
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
        throw new functions.https.HttpsError('not-found', `${label}: not found (Helius 404)`, { status });
      }
      if (status === 400) {
        throw new functions.https.HttpsError('invalid-argument', `${label}: bad request (Helius 400)`, { status });
      }
      if (status === 401 || status === 403) {
        throw new functions.https.HttpsError('failed-precondition', `${label}: unauthorized (check Helius API key)`, {
          status,
        });
      }
      if (status === 429) {
        throw new functions.https.HttpsError('resource-exhausted', `${label}: rate limited`, { status });
      }
      if (status >= 500) {
        throw new functions.https.HttpsError('unavailable', `${label}: upstream unavailable`, { status });
      }
      throw new functions.https.HttpsError('unknown', `${label}: HTTP ${status}`, { status });
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
        throw new functions.https.HttpsError('unavailable', `${label}: request failed`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(backoffMs * 2 ** attempt);
    }
  }
  // Unreachable, but keeps TS happy.
  throw new functions.https.HttpsError('unavailable', `${label}: request failed`);
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
    functions.logger.warn('Helius RPC error', {
      method,
      label,
      status: res.status,
      upstreamCode,
      message,
    });
    throw new functions.https.HttpsError('unavailable', `${label}: ${message}`, {
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
    functions.logger.warn('Helius searchAssets returned 0 items for collection grouping; falling back to ungrouped search', {
      owner,
      collection: collectionMintStr,
    });
  }

  const result = await heliusRpc<any>('searchAssets', baseParams, 'Helius assets error');
  return Array.isArray(result?.items) ? result.items : [];
}

async function findCertificateForBox(owner: string, boxId: string) {
  if (!boxId) return null;
  const assets = await fetchAssetsOwned(owner);
  return assets.find((asset: any) => getAssetKind(asset) === 'certificate' && getBoxIdFromAsset(asset) === boxId) || null;
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
    throw new functions.https.HttpsError(
      'not-found',
      'Asset not found. If you just minted/transferred/opened this item, wait a few seconds and retry.',
      { assetId },
    );
  }
  return asset;
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

function u64LE(value: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function decodeU64LEAsNumber(buf: Buffer, offset: number, label: string): number {
  const n = buf.readBigUInt64LE(offset);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new functions.https.HttpsError('failed-precondition', `${label} is too large`);
  }
  return Number(n);
}

function decodeDeliverIxData(data: Buffer): { deliveryId: number; feeLamports: number; itemsLen: number } {
  if (data.length < 8 + 4 + 8 + 4) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid deliver instruction data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(IX_DELIVER)) {
    throw new functions.https.HttpsError('invalid-argument', 'Transaction is not a box_minter deliver instruction');
  }
  const deliveryId = data.readUInt32LE(8);
  const feeLamports = decodeU64LEAsNumber(data, 12, 'delivery_fee_lamports');
  const itemsLen = data.readUInt32LE(20);
  return { deliveryId, feeLamports, itemsLen };
}

function decodeDeliverIxItems(data: Buffer): Array<{ kind: number; refId: number }> {
  const decoded = decodeDeliverIxData(data);
  const items: Array<{ kind: number; refId: number }> = [];
  let o = 8 + 4 + 8 + 4; // discriminator + delivery_id + fee + vec_len
  for (let i = 0; i < decoded.itemsLen; i += 1) {
    if (o + 1 + 4 > data.length) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid deliver instruction data (truncated items)');
    }
    const kind = data[o];
    o += 1;
    const refId = data.readUInt32LE(o);
    o += 4;
    items.push({ kind, refId });
  }
  return items;
}

function normalizeU64(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.floor(value));
  if (typeof value === 'string' && value) {
    try {
      const n = BigInt(value);
      if (n >= 0n) return n;
    } catch {
      // handled below
    }
  }
  throw new functions.https.HttpsError('invalid-argument', `${label} must be a non-negative u64`);
}

function encodeOpenBoxArgs(dudeIds: number[]): Buffer {
  if (!Array.isArray(dudeIds) || dudeIds.length !== DUDES_PER_BOX) {
    throw new functions.https.HttpsError('invalid-argument', `dudeIds must have length ${DUDES_PER_BOX}`);
  }
  const ids = dudeIds.map((n) => Number(n));
  ids.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > MAX_DUDE_ID) {
      throw new functions.https.HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    throw new functions.https.HttpsError('invalid-argument', 'Duplicate dude ids');
  }
  return Buffer.concat([IX_OPEN_BOX, ...ids.map(u16LE)]);
}

function encodeMintReceiptsArgs(args: { kind: number; refIds: number[] }): Buffer {
  const kind = Number(args.kind);
  if (!Number.isFinite(kind) || ![0, 1].includes(kind)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid receipt kind');
  }
  const refIds = Array.isArray(args.refIds) ? args.refIds.map((n) => Number(n)) : [];
  if (!refIds.length) {
    throw new functions.https.HttpsError('invalid-argument', 'refIds must be non-empty');
  }
  refIds.forEach((id) => {
    if (!Number.isFinite(id) || id <= 0 || id > 0xffff_ffff) {
      throw new functions.https.HttpsError('invalid-argument', `Invalid refId: ${id}`);
    }
  });

  return Buffer.concat([IX_MINT_RECEIPTS, Buffer.from([kind & 0xff]), u32LE(refIds.length), ...refIds.map(u32LE)]);
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

async function ensureClaimCode(boxId: string, boxAssetId: string, dudeIds: number[], owner: string) {
  const existing = await db.collection('claimCodes').where('boxId', '==', boxId).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;
  let code = '';
  let ref = db.doc(`claimCodes/placeholder`);
  do {
    code = randomBytes(4).toString('hex').toUpperCase();
    ref = db.doc(`claimCodes/${code}`);
  } while ((await ref.get()).exists);

  await ref.set({
    boxId,
    boxAssetId,
    dudeIds,
    owner,
    createdAt: FieldValue.serverTimestamp(),
  });
  return code;
}

function buildTx(instructions: TransactionInstruction[], payer: PublicKey, recentBlockhash: string, signers: Keypair[] = []) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (signers.length) tx.sign(signers);
  return tx;
}

function normalizeCountryCode(country?: string) {
  const normalized = (country || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[\s.]/g, '');
  if (compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA') return 'US';
  return '';
}

function shippingZone(country?: string): 'us' | 'intl' {
  const code = normalizeCountryCode(country);
  if (code === 'US' || code === 'PR' || code === 'GU' || code === 'VI' || code === 'AS') return 'us';
  const normalized = (country || '').trim().toLowerCase();
  if (normalized.includes('united states')) return 'us';
  return 'intl';
}

function shippingLamports(country: string, items: number) {
  const zone = shippingZone(country);
  const base = zone === 'us' ? 0.15 : 0.32;
  const multiplier = Math.max(1, items * 0.35);
  return Math.round(base * multiplier * LAMPORTS_PER_SOL);
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

function extractMemos(tx: any): string[] {
  const keys = resolveInstructionAccounts(tx);
  return (tx?.transaction?.message?.compiledInstructions || []).reduce((memos: string[], ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(MEMO_PROGRAM_ID)) return memos;
    const dataField = (ix as any).data;
    const dataBuffer =
      typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
    const text = dataBuffer.toString();
    return text ? [...memos, text] : memos;
  }, []);
}

function findClaimMemo(tx: any, code: string) {
  const memos = extractMemos(tx);
  return memos.find((m) => m === `claim:${code}` || m.startsWith(`claim:${code}:`));
}

function extractCompressedAssetIds(tx: any) {
  const logs: string[] = tx?.meta?.logMessages || [];
  const regex = /asset(?:\s+|-)id[:\s]*([1-9A-HJ-NP-Za-km-z]{32,44})/i;
  const found = new Set<string>();
  logs.forEach((line) => {
    const match = typeof line === 'string' ? line.match(regex) : null;
    if (match?.[1]) found.add(match[1]);
  });
  return Array.from(found);
}

function lamportsDeltaForAccount(tx: any, account: PublicKey): number {
  const keys = resolveInstructionAccounts(tx);
  const idx = keys.findIndex((k) => k.equals(account));
  if (idx === -1) return 0;
  const pre = Number(tx?.meta?.preBalances?.[idx] || 0);
  const post = Number(tx?.meta?.postBalances?.[idx] || 0);
  return post - pre;
}

async function processClaimSignature(code: string, signature: string, owner: string) {
  const tx = await withTimeout(
    connection().getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction',
  );
  if (!tx || tx.meta?.err) return null;
  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== owner) return null;
  const memo = findClaimMemo(tx, code);
  if (!memo) return null;
  return { signature, payer: payer.toBase58(), memo };
}

async function detectClaimOnChain(code: string, owner: string, limit = 20): Promise<string | null> {
  const sigs = await withTimeout(
    connection().getSignaturesForAddress(new PublicKey(owner), { limit }),
    RPC_TIMEOUT_MS,
    'getSignaturesForAddress',
  );
  for (const sig of sigs) {
    if (sig.err) continue;
    const processed = await processClaimSignature(code, sig.signature, owner);
    if (processed) return processed.signature;
  }
  return null;
}

export const solanaAuth = onCallAuthed('solanaAuth', async (request, uid) => {
  const schema = z.object({ wallet: z.string(), message: z.string(), signature: z.array(z.number()) });
  const { wallet: rawWallet, message, signature } = parseRequest(schema, request.data);
  const wallet = normalizeWallet(rawWallet);
  const pubkey = new PublicKey(wallet);
  const verified = nacl.sign.detached.verify(new TextEncoder().encode(message), parseSignature(signature), pubkey.toBytes());
  if (!verified) throw new functions.https.HttpsError('unauthenticated', 'Invalid signature');

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
  const schema = z.object({
    encrypted: z.string(),
    country: z.string(),
    countryCode: z.string().optional(),
    label: z.string().default('Home'),
    hint: z.string(),
    email: z.string().email().optional(),
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

export const prepareOpenBoxTx = onCallLogged('prepareOpenBoxTx', async (request) => {
  const schema = z.object({ owner: z.string(), boxAssetId: z.string() });
  const { owner, boxAssetId } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  const ownerPk = new PublicKey(ownerWallet);

  await ensureOnchainCoreConfig();

  let asset: any;
  try {
    asset = await fetchAssetRetry(boxAssetId);
  } catch (err) {
    const anyErr = err as any;
    if (anyErr && typeof anyErr === 'object' && anyErr.code === 'not-found') {
      throw new functions.https.HttpsError(
        'not-found',
        'Box not found. If you already opened this box, it has been burned. If you just minted/transferred it, wait a few seconds and try again.',
        { boxAssetId, cluster },
      );
    }
    throw err;
  }

  const kind = getAssetKind(asset);
  if (kind !== 'box') {
    throw new functions.https.HttpsError('failed-precondition', 'Only blind boxes can be opened');
  }
  if (!isMonsAsset(asset)) {
    throw new functions.https.HttpsError('failed-precondition', 'Item is not part of the Mons collection');
  }
  const assetOwner = asset?.ownership?.owner;
  if (assetOwner !== ownerWallet) {
    throw new functions.https.HttpsError('failed-precondition', 'Box not owned by wallet');
  }

  // Ensure the provided COSIGNER_SECRET matches the on-chain box minter admin (config PDA),
  // and ensure COLLECTION_MINT matches the on-chain configured core collection.
  const cfgInfo = await withTimeout(
    connection().getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run box-minter:deploy-all`, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  if (!collectionMint.equals(cfgCoreCollection)) {
    throw new functions.https.HttpsError('failed-precondition', 'COLLECTION_MINT env var does not match on-chain config', {
      env: collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
    });
  }

  // Assign dudes deterministically per box, reserving globally unique IDs in Firestore.
  const dudeIds = await assignDudes(boxAssetId);
  const programId = boxMinterProgramId;
  const dudeAssetPdas = dudeIds.map((id) =>
    PublicKey.findProgramAddressSync([Buffer.from('dude'), u16LE(id)], programId)[0],
  );

  let boxAssetPk: PublicKey;
  try {
    boxAssetPk = new PublicKey(boxAssetId);
  } catch {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid boxAssetId');
  }

  const openBoxIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: ownerPk, isSigner: true, isWritable: true },
      { pubkey: boxAssetPk, isSigner: false, isWritable: true },
      { pubkey: cfgCoreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...dudeAssetPdas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeOpenBoxArgs(dudeIds),
  });

  const conn = connection();
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), openBoxIx];

  const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash');
  const msg = new TransactionMessage({ payerKey: ownerPk, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);

  const raw = tx.serialize();
  const MAX_RAW_TX_BYTES = 1232;
  if (raw.length > MAX_RAW_TX_BYTES) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Open box transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}). Try again or contact support.`,
      {
        rawBytes: raw.length,
        maxRawBytes: MAX_RAW_TX_BYTES,
        base64Chars: Buffer.from(raw).toString('base64').length,
      },
    );
  }

  return { encodedTx: Buffer.from(raw).toString('base64'), assignedDudeIds: dudeIds };
});

export const createDeliveryOrder = onCallLogged('createDeliveryOrder', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), itemIds: z.array(z.string()).min(1), addressId: z.string() });
  const { owner, itemIds, addressId } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new functions.https.HttpsError('permission-denied', 'Owners only');

  // Keep server-side limits conservative; client will also enforce tx size limits.
  if (itemIds.length > 8) {
    throw new functions.https.HttpsError('invalid-argument', 'Too many items in one delivery request (max 8)');
  }

  await ensureOnchainCoreConfig();

  const addressSnap = await db.doc(`profiles/${wallet}/addresses/${addressId}`).get();
  if (!addressSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Address not found');
  }
  const addressData = addressSnap.data();
  const addressCountry = addressData?.countryCode || normalizeCountryCode(addressData?.country) || addressData?.country || '';

  // Pre-validate items and prepare any claim codes for delivered boxes.
  // This keeps cosigning strict and lets the client build transactions deterministically.
  const orderItems: any[] = [];
  for (const assetId of itemIds) {
    const asset = await fetchAssetRetry(assetId);
    const kind = getAssetKind(asset);
    if (!kind) throw new functions.https.HttpsError('failed-precondition', 'Unsupported asset type');
    if (kind === 'certificate') {
      throw new functions.https.HttpsError('failed-precondition', 'Certificates are already delivery outputs');
    }
    if (!isMonsAsset(asset)) {
      throw new functions.https.HttpsError('failed-precondition', 'Item is not part of the Mons collection');
    }
    const assetOwner = asset?.ownership?.owner;
    if (assetOwner !== ownerWallet) {
      throw new functions.https.HttpsError('failed-precondition', 'Item not owned by wallet');
    }

    if (kind === 'box') {
      const boxIdStr = getBoxIdFromAsset(asset);
      const refId = Number(boxIdStr);
      if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
        throw new functions.https.HttpsError('failed-precondition', 'Box id missing from metadata');
      }

      const dudeIds = await assignDudes(assetId);
      const claimCode = await ensureClaimCode(String(refId), assetId, dudeIds, ownerWallet);
      orderItems.push({ assetId, kind: 'box', refId, boxId: String(refId), dudeIds, claimCode });
    } else {
      const dudeId = getDudeIdFromAsset(asset);
      const refId = Number(dudeId);
      if (!Number.isFinite(refId) || refId <= 0 || refId > MAX_DUDE_ID) {
        throw new functions.https.HttpsError('failed-precondition', 'Dude id missing from metadata');
      }
      orderItems.push({ assetId, kind: 'dude', refId });
    }
  }

  const orderId = db.collection('deliveryOrders').doc().id;
  const deliveryLamports = randomInt(MIN_DELIVERY_LAMPORTS, MAX_DELIVERY_LAMPORTS + 1);
  // Small on-chain-friendly id (u32-ish). Stored + later embedded in the on-chain instruction data.
  const deliveryId = randomInt(1, 2 ** 31);

  await db.doc(`deliveryOrders/${orderId}`).set({
    status: 'prepared',
    owner: ownerWallet,
    addressId,
    addressSnapshot: {
      ...addressData,
      id: addressId,
      countryCode: addressCountry || addressData?.countryCode,
    },
    itemIds,
    items: orderItems,
    deliveryId,
    deliveryLamports,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { orderId, deliveryId, deliveryLamports };
});

export const cosignDeliveryTx = onCallLogged('cosignDeliveryTx', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), orderId: z.string(), encodedTx: z.string() });
  const { owner, orderId, encodedTx } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new functions.https.HttpsError('permission-denied', 'Owners only');

  await ensureOnchainCoreConfig();

  const orderRef = db.doc(`deliveryOrders/${orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Delivery order not found');
  }
  const order = orderSnap.data() as any;
  if (order.owner && order.owner !== ownerWallet) {
    throw new functions.https.HttpsError('permission-denied', 'Order belongs to a different wallet');
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(encodedTx, 'base64'));
  } catch (err) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid transaction payload (decode failed)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Validate payer == owner wallet.
  const payerKey = tx.message.staticAccountKeys?.[0];
  if (!payerKey || payerKey.toBase58() !== ownerWallet) {
    throw new functions.https.HttpsError('failed-precondition', 'Transaction payer does not match owner');
  }

  assertConfiguredProgramId(boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');

  // Load on-chain config (admin/treasury/core collection) so we can strictly validate the instruction accounts.
  const cfgInfo = await withTimeout(
    connection().getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run box-minter:deploy-all`, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgTreasury = new PublicKey(cfgInfo.data.subarray(8 + 32, 8 + 32 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  if (!collectionMint.equals(cfgCoreCollection)) {
    throw new functions.https.HttpsError('failed-precondition', 'COLLECTION_MINT env var does not match on-chain config', {
      env: collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
    });
  }

  // Find the box_minter instruction and decode its args.
  const keys = tx.message.staticAccountKeys;
  const ix = (tx.message.compiledInstructions || []).find((ci: any) => {
    const program = keys?.[ci.programIdIndex];
    return program && program.equals(boxMinterProgramId);
  });
  if (!ix) {
    throw new functions.https.HttpsError('failed-precondition', 'Missing box_minter instruction in transaction');
  }

  const ixData = Buffer.from(ix.data || []);
  const decoded = decodeDeliverIxData(ixData);
  const decodedItems = decodeDeliverIxItems(ixData);
  const expectedFee = Number(order.deliveryLamports || order.shippingLamports || 0);
  const expectedId = Number(order.deliveryId || 0);

  if (!expectedFee || !expectedId) {
    throw new functions.https.HttpsError('failed-precondition', 'Order is missing delivery fee/id (recreate order)');
  }
  if (decoded.deliveryId !== expectedId) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery id mismatch', {
      expectedId,
      got: decoded.deliveryId,
    });
  }
  if (decoded.feeLamports !== expectedFee) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery fee mismatch', {
      expectedFee,
      got: decoded.feeLamports,
    });
  }
  if (decoded.feeLamports < MIN_DELIVERY_LAMPORTS || decoded.feeLamports > MAX_DELIVERY_LAMPORTS) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery fee is out of bounds', {
      feeLamports: decoded.feeLamports,
      min: MIN_DELIVERY_LAMPORTS,
      max: MAX_DELIVERY_LAMPORTS,
    });
  }
  const expectedItems = Array.isArray(order.itemIds) ? order.itemIds.length : 0;
  if (expectedItems && decoded.itemsLen !== expectedItems) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery item count mismatch', {
      expectedItems,
      got: decoded.itemsLen,
    });
  }

  // Require that the server cosigner is a required signer on this tx (so on-chain can enforce approval).
  const header: any = (tx.message as any).header;
  const numRequired = Number(header?.numRequiredSignatures || 0);
  const required = keys.slice(0, Math.max(0, numRequired)).map((k) => k.toBase58());
  if (!required.includes(signer.publicKey.toBase58())) {
    throw new functions.https.HttpsError('failed-precondition', 'Transaction is missing required server cosigner', {
      requiredSigners: required,
      expectedCosigner: signer.publicKey.toBase58(),
    });
  }

  // Validate deliver instruction account list matches the expected order items and on-chain config.
  const accountKeyIndexesRaw: any = (ix as any).accountKeyIndexes;
  const accountKeyIndexes: number[] = Array.isArray(accountKeyIndexesRaw)
    ? (accountKeyIndexesRaw as number[])
    : Array.from(accountKeyIndexesRaw || []);
  const ixAccounts = accountKeyIndexes.map((idx: number) => keys[idx]);
  const FIXED_DELIVER_ACCOUNTS = 7;
  const expectedAccountLen = FIXED_DELIVER_ACCOUNTS + decoded.itemsLen * 2;
  if (ixAccounts.length !== expectedAccountLen) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid deliver instruction accounts', {
      expectedAccountLen,
      got: ixAccounts.length,
    });
  }
  if (!ixAccounts[0]?.equals(boxMinterConfigPda)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid config PDA in deliver instruction');
  }
  if (!ixAccounts[1]?.equals(signer.publicKey)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid cosigner in deliver instruction');
  }
  if (!ixAccounts[2]?.equals(payerKey)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid payer in deliver instruction');
  }
  if (!ixAccounts[3]?.equals(cfgTreasury)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid treasury in deliver instruction');
  }
  if (!ixAccounts[4]?.equals(cfgCoreCollection)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid core collection in deliver instruction');
  }
  if (!ixAccounts[5]?.equals(MPL_CORE_PROGRAM_ID)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid MPL Core program id in deliver instruction');
  }
  if (!ixAccounts[6]?.equals(SystemProgram.programId)) {
    throw new functions.https.HttpsError('failed-precondition', 'Invalid system program in deliver instruction');
  }

  const expectedItemIds = Array.isArray(order.itemIds) ? (order.itemIds as string[]) : [];
  const expectedOrderItems = Array.isArray(order.items) ? (order.items as any[]) : [];
  for (let i = 0; i < decoded.itemsLen; i += 1) {
    const burnAccount = ixAccounts[FIXED_DELIVER_ACCOUNTS + i * 2];
    const receiptAccount = ixAccounts[FIXED_DELIVER_ACCOUNTS + i * 2 + 1];

    const expectedAssetId = expectedItemIds[i];
    if (expectedAssetId) {
      const expectedBurn = new PublicKey(expectedAssetId);
      if (!burnAccount?.equals(expectedBurn)) {
        throw new functions.https.HttpsError('failed-precondition', 'Delivery burn asset mismatch', {
          index: i,
          expected: expectedBurn.toBase58(),
          got: burnAccount?.toBase58(),
        });
      }
    }

    const kindByte = Number(decodedItems[i]?.kind);
    const refId = Number(decodedItems[i]?.refId);
    if (![0, 1].includes(kindByte) || !Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
      throw new functions.https.HttpsError('failed-precondition', 'Invalid deliver item args', { index: i, kindByte, refId });
    }

    const expectedReceipt = PublicKey.findProgramAddressSync(
      [Buffer.from('receipt'), Buffer.from([kindByte]), u32LE(refId)],
      boxMinterProgramId,
    )[0];
    if (!receiptAccount?.equals(expectedReceipt)) {
      throw new functions.https.HttpsError('failed-precondition', 'Delivery receipt PDA mismatch', {
        index: i,
        expected: expectedReceipt.toBase58(),
        got: receiptAccount?.toBase58(),
      });
    }

    const orderItem = expectedOrderItems[i];
    if (orderItem) {
      const expectedKindByte = orderItem.kind === 'box' ? 0 : orderItem.kind === 'dude' ? 1 : null;
      const expectedRefId = Number(orderItem.refId);
      if (expectedKindByte == null || expectedKindByte !== kindByte || !Number.isFinite(expectedRefId) || expectedRefId !== refId) {
        throw new functions.https.HttpsError('failed-precondition', 'Delivery item metadata mismatch', {
          index: i,
          expected: { kind: orderItem.kind, refId: orderItem.refId },
          got: { kindByte, refId },
        });
      }
    }
  }

  // Sign only as cosigner; wallet will add payer sig client-side.
  tx.sign([signer]);

  const raw = tx.serialize();
  const MAX_RAW_TX_BYTES = 1232;
  if (raw.length > MAX_RAW_TX_BYTES) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Delivery transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}). Try fewer items.`,
      {
        rawBytes: raw.length,
        maxRawBytes: MAX_RAW_TX_BYTES,
        base64Chars: Buffer.from(raw).toString('base64').length,
        items: decoded.itemsLen,
      },
    );
  }

  return { encodedTx: Buffer.from(raw).toString('base64') };
});

export const finalizeDeliveryTx = onCallLogged('finalizeDeliveryTx', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), signature: z.string(), orderId: z.string() });
  const { owner, signature, orderId } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new functions.https.HttpsError('permission-denied', 'Owners only');

  const orderRef = db.doc(`deliveryOrders/${orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Delivery order not found');
  }
  const order = orderSnap.data() as any;
  if (order.owner && order.owner !== ownerWallet) {
    throw new functions.https.HttpsError('permission-denied', 'Order belongs to a different wallet');
  }
  if (order.signature && order.signature !== signature && order.status === 'completed') {
    throw new functions.https.HttpsError('already-exists', 'Order already finalized');
  }

  const tx = await withTimeout(
    connection().getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction',
  );
  if (!tx || tx.meta?.err) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery transaction not found or failed');
  }
  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== ownerWallet) {
    throw new functions.https.HttpsError('failed-precondition', 'Signature payer does not match owner');
  }

  // Verify the tx contains our box_minter::deliver instruction and that it matches the order's fee/id.
  const keys = resolveInstructionAccounts(tx);
  const deliverIx = (tx?.transaction?.message?.compiledInstructions || []).find((ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(boxMinterProgramId)) return false;
    const dataField = (ix as any).data;
    const dataBuffer =
      typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
    return dataBuffer.subarray(0, 8).equals(IX_DELIVER);
  });
  if (!deliverIx) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery transaction is missing box_minter deliver instruction');
  }

  const deliverDataField = (deliverIx as any).data;
  const deliverData =
    typeof deliverDataField === 'string' ? Buffer.from(bs58.decode(deliverDataField)) : Buffer.from(deliverDataField || []);
  const decoded = decodeDeliverIxData(deliverData);

  const expectedId = Number(order.deliveryId || 0);
  const expectedFee = Number(order.deliveryLamports || order.shippingLamports || 0);
  if (expectedId && decoded.deliveryId !== expectedId) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery id mismatch', {
      expectedId,
      got: decoded.deliveryId,
    });
  }
  if (expectedFee && decoded.feeLamports !== expectedFee) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery fee mismatch', {
      expectedFee,
      got: decoded.feeLamports,
    });
  }

  // Treasury is the 4th account in our deliver instruction account list:
  // [config, cosigner, payer, treasury, ...]
  const treasuryKeyIndex = Array.isArray((deliverIx as any).accountKeyIndexes) ? (deliverIx as any).accountKeyIndexes[3] : null;
  const treasuryKey = typeof treasuryKeyIndex === 'number' ? keys[treasuryKeyIndex] : null;
  const shippingPaid = treasuryKey ? lamportsDeltaForAccount(tx, treasuryKey) : 0;
  if (expectedFee && shippingPaid < expectedFee) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery payment missing or too low');
  }

  const accountKeyIndexesRaw: any = (deliverIx as any).accountKeyIndexes;
  const accountKeyIndexes: number[] = Array.isArray(accountKeyIndexesRaw)
    ? (accountKeyIndexesRaw as number[])
    : Array.from(accountKeyIndexesRaw || []);
  const ixAccounts = accountKeyIndexes.map((idx: number) => keys[idx]);
  const FIXED_DELIVER_ACCOUNTS = 7;
  const mintedReceiptIds = Array.from({ length: decoded.itemsLen }, (_, i) => {
    const receiptKey = ixAccounts[FIXED_DELIVER_ACCOUNTS + i * 2 + 1];
    return receiptKey ? receiptKey.toBase58() : null;
  });

  const itemIds: string[] = Array.isArray(order.itemIds) ? order.itemIds : [];
  const certificateSummary = itemIds.map((assetId: string, idx: number) => ({
    assetId,
    mintedAssetId: mintedReceiptIds[idx] || null,
  }));

  let finalSignature = signature;
  let finalShippingPaid = shippingPaid;
  let finalCertificates = certificateSummary;
  await db.runTransaction(async (trx) => {
    const fresh = await trx.get(orderRef);
    if (!fresh.exists) throw new functions.https.HttpsError('not-found', 'Delivery order not found');
    const existing = fresh.data() as any;
    if (existing.status === 'completed' && existing.signature) {
      finalSignature = existing.signature;
      finalShippingPaid = existing.shippingPaid || shippingPaid;
      finalCertificates = existing.mintedCertificates || certificateSummary;
      return;
    }
    trx.set(
      orderRef,
      {
        status: 'completed',
        signature,
        payer: ownerWallet,
        deliveryId: expectedId || decoded.deliveryId,
        shippingPaid,
        mintedCertificates: certificateSummary,
        burnedAssets: existing.itemIds || order.itemIds,
        finalizedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return {
    recorded: true,
    signature: finalSignature,
    orderId,
    shippingPaid: finalShippingPaid,
    certificates: finalCertificates,
  };
});

export const prepareIrlClaimTx = onCallLogged('prepareIrlClaimTx', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), code: z.string() });
  const { owner, code } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  await ensureOnchainCoreConfig();

  const claimRef = db.doc(`claimCodes/${code}`);
  const claimDoc = await claimRef.get();
  if (!claimDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Invalid claim code');
  }
  const claim = claimDoc.data() as any;
  if (claim.redeemedAt || claim.redeemedSignature) {
    throw new functions.https.HttpsError('failed-precondition', 'Claim code already redeemed');
  }
  const alreadyRedeemedSig = await detectClaimOnChain(code, ownerWallet).catch(() => null);
  if (alreadyRedeemedSig) {
    await claimRef.set(
      {
        redeemedAt: FieldValue.serverTimestamp(),
        redeemedBy: ownerWallet,
        redeemedSignature: alreadyRedeemedSig,
      },
      { merge: true },
    );
    throw new functions.https.HttpsError('failed-precondition', 'Claim already redeemed on-chain');
  }
  const certificate = claim.boxId ? await findCertificateForBox(ownerWallet, claim.boxId) : null;
  if (!certificate) {
    throw new functions.https.HttpsError('permission-denied', 'Blind box certificate not found in wallet');
  }
  const certificateOwner = certificate?.ownership?.owner;
  if (certificateOwner !== ownerWallet) {
    throw new functions.https.HttpsError('permission-denied', 'Certificate not found in wallet');
  }
  const kind = getAssetKind(certificate);
  if (kind !== 'certificate') {
    throw new functions.https.HttpsError('failed-precondition', 'Provided asset is not a certificate');
  }
  const certificateBoxId = getBoxIdFromAsset(certificate);
  if (!certificateBoxId) {
    throw new functions.https.HttpsError('failed-precondition', 'Certificate missing box reference');
  }
  if (claim.boxId && claim.boxId !== certificateBoxId) {
    throw new functions.https.HttpsError('permission-denied', 'Certificate does not match claim box');
  }
  if (!isMonsAsset(certificate)) {
    throw new functions.https.HttpsError('failed-precondition', 'Certificate is outside the Mons collection');
  }
  const certificateId = certificate.id;

  const dudeIds: number[] = claim.dudeIds || [];
  if (!dudeIds.length) {
    throw new functions.https.HttpsError('failed-precondition', 'Claim has no dudes assigned');
  }
  const pending = claim.pendingAttempt;
  const nowMs = Date.now();
  const pendingExpiry = pending?.expiresAt?.toMillis ? pending.expiresAt.toMillis() : 0;
  if (pending && pendingExpiry > nowMs) {
    const message =
      pending.owner === ownerWallet
        ? 'Claim already has a pending transaction, please submit it or wait a few minutes.'
        : 'Claim is locked by another wallet right now.';
    throw new functions.https.HttpsError('failed-precondition', message);
  }

  const attemptId = randomBytes(8).toString('hex');
  const expiresAt = Timestamp.fromMillis(nowMs + CLAIM_LOCK_WINDOW_MS);
  await db.runTransaction(async (txRef) => {
    const fresh = await txRef.get(claimRef);
    if (!fresh.exists) {
      throw new functions.https.HttpsError('not-found', 'Invalid claim code');
    }
    const data = fresh.data() as any;
    const existingPending = data.pendingAttempt;
    const existingPendingExpiry = existingPending?.expiresAt?.toMillis ? existingPending.expiresAt.toMillis() : 0;
    if (data.redeemedAt || data.redeemedSignature) {
      throw new functions.https.HttpsError('failed-precondition', 'Claim already redeemed');
    }
    if (existingPending && existingPendingExpiry > Date.now()) {
      throw new functions.https.HttpsError('failed-precondition', 'Claim already has a pending transaction');
    }
    txRef.update(claimRef, {
      pendingAttempt: {
        owner: ownerWallet,
        attemptId,
        certificateId,
        expiresAt,
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
  });

  // Load on-chain config (admin/core collection) so we can build a correct `mint_receipts` tx.
  const cfgInfo = await withTimeout(
    connection().getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run box-minter:deploy-all`, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const cfgCoreCollection = new PublicKey(cfgInfo.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  if (!collectionMint.equals(cfgCoreCollection)) {
    throw new functions.https.HttpsError('failed-precondition', 'COLLECTION_MINT env var does not match on-chain config', {
      env: collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
    });
  }

  const programId = boxMinterProgramId;
  const receiptPdas = dudeIds.map((id) =>
    PublicKey.findProgramAddressSync([Buffer.from('receipt'), Buffer.from([1]), u32LE(Number(id))], programId)[0],
  );

  const mintReceiptsIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: ownerPk, isSigner: true, isWritable: true },
      { pubkey: cfgCoreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...receiptPdas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeMintReceiptsArgs({ kind: 1, refIds: dudeIds }),
  });

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }),
    memoInstruction(`claim:${code}:${attemptId}`),
    mintReceiptsIx,
  ];

  const { blockhash } = await withTimeout(connection().getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash');
  const tx = buildTx(instructions, ownerPk, blockhash, [signer]);

  const raw = tx.serialize();
  const MAX_RAW_TX_BYTES = 1232;
  if (raw.length > MAX_RAW_TX_BYTES) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Claim transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}).`,
      { rawBytes: raw.length, maxRawBytes: MAX_RAW_TX_BYTES },
    );
  }

  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    certificates: dudeIds,
    attemptId,
    lockExpiresAt: expiresAt.toMillis(),
    certificateId,
  };
});

export const finalizeClaimTx = onCallLogged('finalizeClaimTx', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), code: z.string(), signature: z.string() });
  const { owner, code, signature } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const claimRef = db.doc(`claimCodes/${code}`);
  const claimDoc = await claimRef.get();
  if (!claimDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Invalid claim code');
  }
  const claim = claimDoc.data() as any;
  if (claim.redeemedAt || claim.redeemedSignature) {
    throw new functions.https.HttpsError('failed-precondition', 'Claim already redeemed');
  }

  const processed = await processClaimSignature(code, signature, ownerWallet);
  if (!processed) {
    throw new functions.https.HttpsError('failed-precondition', 'Claim transaction not found or invalid');
  }

  await db.runTransaction(async (txRef) => {
    const fresh = await txRef.get(claimRef);
    if (!fresh.exists) {
      throw new functions.https.HttpsError('not-found', 'Invalid claim code');
    }
    const data = fresh.data() as any;
    if (data.redeemedAt || data.redeemedSignature) return;
    txRef.update(claimRef, {
      redeemedAt: FieldValue.serverTimestamp(),
      redeemedBy: ownerWallet,
      redeemedSignature: signature,
      redeemedCertificateId: data.pendingAttempt?.certificateId,
      pendingAttempt: FieldValue.delete(),
    });
  });

  return { recorded: true, signature };
});
