import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type Args = {
  assetId: string;
  cluster: SolanaCluster;
  rawOwners: boolean;
};

type DasAsset = Record<string, any>;

type CollectionSummary = {
  id: string;
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  slug: string;
  slugSource: string;
};

type CollectionFetchResult = {
  assets: DasAsset[];
  firstAsset?: DasAsset;
  method: 'searchAssets' | 'getAssetsByGroup';
};

function heliusRpcBaseForCluster(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';
}

let activeCluster: SolanaCluster | null = null;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 1000;

function usage() {
  return [
    'Get unique holder addresses for the collection an asset belongs to.',
    '',
    'Usage:',
    '  npm run get_token_holders <assetId> -- --cluster <mainnet-beta|testnet|devnet>',
    '  npm run get_token_holders <assetId> -- --cluster <mainnet-beta|testnet|devnet> --raw-owners',
    '',
    'Example:',
    '  npm run get_token_holders HD7TJ2o4YomVHocngy557SrSsQ5RXNsvJD23WAaNJkwA -- --cluster mainnet-beta',
    '',
    'Requirements:',
    '  - HELIUS_API_KEY or VITE_HELIUS_API_KEY in .env',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  let assetId: string | undefined;
  let cluster: SolanaCluster | undefined;
  let rawOwners = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--cluster') {
      const value = String(argv[i + 1] || '').trim();
      if (value === 'mainnet-beta' || value === 'testnet' || value === 'devnet') {
        cluster = value;
        i += 1;
        continue;
      }
      fail(`Invalid value for --cluster: ${value || '(missing)'}\n\n${usage()}`);
    }

    if (arg === '--raw-owners') {
      rawOwners = true;
      continue;
    }

    if (arg.startsWith('-')) {
      fail(`Unknown arg: ${arg}\n\n${usage()}`);
    }

    if (assetId) {
      fail(`Expected exactly one asset id.\n\n${usage()}`);
    }

    try {
      assetId = new PublicKey(arg).toBase58();
    } catch {
      fail(`Invalid Solana asset id: ${arg}`);
    }
  }

  if (!assetId) fail(usage());
  if (!cluster) fail(`Missing required --cluster.\n\n${usage()}`);
  return { assetId, cluster, rawOwners };
}

function loadLocalEnv() {
  const envPaths = [
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../.env.local', import.meta.url)),
    fileURLToPath(new URL('../functions/.env', import.meta.url)),
    fileURLToPath(new URL('../functions/.env.local', import.meta.url)),
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

function requireActiveCluster(): SolanaCluster {
  if (!activeCluster) fail('Missing active cluster. Pass --cluster <mainnet-beta|testnet|devnet>.');
  return activeCluster;
}

function heliusRpcUrl(): string {
  return `${heliusRpcBaseForCluster(requireActiveCluster())}/?api-key=${heliusApiKey()}`;
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

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeWalletMaybe(wallet: unknown): string | undefined {
  if (typeof wallet !== 'string' || !wallet.trim()) return undefined;
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    return undefined;
  }
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

function extractCollectionId(asset: DasAsset): string | undefined {
  const grouped = asset?.grouping;
  if (Array.isArray(grouped)) {
    for (const group of grouped) {
      if (group?.group_key === 'collection' && typeof group?.group_value === 'string' && group.group_value.trim()) {
        return group.group_value.trim();
      }
    }
  }

  return pickString(asset?.content?.metadata?.collection?.key);
}

function collectionGroupingMetadata(asset: DasAsset | null | undefined): Record<string, unknown> | null {
  const grouped = asset?.grouping;
  if (!Array.isArray(grouped)) return null;
  for (const group of grouped) {
    if (group?.group_key !== 'collection') continue;
    const metadata = group?.collection_metadata || group?.collectionMetadata;
    if (metadata && typeof metadata === 'object') return metadata as Record<string, unknown>;
  }
  return null;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function deriveCollectionSummary(collectionId: string, collectionAsset: DasAsset | null, collectionPageSample?: DasAsset): CollectionSummary {
  const sampleMeta = collectionGroupingMetadata(collectionPageSample);
  const assetMeta = collectionAsset?.content?.metadata || {};

  const name = pickString(sampleMeta?.name, assetMeta?.name, assetMeta?.title);
  const symbol = pickString(sampleMeta?.symbol, assetMeta?.symbol);
  const description = pickString(sampleMeta?.description, assetMeta?.description);
  const image = pickString(sampleMeta?.image, collectionAsset?.content?.links?.image, collectionAsset?.content?.files?.[0]?.uri);

  const explicitSlug = pickString(
    sampleMeta?.slug,
    sampleMeta?.collection_slug,
    sampleMeta?.collectionSlug,
    assetMeta?.slug,
    assetMeta?.collection_slug,
    assetMeta?.collectionSlug,
    collectionAsset?.slug,
  );

  const slugFromExplicit = explicitSlug ? slugify(explicitSlug) : '';
  if (slugFromExplicit) {
    return {
      id: collectionId,
      ...(name ? { name } : {}),
      ...(symbol ? { symbol } : {}),
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      slug: slugFromExplicit,
      slugSource: 'collection metadata slug',
    };
  }

  const slugFromName = name ? slugify(name) : '';
  if (slugFromName) {
    return {
      id: collectionId,
      ...(name ? { name } : {}),
      ...(symbol ? { symbol } : {}),
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      slug: slugFromName,
      slugSource: 'collection name',
    };
  }

  const slugFromSymbol = symbol ? slugify(symbol) : '';
  if (slugFromSymbol) {
    return {
      id: collectionId,
      ...(name ? { name } : {}),
      ...(symbol ? { symbol } : {}),
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      slug: slugFromSymbol,
      slugSource: 'collection symbol',
    };
  }

  return {
    id: collectionId,
    ...(name ? { name } : {}),
    ...(symbol ? { symbol } : {}),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    slug: slugify(collectionId),
    slugSource: 'collection id',
  };
}

async function fetchAsset(assetId: string): Promise<DasAsset> {
  return heliusRpc<DasAsset>('getAsset', { id: assetId });
}

async function fetchAssetMaybe(assetId: string): Promise<DasAsset | null> {
  try {
    return await fetchAsset(assetId);
  } catch (err) {
    console.warn(`Warning: failed to fetch collection asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchCollectionAssetsVia(
  method: 'searchAssets' | 'getAssetsByGroup',
  collectionId: string,
): Promise<CollectionFetchResult> {
  const assets: DasAsset[] = [];
  const seenAssetIds = new Set<string>();
  let firstAsset: DasAsset | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params =
      method === 'searchAssets'
        ? {
            grouping: ['collection', collectionId],
            page,
            limit: PAGE_LIMIT,
            displayOptions: {
              showCollectionMetadata: true,
              showUnverifiedCollections: true,
            },
          }
        : {
            groupKey: 'collection',
            groupValue: collectionId,
            page,
            limit: PAGE_LIMIT,
            displayOptions: {
              showCollectionMetadata: true,
              showUnverifiedCollections: true,
            },
          };

    const result = await heliusRpc<any>(method, params);
    const items = Array.isArray(result?.items) ? result.items : [];

    if (!firstAsset && items.length) firstAsset = items[0];

    for (const item of items) {
      const id = pickString(item?.id);
      if (!id || seenAssetIds.has(id)) continue;
      seenAssetIds.add(id);
      assets.push(item);
    }

    console.log(`[helius] ${method} page ${page}: ${items.length} assets`);

    if (items.length < PAGE_LIMIT) {
      return { assets, ...(firstAsset ? { firstAsset } : {}), method };
    }
  }

  fail(`Reached ${MAX_PAGES} pages while fetching collection ${collectionId}. Refusing to continue without a stop condition.`);
}

async function fetchCollectionAssets(collectionId: string): Promise<CollectionFetchResult> {
  const searchResult = await fetchCollectionAssetsVia('searchAssets', collectionId);
  if (searchResult.assets.length > 0) return searchResult;

  console.log('[helius] searchAssets returned 0 assets; falling back to getAssetsByGroup');
  return fetchCollectionAssetsVia('getAssetsByGroup', collectionId);
}

function collectUniqueOwners(assets: DasAsset[]) {
  const owners = new Set<string>();
  let burntAssets = 0;
  let ownerlessAssets = 0;
  let liveAssets = 0;

  for (const asset of assets) {
    if (looksBurntOrClosedInHelius(asset)) {
      burntAssets += 1;
      continue;
    }

    const owner = normalizeWalletMaybe(asset?.ownership?.owner);
    if (!owner) {
      ownerlessAssets += 1;
      continue;
    }

    liveAssets += 1;
    owners.add(owner);
  }

  return {
    liveAssets,
    burntAssets,
    ownerlessAssets,
    owners: Array.from(owners).sort((a, b) => a.localeCompare(b)),
  };
}

async function classifyOwners(rawOwners: string[]) {
  const connection = new Connection(heliusRpcUrl(), 'confirmed');
  const walletOwners: string[] = [];
  const offCurveOwners: string[] = [];
  const executableOwners: string[] = [];

  for (let i = 0; i < rawOwners.length; i += 100) {
    const batch = rawOwners.slice(i, i + 100);
    const keys = batch.map((owner) => new PublicKey(owner));
    const infos = await connection.getMultipleAccountsInfo(keys, { commitment: 'confirmed' });

    for (let j = 0; j < batch.length; j += 1) {
      const owner = batch[j];
      const key = keys[j];
      const info = infos[j];

      if (!PublicKey.isOnCurve(key.toBytes())) {
        offCurveOwners.push(owner);
        continue;
      }

      if (info?.executable) {
        executableOwners.push(owner);
        continue;
      }

      walletOwners.push(owner);
    }
  }

  return {
    rawOwners,
    walletOwners,
    offCurveOwners,
    executableOwners,
  };
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  activeCluster = args.cluster;

  console.log(`Cluster: ${args.cluster}`);
  console.log(`Asset:   ${args.assetId}`);

  const asset = await fetchAsset(args.assetId);
  const assetName = pickString(asset?.content?.metadata?.name, asset?.content?.metadata?.title);
  const collectionId = extractCollectionId(asset);
  if (!collectionId) {
    fail(`Asset ${args.assetId} is not grouped into a collection according to Helius.`);
  }

  const collectionFetch = await fetchCollectionAssets(collectionId);
  const collectionAsset = await fetchAssetMaybe(collectionId);
  const collection = deriveCollectionSummary(collectionId, collectionAsset, collectionFetch.firstAsset);
  const ownersResult = collectUniqueOwners(collectionFetch.assets);
  const ownerClassification = await classifyOwners(ownersResult.owners);
  const csvOwners = args.rawOwners ? ownerClassification.rawOwners : ownerClassification.walletOwners;

  const discountsDir = fileURLToPath(new URL('./discounts', import.meta.url));
  mkdirSync(discountsDir, { recursive: true });

  const outputPath = path.join(discountsDir, `${collection.slug}.csv`);
  const csv = csvOwners.join('\n');
  writeFileSync(outputPath, csv ? `${csv}\n` : '', 'utf8');

  console.log('');
  console.log('Collection:');
  console.log(`  id:          ${collection.id}`);
  console.log(`  name:        ${collection.name || '-'}`);
  console.log(`  symbol:      ${collection.symbol || '-'}`);
  console.log(`  slug:        ${collection.slug} (${collection.slugSource})`);
  console.log(`  description: ${collection.description || '-'}`);
  console.log(`  image:       ${collection.image || '-'}`);
  console.log(`  source:      ${collectionFetch.method}`);
  console.log('');
  console.log('Summary:');
  console.log(`  token:             ${assetName || '-'} (${args.assetId})`);
  console.log(`  collection assets: ${collectionFetch.assets.length}`);
  console.log(`  live assets:       ${ownersResult.liveAssets}`);
  console.log(`  burnt assets:      ${ownersResult.burntAssets}`);
  console.log(`  ownerless assets:  ${ownersResult.ownerlessAssets}`);
  console.log(`  raw owners:        ${ownerClassification.rawOwners.length}`);
  console.log(`  wallet owners:     ${ownerClassification.walletOwners.length}`);
  console.log(`  off-curve owners:  ${ownerClassification.offCurveOwners.length}`);
  console.log(`  executable owners: ${ownerClassification.executableOwners.length}`);
  console.log(`  csv mode:          ${args.rawOwners ? 'raw owners' : 'wallet owners'}`);
  console.log(`  csv rows:          ${csvOwners.length}`);
  console.log('');
  console.log(`Saved CSV: ${outputPath}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
