import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import type { DasAsset } from '../../../../shared/dasAsset.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeBoxMinterMetadataBaseForComparison,
} from '../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS, type DeploymentRegistryDrop } from '../../../../shared/deploymentRegistry.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import { BOX_MINTER_PENDING_OPEN_SEED } from '../../../../shared/boxMinterProtocol.js';
import { decodePendingOpenData } from '../../../../shared/pendingOpenCodec.js';
import { isNonZeroBase58Bytes, isTransientShopRpcError } from '../../../../shared/solanaRpcProxy.js';
import { transformShopInventoryItem } from '../../../../shared/shopDomain.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import {
  createSolanaProvider,
  parseSolanaRpcAccount,
  SolanaProviderError,
  type SolanaRetryPolicy,
} from './solanaProvider.js';
import {
  MPL_CORE_PROGRAM_ID,
  RevealDudesError,
  RevealRpcError,
  type ProviderContext,
  type RevealRuntime,
} from './revealDudesDomain.js';

const PROVIDER_MAX_BYTES = 2 * 1024 * 1024;

export const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;

function revealRetryPolicy(attempts: number): SolanaRetryPolicy {
  return {
    attempts,
    delayMs: () => 100,
    shouldRetry: (error) => {
      if (error.kind === 'rpc') {
        return isTransientShopRpcError({ code: error.rpcCode, message: error.message });
      }
      if (error.kind === 'http') {
        return true;
      }
      return error.kind === 'network' || error.kind === 'timeout' || error.kind === 'body' ||
        error.kind === 'invalid-response';
    },
  };
}

function revealProviderError(error: unknown): RevealDudesError {
  if (!(error instanceof SolanaProviderError)) {
    return new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
  }
  if (error.kind === 'timeout') {
    return new RevealDudesError('deadline-exceeded', 'Reveal provider request timed out.');
  }
  if (error.kind === 'rpc') {
    return new RevealRpcError(error.message, error.rpcCode, error.rpcData);
  }
  if (error.kind === 'invalid-response') {
    return new RevealDudesError('unavailable', 'Reveal provider returned an invalid response.');
  }
  return new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
}

export async function rpcCall(
  context: ProviderContext,
  runtime: Pick<RevealRuntime, 'cluster'>,
  method: string,
  params: unknown,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 2;
  const provider = createSolanaProvider({
    apiKey: context.apiKey,
    attemptTimeoutMs: options.timeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS,
    cluster: runtime.cluster,
    envelope: 'strict',
    fetch: context.fetch,
    maxResponseBytes: PROVIDER_MAX_BYTES,
    requestId: () => crypto.randomUUID(),
    retry: revealRetryPolicy(attempts),
    signal: context.signal,
  });
  try {
    return await provider.rpc(method, params, { accept: 'application/json' });
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    throw revealProviderError(error);
  }
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  try {
    return parseSolanaRpcAccount(value, { maxEncodedBytes: PROVIDER_MAX_BYTES });
  } catch (error) {
    if (error instanceof SolanaProviderError && error.reason === 'account-shape') {
      throw new RevealDudesError('failed-precondition', `${label} is invalid.`);
    }
    throw new RevealDudesError('unavailable', 'Reveal provider returned invalid account data.');
  }
}

function configuredRoutingMatches(runtime: RevealRuntime, decoded: DecodedBoxMinterConfigData): boolean {
  const routing = decoded.paymentRouting;
  if (!routing) return false;
  if ('treasury' in runtime.config) {
    return routing.schema === 'legacy' && bs58.encode(decoded.treasury) === runtime.config.treasury;
  }
  const configured = runtime.config.paymentRouting;
  if (!configured || routing.schema !== 'split-payments-v1') return false;
  if (
    bs58.encode(routing.deliveryPaymentReceiver) !== configured.deliveryPaymentReceiver ||
    routing.mintProceeds.length !== configured.mintProceeds.length
  ) return false;
  return configured.mintProceeds.every((expected, index) => {
    const actual = routing.mintProceeds[index];
    return Boolean(actual) && bs58.encode(actual.address) === expected.address && actual.percentage === expected.percentage;
  });
}

export async function validateOnchainConfig(
  context: ProviderContext,
  runtime: RevealRuntime,
): Promise<{ admin: PublicKey; coreCollection: PublicKey }> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [[
    runtime.collectionMint.toBase58(),
    runtime.boxMinterConfigPda.toBase58(),
  ], { commitment: 'confirmed', encoding: 'base64' }]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new RevealDudesError('unavailable', 'Reveal provider returned an invalid account response.');
  }
  if (!result.value[0] || !result.value[1]) {
    throw new RevealDudesError('failed-precondition', 'On-chain mint configuration is missing.', { dropId: runtime.dropId });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const config = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (!collection.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new RevealDudesError('failed-precondition', 'COLLECTION_MINT is not an MPL Core collection account.');
  }
  if (!config.owner.equals(runtime.boxMinterProgramId)) {
    throw new RevealDudesError('failed-precondition', 'BOX_MINTER_CONFIG_PDA has an unexpected owner.');
  }
  let decoded: DecodedBoxMinterConfigData;
  try {
    decoded = decodeBoxMinterConfigData(config.data, {
      validateDiscriminator: true,
      validateItemsPerBox: true,
      normalizeDiscountMintsPerWallet: true,
      decodeExtensions: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new RevealDudesError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (
    !coreCollection.equals(runtime.collectionMint) ||
    decoded.itemsPerBox !== runtime.itemsPerBox ||
    decoded.maxSupply !== runtime.config.maxSupply ||
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet ||
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ) ||
    !configuredRoutingMatches(runtime, decoded)
  ) {
    throw new RevealDudesError('failed-precondition', 'Committed drop configuration does not match the on-chain config.', {
      dropId: runtime.dropId,
      configuredMetadataBase: runtime.config.metadataBase,
      onchainMetadataBase: normalizeBoxMinterMetadataBaseForComparison(decoded.uriBase),
    });
  }
  return { admin: new PublicKey(decoded.admin), coreCollection };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function revealScopeRuntimes(runtime: RevealRuntime): DeploymentRegistryDrop[] {
  return Object.values(DEPLOYMENT_DROPS).filter((drop) =>
    drop.solanaCluster === runtime.cluster &&
    drop.boxMinterProgramId === runtime.config.boxMinterProgramId &&
    drop.itemsPerBox === runtime.itemsPerBox);
}

export async function loadPendingOpen(
  context: ProviderContext,
  runtime: RevealRuntime,
  owner: PublicKey,
  boxAsset: PublicKey,
): Promise<{
  pendingPda: PublicKey;
  dudeAssets: PublicKey[];
  layout: 'legacyFixed' | 'vec';
}> {
  const pendingPda = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_PENDING_OPEN_SEED), boxAsset.toBuffer()],
    runtime.boxMinterProgramId,
  )[0];
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    pendingPda.toBase58(),
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  const value = isRecord(result) ? result.value : undefined;
  if (!value) {
    throw new RevealDudesError(
      'not-found',
      'Pending open not found. Start opening the box first, then reveal.',
      { pending: pendingPda.toBase58(), boxAssetId: boxAsset.toBase58() },
    );
  }
  const account = parseRpcAccount(value, 'Pending open');
  if (!account.owner.equals(runtime.boxMinterProgramId)) {
    throw new RevealDudesError('failed-precondition', 'Pending open has an unexpected owner.');
  }
  let decoded;
  try {
    decoded = decodePendingOpenData(account.data, { legacyDudeCounts: [runtime.itemsPerBox] });
  } catch {
    throw new RevealDudesError('failed-precondition', 'Pending open data is invalid.');
  }
  if (!bytesEqual(decoded.owner, owner.toBytes()) || !bytesEqual(decoded.boxAsset, boxAsset.toBytes())) {
    throw new RevealDudesError('permission-denied', 'Pending open belongs to a different wallet.');
  }
  if (decoded.dudeAssets.length !== runtime.itemsPerBox) {
    throw new RevealDudesError('failed-precondition', `Pending open has invalid figure placeholder count (expected ${runtime.itemsPerBox}).`);
  }
  if (decoded.config && !bytesEqual(decoded.config, runtime.boxMinterConfigPda.toBytes())) {
    throw new RevealDudesError('failed-precondition', 'Pending open belongs to a different drop config.');
  }
  if (!decoded.config) {
    const scoped = revealScopeRuntimes(runtime);
    if (scoped.length > 1) {
      const sharedCollection = scoped.filter((drop) => drop.collectionMint === runtime.config.collectionMint).length > 1;
      if (sharedCollection) {
        throw new RevealDudesError('failed-precondition', 'Legacy pending open cannot be disambiguated for a shared collection mint.');
      }
      const asset = await rpcCall(context, runtime, 'getAsset', {
        id: boxAsset.toBase58(),
        options: HELIUS_COLLECTION_GROUPING_OPTIONS,
      });
      const item = isRecord(asset) ? transformShopInventoryItem(asset as DasAsset, runtime.cluster) : null;
      if (!item || item.kind !== 'box' || item.dropId !== runtime.dropId) {
        throw new RevealDudesError('failed-precondition', 'Pending open asset does not belong to the requested drop.');
      }
    }
  }
  return {
    pendingPda,
    dudeAssets: decoded.dudeAssets.map((bytes) => new PublicKey(bytes)),
    layout: decoded.layout,
  };
}

export async function loadLatestBlockhash(
  context: ProviderContext,
  runtime: RevealRuntime,
): Promise<{ blockhash: string; blockhashContextSlot: number }> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const contextValue = isRecord(result) ? result.context : undefined;
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  const lastValidBlockHeight = isRecord(value) ? value.lastValidBlockHeight : undefined;
  if (
    !isRecord(contextValue) ||
    !Number.isSafeInteger(contextValue.slot) ||
    Number(contextValue.slot) < 0 ||
    !isNonZeroBase58Bytes(blockhash, 32) ||
    !Number.isSafeInteger(lastValidBlockHeight) ||
    Number(lastValidBlockHeight) < 0
  ) {
    throw new RevealDudesError('unavailable', 'Reveal provider returned an invalid blockhash.');
  }
  return { blockhash, blockhashContextSlot: Number(contextValue.slot) };
}
