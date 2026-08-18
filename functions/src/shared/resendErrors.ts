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

export function summarizeResendError(error: unknown): ResendErrorSummary {
  const value = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const name = typeof value.name === 'string' && value.name ? value.name : 'unknown_resend_error';
  const message = typeof value.message === 'string' && value.message ? value.message : 'Unknown Resend error';
  const statusCode = typeof value.statusCode === 'number' && Number.isFinite(value.statusCode) ? value.statusCode : null;
  return { name, message, statusCode };
}

export function isRetryableResendError(error: ResendErrorSummary): boolean {
  if (RETRYABLE_RESEND_ERROR_NAMES.has(error.name)) return true;
  if (error.name !== 'unknown_resend_error') return false;
  if (error.statusCode === 408 || error.statusCode === 409 || error.statusCode === 429) return true;
  return Boolean(error.statusCode && error.statusCode >= 500);
}
