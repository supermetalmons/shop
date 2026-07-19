import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import {
  ADDRESS_CIPHER_NONCE_LENGTH,
  ADDRESS_CIPHER_PUBLIC_KEY_LENGTH,
  addressCipherHint,
  decryptAddressCipherText,
  encryptAddressCipherText,
  parseAddressCipherPayload,
  serializeAddressCipherPayload,
  type AddressCipherParts,
} from '../functions/src/shared/addressCipher.ts';
import { encryptAddressPayload } from '../src/lib/solana.ts';

const encodeBase64 = (value: Uint8Array) =>
  Buffer.from(value).toString('base64');

const decodeBase64 = (value: string) => Buffer.from(value, 'base64');

test('address cipher round-trips UTF-8 text through the canonical wire payload', () => {
  const recipient = nacl.box.keyPair();
  const plaintext = 'İstanbul 🚚 / 12 Example Street';
  const parts = encryptAddressCipherText(plaintext, recipient.publicKey);
  const payload = serializeAddressCipherPayload(parts, encodeBase64);
  const parsed = parseAddressCipherPayload(payload, decodeBase64);

  assert.ok(parsed);
  assert.equal(
    decryptAddressCipherText(parsed, recipient.secretKey),
    plaintext,
  );
});

test('address cipher serialization has deterministic nonce, public-key, ciphertext order', () => {
  const recipient = nacl.box.keyPair.fromSecretKey(
    new Uint8Array(nacl.box.secretKeyLength).fill(3),
  );
  const ephemeral = nacl.box.keyPair.fromSecretKey(
    new Uint8Array(nacl.box.secretKeyLength).fill(7),
  );
  const nonce = Uint8Array.from(
    { length: ADDRESS_CIPHER_NONCE_LENGTH },
    (_, index) => index,
  );
  const plaintext = 'Deterministic address';
  const parts = encryptAddressCipherText(plaintext, recipient.publicKey, {
    createEphemeralKeyPair: () => ephemeral,
    randomBytes: (length) => {
      assert.equal(length, ADDRESS_CIPHER_NONCE_LENGTH);
      return nonce;
    },
  });
  const expectedCiphertext = nacl.box(
    new TextEncoder().encode(plaintext),
    nonce,
    recipient.publicKey,
    ephemeral.secretKey,
  );

  assert.equal(
    serializeAddressCipherPayload(parts, encodeBase64),
    [
      encodeBase64(nonce),
      encodeBase64(ephemeral.publicKey),
      encodeBase64(expectedCiphertext),
    ].join('.'),
  );
});

test('address cipher parsing rejects malformed parts and decoder failures', () => {
  const validNonce = encodeBase64(
    new Uint8Array(ADDRESS_CIPHER_NONCE_LENGTH),
  );
  const validPublicKey = encodeBase64(
    new Uint8Array(ADDRESS_CIPHER_PUBLIC_KEY_LENGTH),
  );
  const ciphertext = encodeBase64(new Uint8Array([1]));

  for (const payload of [
    '',
    '   ',
    `${validNonce}.${validPublicKey}`,
    `${validNonce}.${validPublicKey}.${ciphertext}.extra`,
    `.${validPublicKey}.${ciphertext}`,
    `${validNonce}..${ciphertext}`,
    `${validNonce}.${validPublicKey}.`,
    `${encodeBase64(new Uint8Array(23))}.${validPublicKey}.${ciphertext}`,
    `${validNonce}.${encodeBase64(new Uint8Array(31))}.${ciphertext}`,
  ]) {
    assert.equal(parseAddressCipherPayload(payload, decodeBase64), null);
  }

  assert.equal(
    parseAddressCipherPayload(
      `${validNonce}.${validPublicKey}.${ciphertext}`,
      () => {
        throw new Error('decode failed');
      },
    ),
    null,
  );
});

test('address cipher decryption returns null for wrong keys and nonces', () => {
  const recipient = nacl.box.keyPair();
  const otherRecipient = nacl.box.keyPair();
  const parts = encryptAddressCipherText('secret address', recipient.publicKey);

  assert.equal(
    decryptAddressCipherText(parts, otherRecipient.secretKey),
    null,
  );

  const wrongNonce = Uint8Array.from(parts.nonce);
  wrongNonce[0] ^= 0xff;
  const wrongNonceParts: AddressCipherParts = {
    ...parts,
    nonce: wrongNonce,
  };
  assert.equal(
    decryptAddressCipherText(wrongNonceParts, recipient.secretKey),
    null,
  );
  assert.equal(
    decryptAddressCipherText(parts, new Uint8Array(1)),
    null,
  );
});

test('address cipher hints preserve empty and short plaintext behavior', () => {
  assert.equal(addressCipherHint(''), '...');
  assert.equal(addressCipherHint('A'), 'A...A');
  assert.equal(addressCipherHint('AB'), 'A...AB');
  assert.equal(addressCipherHint('ABC'), 'A...BC');
});

test('frontend address encryption preserves its adapter shape and diagnostics', () => {
  const recipient = nacl.box.keyPair();
  const publicKey = encodeBase64(recipient.publicKey);
  const plaintext = 'Bosphorus Avenue 12';
  const encrypted = encryptAddressPayload(plaintext, ` \n${publicKey}\t `);
  const parsed = parseAddressCipherPayload(
    encrypted.cipherText,
    decodeBase64,
  );

  assert.deepEqual(Object.keys(encrypted).sort(), ['cipherText', 'hint']);
  assert.equal(encrypted.hint, 'B...12');
  assert.ok(parsed);
  assert.equal(
    decryptAddressCipherText(parsed, recipient.secretKey),
    plaintext,
  );

  assert.throws(
    () => encryptAddressPayload(plaintext, ' \n '),
    {
      message:
        'Missing address encryption public key (set `ADDRESS_ENCRYPTION_PUBLIC_KEY` in src/App.tsx)',
    },
  );

  const base58LookingKey = '11111111111111111111111111111111';
  assert.throws(
    () => encryptAddressPayload(plaintext, base58LookingKey),
    {
      message:
        'Invalid address encryption public key: expected base64 Curve25519 public key (32 bytes), got 24 bytes after base64 decode. It looks like you pasted a base58 Solana address. This must be a TweetNaCl box (Curve25519) public key encoded in base64.',
    },
  );
  assert.throws(
    () => encryptAddressPayload(plaintext, '%'),
    {
      message:
        'Invalid address encryption public key: expected base64 Curve25519 public key (32 bytes), got 0 bytes after base64 decode.',
    },
  );
});
