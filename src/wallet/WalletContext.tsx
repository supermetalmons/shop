import { FC, ReactNode, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  PhantomWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { GlowWalletAdapter } from '@solana/wallet-adapter-glow';
import { LedgerWalletAdapter } from '@solana/wallet-adapter-ledger';
import '@solana/wallet-adapter-react-ui/styles.css';
import { normalizePathname, resolveFrontendDropByPath, rpcEndpointForCluster } from '../lib/dropConfig';

interface Props {
  currentPath?: string;
  children: ReactNode;
}

function resolveNetworkFromCluster(cluster: string): WalletAdapterNetwork {
  if (cluster === 'mainnet-beta') return WalletAdapterNetwork.Mainnet;
  if (cluster === 'testnet') return WalletAdapterNetwork.Testnet;
  return WalletAdapterNetwork.Devnet;
}

export const WalletContextProvider: FC<Props> = ({ currentPath, children }) => {
  const normalizedPath = useMemo(() => normalizePathname(currentPath || '/'), [currentPath]);
  const activeDrop = useMemo(() => resolveFrontendDropByPath(normalizedPath), [normalizedPath]);
  const network = useMemo(() => resolveNetworkFromCluster(activeDrop.solanaCluster), [activeDrop.solanaCluster]);
  const rpcEndpoint = useMemo(() => rpcEndpointForCluster(activeDrop.solanaCluster), [activeDrop.solanaCluster]);
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
