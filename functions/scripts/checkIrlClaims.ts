import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import { PublicKey } from '@solana/web3.js';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
} from '../../scripts/shared/firebaseCliFirestoreRest.ts';
import { normalizeDropId, requireFunctionsDrop, type SolanaCluster } from '../src/config/deployment.ts';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  dasAssetMatchesCollection,
  dasAssetMetadataName,
  dasAssetMetadataUri,
  type DasAsset,
} from '../src/shared/dasAsset.ts';
import {
  heliusSearchAssetsHasNextPage,
  heliusSearchAssetsItems,
} from '../src/shared/heliusDas.ts';

type Args = {
  code?: string;
  dropId: string;
  limit?: number;
  json: boolean;
};

type ClaimRecord = {
  code: string;
  dropId?: string;
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

const PROJECT_ID = 'mons-shop';
const IRL_CODE_DIGITS = 10;
const CHECK_IRL_CLAIMS_DAS_NAME_OPTIONS = { metadataNameMode: 'string-only' } as const;
const CHECK_IRL_CLAIMS_DAS_BURN_OPTIONS = {
  missingAssetResult: false,
  nonBooleanFlagIsBurnt: true,
} as const;
const firestoreRestClient = createFirebaseCliFirestoreRestClient({
  projectId: PROJECT_ID,
});

function heliusRpcBaseForCluster(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';
}

function usage() {
  return [
    'Check IRL claim codes against on-chain state.',
    '',
    'Usage:',
    '  npm run check-irl-claims -- --drop-id <dropId>',
    '  npm run check-irl-claims -- --drop-id <dropId> --code 1234567890',
    '  npm run check-irl-claims -- --drop-id <dropId> --limit 25',
    '  npm run check-irl-claims -- --drop-id <dropId> --json',
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
  const args: Omit<Args, 'dropId'> & { dropId?: string } = { json: false };

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

    if (arg === '--drop-id') {
      const value = String(argv[i + 1] || '').trim();
      if (!value) fail('Missing value for --drop-id');
      args.dropId = value;
      i += 1;
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
  if (!args.dropId) {
    fail(`Missing required --drop-id.\n\n${usage()}`);
  }

  return { ...args, dropId: args.dropId };
}

const args = parseArgs(process.argv.slice(2));
const dropConfig = requireFunctionsDrop(args.dropId);
const selectedDropId = dropConfig.dropId;
const cluster = dropConfig.solanaCluster;
const collectionMint = dropConfig.collectionMint;
const HELIUS_RPC_BASE = heliusRpcBaseForCluster(cluster);

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

function claimMatchesSelectedDrop(claim: ClaimRecord): boolean {
  return claim.dropId === selectedDropId;
}

function limitClaims(claims: ClaimRecord[], limit: number | undefined): ClaimRecord[] {
  return typeof limit === 'number' ? claims.slice(0, limit) : claims;
}

function getAssetKind(asset: DasAsset): 'box' | 'dude' | 'certificate' | null {
  return dasAssetKind(asset, CHECK_IRL_CLAIMS_DAS_NAME_OPTIONS);
}

function getBoxIdFromAsset(asset: DasAsset): string | undefined {
  return dasAssetBoxId(asset, CHECK_IRL_CLAIMS_DAS_NAME_OPTIONS);
}

function getDudeIdFromAsset(asset: DasAsset): number | undefined {
  return dasAssetDudeId(asset);
}

function getAssetJsonUri(asset: DasAsset): string | undefined {
  return dasAssetMetadataUri(asset) || undefined;
}

function getAssetName(asset: DasAsset): string | undefined {
  return dasAssetMetadataName(asset);
}

function looksBurntOrClosedInHelius(asset: DasAsset | null | undefined): boolean {
  return dasAssetLooksBurntOrClosed(asset, CHECK_IRL_CLAIMS_DAS_BURN_OPTIONS);
}

function assetMatchesCollection(asset: DasAsset, expectedCollectionMint: string): boolean {
  return dasAssetMatchesCollection(asset, expectedCollectionMint);
}

function isMonsAsset(asset: DasAsset): boolean {
  const kind = getAssetKind(asset);
  if (!kind) return false;
  if (!collectionMint) return false;
  return assetMatchesCollection(asset, collectionMint);
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
        const items = heliusSearchAssetsItems<DasAsset>(result);
        out.push(...items.filter(isMonsAsset));
        // This audit has always paged against its requested size, even when
        // Helius echoes a different response limit.
        const paginationResult = { ...result, limit };
        if (
          !heliusSearchAssetsHasNextPage(
            paginationResult,
            page,
            items,
            limit,
            {
              totalPolicy: 'ignore',
            },
          )
        ) {
          break;
        }
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
  const dropId = typeof data?.dropId === 'string' && data.dropId.trim() ? normalizeDropId(data.dropId) : undefined;
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
    ...(dropId ? { dropId } : {}),
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

async function loadClaimsViaRest(args: Args): Promise<ClaimRecord[]> {
  if (args.code) {
    const json = await firestoreRestClient.request({
      url: firestoreRestClient.documentUrl(`claimCodes/${args.code}`),
    });
    const document = decodeFirestoreRestDocument(json);
    const parsed = document
      ? parseClaimData(document.data, document.id)
      : null;
    return parsed && claimMatchesSelectedDrop(parsed) ? [parsed] : [];
  }

  const claims: ClaimRecord[] = [];
  let pageToken: string | undefined;
  do {
    const url = firestoreRestClient.documentUrl('claimCodes');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await firestoreRestClient.request({
      url,
    });
    const docs = Array.isArray(json?.documents) ? json.documents : [];
    for (const doc of docs) {
      const document = decodeFirestoreRestDocument(doc);
      const parsed = document
        ? parseClaimData(document.data, document.id)
        : null;
      if (parsed && claimMatchesSelectedDrop(parsed)) claims.push(parsed);
    }
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  claims.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return limitClaims(claims, args.limit);
}

async function loadClaims(args: Args): Promise<ClaimRecord[]> {
  if (args.code) {
    try {
      const app = initializeApp({ projectId: PROJECT_ID });
      const db = getFirestore(app);
      const snap = await db.doc(`claimCodes/${args.code}`).get();
      if (!snap.exists) return [];
      const parsed = parseClaimDoc(snap as QueryDocumentSnapshot);
      return parsed && claimMatchesSelectedDrop(parsed) ? [parsed] : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!looksLikeFirestorePermissionError(message)) throw err;
      return loadClaimsViaRest(args);
    }
  }

  try {
    const app = initializeApp({ projectId: PROJECT_ID });
    const db = getFirestore(app);
    const snap = await db.collection('claimCodes').where('dropId', '==', selectedDropId).get();
    const claims = snap.docs.map(parseClaimDoc).filter(Boolean) as ClaimRecord[];
    claims.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return limitClaims(claims, args.limit);
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

function printText(results: ClaimInspection[], dropId: string) {
  const summary = summarize(results);
  console.log(`Drop: ${dropId}`);
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
  const claims = await loadClaims(args);

  if (!claims.length) {
    const message = args.code
      ? `No claim doc found for code ${args.code} in drop ${selectedDropId}.`
      : `No claim docs found for drop ${selectedDropId}.`;
    if (args.json) {
      console.log(JSON.stringify({ dropId: selectedDropId, summary: summarize([]), results: [], message }, null, 2));
    } else {
      console.log(message);
    }
    return;
  }

  const results = await inspectClaims(claims);
  if (args.json) {
    console.log(JSON.stringify({ dropId: selectedDropId, summary: summarize(results), results }, null, 2));
    return;
  }

  printText(results, selectedDropId);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (/Could not load the default credentials|Failed to determine service account|credential implementation provided/i.test(message)) {
    console.error('Firestore admin credentials are not available. Set GOOGLE_APPLICATION_CREDENTIALS or local ADC, then retry.');
  }
  console.error(message);
  process.exit(1);
});
