import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  decodeDeliverInstruction,
  deriveDeliveryAddress,
  encodeDeliverInstruction,
  hasDeliverDiscriminator,
} from '../src/deliveryProtocol.ts';

test('deliver instruction retains the Anchor discriminator and u32/u64/u8 wire layout', () => {
  const data = Buffer.from('fa83de39d3e5d193785634120807060504030201fe', 'hex');
  assert.deepEqual(encodeDeliverInstruction(0x12345678, 0x0102030405060708n, 254), data);
  assert.deepEqual(decodeDeliverInstruction(data), {
    deliveryId: 0x12345678,
    feeLamports: 0x0102030405060708n,
    deliveryBump: 254,
  });
  assert.equal(encodeDeliverInstruction(7, 0n, 255).toString('hex'),
    'fa83de39d3e5d193070000000000000000000000ff');
});

test('deliver decoding preserves discriminator-only matching and trailing-byte compatibility', () => {
  const data = Buffer.from('fa83de39d3e5d193ffffffffffffffffffffffffff', 'hex');
  for (let length = 0; length < data.length; length += 1) {
    const truncated = data.subarray(0, length);
    assert.equal(hasDeliverDiscriminator(truncated), length >= 8);
    assert.equal(decodeDeliverInstruction(truncated), null);
  }
  const expected = { deliveryId: 0xffff_ffff, feeLamports: 0xffff_ffff_ffff_ffffn, deliveryBump: 255 };
  assert.deepEqual(decodeDeliverInstruction(data), expected);
  assert.deepEqual(decodeDeliverInstruction(Buffer.concat([data, Buffer.from([1, 2])])), expected);
  const unrelated = Buffer.from(data);
  unrelated[0] ^= 1;
  assert.equal(hasDeliverDiscriminator(unrelated), false);
  assert.equal(decodeDeliverInstruction(unrelated), null);
});

test('delivery addresses retain legacy singleton and config-scoped seeds', () => {
  for (const [config, expectedAddress, expectedBump] of [
    ['bJV4vxUzyGExGeMnUdGrBCnBzqcQqBZbSq5hG2mH7Mt', 'GYUzFVDJY6p6UhPCcSadsnSSDvDzg16Sc4dHR4NWLKYS', 255],
    ['4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw', '7UibMyUUbdb3EUTy7x1JEkGjNrnTALyqEyJf2s2qXMrF', 254],
  ] as const) {
    const [address, bump] = deriveDeliveryAddress({
      boxMinterProgramId: PublicKey.default,
      boxMinterConfigPda: new PublicKey(config),
    }, 0x12345678);
    assert.equal(address.toBase58(), expectedAddress);
    assert.equal(bump, expectedBump);
  }
});
