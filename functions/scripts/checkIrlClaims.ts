import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import { PublicKey } from '@solana/web3.js';
import { FUNCTIONS_DEPLOYMENT } from '../src/config/deployment.ts';

type Args = {
  code?: string;
  limit?: number;
  json: boolean;
};

type ClaimRecord = {
  code: string;
  owner: string;
  boxId: number;
  boxAssetId: string;
  dudeIds: number[];
  deliveryId?: number;
  createdAt?: string;
};

type ClaimStatus = 'claimed' | 'unclaimed' | 'transferred' | 'inconclusive';

type ClaimInspection = ClaimRecord & {
  status: ClaimStatus;
  reason: string;
  matchedDudeIds: number[];
  matchedReceiptAssets: Array<{
    assetId: string;
    dudeId: number;
    owner?: string;
    burnt: boolean;
    jsonUri?: string;
    name?: string;
  }>;
  matchingBoxCertificate?: {
    assetId: string;
    owner?: string;
    burnt: boolean;
    jsonUri?: string;
    name?: string;
  };
};

type DasAsset = Record<string, any>;

const PROJECT_ID = 'mons-shop';
const IRL_CODE_DIGITS = 10;
const FIREBASE_CLI_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const cluster = FUNCTIONS_DEPLOYMENT.solanaCluster;
const collectionMint = FUNCTIONS_DEPLOYMENT.collectionMint;
const metadataBase = FUNCTIONS_DEPLOYMENT.metadataBase;
const HELIUS_RPC_BASE =
  cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';

function usage() {
  return [
    'Check IRL claim codes against on-chain state.',
    '',
    'Usage:',
    '  npm run check-irl-claims',
    '  npm run check-irl-claims -- --code 1234567890',
    '  npm run check-irl-claims -- --limit 25',
    '  npm run check-irl-claims -- --json',
    '',
    'Requirements:',
    '  - HELIUS_API_KEY or VITE_HELIUS_API_KEY in .env',
    '  - Firestore admin credentials available via ADC/GOOGLE_APPLICATION_CREDENTIALS',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--json') {
      args.json = true;
      continue;
    }

    if (arg === '--code') {
      const value = argv[i + 1];
      if (!value) fail('Missing value for --code');
      args.code = normalizeIrlClaimCode(value);
      i += 1;
      continue;
    }

    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1) fail('Invalid value for --limit');
      args.limit = Math.floor(value);
      i += 1;
      continue;
    }

    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (args.code && args.code.length !== IRL_CODE_DIGITS) {
    fail(`Invalid claim code. Expected ${IRL_CODE_DIGITS} digits.`);
  }

  return args;
}

function loadLocalEnv() {
  const envPaths = [
    fileURLToPath(new URL('../../.env', import.meta.url)),
    fileURLToPath(new URL('../../.env.local', import.meta.url)),
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../.env.local', import.meta.url)),
  ];

  const loadEnvFile = (process as any).loadEnvFile as ((path: string) => void) | undefined;

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    try {
      if (typeof loadEnvFile === 'function') {
        loadEnvFile(envPath);
        continue;
      }
    } catch {
      // Fall back to the manual parser below.
    }

    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const eq = withoutExport.indexOf('=');
      if (eq <= 0) continue;
      const key = withoutExport.slice(0, eq).trim();
      let value = withoutExport.slice(eq + 1).trim();
      if (!key || key in process.env) continue;
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      process.env[key] = value;
    }
  }
}

function heliusApiKey(): string {
  const raw = (process.env.HELIUS_API_KEY || process.env.VITE_HELIUS_API_KEY || '').trim();
  if (!raw) fail('Missing HELIUS_API_KEY or VITE_HELIUS_API_KEY');
  return raw;
}

function heliusRpcUrl(): string {
  return `${HELIUS_RPC_BASE}/?api-key=${heliusApiKey()}`;
}

function looksLikeFirestorePermissionError(message: string): boolean {
  return /permission[-_\s]?denied|missing or insufficient permissions/i.test(message);
}

async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(heliusRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.error) {
    const message = (json as any)?.error?.message || res.statusText || `Helius ${method} failed`;
    throw new Error(message);
  }
  return (json as any).result as T;
}

async function heliusJson(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.error) {
    const message = (json as any)?.error?.message || res.statusText || 'Helius request failed';
    throw new Error(message);
  }
  return json;
}

async function fetchAsset(assetId: string): Promise<DasAsset | null> {
  try {
    const asset = await heliusRpc<any>('getAsset', { id: assetId });
    return asset || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/method not found|invalid params/i.test(message)) throw err;

    const clusterParam = cluster === 'mainnet-beta' ? '' : `&cluster=${cluster}`;
    const url = `https://api.helius.xyz/v0/assets?ids[]=${assetId}&api-key=${heliusApiKey()}${clusterParam}`;
    const json = await heliusJson(url);
    return Array.isArray(json) ? json[0] || null : (json as any)?.[0] || null;
  }
}

function normalizeWallet(wallet: string): string {
  return new PublicKey(wallet).toBase58();
}

function normalizeWalletMaybe(wallet: unknown): string | undefined {
  if (typeof wallet !== 'string' || !wallet.trim()) return undefined;
  try {
    return normalizeWallet(wallet);
  } catch {
    return undefined;
  }
}

function normalizeIrlClaimCode(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function getAssetKind(asset: DasAsset): 'box' | 'dude' | 'certificate' | null {
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
    const valueFromUri = Number(match?.[1]);
    return Number.isFinite(valueFromUri) ? valueFromUri : undefined;
  }
  return undefined;
}

function getAssetJsonUri(asset: DasAsset): string | undefined {
  const uri =
    asset?.content?.json_uri ||
    asset?.content?.jsonUri ||
    asset?.content?.metadata?.uri ||
    asset?.content?.metadata?.json_uri ||
    asset?.content?.metadata?.jsonUri;
  return typeof uri === 'string' && uri ? uri : undefined;
}

function getAssetName(asset: DasAsset): string | undefined {
  const name = asset?.content?.metadata?.name || asset?.content?.metadata?.title;
  return typeof name === 'string' && name ? name : undefined;
}

function looksBurntOrClosedInHelius(asset: DasAsset | null | undefined): boolean {
  if (!asset || typeof asset !== 'object') return false;
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
  if (burntFlag != null && burntFlag !== false) return true;

  const ownershipState = String(
    anyAsset?.ownership?.ownership_state || anyAsset?.ownership?.ownershipState || anyAsset?.ownership?.state || '',
  ).toLowerCase();
  if (ownershipState && /burn/.test(ownershipState)) return true;
  return false;
}

function assetMatchesCollection(asset: DasAsset, expectedCollectionMint: string): boolean {
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const group of grouped) {
      if (group?.group_key === 'collection' && group?.group_value === expectedCollectionMint) return true;
    }
  }
  const collectionKey = asset?.content?.metadata?.collection?.key;
  return typeof collectionKey === 'string' && collectionKey === expectedCollectionMint;
}

function isMonsAsset(asset: DasAsset): boolean {
  const kind = getAssetKind(asset);
  if (!kind) return false;
  if (collectionMint && assetMatchesCollection(asset, collectionMint)) return true;

  const uri: string = asset?.content?.json_uri || asset?.content?.jsonUri || '';
  return typeof uri === 'string' && uri.startsWith(metadataBase);
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

  if (collectionMint) {
    const grouped = await heliusRpc<any>('searchAssets', { ...baseParams, grouping: ['collection', collectionMint] });
    const groupedItems = Array.isArray(grouped?.items) ? grouped.items : [];
    if (groupedItems.length) return groupedItems.filter(isMonsAsset);
  }

  const ungrouped = await heliusRpc<any>('searchAssets', baseParams);
  const items = Array.isArray(ungrouped?.items) ? ungrouped.items : [];
  return items.filter(isMonsAsset);
}

let cachedCollectionAssetsPromise: Promise<DasAsset[]> | null = null;

async function fetchCollectionAssets(): Promise<DasAsset[]> {
  if (!cachedCollectionAssetsPromise) {
    cachedCollectionAssetsPromise = (async () => {
      if (!collectionMint) return [];
      const out: DasAsset[] = [];
      const limit = 1000;

      for (let page = 1; page < 20; page += 1) {
        const result = await heliusRpc<any>('searchAssets', {
          grouping: ['collection', collectionMint],
          page,
          limit,
          displayOptions: {
            showCollectionMetadata: true,
            showUnverifiedCollections: true,
          },
        });
        const items = Array.isArray(result?.items) ? result.items : [];
        out.push(...items.filter(isMonsAsset));
        if (items.length < limit) break;
      }

      return out;
    })().catch((err) => {
      cachedCollectionAssetsPromise = null;
      throw err;
    });
  }

  return cachedCollectionAssetsPromise;
}

function timestampToIso(value: unknown): string | undefined {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value && typeof (value as any).toDate === 'function') return (value as any).toDate().toISOString();
  return undefined;
}

function parseClaimData(data: any, docId: string): ClaimRecord | null {
  const code = normalizeIrlClaimCode(typeof data?.code === 'string' ? data.code : docId);
  const owner = normalizeWalletMaybe(data?.owner);
  const boxId = Math.floor(Number(data?.boxId));
  const boxAssetId = typeof data?.boxAssetId === 'string' ? data.boxAssetId.trim() : '';
  const dudeIds = Array.isArray(data?.dudeIds)
    ? data.dudeIds.map((value: unknown) => Math.floor(Number(value))).filter((value: number) => Number.isFinite(value) && value > 0)
    : [];
  const deliveryId = Number.isFinite(Number(data?.deliveryId)) ? Math.floor(Number(data.deliveryId)) : undefined;
  const createdAt = timestampToIso(data?.createdAt);

  if (!code || code.length !== IRL_CODE_DIGITS || !owner || !Number.isFinite(boxId) || boxId <= 0 || !boxAssetId || !dudeIds.length) {
    return null;
  }

  return {
    code,
    owner,
    boxId,
    boxAssetId,
    dudeIds,
    ...(deliveryId != null ? { deliveryId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function parseClaimDoc(doc: QueryDocumentSnapshot): ClaimRecord | null {
  return parseClaimData(doc.data() as any, doc.id);
}

function decodeFirestoreValue(value: any): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return String(value.stringValue);
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return String(value.timestampValue);
  if ('arrayValue' in value) {
    const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
    return values.map((entry: any) => decodeFirestoreValue(entry));
  }
  if ('mapValue' in value) {
    const fields = value.mapValue?.fields || {};
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(fields)) {
      out[key] = decodeFirestoreValue(inner);
    }
    return out;
  }
  if ('nullValue' in value) return null;
  return undefined;
}

function decodeFirestoreDocument(doc: any): ClaimRecord | null {
  const rawFields = doc?.fields && typeof doc.fields === 'object' ? doc.fields : {};
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    data[key] = decodeFirestoreValue(value);
  }
  const name = typeof doc?.name === 'string' ? doc.name : '';
  const docId = name ? name.split('/').pop() || '' : '';
  return parseClaimData(data, docId);
}

let cachedFirebaseCliAccessTokenPromise: Promise<string> | null = null;

function firebaseCliAuthState(): { refreshToken: string; scope?: string } {
  const result = spawnSync('firebase', ['login:list', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1',
    },
  });

  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || 'firebase login:list failed';
    throw new Error(message);
  }

  const payload = JSON.parse(result.stdout || '{}') as any;
  const refreshToken = payload?.result?.[0]?.tokens?.refresh_token;
  const scope = payload?.result?.[0]?.tokens?.scope;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('No Firebase CLI refresh token available');
  }
  return { refreshToken, ...(typeof scope === 'string' && scope ? { scope } : {}) };
}

async function firebaseCliAccessToken(): Promise<string> {
  if (!cachedFirebaseCliAccessTokenPromise) {
    cachedFirebaseCliAccessTokenPromise = (async () => {
      const authState = firebaseCliAuthState();
      const body = new URLSearchParams({
        refresh_token: authState.refreshToken,
        client_id: FIREBASE_CLI_CLIENT_ID,
        client_secret: FIREBASE_CLI_CLIENT_SECRET,
        grant_type: 'refresh_token',
        ...(authState.scope ? { scope: authState.scope } : {}),
      });

      const res = await fetch('https://www.googleapis.com/oauth2/v3/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof (json as any)?.access_token !== 'string') {
        const message = (json as any)?.error_description || (json as any)?.error || res.statusText || 'OAuth token refresh failed';
        throw new Error(message);
      }
      return String((json as any).access_token);
    })().catch((err) => {
      cachedFirebaseCliAccessTokenPromise = null;
      throw err;
    });
  }

  return cachedFirebaseCliAccessTokenPromise;
}

async function firestoreRest(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await firebaseCliAccessToken()}`,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.error) {
    const message = (json as any)?.error?.message || res.statusText || 'Firestore REST request failed';
    throw new Error(message);
  }
  return json;
}

async function loadClaimsViaRest(args: Args): Promise<ClaimRecord[]> {
  if (args.code) {
    const json = await firestoreRest(`claimCodes/${encodeURIComponent(args.code)}`);
    const parsed = decodeFirestoreDocument(json);
    return parsed ? [parsed] : [];
  }

  const claims: ClaimRecord[] = [];
  let pageToken: string | undefined;
  do {
    const json = await firestoreRest('claimCodes', {
      pageSize: '1000',
      ...(pageToken ? { pageToken } : {}),
    });
    const docs = Array.isArray(json?.documents) ? json.documents : [];
    for (const doc of docs) {
      const parsed = decodeFirestoreDocument(doc);
      if (parsed) claims.push(parsed);
    }
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  claims.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return typeof args.limit === 'number' ? claims.slice(0, args.limit) : claims;
}

async function loadClaims(args: Args): Promise<ClaimRecord[]> {
  if (args.code) {
    try {
      const app = initializeApp({ projectId: PROJECT_ID });
      const db = getFirestore(app);
      const snap = await db.doc(`claimCodes/${args.code}`).get();
      if (!snap.exists) return [];
      const parsed = parseClaimDoc(snap as QueryDocumentSnapshot);
      return parsed ? [parsed] : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!looksLikeFirestorePermissionError(message)) throw err;
      return loadClaimsViaRest(args);
    }
  }

  try {
    const app = initializeApp({ projectId: PROJECT_ID });
    const db = getFirestore(app);
    const snap = await db.collection('claimCodes').get();
    const claims = snap.docs.map(parseClaimDoc).filter(Boolean) as ClaimRecord[];
    claims.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return typeof args.limit === 'number' ? claims.slice(0, args.limit) : claims;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!looksLikeFirestorePermissionError(message)) throw err;
    return loadClaimsViaRest(args);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const out = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      out[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

function sortNumbers(values: Iterable<number>): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

async function inspectClaims(claims: ClaimRecord[]): Promise<ClaimInspection[]> {
  const collectionAssets = await fetchCollectionAssets();
  const collectionCertificates = collectionAssets.filter((asset) => getAssetKind(asset) === 'certificate');
  const receiptsByDudeId = new Map<number, DasAsset[]>();
  const boxCertificatesByBoxId = new Map<number, DasAsset[]>();

  for (const asset of collectionCertificates) {
    const dudeId = getDudeIdFromAsset(asset);
    if (dudeId != null) {
      const existing = receiptsByDudeId.get(dudeId) || [];
      existing.push(asset);
      receiptsByDudeId.set(dudeId, existing);
    }

    const boxId = Number(getBoxIdFromAsset(asset));
    if (Number.isFinite(boxId) && boxId > 0) {
      const existing = boxCertificatesByBoxId.get(boxId) || [];
      existing.push(asset);
      boxCertificatesByBoxId.set(boxId, existing);
    }
  }

  return mapLimit(claims, 8, async (claim) => {
    const matchedReceiptAssets = claim.dudeIds
      .flatMap((dudeId) =>
        (receiptsByDudeId.get(dudeId) || []).map((asset) => ({
          assetId: String(asset?.id || ''),
          dudeId,
          owner: normalizeWalletMaybe(asset?.ownership?.owner),
          burnt: looksBurntOrClosedInHelius(asset),
          jsonUri: getAssetJsonUri(asset),
          name: getAssetName(asset),
        })),
      )
      .filter((entry) => entry.assetId);
    const matchedDudeIds = sortNumbers(matchedReceiptAssets.map((entry) => entry.dudeId));
    const boxCertificate = (boxCertificatesByBoxId.get(claim.boxId) || [])[0] || null;
    const matchingBoxCertificate =
      boxCertificate && String(boxCertificate?.id || '')
        ? {
            assetId: String(boxCertificate?.id || ''),
            owner: normalizeWalletMaybe(boxCertificate?.ownership?.owner),
            burnt: looksBurntOrClosedInHelius(boxCertificate),
            jsonUri: getAssetJsonUri(boxCertificate),
            name: getAssetName(boxCertificate),
          }
        : undefined;

    let status: ClaimStatus;
    let reason: string;

    if (matchedDudeIds.length > 0) {
      status = 'claimed';
      const owners = Array.from(new Set(matchedReceiptAssets.map((entry) => entry.owner).filter(Boolean)));
      reason =
        owners.length > 0
          ? `Found expected dude receipt asset(s) for ids ${matchedDudeIds.join(', ')} owned by ${owners.join(', ')}`
          : `Found expected dude receipt asset(s) for ids ${matchedDudeIds.join(', ')}`;
    } else if (matchingBoxCertificate?.owner && matchingBoxCertificate.owner !== claim.owner) {
      status = 'transferred';
      reason = `Matching box receipt certificate is live and currently owned by ${matchingBoxCertificate.owner}`;
    } else if (matchingBoxCertificate?.owner === claim.owner) {
      status = 'unclaimed';
      reason = 'Matching box receipt certificate is still live in the original owner wallet';
    } else if (!boxCertificate) {
      status = 'inconclusive';
      reason = 'No matching dude receipts and no live box receipt certificate were found in the collection index';
    } else {
      status = 'inconclusive';
      reason = 'Current on-chain state does not prove either claimed or unclaimed';
    }

    return {
      ...claim,
      status,
      reason,
      matchedDudeIds,
      matchedReceiptAssets,
      ...(matchingBoxCertificate ? { matchingBoxCertificate } : {}),
    };
  });
}

function summarize(results: ClaimInspection[]) {
  return {
    total: results.length,
    claimed: results.filter((result) => result.status === 'claimed').length,
    unclaimed: results.filter((result) => result.status === 'unclaimed').length,
    transferred: results.filter((result) => result.status === 'transferred').length,
    inconclusive: results.filter((result) => result.status === 'inconclusive').length,
  };
}

function printText(results: ClaimInspection[]) {
  const summary = summarize(results);
  console.log(`Checked ${summary.total} claim code(s).`);
  console.log(
    `claimed ${summary.claimed} | unclaimed ${summary.unclaimed} | transferred ${summary.transferred} | inconclusive ${summary.inconclusive}`,
  );
  console.log('');

  for (const result of results) {
    console.log(`Code: ${result.code}`);
    console.log(`Status: ${result.status}`);
    console.log(`Claim owner: ${result.owner}`);
    console.log(`Box id: ${result.boxId}`);
    console.log(`Delivery id: ${result.deliveryId ?? '-'}`);
    console.log(`Expected dude ids: ${result.dudeIds.join(', ')}`);
    console.log(`Reason: ${result.reason}`);
    console.log('On-chain evidence:');

    if (result.matchingBoxCertificate) {
      console.log(`  Box receipt asset: ${result.matchingBoxCertificate.assetId}`);
      console.log(`  Box receipt owner: ${result.matchingBoxCertificate.owner || '-'}`);
      console.log(`  Box receipt burnt: ${String(result.matchingBoxCertificate.burnt)}`);
      console.log(`  Box receipt name: ${result.matchingBoxCertificate.name || '-'}`);
      console.log(`  Box receipt uri: ${result.matchingBoxCertificate.jsonUri || '-'}`);
    } else {
      console.log('  Box receipt asset: none found');
    }

    if (result.matchedReceiptAssets.length) {
      console.log('  Dude receipt assets:');
      for (const entry of result.matchedReceiptAssets) {
        console.log(
          `    dude ${entry.dudeId}: ${entry.assetId} owner=${entry.owner || '-'} burnt=${String(entry.burnt)} name=${entry.name || '-'} uri=${entry.jsonUri || '-'}`,
        );
      }
    } else {
      console.log('  Dude receipt assets: none found');
    }

    console.log('');
  }
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const claims = await loadClaims(args);

  if (!claims.length) {
    const message = args.code ? `No claim doc found for code ${args.code}.` : 'No claim docs found.';
    if (args.json) {
      console.log(JSON.stringify({ summary: summarize([]), results: [], message }, null, 2));
    } else {
      console.log(message);
    }
    return;
  }

  const results = await inspectClaims(claims);
  if (args.json) {
    console.log(JSON.stringify({ summary: summarize(results), results }, null, 2));
    return;
  }

  printText(results);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (/Could not load the default credentials|Failed to determine service account|credential implementation provided/i.test(message)) {
    console.error('Firestore admin credentials are not available. Set GOOGLE_APPLICATION_CREDENTIALS or local ADC, then retry.');
  }
  console.error(message);
  process.exit(1);
});
