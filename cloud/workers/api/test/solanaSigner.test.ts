import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { decodeSolanaSigner } from '../src/solanaSigner.ts';

test('Solana signer decoding preserves the key and accepts surrounding whitespace', () => {
  const expected = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const signer = decodeSolanaSigner(` \n${bs58.encode(expected.secretKey)}\t`, () => assert.fail('valid signer rejected'));
  assert.equal(signer.publicKey.toBase58(), expected.publicKey.toBase58());
  assert.deepEqual(signer.secretKey, expected.secretKey);
});

for (const [name, secret, kind] of [
  ['empty', '', 'length'],
  ['invalid base58', 'not-a-base58-key', 'encoding'],
  ['32-byte seed', bs58.encode(new Uint8Array(32).fill(1)), 'length'],
  ['short key', bs58.encode(new Uint8Array(63).fill(1)), 'length'],
  ['long key', bs58.encode(new Uint8Array(65).fill(1)), 'length'],
  ['invalid 64-byte key', bs58.encode(new Uint8Array(64).fill(1)), 'key-validation'],
]) {
  test(`Solana signer decoding maps ${name} to the caller's error`, () => {
    const expected = new Error('Signing is unavailable.');
    assert.throws(() => decodeSolanaSigner(secret, failure => {
      assert.equal(failure.kind, kind);
      if (failure.kind === 'length') assert.equal(failure.length, bs58.decode(secret).length);
      else assert(failure.cause instanceof Error);
      return expected;
    }), (error) => error === expected);
  });
}
