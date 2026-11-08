import assert from 'node:assert/strict';
import { decode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';

const legacyReservation = Object.freeze({ quantity: 18, valueWei: '18000000000000000' });

export function parseRelicReservation(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'quantity,valueWei', 'Invalid relic reservation configuration');
  assert.ok(Number.isSafeInteger(value.quantity) && value.quantity >= 0 && value.quantity <= 18,
    'Relic reservation quantity must be an integer from 0 to 18');
  assert.ok(typeof value.valueWei === 'string' && /^(0|[1-9][0-9]*)$/.test(value.valueWei) &&
    BigInt(value.valueWei) < (1n << 256n), 'Relic reservation value must be a decimal uint256 string');
  assert.ok(value.quantity !== 0 || value.valueWei === '0', 'A zero relic reservation must have zero value');
  return { quantity: value.quantity, valueWei: value.valueWei };
}

export function relicReservation(manifest) {
  return Object.hasOwn(manifest, 'relicReservation') ? parseRelicReservation(manifest.relicReservation) : { ...legacyReservation };
}

export function validateRelicReservationSkip(manifest, record) {
  assert.equal(relicReservation(manifest).quantity, 0, 'Only zero relic reservations may be skipped');
  assert.ok(record && typeof record === 'object' && !Array.isArray(record), 'Missing zero relic reservation verification');
  assert.equal(record.action, 'reserve', 'Reservation skip action changed');
  assert.equal(record.skipped, true, 'Reservation skip is not verified');
  assert.equal(record.chainId, manifest.chainId, 'Reservation skip chain changed');
  assert.equal(record.contractAddress, manifest.contractAddress, 'Reservation skip collection changed');
  assert.match(record.blockHash, /^0x[0-9a-f]{64}$/i, 'Invalid reservation skip block hash');
  assert.match(record.blockNumber, /^0x[0-9a-f]+$/i, 'Invalid reservation skip block number');
  assert.equal(record.raw, undefined, 'A reservation skip cannot contain a transaction');
  assert.equal(record.nonce, undefined, 'A reservation skip cannot consume a nonce');
}

export async function verifyRelicReservationSkip(manifest, record, rpc) {
  validateRelicReservationSkip(manifest, record);
  const block = await rpc('eth_getBlockByNumber', [record.blockNumber, false]);
  assert.equal(block?.hash, record.blockHash, 'Reservation skip block is no longer canonical');
  assert.equal(BigInt(block.number), BigInt(record.blockNumber), 'Reservation skip block number changed');
  const reference = { blockHash: record.blockHash, requireCanonical: true };
  // Reserved supply never decreases; opening and public mints may share this block.
  const signature = 'relicsAllocated()';
  const data = `0x${Buffer.from(keccak_256(Buffer.from(signature))).subarray(0, 4).toString('hex')}`;
  const [value] = decode(['uint256'], await rpc('eth_call', [{ to: manifest.contractAddress, data }, reference]));
  assert.equal(value, 0n, `Zero reservation precondition changed: ${signature}`);
  assert.equal((await rpc('eth_getBlockByNumber', [record.blockNumber, false]))?.hash, record.blockHash,
    'Reservation skip block is no longer canonical');
}
