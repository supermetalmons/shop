import {
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
  type BoxMinterMintVariantTuple,
} from './boxMinterProtocol.js';
import {
  bytesEqual,
  hasAnyNonZeroByte,
  readU32LE,
  readU64LE,
} from './byteCodec.js';

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

export type BoxMinterConfigCodecErrorReason =
  | 'empty'
  | 'invalid-discriminator'
  | 'config-truncated'
  | 'invalid-items-per-box'
  | 'variant-data-truncated'
  | 'drop-seed-truncated'
  | 'unexpected-config-trailing-data'
  | 'unexpected-drop-seed-trailing-data';

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
  if (hasAnyNonZeroByte(trailing.subarray(32))) {
    throw new BoxMinterConfigCodecError(
      'unexpected-drop-seed-trailing-data',
      'Unsupported box minter config schema. Unexpected trailing data after drop seed.',
    );
  }
  return dropSeed;
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
  if (validateDiscriminator) {
    if (data.length < 8) {
      throw new BoxMinterConfigCodecError('empty', 'Invalid config account: empty');
    }
    if (!bytesEqual(data.subarray(0, 8), BOX_MINTER_CONFIG_DISCRIMINATOR)) {
      throw new BoxMinterConfigCodecError(
        'invalid-discriminator',
        'Invalid config account discriminator',
      );
    }
  }

  if (data.length < BOX_MINTER_CONFIG_ACCOUNT_SIZE_LEGACY_FIXED_ITEMS) {
    throw new BoxMinterConfigCodecError(
      'config-truncated',
      'Unsupported box minter config schema. Config data is truncated.',
      {
        expectedMinBytes: BOX_MINTER_CONFIG_ACCOUNT_SIZE_LEGACY_FIXED_ITEMS,
        actualBytes: data.length,
      },
    );
  }

  let offset = 8;
  const admin = data.subarray(offset, offset + 32);
  offset += 32;
  const treasury = data.subarray(offset, offset + 32);
  offset += 32;
  const coreCollection = data.subarray(offset, offset + 32);
  offset += 32;
  const priceLamports = readU64LE(data, offset);
  offset += 8;
  const discountPriceLamports = readU64LE(data, offset);
  offset += 8;
  const discountMerkleRoot = data.subarray(offset, offset + 32);
  offset += 32;
  const maxSupply = readU32LE(data, offset);
  offset += 4;
  const maxPerTx = data[offset] ?? 0;
  offset += 1;
  let itemsPerBox = LEGACY_FIXED_ITEMS_PER_BOX;
  if (data.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS) {
    itemsPerBox = data[offset] ?? 0;
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
  const minted = readU32LE(data, offset);
  offset += 4;

  const namePrefix = readBorshString(
    data,
    offset,
    options.stringDecodeErrorMessages,
  );
  offset = namePrefix.next;
  const symbol = readBorshString(
    data,
    offset,
    options.stringDecodeErrorMessages,
  );
  offset = symbol.next;
  const uriBase = readBorshString(
    data,
    offset,
    options.stringDecodeErrorMessages,
  );
  offset = uriBase.next;
  if (offset + 2 > data.length) {
    throwConfigTruncated(data.length, offset + 2);
  }
  const started = Boolean(data[offset]);
  offset += 1;
  const bump = data[offset] ?? 0;
  offset += 1;
  let discountMintsPerWallet = 1;
  if (
    data.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DISCOUNT_LIMIT ||
    !decodeExtensions
  ) {
    if (decodeExtensions && offset + 1 > data.length) {
      throwConfigTruncated(data.length, offset + 1);
    }
    const rawDiscountMintsPerWallet = decodeExtensions
      ? data[offset] ?? 1
      : data[offset];
    discountMintsPerWallet = normalizeDiscountLimit
      ? normalizeDiscountMintsPerWallet(rawDiscountMintsPerWallet)
      : rawDiscountMintsPerWallet;
    offset += 1;
  }
  let figureNamePrefix = 'figure';
  if (
    decodeExtensions &&
    data.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_FIGURE_NAME_PREFIX
  ) {
    const decoded = readBorshString(data, offset);
    figureNamePrefix = decoded.value;
    offset = decoded.next;
  }
  let mintVariantKind = BOX_MINTER_MINT_VARIANT_KIND_NONE;
  let mintVariantStartIds: BoxMinterMintVariantTuple = [0, 0, 0];
  let mintVariantEndIds: BoxMinterMintVariantTuple = [0, 0, 0];
  let mintVariantNextIds: BoxMinterMintVariantTuple = [0, 0, 0];
  if (
    decodeExtensions &&
    data.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_MINT_VARIANTS
  ) {
    const mintVariantBytes = 1 + 4 * BOX_MINTER_MINT_VARIANT_OPTION_COUNT * 3;
    if (offset + mintVariantBytes > data.length) {
      throw new BoxMinterConfigCodecError(
        'variant-data-truncated',
        'Unsupported box minter config schema. Variant mint data is truncated.',
      );
    }
    mintVariantKind = data[offset] ?? BOX_MINTER_MINT_VARIANT_KIND_NONE;
    offset += 1;
    const startIds = readU32Tuple(data, offset);
    mintVariantStartIds = startIds.value;
    offset = startIds.next;
    const endIds = readU32Tuple(data, offset);
    mintVariantEndIds = endIds.value;
    offset = endIds.next;
    const nextIds = readU32Tuple(data, offset);
    mintVariantNextIds = nextIds.value;
    offset = nextIds.next;
  }
  const dropSeed =
    decodeExtensions &&
    data.length >= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED
      ? decodeOptionalTrailingDropSeed(data, offset)
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
  };
}
