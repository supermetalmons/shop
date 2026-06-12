/**
 * Frontend deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain -- <dropId>`) after
 * an on-chain deployment.
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - `VITE_HELIUS_API_KEY` and `VITE_FIREBASE_API_KEY` may be provided via env to
 *   override the bundled frontend defaults in `src/lib/helius.ts` and `src/lib/firebase.ts`.
 */

import { CARD_NFT_2_BOX_MEDIA } from './dropMediaDefaults.ts';

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'little_swag_hoodies' | 'card_nft_2';
export type MetadataPathFormat = 'legacy' | 'compact';

export type MediaMapStrategy = 'direct' | 'cyclic';

export type MediaMapConfig = {
  strategy?: MediaMapStrategy;
  count?: number;
  overrides?: Record<number, number>;
};

export type FigureMediaConfig = MediaMapConfig;
export type BoxMediaConfig = MediaMapConfig;

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

export type FrontendDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;

  // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfig;
  boxMedia?: BoxMediaConfig;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfig;

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
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

  // Canonical derived drop paths (avoid duplicating URL strings).
  paths: DropPaths;
};

// Backward-compatible type alias.
export type FrontendDeploymentConfig = FrontendDropConfig;

export type FrontendDropsMap = Record<string, FrontendDropConfig>;

export type SecondaryMarketplaceKey = 'magiceden' | 'tensor';

export type SecondaryMarketplaceLink = {
  key: SecondaryMarketplaceKey;
  label: string;
  href: string;
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

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

const MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  little_swag_boxes: 'https://magiceden.io/marketplace/little_swag_boxes',
  poncho_drifella: 'https://magiceden.io/marketplace/poncho_drifella',
};

const TENSOR_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  card_nft_2: 'https://www.tensor.trade/trade/card_nft_2',
  little_swag_boxes: 'https://www.tensor.trade/trade/little_swag_boxes',
  poncho_drifella: 'https://www.tensor.trade/trade/poncho_drifella',
};

const FORCE_SOLD_OUT_DROP_OVERRIDES: Record<string, true> = {
  card_nft_2: true,
  poncho_drifella: true,
};

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

function defaultSecondaryMarketHref(dropId: string): string | undefined {
  return secondaryMarketplaceLinksForDropId(dropId).find((link) => link.key === 'tensor')?.href;
}

export function secondaryMarketplaceLinksForDropId(dropId: string): SecondaryMarketplaceLink[] {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) return [];
  return [
    {
      key: 'magiceden',
      label: 'Magic Eden',
      href: MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES[normalizedDropId] || `https://magiceden.io/marketplace/${normalizedDropId}`,
    },
    {
      key: 'tensor',
      label: 'Tensor',
      href: TENSOR_MARKETPLACE_HREF_OVERRIDES[normalizedDropId] || `https://www.tensor.trade/trade/${normalizedDropId}`,
    },
  ];
}

function defaultForceSoldOutForDropId(dropId: string): boolean {
  const normalizedDropId = normalizeDropId(dropId);
  return FORCE_SOLD_OUT_DROP_OVERRIDES[normalizedDropId] === true;
}

function normalizeMediaMapConfig(raw: MediaMapConfig | undefined): MediaMapConfig | undefined {
  if (!raw) return undefined;
  const strategy = raw.strategy === 'cyclic' ? 'cyclic' : raw.strategy === 'direct' ? 'direct' : undefined;
  const countRaw = Number(raw.count);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : undefined;
  const overrideEntries = Object.entries(raw.overrides || {}).flatMap(([tokenIdRaw, mediaIdRaw]) => {
    const tokenId = Math.floor(Number(tokenIdRaw));
    const mediaId = Math.floor(Number(mediaIdRaw));
    if (!Number.isFinite(tokenId) || tokenId <= 0) return [];
    if (!Number.isFinite(mediaId) || mediaId <= 0) return [];
    return [[tokenId, mediaId] as const];
  });
  const overrides = overrideEntries.length ? Object.fromEntries(overrideEntries) : undefined;
  if (!strategy && !count && !overrides) return undefined;
  return {
    ...(strategy ? { strategy } : {}),
    ...(count ? { count } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

function normalizeFigureMediaConfig(raw: FigureMediaConfig | undefined): FigureMediaConfig | undefined {
  return normalizeMediaMapConfig(raw);
}

function normalizeBoxMediaConfig(raw: BoxMediaConfig | undefined): BoxMediaConfig | undefined {
  return normalizeMediaMapConfig(raw);
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

const LITTLE_SWAG_BOXES_FIGURE_MEDIA: FigureMediaConfig = {
  strategy: 'cyclic',
  count: 333,
  overrides: {
    344: 1,
    353: 90,
    360: 3,
    505: 163,
    650: 285,
    660: 13,
    661: 206,
    662: 82,
    663: 175,
    664: 19,
    665: 92,
    666: 86,
    677: 1,
    686: 90,
    693: 3,
    838: 163,
    983: 285,
    993: 49,
    994: 206,
    995: 21,
    996: 175,
    997: 19,
    998: 92,
    999: 86,
  },
};

function defaultFigureMediaConfigForDropFamily(dropFamily: DropFamily): FigureMediaConfig | undefined {
  if (dropFamily !== 'little_swag_boxes') return undefined;
  return normalizeFigureMediaConfig(LITTLE_SWAG_BOXES_FIGURE_MEDIA);
}

function defaultBoxMediaConfigForDropFamily(dropFamily: DropFamily): BoxMediaConfig | undefined {
  if (dropFamily !== 'card_nft_2') return undefined;
  return normalizeBoxMediaConfig(CARD_NFT_2_BOX_MEDIA);
}

function defaultStripeCheckoutEnabledForDropFamily(dropFamily: DropFamily): boolean {
  return dropFamily === 'card_nft_2';
}

function resolveStripeCheckoutEnabled(value: unknown, dropFamily: DropFamily): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return defaultStripeCheckoutEnabledForDropFamily(dropFamily);
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

function createFrontendDrop(
  config: Omit<FrontendDropConfig, 'dropId' | 'paths' | 'metadataPathFormat'> & {
    dropId: string;
    metadataPathFormat?: MetadataPathFormat;
  },
): FrontendDropConfig {
  const { stripeCheckoutEnabled: rawStripeCheckoutEnabled, ...baseConfig } = config;
  const normalizedDropId = normalizeDropId(config.dropId);
  const normalizedDropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  const metadataPathFormat = normalizeMetadataPathFormat(config.metadataPathFormat);
  const figureMedia = normalizeFigureMediaConfig(config.figureMedia) || defaultFigureMediaConfigForDropFamily(normalizedDropFamily);
  const boxMedia = normalizeBoxMediaConfig(config.boxMedia) || defaultBoxMediaConfigForDropFamily(normalizedDropFamily);
  const forceSoldOut = config.forceSoldOut === true || defaultForceSoldOutForDropId(normalizedDropId);
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = normalizeOptionalString(config.boxMinterConfigPda);
  const stripeCheckoutEnabled = resolveStripeCheckoutEnabled(rawStripeCheckoutEnabled, normalizedDropFamily);
  const stripeCheckoutDisabledOverride =
    rawStripeCheckoutEnabled === false && defaultStripeCheckoutEnabledForDropFamily(normalizedDropFamily);
  if (stripeCheckoutEnabled && baseConfig.solanaCluster === 'mainnet-beta' && config.stripeLiveUnitAmountCents == null) {
    throw new Error(`stripeLiveUnitAmountCents is required for Stripe-enabled mainnet drop ${normalizedDropId}`);
  }
  return {
    ...baseConfig,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    metadataPathFormat,
    secondaryMarketHref: normalizeOptionalString(config.secondaryMarketHref) || defaultSecondaryMarketHref(normalizedDropId),
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMedia ? { boxMedia } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    figureNamePrefix: normalizeOptionalString(config.figureNamePrefix) || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
    ...(stripeCheckoutEnabled ? { stripeCheckoutEnabled: true } : stripeCheckoutDisabledOverride ? { stripeCheckoutEnabled: false } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(config.metadataBase, metadataPathFormat),
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

// BEGIN AUTO-GENERATED FRONTEND DROP REGISTRY
export const FRONTEND_DROPS: FrontendDropsMap = {
  "card_nft_2": createFrontendDrop({
    solanaCluster: "mainnet-beta",
    dropId: "card_nft_2",
    dropFamily: "card_nft_2",
    collectionName: "Card NFT 2",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/cardnft2/json",
    metadataPathFormat: "compact",

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.44,
    discountPriceSol: 0.36,
    stripeLiveUnitAmountCents: 4400,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "a8cdf1ec11dbfacb15e9859d0d1484d95f388d883c012314db51e80e5f8021d3",
    maxSupply: 3711,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "cardnft2",

    // On-chain ids
    boxMinterProgramId: "7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU",
    boxMinterConfigPda: "5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm",
    collectionMint: "EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu",
  }),
  "card_nft_2_devnet_final": createFrontendDrop({
    solanaCluster: "devnet",
    dropId: "card_nft_2_devnet_final",
    dropFamily: "card_nft_2",
    collectionName: "Card NFT 2",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/cardnft2/json",
    metadataPathFormat: "compact",

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.44,
    discountPriceSol: 0.36,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "a8cdf1ec11dbfacb15e9859d0d1484d95f388d883c012314db51e80e5f8021d3",
    maxSupply: 3711,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "cardnft2",

    // On-chain ids
    boxMinterProgramId: "7h4JRc5vELpaahm11AeshFEQHe1jePauRnMFWaPSRNpV",
    boxMinterConfigPda: "CPDsJdtvjoYyepqK5sEtYCxmFK6Fjaga9gx7JCBqBj6y",
    collectionMint: "3iX4NjZ9b8TCi2s8xkss4sr1YwYkNhtjH4sib5kxAuEq",
  }),
  "little_swag_boxes": createFrontendDrop({
    solanaCluster: "mainnet-beta",
    dropId: "little_swag_boxes",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",
    metadataPathFormat: "legacy",
    forceSoldOut: true,
    figureMedia: {
      strategy: "cyclic",
      count: 333,
      overrides: {
        344: 1,
        353: 90,
        360: 3,
        505: 163,
        650: 285,
        660: 13,
        661: 206,
        662: 82,
        663: 175,
        664: 19,
        665: 92,
        666: 86,
        677: 1,
        686: 90,
        693: 3,
        838: 163,
        983: 285,
        993: 49,
        994: 206,
        995: 21,
        996: 175,
        997: 19,
        998: 92,
        999: 86,
      },
    },

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
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
  }),
  "little_swag_boxes_devnet": createFrontendDrop({
    solanaCluster: "devnet",
    dropId: "little_swag_boxes_devnet",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",
    metadataPathFormat: "legacy",
    figureMedia: {
      strategy: "cyclic",
      count: 333,
      overrides: {
        344: 1,
        353: 90,
        360: 3,
        505: 163,
        650: 285,
        660: 13,
        661: 206,
        662: 82,
        663: 175,
        664: 19,
        665: 92,
        666: 86,
        677: 1,
        686: 90,
        693: 3,
        838: 163,
        983: 285,
        993: 49,
        994: 206,
        995: 21,
        996: 175,
        997: 19,
        998: 92,
        999: 86,
      },
    },

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
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
  }),
  "little_swag_hoodies": createFrontendDrop({
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

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 3,
    discountPriceSol: 2.55,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 21900,
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
  }),
  "little_swag_hoodies_devnet": createFrontendDrop({
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

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 0.069,
    discountPriceSol: 0.042,
    stripeCheckoutEnabled: true,
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
  }),
  "poncho_drifella": createFrontendDrop({
    solanaCluster: "mainnet-beta",
    dropId: "poncho_drifella",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",
    metadataPathFormat: "legacy",
    forceSoldOut: true,

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
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
  }),
  "poncho_drifella_devnet_x10": createFrontendDrop({
    solanaCluster: "devnet",
    dropId: "poncho_drifella_devnet_x10",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",
    metadataPathFormat: "legacy",

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
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
  }),
};
// END AUTO-GENERATED FRONTEND DROP REGISTRY

assertSharedProgramDropsUseExplicitConfigPdas(FRONTEND_DROPS, 'Frontend deployment config');

export function getFrontendDrop(dropId: string): FrontendDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FRONTEND_DROPS[normalizedDropId];
}

export function dropFamilyForDrop(dropOrId?: FrontendDropConfig | string): DropFamily {
  const drop =
    typeof dropOrId === 'string'
      ? getFrontendDrop(dropOrId)
      : dropOrId && typeof dropOrId === 'object'
        ? dropOrId
        : undefined;
  const fallbackDropId = typeof dropOrId === 'string' ? dropOrId : drop?.dropId;
  return normalizeDropFamily(drop?.dropFamily, fallbackDropId);
}

export function isDropFamily(dropOrId: FrontendDropConfig | string | undefined, dropFamily: DropFamily): boolean {
  return dropFamilyForDrop(dropOrId) === dropFamily;
}

export function requireFrontendDrop(dropId: string): FrontendDropConfig {
  const found = getFrontendDrop(dropId);
  if (!found) {
    throw new Error(`Unknown frontend dropId: ${dropId}`);
  }
  return found;
}

export function listFrontendDrops(): FrontendDropConfig[] {
  return Object.keys(FRONTEND_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FRONTEND_DROPS[dropId]);
}
