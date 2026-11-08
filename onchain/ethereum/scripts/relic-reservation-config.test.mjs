import assert from 'node:assert/strict';
import test from 'node:test';
import { encode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { parseRelicReservation, relicReservation, validateRelicReservationSkip, verifyRelicReservationSkip } from './relic-reservation-config.mjs';

const manifest = { chainId: 11155111, contractAddress: `0x${'ab'.repeat(20)}`, relicReservation: { quantity: 0, valueWei: '0' } };
const skip = { action: 'reserve', skipped: true, chainId: manifest.chainId, contractAddress: manifest.contractAddress,
  blockNumber: '0xa', blockHash: `0x${'12'.repeat(32)}` };
const saleSelector = `0x${Buffer.from(keccak_256(Buffer.from('saleActive()'))).subarray(0, 4).toString('hex')}`;
const allocationSelector = `0x${Buffer.from(keccak_256(Buffer.from('relicsAllocated()'))).subarray(0, 4).toString('hex')}`;

test('legacy reservation defaults remain immutable while explicit quantities and deposits are validated', () => {
  assert.deepEqual(relicReservation({}), { quantity: 18, valueWei: '18000000000000000' });
  const changed = relicReservation({}); changed.quantity = 0;
  assert.equal(relicReservation({}).quantity, 18);
  for (const quantity of [0, 1, 10, 18]) assert.deepEqual(parseRelicReservation({ quantity, valueWei: '0' }), { quantity, valueWei: '0' });
  assert.deepEqual(relicReservation({ relicReservation: { quantity: 3, valueWei: '55' } }), { quantity: 3, valueWei: '55' });
  for (const value of [null, {}, { quantity: 0, valueWei: '1' }, { quantity: -1, valueWei: '0' }, { quantity: 19, valueWei: '0' },
    { quantity: 1.5, valueWei: '0' }, { quantity: '1', valueWei: '0' }, { quantity: 1, valueWei: 0 }, { quantity: 1, valueWei: '01' },
    { quantity: 1, valueWei: (1n << 256n).toString() }, { quantity: 1, valueWei: '0', extra: true }]) {
    assert.throws(() => parseRelicReservation(value));
  }
});

test('zero reservation skips cannot impersonate signed transactions or another release', () => {
  validateRelicReservationSkip(manifest, skip);
  for (const invalid of [undefined, { ...skip, skipped: false }, { ...skip, action: 'open' }, { ...skip, chainId: 1 },
    { ...skip, contractAddress: `0x${'cd'.repeat(20)}` }, { ...skip, blockHash: '0x0' }, { ...skip, blockNumber: '10' },
    { ...skip, raw: '0x01' }, { ...skip, nonce: '0' }]) assert.throws(() => validateRelicReservationSkip(manifest, invalid));
  assert.throws(() => validateRelicReservationSkip({ ...manifest, relicReservation: { quantity: 1, valueWei: '0' } }, skip));
});

test('zero reservation verification pins unallocated relic supply to a canonical block', async () => {
  let reads = 0;
  const rpc = async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { number: skip.blockNumber, hash: skip.blockHash };
    assert.equal(method, 'eth_call');
    assert.equal(params[0].to, manifest.contractAddress);
    assert.deepEqual(params[1], { blockHash: skip.blockHash, requireCanonical: true });
    reads++;
    return `0x${Buffer.from(encode([params[0].data === saleSelector ? 'bool' : 'uint256'], [params[0].data === saleSelector ? false : 0n])).toString('hex')}`;
  };
  await verifyRelicReservationSkip(manifest, skip, rpc);
  assert.equal(reads, 1);
  await assert.rejects(verifyRelicReservationSkip(manifest, skip, async (method, params) => method === 'eth_call'
    ? `0x${Buffer.from(encode(['uint256'], [1n])).toString('hex')}` : rpc(method, params)), /precondition/);
  await assert.rejects(verifyRelicReservationSkip(manifest, skip, async (method, params) => method === 'eth_getBlockByNumber'
    ? { number: skip.blockNumber, hash: `0x${'34'.repeat(32)}` } : rpc(method, params)), /canonical/);
});

test('zero reservation verification permits sale opening and public activity in the same block', async () => {
  const reads = [];
  await verifyRelicReservationSkip(manifest, skip, async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { number: skip.blockNumber, hash: skip.blockHash };
    assert.equal(method, 'eth_call');
    assert.equal(params[0].to, manifest.contractAddress);
    assert.deepEqual(params[1], { blockHash: skip.blockHash, requireCanonical: true });
    reads.push(params[0].data);
    const type = params[0].data === saleSelector ? 'bool' : 'uint256';
    const value = params[0].data === saleSelector ? true : params[0].data === allocationSelector ? 0n : 111n;
    return `0x${Buffer.from(encode([type], [value])).toString('hex')}`;
  });
  assert.deepEqual(reads, [allocationSelector]);
});
