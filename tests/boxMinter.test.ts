import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PublicKey,
  type Connection,
  type VersionedTransaction,
} from '@solana/web3.js';
import {
  assertBoxMinterConfigMatchesDropConfig,
  boxAssetPda,
  boxMinterConfigPda,
  buildMintBoxesTxWithAccounts,
  buildMintDiscountedBoxTxWithAccounts,
  buildMintDiscountedVariantBoxTxWithAccounts,
  buildMintVariantBoxTxWithAccounts,
  decodeBoxMinterConfigAccount,
  discountMintRecordPda,
  type BoxMinterConfigAccount,
} from '../src/lib/boxMinter.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1,
  BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC,
  BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION,
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
} from '../shared/boxMinterConfigCodec.ts';
import type { PaymentRoutingConfig } from '../shared/deploymentRegistry.ts';

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

function encodeConfigAccount(
  dropSeed?: Uint8Array,
  uriBase = `https://assets.example.com/drops/${'x'.repeat(63)}`,
): Buffer {
  const maxLenName = 'hoodie01';
  const maxLenSymbol = 'monsshop10';
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
    borshString(uriBase),
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

function encodeSplitPaymentsConfig(
  recipients: Array<{ address: PublicKey; percentage: number }>,
): Buffer {
  const dropSeed = Uint8Array.from(
    { length: 32 },
    (_, index) => (index + 17) & 0xff,
  );
  const base = padToAccountSize(
    encodeConfigAccount(dropSeed),
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  );
  const extension = Buffer.alloc(
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1 -
      BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  );
  Buffer.from(BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC).copy(extension, 0);
  extension[8] = BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION;
  extension[9] = recipients.length;
  recipients.forEach(({ address, percentage }, index) => {
    address.toBuffer().copy(extension, 10 + index * 32);
    extension[106 + index] = percentage;
  });
  return Buffer.concat([base, extension]);
}

function standardMintConfig(
  cfg: BoxMinterConfigAccount,
): BoxMinterConfigAccount {
  return {
    ...cfg,
    mintVariantKind: 0,
    mintVariantStartIds: [0, 0, 0],
    mintVariantEndIds: [0, 0, 0],
    mintVariantNextIds: [0, 0, 0],
  };
}

const mockConnection = {
  getLatestBlockhash: async () => ({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1,
  }),
} as unknown as Connection;

function programInstructionAccounts(
  tx: VersionedTransaction,
  programId: PublicKey,
): PublicKey[] {
  const message = tx.message;
  const instruction = message.compiledInstructions.find((candidate) =>
    message.staticAccountKeys[candidate.programIdIndex]?.equals(programId),
  );
  assert.ok(instruction);
  return Array.from(instruction.accountKeyIndexes).map(
    (index) => message.staticAccountKeys[index],
  );
}

function assertMintAssetsAndRecipients(
  tx: VersionedTransaction,
  programId: PublicKey,
  boxAccounts: PublicKey[],
  recipientAccounts: PublicKey[],
): void {
  const accounts = programInstructionAccounts(tx, programId);
  const expectedSuffix = [...boxAccounts, ...recipientAccounts].map((key) =>
    key.toBase58(),
  );
  assert.deepEqual(
    accounts.slice(-expectedSuffix.length).map((key) => key.toBase58()),
    expectedSuffix,
  );
  const message = tx.message;
  const instruction = message.compiledInstructions.find((candidate) =>
    message.staticAccountKeys[candidate.programIdIndex]?.equals(programId),
  );
  assert.ok(instruction);
  const recipientIndexes = recipientAccounts.length
    ? Array.from(instruction.accountKeyIndexes).slice(-recipientAccounts.length)
    : [];
  for (const index of recipientIndexes) {
    assert.equal(message.isAccountWritable(index), true);
    assert.equal(message.isAccountSigner(index), false);
  }
}

test('decodeBoxMinterConfigAccount handles legacy and v2 schemas', () => {
  const accountPubkey = pubkey(99);
  const legacy = decodeBoxMinterConfigAccount(
    accountPubkey,
    padToAccountSize(
      encodeConfigAccount(),
      BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
    ),
  );
  assert.equal(legacy.dropSeed, undefined);
  assert.equal(legacy.paymentRouting.schema, 'legacy');

  const dropSeed = Uint8Array.from({ length: 32 }, (_, index) => (index + 17) & 0xff);
  const v2 = decodeBoxMinterConfigAccount(
    accountPubkey,
    padToAccountSize(
      encodeConfigAccount(dropSeed),
      BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
    ),
  );
  assert.deepEqual(Array.from(v2.dropSeed || []), Array.from(dropSeed));
  assert.equal(v2.paymentRouting.schema, 'legacy');
});

test('decodeBoxMinterConfigAccount decodes exact split-payments-v1 routing', () => {
  const recipients = [
    { address: pubkey(80), percentage: 50 },
    { address: pubkey(81), percentage: 30 },
    { address: pubkey(82), percentage: 20 },
  ];
  const decoded = decodeBoxMinterConfigAccount(
    pubkey(99),
    encodeSplitPaymentsConfig(recipients),
  );

  assert.equal(decoded.paymentRouting.schema, 'split-payments-v1');
  assert.equal(decoded.paymentRouting.deliveryPaymentReceiver.toBase58(), pubkey(2).toBase58());
  assert.deepEqual(
    decoded.paymentRouting.mintProceeds.map(({ address, percentage }) => ({
      address: address.toBase58(),
      percentage,
    })),
    recipients.map(({ address, percentage }) => ({
      address: address.toBase58(),
      percentage,
    })),
  );
});

test('split payment codec fails closed for unknown sizes, magic, versions, and malformed routes', () => {
  const recipients = [
    { address: pubkey(80), percentage: 60 },
    { address: pubkey(81), percentage: 40 },
  ];
  const valid = encodeSplitPaymentsConfig(recipients);
  const decoded = decodeBoxMinterConfigData(valid);
  assert.equal(decoded.paymentRouting?.schema, 'split-payments-v1');
  assert.equal(decoded.paymentRouting?.mintProceeds.length, 2);
  const cases: Array<{
    data: Buffer;
    reason: BoxMinterConfigCodecError['reason'];
  }> = [];

  cases.push({
    data: valid.subarray(0, valid.length - 1),
    reason: 'unsupported-config-account-size',
  });
  cases.push({
    data: Buffer.concat([valid, Buffer.alloc(1)]),
    reason: 'unsupported-config-account-size',
  });
  const invalidMagic = Buffer.from(valid);
  invalidMagic[BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED] ^= 0xff;
  cases.push({ data: invalidMagic, reason: 'invalid-payment-routing-magic' });
  const invalidVersion = Buffer.from(valid);
  invalidVersion[384] = 2;
  cases.push({
    data: invalidVersion,
    reason: 'unsupported-payment-routing-version',
  });
  const invalidCount = Buffer.from(valid);
  invalidCount[385] = 1;
  cases.push({
    data: invalidCount,
    reason: 'invalid-payment-routing-recipient-count',
  });
  const duplicateRecipient = Buffer.from(valid);
  pubkey(80).toBuffer().copy(duplicateRecipient, 418);
  cases.push({
    data: duplicateRecipient,
    reason: 'invalid-payment-routing-recipient',
  });
  const invalidTotal = Buffer.from(valid);
  invalidTotal[483] = 39;
  cases.push({
    data: invalidTotal,
    reason: 'invalid-payment-routing-percentage',
  });
  const nonzeroInactiveSlot = Buffer.from(valid);
  pubkey(82).toBuffer().copy(nonzeroInactiveSlot, 450);
  cases.push({
    data: nonzeroInactiveSlot,
    reason: 'invalid-payment-routing-recipient',
  });
  const nonzeroReserved = Buffer.from(valid);
  nonzeroReserved[487] = 1;
  cases.push({
    data: nonzeroReserved,
    reason: 'invalid-payment-routing-reserved-data',
  });

  for (const { data, reason } of cases) {
    assert.throws(
      () => decodeBoxMinterConfigData(data),
      (error) =>
        error instanceof BoxMinterConfigCodecError && error.reason === reason,
    );
  }
});

test('deployment payment routing must exactly match the on-chain route', () => {
  const recipients = [
    { address: pubkey(80), percentage: 50 },
    { address: pubkey(81), percentage: 30 },
    { address: pubkey(82), percentage: 20 },
  ];
  const decoded = decodeBoxMinterConfigAccount(
    pubkey(99),
    encodeSplitPaymentsConfig(recipients),
  );
  const paymentRouting: PaymentRoutingConfig = {
    mintProceeds: [
      {
        address: recipients[0].address.toBase58(),
        percentage: recipients[0].percentage,
      },
      {
        address: recipients[1].address.toBase58(),
        percentage: recipients[1].percentage,
      },
      {
        address: recipients[2].address.toBase58(),
        percentage: recipients[2].percentage,
      },
    ],
    deliveryPaymentReceiver: pubkey(2).toBase58(),
  };

  assert.doesNotThrow(() =>
    assertBoxMinterConfigMatchesDropConfig(decoded, {
      treasury: pubkey(2).toBase58(),
      paymentRouting,
    }),
  );
  assert.throws(
    () =>
      assertBoxMinterConfigMatchesDropConfig(decoded, {
        treasury: pubkey(2).toBase58(),
      }),
    /missing.*split payment routing/i,
  );
  assert.throws(
    () =>
      assertBoxMinterConfigMatchesDropConfig(decoded, {
        treasury: pubkey(2).toBase58(),
        paymentRouting: {
          ...paymentRouting,
          mintProceeds: [
            paymentRouting.mintProceeds[2],
            paymentRouting.mintProceeds[1],
            paymentRouting.mintProceeds[0],
          ],
        },
      }),
    /mint proceeds routing/i,
  );
  assert.throws(
    () =>
      assertBoxMinterConfigMatchesDropConfig(decoded, {
        treasury: pubkey(3).toBase58(),
        paymentRouting,
      }),
    /delivery payment receiver/i,
  );
});

test('all mint builders append split recipients after asset accounts', async () => {
  const programId = pubkey(20);
  const payer = pubkey(21);
  const recipients = [
    { address: pubkey(80), percentage: 50 },
    { address: pubkey(81), percentage: 30 },
    { address: pubkey(82), percentage: 20 },
  ];
  const variantCfg = decodeBoxMinterConfigAccount(
    pubkey(99),
    encodeSplitPaymentsConfig(recipients),
  );
  const standardCfg = standardMintConfig(variantCfg);
  const standardDrop = {
    boxMinterProgramId: programId.toBase58(),
    maxPerTx: 15,
  } as any;
  const variantDrop = {
    ...standardDrop,
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
  } as any;
  const recipientAccounts = recipients.map(({ address }) => address);

  const built = [
    await buildMintBoxesTxWithAccounts(
      mockConnection,
      standardCfg,
      payer,
      2,
      standardDrop,
    ),
    await buildMintDiscountedBoxTxWithAccounts(
      mockConnection,
      standardCfg,
      payer,
      2,
      [],
      standardDrop,
    ),
    await buildMintVariantBoxTxWithAccounts(
      mockConnection,
      variantCfg,
      payer,
      'L',
      variantDrop,
    ),
    await buildMintDiscountedVariantBoxTxWithAccounts(
      mockConnection,
      variantCfg,
      payer,
      'L',
      [],
      variantDrop,
    ),
  ];

  for (const { tx, boxAccounts } of built) {
    assertMintAssetsAndRecipients(
      tx,
      programId,
      boxAccounts,
      recipientAccounts,
    );
  }

  const maxQuantity = await buildMintBoxesTxWithAccounts(
    mockConnection,
    standardCfg,
    payer,
    15,
    standardDrop,
  );
  assert.ok(maxQuantity.tx.serialize().length <= 1_232);
  assertMintAssetsAndRecipients(
    maxQuantity.tx,
    programId,
    maxQuantity.boxAccounts,
    recipientAccounts,
  );
});

test('legacy mint builders retain asset-only remaining account suffixes', async () => {
  const programId = pubkey(20);
  const payer = pubkey(21);
  const legacyCfg = standardMintConfig(
    decodeBoxMinterConfigAccount(
      pubkey(99),
      padToAccountSize(
        encodeConfigAccount(
          Uint8Array.from(
            { length: 32 },
            (_, index) => (index + 17) & 0xff,
          ),
        ),
        BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
      ),
    ),
  );
  const drop = {
    boxMinterProgramId: programId.toBase58(),
    maxPerTx: 15,
  } as any;
  const { tx, boxAccounts } = await buildMintBoxesTxWithAccounts(
    mockConnection,
    legacyCfg,
    payer,
    2,
    drop,
  );

  assertMintAssetsAndRecipients(tx, programId, boxAccounts, []);
});

test('decodeBoxMinterConfigAccount accepts stale seed suffix padding after a shorter URI migration', () => {
  const dropSeed = Uint8Array.from(
    { length: 32 },
    (_, index) => (index + 17) & 0xff,
  );
  const legacyUri = 'https://assets.mons.link/drops/cardnft2/json';
  const cdnUri = 'https://cdn.lil.org/nft/card_nft_2/json';
  const account = padToAccountSize(
    encodeConfigAccount(dropSeed, legacyUri),
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  );
  const migrated = encodeConfigAccount(dropSeed, cdnUri);
  migrated.copy(account);
  const staleSuffixLength = legacyUri.length - cdnUri.length;

  assert.deepEqual(
    account.subarray(
      migrated.length,
      migrated.length + staleSuffixLength,
    ),
    Buffer.from(dropSeed.subarray(dropSeed.length - staleSuffixLength)),
  );
  const decoded = decodeBoxMinterConfigAccount(pubkey(99), account);
  assert.equal(decoded.uriBase, cdnUri);
  assert.deepEqual(Array.from(decoded.dropSeed || []), Array.from(dropSeed));
});

test('decodeBoxMinterConfigAccount rejects unrelated bytes after a drop seed', () => {
  const dropSeed = Uint8Array.from(
    { length: 32 },
    (_, index) => (index + 17) & 0xff,
  );
  const serialized = encodeConfigAccount(
    dropSeed,
    'https://cdn.lil.org/nft/card_nft_2/json',
  );
  const account = padToAccountSize(
    serialized,
    BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  );
  account[serialized.length] = 0xff;

  assert.throws(
    () => decodeBoxMinterConfigAccount(pubkey(99), account),
    /Unexpected trailing data after drop seed/,
  );
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
  const legacyCfg = decodeBoxMinterConfigAccount(
    legacyConfigPda,
    padToAccountSize(
      encodeConfigAccount(),
      BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
    ),
  );

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

  assert.doesNotThrow(() =>
    assertBoxMinterConfigMatchesDropConfig(cfg, {
      collectionMint: pubkey(70).toBase58(),
      metadataBase: 'https://cdn.example.com/nft/shared',
      metadataBaseAliases: ['https://assets.example.com/drops/shared'],
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

test('Poncho on-chain config accepts the legacy alias during rollout', () => {
  const drop = {
    collectionMint: pubkey(72).toBase58(),
    metadataBase: 'https://cdn.lil.org/nft/poncho_drifella',
    metadataBaseAliases: ['https://assets.mons.link/drops/poncho'],
  } as any;

  assert.doesNotThrow(() => assertBoxMinterConfigMatchesDropConfig({
    coreCollection: pubkey(72),
    uriBase: 'https://assets.mons.link/drops/poncho',
  }, drop));
  assert.doesNotThrow(() => assertBoxMinterConfigMatchesDropConfig({
    coreCollection: pubkey(72),
    uriBase: 'https://cdn.lil.org/nft/poncho_drifella',
  }, drop));
  assert.throws(() => assertBoxMinterConfigMatchesDropConfig({
    coreCollection: pubkey(72),
    uriBase: 'https://cdn.lil.org/nft/poncho_drifella-copy',
  }, drop), /metadata base/i);
});

test('Card NFT 2 on-chain config accepts only its exact mainnet alias', () => {
  const drop = {
    collectionMint: pubkey(73).toBase58(),
    metadataBase: 'https://cdn.lil.org/nft/card_nft_2/json',
    metadataBaseAliases: ['https://assets.mons.link/drops/cardnft2/json'],
  } as any;

  assert.doesNotThrow(() => assertBoxMinterConfigMatchesDropConfig({
    coreCollection: pubkey(73),
    uriBase: 'https://assets.mons.link/drops/cardnft2/json',
  }, drop));
  assert.doesNotThrow(() => assertBoxMinterConfigMatchesDropConfig({
    coreCollection: pubkey(73),
    uriBase: 'https://cdn.lil.org/nft/card_nft_2/json',
  }, drop));
  assert.throws(() => assertBoxMinterConfigMatchesDropConfig({
    coreCollection: pubkey(73),
    uriBase: 'https://assets.mons.link/drops/cardnft2',
  }, drop), /metadata base/i);
});
