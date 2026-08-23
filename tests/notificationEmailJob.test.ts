import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_EMAIL_KINDS,
  NOTIFICATION_EMAIL_JOB_VERSION,
  NOTIFICATION_EMAIL_MAX_HTML_BYTES,
  NOTIFICATION_EMAIL_MAX_JOB_BYTES,
  NOTIFICATION_EMAIL_MAX_RECIPIENTS,
  NOTIFICATION_EMAIL_MAX_SUBJECT_CHARACTERS,
  NOTIFICATION_EMAIL_MAX_TEXT_BYTES,
  createNotificationEmailJobV1,
  isNotificationEmailJobV1,
  notificationEmailJobByteLength,
  type NotificationEmailKind,
} from '../shared/notificationEmailJob.ts';

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';

function job(kind: NotificationEmailKind = 'buyer_order_received') {
  return createNotificationEmailJobV1({
    jobId: JOB_ID,
    kind,
    idempotencyKey: kind === 'stripe_checkout_manual_review'
      ? 'card_nft_2:cs_test_123:stripe_manual_review'
      : `card_nft_2:123:${kind}`,
    recipients: ['Buyer@example.com'],
    subject: 'Subject',
    text: 'Text',
    html: '<p>HTML</p>',
    context: kind === 'stripe_checkout_manual_review'
      ? { dropId: 'card_nft_2', sessionId: 'cs_test_123' }
      : { dropId: 'card_nft_2', deliveryId: 123 },
  });
}

test('notification email contract accepts every supported kind', () => {
  for (const kind of NOTIFICATION_EMAIL_KINDS) assert.equal(isNotificationEmailJobV1(job(kind)), true, kind);
});

test('notification email contract rejects extra fields and malformed identities', () => {
  assert.equal(job().version, NOTIFICATION_EMAIL_JOB_VERSION);
  assert.equal(isNotificationEmailJobV1({ ...job(), extra: true }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), jobId: 'not-a-uuid' }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), idempotencyKey: '' }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), subject: 'x'.repeat(NOTIFICATION_EMAIL_MAX_SUBJECT_CHARACTERS + 1) }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), context: { dropId: 'card_nft_2', sessionId: 'wrong-shape' } }), false);
  assert.equal(isNotificationEmailJobV1({
    ...job('stripe_checkout_manual_review'),
    context: { dropId: 'card_nft_2', deliveryId: 123 },
  }), false);
});

test('notification email contract validates and deduplicates recipients', () => {
  assert.equal(isNotificationEmailJobV1({ ...job(), recipients: ['not an email'] }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), recipients: [' buyer@example.com'] }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), recipients: ['Buyer@example.com', 'buyer@example.com'] }), false);
  assert.equal(isNotificationEmailJobV1({
    ...job(),
    recipients: Array.from({ length: NOTIFICATION_EMAIL_MAX_RECIPIENTS + 1 }, (_, index) => `buyer${index}@example.com`),
  }), false);
});

test('notification email contract enforces body and serialized size limits', () => {
  assert.equal(isNotificationEmailJobV1({ ...job(), text: 'x'.repeat(NOTIFICATION_EMAIL_MAX_TEXT_BYTES + 1) }), false);
  assert.equal(isNotificationEmailJobV1({ ...job(), html: 'x'.repeat(NOTIFICATION_EMAIL_MAX_HTML_BYTES + 1) }), false);
  const nearLimit = {
    ...job(),
    text: 't'.repeat(NOTIFICATION_EMAIL_MAX_TEXT_BYTES),
    html: 'h'.repeat(NOTIFICATION_EMAIL_MAX_HTML_BYTES),
  };
  assert.ok(notificationEmailJobByteLength(nearLimit) > NOTIFICATION_EMAIL_MAX_JOB_BYTES);
  assert.equal(isNotificationEmailJobV1(nearLimit), false);
});

test('notification email job creation returns an independent strict value', () => {
  const recipients = ['buyer@example.com'];
  const context = { dropId: 'card_nft_2', deliveryId: 123 };
  const created = createNotificationEmailJobV1({
    kind: 'buyer_order_received',
    idempotencyKey: 'card_nft_2:123:order_received',
    recipients,
    subject: 'Subject',
    text: 'Text',
    html: '<p>HTML</p>',
    context,
  }, () => JOB_ID);
  recipients[0] = 'changed@example.com';
  context.dropId = 'changed';
  assert.equal(created.recipients[0], 'buyer@example.com');
  assert.equal(created.context.dropId, 'card_nft_2');
});
