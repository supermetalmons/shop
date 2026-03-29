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
const DrifApp = React.lazy(() => import('./DrifApp'));
const WipApp = React.lazy(() => import('./WipApp'));

const resolveCurrentPath = (): string => {
  const path = getNormalizedPathname();
  if (path === '/ff') {
    const search = window.location.search || '';
    const hash = window.location.hash || '';
    window.history.replaceState(window.history.state, '', `${canonicalFulfillmentPath}${search}${hash}`);
    return canonicalFulfillmentPath;
  }
  return path;
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
    if (path === '/Poncho_Drifella') return;
    document.body.classList.remove('drif-body');
  }, [path]);

  const isDrifRoute = path === '/Poncho_Drifella';
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
      <App />
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
      <WalletContextProvider>
        <RoutedApp />
      </WalletContextProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
