import type { FrontendDropConfig, SolanaCluster } from './config/deployment';
import {
  LEGACY_DROP_ROUTE_ALIASES,
  resolveFrontendDropByPath,
  resolveUpcomingDropRouteByPath,
  type UpcomingDropRouteConfig,
} from './lib/dropConfig';
import { normalizePathname } from './navigation';

const NEUTRAL_WALLET_CLUSTER: SolanaCluster = 'mainnet-beta';

type PackWipExperience = 'card_nft_2' | 'little_swag_boxes' | 'poncho_drifella';
export type ShopWipExperience = PackWipExperience | 'clear_cards';

type WipRouteDefinition = {
  path: string;
  experience: ShopWipExperience;
  dropId?: string;
};

export const WIP_ROUTES: readonly WipRouteDefinition[] = [
  { path: '/card_nft_2/wip', experience: 'card_nft_2', dropId: 'card_nft_2' },
  {
    path: '/little_swag_boxes/wip',
    experience: 'little_swag_boxes',
    dropId: 'little_swag_boxes',
  },
  {
    path: '/poncho_drifella/wip',
    experience: 'poncho_drifella',
    dropId: 'poncho_drifella',
  },
  { path: '/clear_cards/wip', experience: 'clear_cards' },
];

type RouteAlias = {
  targetPath: string;
  replaceUrl: boolean;
};

const APP_ROUTE_ALIASES: Readonly<Record<string, RouteAlias>> = {
  '/ff': { targetPath: '/fulfillment', replaceUrl: true },
  '/fullfillment': { targetPath: '/fulfillment', replaceUrl: true },
  '/notify-me': { targetPath: '/notify_me', replaceUrl: true },
  ...LEGACY_DROP_ROUTE_ALIASES,
};

type AppRouteKind =
  | 'home'
  | 'drop'
  | 'upcoming'
  | 'claim'
  | 'fulfillment'
  | 'notify'
  | 'wip';

export type ResolvedAppRoute = {
  kind: AppRouteKind;
  path: string;
  replacementHref: string | null;
  claimDeepLinkCode: string | null;
  drop: FrontendDropConfig | null;
  upcoming: UpcomingDropRouteConfig | null;
  wipExperience: ShopWipExperience | null;
  walletCluster: SolanaCluster;
};

type AppRouteLocation = {
  pathname: string;
  search?: string;
  hash?: string;
};

const WIP_ROUTE_BY_PATH = new Map(WIP_ROUTES.map((route) => [route.path, route]));

function createRoute(
  kind: AppRouteKind,
  path: string,
  replacementHref: string | null,
  overrides: Partial<ResolvedAppRoute> = {},
): ResolvedAppRoute {
  return {
    kind,
    path,
    replacementHref,
    claimDeepLinkCode: null,
    drop: null,
    upcoming: null,
    wipExperience: null,
    walletCluster: NEUTRAL_WALLET_CLUSTER,
    ...overrides,
  };
}

export function resolveAppRoute(location: AppRouteLocation): ResolvedAppRoute {
  const requestedPath = normalizePathname(location.pathname);
  const search = location.search || '';
  const hash = location.hash || '';

  if (requestedPath === '/claim') {
    return createRoute('claim', '/', null, {
      claimDeepLinkCode: new URLSearchParams(search).get('code') ?? '',
    });
  }

  const alias = APP_ROUTE_ALIASES[requestedPath];
  const path = alias?.targetPath || requestedPath;
  const replacementHref = alias?.replaceUrl ? `${path}${search}${hash}` : null;

  if (path === '/') return createRoute('home', path, replacementHref);
  if (path === '/fulfillment') return createRoute('fulfillment', path, replacementHref);
  if (path === '/notify_me') return createRoute('notify', path, replacementHref);

  const wipRoute = WIP_ROUTE_BY_PATH.get(path);
  if (wipRoute) {
    return createRoute('wip', path, replacementHref, {
      wipExperience: wipRoute.experience,
    });
  }

  const upcoming = resolveUpcomingDropRouteByPath(path);
  const drop = resolveFrontendDropByPath(path);
  if (drop && (path === `/${drop.dropId}` || upcoming !== null)) {
    return createRoute('drop', path, replacementHref, {
      drop,
      walletCluster: drop.solanaCluster,
    });
  }

  if (upcoming) {
    return createRoute('upcoming', path, replacementHref, {
      upcoming,
      walletCluster: upcoming.solanaCluster,
    });
  }

  return createRoute('home', '/', `/${search}${hash}`);
}
