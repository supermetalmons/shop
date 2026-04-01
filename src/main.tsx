import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import FulfillmentApp from './FulfillmentApp';
import { getNormalizedPathname, subscribeToNavigation } from './navigation';
import { WalletContextProvider } from './wallet/WalletContext';
import './styles.css';

if (!window.Buffer) {
  window.Buffer = Buffer;
}

const queryClient = new QueryClient();
const canonicalFulfillmentPath = '/fullfillment';
const canonicalDrifPath = '/notify-me';
const drifPaths = new Set([canonicalDrifPath]);
const DrifApp = React.lazy(() => import('./DrifApp'));
const WipApp = React.lazy(() => import('./WipApp'));

type RouteAlias = {
  targetPath: string;
  replaceUrl: boolean;
};

const ROUTE_ALIASES: Record<string, RouteAlias> = {
  '/ff': { targetPath: canonicalFulfillmentPath, replaceUrl: true },
  '/notify_me': { targetPath: canonicalDrifPath, replaceUrl: true },
};

const resolveCurrentPath = (): string => {
  const path = getNormalizedPathname();
  const alias = ROUTE_ALIASES[path];

  if (!alias) {
    return path;
  }

  if (alias.replaceUrl) {
    const search = window.location.search || '';
    const hash = window.location.hash || '';
    window.history.replaceState(window.history.state, '', `${alias.targetPath}${search}${hash}`);
  }

  return alias.targetPath;
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

  return (
    <WalletContextProvider currentPath={path}>
      <RoutedContent path={path} />
    </WalletContextProvider>
  );
}

type RoutedContentProps = {
  path: string;
};

function RoutedContent({ path }: RoutedContentProps) {
  const isDrifRoute = drifPaths.has(path);
  const isWipRoute = path === '/wip';
  const isFulfillmentRoute = path === canonicalFulfillmentPath;

  if (isDrifRoute) {
    return (
      <React.Suspense fallback={null}>
        <DrifApp />
      </React.Suspense>
    );
  }

  if (isFulfillmentRoute) {
    return <FulfillmentApp />;
  }

  return (
    <>
      <App currentPath={path} />
      {isWipRoute ? (
        <React.Suspense fallback={null}>
          <WipApp />
        </React.Suspense>
      ) : null}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RoutedApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
