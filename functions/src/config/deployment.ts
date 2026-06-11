/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain -- <dropId>`) after
 * an on-chain deployment, so functions can run with minimal env usage.
 *
 * Secrets:
 * - HELIUS_API_KEY (env/runtime config)
 * - COSIGNER_SECRET (Firebase Functions secret / Google Secret Manager)
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'little_swag_hoodies' | 'card_nft_2';
export type MetadataPathFormat = 'legacy' | 'compact';

export type FunctionsDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;

  // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  mintSelection?: MintSelectionConfig;

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;

  // On-chain ids
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

// Backward-compatible type alias.
export type FunctionsDeploymentConfig = FunctionsDropConfig;

export type FunctionsDropsMap = Record<string, FunctionsDropConfig>;

export type MintSelectionOption = {
  key: string;
  label: string;
  startId: number;
  endId: number;
};

export type MintSelectionConfig = {
  kind: 'size';
  options: MintSelectionOption[];
};

export type DropPaths = {
  /** Normalized drop base (no trailing slash). */
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export const DROP_METADATA_IPFS_GATEWAY = 'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/';
const IPFS_PROTOCOL = 'ipfs://';
const RAW_CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const BASE32_LOOKUP: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Array.from(BASE32_ALPHABET).map((char, index) => [char, index] as const)),
);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeMetadataPathFormat(value: unknown, fallback: MetadataPathFormat = 'legacy'): MetadataPathFormat {
  return value === 'compact' || value === 'legacy' ? value : fallback;
}

function decodeBase32Lower(value: string): Uint8Array | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const digit = BASE32_LOOKUP[char];
    if (typeof digit !== 'number') return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function readUvarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return { value, nextOffset: index + 1 };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function isRawCidV1(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('b')) return false;
  const bytes = decodeBase32Lower(normalized.slice(1));
  if (!bytes?.length) return false;

  const version = readUvarint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = readUvarint(bytes, version.nextOffset);
  if (!codec) return false;
  const multihashCode = readUvarint(bytes, codec.nextOffset);
  if (!multihashCode) return false;
  const multihashLength = readUvarint(bytes, multihashCode.nextOffset);
  if (!multihashLength || multihashLength.value < 1) return false;
  return bytes.length === multihashLength.nextOffset + multihashLength.value;
}

function isRawIpfsCid(value: string): boolean {
  return RAW_CID_V0_RE.test(value) || isRawCidV1(value);
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function normalizeIpfsProtocolUrl(value: string): string {
  const trimmed = trimTrailingSlashes(String(value || '').trim());
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().startsWith(IPFS_PROTOCOL)) return trimmed;
  const withoutProtocol = trimmed.slice(IPFS_PROTOCOL.length).replace(/^ipfs\//i, '');
  return `${IPFS_PROTOCOL}${withoutProtocol.replace(/^\/+/, '')}`;
}

export function normalizeDropBase(base: string): string {
  // Accept either `https://...`, `ipfs://...`, or a raw CID like `bafy...`.
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) return '';
  if (isRawIpfsCid(trimmed)) return `${IPFS_PROTOCOL}${trimmed}`;
  return normalizeIpfsProtocolUrl(trimmed);
}

export function canonicalizeDropAssetUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const normalizedIpfs = normalizeIpfsProtocolUrl(trimmed);
  if (normalizedIpfs.toLowerCase().startsWith(IPFS_PROTOCOL)) return normalizedIpfs;
  if (!hasUrlScheme(normalizedIpfs)) return normalizedIpfs;

  try {
    const parsed = new URL(trimmed);
    const hostMatch = parsed.hostname.match(/^([^./]+)\.ipfs\./i);
    if (hostMatch?.[1]) {
      return `${IPFS_PROTOCOL}${hostMatch[1]}${trimTrailingSlashes(parsed.pathname)}${parsed.search}${parsed.hash}`;
    }
    const pathMatch = parsed.pathname.match(/^\/ipfs\/([^/]+)(\/.*)?$/i);
    if (pathMatch?.[1]) {
      return `${IPFS_PROTOCOL}${pathMatch[1]}${trimTrailingSlashes(pathMatch[2] || '')}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Non-URL strings should pass through unchanged.
  }

  return trimmed;
}

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  const path = canonical.slice(IPFS_PROTOCOL.length).replace(/^\/+/, '');
  return `${DROP_METADATA_IPFS_GATEWAY}${path}`;
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  card_nft_2: 'card_nft_2',
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  poncho_drifella: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return DROP_FAMILY_BY_DROP_ID[normalizedDropId] || 'default';
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'card_nft_2' ||
    normalized === 'default'
  ) {
    return normalized as DropFamily;
  }
  return defaultDropFamilyForDropId(dropId || '');
}

const CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE = 'txcd_99999999';

function defaultStripeCheckoutEnabledForDropFamily(dropFamily: DropFamily): boolean {
  return dropFamily === 'card_nft_2';
}

function defaultStripeProductTaxCodeForDropFamily(dropFamily: DropFamily): string | undefined {
  if (dropFamily !== 'card_nft_2') return undefined;
  return CARD_NFT_2_STRIPE_PRODUCT_TAX_CODE;
}

function resolveStripeCheckoutEnabled(value: unknown, dropFamily: DropFamily): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return defaultStripeCheckoutEnabledForDropFamily(dropFamily);
}

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

function normalizeMintSelectionConfig(raw: MintSelectionConfig | undefined): MintSelectionConfig | undefined {
  if (!raw || raw.kind !== 'size' || !Array.isArray(raw.options)) return undefined;
  const options = raw.options.flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || key).trim();
    const startId = Math.floor(Number(entry?.startId));
    const endId = Math.floor(Number(entry?.endId));
    if (!key || !label || !Number.isFinite(startId) || !Number.isFinite(endId) || startId < 1 || endId < startId) {
      return [];
    }
    return [{ key, label, startId, endId }];
  });
  if (options.length !== 3) return undefined;
  return {
    kind: 'size',
    options,
  };
}

export function dropPathsFromBase(dropBase: string, metadataPathFormat: MetadataPathFormat = 'compact'): DropPaths {
  const base = normalizeDropBase(dropBase);
  if (metadataPathFormat === 'legacy') {
    return {
      base,
      collectionJson: `${base}/collection.json`,
      boxesJsonBase: `${base}/json/boxes/`,
      figuresJsonBase: `${base}/json/figures/`,
      receiptsBoxesJsonBase: `${base}/json/receipts/boxes/`,
      receiptsFiguresJsonBase: `${base}/json/receipts/figures/`,
    };
  }
  return {
    base,
    collectionJson: `${base}/collection.json`,
    boxesJsonBase: `${base}/b`,
    figuresJsonBase: `${base}/f`,
    receiptsBoxesJsonBase: `${base}/rb`,
    receiptsFiguresJsonBase: `${base}/rf`,
  };
}

function createFunctionsDrop(
  config: Omit<FunctionsDropConfig, 'dropId' | 'metadataPathFormat'> & {
    dropId: string;
    metadataPathFormat?: MetadataPathFormat;
  },
): FunctionsDropConfig {
  const {
    stripeCheckoutEnabled: rawStripeCheckoutEnabled,
    stripeProductTaxCode: rawStripeProductTaxCode,
    ...baseConfig
  } = config;
  const normalizedDropId = normalizeDropId(config.dropId);
  const normalizedDropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  const metadataPathFormat = normalizeMetadataPathFormat(config.metadataPathFormat);
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = String(config.boxMinterConfigPda || '').trim();
  const stripeCheckoutEnabled = resolveStripeCheckoutEnabled(rawStripeCheckoutEnabled, normalizedDropFamily);
  const stripeCheckoutDisabledOverride =
    rawStripeCheckoutEnabled === false && defaultStripeCheckoutEnabledForDropFamily(normalizedDropFamily);
  if (stripeCheckoutEnabled && baseConfig.solanaCluster === 'mainnet-beta' && config.stripeLiveUnitAmountCents == null) {
    throw new Error(`stripeLiveUnitAmountCents is required for Stripe-enabled mainnet drop ${normalizedDropId}`);
  }
  const stripeProductTaxCode =
    String(rawStripeProductTaxCode || '').trim() ||
    (stripeCheckoutEnabled ? defaultStripeProductTaxCodeForDropFamily(normalizedDropFamily) || '' : '');
  return {
    ...baseConfig,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    metadataPathFormat,
    ...(mintSelection ? { mintSelection } : {}),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    ...(stripeCheckoutEnabled ? { stripeCheckoutEnabled: true } : stripeCheckoutDisabledOverride ? { stripeCheckoutEnabled: false } : {}),
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
    figureNamePrefix: String(config.figureNamePrefix || '').trim() || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
  };
}

function assertSharedProgramDropsUseExplicitConfigPdas<
  T extends { dropId: string; solanaCluster: SolanaCluster; boxMinterProgramId: string; boxMinterConfigPda?: string },
>(drops: Record<string, T>, registryLabel: string): void {
  const counts = new Map<string, number>();
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    if ((counts.get(key) || 0) < 2) return;
    if (String(drop.boxMinterConfigPda || '').trim()) return;
    throw new Error(
      `${registryLabel} drop ${drop.dropId} shares program ${drop.boxMinterProgramId} on ${drop.solanaCluster} and must set boxMinterConfigPda.`,
    );
  });
}

// BEGIN AUTO-GENERATED FUNCTIONS DROP REGISTRY
export const FUNCTIONS_DROPS: FunctionsDropsMap = {
  "card_nft_2_devnet": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "card_nft_2_devnet",
    dropFamily: "card_nft_2",
    collectionName: "Card NFT 2",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/cardnft2/json",
    metadataPathFormat: "compact",


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 3,
    discountMerkleRoot: "a8cdf1ec11dbfacb15e9859d0d1484d95f388d883c012314db51e80e5f8021d3",
    maxSupply: 65,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "cardnft2",

    // On-chain ids
    boxMinterProgramId: "7h4JRc5vELpaahm11AeshFEQHe1jePauRnMFWaPSRNpV",
    boxMinterConfigPda: "H8Mi2Yq2L8caoVKxvq3RJ4e4nASc7kXDW8beBBAsUfJE",
    collectionMint: "9ATDCHKBges6BWiLHLhttmCxvCQQ83f9eiXjSX6iagRe",
    receiptsMerkleTree: "CvzLuS4UKpUhnLxRKk8UyWi8txtBcmP15EsjvJV9MVxU",
    deliveryLookupTable: "79cwCVecvDXHFtT6CszVVSZ43kVv5bqtXEV61HMy1MUf",
  }),
  "little_swag_boxes": createFunctionsDrop({
    solanaCluster: "mainnet-beta",
    dropId: "little_swag_boxes",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",
    metadataPathFormat: "legacy",


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 1,
    discountPriceSol: 0.55,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c",
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "box",
    figureNamePrefix: "figure",
    symbol: "box",

    // On-chain ids
    boxMinterProgramId: "22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep",
    collectionMint: "7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr",
    receiptsMerkleTree: "Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV",
    deliveryLookupTable: "F51Mj4JFGdVKJfdbYc4aT4de8Dbst7BmWr2P2Bwxa8Wz",
  }),
  "little_swag_boxes_devnet": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "little_swag_boxes_devnet",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",
    metadataPathFormat: "legacy",


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 0.1,
    discountPriceSol: 0.055,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c",
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "box",
    figureNamePrefix: "figure",
    symbol: "lsb",

    // On-chain ids
    boxMinterProgramId: "CTrBmaCdgNRE9iHtrfQJnxH2puKxfi2V3gBMTxMLrrUA",
    collectionMint: "4sdm8HbtoiV3JejDkMXxGZtiCumMHyovWyjA3SLWErG6",
    receiptsMerkleTree: "2C64cbdnyASftaTdVFYYudn94g274QZ1wv283ocRQaTT",
    deliveryLookupTable: "8JhdJPGjsgAaBdBH3sQChwtmuwUBeWxnpcCRPT4Hph9A",
  }),
  "little_swag_hoodies": createFunctionsDrop({
    solanaCluster: "mainnet-beta",
    dropId: "little_swag_hoodies",
    dropFamily: "little_swag_hoodies",
    collectionName: "Little Swag Hoodies",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "ipfs://bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy",
    metadataPathFormat: "compact",
    mintSelection: {
      kind: "size",
      options: [
        {
          key: "L",
          label: "L",
          startId: 1,
          endId: 15,
        },
        {
          key: "XL",
          label: "XL",
          startId: 16,
          endId: 30,
        },
        {
          key: "2XL",
          label: "2XL",
          startId: 31,
          endId: 34,
        },
      ],
    },


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 2.49,
    discountPriceSol: 1.99,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 21900,
    stripeProductTaxCode: "txcd_30011000",
    discountMintsPerWallet: 1,
    discountMerkleRoot: "e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871",
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: "hoodie",
    figureNamePrefix: "hoodie",
    symbol: "hoodie",

    // On-chain ids
    boxMinterProgramId: "7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU",
    boxMinterConfigPda: "3WSAzs8qN1kQoFM8eSKXAYkHXxZ3UianQDRVbVazb8Hi",
    collectionMint: "5nguer6MR8uY2SQfcQi7r6uVgw24ZXJh1vghZez9pU3o",
    receiptsMerkleTree: "kjCLigZAjtydLvWYWoXQV7X3cM5widBkDznfZpLtEAE",
    deliveryLookupTable: "2dLo2T2JRZtH1mbSQMMUYjFGx8YrBjEkj668C8fGbou7",
  }),
  "little_swag_hoodies_devnet": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "little_swag_hoodies_devnet",
    dropFamily: "little_swag_hoodies",
    collectionName: "Little Swag Hoodies",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "ipfs://bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy",
    metadataPathFormat: "compact",
    mintSelection: {
      kind: "size",
      options: [
        {
          key: "L",
          label: "L",
          startId: 1,
          endId: 15,
        },
        {
          key: "XL",
          label: "XL",
          startId: 16,
          endId: 30,
        },
        {
          key: "2XL",
          label: "2XL",
          startId: 31,
          endId: 34,
        },
      ],
    },


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 0.069,
    discountPriceSol: 0.042,
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: "txcd_30011000",
    discountMintsPerWallet: 1,
    discountMerkleRoot: "e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871",
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: "hoodie",
    figureNamePrefix: "hoodie",
    symbol: "hoodie",

    // On-chain ids
    boxMinterProgramId: "8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6",
    boxMinterConfigPda: "J78XFzZ4ZZ4ykYVYofEDPD8yPc5TZxDeDrM7dikwNMZn",
    collectionMint: "DTDkHsCGJfBAnXqR5YPbsbzegnPSF5FUh4g3ckH5hV3w",
    receiptsMerkleTree: "3JycJA4eKp611yDqCf2ZTAQwRaV7u57WAaMRWLEDd1ak",
    deliveryLookupTable: "6poyGyRRoTy1dY9qC1vo6iXy9yH7ya4SRaBZQgBxPKB6",
  }),
  "poncho_drifella": createFunctionsDrop({
    solanaCluster: "mainnet-beta",
    dropId: "poncho_drifella",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",
    metadataPathFormat: "legacy",


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.69,
    discountPriceSol: 0.42,
    discountMintsPerWallet: 3,
    discountMerkleRoot: "57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d",
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "poncho",

    // On-chain ids
    boxMinterProgramId: "C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A",
    collectionMint: "JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH",
    receiptsMerkleTree: "5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow",
    deliveryLookupTable: "4j1YHm1iwmYDZegY5CxJUYqBcxtpPy7UBkSUfRfz6W8c",
  }),
  "poncho_drifella_devnet_x10": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "poncho_drifella_devnet_x10",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",
    metadataPathFormat: "legacy",


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 3,
    discountMerkleRoot: "57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d",
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "poncho",

    // On-chain ids
    boxMinterProgramId: "J9ffqCnnV1kg2gZ7Wg4ebVW5KLFH557UDdz9Y6F8fK2W",
    boxMinterConfigPda: "9dqjCiMeTNMgYEQdoLmTwpLZHcYj1u8sN2Lcz4XiTEov",
    collectionMint: "AKJtTjDvZUbNA5RN1HA9hbVq1Vjnmv4dSTNuL2ANxSBb",
    receiptsMerkleTree: "55oYU418GYy59eJFKYnUJFT7HKXF5K9gR1WW1Jzry7KX",
    deliveryLookupTable: "F5tFuFeb2iQ4i42grSNjyokS2T9HxZDwMLjKRSERPgcL",
  }),
};
// END AUTO-GENERATED FUNCTIONS DROP REGISTRY

assertSharedProgramDropsUseExplicitConfigPdas(FUNCTIONS_DROPS, 'Functions deployment config');

export function getFunctionsDrop(dropId: string): FunctionsDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FUNCTIONS_DROPS[normalizedDropId];
}

export function requireFunctionsDrop(dropId: string): FunctionsDropConfig {
  const found = getFunctionsDrop(dropId);
  if (!found) {
    throw new Error(`Unknown functions dropId: ${dropId}`);
  }
  return found;
}

export function listFunctionsDrops(): FunctionsDropConfig[] {
  return Object.keys(FUNCTIONS_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FUNCTIONS_DROPS[dropId]);
}
