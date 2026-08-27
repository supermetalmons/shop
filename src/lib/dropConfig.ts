import {
  getFrontendDrop,
  isDropFamily,
  listFrontendDrops,
  normalizeDropId,
  type DropFamily,
  type FrontendDropConfig,
  type SolanaCluster,
} from '../config/deployment';
import { CARD_NFT_2_PACK_PREVIEW_ASPECT_RATIO, CARD_NFT_2_PACK_PREVIEW_IMAGE_URL } from './cardNft2Packs';
import {
  CARD_NFT_BINDER_CLEAN_IMAGE_URL,
  CARD_NFT_BINDER_PREVIEW_ASPECT_RATIO,
  CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
  CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
  DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
} from '../config/dropMediaDefaults';

function normalizePathname(pathname: string): string {
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
  previewDropId?: string;
  previewImageUrl?: string;
  previewAspectRatio?: number;
  boxNamePrefix?: string;
  statusText?: string;
};

export const LEGACY_DROP_ROUTE_ALIASES = {
  '/drifella_binder': {
    targetPath: '/card_nft_binder',
    replaceUrl: true,
  },
} as const;

const UPCOMING_DROP_ROUTES: readonly UpcomingDropRouteConfig[] = [
  {
    path: '/clear_cards',
    dropFamily: 'clear_cards',
    solanaCluster: 'mainnet-beta',
    label: 'Clear Cards',
    title: 'Clear Cards',
    previewImageUrl: CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
    previewAspectRatio: CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
    boxNamePrefix: 'card',
  },
  {
    path: '/tbd',
    dropFamily: 'tbd',
    solanaCluster: 'mainnet-beta',
    label: 'TBD',
    title: 'TBD',
    previewImageUrl: 'https://wip.lil.org/tbd_3.webp',
    previewAspectRatio: 1122 / 1266,
    boxNamePrefix: 'drop',
    statusText: 'Fall 2026',
  },
  {
    path: '/card_nft_2',
    dropFamily: 'card_nft_2',
    solanaCluster: 'mainnet-beta',
    label: 'Card NFT 2',
    title: 'Card NFT 2',
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
    previewDropId: 'little_swag_hoodies_devnet',
    boxNamePrefix: 'hoodie',
  },
  {
    path: '/card_nft_binder',
    dropFamily: 'card_nft_binder',
    solanaCluster: 'mainnet-beta',
    label: 'Card NFT Binder',
    title: 'Card NFT Binder',
    previewImageUrl: CARD_NFT_BINDER_CLEAN_IMAGE_URL,
    previewAspectRatio: CARD_NFT_BINDER_PREVIEW_ASPECT_RATIO,
    boxNamePrefix: 'binder',
  },
  {
    path: '/drifella_shirt',
    dropFamily: 'drifella_shirt',
    solanaCluster: 'mainnet-beta',
    label: 'Drifella Shirt',
    title: 'Drifella Shirt',
    previewImageUrl: DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
    previewAspectRatio: 1585 / 1242,
    boxNamePrefix: 'shirt',
  },
];

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

  const upcomingRoute = resolveUpcomingDropRouteByPath(normalizedPath);

  const candidate = normalizedPath.slice(1);
  const exactDrop = resolveFrontendDropById(candidate, options?.drops);
  if (exactDrop) return exactDrop;

  return resolveUpcomingRouteDrop(upcomingRoute, options?.drops);
}
