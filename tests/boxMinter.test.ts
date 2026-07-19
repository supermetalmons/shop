import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  assertBoxMinterConfigMatchesDropConfig,
  boxAssetPda,
  boxMinterConfigPda,
  decodeBoxMinterConfigAccount,
  discountMintRecordPda,
} from '../src/lib/boxMinter.ts';

const ACCOUNT_BOX_MINTER_CONFIG = Uint8Array.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]);
const LEGACY_FIXED_ITEMS_CONFIG_SIZE = 289;

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function pubkey(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff));
}

function u32Tuple(values: [number, number, number]): Buffer {
  return Buffer.concat(values.map((value) => u32LE(value)));
}

function encodeConfigAccount(dropSeed?: Uint8Array): Buffer {
  const maxLenName = 'hoodie01';
  const maxLenSymbol = 'monsshop10';
  const maxLenUriBase = `https://assets.example.com/drops/${'x'.repeat(63)}`;
  return Buffer.concat([
    Buffer.from(ACCOUNT_BOX_MINTER_CONFIG),
    pubkey(1).toBuffer(),
    pubkey(2).toBuffer(),
    pubkey(3).toBuffer(),
    u64LE(1_000_000n),
    u64LE(500_000n),
    Buffer.alloc(32, 9),
    u32LE(34),
    Buffer.from([15]),
    Buffer.from([0]),
    u32LE(7),
    borshString(maxLenName),
    borshString(maxLenSymbol),
    borshString(maxLenUriBase),
    Buffer.from([1]),
    Buffer.from([254]),
    Buffer.from([2]),
    borshString('figure'),
    Buffer.from([1]),
    u32Tuple([1, 16, 31]),
    u32Tuple([15, 30, 34]),
    u32Tuple([1, 16, 31]),
    ...(dropSeed ? [Buffer.from(dropSeed)] : []),
  ]);
}

function padToAccountSize(data: Buffer, size: number): Buffer {
  assert.ok(data.length <= size, `fixture exceeds account size: ${data.length} > ${size}`);
  return Buffer.concat([data, Buffer.alloc(size - data.length)]);
}

function encodeLegacyFixedItemsConfigAccount(): Buffer {
  return padToAccountSize(
    Buffer.concat([
      Buffer.from(ACCOUNT_BOX_MINTER_CONFIG),
      pubkey(1).toBuffer(),
      pubkey(2).toBuffer(),
      pubkey(3).toBuffer(),
      u64LE(1_000_000n),
      u64LE(500_000n),
      Buffer.alloc(32, 9),
      u32LE(333),
      Buffer.from([15]),
      u32LE(7),
      borshString('box'),
      borshString('box'),
      borshString('https://assets.example.com/drops/lsb/json/boxes/'),
      Buffer.from([1]),
      Buffer.from([254]),
    ]),
    LEGACY_FIXED_ITEMS_CONFIG_SIZE,
  );
}

function withZeroPadding(data: Buffer, paddingBytes = 64): Buffer {
  return Buffer.concat([data, Buffer.alloc(Math.max(0, paddingBytes))]);
}

test('decodeBoxMinterConfigAccount handles legacy and v2 schemas', () => {
  const accountPubkey = pubkey(99);
  const legacy = decodeBoxMinterConfigAccount(accountPubkey, withZeroPadding(encodeConfigAccount()));
  assert.equal(legacy.dropSeed, undefined);

  const dropSeed = Uint8Array.from({ length: 32 }, (_, index) => (index + 17) & 0xff);
  const v2 = decodeBoxMinterConfigAccount(accountPubkey, withZeroPadding(encodeConfigAccount(dropSeed)));
  assert.deepEqual(Array.from(v2.dropSeed || []), Array.from(dropSeed));
});

test('decodeBoxMinterConfigAccount handles pre-items fixed-3 legacy schema', () => {
  const legacy = decodeBoxMinterConfigAccount(pubkey(100), encodeLegacyFixedItemsConfigAccount());
  assert.equal(legacy.itemsPerBox, 3);
  assert.equal(legacy.discountMintsPerWallet, 1);
  assert.equal(legacy.figureNamePrefix, 'figure');
  assert.equal(legacy.minted, 7);
  assert.equal(legacy.maxSupply, 333);
  assert.equal(legacy.maxPerTx, 15);
  assert.equal(legacy.namePrefix, 'box');
  assert.equal(legacy.uriBase, 'https://assets.example.com/drops/lsb/json/boxes/');
  assert.equal(legacy.dropSeed, undefined);
  assert.equal(legacy.mintVariantKind, 0);
  assert.doesNotThrow(() =>
    assertBoxMinterConfigMatchesDropConfig(legacy, {
      metadataBase: 'https://assets.example.com/drops/lsb',
    } as any),
  );
});

test('boxMinterConfigPda uses drop seed when provided', () => {
  const programId = pubkey(20);
  const dropSeedA = Uint8Array.from({ length: 32 }, (_, index) => index);
  const dropSeedB = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const [configA] = boxMinterConfigPda(programId, dropSeedA);
  const [configB] = boxMinterConfigPda(programId, dropSeedB);
  assert.notDeepEqual(configA.toBuffer(), configB.toBuffer());
});

test('v2 box and discount PDAs differ for drops sharing one program id', () => {
  const programId = pubkey(30);
  const payer = pubkey(31);
  const mintId = 42n;
  const cfgA = { pubkey: pubkey(40), dropSeed: Uint8Array.from({ length: 32 }, () => 1) };
  const cfgB = { pubkey: pubkey(41), dropSeed: Uint8Array.from({ length: 32 }, () => 2) };

  const [boxA] = boxAssetPda(payer, mintId, 0, programId, cfgA);
  const [boxB] = boxAssetPda(payer, mintId, 0, programId, cfgB);
  assert.notDeepEqual(boxA.toBuffer(), boxB.toBuffer());

  const [discountA] = discountMintRecordPda(payer, programId, cfgA);
  const [discountB] = discountMintRecordPda(payer, programId, cfgB);
  assert.notDeepEqual(discountA.toBuffer(), discountB.toBuffer());
});

test('legacy singleton configs keep legacy box and discount PDAs even with padded account data', () => {
  const programId = pubkey(50);
  const payer = pubkey(51);
  const mintId = 77n;
  const [legacyConfigPda] = boxMinterConfigPda(programId);
  const legacyCfg = decodeBoxMinterConfigAccount(legacyConfigPda, withZeroPadding(encodeConfigAccount(), 96));

  const [expectedLegacyBox] = boxAssetPda(payer, mintId, 0, programId);
  const [derivedLegacyBox] = boxAssetPda(payer, mintId, 0, programId, legacyCfg);
  assert.deepEqual(derivedLegacyBox.toBuffer(), expectedLegacyBox.toBuffer());

  const [expectedLegacyDiscount] = discountMintRecordPda(payer, programId);
  const [derivedLegacyDiscount] = discountMintRecordPda(payer, programId, legacyCfg);
  assert.deepEqual(derivedLegacyDiscount.toBuffer(), expectedLegacyDiscount.toBuffer());
});

test('singleton config PDA remains authoritative even if a caller passes a bogus dropSeed', () => {
  const programId = pubkey(60);
  const payer = pubkey(61);
  const mintId = 91n;
  const [legacyConfigPda] = boxMinterConfigPda(programId);
  const legacyLikeCfg = {
    pubkey: legacyConfigPda,
    dropSeed: Uint8Array.from({ length: 32 }, (_, index) => (index + 1) & 0xff),
  };

  const [expectedLegacyBox] = boxAssetPda(payer, mintId, 0, programId);
  const [derivedLegacyBox] = boxAssetPda(payer, mintId, 0, programId, legacyLikeCfg);
  assert.deepEqual(derivedLegacyBox.toBuffer(), expectedLegacyBox.toBuffer());

  const [expectedLegacyDiscount] = discountMintRecordPda(payer, programId);
  const [derivedLegacyDiscount] = discountMintRecordPda(payer, programId, legacyLikeCfg);
  assert.deepEqual(derivedLegacyDiscount.toBuffer(), expectedLegacyDiscount.toBuffer());
});

test('assertBoxMinterConfigMatchesDropConfig rejects stale collection or metadata base', () => {
  const cfg = {
    coreCollection: pubkey(70),
    uriBase: 'https://assets.example.com/drops/shared/',
  };

  assert.doesNotThrow(() =>
    assertBoxMinterConfigMatchesDropConfig(cfg, {
      collectionMint: pubkey(70).toBase58(),
      metadataBase: 'https://assets.example.com/drops/shared',
    } as any),
  );

  assert.throws(
    () =>
      assertBoxMinterConfigMatchesDropConfig(cfg, {
        collectionMint: pubkey(71).toBase58(),
        metadataBase: 'https://assets.example.com/drops/shared',
      } as any),
    /collection mint/i,
  );

  assert.throws(
    () =>
      assertBoxMinterConfigMatchesDropConfig(cfg, {
        collectionMint: pubkey(70).toBase58(),
        metadataBase: 'https://assets.example.com/drops/other',
      } as any),
    /metadata base/i,
  );
});
