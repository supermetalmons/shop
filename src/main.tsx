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
};

const resolveCurrentPath = (): string => {
  const path = getNormalizedPathname();
  const alias = ROUTE_ALIASES[path];
  const normalizedPath = alias ? alias.targetPath : path;

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
    return normalizedPath;
  }

  const search = window.location.search || '';
  const hash = window.location.hash || '';
  window.history.replaceState(window.history.state, '', `/${search}${hash}`);
  return '/';
};

function RoutedApp() {
  const [path, setPath] = React.useState(() => resolveCurrentPath());

  React.useEffect(() => {
    const handleNavigation = () => {
      setPath(resolveCurrentPath());
    };

    return subscribeToNavigation(handleNavigation);
  }, []);

  React.useEffect(() => {
    if (drifPaths.has(path)) return;
    document.body.classList.remove('drif-body');
  }, [path]);

  return <RoutedContent path={path} />;
}

type RoutedContentProps = {
  path: string;
};

function RoutedContent({ path }: RoutedContentProps) {
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
