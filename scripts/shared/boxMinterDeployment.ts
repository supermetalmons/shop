import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS, decodeBoxMinterConfigData } from '../../shared/boxMinterConfigCodec.ts';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_KIND_SIZE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT,
} from '../../shared/boxMinterProtocol.ts';
import { normalizeDropBase, type MintSelectionConfigSerialized } from './deploymentRegistry.ts';
import type { MplCoreRoyaltyCreator } from './mplCoreCollection.ts';
import { borshString, u32LE, u8 } from './solanaInstructionData.ts';
import { requireDiscountMintsPerWallet } from './deploymentInputValidation.ts';

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function encodeMintSelectionInitializeArgs(mintSelection: MintSelectionConfigSerialized | undefined): Buffer {
  const zeroArray = Array.from(
    { length: BOX_MINTER_MINT_VARIANT_OPTION_COUNT },
    () => u32LE(0),
  );
  if (!mintSelection) {
    return Buffer.concat([
      u8(BOX_MINTER_MINT_VARIANT_KIND_NONE),
      ...zeroArray,
      ...zeroArray,
      ...zeroArray,
    ]);
  }
  if (
    mintSelection.kind !== 'size' ||
    mintSelection.options.length !== BOX_MINTER_MINT_VARIANT_OPTION_COUNT
  ) {
    throw new Error('Invalid mintSelection config for initialize');
  }
  const startIds = mintSelection.options.map((option) => u32LE(option.startId));
  const endIds = mintSelection.options.map((option) => u32LE(option.endId));
  const nextIds = mintSelection.options.map((option) => u32LE(option.startId));
  return Buffer.concat([
    u8(BOX_MINTER_MINT_VARIANT_KIND_SIZE),
    ...startIds,
    ...endIds,
    ...nextIds,
  ]);
}

export function decodeBoxMinterConfigForDeployPreflight(data: Buffer) {
  if (data.length < BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS) {
    throw new Error(
      `Existing on-chain config uses an older schema and cannot be reused.\n` +
        `- expected config account size >= ${BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS} bytes\n` +
        `- actual config account size      : ${data.length} bytes\n` +
        `\n` +
        `This configurable items-per-box change requires a fresh deployment/init.\n` +
        `Fix: deploy to a fresh program id and rerun this script.`,
    );
  }
  // Preserve the historical deploy preflight policy: the discriminator is not
  // consulted here because ownership is validated by the caller.
  const decoded = decodeBoxMinterConfigData(data, {
    validateDiscriminator: false,
    validateItemsPerBox: false,
    decodeExtensions: false,
  });
  return {
    ...decoded,
    admin: new PublicKey(decoded.admin),
    treasury: new PublicKey(decoded.treasury),
    coreCollection: new PublicKey(decoded.coreCollection),
    discountMerkleRoot: Buffer.from(decoded.discountMerkleRoot),
  };
}

export function assertExistingConfigMatchesResume(args: {
  data: Buffer;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMintsPerWallet: number;
  discountMerkleRoot: Buffer;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  metadataBase: string;
  mintSelection?: MintSelectionConfigSerialized;
  mintProceeds?: MplCoreRoyaltyCreator[];
  dropSeed: Buffer;
  allowStartedMint?: boolean;
}): void {
  const decodedRaw = decodeBoxMinterConfigData(args.data, {
    validateDiscriminator: true,
    validateItemsPerBox: true,
    decodeExtensions: true,
  });
  const decoded = {
    ...decodedRaw,
    admin: new PublicKey(decodedRaw.admin),
    treasury: new PublicKey(decodedRaw.treasury),
    coreCollection: new PublicKey(decodedRaw.coreCollection),
    discountMerkleRoot: Buffer.from(decodedRaw.discountMerkleRoot),
  };
  const expectedVariantKind = args.mintSelection
    ? BOX_MINTER_MINT_VARIANT_KIND_SIZE
    : BOX_MINTER_MINT_VARIANT_KIND_NONE;
  const expectedStarts = args.mintSelection
    ? args.mintSelection.options.map((option) => option.startId)
    : [0, 0, 0];
  const expectedEnds = args.mintSelection
    ? args.mintSelection.options.map((option) => option.endId)
    : [0, 0, 0];
  const expectedNext = expectedStarts;
  const routingMatches = args.mintProceeds
    ? decodedRaw.paymentRouting?.schema === 'split-payments-v1' &&
      decodedRaw.paymentRouting.mintProceeds.length === args.mintProceeds.length &&
      decodedRaw.paymentRouting.mintProceeds.every(
        (recipient, index) =>
          new PublicKey(recipient.address).equals(
            args.mintProceeds![index].address,
          ) &&
          recipient.percentage === args.mintProceeds![index].percentage,
      ) &&
      new PublicKey(
        decodedRaw.paymentRouting.deliveryPaymentReceiver,
      ).equals(args.treasury)
    : decodedRaw.paymentRouting?.schema === 'legacy';
  const mismatches = [
    decoded.admin.equals(args.admin) ? '' : 'admin',
    decoded.treasury.equals(args.treasury) ? '' : 'treasury',
    decoded.coreCollection.equals(args.coreCollection)
      ? ''
      : 'coreCollection',
    decoded.priceLamports === args.priceLamports ? '' : 'priceLamports',
    decoded.discountPriceLamports === args.discountPriceLamports
      ? ''
      : 'discountPriceLamports',
    decoded.discountMintsPerWallet === args.discountMintsPerWallet
      ? ''
      : 'discountMintsPerWallet',
    decoded.discountMerkleRoot.equals(args.discountMerkleRoot)
      ? ''
      : 'discountMerkleRoot',
    decoded.maxSupply === args.maxSupply ? '' : 'maxSupply',
    decoded.itemsPerBox === args.itemsPerBox ? '' : 'itemsPerBox',
    decoded.maxPerTx === args.maxPerTx ? '' : 'maxPerTx',
    decoded.namePrefix === args.namePrefix ? '' : 'namePrefix',
    decoded.figureNamePrefix === args.figureNamePrefix
      ? ''
      : 'figureNamePrefix',
    decoded.symbol === args.symbol ? '' : 'symbol',
    normalizeDropBase(decoded.uriBase) ===
    normalizeDropBase(args.metadataBase)
      ? ''
      : 'metadataBase',
    decoded.mintVariantKind === expectedVariantKind
      ? ''
      : 'mintVariantKind',
    isDeepStrictEqual(decoded.mintVariantStartIds, expectedStarts)
      ? ''
      : 'mintVariantStartIds',
    isDeepStrictEqual(decoded.mintVariantEndIds, expectedEnds)
      ? ''
      : 'mintVariantEndIds',
    isDeepStrictEqual(decoded.mintVariantNextIds, expectedNext)
      ? ''
      : 'mintVariantNextIds',
    decoded.dropSeed &&
    Buffer.from(decoded.dropSeed).equals(args.dropSeed)
      ? ''
      : 'dropSeed',
    routingMatches ? '' : 'paymentRouting',
    !decoded.started || args.allowStartedMint ? '' : 'started',
    (args.allowStartedMint
      ? Number.isSafeInteger(decoded.minted) && decoded.minted >= 0 && decoded.minted <= args.maxSupply &&
        (decoded.started || decoded.minted === 0)
      : decoded.minted === 0) ? '' : 'minted',
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(
      `Existing unregistered config cannot be resumed because ${mismatches.join(', ')} differ`,
    );
  }
}

export function boxMinterConfigPda(programId: PublicKey, dropSeed?: Buffer): PublicKey {
  return (dropSeed?.length === 32
    ? PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED), dropSeed], programId)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId))[0];
}

// Anchor instruction discriminator: sha256("global:initialize")[0..8]
const IX_INITIALIZE = Buffer.from('afaf6d1f0d989bed', 'hex');

export const IX_INITIALIZE_SPLIT_PAYMENTS_V1 = createHash('sha256')
  .update('global:initialize_split_payments_v1')
  .digest()
  .subarray(0, 8);

export const IX_SPLIT_PAYMENTS_V1_CAPABILITY = createHash('sha256')
  .update('global:split_payments_v1_capability')
  .digest()
  .subarray(0, 8);

export function buildSplitPaymentsV1CapabilityIx(
  programId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [],
    data: IX_SPLIT_PAYMENTS_V1_CAPABILITY,
  });
}

export function buildInitializeIx(args: {
  programId: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMintsPerWallet: number;
  discountMerkleRoot: Buffer;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  mintSelection?: MintSelectionConfigSerialized;
  dropSeed: Buffer;
  /**
   * Canonical drop base, e.g. `https://assets.example.com/drops/your-drop` or `ipfs://bafy...`.
   *
   * The on-chain program derives per-asset JSON URIs from this base.
   */
  metadataBase: string;
}): TransactionInstruction {
  const configPda = boxMinterConfigPda(args.programId, args.dropSeed);
  const data = Buffer.concat([
    IX_INITIALIZE,
    u64LE(args.priceLamports),
    u64LE(args.discountPriceLamports),
    Buffer.from(args.discountMerkleRoot),
    u32LE(args.maxSupply),
    Buffer.from([args.maxPerTx & 0xff]),
    Buffer.from([args.itemsPerBox & 0xff]),
    borshString(args.namePrefix),
    borshString(args.symbol),
    borshString(args.metadataBase),
    Buffer.from([requireDiscountMintsPerWallet(args.discountMintsPerWallet, 'initialize discountMintsPerWallet') & 0xff]),
    borshString(args.figureNamePrefix),
    encodeMintSelectionInitializeArgs(args.mintSelection),
    Buffer.from(args.dropSeed),
  ]);

  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: true },
      { pubkey: args.treasury, isSigner: false, isWritable: false },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeSplitPaymentsV1Ix(
  args: Parameters<typeof buildInitializeIx>[0] & {
    mintProceeds: MplCoreRoyaltyCreator[];
  },
): TransactionInstruction {
  if (args.treasury.equals(PublicKey.default)) {
    throw new Error(
      'split-payments-v1 delivery receiver must not be the default address',
    );
  }
  if (args.mintProceeds.length < 2 || args.mintProceeds.length > 3) {
    throw new Error('split-payments-v1 requires 2 or 3 mint recipients');
  }
  const seen = new Set<string>();
  let totalPercentage = 0;
  for (const [index, recipient] of args.mintProceeds.entries()) {
    if (recipient.address.equals(PublicKey.default)) {
      throw new Error(`split-payments-v1 recipient ${index} must not be the default address`);
    }
    const address = recipient.address.toBase58();
    if (seen.has(address)) {
      throw new Error(`split-payments-v1 recipient ${index} duplicates ${address}`);
    }
    seen.add(address);
    if (
      !Number.isInteger(recipient.percentage) ||
      recipient.percentage <= 0 ||
      recipient.percentage > 100
    ) {
      throw new Error(`split-payments-v1 recipient ${index} has an invalid percentage`);
    }
    totalPercentage += recipient.percentage;
  }
  if (totalPercentage !== 100) {
    throw new Error(`split-payments-v1 percentages must total 100, got ${totalPercentage}`);
  }

  const legacy = buildInitializeIx(args);
  const recipients = [
    ...args.mintProceeds.map((recipient) => recipient.address),
    ...Array.from(
      { length: 3 - args.mintProceeds.length },
      () => PublicKey.default,
    ),
  ];
  const percentages = [
    ...args.mintProceeds.map((recipient) => recipient.percentage),
    ...Array.from({ length: 3 - args.mintProceeds.length }, () => 0),
  ];
  return new TransactionInstruction({
    programId: legacy.programId,
    keys: legacy.keys,
    data: Buffer.concat([
      IX_INITIALIZE_SPLIT_PAYMENTS_V1,
      legacy.data.subarray(IX_INITIALIZE.length),
      u8(args.mintProceeds.length),
      ...recipients.map((recipient) => recipient.toBuffer()),
      Buffer.from(percentages),
    ]),
  });
}
