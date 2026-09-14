import { raceWithSignal } from './boundedRequest.js';
import {
  D1CommerceRepository,
  commerceFieldValue,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceUnitOfWork,
} from './commerceRepository.js';
import {
  readCommerceRecord,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { isRecord } from './dataAccess.js';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeOperationIdForWallet,
  canonicalPublicKey,
  canonicalSignature,
  parseWorkflowError,
  workflowPendingEffect,
  WORKFLOW_EFFECT_LEASE_MS,
  WORKFLOW_EXECUTION_FIELD,
  type AdminIrlRedeemFinalizeWorkflowPendingEffect,
  type AdminIrlRedeemFinalizeWorkflowStoredOperation,
} from './adminIrlRedeemFinalizeWorkflowState.js';

function workflowOperationContext(
  db: D1Database,
  signal: AbortSignal,
  nowMs: number,
): CommerceRepositoryContext {
  return { repository: new D1CommerceRepository(db), signal, nowMs };
}

async function readProcessingWorkflowOperation(
  commerce: CommerceRepositoryContext,
  transaction: CommerceUnitOfWork,
  key: CommerceDocumentKey,
  operationId: string,
): Promise<{
  document: CommerceDocumentRecord;
  effect: AdminIrlRedeemFinalizeWorkflowPendingEffect | undefined;
} | null> {
  const document = await readCommerceRecord(commerce, key, transaction);
  const execution = document?.data[WORKFLOW_EXECUTION_FIELD];
  if (
    !document || document.data.status !== 'processing' ||
    document.data.processingAttemptId !== operationId ||
    !isRecord(execution) || execution.version !== 1 || execution.operationId !== operationId
  ) return null;
  const pending = workflowPendingEffect(execution);
  if (!pending.valid) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  return { document, effect: pending.effect };
}

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
  const commerce = workflowOperationContext(args.env.COMMERCE_DB, args.signal, nowMs);
  const requestedUntilMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + WORKFLOW_EFFECT_LEASE_MS);
  const claimedEffect: AdminIrlRedeemFinalizeWorkflowPendingEffect = args.kind === 'create'
    ? { kind: 'create', untilMs: requestedUntilMs }
    : { kind: 'restart-claim', claimId: args.claimId, untilMs: requestedUntilMs };
  try {
    return await raceWithSignal(runCommerceTransaction<{ status: 'claimed' | 'busy' | 'changed' }>(
      commerce,
      async (transaction) => {
        const operation = await readProcessingWorkflowOperation(commerce, transaction, located.key, args.operationId);
        if (!operation) return { status: 'changed' as const };
        const { document, effect } = operation;
        if (
          args.kind === 'restart' && effect?.kind === 'restart-claim' &&
          effect.claimId === args.claimId
        ) {
          const renewedEffect = {
            ...effect,
            untilMs: Math.max(effect.untilMs, requestedUntilMs),
          };
          if (renewedEffect.untilMs === effect.untilMs) {
            return { status: 'claimed' as const };
          }
          await transaction.update(document.key, {
            [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: renewedEffect,
            [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
            updatedAt: commerceFieldValue.serverTimestamp(),
          });
          return { status: 'claimed' as const };
        }
        if (document.updateTime !== args.expectedRevision) {
          return { status: 'changed' as const };
        }
        if (
          effect?.kind === 'restart' ||
          ((effect?.kind === 'create' || effect?.kind === 'restart-claim') &&
            effect.untilMs > nowMs)
        ) {
          return { status: 'busy' as const };
        }
        await transaction.update(document.key, {
          [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: claimedEffect,
          [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
          updatedAt: commerceFieldValue.serverTimestamp(),
        });
        return { status: 'claimed' as const };
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
  const commerce = workflowOperationContext(args.env.COMMERCE_DB, args.signal, nowMs);
  try {
    return await raceWithSignal(runCommerceTransaction<{ status: 'dispatched' | 'changed' }>(
      commerce,
      async (transaction) => {
        const operation = await readProcessingWorkflowOperation(commerce, transaction, located.key, args.operationId);
        if (!operation) return { status: 'changed' as const };
        const { document, effect } = operation;
        if (effect?.kind === 'restart' && effect.claimId === args.claimId) {
          return { status: 'dispatched' as const };
        }
        if (effect?.kind !== 'restart-claim' || effect.claimId !== args.claimId) {
          return { status: 'changed' as const };
        }
        await transaction.update(document.key, {
          [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: {
            kind: 'restart',
            claimId: args.claimId,
            dispatchedAtMs: nowMs,
          },
          [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
          updatedAt: commerceFieldValue.serverTimestamp(),
        });
        return { status: 'dispatched' as const };
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
  const commerce = workflowOperationContext(args.env.COMMERCE_DB, args.signal, nowMs);
  const untilMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + WORKFLOW_EFFECT_LEASE_MS);
  try {
    return await raceWithSignal(runCommerceTransaction<{ status: 'retracted' | 'changed' }>(
      commerce,
      async (transaction) => {
        const operation = await readProcessingWorkflowOperation(commerce, transaction, located.key, args.operationId);
        if (!operation) return { status: 'changed' as const };
        const { document, effect } = operation;
        if (effect?.kind === 'restart-claim' && effect.claimId === args.claimId) {
          const renewedEffect = {
            ...effect,
            untilMs: Math.max(effect.untilMs, untilMs),
          };
          if (renewedEffect.untilMs === effect.untilMs) {
            return { status: 'retracted' as const };
          }
          await transaction.update(document.key, {
            [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: renewedEffect,
            [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
            updatedAt: commerceFieldValue.serverTimestamp(),
          });
          return { status: 'retracted' as const };
        }
        if (effect?.kind !== 'restart' || effect.claimId !== args.claimId) {
          return { status: 'changed' as const };
        }
        await transaction.update(document.key, {
          [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: {
            kind: 'restart-claim',
            claimId: args.claimId,
            untilMs,
          },
          [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
          updatedAt: commerceFieldValue.serverTimestamp(),
        });
        return { status: 'retracted' as const };
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
