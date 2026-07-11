import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEND_INBOUND_FORWARD_FROM,
  RESEND_INBOUND_FORWARD_FROM_ADDRESS,
  RESEND_INBOUND_MAX_ATTACHMENTS,
  ResendInboundProcessingError,
  normalizeResendInboundAddress,
  planResendInboundForward,
  prepareResendInboundForward,
  resendInboundForwardDocumentId,
  resendWebhookHeaders,
  resendWebhookRawBody,
  type ResendInboundForwardPlan,
  type ResendInboundProvider,
} from '../functions/src/resendInbound.ts';
import { processResendInboundForward, type ResendInboundStore } from '../functions/src/resendInboundService.ts';
import { resendInboundHttpResponse } from '../functions/src/resendInboundHttp.ts';
import { createResendInboundProvider } from '../functions/src/resendInboundProvider.ts';

function receivedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'email.received',
    created_at: '2026-07-10T12:00:00.000Z',
    data: {
      email_id: 'received-email-123',
      created_at: '2026-07-10T12:00:00.000Z',
      from: 'Buyer <buyer@example.com>',
      to: ['notifications@support.mons.shop'],
      bcc: [],
      cc: [],
      message_id: '<message-123@example.com>',
      subject: 'Order question',
      attachments: [],
      ...overrides,
    },
  } as any;
}

function forwardPlan(event = receivedEvent()): ResendInboundForwardPlan {
  const result = planResendInboundForward(event);
  assert.equal(result.kind, 'forward');
  return result.plan;
}

function receivedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'received-email-123',
    to: ['notifications@support.mons.shop'],
    from: 'Buyer <buyer@example.com>',
    created_at: '2026-07-10T12:00:00.000Z',
    subject: 'Question <urgent>',
    bcc: [],
    cc: [],
    reply_to: ['Replies <reply@example.com>'],
    html: '<p>Hello <img src="cid:image-one"></p>',
    text: 'Hello',
    headers: {},
    message_id: '<message-123@example.com>',
    attachments: [],
    ...overrides,
  } as any;
}

function attachment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    filename: `${id}.txt`,
    content_type: 'text/plain',
    content_disposition: 'attachment',
    content_id: null,
    size: 4,
    download_url: `https://example.test/${id}`,
    expires_at: '2026-07-10T13:00:00.000Z',
    ...overrides,
  } as any;
}

function provider(params: {
  email?: any;
  listed?: any[];
  hasMore?: boolean;
  download?: (item: any) => Promise<Buffer>;
  send?: ResendInboundProvider['sendEmail'];
} = {}): ResendInboundProvider {
  const email = params.email || receivedEmail();
  return {
    async getEmail() {
      return { data: email, error: null };
    },
    async listAttachments() {
      return { data: { data: params.listed || [], has_more: Boolean(params.hasMore) }, error: null };
    },
    downloadAttachment: params.download || (async (item) => Buffer.from(item.id)),
    sendEmail: params.send || (async () => ({ data: { id: 'forwarded-1' }, error: null })),
  };
}

test('inbound address normalization accepts direct/display-name addresses and rejects malformed input', () => {
  assert.equal(normalizeResendInboundAddress(' Notifications@Support.Mons.Shop '), 'notifications@support.mons.shop');
  assert.equal(normalizeResendInboundAddress('Mons <Notifications@Support.Mons.Shop>'), 'notifications@support.mons.shop');
  assert.equal(normalizeResendInboundAddress('not an address'), null);
  assert.equal(normalizeResendInboundAddress(undefined), null);
});

test('routing matches the normalized union of to, cc, bcc, and scalar received_for exactly once', () => {
  for (const field of ['to', 'cc', 'bcc', 'received_for']) {
    const result = planResendInboundForward(
      receivedEvent({ to: [], cc: [], bcc: [], received_for: [], [field]: 'Notifications@Support.Mons.Shop' }),
    );
    assert.equal(result.kind, 'forward', field);
    if (result.kind === 'forward') {
      assert.deepEqual(result.plan.matchedRecipients, ['notifications@support.mons.shop']);
      assert.deepEqual(result.plan.forwardTo, ['ivan@ivan.lol']);
    }
  }
  assert.equal(planResendInboundForward(receivedEvent({ to: ['other@support.mons.shop'] })).kind, 'ignored');
});

test('routing ignores malformed recipient fields and forwarding loop sources', () => {
  assert.equal(planResendInboundForward(receivedEvent({ to: 42, cc: {}, bcc: null })).kind, 'ignored');
  for (const from of ['ivan@ivan.lol', RESEND_INBOUND_FORWARD_FROM_ADDRESS, 'notifications@support.mons.shop']) {
    assert.deepEqual(planResendInboundForward(receivedEvent({ from })), { kind: 'ignored', reason: 'loop_source' });
  }
});

test('routing freezes deterministic delivery metadata and rejects missing email ids', () => {
  const result = planResendInboundForward(receivedEvent());
  assert.equal(result.kind, 'forward');
  if (result.kind === 'forward') {
    assert.equal(result.plan.forwardFrom, RESEND_INBOUND_FORWARD_FROM);
    assert.match(result.plan.idempotencyBaseKey, /^resend-inbound-forward-v1:[a-f0-9]{64}$/);
  }
  assert.throws(() => planResendInboundForward(receivedEvent({ email_id: ' ' })), /missing email_id/);
});

test('webhook helpers preserve the signed raw body and require Svix headers', () => {
  const rawBody = '{"type":"email.received","data":{"email_id":"123"}}';
  const request = {
    rawBody: Buffer.from(rawBody),
    body: { parsed: true },
    headers: {
      'svix-id': ['msg_123', 'ignored'],
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,signature',
    },
  };
  assert.equal(resendWebhookRawBody(request), rawBody);
  assert.deepEqual(resendWebhookHeaders(request), {
    id: 'msg_123',
    timestamp: '1234567890',
    signature: 'v1,signature',
  });
  assert.throws(() => resendWebhookHeaders({ headers: {} }), /Missing svix-id header/);
  assert.throws(() => resendWebhookRawBody({ body: { parsed: true } }), /Missing raw request body/);
});

test('document ids are stable and Firestore-safe', () => {
  const first = resendInboundForwardDocumentId(' received-email-123 ');
  assert.equal(first, resendInboundForwardDocumentId('received-email-123'));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, resendInboundForwardDocumentId('received-email-456'));
});

test('prepared forwarding preserves explicit Reply-To and escapes the original-message banner', async () => {
  const prepared = await prepareResendInboundForward({ plan: forwardPlan(), provider: provider() });
  const payload = prepared.payload as any;
  assert.deepEqual(payload.replyTo, ['reply@example.com']);
  assert.match(payload.html, /Question &lt;urgent&gt;/);
  assert.doesNotMatch(payload.html, /Question <urgent>/);
  assert.match(payload.text, /From: Buyer <buyer@example.com>/);
  assert.equal(prepared.idempotencyKey, forwardPlan().idempotencyBaseKey);
});

test('Reply-To falls back to sender, excludes loops, and shows a visible warning when unavailable', async () => {
  const fallback = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({ email: receivedEmail({ reply_to: [] }) }),
  });
  assert.deepEqual((fallback.payload as any).replyTo, ['buyer@example.com']);

  const unavailable = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({ email: receivedEmail({ reply_to: ['ivan@ivan.lol'], from: 'forwarder@support.mons.shop' }) }),
  });
  assert.equal((unavailable.payload as any).replyTo, undefined);
  assert.match((unavailable.payload as any).text, /Reply address unavailable/);
  assert.match((unavailable.payload as any).html, /Reply address unavailable/);
});

test('attachments retain inbound order, deterministic Base64, and normalized inline content IDs', async () => {
  const first = attachment('first', { content_id: '<image-one>' });
  const second = attachment('second');
  const prepared = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({
      email: receivedEmail({ attachments: [first, second] }),
      listed: [second, first],
      download: async (item) => Buffer.from(`bytes:${item.id}`),
    }),
  });
  const attachments = (prepared.payload as any).attachments;
  assert.deepEqual(attachments.map((item: any) => item.filename), ['first.txt', 'second.txt']);
  assert.equal(attachments[0].content, Buffer.from('bytes:first').toString('base64'));
  assert.equal(attachments[0].contentId, 'image-one');
  assert.equal(attachments[1].contentId, undefined);
});

test('attachment pagination/count overflow and permanent download failures degrade to body-only', async () => {
  const item = attachment('one');
  const paged = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({ email: receivedEmail({ attachments: [item] }), listed: [item], hasMore: true }),
  });
  assert.equal(paged.variant, 'body_only');
  assert.equal(paged.degradedReason, 'too_many_attachments');
  assert.match((paged.payload as any).text, /Attachments were omitted/);

  const failed = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({
      email: receivedEmail({ attachments: [item] }),
      listed: [item],
      download: async () => {
        throw new ResendInboundProcessingError({ reason: 'attachment_gone', message: 'gone', retryable: false });
      },
    }),
  });
  assert.equal(failed.variant, 'body_only');
  assert.equal(failed.degradedReason, 'attachment_gone');

  const listFailureProvider = provider({ email: receivedEmail({ attachments: [item] }) });
  listFailureProvider.listAttachments = async () => ({
    data: null,
    error: { name: 'validation_error', message: 'attachment metadata unavailable', statusCode: 422 },
  });
  const listFailed = await prepareResendInboundForward({ plan: forwardPlan(), provider: listFailureProvider });
  assert.equal(listFailed.variant, 'body_only');
  assert.equal(listFailed.degradedReason, 'attachment_list_failed');
});

test('attachment count is bounded to the webhook execution budget', async () => {
  assert.equal(RESEND_INBOUND_MAX_ATTACHMENTS, 9);
  const items = Array.from({ length: RESEND_INBOUND_MAX_ATTACHMENTS + 1 }, (_, index) => attachment(`item-${index}`));
  let listed = false;
  const boundedProvider = provider({ email: receivedEmail({ attachments: items }) });
  boundedProvider.listAttachments = async () => {
    listed = true;
    return { data: { data: items, has_more: false }, error: null };
  };

  const prepared = await prepareResendInboundForward({ plan: forwardPlan(), provider: boundedProvider });
  assert.equal(prepared.variant, 'body_only');
  assert.equal(prepared.degradedReason, 'too_many_attachments');
  assert.equal(listed, false, 'known attachment overflow should not start provider work');
});

test('actual attachment bytes are bounded when provider size metadata is underreported', async () => {
  const items = [attachment('one', { size: 1 }), attachment('two', { size: 1 }), attachment('three', { size: 1 })];
  const prepared = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({
      email: receivedEmail({ attachments: items }),
      listed: items,
      download: async () => Buffer.alloc(9_000_000),
    }),
  });

  assert.equal(prepared.variant, 'body_only');
  assert.equal(prepared.degradedReason, 'message_too_large');
  assert.equal((prepared.payload as any).attachments, undefined);
});

test('a failed attachment aborts active workers and stops scheduling new downloads', async () => {
  const items = Array.from({ length: 6 }, (_, index) => attachment(`item-${index}`));
  let started = 0;
  let active = 0;
  const downloadAttachment: ResendInboundProvider['downloadAttachment'] = async (item, signal) => {
    started += 1;
    active += 1;
    try {
      if (item.id === 'item-0') {
        throw new ResendInboundProcessingError({ reason: 'attachment_gone', message: 'gone', retryable: false });
      }
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('aborted'));
        else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return Buffer.alloc(1);
    } finally {
      active -= 1;
    }
  };
  const prepared = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({
      email: receivedEmail({ attachments: items }),
      listed: items,
      download: downloadAttachment,
    }),
  });

  assert.equal(prepared.variant, 'body_only');
  assert.equal(prepared.degradedReason, 'attachment_gone');
  assert.equal(started, 3, 'only the initial concurrency window should start');
  assert.equal(active, 0, 'preparation should wait for active downloads to settle');
});

test('temporary attachment failures remain retryable and do not silently omit data', async () => {
  const item = attachment('one');
  await assert.rejects(
    prepareResendInboundForward({
      plan: forwardPlan(),
      provider: provider({
        email: receivedEmail({ attachments: [item] }),
        listed: [item],
        download: async () => {
          throw new ResendInboundProcessingError({ reason: 'download_timeout', message: 'timeout', retryable: true });
        },
      }),
    }),
    (error: any) => error.reason === 'download_timeout' && error.retryable === true,
  );
});

test('oversized body is reduced to a bounded plain-text excerpt', async () => {
  const huge = 'x'.repeat(18_000_000);
  const prepared = await prepareResendInboundForward({
    plan: forwardPlan(),
    provider: provider({ email: receivedEmail({ text: huge, html: null }) }),
  });
  assert.equal(prepared.variant, 'body_only');
  assert.equal(prepared.degradedReason, 'message_too_large');
  assert.ok(Buffer.byteLength((prepared.payload as any).text) < 300_000);
  assert.match((prepared.payload as any).text, /Original message truncated/);
});

class MemoryStore implements ResendInboundStore {
  reservation: any;
  prepared: any[] = [];
  successes: any[] = [];
  failures: any[] = [];
  throwOnSuccess = false;

  constructor(plan: ResendInboundForwardPlan, prepared?: any) {
    this.reservation = {
      kind: 'reserved', attemptId: 'attempt-1', plan, attempts: 1, unresolvedProviderAttempt: false, prepared,
    };
  }
  async reserve() { return this.reservation; }
  async recordPrepared(value: any) { this.prepared.push(value); return 'prepared' as const; }
  async recordSuccess(value: any) {
    this.successes.push(value);
    if (this.throwOnSuccess) throw new Error('Firestore unavailable');
    return 'recorded' as const;
  }
  async recordFailure(value: any) { this.failures.push(value); return 'recorded' as const; }
}

test('service reuses the provider key after success followed by a Firestore failure', async () => {
  const plan = forwardPlan();
  const sentKeys: string[] = [];
  const firstStore = new MemoryStore(plan);
  firstStore.throwOnSuccess = true;
  const firstProvider = provider({ send: async (_payload, key) => {
    sentKeys.push(key);
    return { data: { id: 'provider-id' }, error: null };
  } });
  await assert.rejects(processResendInboundForward({
    plan,
    webhookId: 'webhook-1',
    provider: firstProvider,
    store: firstStore,
    now: () => 1_000,
    newAttemptId: () => 'attempt-1',
  }), /Firestore unavailable/);

  const frozen = {
    payloadDigest: firstStore.prepared[0].payloadDigest,
    idempotencyKey: firstStore.prepared[0].idempotencyKey,
    variant: firstStore.prepared[0].variant,
  };
  const secondStore = new MemoryStore(plan, frozen);
  const outcome = await processResendInboundForward({
    plan,
    webhookId: 'webhook-2',
    provider: firstProvider,
    store: secondStore,
    now: () => 2_000,
    newAttemptId: () => 'attempt-2',
  });
  assert.equal(outcome.kind, 'forwarded');
  assert.deepEqual(sentKeys, [plan.idempotencyBaseKey, plan.idempotencyBaseKey]);
});

test('invalid attachment rejection switches once to the deterministic body-only key and reuses it on retry', async () => {
  const plan = forwardPlan();
  const item = attachment('one');
  const keys: string[] = [];
  const resendProvider = provider({
    email: receivedEmail({ attachments: [item] }),
    listed: [item],
    send: async (_payload, key) => {
      keys.push(key);
      return key.endsWith(':body-only')
        ? { data: { id: 'body-only-id' }, error: null }
        : { data: null, error: { name: 'invalid_attachment', message: 'bad attachment', statusCode: 422 } };
    },
  });
  const firstStore = new MemoryStore(plan);
  firstStore.throwOnSuccess = true;
  await assert.rejects(processResendInboundForward({
    plan, webhookId: 'webhook-1', provider: resendProvider, store: firstStore, newAttemptId: () => 'attempt-1',
  }));
  assert.deepEqual(keys, [plan.idempotencyBaseKey, `${plan.idempotencyBaseKey}:body-only`]);

  const bodyPrepared = firstStore.prepared.at(-1);
  const secondStore = new MemoryStore(plan, {
    payloadDigest: bodyPrepared.payloadDigest,
    idempotencyKey: bodyPrepared.idempotencyKey,
    variant: bodyPrepared.variant,
  });
  const outcome = await processResendInboundForward({
    plan, webhookId: 'webhook-2', provider: resendProvider, store: secondStore, newAttemptId: () => 'attempt-2',
  });
  assert.equal(outcome.kind, 'forwarded');
  assert.equal(outcome.kind === 'forwarded' && outcome.degraded, true);
  assert.deepEqual(keys, [
    plan.idempotencyBaseKey,
    `${plan.idempotencyBaseKey}:body-only`,
    `${plan.idempotencyBaseKey}:body-only`,
  ]);
});

test('service classifies definite permanent and retryable provider failures', async () => {
  const plan = forwardPlan();
  for (const [name, expected] of [['validation_error', 'failed_permanent'], ['rate_limit_exceeded', 'failed_retryable']] as const) {
    const store = new MemoryStore(plan);
    const outcome = await processResendInboundForward({
      plan,
      webhookId: `webhook-${name}`,
      provider: provider({ send: async () => ({ data: null, error: { name, message: name, statusCode: 422 } }) }),
      store,
      newAttemptId: () => `attempt-${name}`,
    });
    assert.equal(outcome.kind, expected);
    assert.equal(store.failures[0].ambiguous, false);
  }
});

test('a thrown provider network error is retryable and remains ambiguous', async () => {
  const plan = forwardPlan();
  const store = new MemoryStore(plan);
  const outcome = await processResendInboundForward({
    plan,
    webhookId: 'webhook-network',
    provider: provider({ send: async () => { throw new TypeError('network connection reset'); } }),
    store,
    newAttemptId: () => 'attempt-network',
  });
  assert.equal(outcome.kind, 'failed_retryable');
  assert.equal(store.failures[0].ambiguous, true);
  assert.equal(store.failures[0].retryable, true);
});

test('returned provider transport and server failures remain ambiguous', async () => {
  const plan = forwardPlan();
  for (const [name, statusCode] of [
    ['application_error', null],
    ['application_error', 500],
    ['internal_server_error', 503],
    ['concurrent_idempotent_requests', 409],
    ['validation_error', 500],
  ] as const) {
    const store = new MemoryStore(plan);
    const outcome = await processResendInboundForward({
      plan,
      webhookId: `webhook-${name}-${statusCode}`,
      provider: provider({ send: async () => ({ data: null, error: { name, message: name, statusCode } }) }),
      store,
      newAttemptId: () => `attempt-${name}-${statusCode}`,
    });
    assert.equal(outcome.kind, 'failed_retryable');
    assert.equal(store.failures[0].ambiguous, true, `${name}/${statusCode}`);
  }
});

test('an unresolved earlier send cannot be erased by a later definite provider rejection', async () => {
  const plan = forwardPlan();
  const store = new MemoryStore(plan);
  store.reservation.unresolvedProviderAttempt = true;
  const outcome = await processResendInboundForward({
    plan,
    webhookId: 'webhook-unresolved-provider-attempt',
    provider: provider({
      send: async () => ({
        data: null,
        error: { name: 'validation_error', message: 'later definite rejection', statusCode: 422 },
      }),
    }),
    store,
    newAttemptId: () => 'attempt-unresolved-provider-attempt',
  });

  assert.equal(outcome.kind, 'failed_retryable');
  assert.equal(store.failures[0].ambiguous, true);
  assert.equal(store.failures[0].retryable, true);
});

test('preparation failure preserves an earlier ambiguous provider attempt', async () => {
  const plan = forwardPlan();
  const store = new MemoryStore(plan, {
    payloadDigest: 'prior-digest', idempotencyKey: plan.idempotencyBaseKey, variant: 'full',
  });
  store.reservation.unresolvedProviderAttempt = true;
  const brokenProvider = provider();
  brokenProvider.getEmail = async () => ({
    data: null,
    error: { name: 'not_found', message: 'temporarily unavailable during retry', statusCode: 404 },
  });
  const outcome = await processResendInboundForward({
    plan, webhookId: 'webhook-retry', provider: brokenProvider, store, newAttemptId: () => 'retry-attempt',
  });
  assert.equal(outcome.kind, 'failed_retryable');
  assert.equal(store.failures[0].ambiguous, true);
  assert.equal(store.failures[0].retryable, true);
});

test('service returns active leases and terminal deduplication without contacting Resend', async () => {
  const plan = forwardPlan();
  const active = new MemoryStore(plan);
  active.reservation = { kind: 'in_progress', leaseExpiresAt: 12_345 };
  assert.deepEqual(await processResendInboundForward({
    plan, webhookId: 'w1', provider: provider(), store: active, newAttemptId: () => 'a1',
  }), { kind: 'in_progress', leaseExpiresAt: 12_345 });

  const terminal = new MemoryStore(plan);
  terminal.reservation = { kind: 'terminal', status: 'forwarded' };
  assert.deepEqual(await processResendInboundForward({
    plan, webhookId: 'w2', provider: provider(), store: terminal, newAttemptId: () => 'a2',
  }), { kind: 'duplicate', terminalStatus: 'forwarded' });

  terminal.reservation = { kind: 'terminal', status: 'failed_permanent' };
  assert.deepEqual(await processResendInboundForward({
    plan, webhookId: 'w3', provider: provider(), store: terminal, newAttemptId: () => 'a3',
  }), { kind: 'failed_permanent', reason: 'terminal_permanent_failure', attempts: 0 });
});

test('HTTP mapping covers every processing outcome and retry semantics', () => {
  assert.deepEqual(resendInboundHttpResponse({ kind: 'in_progress', leaseExpiresAt: 12_500 }, 10_000), {
    status: 503, retryAfter: '3', body: 'Resend inbound forwarding is already in progress',
  });
  assert.equal(resendInboundHttpResponse({ kind: 'failed_retryable', reason: 'network', attempts: 1 }).status, 500);
  assert.deepEqual(
    resendInboundHttpResponse({ kind: 'forwarded', degraded: false, attempts: 1, providerStatus: 'accepted' }).body,
    { received: true, forwarded: true, degraded: false },
  );
  assert.equal(resendInboundHttpResponse({ kind: 'duplicate', terminalStatus: 'forwarded' }).status, 200);
  assert.equal(resendInboundHttpResponse({ kind: 'needs_review', reason: 'window' }).status, 200);
  assert.deepEqual(
    resendInboundHttpResponse({ kind: 'failed_permanent', reason: 'invalid', attempts: 1 }).body,
    { received: true, forwarded: false, failedPermanently: true },
  );
});

test('provider adapter requests one bounded attachment page and streams download bytes', async () => {
  let listInput: any;
  const item = attachment('streamed');
  const adapter = createResendInboundProvider({
    emails: {
      receiving: {
        get: async () => ({ data: receivedEmail(), error: null }),
        attachments: {
          list: async (input: any) => {
            listInput = input;
            return { data: { data: [item], has_more: false }, error: null };
          },
        },
      },
      send: async () => ({ data: { id: 'sent' }, error: null }),
    },
  } as any, async () => new Response(Buffer.from('streamed bytes')) as any);
  assert.deepEqual(await adapter.listAttachments('email-id'), {
    data: { data: [item], has_more: false }, error: null,
  });
  assert.deepEqual(listInput, { emailId: 'email-id', limit: 100 });
  assert.equal((await adapter.downloadAttachment(item)).toString(), 'streamed bytes');
});

test('provider adapter classifies HTTP, oversized, and network attachment failures', async () => {
  const item = attachment('failure');
  const resend = { emails: { receiving: { get: async () => ({}), attachments: { list: async () => ({}) } }, send: async () => ({}) } } as any;
  for (const [status, retryable] of [[503, true], [404, false]] as const) {
    const adapter = createResendInboundProvider(resend, async () => new Response('', { status }) as any);
    await assert.rejects(adapter.downloadAttachment(item), (error: any) => error.retryable === retryable);
  }
  const oversized = createResendInboundProvider(
    resend,
    async () => new Response('', { headers: { 'content-length': '35000001' } }) as any,
  );
  await assert.rejects(oversized.downloadAttachment(item), (error: any) =>
    error.reason === 'attachment_too_large' && error.retryable === false,
  );
  const network = createResendInboundProvider(resend, async () => { throw new Error('socket timeout'); });
  await assert.rejects(network.downloadAttachment(item), (error: any) =>
    error.reason === 'attachment_download_failed' && error.retryable === true,
  );
});

test('provider adapter forwards external cancellation to attachment fetches', async () => {
  const item = attachment('cancelled');
  const resend = { emails: { receiving: { get: async () => ({}), attachments: { list: async () => ({}) } }, send: async () => ({}) } } as any;
  let fetchSignal: AbortSignal | undefined;
  const adapter = createResendInboundProvider(resend, async (_url, init) => {
    fetchSignal = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      fetchSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const controller = new AbortController();
  const download = adapter.downloadAttachment(item, controller.signal);
  controller.abort();

  await assert.rejects(download, (error: any) =>
    error.reason === 'attachment_download_failed' && error.retryable === true,
  );
  assert.equal(fetchSignal?.aborted, true);
});
