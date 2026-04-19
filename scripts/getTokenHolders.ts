import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type Args = {
  targetId: string;
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

type HolderType = 'wallet' | 'off_curve' | 'executable';

type OwnerClassification = {
  rawOwners: string[];
  walletOwners: string[];
  offCurveOwners: string[];
  executableOwners: string[];
  ownerKinds: Map<string, HolderType>;
};

type FungibleMintInfo = {
  mint: string;
  programId: string;
  decimals: number;
  supplyRaw: bigint;
};

type FungibleTokenSummary = {
  id: string;
  name?: string;
  symbol?: string;
  slug: string;
  slugSource: string;
  programId: string;
  decimals: number;
  supplyRaw: bigint;
  supply: string;
};

type FungibleHolder = {
  owner: string;
  rawAmount: bigint;
  amount: string;
  holderType: HolderType;
};

type FungibleHolderFetchResult = {
  tokenAccounts: number;
  nonZeroTokenAccounts: number;
  totalHeldRaw: bigint;
  holders: FungibleHolder[];
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
const MINT_SUPPLY_OFFSET = 36;
const MINT_DECIMALS_OFFSET = 44;
const MINT_MIN_SIZE = MINT_DECIMALS_OFFSET + 1;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_MIN_SIZE = TOKEN_ACCOUNT_AMOUNT_OFFSET + 8;

function usage() {
  return [
    'Get holder addresses for an NFT collection asset or an SPL token mint.',
    '',
    'Usage:',
    '  npm run get_token_holders <assetOrMintId> -- --cluster <mainnet-beta|testnet|devnet>',
    '  npm run get_token_holders <assetOrMintId> -- --cluster <mainnet-beta|testnet|devnet> --raw-owners',
    '',
    'Examples:',
    '  npm run get_token_holders HD7TJ2o4YomVHocngy557SrSsQ5RXNsvJD23WAaNJkwA -- --cluster mainnet-beta',
    '  npm run get_token_holders FaxYQ3LVXP51rDP2yWGLWVrFAAHeSdFF8SGZxwj2dvor -- --cluster mainnet-beta',
    '',
    'Notes:',
    '  - NFT collection CSV output remains a plain address list.',
    '  - Fungible token CSV output is sorted descending and uses rows of `address,amount`.',
    '  - `--raw-owners` includes off-curve and executable owners in the CSV.',
    '',
    'Requirements:',
    '  - HELIUS_API_KEY or VITE_HELIUS_API_KEY in .env',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  let targetId: string | undefined;
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

    if (targetId) {
      fail(`Expected exactly one asset or mint id.\n\n${usage()}`);
    }

    try {
      targetId = new PublicKey(arg).toBase58();
    } catch {
      fail(`Invalid Solana asset or mint id: ${arg}`);
    }
  }

  if (!targetId) fail(usage());
  if (!cluster) fail(`Missing required --cluster.\n\n${usage()}`);
  return { targetId, cluster, rawOwners };
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

function createConnection() {
  return new Connection(heliusRpcUrl(), 'confirmed');
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

function pickSlugCandidate(candidates: Array<{ value?: string; source: string }>) {
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const slug = slugify(candidate.value);
    if (slug) {
      return { slug, source: candidate.source };
    }
  }
  return null;
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

function deriveFungibleTokenSummary(mintInfo: FungibleMintInfo, asset: DasAsset | null): FungibleTokenSummary {
  const name = pickString(asset?.content?.metadata?.name, asset?.content?.metadata?.title, asset?.token_info?.name);
  const symbol = pickString(asset?.content?.metadata?.symbol, asset?.token_info?.symbol);
  const slugCandidate = pickSlugCandidate([
    { value: symbol, source: 'token symbol' },
    { value: name, source: 'token name' },
    {
      value: pickString(
        asset?.slug,
        asset?.content?.metadata?.slug,
        asset?.content?.metadata?.collection_slug,
        asset?.content?.metadata?.collectionSlug,
      ),
      source: 'token metadata slug',
    },
  ]);

  return {
    id: mintInfo.mint,
    ...(name ? { name } : {}),
    ...(symbol ? { symbol } : {}),
    slug: slugCandidate?.slug || slugify(mintInfo.mint),
    slugSource: slugCandidate?.source || 'mint id',
    programId: mintInfo.programId,
    decimals: mintInfo.decimals,
    supplyRaw: mintInfo.supplyRaw,
    supply: formatTokenAmount(mintInfo.supplyRaw, mintInfo.decimals),
  };
}

function looksLikeFungibleHeliusAsset(asset: DasAsset | null): boolean {
  if (!asset || typeof asset !== 'object') return false;

  const interfaceValue = pickString(asset?.interface)?.toLowerCase();
  if (interfaceValue?.includes('fungible')) return true;

  const tokenStandard = pickString(
    asset?.token_info?.token_standard,
    asset?.token_info?.tokenStandard,
    asset?.content?.metadata?.token_standard,
    asset?.content?.metadata?.tokenStandard,
  )?.toLowerCase();
  if (tokenStandard?.includes('fungible')) return true;

  return typeof asset?.token_info?.decimals === 'number' && asset.token_info.decimals > 0;
}

function formatTokenAmount(rawAmount: bigint, decimals: number): string {
  if (decimals <= 0) return rawAmount.toString();

  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;
  const fraction = rawAmount % divisor;
  if (fraction === 0n) return whole.toString();

  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/g, '');
  return `${whole}.${fractionText}`;
}

function ensureDiscountsDir() {
  const discountsDir = fileURLToPath(new URL('./discounts', import.meta.url));
  mkdirSync(discountsDir, { recursive: true });
  return discountsDir;
}

async function fetchAsset(assetId: string): Promise<DasAsset> {
  return heliusRpc<DasAsset>('getAsset', { id: assetId });
}

async function fetchAssetMaybe(assetId: string, warnOnFailure = true): Promise<DasAsset | null> {
  try {
    return await fetchAsset(assetId);
  } catch (err) {
    if (warnOnFailure) {
      console.warn(`Warning: failed to fetch asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

async function classifyOwners(connection: Connection, rawOwners: string[]): Promise<OwnerClassification> {
  const ownerKinds = new Map<string, HolderType>();
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

      if (info?.executable) {
        executableOwners.push(owner);
        ownerKinds.set(owner, 'executable');
        continue;
      }

      if (!PublicKey.isOnCurve(key.toBytes())) {
        offCurveOwners.push(owner);
        ownerKinds.set(owner, 'off_curve');
        continue;
      }

      walletOwners.push(owner);
      ownerKinds.set(owner, 'wallet');
    }
  }

  return {
    rawOwners,
    walletOwners,
    offCurveOwners,
    executableOwners,
    ownerKinds,
  };
}

async function fetchMintInfoMaybe(connection: Connection, mintId: string): Promise<FungibleMintInfo | null> {
  const accountInfo = await connection.getAccountInfo(new PublicKey(mintId), { commitment: 'confirmed' });
  if (!accountInfo) return null;

  const isTokenProgram =
    accountInfo.owner.equals(TOKEN_PROGRAM_ID) || accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!isTokenProgram || accountInfo.data.length < MINT_MIN_SIZE) return null;

  return {
    mint: mintId,
    programId: accountInfo.owner.toBase58(),
    decimals: accountInfo.data.readUInt8(MINT_DECIMALS_OFFSET),
    supplyRaw: accountInfo.data.readBigUInt64LE(MINT_SUPPLY_OFFSET),
  };
}

async function fetchFungibleHolderBalances(connection: Connection, mintInfo: FungibleMintInfo): Promise<FungibleHolderFetchResult> {
  const balancesByOwner = new Map<string, bigint>();
  let tokenAccounts = 0;
  let nonZeroTokenAccounts = 0;
  let totalHeldRaw = 0n;
  let page = 1;
  let cursor: string | undefined;

  while (true) {
    const result = await heliusRpc<any>('getTokenAccounts', {
      mint: mintInfo.mint,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    const pageAccounts = Array.isArray(result?.token_accounts) ? result.token_accounts : [];
    tokenAccounts += pageAccounts.length;

    console.log(`[helius] getTokenAccounts page ${page}: ${pageAccounts.length} accounts`);

    for (let i = 0; i < pageAccounts.length; i += 100) {
      const batch = pageAccounts.slice(i, i + 100);
      const keys = batch
        .map((item) => pickString(item?.address))
        .filter((address): address is string => Boolean(address))
        .map((address) => new PublicKey(address));

      if (!keys.length) continue;
      const infos = await connection.getMultipleAccountsInfo(keys, { commitment: 'confirmed' });

      for (const info of infos) {
        if (!info || info.data.length < TOKEN_ACCOUNT_MIN_SIZE) continue;

        const owner = new PublicKey(
          info.data.subarray(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + 32),
        ).toBase58();
        const rawAmount = info.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
        if (rawAmount === 0n) continue;

        nonZeroTokenAccounts += 1;
        totalHeldRaw += rawAmount;
        balancesByOwner.set(owner, (balancesByOwner.get(owner) || 0n) + rawAmount);
      }
    }

    const nextCursor = pickString(result?.cursor);
    if (!nextCursor) break;

    cursor = nextCursor;
    page += 1;
  }

  const holders = Array.from(balancesByOwner.entries())
    .map(([owner, rawAmount]) => ({
      owner,
      rawAmount,
      amount: formatTokenAmount(rawAmount, mintInfo.decimals),
      holderType: 'wallet' as HolderType,
    }))
    .sort((a, b) => {
      if (a.rawAmount === b.rawAmount) return a.owner.localeCompare(b.owner);
      return a.rawAmount > b.rawAmount ? -1 : 1;
    });

  return {
    tokenAccounts,
    nonZeroTokenAccounts,
    totalHeldRaw,
    holders,
  };
}

function buildFungibleCsv(holders: FungibleHolder[]) {
  return holders.map((holder) => `${holder.owner},${holder.amount}`).join('\n');
}

async function writeCollectionOwnersCsv(args: Args, asset: DasAsset) {
  const connection = createConnection();
  const collectionId = extractCollectionId(asset);
  if (!collectionId) {
    fail(`Asset ${args.targetId} is not grouped into a collection according to Helius.`);
  }

  const assetName = pickString(asset?.content?.metadata?.name, asset?.content?.metadata?.title);
  const collectionFetch = await fetchCollectionAssets(collectionId);
  const collectionAsset = await fetchAssetMaybe(collectionId);
  const collection = deriveCollectionSummary(collectionId, collectionAsset, collectionFetch.firstAsset);
  const ownersResult = collectUniqueOwners(collectionFetch.assets);
  const ownerClassification = await classifyOwners(connection, ownersResult.owners);
  const csvOwners = args.rawOwners ? ownerClassification.rawOwners : ownerClassification.walletOwners;

  const outputPath = path.join(ensureDiscountsDir(), `${collection.slug}.csv`);
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
  console.log(`  target:            ${assetName || '-'} (${args.targetId})`);
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

async function writeFungibleTokenCsv(args: Args, asset: DasAsset | null, mintInfo: FungibleMintInfo) {
  const connection = createConnection();
  const token = deriveFungibleTokenSummary(mintInfo, asset);
  const holderFetch = await fetchFungibleHolderBalances(connection, mintInfo);
  const ownerClassification = await classifyOwners(
    connection,
    holderFetch.holders.map((holder) => holder.owner),
  );

  const holders = holderFetch.holders.map((holder) => ({
    ...holder,
    holderType: ownerClassification.ownerKinds.get(holder.owner) || 'wallet',
  }));

  const csvHolders = args.rawOwners ? holders : holders.filter((holder) => holder.holderType === 'wallet');
  const outputPath = path.join(ensureDiscountsDir(), `${token.slug}.csv`);
  const csv = buildFungibleCsv(csvHolders);
  writeFileSync(outputPath, csv ? `${csv}\n` : '', 'utf8');

  console.log('');
  console.log('Token:');
  console.log(`  id:          ${token.id}`);
  console.log(`  name:        ${token.name || '-'}`);
  console.log(`  symbol:      ${token.symbol || '-'}`);
  console.log(`  slug:        ${token.slug} (${token.slugSource})`);
  console.log(`  program:     ${token.programId}`);
  console.log(`  decimals:    ${token.decimals}`);
  console.log(`  supply:      ${token.supply}`);
  console.log('');
  console.log('Summary:');
  console.log(`  target:              ${args.targetId}`);
  console.log(`  token accounts:      ${holderFetch.tokenAccounts}`);
  console.log(`  non-zero accounts:   ${holderFetch.nonZeroTokenAccounts}`);
  console.log(`  total held:          ${formatTokenAmount(holderFetch.totalHeldRaw, token.decimals)}`);
  console.log(`  raw holders:         ${ownerClassification.rawOwners.length}`);
  console.log(`  wallet holders:      ${ownerClassification.walletOwners.length}`);
  console.log(`  off-curve owners:    ${ownerClassification.offCurveOwners.length}`);
  console.log(`  executable owners:   ${ownerClassification.executableOwners.length}`);
  console.log(`  csv mode:            ${args.rawOwners ? 'raw owners' : 'wallet owners'}`);
  console.log(`  csv rows:            ${csvHolders.length}`);
  console.log(`  csv sort:            amount desc`);
  console.log('');
  console.log(`Saved CSV: ${outputPath}`);
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  activeCluster = args.cluster;

  console.log(`Cluster: ${args.cluster}`);
  console.log(`Target:  ${args.targetId}`);

  const asset = await fetchAssetMaybe(args.targetId, false);
  if (asset) {
    if (extractCollectionId(asset)) {
      await writeCollectionOwnersCsv(args, asset);
      return;
    }

    if (looksLikeFungibleHeliusAsset(asset)) {
      const connection = createConnection();
      const mintInfo = await fetchMintInfoMaybe(connection, args.targetId);
      if (!mintInfo) {
        fail(`Token ${args.targetId} resolved via DAS metadata but is not a readable SPL mint account on ${args.cluster}.`);
      }
      await writeFungibleTokenCsv(args, asset, mintInfo);
      return;
    }
  }

  const connection = createConnection();
  const mintInfo = await fetchMintInfoMaybe(connection, args.targetId);
  if (!mintInfo) {
    fail(`Target ${args.targetId} is neither a collection NFT asset nor an SPL token mint on ${args.cluster}.`);
  }

  if (mintInfo.decimals === 0 && mintInfo.supplyRaw === 1n && asset) {
    fail(`Asset ${args.targetId} is not grouped into a collection according to Helius.`);
  }

  await writeFungibleTokenCsv(args, asset, mintInfo);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
