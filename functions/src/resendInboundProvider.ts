import type { Resend } from 'resend';
import {
  RESEND_INBOUND_MAX_PAYLOAD_BYTES,
  ResendInboundProcessingError,
  type ResendInboundProvider,
} from './resendInbound.js';

const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000;

function retryableDownloadStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ResendInboundProcessingError({
      reason: 'attachment_download_failed',
      message: 'Attachment response did not expose a bounded readable stream',
      retryable: true,
    });
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
        await reader.cancel();
        throw new ResendInboundProcessingError({
          reason: 'attachment_too_large',
          message: 'Attachment download exceeded the forwarding size limit',
          retryable: false,
        });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export function createResendInboundProvider(
  resend: Resend,
  fetchImpl: typeof fetch = fetch,
): ResendInboundProvider {
  return {
    async getEmail(emailId) {
      return resend.emails.receiving.get(emailId);
    },
    async listAttachments(emailId) {
      const result = await resend.emails.receiving.attachments.list({
        emailId,
        limit: 100,
      });
      if (result.error) return { data: null, error: result.error };
      return {
        data: {
          data: result.data.data,
          has_more: result.data.has_more,
        },
        error: null,
      };
    },
    async downloadAttachment(attachment, signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetchImpl(attachment.download_url, { signal: controller.signal });
        if (!response.ok) {
          throw new ResendInboundProcessingError({
            reason: 'attachment_download_failed',
            message: `Attachment download returned HTTP ${response.status}`,
            retryable: retryableDownloadStatus(response.status),
          });
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > RESEND_INBOUND_MAX_PAYLOAD_BYTES) {
          throw new ResendInboundProcessingError({
            reason: 'attachment_too_large',
            message: 'Attachment download exceeded the forwarding size limit',
            retryable: false,
          });
        }
        return readBoundedResponse(response);
      } catch (error) {
        if (error instanceof ResendInboundProcessingError) throw error;
        throw new ResendInboundProcessingError({
          reason: 'attachment_download_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    },
    async sendEmail(payload, idempotencyKey) {
      const result = await resend.emails.send(payload, { idempotencyKey });
      return result.error
        ? { data: null, error: result.error }
        : { data: { id: result.data.id }, error: null };
    },
  };
}
