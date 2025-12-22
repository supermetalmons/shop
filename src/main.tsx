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
const RootApp = path === '/ff' ? FulfillmentApp : App;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletContextProvider>
        <RootApp />
      </WalletContextProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
