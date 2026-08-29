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
import { API_DROPS } from './dropConfig.js';
import { IX_BUBBLEGUM_TRANSFER_V2 } from './bubblegum.js';
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
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
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
  RequestIdentityError,
  isStaffRequestIdentity,
  resolveRequestWallet,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  type ProfileProviderFetch,
} from './boundedResponse.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  isSignalCancellationError,
  readBoundedRequestJson,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
} from './commerceRepository.js';
import {
  buildRuntime as buildAdminIrlRedeemRuntime,
  fetchAsset as fetchAdminIrlRedeemAsset,
  fetchAssetProof as fetchAdminIrlRedeemAssetProof,
  loadBoundWallet as loadAdminIrlRedeemBoundWallet,
  parseProof as parseAdminIrlRedeemProof,
  receiptDropIdentity as adminIrlRedeemReceiptDropIdentity,
  rpcCall as adminIrlRedeemRpcCall,
} from './adminIrlRedeemOnchain.js';
import {
  createDeliveryPackStatusProjectionOutbox,
  deliveryReceiptRuntime,
  scheduleDeliveryPackStatusProjection,
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
import {
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';

export const ADMIN_IRL_REDEEM_FINALIZE_PATH = '/admin/irl-redeem/finalize';

const REQUEST_MAX_BYTES = 4096;
const HANDLER_TIMEOUT_MS = 540_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const PREPARED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;
const RECEIPT_INDEX_MAX_WAIT_MS = 30_000;
const RECEIPT_INDEX_POLL_MS = 2_000;
const COMMERCE_TRANSACTION_ATTEMPTS = 6;
const MAX_ITEMS = 32;
const MAX_DELIVERY_ALLOCATION_ATTEMPTS = 16;
const HELIUS_ASSET_PAGE_LIMIT = 1000;
const HELIUS_ASSET_MAX_PAGES = 64;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
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
  transferSignature: z.string().min(64).max(128).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
}).strict();

type FinalizeRequest = z.infer<typeof requestSchema>;
type FinalizeEnv = Pick<Env, 'COSIGNER_SECRET' | 'HELIUS_API_KEY'> &
  Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB' | 'OPS_DB'>>;
type CommerceContext = Parameters<typeof deliveryReceiptRuntime.readDocument>[0];
type CommerceTransaction = Awaited<ReturnType<typeof deliveryReceiptRuntime.beginTransaction>>;
type CommerceWrite = ReturnType<typeof deliveryReceiptRuntime.updateWrite>;
type CommerceTransform = NonNullable<Parameters<typeof deliveryReceiptRuntime.updateWrite>[0]['transforms']>[number];
type ProviderContext = Parameters<typeof fetchAdminIrlRedeemAsset>[0];
type Runtime = ReturnType<typeof buildAdminIrlRedeemRuntime>;
type OnchainConfig = Awaited<ReturnType<typeof fetchDeliveryOnchainConfig>>;
export type AdminIrlRedeemFinalizeErrorCode =
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

type StartedRequest = {
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

export type AdminIrlRedeemFinalizeResult = {
  response: Response;
  metrics: { upstreamCalls: number; providerDurationMs: number };
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  targetKind?: AdminIrlRedeemTargetKind;
  deliveryId?: number;
  outcome?: string;
};

type FinalizeDependencies = {
  finalize: typeof finalizeAdminIrlRedeem;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

function statusForCode(code: AdminIrlRedeemFinalizeErrorCode): number {
  if (code === 'invalid-argument') return 400;
  if (code === 'unauthenticated') return 401;
  if (code === 'permission-denied') return 403;
  if (code === 'not-found') return 404;
  if (code === 'aborted' || code === 'failed-precondition') return 409;
  if (code === 'resource-exhausted') return 429;
  if (code === 'deadline-exceeded') return 504;
  if (code === 'unavailable') return 502;
  return 500;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Timing-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorResponse(error: AdminIrlRedeemFinalizeError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, statusForCode(error.code));
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof AdminIrlRedeemFinalizeError) {
    return { kind: error.name, code: error.code, message: error.message };
  }
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: typeof error, message: String(error) };
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

function normalizeItems(request: Record<string, unknown>): {
  itemIds: string[];
  items: RequestItem[];
  targetKind: AdminIrlRedeemTargetKind;
} {
  const rawItems = Array.isArray(request.items) ? request.items : [];
  const items = rawItems.map((value): RequestItem | null => {
    if (!isRecord(value)) return null;
    const assetId = typeof value.assetId === 'string' ? value.assetId.trim() : '';
    const refId = Math.floor(Number(value.refId));
    if (!assetId || !Number.isSafeInteger(refId) || refId < 1 || refId > 0xffff_ffff) return null;
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

function requestPath(body: FinalizeRequest): string {
  return dropAdminIrlRedeemRequestPath(body.dropId, body.requestId);
}

function timestamp(value: number) {
  return deliveryReceiptRuntime.commerceTimestamp(value);
}

function deleteFieldsWrite(path: string, fields: Record<string, unknown>, deleted: string[], transforms: CommerceTransform[]): CommerceWrite {
  return deliveryReceiptRuntime.updateWrite({
    path,
    fields,
    fieldPaths: [...Object.keys(fields), ...deleted],
    transforms,
    mustExist: true,
  });
}

async function runTransaction<T>(
  context: CommerceContext,
  operation: (transaction: CommerceTransaction) => Promise<{ result: T; writes?: CommerceWrite[] }>,
): Promise<T> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: CommerceTransaction | undefined;
    try {
      transaction = await deliveryReceiptRuntime.beginTransaction(context);
      const { result, writes } = await operation(transaction);
      await deliveryReceiptRuntime.commitWrites(context, writes || [], transaction);
      transaction = undefined;
      return result;
    } catch (error) {
      if (transaction) await deliveryReceiptRuntime.rollbackTransactionBestEffort(context, transaction);
      if (error instanceof CommerceWriteConflict && attempt + 1 < COMMERCE_TRANSACTION_ATTEMPTS) {
        await deliveryReceiptRuntime.pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    }
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem data is temporarily unavailable.');
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
  const pendingFinalizeSubmission = normalizePendingFinalizeSubmission(request.pendingFinalizeSubmission);
  const internalDeliveryId = Math.floor(Number(request.internalDeliveryId));
  return {
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
  };
}

async function startFinalize(
  context: CommerceContext,
  body: FinalizeRequest,
  wallet: string,
  attemptId: string,
  nowMs: number,
): Promise<StartFinalizeResult> {
  const path = requestPath(body);
  try {
    return await runTransaction<StartFinalizeResult>(context, async (transaction) => {
      const document = await deliveryReceiptRuntime.readDocument(context, path, transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      const request = document.fields;
      if (request.dropId !== body.dropId) throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request drop mismatch.');
      const owner = finalizeRequestOwner(request, wallet);
      if (request.status === 'complete') return { result: { status: 'complete' as const, request } };
      const leaseExpiresAt = Number(request.processingLeaseExpiresAt || 0);
      if (request.status === 'processing' && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'This Admin IRL redeem request is already being finalized.');
      }
      const started = startedFinalizeRequest(body, request, owner);
      return {
        result: { status: 'started' as const, request: started },
        writes: [deleteFieldsWrite(path, {
          status: 'processing',
          transferSignature: body.transferSignature,
          processingAttemptId: attemptId,
          processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
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
      const document = await deliveryReceiptRuntime.readDocument(cleanup, path);
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

async function clearProcessing(context: CommerceContext, body: FinalizeRequest, attemptId: string, error: unknown): Promise<void> {
  const cleanup = cleanupContext(context);
  await runTransaction(cleanup, async (transaction) => {
    const document = await deliveryReceiptRuntime.readDocument(cleanup, requestPath(body), transaction);
    if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
      return { result: undefined };
    }
    if (document.fields.pendingFinalizeSubmission !== undefined) return { result: undefined };
    return {
      result: undefined,
      writes: [deleteFieldsWrite(document.path, {
        status: 'prepared',
        lastFinalizeError: summarizeError(error),
        preparedExpiresAt: timestamp(Date.now() + PREPARED_TTL_MS),
      }, ['processingAttemptId', 'processingStartedAt', 'processingLeaseExpiresAt'], [
        { fieldPath: 'lastFinalizeErrorAt', value: commerceFieldValue.serverTimestamp() },
        { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
      ])],
    };
  }).catch((cleanupError) => {
    console.warn({ event: 'admin_irl_redeem_finalize_cleanup_failed', error: summarizeError(cleanupError) });
  });
}

function cleanupContext(context: CommerceContext): CommerceContext {
  return { ...context, nowMs: Date.now(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) };
}

function resolveInstructionAccounts(transaction: Awaited<ReturnType<Connection['getTransaction']>>): PublicKey[] {
  const message = transaction?.transaction.message;
  if (!message) return [];
  const keys = message.getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses });
  return [
    ...keys.staticAccountKeys,
    ...(keys.accountKeysFromLookups?.writable || []),
    ...(keys.accountKeysFromLookups?.readonly || []),
  ];
}

function instructionAccounts(instruction: { accountKeyIndexes: Uint8Array | number[] }, keys: PublicKey[]): PublicKey[] {
  return Array.from(instruction.accountKeyIndexes).map((index) => keys[index]).filter((key): key is PublicKey => Boolean(key));
}

function instructionData(instruction: { data: Uint8Array | string }): Buffer {
  return typeof instruction.data === 'string'
    ? Buffer.from(bs58.decode(instruction.data))
    : Buffer.from(instruction.data);
}

function bubblegumLeafAssetIds(transaction: Awaited<ReturnType<Connection['getTransaction']>>): string[] {
  if (!transaction) return [];
  const keys = resolveInstructionAccounts(transaction);
  const ids = new Set<string>();
  for (const group of transaction.meta?.innerInstructions || []) {
    for (const instruction of group.instructions) {
      const program = keys[instruction.programIdIndex];
      if (!program?.equals(MPL_NOOP_PROGRAM_ID)) continue;
      const data = instructionData(instruction);
      if (
        data.length < 41 || data[0] !== 1 || data[1] !== 0 ||
        data.readUInt32LE(2) !== data.length - 6 || data[6] !== 1 || data[7] !== 1 || data[8] !== 1
      ) continue;
      ids.add(new PublicKey(data.subarray(9, 41)).toBase58());
    }
  }
  return Array.from(ids);
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
  const keys = resolveInstructionAccounts(transaction);
  const transferred: string[] = [];
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    if (!keys[instruction.programIdIndex]?.equals(MPL_CORE_PROGRAM_ID)) continue;
    const data = instructionData(instruction);
    if (data[0] !== 14 || data[1] !== 0) continue;
    const accounts = instructionAccounts(instruction, keys);
    if (
      accounts.length >= 7 && accounts[1]?.equals(collection) &&
      accounts[2]?.toBase58() === owner && accounts[3]?.toBase58() === owner &&
      accounts[4]?.toBase58() === admin
    ) transferred.push(accounts[0].toBase58());
  }
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
  const keys = resolveInstructionAccounts(transaction);
  let matches = 0;
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    if (!keys[instruction.programIdIndex]?.equals(BUBBLEGUM_PROGRAM_ID)) continue;
    const data = instructionData(instruction);
    if (!data.subarray(0, IX_BUBBLEGUM_TRANSFER_V2.length).equals(IX_BUBBLEGUM_TRANSFER_V2)) continue;
    const accounts = instructionAccounts(instruction, keys);
    const [, payer, authority, leafOwner, , newOwner, merkleTree, receiptCollection] = accounts;
    if (
      accounts.length >= 8 && payer?.toBase58() === owner && authority?.toBase58() === owner &&
      leafOwner?.toBase58() === owner && newOwner?.toBase58() === admin &&
      merkleTree?.equals(runtime.receiptsMerkleTree) && receiptCollection?.equals(collection)
    ) matches += 1;
  }
  const ids = bubblegumLeafAssetIds(transaction);
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
    `https://${runtime.cluster === 'mainnet-beta' ? 'mainnet' : runtime.cluster}.helius-rpc.com/?api-key=${encodeURIComponent(provider.apiKey)}`,
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
  fields: Record<string, unknown>,
  deleted: string[] = [],
): Promise<void> {
  await deliveryReceiptRuntime.commitWrites(commerce, [deleteFieldsWrite(path, fields, deleted, [
    { fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() },
  ])]);
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
      const document = await deliveryReceiptRuntime.readDocument(context, path, transaction);
      if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const existing = normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
      if (existing && !samePendingFinalizeSubmission(existing, pending)) {
        throw new PendingFinalizeSubmissionError();
      }
      return {
        result: undefined,
        writes: existing ? [] : [deleteFieldsWrite(document.path, {
          pendingFinalizeSubmission: pending,
          processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
        }, [], [{ fieldPath: 'updatedAt', value: commerceFieldValue.serverTimestamp() }])],
      };
    });
  } catch (error) {
    if (error instanceof CommerceWriteConflict) throw error;
    try {
      const cleanup = cleanupContext(context);
      const document = await deliveryReceiptRuntime.readDocument(cleanup, path);
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
      const document = await deliveryReceiptRuntime.readDocument(context, path, transaction);
      if (!document || document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const stored = normalizePendingFinalizeSubmission(document.fields.pendingFinalizeSubmission);
      if (!stored) {
        if (pendingFinalizeSubmissionAlreadySettled(document.fields, pending, outcome)) {
          return { result: undefined };
        }
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem submission recovery changed.');
      }
      if (!samePendingFinalizeSubmission(stored, pending)) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem submission recovery changed.');
      }
      const fields: Record<string, unknown> = {};
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
      const document = await deliveryReceiptRuntime.readDocument(cleanup, path);
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
    const document = await deliveryReceiptRuntime.readDocument(context, path, transaction);
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
    await updateRequest(commerce, path, { internalDeliveryId: deliveryId, internalDeliveryPda: pda.toBase58() });
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
  request: StartedRequest,
  internal: InternalDelivery,
): Promise<string | null> {
  if (request.closeDeliveryTx) return request.closeDeliveryTx;
  const [pda, bump] = deriveDeliveryPda(runtime, internal.deliveryId);
  if (!await connection.getAccountInfo(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })) return null;
  try {
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
    await updateRequest(commerce, path, { closeDeliveryTx: signature });
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
    const transactions = await connection.getTransactions(normalizeReceiptTxs(receiptTxs), { maxSupportedTransactionVersion: 0 });
    const ids = transactions.flatMap(bubblegumLeafAssetIds);
    if (ids.length === items.length) {
      const assets = await mapWithConcurrency(ids, 4, (id) => fetchAdminIrlRedeemAsset(provider, runtime, id));
      assets.forEach(add);
      if (items.every((item) => (direct.get(item.refId) || []).length === 1)) return direct;
    }
  } catch (error) {
    rethrowFinalizeCancellation(provider.signal, error);
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
    if (!isRecord(value)) continue;
    const boxId = Math.floor(Number(value.boxId));
    const dudeIds = Array.isArray(value.dudeIds)
      ? value.dudeIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    if (Number.isSafeInteger(boxId) && boxId > 0) result.set(boxId, dudeIds);
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
  transaction: CommerceTransaction,
  dropId: string,
  selectionKey: string,
  boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>,
): Promise<AdminIrlRedeemMarkerReuseResolution> {
  const markers = await Promise.all(markerPaths(dropId, boxes).map((path) =>
    deliveryReceiptRuntime.readDocument(commerce, path, transaction)));
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
    'processingAttemptId', 'processingStartedAt', 'processingLeaseExpiresAt', 'preparedExpiresAt', 'pendingFinalizeSubmission',
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
): Promise<AdminIrlRedeemFinalizeResponse | null> {
  const selectionKey = buildAdminIrlRedeemSelectionKey({ dropId: body.dropId, originalAssetIds: request.itemIds });
  const result = await runTransaction<
    { status: 'none' } |
    { status: 'complete'; request: Record<string, unknown> }
  >(commerce, async (transaction) => {
    const document = await deliveryReceiptRuntime.readDocument(commerce, requestPath(body), transaction);
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    if (document.fields.status === 'complete') return { result: { status: 'complete' as const, request: document.fields } };
    if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const resolution = await markerResolution(
      commerce,
      transaction,
      body.dropId,
      selectionKey,
      request.items.map((item) => ({ originalAssetId: item.assetId })),
    );
    if (resolution.status === 'none') return { result: { status: 'none' as const } };
    if (resolution.status === 'conflict') throw markerConflict(resolution.reason);
    const order = await deliveryReceiptRuntime.readDocument(
      commerce,
      dropDeliveryOrderPath(body.dropId, resolution.deliveryId),
      transaction,
    );
    if (!order) throw markerConflict('marker delivery order missing');
    const completed = completedMarkerReuse(document.fields, order.fields, resolution);
    return {
      result: { status: 'complete' as const, request: completed },
      writes: [completeRequestWrite(document.path, completed)],
    };
  });
  return result.status === 'none' ? null : completeResponse(body.dropId, body.requestId, result.request);
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
  return deliveryReceiptRuntime.createWrite({
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
      const document = await deliveryReceiptRuntime.readDocument(commerce, requestPath(body), transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      if (document.fields.status === 'complete') return { result: { status: 'complete' as const, request: document.fields } };
      if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const resolution = await markerResolution(commerce, transaction, runtime.dropId, selectionKey, boxesWithCodes);
      if (resolution.status === 'conflict') throw markerConflict(resolution.reason);
      if (resolution.status === 'reuse') {
        const existingOrder = await deliveryReceiptRuntime.readDocument(
          commerce,
          dropDeliveryOrderPath(runtime.dropId, resolution.deliveryId),
          transaction,
        );
        if (!existingOrder) throw markerConflict('marker delivery order missing');
        const completed = completedMarkerReuse(document.fields, existingOrder.fields, resolution);
        return {
          result: { status: 'complete' as const, request: completed },
          writes: [completeRequestWrite(document.path, completed)],
        };
      }
      if (await deliveryReceiptRuntime.readDocument(commerce, orderPath, transaction)) {
        return { result: { status: 'collision' as const } };
      }
      const claims = await Promise.all(claimPaths.map((path) => deliveryReceiptRuntime.readDocument(commerce, path, transaction)));
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
      const document = await deliveryReceiptRuntime.readDocument(commerce, requestPath(body), transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      if (document.fields.status === 'complete') return { result: { status: 'complete' as const, request: document.fields } };
      if (document.fields.status !== 'processing' || document.fields.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const existingMarker = await deliveryReceiptRuntime.readDocument(commerce, markerPath, transaction);
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
          deliveryReceiptRuntime.readDocument(commerce, dropDeliveryOrderPath(runtime.dropId, existingDeliveryId), transaction),
          deliveryReceiptRuntime.readDocument(commerce, `claimCodes/${existingClaimCode}`, transaction),
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
        deliveryReceiptRuntime.readDocument(commerce, orderPath, transaction),
        deliveryReceiptRuntime.readDocument(commerce, claimPath, transaction),
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

function scheduleAdminPackStatusProjection(args: {
  commerce: CommerceContext;
  response: AdminIrlRedeemFinalizeResponse;
  runtime: Runtime;
  waitUntil: DeferredWork;
}): void {
  if (!Number.isSafeInteger(args.response.deliveryId) || Number(args.response.deliveryId) < 1) return;
  scheduleDeliveryPackStatusProjection({
    context: args.commerce,
    deliveryId: Number(args.response.deliveryId),
    dropId: args.runtime.dropId,
    waitUntil: args.waitUntil,
  });
}

async function finalizeAdminIrlRedeem(
  body: FinalizeRequest,
  identity: RequestIdentity,
  env: FinalizeEnv,
  commerce: CommerceContext,
  provider: ProviderContext,
  waitUntil: DeferredWork,
): Promise<{ response: AdminIrlRedeemFinalizeResponse; targetKind: AdminIrlRedeemTargetKind; outcome: string }> {
  const config = API_DROPS[body.dropId];
  if (!config) throw new AdminIrlRedeemFinalizeError('invalid-argument', `Unsupported dropId: ${body.dropId}`);
  const runtime = buildAdminIrlRedeemRuntime(config);
  runtimeSupportsFinalize(runtime);
  let wallet: string;
  try {
    wallet = canonicalWallet(await resolveRequestWallet(
      identity,
      (uid) => loadAdminIrlRedeemBoundWallet(commerce, env.OPS_DB, uid),
    ));
  } catch (error) {
    if (isRecord(error) && error.code === 'unavailable') {
      throw new AdminIrlRedeemFinalizeError(
        'unavailable',
        'Admin IRL redeem finalization is temporarily unavailable.',
      );
    }
    throw error;
  }
  const attemptId = `admin_irl:${crypto.randomUUID()}`;
  const started = await startFinalize(commerce, body, wallet, attemptId, commerce.nowMs);
  if (started.status === 'complete') {
    const targetKind = started.request.targetKind === 'card_receipt' ? 'card_receipt' : 'pack';
    const response = completeResponse(body.dropId, body.requestId, started.request);
    if (targetKind === 'pack') {
      scheduleAdminPackStatusProjection({ commerce, response, runtime, waitUntil });
    }
    return { response, targetKind, outcome: 'already_complete' };
  }
  try {
    const connection = createConnection(provider, runtime);
    await reconcileStartedRequestSubmission({
      commerce,
      provider,
      runtime,
      path: requestPath(body),
      attemptId,
      request: started.request,
    });
    const onchain = await fetchDeliveryOnchainConfig(connection, runtime);
    const signer = decodeCosigner(env.COSIGNER_SECRET);
    if (!signer.publicKey.equals(onchain.admin)) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin.');
    }
    if (started.request.targetKind === 'card_receipt') {
      const card = started.request.items[0];
      if (!card || card.kind !== 'card_receipt') {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
      }
      await verifyCardTransfer(connection, runtime, body.transferSignature, started.request.owner, signer.publicKey.toBase58(), onchain.coreCollection, card.assetId);
      await waitForCardReceipt(provider, runtime, card.assetId, card.refId, signer.publicKey.toBase58());
      return {
        response: await publishCard(commerce, runtime, body, attemptId, started.request, signer.publicKey.toBase58(), {
          figureId: card.refId,
          receiptAssetId: card.assetId,
        }),
        targetKind: 'card_receipt',
        outcome: 'completed',
      };
    }
    await verifyPackTransfer(connection, body.transferSignature, started.request.owner, signer.publicKey.toBase58(), onchain.coreCollection, started.request.itemIds);
    const existing = await completeFromExistingMarkers(commerce, body, attemptId, started.request);
    if (existing) {
      scheduleAdminPackStatusProjection({ commerce, response: existing, runtime, waitUntil });
      return { response: existing, targetKind: 'pack', outcome: 'marker_reuse' };
    }
    const internal = await ensureInternalDelivery(
      connection,
      provider,
      runtime,
      signer,
      onchain,
      commerce,
      requestPath(body),
      attemptId,
      started.request,
    );
    const receiptTxs = await mintPackReceipts(
      connection,
      provider,
      runtime,
      signer,
      onchain.coreCollection,
      started.request.items,
      commerce,
      requestPath(body),
      attemptId,
      started.request.receiptTxs,
    );
    const assets = await findReceiptAssets(connection, provider, runtime, signer.publicKey.toBase58(), started.request.items, receiptTxs);
    const boxes: AdminIrlRedeemBoxBaseInput[] = [];
    for (const item of started.request.items) {
      const matches = assets.get(item.refId) || [];
      if (matches.length !== 1 || typeof matches[0].id !== 'string') {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem pack receipt is not uniquely indexed yet.', {
          dropId: runtime.dropId,
          boxId: item.refId,
          expected: 1,
          got: matches.length,
        });
      }
      const dudeIds = await deliveryReceiptRuntime.assignDudesForBox(
        commerce,
        runtime,
        matches[0].id,
        deliveryReceiptRuntime.secureRandomInt,
      );
      boxes.push({ boxId: item.refId, originalAssetId: item.assetId, receiptAssetId: matches[0].id, dudeIds });
    }
    const closeDeliveryTx = await closeInternalDelivery(connection, runtime, signer, commerce, requestPath(body), started.request, internal);
    const response = await publishPack(
      commerce,
      runtime,
      body,
      attemptId,
      started.request,
      signer.publicKey.toBase58(),
      internal,
      closeDeliveryTx,
      receiptTxs,
      boxes,
    );
    scheduleAdminPackStatusProjection({ commerce, response, runtime, waitUntil });
    return {
      response,
      targetKind: 'pack',
      outcome: 'completed',
    };
  } catch (error) {
    rethrowDeferredWorkRegistrationError(error);
    if (!(error instanceof PendingFinalizeSubmissionError)) {
      await clearProcessing(commerce, body, attemptId, error);
    }
    throw error;
  }
}

const defaultDependencies: FinalizeDependencies = {
  finalize: finalizeAdminIrlRedeem,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

export async function handleAdminIrlRedeemFinalize(
  request: Request,
  env: FinalizeEnv,
  defer: DeferredWork,
  overrides: Partial<FinalizeDependencies> = {},
): Promise<AdminIrlRedeemFinalizeResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try { return await dependencies.providerFetch(input, init); }
    finally { metrics.providerDurationMs += Math.max(0, performance.now() - startedAt); }
  };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new AdminIrlRedeemFinalizeError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response: new Response(response.body, { status: 405, headers: response.headers }), metrics, authOutcome: 'rejected' };
  }
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs,
    timeoutMessage: 'Admin IRL redeem finalization timed out',
  });
  let identity: RequestIdentity | undefined;
  let body: FinalizeRequest | undefined;
  try {
    body = await readRequestBody(request, deadline.signal);
    identity = await dependencies.verifyIdentity(request, env.OPS_DB, deadline.signal, dependencies.nowMs());
    if (!isStaffRequestIdentity(identity)) {
      throw new AdminIrlRedeemFinalizeError('unauthenticated', 'Staff wallet authentication is required.');
    }
    const apiKey = String(env.HELIUS_API_KEY || '').trim();
    const cosignerSecret = String(env.COSIGNER_SECRET || '').trim();
    if (!apiKey || !cosignerSecret) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
    }
    const nowMs = dependencies.nowMs();
    const result = await runCriticalRequestOperation(
      () => dependencies.finalize(
        body!,
        identity!,
        { ...env, COSIGNER_SECRET: cosignerSecret, HELIUS_API_KEY: apiKey },
        {
          commerceDb: env.COMMERCE_DB,
          repository: new D1CommerceRepository(env.COMMERCE_DB),
          nowMs,
          providerFetch: trackedFetch,
          signal: deadline.signal,
          dataDb: env.DATA_DB,
        },
        { apiKey, providerFetch: trackedFetch, signal: deadline.signal },
        defer,
      ),
      { deadline, defer, ignoreDeferredErrors: true },
    );
    return {
      response: jsonResponse(result.response),
      metrics,
      authOutcome: 'accepted',
      dropId: result.response.dropId,
      targetKind: result.targetKind,
      deliveryId: result.response.deliveryId,
      outcome: result.outcome,
    };
  } catch (error) {
    rethrowDeferredWorkRegistrationError(error);
    let normalized: AdminIrlRedeemFinalizeError;
    if (isRequestCancellationError(request, error)) {
      throw error;
    }
    if (deadline.timedOut()) {
      normalized = new AdminIrlRedeemFinalizeError('deadline-exceeded', 'Admin IRL redeem finalization timed out.');
    } else if (error instanceof RequestIdentityError) {
      normalized = new AdminIrlRedeemFinalizeError(
        error.kind === 'invalid-token' ? 'unauthenticated' : error.kind === 'provider-timeout' ? 'deadline-exceeded' : 'unavailable',
        error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.',
      );
    } else {
      normalized = normalizedError(error, 'Admin IRL redeem finalization failed.');
      if (normalized.code === 'internal') {
        console.error({ event: 'admin_irl_redeem_finalize_unhandled_error', error: summarizeError(error) });
      }
    }
    const rejected = ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(normalized.code);
    return {
      response: errorResponse(normalized),
      metrics,
      authOutcome: identity ? (rejected ? 'rejected' : 'provider-failure') : normalized.code === 'unauthenticated' ? 'rejected' : 'provider-failure',
      ...(body?.dropId ? { dropId: body.dropId } : {}),
      outcome: normalized.code,
    };
  } finally {
    deadline.dispose();
  }
}

export const adminIrlRedeemFinalizeTestHooks = {
  clearDefinitiveFinalizeSubmission,
  clearProcessing,
  completeResponse,
  finalizeAdminIrlRedeem,
  findReceiptAssets,
  normalizeItems,
  normalizePendingFinalizeSubmission,
  isDefinitiveTransactionFailure,
  mintPackReceipts,
  persistPendingFinalizeSubmission,
  pendingFinalizeSubmissionAlreadySettled,
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
