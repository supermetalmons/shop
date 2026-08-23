import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  bubblegumBurnV2Ix,
  bubblegumTransferV2Ix,
  IX_BUBBLEGUM_TRANSFER_V2,
} from './bubblegum.js';
import {
  activeDirectCardReceiptClaimSignatures,
  classifyDirectCardReceiptClaimSubmission,
  classifyDirectCardReceiptClaimTransferVerificationError,
  directCardReceiptClaimHasRecipientLock,
  directCardReceiptClaimSubmissionProvesNoDelivery,
  resolveDirectCardReceiptClaimRecoveryAction,
  shouldKeepDirectCardReceiptClaimProcessing,
  type DirectCardReceiptClaimSubmission,
  type DirectCardReceiptClaimTransferEvidence,
} from './adminIrlCardReceipt.js';
import { getApiDrop } from './dropConfig.js';
import { dropDeliveryOrderPath } from './dropPaths.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  receiptMetadataReference,
} from './receiptProof.js';
import { dasAssetLooksBurntOrClosed, type DasAsset } from '../../../../shared/dasAsset.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { isReceiptClaimDeliveryOrderSource } from '../../../../shared/fulfillmentSources.js';
import {
  heliusSearchAssetsHasNextPage,
  heliusSearchAssetsItems,
} from '../../../../shared/heliusDas.js';
import {
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
} from '../../../../shared/boxMinterProtocol.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  hasPluralStripeReceiptClaims,
  normalizeStripeReceiptClaimCode,
  orderStripeReceiptClaimByBoxId,
  requireStripeReceiptClaimCode,
  stripeAssignedIrlClaimForBox,
  stripeReceiptClaimBoxMapKey,
  stripeReceiptClaimCodeMaybe,
  type StripeAssignedIrlClaim,
} from '../../../../shared/stripeReceiptClaims.js';
import type {
  StripeReceiptClaimRequest,
  StripeReceiptClaimResult,
} from '../../../../shared/contracts.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
import {
  FirestoreWriteConflict,
  ProfileReadError,
  createGoogleAccessTokenProvider,
  isRecord,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';
import { adminIrlRedeemRuntime } from './adminIrlRedeemPrepare.js';
import { deliveryReceiptRuntime } from './deliveryReceipts.js';

export const STRIPE_RECEIPT_CLAIM_PATH = '/receipts/stripe/claim';

const REQUEST_MAX_BYTES = 1024;
const HANDLER_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PROCESSING_LEASE_MS = 90_000;
const DIRECT_SUBMISSION_RESOLUTION_MAX_WAIT_MS = 90_000;
const DIRECT_SUBMISSION_RESOLUTION_POLL_MS = 2_000;
const DIRECT_SUBMISSION_PROCESSING_LEASE_MS = 4 * 60_000;
const FIRESTORE_TRANSACTION_ATTEMPTS = 6;
const HELIUS_ASSETS_PAGE_LIMIT = 1000;
const HELIUS_ASSETS_MAX_SEARCH_PAGES = 64;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const BURN_POLICY = { missingAssetResult: true, nonBooleanFlagIsBurnt: false } as const;
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

const requestSchema = z.object({
  code: z.string().min(1).max(64),
  recipient: z.string().min(32).max(64),
}).strict();

type ClaimEnv = Pick<Env, 'COSIGNER_SECRET' | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' | 'HELIUS_API_KEY'>;
type FirestoreContext = Parameters<typeof deliveryReceiptRuntime.readDocument>[0];
type Runtime = ReturnType<typeof adminIrlRedeemRuntime.buildRuntime>;
type ProviderContext = {
  apiKey: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
};
type ClaimErrorCode =
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
type ReceiptKind = 'box' | 'figure';
type StoredResult = {
  receiptKind?: ReceiptKind;
  receiptsTransferred?: number;
  figureIds?: number[];
  receiptAssetIds?: string[];
};
type StartedClaim = {
  status: 'started';
  dropId: string;
  deliveryId: number;
  boxId: number;
  attemptId: string;
  orderPath: string;
  orderIrlClaims: unknown[];
  resumingPreviousProcessingClaim: boolean;
  hasPreviousClaimFailure: boolean;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
  directFigureReceipt?: { receiptAssetId: string; figureId: number };
  receiptTxs: string[];
  receiptTxSubmissions: DirectCardReceiptClaimSubmission[];
};
type ClaimStart = StartedClaim | ({ status: 'already_claimed'; dropId: string; deliveryId: number; boxId: number; receiptTxs: string[] } & StoredResult);
type ClaimMetrics = { upstreamCalls: number; providerDurationMs: number };
type ClaimLogContext = { dropId: string; deliveryId: number };
type ClaimFlow = 'direct_figure' | 'openable_pack' | 'legacy_pack';

export type StripeReceiptClaimRequestResult = {
  response: Response;
  metrics: ClaimMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  deliveryId?: number;
  outcome: string;
};

export class StripeReceiptClaimError extends Error {
  constructor(
    readonly code: ClaimErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StripeReceiptClaimError';
  }
}

type ClaimDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  claim: typeof claimStripeReceipt;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdToken: typeof verifyFirebaseIdToken;
};

function statusForCode(code: ClaimErrorCode): number {
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

function errorResponse(error: StripeReceiptClaimError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, statusForCode(error.code));
}

function normalizedError(error: unknown, fallback: string): StripeReceiptClaimError {
  if (error instanceof StripeReceiptClaimError) return error;
  if (error instanceof deliveryReceiptRuntime.DeliveryReceiptError) {
    return new StripeReceiptClaimError(error.code, error.message, error.details);
  }
  if (error instanceof ProfileReadError) {
    return new StripeReceiptClaimError(error.code, error.message, error.details);
  }
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code as ClaimErrorCode;
    if ([
      'invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
      'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal',
    ].includes(code)) {
      return new StripeReceiptClaimError(
        code,
        typeof error.message === 'string' ? error.message : fallback,
        error.details,
      );
    }
  }
  return new StripeReceiptClaimError('internal', fallback);
}

function summarizeError(error: unknown): Record<string, unknown> {
  const normalized = normalizedError(error, 'Receipt claim failed.');
  return { kind: normalized.name, code: normalized.code, message: normalized.message };
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<StripeReceiptClaimRequest> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new StripeReceiptClaimError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new StripeReceiptClaimError('invalid-argument', 'Receipt claim request is too large.');
  }
  if (!request.body) throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim request.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_MAX_BYTES) {
        throw new StripeReceiptClaimError('invalid-argument', 'Receipt claim request is too large.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const parsed = requestSchema.safeParse(JSON.parse(chunks.join('')) as unknown);
    if (!parsed.success) throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim request.');
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof StripeReceiptClaimError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function canonicalRecipient(value: string): { wallet: string; key: PublicKey } {
  try {
    const key = new PublicKey(value);
    const wallet = key.toBase58();
    if (wallet !== value) throw new Error('non-canonical');
    return { wallet, key };
  } catch {
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid recipient wallet.');
  }
}

function normalizedCode(value: string): string {
  try {
    return requireStripeReceiptClaimCode(value);
  } catch {
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim code.');
  }
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 0xffff_ffff) {
    throw new StripeReceiptClaimError('failed-precondition', `Claim code is missing a valid ${label}.`);
  }
  return normalized;
}

function normalizeReceiptTxs(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())))
    : [];
}

function directReceiptAssetId(value: Record<string, unknown>): string {
  return value.receiptKind === 'figure' && typeof value.receiptAssetId === 'string'
    ? value.receiptAssetId.trim()
    : '';
}

function normalizeSubmissions(value: unknown): DirectCardReceiptClaimSubmission[] {
  if (!Array.isArray(value)) return [];
  const bySignature = new Map<string, DirectCardReceiptClaimSubmission>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const signature = typeof entry.signature === 'string' ? entry.signature.trim() : '';
    const lastValidBlockHeight = Math.floor(Number(entry.lastValidBlockHeight));
    const submittedAtMs = Number(entry.submittedAtMs);
    const status = entry.status === 'not_landed' ? 'not_landed' : 'submitted';
    if (!signature || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1 || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0) continue;
    bySignature.set(signature, { signature, lastValidBlockHeight, submittedAtMs, status });
  }
  return [...bySignature.values()];
}

function normalizePositiveIntegerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((entry) => Number.isSafeInteger(entry) && entry > 0 && entry <= 0xffff_ffff)
    : [];
}

function normalizeStoredResult(value: Record<string, unknown>): StoredResult {
  const receiptKind = value.receiptKind === 'box' || value.receiptKind === 'figure' ? value.receiptKind : undefined;
  const receiptsTransferred = positiveStoredInteger(value.receiptsTransferred);
  const figureIds = normalizePositiveIntegerArray(value.figureIds);
  const receiptAssetId = receiptKind === 'figure' && typeof value.receiptAssetId === 'string' ? value.receiptAssetId.trim() : '';
  return {
    ...(receiptKind ? { receiptKind } : {}),
    ...(receiptsTransferred ? { receiptsTransferred } : {}),
    ...(figureIds.length ? { figureIds } : {}),
    ...(receiptAssetId ? { receiptAssetIds: [receiptAssetId] } : {}),
  };
}

function positiveStoredInteger(value: unknown): number | undefined {
  const normalized = Math.floor(Number(value));
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function responseForClaim(args: {
  dropId: string;
  deliveryId: number;
  receiptTxs: string[];
  receiptKind?: ReceiptKind;
  receiptsTransferred?: number;
  figureIds?: number[];
  receiptAssetIds?: string[];
}): StripeReceiptClaimResult {
  const figureIds = args.figureIds?.length ? args.figureIds : undefined;
  const receiptAssetIds = Array.from(new Set((args.receiptAssetIds || []).map((value) => value.trim()).filter(Boolean)));
  const receiptsTransferred = args.receiptsTransferred && args.receiptsTransferred > 0
    ? args.receiptsTransferred
    : args.receiptKind === 'figure' && figureIds ? figureIds.length : 1;
  return {
    processed: true,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    receiptsTransferred,
    receiptTxs: args.receiptTxs,
    ...(args.receiptKind ? { receiptKind: args.receiptKind } : {}),
    ...(figureIds ? { figureIds } : {}),
    ...(receiptAssetIds.length ? { receiptAssetIds } : {}),
  };
}

function orderTarget(order: Record<string, unknown>, code: string, boxId: number): {
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
} {
  const pluralClaim = orderStripeReceiptClaimByBoxId(order, boxId);
  if (pluralClaim) {
    const pluralCode = stripeReceiptClaimCodeMaybe(pluralClaim);
    if (pluralCode && pluralCode !== code) {
      throw new StripeReceiptClaimError('failed-precondition', 'Receipt order claim code mismatch.');
    }
    const singularClaim = isRecord(order.stripeReceiptClaim) ? order.stripeReceiptClaim : {};
    const singularCode = stripeReceiptClaimCodeMaybe(singularClaim);
    const singularBoxId = Math.floor(Number(singularClaim.boxId));
    return {
      updatePluralOrderClaim: true,
      updateSingularOrderClaim: singularCode === code || (!singularCode && Number.isSafeInteger(singularBoxId) && singularBoxId === boxId),
    };
  }
  if (hasPluralStripeReceiptClaims(order)) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt order claim code mismatch.');
  }
  const singularClaim = isRecord(order.stripeReceiptClaim) ? order.stripeReceiptClaim : {};
  const singularCode = stripeReceiptClaimCodeMaybe(singularClaim);
  if (singularCode && singularCode !== code) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt order claim code mismatch.');
  }
  const items = Array.isArray(order.items) ? order.items : [];
  const firstItem = isRecord(items[0]) ? items[0] : {};
  const orderBoxId = Math.floor(Number(singularClaim.boxId ?? firstItem.refId));
  if (Number.isSafeInteger(orderBoxId) && orderBoxId > 0 && orderBoxId !== boxId) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt order box id mismatch.');
  }
  return { updatePluralOrderClaim: false, updateSingularOrderClaim: true };
}

function orderClaimFields(args: {
  code: string;
  boxId: number;
  status: 'processing' | 'unclaimed' | 'claimed';
  fields: Record<string, unknown>;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const claim = {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: args.code,
    boxId: args.boxId,
    status: args.status,
    ...args.fields,
  };
  const assign = (prefix: string) => {
    for (const [key, value] of Object.entries(claim)) fields[`${prefix}.${key}`] = value;
  };
  if (args.updatePluralOrderClaim) assign(`stripeReceiptClaimsByBoxId.${stripeReceiptClaimBoxMapKey(args.boxId)}`);
  if (args.updateSingularOrderClaim) assign('stripeReceiptClaim');
  return fields;
}

function timestamp(value: number): Record<string, unknown> {
  return { timestampValue: new Date(value).toISOString() };
}

async function runTransaction<T>(
  context: FirestoreContext,
  operation: (transaction: string) => Promise<{ result: T; writes?: Record<string, unknown>[] }>,
): Promise<T> {
  for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: string | undefined;
    try {
      transaction = await deliveryReceiptRuntime.beginTransaction(context);
      const { result, writes } = await operation(transaction);
      if (writes?.length) await deliveryReceiptRuntime.commitWrites(context, writes, transaction);
      else await deliveryReceiptRuntime.rollbackTransactionBestEffort(context, transaction);
      transaction = undefined;
      return result;
    } catch (error) {
      if (transaction) await deliveryReceiptRuntime.rollbackTransactionBestEffort(context, transaction);
      if (error instanceof FirestoreWriteConflict && attempt + 1 < FIRESTORE_TRANSACTION_ATTEMPTS) {
        await deliveryReceiptRuntime.pause(Math.min(400, 25 * 2 ** attempt), context.signal);
        continue;
      }
      throw error;
    }
  }
  throw new StripeReceiptClaimError('unavailable', 'Receipt claim data is temporarily unavailable.');
}

function updateWrite(args: {
  path: string;
  fields: Record<string, unknown>;
  deleted?: string[];
  transforms?: Record<string, unknown>[];
}): Record<string, unknown> {
  return deliveryReceiptRuntime.updateWrite({
    path: args.path,
    fields: args.fields,
    updateMask: [...Object.keys(args.fields), ...(args.deleted || [])],
    transforms: args.transforms,
    currentDocument: { exists: true },
  });
}

async function startClaim(
  context: FirestoreContext,
  code: string,
  recipientWallet: string,
  attemptId: string,
  nowMs: number,
): Promise<ClaimStart> {
  const claimPath = `claimCodes/${code}`;
  return runTransaction<ClaimStart>(context, async (transaction) => {
    const claimDocument = await deliveryReceiptRuntime.readDocument(context, claimPath, transaction);
    if (!claimDocument) throw new StripeReceiptClaimError('not-found', 'Invalid receipt claim code.');
    const claim = claimDocument.fields;
    if (claim.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE) {
      throw new StripeReceiptClaimError('not-found', 'Invalid receipt claim code.');
    }
    if (typeof claim.code === 'string' && normalizeStripeReceiptClaimCode(claim.code) !== code) {
      throw new StripeReceiptClaimError('failed-precondition', 'Claim code record is inconsistent.');
    }
    const rawDropId = typeof claim.dropId === 'string' ? claim.dropId : '';
    const dropId = normalizeDropId(rawDropId);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId) || !getApiDrop(dropId)) {
      throw new StripeReceiptClaimError('failed-precondition', 'Claim code has an invalid drop id.');
    }
    const deliveryId = positiveInteger(claim.deliveryId, 'delivery id');
    const boxId = positiveInteger(claim.boxId, 'box id');
    const directAssetId = directReceiptAssetId(claim);
    const directFigureId = Math.floor(Number(claim.figureId));
    const directFigureReceipt = directAssetId ? { receiptAssetId: directAssetId, figureId: directFigureId } : undefined;
    if (directFigureReceipt && (!Number.isSafeInteger(directFigureId) || directFigureId < 1 || directFigureId !== boxId)) {
      throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim target is invalid.');
    }
    const status = typeof claim.status === 'string' ? claim.status : 'unclaimed';
    const claimedRecipient = typeof claim.recipient === 'string' ? claim.recipient : '';
    const receiptTxSubmissions = normalizeSubmissions(claim.receiptTxSubmissions);
    const storedReceiptTxs = normalizeReceiptTxs(claim.receiptTxs);
    const receiptTxs = directFigureReceipt
      ? activeDirectCardReceiptClaimSignatures({ receiptTxs: storedReceiptTxs, submissions: receiptTxSubmissions })
      : storedReceiptTxs;
    const storedResult = normalizeStoredResult(claim);
    const directRecipientLock = Boolean(directFigureReceipt && directCardReceiptClaimHasRecipientLock({
      hasRecipient: Boolean(claimedRecipient),
      receiptTxCount: receiptTxs.length,
    }));
    const recipientLock = directFigureReceipt ? directRecipientLock : status === 'processing';
    if (status === 'claimed') {
      if (claimedRecipient === recipientWallet) {
        return { result: { status: 'already_claimed' as const, dropId, deliveryId, boxId, receiptTxs, ...storedResult } };
      }
      throw new StripeReceiptClaimError('failed-precondition', 'This receipt claim code has already been used.');
    }
    const leaseExpiresAt = Number(claim.processingLeaseExpiresAt || 0);
    if (status === 'processing' && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs) {
      throw new StripeReceiptClaimError('aborted', 'This receipt claim code is already being processed.');
    }
    if (recipientLock && claimedRecipient && claimedRecipient !== recipientWallet) {
      throw new StripeReceiptClaimError(
        'failed-precondition',
        'This receipt claim code is locked to the receiver address from the previous attempt. Retry with that same address.',
      );
    }
    const orderPath = dropDeliveryOrderPath(dropId, deliveryId);
    const orderDocument = await deliveryReceiptRuntime.readDocument(context, orderPath, transaction);
    if (!orderDocument) throw new StripeReceiptClaimError('not-found', 'Receipt claim order not found.');
    const order = orderDocument.fields;
    if (!isReceiptClaimDeliveryOrderSource(order.source)) {
      throw new StripeReceiptClaimError('failed-precondition', 'Claim code is not for a receipt claim order.');
    }
    if (directFigureReceipt) {
      const storedOrderClaim = isRecord(order.stripeReceiptClaim) ? order.stripeReceiptClaim : {};
      if (
        storedOrderClaim.receiptKind !== 'figure' ||
        storedOrderClaim.receiptAssetId !== directFigureReceipt.receiptAssetId ||
        Math.floor(Number(storedOrderClaim.figureId)) !== directFigureReceipt.figureId
      ) {
        throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt order target mismatch.');
      }
    }
    const target = orderTarget(order, code, boxId);
    const orderFields = {
      dropId,
      ...orderClaimFields({
        code,
        boxId,
        status: 'processing',
        fields: {
          recipient: recipientWallet,
          processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
        },
        ...target,
      }),
    };
    const processingPrefixes = [
      ...(target.updatePluralOrderClaim ? [`stripeReceiptClaimsByBoxId.${stripeReceiptClaimBoxMapKey(boxId)}`] : []),
      ...(target.updateSingularOrderClaim ? ['stripeReceiptClaim'] : []),
    ];
    const writes = [
      updateWrite({
        path: claimPath,
        fields: {
          status: 'processing',
          recipient: recipientWallet,
          processingAttemptId: attemptId,
          processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
        },
        transforms: [
          { fieldPath: 'processingStartedAt', setToServerValue: 'REQUEST_TIME' },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
      }),
      updateWrite({
        path: orderPath,
        fields: orderFields,
        transforms: processingPrefixes.map((prefix) => ({
          fieldPath: `${prefix}.processingStartedAt`,
          setToServerValue: 'REQUEST_TIME',
        })),
      }),
    ];
    return {
      result: {
        status: 'started' as const,
        dropId,
        deliveryId,
        boxId,
        attemptId,
        orderPath,
        orderIrlClaims: Array.isArray(order.irlClaims) ? order.irlClaims : [],
        receiptTxs,
        receiptTxSubmissions,
        resumingPreviousProcessingClaim: recipientLock && claimedRecipient === recipientWallet,
        hasPreviousClaimFailure: Boolean(claim.lastClaimError || claim.lastClaimErrorAt),
        ...(directFigureReceipt ? { directFigureReceipt } : {}),
        ...target,
      },
      writes,
    };
  });
}

function cleanupContext(context: FirestoreContext): FirestoreContext {
  return {
    ...context,
    nowMs: Date.now(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  };
}

function claimPrefixes(started: Pick<StartedClaim, 'boxId' | 'updatePluralOrderClaim' | 'updateSingularOrderClaim'>): string[] {
  return [
    ...(started.updatePluralOrderClaim
      ? [`stripeReceiptClaimsByBoxId.${stripeReceiptClaimBoxMapKey(started.boxId)}`]
      : []),
    ...(started.updateSingularOrderClaim ? ['stripeReceiptClaim'] : []),
  ];
}

async function clearProcessing(
  context: FirestoreContext,
  started: StartedClaim,
  code: string,
  error: unknown,
): Promise<void> {
  const safeContext = cleanupContext(context);
  try {
    await runTransaction(safeContext, async (transaction) => {
      const claimPath = `claimCodes/${code}`;
      const claim = await deliveryReceiptRuntime.readDocument(safeContext, claimPath, transaction);
      if (!claim || claim.fields.status !== 'processing' || claim.fields.processingAttemptId !== started.attemptId) {
        return { result: undefined };
      }
      const lastError = summarizeError(error);
      const prefixes = claimPrefixes(started);
      const orderFields = orderClaimFields({
        code,
        boxId: started.boxId,
        status: 'unclaimed',
        fields: { lastClaimError: lastError },
        updatePluralOrderClaim: started.updatePluralOrderClaim,
        updateSingularOrderClaim: started.updateSingularOrderClaim,
      });
      const orderDeleted = prefixes.flatMap((prefix) => [
        `${prefix}.recipient`,
        `${prefix}.processingStartedAt`,
        `${prefix}.processingLeaseExpiresAt`,
      ]);
      return {
        result: undefined,
        writes: [
          updateWrite({
            path: claimPath,
            fields: { status: 'unclaimed', lastClaimError: lastError },
            deleted: ['processingAttemptId', 'processingStartedAt', 'processingLeaseExpiresAt'],
            transforms: [
              { fieldPath: 'lastClaimErrorAt', setToServerValue: 'REQUEST_TIME' },
              { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
            ],
          }),
          updateWrite({ path: started.orderPath, fields: orderFields, deleted: orderDeleted }),
        ],
      };
    });
  } catch (cleanupError) {
    console.warn({
      event: 'stripe_receipt_claim_cleanup_failed',
      dropId: started.dropId,
      deliveryId: started.deliveryId,
      error: summarizeError(cleanupError),
    });
  }
}

async function rememberSubmittedTransaction(
  context: FirestoreContext,
  code: string,
  attemptId: string,
  receiptTx: string,
  submission?: Omit<DirectCardReceiptClaimSubmission, 'signature'> | null,
): Promise<void> {
  const safeContext = context.signal.aborted ? cleanupContext(context) : context;
  await runTransaction(safeContext, async (transaction) => {
    const path = `claimCodes/${code}`;
    const claim = await deliveryReceiptRuntime.readDocument(safeContext, path, transaction);
    if (!claim) throw new StripeReceiptClaimError('not-found', 'Receipt claim code not found.');
    if (claim.fields.status !== 'processing' || claim.fields.processingAttemptId !== attemptId) {
      throw new StripeReceiptClaimError('aborted', 'Receipt claim processing lease changed.');
    }
    const isDirect = Boolean(directReceiptAssetId(claim.fields));
    const normalizedSubmission = isDirect && submission
      ? normalizeSubmissions([{ signature: receiptTx, ...submission }])[0]
      : undefined;
    const submissions = isDirect ? normalizeSubmissions(claim.fields.receiptTxSubmissions) : [];
    if (normalizedSubmission) {
      const existing = submissions.findIndex((entry) => entry.signature === normalizedSubmission.signature);
      if (existing >= 0) submissions[existing] = normalizedSubmission;
      else submissions.push(normalizedSubmission);
    }
    const merged = Array.from(new Set([...normalizeReceiptTxs(claim.fields.receiptTxs), receiptTx]));
    const receiptTxs = isDirect && submissions.length
      ? activeDirectCardReceiptClaimSignatures({ receiptTxs: merged, submissions })
      : merged;
    return {
      result: undefined,
      writes: [updateWrite({
        path,
        fields: {
          receiptTxs,
          ...(normalizedSubmission ? { receiptTxSubmissions: submissions } : {}),
          ...(normalizedSubmission
            ? { processingLeaseExpiresAt: timestamp(Date.now() + DIRECT_SUBMISSION_PROCESSING_LEASE_MS) }
            : {}),
        },
        transforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      })],
    };
  });
}

async function finalizeClaim(
  context: FirestoreContext,
  started: StartedClaim,
  code: string,
  recipientWallet: string,
  receiptTx: string | null,
  receiptKind: ReceiptKind,
  receiptsTransferred: number,
  figureIds?: number[],
): Promise<string[]> {
  const safeContext = context.signal.aborted ? cleanupContext(context) : context;
  return runTransaction(safeContext, async (transaction) => {
    const claimPath = `claimCodes/${code}`;
    const claim = await deliveryReceiptRuntime.readDocument(safeContext, claimPath, transaction);
    if (!claim) throw new StripeReceiptClaimError('not-found', 'Receipt claim code not found.');
    const storedReceiptTxs = normalizeReceiptTxs(claim.fields.receiptTxs);
    const isDirect = Boolean(directReceiptAssetId(claim.fields));
    const submissions = isDirect ? normalizeSubmissions(claim.fields.receiptTxSubmissions) : [];
    const existingTxs = isDirect && submissions.length
      ? activeDirectCardReceiptClaimSignatures({ receiptTxs: storedReceiptTxs, submissions })
      : storedReceiptTxs;
    if (claim.fields.status === 'claimed') {
      if (claim.fields.recipient !== recipientWallet) {
        throw new StripeReceiptClaimError('failed-precondition', 'This receipt claim code has already been used.');
      }
      return { result: existingTxs };
    }
    if (claim.fields.processingAttemptId !== started.attemptId) {
      throw new StripeReceiptClaimError('aborted', 'Receipt claim processing lease changed.');
    }
    const receiptTxs = receiptTx ? Array.from(new Set([...existingTxs, receiptTx])) : existingTxs;
    const prefixes = claimPrefixes(started);
    const orderFields = {
      dropId: started.dropId,
      ...orderClaimFields({
        code,
        boxId: started.boxId,
        status: 'claimed',
        fields: {
          recipient: recipientWallet,
          receiptTxs,
          receiptKind,
          receiptsTransferred,
          ...(figureIds?.length ? { figureIds } : {}),
        },
        updatePluralOrderClaim: started.updatePluralOrderClaim,
        updateSingularOrderClaim: started.updateSingularOrderClaim,
      }),
    };
    const orderDeleted = prefixes.flatMap((prefix) => [
      `${prefix}.processingStartedAt`,
      `${prefix}.processingLeaseExpiresAt`,
      ...(figureIds?.length ? [] : [`${prefix}.figureIds`]),
    ]);
    return {
      result: receiptTxs,
      writes: [
        updateWrite({
          path: claimPath,
          fields: {
            status: 'claimed',
            recipient: recipientWallet,
            receiptTxs,
            receiptKind,
            receiptsTransferred,
            ...(figureIds?.length ? { figureIds } : {}),
          },
          deleted: [
            'processingAttemptId',
            'processingStartedAt',
            'processingLeaseExpiresAt',
            ...(figureIds?.length ? [] : ['figureIds']),
          ],
          transforms: [
            { fieldPath: 'claimedAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        }),
        updateWrite({
          path: started.orderPath,
          fields: orderFields,
          deleted: orderDeleted,
          transforms: prefixes.map((prefix) => ({
            fieldPath: `${prefix}.claimedAt`,
            setToServerValue: 'REQUEST_TIME',
          })),
        }),
      ],
    };
  });
}

function runtimeForDrop(dropId: string): Runtime {
  const config = getApiDrop(dropId);
  if (!config) throw new StripeReceiptClaimError('failed-precondition', 'Claim code has an unsupported drop id.');
  try {
    return adminIrlRedeemRuntime.buildRuntime(config);
  } catch (error) {
    throw normalizedError(error, 'Receipt claim drop configuration is invalid.');
  }
}

function createConnection(provider: ProviderContext, runtime: Runtime): Connection {
  return deliveryReceiptRuntime.createConnection({
    apiKey: provider.apiKey,
    fetch: provider.providerFetch,
    signal: provider.signal,
  }, runtime);
}

async function fetchAsset(provider: ProviderContext, runtime: Runtime, assetId: string): Promise<DasAsset> {
  try {
    return await adminIrlRedeemRuntime.fetchAsset(provider, runtime, assetId);
  } catch (error) {
    throw normalizedError(error, 'Receipt claim provider is temporarily unavailable.');
  }
}

async function fetchAssetProof(
  provider: ProviderContext,
  runtime: Runtime,
  assetId: string,
): Promise<Record<string, unknown>> {
  try {
    return await adminIrlRedeemRuntime.fetchAssetProof(provider, runtime, assetId);
  } catch (error) {
    throw normalizedError(error, 'Receipt claim provider is temporarily unavailable.');
  }
}

async function scanOwnedAssetPages(args: {
  provider: ProviderContext;
  runtime: Runtime;
  owner: string;
  grouping?: readonly [string, string];
  visitPage: (items: DasAsset[]) => boolean | Promise<boolean>;
}): Promise<{ sawItems: boolean; stopped: boolean }> {
  let sawItems = false;
  for (let page = 1; page <= HELIUS_ASSETS_MAX_SEARCH_PAGES; page += 1) {
    let result: unknown;
    try {
      result = await adminIrlRedeemRuntime.rpcCall(args.provider, args.runtime, 'searchAssets', {
        ownerAddress: args.owner,
        page,
        limit: HELIUS_ASSETS_PAGE_LIMIT,
        options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        ...(args.grouping ? { grouping: args.grouping } : {}),
      });
    } catch (error) {
      throw normalizedError(error, 'Receipt claim provider is temporarily unavailable.');
    }
    const items = heliusSearchAssetsItems(result).filter(isRecord) as DasAsset[];
    sawItems ||= items.length > 0;
    if (await args.visitPage(items)) return { sawItems, stopped: true };
    if (!heliusSearchAssetsHasNextPage(result, page, items, HELIUS_ASSETS_PAGE_LIMIT)) {
      return { sawItems, stopped: false };
    }
  }
  throw new StripeReceiptClaimError('unavailable', 'Too many assets to search for receipt; try again or contact support.', {
    dropId: args.runtime.dropId,
    maxPages: HELIUS_ASSETS_MAX_SEARCH_PAGES,
  });
}

async function findOwnedAsset(args: {
  provider: ProviderContext;
  runtime: Runtime;
  owner: string;
  grouping?: readonly [string, string];
  matches: (asset: DasAsset) => boolean | Promise<boolean>;
}): Promise<{ asset: DasAsset | null; sawItems: boolean }> {
  let asset: DasAsset | null = null;
  const scan = await scanOwnedAssetPages({
    provider: args.provider,
    runtime: args.runtime,
    owner: args.owner,
    grouping: args.grouping,
    visitPage: async (items) => {
      for (const candidate of items) {
        if (!(await args.matches(candidate))) continue;
        asset = candidate;
        return true;
      }
      return false;
    },
  });
  return { asset, sawItems: scan.sawItems };
}

function looksBurntOrClosed(asset: DasAsset): boolean {
  return dasAssetLooksBurntOrClosed(asset, BURN_POLICY);
}

function assetOwner(asset: DasAsset): string {
  return isRecord(asset.ownership) && typeof asset.ownership.owner === 'string'
    ? asset.ownership.owner
    : '';
}

function receiptIdentity(runtime: Runtime) {
  return adminIrlRedeemRuntime.receiptDropIdentity(runtime);
}

async function proofMatches(
  provider: ProviderContext,
  runtime: Runtime,
  asset: DasAsset,
  expected: { kind: 'box' | 'figure'; id: number },
): Promise<boolean> {
  const assetId = typeof asset.id === 'string' ? asset.id.trim() : '';
  if (!assetId) return false;
  let proof: Record<string, unknown>;
  try {
    proof = await fetchAssetProof(provider, runtime, assetId);
  } catch (error) {
    if (normalizedError(error, '').code === 'not-found') return false;
    throw error;
  }
  return assetMatchesReceiptDropIdentity(asset, proof, receiptIdentity(runtime), expected);
}

async function findPackReceipt(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  boxId: number,
): Promise<DasAsset | null> {
  const matches = async (asset: DasAsset) =>
    !looksBurntOrClosed(asset) &&
    assetOwner(asset) === owner &&
    assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), { kind: 'box', id: boxId }) &&
    await proofMatches(provider, runtime, asset, { kind: 'box', id: boxId });
  const grouping = ['collection', runtime.collectionMint.toBase58()] as const;
  const grouped = await findOwnedAsset({ provider, runtime, owner, grouping, matches });
  if (grouped.asset) return grouped.asset;
  return (await findOwnedAsset({ provider, runtime, owner, matches })).asset;
}

async function findPackReceiptById(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  boxId: number,
  assetId: string,
): Promise<DasAsset | null> {
  let asset: DasAsset;
  try {
    asset = await fetchAsset(provider, runtime, assetId);
  } catch (error) {
    if (normalizedError(error, '').code === 'not-found') return null;
    throw error;
  }
  if (looksBurntOrClosed(asset) || assetOwner(asset) !== owner) return null;
  if (!assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), { kind: 'box', id: boxId })) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt belongs to a different drop.');
  }
  if (!(await proofMatches(provider, runtime, asset, { kind: 'box', id: boxId }))) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt proof belongs to a different drop.');
  }
  return asset;
}

async function findFigureReceiptById(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  figureId: number,
  assetId: string,
): Promise<DasAsset | null> {
  let asset: DasAsset;
  try {
    asset = await fetchAsset(provider, runtime, assetId);
  } catch (error) {
    if (normalizedError(error, '').code === 'not-found') return null;
    throw error;
  }
  if (looksBurntOrClosed(asset) || assetOwner(asset) !== owner) return null;
  if (!assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), { kind: 'figure', id: figureId })) {
    throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim target belongs to a different drop.');
  }
  const proof = await fetchAssetProof(provider, runtime, assetId);
  if (!assetMatchesReceiptDropIdentity(asset, proof, receiptIdentity(runtime), { kind: 'figure', id: figureId })) {
    throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim proof belongs to a different drop.');
  }
  try {
    adminIrlRedeemRuntime.parseProof(asset, proof, runtime, owner);
  } catch (error) {
    throw normalizedError(error, 'Direct card receipt claim proof is invalid.');
  }
  return asset;
}

async function findOwnedFigureIds(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  figureIds: number[],
): Promise<Set<number>> {
  const expected = new Set(figureIds);
  const found = new Set<number>();
  const checked = new Set<string>();
  const visitPage = async (items: DasAsset[]) => {
    const candidates: Array<{ asset: DasAsset; figureId: number }> = [];
    for (const asset of items) {
      if (looksBurntOrClosed(asset) || assetOwner(asset) !== owner) continue;
      const reference = receiptMetadataReference(asset);
      if (!reference || reference.kind !== 'figure' || !expected.has(reference.id) || found.has(reference.id)) continue;
      if (!assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), reference)) continue;
      const assetId = typeof asset.id === 'string' ? asset.id.trim() : '';
      if (!assetId || checked.has(assetId)) continue;
      checked.add(assetId);
      candidates.push({ asset, figureId: reference.id });
    }
    for (let index = 0; index < candidates.length; index += 4) {
      const results = await Promise.all(candidates.slice(index, index + 4).map(async (candidate) => ({
        ...candidate,
        matches: await proofMatches(provider, runtime, candidate.asset, { kind: 'figure', id: candidate.figureId }),
      })));
      for (const result of results) if (result.matches) found.add(result.figureId);
      if (found.size === expected.size) return true;
    }
    return found.size === expected.size;
  };
  const grouping = ['collection', runtime.collectionMint.toBase58()] as const;
  const grouped = await scanOwnedAssetPages({ provider, runtime, owner, grouping, visitPage });
  if (!grouped.stopped) await scanOwnedAssetPages({ provider, runtime, owner, visitPage });
  return found;
}

async function ownsAllFigureReceipts(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  figureIds: number[],
): Promise<boolean> {
  const owned = await findOwnedFigureIds(provider, owner, runtime, figureIds);
  return figureIds.every((figureId) => owned.has(figureId));
}

function instructionAccounts(instruction: { accountKeyIndexes: Uint8Array | number[] }, keys: PublicKey[]): PublicKey[] {
  return Array.from(instruction.accountKeyIndexes).map((index) => keys[index]).filter((key): key is PublicKey => Boolean(key));
}

function instructionData(instruction: { data: string | Uint8Array }): Buffer {
  return typeof instruction.data === 'string'
    ? Buffer.from(bs58.decode(instruction.data))
    : Buffer.from(instruction.data);
}

function transactionAccountKeys(transaction: VersionedTransactionResponse): PublicKey[] {
  const keys = transaction.transaction.message.getAccountKeys({
    accountKeysFromLookups: transaction.meta?.loadedAddresses,
  });
  return [
    ...keys.staticAccountKeys,
    ...(keys.accountKeysFromLookups?.writable || []),
    ...(keys.accountKeysFromLookups?.readonly || []),
  ];
}

function bubblegumLeafAssetIds(transaction: VersionedTransactionResponse): string[] {
  const keys = transactionAccountKeys(transaction);
  const assetIds = new Set<string>();
  for (const group of transaction.meta?.innerInstructions || []) {
    for (const instruction of group.instructions) {
      const program = keys[instruction.programIdIndex];
      if (!program?.equals(MPL_NOOP_PROGRAM_ID)) continue;
      const data = instructionData(instruction);
      if (
        data.length < 41 || data[0] !== 1 || data[1] !== 0 ||
        data.readUInt32LE(2) !== data.length - 6 || data[6] !== 1 || data[7] !== 1 || data[8] !== 1
      ) continue;
      assetIds.add(new PublicKey(data.subarray(9, 41)).toBase58());
    }
  }
  return [...assetIds];
}

async function verifyDirectTransfer(args: {
  connection: Connection;
  runtime: Runtime;
  signature: string;
  fromWallet: string;
  toWallet: string;
  coreCollection: PublicKey;
  receiptAssetId: string;
}): Promise<void> {
  const transaction = await args.connection.getTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction) throw new StripeReceiptClaimError('unavailable', 'Card receipt transfer transaction not found yet; retry shortly.');
  if (transaction.meta?.err) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer transaction failed.', { err: transaction.meta.err });
  }
  const keys = transactionAccountKeys(transaction);
  if (keys[0]?.toBase58() !== args.fromWallet) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer payer does not match sender.');
  }
  let matches = 0;
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    if (!keys[instruction.programIdIndex]?.equals(BUBBLEGUM_PROGRAM_ID)) continue;
    const data = instructionData(instruction);
    if (!data.subarray(0, IX_BUBBLEGUM_TRANSFER_V2.length).equals(IX_BUBBLEGUM_TRANSFER_V2)) continue;
    const accounts = instructionAccounts(instruction, keys);
    const [, payer, authority, leafOwner, , newOwner, merkleTree, collection] = accounts;
    if (
      accounts.length >= 8 && payer?.toBase58() === args.fromWallet && authority?.toBase58() === args.fromWallet &&
      leafOwner?.toBase58() === args.fromWallet && newOwner?.toBase58() === args.toWallet &&
      merkleTree?.equals(args.runtime.receiptsMerkleTree) && collection?.equals(args.coreCollection)
    ) matches += 1;
  }
  if (matches !== 1) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer instruction mismatch.', { expected: 1, got: matches });
  }
  const assetIds = bubblegumLeafAssetIds(transaction);
  if (assetIds.length !== 1 || assetIds[0] !== args.receiptAssetId) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer asset mismatch.', {
      expected: args.receiptAssetId,
      got: assetIds,
    });
  }
}

async function inspectSubmission(
  connection: Connection,
  signature: string,
  submission: DirectCardReceiptClaimSubmission,
): Promise<Extract<DirectCardReceiptClaimTransferEvidence, 'rejected' | 'expired_unverified' | 'unresolved'>> {
  const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = statuses.value[0];
  const signatureStatus = status?.err ? 'failed' : status ? 'succeeded' : 'missing';
  const currentBlockHeight = signatureStatus === 'missing' ? await connection.getBlockHeight('confirmed') : 0;
  const evidence = classifyDirectCardReceiptClaimSubmission({
    signatureStatus,
    currentBlockHeight,
    lastValidBlockHeight: submission.lastValidBlockHeight,
    submittedAtMs: submission.submittedAtMs,
    nowMs: Date.now(),
  });
  return evidence === 'not_landed' ? 'rejected' : evidence;
}

async function inspectPersistedTransfers(args: {
  connection: Connection;
  runtime: Runtime;
  signatures: string[];
  submissions: DirectCardReceiptClaimSubmission[];
  adminWallet: string;
  recipientWallet: string;
  coreCollection: PublicKey;
  receiptAssetId: string;
}): Promise<{
  evidence: DirectCardReceiptClaimTransferEvidence;
  signature: string | null;
  terminalSubmissions: DirectCardReceiptClaimSubmission[];
}> {
  const signatures = Array.from(new Set(normalizeReceiptTxs(args.signatures))).reverse();
  if (!signatures.length) return { evidence: 'none', signature: null, terminalSubmissions: [] };
  const submissions = new Map(args.submissions.map((submission) => [submission.signature, submission]));
  let sawUnresolved = false;
  let sawExpired = false;
  const terminalSubmissions: DirectCardReceiptClaimSubmission[] = [];
  for (const signature of signatures) {
    const submission = submissions.get(signature);
    if (submission?.status === 'not_landed') continue;
    try {
      await verifyDirectTransfer({
        connection: args.connection,
        runtime: args.runtime,
        signature,
        fromWallet: args.adminWallet,
        toWallet: args.recipientWallet,
        coreCollection: args.coreCollection,
        receiptAssetId: args.receiptAssetId,
      });
      return { evidence: 'verified', signature, terminalSubmissions };
    } catch (error) {
      let evidence: Extract<DirectCardReceiptClaimTransferEvidence, 'rejected' | 'expired_unverified' | 'unresolved'> =
        classifyDirectCardReceiptClaimTransferVerificationError(error);
      if (evidence === 'unresolved' && submission) {
        try { evidence = await inspectSubmission(args.connection, signature, submission); }
        catch { evidence = 'unresolved'; }
      }
      if (evidence === 'rejected' && submission) terminalSubmissions.push({ ...submission, status: 'not_landed' });
      sawUnresolved ||= evidence === 'unresolved';
      sawExpired ||= evidence === 'expired_unverified';
    }
  }
  return {
    evidence: sawUnresolved ? 'unresolved' : sawExpired ? 'expired_unverified' : 'rejected',
    signature: null,
    terminalSubmissions,
  };
}

function deriveTreeConfig(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function buildTransaction(
  instructions: TransactionInstruction[],
  signer: Keypair,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[] = [],
): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables));
  transaction.sign([signer]);
  return transaction;
}

function encodingTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof RangeError && (
    /encoding overruns Uint8Array/i.test(message) ||
    /offset.*out of range/i.test(message) ||
    String(isRecord(error) ? error.code || '' : '') === 'ERR_OUT_OF_RANGE'
  );
}

async function buildWithOptionalLookupTable(args: {
  provider: ProviderContext;
  runtime: Runtime;
  build: (lookupTables: AddressLookupTableAccount[]) => VersionedTransaction;
  encodeTooLargeMessage: string;
  packetTooLargeMessage: (rawBytes: number) => string;
}): Promise<VersionedTransaction> {
  let lookupTables: AddressLookupTableAccount[] | undefined;
  const loadLookupTables = async () => {
    if (lookupTables) return lookupTables;
    try { lookupTables = await adminIrlRedeemRuntime.loadLookupTable(args.provider, args.runtime); }
    catch { lookupTables = []; }
    return lookupTables;
  };
  const serialize = (tables: AddressLookupTableAccount[]) => {
    const transaction = args.build(tables);
    return { transaction, raw: transaction.serialize() };
  };
  let built: { transaction: VersionedTransaction; raw: Uint8Array };
  try {
    built = serialize([]);
  } catch (error) {
    if (!encodingTooLarge(error)) throw error;
    const tables = await loadLookupTables();
    if (!tables.length) throw new StripeReceiptClaimError('failed-precondition', args.encodeTooLargeMessage);
    try { built = serialize(tables); }
    catch (lookupError) {
      if (!encodingTooLarge(lookupError)) throw lookupError;
      throw new StripeReceiptClaimError('failed-precondition', args.encodeTooLargeMessage);
    }
  }
  if (built.raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    const tables = await loadLookupTables();
    if (tables.length) built = serialize(tables);
  }
  if (built.raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    throw new StripeReceiptClaimError('failed-precondition', args.packetTooLargeMessage(built.raw.length), {
      rawBytes: built.raw.length,
      maxRawBytes: SOLANA_MAX_RAW_TX_BYTES,
    });
  }
  return built.transaction;
}

function signedTransactionSignature(transaction: VersionedTransaction): string {
  return bs58.encode(transaction.signatures[0]);
}

async function sendSigned(
  connection: Connection,
  transaction: VersionedTransaction,
  signal: AbortSignal,
  label: string,
): Promise<string> {
  const signature = signedTransactionSignature(transaction);
  try {
    return await deliveryReceiptRuntime.sendAndConfirmSignedTransaction(connection, transaction, signal, label);
  } catch (error) {
    const normalized = normalizedError(error, `${label} transaction failed.`);
    const details = isRecord(normalized.details) ? normalized.details : {};
    if (details.maybeSubmitted === true || normalized.code === 'deadline-exceeded') {
      throw new StripeReceiptClaimError(normalized.code, normalized.message, {
        ...details,
        signature,
        maybeSubmitted: true,
      });
    }
    throw normalized;
  }
}

function transferInstruction(args: {
  proof: ReturnType<typeof adminIrlRedeemRuntime.parseProof>;
  owner: PublicKey;
  recipient: PublicKey;
  coreCollection: PublicKey;
}): TransactionInstruction {
  return bubblegumTransferV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    treeConfig: deriveTreeConfig(args.proof.merkleTree),
    payer: args.owner,
    authority: args.owner,
    leafOwner: args.proof.leafOwner,
    leafDelegate: args.proof.leafDelegate,
    newLeafOwner: args.recipient,
    merkleTree: args.proof.merkleTree,
    coreCollection: args.coreCollection,
    root: args.proof.root,
    dataHash: args.proof.dataHash,
    creatorHash: args.proof.creatorHash,
    assetDataHash: args.proof.assetDataHash,
    flags: args.proof.flags,
    nonce: args.proof.nonce,
    index: args.proof.index,
    proof: args.proof.proofAccounts,
  });
}

function burnInstruction(args: {
  proof: ReturnType<typeof adminIrlRedeemRuntime.parseProof>;
  owner: PublicKey;
  coreCollection: PublicKey;
}): TransactionInstruction {
  return bubblegumBurnV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    mplCoreProgramId: MPL_CORE_PROGRAM_ID,
    mplCoreCpiSigner: MPL_CORE_CPI_SIGNER,
    treeConfig: deriveTreeConfig(args.proof.merkleTree),
    payer: args.owner,
    authority: args.owner,
    leafOwner: args.proof.leafOwner,
    leafDelegate: args.proof.leafDelegate,
    merkleTree: args.proof.merkleTree,
    coreCollection: args.coreCollection,
    root: args.proof.root,
    dataHash: args.proof.dataHash,
    creatorHash: args.proof.creatorHash,
    assetDataHash: args.proof.assetDataHash,
    flags: args.proof.flags,
    nonce: args.proof.nonce,
    index: args.proof.index,
    proof: args.proof.proofAccounts,
  });
}

function proofForAsset(
  asset: DasAsset,
  proof: Record<string, unknown>,
  runtime: Runtime,
  owner: string,
): ReturnType<typeof adminIrlRedeemRuntime.parseProof> {
  try { return adminIrlRedeemRuntime.parseProof(asset, proof, runtime, owner); }
  catch (error) { throw normalizedError(error, 'Receipt proof is invalid.'); }
}

async function resolveAmbiguousDirectSubmission(args: {
  connection: Connection;
  signature: string;
  lastValidBlockHeight: number;
  submittedAtMs: number;
  signal: AbortSignal;
}): Promise<'landed' | 'not_landed' | 'unresolved'> {
  const deadline = Date.now() + DIRECT_SUBMISSION_RESOLUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (args.signal.aborted) throw args.signal.reason;
    try {
      const statuses = await args.connection.getSignatureStatuses([args.signature], { searchTransactionHistory: true });
      const status = statuses.value[0];
      if (status?.err) return 'not_landed';
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized' || status?.confirmations === null) {
        return 'landed';
      }
      if (!status) {
        const currentBlockHeight = await args.connection.getBlockHeight('confirmed');
        if (directCardReceiptClaimSubmissionProvesNoDelivery({
          signatureStatus: 'missing',
          currentBlockHeight,
          lastValidBlockHeight: args.lastValidBlockHeight,
          submittedAtMs: args.submittedAtMs,
          nowMs: Date.now(),
        })) return 'not_landed';
      }
    } catch {
      if (args.signal.aborted) throw args.signal.reason;
    }
    await deliveryReceiptRuntime.pause(DIRECT_SUBMISSION_RESOLUTION_POLL_MS, args.signal);
  }
  return 'unresolved';
}

async function sendDirectFigureTransfer(args: {
  provider: ProviderContext;
  connection: Connection;
  runtime: Runtime;
  signer: Keypair;
  recipient: PublicKey;
  coreCollection: PublicKey;
  adminReceipt: DasAsset;
  persistSubmission: (submission: DirectCardReceiptClaimSubmission) => Promise<void>;
}): Promise<DirectCardReceiptClaimSubmission> {
  const receiptId = typeof args.adminReceipt.id === 'string' ? args.adminReceipt.id.trim() : '';
  if (!receiptId) throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt is missing an asset id.');
  const proof = proofForAsset(
    args.adminReceipt,
    await fetchAssetProof(args.provider, args.runtime, receiptId),
    args.runtime,
    args.signer.publicKey.toBase58(),
  );
  const instruction = transferInstruction({
    proof,
    owner: args.signer.publicKey,
    recipient: args.recipient,
    coreCollection: args.coreCollection,
  });
  const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash('confirmed');
  const transaction = await buildWithOptionalLookupTable({
    provider: args.provider,
    runtime: args.runtime,
    build: (tables) => buildTransaction(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), instruction],
      args.signer,
      blockhash,
      tables,
    ),
    encodeTooLargeMessage: 'Direct card receipt claim transaction is too large to encode.',
    packetTooLargeMessage: (rawBytes) => `Direct card receipt claim transaction too large (${rawBytes} bytes > ${SOLANA_MAX_RAW_TX_BYTES}).`,
  });
  const submittedAtMs = Date.now();
  const submission: DirectCardReceiptClaimSubmission = {
    signature: signedTransactionSignature(transaction),
    lastValidBlockHeight,
    submittedAtMs,
    status: 'submitted',
  };
  await args.persistSubmission(submission);
  try {
    const signature = await sendSigned(args.connection, transaction, args.provider.signal, 'claimStripeReceipt:directFigure');
    return { ...submission, signature };
  } catch (error) {
    const normalized = normalizedError(error, 'Direct card receipt claim transaction failed.');
    const details = isRecord(normalized.details) ? normalized.details : {};
    const ambiguousSignature = details.maybeSubmitted === true && typeof details.signature === 'string'
      ? details.signature.trim()
      : '';
    if (!ambiguousSignature) {
      try { await args.persistSubmission({ ...submission, status: 'not_landed' }); }
      catch (persistError) {
        throw new StripeReceiptClaimError(normalized.code, normalized.message, {
          ...details,
          lastValidBlockHeight,
          submittedAtMs,
          persistError: summarizeError(persistError),
        });
      }
      throw new StripeReceiptClaimError(normalized.code, normalized.message, {
        ...details,
        directCardReceiptSubmissionStatus: 'not_landed',
      });
    }
    const resolution = await resolveAmbiguousDirectSubmission({
      connection: args.connection,
      signature: ambiguousSignature,
      lastValidBlockHeight,
      submittedAtMs,
      signal: args.provider.signal,
    });
    if (resolution === 'landed') return { ...submission, signature: ambiguousSignature };
    if (resolution === 'not_landed') {
      await args.persistSubmission({ ...submission, signature: ambiguousSignature, status: 'not_landed' });
      throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim transaction expired before landing; retry.', {
        signature: ambiguousSignature,
        directCardReceiptSubmissionStatus: 'not_landed',
      });
    }
    throw new StripeReceiptClaimError(normalized.code, normalized.message, {
      ...details,
      signature: ambiguousSignature,
      lastValidBlockHeight,
      submittedAtMs,
      keepReceiptClaimProcessing: true,
    });
  }
}

function requireOpenableAssignment(claims: unknown[], runtime: Runtime, boxId: number): StripeAssignedIrlClaim {
  try {
    const assignment = stripeAssignedIrlClaimForBox({ irlClaims: claims }, boxId, {
      itemsPerBox: runtime.itemsPerBox,
      maxDudeId: runtime.maxDudeId,
    });
    if (assignment) return assignment;
  } catch (error) {
    throw new StripeReceiptClaimError(
      'failed-precondition',
      error instanceof Error
        ? error.message.replace(/^Stripe (?:receipt|IRL) claim/, 'Receipt claim')
        : 'Receipt claim is not ready yet; assigned receipts are invalid.',
      { dropId: runtime.dropId, boxId },
    );
  }
  throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned card receipts are missing.', {
    dropId: runtime.dropId,
    boxId,
  });
}

async function sendOpenableClaim(args: {
  provider: ProviderContext;
  connection: Connection;
  runtime: Runtime;
  signer: Keypair;
  recipient: PublicKey;
  coreCollection: PublicKey;
  adminReceipt: DasAsset;
  figureIds: number[];
}): Promise<string> {
  const receiptId = typeof args.adminReceipt.id === 'string' ? args.adminReceipt.id.trim() : '';
  if (!receiptId) throw new StripeReceiptClaimError('failed-precondition', 'Matching pack receipt is missing an asset id.');
  const proof = proofForAsset(
    args.adminReceipt,
    await fetchAssetProof(args.provider, args.runtime, receiptId),
    args.runtime,
    args.signer.publicKey.toBase58(),
  );
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    burnInstruction({ proof, owner: args.signer.publicKey, coreCollection: args.coreCollection }),
    deliveryReceiptRuntime.mintReceiptsInstruction({
      runtime: args.runtime,
      signer: args.signer.publicKey,
      recipient: args.recipient,
      coreCollection: args.coreCollection,
      boxIds: [],
      dudeIds: args.figureIds,
    }),
  ];
  const { blockhash } = await args.connection.getLatestBlockhash('confirmed');
  const transaction = await buildWithOptionalLookupTable({
    provider: args.provider,
    runtime: args.runtime,
    build: (tables) => buildTransaction(instructions, args.signer, blockhash, tables),
    encodeTooLargeMessage: 'Receipt claim transaction is too large to encode.',
    packetTooLargeMessage: (rawBytes) => `Receipt claim transaction too large (${rawBytes} bytes > ${SOLANA_MAX_RAW_TX_BYTES}).`,
  });
  return sendSigned(args.connection, transaction, args.provider.signal, 'claimStripeReceipt:openable');
}

function maybeSubmittedSignature(error: unknown): string | null {
  const normalized = normalizedError(error, '');
  const details = isRecord(normalized.details) ? normalized.details : {};
  return details.maybeSubmitted === true && typeof details.signature === 'string' && details.signature.trim()
    ? details.signature.trim()
    : null;
}

function keepsProcessing(error: unknown): boolean {
  const details = normalizedError(error, '').details;
  return isRecord(details) && details.keepReceiptClaimProcessing === true;
}

function claimFlowFor(directFigureReceipt: StartedClaim['directFigureReceipt'], itemsPerBox: number): ClaimFlow {
  if (directFigureReceipt) return 'direct_figure';
  return itemsPerBox >= BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX ? 'openable_pack' : 'legacy_pack';
}

type ClaimExecution = {
  response: StripeReceiptClaimResult;
  outcome: 'already_claimed' | 'claimed_box' | 'claimed_figures' | 'claimed_direct_figure';
};

async function claimStripeReceipt(
  body: StripeReceiptClaimRequest,
  env: ClaimEnv,
  firestore: FirestoreContext,
  provider: ProviderContext,
  onContext: (context: ClaimLogContext) => void = () => undefined,
): Promise<ClaimExecution> {
  const recipient = canonicalRecipient(body.recipient);
  const code = normalizedCode(body.code);
  const attemptId = `stripe_receipt:${crypto.randomUUID()}`;
  let started: StartedClaim | null = null;
  let sentReceiptTx: string | null = null;
  let sentSubmission: Omit<DirectCardReceiptClaimSubmission, 'signature'> | null = null;
  let keepDirectRecipientLock = false;
  try {
    const claim = await startClaim(firestore, code, recipient.wallet, attemptId, firestore.nowMs);
    if (claim.status === 'already_claimed') {
      if (claim.receiptKind) {
        return {
          response: responseForClaim({
            dropId: claim.dropId,
            deliveryId: claim.deliveryId,
            receiptTxs: claim.receiptTxs,
            receiptKind: claim.receiptKind,
            receiptsTransferred: claim.receiptsTransferred,
            figureIds: claim.figureIds,
            receiptAssetIds: claim.receiptAssetIds,
          }),
          outcome: 'already_claimed',
        };
      }
      let runtime: Runtime | null = null;
      try { runtime = runtimeForDrop(claim.dropId); }
      catch {}
      if (runtime && runtime.itemsPerBox >= BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX) {
        try {
          const order = await deliveryReceiptRuntime.readDocument(firestore, dropDeliveryOrderPath(claim.dropId, claim.deliveryId));
          const assignment = order
            ? stripeAssignedIrlClaimForBox(order.fields, claim.boxId, {
                itemsPerBox: runtime.itemsPerBox,
                maxDudeId: runtime.maxDudeId,
              })
            : null;
          if (assignment && await ownsAllFigureReceipts(provider, recipient.wallet, runtime, assignment.dudeIds)) {
            return {
              response: responseForClaim({
                dropId: claim.dropId,
                deliveryId: claim.deliveryId,
                receiptTxs: claim.receiptTxs,
                receiptKind: 'figure',
                receiptsTransferred: assignment.dudeIds.length,
                figureIds: assignment.dudeIds,
              }),
              outcome: 'already_claimed',
            };
          }
        } catch {}
      }
      return {
        response: responseForClaim({
          dropId: claim.dropId,
          deliveryId: claim.deliveryId,
          receiptTxs: claim.receiptTxs,
          ...(runtime ? { receiptKind: 'box' as const } : {}),
        }),
        outcome: 'already_claimed',
      };
    }
    started = claim;
    onContext({ dropId: claim.dropId, deliveryId: claim.deliveryId });
    keepDirectRecipientLock = Boolean(claim.directFigureReceipt && shouldKeepDirectCardReceiptClaimProcessing({
      resumingPreviousProcessingClaim: claim.resumingPreviousProcessingClaim,
      recipientOwnershipConfirmed: false,
    }));
    const runtime = runtimeForDrop(claim.dropId);
    const flow = claimFlowFor(claim.directFigureReceipt, runtime.itemsPerBox);
    const assignment = flow === 'openable_pack'
      ? requireOpenableAssignment(claim.orderIrlClaims, runtime, claim.boxId)
      : null;
    const connection = createConnection(provider, runtime);
    const onchain = await deliveryReceiptRuntime.fetchOnchainConfig(connection, runtime);
    let signer: Keypair;
    try { signer = deliveryReceiptRuntime.decodeCosigner(env.COSIGNER_SECRET); }
    catch (error) { throw normalizedError(error, 'Receipt claiming is temporarily unavailable.'); }
    if (!signer.publicKey.equals(onchain.admin)) {
      throw new StripeReceiptClaimError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin.', {
        expectedAdmin: onchain.admin.toBase58(),
        cosigner: signer.publicKey.toBase58(),
      });
    }
    if (!runtime.collectionMint.equals(onchain.coreCollection)) {
      throw new StripeReceiptClaimError('failed-precondition', 'COLLECTION_MINT does not match on-chain config.', {
        configured: runtime.collectionMint.toBase58(),
        onchain: onchain.coreCollection.toBase58(),
        dropId: runtime.dropId,
      });
    }
    const adminWallet = signer.publicKey.toBase58();
    if (flow === 'direct_figure' && claim.directFigureReceipt) {
      const target = claim.directFigureReceipt;
      const finalizeDirect = async (receiptTx: string | null): Promise<ClaimExecution> => {
        const receiptTxs = await finalizeClaim(
          firestore,
          claim,
          code,
          recipient.wallet,
          receiptTx,
          'figure',
          1,
          [target.figureId],
        );
        return {
          response: responseForClaim({
            dropId: claim.dropId,
            deliveryId: claim.deliveryId,
            receiptTxs,
            receiptKind: 'figure',
            receiptsTransferred: 1,
            figureIds: [target.figureId],
            receiptAssetIds: [target.receiptAssetId],
          }),
          outcome: 'claimed_direct_figure',
        };
      };
      const persisted = await inspectPersistedTransfers({
        connection,
        runtime,
        signatures: claim.receiptTxs,
        submissions: claim.receiptTxSubmissions,
        adminWallet,
        recipientWallet: recipient.wallet,
        coreCollection: onchain.coreCollection,
        receiptAssetId: target.receiptAssetId,
      });
      for (const terminal of persisted.terminalSubmissions) {
        const { signature, ...submission } = terminal;
        await rememberSubmittedTransaction(firestore, code, attemptId, signature, submission);
      }
      const recipientReceipt = persisted.evidence === 'verified'
        ? null
        : await findFigureReceiptById(provider, recipient.wallet, runtime, target.figureId, target.receiptAssetId);
      const adminReceipt = persisted.evidence === 'verified' || persisted.evidence === 'unresolved' || recipientReceipt
        ? null
        : await findFigureReceiptById(provider, adminWallet, runtime, target.figureId, target.receiptAssetId);
      const recovery = resolveDirectCardReceiptClaimRecoveryAction({
        transferEvidence: persisted.evidence,
        recipientOwnsReceipt: Boolean(recipientReceipt),
        adminOwnsReceipt: Boolean(adminReceipt),
      });
      if (recovery === 'finalize') {
        keepDirectRecipientLock = shouldKeepDirectCardReceiptClaimProcessing({
          resumingPreviousProcessingClaim: claim.resumingPreviousProcessingClaim,
          recipientOwnershipConfirmed: true,
        });
        return finalizeDirect(persisted.signature);
      }
      if (recovery === 'wait' || !adminReceipt) {
        if (keepDirectRecipientLock) {
          throw new StripeReceiptClaimError(
            'unavailable',
            'Card receipt ownership is still resolving for the original receiver; retry shortly.',
            { keepReceiptClaimProcessing: true },
          );
        }
        throw new StripeReceiptClaimError('failed-precondition', 'Matching admin-owned card receipt not found.');
      }
      const submission = await sendDirectFigureTransfer({
        provider,
        connection,
        runtime,
        signer,
        recipient: recipient.key,
        coreCollection: onchain.coreCollection,
        adminReceipt,
        persistSubmission: async (candidate) => {
          const { signature, ...details } = candidate;
          await rememberSubmittedTransaction(firestore, code, attemptId, signature, details);
          sentReceiptTx = signature;
          sentSubmission = details;
        },
      });
      return finalizeDirect(submission.signature);
    }
    const adminReceipt = assignment
      ? await findPackReceiptById(provider, adminWallet, runtime, claim.boxId, assignment.boxAssetId)
      : await findPackReceipt(provider, adminWallet, runtime, claim.boxId);
    if (flow === 'openable_pack' && assignment) {
      const finalizeFigures = async (receiptTx: string | null): Promise<ClaimExecution> => {
        const receiptTxs = await finalizeClaim(
          firestore,
          claim,
          code,
          recipient.wallet,
          receiptTx,
          'figure',
          assignment.dudeIds.length,
          assignment.dudeIds,
        );
        return {
          response: responseForClaim({
            dropId: claim.dropId,
            deliveryId: claim.deliveryId,
            receiptTxs,
            receiptKind: 'figure',
            receiptsTransferred: assignment.dudeIds.length,
            figureIds: assignment.dudeIds,
          }),
          outcome: 'claimed_figures',
        };
      };
      let ownsAssignedFigures: boolean | undefined;
      const recipientOwnsFigures = async () => {
        ownsAssignedFigures ??= await ownsAllFigureReceipts(provider, recipient.wallet, runtime, assignment.dudeIds);
        return ownsAssignedFigures;
      };
      if ((claim.resumingPreviousProcessingClaim || claim.hasPreviousClaimFailure) && await recipientOwnsFigures()) {
        return finalizeFigures(null);
      }
      if (!adminReceipt) {
        if (await recipientOwnsFigures()) return finalizeFigures(null);
        throw new StripeReceiptClaimError('failed-precondition', 'Matching admin-owned pack receipt not found.');
      }
      const adminReceiptId = typeof adminReceipt.id === 'string' ? adminReceipt.id.trim() : '';
      if (!adminReceiptId) throw new StripeReceiptClaimError('failed-precondition', 'Matching pack receipt is missing an asset id.');
      if (adminReceiptId !== assignment.boxAssetId) {
        throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt does not match admin receipt.', {
          dropId: claim.dropId,
          deliveryId: claim.deliveryId,
          boxId: claim.boxId,
          assignedBoxAssetId: assignment.boxAssetId,
          adminReceiptId,
        });
      }
      const receiptTx = await sendOpenableClaim({
        provider,
        connection,
        runtime,
        signer,
        recipient: recipient.key,
        coreCollection: onchain.coreCollection,
        adminReceipt,
        figureIds: assignment.dudeIds,
      });
      sentReceiptTx = receiptTx;
      return finalizeFigures(receiptTx);
    }
    let recipientReceipt: DasAsset | null | undefined;
    const findRecipientReceipt = async () => {
      if (recipientReceipt === undefined) {
        recipientReceipt = await findPackReceipt(provider, recipient.wallet, runtime, claim.boxId);
      }
      return recipientReceipt;
    };
    const finalizeBox = async (receiptTx: string | null): Promise<ClaimExecution> => {
      const receiptTxs = await finalizeClaim(firestore, claim, code, recipient.wallet, receiptTx, 'box', 1);
      return {
        response: responseForClaim({
          dropId: claim.dropId,
          deliveryId: claim.deliveryId,
          receiptTxs,
          receiptKind: 'box',
          receiptsTransferred: 1,
        }),
        outcome: 'claimed_box',
      };
    };
    if ((claim.resumingPreviousProcessingClaim || claim.hasPreviousClaimFailure) && await findRecipientReceipt()) {
      return finalizeBox(null);
    }
    if (!adminReceipt) {
      if (await findRecipientReceipt()) return finalizeBox(null);
      throw new StripeReceiptClaimError('failed-precondition', 'Matching admin-owned pack receipt not found.');
    }
    const receiptId = typeof adminReceipt.id === 'string' ? adminReceipt.id.trim() : '';
    if (!receiptId) throw new StripeReceiptClaimError('failed-precondition', 'Matching pack receipt is missing an asset id.');
    const proof = proofForAsset(
      adminReceipt,
      await fetchAssetProof(provider, runtime, receiptId),
      runtime,
      adminWallet,
    );
    const instruction = transferInstruction({
      proof,
      owner: signer.publicKey,
      recipient: recipient.key,
      coreCollection: onchain.coreCollection,
    });
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transaction = buildTransaction(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), instruction],
      signer,
      blockhash,
    );
    const receiptTx = await sendSigned(connection, transaction, provider.signal, 'claimStripeReceipt');
    sentReceiptTx = receiptTx;
    return finalizeBox(receiptTx);
  } catch (error) {
    const normalized = normalizedError(error, 'Receipt claim failed.');
    const directDefinitelyNotLanded = isRecord(normalized.details) && normalized.details.directCardReceiptSubmissionStatus === 'not_landed';
    const maybeSent = directDefinitelyNotLanded ? null : sentReceiptTx || maybeSubmittedSignature(normalized);
    if (started && maybeSent) {
      const details = isRecord(normalized.details) ? normalized.details : {};
      const errorSubmission = normalizeSubmissions([{
        signature: maybeSent,
        lastValidBlockHeight: details.lastValidBlockHeight,
        submittedAtMs: details.submittedAtMs,
      }])[0];
      await rememberSubmittedTransaction(
        firestore,
        code,
        attemptId,
        maybeSent,
        sentSubmission || errorSubmission || null,
      ).catch((persistError) => {
        console.warn({
          event: 'stripe_receipt_claim_submission_persist_failed',
          dropId: started?.dropId,
          deliveryId: started?.deliveryId,
          error: summarizeError(persistError),
        });
      });
    } else if (started && !directDefinitelyNotLanded && (keepsProcessing(normalized) || keepDirectRecipientLock)) {
      console.warn({
        event: 'stripe_receipt_claim_left_processing',
        dropId: started.dropId,
        deliveryId: started.deliveryId,
        error: summarizeError(normalized),
      });
    } else if (started) {
      await clearProcessing(firestore, started, code, normalized);
    }
    throw normalized;
  }
}

const defaultDependencies: ClaimDependencies = {
  accessTokenProvider: createGoogleAccessTokenProvider(),
  claim: claimStripeReceipt,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
};

async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function handleStripeReceiptClaim(
  request: Request,
  env: ClaimEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  overrides: Partial<ClaimDependencies> = {},
): Promise<StripeReceiptClaimRequestResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: ClaimMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try { return await dependencies.providerFetch(input, init); }
    finally { metrics.providerDurationMs += Math.max(0, performance.now() - startedAt); }
  };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new StripeReceiptClaimError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { status: 405, headers: response.headers }),
      metrics,
      authOutcome: 'rejected',
      outcome: 'method_not_allowed',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Stripe receipt claim timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: FirebaseIdentity | undefined;
  let execution: Promise<ClaimExecution> | undefined;
  let claimContext: ClaimLogContext | undefined;
  try {
    const body = await readRequestBody(request, controller.signal);
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    const serviceAccountJson = String(env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON || '').trim();
    const apiKey = String(env.HELIUS_API_KEY || '').trim();
    const cosignerSecret = String(env.COSIGNER_SECRET || '').trim();
    if (!serviceAccountJson || !apiKey || !cosignerSecret) {
      throw new StripeReceiptClaimError('unavailable', 'Receipt claiming is temporarily unavailable.');
    }
    const nowMs = dependencies.nowMs();
    execution = dependencies.claim(
      body,
      { ...env, COSIGNER_SECRET: cosignerSecret, FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: serviceAccountJson, HELIUS_API_KEY: apiKey },
      {
        accessTokenProvider: dependencies.accessTokenProvider,
        nowMs,
        providerFetch: trackedFetch,
        serviceAccountJson,
        signal: controller.signal,
      },
      { apiKey, providerFetch: trackedFetch, signal: controller.signal },
      (context) => { claimContext = context; },
    );
    const result = await waitForSignal(execution, controller.signal);
    return {
      response: jsonResponse(result.response),
      metrics,
      authOutcome: 'accepted',
      dropId: result.response.dropId,
      deliveryId: result.response.deliveryId,
      outcome: result.outcome,
    };
  } catch (error) {
    let normalized: StripeReceiptClaimError;
    if (controller.signal.aborted) {
      if (execution) {
        const cleanup = execution.then(() => undefined, () => undefined);
        try { waitUntil(cleanup); }
        catch { void cleanup; }
      }
      normalized = new StripeReceiptClaimError('deadline-exceeded', 'Receipt claim request timed out.');
    } else if (error instanceof FirebaseIdTokenError) {
      normalized = new StripeReceiptClaimError(
        error.kind === 'invalid-token' ? 'unauthenticated' : error.kind === 'provider-timeout' ? 'deadline-exceeded' : 'unavailable',
        error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.',
      );
    } else {
      normalized = normalizedError(error, 'Receipt claim failed.');
      if (normalized.code === 'internal') {
        console.error({ event: 'stripe_receipt_claim_unhandled_error', error: summarizeError(error) });
      }
    }
    const rejected = ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(normalized.code);
    return {
      response: errorResponse(normalized),
      metrics,
      authOutcome: identity ? (rejected ? 'rejected' : 'provider-failure') : normalized.code === 'unauthenticated' ? 'rejected' : 'provider-failure',
      ...claimContext,
      outcome: normalized.code,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const stripeReceiptClaimTestHooks = {
  buildWithOptionalLookupTable,
  claimFlowFor,
  claimStripeReceipt,
  clearProcessing,
  finalizeClaim,
  rememberSubmittedTransaction,
  normalizeSubmissions,
  orderTarget,
  readRequestBody,
  responseForClaim,
  startClaim,
};
