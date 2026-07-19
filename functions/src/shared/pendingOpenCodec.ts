import { isOpenableBoxMinterItemsPerBox } from './boxMinterProtocol.js';
import {
  bytesEqual,
  hasAnyNonZeroByte,
  readU32LE,
  readU64LE,
} from './byteCodec.js';

export const PENDING_OPEN_BOX_DISCRIMINATOR = Uint8Array.from([
  0x45, 0x07, 0x45, 0x1a, 0xf0, 0x0c, 0x43, 0xa1,
]);

export type PendingOpenBoxLayout = 'legacyFixed' | 'vec';

export type PendingOpenCodecErrorReason =
  | 'too-short'
  | 'invalid-discriminator'
  | 'truncated-vector'
  | 'truncated-config'
  | 'unexpected-trailing-bytes';

export class PendingOpenCodecError extends Error {
  constructor(readonly reason: PendingOpenCodecErrorReason) {
    super(reason);
    this.name = 'PendingOpenCodecError';
  }
}

export type DecodedPendingOpenData = {
  owner: Uint8Array;
  boxAsset: Uint8Array;
  dudeAssets: Uint8Array[];
  createdSlot: bigint;
  bump: number;
  layout: PendingOpenBoxLayout;
  config?: Uint8Array;
};

export type DecodePendingOpenDataOptions = {
  legacyDudeCounts?: readonly unknown[];
  inferLegacyDudeCount?: boolean;
  allowZeroPaddingAfterConfig?: boolean;
};

const HEADER_LEN = 8 + 32 + 32;
const LEGACY_BASE_LEN = HEADER_LEN + 8 + 1;
const VEC_BASE_LEN = HEADER_LEN + 4 + 8 + 1;

export function normalizePendingOpenDudeCount(value: unknown): number | null {
  const count = Number(value);
  return isOpenableBoxMinterItemsPerBox(count) ? count : null;
}

function inferLegacyFixedDudeCount(dataLength: number): number | null {
  const dudeBytes = dataLength - LEGACY_BASE_LEN;
  if (dudeBytes < 32 || dudeBytes % 32 !== 0) return null;
  return normalizePendingOpenDudeCount(dudeBytes / 32);
}

function decodeLegacyFixed(
  data: Uint8Array,
  dudeCount: number,
): DecodedPendingOpenData | null {
  if (data.length !== LEGACY_BASE_LEN + 32 * dudeCount) return null;

  let offset = 8;
  const owner = data.subarray(offset, offset + 32);
  offset += 32;
  const boxAsset = data.subarray(offset, offset + 32);
  offset += 32;
  const dudeAssets: Uint8Array[] = [];
  for (let index = 0; index < dudeCount; index += 1) {
    dudeAssets.push(data.subarray(offset, offset + 32));
    offset += 32;
  }
  const createdSlot = readU64LE(data, offset);
  offset += 8;
  const bump = data[offset] ?? 0;
  return { owner, boxAsset, dudeAssets, createdSlot, bump, layout: 'legacyFixed' };
}

function decodeVec(
  data: Uint8Array,
  allowZeroPaddingAfterConfig: boolean,
): DecodedPendingOpenData {
  if (data.length < VEC_BASE_LEN) {
    throw new PendingOpenCodecError('too-short');
  }

  let offset = 8;
  const owner = data.subarray(offset, offset + 32);
  offset += 32;
  const boxAsset = data.subarray(offset, offset + 32);
  offset += 32;
  const dudeCount = readU32LE(data, offset);
  offset += 4;
  const expectedLen = VEC_BASE_LEN + 32 * dudeCount;
  if (data.length < expectedLen) {
    throw new PendingOpenCodecError('truncated-vector');
  }

  const dudeAssets: Uint8Array[] = [];
  for (let index = 0; index < dudeCount; index += 1) {
    dudeAssets.push(data.subarray(offset, offset + 32));
    offset += 32;
  }
  const createdSlot = readU64LE(data, offset);
  offset += 8;
  const bump = data[offset] ?? 0;
  offset += 1;

  let config: Uint8Array | undefined;
  if (offset < data.length) {
    const trailing = data.subarray(offset);
    if (trailing.length < 32) {
      throw new PendingOpenCodecError('truncated-config');
    }
    config = trailing.subarray(0, 32);
    const padding = trailing.subarray(32);
    if (
      (!allowZeroPaddingAfterConfig && padding.length > 0) ||
      hasAnyNonZeroByte(padding)
    ) {
      throw new PendingOpenCodecError('unexpected-trailing-bytes');
    }
  }

  return {
    owner,
    boxAsset,
    dudeAssets,
    createdSlot,
    bump,
    layout: 'vec',
    ...(config ? { config } : {}),
  };
}

export function decodePendingOpenData(
  data: Uint8Array,
  options: DecodePendingOpenDataOptions = {},
): DecodedPendingOpenData {
  if (data.length < LEGACY_BASE_LEN) {
    throw new PendingOpenCodecError('too-short');
  }
  if (!bytesEqual(data.subarray(0, 8), PENDING_OPEN_BOX_DISCRIMINATOR)) {
    throw new PendingOpenCodecError('invalid-discriminator');
  }

  const legacyDudeCounts = Array.from(
    new Set(
      (options.legacyDudeCounts ?? [])
        .map(normalizePendingOpenDudeCount)
        .filter((count): count is number => count != null),
    ),
  );
  if (legacyDudeCounts.length > 0) {
    for (const dudeCount of legacyDudeCounts) {
      const decoded = decodeLegacyFixed(data, dudeCount);
      if (decoded) return decoded;
    }
  } else if (options.inferLegacyDudeCount) {
    const inferredDudeCount = inferLegacyFixedDudeCount(data.length);
    if (inferredDudeCount != null) {
      const decoded = decodeLegacyFixed(data, inferredDudeCount);
      if (decoded) return decoded;
    }
  }

  return decodeVec(data, options.allowZeroPaddingAfterConfig === true);
}
