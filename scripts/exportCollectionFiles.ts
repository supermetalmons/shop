import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { createScriptHeliusRpc } from './shared/solanaRpcEnvironment.ts';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
type DasAsset = Record<string, any>;

type Args = {
  cluster: SolanaCluster;
  outputDir: string;
  collectionAddresses: string[];
};

type CollectionExport = {
  collectionName: string | null;
  collectionAddress: string;
  collectionCoverImageUrl: string | null;
  tokens: Array<{
    address: string;
    fileUrls: string[];
  }>;
};

const DEFAULT_COLLECTION_ADDRESSES = [
  'JDmZF2EsfWHcq9evTLDfqqUhAHh3zTYMy2rTeEfhx9hy',
];

const PAGE_LIMIT = 1000;
const MAX_PAGES = 1000;
const REQUEST_DELAY_MS = 800;
const COLLECTION_DELAY_MS = 2500;
const RETRIES = 5;
const REQUEST_TIMEOUT_MS = 60_000;

let activeCluster: SolanaCluster = 'mainnet-beta';
let lastRequestAt = 0;

function usage() {
  return [
    'Export per-collection token file URLs from Helius DAS.',
    '',
    'Usage:',
    '  npm run export_collection_files',
    '  npm run export_collection_files -- --cluster mainnet-beta --output scripts/collection-files <collection>...',
    '',
    'Requirements:',
    '  - HELIUS_API_KEY in .env',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(rawAddress: string): string {
  try {
    return new PublicKey(rawAddress).toBase58();
  } catch {
    fail(`Invalid Solana address: ${rawAddress}`);
  }
}

function parseArgs(argv: string[]): Args {
  let cluster: SolanaCluster = 'mainnet-beta';
  let outputDir = fileURLToPath(new URL('./collection-files', import.meta.url));
  const collectionAddresses: string[] = [];

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

    if (arg === '--output') {
      const value = String(argv[i + 1] || '').trim();
      if (!value) fail(`Missing value for --output.\n\n${usage()}`);
      outputDir = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) fail(`Unknown arg: ${arg}\n\n${usage()}`);
    collectionAddresses.push(normalizeAddress(arg));
  }

  return {
    cluster,
    outputDir,
    collectionAddresses: collectionAddresses.length
      ? Array.from(new Set(collectionAddresses))
      : DEFAULT_COLLECTION_ADDRESSES.map(normalizeAddress),
  };
}

async function waitForRateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS - elapsed);
  lastRequestAt = Date.now();
}

let requestHelius: ReturnType<typeof createScriptHeliusRpc> | undefined;
async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  requestHelius ??= createScriptHeliusRpc({ cluster: activeCluster }, {
    attempts: RETRIES + 1, timeoutMs: REQUEST_TIMEOUT_MS,
    retryableStatus: status => status === 429 || status >= 500,
    retryDelay: attempt => 1500 * 2 ** attempt,
    beforeAttempt: waitForRateLimit, retryTransportErrors: true, retryReadErrors: true,
  });
  return requestHelius<T>(method, params);
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function looksLikeFileUrl(value: string) {
  return /^(https?:\/\/|ipfs:\/\/|ar:\/\/|data:)/i.test(value.trim());
}

function collectUrlsFrom(value: unknown, urls: string[], seen: Set<string>) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (looksLikeFileUrl(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      urls.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUrlsFrom(item, urls, seen);
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUrlsFrom(item, urls, seen);
  }
}

function tokenFileUrls(asset: DasAsset) {
  const urls: string[] = [];
  const seen = new Set<string>();

  collectUrlsFrom(asset?.content?.files, urls, seen);
  collectUrlsFrom(asset?.content?.links, urls, seen);
  collectUrlsFrom(asset?.content?.json_uri, urls, seen);
  collectUrlsFrom(asset?.content?.jsonUri, urls, seen);
  collectUrlsFrom(asset?.content?.metadata?.image, urls, seen);
  collectUrlsFrom(asset?.content?.metadata?.animation_url, urls, seen);
  collectUrlsFrom(asset?.content?.metadata?.animationUrl, urls, seen);
  collectUrlsFrom(asset?.content?.metadata?.external_url, urls, seen);
  collectUrlsFrom(asset?.content?.metadata?.externalUrl, urls, seen);
  collectUrlsFrom(asset?.content?.metadata?.properties?.files, urls, seen);

  return urls;
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

function collectionName(collectionAsset: DasAsset | null, sampleAsset: DasAsset | undefined) {
  const sampleMeta = collectionGroupingMetadata(sampleAsset);
  return pickString(
    sampleMeta?.name,
    collectionAsset?.content?.metadata?.name,
    collectionAsset?.content?.metadata?.title,
    collectionAsset?.token_info?.name,
  ) || null;
}

function collectionCoverImageUrl(collectionAsset: DasAsset | null, sampleAsset: DasAsset | undefined) {
  const urls: string[] = [];
  const seen = new Set<string>();
  const sampleMeta = collectionGroupingMetadata(sampleAsset);

  collectUrlsFrom(sampleMeta?.image, urls, seen);
  collectUrlsFrom(collectionAsset?.content?.links?.image, urls, seen);
  collectUrlsFrom(collectionAsset?.content?.metadata?.image, urls, seen);
  collectUrlsFrom(collectionAsset?.content?.files, urls, seen);

  return urls[0] || null;
}

async function fetchAssetMaybe(assetId: string): Promise<DasAsset | null> {
  try {
    return await heliusRpc<DasAsset>('getAsset', { id: assetId });
  } catch (err) {
    console.warn(`[helius] failed to fetch collection asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchCollectionAssetsVia(method: 'searchAssets' | 'getAssetsByGroup', collectionAddress: string) {
  const assets: DasAsset[] = [];
  const seenAssetIds = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params =
      method === 'searchAssets'
        ? {
            grouping: ['collection', collectionAddress],
            page,
            limit: PAGE_LIMIT,
            displayOptions: {
              showCollectionMetadata: true,
              showUnverifiedCollections: true,
            },
          }
        : {
            groupKey: 'collection',
            groupValue: collectionAddress,
            page,
            limit: PAGE_LIMIT,
            displayOptions: {
              showCollectionMetadata: true,
              showUnverifiedCollections: true,
            },
          };

    const result = await heliusRpc<any>(method, params);
    const items = Array.isArray(result?.items) ? result.items : [];

    for (const item of items) {
      const id = pickString(item?.id);
      if (!id || seenAssetIds.has(id)) continue;
      seenAssetIds.add(id);
      assets.push(item);
    }

    console.log(`[helius] ${collectionAddress} ${method} page ${page}: ${items.length} tokens`);
    if (items.length < PAGE_LIMIT) return assets;
  }

  fail(`Reached ${MAX_PAGES} pages while fetching collection ${collectionAddress}.`);
}

async function fetchCollectionAssets(collectionAddress: string) {
  const searchAssets = await fetchCollectionAssetsVia('searchAssets', collectionAddress);
  if (searchAssets.length) return searchAssets;

  console.log(`[helius] ${collectionAddress} searchAssets returned 0 tokens; falling back to getAssetsByGroup`);
  return fetchCollectionAssetsVia('getAssetsByGroup', collectionAddress);
}

async function exportCollection(collectionAddress: string, outputDir: string) {
  console.log('');
  console.log(`Collection: ${collectionAddress}`);

  const collectionAsset = await fetchAssetMaybe(collectionAddress);
  const assets = await fetchCollectionAssets(collectionAddress);
  const sampleAsset = assets[0];

  const out: CollectionExport = {
    collectionName: collectionName(collectionAsset, sampleAsset),
    collectionAddress,
    collectionCoverImageUrl: collectionCoverImageUrl(collectionAsset, sampleAsset),
    tokens: assets.map((asset) => ({
      address: pickString(asset?.id) || '',
      fileUrls: tokenFileUrls(asset),
    })).filter((token) => Boolean(token.address)),
  };

  const outputPath = path.join(outputDir, `${collectionAddress}.json`);
  writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`Saved ${outputPath} (${out.tokens.length} tokens)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  activeCluster = args.cluster;
  mkdirSync(args.outputDir, { recursive: true });

  console.log(`Cluster: ${args.cluster}`);
  console.log(`Output:  ${args.outputDir}`);
  console.log(`Collections: ${args.collectionAddresses.length}`);

  for (let i = 0; i < args.collectionAddresses.length; i += 1) {
    await exportCollection(args.collectionAddresses[i], args.outputDir);
    if (i < args.collectionAddresses.length - 1) await sleep(COLLECTION_DELAY_MS);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
