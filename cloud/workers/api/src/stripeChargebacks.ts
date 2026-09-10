import { isCommerceDocumentSegment } from '../../../../shared/commerceDocumentPath.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import {
  isStripeChargebackSessionId,
  isStripeDisputeId,
  normalizeStripeDispute,
  type StripeChargebackBackfillRequest,
  type StripeChargebackBackfillResult,
  type StripeChargebackMode,
  type StripeDispute,
} from '../../../../shared/stripeChargebacks.js';
import { STRIPE_OFFCHAIN_FULFILLMENT_MODE } from '../../../../shared/stripeCheckoutSession.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { recordStripeChargeback, StripeChargebackStoreError } from './stripeChargebackStore.js';

export type StripeChargebackEnv = Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env,
  'STRIPE_SECRET_KEY' | 'STRIPE_RESTRICTED_KEY' | 'STRIPE_SECRET_KEY_LIVE' | 'STRIPE_RESTRICTED_KEY_LIVE'
>>;

export type StripeChargebackOptions = {
  signal: AbortSignal;
  write?: boolean;
  providerFetch?: typeof fetch;
  nowMs?: () => number;
};

type StripeSession = {
  id: string;
  livemode: boolean;
  paymentIntentId: string;
  appMarked: boolean;
  dropId?: string;
};

type StripeChargebackProcessResult = {
  matchedOrders: number;
  inserted: number;
  existing: number;
  unrelated: number;
};

type StripeList = { data: unknown[]; has_more: boolean };

export class StripeChargebackError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'StripeChargebackError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidProvider(): StripeChargebackError {
  return new StripeChargebackError('stripe-invalid-response', 502, 'Stripe chargeback data is invalid.');
}

function identityConflict(): StripeChargebackError {
  return new StripeChargebackError('chargeback-identity-conflict', 409, 'Stripe chargeback identity does not match the order.');
}

function paymentIntentId(value: unknown, livemode: boolean): string | null {
  if (record(value) && typeof value.livemode === 'boolean' && value.livemode !== livemode) throw invalidProvider();
  const id = record(value) ? value.id : value;
  if (id == null) return null;
  if (typeof id !== 'string' || id.length > 256 || !/^pi_[A-Za-z0-9_]+$/.test(id)) throw invalidProvider();
  return id;
}

function stripeKeys(env: StripeChargebackEnv, mode: StripeChargebackMode): string[] {
  const values = mode === 'live'
    ? [env.STRIPE_SECRET_KEY_LIVE, env.STRIPE_RESTRICTED_KEY_LIVE]
    : [env.STRIPE_SECRET_KEY, env.STRIPE_RESTRICTED_KEY];
  const pattern = mode === 'live' ? /^(?:sk|rk)_live_/ : /^(?:sk|rk)_test_/;
  const keys = Array.from(new Set(values.map((value) => String(value || '').trim()).filter((key) => pattern.test(key))));
  if (!keys.length) throw new StripeChargebackError('stripe-not-configured', 503, `Stripe ${mode} credentials are not configured.`);
  return keys;
}

export async function stripeRead(
  pathname: string,
  query: Record<string, string>,
  mode: StripeChargebackMode,
  env: StripeChargebackEnv,
  options: StripeChargebackOptions,
  form?: URLSearchParams,
): Promise<unknown> {
  options.signal.throwIfAborted();
  for (const key of stripeKeys(env, mode)) {
    const scope = createTimedAbortScope(options.signal, {
      timeoutMs: 10_000,
      timeoutMessage: 'Stripe chargeback request timed out',
    });
    try {
      const url = new URL(`https://api.stripe.com/v1/${pathname}`);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      const response = await raceWithSignal((options.providerFetch || fetch)(url.toString(), {
        headers: {
          Authorization: `Bearer ${key}`,
          'Stripe-Version': '2026-07-29.dahlia',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { method: 'POST', body: form.toString() } : {}),
        redirect: 'manual',
        signal: scope.signal,
      }), scope.signal);
      if (response.status === 401 || response.status === 403) {
        await cancelResponseBody(response);
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        throw new StripeChargebackError('stripe-redirect-rejected', 502, 'Stripe redirected the chargeback request.');
      }
      if (!response.ok) {
        let errorPayload: unknown;
        try {
          errorPayload = await readBoundedResponseJson(response, {
            maxBytes: 16 * 1024,
            signal: scope.signal,
            contentType: 'require-json',
            createError: invalidProvider,
          });
        } catch (error) {
          options.signal.throwIfAborted();
          if (scope.timedOut()) throw error;
        }
        if (record(errorPayload) && record(errorPayload.error) &&
          typeof errorPayload.error.message === 'string' && /^Invalid Stripe API version/i.test(errorPayload.error.message)) {
          throw new StripeChargebackError('stripe-api-version-unsupported', 502, 'Stripe rejected the configured API version.');
        }
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new StripeChargebackError(`stripe-http-${response.status}`, retryable ? 503 : 502, 'Stripe rejected the chargeback request.');
      }
      return await readBoundedResponseJson(response, {
        maxBytes: pathname === 'disputes' ? 12 * 1024 * 1024 : 2 * 1024 * 1024,
        signal: scope.signal,
        contentType: 'require-json',
        createError: invalidProvider,
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof StripeChargebackError) throw error;
      if (scope.timedOut()) {
        throw new StripeChargebackError('stripe-request-timeout', 503, 'Stripe chargeback request timed out.');
      }
      throw new StripeChargebackError('stripe-network-error', 503, 'Stripe chargeback connection failed.');
    } finally {
      scope.dispose();
    }
  }
  throw new StripeChargebackError('stripe-credentials-rejected', 503, 'Stripe rejected the configured chargeback credentials.');
}

function stripeList(value: unknown, limit: number): StripeList {
  if (!record(value) || value.object !== 'list' || !Array.isArray(value.data) ||
    value.data.length > limit || typeof value.has_more !== 'boolean' ||
    (value.has_more && !value.data.length)) throw invalidProvider();
  return { data: value.data, has_more: value.has_more };
}

function stripeSession(value: unknown, pi: string, livemode: boolean): StripeSession {
  if (!record(value) || value.object !== 'checkout.session' || !isStripeChargebackSessionId(value.id) ||
    value.livemode !== livemode || value.id.startsWith('cs_live_') !== livemode ||
    paymentIntentId(value.payment_intent, livemode) !== pi) throw invalidProvider();
  const metadata = record(value.metadata) ? value.metadata : {};
  const appMarked = metadata.fulfillmentMode === STRIPE_OFFCHAIN_FULFILLMENT_MODE;
  if (appMarked && !isCommerceDocumentSegment(metadata.dropId)) throw invalidProvider();
  return {
    id: value.id,
    livemode,
    paymentIntentId: pi,
    appMarked,
    ...(isCommerceDocumentSegment(metadata.dropId) ? { dropId: metadata.dropId } : {}),
  };
}

async function stripeSessions(
  pi: string,
  livemode: boolean,
  env: StripeChargebackEnv,
  options: StripeChargebackOptions,
): Promise<StripeSession[]> {
  const sessions = new Map<string, StripeSession>();
  const mode = livemode ? 'live' : 'test';
  let cursor: string | undefined;
  while (true) {
    options.signal.throwIfAborted();
    const page = stripeList(await stripeRead('checkout/sessions', {
      payment_intent: pi,
      limit: '100',
      ...(cursor ? { starting_after: cursor } : {}),
    }, mode, env, options), 100);
    for (const value of page.data) {
      const session = stripeSession(value, pi, livemode);
      if (sessions.has(session.id)) throw invalidProvider();
      sessions.set(session.id, session);
    }
    if (!page.has_more) break;
    cursor = Array.from(sessions.keys()).at(-1);
  }
  const linked = await env.COMMERCE_DB.prepare(`SELECT DISTINCT
      CASE WHEN document_kind = 'stripe_checkout' THEN document_id
        ELSE json_extract(document_json, '$.stripeCheckoutSessionId') END AS session_id
    FROM commerce_documents
    WHERE (document_kind = 'stripe_checkout' OR (document_kind = 'delivery_order' AND source = ?))
      AND json_extract(document_json, '$.stripePaymentIntentId') = ?`)
    .bind(STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE, pi).all<{ session_id: unknown }>();
  for (const row of linked.results) {
    if (!isStripeChargebackSessionId(row.session_id)) throw identityConflict();
    if (row.session_id.startsWith('cs_live_') !== livemode) continue;
    if (sessions.has(row.session_id)) continue;
    const session = stripeSession(await stripeRead(`checkout/sessions/${row.session_id}`, {}, mode, env, options), pi, livemode);
    if (session.id !== row.session_id) throw invalidProvider();
    sessions.set(session.id, session);
  }
  return Array.from(sessions.values());
}

async function matchedDropIds(db: D1Database, session: StripeSession): Promise<string[]> {
  const rows = await db.prepare(`SELECT document_path, document_kind, document_id, drop_id, document_json
    FROM commerce_documents
    WHERE (document_kind = 'stripe_checkout' AND document_id = ?)
      OR (document_kind = 'delivery_order' AND source = ?
        AND json_extract(document_json, '$.stripeCheckoutSessionId') = ?)`)
    .bind(session.id, STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE, session.id).all<Record<string, unknown>>();
  const drops = new Set<string>();
  for (const row of rows.results) {
    const dropId = row.drop_id;
    if (!isCommerceDocumentSegment(dropId) || typeof row.document_json !== 'string') throw identityConflict();
    let data: unknown;
    try { data = JSON.parse(row.document_json); } catch { throw identityConflict(); }
    if (!record(data)) throw identityConflict();
    const collection = row.document_kind === 'stripe_checkout' ? 'stripeCheckouts' : 'deliveryOrders';
    if (!isCommerceDocumentSegment(row.document_id) ||
      row.document_path !== `drops/${dropId}/${collection}/${row.document_id}` ||
      (data.dropId !== undefined && data.dropId !== dropId) ||
      (data.livemode !== undefined && data.livemode !== session.livemode) ||
      (data.stripePaymentIntentId !== undefined && data.stripePaymentIntentId !== session.paymentIntentId) ||
      (row.document_kind === 'stripe_checkout' && data.sessionId !== undefined && data.sessionId !== session.id) ||
      (session.appMarked && session.dropId !== dropId)) throw identityConflict();
    drops.add(dropId);
  }
  if (drops.size > 1) throw identityConflict();
  if (!drops.size && session.appMarked) {
    throw new StripeChargebackError('chargeback-order-pending', 503, 'The Stripe order is not available for chargeback matching yet.');
  }
  return Array.from(drops);
}

export async function processStripeDispute(
  dispute: StripeDispute,
  env: StripeChargebackEnv,
  options: StripeChargebackOptions,
): Promise<StripeChargebackProcessResult> {
  const result: StripeChargebackProcessResult = { matchedOrders: 0, inserted: 0, existing: 0, unrelated: 0 };
  options.signal.throwIfAborted();
  const normalized = normalizeStripeDispute({ object: 'dispute', id: dispute.id,
    livemode: dispute.livemode, charge: dispute.chargeId, payment_intent: dispute.paymentIntentId, created: dispute.created });
  if (!normalized) throw new StripeChargebackError('invalid-dispute', 400, 'Stripe dispute is invalid.');
  try {
    let pi = normalized.paymentIntentId;
    if (!pi) {
      const charge = await stripeRead(`charges/${normalized.chargeId}`, {}, normalized.livemode ? 'live' : 'test', env, options);
      if (!record(charge) || charge.object !== 'charge' || charge.id !== normalized.chargeId ||
        charge.livemode !== normalized.livemode || !Object.hasOwn(charge, 'payment_intent')) throw invalidProvider();
      pi = paymentIntentId(charge.payment_intent, normalized.livemode) || undefined;
      if (!pi) return { ...result, unrelated: 1 };
    }
    const sessions = await stripeSessions(pi, normalized.livemode, env, options);
    const matches: Array<{ session: StripeSession; dropId: string }> = [];
    for (const session of sessions) {
      options.signal.throwIfAborted();
      for (const dropId of await matchedDropIds(env.COMMERCE_DB, session)) matches.push({ session, dropId });
    }
    for (const { session, dropId } of matches) {
      options.signal.throwIfAborted();
      const stored = await recordStripeChargeback(env.COMMERCE_DB, {
        livemode: normalized.livemode,
        sessionId: session.id,
        disputeId: normalized.id,
        dropId,
        chargeId: normalized.chargeId,
        paymentIntentId: pi,
        disputeCreatedAt: normalized.created,
        recordedAtMs: Math.floor(options.nowMs?.() ?? Date.now()),
      }, options.write !== false);
      result.matchedOrders += 1;
      if (stored === 'inserted') result.inserted += 1;
      if (stored === 'existing') result.existing += 1;
    }
    if (!result.matchedOrders) result.unrelated = 1;
    return result;
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof StripeChargebackError) throw error;
    if (error instanceof StripeChargebackStoreError) throw identityConflict();
    throw new StripeChargebackError('chargeback-storage-unavailable', 503, 'Chargeback history could not be recorded.');
  }
}

export async function backfillStripeChargebacks(
  request: StripeChargebackBackfillRequest,
  env: StripeChargebackEnv,
  options: StripeChargebackOptions,
): Promise<StripeChargebackBackfillResult> {
  if ((request.mode !== 'live' && request.mode !== 'test') ||
    (request.cursor !== undefined && !isStripeDisputeId(request.cursor)) ||
    (request.write !== undefined && typeof request.write !== 'boolean')) {
    throw new StripeChargebackError('invalid-argument', 400, 'Stripe chargeback backfill request is invalid.');
  }
  const write = request.write === true;
  const page = stripeList(await stripeRead('disputes', {
    limit: '1',
    ...(request.cursor ? { starting_after: request.cursor } : {}),
  }, request.mode, env, options), 1);
  const result: StripeChargebackBackfillResult = {
    mode: request.mode, write, nextCursor: null, scanned: page.data.length,
    matchedOrders: 0, inserted: 0, existing: 0, unrelated: 0, failures: [],
  };
  const seen = new Set<string>();
  for (const value of page.data) {
    options.signal.throwIfAborted();
    if (!record(value) || !isStripeDisputeId(value.id)) throw invalidProvider();
    const dispute = normalizeStripeDispute(value);
    const disputeId = value.id;
    if (!dispute || dispute.livemode !== (request.mode === 'live') || seen.has(disputeId) || disputeId === request.cursor) {
      result.failures.push({ disputeId, code: 'invalid-dispute' });
      continue;
    }
    seen.add(disputeId);
    try {
      const processed = await processStripeDispute(dispute, env, { ...options, write });
      result.matchedOrders += processed.matchedOrders;
      result.inserted += processed.inserted;
      result.existing += processed.existing;
      result.unrelated += processed.unrelated;
    } catch (error) {
      options.signal.throwIfAborted();
      result.failures.push({ disputeId, code: error instanceof StripeChargebackError ? error.code : 'chargeback-unavailable' });
    }
  }
  if (result.failures.length) result.nextCursor = request.cursor || null;
  else if (page.has_more) {
    const last = page.data.at(-1);
    if (!record(last) || !isStripeDisputeId(last.id)) throw invalidProvider();
    result.nextCursor = last.id;
  }
  return result;
}
