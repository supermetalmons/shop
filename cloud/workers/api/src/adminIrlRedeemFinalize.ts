import bs58 from 'bs58';
import { z } from 'zod';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { API_DROPS, type ApiDropConfig } from './dropConfig.js';
import {
  ADMIN_IRL_REDEEM_CARD_MARKER_VERSION,
  buildAdminIrlRedeemCardClaimCodeDocument,
  buildAdminIrlRedeemCardDeliveryOrderDocument,
  buildAdminIrlRedeemCardMarkerDocument,
  buildAdminIrlRedeemClaimCodeDocument,
  buildAdminIrlRedeemDeliveryOrderDocument,
  buildAdminIrlRedeemMarkerDocument,
  buildAdminIrlRedeemSelectionKey,
  getAdminIrlRedeemUnsupportedReason,
  resolveAdminIrlRedeemMarkerReuse,
  type AdminIrlRedeemBoxBaseInput,
  type AdminIrlRedeemCardInput,
  type AdminIrlRedeemMarkerReuseResolution,
} from './adminIrlRedeem.js';
import {
  adminIrlCardReceiptProofHasIdentity,
  classifyAdminIrlCardReceiptLookupError,
} from './adminIrlCardReceipt.js';
import {
  dropAdminIrlRedeemPackMarkerPath,
  dropAdminIrlRedeemReceiptMarkerPath,
  dropAdminIrlRedeemRequestPath,
  dropDeliveryOrderPath,
} from './dropPaths.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
} from './receiptProof.js';
import {
  bubblegumReceiptAssetIds,
  coreTransferAssetIds,
  matchingReceiptTransferCount,
} from './receiptTransferVerification.js';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  walletHasAdminIrlRedeemAccess,
} from '../../../../shared/fulfillmentAccess.js';
import {
  getAdminIrlRedeemTargetEligibility,
  type AdminIrlRedeemTargetKind,
} from '../../../../shared/adminIrlEligibility.js';
import { dasAssetBoxId } from '../../../../shared/dasAsset.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import { heliusSearchAssetsHasNextPage, heliusSearchAssetsItems } from '../../../../shared/heliusDas.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  generateUniqueStripeReceiptClaimCodes,
  normalizeStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
  stripeReceiptClaimCodeMaybe,
} from '../../../../shared/stripeReceiptClaims.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import {
  createAdminIrlRedeemFinalizeOperationId,
  isAdminIrlRedeemFinalizeOperationId,
} from '../../../../shared/contracts.js';
import {
  isStaffRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  isSignalCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
} from './boundedRequest.js';
import { isRecord, ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  type CommerceUnitOfWork,
} from './commerceRepository.js';
import {
  commerceTimestamp,
  createCommerceWrite,
  readCommerceDocument,
  runCommerceWriteTransaction,
  updateCommerceWrite,
  type CommerceDocumentContext,
  type CommerceTransform,
  type CommerceWrite,
} from './commerceTransactions.js';
import {
  buildRuntime as buildAdminIrlRedeemRuntime,
  fetchAsset as fetchAdminIrlRedeemAsset,
  fetchAssetProof as fetchAdminIrlRedeemAssetProof,
  parseProof as parseAdminIrlRedeemProof,
  receiptDropIdentity as adminIrlRedeemReceiptDropIdentity,
  rpcCall as adminIrlRedeemRpcCall,
} from './adminIrlRedeemOnchain.js';
import {
  createDeliveryPackStatusProjectionOutbox,
  deliveryReceiptRuntime,
  projectPendingDeliveryPackStatus,
} from './deliveryReceipts.js';
import {
  DeliveryReceiptError,
  buildTransaction as buildDeliveryTransaction,
  closeDeliveryInstruction,
  decodeCosigner,
  deriveDeliveryPda,
  fetchOnchainConfig as fetchDeliveryOnchainConfig,
  hasConfirmedSignatureCommitment,
  mintReceiptsInstruction,
  sendAndConfirmSignedTransaction,
} from './deliveryReceiptOnchain.js';
import { heliusRpcUrl } from './solanaProvider.js';

export const ADMIN_IRL_REDEEM_FINALIZE_PATH = '/admin/irl-redeem/finalize';

const REQUEST_MAX_BYTES = 4096;
const CLEANUP_TIMEOUT_MS = 10_000;
const PREPARED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 30 * 60 * 1000;
const WORKFLOW_EFFECT_LEASE_MS = 30_000;
const RECEIPT_INDEX_MAX_WAIT_MS = 30_000;
const RECEIPT_INDEX_POLL_MS = 2_000;
const MAX_ITEMS = 32;
const MAX_DELIVERY_ALLOCATION_ATTEMPTS = 16;
const HELIUS_ASSET_PAGE_LIMIT = 1000;
const HELIUS_ASSET_MAX_PAGES = 64;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const WORKFLOW_EXECUTION_FIELD = 'workflowFinalizeV1';
const WORKFLOW_DRAFT_FIELD = 'workflowPublicationDraftV1';
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const ADMIN_WALLETS = new Set([
  ...FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  ...ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
].map((wallet) => new PublicKey(wallet).toBase58()));

const requestSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  dropId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  transferSignature: z.string().min(64).max(128).regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
    .refine((value) => canonicalSignature(value) === value),
}).strict();

export type AdminIrlRedeemFinalizeRequest = z.infer<typeof requestSchema>;
type FinalizeRequest = AdminIrlRedeemFinalizeRequest;
type CommerceContext = CommerceDocumentContext & {
  dataDb?: D1Database;
  providerFetch: typeof fetch;
  [key: string]: unknown;
};
type ProviderContext = Parameters<typeof fetchAdminIrlRedeemAsset>[0];
type Runtime = ReturnType<typeof buildAdminIrlRedeemRuntime>;
type OnchainConfig = Awaited<ReturnType<typeof fetchDeliveryOnchainConfig>>;
export type AdminIrlRedeemFinalizeErrorCode = ApiErrorCode;

export class AdminIrlRedeemFinalizeError extends Error {
  constructor(
    readonly code: AdminIrlRedeemFinalizeErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminIrlRedeemFinalizeError';
  }
}

class PendingFinalizeSubmissionError extends AdminIrlRedeemFinalizeError {
  constructor(cause?: unknown) {
    super('aborted', 'A submitted Admin IRL redeem transaction is still being reconciled.');
    this.name = 'PendingFinalizeSubmissionError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

type RequestItem = {
  assetId: string;
  kind: 'box' | 'card_receipt';
  refId: number;
};

type PendingFinalizeSubmission =
  | {
    kind: 'internal_delivery';
    signature: string;
    blockhash: string;
    deliveryId: number;
    deliveryPda: string;
  }
  | {
    kind: 'receipt_mint';
    signature: string;
    blockhash: string;
    assetIds: string[];
  };

type AdminIrlRedeemFinalizeWorkflowOnchainV1 = {
  adminWallet: string;
  coreCollection: string;
  treasury: string;
};

type AdminIrlRedeemFinalizeWorkflowPendingEffect =
  | { kind: 'create'; untilMs: number }
  | { kind: 'restart-claim'; claimId: string; untilMs: number }
  | { kind: 'restart'; claimId?: string; dispatchedAtMs: number };

type AdminIrlRedeemFinalizeWorkflowExecutionV1 = {
  version: 1;
  operationId: string;
  owner: string;
  transferSignature: string;
  adminWallet: string;
  config: ApiDropConfig;
  pendingEffect?: AdminIrlRedeemFinalizeWorkflowPendingEffect;
  onchain?: AdminIrlRedeemFinalizeWorkflowOnchainV1;
  failure?: AdminIrlRedeemFinalizeWorkflowError;
};

type AdminIrlRedeemFinalizeWorkflowCardDraftV1 = {
  version: 1;
  targetKind: 'card_receipt';
  receiptOwner: string;
  card: { figureId: number; receiptAssetId: string };
};

type AdminIrlRedeemFinalizeWorkflowPreparedPackDraftV1 = {
  version: 1;
  targetKind: 'pack';
  mode: 'prepared';
  receiptOwner: string;
  internalDelivery: InternalDelivery;
  closeDeliveryTx: string | null;
  receiptTxs: string[];
  boxes: AdminIrlRedeemBoxBaseInput[];
};

type AdminIrlRedeemFinalizeWorkflowMarkerReuseDraftV1 = {
  version: 1;
  targetKind: 'pack';
  mode: 'marker_reuse';
  receiptOwner: string;
  deliveryId: number;
  sourceRequestId: string;
  fingerprint: string;
};

type AdminIrlRedeemFinalizeWorkflowPublicationDraftV1 =
  | AdminIrlRedeemFinalizeWorkflowCardDraftV1
  | AdminIrlRedeemFinalizeWorkflowPreparedPackDraftV1
  | AdminIrlRedeemFinalizeWorkflowMarkerReuseDraftV1;

type StartedRequest = {
  adminWallet: string;
  requestId: string;
  dropId: string;
  owner: string;
  targetKind: AdminIrlRedeemTargetKind;
  itemIds: string[];
  items: RequestItem[];
  receiptTxs: string[];
  internalDeliveryId?: number;
  internalDeliveryPda?: string;
  internalDeliveryTx?: string;
  closeDeliveryTx?: string;
  pendingFinalizeSubmission?: PendingFinalizeSubmission;
  workflowFinalizeV1?: AdminIrlRedeemFinalizeWorkflowExecutionV1;
  workflowPublicationDraftV1?: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1;
};

type InternalDelivery = {
  deliveryId: number;
  deliveryPda: string;
  deliveryTx: string | null;
};

export type AdminIrlRedeemFinalizeResponse = {
  processed: true;
  dropId: string;
  requestId: string;
  deliveryId?: number;
  receiptTxs: string[];
  claimCodes: string[];
  boxes: Array<{ boxId: number; receiptAssetId?: string; claimCode?: string; dudeIds?: number[] }>;
  cards: Array<{ figureId: number; receiptAssetId: string; claimCode?: string }>;
};

export type AdminIrlRedeemFinalizeWorkflowPayload = Readonly<{
  version: 1;
  dropId: string;
  requestId: string;
}>;

export type AdminIrlRedeemFinalizeWorkflowResultReference = Readonly<{
  kind: 'admin-irl-redeem-finalize-v1';
  dropId: string;
  requestId: string;
}>;

export type AdminIrlRedeemFinalizeWorkflowError = Readonly<{
  code: AdminIrlRedeemFinalizeErrorCode;
  message: string;
  retryable: boolean;
}>;

export type AdminIrlRedeemFinalizeWorkflowPhaseResult = Readonly<{
  status: 'ready' | 'drafted' | 'complete';
}>;

export type AdminIrlRedeemFinalizeWorkflowOutput =
  | Readonly<{
      version: 1;
      ok: true;
      result: AdminIrlRedeemFinalizeWorkflowResultReference;
    }>
  | Readonly<{
      version: 1;
      ok: false;
      error: AdminIrlRedeemFinalizeWorkflowError;
    }>;

type AdminIrlRedeemFinalizeWorkflowEnv = Pick<
  Env,
  'COMMERCE_DB' | 'COSIGNER_SECRET' | 'HELIUS_API_KEY'
> & Partial<Pick<Env, 'DATA_DB'>>;

export type AdminIrlRedeemFinalizeWorkflowStageArgs = Readonly<{
  env: AdminIrlRedeemFinalizeWorkflowEnv;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
  signal: AbortSignal;
}>;

export type AdminIrlRedeemFinalizeWorkflowReservation =
  | Readonly<{ status: 'complete'; result: AdminIrlRedeemFinalizeResponse }>
  | Readonly<{ status: 'reserved'; payload: AdminIrlRedeemFinalizeWorkflowPayload }>;

const WORKFLOW_ERROR_POLICY = {
  'invalid-argument': { message: 'Invalid Admin IRL redeem finalization request.', retryable: false },
  unauthenticated: { message: 'Authentication is required.', retryable: false },
  'permission-denied': { message: 'Admin IRL redeem finalization is not permitted.', retryable: false },
  'not-found': { message: 'Admin IRL redeem request not found.', retryable: false },
  aborted: { message: 'Admin IRL redeem finalization must be retried.', retryable: true },
  'failed-precondition': { message: 'Admin IRL redeem finalization requirements are not satisfied.', retryable: false },
  'resource-exhausted': { message: 'Admin IRL redeem finalization resources are exhausted.', retryable: false },
  'deadline-exceeded': { message: 'Admin IRL redeem finalization timed out.', retryable: true },
  unavailable: { message: 'Admin IRL redeem finalization is temporarily unavailable.', retryable: true },
  internal: { message: 'Admin IRL redeem finalization failed unexpectedly.', retryable: true },
} as const satisfies Record<
  AdminIrlRedeemFinalizeErrorCode,
  Readonly<{ message: string; retryable: boolean }>
>;

function isAdminIrlRedeemFinalizeErrorCode(value: unknown): value is AdminIrlRedeemFinalizeErrorCode {
  return typeof value === 'string' && Object.hasOwn(WORKFLOW_ERROR_POLICY, value);
}

function workflowErrorForCode(
  code: AdminIrlRedeemFinalizeErrorCode,
): AdminIrlRedeemFinalizeWorkflowError {
  return { code, ...WORKFLOW_ERROR_POLICY[code] };
}

function workflowErrorCode(error: unknown): AdminIrlRedeemFinalizeErrorCode {
  if (error instanceof AdminIrlRedeemFinalizeError) return error.code;
  if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) return error.code;
  return 'internal';
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof AdminIrlRedeemFinalizeError) {
    return { kind: error.name, code: error.code };
  }
  if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) {
    return { kind: error.name, code: error.code };
  }
  if (error instanceof Error) return { kind: error.name };
  return { kind: typeof error };
}

function normalizedError(error: unknown, fallback: string): AdminIrlRedeemFinalizeError {
  if (error instanceof AdminIrlRedeemFinalizeError) return error;
  if (error instanceof DeliveryReceiptError) {
    return new AdminIrlRedeemFinalizeError(error.code, error.message, error.details);
  }
  if (error instanceof ProfileReadError) {
    return new AdminIrlRedeemFinalizeError(error.code, error.message, error.details);
  }
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code as AdminIrlRedeemFinalizeErrorCode;
    if ([
      'invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
      'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal',
    ].includes(code)) {
      return new AdminIrlRedeemFinalizeError(
        code,
        typeof error.message === 'string' ? error.message : fallback,
        error.details,
      );
    }
  }
  return new AdminIrlRedeemFinalizeError('internal', fallback);
}

export function adminIrlRedeemFinalizeWorkflowError(
  error: unknown,
): AdminIrlRedeemFinalizeWorkflowError {
  return workflowErrorForCode(workflowErrorCode(error));
}

function parseAdminIrlRedeemFinalizeWorkflowPayload(
  value: unknown,
): AdminIrlRedeemFinalizeWorkflowPayload | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes('dropId') || !keys.includes('requestId')) return null;
  if (
    typeof value.dropId !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.dropId) ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)
  ) return null;
  return { version: 1, dropId: value.dropId, requestId: value.requestId };
}

function parseAdminIrlRedeemFinalizeWorkflowResultReference(
  value: unknown,
): AdminIrlRedeemFinalizeWorkflowResultReference | null {
  if (!isRecord(value) || value.kind !== 'admin-irl-redeem-finalize-v1') return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes('dropId') || !keys.includes('requestId')) return null;
  const payload = parseAdminIrlRedeemFinalizeWorkflowPayload({
    version: 1,
    dropId: value.dropId,
    requestId: value.requestId,
  });
  return payload ? { kind: value.kind, dropId: payload.dropId, requestId: payload.requestId } : null;
}

function parseWorkflowError(value: unknown): AdminIrlRedeemFinalizeWorkflowError | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return null;
  const code = value.code;
  if (!isAdminIrlRedeemFinalizeErrorCode(code)) return null;
  const expected = workflowErrorForCode(code);
  return value.message === expected.message && value.retryable === expected.retryable
    ? expected
    : null;
}

export function parseAdminIrlRedeemFinalizeWorkflowOutput(
  value: unknown,
): AdminIrlRedeemFinalizeWorkflowOutput | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== 'boolean') return null;
  if (value.ok) {
    if (Object.keys(value).length !== 3) return null;
    const result = parseAdminIrlRedeemFinalizeWorkflowResultReference(value.result);
    return result ? { version: 1, ok: true, result } : null;
  }
  if (Object.keys(value).length !== 3) return null;
  const error = parseWorkflowError(value.error);
  return error ? { version: 1, ok: false, error } : null;
}

function rethrowFinalizeCancellation(signal: AbortSignal, error: unknown): void {
  if (isSignalCancellationError(signal, error)) throw signal.reason;
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<FinalizeRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new AdminIrlRedeemFinalizeError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Admin IRL redeem finalization request is too large.'
          : 'Invalid Admin IRL redeem finalization request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  return parsed.data;
}

export function readAdminIrlRedeemFinalizeRequest(
  request: Request,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeRequest> {
  return readRequestBody(request, signal);
}

function canonicalWallet(value: unknown): string {
  try {
    const wallet = new PublicKey(String(value || '').trim()).toBase58();
    if (!walletHasAdminIrlRedeemAccess(wallet, ADMIN_WALLETS)) {
      throw new AdminIrlRedeemFinalizeError('permission-denied', 'Admins only.');
    }
    return wallet;
  } catch (error) {
    if (error instanceof AdminIrlRedeemFinalizeError) throw error;
    throw new AdminIrlRedeemFinalizeError('permission-denied', 'Admins only.');
  }
}

export function resolveAdminIrlRedeemFinalizeStaffWallet(identity: RequestIdentity): string {
  if (!isStaffRequestIdentity(identity)) {
    throw new AdminIrlRedeemFinalizeError('unauthenticated', 'Staff wallet authentication is required.');
  }
  return canonicalWallet(identity.wallet);
}

async function adminIrlRedeemFinalizeOperationId(
  body: AdminIrlRedeemFinalizeRequest,
  staffWallet: string,
): Promise<string> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  return adminIrlRedeemFinalizeOperationIdForWallet(parsed.data, canonicalWallet(staffWallet));
}

async function adminIrlRedeemFinalizeOperationIdForWallet(
  body: AdminIrlRedeemFinalizeRequest,
  wallet: string,
): Promise<string> {
  return createAdminIrlRedeemFinalizeOperationId([
    body.dropId,
    body.requestId,
    body.transferSignature,
    wallet,
  ]);
}

function normalizeReceiptTxs(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())))
    : [];
}

function canonicalSignature(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const signature = value.trim();
  try {
    const decoded = bs58.decode(signature);
    return decoded.length === 64 && decoded.some((byte) => byte !== 0) ? signature : undefined;
  } catch {
    return undefined;
  }
}

function canonicalPublicKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return undefined;
  }
}

function normalizePendingFinalizeSubmission(value: unknown): PendingFinalizeSubmission | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
  }
  const signature = canonicalSignature(value.signature);
  const blockhash = canonicalPublicKey(value.blockhash);
  if (!signature || !blockhash) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
  }
  if (value.kind === 'internal_delivery') {
    const deliveryId = Math.floor(Number(value.deliveryId));
    const deliveryPda = canonicalPublicKey(value.deliveryPda);
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1 || !deliveryPda) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
    }
    return { kind: value.kind, signature, blockhash, deliveryId, deliveryPda };
  }
  if (value.kind === 'receipt_mint' && Array.isArray(value.assetIds)) {
    const assetIds = value.assetIds.map(canonicalPublicKey);
    if (!assetIds.length || assetIds.length > 3 || assetIds.some((assetId) => !assetId) || new Set(assetIds).size !== assetIds.length) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
    }
    return { kind: value.kind, signature, blockhash, assetIds: assetIds as string[] };
  }
  throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
}

function samePendingFinalizeSubmission(left: PendingFinalizeSubmission, right: PendingFinalizeSubmission): boolean {
  if (left.kind !== right.kind || left.signature !== right.signature || left.blockhash !== right.blockhash) return false;
  if (left.kind === 'internal_delivery' && right.kind === 'internal_delivery') {
    return left.deliveryId === right.deliveryId && left.deliveryPda === right.deliveryPda;
  }
  return left.kind === 'receipt_mint' && right.kind === 'receipt_mint' &&
    left.assetIds.length === right.assetIds.length && left.assetIds.every((assetId, index) => assetId === right.assetIds[index]);
}

function workflowConfig(value: unknown, dropId: string): ApiDropConfig {
  if (!isRecord(value) || value.dropId !== dropId) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow configuration is invalid.');
  }
  const config = JSON.parse(JSON.stringify(value)) as ApiDropConfig;
  try {
    const runtime = buildAdminIrlRedeemRuntime(config);
    const unsupported = getAdminIrlRedeemUnsupportedReason({
      dropFamily: runtime.config.dropFamily,
      itemsPerBox: runtime.itemsPerBox,
      sharesCollectionMint: false,
    });
    if (unsupported) throw new Error(unsupported);
  } catch {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow configuration is invalid.');
  }
  return config;
}

function normalizeWorkflowOnchain(value: unknown): AdminIrlRedeemFinalizeWorkflowOnchainV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow on-chain configuration is invalid.');
  }
  const adminWallet = canonicalPublicKey(value.adminWallet);
  const coreCollection = canonicalPublicKey(value.coreCollection);
  const treasury = canonicalPublicKey(value.treasury);
  if (!adminWallet || !coreCollection || !treasury) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow on-chain configuration is invalid.');
  }
  return { adminWallet, coreCollection, treasury };
}

function workflowPendingEffect(
  value: Record<string, unknown>,
): { valid: true; effect?: AdminIrlRedeemFinalizeWorkflowPendingEffect } | { valid: false } {
  const legacy = value.instanceCreationPending;
  if (legacy !== undefined && legacy !== true) return { valid: false };
  if (legacy === true && value.pendingEffect !== undefined) return { valid: false };
  if (legacy === true) return { valid: true, effect: { kind: 'create', untilMs: 0 } };
  if (value.pendingEffect === undefined) return { valid: true };
  const pending = value.pendingEffect;
  if (!isRecord(pending)) return { valid: false };
  const keys = Object.keys(pending);
  if (
    keys.length === 2 && keys.every((key) => key === 'kind' || key === 'untilMs') &&
    pending.kind === 'create' && typeof pending.untilMs === 'number' &&
    Number.isSafeInteger(pending.untilMs) && pending.untilMs >= 0
  ) return { valid: true, effect: { kind: 'create', untilMs: pending.untilMs } };
  if (
    keys.length === 3 && keys.every((key) => key === 'kind' || key === 'claimId' || key === 'untilMs') &&
    pending.kind === 'restart-claim' &&
    typeof pending.claimId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(pending.claimId) &&
    typeof pending.untilMs === 'number' && Number.isSafeInteger(pending.untilMs) && pending.untilMs >= 0
  ) return {
    valid: true,
    effect: { kind: 'restart-claim', claimId: pending.claimId, untilMs: pending.untilMs },
  };
  if (
    pending.kind === 'restart' && (
      (keys.length === 2 && keys.every((key) => key === 'kind' || key === 'dispatchedAtMs')) ||
      (keys.length === 3 && keys.every((key) => key === 'kind' || key === 'claimId' || key === 'dispatchedAtMs'))
    ) &&
    typeof pending.dispatchedAtMs === 'number' &&
    Number.isSafeInteger(pending.dispatchedAtMs) && pending.dispatchedAtMs >= 0 &&
    (pending.claimId === undefined || (
      typeof pending.claimId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(pending.claimId)
    ))
  ) return {
    valid: true,
    effect: {
      kind: 'restart',
      ...(typeof pending.claimId === 'string' ? { claimId: pending.claimId } : {}),
      dispatchedAtMs: pending.dispatchedAtMs,
    },
  };
  return { valid: false };
}

function normalizeWorkflowExecution(
  value: unknown,
  body: FinalizeRequest,
): AdminIrlRedeemFinalizeWorkflowExecutionV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  const operationId = typeof value.operationId === 'string' ? value.operationId : '';
  const owner = canonicalPublicKey(value.owner);
  const transferSignature = canonicalSignature(value.transferSignature);
  const adminWallet = canonicalPublicKey(value.adminWallet);
  if (
    !isAdminIrlRedeemFinalizeOperationId(operationId) ||
    !owner || !transferSignature || transferSignature !== body.transferSignature || !adminWallet
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  const onchain = normalizeWorkflowOnchain(value.onchain);
  const failure = value.failure === undefined ? undefined : parseWorkflowError(value.failure);
  const pending = workflowPendingEffect(value);
  if (
    (value.failure !== undefined && !failure) ||
    !pending.valid
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  return {
    version: 1,
    operationId,
    owner,
    transferSignature,
    adminWallet,
    config: workflowConfig(value.config, body.dropId),
    ...(pending.valid && pending.effect ? { pendingEffect: pending.effect } : {}),
    ...(onchain ? { onchain } : {}),
    ...(failure ? { failure } : {}),
  };
}

function normalizeWorkflowDraft(
  value: unknown,
): AdminIrlRedeemFinalizeWorkflowPublicationDraftV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
  }
  const receiptOwner = canonicalPublicKey(value.receiptOwner);
  if (!receiptOwner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
  }
  const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
  if (
    value.targetKind === 'card_receipt' && isRecord(value.card) &&
    exactKeys(value, ['version', 'targetKind', 'receiptOwner', 'card']) &&
    exactKeys(value.card, ['figureId', 'receiptAssetId'])
  ) {
    const figureId = value.card.figureId;
    const receiptAssetId = canonicalPublicKey(value.card.receiptAssetId);
    if (typeof figureId !== 'number' || !Number.isSafeInteger(figureId) || figureId < 1 || !receiptAssetId) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
    }
    return { version: 1, targetKind: value.targetKind, receiptOwner, card: { figureId, receiptAssetId } };
  }
  if (
    value.targetKind === 'pack' && value.mode === 'marker_reuse' &&
    exactKeys(value, [
      'version', 'targetKind', 'mode', 'receiptOwner',
      'deliveryId', 'sourceRequestId', 'fingerprint',
    ]) &&
    typeof value.deliveryId === 'number' && Number.isSafeInteger(value.deliveryId) && value.deliveryId > 0 &&
    typeof value.sourceRequestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.sourceRequestId) &&
    typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
  ) {
    return {
      version: 1,
      targetKind: value.targetKind,
      mode: value.mode,
      receiptOwner,
      deliveryId: value.deliveryId,
      sourceRequestId: value.sourceRequestId,
      fingerprint: value.fingerprint,
    };
  }
  if (
    value.targetKind === 'pack' && value.mode === 'prepared' &&
    isRecord(value.internalDelivery) && Array.isArray(value.boxes) &&
    exactKeys(value, [
      'version', 'targetKind', 'mode', 'receiptOwner', 'internalDelivery',
      'closeDeliveryTx', 'receiptTxs', 'boxes',
    ]) &&
    exactKeys(value.internalDelivery, ['deliveryId', 'deliveryPda', 'deliveryTx'])
  ) {
    const deliveryId = value.internalDelivery.deliveryId;
    const deliveryPda = canonicalPublicKey(value.internalDelivery.deliveryPda);
    const rawDeliveryTx = value.internalDelivery.deliveryTx;
    const deliveryTx = rawDeliveryTx === null ? null : canonicalSignature(rawDeliveryTx);
    const closeDeliveryTx = value.closeDeliveryTx === null ? null : canonicalSignature(value.closeDeliveryTx);
    const receiptTxs = Array.isArray(value.receiptTxs)
      ? value.receiptTxs.map(canonicalSignature)
      : null;
    const boxes = value.boxes.map((entry): AdminIrlRedeemBoxBaseInput | null => {
      if (!isRecord(entry)) return null;
      const boxId = entry.boxId;
      const originalAssetId = canonicalPublicKey(entry.originalAssetId);
      const receiptAssetId = canonicalPublicKey(entry.receiptAssetId);
      const rawDudeIds = Array.isArray(entry.dudeIds) ? entry.dudeIds : [];
      const dudeIds = rawDudeIds;
      return exactKeys(entry, ['boxId', 'originalAssetId', 'receiptAssetId', 'dudeIds']) &&
        typeof boxId === 'number' && Number.isSafeInteger(boxId) && boxId > 0 && originalAssetId && receiptAssetId && dudeIds.length &&
        dudeIds.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        ? { boxId, originalAssetId, receiptAssetId, dudeIds }
        : null;
    });
    if (
      typeof deliveryId !== 'number' || !Number.isSafeInteger(deliveryId) || deliveryId < 1 || !deliveryPda ||
      (rawDeliveryTx !== null && !deliveryTx) ||
      (value.closeDeliveryTx !== null && !closeDeliveryTx) ||
      !receiptTxs || receiptTxs.some((signature) => !signature) ||
      new Set(receiptTxs).size !== receiptTxs.length ||
      !boxes.length || boxes.length > MAX_ITEMS || boxes.some((box) => !box)
    ) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
    }
    return {
      version: 1,
      targetKind: value.targetKind,
      mode: value.mode,
      receiptOwner,
      internalDelivery: { deliveryId, deliveryPda, deliveryTx: deliveryTx || null },
      closeDeliveryTx: closeDeliveryTx || null,
      receiptTxs: receiptTxs as string[],
      boxes: boxes as AdminIrlRedeemBoxBaseInput[],
    };
  }
  throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
}

function normalizeItems(request: Record<string, unknown>): {
  itemIds: string[];
  items: RequestItem[];
  targetKind: AdminIrlRedeemTargetKind;
} {
  const rawItems = Array.isArray(request.items) ? request.items : [];
  const items = rawItems.map((value): RequestItem | null => {
    if (!isRecord(value)) return null;
    const rawAssetId = typeof value.assetId === 'string' ? value.assetId.trim() : '';
    const assetId = canonicalPublicKey(rawAssetId);
    const refId = Math.floor(Number(value.refId));
    if (
      !assetId || assetId !== rawAssetId ||
      !Number.isSafeInteger(refId) || refId < 1 || refId > 0xffff_ffff
    ) return null;
    if (value.kind === 'box' || value.kind === 'card_receipt') return { assetId, kind: value.kind, refId };
    return null;
  }).filter((value): value is RequestItem => value !== null);
  if (!items.length || items.length !== rawItems.length || items.length > MAX_ITEMS) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request is missing selected items.');
  }
  if (new Set(items.map((item) => item.assetId)).size !== items.length || new Set(items.map((item) => item.refId)).size !== items.length) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request contains duplicate selected items.');
  }
  const targetKinds = new Set(items.map((item) => item.kind === 'box' ? 'pack' : 'card_receipt'));
  if (targetKinds.size !== 1) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request cannot mix packs and card receipts.');
  }
  const targetKind = Array.from(targetKinds)[0] as AdminIrlRedeemTargetKind;
  if ((request.targetKind === 'card_receipt' ? 'card_receipt' : 'pack') !== targetKind) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request target kind mismatch.');
  }
  const eligibility = getAdminIrlRedeemTargetEligibility({ targetKind, itemCount: items.length });
  if (!eligibility.eligible) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem supports one card receipt at a time.');
  }
  const itemIds = items.map((item) => item.assetId);
  const storedItemIds = Array.isArray(request.itemIds)
    ? request.itemIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim())
    : [];
  if (storedItemIds.length !== itemIds.length || storedItemIds.some((value, index) => value !== itemIds[index])) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request selected item mismatch.');
  }
  return { itemIds, items, targetKind };
}

function completeResponse(dropId: string, requestId: string, request: Record<string, unknown>): AdminIrlRedeemFinalizeResponse {
  const boxes = Array.isArray(request.boxes) ? request.boxes.flatMap((value) => {
    if (!isRecord(value)) return [];
    const boxId = Math.floor(Number(value.boxId));
    if (!Number.isSafeInteger(boxId) || boxId < 1) return [];
    const receiptAssetId = typeof value.receiptAssetId === 'string' ? value.receiptAssetId.trim() : '';
    const claimCode = typeof value.claimCode === 'string' ? normalizeStripeReceiptClaimCode(value.claimCode) : '';
    const dudeIds = Array.isArray(value.dudeIds)
      ? value.dudeIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    return [{ boxId, ...(receiptAssetId ? { receiptAssetId } : {}), ...(claimCode ? { claimCode } : {}), ...(dudeIds.length ? { dudeIds } : {}) }];
  }) : [];
  const cards = Array.isArray(request.cards) ? request.cards.flatMap((value) => {
    if (!isRecord(value)) return [];
    const figureId = Math.floor(Number(value.figureId));
    const receiptAssetId = typeof value.receiptAssetId === 'string' ? value.receiptAssetId.trim() : '';
    if (!Number.isSafeInteger(figureId) || figureId < 1 || !receiptAssetId) return [];
    const claimCode = typeof value.claimCode === 'string' ? normalizeStripeReceiptClaimCode(value.claimCode) : '';
    return [{ figureId, receiptAssetId, ...(claimCode ? { claimCode } : {}) }];
  }) : [];
  const deliveryId = Math.floor(Number(request.deliveryId));
  return {
    processed: true,
    dropId,
    requestId,
    ...(Number.isSafeInteger(deliveryId) && deliveryId > 0 ? { deliveryId } : {}),
    receiptTxs: normalizeReceiptTxs(request.receiptTxs),
    claimCodes: Array.isArray(request.claimCodes)
      ? request.claimCodes.map(normalizeStripeReceiptClaimCode).filter(Boolean)
      : [],
    boxes,
    cards,
  };
}

function validateWorkflowCompletion(
  response: AdminIrlRedeemFinalizeResponse,
  request: Record<string, unknown>,
): AdminIrlRedeemFinalizeResponse {
  let normalizedItems: ReturnType<typeof normalizeItems>;
  let runtime: Runtime;
  try {
    normalizedItems = normalizeItems(request);
    const execution = request[WORKFLOW_EXECUTION_FIELD];
    if (!isRecord(execution)) throw new Error('missing Workflow execution');
    runtime = buildAdminIrlRedeemRuntime(workflowConfig(execution.config, response.dropId));
  } catch {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  const rawReceiptTxs = Array.isArray(request.receiptTxs) ? request.receiptTxs : [];
  const rawClaimCodes = Array.isArray(request.claimCodes) ? request.claimCodes : [];
  const rawBoxes = Array.isArray(request.boxes) ? request.boxes : [];
  const rawCards = Array.isArray(request.cards) ? request.cards : [];
  const nestedClaimCodes = [
    ...response.boxes.map((box) => box.claimCode),
    ...response.cards.map((card) => card.claimCode),
  ];
  const receiptAssetIds = [
    ...response.boxes.map((box) => box.receiptAssetId),
    ...response.cards.map((card) => card.receiptAssetId),
  ];
  const allDudeIds = response.boxes.flatMap((box) => box.dudeIds || []);
  const validClaimCodes = response.claimCodes.every((code) => {
    try { return requireStripeReceiptClaimCode(code) === code; } catch { return false; }
  });
  const rawReceiptTxsValid = rawReceiptTxs.every((signature) =>
    typeof signature === 'string' && canonicalSignature(signature) === signature);
  const rawClaimCodesValid = rawClaimCodes.every((code) => {
    if (typeof code !== 'string') return false;
    try { return requireStripeReceiptClaimCode(code) === code; } catch { return false; }
  });
  const rawBoxesValid = rawBoxes.every((value, index) => {
    if (!isRecord(value) || Object.keys(value).length !== 5 || !Array.isArray(value.dudeIds)) return false;
    const item = normalizedItems.items[index];
    const dudeIds = value.dudeIds;
    return item?.kind === 'box' &&
      typeof value.boxId === 'number' && value.boxId === item.refId &&
      value.originalAssetId === item.assetId &&
      typeof value.receiptAssetId === 'string' && canonicalPublicKey(value.receiptAssetId) === value.receiptAssetId &&
      typeof value.claimCode === 'string' && normalizeStripeReceiptClaimCode(value.claimCode) === value.claimCode &&
      dudeIds.length === runtime.itemsPerBox &&
      dudeIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= runtime.maxDudeId) &&
      new Set(dudeIds).size === dudeIds.length;
  });
  const rawCardsValid = rawCards.every((value, index) => {
    if (!isRecord(value) || Object.keys(value).length !== 3) return false;
    const item = normalizedItems.items[index];
    return item?.kind === 'card_receipt' &&
      typeof value.figureId === 'number' && value.figureId === item.refId &&
      value.receiptAssetId === item.assetId &&
      typeof value.claimCode === 'string' && normalizeStripeReceiptClaimCode(value.claimCode) === value.claimCode;
  });
  if (
    response.deliveryId === undefined ||
    rawReceiptTxs.length !== response.receiptTxs.length ||
    rawClaimCodes.length !== response.claimCodes.length ||
    rawBoxes.length !== response.boxes.length ||
    rawCards.length !== response.cards.length ||
    (response.boxes.length === 0) === (response.cards.length === 0) ||
    response.cards.length > 1 ||
    !rawReceiptTxsValid || !rawClaimCodesValid || !rawBoxesValid || !rawCardsValid ||
    response.receiptTxs.some((signature) => canonicalSignature(signature) !== signature) ||
    new Set(response.receiptTxs).size !== response.receiptTxs.length ||
    !validClaimCodes || new Set(response.claimCodes).size !== response.claimCodes.length ||
    nestedClaimCodes.length !== response.claimCodes.length ||
    nestedClaimCodes.some((code) => typeof code !== 'string') ||
    nestedClaimCodes.some((code, index) => code !== response.claimCodes[index]) ||
    receiptAssetIds.some((assetId) => typeof assetId !== 'string' || canonicalPublicKey(assetId) !== assetId) ||
    new Set(receiptAssetIds).size !== receiptAssetIds.length ||
    new Set(response.boxes.map((box) => box.boxId)).size !== response.boxes.length ||
    new Set(response.cards.map((card) => card.figureId)).size !== response.cards.length ||
    new Set(allDudeIds).size !== allDudeIds.length ||
    (normalizedItems.targetKind === 'pack'
      ? response.boxes.length !== normalizedItems.items.length || response.cards.length !== 0 ||
        response.boxes.some((box, index) => box.boxId !== normalizedItems.items[index]?.refId)
      : response.cards.length !== 1 || response.boxes.length !== 0 ||
        response.cards[0]?.figureId !== normalizedItems.items[0]?.refId)
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  return response;
}

function requestPath(body: FinalizeRequest): string {
  return dropAdminIrlRedeemRequestPath(body.dropId, body.requestId);
}

function timestamp(value: number) {
  return commerceTimestamp(value);
}

function deleteFieldsWrite(path: string, fields: Record<string, unknown>, deleted: string[], transforms: CommerceTransform[]): CommerceWrite {
  return updateCommerceWrite({
    path,
    fields,
    fieldPaths: [...Object.keys(fields), ...deleted],
    transforms,
    mustExist: true,
  });
}

async function runTransaction<T>(
  context: CommerceContext,
  operation: (transaction: CommerceUnitOfWork) => Promise<{ result: T; writes?: CommerceWrite[] }>,
): Promise<T> {
  return runCommerceWriteTransaction(context, operation);
}

type StartFinalizeResult =
  | { status: 'complete'; request: Record<string, unknown> }
  | { status: 'started'; request: StartedRequest };

function finalizeRequestOwner(request: Record<string, unknown>, wallet: string): string {
  let owner: string;
  try {
    owner = new PublicKey(String(request.owner || '')).toBase58();
  } catch {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request owner is invalid.');
  }
  if (owner !== wallet) {
    throw new AdminIrlRedeemFinalizeError('permission-denied', 'Only the requesting admin wallet can finalize this Admin IRL redeem.');
  }
  return owner;
}

function startedFinalizeRequest(
  body: FinalizeRequest,
  request: Record<string, unknown>,
  owner: string,
): StartedRequest {
  const normalized = normalizeItems(request);
  const adminWallet = canonicalPublicKey(request.adminWallet);
  if (!adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request admin wallet is invalid.');
  }
  const pendingFinalizeSubmission = normalizePendingFinalizeSubmission(request.pendingFinalizeSubmission);
  const workflowFinalizeV1 = request[WORKFLOW_EXECUTION_FIELD] === undefined
    ? undefined
    : normalizeWorkflowExecution(request[WORKFLOW_EXECUTION_FIELD], body);
  const workflowPublicationDraftV1 = normalizeWorkflowDraft(request[WORKFLOW_DRAFT_FIELD]);
  const internalDeliveryId = Math.floor(Number(request.internalDeliveryId));
  return {
    adminWallet,
    requestId: body.requestId,
    dropId: body.dropId,
    owner,
    targetKind: normalized.targetKind,
    itemIds: normalized.itemIds,
    items: normalized.items,
    receiptTxs: normalizeReceiptTxs(request.receiptTxs),
    ...(Number.isSafeInteger(internalDeliveryId) && internalDeliveryId > 0 ? { internalDeliveryId } : {}),
    ...(typeof request.internalDeliveryPda === 'string' && request.internalDeliveryPda ? { internalDeliveryPda: request.internalDeliveryPda } : {}),
    ...(typeof request.internalDeliveryTx === 'string' && request.internalDeliveryTx ? { internalDeliveryTx: request.internalDeliveryTx } : {}),
    ...(typeof request.closeDeliveryTx === 'string' && request.closeDeliveryTx ? { closeDeliveryTx: request.closeDeliveryTx } : {}),
    ...(pendingFinalizeSubmission ? { pendingFinalizeSubmission } : {}),
    ...(workflowFinalizeV1 ? { workflowFinalizeV1 } : {}),
    ...(workflowPublicationDraftV1 ? { workflowPublicationDraftV1 } : {}),
  };
}

function workflowExecutionForReplay(
  value: unknown,
  body: FinalizeRequest,
  requested: AdminIrlRedeemFinalizeWorkflowExecutionV1,
  allowTerminalFailure: boolean,
): AdminIrlRedeemFinalizeWorkflowExecutionV1 {
  if (value === undefined) return requested;
  const existing = normalizeWorkflowExecution(value, body);
  if (
    existing.operationId !== requested.operationId ||
    existing.owner !== requested.owner ||
    existing.transferSignature !== requested.transferSignature ||
    existing.adminWallet !== requested.adminWallet
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution changed.');
  }
  if (existing.failure && !existing.failure.retryable && !allowTerminalFailure) {
    throw new AdminIrlRedeemFinalizeError(existing.failure.code, existing.failure.message);
  }
  return {
    version: 1,
    operationId: existing.operationId,
    owner: existing.owner,
    transferSignature: existing.transferSignature,
    adminWallet: existing.adminWallet,
    config: existing.config,
    ...(existing.pendingEffect ? { pendingEffect: existing.pendingEffect } : {}),
    ...(existing.onchain ? { onchain: existing.onchain } : {}),
    ...(existing.failure ? { failure: existing.failure } : {}),
  };
}

async function startFinalize(
  context: CommerceContext,
  body: FinalizeRequest,
  wallet: string,
  attemptId: string,
  nowMs: number,
  workflowExecution?: AdminIrlRedeemFinalizeWorkflowExecutionV1,
): Promise<StartFinalizeResult> {
  const path = requestPath(body);
  try {
    return await runTransaction<StartFinalizeResult>(context, async (transaction) => {
      const document = await readCommerceDocument(context, path, transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      const request = document.fields;
      if (request.dropId !== body.dropId) throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request drop mismatch.');
      const owner = finalizeRequestOwner(request, wallet);
      const requestAdminWallet = canonicalPublicKey(request.adminWallet);
      if (!requestAdminWallet) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request admin wallet is invalid.');
      }
      if (
        workflowExecution &&
        (workflowExecution.owner !== owner ||
          workflowExecution.transferSignature !== body.transferSignature ||
          workflowExecution.adminWallet !== requestAdminWallet ||
          workflowExecution.operationId !== attemptId)
      ) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem Workflow execution does not match the request.');
      }
      const storedSignature = request.transferSignature === undefined
        ? undefined
        : canonicalSignature(request.transferSignature);
      if (request.transferSignature !== undefined && !storedSignature) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem transfer signature is invalid.');
      }
      if (storedSignature && storedSignature !== body.transferSignature) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer signature changed.');
      }
      if (request.status === 'complete') return { result: { status: 'complete' as const, request } };
      const replayExecution = workflowExecution
        ? workflowExecutionForReplay(
            request[WORKFLOW_EXECUTION_FIELD],
            body,
            workflowExecution,
            request.status === 'processing' && request.processingAttemptId === attemptId,
          )
        : undefined;
      const leaseExpiresAt = Number(request.processingLeaseExpiresAt || 0);
      if (request.status === 'processing' && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) {
        if (request.processingAttemptId === attemptId && storedSignature === body.transferSignature) {
          const started = startedFinalizeRequest(body, {
            ...request,
            ...(replayExecution ? { [WORKFLOW_EXECUTION_FIELD]: replayExecution } : {}),
          }, owner);
          return {
            result: { status: 'started' as const, request: started },
            writes: [deleteFieldsWrite(path, {
              processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
              ...(replayExecution ? { [WORKFLOW_EXECUTION_FIELD]: replayExecution } : {}),
            }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
          };
        }
        throw new AdminIrlRedeemFinalizeError('aborted', 'This Admin IRL redeem request is already being finalized.');
      }
      const requestWithWorkflow = replayExecution
        ? { ...request, [WORKFLOW_EXECUTION_FIELD]: replayExecution }
        : request;
      const started = startedFinalizeRequest(body, requestWithWorkflow, owner);
      return {
        result: { status: 'started' as const, request: started },
        writes: [deleteFieldsWrite(path, {
          status: 'processing',
          transferSignature: body.transferSignature,
          processingAttemptId: attemptId,
          processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
          ...(replayExecution ? { [WORKFLOW_EXECUTION_FIELD]: replayExecution } : {}),
        }, ['preparedExpiresAt'], [
          { fieldPath: 'processingStartedAt', value: commerceFieldValue.serverTimestamp() },
          { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
        ])],
      };
    });
  } catch (error) {
    if (error instanceof AdminIrlRedeemFinalizeError) throw error;
    try {
      const cleanup = cleanupContext(context);
      const document = await readCommerceDocument(cleanup, path);
      const request = document?.fields;
      if (
        request?.status === 'processing' &&
        request.processingAttemptId === attemptId &&
        request.transferSignature === body.transferSignature &&
        request.dropId === body.dropId
      ) {
        const owner = finalizeRequestOwner(request, wallet);
        return { status: 'started', request: startedFinalizeRequest(body, request, owner) };
      }
    } catch {}
    throw error;
  }
}

function cleanupContext(context: CommerceContext): CommerceContext {
  return { ...context, nowMs: Date.now(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) };
}

async function loadTransaction(
  connection: Pick<Connection, 'getTransaction'>,
  signature: string,
): Promise<NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>> {
  const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem transfer transaction not found yet; retry shortly.');
  }
  if (transaction.meta?.err) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer transaction failed.', {
      err: transaction.meta.err,
    });
  }
  return transaction;
}

async function verifyPackTransfer(
  connection: Pick<Connection, 'getTransaction'>,
  signature: string,
  owner: string,
  admin: string,
  collection: PublicKey,
  itemIds: string[],
): Promise<void> {
  const transaction = await loadTransaction(connection, signature);
  if (transaction.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer payer does not match requester.');
  }
  const transferred = coreTransferAssetIds(transaction, { sender: owner, recipient: admin, collection });
  if (transferred.length !== itemIds.length || transferred.some((asset, index) => asset !== itemIds[index])) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer asset mismatch.', {
      expected: itemIds,
      got: transferred,
    });
  }
}

async function verifyCardTransfer(
  connection: Pick<Connection, 'getTransaction'>,
  runtime: Runtime,
  signature: string,
  owner: string,
  admin: string,
  collection: PublicKey,
  receiptAssetId: string,
): Promise<void> {
  const transaction = await loadTransaction(connection, signature);
  if (transaction.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Card receipt transfer payer does not match sender.');
  }
  const matches = matchingReceiptTransferCount(transaction, {
    sender: owner,
    recipient: admin,
    collection,
    merkleTree: runtime.receiptsMerkleTree,
  });
  const ids = bubblegumReceiptAssetIds(transaction);
  if (matches !== 1 || ids.length !== 1 || ids[0] !== receiptAssetId) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Card receipt transfer asset mismatch.', {
      expected: receiptAssetId,
      got: ids,
    });
  }
}

function runtimeSupportsFinalize(runtime: Runtime): void {
  const unsupported = getAdminIrlRedeemUnsupportedReason({
    dropFamily: runtime.config.dropFamily,
    itemsPerBox: runtime.itemsPerBox,
    sharesCollectionMint: Object.values(API_DROPS).filter((drop) =>
      drop.solanaCluster === runtime.cluster && drop.collectionMint === runtime.collectionMint.toBase58()
    ).length > 1,
  });
  if (unsupported) throw new AdminIrlRedeemFinalizeError('failed-precondition', unsupported);
}

function createConnection(provider: ProviderContext, runtime: Runtime): Connection {
  return new Connection(
    heliusRpcUrl(runtime.cluster, provider.apiKey),
    {
      commitment: 'confirmed',
      fetch: (input, init) => provider.providerFetch(input, { ...init, signal: provider.signal }),
    },
  );
}

function mplCoreBurn(asset: PublicKey, collection: PublicKey, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([12, 0]),
  });
}

async function updateRequest(
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  fields: Record<string, unknown>,
  deleted: string[] = [],
): Promise<void> {
  await runTransaction(commerce, async (transaction) => {
    const document = await readCommerceDocument(commerce, path, transaction);
    if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    return {
      result: undefined,
      writes: [deleteFieldsWrite(path, {
        ...fields,
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      }, deleted, [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
    };
  });
}

function isTombstone(account: Awaited<ReturnType<Connection['getAccountInfo']>>): boolean {
  return !account || account.data.length <= 1;
}

async function persistPendingFinalizeSubmission(
  context: CommerceContext,
  path: string,
  attemptId: string,
  pending: PendingFinalizeSubmission,
): Promise<void> {
  try {
    await runTransaction(context, async (transaction) => {
      const document = await readCommerceDocument(context, path, transaction);
      if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const existing = normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
      if (existing && !samePendingFinalizeSubmission(existing, pending)) {
        throw new PendingFinalizeSubmissionError();
      }
      return {
        result: undefined,
        writes: [deleteFieldsWrite(document.path, {
          ...(existing ? {} : { pendingFinalizeSubmission: pending }),
          processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
        }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
      };
    });
  } catch (error) {
    if (error instanceof CommerceWriteConflict) throw error;
    try {
      const cleanup = cleanupContext(context);
      const document = await readCommerceDocument(cleanup, path);
      const stored = document && normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
      if (
        document?.fields.status === 'processing' &&
        document.fields.processingAttemptId === attemptId &&
        stored && samePendingFinalizeSubmission(stored, pending)
      ) return;
    } catch {}
    throw error;
  }
}

function pendingFinalizeSubmissionAlreadySettled(
  document: Record<string, unknown>,
  pending: PendingFinalizeSubmission,
  outcome: 'confirmed' | 'expired',
): boolean {
  if (outcome === 'expired') return true;
  if (pending.kind === 'receipt_mint') {
    return Array.isArray(document.receiptTxs) && document.receiptTxs.includes(pending.signature);
  }
  return document.internalDeliveryId === pending.deliveryId &&
    document.internalDeliveryPda === pending.deliveryPda &&
    document.internalDeliveryTx === pending.signature;
}

async function settlePendingFinalizeSubmission(
  context: CommerceContext,
  path: string,
  attemptId: string,
  pending: PendingFinalizeSubmission,
  outcome: 'confirmed' | 'expired',
): Promise<void> {
  try {
    await runTransaction(context, async (transaction) => {
      const document = await readCommerceDocument(context, path, transaction);
      if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const stored = normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
      if (!stored) {
        if (pendingFinalizeSubmissionAlreadySettled(document.fields, pending, outcome)) {
          return {
            result: undefined,
            writes: [deleteFieldsWrite(document.path, {
              processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
            }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
          };
        }
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem submission recovery changed.');
      }
      if (!samePendingFinalizeSubmission(stored, pending)) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem submission recovery changed.');
      }
      const fields: Record<string, unknown> = {
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      };
      if (outcome === 'confirmed') {
        if (pending.kind === 'internal_delivery') {
          fields.internalDeliveryId = pending.deliveryId;
          fields.internalDeliveryPda = pending.deliveryPda;
          fields.internalDeliveryTx = pending.signature;
        } else {
          fields.receiptTxs = Array.from(new Set([...normalizeReceiptTxs(document.fields.receiptTxs), pending.signature]));
        }
      }
      return {
        result: undefined,
        writes: [deleteFieldsWrite(document.path, fields, ['pendingFinalizeSubmission'], [
          { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
        ])],
      };
    });
  } catch (error) {
    try {
      const cleanup = cleanupContext(context);
      const document = await readCommerceDocument(cleanup, path);
      const stored = document && normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
      if (
        document?.fields.status === 'processing' &&
        document.fields.processingAttemptId === attemptId &&
        !stored && pendingFinalizeSubmissionAlreadySettled(document.fields, pending, outcome)
      ) return;
    } catch {}
    throw error;
  }
}

async function holdPendingFinalizeSubmission(
  context: CommerceContext,
  path: string,
  attemptId: string,
  pending: PendingFinalizeSubmission,
): Promise<void> {
  await runTransaction(context, async (transaction) => {
    const document = await readCommerceDocument(context, path, transaction);
    if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
      return { result: undefined };
    }
    const stored = normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
    if (!stored || !samePendingFinalizeSubmission(stored, pending)) return { result: undefined };
    return {
      result: undefined,
      writes: [deleteFieldsWrite(document.path, {
        processingLeaseExpiresAt: timestamp(context.nowMs + PROCESSING_LEASE_MS),
      }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
    };
  });
}

async function probePendingFinalizeSubmission(
  connection: Connection,
  pending: PendingFinalizeSubmission,
): Promise<'confirmed' | 'expired' | 'unresolved'> {
  const status = (await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) return 'expired';
  if (hasConfirmedSignatureCommitment(status)) return 'confirmed';
  if (status) return 'unresolved';
  const landed = pending.kind === 'internal_delivery'
    ? Boolean(await connection.getAccountInfo(new PublicKey(pending.deliveryPda), {
      commitment: 'confirmed', dataSlice: { offset: 0, length: 0 },
    }))
    : (await connection.getMultipleAccountsInfo(pending.assetIds.map((assetId) => new PublicKey(assetId)), {
      commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
    })).every(isTombstone);
  if (landed) return 'confirmed';
  const validity = await connection.isBlockhashValid(pending.blockhash, { commitment: 'confirmed' });
  return validity.value ? 'unresolved' : 'expired';
}

async function reconcilePendingFinalizeSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<'confirmed' | 'expired' | 'unresolved'> {
  const probeContext = cleanupContext(args.commerce);
  let outcome: 'confirmed' | 'expired' | 'unresolved' = 'unresolved';
  try {
    outcome = await probePendingFinalizeSubmission(
      createConnection({ ...args.provider, signal: probeContext.signal }, args.runtime),
      args.pending,
    );
  } catch {}
  const persistence = cleanupContext(args.commerce);
  if (outcome === 'unresolved') {
    await holdPendingFinalizeSubmission(persistence, args.path, args.attemptId, args.pending);
  } else {
    await settlePendingFinalizeSubmission(
      persistence,
      args.path,
      args.attemptId,
      args.pending,
      outcome,
    );
  }
  return outcome;
}

function pendingFinalizeSubmissionError(error: unknown, signal: AbortSignal): PendingFinalizeSubmissionError {
  return new PendingFinalizeSubmissionError(signal.aborted ? signal.reason : error);
}

function isDefinitiveTransactionFailure(error: unknown): boolean {
  return error instanceof DeliveryReceiptError &&
    isRecord(error.details) &&
    error.details.definitiveFailure === true;
}

async function receiptBatchConfirmedByPostState(
  error: unknown,
  connection: Pick<Connection, 'getMultipleAccountsInfo'>,
  assets: PublicKey[],
): Promise<boolean> {
  if (isDefinitiveTransactionFailure(error)) return false;
  const post = await connection.getMultipleAccountsInfo(assets, {
    commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
  }).catch(() => []);
  return post.length === assets.length && post.every(isTombstone);
}

async function clearDefinitiveFinalizeSubmission(args: {
  commerce: CommerceContext;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<void> {
  try {
    await settlePendingFinalizeSubmission(
      cleanupContext(args.commerce),
      args.path,
      args.attemptId,
      args.pending,
      'expired',
    );
  } catch (error) {
    throw pendingFinalizeSubmissionError(error, args.commerce.signal);
  }
}

async function rethrowUnbroadcastFinalizeCancellation(args: {
  broadcastStarted: boolean;
  commerce: CommerceContext;
  error: unknown;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<void> {
  if (args.broadcastStarted || !isSignalCancellationError(args.commerce.signal, args.error)) return;
  await clearDefinitiveFinalizeSubmission(args);
  throw args.commerce.signal.reason;
}

async function reconcileStartedRequestSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  request: StartedRequest;
}): Promise<void> {
  const pending = args.request.pendingFinalizeSubmission;
  if (!pending) return;
  let outcome: 'confirmed' | 'expired' | 'unresolved';
  try {
    outcome = await reconcilePendingFinalizeSubmission({
      ...args,
      pending,
    });
  } catch (error) {
    throw pendingFinalizeSubmissionError(error, args.commerce.signal);
  }
  if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(undefined, args.commerce.signal);
  if (outcome === 'confirmed') {
    if (pending.kind === 'internal_delivery') {
      args.request.internalDeliveryId = pending.deliveryId;
      args.request.internalDeliveryPda = pending.deliveryPda;
      args.request.internalDeliveryTx = pending.signature;
    } else if (!args.request.receiptTxs.includes(pending.signature)) {
      args.request.receiptTxs.push(pending.signature);
    }
  }
  delete args.request.pendingFinalizeSubmission;
}

async function mintPackReceipts(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  signer: Keypair,
  collection: PublicKey,
  items: RequestItem[],
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  existing: string[],
): Promise<string[]> {
  const keys = items.map((item) => new PublicKey(item.assetId));
  const infos = await connection.getMultipleAccountsInfo(keys, { commitment: 'confirmed', dataSlice: { offset: 0, length: 2 } });
  const pending = items.map((item, index) => ({ ...item, asset: keys[index], account: infos[index] }))
    .filter((item) => !isTombstone(item.account));
  const receiptTxs = normalizeReceiptTxs(existing);
  while (pending.length) {
    let batchSize = Math.min(3, pending.length);
    let lastError: unknown;
    while (batchSize >= 1) {
      const batch = pending.slice(0, batchSize);
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...batch.map((item) => mplCoreBurn(item.asset, collection, signer.publicKey)),
        mintReceiptsInstruction({
          runtime,
          signer: signer.publicKey,
          recipient: signer.publicKey,
          coreCollection: collection,
          boxIds: batch.map((item) => item.refId),
          dudeIds: [],
        }),
      ];
      let completed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (commerce.signal.aborted) throw commerce.signal.reason;
        try {
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          const transaction = buildDeliveryTransaction(instructions, signer.publicKey, blockhash, signer);
          if (transaction.serialize().length > SOLANA_MAX_RAW_TX_BYTES) throw new RangeError('transaction too large');
          const signature = bs58.encode(transaction.signatures[0]);
          const pendingSubmission: PendingFinalizeSubmission = {
            kind: 'receipt_mint',
            signature,
            blockhash,
            assetIds: batch.map((item) => item.asset.toBase58()),
          };
          await persistPendingFinalizeSubmission(commerce, path, attemptId, pendingSubmission);
          let broadcastStarted = false;
          try {
            await sendAndConfirmSignedTransaction(
              connection,
              transaction,
              commerce.signal,
              'Admin IRL receipt mint',
              () => { broadcastStarted = true; },
            );
            await settlePendingFinalizeSubmission(
              commerce,
              path,
              attemptId,
              pendingSubmission,
              'confirmed',
            );
          } catch (error) {
            await rethrowUnbroadcastFinalizeCancellation({
              broadcastStarted,
              commerce,
              error,
              path,
              attemptId,
              pending: pendingSubmission,
            });
            if (isDefinitiveTransactionFailure(error)) {
              await clearDefinitiveFinalizeSubmission({
                commerce,
                path,
                attemptId,
                pending: pendingSubmission,
              });
              throw error;
            }
            const outcome = await reconcilePendingFinalizeSubmission({
              commerce,
              provider,
              runtime,
              path,
              attemptId,
              pending: pendingSubmission,
            }).catch(() => 'unresolved' as const);
            if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(error, commerce.signal);
            if (outcome === 'expired') throw error;
          }
          if (!receiptTxs.includes(signature)) receiptTxs.push(signature);
          pending.splice(0, batchSize);
          completed = true;
          break;
        } catch (error) {
          if (error instanceof PendingFinalizeSubmissionError) throw error;
          rethrowFinalizeCancellation(commerce.signal, error);
          lastError = error;
          if (await receiptBatchConfirmedByPostState(
            error,
            connection,
            batch.map((item) => item.asset),
          )) {
            pending.splice(0, batchSize);
            completed = true;
            break;
          }
          if (attempt < 2) await deliveryReceiptRuntime.pause(Math.min(4_000, 600 * 2 ** attempt), commerce.signal);
        }
      }
      if (completed) break;
      batchSize -= 1;
    }
    if (batchSize < 1) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Unable to mint Admin IRL redeem pack receipts.', {
        lastError: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
  }
  return receiptTxs;
}

function encodeDeliverArgs(deliveryId: number, deliveryBump: number): Buffer {
  const data = Buffer.alloc(21);
  IX_DELIVER.copy(data, 0);
  data.writeUInt32LE(deliveryId, 8);
  data.writeBigUInt64LE(0n, 12);
  data.writeUInt8(deliveryBump, 20);
  return data;
}

async function buildTransactionWithLookupTables(
  instructions: TransactionInstruction[],
  signer: Keypair,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[],
): Promise<VersionedTransaction> {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables));
  transaction.sign([signer]);
  return transaction;
}

async function ensureInternalDelivery(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  signer: Keypair,
  onchain: OnchainConfig,
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  request: StartedRequest,
): Promise<InternalDelivery> {
  let lookupTables: AddressLookupTableAccount[] = [];
  if (runtime.deliveryLookupTable) {
    const lookup = await connection.getAddressLookupTable(runtime.deliveryLookupTable).catch(() => null);
    if (lookup?.value?.isActive()) lookupTables = [lookup.value];
  }
  const assets = request.items.map((item) => new PublicKey(item.assetId));
  const send = async (deliveryId: number, deliveryPda: PublicKey, bump: number): Promise<InternalDelivery> => {
    if (request.internalDeliveryTx) return { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: request.internalDeliveryTx };
    const existing = await connection.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } });
    if (existing) return { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: null };
    const instruction = new TransactionInstruction({
      programId: runtime.boxMinterProgramId,
      keys: [
        { pubkey: runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(onchain.decoded.treasury), isSigner: false, isWritable: true },
        { pubkey: onchain.coreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        ...assets.map((asset) => ({ pubkey: asset, isSigner: false, isWritable: true })),
      ],
      data: encodeDeliverArgs(deliveryId, bump),
    });
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction];
    const sized = await buildTransactionWithLookupTables(instructions, signer, DUMMY_BLOCKHASH, lookupTables);
    if (sized.serialize().length > SOLANA_MAX_RAW_TX_BYTES) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL internal delivery transaction is too large. Try fewer packs.');
    }
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transaction = await buildTransactionWithLookupTables(instructions, signer, blockhash, lookupTables);
    const signature = bs58.encode(transaction.signatures[0]);
    const pendingSubmission: PendingFinalizeSubmission = {
      kind: 'internal_delivery',
      signature,
      blockhash,
      deliveryId,
      deliveryPda: deliveryPda.toBase58(),
    };
    await persistPendingFinalizeSubmission(commerce, path, attemptId, pendingSubmission);
    let broadcastStarted = false;
    try {
      await sendAndConfirmSignedTransaction(
        connection,
        transaction,
        commerce.signal,
        'Admin IRL internal delivery',
        () => { broadcastStarted = true; },
      );
      await settlePendingFinalizeSubmission(
        commerce,
        path,
        attemptId,
        pendingSubmission,
        'confirmed',
      );
    } catch (error) {
      await rethrowUnbroadcastFinalizeCancellation({
        broadcastStarted,
        commerce,
        error,
        path,
        attemptId,
        pending: pendingSubmission,
      });
      if (isDefinitiveTransactionFailure(error)) {
        await clearDefinitiveFinalizeSubmission({
          commerce,
          path,
          attemptId,
          pending: pendingSubmission,
        });
        throw error;
      }
      const outcome = await reconcilePendingFinalizeSubmission({
        commerce,
        provider,
        runtime,
        path,
        attemptId,
        pending: pendingSubmission,
      }).catch(() => 'unresolved' as const);
      if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(error, commerce.signal);
      if (outcome === 'expired') throw error;
    }
    const result = { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: signature };
    return result;
  };
  if (request.internalDeliveryId && request.internalDeliveryPda) {
    const [pda, bump] = deriveDeliveryPda(runtime, request.internalDeliveryId);
    if (pda.toBase58() !== request.internalDeliveryPda) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL internal delivery PDA does not match delivery id.');
    }
    return send(request.internalDeliveryId, pda, bump);
  }
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = deliveryReceiptRuntime.secureRandomInt(2 ** 31 - 1) + 1;
    const [pda, bump] = deriveDeliveryPda(runtime, deliveryId);
    if (await connection.getAccountInfo(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })) continue;
    await updateRequest(commerce, path, attemptId, { internalDeliveryId: deliveryId, internalDeliveryPda: pda.toBase58() });
    return send(deliveryId, pda, bump);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate hidden Admin IRL delivery id.');
}

async function closeInternalDelivery(
  connection: Connection,
  runtime: Runtime,
  signer: Keypair,
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  request: StartedRequest,
  internal: InternalDelivery,
): Promise<string | null> {
  try {
    if (request.closeDeliveryTx) return request.closeDeliveryTx;
    const [pda, bump] = deriveDeliveryPda(runtime, internal.deliveryId);
    if (!await connection.getAccountInfo(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })) return null;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transaction = buildDeliveryTransaction([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      closeDeliveryInstruction({
        runtime,
        signer: signer.publicKey,
        deliveryPda: pda,
        deliveryId: internal.deliveryId,
        deliveryBump: bump,
      }),
    ], signer.publicKey, blockhash, signer);
    const signature = await sendAndConfirmSignedTransaction(
      connection,
      transaction,
      commerce.signal,
      'Admin IRL internal delivery close',
    );
    await updateRequest(commerce, path, attemptId, { closeDeliveryTx: signature });
    return signature;
  } catch (error) {
    console.warn({
      event: 'admin_irl_redeem_internal_delivery_close_failed',
      dropId: runtime.dropId,
      requestId: request.requestId,
      deliveryId: internal.deliveryId,
      error: summarizeError(error),
    });
    return null;
  }
}

function receiptMatches(asset: unknown, runtime: Runtime, boxId: number, owner: string): boolean {
  if (!isRecord(asset) || !isRecord(asset.ownership) || asset.ownership.owner !== owner) return false;
  return assetMatchesReceiptMetadataIdentity(
    asset,
    adminIrlRedeemReceiptDropIdentity(runtime),
    { kind: 'box', id: boxId },
  );
}

async function scanAssetsByOwner(
  provider: ProviderContext,
  runtime: Runtime,
  owner: string,
  visit: (asset: unknown) => void,
  grouping?: readonly [string, string],
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (let page = 1; page <= HELIUS_ASSET_MAX_PAGES; page += 1) {
    if (Date.now() >= deadlineMs) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem receipt indexing timed out.');
    }
    const params: Record<string, unknown> = {
      ownerAddress: owner,
      page,
      limit: HELIUS_ASSET_PAGE_LIMIT,
      options: HELIUS_COLLECTION_GROUPING_OPTIONS,
      ...(grouping ? { grouping } : {}),
    };
    const result = await adminIrlRedeemRpcCall(provider, runtime, 'searchAssets', params);
    const items = heliusSearchAssetsItems(result);
    items.forEach(visit);
    if (!heliusSearchAssetsHasNextPage(result, page, items, HELIUS_ASSET_PAGE_LIMIT)) return;
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Too many assets to search for Admin IRL receipts.');
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function findReceiptAssets(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  owner: string,
  items: RequestItem[],
  receiptTxs: string[],
): Promise<Map<number, Record<string, unknown>[]>> {
  const expected = new Set(items.map((item) => item.refId));
  const direct = new Map<number, Record<string, unknown>[]>();
  const add = (asset: unknown) => {
    if (!isRecord(asset)) return;
    const boxId = Number(dasAssetBoxId(asset, NAME_POLICY));
    if (!Number.isSafeInteger(boxId) || !expected.has(boxId) || !receiptMatches(asset, runtime, boxId, owner)) return;
    const list = direct.get(boxId) || [];
    if (!list.some((entry) => entry.id === asset.id)) list.push(asset);
    direct.set(boxId, list);
  };
  try {
    const signatures = normalizeReceiptTxs(receiptTxs);
    const transactions = await connection.getTransactions(signatures, { maxSupportedTransactionVersion: 0 });
    if (transactions.length === signatures.length && transactions.every(Boolean)) {
      const ids = transactions.flatMap((transaction) => transaction ? bubblegumReceiptAssetIds(transaction) : []);
      if (ids.length !== items.length || new Set(ids).size !== ids.length) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt transaction assets do not match the request.');
      }
      const assets = await mapWithConcurrency(ids, 4, (id) => fetchAdminIrlRedeemAsset(provider, runtime, id));
      for (const asset of assets) {
        const boxId = isRecord(asset) ? Number(dasAssetBoxId(asset, NAME_POLICY)) : Number.NaN;
        if (!Number.isSafeInteger(boxId) || !expected.has(boxId) || !receiptMatches(asset, runtime, boxId, owner)) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem indexed receipt does not match the request.');
        }
        add(asset);
      }
      if (!items.every((item) => (direct.get(item.refId) || []).length === 1)) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem indexed receipts are ambiguous.');
      }
      return direct;
    }
  } catch (error) {
    rethrowFinalizeCancellation(provider.signal, error);
    if (error instanceof AdminIrlRedeemFinalizeError && error.code === 'failed-precondition') throw error;
    console.warn({ event: 'admin_irl_redeem_receipt_transaction_lookup_failed', dropId: runtime.dropId, error: summarizeError(error) });
  }
  const startedAt = Date.now();
  const deadlineMs = startedAt + RECEIPT_INDEX_MAX_WAIT_MS;
  while (Date.now() <= deadlineMs) {
    direct.clear();
    await scanAssetsByOwner(
      provider,
      runtime,
      owner,
      add,
      ['collection', runtime.collectionMint.toBase58()],
      deadlineMs,
    );
    if (!items.every((item) => (direct.get(item.refId) || []).length === 1)) {
      await scanAssetsByOwner(provider, runtime, owner, add, undefined, deadlineMs);
    }
    if (items.every((item) => (direct.get(item.refId) || []).length === 1)) return direct;
    await deliveryReceiptRuntime.pause(RECEIPT_INDEX_POLL_MS, provider.signal);
  }
  return direct;
}

async function waitForCardReceipt(
  provider: ProviderContext,
  runtime: Runtime,
  receiptAssetId: string,
  figureId: number,
  admin: string,
): Promise<void> {
  const startedAt = Date.now();
  let lastOwner = '';
  let lastTransient: unknown;
  while (Date.now() - startedAt <= RECEIPT_INDEX_MAX_WAIT_MS) {
    try {
      const asset = await fetchAdminIrlRedeemAsset(provider, runtime, receiptAssetId);
      lastOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string' ? asset.ownership.owner : '';
      if (lastOwner === admin) {
        if (!assetMatchesReceiptMetadataIdentity(asset, adminIrlRedeemReceiptDropIdentity(runtime), { kind: 'figure', id: figureId })) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt does not belong to the requested drop.');
        }
        const proof = await fetchAdminIrlRedeemAssetProof(provider, runtime, receiptAssetId);
        if (adminIrlCardReceiptProofHasIdentity(proof)) {
          if (!assetMatchesReceiptDropIdentity(asset, proof, adminIrlRedeemReceiptDropIdentity(runtime), { kind: 'figure', id: figureId })) {
            throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt proof belongs to a different drop.');
          }
          parseAdminIrlRedeemProof(asset, proof, runtime, admin);
          return;
        }
      }
      lastTransient = undefined;
    } catch (error) {
      rethrowFinalizeCancellation(provider.signal, error);
      const disposition = classifyAdminIrlCardReceiptLookupError(error);
      if (disposition === 'fatal') throw normalizedError(error, 'Admin IRL card receipt lookup failed.');
      lastTransient = disposition === 'transient' ? error : undefined;
    }
    await deliveryReceiptRuntime.pause(RECEIPT_INDEX_POLL_MS, provider.signal);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', lastTransient
    ? 'Admin IRL card receipt lookup failed while waiting for indexing; retry shortly.'
    : 'Admin IRL card receipt is not indexed under the deployer wallet yet.', {
      receiptAssetId,
      expectedOwner: admin,
      lastOwner,
      ...(lastTransient ? { lastError: summarizeError(lastTransient) } : {}),
    });
}

function markerPaths(dropId: string, boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>): string[] {
  return Array.from(new Set(boxes.flatMap((box) => [
    dropAdminIrlRedeemPackMarkerPath(dropId, box.originalAssetId),
    ...(box.receiptAssetId ? [dropAdminIrlRedeemReceiptMarkerPath(dropId, box.receiptAssetId)] : []),
  ])));
}

function dudeIdsByBoxId(order: Record<string, unknown>): Map<number, number[]> {
  const result = new Map<number, number[]>();
  if (!Array.isArray(order.irlClaims)) return result;
  for (const value of order.irlClaims) {
    if (!isRecord(value) || typeof value.boxId !== 'number' || !Number.isSafeInteger(value.boxId) ||
      value.boxId < 1 || !Array.isArray(value.dudeIds) ||
      !value.dudeIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      new Set(value.dudeIds).size !== value.dudeIds.length) {
      throw markerConflict('marker delivery order assignments are invalid');
    }
    result.set(value.boxId, value.dudeIds as number[]);
  }
  return result;
}

function markerConflict(reason?: string): AdminIrlRedeemFinalizeError {
  return new AdminIrlRedeemFinalizeError('failed-precondition', 'One or more selected items already have Admin IRL claim codes.', {
    ...(reason ? { reason } : {}),
  });
}

async function markerResolution(
  commerce: CommerceContext,
  transaction: CommerceUnitOfWork,
  dropId: string,
  selectionKey: string,
  boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>,
): Promise<AdminIrlRedeemMarkerReuseResolution> {
  const markers = await Promise.all(markerPaths(dropId, boxes).map((path) =>
    readCommerceDocument(commerce, path, transaction)));
  return resolveAdminIrlRedeemMarkerReuse({
    dropId,
    selectionKey,
    originalAssetIds: boxes.map((box) => box.originalAssetId),
    markers: markers.map((document) => document?.fields || null),
  });
}

function completedMarkerReuse(
  request: Record<string, unknown>,
  order: Record<string, unknown>,
  resolution: Extract<AdminIrlRedeemMarkerReuseResolution, { status: 'reuse' }>,
): Record<string, unknown> {
  if (order.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) throw markerConflict('marker delivery order source mismatch');
  const byBox = dudeIdsByBoxId(order);
  const receiptTxs = Array.from(new Set([...normalizeReceiptTxs(order.receiptTxs), ...normalizeReceiptTxs(request.receiptTxs)]));
  return {
    ...request,
    status: 'complete',
    deliveryId: resolution.deliveryId,
    receiptTxs,
    claimCodes: resolution.claimCodes,
    boxes: resolution.boxes.map((box) => ({ ...box, dudeIds: byBox.get(box.boxId) || [] })),
    duplicateOfRequestId: resolution.requestId,
  };
}

type MarkerReuseReference = {
  deliveryId: number;
  sourceRequestId: string;
  fingerprint: string;
};

async function markerReuseReference(completed: Record<string, unknown>): Promise<MarkerReuseReference> {
  const deliveryId = Number(completed.deliveryId);
  const sourceRequestId = typeof completed.duplicateOfRequestId === 'string' ? completed.duplicateOfRequestId : '';
  if (!Number.isSafeInteger(deliveryId) || deliveryId < 1 || !/^[A-Za-z0-9_-]{8,128}$/.test(sourceRequestId)) {
    throw markerConflict('marker completion identity is invalid');
  }
  const stable = {
    deliveryId,
    sourceRequestId,
    receiptTxs: normalizeReceiptTxs(completed.receiptTxs),
    claimCodes: Array.isArray(completed.claimCodes) ? completed.claimCodes : [],
    boxes: Array.isArray(completed.boxes) ? completed.boxes : [],
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable)));
  return {
    deliveryId,
    sourceRequestId,
    fingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

async function resolveExistingMarkerCompletion(
  commerce: CommerceContext,
  transaction: CommerceUnitOfWork,
  body: FinalizeRequest,
  request: StartedRequest,
  fields: Record<string, unknown>,
): Promise<{ completed: Record<string, unknown>; reference: MarkerReuseReference } | null> {
  const selectionKey = buildAdminIrlRedeemSelectionKey({ dropId: body.dropId, originalAssetIds: request.itemIds });
  const resolution = await markerResolution(
    commerce,
    transaction,
    body.dropId,
    selectionKey,
    request.items.map((item) => ({ originalAssetId: item.assetId })),
  );
  if (resolution.status === 'none') return null;
  if (resolution.status === 'conflict') throw markerConflict(resolution.reason);
  const order = await readCommerceDocument(
    commerce,
    dropDeliveryOrderPath(body.dropId, resolution.deliveryId),
    transaction,
  );
  if (!order) throw markerConflict('marker delivery order missing');
  const completed = completedMarkerReuse(fields, order.fields, resolution);
  validateWorkflowCompletion(completeResponse(body.dropId, body.requestId, completed), completed);
  return { completed, reference: await markerReuseReference(completed) };
}

function completeRequestWrite(path: string, completed: Record<string, unknown>): CommerceWrite {
  const fields: Record<string, unknown> = {
    status: 'complete',
    ...(Number.isSafeInteger(completed.deliveryId) ? { deliveryId: completed.deliveryId } : {}),
    receiptTxs: normalizeReceiptTxs(completed.receiptTxs),
    claimCodes: Array.isArray(completed.claimCodes) ? completed.claimCodes : [],
    ...(Array.isArray(completed.boxes) ? { boxes: completed.boxes } : {}),
    ...(Array.isArray(completed.cards) ? { cards: completed.cards } : {}),
    ...(typeof completed.duplicateOfRequestId === 'string' ? { duplicateOfRequestId: completed.duplicateOfRequestId } : {}),
    ...(Number.isSafeInteger(completed.internalDeliveryId) ? { internalDeliveryId: completed.internalDeliveryId } : {}),
    ...(typeof completed.internalDeliveryPda === 'string' ? { internalDeliveryPda: completed.internalDeliveryPda } : {}),
    ...(typeof completed.internalDeliveryTx === 'string' ? { internalDeliveryTx: completed.internalDeliveryTx } : {}),
    ...(typeof completed.closeDeliveryTx === 'string' ? { closeDeliveryTx: completed.closeDeliveryTx } : {}),
  };
  return deleteFieldsWrite(path, fields, [
    'processingAttemptId', 'processingStartedAt', 'processingLeaseExpiresAt', 'preparedExpiresAt',
    'pendingFinalizeSubmission', WORKFLOW_DRAFT_FIELD,
    `${WORKFLOW_EXECUTION_FIELD}.failure`,
    `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
    `${WORKFLOW_EXECUTION_FIELD}.pendingEffect`,
  ], [
    { fieldPath: 'completedAt', value: commerceFieldValue.serverTimestamp() },
    { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
  ]);
}

async function completeFromExistingMarkers(
  commerce: CommerceContext,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
  expected?: MarkerReuseReference,
): Promise<AdminIrlRedeemFinalizeResponse | null> {
  const result = await runTransaction<
    { status: 'none' } |
    { status: 'complete'; request: Record<string, unknown> }
  >(commerce, async (transaction) => {
    const document = await readCommerceDocument(commerce, requestPath(body), transaction);
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    if (document.fields.status === 'complete') return { result: { status: 'complete' as const, request: document.fields } };
    if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const resolved = await resolveExistingMarkerCompletion(commerce, transaction, body, request, document.fields);
    if (!resolved) return { result: { status: 'none' as const } };
    if (expected && (
      resolved.reference.deliveryId !== expected.deliveryId ||
      resolved.reference.sourceRequestId !== expected.sourceRequestId ||
      resolved.reference.fingerprint !== expected.fingerprint
    )) throw markerConflict('marker reuse state changed after draft');
    return {
      result: { status: 'complete' as const, request: resolved.completed },
      writes: [completeRequestWrite(document.path, resolved.completed)],
    };
  });
  return result.status === 'none' ? null : completeResponse(body.dropId, body.requestId, result.request);
}

async function reusableExistingMarkerState(
  commerce: CommerceContext,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
): Promise<
  | { status: 'none' }
  | { status: 'complete' }
  | ({ status: 'reuse' } & MarkerReuseReference)
> {
  return runTransaction<
    | { status: 'none' }
    | { status: 'complete' }
    | ({ status: 'reuse' } & MarkerReuseReference)
  >(commerce, async (transaction) => {
    const document = await readCommerceDocument(commerce, requestPath(body), transaction);
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    if (document.fields.status === 'complete') return { result: { status: 'complete' as const } };
    if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const resolved = await resolveExistingMarkerCompletion(commerce, transaction, body, request, document.fields);
    return {
      result: resolved
        ? { status: 'reuse' as const, ...resolved.reference }
        : { status: 'none' as const },
    };
  });
}

function newDeliveryId(): number {
  return deliveryReceiptRuntime.secureRandomInt(2 ** 31 - 1) + 1;
}

function newClaimCodes(quantity: number): string[] {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ITEMS) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid receipt claim code quantity.');
  }
  return generateUniqueStripeReceiptClaimCodes(quantity);
}

function createWithTimestamps(path: string, fields: Record<string, unknown>, timestamps: string[]): CommerceWrite {
  return createCommerceWrite({
    path,
    fields,
    transforms: timestamps.map((fieldPath) => ({ fieldPath, value: commerceFieldValue.serverTimestamp() })),
  });
}

async function publishPack(
  commerce: CommerceContext,
  runtime: Runtime,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
  receiptOwner: string,
  internal: InternalDelivery,
  closeDeliveryTx: string | null,
  receiptTxs: string[],
  boxes: AdminIrlRedeemBoxBaseInput[],
): Promise<AdminIrlRedeemFinalizeResponse> {
  const selectionKey = buildAdminIrlRedeemSelectionKey({
    dropId: runtime.dropId,
    originalAssetIds: boxes.map((box) => box.originalAssetId),
  });
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = newDeliveryId();
    const claimCodes = newClaimCodes(boxes.length);
    const boxesWithCodes = boxes.map((box, index) => ({ ...box, receiptClaimCode: claimCodes[index] }));
    const orderPath = dropDeliveryOrderPath(runtime.dropId, deliveryId);
    const claimPaths = claimCodes.map((code) => `claimCodes/${code}`);
    const result = await runTransaction<
      { status: 'collision' } |
      { status: 'complete'; request: Record<string, unknown> } |
      { status: 'created'; request: Record<string, unknown>; order: Record<string, unknown> }
    >(commerce, async (transaction) => {
      const document = await readCommerceDocument(commerce, requestPath(body), transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      if (document.fields.status === 'complete') return { result: { status: 'complete' as const, request: document.fields } };
      if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const resolution = await markerResolution(commerce, transaction, runtime.dropId, selectionKey, boxesWithCodes);
      if (resolution.status === 'conflict') throw markerConflict(resolution.reason);
      if (resolution.status === 'reuse') {
        const existingOrder = await readCommerceDocument(
          commerce,
          dropDeliveryOrderPath(runtime.dropId, resolution.deliveryId),
          transaction,
        );
        if (!existingOrder) throw markerConflict('marker delivery order missing');
        const completed = completedMarkerReuse(document.fields, existingOrder.fields, resolution);
        validateWorkflowCompletion(completeResponse(runtime.dropId, request.requestId, completed), completed);
        return {
          result: { status: 'complete' as const, request: completed },
          writes: [completeRequestWrite(document.path, completed)],
        };
      }
      if (await readCommerceDocument(commerce, orderPath, transaction)) {
        return { result: { status: 'collision' as const } };
      }
      const claims = await Promise.all(claimPaths.map((path) => readCommerceDocument(commerce, path, transaction)));
      if (claims.some(Boolean)) return { result: { status: 'collision' as const } };
      const order = buildAdminIrlRedeemDeliveryOrderDocument({
        dropId: runtime.dropId,
        deliveryId,
        requestId: request.requestId,
        owner: request.owner,
        receiptOwner,
        transferSignature: body.transferSignature,
        receiptTxs,
        boxes: boxesWithCodes,
      });
      Object.assign(order, createDeliveryPackStatusProjectionOutbox(runtime, order, commerce.nowMs).fields);
      const writes: CommerceWrite[] = [createWithTimestamps(orderPath, order, ['createdAt', 'processedAt'])];
      boxesWithCodes.forEach((box, index) => {
        writes.push(createWithTimestamps(claimPaths[index], buildAdminIrlRedeemClaimCodeDocument({
          dropId: runtime.dropId,
          deliveryId,
          owner: request.owner,
          receiptOwner,
          requestId: request.requestId,
          box,
        }), ['createdAt', 'updatedAt']));
      });
      const markerWrites = new Map<string, CommerceWrite>();
      boxesWithCodes.forEach((box) => {
        const marker = buildAdminIrlRedeemMarkerDocument({
          dropId: runtime.dropId,
          deliveryId,
          requestId: request.requestId,
          owner: request.owner,
          transferSignature: body.transferSignature,
          selectionKey,
          box,
        });
        for (const path of markerPaths(runtime.dropId, [box])) {
          markerWrites.set(path, createWithTimestamps(path, marker, ['createdAt']));
        }
      });
      writes.push(...markerWrites.values());
      const completed: Record<string, unknown> = {
        ...document.fields,
        status: 'complete',
        deliveryId,
        internalDeliveryId: internal.deliveryId,
        internalDeliveryPda: internal.deliveryPda,
        ...(internal.deliveryTx ? { internalDeliveryTx: internal.deliveryTx } : {}),
        ...(closeDeliveryTx ? { closeDeliveryTx } : {}),
        receiptTxs,
        claimCodes,
        boxes: boxesWithCodes.map((box) => ({
          boxId: box.boxId,
          originalAssetId: box.originalAssetId,
          receiptAssetId: box.receiptAssetId,
          claimCode: box.receiptClaimCode,
          dudeIds: box.dudeIds,
        })),
      };
      writes.push(completeRequestWrite(document.path, completed));
      return { result: { status: 'created' as const, request: completed, order }, writes };
    });
    if (result.status === 'collision') continue;
    return completeResponse(runtime.dropId, request.requestId, result.request);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate Admin IRL redeem delivery id or claim codes.');
}

async function publishCard(
  commerce: CommerceContext,
  runtime: Runtime,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
  receiptOwner: string,
  card: Omit<AdminIrlRedeemCardInput, 'receiptClaimCode'>,
): Promise<AdminIrlRedeemFinalizeResponse> {
  const markerPath = dropAdminIrlRedeemReceiptMarkerPath(runtime.dropId, card.receiptAssetId);
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = newDeliveryId();
    const claimCode = newClaimCodes(1)[0];
    const cardWithCode = { ...card, receiptClaimCode: claimCode };
    const orderPath = dropDeliveryOrderPath(runtime.dropId, deliveryId);
    const claimPath = `claimCodes/${claimCode}`;
    const result = await runTransaction<
      { status: 'collision' } |
      { status: 'complete'; request: Record<string, unknown> } |
      { status: 'created'; request: Record<string, unknown> }
    >(commerce, async (transaction) => {
      const document = await readCommerceDocument(commerce, requestPath(body), transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      if (document.fields.status === 'complete') return { result: { status: 'complete' as const, request: document.fields } };
      if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const existingMarker = await readCommerceDocument(commerce, markerPath, transaction);
      if (existingMarker) {
        const marker = existingMarker.fields;
        const existingDeliveryId = Math.floor(Number(marker.deliveryId));
        let existingClaimCode = '';
        try { existingClaimCode = requireStripeReceiptClaimCode(marker.claimCode); } catch { throw markerConflict('invalid card receipt marker claim code'); }
        if (
          marker.version !== ADMIN_IRL_REDEEM_CARD_MARKER_VERSION ||
          marker.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          marker.targetKind !== 'card_receipt' || marker.dropId !== runtime.dropId ||
          marker.receiptAssetId !== card.receiptAssetId || Number(marker.figureId) !== card.figureId ||
          !Number.isSafeInteger(existingDeliveryId) || existingDeliveryId < 1 || marker.owner !== request.owner
        ) throw markerConflict('card receipt marker mismatch');
        const [order, claim] = await Promise.all([
          readCommerceDocument(commerce, dropDeliveryOrderPath(runtime.dropId, existingDeliveryId), transaction),
          readCommerceDocument(commerce, `claimCodes/${existingClaimCode}`, transaction),
        ]);
        if (!order || !claim) throw markerConflict('card receipt marker order or claim missing');
        const item = Array.isArray(order.fields.items) && isRecord(order.fields.items[0]) ? order.fields.items[0] : {};
        const orderClaim = isRecord(order.fields.stripeReceiptClaim) ? order.fields.stripeReceiptClaim : {};
        if (
          order.fields.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          !isRecord(order.fields.adminIrlRedeem) || order.fields.adminIrlRedeem.targetKind !== 'card_receipt' ||
          order.fields.owner !== request.owner || !Array.isArray(order.fields.items) || order.fields.items.length !== 1 ||
          item.kind !== 'dude' || Number(item.refId) !== card.figureId || item.assetId !== card.receiptAssetId ||
          orderClaim.receiptKind !== 'figure' || orderClaim.receiptAssetId !== card.receiptAssetId ||
          Number(orderClaim.figureId) !== card.figureId || stripeReceiptClaimCodeMaybe(orderClaim) !== existingClaimCode ||
          claim.fields.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE || claim.fields.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          claim.fields.dropId !== runtime.dropId || Number(claim.fields.deliveryId) !== existingDeliveryId ||
          claim.fields.receiptKind !== 'figure' || claim.fields.receiptAssetId !== card.receiptAssetId || Number(claim.fields.figureId) !== card.figureId ||
          normalizeStripeReceiptClaimCode(claim.fields.code) !== existingClaimCode
        ) throw markerConflict('card receipt marker order or claim mismatch');
        const completed: Record<string, unknown> = {
          ...document.fields,
          status: 'complete',
          deliveryId: existingDeliveryId,
          receiptTxs: normalizeReceiptTxs(order.fields.receiptTxs),
          claimCodes: [existingClaimCode],
          cards: [{ figureId: card.figureId, receiptAssetId: card.receiptAssetId, claimCode: existingClaimCode }],
          duplicateOfRequestId: marker.requestId,
        };
        return { result: { status: 'complete' as const, request: completed }, writes: [completeRequestWrite(document.path, completed)] };
      }
      const [orderExists, claimExists] = await Promise.all([
        readCommerceDocument(commerce, orderPath, transaction),
        readCommerceDocument(commerce, claimPath, transaction),
      ]);
      if (orderExists || claimExists) return { result: { status: 'collision' as const } };
      const order = buildAdminIrlRedeemCardDeliveryOrderDocument({
        dropId: runtime.dropId,
        deliveryId,
        requestId: request.requestId,
        owner: request.owner,
        receiptOwner,
        transferSignature: body.transferSignature,
        card: cardWithCode,
      });
      const claim = buildAdminIrlRedeemCardClaimCodeDocument({
        dropId: runtime.dropId,
        deliveryId,
        owner: request.owner,
        receiptOwner,
        requestId: request.requestId,
        card: cardWithCode,
      });
      const marker = buildAdminIrlRedeemCardMarkerDocument({
        dropId: runtime.dropId,
        deliveryId,
        requestId: request.requestId,
        owner: request.owner,
        transferSignature: body.transferSignature,
        card: cardWithCode,
      });
      const completed: Record<string, unknown> = {
        ...document.fields,
        status: 'complete',
        deliveryId,
        receiptTxs: [body.transferSignature],
        claimCodes: [claimCode],
        cards: [{ figureId: card.figureId, receiptAssetId: card.receiptAssetId, claimCode }],
      };
      return {
        result: { status: 'created' as const, request: completed },
        writes: [
          createWithTimestamps(orderPath, order, ['createdAt', 'processedAt']),
          createWithTimestamps(claimPath, claim, ['createdAt', 'updatedAt']),
          createWithTimestamps(markerPath, marker, ['createdAt']),
          completeRequestWrite(document.path, completed),
        ],
      };
    });
    if (result.status === 'collision') continue;
    return completeResponse(runtime.dropId, request.requestId, result.request);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate Admin IRL card receipt delivery id or claim code.');
}

function workflowCommerceContext(
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  signal: AbortSignal,
  nowMs = Date.now(),
): CommerceContext {
  return {
    commerceDb: env.COMMERCE_DB,
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs,
    providerFetch: (input, init) => fetch(input, init),
    signal,
    dataDb: env.DATA_DB,
  };
}

function workflowProviderContext(
  env: Pick<Env, 'HELIUS_API_KEY'>,
  signal: AbortSignal,
): ProviderContext {
  const apiKey = String(env.HELIUS_API_KEY || '').trim();
  if (!apiKey) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
  }
  return { apiKey, providerFetch: (input, init) => fetch(input, init), signal };
}

function workflowSigner(env: Pick<Env, 'COSIGNER_SECRET'>): Keypair {
  const secret = String(env.COSIGNER_SECRET || '').trim();
  if (!secret) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
  }
  return decodeCosigner(secret);
}

function workflowResultReference(
  dropId: string,
  requestId: string,
): AdminIrlRedeemFinalizeWorkflowResultReference {
  return { kind: 'admin-irl-redeem-finalize-v1', dropId, requestId };
}

async function projectWorkflowPackStatus(
  commerce: CommerceContext,
  response: AdminIrlRedeemFinalizeResponse,
): Promise<void> {
  const deliveryId = response.deliveryId;
  if (typeof deliveryId !== 'number' || !Number.isSafeInteger(deliveryId) || deliveryId < 1 || response.boxes.length < 1) {
    return;
  }
  try {
    await projectPendingDeliveryPackStatus({
      context: commerce,
      deliveryId,
      dropId: response.dropId,
    });
  } catch (error) {
    console.error({
      event: 'admin_irl_redeem_pack_status_projection_failed',
      dropId: response.dropId,
      deliveryId,
      error: summarizeError(error),
    });
  }
}

type LoadedWorkflowRequest =
  | Readonly<{
      status: 'complete';
      response: AdminIrlRedeemFinalizeResponse;
      body: FinalizeRequest;
      commerce: CommerceContext;
    }>
  | Readonly<{
      status: 'started';
      body: FinalizeRequest;
      commerce: CommerceContext;
      request: StartedRequest;
      execution: AdminIrlRedeemFinalizeWorkflowExecutionV1;
      draft?: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1;
    }>;

async function loadWorkflowRequest(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
  confirmEntry = false,
): Promise<LoadedWorkflowRequest> {
  const payload = parseAdminIrlRedeemFinalizeWorkflowPayload(args.payload);
  if (!payload || !isAdminIrlRedeemFinalizeOperationId(args.operationId)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow request.');
  }
  const commerce = workflowCommerceContext(args.env, args.signal);
  const path = dropAdminIrlRedeemRequestPath(payload.dropId, payload.requestId);
  return runTransaction<LoadedWorkflowRequest>(commerce, async (transaction) => {
    const document = await readCommerceDocument(commerce, path, transaction);
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    const fields = document.fields;
    const owner = canonicalPublicKey(fields.owner);
    const transferSignature = canonicalSignature(fields.transferSignature);
    if (!owner || !transferSignature) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem transfer signature is invalid.');
    }
    const body = { dropId: payload.dropId, requestId: payload.requestId, transferSignature };
    const expectedOperationId = await adminIrlRedeemFinalizeOperationIdForWallet(body, owner);
    if (expectedOperationId !== args.operationId || fields.dropId !== payload.dropId) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem Workflow identity mismatch.');
    }
    if (fields.status === 'complete') {
      return {
        result: {
          status: 'complete' as const,
          response: completeResponse(payload.dropId, payload.requestId, fields),
          body,
          commerce,
        },
      };
    }
    if (fields.status !== 'processing' || fields.processingAttemptId !== args.operationId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const request = startedFinalizeRequest(body, fields, owner);
    const execution = request.workflowFinalizeV1;
    if (
      !execution || execution.operationId !== args.operationId || execution.owner !== owner ||
      execution.transferSignature !== transferSignature || execution.adminWallet !== request.adminWallet
    ) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
    }
    const enteredAtMs = Date.now();
    const enteredEffect = confirmEntry && execution.pendingEffect?.kind === 'create'
      ? {
          ...execution.pendingEffect,
          untilMs: Math.max(execution.pendingEffect.untilMs, enteredAtMs + WORKFLOW_EFFECT_LEASE_MS),
        }
      : undefined;
    return {
      result: {
        status: 'started' as const,
        body,
        commerce,
        request,
        execution,
        ...(request.workflowPublicationDraftV1 ? { draft: request.workflowPublicationDraftV1 } : {}),
      },
      writes: [deleteFieldsWrite(path, {
        processingLeaseExpiresAt: timestamp(enteredAtMs + PROCESSING_LEASE_MS),
        ...(enteredEffect
          ? { [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: enteredEffect }
          : {}),
      }, confirmEntry ? [
        `${WORKFLOW_EXECUTION_FIELD}.failure`,
        `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
      ] : [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
    };
  });
}

function validateWorkflowDraftForRequest(
  draft: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
  request: StartedRequest,
  runtime: Runtime,
): void {
  if (draft.receiptOwner !== request.adminWallet || draft.targetKind !== request.targetKind) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft does not match the request.');
  }
  if (draft.targetKind === 'card_receipt') {
    const item = request.items[0];
    if (
      request.items.length !== 1 || !item || item.kind !== 'card_receipt' ||
      draft.card.figureId !== item.refId || draft.card.receiptAssetId !== item.assetId
    ) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft does not match the request.');
    }
    return;
  }
  if (draft.mode === 'marker_reuse') return;
  const [expectedDeliveryPda] = deriveDeliveryPda(runtime, draft.internalDelivery.deliveryId);
  if (
    expectedDeliveryPda.toBase58() !== draft.internalDelivery.deliveryPda ||
    request.internalDeliveryId !== draft.internalDelivery.deliveryId ||
    request.internalDeliveryPda !== draft.internalDelivery.deliveryPda ||
    (request.internalDeliveryTx || null) !== draft.internalDelivery.deliveryTx ||
    (request.closeDeliveryTx || null) !== draft.closeDeliveryTx ||
    request.receiptTxs.length !== draft.receiptTxs.length ||
    request.receiptTxs.some((signature, index) => signature !== draft.receiptTxs[index]) ||
    draft.boxes.length !== request.items.length ||
    new Set(draft.boxes.map((box) => box.receiptAssetId)).size !== draft.boxes.length ||
    new Set(draft.boxes.flatMap((box) => box.dudeIds)).size !== draft.boxes.reduce((sum, box) => sum + box.dudeIds.length, 0) ||
    draft.boxes.some((box, index) => {
      const item = request.items[index];
      return !item || item.kind !== 'box' || box.boxId !== item.refId ||
        box.originalAssetId !== item.assetId || box.dudeIds.length !== runtime.itemsPerBox ||
        box.dudeIds.some((dudeId) => dudeId > runtime.maxDudeId);
    })
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft does not match the request.');
  }
}

async function persistWorkflowOnchain(
  loaded: Extract<LoadedWorkflowRequest, { status: 'started' }>,
  onchain: AdminIrlRedeemFinalizeWorkflowOnchainV1,
): Promise<void> {
  let persisted = onchain;
  await runTransaction(loaded.commerce, async (transaction) => {
    const document = await readCommerceDocument(
      loaded.commerce,
      requestPath(loaded.body),
      transaction,
    );
    if (
      !document || document.fields.status !== 'processing' ||
      document.fields.processingAttemptId !== loaded.execution.operationId
    ) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const current = normalizeWorkflowExecution(document.fields[WORKFLOW_EXECUTION_FIELD], loaded.body);
    if (
      current.operationId !== loaded.execution.operationId ||
      current.owner !== loaded.execution.owner ||
      current.transferSignature !== loaded.execution.transferSignature ||
      current.adminWallet !== loaded.execution.adminWallet ||
      JSON.stringify(current.config) !== JSON.stringify(loaded.execution.config)
    ) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution changed.');
    }
    const existing = current.onchain;
    if (existing && (
      existing.adminWallet !== onchain.adminWallet ||
      existing.coreCollection !== onchain.coreCollection ||
      existing.treasury !== onchain.treasury
    )) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem on-chain configuration changed.');
    }
    persisted = existing || onchain;
    return {
      result: undefined,
      writes: [deleteFieldsWrite(document.path, {
        [`${WORKFLOW_EXECUTION_FIELD}.onchain`]: persisted,
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
    };
  });
  loaded.execution.onchain = persisted;
}

async function persistWorkflowDraft(
  loaded: Extract<LoadedWorkflowRequest, { status: 'started' }>,
  draft: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
): Promise<void> {
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  await runTransaction(loaded.commerce, async (transaction) => {
    const document = await readCommerceDocument(
      loaded.commerce,
      requestPath(loaded.body),
      transaction,
    );
    if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== loaded.execution.operationId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const currentRequest = startedFinalizeRequest(loaded.body, document.fields, loaded.request.owner);
    const candidate = draft.targetKind === 'pack' && draft.mode === 'prepared'
      ? {
          ...draft,
          internalDelivery: {
            ...draft.internalDelivery,
            deliveryTx: currentRequest.internalDeliveryTx || null,
          },
          closeDeliveryTx: currentRequest.closeDeliveryTx || null,
          receiptTxs: currentRequest.receiptTxs,
        }
      : draft;
    validateWorkflowDraftForRequest(candidate, currentRequest, runtime);
    const existing = normalizeWorkflowDraft(document.fields[WORKFLOW_DRAFT_FIELD]);
    if (existing) {
      validateWorkflowDraftForRequest(existing, currentRequest, runtime);
      return { result: undefined };
    }
    return {
      result: undefined,
      writes: [deleteFieldsWrite(document.path, {
        [WORKFLOW_DRAFT_FIELD]: candidate,
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
    };
  });
}

export async function reserveAdminIrlRedeemFinalizeWorkflow(args: Readonly<{
  body: AdminIrlRedeemFinalizeRequest;
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  operationId: string;
  signal: AbortSignal;
  staffWallet: string;
  nowMs?: number;
}>): Promise<AdminIrlRedeemFinalizeWorkflowReservation> {
  const parsed = requestSchema.safeParse(args.body);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  const wallet = canonicalWallet(args.staffWallet);
  if (args.operationId !== await adminIrlRedeemFinalizeOperationId(parsed.data, wallet)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow operation id.');
  }
  const config = API_DROPS[parsed.data.dropId];
  if (!config) throw new AdminIrlRedeemFinalizeError('invalid-argument', `Unsupported dropId: ${parsed.data.dropId}`);
  const snapshot = JSON.parse(JSON.stringify(config)) as ApiDropConfig;
  runtimeSupportsFinalize(buildAdminIrlRedeemRuntime(snapshot));
  const commerce = workflowCommerceContext(args.env, args.signal, args.nowMs ?? Date.now());
  const prepared = await readCommerceDocument(commerce, requestPath(parsed.data));
  if (!prepared) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
  const owner = finalizeRequestOwner(prepared.fields, wallet);
  const adminWallet = canonicalPublicKey(prepared.fields.adminWallet);
  if (!adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request admin wallet is invalid.');
  }
  const execution: AdminIrlRedeemFinalizeWorkflowExecutionV1 = {
    version: 1,
    operationId: args.operationId,
    owner,
    transferSignature: parsed.data.transferSignature,
    adminWallet,
    config: snapshot,
    pendingEffect: { kind: 'create', untilMs: 0 },
  };
  const started = await startFinalize(
    commerce,
    parsed.data,
    wallet,
    args.operationId,
    args.nowMs ?? Date.now(),
    execution,
  );
  if (started.status === 'complete') {
    return { status: 'complete', result: completeResponse(parsed.data.dropId, parsed.data.requestId, started.request) };
  }
  return {
    status: 'reserved',
    payload: { version: 1, dropId: parsed.data.dropId, requestId: parsed.data.requestId },
  };
}

export async function resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args, true);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  const provider = workflowProviderContext(args.env, args.signal);
  await reconcileStartedRequestSubmission({
    commerce: loaded.commerce,
    provider,
    runtime,
    path: requestPath(loaded.body),
    attemptId: args.operationId,
    request: loaded.request,
  });
  return { status: 'ready' };
}

export async function validateAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  if (loaded.request.pendingFinalizeSubmission) throw new PendingFinalizeSubmissionError();
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  const provider = workflowProviderContext(args.env, args.signal);
  const connection = createConnection(provider, runtime);
  const signer = workflowSigner(args.env);
  const onchain = await fetchDeliveryOnchainConfig(connection, runtime);
  const pinned = {
    adminWallet: onchain.admin.toBase58(),
    coreCollection: onchain.coreCollection.toBase58(),
    treasury: new PublicKey(onchain.decoded.treasury).toBase58(),
  };
  if (pinned.adminWallet !== loaded.request.adminWallet || !signer.publicKey.equals(onchain.admin)) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match the prepared on-chain admin.');
  }
  await persistWorkflowOnchain(loaded, pinned);
  if (loaded.request.targetKind === 'card_receipt') {
    const card = loaded.request.items[0];
    if (!card || card.kind !== 'card_receipt') {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
    }
    await verifyCardTransfer(
      connection,
      runtime,
      loaded.body.transferSignature,
      loaded.request.owner,
      pinned.adminWallet,
      onchain.coreCollection,
      card.assetId,
    );
    return { status: 'ready' };
  }
  await verifyPackTransfer(
    connection,
    loaded.body.transferSignature,
    loaded.request.owner,
    pinned.adminWallet,
    onchain.coreCollection,
    loaded.request.itemIds,
  );
  return { status: 'ready' };
}

export async function prepareAdminIrlRedeemFinalizeWorkflowDraft(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  if (loaded.request.pendingFinalizeSubmission) {
    const provider = workflowProviderContext(args.env, args.signal);
    await reconcileStartedRequestSubmission({
      commerce: loaded.commerce,
      provider,
      runtime,
      path: requestPath(loaded.body),
      attemptId: args.operationId,
      request: loaded.request,
    });
  }
  const markerState = loaded.request.targetKind === 'pack'
    ? await reusableExistingMarkerState(loaded.commerce, loaded.body, args.operationId, loaded.request)
    : { status: 'none' as const };
  if (markerState.status === 'complete') return { status: 'complete' };
  if (markerState.status === 'reuse') {
    await persistWorkflowDraft(loaded, {
      version: 1,
      targetKind: 'pack',
      mode: 'marker_reuse',
      receiptOwner: loaded.request.adminWallet,
      deliveryId: markerState.deliveryId,
      sourceRequestId: markerState.sourceRequestId,
      fingerprint: markerState.fingerprint,
    });
    return { status: 'drafted' };
  }
  const provider = workflowProviderContext(args.env, args.signal);
  const pinned = loaded.execution.onchain;
  if (!pinned) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem Workflow configuration was not validated.');
  }
  const signer = workflowSigner(args.env);
  if (signer.publicKey.toBase58() !== pinned.adminWallet || pinned.adminWallet !== loaded.request.adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match the prepared on-chain admin.');
  }
  const connection = createConnection(provider, runtime);
  const current = await fetchDeliveryOnchainConfig(connection, runtime);
  if (
    current.admin.toBase58() !== pinned.adminWallet ||
    current.coreCollection.toBase58() !== pinned.coreCollection ||
    new PublicKey(current.decoded.treasury).toBase58() !== pinned.treasury
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem on-chain configuration changed.');
  }
  if (loaded.request.targetKind === 'card_receipt') {
    const card = loaded.request.items[0];
    if (!card || card.kind !== 'card_receipt') {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
    }
    await waitForCardReceipt(provider, runtime, card.assetId, card.refId, pinned.adminWallet);
    await persistWorkflowDraft(loaded, {
      version: 1,
      targetKind: 'card_receipt',
      receiptOwner: pinned.adminWallet,
      card: { figureId: card.refId, receiptAssetId: card.assetId },
    });
    return { status: 'drafted' };
  }
  const internal = await ensureInternalDelivery(
    connection,
    provider,
    runtime,
    signer,
    current,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request,
  );
  const receiptTxs = await mintPackReceipts(
    connection,
    provider,
    runtime,
    signer,
    current.coreCollection,
    loaded.request.items,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request.receiptTxs,
  );
  const assets = await findReceiptAssets(
    connection,
    provider,
    runtime,
    pinned.adminWallet,
    loaded.request.items,
    receiptTxs,
  );
  const boxes: AdminIrlRedeemBoxBaseInput[] = [];
  for (const item of loaded.request.items) {
    const matches = assets.get(item.refId) || [];
    if (matches.length === 0) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem pack receipt is not indexed yet.');
    }
    const receiptAssetId = matches.length === 1 ? canonicalPublicKey(matches[0].id) : undefined;
    if (matches.length !== 1 || !receiptAssetId) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem pack receipt indexing is ambiguous.');
    }
    const dudeIds = await deliveryReceiptRuntime.assignDudesForBox(
      loaded.commerce,
      runtime,
      receiptAssetId,
      deliveryReceiptRuntime.secureRandomInt,
    );
    boxes.push({ boxId: item.refId, originalAssetId: item.assetId, receiptAssetId, dudeIds });
  }
  const closeDeliveryTx = await closeInternalDelivery(
    connection,
    runtime,
    signer,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request,
    internal,
  ).catch(() => null);
  await persistWorkflowDraft(loaded, {
    version: 1,
    targetKind: 'pack',
    mode: 'prepared',
    receiptOwner: pinned.adminWallet,
    internalDelivery: internal,
    closeDeliveryTx,
    receiptTxs,
    boxes,
  });
  return { status: 'drafted' };
}

export async function publishAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowResultReference> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') {
    await projectWorkflowPackStatus(loaded.commerce, loaded.response);
    return workflowResultReference(loaded.body.dropId, loaded.body.requestId);
  }
  const draft = loaded.draft;
  if (!draft) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem publication draft is missing.');
  }
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  validateWorkflowDraftForRequest(draft, loaded.request, runtime);
  if (draft.targetKind === 'card_receipt') {
    await publishCard(
      loaded.commerce,
      runtime,
      loaded.body,
      args.operationId,
      loaded.request,
      draft.receiptOwner,
      draft.card,
    );
  } else if (draft.mode === 'marker_reuse') {
    const completed = await completeFromExistingMarkers(
      loaded.commerce,
      loaded.body,
      args.operationId,
      loaded.request,
      {
        deliveryId: draft.deliveryId,
        sourceRequestId: draft.sourceRequestId,
        fingerprint: draft.fingerprint,
      },
    );
    if (!completed) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem marker reuse state changed.');
    }
    await projectWorkflowPackStatus(loaded.commerce, completed);
  } else {
    const completed = await publishPack(
      loaded.commerce,
      runtime,
      loaded.body,
      args.operationId,
      loaded.request,
      draft.receiptOwner,
      draft.internalDelivery,
      draft.closeDeliveryTx,
      draft.receiptTxs,
      draft.boxes,
    );
    await projectWorkflowPackStatus(loaded.commerce, completed);
  }
  return workflowResultReference(loaded.body.dropId, loaded.body.requestId);
}

export async function cleanupAdminIrlRedeemFinalizeWorkflow(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  error: AdminIrlRedeemFinalizeWorkflowError;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
  signal: AbortSignal;
}>): Promise<{ cleared: boolean }> {
  const payload = parseAdminIrlRedeemFinalizeWorkflowPayload(args.payload);
  if (!payload) throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow request.');
  const workflowError = workflowErrorForCode(
    isAdminIrlRedeemFinalizeErrorCode(args.error.code) ? args.error.code : 'internal',
  );
  const commerce = workflowCommerceContext(args.env, args.signal);
  return runTransaction<{ cleared: boolean }>(commerce, async (transaction) => {
    const document = await readCommerceDocument(
      commerce,
      dropAdminIrlRedeemRequestPath(payload.dropId, payload.requestId),
      transaction,
    );
    if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== args.operationId) {
      return { result: { cleared: false } };
    }
    const hasProgress = document.fields.pendingFinalizeSubmission !== undefined ||
      document.fields.internalDeliveryTx !== undefined ||
      normalizeReceiptTxs(document.fields.receiptTxs).length > 0 ||
      document.fields[WORKFLOW_DRAFT_FIELD] !== undefined;
    if (hasProgress) {
      return {
        result: { cleared: false },
        writes: [deleteFieldsWrite(document.path, {
          lastFinalizeError: {
            kind: 'workflow',
            code: workflowError.code,
            recovery: workflowError.retryable ? 'automatic' : 'manual',
          },
          [`${WORKFLOW_EXECUTION_FIELD}.failure`]: workflowError,
          processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
        }, [
          `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
          `${WORKFLOW_EXECUTION_FIELD}.pendingEffect`,
        ], [
          { fieldPath: 'lastFinalizeErrorAt', value: commerceFieldValue.serverTimestamp() },
          { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
        ])],
      };
    }
    return {
      result: { cleared: true },
      writes: [deleteFieldsWrite(document.path, {
        status: 'prepared',
        lastFinalizeError: { kind: 'workflow', code: workflowError.code },
        [`${WORKFLOW_EXECUTION_FIELD}.failure`]: workflowError,
        preparedExpiresAt: timestamp(Date.now() + PREPARED_TTL_MS),
      }, [
        'processingAttemptId', 'processingStartedAt', 'processingLeaseExpiresAt',
        WORKFLOW_DRAFT_FIELD,
        `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
        `${WORKFLOW_EXECUTION_FIELD}.pendingEffect`,
      ], [
        { fieldPath: 'lastFinalizeErrorAt', value: commerceFieldValue.serverTimestamp() },
        { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
      ])],
    };
  });
}

export async function loadAdminIrlRedeemFinalizeWorkflowResult(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'>;
  operationId: string;
  reference?: AdminIrlRedeemFinalizeWorkflowResultReference;
}>): Promise<AdminIrlRedeemFinalizeResponse> {
  const repository = new D1CommerceRepository(args.env.COMMERCE_DB);
  const document = await repository.getAdminIrlRedeemRequestForWorkflowStatus(args.operationId);
  if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem Workflow operation not found.');
  const fields = document.data;
  const execution = isRecord(fields[WORKFLOW_EXECUTION_FIELD]) ? fields[WORKFLOW_EXECUTION_FIELD] : null;
  const owner = canonicalPublicKey(fields.owner);
  const transferSignature = canonicalSignature(fields.transferSignature);
  if (
    !execution || execution.version !== 1 || execution.operationId !== args.operationId ||
    !owner || execution.owner !== owner || execution.transferSignature !== transferSignature || !transferSignature
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  const dropId = document.key.dropId || '';
  const requestId = document.key.documentId;
  if (
    args.operationId !== await adminIrlRedeemFinalizeOperationIdForWallet({ dropId, requestId, transferSignature }, owner) ||
    fields.status !== 'complete' || fields.dropId !== dropId ||
    (args.reference && (args.reference.dropId !== dropId || args.reference.requestId !== requestId))
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  return validateWorkflowCompletion(completeResponse(dropId, requestId, fields), fields);
}

export type AdminIrlRedeemFinalizeWorkflowStoredOperation = Readonly<{
  dropId: string;
  failure?: AdminIrlRedeemFinalizeWorkflowError;
  pendingEffect?: Readonly<AdminIrlRedeemFinalizeWorkflowPendingEffect>;
  revision: string;
  owner: string;
  requestId: string;
  status: string;
}>;

type AdminIrlRedeemFinalizeWorkflowEffectClaimArgs = Readonly<{
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  expectedRevision: string;
  operationId: string;
  signal: AbortSignal;
  nowMs?: number;
}> & (
  | Readonly<{ kind: 'create'; claimId?: never }>
  | Readonly<{ kind: 'restart'; claimId: string }>
);

function validWorkflowEffectClaimId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export async function claimAdminIrlRedeemFinalizeWorkflowEffect(
  args: AdminIrlRedeemFinalizeWorkflowEffectClaimArgs,
): Promise<{ status: 'claimed' | 'busy' | 'changed' }> {
  if (args.signal.aborted) throw args.signal.reason;
  const nowMs = args.nowMs ?? Date.now();
  if (
    !Number.isSafeInteger(nowMs) || nowMs < 0 ||
    (args.kind === 'restart' && !validWorkflowEffectClaimId(args.claimId))
  ) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow effect time.');
  }
  const located = await raceWithSignal(
    new D1CommerceRepository(args.env.COMMERCE_DB)
      .getAdminIrlRedeemRequestForWorkflowStatus(args.operationId),
    args.signal,
  );
  if (!located) return { status: 'changed' };
  const commerce = workflowCommerceContext(args.env, args.signal, nowMs);
  const requestedUntilMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + WORKFLOW_EFFECT_LEASE_MS);
  const claimedEffect: AdminIrlRedeemFinalizeWorkflowPendingEffect = args.kind === 'create'
    ? { kind: 'create', untilMs: requestedUntilMs }
    : { kind: 'restart-claim', claimId: args.claimId, untilMs: requestedUntilMs };
  try {
    return await raceWithSignal(runTransaction<{ status: 'claimed' | 'busy' | 'changed' }>(
      commerce,
      async (transaction) => {
        const document = await readCommerceDocument(
          commerce,
          dropAdminIrlRedeemRequestPath(located.key.dropId || '', located.key.documentId),
          transaction,
        );
        const execution = document?.fields[WORKFLOW_EXECUTION_FIELD];
        if (
          !document || document.fields.status !== 'processing' ||
          document.fields.processingAttemptId !== args.operationId ||
          !isRecord(execution) || execution.version !== 1 || execution.operationId !== args.operationId
        ) {
          return { result: { status: 'changed' as const } };
        }
        const pending = workflowPendingEffect(execution);
        if (!pending.valid) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
        }
        if (
          args.kind === 'restart' && pending.effect?.kind === 'restart-claim' &&
          pending.effect.claimId === args.claimId
        ) {
          const renewedEffect = {
            ...pending.effect,
            untilMs: Math.max(pending.effect.untilMs, requestedUntilMs),
          };
          return renewedEffect.untilMs === pending.effect.untilMs
            ? { result: { status: 'claimed' as const } }
            : {
                result: { status: 'claimed' as const },
                writes: [deleteFieldsWrite(document.path, {
                  [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: renewedEffect,
                }, [
                  `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
                ], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
              };
        }
        if (document.updateTime !== args.expectedRevision) {
          return { result: { status: 'changed' as const } };
        }
        if (
          pending.effect?.kind === 'restart' ||
          ((pending.effect?.kind === 'create' || pending.effect?.kind === 'restart-claim') &&
            pending.effect.untilMs > nowMs)
        ) {
          return { result: { status: 'busy' as const } };
        }
        return {
          result: { status: 'claimed' as const },
          writes: [deleteFieldsWrite(document.path, {
            [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: claimedEffect,
          }, [
            `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
          ], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
        };
      },
    ), args.signal);
  } catch (error) {
    if (args.signal.aborted) throw args.signal.reason;
    try {
      const operation = await raceWithSignal(loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: args.env,
        operationId: args.operationId,
      }), args.signal);
      if (!operation || operation.status !== 'processing') return { status: 'changed' };
      const pending = operation.pendingEffect;
      if (
        args.kind === 'restart' && pending?.kind === 'restart-claim' &&
        pending.claimId === args.claimId
      ) return { status: 'claimed' };
      if (
        args.kind === 'restart' && pending?.kind === 'restart' &&
        pending.claimId === args.claimId
      ) return { status: 'busy' };
      if (args.kind === 'create' && pending?.kind === 'create' && pending.untilMs === requestedUntilMs) {
        return { status: 'claimed' };
      }
      return { status: 'changed' };
    } catch {
      if (args.signal.aborted) throw args.signal.reason;
      throw error;
    }
  }
}

export async function dispatchAdminIrlRedeemFinalizeWorkflowRestart(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  operationId: string;
  claimId: string;
  signal: AbortSignal;
  nowMs?: number;
}>): Promise<{ status: 'dispatched' | 'changed' }> {
  if (args.signal.aborted) throw args.signal.reason;
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !validWorkflowEffectClaimId(args.claimId)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow dispatch.');
  }
  const located = await raceWithSignal(
    new D1CommerceRepository(args.env.COMMERCE_DB)
      .getAdminIrlRedeemRequestForWorkflowStatus(args.operationId),
    args.signal,
  );
  if (!located) return { status: 'changed' };
  const commerce = workflowCommerceContext(args.env, args.signal, nowMs);
  try {
    return await raceWithSignal(runTransaction<{ status: 'dispatched' | 'changed' }>(
      commerce,
      async (transaction) => {
        const document = await readCommerceDocument(
          commerce,
          dropAdminIrlRedeemRequestPath(located.key.dropId || '', located.key.documentId),
          transaction,
        );
        const execution = document?.fields[WORKFLOW_EXECUTION_FIELD];
        if (
          !document || document.fields.status !== 'processing' ||
          document.fields.processingAttemptId !== args.operationId ||
          !isRecord(execution) || execution.version !== 1 || execution.operationId !== args.operationId
        ) return { result: { status: 'changed' as const } };
        const pending = workflowPendingEffect(execution);
        if (!pending.valid) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
        }
        if (pending.effect?.kind === 'restart' && pending.effect.claimId === args.claimId) {
          return { result: { status: 'dispatched' as const } };
        }
        if (pending.effect?.kind !== 'restart-claim' || pending.effect.claimId !== args.claimId) {
          return { result: { status: 'changed' as const } };
        }
        return {
          result: { status: 'dispatched' as const },
          writes: [deleteFieldsWrite(document.path, {
            [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: {
              kind: 'restart',
              claimId: args.claimId,
              dispatchedAtMs: nowMs,
            },
          }, [
            `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
          ], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
        };
      },
    ), args.signal);
  } catch (error) {
    if (args.signal.aborted) throw args.signal.reason;
    try {
      const operation = await raceWithSignal(loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: args.env,
        operationId: args.operationId,
      }), args.signal);
      return operation?.status === 'processing' &&
          operation.pendingEffect?.kind === 'restart' &&
          operation.pendingEffect.claimId === args.claimId
        ? { status: 'dispatched' }
        : { status: 'changed' };
    } catch {
      if (args.signal.aborted) throw args.signal.reason;
      throw error;
    }
  }
}

export async function retractAdminIrlRedeemFinalizeWorkflowRestartDispatch(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  operationId: string;
  claimId: string;
  signal: AbortSignal;
  nowMs?: number;
}>): Promise<{ status: 'retracted' | 'changed' }> {
  if (args.signal.aborted) throw args.signal.reason;
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !validWorkflowEffectClaimId(args.claimId)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow retraction.');
  }
  const located = await raceWithSignal(
    new D1CommerceRepository(args.env.COMMERCE_DB)
      .getAdminIrlRedeemRequestForWorkflowStatus(args.operationId),
    args.signal,
  );
  if (!located) return { status: 'changed' };
  const commerce = workflowCommerceContext(args.env, args.signal, nowMs);
  const untilMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + WORKFLOW_EFFECT_LEASE_MS);
  try {
    return await raceWithSignal(runTransaction<{ status: 'retracted' | 'changed' }>(
      commerce,
      async (transaction) => {
        const document = await readCommerceDocument(
          commerce,
          dropAdminIrlRedeemRequestPath(located.key.dropId || '', located.key.documentId),
          transaction,
        );
        const execution = document?.fields[WORKFLOW_EXECUTION_FIELD];
        if (
          !document || document.fields.status !== 'processing' ||
          document.fields.processingAttemptId !== args.operationId ||
          !isRecord(execution) || execution.version !== 1 || execution.operationId !== args.operationId
        ) return { result: { status: 'changed' as const } };
        const pending = workflowPendingEffect(execution);
        if (!pending.valid) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
        }
        if (pending.effect?.kind === 'restart-claim' && pending.effect.claimId === args.claimId) {
          const renewedEffect = {
            ...pending.effect,
            untilMs: Math.max(pending.effect.untilMs, untilMs),
          };
          return renewedEffect.untilMs === pending.effect.untilMs
            ? { result: { status: 'retracted' as const } }
            : {
                result: { status: 'retracted' as const },
                writes: [deleteFieldsWrite(document.path, {
                  [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: renewedEffect,
                }, [
                  `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
                ], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
              };
        }
        if (pending.effect?.kind !== 'restart' || pending.effect.claimId !== args.claimId) {
          return { result: { status: 'changed' as const } };
        }
        return {
          result: { status: 'retracted' as const },
          writes: [deleteFieldsWrite(document.path, {
            [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: {
              kind: 'restart-claim',
              claimId: args.claimId,
              untilMs,
            },
          }, [
            `${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`,
          ], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
        };
      },
    ), args.signal);
  } catch (error) {
    if (args.signal.aborted) throw args.signal.reason;
    try {
      const operation = await raceWithSignal(loadAdminIrlRedeemFinalizeWorkflowOperation({
        env: args.env,
        operationId: args.operationId,
      }), args.signal);
      return operation?.status === 'processing' &&
          operation.pendingEffect?.kind === 'restart-claim' &&
          operation.pendingEffect.claimId === args.claimId
        ? { status: 'retracted' }
        : { status: 'changed' };
    } catch {
      if (args.signal.aborted) throw args.signal.reason;
      throw error;
    }
  }
}

export async function loadAdminIrlRedeemFinalizeWorkflowOperation(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'>;
  operationId: string;
}>): Promise<AdminIrlRedeemFinalizeWorkflowStoredOperation | null> {
  const document = await new D1CommerceRepository(args.env.COMMERCE_DB)
    .getAdminIrlRedeemRequestForWorkflowStatus(args.operationId);
  if (!document) return null;
  const execution = document.data[WORKFLOW_EXECUTION_FIELD];
  if (!isRecord(execution) || execution.version !== 1 || execution.operationId !== args.operationId) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow operation is invalid.');
  }
  const owner = canonicalPublicKey(execution.owner);
  const transferSignature = canonicalSignature(execution.transferSignature);
  const failure = execution.failure === undefined ? undefined : parseWorkflowError(execution.failure);
  const pending = workflowPendingEffect(execution);
  const dropId = document.key.dropId || '';
  const requestId = document.key.documentId;
  if (
    !owner || !transferSignature || (execution.failure !== undefined && !failure) ||
    !pending.valid ||
    args.operationId !== await adminIrlRedeemFinalizeOperationIdForWallet({ dropId, requestId, transferSignature }, owner)
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow operation is invalid.');
  }
  return {
    dropId,
    ...(failure ? { failure } : {}),
    ...(pending.valid && pending.effect ? { pendingEffect: pending.effect } : {}),
    revision: document.updateTime,
    owner,
    requestId,
    status: typeof document.data.status === 'string' ? document.data.status : '',
  };
}

export const adminIrlRedeemFinalizeTestHooks = {
  clearDefinitiveFinalizeSubmission,
  completeResponse,
  findReceiptAssets,
  normalizeItems,
  normalizePendingFinalizeSubmission,
  isDefinitiveTransactionFailure,
  mintPackReceipts,
  persistPendingFinalizeSubmission,
  pendingFinalizeSubmissionAlreadySettled,
  persistWorkflowOnchain,
  probePendingFinalizeSubmission,
  readRequestBody,
  receiptBatchConfirmedByPostState,
  rethrowUnbroadcastFinalizeCancellation,
  runtimeSupportsFinalize,
  scanAssetsByOwner,
  settlePendingFinalizeSubmission,
  startFinalize,
  verifyCardTransfer,
  verifyPackTransfer,
  waitForCardReceipt,
};
