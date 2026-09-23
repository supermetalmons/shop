import { D1CommerceRepository } from './commerceRepository.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';
import type { ApiErrorCode } from './dataAccess.js';

export type ReceiptClaimWorkflowFailure = {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
};

export function receiptClaimWorkflowContext(
  env: Pick<Env, 'COMMERCE_DB'>,
  signal: AbortSignal,
  nowMs = Date.now(),
): CommerceRepositoryContext {
  return { repository: new D1CommerceRepository(env.COMMERCE_DB), signal, nowMs };
}

export function logReceiptClaimWorkflow(entry: Record<string, unknown>): void {
  try {
    console.log({ event: 'receipt_claim_workflow', ...entry });
  } catch {}
}

export function receiptClaimWorkflowFailure(error: unknown): ReceiptClaimWorkflowFailure {
  if (error instanceof StripeReceiptClaimError) {
    return {
      code: error.code,
      message: error.message,
      retryable: ['aborted', 'deadline-exceeded', 'unavailable', 'internal', 'resource-exhausted'].includes(error.code),
    };
  }
  return {
    code: 'unavailable',
    message: 'Receipt claiming is temporarily unavailable. Retry with the same receiver address.',
    retryable: true,
  };
}
