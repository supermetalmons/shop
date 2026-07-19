/**
 * Frontend projection of the canonical deployment registry.
 *
 * Deployment rows live in functions/src/shared/deploymentRegistry.ts so the
 * frontend and Cloud Functions cannot drift.
 */

import {
  defaultBoxMediaConfigForDropFamily,
  defaultFigureMediaConfigForDropFamily,
} from '../../functions/src/shared/dropMediaDefaults.js';
import { DEPLOYMENT_DROPS } from '../../functions/src/shared/deploymentRegistry.js';
import type {
  DeploymentMediaMapConfig,
  DeploymentRegistryDrop,
} from '../../functions/src/shared/deploymentRegistry.js';
import {
  canonicalizeDropAssetUrl as canonicalizeSharedDropAssetUrl,
  defaultDropFamilyForDropId as defaultSharedDropFamilyForDropId,
  dropPathsFromBase,
  normalizeDiscountMintsPerWallet,
  normalizeDropBase as normalizeSharedDropBase,
  normalizeDropFamily as normalizeSharedDropFamily,
  normalizeDropId as normalizeSharedDropId,
  normalizeMetadataPathFormat,
  normalizeMintSelectionConfig,
} from '../../functions/src/shared/deploymentCore.js';
import type {
  DropFamily as SharedDropFamily,
  DropPaths,
  MetadataPathFormat,
  MintSelectionConfig as SharedMintSelectionConfig,
  SolanaCluster as SharedSolanaCluster,
} from '../../functions/src/shared/deploymentCore.js';
import { normalizeMediaMapConfig } from '../../functions/src/shared/mediaMap.js';
import {
  assertStripeLivePriceConfigured,
  resolveStripeCheckoutEnabledForDropFamily,
} from '../../functions/src/shared/stripeCheckoutCore.js';

export type SolanaCluster = SharedSolanaCluster;
export type DropFamily = SharedDropFamily;
export type MediaMapConfig = DeploymentMediaMapConfig;
export type FigureMediaConfig = MediaMapConfig;
type BoxMediaConfig = MediaMapConfig;
export type MintSelectionConfig = SharedMintSelectionConfig;

export type FrontendDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfig;
  boxMedia?: BoxMediaConfig;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfig;
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
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  paths: DropPaths;
};

export type FrontendDeploymentConfig = FrontendDropConfig;
export type FrontendDropsMap = Record<string, FrontendDropConfig>;

type SecondaryMarketplaceKey = 'magiceden' | 'tensor';

export type SecondaryMarketplaceLink = {
  key: SecondaryMarketplaceKey;
  label: string;
  href: string;
};

export const DROP_METADATA_IPFS_GATEWAY = 'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/';
const IPFS_PROTOCOL = 'ipfs://';
export const normalizeDropBase = normalizeSharedDropBase;
export const canonicalizeDropAssetUrl = canonicalizeSharedDropAssetUrl;
export const normalizeDropId = normalizeSharedDropId;
export const defaultDropFamilyForDropId = defaultSharedDropFamilyForDropId;
export const normalizeDropFamily = normalizeSharedDropFamily;

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  const path = canonical.slice(IPFS_PROTOCOL.length).replace(/^\/+/, '');
  return `${DROP_METADATA_IPFS_GATEWAY}${path}`;
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

function ownMarketplaceOverride(
  overrides: Record<string, string>,
  dropId: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(overrides, dropId)
    ? overrides[dropId]
    : undefined;
}

export function secondaryMarketplaceLinksForDropId(dropId: string): SecondaryMarketplaceLink[] {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) return [];
  return [
    {
      key: 'magiceden',
      label: 'Magic Eden',
      href:
        ownMarketplaceOverride(
          MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES,
          normalizedDropId,
        ) || `https://magiceden.io/marketplace/${normalizedDropId}`,
    },
    {
      key: 'tensor',
      label: 'Tensor',
      href:
        ownMarketplaceOverride(
          TENSOR_MARKETPLACE_HREF_OVERRIDES,
          normalizedDropId,
        ) || `https://www.tensor.trade/trade/${normalizedDropId}`,
    },
  ];
}

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

function projectFrontendDrop(config: DeploymentRegistryDrop): FrontendDropConfig {
  const normalizedDropId = normalizeDropId(config.dropId);
  const dropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  const metadataPathFormat = normalizeMetadataPathFormat(config.metadataPathFormat);
  const metadataBase = normalizeDropBase(config.metadataBase);
  const figureMedia =
    normalizeMediaMapConfig(config.figureMedia) ||
    defaultFigureMediaConfigForDropFamily(dropFamily);
  const boxMedia =
    normalizeMediaMapConfig(config.boxMedia) ||
    defaultBoxMediaConfigForDropFamily(dropFamily);
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = normalizeOptionalString(config.boxMinterConfigPda);
  const stripeCheckout = resolveStripeCheckoutEnabledForDropFamily(
    config.stripeCheckoutEnabled,
    dropFamily,
  );
  assertStripeLivePriceConfigured({
    dropId: normalizedDropId,
    solanaCluster: config.solanaCluster,
    stripeCheckoutEnabled: stripeCheckout.enabled,
    stripeLiveUnitAmountCents: config.stripeLiveUnitAmountCents,
  });
  const forceSoldOut = config.forceSoldOut === true;
  const secondaryMarketHref =
    normalizeOptionalString(config.secondaryMarketHref) ||
    secondaryMarketplaceLinksForDropId(normalizedDropId).find(
      (link) => link.key === 'tensor',
    )?.href;

  return {
    solanaCluster: config.solanaCluster,
    dropId: normalizedDropId,
    dropFamily,
    collectionName: config.collectionName,
    metadataBase,
    metadataPathFormat,
    treasury: config.treasury,
    priceSol: config.priceSol,
    discountPriceSol: config.discountPriceSol,
    ...(config.stripeLiveUnitAmountCents != null
      ? { stripeLiveUnitAmountCents: config.stripeLiveUnitAmountCents }
      : {}),
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(
      config.discountMintsPerWallet,
    ),
    discountMerkleRoot: config.discountMerkleRoot,
    maxSupply: config.maxSupply,
    itemsPerBox: config.itemsPerBox,
    maxPerTx: config.maxPerTx,
    namePrefix: config.namePrefix,
    figureNamePrefix: normalizeOptionalString(config.figureNamePrefix) || 'figure',
    symbol: config.symbol,
    boxMinterProgramId: config.boxMinterProgramId,
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    collectionMint: config.collectionMint,
    secondaryMarketHref,
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMedia ? { boxMedia } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    ...(stripeCheckout.enabled
      ? { stripeCheckoutEnabled: true }
      : stripeCheckout.disabledOverride
        ? { stripeCheckoutEnabled: false }
        : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(metadataBase, metadataPathFormat),
  };
}

export const FRONTEND_DROPS: FrontendDropsMap = Object.fromEntries(
  Object.entries(DEPLOYMENT_DROPS).map(([dropId, drop]) => [
    dropId,
    projectFrontendDrop(drop),
  ]),
);

export function getFrontendDrop(dropId: string): FrontendDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return Object.prototype.hasOwnProperty.call(FRONTEND_DROPS, normalizedDropId)
    ? FRONTEND_DROPS[normalizedDropId]
    : undefined;
}

function dropFamilyForDrop(
  dropOrId?: FrontendDropConfig | string,
): DropFamily {
  const drop =
    typeof dropOrId === 'string'
      ? getFrontendDrop(dropOrId)
      : dropOrId && typeof dropOrId === 'object'
        ? dropOrId
        : undefined;
  const fallbackDropId =
    typeof dropOrId === 'string' ? dropOrId : drop?.dropId;
  return normalizeDropFamily(drop?.dropFamily, fallbackDropId);
}

export function isDropFamily(
  dropOrId: FrontendDropConfig | string | undefined,
  dropFamily: DropFamily,
): boolean {
  return dropFamilyForDrop(dropOrId) === dropFamily;
}

export function listFrontendDrops(): FrontendDropConfig[] {
  return Object.keys(FRONTEND_DROPS)
    .sort((left, right) => left.localeCompare(right))
    .map((dropId) => FRONTEND_DROPS[dropId]);
}
