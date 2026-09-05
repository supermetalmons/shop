import bs58 from 'bs58';
import { z } from 'zod';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  API_DROPS,
  getApiDrop,
  type ApiDropConfig,
} from './dropConfig.js';
import { dropDeliveryOrderPath } from './dropPaths.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import type {
  PrepareDeliveryRequest,
  PrepareDeliveryResponse,
} from '../../../../shared/contracts.js';
import { DELIVERY_PREPARE_ATTEMPT_HEADER } from '../../../../shared/contracts.js';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  type DasAsset,
} from '../../../../shared/dasAsset.js';
import { uniqueAssetGroupingCollectionMint } from '../../../../shared/dasAssetCollections.js';
import { DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS } from '../../../../shared/deliveryRecovery.js';
import { HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES } from '../../../../shared/heliusDas.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  isNonZeroBase58Bytes,
  isTransientShopRpcError,
} from '../../../../shared/solanaRpcProxy.js';
import {
  canDeliverItemKind,
  calculateDeliveryLamports,
  normalizeDeliveryUnitsPerBox,
} from '../../../../shared/shipping.js';
import { RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import { type ProfileProviderFetch } from './boundedResponse.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import {
  registerDeferredWork,
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import { isRecord, ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import {
  createSolanaProvider,
  parseSolanaRpcAccount,
  SolanaProviderError,
  type SolanaRetryPolicy,
} from './solanaProvider.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentData,
} from './commerceRepository.js';
import {
  loadD1ProfileAddress,
  type D1ProfileAddress,
} from './profileD1.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';

export const DELIVERY_PREPARE_PATH = '/delivery/prepare';

const REQUEST_MAX_BYTES = 4096;
const PROVIDER_MAX_BYTES = HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES;
const HANDLER_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const RECONCILE_TIMEOUT_MS = 5_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const PROVIDER_CONCURRENCY = 3;
const ASSET_FETCH_MAX_ATTEMPTS = 6;
const ASSET_FETCH_MAX_WAIT_MS = 12_000;
const ASSET_FETCH_RETRY_BASE_DELAY_MS = 300;
const MAX_DELIVERY_ITEMS = 32;
const MAX_DELIVERY_ID_ATTEMPTS = 16;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const SERVER_INVALID_DELIVERY_UNITS_POLICY = 'arithmetic' as const;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
const MPL_CORE_COLLECTION_V1_DISCRIMINATOR = 5;
const MPL_CORE_COLLECTION_V1_MIN_BYTES = 49;
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

const requestSchema = z.object({
  owner: z.string().min(32).max(64),
  dropId: z.string().min(1).max(64),
  itemIds: z.array(z.string().min(32).max(64)).min(1).max(MAX_DELIVERY_ITEMS),
  addressId: z.string().regex(/^[A-Za-z0-9]{20}$/),
}).strict();

type DeliveryPrepareEnv = Pick<
  Env,
  'COSIGNER_SECRET' | 'HELIUS_API_KEY'
> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'OPS_DB'>>;

type DeliveryPrepareErrorCode = ApiErrorCode;

class DeliveryPrepareError extends Error {
  constructor(
    readonly code: DeliveryPrepareErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryPrepareError';
  }
}

type DeliveryRuntime = {
  config: ApiDropConfig;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  deliveryLookupTable?: PublicKey;
  itemsPerBox: number;
  maxSupply: number;
  maxDudeId: number;
};

type CommerceContext = {
  commerceDb?: D1Database;
  nowMs: number;
  repository?: D1CommerceRepository;
  signal: AbortSignal;
  [key: string]: unknown;
};

function commerceRepository(context: CommerceContext): D1CommerceRepository {
  if (context.repository) return context.repository;
  if (context.commerceDb) return new D1CommerceRepository(context.commerceDb);
  throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
}

type ProviderContext = {
  apiKey: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  attemptTimeoutMs?: number;
};

type AddressDocument = {
  decoded: CommerceDocumentData;
};

type OnchainState = {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
};

type DeliveryOrderItem = {
  assetId: string;
  kind: 'box' | 'dude';
  refId: number;
};

type DeliveryPrepareDependencies = {
  attemptId: () => string;
  candidateId: () => number;
  defer: DeferredWork;
  createDeliveryOrder: (
    context: CommerceContext,
    input: DeliveryOrderCreateInput,
  ) => Promise<string>;
  deleteDeliveryOrder: (
    context: CommerceContext,
    path: string,
    updateTime: string,
  ) => Promise<void>;
  deliveryPdaExists: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
    deliveryPda: PublicKey,
  ) => Promise<boolean>;
  fetchAsset: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
    assetId: string,
  ) => Promise<DasAsset>;
  getDrop: (dropId: string) => ApiDropConfig | undefined;
  loadAddress: (
    context: CommerceContext,
    db: D1Database | undefined,
    wallet: string,
    addressId: string,
  ) => Promise<AddressDocument>;
  loadLatestBlockhash: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
  ) => Promise<{ blockhash: string; blockhashContextSlot: number }>;
  loadLookupTable: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
  ) => Promise<AddressLookupTableAccount[]>;
  loadOnchainState: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
  ) => Promise<OnchainState>;
  loadBoundWallet: (
    context: CommerceContext,
    db: D1Database | undefined,
    uid: string,
  ) => Promise<string>;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  createCommerceRepository: (db: D1Database) => D1CommerceRepository;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

type DeliveryPrepareMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type DeliveryPrepareResult = {
  response: Response;
  metrics: DeliveryPrepareMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
};

type DeliveryOrderCreateInput = {
  path: string;
  dropId: string;
  owner: string;
  addressId: string;
  address: AddressDocument;
  addressCountry: string;
  items: DeliveryOrderItem[];
  deliveryId: number;
  deliveryPda: string;
  lookupTable?: string;
  deliveryLamports: number;
  nextPreparedProbeAtMs: number;
  prepareAttemptId: string;
};

function errorResponse(error: DeliveryPrepareError): Response {
  return jsonResponse(apiErrorBody(error), httpStatusForApiErrorCode(error.code, 502));
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<PrepareDeliveryRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new DeliveryPrepareError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Delivery preparation request is too large.'
          : 'Invalid delivery preparation request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation request.');
  return parsed.data;
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('non-canonical');
    return key;
  } catch {
    throw new DeliveryPrepareError('invalid-argument', `Invalid ${label}`);
  }
}

function configuredPublicKey(label: string, value: string | undefined, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new DeliveryPrepareError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new DeliveryPrepareError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof DeliveryPrepareError) throw error;
    throw new DeliveryPrepareError('failed-precondition', `${label} is invalid.`);
  }
}

function buildRuntime(config: ApiDropConfig): DeliveryRuntime {
  const dropId = normalizeDropId(config.dropId);
  const itemsPerBox = Number(config.itemsPerBox);
  const maxSupply = Number(config.maxSupply);
  const maxDudeId = maxSupply * itemsPerBox;
  if (
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox) ||
    !Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Delivery drop configuration is invalid.', { dropId });
  }
  const boxMinterProgramId = configuredPublicKey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId)!;
  const boxMinterConfigPda = configuredPublicKey('BOX_MINTER_CONFIG_PDA', config.boxMinterConfigPda, false) ||
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint: configuredPublicKey('COLLECTION_MINT', config.collectionMint)!,
    deliveryLookupTable: configuredPublicKey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable, false),
    itemsPerBox,
    maxSupply,
    maxDudeId,
  };
}

function clusterSharesCollection(runtime: DeliveryRuntime): boolean {
  return Object.values(API_DROPS).some((candidate) =>
    candidate.dropId !== runtime.dropId &&
    candidate.solanaCluster === runtime.cluster &&
    candidate.collectionMint === runtime.collectionMint.toBase58());
}

const PROVIDER_RETRY: SolanaRetryPolicy = {
  attempts: 2,
  delayMs: () => 100,
  shouldRetry: (failure) =>
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    failure.kind === 'body' ||
    (failure.kind === 'http' && TRANSIENT_HTTP_STATUSES.has(failure.status || 0)) ||
    (failure.kind === 'rpc' && isTransientShopRpcError({
      code: failure.rpcCode,
      message: failure.message,
      ...(failure.rpcData === undefined ? {} : { data: failure.rpcData }),
    })),
};

const PROVIDER_REST_RETRY: SolanaRetryPolicy = {
  ...PROVIDER_RETRY,
  shouldRetry: (failure, attemptNumber) =>
    failure.kind === 'invalid-response' ||
    (failure.kind !== 'rpc' && PROVIDER_RETRY.shouldRetry(failure, attemptNumber)),
};

function provider(context: ProviderContext, runtime: DeliveryRuntime) {
  return createSolanaProvider({
    apiKey: context.apiKey,
    attemptTimeoutMs: context.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS,
    cluster: runtime.cluster,
    fetch: context.providerFetch,
    maxResponseBytes: PROVIDER_MAX_BYTES,
    requestId: (method) => `delivery-prepare-${method}`,
    retry: PROVIDER_RETRY,
    signal: context.signal,
  });
}

function translateProviderError(
  context: ProviderContext,
  error: unknown,
): DeliveryPrepareError {
  if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
  if (!(error instanceof SolanaProviderError)) {
    return new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
  }
  if (error.kind === 'timeout') {
    return new DeliveryPrepareError('deadline-exceeded', 'Delivery provider request timed out.');
  }
  if ((error.kind === 'network' || error.kind === 'body') && error.method?.endsWith('Rest')) {
    return new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid response.');
  }
  if (error.kind === 'invalid-response') {
    return new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid response.');
  }
  if (error.kind === 'rpc') {
    return new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.', {
      method: error.method,
      ...(Number.isFinite(error.rpcCode) ? { upstreamCode: error.rpcCode } : {}),
    });
  }
  if (error.kind === 'not-found' && error.resource === 'asset') {
    return new DeliveryPrepareError('not-found', 'Asset not found.');
  }
  return new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
}

async function rpcCall(
  context: ProviderContext,
  runtime: DeliveryRuntime,
  method: string,
  params: unknown,
): Promise<unknown> {
  try {
    return await provider(context, runtime).rpc(method, params);
  } catch (error) {
    throw translateProviderError(context, error);
  }
}

async function fetchAsset(
  context: ProviderContext,
  runtime: DeliveryRuntime,
  assetId: string,
): Promise<DasAsset> {
  try {
    return await provider(context, runtime).getAsset(assetId, {
      indexingRetry: {
        attempts: ASSET_FETCH_MAX_ATTEMPTS,
        baseDelayMs: ASSET_FETCH_RETRY_BASE_DELAY_MS,
        capDelayToRemaining: true,
        maxElapsedMs: ASSET_FETCH_MAX_WAIT_MS,
      },
      restRetry: PROVIDER_REST_RETRY,
    });
  } catch (error) {
    throw translateProviderError(context, error);
  }
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  try {
    return parseSolanaRpcAccount(value, { maxEncodedBytes: PROVIDER_MAX_BYTES });
  } catch (error) {
    if (error instanceof SolanaProviderError && error.reason === 'account-shape') {
      throw new DeliveryPrepareError('failed-precondition', `${label} is invalid.`);
    }
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned invalid account data.');
  }
}

function paymentRoutingMatches(config: ApiDropConfig, decoded: DecodedBoxMinterConfigData): boolean {
  const paymentRouting = decoded.paymentRouting;
  if (!paymentRouting) return false;
  if (!config.paymentRouting) return paymentRouting.schema === 'legacy';
  if (paymentRouting.schema !== 'split-payments-v1') return false;
  if (
    new PublicKey(paymentRouting.deliveryPaymentReceiver).toBase58() !== config.paymentRouting.deliveryPaymentReceiver ||
    paymentRouting.mintProceeds.length !== config.paymentRouting.mintProceeds.length
  ) return false;
  return config.paymentRouting.mintProceeds.every((expected, index) => {
    const actual = paymentRouting.mintProceeds[index];
    return Boolean(actual) &&
      new PublicKey(actual.address).toBase58() === expected.address &&
      actual.percentage === expected.percentage;
  });
}

async function loadOnchainState(
  context: ProviderContext,
  runtime: DeliveryRuntime,
): Promise<OnchainState> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    [runtime.collectionMint.toBase58(), runtime.boxMinterConfigPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid account response.');
  }
  if (!result.value[0]) {
    throw new DeliveryPrepareError('failed-precondition', 'Configured collection was not found on-chain.', {
      collection: runtime.collectionMint.toBase58(),
      dropId: runtime.dropId,
    });
  }
  if (!result.value[1]) {
    throw new DeliveryPrepareError('failed-precondition', 'Box minter config PDA not found.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const configAccount = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (
    !collection.owner.equals(MPL_CORE_PROGRAM_ID) ||
    collection.data.length < MPL_CORE_COLLECTION_V1_MIN_BYTES ||
    collection.data[0] !== MPL_CORE_COLLECTION_V1_DISCRIMINATOR
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Configured collection is not an MPL Core collection.');
  }
  if (!configAccount.owner.equals(runtime.boxMinterProgramId)) {
    throw new DeliveryPrepareError('failed-precondition', 'Box minter config PDA has an unexpected owner.');
  }
  let decoded: DecodedBoxMinterConfigData;
  try {
    decoded = decodeBoxMinterConfigData(configAccount.data, {
      validateDiscriminator: true,
      decodeExtensions: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new DeliveryPrepareError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  const admin = new PublicKey(decoded.admin);
  const treasury = new PublicKey(decoded.treasury);
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (
    !coreCollection.equals(runtime.collectionMint) ||
    decoded.itemsPerBox !== runtime.itemsPerBox ||
    decoded.maxSupply !== runtime.maxSupply ||
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet ||
    !isBoxMinterDiscountMintsPerWallet(decoded.discountMintsPerWallet) ||
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ) ||
    treasury.toBase58() !== runtime.config.treasury ||
    !paymentRoutingMatches(runtime.config, decoded)
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Committed drop configuration does not match the on-chain config.', {
      dropId: runtime.dropId,
    });
  }
  return { admin, treasury, coreCollection };
}

async function loadLatestBlockhash(
  context: ProviderContext,
  runtime: DeliveryRuntime,
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
    !Number.isSafeInteger(lastValidBlockHeight) ||
    Number(lastValidBlockHeight) < 0 ||
    !isNonZeroBase58Bytes(blockhash, 32)
  ) {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid blockhash.');
  }
  return {
    blockhash,
    blockhashContextSlot: Number(contextValue.slot),
  };
}

async function loadLookupTable(
  context: ProviderContext,
  runtime: DeliveryRuntime,
): Promise<AddressLookupTableAccount[]> {
  if (!runtime.deliveryLookupTable) return [];
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    runtime.deliveryLookupTable.toBase58(),
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  const value = isRecord(result) ? result.value : undefined;
  if (!value) {
    throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE not found on-chain.');
  }
  const account = parseRpcAccount(value, 'DELIVERY_LOOKUP_TABLE');
  if (!account.owner.equals(AddressLookupTableProgram.programId)) {
    throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE has an unexpected owner.');
  }
  try {
    const lookupTable = new AddressLookupTableAccount({
      key: runtime.deliveryLookupTable,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
    if (!lookupTable.isActive()) {
      throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is inactive.');
    }
    return [lookupTable];
  } catch (error) {
    if (error instanceof DeliveryPrepareError) throw error;
    throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is invalid.');
  }
}

async function deliveryPdaExists(
  context: ProviderContext,
  runtime: DeliveryRuntime,
  deliveryPda: PublicKey,
): Promise<boolean> {
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    deliveryPda.toBase58(),
    { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Object.hasOwn(result, 'value')) {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid account response.');
  }
  return result.value !== null;
}

async function loadBoundWallet(
  context: CommerceContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
    const resolution = await resolveD1AuthWalletBinding(db, uid, context.signal);
    if ('reason' in resolution) throw new DeliveryPrepareError('unauthenticated', 'Sign in with your wallet first.');
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (
      error instanceof DeliveryPrepareError ||
      error instanceof ProfileReadError
    ) throw error;
    throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
  }
}

function d1AddressDocument(address: D1ProfileAddress): AddressDocument {
  return {
    decoded: {
      id: address.id,
      country: address.country,
      encrypted: address.encrypted,
      hint: address.hint,
      createdAt: address.createdAtMs,
      ...(address.countryCode ? { countryCode: address.countryCode } : {}),
      ...(address.email ? { email: address.email } : {}),
      ...(address.label ? { label: address.label } : {}),
    },
  };
}

async function loadAddress(
  context: CommerceContext,
  db: D1Database | undefined,
  wallet: string,
  addressId: string,
): Promise<AddressDocument> {
  if (!db) throw new DeliveryPrepareError('unavailable', 'Delivery address is temporarily unavailable.');
  let stored;
  try {
    stored = await loadD1ProfileAddress(db, wallet, addressId, context.signal);
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    throw new DeliveryPrepareError('unavailable', 'Delivery address is temporarily unavailable.');
  }
  if (stored) return d1AddressDocument(stored);
  throw new DeliveryPrepareError('not-found', 'Address not found');
}

async function createDeliveryOrder(
  context: CommerceContext,
  input: DeliveryOrderCreateInput,
): Promise<string> {
  const reconcile = () => reconcileCreatedDeliveryOrder({
    ...context,
    signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
  }, input).catch(() => null);
  const fields = {
    dropId: input.dropId,
    status: 'prepared',
    owner: input.owner,
    addressId: input.addressId,
    addressSnapshot: {
      ...input.address.decoded,
      id: input.addressId,
      ...(input.addressCountry ? { countryCode: input.addressCountry } : {}),
    },
    itemIds: input.items.map((item) => item.assetId),
    items: input.items,
    deliveryId: input.deliveryId,
    deliveryPda: input.deliveryPda,
    ...(input.lookupTable ? { lookupTable: input.lookupTable } : {}),
    deliveryLamports: input.deliveryLamports,
    prepareAttemptId: input.prepareAttemptId,
    receiptRecovery: {
      preparedProbeCount: 0,
      nextPreparedProbeAt: input.nextPreparedProbeAtMs,
    },
    createdAt: commerceFieldValue.serverTimestamp(),
  };
  const key = commerceKeys.deliveryOrder(input.dropId, String(input.deliveryId));
  try {
    if (key.path !== input.path) throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
    const created = await commerceRepository(context).run(
      context.nowMs,
      async (unit) => unit.create(key, fields),
    );
    return created.updateTime;
  } catch (error) {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    throw error;
  }
}

async function reconcileCreatedDeliveryOrder(
  context: CommerceContext,
  input: DeliveryOrderCreateInput,
): Promise<string | null> {
  const key = commerceKeys.deliveryOrder(input.dropId, String(input.deliveryId));
  if (key.path !== input.path) return null;
  const document = await commerceRepository(context).get(key);
  if (!document) return null;
  const decoded = document.data;
  if (
    !decoded ||
    decoded.prepareAttemptId !== input.prepareAttemptId ||
    decoded.status !== 'prepared' ||
    decoded.dropId !== input.dropId ||
    decoded.owner !== input.owner ||
    decoded.addressId !== input.addressId ||
    decoded.deliveryId !== input.deliveryId ||
    decoded.deliveryPda !== input.deliveryPda ||
    decoded.deliveryLamports !== input.deliveryLamports ||
    JSON.stringify(decoded.itemIds) !== JSON.stringify(input.items.map((item) => item.assetId))
  ) return null;
  return document.updateTime;
}

async function deleteDeliveryOrder(
  context: CommerceContext,
  path: string,
  updateTime: string,
): Promise<void> {
  const identity = path.match(/^drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
  if (!identity) throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
  const key = commerceKeys.deliveryOrder(identity[1], identity[2]);
  await commerceRepository(context).run(context.nowMs, async (unit) => {
    const current = await unit.get(key);
    if (!current || current.updateTime !== updateTime) throw new CommerceWriteConflict();
    await unit.delete(key, { mustExist: true });
  });
}

function secureDeliveryId(): number {
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while ((values[0] & 0x7fff_ffff) === 0);
  return values[0] & 0x7fff_ffff;
}

function decodeCosigner(secret: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret.trim());
  } catch {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
  if (decoded.length !== 64) {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
  try {
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
}

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function u64LE(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function maximumDeliveryLamports(runtime: DeliveryRuntime): number {
  const maximumFigures = MAX_DELIVERY_ITEMS * Math.max(
    1,
    normalizeDeliveryUnitsPerBox(runtime.itemsPerBox, SERVER_INVALID_DELIVERY_UNITS_POLICY),
  );
  return Math.max(
    calculateDeliveryLamports(
      Array.from({ length: MAX_DELIVERY_ITEMS }, () => ({ kind: 'box' as const })),
      'US',
      runtime.itemsPerBox,
      runtime.config.dropFamily,
      SERVER_INVALID_DELIVERY_UNITS_POLICY,
    ),
    calculateDeliveryLamports(
      Array.from({ length: maximumFigures }, () => ({ kind: 'dude' as const })),
      'ZZ',
      runtime.itemsPerBox,
      runtime.config.dropFamily,
      SERVER_INVALID_DELIVERY_UNITS_POLICY,
    ),
  );
}

function encodeDeliverArgs(
  runtime: DeliveryRuntime,
  deliveryId: number,
  feeLamports: number,
  deliveryBump: number,
): Buffer {
  if (!Number.isInteger(deliveryId) || deliveryId < 1 || deliveryId > 0xffff_ffff) {
    throw new DeliveryPrepareError('invalid-argument', 'Invalid deliveryId');
  }
  if (
    !Number.isSafeInteger(feeLamports) ||
    feeLamports < 0 ||
    feeLamports > maximumDeliveryLamports(runtime)
  ) {
    throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery_fee_lamports');
  }
  if (!Number.isInteger(deliveryBump) || deliveryBump < 0 || deliveryBump > 255) {
    throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery bump');
  }
  return Buffer.concat([IX_DELIVER, u32LE(deliveryId), u64LE(feeLamports), Buffer.from([deliveryBump])]);
}

function isLegacySingletonConfigPda(programId: PublicKey, configPda: PublicKey): boolean {
  return configPda.equals(PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0]);
}

function deriveDeliveryPda(runtime: DeliveryRuntime, deliveryId: number): [PublicKey, number] {
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!isLegacySingletonConfigPda(runtime.boxMinterProgramId, runtime.boxMinterConfigPda)) {
    seeds.push(runtime.boxMinterConfigPda.toBuffer());
  }
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, runtime.boxMinterProgramId);
}

function buildInstruction(args: {
  runtime: DeliveryRuntime;
  owner: PublicKey;
  signer: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
  deliveryLamports: number;
  assetPks: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.runtime.boxMinterProgramId,
    keys: [
      { pubkey: args.runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.treasury, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.deliveryPda, isSigner: false, isWritable: true },
      ...args.assetPks.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeDeliverArgs(args.runtime, args.deliveryId, args.deliveryLamports, args.deliveryBump),
  });
}

function buildTransaction(
  instructions: TransactionInstruction[],
  owner: PublicKey,
  blockhash: string,
  signer: Keypair,
  lookupTables: AddressLookupTableAccount[],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([signer]);
  return transaction;
}

function transactionEncodingTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof RangeError && (
    /encoding overruns Uint8Array/i.test(message) ||
    /offset.*out of range/i.test(message) ||
    String((error as { code?: unknown }).code || '') === 'ERR_OUT_OF_RANGE'
  );
}

function serializedTransactionSize(build: () => VersionedTransaction): number {
  try {
    return build().serialize().length;
  } catch (error) {
    if (!transactionEncodingTooLarge(error)) throw error;
    return SOLANA_MAX_RAW_TX_BYTES + 1;
  }
}

function ensurePacketFits(args: {
  runtime: DeliveryRuntime;
  owner: PublicKey;
  signer: Keypair;
  lookupTables: AddressLookupTableAccount[];
  assetPks: PublicKey[];
  onchain: OnchainState;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
  deliveryLamports: number;
}): TransactionInstruction {
  const instruction = buildInstruction({
    runtime: args.runtime,
    owner: args.owner,
    signer: args.signer.publicKey,
    treasury: args.onchain.treasury,
    coreCollection: args.onchain.coreCollection,
    deliveryPda: args.deliveryPda,
    deliveryId: args.deliveryId,
    deliveryBump: args.deliveryBump,
    deliveryLamports: args.deliveryLamports,
    assetPks: args.assetPks,
  });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction];
  const rawBytes = serializedTransactionSize(() =>
    buildTransaction(instructions, args.owner, DUMMY_BLOCKHASH, args.signer, args.lookupTables));
  if (rawBytes <= SOLANA_MAX_RAW_TX_BYTES) return instruction;
  let maxFit = 0;
  for (let count = args.assetPks.length - 1; count >= 1; count -= 1) {
    const candidateInstruction = buildInstruction({
      runtime: args.runtime,
      owner: args.owner,
      signer: args.signer.publicKey,
      treasury: args.onchain.treasury,
      coreCollection: args.onchain.coreCollection,
      deliveryPda: args.deliveryPda,
      deliveryId: args.deliveryId,
      deliveryBump: args.deliveryBump,
      deliveryLamports: args.deliveryLamports,
      assetPks: args.assetPks.slice(0, count),
    });
    const candidateBytes = serializedTransactionSize(() => buildTransaction(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), candidateInstruction],
      args.owner,
      DUMMY_BLOCKHASH,
      args.signer,
      args.lookupTables,
    ));
    if (candidateBytes <= SOLANA_MAX_RAW_TX_BYTES) {
      maxFit = count;
      break;
    }
  }
  throw new DeliveryPrepareError(
    'failed-precondition',
    `Delivery transaction too large (${rawBytes} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer items.` +
      (maxFit ? ` Estimated max that fits: ${maxFit}.` : ' Try 1 item.'),
    { rawBytes, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, items: args.assetPks.length, maxFit },
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
  onFailure?: (error: unknown) => void,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await map(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          onFailure?.(error);
        }
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

function orderItem(asset: DasAsset, assetId: string, runtime: DeliveryRuntime, owner: string): DeliveryOrderItem {
  if (asset.id !== assetId) {
    throw new DeliveryPrepareError('failed-precondition', 'Asset id does not match the requested item');
  }
  const kind = dasAssetKind(asset, NAME_POLICY);
  if (!kind) throw new DeliveryPrepareError('failed-precondition', 'Unsupported asset type');
  if (kind === 'certificate') {
    throw new DeliveryPrepareError('failed-precondition', 'Certificates cannot be delivered');
  }
  if (!canDeliverItemKind(runtime.config.dropFamily, kind)) {
    throw new DeliveryPrepareError('failed-precondition', 'Clear Cards packs must be opened before delivery');
  }
  if (
    clusterSharesCollection(runtime) ||
    uniqueAssetGroupingCollectionMint(asset) !== runtime.collectionMint.toBase58()
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Item does not belong to the requested drop');
  }
  if (!isRecord(asset.ownership) || asset.ownership.owner !== owner) {
    throw new DeliveryPrepareError('failed-precondition', 'Item not owned by wallet');
  }
  if (kind === 'box') {
    const refId = Number(dasAssetBoxId(asset, NAME_POLICY));
    if (!Number.isInteger(refId) || refId < 1 || refId > 0xffff_ffff) {
      throw new DeliveryPrepareError('failed-precondition', 'Box id missing from metadata');
    }
    return { assetId, kind, refId };
  }
  const refId = Number(dasAssetDudeId(asset));
  if (!Number.isInteger(refId) || refId < 1 || refId > runtime.maxDudeId) {
    throw new DeliveryPrepareError('failed-precondition', 'Dude id missing from metadata');
  }
  return { assetId, kind, refId };
}

async function prepareDelivery(args: {
  body: PrepareDeliveryRequest;
  context: CommerceContext;
  providerContext: ProviderContext;
  identity: RequestIdentity;
  env: DeliveryPrepareEnv;
  dependencies: DeliveryPrepareDependencies;
  defer: DeferredWork;
  runCritical: <T>(start: () => Promise<T>) => Promise<T>;
  runRead: <T>(operation: Promise<T>) => Promise<T>;
  prepareAttemptId?: string;
}): Promise<PrepareDeliveryResponse> {
  const sessionWallet = await resolveRequestWallet(
    args.identity,
    (uid) => args.runRead(args.dependencies.loadBoundWallet(args.context, args.env.OPS_DB, uid)),
  );
  const owner = canonicalPublicKey(args.body.owner, 'wallet address');
  const ownerWallet = owner.toBase58();
  if (sessionWallet !== ownerWallet) throw new DeliveryPrepareError('permission-denied', 'Owners only');
  const dropId = normalizeDropId(args.body.dropId);
  const config = args.dependencies.getDrop(dropId);
  if (!config) throw new DeliveryPrepareError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const runtime = buildRuntime(config);
  const itemIds = args.body.itemIds.map((itemId) => canonicalPublicKey(itemId, 'asset id').toBase58());
  if (new Set(itemIds).size !== itemIds.length) {
    throw new DeliveryPrepareError('invalid-argument', 'Duplicate itemIds are not allowed');
  }
  const address = await args.runRead(
    args.dependencies.loadAddress(args.context, args.env.OPS_DB, ownerWallet, args.body.addressId),
  );
  const rawAddressCountry = typeof address.decoded.countryCode === 'string' && address.decoded.countryCode
    ? address.decoded.countryCode
    : typeof address.decoded.country === 'string' ? address.decoded.country : '';
  const addressCountry = normalizeCountryCode(rawAddressCountry) || rawAddressCountry;
  const assetAbort = new AbortController();
  const assetContext = {
    ...args.providerContext,
    signal: AbortSignal.any([args.providerContext.signal, assetAbort.signal]),
  };
  const items = await mapWithConcurrency(itemIds, PROVIDER_CONCURRENCY, async (assetId) =>
    orderItem(
      await args.dependencies.fetchAsset(assetContext, runtime, assetId),
      assetId,
      runtime,
      ownerWallet,
    ), (error) => assetAbort.abort(error));
  const deliveryLamports = calculateDeliveryLamports(
    items,
    addressCountry,
    runtime.itemsPerBox,
    runtime.config.dropFamily,
    SERVER_INVALID_DELIVERY_UNITS_POLICY,
  );
  const onchain = await args.dependencies.loadOnchainState(args.providerContext, runtime);
  const signer = decodeCosigner(String(args.env.COSIGNER_SECRET || ''));
  if (!signer.publicKey.equals(onchain.admin)) {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: onchain.admin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  const lookupTables = await args.dependencies.loadLookupTable(args.providerContext, runtime);
  const assetPks = itemIds.map((itemId) => new PublicKey(itemId));
  const prepareAttemptId = args.prepareAttemptId || args.dependencies.attemptId();
  if (!ATTEMPT_ID_PATTERN.test(prepareAttemptId)) {
    throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
  }
  for (let attempt = 0; attempt < MAX_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const deliveryId = args.dependencies.candidateId();
    if (!Number.isInteger(deliveryId) || deliveryId < 1 || deliveryId >= 2 ** 31) {
      throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
    }
    const [deliveryPda, deliveryBump] = deriveDeliveryPda(runtime, deliveryId);
    if (await args.dependencies.deliveryPdaExists(args.providerContext, runtime, deliveryPda)) continue;
    const instruction = ensurePacketFits({
      runtime,
      owner,
      signer,
      lookupTables,
      assetPks,
      onchain,
      deliveryPda,
      deliveryId,
      deliveryBump,
      deliveryLamports,
    });
    const path = dropDeliveryOrderPath(dropId, deliveryId);
    const cleanupCreatedOrder = async (updateTime: string): Promise<void> => {
      try {
        await args.dependencies.deleteDeliveryOrder({
          ...args.context,
          nowMs: args.dependencies.nowMs(),
          signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        }, path, updateTime);
      } catch (cleanupError) {
        rethrowDeferredWorkRegistrationError(cleanupError);
        console.error({
          event: 'delivery_prepare_cleanup_failed',
          dropId,
          deliveryId,
          error: cleanupError instanceof Error ? { name: cleanupError.name, message: cleanupError.message } : { name: 'UnknownError' },
        });
      }
    };
    let updateTime: string;
    try {
      args.context.signal.throwIfAborted();
      updateTime = await args.runCritical(async () => {
        const createdAt = await args.dependencies.createDeliveryOrder(args.context, {
          path,
          dropId,
          owner: ownerWallet,
          addressId: args.body.addressId,
          address,
          addressCountry,
          items,
          deliveryId,
          deliveryPda: deliveryPda.toBase58(),
          ...(runtime.deliveryLookupTable ? { lookupTable: runtime.deliveryLookupTable.toBase58() } : {}),
          deliveryLamports,
          nextPreparedProbeAtMs: args.dependencies.nowMs() + DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[0],
          prepareAttemptId,
        });
        if (args.context.signal.aborted) {
          await cleanupCreatedOrder(createdAt);
          throw args.context.signal.reason;
        }
        return createdAt;
      });
    } catch (error) {
      if (error instanceof CommerceWriteConflict) continue;
      throw error;
    }
    try {
      const latestBlockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
      args.context.signal.throwIfAborted();
      const transaction = buildTransaction(
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
        owner,
        latestBlockhash.blockhash,
        signer,
        lookupTables,
      );
      return {
        encodedTx: Buffer.from(transaction.serialize()).toString('base64'),
        blockhashContextSlot: latestBlockhash.blockhashContextSlot,
        deliveryLamports,
        deliveryId,
      };
    } catch (error) {
      if (args.context.signal.aborted) {
        registerDeferredWork(args.defer, cleanupCreatedOrder(updateTime));
      } else {
        await args.runCritical(() => cleanupCreatedOrder(updateTime));
      }
      throw error;
    }
  }
  throw new DeliveryPrepareError('unavailable', 'Failed to allocate delivery id. Try again.');
}

const defaultDependencies: DeliveryPrepareDependencies = {
  attemptId: () => crypto.randomUUID(),
  candidateId: secureDeliveryId,
  defer: () => undefined,
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  createDeliveryOrder,
  deleteDeliveryOrder,
  deliveryPdaExists,
  fetchAsset,
  loadAddress,
  getDrop: getApiDrop,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  loadBoundWallet,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

export async function handleDeliveryPrepare(
  request: Request,
  env: DeliveryPrepareEnv,
  overrides: Partial<DeliveryPrepareDependencies> = {},
): Promise<DeliveryPrepareResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new DeliveryPrepareError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome: 'rejected',
    };
  }
  return withAuthenticatedRequest<DeliveryPrepareResult>(request, {
    opsDb: env.OPS_DB,
    timeoutMessage: 'Delivery preparation request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    let identity: RequestIdentity | undefined;
    let dropId: string | undefined;
    try {
      identity = await authenticate();
      const body = await readRequestBody(request, deadline.signal);
      const requestedDropId = normalizeDropId(body.dropId);
      dropId = dependencies.getDrop(requestedDropId) ? requestedDropId : undefined;
      const apiKey = String(env.HELIUS_API_KEY || '').trim();
      if (!apiKey || !String(env.COSIGNER_SECRET || '').trim()) {
        throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
      }
      const nowMs = dependencies.nowMs();
      const prepareAttemptId = request.headers.get(DELIVERY_PREPARE_ATTEMPT_HEADER)?.trim();
      if (prepareAttemptId && !ATTEMPT_ID_PATTERN.test(prepareAttemptId)) {
        throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation attempt.');
      }
      const response = await prepareDelivery({
        body,
        identity,
        env,
        dependencies,
        defer: dependencies.defer,
        runCritical: (start) => runCriticalRequestOperation(start, {
          deadline,
          defer: dependencies.defer,
          ignoreDeferredErrors: true,
        }),
        runRead: (operation) => raceReadWithSignal(operation, deadline.signal),
        ...(prepareAttemptId ? { prepareAttemptId } : {}),
        context: {
          nowMs,
          repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
          signal: deadline.signal,
        },
        providerContext: {
          apiKey,
          providerFetch: trackedFetch,
          signal: deadline.signal,
        },
      });
      return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted', dropId };
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isRequestCancellationError(request, error)) throw error;
      let deliveryError: DeliveryPrepareError;
      let authOutcome: DeliveryPrepareResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
      if (error instanceof DeliveryPrepareError) {
        deliveryError = error;
        if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
          authOutcome = 'rejected';
        }
      } else if (error instanceof RequestIdentityError) {
        deliveryError = error.kind === 'invalid-token'
          ? new DeliveryPrepareError('unauthenticated', 'Authentication is required.')
          : error.kind === 'provider-timeout'
            ? new DeliveryPrepareError('deadline-exceeded', 'Delivery preparation request timed out.')
            : new DeliveryPrepareError('unavailable', 'Authentication is temporarily unavailable.');
        authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
      } else if (error instanceof ProfileReadError) {
        deliveryError = new DeliveryPrepareError(error.code, error.message, error.details);
        if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
          authOutcome = 'rejected';
        }
      } else if (error instanceof CommerceWriteConflict) {
        deliveryError = new DeliveryPrepareError('aborted', 'Delivery preparation conflicted. Try again.');
        authOutcome = 'rejected';
      } else if (deadline.timedOut()) {
        deliveryError = new DeliveryPrepareError('deadline-exceeded', 'Delivery preparation request timed out.');
      } else {
        console.error({
          event: 'delivery_prepare_failed',
          error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
        });
        deliveryError = new DeliveryPrepareError('internal', 'Delivery preparation failed.');
      }
      if (!identity) await request.body?.cancel().catch(() => undefined);
      return { response: errorResponse(deliveryError), metrics, authOutcome, ...(dropId ? { dropId } : {}) };
    }
  });
}

export const deliveryPrepareTestHooks = {
  buildInstruction,
  buildRuntime,
  createDeliveryOrder,
  decodeCosigner,
  deriveDeliveryPda,
  encodeDeliverArgs,
  fetchAsset,
  loadAddress,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  loadBoundWallet,
  orderItem,
  prepareDelivery,
  secureDeliveryId,
};
