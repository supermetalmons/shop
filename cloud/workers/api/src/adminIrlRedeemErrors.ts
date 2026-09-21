import { AdminIrlRedeemFinalizeError } from './adminIrlRedeemFinalizeWorkflowState.js';
import { type ApiErrorCode } from './dataAccess.js';

type AdminIrlRedeemPrepareErrorCode = ApiErrorCode;

export class AdminIrlRedeemPrepareError extends Error {
  constructor(
    readonly code: AdminIrlRedeemPrepareErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminIrlRedeemPrepareError';
  }
}
export class PendingFinalizeSubmissionError extends AdminIrlRedeemFinalizeError {
  constructor(cause?: unknown) {
    super('aborted', 'A submitted Admin IRL redeem transaction is still being reconciled.');
    this.name = 'PendingFinalizeSubmissionError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}
