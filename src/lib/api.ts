import { onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { PublicKey } from '@solana/web3.js';
import { auth, FIREBASE_FUNCTIONS_REGION, firebaseApp } from './firebase';
import {
  DeliverySelection,
  FulfillmentStatus,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  InventoryItem,
  PendingOpenBox,
  PreparedTxResponse,
  Profile,
  ProfileAddress,
} from '../types';
import { getHeliusApiKey } from './helius';
import { normalizeFigureDisplayImage } from './dropContent';
import {
  FRONTEND_DROPS,
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

type FrontendDropRuntime = Pick<
  FrontendDeploymentConfig,
  'dropId' | 'solanaCluster' | 'collectionMint' | 'boxMinterProgramId'
>;

const FRONTEND_DROP_RUNTIMES: FrontendDropRuntime[] = Object.keys(FRONTEND_DROPS)
  .sort((a, b) => a.localeCompare(b))
  .map((dropId) => {
    const drop = FRONTEND_DROPS[dropId];
    return {
      dropId: drop.dropId,
      solanaCluster: drop.solanaCluster,
      collectionMint: drop.collectionMint,
      boxMinterProgramId: drop.boxMinterProgramId,
    };
  });

const FRONTEND_DROP_BY_ID = new Map<string, FrontendDropRuntime>(
  FRONTEND_DROP_RUNTIMES.map((drop) => [drop.dropId, drop]),
);
const FRONTEND_DROPS_BY_COLLECTION_MINT = new Map<string, FrontendDropRuntime[]>();
FRONTEND_DROP_RUNTIMES.forEach((drop) => {
  const existing = FRONTEND_DROPS_BY_COLLECTION_MINT.get(drop.collectionMint) || [];
  existing.push(drop);
  FRONTEND_DROPS_BY_COLLECTION_MINT.set(drop.collectionMint, existing);
});

type DasAsset = Record<string, any>;
const ASSET_DROP_ID_FIELD = '__monsDropId';

function readU32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, true);
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

function getAssetKind(asset: DasAsset): InventoryItem['kind'] | null {
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

function getBoxIdFromAsset(asset: DasAsset): string | undefined {
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

function getDudeIdFromAsset(asset: DasAsset): number | undefined {
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
  const name: string = asset?.content?.metadata?.name || asset?.content?.metadata?.title || '';
  if (typeof name === 'string' && name) {
    const match = name.match(/(?:figure|dude)\s*#?\s*(\d+)/i);
    const n = Number(match?.[1]);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function assetCollectionMints(asset: DasAsset): string[] {
  const out = new Set<string>();
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const g of grouped) {
      if (g?.group_key === 'collection' && typeof g?.group_value === 'string' && g.group_value) {
        out.add(g.group_value);
      }
    }
  }
  const contentCollectionKey = asset?.content?.metadata?.collection?.key;
  if (typeof contentCollectionKey === 'string' && contentCollectionKey) out.add(contentCollectionKey);
  return Array.from(out);
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

function resolveAssetDropId(asset: DasAsset, solanaCluster?: SolanaCluster): string | null {
  const cached = (asset as any)?.[ASSET_DROP_ID_FIELD];
  if (typeof cached === 'string' && FRONTEND_DROP_BY_ID.has(cached)) return cached;

  for (const collectionMint of assetCollectionMints(asset)) {
    const drop = resolveSingleDropRuntime(FRONTEND_DROPS_BY_COLLECTION_MINT.get(collectionMint) || [], solanaCluster);
    if (!drop) continue;
    (asset as any)[ASSET_DROP_ID_FIELD] = drop.dropId;
    return drop.dropId;
  }

  return null;
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

  const image = kind === 'dude' ? normalizeFigureDisplayImage(dropId, imageRaw, dudeId) : imageRaw;
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

async function fetchAssetsOwned(owner: string): Promise<DasAsset[]> {
  const baseParams = {
    ownerAddress: owner,
    page: 1,
    limit: 1000,
    displayOptions: {
      showCollectionMetadata: true,
      showUnverifiedCollections: true,
    },
  };

  const mergedByAssetId = new Map<string, DasAsset>();
  const ungroupedByCluster = new Map<SolanaCluster, DasAsset[]>();

  for (const drop of FRONTEND_DROP_RUNTIMES) {
    let items: DasAsset[] = [];
    let usedFallback = false;

    try {
      const grouped = await heliusRpc<any>(drop.solanaCluster, 'searchAssets', {
        ...baseParams,
        grouping: ['collection', drop.collectionMint],
      });
      items = Array.isArray(grouped?.items) ? grouped.items : [];
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
          const ungrouped = await heliusRpc<any>(drop.solanaCluster, 'searchAssets', baseParams);
          const ungroupedItems = Array.isArray(ungrouped?.items) ? ungrouped.items : [];
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

export async function fetchInventory(owner: string): Promise<InventoryItem[]> {
  const assets = await fetchAssetsOwned(owner);
  return assets.map(transformInventoryItem).filter(Boolean) as InventoryItem[];
}

export async function fetchPendingOpenBoxes(owner: string): Promise<PendingOpenBox[]> {
  const out: PendingOpenBox[] = [];
  for (const drop of FRONTEND_DROP_RUNTIMES) {
    const result = await heliusRpc<any>(drop.solanaCluster, 'getProgramAccounts', [
      drop.boxMinterProgramId,
      {
        encoding: 'base64',
        filters: [
          { memcmp: { offset: 0, bytes: ACCOUNT_PENDING_OPEN_BOX_B58 } },
          { memcmp: { offset: 8, bytes: owner } },
        ],
      },
    ]).catch((err) => {
      console.warn('[mons/helius] getProgramAccounts failed for pending opens', {
        dropId: drop.dropId,
        cluster: drop.solanaCluster,
        error: err,
      });
      return [];
    });

    const accounts = Array.isArray(result) ? result : [];
    for (const entry of accounts) {
      const pendingPda = typeof entry?.pubkey === 'string' ? entry.pubkey : null;
      const dataField = entry?.account?.data;
      const dataB64 =
        Array.isArray(dataField) && typeof dataField[0] === 'string'
          ? dataField[0]
          : typeof dataField === 'string'
            ? dataField
            : null;
      if (!pendingPda || !dataB64) continue;
      const buf = Uint8Array.from(Buffer.from(dataB64, 'base64'));
      if (buf.length < 8 + 32 + 32 + 4 + 8 + 1) continue;
      if (!bytesEqual(buf.subarray(0, 8), ACCOUNT_PENDING_OPEN_BOX)) continue;
      const ownerFromChain = new PublicKey(buf.subarray(8, 8 + 32)).toBase58();
      if (ownerFromChain !== owner) continue;
      const boxAssetId = new PublicKey(buf.subarray(8 + 32, 8 + 32 + 32)).toBase58();
      const dudeAssetIds: string[] = [];
      let o = 8 + 32 + 32;
      const dudeCount = readU32(buf, o);
      o += 4;
      if (buf.length < 8 + 32 + 32 + 4 + 32 * dudeCount + 8 + 1) continue;
      for (let i = 0; i < dudeCount; i += 1) {
        dudeAssetIds.push(new PublicKey(buf.subarray(o, o + 32)).toBase58());
        o += 32;
      }
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const createdSlotBig = view.getBigUint64(o, true);
      const createdSlot = createdSlotBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(createdSlotBig) : undefined;
      out.push({
        dropId: drop.dropId,
        pendingPda,
        boxAssetId,
        dudeAssetIds,
        ...(createdSlot != null ? { createdSlot } : {}),
      });
    }
  }
  const deduped = new Map<string, PendingOpenBox>();
  out.forEach((entry) => {
    deduped.set(`${entry.dropId}:${entry.pendingPda}`, entry);
  });
  const dedupedRows = Array.from(deduped.values());
  dedupedRows.sort((a, b) => (Number(b.createdSlot || 0) - Number(a.createdSlot || 0)));
  return dedupedRows;
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

export async function listFulfillmentOrders(args: {
  limit?: number;
  cursor?: FulfillmentOrdersCursor | null;
  dropId: string;
}): Promise<{ orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }> {
  return callFunction<
    { limit?: number; cursor?: FulfillmentOrdersCursor | null; dropId: string },
    { orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }
  >('listFulfillmentOrders', {
    limit: args.limit,
    cursor: args.cursor || undefined,
    dropId: args.dropId,
  });
}

export async function updateFulfillmentStatus(
  deliveryId: number,
  status: FulfillmentStatus | '' | null,
  dropId: string,
): Promise<{ deliveryId: number; fulfillmentStatus: FulfillmentStatus | '' }> {
  return callFunction<
    { deliveryId: number; status: FulfillmentStatus | '' | null; dropId: string },
    { deliveryId: number; fulfillmentStatus: FulfillmentStatus | '' }
  >('updateFulfillmentStatus', { deliveryId, status, dropId });
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

export async function issueReceipts(
  owner: string,
  deliveryId: number,
  signature: string,
  dropId: string,
): Promise<{ processed: boolean; deliveryId: number; receiptsMinted?: number; receiptTxs?: string[]; closeDeliveryTx?: string | null }> {
  return callFunction<
    { owner: string; deliveryId: number; signature: string; dropId: string },
    { processed: boolean; deliveryId: number; receiptsMinted?: number; receiptTxs?: string[]; closeDeliveryTx?: string | null }
  >('issueReceipts', { owner, deliveryId, signature, dropId });
}

export async function requestClaimTx(
  owner: string,
  code: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; code: string }, PreparedTxResponse>('prepareIrlClaimTx', { owner, code });
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
): Promise<{ profile: Profile }> {
  return callFunction<{ wallet: string; message: string; signature: number[] }, { profile: Profile }>('solanaAuth', {
    wallet,
    message,
    signature: Array.from(signature),
  });
}

export async function getProfile(ownerWallet?: string): Promise<{ profile: Profile }> {
  const payload: { ownerWallet?: string } = {};
  if (typeof ownerWallet === 'string' && ownerWallet.trim()) {
    payload.ownerWallet = ownerWallet;
  }
  return callFunction<{ ownerWallet?: string }, { profile: Profile }>('getProfile', payload);
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
