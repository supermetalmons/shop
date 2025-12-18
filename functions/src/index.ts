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
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  MetadataArgs,
  TokenProgramVersion,
  TokenStandard,
  createBurnInstruction,
  createMintToCollectionV1Instruction,
} from '@metaplex-foundation/mpl-bubblegum';
import { ConcurrentMerkleTreeAccount, SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, SPL_NOOP_PROGRAM_ID } from '@solana/spl-account-compression';
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

function treeAuthorityPda(tree: PublicKey) {
  // Bubblegum expects the tree authority (TreeConfig) PDA, not the wallet that created/delegates the tree.
  // PDA seed is the Merkle tree pubkey.
  return PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function collectionAuthority() {
  const secret = process.env.COLLECTION_UPDATE_AUTHORITY_SECRET;
  if (secret) {
    const kp = Keypair.fromSecretKey(decodeSecretKey(secret, 'COLLECTION_UPDATE_AUTHORITY_SECRET'));
    if (!kp.publicKey.equals(collectionUpdateAuthority)) {
      throw new Error(
        `COLLECTION_UPDATE_AUTHORITY_SECRET pubkey ${kp.publicKey.toBase58()} does not match COLLECTION_UPDATE_AUTHORITY ${collectionUpdateAuthority.toBase58()}`,
      );
    }
    return kp;
  }
  // Fallback: allow tree authority to act as collection authority if they match.
  const treeAuth = treeAuthority();
  if (treeAuth.publicKey.equals(collectionUpdateAuthority)) return treeAuth;
  throw new Error(
    'Missing COLLECTION_UPDATE_AUTHORITY_SECRET; set it to the collection update authority keypair used for the collection.',
  );
}

function heliusRpcUrl() {
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing HELIUS_API_KEY');
  return `${HELIUS_DEVNET_RPC}/?api-key=${apiKey}`;
}

const rpcUrl = heliusRpcUrl();

const merkleTree = new PublicKey(process.env.MERKLE_TREE || PublicKey.default.toBase58());
const collectionMint = new PublicKey(process.env.COLLECTION_MINT || PublicKey.default.toBase58());
const collectionMetadata = new PublicKey(process.env.COLLECTION_METADATA || PublicKey.default.toBase58());
const collectionMasterEdition = new PublicKey(
  process.env.COLLECTION_MASTER_EDITION || PublicKey.default.toBase58(),
);
const collectionUpdateAuthorityEnv = process.env.COLLECTION_UPDATE_AUTHORITY || PublicKey.default.toBase58();
const collectionUpdateAuthority = new PublicKey(collectionUpdateAuthorityEnv);
const shippingVault = new PublicKey(process.env.DELIVERY_VAULT || PublicKey.default.toBase58());
const DEFAULT_METADATA_BASE = 'https://assets.mons.link/shop/drops/1';
const metadataBase = (process.env.METADATA_BASE || DEFAULT_METADATA_BASE).replace(/\/$/, '');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
// Bubblegum program signer PDA used for CPI into Token Metadata during MintToCollectionV1.
const bubblegumCollectionSigner = PublicKey.findProgramAddressSync([Buffer.from('collection_cpi')], BUBBLEGUM_PROGRAM_ID)[0];
const collectionMintStr = collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58();

const boxMinterProgramId = new PublicKey(process.env.BOX_MINTER_PROGRAM_ID || PublicKey.default.toBase58());
const boxMinterConfigPda = PublicKey.findProgramAddressSync([Buffer.from('config')], boxMinterProgramId)[0];
// Anchor discriminator = sha256("global:open_box")[0..8]
const IX_OPEN_BOX = Buffer.from('e1dc0a68ad97d6c7', 'hex');

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

let cachedTreeAuthority: Keypair | null = null;
function treeAuthority() {
  if (!cachedTreeAuthority) {
    cachedTreeAuthority = Keypair.fromSecretKey(decodeSecretKey(process.env.TREE_AUTHORITY_SECRET, 'TREE_AUTHORITY_SECRET'));
  }
  return cachedTreeAuthority;
}

let cachedCosigner: Keypair | null = null;
function cosigner() {
  if (!cachedCosigner) {
    const raw = (process.env.COSIGNER_SECRET || process.env.TREE_AUTHORITY_SECRET || '').trim();
    const label = process.env.COSIGNER_SECRET ? 'COSIGNER_SECRET' : 'TREE_AUTHORITY_SECRET';
    cachedCosigner = Keypair.fromSecretKey(decodeSecretKey(raw, label));
  }
  return cachedCosigner;
}

function ensureAuthorityKeys() {
  // Prepared transactions require server-side signatures for the tree delegate and the collection authority.
  // Note: Bubblegum's `collectionAuthority` account IS a required signer (see mpl-bubblegum instruction builder).
  treeAuthority();
  collectionAuthority();
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

function collectionAuthorityRecordPda(authority: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      collectionMint.toBuffer(),
      Buffer.from('collection_authority'),
      authority.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
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

async function ensureOnchainMintConfig(force = false) {
  const now = Date.now();
  if (!force && onchainConfigOk && now - lastOnchainConfigCheckMs < ONCHAIN_CONFIG_CHECK_TTL_MS) return;
  lastOnchainConfigCheckMs = now;

  ensureAuthorityKeys();
  assertConfiguredPublicKey(merkleTree, 'MERKLE_TREE');
  assertConfiguredPublicKey(collectionMint, 'COLLECTION_MINT');
  assertConfiguredPublicKey(collectionMetadata, 'COLLECTION_METADATA');
  assertConfiguredPublicKey(collectionMasterEdition, 'COLLECTION_MASTER_EDITION');

  const collectionAuthoritySigner = collectionAuthority();
  const recordPda = collectionAuthorityRecordPda(collectionAuthoritySigner.publicKey);
  const pubkeys = [merkleTree, collectionMint, collectionMetadata, collectionMasterEdition, recordPda];
  const infos = await withTimeout(
    connection().getMultipleAccountsInfo(pubkeys, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo',
  );

  const missing: Record<string, string> = {};
  for (let i = 0; i < pubkeys.length; i += 1) {
    if (infos[i]) continue;
    const key = pubkeys[i];
    const label =
      key.equals(merkleTree)
        ? 'MERKLE_TREE'
        : key.equals(collectionMint)
          ? 'COLLECTION_MINT'
          : key.equals(collectionMetadata)
            ? 'COLLECTION_METADATA'
            : key.equals(collectionMasterEdition)
              ? 'COLLECTION_MASTER_EDITION'
              : 'COLLECTION_AUTHORITY_RECORD_PDA';
    missing[label] = key.toBase58();
  }

  if (Object.keys(missing).length) {
    onchainConfigOk = false;
    throw new functions.https.HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or mismatched. Re-run `npm run box-minter:deploy-all`, update functions env, and redeploy.',
      {
        missing,
        bubblegumSigner: bubblegumCollectionSigner.toBase58(),
        collectionAuthority: collectionAuthoritySigner.publicKey.toBase58(),
        expectedCollectionAuthorityRecordPda: recordPda.toBase58(),
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

type MetadataExtra = {
  boxId?: string;
  dudeIds?: number[];
  receiptTarget?: 'box' | 'figure';
};

function normalizeBoxId(boxId?: string) {
  if (!boxId) return undefined;
  const numeric = Number(boxId);
  if (Number.isFinite(numeric) && numeric > 0) return String(numeric);
  const match = `${boxId}`.match(/\d+/);
  return match?.[0];
}

function buildMetadata(kind: 'box' | 'dude' | 'certificate', index: number, extra?: MetadataExtra): MetadataArgs {
  const dudes = (extra?.dudeIds || []).filter((id) => Number.isFinite(id)) as number[];
  const primaryDudeId = dudes[0] ?? index;
  const boxRef = normalizeBoxId(extra?.boxId);
  const certificateTarget =
    kind === 'certificate'
      ? extra?.receiptTarget || (dudes.length ? 'figure' : boxRef ? 'box' : undefined)
      : undefined;
  const name = (() => {
    if (kind === 'box') return `mons blind box #${index}`;
    if (kind === 'dude') return `mons figure #${primaryDudeId}`;
    if (certificateTarget === 'figure') return `mons receipt · figure #${primaryDudeId}`;
    if (certificateTarget === 'box') return `mons receipt · box ${boxRef || extra?.boxId?.slice(0, 6) || index}`;
    return `mons authenticity #${index}`;
  })();

  const uriSuffix =
    kind === 'box'
      ? `json/boxes/${index}.json`
      : kind === 'dude'
        ? `json/figures/${primaryDudeId}.json`
        : certificateTarget === 'box'
          ? `json/receipts/boxes/${boxRef || index}.json`
          : certificateTarget === 'figure'
            ? `json/receipts/figures/${primaryDudeId}.json`
            : `json/receipts/${index}.json`;

  return {
    name,
    symbol: 'MONS',
    uri: `${metadataBase}/${uriSuffix}`,
    sellerFeeBasisPoints: 0,
    creators: [{ address: treeAuthority().publicKey, verified: false, share: 100 }],
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: TokenStandard.NonFungible,
    collection: { key: collectionMint, verified: false },
    uses: null,
  };
}

async function buildMintInstructions(
  owner: PublicKey,
  quantity: number,
  kind: 'box' | 'dude' | 'certificate',
  startIndex = 1,
  extra?: MetadataExtra,
) {
  // Fail fast with a helpful error if env/on-chain prereqs don't match the current deployment.
  await ensureOnchainMintConfig();
  const instructions: TransactionInstruction[] = [];
  const collectionAuthoritySigner = collectionAuthority();
  const collectionAuthorityRecord = collectionAuthorityRecordPda(collectionAuthoritySigner.publicKey);
  const treeAuthorityKey = treeAuthority();
  const treeAuthorityConfig = treeAuthorityPda(merkleTree);

  for (let i = 0; i < quantity; i += 1) {
    const perMintDudeIds =
      extra?.dudeIds && (quantity > 1 || kind === 'dude') ? [extra.dudeIds[i]] : extra?.dudeIds;
    const metadataArgs = buildMetadata(kind, startIndex + i, {
      boxId: extra?.boxId,
      dudeIds: perMintDudeIds?.filter((id) => Number.isFinite(id)) as number[] | undefined,
      receiptTarget: extra?.receiptTarget,
    });
    instructions.push(
      createMintToCollectionV1Instruction(
        {
          payer: owner,
          merkleTree,
          treeAuthority: treeAuthorityConfig,
          treeDelegate: treeAuthorityKey.publicKey,
          leafOwner: owner,
          leafDelegate: owner,
          collectionAuthority: collectionAuthoritySigner.publicKey,
          collectionMint,
          collectionMetadata,
          editionAccount: collectionMasterEdition,
          bubblegumSigner: bubblegumCollectionSigner,
          compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
          logWrapper: SPL_NOOP_PROGRAM_ID,
          collectionAuthorityRecordPda: collectionAuthorityRecord,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        },
        { metadataArgs },
      ),
    );
  }

  return instructions;
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
  // NOTE: Newly minted compressed NFTs can briefly miss collection-group indexing on devnet.
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

async function fetchAssetProof(assetId: string) {
  // Use DAS RPC to keep behavior consistent with `searchAssets` (inventory).
  // REST endpoints can lag or behave differently across clusters.
  let proof: any;
  try {
    proof = await heliusRpc<any>('getAssetProof', { id: assetId }, 'Helius proof error');
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
    const url = `https://api.helius.xyz/v0/assets/${assetId}/proof?api-key=${helius}${clusterParam}`;
    proof = await heliusJson(url, 'Helius proof error');
  }
  const tree =
    (proof as any)?.merkleTree ||
    (proof as any)?.merkle_tree ||
    (proof as any)?.tree_id ||
    (proof as any)?.treeId ||
    (proof as any)?.tree;
  if (!proof || typeof proof !== 'object' || !(proof as any)?.root || !(proof as any)?.proof || !tree) {
    throw new functions.https.HttpsError(
      'not-found',
      'Asset proof not available yet. If you just minted/transferred/opened this item, wait a few seconds and retry.',
      { assetId },
    );
  }
  // Normalize tree field so downstream code can rely on it.
  if (!(proof as any).merkleTree && tree) (proof as any).merkleTree = tree;
  return proof;
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

  // Primary: collection grouping match.
  const groupingMatch =
    !collectionMintStr ||
    (asset?.grouping || []).some((g: any) => g?.group_key === 'collection' && g?.group_value === collectionMintStr);
  if (groupingMatch) return true;

  // Fallbacks: allow inventory to work during collection-indexing delays.
  const tree = asset?.compression?.tree || asset?.compression?.treeId;
  if (typeof tree === 'string' && tree === merkleTree.toBase58()) return true;

  const uri: string = asset?.content?.json_uri || asset?.content?.jsonUri || '';
  if (typeof uri === 'string' && uri && uri.startsWith(metadataBase)) return true;

  return false;
}

async function fetchAssetWithProof(assetId: string) {
  // DAS can be briefly inconsistent right after mint/transfer. Retry a few times so a newly minted
  // box that already shows in inventory can still be opened immediately.
  const startedAt = Date.now();
  const maxWaitMs = 12_000;
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts && Date.now() - startedAt < maxWaitMs; attempt++) {
    try {
      const [asset, proof] = await Promise.all([fetchAsset(assetId), fetchAssetProof(assetId)]);
      return { asset, proof };
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

const TREE_PARAMS_CACHE_TTL_MS = 10 * 60 * 1000;
const treeParamsCache = new Map<string, { canopyDepth: number; maxDepth: number; updatedAt: number }>();

async function getTreeParams(tree: PublicKey): Promise<{ canopyDepth: number; maxDepth: number }> {
  const key = tree.toBase58();
  const cached = treeParamsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.updatedAt < TREE_PARAMS_CACHE_TTL_MS) {
    return { canopyDepth: cached.canopyDepth, maxDepth: cached.maxDepth };
  }

  const info = await withTimeout(connection().getAccountInfo(tree, { commitment: 'confirmed' }), RPC_TIMEOUT_MS, 'getAccountInfo:tree');
  if (!info?.data) {
    const params = { canopyDepth: 0, maxDepth: 0 };
    treeParamsCache.set(key, { ...params, updatedAt: now });
    return params;
  }

  const acct = ConcurrentMerkleTreeAccount.fromBuffer(info.data);
  const canopyRaw = Number(acct.getCanopyDepth() || 0);
  const canopyDepth = Number.isFinite(canopyRaw) && canopyRaw > 0 ? Math.round(canopyRaw) : 0;
  const depthRaw = Number(acct.getMaxDepth() || 0);
  const maxDepth = Number.isFinite(depthRaw) && depthRaw > 0 ? Math.round(depthRaw) : 0;
  treeParamsCache.set(key, { canopyDepth, maxDepth, updatedAt: now });
  return { canopyDepth, maxDepth };
}

function truncateProofByCanopy(proof: string[], canopyDepth: number): string[] {
  const drop = Math.max(0, Math.floor(canopyDepth || 0));
  if (!drop) return proof;
  if (proof.length <= drop) return [];
  return proof.slice(0, proof.length - drop);
}

function normalizeLeafIndex(args: { nodeIndex: number; maxDepth: number }): number {
  const nodeIndex = Number(args.nodeIndex);
  if (!Number.isFinite(nodeIndex) || nodeIndex < 0) return 0;

  // Helius `node_index` is the index in the *full binary tree* where leaf nodes start at 2^depth.
  // Bubblegum/compression expects the leaf index 0..(2^depth - 1).
  const depth = Number(args.maxDepth || 0);
  if (!depth) return nodeIndex >>> 0;
  const leafOffset = Math.pow(2, depth);
  const leafIndex = nodeIndex >= leafOffset ? nodeIndex - leafOffset : nodeIndex;
  return leafIndex >>> 0;
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

function encodeOpenBoxArgs(args: {
  dudeIds: number[];
  root: Uint8Array;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  nonce: bigint;
  index: number;
}): Buffer {
  if (!Array.isArray(args.dudeIds) || args.dudeIds.length !== DUDES_PER_BOX) {
    throw new functions.https.HttpsError('invalid-argument', `dudeIds must have length ${DUDES_PER_BOX}`);
  }
  const ids = args.dudeIds.map((n) => Number(n));
  ids.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > MAX_DUDE_ID) {
      throw new functions.https.HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    throw new functions.https.HttpsError('invalid-argument', 'Duplicate dude ids');
  }
  if (args.root.length !== 32 || args.dataHash.length !== 32 || args.creatorHash.length !== 32) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid burn hashes (expected 32-byte root/dataHash/creatorHash)');
  }

  return Buffer.concat([
    IX_OPEN_BOX,
    ...ids.map(u16LE),
    Buffer.from(args.root),
    Buffer.from(args.dataHash),
    Buffer.from(args.creatorHash),
    u64LE(args.nonce),
    u32LE(args.index),
  ]);
}

async function createBurnIx(assetId: string, owner: PublicKey, cached?: { asset?: any; proof?: any }) {
  const asset = cached?.asset ?? (await fetchAsset(assetId));
  const proof = cached?.proof ?? (await fetchAssetProof(assetId));
  const leafNonce = proof.leaf?.nonce ?? asset.compression?.leaf_id ?? 0;
  const merkle = new PublicKey(asset.compression?.tree || proof.merkleTree);
  const { canopyDepth, maxDepth } = await getTreeParams(merkle);
  const proofNodes = Array.isArray(proof.proof) ? (proof.proof as any[]).filter((p) => typeof p === 'string') : [];
  const truncated = truncateProofByCanopy(proofNodes as string[], canopyDepth);
  const proofPath = truncated.map((p: string) => ({ pubkey: new PublicKey(p), isSigner: false, isWritable: false }));
  const maxDepthUsed = maxDepth || proofNodes.length || 0;
  const leafIndex = normalizeLeafIndex({ nodeIndex: Number(proof.node_index ?? asset.compression?.leaf_id ?? 0), maxDepth: maxDepthUsed });

  const ix = createBurnInstruction(
    {
      treeAuthority: treeAuthorityPda(merkle),
      leafOwner: new PublicKey(asset.ownership.owner),
      leafDelegate: owner,
      merkleTree: merkle,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      anchorRemainingAccounts: proofPath,
    },
    {
      root: Array.from(bs58.decode(proof.root)),
      dataHash: Array.from(bs58.decode(asset.compression.data_hash)),
      creatorHash: Array.from(bs58.decode(asset.compression.creator_hash)),
      nonce: leafNonce,
      index: leafIndex,
    },
  );
  return ix;
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

async function ensureClaimCode(boxId: string, dudeIds: number[], owner: string) {
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
    dudeIds,
    owner,
    createdAt: FieldValue.serverTimestamp(),
  });
  return code;
}

function certificateIndexForItem(assetId: string, kind: 'box' | 'dude', dudeIds?: number[]) {
  if (kind === 'dude' && dudeIds?.[0]) return dudeIds[0];
  const input = `${kind}:${assetId}:${(dudeIds || []).join(',')}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return (hash % 1_000_000) + 1;
}

function buildTx(instructions: TransactionInstruction[], payer: PublicKey, recentBlockhash: string) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const signers: Keypair[] = [treeAuthority()];
  const ca = collectionAuthority();
  if (!signers.some((s) => s.publicKey.equals(ca.publicKey))) {
    signers.push(ca);
  }
  tx.sign(signers);
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
  const ownerPk = new PublicKey(owner);
  let asset: any;
  let proof: any;
  try {
    ({ asset, proof } = await fetchAssetWithProof(boxAssetId));
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
  if (assetOwner !== owner) {
    throw new functions.https.HttpsError('failed-precondition', 'Box not owned by wallet');
  }

  assertConfiguredProgramId(boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');

  // Ensure the provided COSIGNER_SECRET matches the on-chain box minter admin (config PDA).
  const cfgInfo = await withTimeout(
    connection().getAccountInfo(boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:boxMinterConfig',
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run box-minter:deploy-all`, update env, and redeploy.',
      { configPda: boxMinterConfigPda.toBase58() },
    );
  }
  const cfgAdmin = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }

  // Assign dudes deterministically per box, reserving globally unique IDs in Firestore.
  const dudeIds = await assignDudes(boxAssetId);

  // Normalize proof + truncate canopy nodes to keep the tx under the size limit.
  const proofTreeStr = String((proof as any)?.merkleTree || (proof as any)?.merkle_tree || (proof as any)?.treeId || '');
  if (proofTreeStr && proofTreeStr !== merkleTree.toBase58()) {
    throw new functions.https.HttpsError('failed-precondition', 'Box is from a different Merkle tree than the configured drop', {
      boxTree: proofTreeStr,
      configuredTree: merkleTree.toBase58(),
    });
  }
  const { canopyDepth, maxDepth } = await getTreeParams(merkleTree);
  const fullProof = Array.isArray((proof as any)?.proof) ? ((proof as any).proof as any[]).filter((p) => typeof p === 'string') : [];
  const truncatedProof = truncateProofByCanopy(fullProof as string[], canopyDepth);

  const rootBytes = bs58.decode(String((proof as any).root || ''));
  const dataHashBytes = bs58.decode(String(asset?.compression?.data_hash || ''));
  const creatorHashBytes = bs58.decode(String(asset?.compression?.creator_hash || ''));
  const nonce = normalizeU64((proof as any)?.leaf?.nonce ?? asset?.compression?.leaf_id ?? 0, 'nonce');
  const maxDepthUsed = maxDepth || fullProof.length || 0;
  const nodeIndex = Number((proof as any)?.node_index ?? asset?.compression?.leaf_id ?? 0);
  const leafIndex = normalizeLeafIndex({ nodeIndex, maxDepth: maxDepthUsed });
  const maxLeaves = maxDepthUsed ? Math.pow(2, maxDepthUsed) : 0;
  if (maxLeaves && leafIndex >= maxLeaves) {
    throw new functions.https.HttpsError('failed-precondition', 'Leaf index is out of bounds for the configured Merkle tree', {
      nodeIndex,
      leafIndex,
      maxDepth: maxDepthUsed,
      maxLeaves,
      tree: merkleTree.toBase58(),
    });
  }

  const openBoxIx = new TransactionInstruction({
    programId: boxMinterProgramId,
    keys: [
      { pubkey: boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: ownerPk, isSigner: true, isWritable: true },
      { pubkey: merkleTree, isSigner: false, isWritable: true },
      { pubkey: treeAuthorityPda(merkleTree), isSigner: false, isWritable: true },
      { pubkey: collectionMint, isSigner: false, isWritable: false },
      { pubkey: collectionMetadata, isSigner: false, isWritable: true },
      { pubkey: collectionMasterEdition, isSigner: false, isWritable: false },
      { pubkey: collectionAuthorityRecordPda(boxMinterConfigPda), isSigner: false, isWritable: false },
      { pubkey: bubblegumCollectionSigner, isSigner: false, isWritable: false },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...truncatedProof.map((p) => ({ pubkey: new PublicKey(p), isSigner: false, isWritable: false })),
    ],
    data: encodeOpenBoxArgs({
      dudeIds,
      root: rootBytes,
      dataHash: dataHashBytes,
      creatorHash: creatorHashBytes,
      nonce,
      index: leafIndex >>> 0,
    }),
  });

  const conn = connection();
  const instructions: TransactionInstruction[] = [
    // Bubblegum CPI allocates; request the max heap frame to avoid OOM.
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    openBoxIx,
  ];

  const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash');
  const msg = new TransactionMessage({ payerKey: ownerPk, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);
  const raw = tx.serialize();
  // Solana hard cap: 1232 bytes for the serialized transaction.
  // (Wallets often show a base64 cap too: 1644 chars.)
  const MAX_RAW_TX_BYTES = 1232;
  if (raw.length > MAX_RAW_TX_BYTES) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Open box transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}). This usually means the Merkle tree canopy is too small; redeploy the tree with a larger canopy (e.g. 8).`,
      {
        rawBytes: raw.length,
        maxRawBytes: MAX_RAW_TX_BYTES,
        base64Chars: Buffer.from(raw).toString('base64').length,
        canopyDepth,
        proofNodes: fullProof.length,
        truncatedProofNodes: truncatedProof.length,
        tree: merkleTree.toBase58(),
      },
    );
  }

  return { encodedTx: Buffer.from(raw).toString('base64'), assignedDudeIds: dudeIds };
});

export const prepareDeliveryTx = onCallLogged('prepareDeliveryTx', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), itemIds: z.array(z.string()).min(1), addressId: z.string() });
  const { owner, itemIds, addressId } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new functions.https.HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);
  const conn = connection();
  const addressSnap = await db.doc(`profiles/${wallet}/addresses/${addressId}`).get();
  if (!addressSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Address not found');
  }
  const addressData = addressSnap.data();
  const addressCountry = addressData?.countryCode || normalizeCountryCode(addressData?.country) || addressData?.country || '';
  const orderId = db.collection('deliveryOrders').doc().id;
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
    memoInstruction(`delivery:${orderId}`),
  ];
  const orderItems: {
    assetId: string;
    kind: 'box' | 'dude';
    boxId?: string;
    dudeIds?: number[];
    certificateIndex: number;
    claimCode?: string;
  }[] = [];
  for (let i = 0; i < itemIds.length; i += 1) {
    const id = itemIds[i];
    const assetData = await fetchAssetWithProof(id);
    const kind = getAssetKind(assetData.asset);
    if (!kind) {
      throw new functions.https.HttpsError('failed-precondition', 'Unsupported asset type');
    }
    if (!isMonsAsset(assetData.asset)) {
      throw new functions.https.HttpsError('failed-precondition', 'Item is not part of the Mons collection');
    }
    const assetOwner = assetData.asset?.ownership?.owner;
    if (assetOwner !== ownerWallet) {
      throw new functions.https.HttpsError('failed-precondition', 'Item not owned by wallet');
    }
    if (kind === 'certificate') {
      throw new functions.https.HttpsError('failed-precondition', 'Certificates are already delivery outputs');
    }
    let dudeIds: number[] | undefined;
    let claimCode: string | undefined;
    if (kind === 'box') {
      const assigned = await assignDudes(id);
      dudeIds = assigned;
      claimCode = await ensureClaimCode(id, assigned, ownerWallet);
    }
    if (kind === 'dude') {
      const dudeId = getDudeIdFromAsset(assetData.asset);
      dudeIds = dudeId ? [dudeId] : undefined;
    }
    const boxRef = getBoxIdFromAsset(assetData.asset) || (kind === 'box' ? id : undefined);
    const certIndex = certificateIndexForItem(boxRef || id, kind, dudeIds);
    orderItems.push({
      assetId: id,
      kind,
      boxId: boxRef,
      dudeIds,
      certificateIndex: certIndex,
      claimCode,
    });
    instructions.push(await createBurnIx(id, ownerPk, assetData));
    instructions.push(
      ...(await buildMintInstructions(ownerPk, 1, 'certificate', certIndex, {
        boxId: boxRef,
        dudeIds,
        receiptTarget: kind === 'box' ? 'box' : 'figure',
      })),
    );
  }
  const deliveryPrice = shippingLamports(addressCountry || 'unknown', itemIds.length);
  instructions.unshift(SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: shippingVault, lamports: deliveryPrice }));
  const { blockhash } = await withTimeout(
    conn.getLatestBlockhash('confirmed'),
    RPC_TIMEOUT_MS,
    'getLatestBlockhash',
  );
  const tx = buildTx(instructions, ownerPk, blockhash);
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
    shippingLamports: deliveryPrice,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { encodedTx: Buffer.from(tx.serialize()).toString('base64'), deliveryLamports: deliveryPrice, orderId };
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
  const memo = extractMemos(tx).find((m) => m === `delivery:${orderId}`);
  if (!memo) {
    throw new functions.https.HttpsError('failed-precondition', 'Delivery memo not found on transaction');
  }
  const shippingPaid = lamportsDeltaForAccount(tx, shippingVault);
  if (order.shippingLamports && shippingPaid < order.shippingLamports) {
    throw new functions.https.HttpsError('failed-precondition', 'Shipping payment missing or too low');
  }
  const mintedIds = extractCompressedAssetIds(tx);
  const certificateSummary = (order.items || []).map(
    (item: any, idx: number) => ({
      assetId: item.assetId,
      kind: item.kind,
      boxId: item.boxId,
      dudeIds: item.dudeIds,
      certificateIndex: item.certificateIndex,
      claimCode: item.claimCode,
      mintedAssetId: mintedIds[idx] || null,
    }),
  );

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
        memoDetected: Boolean(memo),
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

  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 })];
  instructions.push(memoInstruction(`claim:${code}:${attemptId}`));
  instructions.push(
    ...(await buildMintInstructions(ownerPk, dudeIds.length, 'certificate', 1, {
      boxId: claim.boxId || certificateBoxId,
      dudeIds,
      receiptTarget: 'figure',
    })),
  );
  const { blockhash } = await withTimeout(
    connection().getLatestBlockhash('confirmed'),
    RPC_TIMEOUT_MS,
    'getLatestBlockhash',
  );
  const tx = buildTx(instructions, ownerPk, blockhash);
  return {
    encodedTx: Buffer.from(tx.serialize()).toString('base64'),
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
