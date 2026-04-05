import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import FulfillmentApp from './FulfillmentApp';
import { getNormalizedPathname, subscribeToNavigation } from './navigation';
import { WalletContextProvider } from './wallet/WalletContext';
import { type SolanaCluster, listFrontendDrops } from './config/deployment';
import { resolveFrontendDropByPath } from './lib/dropConfig';
import './styles.css';

if (!window.Buffer) {
  window.Buffer = Buffer;
}

const queryClient = new QueryClient();
const canonicalFulfillmentPath = '/fullfillment';
const canonicalDrifPath = '/notify_me';
const drifPaths = new Set([canonicalDrifPath]);
const DrifApp = React.lazy(() => import('./DrifApp'));
const WipApp = React.lazy(() => import('./WipApp'));
const NEUTRAL_WALLET_CLUSTER: SolanaCluster = 'mainnet-beta';

type RouteAlias = {
  targetPath: string;
  replaceUrl: boolean;
};

const ROUTE_ALIASES: Record<string, RouteAlias> = {
  '/ff': { targetPath: canonicalFulfillmentPath, replaceUrl: true },
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
    normalizedPath === '/wip' ||
    drifPaths.has(normalizedPath) ||
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
  const routeDrop = resolveFrontendDropByPath(path);

  if (isDrifRoute) {
    return (
      <React.Suspense fallback={null}>
        <DrifApp />
      </React.Suspense>
    );
  }

  if (isFulfillmentRoute) {
    return <FulfillmentRoute />;
  }

  return (
    <WalletContextProvider cluster={routeDrop?.solanaCluster || NEUTRAL_WALLET_CLUSTER}>
      <App currentPath={isWipRoute ? '/' : path} />
      {isWipRoute ? (
        <React.Suspense fallback={null}>
          <WipApp />
        </React.Suspense>
      ) : null}
    </WalletContextProvider>
  );
}

function FulfillmentRoute() {
  const drops = React.useMemo(() => listFrontendDrops(), []);
  const [selectedDropId, setSelectedDropId] = React.useState('');
  const selectedDrop = React.useMemo(
    () => drops.find((drop) => drop.dropId === selectedDropId) || null,
    [drops, selectedDropId],
  );

  return (
    <WalletContextProvider cluster={selectedDrop?.solanaCluster || NEUTRAL_WALLET_CLUSTER}>
      <FulfillmentApp selectedDropId={selectedDropId} onSelectedDropIdChange={setSelectedDropId} />
    </WalletContextProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RoutedApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
