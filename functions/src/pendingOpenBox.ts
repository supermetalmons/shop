import { PublicKey } from '@solana/web3.js';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  decodePendingOpenData,
  PendingOpenCodecError,
  PENDING_OPEN_BOX_DISCRIMINATOR,
  type PendingOpenBoxLayout,
} from './shared/pendingOpenCodec.js';

export const ACCOUNT_PENDING_OPEN_BOX = Buffer.from(PENDING_OPEN_BOX_DISCRIMINATOR);
export type { PendingOpenBoxLayout } from './shared/pendingOpenCodec.js';

export type DecodedPendingOpenBox = {
  owner: PublicKey;
  boxAsset: PublicKey;
  dudeAssets: PublicKey[];
  createdSlot: bigint;
  bump: number;
  layout: PendingOpenBoxLayout;
  config?: PublicKey;
};

type DecodePendingOpenBoxOptions = {
  expectedDudeCount?: number;
};

function throwPendingOpenHttpsError(error: PendingOpenCodecError): never {
  const messageByReason = {
    'too-short': 'Invalid PendingOpenBox account data (too short)',
    'invalid-discriminator': 'Invalid PendingOpenBox account discriminator',
    'truncated-vector': 'Invalid PendingOpenBox account data (truncated vector)',
    'truncated-config': 'Invalid PendingOpenBox account data (truncated config)',
    'unexpected-trailing-bytes': 'Invalid PendingOpenBox account data (unexpected trailing bytes)',
  } satisfies Record<PendingOpenCodecError['reason'], string>;
  throw new HttpsError('failed-precondition', messageByReason[error.reason]);
}

export function decodePendingOpenBox(
  data: Buffer | Uint8Array,
  options: DecodePendingOpenBoxOptions = {},
): DecodedPendingOpenBox {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  try {
    const decoded = decodePendingOpenData(buf, {
      legacyDudeCounts: [options.expectedDudeCount],
      inferLegacyDudeCount: true,
      allowZeroPaddingAfterConfig: true,
    });
    const config = decoded.config ? new PublicKey(decoded.config) : undefined;
    return {
      owner: new PublicKey(decoded.owner),
      boxAsset: new PublicKey(decoded.boxAsset),
      dudeAssets: decoded.dudeAssets.map((asset) => new PublicKey(asset)),
      createdSlot: decoded.createdSlot,
      bump: decoded.bump,
      layout: decoded.layout,
      ...(config ? { config } : {}),
    };
  } catch (error) {
    if (error instanceof PendingOpenCodecError) {
      throwPendingOpenHttpsError(error);
    }
    throw error;
  }
}
