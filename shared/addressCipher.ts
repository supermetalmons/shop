import nacl from 'tweetnacl';

export const ADDRESS_CIPHER_NONCE_LENGTH = nacl.box.nonceLength;
export const ADDRESS_CIPHER_PUBLIC_KEY_LENGTH = nacl.box.publicKeyLength;
export const ADDRESS_CIPHER_SECRET_KEY_LENGTH = nacl.box.secretKeyLength;

export type AddressCipherParts = Readonly<{
  nonce: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  ciphertext: Uint8Array;
}>;

export type AddressCipherBase64Encoder = (value: Uint8Array) => string;
export type AddressCipherBase64Decoder = (value: string) => Uint8Array | null;

type AddressCipherKeyPair = Readonly<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}>;

export type AddressCipherEncryptDependencies = Readonly<{
  createEphemeralKeyPair?: () => AddressCipherKeyPair;
  randomBytes?: (length: number) => Uint8Array;
}>;

export function addressCipherHint(plaintext: string): string {
  return plaintext.slice(0, 1) + '...' + plaintext.slice(-2);
}

export function encryptAddressCipherText(
  plaintext: string,
  recipientPublicKey: Uint8Array,
  dependencies: AddressCipherEncryptDependencies = {},
): AddressCipherParts {
  const ephemeral =
    dependencies.createEphemeralKeyPair?.() ?? nacl.box.keyPair();
  const nonce =
    dependencies.randomBytes?.(ADDRESS_CIPHER_NONCE_LENGTH) ??
    nacl.randomBytes(ADDRESS_CIPHER_NONCE_LENGTH);
  const message = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.box(
    message,
    nonce,
    recipientPublicKey,
    ephemeral.secretKey,
  );
  return {
    nonce,
    ephemeralPublicKey: ephemeral.publicKey,
    ciphertext,
  };
}

export function decryptAddressCipherText(
  parts: AddressCipherParts,
  recipientSecretKey: Uint8Array,
): string | null {
  try {
    const opened = nacl.box.open(
      parts.ciphertext,
      parts.nonce,
      parts.ephemeralPublicKey,
      recipientSecretKey,
    );
    if (!opened) return null;
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

export function serializeAddressCipherPayload(
  parts: AddressCipherParts,
  encodeBase64: AddressCipherBase64Encoder,
): string {
  return [
    encodeBase64(parts.nonce),
    encodeBase64(parts.ephemeralPublicKey),
    encodeBase64(parts.ciphertext),
  ].join('.');
}

export function parseAddressCipherPayload(
  payload: string,
  decodeBase64: AddressCipherBase64Decoder,
): AddressCipherParts | null {
  try {
    const raw = (payload || '').trim();
    if (!raw) return null;
    const encodedParts = raw.split('.');
    if (encodedParts.length !== 3 || encodedParts.some((part) => !part)) {
      return null;
    }
    const [nonceRaw, ephemeralPublicKeyRaw, ciphertextRaw] = encodedParts;
    const nonce = decodeBase64(nonceRaw);
    const ephemeralPublicKey = decodeBase64(ephemeralPublicKeyRaw);
    const ciphertext = decodeBase64(ciphertextRaw);
    if (!nonce || !ephemeralPublicKey || !ciphertext) return null;
    if (
      nonce.length !== ADDRESS_CIPHER_NONCE_LENGTH ||
      ephemeralPublicKey.length !== ADDRESS_CIPHER_PUBLIC_KEY_LENGTH
    ) {
      return null;
    }
    return { nonce, ephemeralPublicKey, ciphertext };
  } catch {
    return null;
  }
}
