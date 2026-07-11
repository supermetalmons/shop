import type { ResendInboundProcessingOutcome } from './resendInboundService.js';

export type ResendInboundHttpResponse = {
  status: 200 | 500 | 503;
  retryAfter?: string;
  body: string | Record<string, boolean>;
};

export function resendInboundHttpResponse(
  outcome: ResendInboundProcessingOutcome,
  nowMs = Date.now(),
): ResendInboundHttpResponse {
  if (outcome.kind === 'in_progress') {
    return {
      status: 503,
      retryAfter: String(Math.max(1, Math.ceil((outcome.leaseExpiresAt - nowMs) / 1000))),
      body: 'Resend inbound forwarding is already in progress',
    };
  }
  if (outcome.kind === 'failed_retryable') {
    return { status: 500, body: 'Unable to forward Resend inbound email' };
  }
  if (outcome.kind === 'forwarded') {
    return { status: 200, body: { received: true, forwarded: true, degraded: outcome.degraded } };
  }
  if (outcome.kind === 'duplicate') {
    return { status: 200, body: { received: true, forwarded: true, duplicate: true } };
  }
  if (outcome.kind === 'needs_review') {
    return { status: 200, body: { received: true, forwarded: false, needsReview: true } };
  }
  return { status: 200, body: { received: true, forwarded: false, failedPermanently: true } };
}
