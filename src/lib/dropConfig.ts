import { clusterApiUrl } from '@solana/web3.js';
import {
  FRONTEND_DROPS,
  isDropFamily,
  normalizeDropId,
  type DropFamily,
  type FrontendDropConfig,
  type SolanaCluster,
  getFrontendDrop,
} from '../config/deployment';
import { getHeliusApiKey } from './helius';
import { CARD_NFT_2_PACK_PREVIEW_ASPECT_RATIO, CARD_NFT_2_PACK_PREVIEW_IMAGE_URL } from './cardNft2Packs';

export function normalizePathname(pathname: string): string {
  const normalized = String(pathname || '').replace(/\/+$/, '');
  return normalized || '/';
}

export function dropPath(dropId: string): string {
  return `/${String(dropId || '').trim()}`;
}

export type UpcomingDropRouteConfig = {
  path: string;
  dropFamily: DropFamily;
  solanaCluster: SolanaCluster;
  label: string;
  title: string;
  notifyPath: string;
  previewDropId?: string;
  previewImageUrl?: string;
  previewAspectRatio?: number;
  boxNamePrefix?: string;
};

const UPCOMING_DROP_ROUTES: readonly UpcomingDropRouteConfig[] = [
  {
    path: '/card_nft_2',
    dropFamily: 'card_nft_2',
    solanaCluster: 'mainnet-beta',
    label: 'Card NFT 2',
    title: 'Card NFT 2',
    notifyPath: '/notify_me',
    previewImageUrl: CARD_NFT_2_PACK_PREVIEW_IMAGE_URL,
    previewAspectRatio: CARD_NFT_2_PACK_PREVIEW_ASPECT_RATIO,
    boxNamePrefix: 'pack',
  },
  {
    path: '/little_swag_hoodies',
    dropFamily: 'little_swag_hoodies',
    solanaCluster: 'mainnet-beta',
    label: 'Little Swag Hoodies',
    title: 'Little Swag Hoodies',
    notifyPath: '/notify_me',
    previewDropId: 'little_swag_hoodies_devnet',
    boxNamePrefix: 'hoodie',
  },
];

export function listFrontendDrops(): FrontendDropConfig[] {
  return Object.keys(FRONTEND_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FRONTEND_DROPS[dropId]);
}

export function listFrontendDropIds(): string[] {
  return listFrontendDrops().map((drop) => drop.dropId);
}

export function listUpcomingDropRoutes(): UpcomingDropRouteConfig[] {
  return [...UPCOMING_DROP_ROUTES];
}

export function resolveUpcomingDropRouteByPath(pathname: string): UpcomingDropRouteConfig | null {
  const normalizedPath = normalizePathname(pathname);
  return UPCOMING_DROP_ROUTES.find((route) => normalizePathname(route.path) === normalizedPath) || null;
}

export function resolveUpcomingRouteDrop(
  route: UpcomingDropRouteConfig | null | undefined,
  drops: readonly FrontendDropConfig[] = listFrontendDrops(),
): FrontendDropConfig | null {
  if (!route) return null;
  return (
    drops.find((drop) => drop.solanaCluster === route.solanaCluster && isDropFamily(drop, route.dropFamily)) || null
  );
}

function resolveFrontendDropById(dropId: string, drops?: readonly FrontendDropConfig[]): FrontendDropConfig | null {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) return null;
  if (drops) {
    return drops.find((drop) => drop.dropId === normalizedDropId) || null;
  }
  return getFrontendDrop(normalizedDropId) || null;
}

export function resolveFrontendDropByPath(
  pathname: string,
  options?: { drops?: readonly FrontendDropConfig[] },
): FrontendDropConfig | null {
  const normalizedPath = normalizePathname(pathname);
  if (normalizedPath === '/') return null;

  const candidate = normalizedPath.slice(1);
  const exactDrop = resolveFrontendDropById(candidate, options?.drops);
  if (exactDrop) return exactDrop;

  const upcomingRoute = resolveUpcomingDropRouteByPath(normalizedPath);
  return resolveUpcomingRouteDrop(upcomingRoute, options?.drops);
}

export function heliusRpcUrlForCluster(cluster: SolanaCluster): string | null {
  const apiKey = getHeliusApiKey();
  if (!apiKey) return null;
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  return `https://${subdomain}.helius-rpc.com/?api-key=${apiKey}`;
}

export function rpcEndpointForCluster(cluster: SolanaCluster): string {
  return heliusRpcUrlForCluster(cluster) || clusterApiUrl(cluster);
}
