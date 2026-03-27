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
const DrifApp = React.lazy(() => import('./DrifApp'));
const WipApp = React.lazy(() => import('./WipApp'));
const isDrifRoute = path === '/Poncho_Drifella';
const isWipRoute = path === '/wip';
const RootApp = path === '/ff' ? FulfillmentApp : App;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletContextProvider>
        {isWipRoute ? (
          <React.Suspense fallback={null}>
            <WipApp />
          </React.Suspense>
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
