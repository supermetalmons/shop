import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
} from '../../../../shared/fulfillmentAccess.ts';
import type {
  StripeChargebackBackfillRequest,
  StripeChargebackBackfillResult,
} from '../../../../shared/stripeChargebacks.ts';
import { handleStripeChargebackBackfill } from '../src/stripeChargebackBackfill.ts';
import { StripeChargebackError } from '../src/stripeChargebacks.ts';
import { handleStripeWebhookRequest } from '../src/stripeWebhook.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { createCommerceD1 } from './commerceD1Harness.ts';

const TEST_SECRET = 'whsec_dispute_test';
const LIVE_SECRET = 'whsec_dispute_live';
const ADMIN = FULFILLMENT_ADMIN_WALLET_ADDRESSES[0];
const EVENT_TYPES = [
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
];

function backfillRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://api.mons.shop/admin/stripe-chargebacks/backfill', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

function emptyPage(body: StripeChargebackBackfillRequest): StripeChargebackBackfillResult {
  return {
    mode: body.mode,
    write: body.write === true,
    nextCursor: null,
    scanned: 0,
    matchedOrders: 0,
    inserted: 0,
    existing: 0,
    unrelated: 0,
    failures: [],
  };
}

const adminIdentity = async () => ({ kind: 'staff-wallet', wallet: ADMIN } as const);

test('chargeback backfill requires full administrator access before provider work', async () => {
  let calls = 0;
  const backfill = async (body: StripeChargebackBackfillRequest) => {
    calls += 1;
    return emptyPage(body);
  };
  const env = { COMMERCE_DB: createCommerceD1() };
  const anonymous = await handleStripeChargebackBackfill(backfillRequest({ mode: 'live' }), env, {
    backfill,
    verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'test' }),
  });
  assert.equal(anonymous.response.status, 401);
  const shipper = await handleStripeChargebackBackfill(backfillRequest({ mode: 'live' }), env, {
    backfill,
    verifyIdentity: async () => ({ kind: 'staff-wallet', wallet: SHIPPER_FULFILLMENT_ACCESS[0].wallet }),
  });
  assert.equal(shipper.response.status, 403);
  const expired = await handleStripeChargebackBackfill(backfillRequest({ mode: 'live' }), env, {
    backfill,
    verifyIdentity: async () => { throw new RequestIdentityError('invalid-token'); },
  });
  assert.equal(expired.response.status, 401);
  assert.equal(calls, 0);
});

test('chargeback backfill validates mode, cursor, write, and exact request fields', async () => {
  let calls = 0;
  for (const body of [
    {}, { mode: 'both' }, { mode: 'live', cursor: 'cs_live_other' },
    { mode: 'test', cursor: '' }, { mode: 'test', cursor: `du_${'a'.repeat(256)}` },
    { mode: 'live', write: 'true' }, { mode: 'live', extra: true },
  ]) {
    const result = await handleStripeChargebackBackfill(backfillRequest(body), { COMMERCE_DB: createCommerceD1() }, {
      verifyIdentity: adminIdentity,
      backfill: async (input) => { calls += 1; return emptyPage(input); },
    });
    assert.equal(result.response.status, 400, JSON.stringify(body));
  }
  assert.equal(calls, 0);
});

test('chargeback backfill returns dry-run and write results with legacy cursor support', async () => {
  const requests: StripeChargebackBackfillRequest[] = [];
  for (const body of [{ mode: 'live' as const }, { mode: 'test' as const, cursor: 'dp_legacy', write: true }]) {
    const result = await handleStripeChargebackBackfill(backfillRequest(body), { COMMERCE_DB: createCommerceD1() }, {
      verifyIdentity: adminIdentity,
      backfill: async (input) => {
        requests.push(input);
        return { ...emptyPage(input), scanned: 2, unrelated: 2 };
      },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.authOutcome, 'accepted');
    assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await result.response.json(), { ok: true, ...emptyPage(body), scanned: 2, unrelated: 2 });
  }
  assert.deepEqual(requests, [{ mode: 'live' }, { mode: 'test', cursor: 'dp_legacy', write: true }]);
});

test('chargeback backfill preserves explicit failures and sanitizes provider exceptions', async () => {
  const failure = { disputeId: 'du_unresolved', code: 'unresolved_app_session' };
  const env = { COMMERCE_DB: createCommerceD1() };
  const incomplete = await handleStripeChargebackBackfill(backfillRequest({ mode: 'live', write: true }), env, {
    verifyIdentity: adminIdentity,
    backfill: async (body) => ({ ...emptyPage(body), scanned: 1, failures: [failure] }),
  });
  assert.equal(incomplete.response.status, 200);
  assert.equal(incomplete.failures, 1);
  assert.deepEqual((await incomplete.response.json() as StripeChargebackBackfillResult).failures, [failure]);
  const unavailable = await handleStripeChargebackBackfill(backfillRequest({ mode: 'live' }), env, {
    verifyIdentity: adminIdentity,
    backfill: async () => { throw new StripeChargebackError('stripe_unavailable', 503, 'sk_live_sensitive'); },
  });
  assert.equal(unavailable.response.status, 503);
  assert.doesNotMatch(await unavailable.response.text(), /sk_live_sensitive/);
});

test('chargeback backfill bounds handler work and rejects other methods', async () => {
  const env = { COMMERCE_DB: createCommerceD1() };
  const wrongMethod = await handleStripeChargebackBackfill(backfillRequest(null, 'GET'), env);
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('Allow'), 'POST, OPTIONS');
  const timedOut = await handleStripeChargebackBackfill(backfillRequest({ mode: 'live' }), env, {
    verifyIdentity: adminIdentity,
    timeoutMs: 5,
    backfill: () => new Promise<StripeChargebackBackfillResult>(() => undefined),
  });
  assert.equal(timedOut.response.status, 504);
});

function disputeEvent(type: string, livemode = false): Record<string, unknown> {
  return {
    id: 'evt_chargeback',
    object: 'event',
    type,
    livemode,
    data: {
      object: {
        id: 'du_history',
        object: 'dispute',
        charge: 'ch_payment',
        payment_intent: 'pi_payment',
        created: 1780000000,
        livemode,
        status: 'warning_closed',
        evidence: { customer_email_address: 'private@example.com' },
      },
    },
  };
}

async function signedDisputeRequest(event: Record<string, unknown>, secret = TEST_SECRET): Promise<Request> {
  const payload = JSON.stringify(event);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    timestamp: Math.floor(Date.now() / 1000),
    cryptoProvider: Stripe.createSubtleCryptoProvider(crypto.subtle),
  });
  return new Request('https://api.mons.shop/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
}

function webhookEnv() {
  return {
    COMMERCE_DB: createCommerceD1(),
    STRIPE_WEBHOOK_SECRET: LIVE_SECRET,
    STRIPE_WEBHOOK_SECRET_DEVNET: TEST_SECRET,
    STRIPE_FULFILLMENT_QUEUE: {
      send: async () => { throw new Error('A dispute must never enqueue fulfillment'); },
    } as unknown as Queue,
  };
}

test('signed dispute event types normalize and record history without fulfillment dispatch', async () => {
  const logs: Record<string, unknown>[] = [];
  for (const type of EVENT_TYPES) {
    for (const livemode of [false, true]) {
      const result = await handleStripeWebhookRequest(
        await signedDisputeRequest(disputeEvent(type, livemode), livemode ? LIVE_SECRET : TEST_SECRET),
        webhookEnv(),
        {
          log: (entry) => logs.push(entry),
          getDrop: () => { throw new Error('Disputes must not use current drop configuration'); },
          processDispute: async (dispute) => {
            assert.deepEqual(dispute, {
              id: 'du_history', livemode, chargeId: 'ch_payment', paymentIntentId: 'pi_payment', created: 1780000000,
            });
            return { matchedOrders: 1, inserted: 1, existing: 0, unrelated: 0 };
          },
        },
      );
      assert.equal(result.response.status, 200);
      assert.equal(result.outcome, 'chargeback_recorded');
    }
  }
  assert.doesNotMatch(JSON.stringify(logs), /private@example|evidence|whsec_/);
});

test('signed evidence-heavy dispute updates include previous attributes without exceeding the webhook allowance', async () => {
  const text = '界'.repeat(20_000);
  const evidence = { product_description: text, uncategorized_text: text, refund_policy_disclosure: text, refund_refusal_explanation: text };
  const event = {
    ...disputeEvent('charge.dispute.updated'),
    data: {
      object: {
        id: 'du_large', object: 'dispute', charge: 'ch_payment', payment_intent: 'pi_payment',
        created: 1780000000, livemode: false, status: 'under_review', evidence,
      },
      previous_attributes: { evidence },
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(event)) > 256 * 1024);
  let calls = 0;
  for (const [secret, status] of [[TEST_SECRET, 200], ['whsec_wrong', 400]] as const) {
    const result = await handleStripeWebhookRequest(await signedDisputeRequest(event, secret), webhookEnv(), {
      log: () => undefined,
      processDispute: async (dispute) => {
        calls += 1;
        assert.equal(dispute.id, 'du_large');
        return { matchedOrders: 1, inserted: 1, existing: 0, unrelated: 0 };
      },
    });
    assert.equal(result.response.status, status);
  }
  assert.equal(calls, 1);
});

test('dispute events reject invalid signatures and inconsistent live/test identity', async () => {
  let calls = 0;
  const malformed = disputeEvent('charge.dispute.created');
  malformed.livemode = true;
  for (const [event, secret] of [
    [disputeEvent('charge.dispute.created'), LIVE_SECRET],
    [disputeEvent('charge.dispute.created', true), TEST_SECRET],
    [disputeEvent('charge.dispute.created'), 'whsec_wrong'],
    [malformed, LIVE_SECRET],
  ] as const) {
    const result = await handleStripeWebhookRequest(await signedDisputeRequest(event, secret), webhookEnv(), {
      log: () => undefined,
      processDispute: async () => { calls += 1; return { matchedOrders: 0, inserted: 0, existing: 0, unrelated: 1 }; },
    });
    assert.equal(result.response.status, 400);
  }
  assert.equal(calls, 0);
});

test('dispute webhook retries unresolved app payments but acknowledges unrelated payments', async () => {
  const request = () => signedDisputeRequest(disputeEvent('charge.dispute.created'));
  const unmatched = await handleStripeWebhookRequest(await request(), webhookEnv(), {
    log: () => undefined,
    processDispute: async () => ({ matchedOrders: 0, inserted: 0, existing: 0, unrelated: 1 }),
  });
  assert.equal(unmatched.response.status, 200);
  assert.equal(unmatched.outcome, 'unrelated_dispute');
  const unresolved = await handleStripeWebhookRequest(await request(), webhookEnv(), {
    log: () => undefined,
    processDispute: async () => { throw new StripeChargebackError('unresolved_app_session', 503, 'sensitive provider data'); },
  });
  assert.equal(unresolved.response.status, 500);
  assert.equal(unresolved.outcome, 'unresolved_app_session');
  assert.doesNotMatch(await unresolved.response.text(), /sensitive/);
});

test('refunds and standalone fraud warnings do not enter dispute processing', async () => {
  for (const type of ['charge.refunded', 'refund.created', 'radar.early_fraud_warning.created']) {
    const result = await handleStripeWebhookRequest(await signedDisputeRequest(disputeEvent(type)), webhookEnv(), {
      log: () => undefined,
      processDispute: async () => { throw new Error('Unexpected dispute processing'); },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.outcome, 'unsupported_event');
  }
});
