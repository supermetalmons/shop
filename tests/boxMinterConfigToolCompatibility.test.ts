import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
} from '../functions/src/shared/boxMinterConfigCodec.ts';
import { decodeBoxMinterConfigForDeployPreflight } from '../scripts/deploy-all-onchain.ts';
import { decodeBoxMinterConfigForPriceUpdate } from '../scripts/setMintPrices.ts';
import { decodeStartMintMetadataBase } from '../scripts/startMint.ts';

const NAME_PREFIX_OFFSET =
  8 + 32 * 3 + 8 + 8 + 32 + 4 + 1 + 1 + 4;

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u32LE(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0);
  return result;
}

function u64LE(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function publicKeyBytes(seed: number): Buffer {
  return Buffer.from(
    new PublicKey(
      Uint8Array.from(
        { length: 32 },
        (_, index) => (seed + index) & 0xff,
      ),
    ).toBytes(),
  );
}

function encodeBasicConfig(options: {
  itemsPerBox: number;
  discountMintsPerWallet: number;
  futureExtension?: Uint8Array;
}): Buffer {
  const serialized = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    publicKeyBytes(1),
    publicKeyBytes(33),
    publicKeyBytes(65),
    u64LE(1_000_000_000n),
    u64LE(800_000_000n),
    Buffer.alloc(32, 9),
    u32LE(500),
    u8(15),
    u8(options.itemsPerBox),
    u32LE(7),
    borshString('box'),
    borshString('MONS'),
    borshString('https://assets.example.com/drop'),
    u8(1),
    u8(254),
    u8(options.discountMintsPerWallet),
  ]);
  const padded = Buffer.concat([
    serialized,
    Buffer.alloc(
      Math.max(0, BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - serialized.length),
    ),
  ]);
  if (!options.futureExtension) return padded;
  return Buffer.concat([
    padded,
    Buffer.from(options.futureExtension),
    Buffer.alloc(
      Math.max(
        0,
        BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED -
          padded.length -
          options.futureExtension.length,
      ),
    ),
  ]);
}

function encodeLegacyFixedConfig(uriBase: string): Buffer {
  const serialized = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    publicKeyBytes(1),
    publicKeyBytes(33),
    publicKeyBytes(65),
    u64LE(1_000_000_000n),
    u64LE(800_000_000n),
    Buffer.alloc(32, 9),
    u32LE(500),
    u8(15),
    u32LE(7),
    borshString('box'),
    borshString('MONS'),
    borshString(uriBase),
    u8(1),
    u8(254),
  ]);
  return Buffer.concat([
    serialized,
    Buffer.alloc(
      Math.max(0, BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - 1 - serialized.length),
    ),
  ]);
}

function configWithUriLengthAt(
  uriLengthOffset: number,
  dataLength = BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS,
): Buffer {
  const namePrefixLength = uriLengthOffset - NAME_PREFIX_OFFSET - 8;
  assert.ok(namePrefixLength >= 0);
  const data = Buffer.alloc(dataLength);
  Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR).copy(data);
  data[NAME_PREFIX_OFFSET - 5] = 3;
  data.writeUInt32LE(namePrefixLength, NAME_PREFIX_OFFSET);
  data.writeUInt32LE(0, NAME_PREFIX_OFFSET + 4 + namePrefixLength);
  return data;
}

function assertConfigTruncated(
  decode: () => unknown,
  expectedMinBytes: number,
  actualBytes: number,
): void {
  assert.throws(
    decode,
    (error) =>
      error instanceof BoxMinterConfigCodecError &&
      error.reason === 'config-truncated' &&
      error.details?.expectedMinBytes === expectedMinBytes &&
      error.details.actualBytes === actualBytes,
  );
}

test('tool config decoders retain basic-layout policy for arbitrary item and discount bytes', () => {
  const data = encodeBasicConfig({
    itemsPerBox: 255,
    discountMintsPerWallet: 7,
  });

  const priceUpdate = decodeBoxMinterConfigForPriceUpdate(data);
  const deployPreflight = decodeBoxMinterConfigForDeployPreflight(data);
  assert.equal(priceUpdate.itemsPerBox, 255);
  assert.equal(deployPreflight.itemsPerBox, 255);
  assert.equal(priceUpdate.discountMintsPerWallet, 7);
  assert.equal(deployPreflight.discountMintsPerWallet, 1);

  assert.throws(
    () => decodeBoxMinterConfigData(data),
    (error) =>
      error instanceof BoxMinterConfigCodecError &&
      error.reason === 'invalid-items-per-box',
  );
});

test('start-mint accepts legacy fixed configs and canonicalizes their metadata base', () => {
  const metadataBase = 'https://assets.example.com/drops/legacy';
  assert.equal(
    decodeStartMintMetadataBase(
      encodeLegacyFixedConfig(`${metadataBase}/json/boxes/`),
    ),
    metadataBase,
  );
});

test('shared and start-mint decoders reject truncated metadata strings and required trailing fields', () => {
  const truncatedLength = configWithUriLengthAt(
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - 2,
  );
  for (const decode of [
    () => decodeBoxMinterConfigData(truncatedLength),
    () => decodeStartMintMetadataBase(truncatedLength),
  ]) {
    assertConfigTruncated(
      decode,
      truncatedLength.length + 2,
      truncatedLength.length,
    );
  }

  const metadataBase = Buffer.from('https://x.test/a');
  const uriLengthOffset =
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS - 4 - metadataBase.length;
  const truncatedBytes = configWithUriLengthAt(uriLengthOffset);
  truncatedBytes.writeUInt32LE(metadataBase.length + 1, uriLengthOffset);
  metadataBase.copy(truncatedBytes, uriLengthOffset + 4);
  for (const decode of [
    () => decodeBoxMinterConfigData(truncatedBytes),
    () => decodeStartMintMetadataBase(truncatedBytes),
  ]) {
    assertConfigTruncated(
      decode,
      truncatedBytes.length + 1,
      truncatedBytes.length,
    );
  }

  const missingRequiredFields = configWithUriLengthAt(uriLengthOffset);
  missingRequiredFields.writeUInt32LE(metadataBase.length, uriLengthOffset);
  metadataBase.copy(missingRequiredFields, uriLengthOffset + 4);
  for (const decode of [
    () => decodeBoxMinterConfigData(missingRequiredFields),
    () => decodeStartMintMetadataBase(missingRequiredFields),
  ]) {
    assertConfigTruncated(
      decode,
      missingRequiredFields.length + 2,
      missingRequiredFields.length,
    );
  }
});

test('strict decoding rejects truncated schema-signaled extensions while tooling can ignore them', () => {
  const metadataBase = Buffer.from('https://x.test/a');
  const missingDiscountLength = BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS + 1;
  const discountUriLengthOffset =
    missingDiscountLength - 2 - 4 - metadataBase.length;
  const missingDiscount = configWithUriLengthAt(
    discountUriLengthOffset,
    missingDiscountLength,
  );
  missingDiscount.writeUInt32LE(
    metadataBase.length,
    discountUriLengthOffset,
  );
  metadataBase.copy(missingDiscount, discountUriLengthOffset + 4);
  assertConfigTruncated(
    () => decodeBoxMinterConfigData(missingDiscount),
    missingDiscount.length + 1,
    missingDiscount.length,
  );
  assert.equal(
    decodeStartMintMetadataBase(missingDiscount),
    metadataBase.toString('utf8'),
  );

  const figurePrefixLength = BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS + 17;
  const truncatedFigurePrefix = configWithUriLengthAt(
    figurePrefixLength - 9,
    figurePrefixLength,
  );
  assertConfigTruncated(
    () => decodeBoxMinterConfigData(truncatedFigurePrefix),
    truncatedFigurePrefix.length + 2,
    truncatedFigurePrefix.length,
  );
});

test('tool config decoders ignore unknown trailing extension bytes while strict decoding rejects them', () => {
  const data = encodeBasicConfig({
    itemsPerBox: 3,
    discountMintsPerWallet: 2,
    futureExtension: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
  });

  for (const decoded of [
    decodeBoxMinterConfigForPriceUpdate(data),
    decodeBoxMinterConfigForDeployPreflight(data),
  ]) {
    assert.equal(decoded.itemsPerBox, 3);
    assert.equal(decoded.discountMintsPerWallet, 2);
    assert.equal(decoded.figureNamePrefix, 'figure');
    assert.equal(decoded.mintVariantKind, 0);
    assert.equal(decoded.dropSeed, undefined);
  }

  assert.throws(
    () => decodeBoxMinterConfigData(data),
    (error) => error instanceof BoxMinterConfigCodecError,
  );
});

test('set-mint-prices retains explicit malformed base-string errors', () => {
  const truncatedLength = Buffer.alloc(
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS,
  );
  Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR).copy(truncatedLength);
  truncatedLength.writeUInt32LE(120, NAME_PREFIX_OFFSET);
  truncatedLength.writeUInt32LE(0, NAME_PREFIX_OFFSET + 4 + 120);
  assert.throws(
    () => decodeBoxMinterConfigForPriceUpdate(truncatedLength),
    {
      message:
        'Unsupported box minter config schema while decoding string length.',
    },
  );

  const truncatedBytes = Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS);
  Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR).copy(truncatedBytes);
  truncatedBytes.writeUInt32LE(125, NAME_PREFIX_OFFSET);
  assert.throws(
    () => decodeBoxMinterConfigForPriceUpdate(truncatedBytes),
    {
      message:
        'Unsupported box minter config schema while decoding string bytes.',
    },
  );
});
