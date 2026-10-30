import type { EthereumStats } from '../../shared/ethereum/api';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumMintKind } from '../../shared/ethereum/protocol';

export function ethereumMintPrice(kind: EthereumMintKind, prices: Pick<Ethereum111kConfig, 'cratePriceWei' | 'warehousePriceWei' | 'reliquaryPriceWei'>): string {
  return prices[`${kind}PriceWei`];
}

export function ethereumMintRemaining(kind: EthereumMintKind, stats: Pick<EthereumStats, 'remainingCrates' | 'remainingWarehouses' | 'remainingReliquaries'>): number {
  return { crate: stats.remainingCrates, warehouse: stats.remainingWarehouses, reliquary: stats.remainingReliquaries }[kind];
}
