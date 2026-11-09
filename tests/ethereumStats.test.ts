import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbi } from '../shared/ethereum/abi.ts';
import { decode111kStats, valid111kDiscountUsage, valid111kRelicSupply } from '../shared/ethereum/stats.ts';

const root = `0x${'12'.repeat(32)}`;
const price = (1n << 200n) + 7n;
const base = encodeAbi(
  ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
  [444, 2, 3, price, price * 11n, false, root, price - 1n, 5, 1, 2, 1],
);

function extend(...values: bigint[]) {
  return base + encodeAbi(values.map(() => 'uint256'), values).slice(2);
}

test('111K stats distinguish the three layouts and preserve large wei amounts', () => {
  const expected = {
    wordCount: 12, allocatedCrates: 444n, warehousesMinted: 2n, artworksMinted: 3n,
    cratePriceWei: price, warehousePriceWei: price * 11n, saleActive: false, discountMerkleRoot: root,
    discountCratePriceWei: price - 1n, discountAllowance: 5n, discountUsed: 1n,
    relicsAllocated: 2n, relicsMinted: 1n, publicRelicsMinted: 0n, discountCap: null,
  };
  assert.deepEqual(decode111kStats(base), expected);
  const discountCap = { maxDiscountedMints: 0n, totalDiscountedMints: 0n };
  assert.deepEqual(decode111kStats(extend(0n, 0n)), { ...expected, wordCount: 14, discountCap });
  assert.deepEqual(decode111kStats(extend(0n, 0n, 0n)), { ...expected, wordCount: 15, discountCap });
});

test('111K stats require exact ABI lengths and canonical boolean words', () => {
  for (const raw of [null, base.slice(0, -2), base.slice(0, -64), extend(10n), extend(10n, 3n, 4n, 1n)]) {
    assert.equal(decode111kStats(raw), null);
  }
  const flagOffset = 2 + 64 * 5;
  const invalidFlag = base.slice(0, flagOffset) + '2'.padStart(64, '0') + base.slice(flagOffset + 64);
  assert.throws(() => decode111kStats(invalidFlag), /Invalid ABI boolean/);
});

test('discount usage and relic supply are validated independently', () => {
  for (const raw of [base, extend(5555n, 444n), extend(5555n, 444n, 2n)]) {
    const stats = decode111kStats(raw)!;
    assert.ok(valid111kDiscountUsage(stats));
    assert.ok(valid111kDiscountUsage({ ...stats, discountAllowance: 1n, discountUsed: 0n }));
    assert.equal(valid111kDiscountUsage({ ...stats, discountAllowance: 0n, discountUsed: 0n }), false);
    assert.equal(valid111kDiscountUsage({ ...stats, discountAllowance: 11n }), false);
    assert.equal(valid111kDiscountUsage({ ...stats, discountUsed: 11n }), false);
    assert.ok(valid111kRelicSupply(stats));
    assert.ok(valid111kRelicSupply({ ...stats, allocatedCrates: 5555n }));
    assert.equal(valid111kRelicSupply({ ...stats, allocatedCrates: 5556n }), false);
  }
  for (const raw of [extend(5556n, 1n), extend(1n, 2n), extend(5555n, 445n)]) {
    const stats = decode111kStats(raw)!;
    assert.equal(valid111kDiscountUsage(stats), false);
    assert.ok(valid111kRelicSupply(stats));
  }
  assert.equal(valid111kRelicSupply(decode111kStats(extend(0n, 0n, 3n))!), false);
});

test('wallet discount usage is bounded by lifetime mints across all stats layouts', () => {
  for (const [raw, allocatedCrates] of [[base, 2n], [extend(5n, 2n), 10n], [extend(5n, 2n, 0n), 10n]] as const) {
    const stats = { ...decode111kStats(raw)!, allocatedCrates, discountAllowance: 1n };
    assert.ok(valid111kDiscountUsage({ ...stats, discountUsed: 2n }));
    assert.equal(valid111kDiscountUsage({ ...stats, discountUsed: 3n }), false);
  }
});
