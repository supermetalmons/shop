import { decodeReturn } from './abi.ts';
import { ETHEREUM_CRATES_PER_RELIC, ETHEREUM_CRATES_PER_WAREHOUSE, ETHEREUM_MAX_DISCOUNT_ALLOWANCE, ETHEREUM_MAX_RELICS, ethereumItemDisplayIdMaximum } from './protocol.ts';

const STATS_TYPES = [
  'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256',
  'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256',
] as const;

export function decode111kStats(raw: unknown) {
  if (typeof raw !== 'string') return null;
  const wordCount = (raw.length - 2) / 64;
  if (wordCount !== 12 && wordCount !== 14 && wordCount !== 15) return null;
  const [allocatedCrates, warehousesMinted, artworksMinted, cratePriceWei, warehousePriceWei,
    saleActive, discountMerkleRoot, discountCratePriceWei, discountAllowance, discountUsed,
    relicsAllocated, relicsMinted, maxDiscountedMints, totalDiscountedMints, publicRelicsMinted = 0n,
  ] = decodeReturn(STATS_TYPES.slice(0, wordCount), raw) as [
    bigint, bigint, bigint, bigint, bigint, boolean, string, bigint,
    bigint, bigint, bigint, bigint, bigint?, bigint?, bigint?,
  ];
  return {
    wordCount, allocatedCrates, warehousesMinted, artworksMinted, cratePriceWei, warehousePriceWei,
    saleActive, discountMerkleRoot, discountCratePriceWei, discountAllowance, discountUsed,
    relicsAllocated, relicsMinted, publicRelicsMinted,
    discountCap: maxDiscountedMints !== undefined && totalDiscountedMints !== undefined
      ? { maxDiscountedMints, totalDiscountedMints } : null,
  };
}

type CollectionStats = NonNullable<ReturnType<typeof decode111kStats>>;

export function valid111kDiscountUsage({ allocatedCrates, discountAllowance, discountUsed, discountCap }: CollectionStats): boolean {
  if (discountAllowance < 1n || discountAllowance > ETHEREUM_MAX_DISCOUNT_ALLOWANCE || discountUsed > ETHEREUM_MAX_DISCOUNT_ALLOWANCE) return false;
  if (!discountCap) return discountUsed <= allocatedCrates;
  const { maxDiscountedMints, totalDiscountedMints } = discountCap;
  return maxDiscountedMints <= BigInt(ethereumItemDisplayIdMaximum('crate')) &&
    discountUsed <= totalDiscountedMints && totalDiscountedMints <= maxDiscountedMints && totalDiscountedMints <= allocatedCrates;
}

function relicCrates({ relicsAllocated, publicRelicsMinted }: CollectionStats): bigint {
  return (relicsAllocated + publicRelicsMinted) * BigInt(ETHEREUM_CRATES_PER_RELIC);
}

export function valid111kRelicSupply(stats: CollectionStats): boolean {
  return stats.relicsMinted <= stats.relicsAllocated && stats.relicsAllocated + stats.publicRelicsMinted <= BigInt(ETHEREUM_MAX_RELICS) &&
    stats.allocatedCrates <= BigInt(ethereumItemDisplayIdMaximum('crate')) && stats.allocatedCrates >= relicCrates(stats);
}

export function minimum111kAllocatedCrates(stats: CollectionStats): bigint {
  const warehouseCrates = stats.warehousesMinted * BigInt(ETHEREUM_CRATES_PER_WAREHOUSE);
  const discountedCrates = stats.discountCap?.totalDiscountedMints ?? stats.discountUsed;
  return warehouseCrates + relicCrates(stats) + discountedCrates;
}
