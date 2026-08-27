import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { subscribeToNavigation } from './navigation';
import { getBuildInfo } from './lib/buildInfo';
import { installMobileInteractionGuards } from './lib/mobileInteractionGuards';
import { canonicalProductionUrl } from './lib/canonicalOrigin';
import { runBrowserBootstrap } from './bootstrap';
import { resolveAppRoute, type ResolvedAppRoute } from './routes';
import ShopRoute from './ShopRoute';
import { BackgroundBlurProvider } from './components/BackgroundBlurLayer';
import './styles.css';

const DrifApp = React.lazy(() => import('./DrifApp'));
const FulfillmentRoute = React.lazy(() => import('./FulfillmentRoute'));

const routesEqual = (a: ResolvedAppRoute, b: ResolvedAppRoute): boolean =>
  a.kind === b.kind &&
  a.path === b.path &&
  a.claimDeepLinkCode === b.claimDeepLinkCode &&
  a.drop === b.drop &&
  a.upcoming === b.upcoming &&
  a.wipExperience === b.wipExperience;

const resolveCurrentRoute = (): ResolvedAppRoute => {
  const route = resolveAppRoute({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });

  if (route.replacementHref) {
    window.history.replaceState(window.history.state, '', route.replacementHref);
  }

  return route;
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
    if (route.kind === 'notify') return;
    document.body.classList.remove('drif-body');
  }, [route.kind]);

  return <RoutedContent route={route} />;
}

type RoutedContentProps = {
  route: ResolvedAppRoute;
};

function RoutedContent({ route }: RoutedContentProps) {
  if (route.kind === 'notify') {
    return (
      <React.Suspense fallback={null}>
        <DrifApp />
      </React.Suspense>
    );
  }

  if (route.kind === 'fulfillment') {
    return (
      <React.Suspense fallback={null}>
        <FulfillmentRoute />
      </React.Suspense>
    );
  }

  return (
    <ShopRoute
      cluster={route.walletCluster}
      currentPath={route.path}
      claimDeepLinkCode={route.claimDeepLinkCode}
      wipExperience={route.wipExperience}
    />
  );
}

runBrowserBootstrap(canonicalProductionUrl(window.location.href), {
  redirect: (url) => window.location.replace(url),
  setup: () => {
    if (!window.Buffer) window.Buffer = Buffer;
    installMobileInteractionGuards();
    document.title = getBuildInfo() === 'local dev' ? 'localshop' : 'mons.shop';
  },
  mount: () => {
    const queryClient = new QueryClient();
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <BackgroundBlurProvider>
            <RoutedApp />
          </BackgroundBlurProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );
  },
});
