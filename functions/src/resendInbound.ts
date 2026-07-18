import { createHash } from 'crypto';
import type {
  Attachment,
  AttachmentData,
  CreateEmailOptions,
  EmailReceivedEvent,
  GetReceivingEmailResponseSuccess,
} from 'resend';
import { normalizeNotificationEmailRecipient } from './notifications.js';
import { isRetryableResendError, summarizeResendError, type ResendErrorSummary } from './resendErrors.js';

export const RESEND_INBOUND_FORWARD_FROM = 'Mons Shop Forwarder <forwarder@support.mons.shop>';
export const RESEND_INBOUND_FORWARD_FROM_ADDRESS = 'forwarder@support.mons.shop';
const RESEND_INBOUND_PAYLOAD_VERSION = 'v1';
// Three waves at the provider's 15-second per-download timeout leave enough of
// the 120-second webhook budget for fetching, persistence, and the final send.
export const RESEND_INBOUND_MAX_ATTACHMENTS = 9;
export const RESEND_INBOUND_MAX_PAYLOAD_BYTES = 35_000_000;
const RESEND_INBOUND_BODY_EXCERPT_BYTES = 256 * 1024;
const RESEND_INBOUND_ATTACHMENT_CONCURRENCY = 3;

const EMPTY_BODY_TEXT = 'This forwarded email contained no text body.';

export type ResendInboundForwardRoute = {
  recipient: string;
  forwardTo: readonly string[];
};

const RESEND_INBOUND_FORWARD_ROUTES: readonly ResendInboundForwardRoute[] = [
  {
    recipient: 'notifications@support.mons.shop',
    forwardTo: ['ivan@ivan.lol'],
  },
];

type ResendReceivedEventDataCompat = EmailReceivedEvent['data'] & {
  received_for?: unknown;
};

export type ResendReceivedEventCompat = Omit<EmailReceivedEvent, 'data'> & {
  data: ResendReceivedEventDataCompat;
};

export type ResendInboundForwardPlan = {
  emailId: string;
  messageId: string;
  receivedAt: string;
  matchedRecipients: string[];
  forwardFrom: string;
  forwardTo: string[];
  payloadVersion: typeof RESEND_INBOUND_PAYLOAD_VERSION;
  idempotencyBaseKey: string;
};

export type ResendInboundRouteResult =
  | { kind: 'forward'; plan: ResendInboundForwardPlan }
  | { kind: 'ignored'; reason: 'recipient_not_configured' | 'loop_source' };

export type ResendWebhookHeaders = {
  id: string;
  timestamp: string;
  signature: string;
};

type ProviderResponse<T> =
  | { data: T; error: null }
  | { data: null; error: unknown };

export interface ResendInboundProvider {
  getEmail(emailId: string): Promise<ProviderResponse<GetReceivingEmailResponseSuccess>>;
  listAttachments(emailId: string): Promise<ProviderResponse<{ data: AttachmentData[]; has_more: boolean }>>;
  downloadAttachment(attachment: AttachmentData, signal?: AbortSignal): Promise<Buffer>;
  sendEmail(
    payload: CreateEmailOptions,
    idempotencyKey: string,
  ): Promise<ProviderResponse<{ id: string }>>;
}

export type PreparedResendInboundForward = {
  payload: CreateEmailOptions;
  payloadDigest: string;
  idempotencyKey: string;
  variant: 'full' | 'body_only';
  degradedReason?: string;
  bodyOnlyFallback?: Omit<PreparedResendInboundForward, 'bodyOnlyFallback'>;
};

export class ResendInboundProcessingError extends Error {
  readonly reason: string;
  readonly retryable: boolean;
  readonly providerError?: ResendErrorSummary;

  constructor(params: { reason: string; message: string; retryable: boolean; providerError?: ResendErrorSummary }) {
    super(params.message);
    this.name = 'ResendInboundProcessingError';
    this.reason = params.reason;
    this.retryable = params.retryable;
    this.providerError = params.providerError;
  }
}

export function normalizeResendInboundAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const angleAddress = trimmed.match(/<([^<>]+)>\s*$/)?.[1];
  return normalizeNotificationEmailRecipient(angleAddress || trimmed);
}

function normalizedAddressList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values
    .map(normalizeResendInboundAddress)
    .filter((address): address is string => Boolean(address));
}

function forwardingLoopAddresses(routes: readonly ResendInboundForwardRoute[]): Set<string> {
  const addresses = new Set<string>([RESEND_INBOUND_FORWARD_FROM_ADDRESS]);
  routes.forEach((route) => {
    const recipient = normalizeResendInboundAddress(route.recipient);
    if (recipient) addresses.add(recipient);
    route.forwardTo.forEach((rawAddress) => {
      const address = normalizeResendInboundAddress(rawAddress);
      if (address) addresses.add(address);
    });
  });
  return addresses;
}

export function planResendInboundForward(
  event: ResendReceivedEventCompat,
  routes: readonly ResendInboundForwardRoute[] = RESEND_INBOUND_FORWARD_ROUTES,
): ResendInboundRouteResult {
  const emailId = typeof event.data?.email_id === 'string' ? event.data.email_id.trim() : '';
  if (!emailId) throw new Error('Resend email.received event is missing email_id');

  const source = normalizeResendInboundAddress(event.data.from);
  if (source && forwardingLoopAddresses(routes).has(source)) {
    return { kind: 'ignored', reason: 'loop_source' };
  }

  const incomingRecipients = new Set(
    [event.data.to, event.data.cc, event.data.bcc, event.data.received_for].flatMap(normalizedAddressList),
  );
  const matchedRecipients = new Set<string>();
  const forwardTo = new Set<string>();

  for (const route of routes) {
    const recipient = normalizeResendInboundAddress(route.recipient);
    if (!recipient || !incomingRecipients.has(recipient)) continue;
    matchedRecipients.add(recipient);
    route.forwardTo.forEach((destination) => {
      const normalized = normalizeResendInboundAddress(destination);
      if (normalized) forwardTo.add(normalized);
    });
  }

  if (!matchedRecipients.size || !forwardTo.size) {
    return { kind: 'ignored', reason: 'recipient_not_configured' };
  }

  const digest = resendInboundForwardDocumentId(emailId);
  return {
    kind: 'forward',
    plan: {
      emailId,
      messageId: typeof event.data.message_id === 'string' ? event.data.message_id : '',
      receivedAt: typeof event.data.created_at === 'string' ? event.data.created_at : event.created_at,
      matchedRecipients: Array.from(matchedRecipients),
      forwardFrom: RESEND_INBOUND_FORWARD_FROM,
      forwardTo: Array.from(forwardTo),
      payloadVersion: RESEND_INBOUND_PAYLOAD_VERSION,
      idempotencyBaseKey: `resend-inbound-forward-${RESEND_INBOUND_PAYLOAD_VERSION}:${digest}`,
    },
  };
}

function requestHeader(req: any, name: string): string {
  const raw = req?.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name} header`);
  return value.trim();
}

export function resendWebhookHeaders(req: any): ResendWebhookHeaders {
  return {
    id: requestHeader(req, 'svix-id'),
    timestamp: requestHeader(req, 'svix-timestamp'),
    signature: requestHeader(req, 'svix-signature'),
  };
}

export function resendWebhookRawBody(req: any): string {
  const rawBody = req?.rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
  if (typeof rawBody === 'string') return rawBody;
  if (Buffer.isBuffer(req?.body)) return req.body.toString('utf8');
  if (typeof req?.body === 'string') return req.body;
  throw new Error('Missing raw request body for Resend webhook signature verification');
}

export function resendInboundForwardDocumentId(emailId: string): string {
  const normalized = emailId.trim();
  if (!normalized) throw new Error('Cannot build a Resend inbound forwarding document id without an email id');
  return createHash('sha256').update(normalized).digest('hex');
}

export function summarizeResendInboundError(error: unknown): {
  reason: string;
  retryable: boolean;
  error: ResendErrorSummary | { name: string; message: string; statusCode: null };
} {
  if (error instanceof ResendInboundProcessingError) {
    return {
      reason: error.reason,
      retryable: error.retryable,
      error: error.providerError || { name: error.name, message: error.message, statusCode: null },
    };
  }
  if (error instanceof Error) {
    return {
      reason: 'inbound_processing_error',
      retryable: true,
      error: { name: error.name, message: error.message, statusCode: null },
    };
  }
  if (error && typeof error === 'object' && ('name' in error || 'statusCode' in error)) {
    const providerError = summarizeResendError(error);
    return {
      reason: providerError.name,
      retryable: isRetryableResendError(providerError),
      error: providerError,
    };
  }
  return {
    reason: 'inbound_processing_error',
    retryable: true,
    error: { name: typeof error, message: String(error), statusCode: null },
  };
}

function providerFailure(reason: string, error: unknown): ResendInboundProcessingError {
  const providerError = summarizeResendError(error);
  return new ResendInboundProcessingError({
    reason,
    message: providerError.message,
    retryable: isRetryableResendError(providerError),
    providerError,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '');
}

function normalizedReplyTo(email: GetReceivingEmailResponseSuccess, plan: ResendInboundForwardPlan): string[] {
  const excluded = new Set<string>([
    RESEND_INBOUND_FORWARD_FROM_ADDRESS,
    ...plan.matchedRecipients,
    ...plan.forwardTo,
  ]);
  const explicit = normalizedAddressList(email.reply_to).filter((address) => !excluded.has(address));
  if (explicit.length) return Array.from(new Set(explicit));
  const sender = normalizeResendInboundAddress(email.from);
  return sender && !excluded.has(sender) ? [sender] : [];
}

function forwardBanner(params: {
  email: GetReceivingEmailResponseSuccess;
  replyAvailable: boolean;
  warning?: string;
}): { text: string; html: string } {
  const recipientText = params.email.to.join(', ') || '(unknown)';
  const warnings = [
    params.warning,
    ...(!params.replyAvailable ? ['Reply address unavailable; use the original sender shown below.'] : []),
  ].filter((value): value is string => Boolean(value));
  const textLines = [
    'Forwarded message',
    `From: ${params.email.from || '(unknown)'}`,
    `To: ${recipientText}`,
    `Subject: ${params.email.subject || '(no subject)'}`,
    ...warnings.map((warning) => `Warning: ${warning}`),
    '',
  ];
  const warningHtml = warnings
    .map((warning) => `<div style="color:#a33"><strong>Warning:</strong> ${escapeHtml(warning)}</div>`)
    .join('');
  return {
    text: textLines.join('\n'),
    html:
      '<div style="font-family:Arial,sans-serif;font-size:13px;color:#444;border-left:3px solid #bbb;padding:8px 12px;margin-bottom:16px">' +
      '<strong>Forwarded message</strong><br>' +
      `From: ${escapeHtml(params.email.from || '(unknown)')}<br>` +
      `To: ${escapeHtml(recipientText)}<br>` +
      `Subject: ${escapeHtml(params.email.subject || '(no subject)')}<br>` +
      warningHtml +
      '</div>',
  };
}

function buildPayload(params: {
  email: GetReceivingEmailResponseSuccess;
  plan: ResendInboundForwardPlan;
  replyTo: string[];
  attachments?: Attachment[];
  warning?: string;
  truncateBody?: boolean;
}): CreateEmailOptions {
  const banner = forwardBanner({
    email: params.email,
    replyAvailable: params.replyTo.length > 0,
    warning: params.warning,
  });
  const originalText = params.email.text || EMPTY_BODY_TEXT;
  const textBody = params.truncateBody
    ? truncateUtf8(originalText, RESEND_INBOUND_BODY_EXCERPT_BYTES) + '\n\n[Original message truncated.]'
    : originalText;
  const originalHtml = params.truncateBody
    ? `<pre style="white-space:pre-wrap">${escapeHtml(textBody)}</pre>`
    : params.email.html || `<pre style="white-space:pre-wrap">${escapeHtml(originalText)}</pre>`;
  return {
    from: params.plan.forwardFrom,
    to: params.plan.forwardTo,
    subject: params.email.subject?.trim() || '(no subject)',
    text: `${banner.text}${textBody}`,
    html: `${banner.html}${originalHtml}`,
    ...(params.replyTo.length ? { replyTo: params.replyTo } : {}),
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
  };
}

function resendInboundPayloadDigest(payload: CreateEmailOptions): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function resendInboundPayloadBytes(payload: CreateEmailOptions): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function bodyOnlyPrepared(params: {
  email: GetReceivingEmailResponseSuccess;
  plan: ResendInboundForwardPlan;
  replyTo: string[];
  reason: string;
}): PreparedResendInboundForward {
  const bodyOnlyWarning =
    params.reason === 'message_too_large' && !params.email.attachments.length
      ? 'The original message body was too large and has been truncated. The complete original remains available in Resend.'
      : 'Attachments were omitted. The complete original remains available in Resend.';
  let payload = buildPayload({
    email: params.email,
    plan: params.plan,
    replyTo: params.replyTo,
    warning: bodyOnlyWarning,
  });
  if (resendInboundPayloadBytes(payload) > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
    payload = buildPayload({
      email: params.email,
      plan: params.plan,
      replyTo: params.replyTo,
      warning: 'Attachments were omitted and the original message body was truncated. The complete original remains available in Resend.',
      truncateBody: true,
    });
  }
  if (resendInboundPayloadBytes(payload) > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
    throw new ResendInboundProcessingError({
      reason: 'message_body_too_large',
      message: 'The bounded forwarding excerpt still exceeded the send payload limit',
      retryable: false,
    });
  }
  return {
    payload,
    payloadDigest: resendInboundPayloadDigest(payload),
    idempotencyKey: `${params.plan.idempotencyBaseKey}:body-only`,
    variant: 'body_only',
    degradedReason: params.reason,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const controller = new AbortController();
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!controller.signal.aborted && nextIndex < values.length) {
      const index = nextIndex++;
      try {
        const result = await mapper(values[index], index, controller.signal);
        if (!controller.signal.aborted) results[index] = result;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          controller.abort();
        }
        break;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

function normalizedContentId(contentId: string | undefined): string | undefined {
  const normalized = contentId?.trim().replace(/^<|>$/g, '');
  return normalized || undefined;
}

export async function prepareResendInboundForward(params: {
  plan: ResendInboundForwardPlan;
  provider: ResendInboundProvider;
}): Promise<PreparedResendInboundForward> {
  const emailResult = await params.provider.getEmail(params.plan.emailId);
  if (emailResult.error) throw providerFailure('received_email_fetch_failed', emailResult.error);
  const email = emailResult.data;
  const replyTo = normalizedReplyTo(email, params.plan);
  const basePayload = buildPayload({ email, plan: params.plan, replyTo });
  const bodyOnlyFallback = bodyOnlyPrepared({
    email,
    plan: params.plan,
    replyTo,
    reason: 'attachment_forwarding_failed',
  });

  if (!email.attachments.length) {
    if (resendInboundPayloadBytes(basePayload) > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
      return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: 'message_too_large' });
    }
    return {
      payload: basePayload,
      payloadDigest: resendInboundPayloadDigest(basePayload),
      idempotencyKey: params.plan.idempotencyBaseKey,
      variant: 'full',
    };
  }

  if (email.attachments.length > RESEND_INBOUND_MAX_ATTACHMENTS) {
    return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: 'too_many_attachments' });
  }

  const attachmentsResult = await params.provider.listAttachments(params.plan.emailId);
  if (attachmentsResult.error) {
    const failure = providerFailure('attachment_list_failed', attachmentsResult.error);
    if (failure.retryable) throw failure;
    return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: failure.reason });
  }
  if (attachmentsResult.data.has_more || attachmentsResult.data.data.length > RESEND_INBOUND_MAX_ATTACHMENTS) {
    return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: 'too_many_attachments' });
  }

  const signedById = new Map(attachmentsResult.data.data.map((attachment) => [attachment.id, attachment]));
  const ordered = email.attachments.map((attachment) => signedById.get(attachment.id));
  if (ordered.some((attachment) => !attachment)) {
    throw new ResendInboundProcessingError({
      reason: 'attachment_metadata_mismatch',
      message: 'Received attachment metadata did not match the attachment download list',
      retryable: true,
    });
  }

  const basePayloadBytes = resendInboundPayloadBytes(basePayload);
  const estimatedAttachmentBytes = ordered.reduce(
    (total, attachment) => total + 4 * Math.ceil((attachment?.size || 0) / 3),
    0,
  );
  if (basePayloadBytes + estimatedAttachmentBytes > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
    return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: 'message_too_large' });
  }

  let attachments: Attachment[];
  let projectedPayloadBytes = basePayloadBytes + Buffer.byteLength(',"attachments":[]', 'utf8');
  let projectedAttachmentCount = 0;
  try {
    attachments = await mapWithConcurrency(
      ordered as AttachmentData[],
      RESEND_INBOUND_ATTACHMENT_CONCURRENCY,
      async (attachment, _index, signal) => {
        const bytes = await params.provider.downloadAttachment(attachment, signal);
        signal.throwIfAborted();
        const contentId = normalizedContentId(attachment.content_id);
        const attachmentWithoutContent: Attachment = {
          content: '',
          filename: attachment.filename || false,
          contentType: attachment.content_type,
          ...(contentId ? { contentId } : {}),
        };
        const encodedBytes = 4 * Math.ceil(bytes.length / 3);
        const attachmentBytes = Buffer.byteLength(JSON.stringify(attachmentWithoutContent), 'utf8') + encodedBytes;
        const separatorBytes = projectedAttachmentCount ? 1 : 0;
        if (projectedPayloadBytes + separatorBytes + attachmentBytes > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
          throw new ResendInboundProcessingError({
            reason: 'message_too_large',
            message: 'Downloaded attachments exceeded the forwarding size limit',
            retryable: false,
          });
        }
        projectedPayloadBytes += separatorBytes + attachmentBytes;
        projectedAttachmentCount += 1;
        return { ...attachmentWithoutContent, content: bytes.toString('base64') };
      },
    );
  } catch (error) {
    const summarized = summarizeResendInboundError(error);
    if (summarized.retryable) throw error;
    return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: summarized.reason });
  }

  const payload = buildPayload({ email, plan: params.plan, replyTo, attachments });
  if (resendInboundPayloadBytes(payload) > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
    return bodyOnlyPrepared({ email, plan: params.plan, replyTo, reason: 'message_too_large' });
  }
  return {
    payload,
    payloadDigest: resendInboundPayloadDigest(payload),
    idempotencyKey: params.plan.idempotencyBaseKey,
    variant: 'full',
    bodyOnlyFallback,
  };
}
