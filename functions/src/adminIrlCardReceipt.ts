export type AdminIrlCardReceiptLookupErrorDisposition = 'indexing' | 'transient' | 'fatal';

export type DirectCardReceiptClaimRecoveryAction = 'finalize' | 'transfer' | 'wait';
export type DirectCardReceiptClaimSubmissionStatus = 'submitted' | 'not_landed';
export type DirectCardReceiptClaimSubmission = {
  signature: string;
  lastValidBlockHeight: number;
  submittedAtMs: number;
  status: DirectCardReceiptClaimSubmissionStatus;
};
export type DirectCardReceiptClaimTransferEvidence =
  | 'none'
  | 'verified'
  | 'rejected'
  | 'expired_unverified'
  | 'unresolved';
export const DIRECT_CARD_RECEIPT_CLAIM_ABSENCE_PROOF_MAX_AGE_MS = 15 * 60 * 1000;

export function activeDirectCardReceiptClaimSignatures(args: {
  receiptTxs: readonly string[];
  submissions: ReadonlyArray<{
    signature: string;
    status: DirectCardReceiptClaimSubmissionStatus;
  }>;
}): string[] {
  const notLanded = new Set(
    args.submissions
      .filter((submission) => submission?.status === 'not_landed')
      .map((submission) => String(submission?.signature || '').trim())
      .filter(Boolean),
  );
  return Array.from(
    new Set(args.receiptTxs.map((signature) => String(signature || '').trim()).filter(Boolean)),
  ).filter((signature) => !notLanded.has(signature));
}

export function directCardReceiptClaimHasRecipientLock(args: {
  hasRecipient: boolean;
  receiptTxCount: number;
}): boolean {
  return args.hasRecipient && args.receiptTxCount > 0;
}

export function shouldKeepDirectCardReceiptClaimProcessing(args: {
  resumingPreviousProcessingClaim: boolean;
  recipientOwnershipConfirmed: boolean;
}): boolean {
  return args.resumingPreviousProcessingClaim || args.recipientOwnershipConfirmed;
}

function normalizedErrorCode(err: unknown): string {
  return String((err as any)?.code || '')
    .trim()
    .toLowerCase()
    .replace(/^functions\//, '');
}

export function classifyDirectCardReceiptClaimTransferVerificationError(
  err: unknown,
): Extract<DirectCardReceiptClaimTransferEvidence, 'rejected' | 'unresolved'> {
  return normalizedErrorCode(err) === 'failed-precondition' ? 'rejected' : 'unresolved';
}

export function classifyDirectCardReceiptClaimSubmission(args: {
  signatureStatus: 'missing' | 'failed' | 'succeeded';
  currentBlockHeight: number;
  lastValidBlockHeight: number;
  submittedAtMs: number;
  nowMs: number;
}): 'not_landed' | 'expired_unverified' | 'unresolved' {
  if (args.signatureStatus === 'failed') return 'not_landed';
  if (args.signatureStatus !== 'missing') return 'unresolved';
  const currentBlockHeight = Math.floor(Number(args.currentBlockHeight));
  const lastValidBlockHeight = Math.floor(Number(args.lastValidBlockHeight));
  const submittedAtMs = Number(args.submittedAtMs);
  const nowMs = Number(args.nowMs);
  if (
    !Number.isFinite(currentBlockHeight) ||
    !Number.isFinite(lastValidBlockHeight) ||
    lastValidBlockHeight <= 0 ||
    !Number.isFinite(submittedAtMs) ||
    !Number.isFinite(nowMs)
  ) {
    return 'unresolved';
  }
  const ageMs = nowMs - submittedAtMs;
  if (currentBlockHeight <= lastValidBlockHeight || ageMs < 0) return 'unresolved';
  return ageMs <= DIRECT_CARD_RECEIPT_CLAIM_ABSENCE_PROOF_MAX_AGE_MS
    ? 'not_landed'
    : 'expired_unverified';
}

export function directCardReceiptClaimSubmissionProvesNoDelivery(args: {
  signatureStatus: 'missing' | 'failed' | 'succeeded';
  currentBlockHeight: number;
  lastValidBlockHeight: number;
  submittedAtMs: number;
  nowMs: number;
}): boolean {
  return classifyDirectCardReceiptClaimSubmission(args) === 'not_landed';
}

function errorStatus(err: unknown): number | null {
  const status = Number((err as any)?.details?.status ?? (err as any)?.status);
  return Number.isFinite(status) ? status : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String((err as any)?.message || err || '');
}

export function classifyAdminIrlCardReceiptLookupError(
  err: unknown,
): AdminIrlCardReceiptLookupErrorDisposition {
  const code = normalizedErrorCode(err);
  const status = errorStatus(err);
  const message = errorMessage(err);

  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|invalid api key|missing helius_api_key|check helius api key/i.test(message)
  ) {
    return 'fatal';
  }
  if (code === 'not-found' || status === 404) return 'indexing';
  if (
    code === 'unavailable' ||
    code === 'resource-exhausted' ||
    code === 'deadline-exceeded' ||
    err instanceof TypeError
  ) {
    return 'transient';
  }
  return 'fatal';
}

export function adminIrlCardReceiptProofHasIdentity(proof: unknown): boolean {
  if (!proof || typeof proof !== 'object') return false;
  const record = proof as { tree_id?: unknown; treeId?: unknown; root?: unknown };
  const treeId = String(record.tree_id ?? record.treeId ?? '').trim();
  const root = String(record.root ?? '').trim();
  return Boolean(treeId && root);
}

export function resolveDirectCardReceiptClaimRecoveryAction(args: {
  transferEvidence: DirectCardReceiptClaimTransferEvidence;
  recipientOwnsReceipt: boolean;
  adminOwnsReceipt: boolean;
}): DirectCardReceiptClaimRecoveryAction {
  if (args.transferEvidence === 'verified' || args.recipientOwnsReceipt) return 'finalize';
  // A live unresolved signature may still deliver. An expired-but-unverified
  // signature cannot newly land, so exact current admin ownership is enough to retry safely.
  if (args.transferEvidence === 'unresolved') return 'wait';
  if (args.adminOwnsReceipt) return 'transfer';
  return 'wait';
}
