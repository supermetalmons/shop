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
  SolflareWalletAdapter,
  TorusWalletAdapter,
  UnsafeBurnerWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { clusterApiUrl } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';

function resolveNetwork(): WalletAdapterNetwork {
  const raw = (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet').toLowerCase();
  if (raw === 'mainnet-beta' || raw === 'mainnet') return WalletAdapterNetwork.Mainnet;
  if (raw === 'testnet') return WalletAdapterNetwork.Testnet;
  return WalletAdapterNetwork.Devnet;
}

function heliusRpcUrl(): string | null {
  const apiKey = (import.meta.env.VITE_HELIUS_API_KEY || '').trim();
  if (!apiKey) return null;
  const cluster = (import.meta.env.VITE_SOLANA_CLUSTER || 'devnet').toLowerCase();
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  const base = (import.meta.env.VITE_HELIUS_RPC_URL || '').trim();
  if (base) return `${base}${base.includes('?') ? '&' : '?'}api-key=${apiKey}`;
  return `https://${subdomain}.helius-rpc.com/?api-key=${apiKey}`;
}

const network = resolveNetwork();
const envRpc = (import.meta.env.VITE_RPC_URL || '').trim();
const rpcEndpoint = envRpc || heliusRpcUrl() || clusterApiUrl(network);

interface Props {
  children: ReactNode;
}

export const WalletContextProvider: FC<Props> = ({ children }) => {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network }),
      new LedgerWalletAdapter(),
      new TorusWalletAdapter({ params: { network } }),
      new UnsafeBurnerWalletAdapter(),
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
