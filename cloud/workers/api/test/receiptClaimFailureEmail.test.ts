import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReceiptClaimManualReviewEmailContent, type ReceiptClaimManualReviewEmailMessage } from '../src/notificationEmails.ts';
import { createNotificationEmailJobV1, NOTIFICATION_MANUAL_REVIEW_EMAIL } from '../../../../shared/notificationEmailJob.ts';
import { processNotificationEmailMessage } from '../src/notificationEmailConsumer.ts';

const message: ReceiptClaimManualReviewEmailMessage = {
  dropId: 'card_nft_2', dropName: 'Card NFT 2 <Drop>', cluster: 'mainnet-beta', deliveryId: 123, boxId: 445,
  recipient: '11111111111111111111111111111111', incidentId: 'src-v1-123e4567-e89b-42d3-a456-426614174000:g1',
  incidentKind: 'terminal', operationId: 'src-v1-123e4567-e89b-42d3-a456-426614174000', generation: 1,
  startedAtMs: Date.UTC(2026, 9, 20, 12), failedAtMs: Date.UTC(2026, 9, 20, 12, 15),
  errorCode: 'deadline-exceeded', transactionStatus: 'unresolved', transactionSignature: 'test-signature',
};

test('receipt failure email identifies digital delivery and escapes operational details', () => {
  const content = buildReceiptClaimManualReviewEmailContent(message);
  assert.match(content.subject, /Receipt claim needs review.*445/);
  assert.match(content.text, /15-minute recovery window/);
  assert.match(content.text, /Delivery ID: 123/);
  assert.match(content.text, /Transaction: test-signature/);
  assert.match(content.text, /Transaction state: unresolved/);
  assert.match(content.text, /does not change the physical shipment or refund status/);
  assert.match(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.doesNotMatch(content.html, /<Drop>/);
  assert.match(content.html, /https:\/\/mons.shop\/fulfillment\?dropId=card_nft_2/);
});

test('legacy failure email does not invent a historical error or serialize unapproved fields', () => {
  const content = buildReceiptClaimManualReviewEmailContent({
    ...message, incidentKind: 'legacy', operationId: undefined, generation: undefined,
    errorCode: 'secret-code-in-untrusted-error',
    ...{ claimCode: 'ABCDEF-1234567890', signedTransactionBase64: 'private-signed-bytes', errorMessage: 'private provider details' },
  });
  assert.match(content.text, /original failure was not recorded/);
  assert.match(content.text, /legacy claim; no Workflow/);
  assert.doesNotMatch(JSON.stringify(content), /ABCDEF|private-signed|private provider|secret-code/);
});

test('receipt failure email uses the existing consumer and stable idempotency identity', async () => {
  const content = buildReceiptClaimManualReviewEmailContent(message);
  const job = createNotificationEmailJobV1({
    kind: 'receipt_claim_manual_review', idempotencyKey: `receipt-claim:${message.incidentId}`,
    recipients: [NOTIFICATION_MANUAL_REVIEW_EMAIL], ...content,
    context: { dropId: message.dropId, deliveryId: message.deliveryId },
  });
  const sent: string[] = [];
  const logs: unknown[] = [];
  const queued = { id: 'queue-message', body: job, attempts: 1 };
  const result = await processNotificationEmailMessage(queued, { RESEND_API_KEY: 'test' }, {
    send: async received => { sent.push(received.idempotencyKey); return { data: { id: 'email-id' }, error: null }; },
    log: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value),
  });
  assert.deepEqual(result, { outcome: 'complete' });
  assert.deepEqual(sent, [job.idempotencyKey]);
  assert.deepEqual(job.recipients, ['development@support.mons.shop']);
  assert.match(JSON.stringify(logs), /notification_email_sent/);
  assert.doesNotMatch(JSON.stringify(logs), /test-signature|11111111111111111111111111111111/);
});
