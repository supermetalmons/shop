import { onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, firebaseApp } from './firebase';
import { DeliverySelection, InventoryItem, PreparedTxResponse, Profile, ProfileAddress } from '../types';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  DeliverItemInput,
  buildDeliverTxWithBlockhash,
  fetchBoxMinterConfig,
  normalizeLeafIndex,
  truncateProofByCanopy,
} from './boxMinter';

const region = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1';
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

async function ensureAuthenticated(): Promise<string> {
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

const heliusApiKey = (import.meta.env.VITE_HELIUS_API_KEY || '').trim();
const heliusRpcBase = (import.meta.env.VITE_HELIUS_RPC_URL || '').trim();
const heliusCluster = (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet').toLowerCase();
const heliusSubdomain = heliusCluster === 'mainnet-beta' ? 'mainnet' : heliusCluster;
const heliusCollection = (import.meta.env.VITE_COLLECTION_MINT || '').trim();
const heliusMerkleTree = (import.meta.env.VITE_MERKLE_TREE || '').trim();

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
  throw new Error(`${label} must be a non-negative u64`);
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
  return undefined;
}

function assetMatchesCollection(asset: DasAsset, collectionMint: string): boolean {
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const g of grouped) {
      if (g?.group_key === 'collection' && g?.group_value === collectionMint) return true;
    }
  }
  // Fallback for alternate DAS shapes.
  const contentCollectionKey = asset?.content?.metadata?.collection?.key;
  if (typeof contentCollectionKey === 'string' && contentCollectionKey === collectionMint) return true;
  return false;
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

function isMonsAsset(asset: DasAsset): boolean {
  // Never show burned assets in inventory.
  if (isBurntAsset(asset)) return false;

  const kind = getAssetKind(asset);
  if (!kind) return false;

  // Prefer collection grouping when configured.
  if (heliusCollection && assetMatchesCollection(asset, heliusCollection)) return true;

  // Fall back to the drop's Merkle tree (handles indexing delays or when collection grouping is unavailable).
  const tree: string = (asset as any)?.compression?.tree || (asset as any)?.compression?.treeId || '';
  if (heliusMerkleTree && tree && tree === heliusMerkleTree) return true;

  return false;
}

function transformInventoryItem(asset: DasAsset): InventoryItem | null {
  if (isBurntAsset(asset)) return null;
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

async function heliusRpcWithFallback<T>(method: string, params: any, fallback: () => Promise<T>): Promise<T> {
  try {
    return await heliusRpc<T>(method, params);
  } catch (err) {
    const msg = String((err as any)?.message || '');
    if (/method not found|invalid params/i.test(msg)) {
      return await fallback();
    }
    throw err;
  }
}

async function fetchHeliusAsset(assetId: string): Promise<DasAsset> {
  const cluster = (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet').toLowerCase();
  const apiKey = (import.meta.env.VITE_HELIUS_API_KEY || '').trim();
  const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
  return heliusRpcWithFallback<DasAsset>(
    'getAsset',
    { id: assetId },
    async () => {
      if (!apiKey) throw new Error('Missing VITE_HELIUS_API_KEY');
      const url = `https://api.helius.xyz/v0/assets?ids[]=${assetId}&api-key=${apiKey}${clusterParam}`;
      const res = await fetch(url);
      const json = await res.json().catch(() => ({}));
      const asset = Array.isArray(json) ? json[0] : (json as any)?.[0];
      if (!asset) throw new Error('Asset not found');
      return asset as DasAsset;
    },
  );
}

async function fetchHeliusAssetProof(assetId: string): Promise<any> {
  const cluster = (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet').toLowerCase();
  const apiKey = (import.meta.env.VITE_HELIUS_API_KEY || '').trim();
  const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
  return heliusRpcWithFallback<any>(
    'getAssetProof',
    { id: assetId },
    async () => {
      if (!apiKey) throw new Error('Missing VITE_HELIUS_API_KEY');
      const url = `https://api.helius.xyz/v0/assets/${assetId}/proof?api-key=${apiKey}${clusterParam}`;
      const res = await fetch(url);
      const json = await res.json().catch(() => ({}));
      if (!json || typeof json !== 'object' || !(json as any)?.root || !(json as any)?.proof) {
        throw new Error('Asset proof not available yet');
      }
      return json;
    },
  );
}

function numericIdFromString(value: string | undefined): number {
  const raw = (value || '').trim();
  if (!raw) return NaN;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const match = raw.match(/\d+/);
  return match?.[0] ? Number(match[0]) : NaN;
}

async function fetchAssetWithProofRetry(assetId: string): Promise<{ asset: DasAsset; proof: any }> {
  const startedAt = Date.now();
  const maxWaitMs = 12_000;
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts && Date.now() - startedAt < maxWaitMs; attempt++) {
    try {
      const [asset, proof] = await Promise.all([fetchHeliusAsset(assetId), fetchHeliusAssetProof(assetId)]);
      return { asset, proof };
    } catch (err) {
      lastErr = err;
      // Only retry on transient/indexing failures.
      const msg = String((err as any)?.message || '');
      const retriable =
        /not available yet|not found|rate|timeout|timed out|unavailable|failed/i.test(msg) ||
        /404|429|5\d\d/.test(msg);
      if (!retriable) throw err;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'Asset proof not available yet'));
}

async function buildDeliverItem(
  connection: Connection,
  cfg: Awaited<ReturnType<typeof fetchBoxMinterConfig>>,
  canopyDepth: number,
  maxDepth: number,
  assetId: string,
  ownerWallet: string,
): Promise<DeliverItemInput> {
  const { asset, proof } = await fetchAssetWithProofRetry(assetId);
  const kind = getAssetKind(asset);
  if (!kind) throw new Error('Unsupported asset type');
  if (kind === 'certificate') throw new Error('Certificates are already delivery outputs');
  if (!isMonsAsset(asset)) throw new Error('Item is not part of the Mons collection');

  const assetOwner = asset?.ownership?.owner;
  // Owner check is still enforced by Bubblegum burn; this is just a friendly preflight.
  if (typeof assetOwner === 'string' && assetOwner && assetOwner !== ownerWallet) {
    throw new Error('Item not owned by wallet');
  }

  const boxIdStr = kind === 'box' ? getBoxIdFromAsset(asset) : undefined;
  const dudeId = kind === 'dude' ? getDudeIdFromAsset(asset) : undefined;
  const refId = kind === 'box' ? numericIdFromString(boxIdStr) : kind === 'dude' ? Number(dudeId) : NaN;
  if (!Number.isFinite(refId) || refId <= 0) {
    throw new Error(kind === 'box' ? 'Box id missing from metadata' : 'Dude id missing from metadata');
  }

  const proofNodes = Array.isArray((proof as any)?.proof) ? ((proof as any).proof as any[]).filter((p) => typeof p === 'string') : [];
  const truncated = truncateProofByCanopy(proofNodes as string[], canopyDepth);
  const proofKeys = truncated.map((p) => new PublicKey(p));

  const rootBytes = bs58.decode(String((proof as any).root || ''));
  const dataHashBytes = bs58.decode(String(asset?.compression?.data_hash || ''));
  const creatorHashBytes = bs58.decode(String(asset?.compression?.creator_hash || ''));
  if (rootBytes.length !== 32 || dataHashBytes.length !== 32 || creatorHashBytes.length !== 32) {
    throw new Error('Invalid burn hashes from Helius');
  }

  const nonce = normalizeU64((proof as any)?.leaf?.nonce ?? asset?.compression?.leaf_id ?? 0, 'nonce');
  const maxDepthUsed = maxDepth || proofNodes.length || 0;
  const nodeIndex = Number((proof as any)?.node_index ?? asset?.compression?.leaf_id ?? 0);
  const leafIndex = normalizeLeafIndex({ nodeIndex, maxDepth: maxDepthUsed });

  // Ensure the proof tree matches the on-chain configured tree.
  const proofTreeStr = String((proof as any)?.merkleTree || (proof as any)?.merkle_tree || (proof as any)?.treeId || '');
  const treeStr = String(asset?.compression?.tree || asset?.compression?.treeId || proofTreeStr || '');
  if (treeStr && treeStr !== cfg.merkleTree.toBase58()) {
    throw new Error('Item is from a different Merkle tree than the configured drop');
  }

  return {
    kind,
    refId,
    root: rootBytes,
    dataHash: dataHashBytes,
    creatorHash: creatorHashBytes,
    nonce,
    index: leafIndex >>> 0,
    proof: proofKeys,
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
  // token retained for backwards compatibility; wallet session auth is used under the hood.
  const conn = new Connection(heliusRpcUrl(), { commitment: 'confirmed' });
  const ownerPk = new PublicKey(owner);

  // On-chain program has a conservative cap; size limits often bite earlier anyway.
  const MAX_ITEMS_PER_DELIVERY_TX = 8;
  if ((selection?.itemIds || []).length > MAX_ITEMS_PER_DELIVERY_TX) {
    throw new Error(`Too many items for one delivery transaction (max ${MAX_ITEMS_PER_DELIVERY_TX}). Split into multiple deliveries.`);
  }

  // 1) Create an order on the backend (it decides the random delivery fee + deliveryId).
  const created = await callFunction<
    { owner: string } & DeliverySelection,
    { orderId: string; deliveryId: number; deliveryLamports: number; canopyDepth: number; maxDepth: number }
  >(
    'createDeliveryOrder',
    { owner, ...selection },
  );

  const { orderId, deliveryId, deliveryLamports, canopyDepth, maxDepth } = created;
  if (!orderId) throw new Error('Missing orderId from backend');

  // 2) Build the on-chain deliver tx client-side (fetching proofs via Helius).
  const cfg = await fetchBoxMinterConfig(conn);
  const ownerWallet = ownerPk.toBase58();
  const items = await Promise.all(selection.itemIds.map((id) => buildDeliverItem(conn, cfg, canopyDepth, maxDepth, id, ownerWallet)));

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const unsignedTx = buildDeliverTxWithBlockhash(
    cfg,
    ownerPk,
    { deliveryId, deliveryFeeLamports: deliveryLamports, items },
    blockhash,
  );

  // Solana hard cap: 1232 bytes for the serialized transaction.
  const MAX_RAW_TX_BYTES = 1232;
  const raw = unsignedTx.serialize();
  if (raw.length > MAX_RAW_TX_BYTES) {
    // Best-effort: estimate how many items would fit given the already-fetched proofs.
    let maxFit = 0;
    for (let n = items.length - 1; n >= 1; n -= 1) {
      const candidate = buildDeliverTxWithBlockhash(
        cfg,
        ownerPk,
        { deliveryId, deliveryFeeLamports: deliveryLamports, items: items.slice(0, n) },
        blockhash,
      );
      if (candidate.serialize().length <= MAX_RAW_TX_BYTES) {
        maxFit = n;
        break;
      }
    }
    const proofLen = items?.[0]?.proof?.length ?? 0;
    throw new Error(
      `Delivery transaction too large (${raw.length} bytes > ${MAX_RAW_TX_BYTES}). ` +
        `Try fewer items (this tree proofLen≈${proofLen}, canopy=${canopyDepth}). ` +
        (maxFit ? `Estimated max that fits: ${maxFit}.` : 'Try 1 item.'),
    );
  }

  const unsignedEncoded = Buffer.from(unsignedTx.serialize()).toString('base64');

  // 3) Ask the backend to cosign (this strictly enforces delivery fee/id approval).
  const cosigned = await callFunction<{ owner: string; orderId: string; encodedTx: string }, { encodedTx: string }>('cosignDeliveryTx', {
    owner,
    orderId,
    encodedTx: unsignedEncoded,
  });

  return { encodedTx: cosigned.encodedTx, deliveryLamports, orderId };
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
): Promise<{ profile: Profile }> {
  return callFunction<{ wallet: string; message: string; signature: number[] }, { profile: Profile }>('solanaAuth', {
    wallet,
    message,
    signature: Array.from(signature),
  });
}

export async function getProfile(): Promise<{ profile: Profile }> {
  return callFunction<{}, { profile: Profile }>('getProfile', {});
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
