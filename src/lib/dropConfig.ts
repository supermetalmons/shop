import { clusterApiUrl } from '@solana/web3.js';
import {
  FRONTEND_DROPS,
  type FrontendDropConfig,
  type SolanaCluster,
  getFrontendDrop,
} from '../config/deployment';
import { getHeliusApiKey } from './helius';

export function normalizePathname(pathname: string): string {
  const normalized = String(pathname || '').replace(/\/+$/, '');
  return normalized || '/';
}

export function dropPath(dropId: string): string {
  return `/${String(dropId || '').trim()}`;
}

export function listFrontendDrops(): FrontendDropConfig[] {
  return Object.keys(FRONTEND_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FRONTEND_DROPS[dropId]);
}

export function listFrontendDropIds(): string[] {
  return listFrontendDrops().map((drop) => drop.dropId);
}

export function resolveFrontendDropByPath(pathname: string): FrontendDropConfig | null {
  const normalizedPath = normalizePathname(pathname);
  if (normalizedPath === '/') return null;

  const candidate = normalizedPath.slice(1);
  return getFrontendDrop(candidate) || null;
}

export function heliusRpcUrlForCluster(cluster: SolanaCluster): string | null {
  const apiKey = getHeliusApiKey();
  if (!apiKey) return null;
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  return `https://${subdomain}.helius-rpc.com/?api-key=${apiKey}`;
}

export function rpcEndpointForCluster(cluster: SolanaCluster): string {
  return heliusRpcUrlForCluster(cluster) || clusterApiUrl(cluster);
}
