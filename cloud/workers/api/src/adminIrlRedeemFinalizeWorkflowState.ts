import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { createAdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.js';
import { isRecord, ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';

export const WORKFLOW_EFFECT_LEASE_MS = 30_000;
export const WORKFLOW_EXECUTION_FIELD = 'workflowFinalizeV1';

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

export type AdminIrlRedeemFinalizeWorkflowPendingEffect =
  | { kind: 'create'; untilMs: number }
  | { kind: 'restart-claim'; claimId: string; untilMs: number }
  | { kind: 'restart'; claimId?: string; dispatchedAtMs: number };

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

export type AdminIrlRedeemFinalizeWorkflowStoredOperation = Readonly<{
  dropId: string;
  failure?: AdminIrlRedeemFinalizeWorkflowError;
  pendingEffect?: Readonly<AdminIrlRedeemFinalizeWorkflowPendingEffect>;
  revision: string;
  owner: string;
  requestId: string;
  status: string;
}>;

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

export function isAdminIrlRedeemFinalizeErrorCode(value: unknown): value is AdminIrlRedeemFinalizeErrorCode {
  return typeof value === 'string' && Object.hasOwn(WORKFLOW_ERROR_POLICY, value);
}

export function workflowErrorForCode(
  code: AdminIrlRedeemFinalizeErrorCode,
): AdminIrlRedeemFinalizeWorkflowError {
  return { code, ...WORKFLOW_ERROR_POLICY[code] };
}

function workflowErrorCode(error: unknown): AdminIrlRedeemFinalizeErrorCode {
  if (error instanceof AdminIrlRedeemFinalizeError) return error.code;
  if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) return error.code;
  return 'internal';
}

export function adminIrlRedeemFinalizeWorkflowError(
  error: unknown,
): AdminIrlRedeemFinalizeWorkflowError {
  return workflowErrorForCode(workflowErrorCode(error));
}

export function parseAdminIrlRedeemFinalizeWorkflowPayload(
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

export function parseWorkflowError(value: unknown): AdminIrlRedeemFinalizeWorkflowError | null {
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

export async function adminIrlRedeemFinalizeOperationIdForWallet(
  body: { dropId: string; requestId: string; transferSignature: string },
  wallet: string,
): Promise<string> {
  return createAdminIrlRedeemFinalizeOperationId([
    body.dropId,
    body.requestId,
    body.transferSignature,
    wallet,
  ]);
}

export function canonicalSignature(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const signature = value.trim();
  try {
    const decoded = bs58.decode(signature);
    return decoded.length === 64 && decoded.some((byte) => byte !== 0) ? signature : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalPublicKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return undefined;
  }
}

export function workflowPendingEffect(
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
