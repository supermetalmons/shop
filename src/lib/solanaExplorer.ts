import { PublicKey } from '@solana/web3.js';

import type { SolanaCluster } from '../config/deployment';

const SOLANA_EXPLORER_BASE_URL = 'https://explorer.solana.com';

export function solanaExplorerAddressUrl(address: string, cluster: SolanaCluster): string | null {
  let normalizedAddress: string;
  try {
    normalizedAddress = new PublicKey(String(address || '').trim()).toBase58();
  } catch {
    return null;
  }

  const url = new URL(`/address/${normalizedAddress}`, SOLANA_EXPLORER_BASE_URL);
  if (cluster !== 'mainnet-beta') url.searchParams.set('cluster', cluster);
  return url.toString();
}
