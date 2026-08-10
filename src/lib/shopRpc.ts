import { Connection, type ConnectionConfig } from '@solana/web3.js';
import type { SolanaCluster } from '../config/deployment';
import { monsApiOrigin } from './monsApiOrigin';

type ShopSolanaCluster = Exclude<SolanaCluster, 'testnet'>;

export const SHOP_SOLANA_CONNECTION_CONFIG = Object.freeze({
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
}) satisfies ConnectionConfig;

function requireShopSolanaCluster(cluster: SolanaCluster): ShopSolanaCluster {
  if (cluster === 'mainnet-beta' || cluster === 'devnet') return cluster;
  throw new Error(`Unsupported mons API Solana cluster: ${cluster}`);
}

export function rpcEndpointForCluster(cluster: SolanaCluster): string {
  return `${monsApiOrigin()}/rpc/${requireShopSolanaCluster(cluster)}`;
}

export function createShopConnection(cluster: SolanaCluster): Connection {
  return new Connection(rpcEndpointForCluster(cluster), SHOP_SOLANA_CONNECTION_CONFIG);
}
