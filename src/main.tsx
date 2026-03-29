import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import FulfillmentApp from './FulfillmentApp';
import { WalletContextProvider } from './wallet/WalletContext';
import './styles.css';

if (!window.Buffer) {
  window.Buffer = Buffer;
}

const queryClient = new QueryClient();
const path = window.location?.pathname?.replace(/\/+$/, '') || '/';
const canonicalFulfillmentPath = '/fullfillment';
if (path === '/ff') {
  const search = window.location?.search || '';
  const hash = window.location?.hash || '';
  window.history.replaceState(window.history.state, '', `${canonicalFulfillmentPath}${search}${hash}`);
}
const DrifApp = React.lazy(() => import('./DrifApp'));
const WipApp = React.lazy(() => import('./WipApp'));
const isDrifRoute = path === '/Poncho_Drifella';
const isWipRoute = path === '/wip';
const isFulfillmentRoute = path === '/ff' || path === canonicalFulfillmentPath;
const RootApp = isFulfillmentRoute ? FulfillmentApp : App;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletContextProvider>
        {isWipRoute ? (
          <>
            <App />
            <React.Suspense fallback={null}>
              <WipApp />
            </React.Suspense>
          </>
        ) : isDrifRoute ? (
          <React.Suspense fallback={null}>
            <DrifApp />
          </React.Suspense>
        ) : (
          <RootApp />
        )}
      </WalletContextProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
