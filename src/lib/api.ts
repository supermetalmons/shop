import { signInAnonymously } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, firebaseApp } from './firebase';
import { DeliverySelection, InventoryItem, MintStats, PreparedTxResponse, Profile, ProfileAddress } from '../types';

const region = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1';
const functionsInstance = firebaseApp ? getFunctions(firebaseApp, region) : undefined;

let authReadyPromise: Promise<string> | null = null;

async function ensureAuthenticated(): Promise<string> {
  if (!auth) throw new Error('Firebase client is not configured');
  if (auth.currentUser) return auth.currentUser.uid;
  if (!authReadyPromise) {
    authReadyPromise = signInAnonymously(auth)
      .then((credential) => credential.user.uid)
      .finally(() => {
        authReadyPromise = null;
      });
  }
  return authReadyPromise;
}

const DEBUG_FUNCTIONS =
  import.meta.env.DEV ||
  import.meta.env.VITE_DEBUG_FUNCTIONS === 'true' ||
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

export async function fetchMintStats(): Promise<MintStats> {
  return callFunction<void, MintStats>('stats');
}

const DEFAULT_METADATA_BASE = 'https://assets.mons.link/shop/drops/1';
const heliusApiKey = (import.meta.env.VITE_HELIUS_API_KEY || '').trim();
const heliusRpcBase = (import.meta.env.VITE_HELIUS_RPC_URL || '').trim();
const heliusCluster = (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet').toLowerCase();
const heliusSubdomain = heliusCluster === 'mainnet-beta' ? 'mainnet' : heliusCluster;
const heliusCollection = (import.meta.env.VITE_COLLECTION_MINT || '').trim();
const heliusMerkleTree = (import.meta.env.VITE_MERKLE_TREE || '').trim();
const heliusMetadataBase = ((import.meta.env.VITE_METADATA_BASE as string) || DEFAULT_METADATA_BASE).replace(/\/$/, '');

type DasAsset = Record<string, any>;

function heliusRpcUrl() {
  if (!heliusApiKey) throw new Error('Missing VITE_HELIUS_API_KEY');
  if (heliusRpcBase) return `${heliusRpcBase}${heliusRpcBase.includes('?') ? '&' : '?'}api-key=${heliusApiKey}`;
  return `https://${heliusSubdomain}.helius-rpc.com/?api-key=${heliusApiKey}`;
}

async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  const startedAt = Date.now();
  const url = heliusRpcUrl();
  const body = { jsonrpc: '2.0', id: method, method, params };
  if (DEBUG_FUNCTIONS) {
    console.info('[mons/helius] →', method, summarizePayload(params));
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (DEBUG_FUNCTIONS) {
    console.info('[mons/helius] ←', method, {
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
  return undefined;
}

function isMonsAsset(asset: DasAsset): boolean {
  const kind = getAssetKind(asset);
  if (!kind) return false;

  const groupingMatch =
    !heliusCollection ||
    (asset?.grouping || []).some((g: any) => g?.group_key === 'collection' && g?.group_value === heliusCollection);
  if (groupingMatch) return true;

  const tree = asset?.compression?.tree || asset?.compression?.treeId;
  if (heliusMerkleTree && typeof tree === 'string' && tree === heliusMerkleTree) return true;

  const uri: string = asset?.content?.json_uri || asset?.content?.jsonUri || '';
  if (typeof uri === 'string' && uri && uri.startsWith(heliusMetadataBase)) return true;

  return false;
}

function transformInventoryItem(asset: DasAsset): InventoryItem | null {
  const kind = getAssetKind(asset);
  if (!kind) return null;
  const boxId = getBoxIdFromAsset(asset);
  const dudeId = getDudeIdFromAsset(asset);
  const image =
    asset?.content?.links?.image ||
    asset?.content?.metadata?.image ||
    asset?.content?.files?.[0]?.uri ||
    asset?.content?.files?.[0]?.cdn_uri;
  return {
    id: asset.id,
    name: asset.content?.metadata?.name || asset.id,
    kind,
    boxId,
    dudeId,
    image,
    attributes: asset.content?.metadata?.attributes || [],
    status: asset.compression?.compressed ? 'minted' : undefined,
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

  if (heliusCollection) {
    const grouped = await heliusRpc<any>('searchAssets', { ...baseParams, grouping: ['collection', heliusCollection] });
    const groupedItems = Array.isArray(grouped?.items) ? grouped.items : [];
    if (groupedItems.length) return groupedItems.filter(isMonsAsset);
  }

  const ungrouped = await heliusRpc<any>('searchAssets', baseParams);
  const items = Array.isArray(ungrouped?.items) ? ungrouped.items : [];
  return items.filter(isMonsAsset);
}

export async function fetchInventory(owner: string, token?: string): Promise<InventoryItem[]> {
  // token retained for backwards compatibility; it is no longer used (client fetches directly from Helius).
  const assets = await fetchAssetsOwned(owner);
  return assets.map(transformInventoryItem).filter(Boolean) as InventoryItem[];
}

export async function requestMintTx(
  owner: string,
  quantity: number,
  token?: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; quantity: number }, PreparedTxResponse>('prepareMintTx', {
    owner,
    quantity,
  });
}

export async function requestOpenBoxTx(
  owner: string,
  boxAssetId: string,
  token?: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; boxAssetId: string }, PreparedTxResponse>('prepareOpenBoxTx', {
    owner,
    boxAssetId,
  });
}

export async function saveEncryptedAddress(
  encrypted: string,
  country: string,
  label: string,
  token: string,
  hint: string,
  email?: string,
  countryCode?: string,
): Promise<ProfileAddress> {
  return callFunction<
    { encrypted: string; country: string; countryCode?: string; label: string; hint: string; email?: string },
    ProfileAddress
  >('saveAddress', { encrypted, country, countryCode, label, hint, email });
}

export async function requestDeliveryTx(
  owner: string,
  selection: DeliverySelection,
  token: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string } & DeliverySelection, PreparedTxResponse>('prepareDeliveryTx', {
    owner,
    ...selection,
  });
}

export async function requestClaimTx(
  owner: string,
  code: string,
  token: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; code: string }, PreparedTxResponse>('prepareIrlClaimTx', { owner, code });
}

export async function finalizeClaimTx(
  owner: string,
  code: string,
  signature: string,
  token: string,
): Promise<{ recorded: boolean; signature: string }> {
  return callFunction<{ owner: string; code: string; signature: string }, { recorded: boolean; signature: string }>(
    'finalizeClaimTx',
    { owner, code, signature },
  );
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
): Promise<{ customToken: string; profile: Profile }> {
  return callFunction<{ wallet: string; message: string; signature: number[] }, { customToken: string; profile: Profile }>(
    'solanaAuth',
    { wallet, message, signature: Array.from(signature) },
  );
}

export async function finalizeMintTx(
  owner: string,
  signature: string,
  token?: string,
): Promise<MintStats> {
  return callFunction<{ owner: string; signature: string }, MintStats>('finalizeMintTx', { owner, signature });
}

export async function finalizeDeliveryTx(
  owner: string,
  signature: string,
  orderId: string,
  token: string,
): Promise<{ recorded: boolean; signature: string; orderId: string }> {
  return callFunction<{ owner: string; signature: string; orderId: string }, { recorded: boolean; signature: string; orderId: string }>(
    'finalizeDeliveryTx',
    { owner, signature, orderId },
  );
}
