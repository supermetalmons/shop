import { PublicKey } from '@solana/web3.js';
import { HttpsError } from 'firebase-functions/v2/https';

export const ACCOUNT_PENDING_OPEN_BOX = Buffer.from('4507451af00c43a1', 'hex');

export type DecodedPendingOpenBox = {
  owner: PublicKey;
  boxAsset: PublicKey;
  dudeAssets: PublicKey[];
  createdSlot: bigint;
  bump: number;
  config?: PublicKey;
};

type DecodePendingOpenBoxOptions = {
  expectedDudeCount?: number;
};

const MIN_OPENABLE_ITEMS_PER_BOX = 1;
const MAX_ITEMS_PER_BOX = 5;

function assertPendingOpenHeader(data: Buffer): void {
  const minLen = 8 + 32 + 32 + 8 + 1;
  if (data.length < minLen) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_PENDING_OPEN_BOX)) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account discriminator');
  }
}

function normalizedExpectedDudeCount(value: unknown): number | null {
  const count = Number(value);
  if (
    Number.isInteger(count) &&
    count >= MIN_OPENABLE_ITEMS_PER_BOX &&
    count <= MAX_ITEMS_PER_BOX
  ) {
    return count;
  }
  return null;
}

function inferLegacyFixedDudeCount(dataLength: number): number | null {
  const baseLen = 8 + 32 + 32 + 8 + 1;
  const dudeBytes = dataLength - baseLen;
  if (dudeBytes < 32 || dudeBytes % 32 !== 0) return null;
  const count = dudeBytes / 32;
  return normalizedExpectedDudeCount(count);
}

function decodeLegacyFixedPendingOpenBox(data: Buffer, expectedDudeCount: number): DecodedPendingOpenBox | null {
  const expectedLen = 8 + 32 + 32 + 32 * expectedDudeCount + 8 + 1;
  if (data.length !== expectedLen) return null;

  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const boxAsset = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const dudeAssets: PublicKey[] = [];
  for (let i = 0; i < expectedDudeCount; i += 1) {
    dudeAssets.push(new PublicKey(data.subarray(o, o + 32)));
    o += 32;
  }
  const createdSlot = data.readBigUInt64LE(o);
  o += 8;
  const bump = data.readUInt8(o);
  return { owner, boxAsset, dudeAssets, createdSlot, bump };
}

function decodeVecPendingOpenBox(data: Buffer): DecodedPendingOpenBox {
  const minLen = 8 + 32 + 32 + 4 + 8 + 1;
  if (data.length < minLen) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (too short)');
  }

  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const boxAsset = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const dudeCount = data.readUInt32LE(o);
  o += 4;
  if (data.length < 8 + 32 + 32 + 4 + 32 * dudeCount + 8 + 1) {
    throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (truncated vector)');
  }
  const dudeAssets: PublicKey[] = [];
  for (let i = 0; i < dudeCount; i += 1) {
    dudeAssets.push(new PublicKey(data.subarray(o, o + 32)));
    o += 32;
  }
  const createdSlot = data.readBigUInt64LE(o);
  o += 8;
  const bump = data.readUInt8(o);
  o += 1;
  let config: PublicKey | undefined;
  if (o < data.length) {
    const trailing = data.subarray(o);
    if (trailing.length < 32) {
      throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (truncated config)');
    }
    config = new PublicKey(trailing.subarray(0, 32));
    if (trailing.subarray(32).some((byte) => byte !== 0)) {
      throw new HttpsError('failed-precondition', 'Invalid PendingOpenBox account data (unexpected trailing bytes)');
    }
  }
  return { owner, boxAsset, dudeAssets, createdSlot, bump, ...(config ? { config } : {}) };
}

export function decodePendingOpenBox(
  data: Buffer | Uint8Array,
  options: DecodePendingOpenBoxOptions = {},
): DecodedPendingOpenBox {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  assertPendingOpenHeader(buf);

  // The original little_swag_boxes program stored `dudes` as a fixed `[Pubkey; 3]`,
  // without a Borsh Vec length prefix. Try that exact legacy shape before the Vec layout.
  const expectedDudeCount = normalizedExpectedDudeCount(options.expectedDudeCount);
  if (expectedDudeCount != null) {
    const legacy = decodeLegacyFixedPendingOpenBox(buf, expectedDudeCount);
    if (legacy) return legacy;
  } else {
    const inferredLegacyCount = inferLegacyFixedDudeCount(buf.length);
    if (inferredLegacyCount != null) {
      const legacy = decodeLegacyFixedPendingOpenBox(buf, inferredLegacyCount);
      if (legacy) return legacy;
    }
  }

  return decodeVecPendingOpenBox(buf);
}
