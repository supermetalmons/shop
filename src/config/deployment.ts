/**
 * Frontend projection of the canonical deployment registry.
 *
 * Deployment rows live in shared/deploymentRegistry.ts so the frontend and
 * API Worker cannot drift.
 */

import {
  defaultBoxMediaConfigForDropFamily,
  defaultFigureMediaConfigForDropFamily,
} from '../../shared/dropMediaDefaults.js';
import {
  DEPLOYMENT_DROPS,
} from '../../shared/deploymentRegistry.js';
import type {
  DeploymentMediaMapConfig,
  DeploymentRegistryDrop,
} from '../../shared/deploymentRegistry.js';
import {
  canonicalizeDropAssetUrl as canonicalizeSharedDropAssetUrl,
  dropPathsFromBase,
  normalizeDropBase as normalizeSharedDropBase,
  normalizeDropFamily,
  normalizeDropId as normalizeSharedDropId,
} from '../../shared/deploymentCore.js';
import type {
  DropFamily as SharedDropFamily,
  DropPaths,
  MintSelectionConfig as SharedMintSelectionConfig,
  SolanaCluster as SharedSolanaCluster,
} from '../../shared/deploymentCore.js';
import { normalizeMediaMapConfig } from '../../shared/mediaMap.js';
import {
  projectDeploymentDropCore,
  type DeploymentDropProjectionCore,
} from '../../shared/deploymentProjection.js';

export type SolanaCluster = SharedSolanaCluster;
export type DropFamily = SharedDropFamily;
export type MediaMapConfig = DeploymentMediaMapConfig;
export type FigureMediaConfig = MediaMapConfig;
type BoxMediaConfig = MediaMapConfig;
export type MintSelectionConfig = SharedMintSelectionConfig;

export type FrontendDropConfig = DeploymentDropProjectionCore & {
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfig;
  boxMedia?: BoxMediaConfig;
  forceSoldOut?: boolean;
  paths: DropPaths;
};

export type FrontendDeploymentConfig = FrontendDropConfig;
export type FrontendDropsMap = Record<string, FrontendDropConfig>;

type SecondaryMarketplaceKey = 'magiceden' | 'tensor' | 'opensea';

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

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  const path = canonical.slice(IPFS_PROTOCOL.length).replace(/^\/+/, '');
  return `${DROP_METADATA_IPFS_GATEWAY}${path}`;
}

const MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  drifella_shirt: 'https://magiceden.io/marketplace/BKcqopLrCYefribMaHhKL46jzsTGkzKpem4pAEWac8dE',
  little_swag_boxes: 'https://magiceden.io/marketplace/little_swag_boxes',
  poncho_drifella: 'https://magiceden.io/marketplace/poncho_drifella',
};

const TENSOR_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  card_nft_2: 'https://www.tensor.trade/trade/card_nft_2',
  drifella_shirt: 'https://www.tensor.trade/trade/BKcqopLrCYefribMaHhKL46jzsTGkzKpem4pAEWac8dE',
  little_swag_boxes: 'https://www.tensor.trade/trade/little_swag_boxes',
  poncho_drifella: 'https://www.tensor.trade/trade/poncho_drifella',
};

const OPENSEA_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  card_nft_2: 'https://opensea.io/collection/cardnft2',
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
  const configuredSecondaryMarketHref = Object.prototype.hasOwnProperty.call(
    DEPLOYMENT_DROPS,
    normalizedDropId,
  )
    ? normalizeOptionalString(
        DEPLOYMENT_DROPS[normalizedDropId]?.secondaryMarketHref,
      )
    : undefined;
  const openSeaHref = ownMarketplaceOverride(
    OPENSEA_MARKETPLACE_HREF_OVERRIDES,
    normalizedDropId,
  );
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
        configuredSecondaryMarketHref ||
        ownMarketplaceOverride(
          TENSOR_MARKETPLACE_HREF_OVERRIDES,
          normalizedDropId,
        ) || `https://www.tensor.trade/trade/${normalizedDropId}`,
    },
    ...(openSeaHref
      ? [{ key: 'opensea' as const, label: 'OpenSea', href: openSeaHref }]
      : []),
  ];
}

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

function projectFrontendDrop(config: DeploymentRegistryDrop): FrontendDropConfig {
  const core = projectDeploymentDropCore(config);
  const figureMedia =
    normalizeMediaMapConfig(config.figureMedia) ||
    defaultFigureMediaConfigForDropFamily(core.dropFamily);
  const boxMedia =
    normalizeMediaMapConfig(config.boxMedia) ||
    defaultBoxMediaConfigForDropFamily(core.dropFamily);
  const forceSoldOut = config.forceSoldOut === true;
  const secondaryMarketHref =
    normalizeOptionalString(config.secondaryMarketHref) ||
    secondaryMarketplaceLinksForDropId(core.dropId).find(
      (link) => link.key === 'tensor',
    )?.href;

  return {
    ...core,
    secondaryMarketHref,
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMedia ? { boxMedia } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(core.metadataBase, core.metadataPathFormat),
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
