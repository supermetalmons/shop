import { onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { PublicKey } from '@solana/web3.js';
import { auth, FIREBASE_FUNCTIONS_REGION, firebaseApp, firestore } from './firebase';
import {
  AdminIrlRedeemFinalizeResult,
  AdminIrlRedeemPreparedTxResponse,
  DeliverySelection,
  FulfillmentManualReviewCheckout,
  FulfillmentStatus,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  InventoryItem,
  IssueReceiptsResult,
  PackStatusBreakdown,
  PackStatusBreakdownItem,
  PackStatusDisplayLabels,
  PendingOpenBox,
  PreparedTxResponse,
  Profile,
  ProfileAddress,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
  StripeReceiptClaimResult,
} from '../types';
import { getHeliusApiKey } from './helius';
import { normalizeBoxDisplayImage, normalizeCertificateDisplayImage, normalizeFigureDisplayImage } from './dropContent';
import { dropAssetLabel } from './dropLabels';
import {
  boxIdFromMetadataUri,
  dudeIdFromMetadataUri,
  metadataKindFromUri,
  selectMetadataUri,
} from './dropMetadataUri';
import { HELIUS_COLLECTION_GROUPING_OPTIONS, uniqueAssetGroupingCollectionMint } from './dasAssetCollections';
import {
  FRONTEND_DROPS,
  normalizeDropId,
  type FrontendDeploymentConfig,
  type SolanaCluster,
} from '../config/deployment';

const region = FIREBASE_FUNCTIONS_REGION;
const functionsInstance = firebaseApp ? getFunctions(firebaseApp, region) : undefined;

let authReadyPromise: Promise<string> | null = null;
let authStateReadyPromise: Promise<void> | null = null;

async function waitForAuthStateReady(localAuth: Auth): Promise<void> {
  // If a user is already present, we’re ready.
  if (localAuth.currentUser) return;
  if (!authStateReadyPromise) {
    authStateReadyPromise = new Promise<void>((resolve) => {
      const unsubscribe = onAuthStateChanged(localAuth, () => {
        unsubscribe();
        resolve();
      });
    }).finally(() => {
      authStateReadyPromise = null;
    });
  }
  return authStateReadyPromise;
}

export async function ensureAuthenticated(): Promise<string> {
  const localAuth = auth;
  if (!localAuth) throw new Error('Firebase client is not configured');

  // IMPORTANT: On page load, Firebase restores persisted auth asynchronously.
  // If we call signInAnonymously() before that completes, we can create a *new* anon user each reload,
  // which breaks our wallet-session mapping and makes users re-sign with Solana unnecessarily.
  await waitForAuthStateReady(localAuth);
  const user = localAuth.currentUser;
  if (user) return user.uid;

  if (!authReadyPromise) {
    authReadyPromise = signInAnonymously(localAuth)
      .then((credential) => credential.user.uid)
      .finally(() => {
        authReadyPromise = null;
      });
  }
  return authReadyPromise;
}

const DEBUG_FUNCTIONS =
  import.meta.env?.DEV ||
  (typeof window !== 'undefined' && window.localStorage?.getItem('monsDebugFunctions') === '1');

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

function summarizeError(err: unknown) {
  const anyErr = err as any;
  if (anyErr && typeof anyErr === 'object') {
    return {
      name: anyErr.name,
      code: anyErr.code,
      message: anyErr.message,
      details: anyErr.details,
      stack: anyErr.stack,
    };
  }
  return { message: String(err) };
}

function makeCallId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function callFunction<Req, Res>(name: string, data?: Req): Promise<Res> {
  if (!functionsInstance) throw new Error('Firebase client is not configured');
  await ensureAuthenticated();
  const callable = httpsCallable<Req, Res>(functionsInstance, name);
  const startedAt = Date.now();
  const callId = DEBUG_FUNCTIONS ? makeCallId() : undefined;
  const basePayload = (data ?? ({} as Req)) as any;
  const payload =
    DEBUG_FUNCTIONS && basePayload && typeof basePayload === 'object' && !Array.isArray(basePayload)
      ? ({ ...basePayload, __debug: { callId, fn: name, ts: new Date().toISOString() } } as Req)
      : (basePayload as Req);

  if (DEBUG_FUNCTIONS) {
    console.info(`[mons/functions] → ${name}`, { callId, payload: summarizePayload(payload) });
  }

  try {
    const result = await callable(payload);
    if (DEBUG_FUNCTIONS) {
      console.info(`[mons/functions] ← ${name}`, {
        callId,
        ms: Date.now() - startedAt,
        data: summarizePayload(result.data),
      });
    }
    return result.data;
  } catch (err) {
    // Always log callable failures on the client; they're rare and essential for debugging prod issues.
    console.error(`[mons/functions] ✖ ${name}`, {
      ...(callId ? { callId } : {}),
      ms: Date.now() - startedAt,
      error: summarizeError(err),
    });
    throw err;
  }
}

const heliusApiKey = getHeliusApiKey();
const MIN_OPENABLE_ITEMS_PER_BOX = 1;
const MAX_ITEMS_PER_BOX = 5;
const HELIUS_SEARCH_ASSETS_LIMIT = 1000;
const HELIUS_SEARCH_ASSETS_MAX_PAGES = 50;

type FrontendDropRuntime = Pick<
  FrontendDeploymentConfig,
  'dropId' | 'solanaCluster' | 'collectionMint' | 'boxMinterProgramId' | 'boxMinterConfigPda' | 'itemsPerBox'
>;

type PendingOpenProgramScope = Pick<FrontendDropRuntime, 'solanaCluster' | 'boxMinterProgramId'> & {
  drops: FrontendDropRuntime[];
};

type PendingOpenRecordCandidate = {
  solanaCluster: SolanaCluster;
  pendingPda: string;
  boxAssetId: string;
  dudeAssetIds: string[];
  createdSlot?: number;
  configPda?: string;
  candidateDrops: FrontendDropRuntime[];
};

export type DropFetchOptions = {
  includeDevnet?: boolean;
};

export type ListCardNft2UnrevealedCardsRequest = {
  limit?: number;
  cursor?: number;
};

export type ListCardNft2UnrevealedCardsResponse = {
  ids: number[];
  nextCursor?: number;
  hasMore: boolean;
};

const FRONTEND_DROP_RUNTIMES: FrontendDropRuntime[] = Object.keys(FRONTEND_DROPS)
  .sort((a, b) => a.localeCompare(b))
  .map((dropId) => {
    const drop = FRONTEND_DROPS[dropId];
    return {
      dropId: drop.dropId,
      solanaCluster: drop.solanaCluster,
      collectionMint: drop.collectionMint,
      boxMinterProgramId: drop.boxMinterProgramId,
      boxMinterConfigPda: typeof drop.boxMinterConfigPda === 'string' ? drop.boxMinterConfigPda.trim() || undefined : undefined,
      itemsPerBox: drop.itemsPerBox,
    };
  });

const FRONTEND_DROP_BY_ID = new Map<string, FrontendDropRuntime>(
  FRONTEND_DROP_RUNTIMES.map((drop) => [drop.dropId, drop]),
);
const FRONTEND_DROPS_BY_COLLECTION_MINT = new Map<string, FrontendDropRuntime[]>();
const FRONTEND_DROPS_BY_PROGRAM_SCOPE = new Map<string, FrontendDropRuntime[]>();
const FRONTEND_DROPS_BY_CONFIG_PDA = new Map<string, FrontendDropRuntime>();
const PENDING_OPEN_DROP_ID_BY_ASSET = new Map<string, string>();
const PENDING_OPEN_DROP_ID_STORAGE_KEY = 'monsPendingOpenDropIds:v1';
const MAX_PENDING_OPEN_DROP_ID_CACHE_ENTRIES = 512;
let pendingOpenDropIdCacheHydrated = false;

function appendIndexedValue<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const existing = index.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  index.set(key, [value]);
}

FRONTEND_DROP_RUNTIMES.forEach((drop) => {
  appendIndexedValue(FRONTEND_DROPS_BY_COLLECTION_MINT, drop.collectionMint, drop);
  appendIndexedValue(FRONTEND_DROPS_BY_PROGRAM_SCOPE, frontendDropProgramScopeKey(drop), drop);
  if (drop.boxMinterConfigPda) {
    FRONTEND_DROPS_BY_CONFIG_PDA.set(frontendDropConfigPdaKey(drop.solanaCluster, drop.boxMinterConfigPda), drop);
  }
});
const MAINNET_FRONTEND_DROP_RUNTIMES = FRONTEND_DROP_RUNTIMES.filter((drop) => drop.solanaCluster !== 'devnet');
const PENDING_OPEN_PROGRAM_SCOPES: PendingOpenProgramScope[] = Array.from(FRONTEND_DROPS_BY_PROGRAM_SCOPE.values()).map((drops) => ({
  solanaCluster: drops[0].solanaCluster,
  boxMinterProgramId: drops[0].boxMinterProgramId,
  drops: [...drops],
}));
const MAINNET_PENDING_OPEN_PROGRAM_SCOPES = PENDING_OPEN_PROGRAM_SCOPES.filter((scope) => scope.solanaCluster !== 'devnet');

function listFrontendDropRuntimes(options?: DropFetchOptions): FrontendDropRuntime[] {
  return options?.includeDevnet === true ? FRONTEND_DROP_RUNTIMES : MAINNET_FRONTEND_DROP_RUNTIMES;
}

function frontendDropCollectionKey(drop: Pick<FrontendDropRuntime, 'solanaCluster' | 'collectionMint'>): string {
  return `${drop.solanaCluster}:${drop.collectionMint}`;
}

function listResolvableCollectionDropRuntimes(options?: DropFetchOptions): FrontendDropRuntime[] {
  const runtimes: FrontendDropRuntime[] = [];
  const seen = new Set<string>();

  for (const drop of listFrontendDropRuntimes(options)) {
    const key = frontendDropCollectionKey(drop);
    if (seen.has(key)) continue;
    seen.add(key);

    const collectionDrop = resolveSingleDropRuntime(FRONTEND_DROPS_BY_COLLECTION_MINT.get(drop.collectionMint) || [], drop.solanaCluster);
    if (collectionDrop) runtimes.push(collectionDrop);
  }

  return runtimes;
}

function frontendDropProgramScopeKey(drop: Pick<FrontendDropRuntime, 'solanaCluster' | 'boxMinterProgramId'>): string {
  return `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
}

function frontendDropConfigPdaKey(solanaCluster: SolanaCluster, configPda: string): string {
  return `${solanaCluster}:${configPda}`;
}

function listPendingOpenProgramScopes(options?: DropFetchOptions): PendingOpenProgramScope[] {
  return options?.includeDevnet === true ? PENDING_OPEN_PROGRAM_SCOPES : MAINNET_PENDING_OPEN_PROGRAM_SCOPES;
}

function pendingOpenDropCacheKey(solanaCluster: SolanaCluster, boxAssetId: string): string {
  return `${solanaCluster}:${boxAssetId}`;
}

function trimPendingOpenDropIdCache(): void {
  while (PENDING_OPEN_DROP_ID_BY_ASSET.size > MAX_PENDING_OPEN_DROP_ID_CACHE_ENTRIES) {
    const oldestKey = PENDING_OPEN_DROP_ID_BY_ASSET.keys().next().value;
    if (!oldestKey) break;
    PENDING_OPEN_DROP_ID_BY_ASSET.delete(oldestKey);
  }
}

function hydratePendingOpenDropIdCache(): void {
  if (pendingOpenDropIdCacheHydrated || typeof window === 'undefined') return;
  pendingOpenDropIdCacheHydrated = true;
  try {
    const raw = window.localStorage?.getItem(PENDING_OPEN_DROP_ID_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    parsed.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return;
      const [cacheKey, dropId] = entry;
      if (typeof cacheKey !== 'string' || typeof dropId !== 'string' || !FRONTEND_DROP_BY_ID.has(dropId)) return;
      PENDING_OPEN_DROP_ID_BY_ASSET.set(cacheKey, dropId);
    });
    trimPendingOpenDropIdCache();
  } catch {
    // Ignore storage corruption; the cache is opportunistic.
  }
}

function persistPendingOpenDropIdCache(): void {
  if (typeof window === 'undefined') return;
  try {
    trimPendingOpenDropIdCache();
    window.localStorage?.setItem(
      PENDING_OPEN_DROP_ID_STORAGE_KEY,
      JSON.stringify(Array.from(PENDING_OPEN_DROP_ID_BY_ASSET.entries())),
    );
  } catch {
    // Ignore storage failures; memory cache is still useful for the current session.
  }
}

function setPendingOpenDropIdCache(solanaCluster: SolanaCluster, boxAssetId: string, dropId: string): void {
  if (!boxAssetId) return;
  hydratePendingOpenDropIdCache();
  const cacheKey = pendingOpenDropCacheKey(solanaCluster, boxAssetId);
  if (PENDING_OPEN_DROP_ID_BY_ASSET.get(cacheKey) === dropId) return;
  PENDING_OPEN_DROP_ID_BY_ASSET.delete(cacheKey);
  PENDING_OPEN_DROP_ID_BY_ASSET.set(cacheKey, dropId);
  persistPendingOpenDropIdCache();
}

function getPendingOpenDropIdCache(solanaCluster: SolanaCluster, boxAssetId: string): string | null {
  hydratePendingOpenDropIdCache();
  const dropId = PENDING_OPEN_DROP_ID_BY_ASSET.get(pendingOpenDropCacheKey(solanaCluster, boxAssetId));
  return typeof dropId === 'string' ? dropId : null;
}

function cachePendingOpenDropId(entry: PendingOpenRecordCandidate, dropId: string): string {
  setPendingOpenDropIdCache(entry.solanaCluster, entry.boxAssetId, dropId);
  return dropId;
}

export function rememberPendingOpenDropId(solanaCluster: SolanaCluster, boxAssetId: string, dropId: string): void {
  const drop = FRONTEND_DROP_BY_ID.get(dropId);
  if (!drop || drop.solanaCluster !== solanaCluster || !boxAssetId) return;
  setPendingOpenDropIdCache(solanaCluster, boxAssetId, drop.dropId);
}

type DasAsset = Record<string, any>;
const ASSET_DROP_ID_FIELD = '__monsDropId';

type HeliusSearchAssetsContext = {
  cluster: SolanaCluster;
  dropId?: string;
  mode: 'grouped';
};

function heliusSearchAssetsItems(result: any): DasAsset[] {
  return Array.isArray(result?.items) ? result.items : [];
}

function heliusSearchAssetsHasNextPage(result: any, page: number, items: DasAsset[], fallbackLimit: number): boolean {
  if (!items.length) return false;
  const responseLimit = Number(result?.limit);
  const limit = Number.isFinite(responseLimit) && responseLimit > 0 ? responseLimit : fallbackLimit;
  if (items.length < limit) return false;

  const total = Number(result?.total);
  const resultPage = Number(result?.page ?? page);
  if (Number.isFinite(total) && total >= 0 && Number.isFinite(resultPage)) {
    return resultPage * limit < total;
  }

  return true;
}

function readU32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, true);
}

function readU64(buf: Uint8Array, offset: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(offset, true);
}

// Anchor discriminator = sha256("account:PendingOpenBox")[0..8]
const ACCOUNT_PENDING_OPEN_BOX = Uint8Array.from([0x45, 0x07, 0x45, 0x1a, 0xf0, 0x0c, 0x43, 0xa1]);
// base58(ACCOUNT_PENDING_OPEN_BOX)
const ACCOUNT_PENDING_OPEN_BOX_B58 = 'CYfPji7s3EQ';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeOpenableItemsPerBox(value: unknown): number | null {
  const count = Number(value);
  return Number.isInteger(count) && count >= MIN_OPENABLE_ITEMS_PER_BOX && count <= MAX_ITEMS_PER_BOX ? count : null;
}

function pendingOpenLegacyFixedLen(itemsPerBox: number): number {
  return 8 + 32 + 32 + 32 * itemsPerBox + 8 + 1;
}

function pendingOpenRecordCandidateItemCounts(scope: Pick<PendingOpenProgramScope, 'drops'>): number[] {
  const counts = new Set<number>();
  scope.drops.forEach((drop) => {
    const count = normalizeOpenableItemsPerBox(drop.itemsPerBox);
    if (count != null) counts.add(count);
  });
  return Array.from(counts).sort((a, b) => a - b);
}

function decodeLegacyFixedPendingOpenPayload(
  buf: Uint8Array,
  itemsPerBox: number,
): { dudeAssetIds: string[]; createdSlot?: number; configPda?: string } | null {
  if (buf.length !== pendingOpenLegacyFixedLen(itemsPerBox)) return null;
  const dudeAssetIds: string[] = [];
  let o = 8 + 32 + 32;
  for (let i = 0; i < itemsPerBox; i += 1) {
    dudeAssetIds.push(new PublicKey(buf.subarray(o, o + 32)).toBase58());
    o += 32;
  }
  const createdSlotBig = readU64(buf, o);
  o += 8 + 1; // slot + bump
  if (o !== buf.length) return null;
  const createdSlot = createdSlotBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(createdSlotBig) : undefined;
  return {
    dudeAssetIds,
    ...(createdSlot != null ? { createdSlot } : {}),
  };
}

function decodeVecPendingOpenPayload(buf: Uint8Array): { dudeAssetIds: string[]; createdSlot?: number; configPda?: string } | null {
  if (buf.length < 8 + 32 + 32 + 4 + 8 + 1) return null;
  const dudeAssetIds: string[] = [];
  let o = 8 + 32 + 32;
  const dudeCount = readU32(buf, o);
  o += 4;
  if (buf.length < 8 + 32 + 32 + 4 + 32 * dudeCount + 8 + 1) return null;
  for (let i = 0; i < dudeCount; i += 1) {
    dudeAssetIds.push(new PublicKey(buf.subarray(o, o + 32)).toBase58());
    o += 32;
  }

  const createdSlotBig = readU64(buf, o);
  o += 8;
  o += 1; // bump
  const createdSlot = createdSlotBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(createdSlotBig) : undefined;
  let configPda: string | undefined;
  if (o < buf.length) {
    const trailing = buf.length - o;
    if (trailing !== 32) return null;
    configPda = new PublicKey(buf.subarray(o, o + 32)).toBase58();
  }

  return {
    dudeAssetIds,
    ...(createdSlot != null ? { createdSlot } : {}),
    ...(configPda ? { configPda } : {}),
  };
}

export function decodePendingOpenRecordData(
  data: Uint8Array,
  scope: Pick<PendingOpenProgramScope, 'drops'>,
): { owner: string; boxAssetId: string; dudeAssetIds: string[]; createdSlot?: number; configPda?: string } | null {
  const buf = Uint8Array.from(data);
  if (buf.length < 8 + 32 + 32 + 8 + 1) return null;
  if (!bytesEqual(buf.subarray(0, 8), ACCOUNT_PENDING_OPEN_BOX)) return null;

  const owner = new PublicKey(buf.subarray(8, 8 + 32)).toBase58();
  const boxAssetId = new PublicKey(buf.subarray(8 + 32, 8 + 32 + 32)).toBase58();

  const itemCounts = pendingOpenRecordCandidateItemCounts(scope);
  for (const count of itemCounts) {
    const legacy = decodeLegacyFixedPendingOpenPayload(buf, count);
    if (legacy) return { owner, boxAssetId, ...legacy };
  }

  const vec = decodeVecPendingOpenPayload(buf);
  return vec ? { owner, boxAssetId, ...vec } : null;
}

function heliusRpcUrl(cluster: SolanaCluster) {
  if (!heliusApiKey) throw new Error('Missing VITE_HELIUS_API_KEY');
  const heliusSubdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  return `https://${heliusSubdomain}.helius-rpc.com/?api-key=${heliusApiKey}`;
}

async function heliusRpc<T>(cluster: SolanaCluster, method: string, params: unknown): Promise<T> {
  const startedAt = Date.now();
  const url = heliusRpcUrl(cluster);
  const body = { jsonrpc: '2.0', id: method, method, params };
  if (DEBUG_FUNCTIONS) {
    console.info('[mons/helius] →', method, { cluster, params: summarizePayload(params) });
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (DEBUG_FUNCTIONS) {
    console.info('[mons/helius] ←', method, {
      cluster,
      ms: Date.now() - startedAt,
      ok: res.ok,
      status: res.status,
      ...(json?.error ? { error: summarizeError(json?.error) } : { result: summarizePayload(json?.result) }),
    });
  }
  if (!res.ok || (json as any)?.error) {
    const message = (json as any)?.error?.message || res.statusText || `Helius ${method} failed`;
    throw new Error(message);
  }
  return (json as any).result as T;
}

async function fetchHeliusSearchAssetPages(
  cluster: SolanaCluster,
  params: Record<string, unknown>,
  context: HeliusSearchAssetsContext,
): Promise<DasAsset[]> {
  const requestedLimit = Number(params.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : HELIUS_SEARCH_ASSETS_LIMIT;
  const out: DasAsset[] = [];
  for (let page = 1; page <= HELIUS_SEARCH_ASSETS_MAX_PAGES; page += 1) {
    let result: any;
    try {
      result = await heliusRpc<any>(cluster, 'searchAssets', {
        ...params,
        page,
      });
    } catch (err) {
      if (!out.length) throw err;
      console.warn('[mons/helius] searchAssets page failed after partial results', {
        ...context,
        page,
        error: err,
      });
      return out;
    }

    const items = heliusSearchAssetsItems(result);
    out.push(...items);
    if (!heliusSearchAssetsHasNextPage(result, page, items, limit)) return out;
  }

  console.warn('[mons/helius] searchAssets page cap reached', {
    ...context,
    maxPages: HELIUS_SEARCH_ASSETS_MAX_PAGES,
  });
  return out;
}

function getAssetKind(asset: DasAsset): InventoryItem['kind'] | null {
  const kindAttr = asset?.content?.metadata?.attributes?.find((a: any) => a?.trait_type === 'type');
  const value = kindAttr?.value;
  if (value === 'box' || value === 'dude' || value === 'certificate') return value;

  const uri = assetMetadataUri(asset);
  const kindFromUri = metadataKindFromUri(uri);
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

function getBoxIdFromAsset(asset: DasAsset): string | undefined {
  const boxAttr = asset?.content?.metadata?.attributes?.find((a: any) => a?.trait_type === 'box_id');
  const value = boxAttr?.value;
  if (typeof value === 'string' && value) return value;

  const uri = assetMetadataUri(asset);
  const uriBoxId = boxIdFromMetadataUri(uri);
  if (uriBoxId) return uriBoxId;

  const name: string = asset?.content?.metadata?.name || asset?.content?.metadata?.title || '';
  const normalized = typeof name === 'string' ? name.toLowerCase().replace(/\s+/g, '') : '';
  const match = normalized.match(/^(b|box)#?(\d+)$/);
  if (match?.[2]) return match[2];
  return undefined;
}

function getDudeIdFromAsset(asset: DasAsset): number | undefined {
  const dudeAttr = asset?.content?.metadata?.attributes?.find((a: any) => a?.trait_type === 'dude_id');
  const num = Number(dudeAttr?.value);
  if (Number.isFinite(num)) return num;

  const uri = assetMetadataUri(asset);
  const idFromUri = dudeIdFromMetadataUri(uri);
  if (typeof idFromUri === 'number') return idFromUri;
  const name: string = asset?.content?.metadata?.name || asset?.content?.metadata?.title || '';
  if (typeof name === 'string' && name) {
    const match = name.match(/(?:figure|dude)\s*#?\s*(\d+)/i);
    const n = Number(match?.[1]);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function assetMetadataUri(asset: DasAsset): string {
  return selectMetadataUri(
    asset?.content?.json_uri,
    asset?.content?.jsonUri,
    asset?.content?.metadata?.json_uri,
    asset?.content?.metadata?.jsonUri,
    asset?.content?.metadata?.uri,
  );
}

function isBurntAsset(asset: DasAsset): boolean {
  const anyAsset = asset as any;
  const burnt =
    anyAsset?.burnt ??
    anyAsset?.burned ??
    anyAsset?.compression?.burnt ??
    anyAsset?.compression?.burned ??
    anyAsset?.ownership?.burnt ??
    anyAsset?.ownership?.burned;

  if (burnt === true) return true;
  // Some APIs return a non-boolean marker (slot/object). Treat any defined, non-false value as burnt.
  if (burnt != null && burnt !== false) return true;
  return false;
}

function resolveSingleDropRuntime(
  candidates: FrontendDropRuntime[],
  solanaCluster?: SolanaCluster,
): FrontendDropRuntime | null {
  const scoped = solanaCluster ? candidates.filter((drop) => drop.solanaCluster === solanaCluster) : candidates;
  if (scoped.length !== 1) return null;
  return scoped[0];
}

function cacheAssetDropId(asset: DasAsset, dropId: string): string {
  (asset as any)[ASSET_DROP_ID_FIELD] = dropId;
  return dropId;
}

function collectionMintResolvesToCandidateDrop(collectionMint: string, entry: PendingOpenRecordCandidate): boolean {
  const collectionDrop = resolveSingleDropRuntime(FRONTEND_DROPS_BY_COLLECTION_MINT.get(collectionMint) || [], entry.solanaCluster);
  return Boolean(collectionDrop && isCandidateDropId(entry, collectionDrop.dropId));
}

function resolveAssetDropId(asset: DasAsset, solanaCluster?: SolanaCluster): string | null {
  const cached = (asset as any)?.[ASSET_DROP_ID_FIELD];
  if (typeof cached === 'string') {
    const cachedDrop = FRONTEND_DROP_BY_ID.get(cached);
    if (cachedDrop && (!solanaCluster || cachedDrop.solanaCluster === solanaCluster)) return cached;
  }

  const collectionMint = uniqueAssetGroupingCollectionMint(asset);
  if (!collectionMint) return null;
  const collectionDrop = resolveSingleDropRuntime(FRONTEND_DROPS_BY_COLLECTION_MINT.get(collectionMint) || [], solanaCluster);
  if (collectionDrop) return cacheAssetDropId(asset, collectionDrop.dropId);

  return null;
}

async function fetchAssetById(assetId: string, solanaCluster: SolanaCluster): Promise<DasAsset | null> {
  if (!assetId) return null;
  try {
    const asset = await heliusRpc<any>(solanaCluster, 'getAsset', {
      id: assetId,
      options: HELIUS_COLLECTION_GROUPING_OPTIONS,
    });
    return asset && typeof asset === 'object' ? (asset as DasAsset) : null;
  } catch {
    return null;
  }
}

function isCandidateDropId(entry: PendingOpenRecordCandidate, dropId: string): boolean {
  return entry.candidateDrops.some((drop) => drop.dropId === dropId);
}

function resolvePendingOpenDropIdByConfigPda(entry: PendingOpenRecordCandidate): string | null {
  const configPda = typeof entry.configPda === 'string' ? entry.configPda.trim() : '';
  if (!configPda) return null;
  const drop = FRONTEND_DROPS_BY_CONFIG_PDA.get(frontendDropConfigPdaKey(entry.solanaCluster, configPda));
  if (!drop || !isCandidateDropId(entry, drop.dropId)) return null;
  return drop.dropId;
}

function resolvePendingOpenDropIdByPlaceholderCount(entry: PendingOpenRecordCandidate): string | null {
  const matches = entry.candidateDrops.filter((drop) => drop.itemsPerBox === entry.dudeAssetIds.length);
  return matches.length === 1 ? matches[0].dropId : null;
}

function pendingOpenCanResolveFromAssetCollection(entry: PendingOpenRecordCandidate): boolean {
  return entry.candidateDrops.some((drop) => collectionMintResolvesToCandidateDrop(drop.collectionMint, entry));
}

async function resolvePendingOpenDropId(entry: PendingOpenRecordCandidate): Promise<string | null> {
  const configDropId = resolvePendingOpenDropIdByConfigPda(entry);
  if (configDropId) return cachePendingOpenDropId(entry, configDropId);
  if (entry.configPda) {
    // New shared-program pending records carry their config PDA explicitly.
    // If this client does not recognize that config, hiding the row is safer than
    // mislabeling it as some other known drop on the same shared program.
    return null;
  }

  if (entry.candidateDrops.length === 1) {
    return cachePendingOpenDropId(entry, entry.candidateDrops[0].dropId);
  }

  const placeholderDropId = resolvePendingOpenDropIdByPlaceholderCount(entry);
  if (placeholderDropId) return cachePendingOpenDropId(entry, placeholderDropId);

  const cachedDropId = getPendingOpenDropIdCache(entry.solanaCluster, entry.boxAssetId);
  if (cachedDropId && isCandidateDropId(entry, cachedDropId)) {
    return cachedDropId;
  }

  if (!pendingOpenCanResolveFromAssetCollection(entry)) return null;

  const asset = await fetchAssetById(entry.boxAssetId, entry.solanaCluster);
  if (!asset) return null;

  const resolvedDropId = resolveAssetDropId(asset, entry.solanaCluster);
  if (!resolvedDropId) return null;
  if (!isCandidateDropId(entry, resolvedDropId)) {
    return null;
  }
  return cachePendingOpenDropId(entry, resolvedDropId);
}

function decodePendingOpenRecordCandidate(
  entry: any,
  owner: string,
  scope: PendingOpenProgramScope,
): PendingOpenRecordCandidate | null {
  const pendingPda = typeof entry?.pubkey === 'string' ? entry.pubkey : null;
  const dataField = entry?.account?.data;
  const dataB64 =
    Array.isArray(dataField) && typeof dataField[0] === 'string'
      ? dataField[0]
      : typeof dataField === 'string'
        ? dataField
        : null;
  if (!pendingPda || !dataB64) return null;

  const buf = Uint8Array.from(Buffer.from(dataB64, 'base64'));
  const decoded = decodePendingOpenRecordData(buf, scope);
  if (!decoded) return null;
  if (decoded.owner !== owner) return null;

  return {
    solanaCluster: scope.solanaCluster,
    pendingPda,
    boxAssetId: decoded.boxAssetId,
    dudeAssetIds: decoded.dudeAssetIds,
    candidateDrops: scope.drops,
    ...(decoded.createdSlot != null ? { createdSlot: decoded.createdSlot } : {}),
    ...(decoded.configPda ? { configPda: decoded.configPda } : {}),
  };
}

function isMonsAsset(asset: DasAsset): boolean {
  // Never show burned assets in inventory.
  if (isBurntAsset(asset)) return false;
  const kind = getAssetKind(asset);
  if (!kind) return false;
  return Boolean(resolveAssetDropId(asset));
}

function transformInventoryItem(asset: DasAsset): InventoryItem | null {
  if (isBurntAsset(asset)) return null;
  const kind = getAssetKind(asset);
  if (!kind) return null;
  const dropId = resolveAssetDropId(asset);
  if (!dropId) return null;
  const boxId = getBoxIdFromAsset(asset);
  const dudeId = getDudeIdFromAsset(asset);
  const imageRaw =
    asset?.content?.links?.image ||
    asset?.content?.metadata?.image ||
    asset?.content?.files?.[0]?.uri ||
    asset?.content?.files?.[0]?.cdn_uri;

  const image =
    kind === 'dude'
      ? normalizeFigureDisplayImage(dropId, imageRaw, dudeId)
      : kind === 'certificate'
        ? normalizeCertificateDisplayImage({ dropId, imageRaw, figureId: dudeId, boxId })
        : normalizeBoxDisplayImage({ dropId, imageRaw, boxId });
  return {
    id: asset.id,
    dropId,
    name: asset.content?.metadata?.name || asset.id,
    kind,
    boxId,
    dudeId,
    image,
    attributes: asset.content?.metadata?.attributes || [],
  };
}

async function fetchAssetsOwned(owner: string, options?: DropFetchOptions): Promise<DasAsset[]> {
  const baseParams = {
    ownerAddress: owner,
    limit: HELIUS_SEARCH_ASSETS_LIMIT,
    burnt: false,
    options: HELIUS_COLLECTION_GROUPING_OPTIONS,
  };

  const mergedByAssetId = new Map<string, DasAsset>();
  const ungroupedByCluster = new Map<SolanaCluster, DasAsset[]>();
  const runtimes = listResolvableCollectionDropRuntimes(options);

  for (const drop of runtimes) {
    let items: DasAsset[] = [];
    let usedFallback = false;

    try {
      items = await fetchHeliusSearchAssetPages(
        drop.solanaCluster,
        {
          ...baseParams,
          grouping: ['collection', drop.collectionMint],
        },
        {
          cluster: drop.solanaCluster,
          dropId: drop.dropId,
          mode: 'grouped',
        },
      );
    } catch (err) {
      console.warn('[mons/helius] grouped search failed, will try fallback', {
        dropId: drop.dropId,
        cluster: drop.solanaCluster,
        error: err,
      });
    }

    if (!items.length) {
      usedFallback = true;
      if (!ungroupedByCluster.has(drop.solanaCluster)) {
        try {
          // Ungrouped search scans the owner's whole wallet; keep this fallback bounded.
          const ungrouped = await heliusRpc<any>(drop.solanaCluster, 'searchAssets', { ...baseParams, page: 1 });
          const ungroupedItems = heliusSearchAssetsItems(ungrouped);
          ungroupedByCluster.set(drop.solanaCluster, ungroupedItems);
        } catch (err) {
          console.warn('[mons/helius] ungrouped search failed', {
            dropId: drop.dropId,
            cluster: drop.solanaCluster,
            error: err,
          });
          ungroupedByCluster.set(drop.solanaCluster, []);
        }
      }
      items = ungroupedByCluster.get(drop.solanaCluster) || [];
    }

    items.forEach((asset) => {
      const dropId = resolveAssetDropId(asset, drop.solanaCluster);
      if (dropId !== drop.dropId) return;
      if (!isMonsAsset(asset)) return;
      const assetId = typeof asset?.id === 'string' ? asset.id : '';
      if (!assetId) return;
      mergedByAssetId.set(assetId, asset);
    });

    if (DEBUG_FUNCTIONS && usedFallback) {
      console.info('[mons/helius] drop inventory used fallback search', {
        dropId: drop.dropId,
        cluster: drop.solanaCluster,
      });
    }
  }

  return Array.from(mergedByAssetId.values());
}

export async function fetchInventory(owner: string, options?: DropFetchOptions): Promise<InventoryItem[]> {
  const assets = await fetchAssetsOwned(owner, options);
  return assets.map(transformInventoryItem).filter(Boolean) as InventoryItem[];
}

export async function listCardNft2UnrevealedCards(
  args: ListCardNft2UnrevealedCardsRequest = {},
): Promise<ListCardNft2UnrevealedCardsResponse> {
  return callFunction<ListCardNft2UnrevealedCardsRequest, ListCardNft2UnrevealedCardsResponse>(
    'listCardNft2UnrevealedCards',
    args,
  );
}

export async function fetchPendingOpenBoxes(owner: string, options?: DropFetchOptions): Promise<PendingOpenBox[]> {
  const discovered: PendingOpenRecordCandidate[] = [];
  for (const scope of listPendingOpenProgramScopes(options)) {
    const result = await heliusRpc<any>(scope.solanaCluster, 'getProgramAccounts', [
      scope.boxMinterProgramId,
      {
        encoding: 'base64',
        filters: [
          { memcmp: { offset: 0, bytes: ACCOUNT_PENDING_OPEN_BOX_B58 } },
          { memcmp: { offset: 8, bytes: owner } },
        ],
      },
    ]).catch((err) => {
      console.warn('[mons/helius] getProgramAccounts failed for pending opens', {
        programId: scope.boxMinterProgramId,
        dropIds: scope.drops.map((drop) => drop.dropId),
        cluster: scope.solanaCluster,
        error: err,
      });
      return [];
    });

    const accounts = Array.isArray(result) ? result : [];
    for (const entry of accounts) {
      const candidate = decodePendingOpenRecordCandidate(entry, owner, scope);
      if (candidate) discovered.push(candidate);
    }
  }

  // Querying per drop breaks once multiple drops reuse one program id. Discover the pending
  // records once per shared program, then recover the real drop from the stored box asset.
  const deduped = new Map<string, PendingOpenRecordCandidate>();
  discovered.forEach((entry) => {
    deduped.set(`${entry.solanaCluster}:${entry.pendingPda}`, entry);
  });

  const resolved = await Promise.all(
    Array.from(deduped.values()).map(async (entry): Promise<PendingOpenBox | null> => {
      const dropId = await resolvePendingOpenDropId(entry);
      if (!dropId) return null;
      return {
        dropId,
        pendingPda: entry.pendingPda,
        boxAssetId: entry.boxAssetId,
        dudeAssetIds: entry.dudeAssetIds,
        ...(entry.createdSlot != null ? { createdSlot: entry.createdSlot } : {}),
      };
    }),
  );

  const rows = resolved.filter((entry): entry is PendingOpenBox => Boolean(entry));
  rows.sort((a, b) => (Number(b.createdSlot || 0) - Number(a.createdSlot || 0)));
  return rows;
}

export async function revealDudes(
  owner: string,
  boxAssetId: string,
  dropId: string,
): Promise<{ signature: string; dudeIds: number[] }> {
  return callFunction<{ owner: string; boxAssetId: string; dropId: string }, { signature: string; dudeIds: number[] }>('revealDudes', {
    owner,
    boxAssetId,
    dropId,
  });
}

export async function saveEncryptedAddress(
  encrypted: string,
  country: string,
  hint: string,
  email?: string,
  countryCode?: string,
): Promise<ProfileAddress> {
  return callFunction<
    { encrypted: string; country: string; countryCode?: string; hint: string; email?: string },
    ProfileAddress
  >('saveAddress', { encrypted, country, countryCode, hint, email });
}

export async function removeAddress(addressId: string): Promise<{ id: string; removed?: boolean }> {
  return callFunction<{ addressId: string }, { id: string; removed?: boolean }>('removeAddress', { addressId });
}

type StripeCheckoutSessionRequest = {
  dropId: string;
  variantKey?: string;
  quantity?: number;
  returnUrl?: string;
};

type StripeCheckoutSessionResponse = {
  id: string;
  url: string;
  livemode?: boolean;
};

function stripeCheckoutRequestQuantity(quantity: StripeCheckoutSessionRequest['quantity']): number | undefined {
  if (quantity === undefined) return undefined;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Stripe checkout quantity must be a positive integer');
  }
  return quantity;
}

function stripeCheckoutSessionPayload(args: StripeCheckoutSessionRequest): StripeCheckoutSessionRequest {
  const payload: StripeCheckoutSessionRequest = {
    dropId: args.dropId,
  };
  if (typeof args.variantKey === 'string' && args.variantKey.trim()) {
    payload.variantKey = args.variantKey.trim();
  }
  const quantity = stripeCheckoutRequestQuantity(args.quantity);
  if (quantity !== undefined) {
    payload.quantity = quantity;
  }
  if (typeof args.returnUrl === 'string' && args.returnUrl.trim()) {
    payload.returnUrl = args.returnUrl.trim();
  }
  return payload;
}

export async function createStripeCheckoutSession(args: StripeCheckoutSessionRequest): Promise<StripeCheckoutSessionResponse> {
  return callFunction<StripeCheckoutSessionRequest, StripeCheckoutSessionResponse>(
    'createStripeCheckoutSession',
    stripeCheckoutSessionPayload(args),
  );
}

export async function createTestStripeCheckoutSession(args: StripeCheckoutSessionRequest): Promise<StripeCheckoutSessionResponse> {
  return callFunction<StripeCheckoutSessionRequest, StripeCheckoutSessionResponse>(
    'createTestStripeCheckoutSession',
    stripeCheckoutSessionPayload(args),
  );
}

function normalizePackStatusAmount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

const PACK_STATUS_DEFAULT_CARDS_PER_PACK = 3;

type PackStatusFrontendConfig = {
  unsealedLabel: string;
};

const PACK_STATUS_FRONTEND_CONFIGS_BY_DROP_ID: Record<string, PackStatusFrontendConfig> = {
  card_nft_2: {
    unsealedLabel: 'Unpacked',
  },
  poncho_drifella: {
    unsealedLabel: 'Unpacked',
  },
  little_swag_boxes: {
    unsealedLabel: 'Unboxed',
  },
};

function packStatusFrontendConfigForDropId(dropId: string): PackStatusFrontendConfig | null {
  const normalizedDropId = normalizeDropId(dropId);
  const config = PACK_STATUS_FRONTEND_CONFIGS_BY_DROP_ID[normalizedDropId];
  const drop = FRONTEND_DROPS[normalizedDropId];
  if (!config || !drop || drop.solanaCluster !== 'mainnet-beta' || normalizePackStatusAmount(drop.itemsPerBox) <= 0) return null;
  return config;
}

function packStatusCardsPerPackForDropId(dropId: string): number {
  const normalizedDropId = normalizeDropId(dropId);
  const dropItemsPerBox = normalizePackStatusAmount(FRONTEND_DROPS[normalizedDropId]?.itemsPerBox);
  return dropItemsPerBox || PACK_STATUS_DEFAULT_CARDS_PER_PACK;
}

export function packStatusDisplayLabelsForDropId(dropId: string | undefined): PackStatusDisplayLabels | null {
  if (!dropId) return null;
  const normalizedDropId = normalizeDropId(dropId);
  const drop = FRONTEND_DROPS[normalizedDropId];
  if (!drop || !packStatusFrontendConfigForDropId(normalizedDropId)) return null;
  return {
    itemColumnLabel: dropAssetLabel(drop, 'figure', 2, { capitalize: true }),
    ariaLabel: `${dropAssetLabel(drop, 'figure', 1, { capitalize: true })} status`,
  };
}

export function supportsFrontendPackStatus(dropId: string | undefined): boolean {
  return Boolean(dropId && packStatusFrontendConfigForDropId(dropId));
}

function packStatusPercentage(amount: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((amount / total) * 10_000) / 100;
}

function packStatusItem(
  key: PackStatusBreakdownItem['key'],
  label: string,
  amount: number,
  total: number,
): PackStatusBreakdownItem {
  return {
    key,
    label,
    amount,
    percentage: key === 'total' && total > 0 ? 100 : packStatusPercentage(amount, total),
  };
}

function normalizePackStatusBreakdown(raw: any, dropId: string): PackStatusBreakdown | null {
  if (!raw || typeof raw !== 'object') return null;
  if (normalizePackStatusAmount(raw.version) !== 1) return null;
  if (typeof raw.dropId === 'string' && raw.dropId && raw.dropId !== dropId) return null;
  const totalInitialSupply = normalizePackStatusAmount(raw.totalInitialSupply);
  if (totalInitialSupply <= 0) return null;
  const config = packStatusFrontendConfigForDropId(dropId);
  const cardsPerPack = normalizePackStatusAmount(raw.cardsPerPack) || packStatusCardsPerPackForDropId(dropId);
  const totalCards = normalizePackStatusAmount(raw.totalCards) || totalInitialSupply * cardsPerPack;
  const total = totalCards;
  const unsealedOnline = normalizePackStatusAmount(raw.unsealedOnline);
  const unsealedCards = unsealedOnline * cardsPerPack;
  const redeemedIrlNormal = normalizePackStatusAmount(raw.redeemedIrlNormal);
  const redeemedIrlStripe = normalizePackStatusAmount(raw.redeemedIrlStripe);
  const redeemedUnsealedCards = normalizePackStatusAmount(raw.redeemedUnsealedCards);
  const redeemedIrl = redeemedIrlNormal + redeemedIrlStripe;
  const redeemedCards = redeemedIrl * cardsPerPack + redeemedUnsealedCards;
  const items: PackStatusBreakdownItem[] = [
    packStatusItem('unsealed', config?.unsealedLabel || 'Unpacked', unsealedCards, total),
    packStatusItem('redeemed', 'Redeemed', redeemedCards, total),
    packStatusItem('total', 'Total', total, total),
  ];
  return {
    dropId,
    total,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline,
    unsealedCards,
    redeemedIrl,
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
    redeemedCards,
    items,
  };
}

export async function getDropPackStatus(dropId: string): Promise<PackStatusBreakdown | null> {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) throw new Error('dropId is required');
  if (!firestore) throw new Error('Firebase client is not configured');
  await ensureAuthenticated();
  const snap = await getDoc(doc(firestore, 'drops', normalizedDropId, 'meta', 'packStatus'));
  if (!snap.exists()) return null;
  return normalizePackStatusBreakdown(snap.data(), normalizedDropId);
}

export async function listFulfillmentOrders(args: {
  limit?: number;
  cursor?: FulfillmentOrdersCursor | null;
  dropId: string;
}): Promise<{ orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }> {
  const resp = await callFunction<
    { limit?: number; cursor?: FulfillmentOrdersCursor | null; dropId: string },
    { orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }
  >('listFulfillmentOrders', {
    limit: args.limit,
    cursor: args.cursor || undefined,
    dropId: args.dropId,
  });
  return {
    ...resp,
    orders: (Array.isArray(resp.orders) ? resp.orders : []).map((order) => ({
      ...order,
      dropId: order.dropId || args.dropId,
    })),
  };
}

export async function listFulfillmentManualReviewCheckouts(args: {
  dropId: string;
}): Promise<{ checkouts: FulfillmentManualReviewCheckout[] }> {
  const resp = await callFunction<
    { dropId: string },
    { checkouts: FulfillmentManualReviewCheckout[] }
  >('listFulfillmentManualReviewCheckouts', { dropId: args.dropId });
  return {
    checkouts: (Array.isArray(resp.checkouts) ? resp.checkouts : []).map((checkout) => ({
      ...checkout,
      dropId: checkout.dropId || args.dropId,
      address: checkout.address || {},
    })),
  };
}

export async function updateFulfillmentStatus(
  deliveryId: number,
  status: FulfillmentStatus | '' | null,
  dropId: string,
  trackingCode?: string,
): Promise<{ deliveryId: number; fulfillmentStatus: FulfillmentStatus | ''; fulfillmentTrackingCode?: string }> {
  return callFunction<
    { deliveryId: number; status: FulfillmentStatus | '' | null; dropId: string; trackingCode?: string },
    { deliveryId: number; fulfillmentStatus: FulfillmentStatus | ''; fulfillmentTrackingCode?: string }
  >('updateFulfillmentStatus', { deliveryId, status, dropId, ...(trackingCode != null ? { trackingCode } : {}) });
}

export async function updateFulfillmentInternalStatus(
  deliveryId: number,
  status: string,
  dropId: string,
): Promise<{ deliveryId: number; fulfillmentInternalStatus: string }> {
  return callFunction<
    { deliveryId: number; status: string; dropId: string },
    { deliveryId: number; fulfillmentInternalStatus: string }
  >('updateFulfillmentInternalStatus', { deliveryId, status, dropId });
}

export async function requestDeliveryTx(
  owner: string,
  selection: DeliverySelection,
  dropId: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; dropId: string } & DeliverySelection, PreparedTxResponse>('prepareDeliveryTx', {
    owner,
    ...selection,
    dropId,
  });
}

export async function prepareAdminIrlRedeemTx(args: {
  owner: string;
  dropId: string;
  itemIds: string[];
}): Promise<AdminIrlRedeemPreparedTxResponse> {
  return callFunction<
    { owner: string; dropId: string; itemIds: string[] },
    AdminIrlRedeemPreparedTxResponse
  >('prepareAdminIrlRedeemTx', args);
}

export async function finalizeAdminIrlRedeem(args: {
  requestId: string;
  dropId: string;
  transferSignature: string;
}): Promise<AdminIrlRedeemFinalizeResult> {
  return callFunction<
    { requestId: string; dropId: string; transferSignature: string },
    AdminIrlRedeemFinalizeResult
  >('finalizeAdminIrlRedeem', args);
}

export async function issueReceipts(
  owner: string,
  deliveryId: number,
  signature: string,
  dropId: string,
): Promise<IssueReceiptsResult> {
  return callFunction<{ owner: string; deliveryId: number; signature: string; dropId: string }, IssueReceiptsResult>(
    'issueReceipts',
    { owner, deliveryId, signature, dropId },
  );
}

export async function recoverMyDeliveryOrders(args?: RecoverDeliveryOrdersArgs): Promise<RecoverDeliveryOrdersResult> {
  const payload: RecoverDeliveryOrdersArgs = {};
  if (typeof args?.dropId === 'string' && args.dropId.trim()) {
    payload.dropId = args.dropId.trim().toLowerCase();
  }
  if (typeof args?.deliveryId === 'number' && Number.isFinite(args.deliveryId)) {
    payload.deliveryId = Math.floor(args.deliveryId);
  }
  if (args?.force === true) {
    payload.force = true;
  }
  return callFunction<RecoverDeliveryOrdersArgs, RecoverDeliveryOrdersResult>('recoverMyDeliveryOrders', payload);
}

export async function requestClaimTx(
  owner: string,
  code: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; code: string }, PreparedTxResponse>('prepareIrlClaimTx', { owner, code });
}

export async function claimStripeReceipt(args: { code: string; recipient: string }): Promise<StripeReceiptClaimResult> {
  return callFunction<{ code: string; recipient: string }, StripeReceiptClaimResult>('claimStripeReceipt', {
    code: args.code,
    recipient: args.recipient,
  });
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
  options?: { mergeStripeDeliveryOrders?: boolean },
): Promise<{ profile: Profile }> {
  type SolanaAuthRequest = {
    wallet: string;
    message: string;
    signature: number[];
    mergeStripeDeliveryOrders?: boolean;
  };
  const payload: SolanaAuthRequest = {
    wallet,
    message,
    signature: Array.from(signature),
  };
  if (options?.mergeStripeDeliveryOrders) {
    payload.mergeStripeDeliveryOrders = true;
  }
  return callFunction<SolanaAuthRequest, { profile: Profile }>('solanaAuth', payload);
}

type GetProfileRequest = {
  ownerWallet?: string;
  mergeStripeDeliveryOrders?: boolean;
};

export async function getProfile(
  ownerWallet?: string,
  options?: { mergeStripeDeliveryOrders?: boolean },
): Promise<{ profile: Profile }> {
  const payload: GetProfileRequest = {};
  if (typeof ownerWallet === 'string' && ownerWallet.trim()) {
    payload.ownerWallet = ownerWallet;
  }
  if (options?.mergeStripeDeliveryOrders) {
    payload.mergeStripeDeliveryOrders = true;
  }
  return callFunction<GetProfileRequest, { profile: Profile }>('getProfile', payload);
}

export async function getAnonymousStripeDeliveryHistory(): Promise<{ orders: Profile['orders'] }> {
  return callFunction<Record<string, never>, { orders: Profile['orders'] }>('getAnonymousStripeDeliveryHistory', {});
}

export async function listDeliveryOrderOwners(
  options?: { cursor?: string; pageSize?: number },
): Promise<{ owners: string[]; nextCursor: string | null; hasMore: boolean }> {
  const payload: { cursor?: string; pageSize?: number } = {};
  if (typeof options?.cursor === 'string' && options.cursor) {
    payload.cursor = options.cursor;
  }
  if (typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize)) {
    payload.pageSize = options.pageSize;
  }
  return callFunction<
    { cursor?: string; pageSize?: number },
    { owners: string[]; nextCursor: string | null; hasMore: boolean }
  >('listDeliveryOrderOwners', payload);
}
