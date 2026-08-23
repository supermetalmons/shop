import {
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
  type BoxMinterMintVariantTuple,
} from './boxMinterProtocol.ts';
import {
  bytesEqual,
  hasAnyNonZeroByte,
  readU32LE,
  readU64LE,
} from './byteCodec.ts';

export const BOX_MINTER_CONFIG_DISCRIMINATOR = Uint8Array.from([
  0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3,
]);

const BOX_MINTER_CONFIG_ACCOUNT_SIZE_LEGACY_FIXED_ITEMS =
  8 + // discriminator
  32 * 3 +
  8 +
  8 +
  32 +
  4 +
  1 +
  4 +
  4 +
  8 +
  4 +
  10 +
  4 +
  96 +
  1 +
  1;
export const BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS =
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_LEGACY_FIXED_ITEMS + 1;
const BOX_MINTER_CONFIG_ACCOUNT_SIZE_DISCOUNT_LIMIT =
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS + 1;
const BOX_MINTER_CONFIG_ACCOUNT_SIZE_FIGURE_NAME_PREFIX =
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DISCOUNT_LIMIT + 4 + 12;
const BOX_MINTER_CONFIG_ACCOUNT_SIZE_MINT_VARIANTS =
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_FIGURE_NAME_PREFIX +
  1 +
  4 * BOX_MINTER_MINT_VARIANT_OPTION_COUNT * 3;
export const BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED =
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_MINT_VARIANTS + 32;
export const BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1 = 488;
export const BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC = Uint8Array.from([
  0x4d, 0x4f, 0x4e, 0x53, 0x50, 0x41, 0x59, 0x00,
]);
export const BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION = 1;
const BOX_MINTER_SPLIT_PAYMENTS_MAX_RECIPIENTS = 3;

export type BoxMinterConfigCodecErrorReason =
  | 'empty'
  | 'invalid-discriminator'
  | 'config-truncated'
  | 'invalid-items-per-box'
  | 'variant-data-truncated'
  | 'drop-seed-truncated'
  | 'unexpected-config-trailing-data'
  | 'unexpected-drop-seed-trailing-data'
  | 'unsupported-config-account-size'
  | 'invalid-payment-routing-magic'
  | 'unsupported-payment-routing-version'
  | 'invalid-payment-routing-recipient-count'
  | 'invalid-payment-routing-recipient'
  | 'invalid-payment-routing-percentage'
  | 'invalid-payment-routing-reserved-data';

export class BoxMinterConfigCodecError extends Error {
  readonly reason: BoxMinterConfigCodecErrorReason;
  readonly details?: Readonly<Record<string, number>>;

  constructor(
    reason: BoxMinterConfigCodecErrorReason,
    message: string,
    details?: Readonly<Record<string, number>>,
  ) {
    super(message);
    this.name = 'BoxMinterConfigCodecError';
    this.reason = reason;
    this.details = details;
  }
}

type DecodedBoxMinterMintProceedsRecipient = {
  address: Uint8Array;
  percentage: number;
};

type DecodedBoxMinterPaymentRouting =
  | {
      schema: 'legacy';
      mintProceeds: DecodedBoxMinterMintProceedsRecipient[];
      deliveryPaymentReceiver: Uint8Array;
    }
  | {
      schema: 'split-payments-v1';
      version: typeof BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION;
      mintProceeds: DecodedBoxMinterMintProceedsRecipient[];
      deliveryPaymentReceiver: Uint8Array;
    };

export type DecodedBoxMinterConfigData = {
  admin: Uint8Array;
  treasury: Uint8Array;
  coreCollection: Uint8Array;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMerkleRoot: Uint8Array;
  discountMintsPerWallet: number;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  started: boolean;
  minted: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  uriBase: string;
  bump: number;
  mintVariantKind: number;
  mintVariantStartIds: BoxMinterMintVariantTuple;
  mintVariantEndIds: BoxMinterMintVariantTuple;
  mintVariantNextIds: BoxMinterMintVariantTuple;
  dropSeed?: Uint8Array;
  paymentRouting?: DecodedBoxMinterPaymentRouting;
};

export type DecodeBoxMinterConfigDataOptions = {
  validateDiscriminator?: boolean;
  validateItemsPerBox?: boolean;
  normalizeDiscountMintsPerWallet?: boolean;
  decodeExtensions?: boolean;
  stringDecodeErrorMessages?: Readonly<{
    length: string;
    bytes: string;
  }>;
};

const LEGACY_FIXED_ITEMS_PER_BOX = 3;
const textDecoder = new TextDecoder();

function throwConfigTruncated(
  dataLength: number,
  expectedMinBytes: number,
  customMessage?: string,
): never {
  if (customMessage !== undefined) {
    throw new Error(customMessage);
  }
  throw new BoxMinterConfigCodecError(
    'config-truncated',
    'Unsupported box minter config schema. Config data is truncated.',
    {
      expectedMinBytes,
      actualBytes: dataLength,
    },
  );
}

function readBorshString(
  data: Uint8Array,
  offset: number,
  errorMessages?: DecodeBoxMinterConfigDataOptions['stringDecodeErrorMessages'],
): { value: string; next: number } {
  if (offset + 4 > data.length) {
    throwConfigTruncated(
      data.length,
      offset + 4,
      errorMessages?.length,
    );
  }
  const len = readU32LE(data, offset);
  const start = offset + 4;
  const end = start + len;
  if (end > data.length) {
    throwConfigTruncated(data.length, end, errorMessages?.bytes);
  }
  return { value: textDecoder.decode(data.subarray(start, end)), next: end };
}

function readU32Tuple(
  data: Uint8Array,
  offset: number,
): { value: BoxMinterMintVariantTuple; next: number } {
  const value: BoxMinterMintVariantTuple = [0, 0, 0];
  let next = offset;
  for (let index = 0; index < BOX_MINTER_MINT_VARIANT_OPTION_COUNT; index += 1) {
    value[index] = readU32LE(data, next);
    next += 4;
  }
  return { value, next };
}

function normalizeDiscountMintsPerWallet(value: number | undefined): number {
  const parsed = Number(value);
  return isBoxMinterDiscountMintsPerWallet(parsed) ? parsed : 1;
}

function isStaleDropSeedSuffixPadding(
  padding: Uint8Array,
  dropSeed: Uint8Array,
): boolean {
  const maximumSuffixLength = Math.min(padding.length, dropSeed.length);
  for (let suffixLength = 1; suffixLength <= maximumSuffixLength; suffixLength += 1) {
    if (hasAnyNonZeroByte(padding.subarray(suffixLength))) continue;
    if (
      bytesEqual(
        padding.subarray(0, suffixLength),
        dropSeed.subarray(dropSeed.length - suffixLength),
      )
    ) {
      return true;
    }
  }
  return false;
}

function decodeOptionalTrailingDropSeed(
  data: Uint8Array,
  offset: number,
): Uint8Array | undefined {
  // RPC returns the full allocated account buffer. All-zero trailing bytes are legacy padding.
  if (offset >= data.length) return undefined;
  const trailing = data.subarray(offset);
  if (!hasAnyNonZeroByte(trailing)) return undefined;
  if (trailing.length < 32) {
    throw new BoxMinterConfigCodecError(
      'drop-seed-truncated',
      'Unsupported box minter config schema. Drop seed data is truncated.',
    );
  }
  const dropSeed = data.slice(offset, offset + 32);
  if (!hasAnyNonZeroByte(dropSeed)) {
    throw new BoxMinterConfigCodecError(
      'unexpected-config-trailing-data',
      'Unsupported box minter config schema. Unexpected trailing data after config payload.',
    );
  }
  const padding = trailing.subarray(32);
  if (
    hasAnyNonZeroByte(padding) &&
    !(
      data.length === BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED &&
      isStaleDropSeedSuffixPadding(padding, dropSeed)
    )
  ) {
    throw new BoxMinterConfigCodecError(
      'unexpected-drop-seed-trailing-data',
      'Unsupported box minter config schema. Unexpected trailing data after drop seed.',
    );
  }
  return dropSeed;
}

function decodeSplitPaymentsV1(
  data: Uint8Array,
  deliveryPaymentReceiver: Uint8Array,
): DecodedBoxMinterPaymentRouting {
  const extensionOffset = BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED;
  const magicEnd = extensionOffset + BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC.length;
  if (
    !bytesEqual(
      data.subarray(extensionOffset, magicEnd),
      BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC,
    )
  ) {
    throw new BoxMinterConfigCodecError(
      'invalid-payment-routing-magic',
      'Invalid split payment routing magic',
    );
  }

  const version = data[magicEnd] ?? 0;
  if (version !== BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION) {
    throw new BoxMinterConfigCodecError(
      'unsupported-payment-routing-version',
      `Unsupported split payment routing version: ${version}`,
      { version },
    );
  }

  const recipientCount = data[magicEnd + 1] ?? 0;
  if (recipientCount < 2 || recipientCount > BOX_MINTER_SPLIT_PAYMENTS_MAX_RECIPIENTS) {
    throw new BoxMinterConfigCodecError(
      'invalid-payment-routing-recipient-count',
      `Invalid split payment recipient count: ${recipientCount}`,
      { recipientCount },
    );
  }

  const recipientAddressesOffset = magicEnd + 2;
  const percentagesOffset =
    recipientAddressesOffset + 32 * BOX_MINTER_SPLIT_PAYMENTS_MAX_RECIPIENTS;
  const recipients: DecodedBoxMinterMintProceedsRecipient[] = [];
  let percentageTotal = 0;
  for (let index = 0; index < BOX_MINTER_SPLIT_PAYMENTS_MAX_RECIPIENTS; index += 1) {
    const address = data.slice(
      recipientAddressesOffset + index * 32,
      recipientAddressesOffset + (index + 1) * 32,
    );
    const percentage = data[percentagesOffset + index] ?? 0;
    if (index >= recipientCount) {
      if (hasAnyNonZeroByte(address) || percentage !== 0) {
        throw new BoxMinterConfigCodecError(
          'invalid-payment-routing-recipient',
          'Inactive split payment recipient slots must be zeroed',
          { index },
        );
      }
      continue;
    }
    if (
      !hasAnyNonZeroByte(address) ||
      recipients.some((recipient) => bytesEqual(recipient.address, address))
    ) {
      throw new BoxMinterConfigCodecError(
        'invalid-payment-routing-recipient',
        'Split payment recipients must be non-default and distinct',
        { index },
      );
    }
    if (percentage <= 0) {
      throw new BoxMinterConfigCodecError(
        'invalid-payment-routing-percentage',
        'Split payment percentages must be positive',
        { index, percentage },
      );
    }
    percentageTotal += percentage;
    recipients.push({ address, percentage });
  }

  if (percentageTotal !== 100) {
    throw new BoxMinterConfigCodecError(
      'invalid-payment-routing-percentage',
      `Split payment percentages must total 100, got ${percentageTotal}`,
      { percentageTotal },
    );
  }

  const reserved = data.subarray(
    percentagesOffset + BOX_MINTER_SPLIT_PAYMENTS_MAX_RECIPIENTS,
  );
  if (hasAnyNonZeroByte(reserved)) {
    throw new BoxMinterConfigCodecError(
      'invalid-payment-routing-reserved-data',
      'Split payment reserved bytes must be zeroed',
    );
  }

  return {
    schema: 'split-payments-v1',
    version: BOX_MINTER_SPLIT_PAYMENTS_V1_VERSION,
    mintProceeds: recipients,
    deliveryPaymentReceiver: deliveryPaymentReceiver.slice(),
  };
}

export function decodeBoxMinterConfigData(
  data: Uint8Array,
  options: DecodeBoxMinterConfigDataOptions = {},
): DecodedBoxMinterConfigData {
  const validateDiscriminator = options.validateDiscriminator !== false;
  const validateItemsPerBox = options.validateItemsPerBox !== false;
  const normalizeDiscountLimit =
    options.normalizeDiscountMintsPerWallet !== false;
  const decodeExtensions = options.decodeExtensions !== false;
  if (
    decodeExtensions &&
    data.length > BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED &&
    data.length !== BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1
  ) {
    throw new BoxMinterConfigCodecError(
      'unsupported-config-account-size',
      `Unsupported box minter config account size: ${data.length}`,
      { actualBytes: data.length },
    );
  }
  const baseData =
    decodeExtensions &&
    data.length === BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1
      ? data.subarray(0, BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED)
      : data;
  if (validateDiscriminator) {
    if (baseData.length < 8) {
      throw new BoxMinterConfigCodecError('empty', 'Invalid config account: empty');
    }
    if (!bytesEqual(baseData.subarray(0, 8), BOX_MINTER_CONFIG_DISCRIMINATOR)) {
      throw new BoxMinterConfigCodecError(
        'invalid-discriminator',
        'Invalid config account discriminator',
      );
    }
  }

  if (baseData.length < BOX_MINTER_CONFIG_ACCOUNT_SIZE_LEGACY_FIXED_ITEMS) {
    throw new BoxMinterConfigCodecError(
      'config-truncated',
      'Unsupported box minter config schema. Config data is truncated.',
      {
        expectedMinBytes: BOX_MINTER_CONFIG_ACCOUNT_SIZE_LEGACY_FIXED_ITEMS,
        actualBytes: baseData.length,
      },
    );
  }

  let offset = 8;
  const admin = baseData.subarray(offset, offset + 32);
  offset += 32;
  const treasury = baseData.subarray(offset, offset + 32);
  offset += 32;
  const coreCollection = baseData.subarray(offset, offset + 32);
  offset += 32;
  const priceLamports = readU64LE(baseData, offset);
  offset += 8;
  const discountPriceLamports = readU64LE(baseData, offset);
  offset += 8;
  const discountMerkleRoot = baseData.subarray(offset, offset + 32);
  offset += 32;
  const maxSupply = readU32LE(baseData, offset);
  offset += 4;
  const maxPerTx = baseData[offset] ?? 0;
  offset += 1;
  let itemsPerBox = LEGACY_FIXED_ITEMS_PER_BOX;
  if (baseData.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS) {
    itemsPerBox = baseData[offset] ?? 0;
    offset += 1;
  }
  if (
    validateItemsPerBox &&
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox)
  ) {
    throw new BoxMinterConfigCodecError(
      'invalid-items-per-box',
      `Invalid on-chain itemsPerBox: ${itemsPerBox} (expected ${BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX}..${BOX_MINTER_MAX_ITEMS_PER_BOX})`,
      { itemsPerBox },
    );
  }
  const minted = readU32LE(baseData, offset);
  offset += 4;

  const namePrefix = readBorshString(
    baseData,
    offset,
    options.stringDecodeErrorMessages,
  );
  offset = namePrefix.next;
  const symbol = readBorshString(
    baseData,
    offset,
    options.stringDecodeErrorMessages,
  );
  offset = symbol.next;
  const uriBase = readBorshString(
    baseData,
    offset,
    options.stringDecodeErrorMessages,
  );
  offset = uriBase.next;
  if (offset + 2 > baseData.length) {
    throwConfigTruncated(baseData.length, offset + 2);
  }
  const started = Boolean(baseData[offset]);
  offset += 1;
  const bump = baseData[offset] ?? 0;
  offset += 1;
  let discountMintsPerWallet = 1;
  if (
    baseData.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DISCOUNT_LIMIT ||
    !decodeExtensions
  ) {
    if (decodeExtensions && offset + 1 > baseData.length) {
      throwConfigTruncated(baseData.length, offset + 1);
    }
    const rawDiscountMintsPerWallet = decodeExtensions
      ? baseData[offset] ?? 1
      : baseData[offset];
    discountMintsPerWallet = normalizeDiscountLimit
      ? normalizeDiscountMintsPerWallet(rawDiscountMintsPerWallet)
      : rawDiscountMintsPerWallet;
    offset += 1;
  }
  let figureNamePrefix = 'figure';
  if (
    decodeExtensions &&
    baseData.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_FIGURE_NAME_PREFIX
  ) {
    const decoded = readBorshString(baseData, offset);
    figureNamePrefix = decoded.value;
    offset = decoded.next;
  }
  let mintVariantKind = BOX_MINTER_MINT_VARIANT_KIND_NONE;
  let mintVariantStartIds: BoxMinterMintVariantTuple = [0, 0, 0];
  let mintVariantEndIds: BoxMinterMintVariantTuple = [0, 0, 0];
  let mintVariantNextIds: BoxMinterMintVariantTuple = [0, 0, 0];
  if (
    decodeExtensions &&
    baseData.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_MINT_VARIANTS
  ) {
    const mintVariantBytes = 1 + 4 * BOX_MINTER_MINT_VARIANT_OPTION_COUNT * 3;
    if (offset + mintVariantBytes > baseData.length) {
      throw new BoxMinterConfigCodecError(
        'variant-data-truncated',
        'Unsupported box minter config schema. Variant mint data is truncated.',
      );
    }
    mintVariantKind = baseData[offset] ?? BOX_MINTER_MINT_VARIANT_KIND_NONE;
    offset += 1;
    const startIds = readU32Tuple(baseData, offset);
    mintVariantStartIds = startIds.value;
    offset = startIds.next;
    const endIds = readU32Tuple(baseData, offset);
    mintVariantEndIds = endIds.value;
    offset = endIds.next;
    const nextIds = readU32Tuple(baseData, offset);
    mintVariantNextIds = nextIds.value;
    offset = nextIds.next;
  }
  const dropSeed =
    decodeExtensions &&
    baseData.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED
      ? decodeOptionalTrailingDropSeed(baseData, offset)
      : undefined;
  const paymentRouting = decodeExtensions
    ? data.length === BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1
      ? decodeSplitPaymentsV1(data, treasury)
      : {
          schema: 'legacy' as const,
          mintProceeds: [{ address: treasury.slice(), percentage: 100 }],
          deliveryPaymentReceiver: treasury.slice(),
        }
    : undefined;

  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    discountMintsPerWallet,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    started,
    minted,
    namePrefix: namePrefix.value,
    figureNamePrefix,
    symbol: symbol.value,
    uriBase: uriBase.value,
    bump,
    mintVariantKind,
    mintVariantStartIds,
    mintVariantEndIds,
    mintVariantNextIds,
    ...(dropSeed ? { dropSeed } : {}),
    ...(paymentRouting ? { paymentRouting } : {}),
  };
}
