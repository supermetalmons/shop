import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { z } from 'zod';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import type { DasAsset } from '../../../../shared/dasAsset.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeBoxMinterMetadataBaseForComparison,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  DEPLOYMENT_DROPS,
  type DeploymentRegistryDrop,
} from '../../../../shared/deploymentRegistry.js';
import type {
  RevealDudesSubmissionUnknownDetails,
} from '../../../../shared/contracts.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
  BOX_MINTER_PENDING_OPEN_SEED,
} from '../../../../shared/boxMinterProtocol.js';
import {
  DudeAssignmentPoolExhaustedError,
  pickDudeIdsForAssignment,
} from '../../../../shared/assignDudesPicker.js';
import { sanitizeDudeAssignmentPool } from '../../../../shared/dudeAssignmentPool.js';
import {
  encodeFinalizeOpenBoxArgs,
} from '../../../../shared/finalizeOpenBoxArgs.js';
import { decodePendingOpenData } from '../../../../shared/pendingOpenCodec.js';
import {
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
  type PackStatusEvent,
} from '../../../../shared/packStatus.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  isBase58Bytes,
  isExactShopRpcResponse,
  isNonZeroBase58Bytes,
  isTransientShopRpcError,
} from '../../../../shared/solanaRpcProxy.js';
import { transformShopInventoryItem } from '../../../../shared/shopDomain.js';
import { RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
  ProfileReadError,
  commerceDocumentRequest,
  cancelResponseBody,
  decodeFirestoreFields,
  isRecord,
  readBoundedJson,
  type CommerceDocumentRequester,
  type ProfileProviderFetch,
} from './firestoreRest.js';
import { resolveD1WalletSession } from './walletSessionD1.js';
import { applyPackStatusProjection } from './packStatusProjection.js';
import {
  RevealSubmissionOwnerMismatchError,
  loadD1RevealSubmission,
  loadRevealSubmissionStorageControl,
  reserveD1RevealSubmission,
  setD1RevealSubmissionStatus,
  type RevealSubmissionRecord,
  type RevealSubmissionStorageControl,
} from './revealSubmissionD1.js';

export const REVEAL_DUDES_PATH = '/boxes/reveal';

const REQUEST_MAX_BYTES = 4096;
const PROVIDER_MAX_BYTES = 2 * 1024 * 1024;
const HANDLER_TIMEOUT_MS = 55_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
const REVEAL_BACKGROUND_JOB_TIMEOUT_MS = 60_000;
const BACKGROUND_PACK_STATUS_TIMEOUT_MS = 10_000;
const REVEAL_BACKGROUND_JOB_INITIAL_DELAY_SECONDS = 5;
const REVEAL_BACKGROUND_JOB_RETRY_DELAYS_SECONDS = [5, 15, 30, 60, 120, 300] as const;
const FIRESTORE_TRANSACTION_ATTEMPTS = 6;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

type RevealErrorCode =
  | 'invalid-argument'
  | 'unauthenticated'
  | 'permission-denied'
  | 'not-found'
  | 'aborted'
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'deadline-exceeded'
  | 'unavailable'
  | 'internal';

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

class RevealRpcError extends RevealDudesError {
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

type RevealRuntime = {
  config: DeploymentRegistryDrop;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  itemsPerBox: number;
  maxDudeId: number;
};

type RevealMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type RevealDudesResult = {
  response: Response;
  metrics: RevealMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  boxAssetId?: string;
  assignmentOutcome?: 'existing' | 'created';
  transactionOutcome?: 'confirmed' | 'failed' | 'unknown';
};

type RevealDudesDependencies = {
  assignDudes: typeof assignDudes;
  confirmRevealSubmission: typeof confirmRevealSubmission;
  countOnlineRevealPackStatus: typeof countOnlineRevealPackStatus;
  failRevealSubmission: typeof failRevealSubmission;
  loadLatestBlockhash: typeof loadLatestBlockhash;
  loadPendingOpen: typeof loadPendingOpen;
  loadRevealSubmission: typeof loadRevealSubmission;
  loadStorageControl: typeof requireRevealSubmissionStorageControl;
  loadWalletSession: typeof loadWalletSession;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  requestCommerceDocument: CommerceDocumentRequester;
  randomInt: (maxExclusive: number) => number;
  reconcileRevealSubmission: typeof reconcileRevealSubmission;
  reserveRevealSubmission: typeof reserveRevealSubmission;
  sendAndConfirmTransaction: typeof sendAndConfirmTransaction;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  validateOnchainConfig: typeof validateOnchainConfig;
  verifyIdentity: typeof verifyRequestIdentity;
};

type RevealWaitUntil = (promise: Promise<unknown>) => void;

type ProviderContext = {
  apiKey: string;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
};

type FirestoreContext = {
  commerceDb: D1Database;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  requestCommerceDocument: CommerceDocumentRequester;
  signal: AbortSignal;
  dataDb?: D1Database;
  opsDb?: D1Database;
};

type AssignmentResult = {
  dudeIds: number[];
  outcome: 'existing' | 'created';
};

type AssignmentDependencies = Pick<RevealDudesDependencies, 'randomInt' | 'sleep'>;

type RevealSubmission = RevealSubmissionRecord;

type RevealSubmissionOutcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

export type RevealBackgroundJob = {
  kind: 'reveal_submission_reconcile';
  dropId: string;
  boxAssetId: string;
  reservationId: string;
  signature: string;
};


function secureRandomInt(maxExclusive: number): number {
  const maximum = Math.floor(Number(maxExclusive));
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x1_0000_0000) {
    throw new RangeError('maxExclusive must be a positive 32-bit integer');
  }
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maximum) * maximum;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % maximum;
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const defaultDependencies: RevealDudesDependencies = {
  assignDudes,
  confirmRevealSubmission,
  countOnlineRevealPackStatus,
  failRevealSubmission,
  loadLatestBlockhash,
  loadPendingOpen,
  loadRevealSubmission,
  loadStorageControl: requireRevealSubmissionStorageControl,
  loadWalletSession,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  requestCommerceDocument: commerceDocumentRequest,
  randomInt: secureRandomInt,
  reconcileRevealSubmission,
  reserveRevealSubmission,
  sendAndConfirmTransaction,
  sleep: pause,
  validateOnchainConfig,
  verifyIdentity: verifyRequestIdentity,
};

const requestSchema = z.object({
  owner: z.string().min(1).max(64),
  boxAssetId: z.string().min(1).max(64),
  dropId: z.string().min(1).max(64),
}).strict();

type RevealRequest = z.infer<typeof requestSchema>;

function errorStatus(code: RevealErrorCode): number {
  if (code === 'invalid-argument') return 400;
  if (code === 'unauthenticated') return 401;
  if (code === 'permission-denied') return 403;
  if (code === 'not-found') return 404;
  if (code === 'aborted' || code === 'failed-precondition') return 409;
  if (code === 'resource-exhausted') return 429;
  if (code === 'deadline-exceeded') return 504;
  if (code === 'unavailable') return 503;
  return 500;
}

function response(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function errorResponse(error: RevealDudesError): Response {
  return response({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, errorStatus(error.code));
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof RevealDudesError) {
    return {
      kind: error.name,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: typeof error, message: String(error) };
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<RevealRequest> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new RevealDudesError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new RevealDudesError('invalid-argument', 'Reveal request is too large.');
  }
  if (!request.body) throw new RevealDudesError('invalid-argument', 'Invalid reveal request.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_MAX_BYTES) throw new RevealDudesError('invalid-argument', 'Reveal request is too large.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const parsed = requestSchema.safeParse(JSON.parse(chunks.join('')) as unknown);
    if (!parsed.success) throw new RevealDudesError('invalid-argument', 'Invalid reveal request.');
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof RevealDudesError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new RevealDudesError('invalid-argument', 'Invalid reveal request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new RevealDudesError('invalid-argument', `Invalid ${label}.`);
  }
}

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

function runtimeForDrop(rawDropId: string): RevealRuntime {
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

function heliusOrigin(cluster: SolanaCluster): string {
  return `https://${cluster === 'mainnet-beta' ? 'mainnet' : cluster}.helius-rpc.com/`;
}

async function rpcCall(
  context: ProviderContext,
  runtime: Pick<RevealRuntime, 'cluster'>,
  method: string,
  params: unknown,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Provider request timed out', 'TimeoutError'));
    }, options.timeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS);
    const id = crypto.randomUUID();
    try {
      if (context.signal.aborted) onAbort();
      if (controller.signal.aborted) throw controller.signal.reason;
      const providerResponse = await context.fetch(
        `${heliusOrigin(runtime.cluster)}?api-key=${encodeURIComponent(context.apiKey)}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          redirect: 'manual',
          signal: controller.signal,
        },
      );
      if (TRANSIENT_HTTP_STATUSES.has(providerResponse.status) && attempt + 1 < attempts) {
        await cancelResponseBody(providerResponse);
        await pause(100, context.signal);
        continue;
      }
      if (!providerResponse.ok) {
        await cancelResponseBody(providerResponse);
        throw new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
      }
      const payload = await readBoundedJson(providerResponse, PROVIDER_MAX_BYTES, controller.signal);
      if (!isExactShopRpcResponse(payload, id)) {
        throw new RevealDudesError('unavailable', 'Reveal provider returned an invalid response.');
      }
      if (payload.error) {
        throw new RevealRpcError(
          payload.error.message,
          payload.error.code,
          payload.error.data,
        );
      }
      if (context.signal.aborted) throw context.signal.reason;
      return payload.result;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (
        error instanceof RevealRpcError &&
        !isTransientShopRpcError({ code: error.rpcCode, message: error.message })
      ) throw error;
      if (error instanceof RevealDudesError && error.code !== 'unavailable') throw error;
      if (attempt + 1 < attempts) {
        await pause(100, context.signal);
        continue;
      }
      if (timedOut) throw new RevealDudesError('deadline-exceeded', 'Reveal provider request timed out.');
      if (error instanceof RevealDudesError) throw error;
      throw new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
    }
  }
  throw new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  if (!isRecord(value) || typeof value.owner !== 'string' || !Array.isArray(value.data)) {
    throw new RevealDudesError('failed-precondition', `${label} is invalid.`);
  }
  const encoded = value.data[0];
  if (typeof encoded !== 'string' || value.data[1] !== 'base64' || encoded.length > PROVIDER_MAX_BYTES) {
    throw new RevealDudesError('unavailable', 'Reveal provider returned invalid account data.');
  }
  try {
    return { owner: new PublicKey(value.owner), data: Buffer.from(encoded, 'base64') };
  } catch {
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

async function validateOnchainConfig(
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

function cosigner(env: Env): Keypair {
  const secret = typeof env.COSIGNER_SECRET === 'string' ? env.COSIGNER_SECRET.trim() : '';
  if (!secret) throw new RevealDudesError('unavailable', 'Reveal signing is temporarily unavailable.');
  try {
    const bytes = bs58.decode(secret);
    if (bytes.length !== 64) throw new Error('invalid');
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new RevealDudesError('unavailable', 'Reveal signing is temporarily unavailable.');
  }
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

async function loadPendingOpen(
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

function firestoreDocumentUrl(path: string, transaction?: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${encodedPath}`);
  if (transaction) url.searchParams.set('transaction', transaction);
  return url.toString();
}

async function loadWalletSession(
  context: FirestoreContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
    const resolution = await resolveD1WalletSession(db, uid, context.signal);
    if ('reason' in resolution) throw new RevealDudesError('unauthenticated', 'Sign in with your wallet first.');
    return resolution.wallet;
  } catch (error) {
    if (error instanceof RevealDudesError || error instanceof ProfileReadError || context.signal.aborted) throw error;
    throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  }
}

async function requireRevealSubmissionStorageControl(
  db: D1Database | undefined,
  signal: AbortSignal,
): Promise<RevealSubmissionStorageControl> {
  if (!db) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  try {
    return await loadRevealSubmissionStorageControl(db, signal);
  } catch (error) {
    if (error instanceof RevealDudesError || signal.aborted) throw error;
    throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  }
}

async function beginFirestoreTransaction(context: FirestoreContext): Promise<string> {
  const value = await context.requestCommerceDocument({
    ...context,
    body: JSON.stringify({ options: { readWrite: {} } }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:beginTransaction`,
  });
  if (!isRecord(value) || typeof value.transaction !== 'string' || !value.transaction) {
    throw new RevealDudesError('unavailable', 'Figure assignment is temporarily unavailable.');
  }
  return value.transaction;
}

async function rollbackFirestoreTransaction(context: FirestoreContext, transaction: string): Promise<void> {
  await context.requestCommerceDocument({
    ...context,
    body: JSON.stringify({ transaction }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:rollback`,
  });
}

function firestoreInteger(value: number): Record<string, string> {
  return { integerValue: String(value) };
}

function firestoreIntegerArray(values: readonly number[]): Record<string, unknown> {
  return { arrayValue: { values: values.map(firestoreInteger) } };
}

function normalizeStoredDudeIds(
  raw: unknown,
  runtime: RevealRuntime,
  boxAssetId: string,
): number[] {
  const dudeIds = Array.isArray(raw) ? raw.map((value) => Math.floor(Number(value))) : [];
  if (
    dudeIds.length !== runtime.itemsPerBox ||
    dudeIds.some((id) => !Number.isFinite(id) || id < 1 || id > runtime.maxDudeId) ||
    new Set(dudeIds).size !== dudeIds.length
  ) {
    throw new RevealDudesError('failed-precondition', 'Stored figure assignment is invalid.', { boxAssetId });
  }
  return dudeIds;
}

async function readFirestoreDocument(
  context: FirestoreContext,
  path: string,
  transaction: string,
): Promise<Record<string, unknown> | null> {
  const document = await context.requestCommerceDocument({
    ...context,
    method: 'GET',
    url: firestoreDocumentUrl(path, transaction),
  });
  if (!document) return null;
  const fields = isRecord(document) ? decodeFirestoreFields(document.fields) : null;
  if (!fields) throw new RevealDudesError('unavailable', 'Figure assignment is temporarily unavailable.');
  return fields;
}

const REVEAL_SUBMISSION_VERSION = 1;
const RESERVATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeRevealSubmission(
  raw: Record<string, unknown>,
  runtime: RevealRuntime,
  boxAssetId: string,
): RevealSubmission {
  const allowedFields = new Set([
    'version',
    'owner',
    'signature',
    'recentBlockhash',
    'blockhashContextSlot',
    'dudeIds',
    'reservationId',
    'status',
    'createdAt',
    'updatedAt',
    'confirmedAt',
  ]);
  const owner = isBase58Bytes(raw.owner, 32) ? raw.owner : null;
  const signature = isNonZeroBase58Bytes(raw.signature, 64) ? raw.signature : null;
  const recentBlockhash = isNonZeroBase58Bytes(raw.recentBlockhash, 32) ? raw.recentBlockhash : null;
  const blockhashContextSlot = raw.blockhashContextSlot;
  const dudeIds = Array.isArray(raw.dudeIds) ? raw.dudeIds : [];
  const reservationId = typeof raw.reservationId === 'string' && RESERVATION_ID_PATTERN.test(raw.reservationId)
    ? raw.reservationId
    : '';
  const status = raw.status === 'pending' || raw.status === 'confirmed' || raw.status === 'failed'
    ? raw.status
    : '';
  if (
    Object.keys(raw).some((field) => !allowedFields.has(field)) ||
    raw.version !== REVEAL_SUBMISSION_VERSION ||
    !owner ||
    !signature ||
    !recentBlockhash ||
    !Number.isSafeInteger(blockhashContextSlot) ||
    Number(blockhashContextSlot) < 0 ||
    !reservationId ||
    !status ||
    dudeIds.length !== runtime.itemsPerBox ||
    dudeIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > runtime.maxDudeId) ||
    new Set(dudeIds).size !== dudeIds.length ||
    (raw.createdAt !== undefined && !Number.isFinite(raw.createdAt)) ||
    (raw.updatedAt !== undefined && !Number.isFinite(raw.updatedAt)) ||
    (raw.confirmedAt !== undefined && !Number.isFinite(raw.confirmedAt))
  ) {
    throw new RevealDudesError('failed-precondition', 'Stored reveal submission is invalid.', { boxAssetId });
  }
  return {
    owner,
    signature,
    recentBlockhash,
    blockhashContextSlot: Number(blockhashContextSlot),
    dudeIds: [...dudeIds],
    reservationId,
    status,
  };
}

async function runRevealSubmissionD1Operation<T>(
  context: FirestoreContext,
  operation: (db: D1Database) => Promise<T>,
): Promise<T> {
  if (!context.opsDb) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
  try {
    return await operation(context.opsDb);
  } catch (error) {
    if (error instanceof RevealDudesError || context.signal.aborted) throw error;
    if (error instanceof RevealSubmissionOwnerMismatchError) {
      throw new RevealDudesError('permission-denied', 'Owners only.');
    }
    if (error instanceof Error && error.message === 'Stored reveal submission does not match its reservation') {
      throw new RevealDudesError('failed-precondition', 'Stored reveal submission is invalid.');
    }
    throw new RevealDudesError('unavailable', 'Reveal submission is temporarily unavailable.');
  }
}

async function loadRevealSubmission(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
): Promise<RevealSubmission | null> {
  return runRevealSubmissionD1Operation(context, (db) => loadD1RevealSubmission(
    db,
    runtime.dropId,
    boxAssetId,
    (raw, storedBoxAssetId) => normalizeRevealSubmission(raw, runtime, storedBoxAssetId),
    context.signal,
  ));
}

async function reserveRevealSubmission(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  candidate: RevealSubmission,
  replaceSubmission: RevealSubmission | undefined,
  _dependencies: Pick<RevealDudesDependencies, 'sleep'>,
): Promise<{ submission: RevealSubmission; owned: boolean }> {
  return runRevealSubmissionD1Operation(context, (db) => reserveD1RevealSubmission({
    boxAssetId,
    candidate,
    db,
    dropId: runtime.dropId,
    normalize: (raw, storedBoxAssetId) => normalizeRevealSubmission(raw, runtime, storedBoxAssetId),
    nowMs: context.nowMs,
    replaceSubmission,
    signal: context.signal,
  }));
}

async function setRevealSubmissionStatus(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
  status: 'confirmed' | 'failed',
): Promise<'confirmed' | 'failed' | 'stale'> {
  return runRevealSubmissionD1Operation(context, (db) => setD1RevealSubmissionStatus({
    boxAssetId,
    db,
    dropId: runtime.dropId,
    normalize: (raw, storedBoxAssetId) => normalizeRevealSubmission(raw, runtime, storedBoxAssetId),
    nowMs: context.nowMs,
    signal: context.signal,
    status,
    submission,
  }));
}

async function confirmRevealSubmission(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  const status = await setRevealSubmissionStatus(context, runtime, boxAssetId, submission, 'confirmed');
  if (status !== 'confirmed') throw new RevealDudesError('aborted', 'Reveal submission changed. Try again.');
}

async function failRevealSubmission(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<'confirmed' | 'failed' | 'stale'> {
  return setRevealSubmissionStatus(context, runtime, boxAssetId, submission, 'failed');
}

async function assignDudes(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  dependencies: AssignmentDependencies,
): Promise<AssignmentResult> {
  const assignmentPath = `drops/${runtime.dropId}/boxAssignments/${boxAssetId}`;
  const poolPath = `drops/${runtime.dropId}/meta/dudePool`;
  for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: string | undefined;
    try {
      transaction = await beginFirestoreTransaction(context);
      const existing = await readFirestoreDocument(context, assignmentPath, transaction);
      if (existing) {
        await rollbackFirestoreTransaction(context, transaction).catch(() => undefined);
        return {
          dudeIds: normalizeStoredDudeIds(existing.dudeIds, runtime, boxAssetId),
          outcome: 'existing',
        };
      }
      const poolDocument = await readFirestoreDocument(context, poolPath, transaction);
      const poolInfo = sanitizeDudeAssignmentPool(poolDocument?.available, runtime.maxDudeId);
      const pool = poolInfo.pool;
      if (pool.length < runtime.itemsPerBox) {
        throw new RevealDudesError('resource-exhausted', 'No figures remaining to assign.', {
          boxAssetId,
          poolLen: pool.length,
          required: runtime.itemsPerBox,
        });
      }
      let picked;
      try {
        picked = await pickDudeIdsForAssignment({
          dropFamily: runtime.config.dropFamily,
          itemsPerBox: runtime.itemsPerBox,
          maxDudeId: runtime.maxDudeId,
          pool,
          randomInt: dependencies.randomInt,
          isAssigned: async (dudeId) => Boolean(await readFirestoreDocument(
            context,
            `drops/${runtime.dropId}/dudeAssignments/${dudeId}`,
            transaction!,
          )),
        });
      } catch (error) {
        if (error instanceof DudeAssignmentPoolExhaustedError) {
          throw new RevealDudesError('resource-exhausted', error.message, {
            boxAssetId,
            bucket: error.bucket,
            chosen: error.chosen,
            candidatesChecked: error.candidatesChecked,
            staleAssigned: error.staleAssigned,
            poolLen: error.poolLen,
          });
        }
        throw error;
      }
      const writes: Record<string, unknown>[] = picked.chosen.map((dudeId) => ({
        update: {
          name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}drops/${runtime.dropId}/dudeAssignments/${dudeId}`,
          fields: {
            dudeId: firestoreInteger(dudeId),
            boxAssetId: { stringValue: boxAssetId },
          },
        },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'assignedAt', setToServerValue: 'REQUEST_TIME' }],
      }));
      writes.push({
        update: {
          name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${poolPath}`,
          fields: { available: firestoreIntegerArray(pool) },
        },
        updateMask: { fieldPaths: ['available'] },
        updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      });
      writes.push({
        update: {
          name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${assignmentPath}`,
          fields: { dudeIds: firestoreIntegerArray(picked.chosen) },
        },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
      });
      await context.requestCommerceDocument({
        ...context,
        body: JSON.stringify({ transaction, writes }),
        method: 'POST',
        url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
      });
      return { dudeIds: picked.chosen, outcome: 'created' };
    } catch (error) {
      if (transaction) await rollbackFirestoreTransaction(context, transaction).catch(() => undefined);
      if (error instanceof RevealDudesError) throw error;
      if (error instanceof FirestoreWriteConflict && attempt + 1 < FIRESTORE_TRANSACTION_ATTEMPTS) {
        await dependencies.sleep(Math.min(2_500, 150 * 2 ** Math.min(attempt, 4)), context.signal);
        continue;
      }
      if (error instanceof ProfileReadError) {
        throw new RevealDudesError(error.code === 'deadline-exceeded' ? error.code : 'unavailable', 'Figure assignment is temporarily unavailable.');
      }
      throw new RevealDudesError('unavailable', 'Figure assignment is temporarily unavailable.');
    }
  }
  throw new RevealDudesError('unavailable', 'Figure assignment is temporarily unavailable.');
}

function transactionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRANSACTION_ERROR_NAMES = new Set([
  'AccountInUse',
  'AccountLoadedTwice',
  'AccountNotFound',
  'ProgramAccountNotFound',
  'InsufficientFundsForFee',
  'InvalidAccountForFee',
  'AlreadyProcessed',
  'BlockhashNotFound',
  'CallChainTooDeep',
  'MissingSignatureForFee',
  'InvalidAccountIndex',
  'SignatureFailure',
  'InvalidProgramForExecution',
  'SanitizeFailure',
  'ClusterMaintenance',
  'AccountBorrowOutstanding',
  'WouldExceedMaxBlockCostLimit',
  'UnsupportedVersion',
  'InvalidWritableAccount',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'TooManyAccountLocks',
  'AddressLookupTableNotFound',
  'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData',
  'InvalidAddressLookupTableIndex',
  'InvalidRentPayingAccount',
  'WouldExceedMaxVoteCostLimit',
  'WouldExceedAccountDataTotalLimit',
  'MaxLoadedAccountsDataSizeExceeded',
  'InvalidLoadedAccountsDataSizeLimit',
  'ResanitizationNeeded',
  'UnbalancedTransaction',
  'ProgramCacheHitMaxLimit',
  'CommitCancelled',
]);

const INSTRUCTION_ERROR_NAMES = new Set([
  'GenericError',
  'InvalidArgument',
  'InvalidInstructionData',
  'InvalidAccountData',
  'AccountDataTooSmall',
  'InsufficientFunds',
  'IncorrectProgramId',
  'MissingRequiredSignature',
  'AccountAlreadyInitialized',
  'UninitializedAccount',
  'UnbalancedInstruction',
  'ModifiedProgramId',
  'ExternalAccountLamportSpend',
  'ExternalAccountDataModified',
  'ReadonlyLamportChange',
  'ReadonlyDataModified',
  'DuplicateAccountIndex',
  'ExecutableModified',
  'RentEpochModified',
  'NotEnoughAccountKeys',
  'AccountDataSizeChanged',
  'AccountNotExecutable',
  'AccountBorrowFailed',
  'AccountBorrowOutstanding',
  'DuplicateAccountOutOfSync',
  'InvalidError',
  'ExecutableDataModified',
  'ExecutableLamportChange',
  'ExecutableAccountNotRentExempt',
  'UnsupportedProgramId',
  'CallDepth',
  'MissingAccount',
  'ReentrancyNotAllowed',
  'MaxSeedLengthExceeded',
  'InvalidSeeds',
  'InvalidRealloc',
  'ComputationalBudgetExceeded',
  'PrivilegeEscalation',
  'ProgramEnvironmentSetupFailure',
  'ProgramFailedToComplete',
  'ProgramFailedToCompile',
  'Immutable',
  'IncorrectAuthority',
  'BorshIoError',
  'AccountNotRentExempt',
  'InvalidAccountOwner',
  'ArithmeticOverflow',
  'UnsupportedSysvar',
  'IllegalOwner',
  'MaxAccountsDataAllocationsExceeded',
  'MaxAccountsExceeded',
  'MaxInstructionTraceLengthExceeded',
  'BuiltinProgramsMustConsumeComputeUnits',
]);

function isByteIndex(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xff;
}

function isInstructionError(value: unknown): boolean {
  if (typeof value === 'string') return INSTRUCTION_ERROR_NAMES.has(value);
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (Number.isSafeInteger(value.Custom)) {
    return Number(value.Custom) >= 0 && Number(value.Custom) <= 0xffff_ffff;
  }
  return typeof value.BorshIoError === 'string';
}

function isTransactionError(value: unknown): boolean {
  if (typeof value === 'string') return TRANSACTION_ERROR_NAMES.has(value);
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (Array.isArray(value.InstructionError)) {
    const [index, error] = value.InstructionError;
    return value.InstructionError.length === 2 && isByteIndex(index) && isInstructionError(error);
  }
  if (isByteIndex(value.DuplicateInstruction)) return true;
  for (const name of ['InsufficientFundsForRent', 'ProgramExecutionTemporarilyRestricted']) {
    const detail = value[name];
    if (
      isRecord(detail) &&
      Object.keys(detail).length === 1 &&
      isByteIndex(detail.account_index)
    ) return true;
  }
  return false;
}

type ConfirmedTransactionOutcome =
  | { outcome: 'confirmed'; logs: string[] }
  | { outcome: 'failed'; error: unknown; logs: string[] }
  | { outcome: 'unknown'; logs: string[] };

function confirmedTransactionOutcome(value: unknown, signature: string): ConfirmedTransactionOutcome {
  if (!isRecord(value) || !Number.isSafeInteger(value.slot) || Number(value.slot) < 0) {
    return { outcome: 'unknown', logs: [] };
  }
  const transaction = value.transaction;
  const meta = value.meta;
  if (
    !isRecord(transaction) ||
    !Array.isArray(transaction.signatures) ||
    transaction.signatures[0] !== signature ||
    !isRecord(meta) ||
    !Object.hasOwn(meta, 'err')
  ) {
    return { outcome: 'unknown', logs: [] };
  }
  const logs = Array.isArray(meta.logMessages)
    ? meta.logMessages.filter((entry): entry is string => typeof entry === 'string').slice(0, 80)
    : [];
  if (meta.err === null) return { outcome: 'confirmed', logs };
  return isTransactionError(meta.err)
    ? { outcome: 'failed', error: meta.err, logs }
    : { outcome: 'unknown', logs };
}

type ParsedSignatureStatus = {
  err: unknown;
  confirmations: number | null;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
};

type ParsedSignatureStatusResult = {
  contextSlot: number;
  status: ParsedSignatureStatus | null;
};

function parseSignatureStatusResult(result: unknown): ParsedSignatureStatusResult | undefined {
  if (
    !isRecord(result) ||
    !isRecord(result.context) ||
    !Number.isSafeInteger(result.context.slot) ||
    Number(result.context.slot) < 0 ||
    !Array.isArray(result.value) ||
    result.value.length !== 1
  ) return undefined;
  const contextSlot = Number(result.context.slot);
  const status = result.value[0];
  if (status === null) return { contextSlot, status: null };
  if (
    !isRecord(status) ||
    !Number.isSafeInteger(status.slot) ||
    Number(status.slot) < 0 ||
    !(status.confirmations === null || (
      Number.isSafeInteger(status.confirmations) && Number(status.confirmations) >= 0
    )) ||
    !Object.hasOwn(status, 'err') ||
    !(
      status.confirmationStatus === undefined ||
      status.confirmationStatus === null ||
      status.confirmationStatus === 'processed' ||
      status.confirmationStatus === 'confirmed' ||
      status.confirmationStatus === 'finalized'
    )
  ) return undefined;
  return {
    contextSlot,
    status: {
      err: status.err,
      confirmations: status.confirmations === null ? null : Number(status.confirmations),
      confirmationStatus: status.confirmationStatus,
    },
  };
}

function hasConfirmedSignatureCommitment(status: ParsedSignatureStatus): boolean {
  if (status.confirmationStatus != null) {
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  }
  return status.confirmations === null || status.confirmations > 0;
}

function signatureStatusOutcome(
  status: ParsedSignatureStatus | null,
): 'confirmed' | 'failed' | 'pending' | 'absent' {
  if (status === null) return 'absent';
  if (!hasConfirmedSignatureCommitment(status)) return 'pending';
  if (status.err === null) return 'confirmed';
  return isTransactionError(status.err) ? 'failed' : 'pending';
}

function preflightFailure(error: unknown): { logs: string[] } | null {
  if (!(error instanceof RevealRpcError) || error.rpcCode !== -32002 || !isRecord(error.rpcData)) return null;
  if (error.rpcData.err === 'AlreadyProcessed') return null;
  if (!isTransactionError(error.rpcData.err) || !Array.isArray(error.rpcData.logs)) return null;
  if (!error.rpcData.logs.every((value) => typeof value === 'string')) return null;
  return {
    logs: error.rpcData.logs.filter((value): value is string => typeof value === 'string').slice(0, 80),
  };
}

async function waitForSignature(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: unknown; logs: string[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const searchTransactionHistory = Date.now() - startedAt > 6_000;
      const result = await rpcCall(context, runtime, 'getSignatureStatuses', [
        [signature],
        { searchTransactionHistory },
      ], { attempts: 1 });
      const parsed = parseSignatureStatusResult(result);
      const outcome = parsed === undefined ? 'pending' : signatureStatusOutcome(parsed.status);
      if (outcome === 'failed') {
        const transaction = await loadTransaction(context, runtime, signature).catch(() => null);
        const corroborated = confirmedTransactionOutcome(transaction, signature);
        if (corroborated.outcome === 'confirmed') return { ok: true };
        if (corroborated.outcome === 'failed') {
          return { ok: false, error: corroborated.error, logs: corroborated.logs };
        }
      }
      if (outcome === 'confirmed') return { ok: true };
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
    }
    await pause(TX_CONFIRM_POLL_MS, context.signal);
  }
  const transaction = await loadTransaction(context, runtime, signature).catch(() => null);
  const corroborated = confirmedTransactionOutcome(transaction, signature);
  if (corroborated.outcome === 'confirmed') return { ok: true };
  return {
    ok: false,
    error: corroborated.outcome === 'failed' ? corroborated.error : 'timeout',
    logs: corroborated.logs,
  };
}

async function loadTransaction(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
): Promise<Record<string, unknown> | null> {
  const value = await rpcCall(context, runtime, 'getTransaction', [signature, {
    commitment: 'confirmed',
    encoding: 'json',
    maxSupportedTransactionVersion: 0,
  }], { attempts: 1 });
  return isRecord(value) ? value : null;
}

async function corroborateRevealSubmissionOutcome(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
): Promise<'confirmed' | 'failed' | 'unknown'> {
  const transaction = await loadTransaction(context, runtime, signature).catch(() => null);
  return confirmedTransactionOutcome(transaction, signature).outcome;
}

type ParsedBlockhashValidity = {
  contextSlot: number;
  valid: boolean;
};

function parseBlockhashValidity(result: unknown): ParsedBlockhashValidity | undefined {
  if (
    !isRecord(result) ||
    !isRecord(result.context) ||
    !Number.isSafeInteger(result.context.slot) ||
    Number(result.context.slot) < 0 ||
    typeof result.value !== 'boolean'
  ) return undefined;
  return {
    contextSlot: Number(result.context.slot),
    valid: result.value,
  };
}

async function reconcileRevealSubmission(
  context: ProviderContext,
  runtime: RevealRuntime,
  submission: RevealSubmission,
): Promise<RevealSubmissionOutcome> {
  try {
    const current = parseSignatureStatusResult(await rpcCall(context, runtime, 'getSignatureStatuses', [
      [submission.signature],
      { searchTransactionHistory: false },
    ], { attempts: 1 }));
    if (!current) return 'unknown';
    const currentOutcome = signatureStatusOutcome(current.status);
    if (currentOutcome === 'confirmed') return currentOutcome;
    if (currentOutcome === 'failed') {
      return corroborateRevealSubmissionOutcome(context, runtime, submission.signature);
    }
    if (currentOutcome !== 'absent') return 'unknown';
    const minContextSlot = Math.max(submission.blockhashContextSlot, current.contextSlot);
    const blockhashValidity = parseBlockhashValidity(await rpcCall(context, runtime, 'isBlockhashValid', [
      submission.recentBlockhash,
      { commitment: 'confirmed', minContextSlot },
    ], { attempts: 1 }));
    if (
      !blockhashValidity ||
      blockhashValidity.valid ||
      blockhashValidity.contextSlot < minContextSlot
    ) return 'unknown';
    const historical = parseSignatureStatusResult(await rpcCall(context, runtime, 'getSignatureStatuses', [
      [submission.signature],
      { searchTransactionHistory: true },
    ], { attempts: 1 }));
    if (!historical) return 'unknown';
    const historicalOutcome = signatureStatusOutcome(historical.status);
    if (historicalOutcome === 'confirmed') return historicalOutcome;
    if (historicalOutcome === 'failed') {
      return corroborateRevealSubmissionOutcome(context, runtime, submission.signature);
    }
    return historicalOutcome === 'absent' && historical.contextSlot >= blockhashValidity.contextSlot
      ? 'expired'
      : 'unknown';
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    return 'unknown';
  }
}

async function sendAndConfirmTransaction(
  context: ProviderContext,
  runtime: RevealRuntime,
  transaction: VersionedTransaction,
  overrides: { waitForSignature?: typeof waitForSignature } = {},
): Promise<string> {
  if (context.signal.aborted) throw context.signal.reason;
  const waitForTransaction = overrides.waitForSignature ?? waitForSignature;
  const signature = bs58.encode(transaction.signatures[0]);
  let sendError: unknown;
  try {
    const result = await rpcCall(context, runtime, 'sendTransaction', [
      Buffer.from(transaction.serialize()).toString('base64'),
      { encoding: 'base64', maxRetries: 2, preflightCommitment: 'confirmed' },
    ], { attempts: 1, timeoutMs: TX_SEND_TIMEOUT_MS });
    if (result !== signature) throw new RevealDudesError('unavailable', 'Reveal provider returned an unexpected transaction signature.');
  } catch (error) {
    sendError = error;
  }
  if (sendError) {
    const preflight = preflightFailure(sendError);
    if (preflight) {
      throw new RevealDudesError('failed-precondition', 'Reveal transaction preflight failed.', {
        signature,
        lastError: transactionErrorMessage(sendError),
        lastLogs: preflight.logs,
      });
    }
    let maybe: Awaited<ReturnType<typeof waitForSignature>>;
    try {
      maybe = await waitForTransaction(context, runtime, signature, TX_SEND_TIMEOUT_MS);
    } catch {
      throw new RevealDudesError(
        context.signal.aborted ? 'deadline-exceeded' : 'unavailable',
        'Reveal transaction submission status is unknown. Try again.',
        {
          signature,
          lastError: transactionErrorMessage(sendError),
          maybeSubmitted: true,
        },
      );
    }
    if (maybe.ok) return signature;
    const maybeMessage = transactionErrorMessage(maybe.error);
    if (!/timeout/i.test(maybeMessage)) {
      throw new RevealDudesError('failed-precondition', 'Reveal transaction was not confirmed. Try again.', {
        signature,
        lastError: maybeMessage,
        lastLogs: maybe.logs.slice(0, 80),
      });
    }
    throw new RevealDudesError('unavailable', 'Reveal transaction submission status is unknown. Try again.', {
      signature,
      lastError: transactionErrorMessage(sendError),
      maybeSubmitted: true,
    });
  }
  let confirmed: Awaited<ReturnType<typeof waitForSignature>>;
  try {
    confirmed = await waitForTransaction(context, runtime, signature, TX_CONFIRM_TIMEOUT_MS);
  } catch {
    throw new RevealDudesError('deadline-exceeded', 'Reveal transaction was not confirmed. Try again.', {
      signature,
      lastError: 'timeout',
      maybeSubmitted: true,
    });
  }
  if (confirmed.ok) return signature;
  const message = transactionErrorMessage(confirmed.error);
  const timedOut = /timeout/i.test(message);
  throw new RevealDudesError(timedOut ? 'deadline-exceeded' : 'failed-precondition', 'Reveal transaction was not confirmed. Try again.', {
    signature,
    lastError: message,
    lastLogs: confirmed.logs.slice(0, 80),
    ...(timedOut ? { maybeSubmitted: true } : {}),
  });
}

async function loadLatestBlockhash(
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

async function countOnlineRevealPackStatus(
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  signature: string,
): Promise<void> {
  if (!shouldTrackPackStatusForDrop({
    dropId: runtime.dropId,
    cluster: runtime.cluster,
    itemsPerBox: runtime.itemsPerBox,
    maxSupply: runtime.config.maxSupply,
  })) return;
  const event: PackStatusEvent = {
    dropId: runtime.dropId,
    type: 'onlineReveal',
    eventKey: boxAssetId,
    quantity: packStatusCardsPerPack({ itemsPerBox: runtime.itemsPerBox }),
    increments: { unsealedOnline: 1 },
    boxAssetId,
    signature,
    createdAtMs: context.nowMs,
  };
  await applyPackStatusProjection({
    dataDb: context.dataDb,
    event,
    log: (entry) => console.warn(entry),
  });
}

async function failRevealSubmissionSafely(
  dependency: typeof failRevealSubmission,
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  try {
    await dependency(context, runtime, boxAssetId, submission);
  } catch (error) {
    console.warn({
      event: 'reveal_submission_fail_status_failed',
      dropId: runtime.dropId,
      boxAssetId,
      signature: submission.signature,
      error: summarizeError(error),
    });
  }
}

function completeWaitUntil(promise: Promise<unknown>): void {
  void promise.catch((error) => {
    console.error({ event: 'reveal_background_error', error: summarizeError(error) });
  });
}

function scheduleRevealBackground(
  waitUntil: RevealWaitUntil,
  promise: Promise<unknown>,
): void {
  const guarded = promise.catch((error) => {
    console.error({ event: 'reveal_background_error', error: summarizeError(error) });
  });
  try {
    waitUntil(guarded);
  } catch (error) {
    console.error({ event: 'reveal_wait_until_failed', error: summarizeError(error) });
    completeWaitUntil(guarded);
  }
}

function scheduleConfirmedPackStatusRepair(
  dependencies: RevealDudesDependencies,
  waitUntil: RevealWaitUntil,
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): void {
  scheduleRevealBackground(
    waitUntil,
    dependencies.countOnlineRevealPackStatus(
      {
        ...context,
        nowMs: dependencies.nowMs(),
        providerFetch: dependencies.providerFetch,
        signal: AbortSignal.timeout(BACKGROUND_PACK_STATUS_TIMEOUT_MS),
      },
      runtime,
      boxAssetId,
      submission.signature,
    ),
  );
}

function unknownSubmissionError(
  submission: RevealSubmission,
  code: RevealErrorCode = 'unavailable',
  message = 'Reveal transaction submission status is unknown. Try again.',
): RevealDudesError {
  const details: RevealDudesSubmissionUnknownDetails = {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: submission.signature,
      recentBlockhash: submission.recentBlockhash,
      dudeIds: [...submission.dudeIds],
    },
  };
  return new RevealDudesError(code, message, details);
}

function revealBackgroundJob(
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): RevealBackgroundJob {
  return {
    kind: 'reveal_submission_reconcile',
    dropId: runtime.dropId,
    boxAssetId,
    reservationId: submission.reservationId,
    signature: submission.signature,
  };
}

export function isRevealBackgroundJob(value: unknown): value is RevealBackgroundJob {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    !['kind', 'dropId', 'boxAssetId', 'reservationId', 'signature'].every((key) => Object.hasOwn(value, key)) ||
    value.kind !== 'reveal_submission_reconcile' ||
    typeof value.dropId !== 'string' ||
    value.dropId.length < 1 ||
    value.dropId.length > 64 ||
    typeof value.boxAssetId !== 'string' ||
    typeof value.reservationId !== 'string' ||
    !RESERVATION_ID_PATTERN.test(value.reservationId) ||
    !isNonZeroBase58Bytes(value.signature, 64) ||
    !isBase58Bytes(value.boxAssetId, 32)
  ) return false;
  return true;
}

async function enqueueRevealBackgroundJob(
  queue: Queue,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
  delaySeconds = 0,
): Promise<void> {
  await queue.send(revealBackgroundJob(runtime, boxAssetId, submission), {
    contentType: 'json',
    ...(delaySeconds > 0 ? { delaySeconds } : {}),
  });
}

async function finalizeConfirmedSubmissionForResponse(
  dependencies: RevealDudesDependencies,
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  try {
    await dependencies.confirmRevealSubmission(context, runtime, boxAssetId, submission);
  } catch (error) {
    const code = context.signal.aborted ||
      (error instanceof RevealDudesError && error.code === 'deadline-exceeded') ||
      (error instanceof ProfileReadError && error.code === 'deadline-exceeded')
      ? 'deadline-exceeded'
      : 'unavailable';
    throw unknownSubmissionError(
      submission,
      code,
      'Reveal transaction is confirmed, but finalization is incomplete. Try again.',
    );
  }
}

type RevealBackgroundJobDependencies = Pick<
  RevealDudesDependencies,
  | 'confirmRevealSubmission'
  | 'countOnlineRevealPackStatus'
  | 'failRevealSubmission'
  | 'loadRevealSubmission'
  | 'loadStorageControl'
  | 'nowMs'
  | 'providerFetch'
  | 'requestCommerceDocument'
  | 'reconcileRevealSubmission'
> & {
  log: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

const defaultRevealBackgroundJobDependencies: RevealBackgroundJobDependencies = {
  confirmRevealSubmission,
  countOnlineRevealPackStatus,
  failRevealSubmission,
  loadRevealSubmission,
  loadStorageControl: requireRevealSubmissionStorageControl,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  requestCommerceDocument: commerceDocumentRequest,
  reconcileRevealSubmission,
  log: (entry) => console.info(entry),
  warn: (entry) => console.warn(entry),
  error: (entry) => console.error(entry),
};

export function revealBackgroundJobRetryDelaySeconds(attempts: number): number {
  const index = Math.min(
    Math.max(1, Math.floor(attempts)) - 1,
    REVEAL_BACKGROUND_JOB_RETRY_DELAYS_SECONDS.length - 1,
  );
  return REVEAL_BACKGROUND_JOB_RETRY_DELAYS_SECONDS[index];
}

function retryRevealBackgroundJob(
  message: Message<unknown>,
  dependencies: RevealBackgroundJobDependencies,
  job: RevealBackgroundJob,
  reason: string,
): void {
  const delaySeconds = revealBackgroundJobRetryDelaySeconds(message.attempts);
  dependencies.warn({
    event: 'reveal_background_job_retry',
    dropId: job.dropId,
    boxAssetId: job.boxAssetId,
    signature: job.signature,
    attempts: message.attempts,
    delaySeconds,
    reason,
  });
  message.retry({ delaySeconds });
}

export async function processRevealBackgroundJobMessage(
  message: Message<unknown>,
  env: Pick<Env, 'HELIUS_API_KEY' | 'OPS_DB'> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  overrides: Partial<RevealBackgroundJobDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultRevealBackgroundJobDependencies, ...overrides };
  if (!isRevealBackgroundJob(message.body)) {
    dependencies.error({
      event: 'reveal_background_job_invalid',
      queueMessageId: message.id,
      attempts: message.attempts,
    });
    message.ack();
    return;
  }
  const job = message.body;
  const signal = AbortSignal.timeout(REVEAL_BACKGROUND_JOB_TIMEOUT_MS);
  let storageControl: RevealSubmissionStorageControl;
  try {
    storageControl = await dependencies.loadStorageControl(env.OPS_DB, signal);
  } catch (error) {
    retryRevealBackgroundJob(
      message,
      dependencies,
      job,
      error instanceof Error ? error.message : 'storage_control_unavailable',
    );
    return;
  }
  if (storageControl.paused) {
    retryRevealBackgroundJob(message, dependencies, job, 'reveal_submissions_paused');
    return;
  }
  const firestoreContext: FirestoreContext = {
    commerceDb: env.COMMERCE_DB,
    nowMs: dependencies.nowMs(),
    providerFetch: dependencies.providerFetch,
    requestCommerceDocument: dependencies.requestCommerceDocument,
    signal,
    dataDb: env.DATA_DB,
    opsDb: env.OPS_DB,
  };
  try {
    const runtime = runtimeForDrop(job.dropId);
    const submission = await dependencies.loadRevealSubmission(firestoreContext, runtime, job.boxAssetId);
    if (
      !submission ||
      submission.reservationId !== job.reservationId ||
      submission.signature !== job.signature
    ) {
      dependencies.log({
        event: 'reveal_background_job_stale',
        dropId: job.dropId,
        boxAssetId: job.boxAssetId,
        signature: job.signature,
      });
      message.ack();
      return;
    }
    if (submission.status === 'failed') {
      message.ack();
      return;
    }
    if (submission.status === 'pending') {
      const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
      if (!apiKey) throw new Error('helius_api_key_not_configured');
      const outcome = await dependencies.reconcileRevealSubmission(
        { apiKey, fetch: dependencies.providerFetch, signal },
        runtime,
        submission,
      );
      if (outcome === 'unknown') {
        retryRevealBackgroundJob(message, dependencies, job, 'transaction_status_unknown');
        return;
      }
      if (outcome === 'failed' || outcome === 'expired') {
        const status = await dependencies.failRevealSubmission(
          firestoreContext,
          runtime,
          job.boxAssetId,
          submission,
        );
        if (status !== 'confirmed') {
          dependencies.log({
            event: 'reveal_background_job_terminal',
            dropId: job.dropId,
            boxAssetId: job.boxAssetId,
            signature: job.signature,
            outcome: 'failed',
          });
          message.ack();
          return;
        }
      }
      if (outcome === 'confirmed') {
        await dependencies.confirmRevealSubmission(firestoreContext, runtime, job.boxAssetId, submission);
      }
    }
    await dependencies.countOnlineRevealPackStatus(
      firestoreContext,
      runtime,
      job.boxAssetId,
      job.signature,
    );
    dependencies.log({
      event: 'reveal_background_job_terminal',
      dropId: job.dropId,
      boxAssetId: job.boxAssetId,
      signature: job.signature,
      outcome: 'confirmed',
    });
    message.ack();
  } catch (error) {
    retryRevealBackgroundJob(
      message,
      dependencies,
      job,
      error instanceof Error ? error.message : 'unknown_error',
    );
  }
}

function scheduleFailedSubmission(
  dependencies: RevealDudesDependencies,
  waitUntil: RevealWaitUntil,
  context: FirestoreContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): void {
  scheduleRevealBackground(
    waitUntil,
    failRevealSubmissionSafely(
      dependencies.failRevealSubmission,
      {
        ...context,
        providerFetch: dependencies.providerFetch,
        signal: AbortSignal.timeout(PROVIDER_ATTEMPT_TIMEOUT_MS),
      },
      runtime,
      boxAssetId,
      submission,
    ),
  );
}

export async function handleRevealDudes(
  request: Request,
  env: Env,
  overrides: Partial<RevealDudesDependencies> = {},
  waitUntil: RevealWaitUntil = completeWaitUntil,
): Promise<RevealDudesResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: RevealMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  let authOutcome: RevealDudesResult['authOutcome'] = 'rejected';
  let dropId: string | undefined;
  let boxAssetId: string | undefined;
  let assignmentOutcome: RevealDudesResult['assignmentOutcome'];
  let transactionOutcome: RevealDudesResult['transactionOutcome'];
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return {
      response: response({ error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405, { Allow: 'POST, OPTIONS' }),
      metrics,
      authOutcome,
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Reveal request timed out', 'TimeoutError')),
    HANDLER_TIMEOUT_MS,
  );
  const meteredFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await dependencies.providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += performance.now() - startedAt;
    }
  };
  try {
    const body = await readRequestBody(request, controller.signal);
    const owner = canonicalPublicKey(body.owner, 'wallet address');
    boxAssetId = canonicalPublicKey(body.boxAssetId, 'boxAssetId').toBase58();
    const runtime = runtimeForDrop(body.dropId);
    dropId = runtime.dropId;
    let identity: RequestIdentity;
    try {
      identity = await dependencies.verifyIdentity(
        request,
        env.OPS_DB,
        controller.signal,
        dependencies.nowMs(),
      );
    } catch (error) {
      if (error instanceof RequestIdentityError) {
        authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
        throw new RevealDudesError(
          error.kind === 'invalid-token'
            ? 'unauthenticated'
            : error.kind === 'provider-timeout' ? 'deadline-exceeded' : 'unavailable',
          error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.',
        );
      }
      throw error;
    }
    authOutcome = 'provider-failure';
    const storageControl = await dependencies.loadStorageControl(env.OPS_DB, controller.signal);
    const firestoreContext: FirestoreContext = {
      commerceDb: env.COMMERCE_DB,
      nowMs: dependencies.nowMs(),
      providerFetch: meteredFetch,
      requestCommerceDocument: dependencies.requestCommerceDocument,
      signal: controller.signal,
      dataDb: env.DATA_DB,
      opsDb: env.OPS_DB,
    };
    const sessionWallet = await resolveRequestWallet(
      identity,
      (uid) => dependencies.loadWalletSession(firestoreContext, env.OPS_DB, uid),
    );
    if (sessionWallet !== owner.toBase58()) {
      authOutcome = 'rejected';
      throw new RevealDudesError('permission-denied', 'Owners only.');
    }
    authOutcome = 'accepted';
    if (storageControl.paused) {
      throw new RevealDudesError('unavailable', 'Reveal migration is in progress. Try again.');
    }
    const storedSubmission = await dependencies.loadRevealSubmission(firestoreContext, runtime, boxAssetId);
    if (storedSubmission && storedSubmission.owner !== owner.toBase58()) {
      authOutcome = 'rejected';
      throw new RevealDudesError('permission-denied', 'Owners only.');
    }
    if (storedSubmission?.status === 'confirmed') {
      transactionOutcome = 'confirmed';
      scheduleConfirmedPackStatusRepair(
        dependencies,
        waitUntil,
        firestoreContext,
        runtime,
        boxAssetId,
        storedSubmission,
      );
      return {
        response: response({ signature: storedSubmission.signature, dudeIds: storedSubmission.dudeIds }, 200),
        metrics,
        authOutcome,
        dropId,
        boxAssetId,
        transactionOutcome,
      };
    }
    const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
    if (!apiKey) throw new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
    const providerContext: ProviderContext = { apiKey, fetch: meteredFetch, signal: controller.signal };
    let replaceSubmission: RevealSubmission | undefined;
    if (storedSubmission) {
      const outcome = storedSubmission.status === 'failed'
        ? 'failed'
        : await dependencies.reconcileRevealSubmission(providerContext, runtime, storedSubmission);
      if (outcome === 'confirmed') {
        transactionOutcome = 'confirmed';
        await finalizeConfirmedSubmissionForResponse(
          dependencies,
          firestoreContext,
          runtime,
          boxAssetId,
          storedSubmission,
        );
        scheduleConfirmedPackStatusRepair(
          dependencies,
          waitUntil,
          firestoreContext,
          runtime,
          boxAssetId,
          storedSubmission,
        );
        return {
          response: response({ signature: storedSubmission.signature, dudeIds: storedSubmission.dudeIds }, 200),
          metrics,
          authOutcome,
          dropId,
          boxAssetId,
          transactionOutcome,
        };
      }
      if (outcome === 'unknown') {
        transactionOutcome = 'unknown';
        throw unknownSubmissionError(storedSubmission);
      }
      replaceSubmission = storedSubmission;
    }
    const onchain = await dependencies.validateOnchainConfig(providerContext, runtime);
    const signer = cosigner(env);
    if (!signer.publicKey.equals(onchain.admin)) {
      throw new RevealDudesError('failed-precondition', 'COSIGNER_SECRET does not match the on-chain admin.', {
        expectedAdmin: onchain.admin.toBase58(),
        cosigner: signer.publicKey.toBase58(),
      });
    }
    const boxAsset = new PublicKey(boxAssetId);
    const pending = await dependencies.loadPendingOpen(providerContext, runtime, owner, boxAsset);
    const assignment = await dependencies.assignDudes(firestoreContext, runtime, boxAssetId, dependencies);
    assignmentOutcome = assignment.outcome;
    const instruction = new TransactionInstruction({
      programId: runtime.boxMinterProgramId,
      keys: [
        { pubkey: runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: boxAsset, isSigner: false, isWritable: true },
        { pubkey: onchain.coreCollection, isSigner: false, isWritable: true },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: pending.pendingPda, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        ...pending.dudeAssets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: Buffer.from(encodeFinalizeOpenBoxArgs(assignment.dudeIds, {
        itemsPerBox: runtime.itemsPerBox,
        maxDudeId: runtime.maxDudeId,
        pendingLayout: pending.layout,
      })),
    });
    const latestBlockhash = await dependencies.loadLatestBlockhash(providerContext, runtime);
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
    }).compileToV0Message());
    transaction.sign([signer]);
    const candidate: RevealSubmission = {
      owner: owner.toBase58(),
      signature: bs58.encode(transaction.signatures[0]),
      recentBlockhash: latestBlockhash.blockhash,
      blockhashContextSlot: latestBlockhash.blockhashContextSlot,
      dudeIds: [...assignment.dudeIds],
      reservationId: crypto.randomUUID(),
      status: 'pending',
    };
    let reservation: Awaited<ReturnType<typeof reserveRevealSubmission>>;
    try {
      reservation = await dependencies.reserveRevealSubmission(
        firestoreContext,
        runtime,
        boxAssetId,
        candidate,
        replaceSubmission,
        dependencies,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        scheduleFailedSubmission(
          dependencies,
          waitUntil,
          firestoreContext,
          runtime,
          boxAssetId,
          candidate,
        );
      }
      throw error;
    }
    if (reservation.submission.status === 'confirmed') {
      transactionOutcome = 'confirmed';
      scheduleConfirmedPackStatusRepair(
        dependencies,
        waitUntil,
        firestoreContext,
        runtime,
        boxAssetId,
        reservation.submission,
      );
      return {
        response: response({
          signature: reservation.submission.signature,
          dudeIds: reservation.submission.dudeIds,
        }, 200),
        metrics,
        authOutcome,
        dropId,
        boxAssetId,
        assignmentOutcome,
        transactionOutcome,
      };
    }
    if (!reservation.owned) {
      if (reservation.submission.owner !== owner.toBase58()) {
        authOutcome = 'rejected';
        throw new RevealDudesError('permission-denied', 'Owners only.');
      }
      const outcome = reservation.submission.status === 'failed'
        ? 'failed'
        : await dependencies.reconcileRevealSubmission(providerContext, runtime, reservation.submission);
      if (outcome === 'confirmed') {
        transactionOutcome = 'confirmed';
        await finalizeConfirmedSubmissionForResponse(
          dependencies,
          firestoreContext,
          runtime,
          boxAssetId,
          reservation.submission,
        );
        scheduleConfirmedPackStatusRepair(
          dependencies,
          waitUntil,
          firestoreContext,
          runtime,
          boxAssetId,
          reservation.submission,
        );
        return {
          response: response({
            signature: reservation.submission.signature,
            dudeIds: reservation.submission.dudeIds,
          }, 200),
          metrics,
          authOutcome,
          dropId,
          boxAssetId,
          assignmentOutcome,
          transactionOutcome,
        };
      }
      if (outcome === 'unknown') {
        transactionOutcome = 'unknown';
        throw unknownSubmissionError(reservation.submission);
      }
      transactionOutcome = 'failed';
      throw new RevealDudesError('aborted', 'Reveal submission changed. Try again.');
    }
    const submission = reservation.submission;
    try {
      await enqueueRevealBackgroundJob(
        env.REVEAL_BACKGROUND_QUEUE,
        runtime,
        boxAssetId,
        submission,
        REVEAL_BACKGROUND_JOB_INITIAL_DELAY_SECONDS,
      );
    } catch {
      transactionOutcome = 'failed';
      scheduleFailedSubmission(
        dependencies,
        waitUntil,
        firestoreContext,
        runtime,
        boxAssetId,
        submission,
      );
      throw new RevealDudesError('unavailable', 'Reveal processing is temporarily unavailable. Try again.');
    }
    let signature: string;
    try {
      signature = await dependencies.sendAndConfirmTransaction(providerContext, runtime, transaction);
      transactionOutcome = 'confirmed';
    } catch (error) {
      const submissionUnknown = error instanceof RevealDudesError &&
        isRecord(error.details) && error.details.maybeSubmitted === true;
      transactionOutcome = submissionUnknown ? 'unknown' : 'failed';
      if (submissionUnknown) {
        console.warn({
          event: 'reveal_transaction_unknown',
          dropId: runtime.dropId,
          boxAssetId,
          signature: submission.signature,
          error: summarizeError(error),
        });
        throw unknownSubmissionError(submission, error.code, error.message);
      }
      if (controller.signal.aborted) {
        scheduleFailedSubmission(
          dependencies,
          waitUntil,
          firestoreContext,
          runtime,
          boxAssetId,
          submission,
        );
      } else {
        await failRevealSubmissionSafely(
          dependencies.failRevealSubmission,
          firestoreContext,
          runtime,
          boxAssetId,
          submission,
        );
      }
      throw error;
    }
    await finalizeConfirmedSubmissionForResponse(
      dependencies,
      firestoreContext,
      runtime,
      boxAssetId,
      submission,
    );
    scheduleConfirmedPackStatusRepair(
      dependencies,
      waitUntil,
      firestoreContext,
      runtime,
      boxAssetId,
      submission,
    );
    return {
      response: response({ signature, dudeIds: submission.dudeIds }, 200),
      metrics,
      authOutcome,
      dropId,
      boxAssetId,
      assignmentOutcome,
      transactionOutcome,
    };
  } catch (error) {
    let normalized: RevealDudesError;
    if (error instanceof RevealDudesError) normalized = error;
    else if (error instanceof ProfileReadError) {
      normalized = new RevealDudesError(error.code, error.message, error.details);
    } else if (controller.signal.aborted) {
      normalized = new RevealDudesError('deadline-exceeded', 'Reveal request timed out.');
    } else {
      normalized = new RevealDudesError('internal', 'Reveal failed.');
    }
    if (['invalid-argument', 'unauthenticated', 'permission-denied'].includes(normalized.code)) {
      authOutcome = 'rejected';
    }
    return {
      response: errorResponse(normalized),
      metrics,
      authOutcome,
      ...(dropId ? { dropId } : {}),
      ...(boxAssetId ? { boxAssetId } : {}),
      ...(assignmentOutcome ? { assignmentOutcome } : {}),
      ...(transactionOutcome ? { transactionOutcome } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const revealDudesTestHooks = {
  assignDudes,
  countOnlineRevealPackStatus,
  confirmRevealSubmission,
  enqueueRevealBackgroundJob,
  loadLatestBlockhash,
  loadPendingOpen,
  loadRevealSubmission,
  loadWalletSession,
  reconcileRevealSubmission,
  reserveRevealSubmission,
  revealBackgroundJobTimeoutMs: REVEAL_BACKGROUND_JOB_TIMEOUT_MS,
  failRevealSubmission,
  rpcCall,
  runtimeForDrop,
  sendAndConfirmTransaction,
  waitForSignature,
};
