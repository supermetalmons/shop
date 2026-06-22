import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getNormalizedPathname, subscribeToNavigation } from './navigation';
import { getBuildInfo } from './lib/buildInfo';
import type { SolanaCluster } from './config/deployment';
import { resolveFrontendDropByPath, resolveUpcomingDropRouteByPath } from './lib/dropConfig';
import { installMobileInteractionGuards } from './lib/mobileInteractionGuards';
import ShopRoute from './ShopRoute';
import './styles.css';

if (!window.Buffer) {
  window.Buffer = Buffer;
}

installMobileInteractionGuards();

document.title = getBuildInfo() === 'local dev' ? 'localshop' : 'mons.shop';

const queryClient = new QueryClient();
const canonicalFulfillmentPath = '/fulfillment';
const canonicalDrifPath = '/notify_me';
const canonicalCardNft2UnrevealedPath = '/card_nft_2/unrevealed';
const canonicalClaimPath = '/claim';
const drifPaths = new Set([canonicalDrifPath]);
const CardNft2UnrevealedApp = React.lazy(() => import('./CardNft2UnrevealedApp'));
const DrifApp = React.lazy(() => import('./DrifApp'));
const FulfillmentRoute = React.lazy(() => import('./FulfillmentRoute'));
const NEUTRAL_WALLET_CLUSTER: SolanaCluster = 'mainnet-beta';

type RouteAlias = {
  targetPath: string;
  replaceUrl: boolean;
};

const ROUTE_ALIASES: Record<string, RouteAlias> = {
  '/ff': { targetPath: canonicalFulfillmentPath, replaceUrl: true },
  '/fullfillment': { targetPath: canonicalFulfillmentPath, replaceUrl: true },
  '/notify-me': { targetPath: canonicalDrifPath, replaceUrl: true },
  [canonicalClaimPath]: { targetPath: '/', replaceUrl: false },
};

type CurrentRoute = {
  path: string;
  claimDeepLinkCode: string | null;
};

const claimDeepLinkCodeFromSearch = (): string => new URLSearchParams(window.location.search).get('code') ?? '';

const routesEqual = (a: CurrentRoute, b: CurrentRoute): boolean =>
  a.path === b.path && a.claimDeepLinkCode === b.claimDeepLinkCode;

const resolveCurrentRoute = (): CurrentRoute => {
  const path = getNormalizedPathname();
  const alias = ROUTE_ALIASES[path];
  const normalizedPath = alias ? alias.targetPath : path;
  const claimDeepLinkCode = path === canonicalClaimPath ? claimDeepLinkCodeFromSearch() : null;

  if (alias?.replaceUrl) {
    const search = window.location.search || '';
    const hash = window.location.hash || '';
    window.history.replaceState(window.history.state, '', `${alias.targetPath}${search}${hash}`);
  }

  if (
    normalizedPath === '/' ||
    normalizedPath === canonicalFulfillmentPath ||
    normalizedPath === canonicalCardNft2UnrevealedPath ||
    normalizedPath === '/wip' ||
    drifPaths.has(normalizedPath) ||
    resolveUpcomingDropRouteByPath(normalizedPath) ||
    resolveFrontendDropByPath(normalizedPath)
  ) {
    return { path: normalizedPath, claimDeepLinkCode };
  }

  const search = window.location.search || '';
  const hash = window.location.hash || '';
  window.history.replaceState(window.history.state, '', `/${search}${hash}`);
  return { path: '/', claimDeepLinkCode: null };
};

function RoutedApp() {
  const [route, setRoute] = React.useState(() => resolveCurrentRoute());

  React.useEffect(() => {
    const handleNavigation = () => {
      const nextRoute = resolveCurrentRoute();
      setRoute((currentRoute) => {
        return routesEqual(currentRoute, nextRoute) ? currentRoute : nextRoute;
      });
    };

    return subscribeToNavigation(handleNavigation);
  }, []);

  React.useEffect(() => {
    if (drifPaths.has(route.path)) return;
    document.body.classList.remove('drif-body');
  }, [route.path]);

  return <RoutedContent route={route} />;
}

type RoutedContentProps = {
  route: CurrentRoute;
};

function RoutedContent({ route }: RoutedContentProps) {
  const { path } = route;
  const isDrifRoute = drifPaths.has(path);
  const isWipRoute = path === '/wip';
  const isFulfillmentRoute = path === canonicalFulfillmentPath;
  const isCardNft2UnrevealedRoute = path === canonicalCardNft2UnrevealedPath;
  const routeDrop = isCardNft2UnrevealedRoute ? null : resolveFrontendDropByPath(path);
  const upcomingRoute = routeDrop ? null : resolveUpcomingDropRouteByPath(path);

  if (isDrifRoute) {
    return (
      <React.Suspense fallback={null}>
        <DrifApp />
      </React.Suspense>
    );
  }

  if (isFulfillmentRoute) {
    return (
      <React.Suspense fallback={null}>
        <FulfillmentRoute />
      </React.Suspense>
    );
  }

  if (isCardNft2UnrevealedRoute) {
    return (
      <React.Suspense fallback={null}>
        <CardNft2UnrevealedApp />
      </React.Suspense>
    );
  }

  return (
    <ShopRoute
      cluster={routeDrop?.solanaCluster || upcomingRoute?.solanaCluster || NEUTRAL_WALLET_CLUSTER}
      currentPath={path}
      claimDeepLinkCode={route.claimDeepLinkCode}
      isWipRoute={isWipRoute}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RoutedApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
