import { type AdminIrlRedeemTargetKind } from '../../../../shared/adminIrlEligibility.js';
import { isAdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.js';
import {
  AdminIrlRedeemFinalizeError,
  WORKFLOW_EFFECT_LEASE_MS,
  WORKFLOW_EXECUTION_FIELD,
  adminIrlRedeemFinalizeOperationIdForWallet,
  canonicalPublicKey,
  canonicalSignature,
  isAdminIrlRedeemFinalizeErrorCode,
  parseAdminIrlRedeemFinalizeWorkflowPayload,
  workflowErrorForCode,
  type AdminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowPayload,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  type CommerceDocumentKey,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentWriteData,
  type CommerceDocumentRecord,
  CommerceWriteConflict,
} from './commerceRepository.js';
import {
  commerceTimestamp,
  readCommerceRecord,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { dropAdminIrlRedeemRequestPath, dropAdminIrlRedeemReceiptMarkerPath } from './dropPaths.js';
import { AdminIrlRedeemPrepareError, PendingFinalizeSubmissionError } from './adminIrlRedeemErrors.js';
import {
  type AdminIrlRedeemFinalizeResponse,
  type AdminIrlRedeemFinalizeWorkflowExecutionV1,
  type AdminIrlRedeemFinalizeWorkflowOnchainV1,
  type AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
  type FinalizeRequest,
  type PendingFinalizeSubmission,
  type RequestItem,
  type StartedRequest,
  WORKFLOW_DRAFT_FIELD,
  completeResponse,
  finalizeRequestOwner,
  normalizePendingFinalizeSubmission,
  normalizeReceiptTxs,
  normalizeWorkflowDraft,
  normalizeWorkflowExecution,
  samePendingFinalizeSubmission,
  startedFinalizeRequest,
  validateWorkflowDraftForRequest,
  workflowExecutionData,
  workflowExecutionForReplay,
} from './adminIrlRedeemRequestState.js';
import { buildRuntime as buildAdminIrlRedeemRuntime } from './adminIrlRedeemRuntime.js';
import { mutateSubmissionJournal } from './submissionJournal.js';

const PROCESSING_LEASE_MS = 30 * 60 * 1000;
const PREPARED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 10_000;

type CommerceContext = CommerceRepositoryContext;
type StartFinalizeResult =
  | { status: 'complete'; request: Record<string, unknown> }
  | { status: 'started'; request: StartedRequest };

export async function startFinalize(
  context: CommerceContext,
  body: FinalizeRequest,
  wallet: string,
  attemptId: string,
  nowMs: number,
  workflowExecution?: AdminIrlRedeemFinalizeWorkflowExecutionV1,
): Promise<StartFinalizeResult> {
  const key = commerceKeys.adminIrlRedeemRequest(body.dropId, body.requestId);
  try {
    return await runCommerceTransaction<StartFinalizeResult>(context, async (transaction) => {
      const document = await readCommerceRecord(context, key, transaction);
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      const request = document.data;
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
      if (request.status === 'complete') return { status: 'complete' as const, request };
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
          await transaction.update(document.key, {
            processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
            ...(replayExecution ? { [WORKFLOW_EXECUTION_FIELD]: workflowExecutionData(replayExecution) } : {}),
            updatedAt: commerceFieldValue.serverTimestamp(),
          });
          return { status: 'started' as const, request: started };
        }
        throw new AdminIrlRedeemFinalizeError('aborted', 'This Admin IRL redeem request is already being finalized.');
      }
      const requestWithWorkflow = replayExecution
        ? { ...request, [WORKFLOW_EXECUTION_FIELD]: replayExecution }
        : request;
      const started = startedFinalizeRequest(body, requestWithWorkflow, owner);
      await transaction.update(document.key, {
        status: 'processing',
        transferSignature: body.transferSignature,
        processingAttemptId: attemptId,
        processingLeaseExpiresAt: timestamp(nowMs + PROCESSING_LEASE_MS),
        ...(replayExecution ? { [WORKFLOW_EXECUTION_FIELD]: workflowExecutionData(replayExecution) } : {}),
        preparedExpiresAt: commerceFieldValue.delete(),
        processingStartedAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      });
      return { status: 'started' as const, request: started };
    });
  } catch (error) {
    if (error instanceof AdminIrlRedeemFinalizeError) throw error;
    try {
      const cleanup = cleanupContext(context);
      const document = await readCommerceRecord(cleanup, key);
      const request = document?.data;
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

export function cleanupContext(context: CommerceContext): CommerceContext {
  return { ...context, nowMs: Date.now(), signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) };
}

export async function persistPendingFinalizeSubmission(
  context: CommerceContext,
  key: CommerceDocumentKey<'admin_irl_redeem_request'>,
  attemptId: string,
  pending: PendingFinalizeSubmission,
): Promise<void> {
  await mutateSubmissionJournal({
    context,
    key,
    phase: 'persist',
    createCleanupContext: () => cleanupContext(context),
    plan: (document) => {
      if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const existing = normalizePendingFinalizeSubmission(document.data.pendingFinalizeSubmission);
      if (existing && !samePendingFinalizeSubmission(existing, pending)) {
        throw new PendingFinalizeSubmissionError();
      }
      return {
        ...(existing ? {} : { pendingFinalizeSubmission: pending }),
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
        updatedAt: commerceFieldValue.serverTimestamp(),
      };
    },
    isApplied: (document) => {
      const stored = document && normalizePendingFinalizeSubmission(document.data.pendingFinalizeSubmission);
      return Boolean(
        document?.data.status === 'processing' &&
        document.data.processingAttemptId === attemptId &&
        stored && samePendingFinalizeSubmission(stored, pending)
      );
    },
  });
}

export function pendingFinalizeSubmissionAlreadySettled(
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

export async function settlePendingFinalizeSubmission(
  context: CommerceContext,
  key: CommerceDocumentKey<'admin_irl_redeem_request'>,
  attemptId: string,
  pending: PendingFinalizeSubmission,
  outcome: 'confirmed' | 'expired',
): Promise<void> {
  await mutateSubmissionJournal({
    context,
    key,
    phase: 'settle',
    createCleanupContext: () => cleanupContext(context),
    plan: (document) => {
      if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const stored = normalizePendingFinalizeSubmission(document.data.pendingFinalizeSubmission);
      if (!stored) {
        if (pendingFinalizeSubmissionAlreadySettled(document.data, pending, outcome)) {
          return {
            processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
            updatedAt: commerceFieldValue.serverTimestamp(),
          };
        }
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem submission recovery changed.');
      }
      if (!samePendingFinalizeSubmission(stored, pending)) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem submission recovery changed.');
      }
      const values: CommerceDocumentWriteData = {
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
        pendingFinalizeSubmission: commerceFieldValue.delete(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      };
      if (outcome === 'confirmed') {
        if (pending.kind === 'internal_delivery') {
          values.internalDeliveryId = pending.deliveryId;
          values.internalDeliveryPda = pending.deliveryPda;
          values.internalDeliveryTx = pending.signature;
        } else {
          values.receiptTxs = Array.from(new Set([...normalizeReceiptTxs(document.data.receiptTxs), pending.signature]));
        }
      }
      return values;
    },
    isApplied: (document) => {
      const stored = document && normalizePendingFinalizeSubmission(document.data.pendingFinalizeSubmission);
      return Boolean(
        document?.data.status === 'processing' &&
        document.data.processingAttemptId === attemptId &&
        !stored && pendingFinalizeSubmissionAlreadySettled(document.data, pending, outcome)
      );
    },
  });
}

export async function holdPendingFinalizeSubmission(
  context: CommerceContext,
  key: CommerceDocumentKey<'admin_irl_redeem_request'>,
  attemptId: string,
  pending: PendingFinalizeSubmission,
): Promise<void> {
  await runCommerceTransaction(context, async (transaction) => {
    const document = await readCommerceRecord(context, key, transaction);
    if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
      return;
    }
    const stored = normalizePendingFinalizeSubmission(document.data.pendingFinalizeSubmission);
    if (!stored || !samePendingFinalizeSubmission(stored, pending)) return;
    await transaction.update(document.key, {
      processingLeaseExpiresAt: timestamp(context.nowMs + PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
  });
}

function timestamp(value: number) {
  return commerceTimestamp(value);
}

type PreparedCommerceContext = { commerceDb?: D1Database; nowMs: number; repository?: D1CommerceRepository; signal: AbortSignal };
type PreparedItem = RequestItem;
export type CreateRequestInput = {
  adminWallet: string;
  dropId: string;
  itemIds: string[];
  items: PreparedItem[];
  owner: string;
  prepareAttemptId?: string;
  requestId: string;
  targetKind: AdminIrlRedeemTargetKind;
};

function requestMatches(value: CommerceDocumentRecord | null, input: CreateRequestInput): boolean {
  const fields = value?.data;
  return Boolean(
    fields &&
    fields.status === 'prepared' &&
    fields.dropId === input.dropId &&
    fields.owner === input.owner &&
    fields.adminWallet === input.adminWallet &&
    fields.targetKind === input.targetKind &&
    JSON.stringify(fields.itemIds) === JSON.stringify(input.itemIds) &&
    (input.prepareAttemptId === undefined || fields.prepareAttemptId === input.prepareAttemptId)
  );
}

export async function createPreparedRequest(context: PreparedCommerceContext, input: CreateRequestInput): Promise<string> {
  const path = dropAdminIrlRedeemRequestPath(input.dropId, input.requestId);
  const key = commerceKeys.adminIrlRedeemRequest(input.dropId, input.requestId);
  if (key.path !== path) throw new AdminIrlRedeemPrepareError('internal', 'Admin IRL redeem preparation failed.');
  const fields = {
    dropId: input.dropId,
    status: 'prepared',
    owner: input.owner,
    targetKind: input.targetKind,
    adminWallet: input.adminWallet,
    itemIds: input.itemIds,
    items: input.items,
    preparedExpiresAt: commerceFieldValue.timestamp(Math.floor((context.nowMs + PREPARED_TTL_MS) / 1000),
      ((context.nowMs + PREPARED_TTL_MS) % 1000) * 1_000_000),
    createdAt: commerceFieldValue.serverTimestamp(),
    updatedAt: commerceFieldValue.serverTimestamp(),
    ...(input.prepareAttemptId ? { prepareAttemptId: input.prepareAttemptId } : {}),
  };
  try {
    const created = await commerceRepository(context).run(context.nowMs, async (unit) => unit.create(key, fields));
    return created.updateTime;
  } catch (error) {
    if (error instanceof CommerceWriteConflict) {
      throw new AdminIrlRedeemPrepareError('aborted', 'Admin IRL redeem request collision. Retry.');
    }
    const reconciled = await commerceRepository(context).get(key).catch(() => null);
    if (requestMatches(reconciled, input)) return reconciled!.updateTime;
    throw error;
  }
}

export async function deletePreparedRequestAtRevision(
  context: PreparedCommerceContext,
  key: CommerceDocumentKey<'admin_irl_redeem_request'>,
  updateTime: string,
): Promise<void> {
  await commerceRepository(context).run(context.nowMs, async (unit) => {
    const current = await unit.get(key);
    if (!current || current.updateTime !== updateTime) throw new CommerceWriteConflict();
    await unit.delete(key, { mustExist: true });
  });
}

export async function loadReceiptMarker(
  context: PreparedCommerceContext,
  dropId: string,
  assetId: string,
): Promise<boolean> {
  const key = commerceKeys.adminIrlRedeemReceiptMarker(dropId, assetId);
  if (key.path !== dropAdminIrlRedeemReceiptMarkerPath(dropId, assetId)) {
    throw new AdminIrlRedeemPrepareError('internal', 'Admin IRL redeem preparation failed.');
  }
  return Boolean(await commerceRepository(context).get(key));
}

function commerceRepository(context: PreparedCommerceContext): D1CommerceRepository {
  if (context.repository) return context.repository;
  if (context.commerceDb) return new D1CommerceRepository(context.commerceDb);
  throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
}

type LoadedWorkflowRequest =
  | Readonly<{ status: 'complete'; response: AdminIrlRedeemFinalizeResponse; body: FinalizeRequest }>
  | Readonly<{ status: 'started'; body: FinalizeRequest; request: StartedRequest; execution: AdminIrlRedeemFinalizeWorkflowExecutionV1; draft?: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1 }>;

export async function enterWorkflow(
  commerce: CommerceContext,
  args: { operationId: string; payload: AdminIrlRedeemFinalizeWorkflowPayload },
  confirmEntry = false,
): Promise<LoadedWorkflowRequest> {
  const payload = parseAdminIrlRedeemFinalizeWorkflowPayload(args.payload);
  if (!payload || !isAdminIrlRedeemFinalizeOperationId(args.operationId)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow request.');
  }
  const key = commerceKeys.adminIrlRedeemRequest(payload.dropId, payload.requestId);
  return runCommerceTransaction<LoadedWorkflowRequest>(commerce, async (transaction) => {
    const document = await readCommerceRecord(commerce, key, transaction);
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    const fields = document.data;
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
        status: 'complete' as const,
        response: completeResponse(payload.dropId, payload.requestId, fields),
        body,
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
    await transaction.update(document.key, {
      processingLeaseExpiresAt: timestamp(enteredAtMs + PROCESSING_LEASE_MS),
      ...(enteredEffect
        ? { [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: enteredEffect }
        : {}),
      ...(confirmEntry ? {
        [`${WORKFLOW_EXECUTION_FIELD}.failure`]: commerceFieldValue.delete(),
        [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
      } : {}),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
    return {
      status: 'started' as const,
      body,
      request,
      execution,
      ...(request.workflowPublicationDraftV1 ? { draft: request.workflowPublicationDraftV1 } : {}),
    };
  });
}

export async function persistWorkflowOnchain(
  loaded: { commerce: CommerceContext; body: FinalizeRequest; execution: AdminIrlRedeemFinalizeWorkflowExecutionV1 },
  onchain: AdminIrlRedeemFinalizeWorkflowOnchainV1,
): Promise<void> {
  let persisted = onchain;
  await runCommerceTransaction(loaded.commerce, async (transaction) => {
    const document = await readCommerceRecord(
      loaded.commerce,
      commerceKeys.adminIrlRedeemRequest(loaded.body.dropId, loaded.body.requestId),
      transaction,
    );
    if (
      !document || document.data.status !== 'processing' ||
      document.data.processingAttemptId !== loaded.execution.operationId
    ) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const current = normalizeWorkflowExecution(document.data[WORKFLOW_EXECUTION_FIELD], loaded.body);
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
    await transaction.update(document.key, {
      [`${WORKFLOW_EXECUTION_FIELD}.onchain`]: persisted,
      processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
  });
  loaded.execution.onchain = persisted;
}

export async function persistWorkflowDraft(
  loaded: { commerce: CommerceContext; body: FinalizeRequest; execution: AdminIrlRedeemFinalizeWorkflowExecutionV1; request: Pick<StartedRequest, 'owner'> },
  draft: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
): Promise<void> {
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  await runCommerceTransaction(loaded.commerce, async (transaction) => {
    const document = await readCommerceRecord(
      loaded.commerce,
      commerceKeys.adminIrlRedeemRequest(loaded.body.dropId, loaded.body.requestId),
      transaction,
    );
    if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== loaded.execution.operationId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const currentRequest = startedFinalizeRequest(loaded.body, document.data, loaded.request.owner);
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
    const existing = normalizeWorkflowDraft(document.data[WORKFLOW_DRAFT_FIELD]);
    if (existing) {
      validateWorkflowDraftForRequest(existing, currentRequest, runtime);
      return;
    }
    await transaction.update(document.key, {
      [WORKFLOW_DRAFT_FIELD]: candidate,
      processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
  });
}

export async function recordWorkflowFailure(args: Readonly<{
  commerce: CommerceContext;
  error: AdminIrlRedeemFinalizeWorkflowError;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
}>): Promise<{ cleared: boolean }> {
  const payload = parseAdminIrlRedeemFinalizeWorkflowPayload(args.payload);
  if (!payload) throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow request.');
  const workflowError = workflowErrorForCode(
    isAdminIrlRedeemFinalizeErrorCode(args.error.code) ? args.error.code : 'internal',
  );
  const commerce = args.commerce;
  return runCommerceTransaction<{ cleared: boolean }>(commerce, async (transaction) => {
    const document = await readCommerceRecord(
      commerce,
      commerceKeys.adminIrlRedeemRequest(payload.dropId, payload.requestId),
      transaction,
    );
    if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== args.operationId) {
      return { cleared: false };
    }
    const hasProgress = document.data.pendingFinalizeSubmission !== undefined ||
      document.data.internalDeliveryTx !== undefined ||
      normalizeReceiptTxs(document.data.receiptTxs).length > 0 ||
      document.data[WORKFLOW_DRAFT_FIELD] !== undefined;
    if (hasProgress) {
      await transaction.update(document.key, {
        lastFinalizeError: {
          kind: 'workflow',
          code: workflowError.code,
          recovery: workflowError.retryable ? 'automatic' : 'manual',
        },
        [`${WORKFLOW_EXECUTION_FIELD}.failure`]: workflowError,
        processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
        [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
        [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: commerceFieldValue.delete(),
        lastFinalizeErrorAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      });
      return { cleared: false };
    }
    await transaction.update(document.key, {
      status: 'prepared',
      lastFinalizeError: { kind: 'workflow', code: workflowError.code },
      [`${WORKFLOW_EXECUTION_FIELD}.failure`]: workflowError,
      preparedExpiresAt: timestamp(Date.now() + PREPARED_TTL_MS),
      processingAttemptId: commerceFieldValue.delete(),
      processingStartedAt: commerceFieldValue.delete(),
      processingLeaseExpiresAt: commerceFieldValue.delete(),
      [WORKFLOW_DRAFT_FIELD]: commerceFieldValue.delete(),
      [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
      [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: commerceFieldValue.delete(),
      lastFinalizeErrorAt: commerceFieldValue.serverTimestamp(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
    return { cleared: true };
  });
}

export async function recordInternalDelivery(
  commerce: CommerceContext,
  key: CommerceDocumentKey<'admin_irl_redeem_request'>,
  attemptId: string,
  delivery: { deliveryId: number; deliveryPda: string },
): Promise<void> {
  await runCommerceTransaction(commerce, async (transaction) => {
    const document = await readCommerceRecord(commerce, key, transaction);
    if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    await transaction.update(document.key, {
      internalDeliveryId: delivery.deliveryId,
      internalDeliveryPda: delivery.deliveryPda,
      processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
  });
}

export async function recordCloseDelivery(
  commerce: CommerceContext,
  key: CommerceDocumentKey<'admin_irl_redeem_request'>,
  attemptId: string,
  signature: string,
): Promise<void> {
  await runCommerceTransaction(commerce, async (transaction) => {
    const document = await readCommerceRecord(commerce, key, transaction);
    if (!document || document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    await transaction.update(document.key, {
      closeDeliveryTx: signature,
      processingLeaseExpiresAt: timestamp(Date.now() + PROCESSING_LEASE_MS),
      updatedAt: commerceFieldValue.serverTimestamp(),
    });
  });
}
