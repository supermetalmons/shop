import { FC, ReactNode, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  PhantomWalletAdapter,
} from '@solana/wallet-adapter-phantom';
import { LedgerWalletAdapter } from '@solana/wallet-adapter-ledger';
import '@solana/wallet-adapter-react-ui/styles.css';
import { rpcEndpointForCluster } from '../lib/dropConfig';
import type { SolanaCluster } from '../config/deployment';
import { WalletModalFocusManager } from './WalletModalFocusManager';

interface Props {
  cluster: SolanaCluster;
  children: ReactNode;
}

export const WalletContextProvider: FC<Props> = ({ cluster, children }) => {
  const rpcEndpoint = useMemo(() => rpcEndpointForCluster(cluster), [cluster]);
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new LedgerWalletAdapter(),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={rpcEndpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletModalFocusManager />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
