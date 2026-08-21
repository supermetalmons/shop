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
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../functions/src/shared/dasAssetCollections.js';
import type { DasAsset } from '../../../../functions/src/shared/dasAsset.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeBoxMinterMetadataBaseForComparison,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../functions/src/shared/deploymentCore.js';
import {
  DEPLOYMENT_DROPS,
  type DeploymentRegistryDrop,
} from '../../../../functions/src/shared/deploymentRegistry.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../functions/src/shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
  BOX_MINTER_PENDING_OPEN_SEED,
} from '../../../../functions/src/shared/boxMinterProtocol.js';
import {
  DudeAssignmentPoolExhaustedError,
  pickDudeIdsForAssignment,
} from '../../../../functions/src/shared/assignDudesPicker.js';
import { sanitizeDudeAssignmentPool } from '../../../../functions/src/shared/dudeAssignmentPool.js';
import {
  encodeFinalizeOpenBoxArgs,
} from '../../../../functions/src/shared/finalizeOpenBoxArgs.js';
import { decodePendingOpenData } from '../../../../functions/src/shared/pendingOpenCodec.js';
import {
  PACK_STATUS_SCHEMA_VERSION,
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
} from '../../../../functions/src/shared/packStatus.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../functions/src/shared/solanaProgramAddresses.js';
import { transformShopInventoryItem } from '../../../../functions/src/shared/shopDomain.js';
import {
  WALLET_SESSION_COLLECTION,
  resolveWalletSessionBinding,
} from '../../../../functions/src/shared/walletLifecycle.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
  ProfileReadError,
  authenticatedFirestoreRequest,
  cancelResponseBody,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  isRecord,
  readBoundedJson,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export const REVEAL_DUDES_PATH = '/boxes/reveal';

const REQUEST_MAX_BYTES = 4096;
const PROVIDER_MAX_BYTES = 2 * 1024 * 1024;
const HANDLER_TIMEOUT_MS = 55_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
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
  accessTokenProvider: GoogleAccessTokenProvider;
  assignDudes: typeof assignDudes;
  countOnlineRevealPackStatus: typeof countOnlineRevealPackStatus;
  loadLatestBlockhash: typeof loadLatestBlockhash;
  loadPendingOpen: typeof loadPendingOpen;
  loadWalletSession: typeof loadWalletSession;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  randomInt: (maxExclusive: number) => number;
  sendAndConfirmTransaction: typeof sendAndConfirmTransaction;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  validateOnchainConfig: typeof validateOnchainConfig;
  verifyIdToken: (
    authorization: string | null,
    providerFetch: ProfileProviderFetch,
    signal: AbortSignal,
    nowMs?: number,
  ) => Promise<FirebaseIdentity>;
};

type RevealWaitUntil = (promise: Promise<unknown>) => void;

type ProviderContext = {
  apiKey: string;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
};

type FirestoreContext = {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
};

type AssignmentResult = {
  dudeIds: number[];
  outcome: 'existing' | 'created';
};

type AssignmentDependencies = Pick<RevealDudesDependencies, 'randomInt' | 'sleep'>;

const accessTokenProvider = createGoogleAccessTokenProvider();

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
  accessTokenProvider,
  assignDudes,
  countOnlineRevealPackStatus,
  loadLatestBlockhash,
  loadPendingOpen,
  loadWalletSession,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  randomInt: secureRandomInt,
  sendAndConfirmTransaction,
  sleep: pause,
  validateOnchainConfig,
  verifyIdToken: verifyFirebaseIdToken,
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
      if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== id) {
        throw new RevealDudesError('unavailable', 'Reveal provider returned an invalid response.');
      }
      if (isRecord(payload.error)) {
        const rpcCode = Number(payload.error.code);
        throw new RevealRpcError(
          typeof payload.error.message === 'string' ? payload.error.message : 'Reveal RPC request failed.',
          Number.isFinite(rpcCode) ? rpcCode : undefined,
          payload.error.data,
        );
      }
      if (!Object.hasOwn(payload, 'result')) {
        throw new RevealDudesError('unavailable', 'Reveal provider returned an invalid response.');
      }
      return payload.result;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (error instanceof RevealRpcError) throw error;
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

async function loadWalletSession(context: FirestoreContext, uid: string): Promise<string> {
  const document = await authenticatedFirestoreRequest({
    ...context,
    method: 'GET',
    url: firestoreDocumentUrl(`${WALLET_SESSION_COLLECTION}/${uid}`),
  });
  const fields = isRecord(document) ? decodeFirestoreFields(document.fields) : null;
  const resolution = resolveWalletSessionBinding({
    uid,
    sessionExists: Boolean(document),
    sessionData: fields,
  });
  if ('reason' in resolution) throw new RevealDudesError('unauthenticated', 'Sign in with your wallet first.');
  return resolution.wallet;
}

async function beginFirestoreTransaction(context: FirestoreContext): Promise<string> {
  const value = await authenticatedFirestoreRequest({
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
  await authenticatedFirestoreRequest({
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
  const document = await authenticatedFirestoreRequest({
    ...context,
    method: 'GET',
    url: firestoreDocumentUrl(path, transaction),
  });
  if (!document) return null;
  const fields = isRecord(document) ? decodeFirestoreFields(document.fields) : null;
  if (!fields) throw new RevealDudesError('unavailable', 'Figure assignment is temporarily unavailable.');
  return fields;
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
      await authenticatedFirestoreRequest({
        ...context,
        body: JSON.stringify({ transaction, writes }),
        method: 'POST',
        surfaceWriteConflict: true,
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

function rpcLogs(error: unknown): string[] {
  if (!(error instanceof RevealRpcError) || !isRecord(error.rpcData)) return [];
  const logs = error.rpcData.logs;
  return Array.isArray(logs) ? logs.filter((value): value is string => typeof value === 'string') : [];
}

function transactionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const status = isRecord(result) && Array.isArray(result.value) ? result.value[0] : null;
      if (isRecord(status) && status.err) {
        const transaction = await loadTransaction(context, runtime, signature).catch(() => null);
        return {
          ok: false,
          error: status.err,
          logs: isRecord(transaction?.meta) && Array.isArray(transaction.meta.logMessages)
            ? transaction.meta.logMessages.filter((value): value is string => typeof value === 'string')
            : [],
        };
      }
      if (isRecord(status) && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return { ok: true };
      }
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
    }
    await pause(TX_CONFIRM_POLL_MS, context.signal);
  }
  const transaction = await loadTransaction(context, runtime, signature).catch(() => null);
  if (isRecord(transaction?.meta) && !transaction.meta.err) return { ok: true };
  return {
    ok: false,
    error: isRecord(transaction?.meta) ? transaction.meta.err || 'timeout' : 'timeout',
    logs: isRecord(transaction?.meta) && Array.isArray(transaction.meta.logMessages)
      ? transaction.meta.logMessages.filter((value): value is string => typeof value === 'string')
      : [],
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

async function sendAndConfirmTransaction(
  context: ProviderContext,
  runtime: RevealRuntime,
  transaction: VersionedTransaction,
): Promise<string> {
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
    const logs = rpcLogs(sendError);
    if (logs.length) {
      throw new RevealDudesError('failed-precondition', 'Reveal transaction preflight failed.', {
        signature,
        lastError: transactionErrorMessage(sendError),
        lastLogs: logs.slice(0, 80),
      });
    }
    const maybe = await waitForSignature(context, runtime, signature, TX_SEND_TIMEOUT_MS);
    if (maybe.ok) return signature;
    throw new RevealDudesError('unavailable', 'Reveal transaction submission status is unknown. Try again.', {
      signature,
      lastError: transactionErrorMessage(sendError),
      maybeSubmitted: true,
    });
  }
  const confirmed = await waitForSignature(context, runtime, signature, TX_CONFIRM_TIMEOUT_MS);
  if (confirmed.ok) return signature;
  const message = transactionErrorMessage(confirmed.error);
  throw new RevealDudesError(/timeout/i.test(message) ? 'deadline-exceeded' : 'failed-precondition', 'Reveal transaction was not confirmed. Try again.', {
    signature,
    lastError: message,
    lastLogs: confirmed.logs.slice(0, 80),
  });
}

async function loadLatestBlockhash(context: ProviderContext, runtime: RevealRuntime): Promise<string> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  try {
    if (!blockhash || new PublicKey(blockhash).toBytes().length !== 32) throw new Error('invalid');
  } catch {
    throw new RevealDudesError('unavailable', 'Reveal provider returned an invalid blockhash.');
  }
  return blockhash;
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
  const eventPath = `drops/${runtime.dropId}/packStatusEvents/onlineReveal_${encodeURIComponent(boxAssetId)}`;
  for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: string | undefined;
    try {
      transaction = await beginFirestoreTransaction(context);
      const event = await readFirestoreDocument(context, eventPath, transaction);
      if (event) return;
      const statsName = `${FIRESTORE_DOCUMENT_NAME_PREFIX}drops/${runtime.dropId}/meta/packStatus`;
      const quantity = packStatusCardsPerPack({ itemsPerBox: runtime.itemsPerBox });
      await authenticatedFirestoreRequest({
        ...context,
        body: JSON.stringify({
          transaction,
          writes: [
            {
              transform: {
                document: statsName,
                fieldTransforms: [
                  { fieldPath: 'unsealedOnline', increment: firestoreInteger(1) },
                  { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
                ],
              },
              currentDocument: { exists: true },
            },
            {
              update: {
                name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${eventPath}`,
                fields: {
                  version: firestoreInteger(PACK_STATUS_SCHEMA_VERSION),
                  dropId: { stringValue: runtime.dropId },
                  type: { stringValue: 'onlineReveal' },
                  eventKey: { stringValue: boxAssetId },
                  quantity: firestoreInteger(quantity),
                  increments: { mapValue: { fields: { unsealedOnline: firestoreInteger(1) } } },
                  boxAssetId: { stringValue: boxAssetId },
                  signature: { stringValue: signature },
                },
              },
              currentDocument: { exists: false },
              updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
            },
          ],
        }),
        method: 'POST',
        surfaceWriteConflict: true,
        url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
      });
      transaction = undefined;
      return;
    } catch (error) {
      if (error instanceof FirestoreWriteConflict && attempt + 1 < FIRESTORE_TRANSACTION_ATTEMPTS) {
        await pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    } finally {
      if (transaction) await rollbackFirestoreTransaction(context, transaction).catch(() => undefined);
    }
  }
}

function completeWaitUntil(promise: Promise<unknown>): void {
  void promise.catch((error) => {
    console.error({ event: 'reveal_background_error', error: summarizeError(error) });
  });
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
    let identity: FirebaseIdentity;
    try {
      identity = await dependencies.verifyIdToken(
        request.headers.get('Authorization'),
        meteredFetch,
        controller.signal,
        dependencies.nowMs(),
      );
    } catch (error) {
      if (error instanceof FirebaseIdTokenError) {
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
    const serviceAccountJson = typeof env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON === 'string'
      ? env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON.trim()
      : '';
    if (!serviceAccountJson) throw new RevealDudesError('unavailable', 'Reveal data is temporarily unavailable.');
    const firestoreContext: FirestoreContext = {
      accessTokenProvider: dependencies.accessTokenProvider,
      nowMs: dependencies.nowMs(),
      providerFetch: meteredFetch,
      serviceAccountJson,
      signal: controller.signal,
    };
    const sessionWallet = await dependencies.loadWalletSession(firestoreContext, identity.uid);
    if (sessionWallet !== owner.toBase58()) {
      authOutcome = 'rejected';
      throw new RevealDudesError('permission-denied', 'Owners only.');
    }
    authOutcome = 'accepted';
    const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
    if (!apiKey) throw new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
    const providerContext: ProviderContext = { apiKey, fetch: meteredFetch, signal: controller.signal };
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
    const blockhash = await dependencies.loadLatestBlockhash(providerContext, runtime);
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
    }).compileToV0Message());
    transaction.sign([signer]);
    let signature: string;
    try {
      signature = await dependencies.sendAndConfirmTransaction(providerContext, runtime, transaction);
      transactionOutcome = 'confirmed';
    } catch (error) {
      transactionOutcome = error instanceof RevealDudesError && isRecord(error.details) && error.details.maybeSubmitted === true
        ? 'unknown'
        : 'failed';
      throw error;
    }
    const backgroundContext: FirestoreContext = {
      ...firestoreContext,
      providerFetch: dependencies.providerFetch,
    };
    waitUntil(dependencies.countOnlineRevealPackStatus(backgroundContext, runtime, boxAssetId, signature).catch((error) => {
      console.warn({
        event: 'reveal_pack_status_count_failed',
        dropId: runtime.dropId,
        boxAssetId,
        signature,
        error: summarizeError(error),
      });
    }));
    return {
      response: response({ signature, dudeIds: assignment.dudeIds }, 200),
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
  loadPendingOpen,
  runtimeForDrop,
  sendAndConfirmTransaction,
};
