import type { EthereumMintKind } from '../../shared/ethereum/protocol';
import type { EthereumStats } from '../../shared/ethereum/api';
import { verifyEthereumDiscountProof } from '../../shared/ethereum/discounts';
import { ethereumMintPrice } from './mint';

export const EMPTY_ETHEREUM_DISCOUNT_ROOT = `0x${'0'.repeat(64)}`;

export type EthereumMintQuote = {
  discounted: boolean;
  unitPriceWei: string;
  discountMerkleRoot: string | null;
};

type DiscountDataset = { root: string; proofs: Record<string, string[]> };
const datasets = new Map<string, Promise<DiscountDataset>>();

async function dataset(root: string): Promise<DiscountDataset> {
  const cached = datasets.get(root);
  if (cached) return cached;
  const loading = import('./discounts/111k.json').then(({ default: value }) => {
    if (value.root !== root || !value.proofs || typeof value.proofs !== 'object') {
      throw new Error('The discount list changed. Refresh this page and try again.');
    }
    return value as DiscountDataset;
  }).catch(cause => {
    datasets.delete(root);
    throw cause;
  });
  datasets.set(root, loading);
  return loading;
}

export const ethereumDiscounts = {
  async proof(address: string, root: string): Promise<string[] | null> {
    const { proofs } = await dataset(root);
    const proof = Object.hasOwn(proofs, address) ? proofs[address] : null;
    if (proof === null) return null;
    if (!Array.isArray(proof) || !proof.every(value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)) ||
      !verifyEthereumDiscountProof(address, proof, root)) {
      throw new Error('Couldn’t verify your mint discount. Refresh this page and try again.');
    }
    return proof;
  },
};

export function ethereumMintQuote(kind: EthereumMintKind, quantity: number, stats: EthereumStats, eligible: boolean): EthereumMintQuote {
  const discounted = kind === 'crate' && eligible && stats.discountMerkleRoot !== EMPTY_ETHEREUM_DISCOUNT_ROOT &&
    quantity <= Math.max(0, stats.discountAllowance - stats.discountUsed);
  return {
    discounted,
    unitPriceWei: discounted ? stats.discountCratePriceWei : ethereumMintPrice(kind, stats),
    discountMerkleRoot: kind === 'crate' ? stats.discountMerkleRoot : null,
  };
}
