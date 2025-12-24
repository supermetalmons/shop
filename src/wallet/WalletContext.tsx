import { FC, ReactNode, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  LedgerWalletAdapter,
  PhantomWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { GlowWalletAdapter } from '@solana/wallet-adapter-glow';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';
import { getHeliusApiKey } from '../lib/helius';
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

function resolveNetwork(): WalletAdapterNetwork {
  const raw = FRONTEND_DEPLOYMENT.solanaCluster;
  if (raw === 'mainnet-beta') return WalletAdapterNetwork.Mainnet;
  if (raw === 'testnet') return WalletAdapterNetwork.Testnet;
  return WalletAdapterNetwork.Devnet;
}

function heliusRpcUrl(): string | null {
  const apiKey = getHeliusApiKey();
  if (!apiKey) return null;
  const cluster = FRONTEND_DEPLOYMENT.solanaCluster;
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  return `https://${subdomain}.helius-rpc.com/?api-key=${apiKey}`;
}

const network = resolveNetwork();
const rpcEndpoint = heliusRpcUrl() || clusterApiUrl(network);

interface Props {
  children: ReactNode;
}

export const WalletContextProvider: FC<Props> = ({ children }) => {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new LedgerWalletAdapter(),
      new GlowWalletAdapter({ network }),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={rpcEndpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
