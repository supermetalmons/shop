import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
} from '@solana/web3.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import { BOX_MINTER_PENDING_OPEN_SEED } from '../../../../shared/boxMinterProtocol.js';
import type { DasAsset } from '../../../../shared/dasAsset.js';
import { HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES } from '../../../../shared/heliusDas.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import { AdminIrlRedeemPrepareError } from './adminIrlRedeemErrors.js';
import type { AdminIrlRedeemRuntime } from './adminIrlRedeemRuntime.js';
import { isSignalCancellationError } from './boundedRequest.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { isRecord } from './dataAccess.js';
import {
  decodeReceiptProof,
  ReceiptProofDecodeError,
  type DecodedReceiptProof,
} from './receiptProof.js';
import {
  SolanaProviderError,
  createSolanaProvider,
  parseSolanaRpcAccount,
  type SolanaRetryPolicy,
} from './solanaProvider.js';

export { buildRuntime } from './adminIrlRedeemRuntime.js';

const PROVIDER_MAX_BYTES = HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

export type ProviderContext = {
  apiKey: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  attemptTimeoutMs?: number;
};

export type OnchainState = {
  admin: PublicKey;
  coreCollection: PublicKey;
};

const PROVIDER_RETRY: SolanaRetryPolicy = {
  attempts: 2,
  delayMs: () => 100,
  shouldRetry: (failure) =>
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    failure.kind === 'body' ||
    (failure.kind === 'http' && TRANSIENT_HTTP_STATUSES.has(failure.status || 0)),
};

const PROVIDER_REST_RETRY: SolanaRetryPolicy = {
  ...PROVIDER_RETRY,
  shouldRetry: (failure) =>
    failure.kind === 'invalid-response' || PROVIDER_RETRY.shouldRetry(failure, 1),
};

function provider(context: ProviderContext, runtime: AdminIrlRedeemRuntime) {
  return createSolanaProvider({
    apiKey: context.apiKey,
    attemptTimeoutMs: context.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS,
    cluster: runtime.cluster,
    fetch: context.providerFetch,
    maxResponseBytes: PROVIDER_MAX_BYTES,
    requestId: (method) => `admin-irl-redeem-${method}`,
    retry: PROVIDER_RETRY,
    signal: context.signal,
  });
}

function translateProviderError(
  context: ProviderContext,
  error: unknown,
  assetId?: string,
): AdminIrlRedeemPrepareError {
  if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
  if (!(error instanceof SolanaProviderError)) {
    return new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
  }
  if (error.kind === 'timeout') {
    return new AdminIrlRedeemPrepareError('deadline-exceeded', 'Admin IRL redeem provider request timed out.');
  }
  if ((error.kind === 'network' || error.kind === 'body') && error.method?.endsWith('Rest')) {
    return new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid response.');
  }
  if (error.kind === 'invalid-response') {
    return new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid response.');
  }
  if (error.kind === 'rpc') {
    return new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.', {
      method: error.method,
      ...(Number.isFinite(error.rpcCode) ? { upstreamCode: error.rpcCode } : {}),
    });
  }
  if (error.kind === 'not-found') {
    if (error.method === 'getAssetRest') {
      return new AdminIrlRedeemPrepareError('not-found', 'Asset not found.');
    }
    if (error.method === 'getAssetProofRest') {
      return new AdminIrlRedeemPrepareError('not-found', 'Asset proof not found');
    }
    if (error.resource === 'asset-proof') {
      return new AdminIrlRedeemPrepareError('not-found', 'Asset proof not found', { assetId });
    }
    return new AdminIrlRedeemPrepareError(
      'not-found',
      'Asset not found. If you just transferred or minted it, wait a few seconds and try again.',
    );
  }
  return new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
}

export async function rpcCall(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  method: string,
  params: unknown,
): Promise<unknown> {
  try {
    return await provider(context, runtime).rpc(method, params);
  } catch (error) {
    throw translateProviderError(context, error);
  }
}

export async function fetchAsset(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assetId: string,
): Promise<DasAsset> {
  try {
    return await provider(context, runtime).getAsset(assetId, {
      indexingRetry: {
        attempts: 6,
        baseDelayMs: 300,
        capDelayToRemaining: false,
        maxElapsedMs: 12_000,
      },
      restRetry: PROVIDER_REST_RETRY,
    });
  } catch (error) {
    throw translateProviderError(context, error, assetId);
  }
}

export async function fetchAssetProof(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assetId: string,
): Promise<Record<string, unknown>> {
  try {
    return await provider(context, runtime).getAssetProof(assetId, {
      restRetry: PROVIDER_REST_RETRY,
    });
  } catch (error) {
    throw translateProviderError(context, error, assetId);
  }
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  try {
    return parseSolanaRpcAccount(value, { maxEncodedBytes: PROVIDER_MAX_BYTES });
  } catch (error) {
    if (error instanceof SolanaProviderError && error.reason === 'account-shape') {
      throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is invalid.`);
    }
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned invalid account data.');
  }
}

export async function loadOnchainState(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
): Promise<OnchainState> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    [runtime.collectionMint.toBase58(), runtime.boxMinterConfigPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid account response.');
  }
  if (!result.value[0]) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Configured collection was not found on-chain.', {
      collection: runtime.collectionMint.toBase58(),
      dropId: runtime.dropId,
    });
  }
  if (!result.value[1]) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Box minter config PDA not found.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const config = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (!collection.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Configured collection is not an MPL Core collection.');
  }
  if (!config.owner.equals(runtime.boxMinterProgramId)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Box minter config PDA has an unexpected owner.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      expectedOwner: runtime.boxMinterProgramId.toBase58(),
      actualOwner: config.owner.toBase58(),
      dropId: runtime.dropId,
    });
  }
  let decoded: DecodedBoxMinterConfigData;
  try {
    decoded = decodeBoxMinterConfigData(config.data, {
      validateDiscriminator: true,
      decodeExtensions: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (!coreCollection.equals(runtime.collectionMint)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'COLLECTION_MINT does not match on-chain config', {
      configured: runtime.collectionMint.toBase58(),
      onchain: coreCollection.toBase58(),
      dropId: runtime.dropId,
    });
  }
  return { admin: new PublicKey(decoded.admin), coreCollection };
}

export function pendingOpenPda(runtime: AdminIrlRedeemRuntime, asset: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_PENDING_OPEN_SEED), asset.toBuffer()],
    runtime.boxMinterProgramId,
  )[0];
}

export async function loadPendingOpenAccounts(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assets: PublicKey[],
): Promise<boolean[]> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    assets.map((asset) => pendingOpenPda(runtime, asset).toBase58()),
    { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== assets.length) {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid pending-open response.');
  }
  return result.value.map(Boolean);
}

export async function loadLatestBlockhash(context: ProviderContext, runtime: AdminIrlRedeemRuntime): Promise<string> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  try {
    if (!blockhash || new PublicKey(blockhash).toBytes().length !== 32) throw new Error('invalid');
  } catch {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid blockhash.');
  }
  return blockhash;
}

export async function loadLookupTable(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
): Promise<AddressLookupTableAccount[]> {
  if (!runtime.deliveryLookupTable) return [];
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    runtime.deliveryLookupTable.toBase58(),
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  const value = isRecord(result) ? result.value : undefined;
  if (!value) return [];
  const account = parseRpcAccount(value, 'DELIVERY_LOOKUP_TABLE');
  if (!account.owner.equals(AddressLookupTableProgram.programId)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE has an unexpected owner.');
  }
  try {
    const lookup = new AddressLookupTableAccount({
      key: runtime.deliveryLookupTable,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
    return lookup.isActive() ? [lookup] : [];
  } catch {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is invalid.');
  }
}

export function receiptDropIdentity(runtime: AdminIrlRedeemRuntime) {
  return {
    collectionMintStr: runtime.collectionMint.toBase58(),
    metadataBase: runtime.config.metadataBase,
    metadataBaseAliases: runtime.config.metadataBaseAliases,
    receiptsMerkleTree: runtime.receiptsMerkleTree,
    receiptPoolId: runtime.config.receiptPoolId,
    receiptMaxId: runtime.receiptMaxId,
  };
}

export function parseProof(
  asset: DasAsset,
  proof: Record<string, unknown>,
  runtime: AdminIrlRedeemRuntime,
  owner: string,
): DecodedReceiptProof {
  try {
    return decodeReceiptProof({
      asset,
      proof,
      expectedTree: runtime.receiptsMerkleTree,
      expectedOwner: owner,
      dimensions: {
        maxDepth: runtime.receiptsTreeMaxDepth,
        canopyDepth: runtime.receiptsTreeCanopyDepth,
      },
    });
  } catch (error) {
    if (!(error instanceof ReceiptProofDecodeError)) throw error;
    throw new AdminIrlRedeemPrepareError(
      'failed-precondition',
      error.reason === 'index-out-of-range' ? 'Unable to parse receipt leaf id' : error.message,
    );
  }
}
