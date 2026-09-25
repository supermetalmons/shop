import { z } from 'zod';
import {
  getPreorderConfig, PREORDER_CARD_COUNT, PREORDER_RESERVATION_TTL_MS,
  type PreorderConfig, type PreorderPrepareResponse,
} from '../../../../shared/preorders.js';
import { canonicalWalletAddress } from '../../../../shared/walletLifecycle.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import { classifyAuthenticatedRequestError, withAuthenticatedRequest } from './authenticatedRequest.js';
import { readBoundedRequestJson } from './boundedRequest.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import { ProfileReadError } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import { PreorderStore, publicPreorder, type StoredPreorder } from './preorderStore.js';
import {
  authorizePreorderTransaction, isPreorderBlockhashValid, preparePreorderTransaction,
  probePreorderTransaction, sendPreorderTransaction,
} from './preorderTransaction.js';
import { requestIdentitySubject, resolveRequestWallet, verifyRequestIdentity, type RequestAuthContext } from './requestIdentity.js';

export const PREORDER_PATHS = ['/preorders/availability', '/preorders/prepare', '/preorders/submit', '/preorders/cancel', '/preorders/status'] as const;
const idSchema = z.string().min(1).max(80);
const orderSchema = z.object({ preorderId: idSchema, orderId: z.string().uuid() }).strict();
const prepareSchema = z.object({
  preorderId: idSchema, buyer: z.string().min(32).max(44),
  requestId: z.string().uuid(), cardIds: z.array(z.number().int().min(1).max(PREORDER_CARD_COUNT)).min(1).max(3),
}).strict();
const submitSchema = orderSchema.extend({ transactionBase64: z.string().min(1).max(2000) });
const statusSchema = z.object({ preorderId: idSchema, orderId: z.string().uuid().optional() }).strict();

type PreorderDependencies = {
  nowMs: () => number;
  providerFetch: typeof fetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
  prepare: typeof preparePreorderTransaction;
  authorize: (args: Parameters<typeof authorizePreorderTransaction>[0]) =>
    ReturnType<typeof authorizePreorderTransaction> | Promise<ReturnType<typeof authorizePreorderTransaction>>;
  probe: typeof probePreorderTransaction;
  send: typeof sendPreorderTransaction;
  blockhashValid: typeof isPreorderBlockhashValid;
};

const defaults: PreorderDependencies = {
  nowMs: Date.now, providerFetch: (input, init) => fetch(input, init), timeoutMs: 45_000,
  verifyIdentity: verifyRequestIdentity, prepare: preparePreorderTransaction, authorize: authorizePreorderTransaction,
  probe: probePreorderTransaction, send: sendPreorderTransaction, blockhashValid: isPreorderBlockhashValid,
};

function enabledConfig(preorderId: string): PreorderConfig {
  const config = getPreorderConfig(preorderId);
  if (!config?.enabled || config.cluster !== 'devnet') {
    throw new ProfileReadError('failed-precondition', 409, 'Preorders are not available for this collection.');
  }
  return config;
}

function rpcArgs(env: Env, config: PreorderConfig, dependencies: PreorderDependencies, signal: AbortSignal) {
  if (!env.HELIUS_API_KEY) throw new ProfileReadError('unavailable', 503, 'Preorders are temporarily unavailable.');
  return { config, apiKey: env.HELIUS_API_KEY, fetch: dependencies.providerFetch, signal };
}

async function broadcastOrder(
  order: StoredPreorder, args: ReturnType<typeof rpcArgs>, dependencies: PreorderDependencies,
): Promise<void> {
  try { await dependencies.send({ ...args, transactionBase64: order.signedTransaction! }); }
  catch (error) {
    args.signal.throwIfAborted();
    console.warn({ event: 'preorder_broadcast_uncertain', orderId: order.orderId,
      error: error instanceof Error ? error.name : 'UnknownError' });
  }
}

async function reconcileOrder(
  order: StoredPreorder, store: PreorderStore, env: Env, dependencies: PreorderDependencies, signal: AbortSignal,
  options: { checkPreparedBlockhash?: boolean; rebroadcast?: boolean } = {},
): Promise<StoredPreorder> {
  const config = enabledConfig(order.preorderId);
  if (order.status === 'prepared') {
    if (order.expiresAtMs <= dependencies.nowMs() || (options.checkPreparedBlockhash && !(await dependencies.blockhashValid({
      ...rpcArgs(env, config, dependencies, signal), blockhash: order.blockhash, minContextSlot: order.blockhashContextSlot,
    })))) return store.finish(order, 'expired', dependencies.nowMs());
    return order;
  }
  if (order.status !== 'submitted') return order;
  const args = rpcArgs(env, config, dependencies, signal);
  const outcome = await dependencies.probe({
    ...args, signature: order.signature!, transactionBase64: order.signedTransaction!,
    assets: order.assets, lastValidBlockHeight: order.lastValidBlockHeight, blockhashContextSlot: order.blockhashContextSlot,
  });
  if (outcome.status !== 'pending') {
    return store.finish(order, outcome.status === 'confirmed' ? 'succeeded' : outcome.status, dependencies.nowMs());
  }
  if (options.rebroadcast) {
    await broadcastOrder(order, args, dependencies);
  }
  await store.defer(order, dependencies.nowMs());
  return (await store.get(order.orderId))!;
}

function assertRequestMatches(order: StoredPreorder, ids: number[]): void {
  if (order.cardIds.length !== ids.length || order.cardIds.some((id, index) => id !== ids[index])) {
    throw new ProfileReadError('failed-precondition', 409, 'This request ID belongs to a different selection.');
  }
}

function preparedResponse(order: StoredPreorder): PreorderPrepareResponse {
  return { order: publicPreorder(order), transactionBase64: order.status === 'prepared' ? order.preparedTransaction : null };
}

async function enforcePrepareLimit(env: Env, request: Request, buyer: string, subject: string): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP');
  const checks = [
    env.PREORDER_PREPARE_RATE_LIMITER.limit({ key: `wallet:${buyer}` }),
    env.PREORDER_PREPARE_RATE_LIMITER.limit({ key: `subject:${subject}` }),
  ];
  if (ip) checks.push(env.PREORDER_PREPARE_IP_RATE_LIMITER.limit({ key: ip }));
  const outcomes = await Promise.all(checks);
  if (outcomes.some((outcome) => !outcome.success)) {
    throw new ProfileReadError('resource-exhausted', 429, 'Too many preorder attempts. Please wait a minute.');
  }
}

export async function handlePreorderRequest(
  request: Request, env: Env, authContext: RequestAuthContext = {}, overrides: Partial<PreorderDependencies> = {},
) {
  const dependencies = { ...defaults, ...overrides };
  const path = new URL(request.url).pathname;
  const expectedMethod = path.endsWith('/availability') ? 'GET' : 'POST';
  if (request.method !== expectedMethod) {
    await request.body?.cancel().catch(() => undefined);
    return { response: jsonResponse({ error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405,
      { headers: { Allow: `${expectedMethod}, OPTIONS` } }), metrics: { upstreamCalls: 0, providerDurationMs: 0 }, authOutcome: 'rejected' as const };
  }
  return withAuthenticatedRequest(request, { authContext, opsDb: env.OPS_DB, dependencies,
    timeoutMessage: 'Preorder request timed out.' }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    const deps = { ...dependencies, providerFetch: trackedFetch };
    let authenticated = false;
    try {
      const raw = expectedMethod === 'GET' ? Object.fromEntries(new URL(request.url).searchParams)
        : await readBoundedRequestJson(request, { maxBytes: 4096, signal: deadline.signal,
          createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid preorder request.') });
      const schema = path.endsWith('/prepare') ? prepareSchema : path.endsWith('/submit') ? submitSchema
        : path.endsWith('/cancel') ? orderSchema : statusSchema;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid preorder request.');
      const body = parsed.data;
      const config = enabledConfig(body.preorderId);
      if ((await loadCommerceAuthorityControl(env.COMMERCE_DB)).state !== 'd1') {
        throw new ProfileReadError('unavailable', 503, 'Preorders are temporarily unavailable for maintenance.');
      }
      const store = new PreorderStore(env.COMMERCE_DB);
      await store.expirePrepared(deps.nowMs());
      if (path === '/preorders/availability') {
        const claims = new Map((await store.claims(config.cluster, config.collection)).map((claim) => [claim.id, claim.status]));
        return { response: jsonResponse({ preorderId: config.preorderId,
          items: Array.from({ length: PREORDER_CARD_COUNT }, (_, index) => ({ id: index + 1, status: claims.get(index + 1) || 'available' })) }, 200),
          metrics, authOutcome: 'accepted' as const };
      }
      const identity = await authenticate();
      const buyer = await resolveRequestWallet(identity, async (subject) => {
        const resolution = await resolveD1AuthWalletBinding(env.OPS_DB, subject, deadline.signal);
        if ('reason' in resolution) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
        return resolution.wallet;
      });
      authenticated = true;
      if (path === '/preorders/prepare') {
        const input = prepareSchema.parse(body);
        if (canonicalWalletAddress(input.buyer) !== buyer) throw new ProfileReadError('permission-denied', 403, 'Wallet session does not match the buyer.');
        const ids = [...input.cardIds].sort((left, right) => left - right);
        if (new Set(ids).size !== ids.length) throw new ProfileReadError('invalid-argument', 400, 'Select each card only once.');
        let existing = await store.request(config.preorderId, buyer, input.requestId);
        if (existing) {
          assertRequestMatches(existing, ids);
          existing = await reconcileOrder(existing, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
          return { response: jsonResponse(preparedResponse(existing), 200), metrics, authOutcome: 'accepted' as const };
        }
        await enforcePrepareLimit(env, request, buyer, requestIdentitySubject(identity));
        const active = await store.active(config.preorderId, buyer);
        if (active) {
          const current = await reconcileOrder(active, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
          if (current.status === 'prepared' || current.status === 'submitted') {
            throw new ProfileReadError('failed-precondition', 409, 'Finish or cancel your current preorder first.', { order: publicPreorder(current) });
          }
        }
        const claims = await store.claims(config.cluster, config.collection);
        for (const orderId of new Set(claims.filter((claim) => ids.includes(claim.id) && claim.status === 'reserved').map((claim) => claim.orderId))) {
          const reserved = await store.get(orderId);
          if (reserved) await reconcileOrder(reserved, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
        }
        const prepared = await deps.prepare({ ...rpcArgs(env, config, deps, deadline.signal), buyer, ids, cosignerSecret: env.COSIGNER_SECRET });
        const nowMs = deps.nowMs();
        const order = await store.reserve({ orderId: crypto.randomUUID(), preorderId: config.preorderId, buyer,
          cardIds: ids, assets: prepared.assets, status: 'prepared', expiresAtMs: nowMs + PREORDER_RESERVATION_TTL_MS,
          signature: null, cluster: config.cluster, collection: config.collection, requestId: input.requestId,
          preparedTransaction: prepared.transactionBase64, signedTransaction: null, blockhash: prepared.blockhash,
          blockhashContextSlot: prepared.blockhashContextSlot, lastValidBlockHeight: prepared.lastValidBlockHeight,
          createdAtMs: nowMs, revision: 1 });
        assertRequestMatches(order, ids);
        return { response: jsonResponse(preparedResponse(order), 200), metrics, authOutcome: 'accepted' as const };
      }
      const orderId = 'orderId' in body ? body.orderId : undefined;
      let order = orderId ? await store.get(orderId) : await store.active(config.preorderId, buyer);
      let broadcastAttempted = false;
      if (order && (order.buyer !== buyer || order.preorderId !== config.preorderId)) {
        throw new ProfileReadError('permission-denied', 403, 'This preorder belongs to another wallet or collection.');
      }
      if (!order && path !== '/preorders/status') throw new ProfileReadError('not-found', 404, 'Preorder not found.');
      if (order && path === '/preorders/cancel' && order.status === 'prepared') {
        order = await store.finish(order, 'cancelled', deps.nowMs());
      } else if (order && path === '/preorders/submit' && order.status === 'prepared') {
        order = await reconcileOrder(order, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
        if (order.status === 'prepared') {
          const input = submitSchema.parse(body);
          const authorized = await deps.authorize({ preparedTransactionBase64: order.preparedTransaction,
            signedTransactionBase64: input.transactionBase64, buyer, authority: config.authority, cosignerSecret: env.COSIGNER_SECRET });
          deadline.signal.throwIfAborted();
          order = await store.submit(order, authorized, deps.nowMs());
          if (order.status === 'submitted') {
            await broadcastOrder(order, rpcArgs(env, config, deps, deadline.signal), deps);
            broadcastAttempted = true;
          }
        }
      }
      if (order && order.status === 'submitted') {
        try { order = await reconcileOrder(order, store, env, deps, deadline.signal, {
          rebroadcast: !broadcastAttempted && (path === '/preorders/submit' || path === '/preorders/status'),
        }); }
        catch (error) {
          console.warn({ event: 'preorder_submission_uncertain', orderId: order.orderId,
            error: error instanceof Error ? error.name : 'UnknownError' });
          order = (await store.get(order.orderId))!;
        }
      } else if (order && path === '/preorders/status') {
        order = await reconcileOrder(order, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
      }
      return { response: jsonResponse({ order: order ? publicPreorder(order) : null }, 200), metrics, authOutcome: 'accepted' as const };
    } catch (error) {
      const failure = classifyAuthenticatedRequestError(error, { authenticated, timedOut: deadline.timedOut(),
        timeoutPrecedence: 'after-known-errors', timeoutMessage: 'Preorder request timed out.',
        internalMessage: 'Preorder request failed.', mapDomainError: () => undefined });
      if (failure.unexpected) console.error({ event: 'preorder_request_failed', error: error instanceof Error ? error.name : 'UnknownError' });
      return { response: jsonResponse(apiErrorBody(failure.error), httpStatusForApiErrorCode(failure.error.code, 503)),
        metrics, authOutcome: failure.authOutcome };
    }
  });
}

export async function reconcilePendingPreorders(env: Env, signal: AbortSignal, overrides: Partial<PreorderDependencies> = {}): Promise<number> {
  const dependencies = { ...defaults, ...overrides };
  const store = new PreorderStore(env.COMMERCE_DB);
  const due = await store.due(dependencies.nowMs());
  const failures: unknown[] = [];
  for (const order of due) {
    signal.throwIfAborted();
    try { await reconcileOrder(order, store, env, dependencies, signal, { rebroadcast: true }); }
    catch (error) {
      if (order.status === 'submitted') await store.defer(order, dependencies.nowMs()).catch(() => undefined);
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Preorder reconciliation failed.');
  return due.length;
}
