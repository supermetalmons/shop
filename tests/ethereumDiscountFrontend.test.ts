import assert from 'node:assert/strict';
import test from 'node:test';
import dataset from '../src/ethereum/discounts/111k.json';
import { ethereumDiscounts, ethereumMintQuote } from '../src/ethereum/discounts.ts';
import { ethereumApi } from '../src/ethereum/api.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { verifyEthereumDiscountProof } from '../shared/ethereum/discounts.ts';

const owner = '0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe';
const other = '0x1111111111111111111111111111111111111111';
const config = resolveEthereum111kConfig({ contractAddress: '0x3333333333333333333333333333333333333333' });

test('browser verification accepts every generated proof and rejects another wallet', () => {
  for (const [address, proof] of Object.entries(dataset.proofs)) {
    assert.equal(verifyEthereumDiscountProof(address, proof, dataset.root), true);
    assert.equal(verifyEthereumDiscountProof(other, proof, dataset.root), false);
  }
  assert.equal(verifyEthereumDiscountProof(owner.toUpperCase().replace('0X', '0x'), dataset.proofs[owner], dataset.root), true);
});

test('browser verification rejects malformed and tampered inputs without throwing', () => {
  const proof = dataset.proofs[owner];
  assert.equal(verifyEthereumDiscountProof('not an address', proof, dataset.root), false);
  assert.equal(verifyEthereumDiscountProof(owner, proof, '0x00'), false);
  assert.equal(verifyEthereumDiscountProof(owner, ['0x00'], dataset.root), false);
  assert.equal(verifyEthereumDiscountProof(owner, [...proof, dataset.root], dataset.root), false);
  assert.equal(verifyEthereumDiscountProof(owner, proof.slice(1), dataset.root), false);
  assert.equal(verifyEthereumDiscountProof(owner, Array(33).fill(dataset.root), dataset.root), false);
  assert.equal(Reflect.apply(verifyEthereumDiscountProof, undefined, [owner, null, dataset.root]), false);
  assert.equal(verifyEthereumDiscountProof(owner, proof, `0x${'00'.repeat(32)}`), false);
  assert.equal(verifyEthereumDiscountProof('0x0000000000000000000000000000000000000001', [],
    '0xb5d9d894133a730aa651ef62d26b0ffa846233c74177a591a4a896adfda97d22'), true);
});

test('the published draft proves the explicit wallet and distinguishes an absent wallet from a mismatched root', async () => {
  const proof = await ethereumDiscounts.proof(owner, dataset.root);
  assert.ok(proof);
  assert.equal(verifyEthereumDiscountProof(owner, proof, dataset.root), true);
  assert.equal(await ethereumDiscounts.proof(other, dataset.root), null);
  await assert.rejects(ethereumDiscounts.proof(other, `0x${'12'.repeat(32)}`), /discount list changed/);
});

test('stats requests scope wallet usage and reject another owner, chain, deployment, or malformed discount data', async t => {
  const valid = {
    chainId: config.chainId, contractAddress: config.contractAddress, owner,
    allocatedCrates: 0, warehousesMinted: 0, relicsAllocated: 0, relicsMinted: 0, publicRelicsMinted: 0, artworksMinted: 0, cratePriceWei: config.cratePriceWei,
    warehousePriceWei: config.warehousePriceWei, saleActive: true, remainingCrates: 5555, remainingWarehouses: 505, remainingRelics: 0,
    discountMerkleRoot: dataset.root, discountCratePriceWei: '50000000000000', discountAllowance: 1, discountUsed: 0,
  };
  let value: unknown = valid;
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async input => {
    urls.push(String(input));
    return Response.json(value);
  });
  assert.deepEqual(await ethereumApi.stats(config, owner), valid);
  assert.equal(new URL(urls[0], 'https://mons.shop').searchParams.get('owner'), owner);
  for (const changed of [
    { owner: other }, { owner: null }, { chainId: 31337 }, { contractAddress: other },
    { discountMerkleRoot: '0x1234' }, { discountAllowance: 0 }, { discountAllowance: 11 }, { discountUsed: -1 }, { discountCratePriceWei: '-1' },
    { maxDiscountedMints: 500 }, { totalDiscountedMints: 0 },
    ...[-1, 5556, 0.5, '500', null].map(maxDiscountedMints => ({ maxDiscountedMints, totalDiscountedMints: 0 })),
    ...[-1, 501, 0.5, '1', null].map(totalDiscountedMints => ({ maxDiscountedMints: 500, totalDiscountedMints })),
    { relicsAllocated: -1 }, { relicsAllocated: 19 }, { relicsMinted: 1 }, { remainingRelics: 1 }, { relicsMinted: -1 }, { remainingRelics: -1 },
    { publicRelicsMinted: -1 }, { publicRelicsMinted: 19 }, { publicRelicsMinted: 1 },
    { relicsAllocated: 17, remainingRelics: 17, publicRelicsMinted: 2, allocatedCrates: 2109 },
  ]) {
    value = { ...valid, ...changed };
    await assert.rejects(ethereumApi.stats(config, owner), /invalid response/);
  }
  value = { ...valid, owner: null };
  assert.deepEqual(await ethereumApi.stats(config, null), value);
  assert.equal(new URL(urls.at(-1)!, 'https://mons.shop').searchParams.has('owner'), false);
  value = { ...valid, publicRelicsMinted: undefined };
  assert.deepEqual(await ethereumApi.stats(config, owner), valid);
  value = { ...valid, allocatedCrates: 333, remainingCrates: 5222, remainingWarehouses: 474,
    relicsAllocated: 1, remainingRelics: 1, publicRelicsMinted: 2 };
  assert.deepEqual(await ethereumApi.stats(config, owner), value);
  for (const [maxDiscountedMints, totalDiscountedMints] of [[0, 0], [500, 499], [500, 500], [5555, 5555]]) {
    value = { ...valid, maxDiscountedMints, totalDiscountedMints };
    assert.deepEqual(await ethereumApi.stats(config, owner), value);
  }
  const count = urls.length;
  await assert.rejects(ethereumApi.stats(config, 'invalid'), /invalid response/);
  assert.equal(urls.length, count);
});

test('mint quotes require the full quantity to fit wallet and total discounted allowances', () => {
  const stats = {
    chainId: config.chainId, contractAddress: config.contractAddress!, owner,
    allocatedCrates: 499, warehousesMinted: 0, relicsAllocated: 0, relicsMinted: 0, publicRelicsMinted: 0, artworksMinted: 0,
    cratePriceWei: config.cratePriceWei, warehousePriceWei: config.warehousePriceWei, saleActive: true,
    remainingCrates: 5056, remainingWarehouses: 459, remainingRelics: 0,
    discountMerkleRoot: dataset.root, discountCratePriceWei: '50000000000000', discountAllowance: 3, discountUsed: 0,
  };
  assert.equal(ethereumMintQuote('crate', 3, stats, true).discounted, true);
  const capped = { ...stats, maxDiscountedMints: 500, totalDiscountedMints: 499 };
  assert.equal(ethereumMintQuote('crate', 1, capped, true).discounted, true);
  assert.equal(ethereumMintQuote('crate', 2, capped, true).unitPriceWei, stats.cratePriceWei);
  assert.equal(ethereumMintQuote('crate', 1, { ...capped, totalDiscountedMints: 500 }, true).discounted, false);
  assert.equal(ethereumMintQuote('crate', 1, { ...capped, maxDiscountedMints: 0, totalDiscountedMints: 0 }, true).discounted, false);
  assert.equal(ethereumMintQuote('crate', 1, { ...capped, discountUsed: 3 }, true).discounted, false);
  assert.equal(ethereumMintQuote('warehouse', 1, capped, true).discounted, false);
});
