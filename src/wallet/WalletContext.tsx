import { FC, ReactNode, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  PhantomWalletAdapter,
} from '@solana/wallet-adapter-phantom';
import { GlowWalletAdapter } from '@solana/wallet-adapter-glow';
import { LedgerWalletAdapter } from '@solana/wallet-adapter-ledger';
import '@solana/wallet-adapter-react-ui/styles.css';
import { rpcEndpointForCluster } from '../lib/dropConfig';
import type { SolanaCluster } from '../config/deployment';

interface Props {
  cluster: SolanaCluster;
  children: ReactNode;
}

function resolveNetworkFromCluster(cluster: SolanaCluster): WalletAdapterNetwork {
  if (cluster === 'mainnet-beta') return WalletAdapterNetwork.Mainnet;
  if (cluster === 'testnet') return WalletAdapterNetwork.Testnet;
  return WalletAdapterNetwork.Devnet;
}

export const WalletContextProvider: FC<Props> = ({ cluster, children }) => {
  const network = useMemo(() => resolveNetworkFromCluster(cluster), [cluster]);
  const rpcEndpoint = useMemo(() => rpcEndpointForCluster(cluster), [cluster]);
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new GlowWalletAdapter({ network }),
      new LedgerWalletAdapter(),
    ],
    [network],
  );

  return (
    <ConnectionProvider endpoint={rpcEndpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
