import React from 'react';
import App from './App';
import { WalletContextProvider } from './wallet/WalletContext';
import type { SolanaCluster } from './config/deployment';

const WipApp = React.lazy(() => import('./WipApp'));

type ShopRouteProps = {
  cluster: SolanaCluster;
  currentPath: string;
  isWipRoute?: boolean;
};

export default function ShopRoute({ cluster, currentPath, isWipRoute = false }: ShopRouteProps) {
  return (
    <WalletContextProvider cluster={cluster}>
      <App currentPath={isWipRoute ? '/' : currentPath} />
      {isWipRoute ? (
        <React.Suspense fallback={null}>
          <WipApp />
        </React.Suspense>
      ) : null}
    </WalletContextProvider>
  );
}
