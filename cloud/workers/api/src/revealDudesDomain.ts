import { PublicKey } from '@solana/web3.js';
import { normalizeDropId, type SolanaCluster } from '../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS, type DeploymentRegistryDrop } from '../../../../shared/deploymentRegistry.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
} from '../../../../shared/boxMinterProtocol.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import type { ApiErrorCode } from './dataAccess.js';
import type { RevealSubmissionRecord } from './revealSubmissionD1.js';

export const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

export type RevealErrorCode = ApiErrorCode;

export class RevealDudesError extends Error {
  constructor(
    readonly code: RevealErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RevealDudesError';
  }
}

export class RevealRpcError extends RevealDudesError {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super('unavailable', message, {
      ...(rpcCode === undefined ? {} : { upstreamCode: rpcCode }),
    });
    this.name = 'RevealRpcError';
  }
}

export type RevealRuntime = {
  config: DeploymentRegistryDrop;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  itemsPerBox: number;
  maxDudeId: number;
};

export type ProviderContext = {
  apiKey: string;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
};

export type RevealContext = {
  commerceDb: D1Database;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  dataDb?: D1Database;
  opsDb?: D1Database;
};

export type RevealSubmission = RevealSubmissionRecord;

export type RevealSubmissionOutcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

export const RESERVATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function configuredPublicKey(value: string | undefined, label: string, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new RevealDudesError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new RevealDudesError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof RevealDudesError) throw error;
    throw new RevealDudesError('failed-precondition', `${label} is invalid.`);
  }
}

export function runtimeForDrop(rawDropId: string): RevealRuntime {
  const dropId = normalizeDropId(rawDropId);
  const config = DEPLOYMENT_DROPS[dropId];
  if (!config) throw new RevealDudesError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const itemsPerBox = Number(config.itemsPerBox);
  const maxSupply = Number(config.maxSupply);
  const maxDudeId = itemsPerBox * maxSupply;
  if (
    itemsPerBox < BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX ||
    !Number.isInteger(maxSupply) || maxSupply < 1 ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff
  ) {
    throw new RevealDudesError('failed-precondition', 'This drop does not support opening.');
  }
  const boxMinterProgramId = configuredPublicKey(config.boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID')!;
  const boxMinterConfigPda = configuredPublicKey(config.boxMinterConfigPda, 'BOX_MINTER_CONFIG_PDA', false) ||
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint: configuredPublicKey(config.collectionMint, 'COLLECTION_MINT')!,
    itemsPerBox,
    maxDudeId,
  };
}
