export type ResendErrorSummary = {
  name: string;
  message: string;
  statusCode: number | null;
};

const RETRYABLE_RESEND_ERROR_NAMES = new Set([
  'application_error',
  'concurrent_idempotent_requests',
  'daily_quota_exceeded',
  'internal_server_error',
  'monthly_quota_exceeded',
  'rate_limit_exceeded',
]);

export function summarizeResendError(error: any): ResendErrorSummary {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'unknown_resend_error';
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Unknown Resend error';
  const statusCode = typeof error?.statusCode === 'number' && Number.isFinite(error.statusCode) ? error.statusCode : null;
  return { name, message, statusCode };
}

export function isRetryableResendError(error: ResendErrorSummary): boolean {
  if (RETRYABLE_RESEND_ERROR_NAMES.has(error.name)) return true;
  if (error.name !== 'unknown_resend_error') return false;
  if (error.statusCode === 408 || error.statusCode === 409 || error.statusCode === 429) return true;
  return Boolean(error.statusCode && error.statusCode >= 500);
}
