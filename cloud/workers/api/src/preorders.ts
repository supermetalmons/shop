import { z } from 'zod';
import {
  getPreorderConfig, PREORDER_CARD_COUNT, PREORDER_RESERVATION_TTL_MS,
  type PreorderConfig, type PreorderPrepareResponse,
} from '../../../../shared/preorders.js';
import { canonicalWalletAddress } from '../../../../shared/walletLifecycle.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import { classifyAuthenticatedRequestError, withAuthenticatedRequest } from './authenticatedRequest.js';
import { readBoundedRequestJson } from './boundedRequest.js';
import type { DeferredWork } from './deferredWork.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import { ProfileReadError } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import { MiNoteAuthError, verifyMiNoteSession } from './miNoteAuth.js';
import { assertMiNoteEligibility, loadMiNoteEligibility } from './miNoteEligibility.js';
import type { WorkerDependencies } from './publicRouteSupport.js';
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
const statusSchema = z.object({
  preorderId: idSchema, orderId: z.string().uuid().optional(), includeRecoveries: z.literal(true).optional(),
  recoveryCursor: z.string().min(1).max(256).optional(),
}).strict().refine((input) => (!input.includeRecoveries || !input.orderId) &&
  (input.recoveryCursor === undefined || input.includeRecoveries === true));
const availabilitySchema = z.object({ preorderId: idSchema }).strict();

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
  verifyEthereumSession: typeof verifyMiNoteSession;
  eligibility: typeof loadMiNoteEligibility;
  cache: WorkerDependencies['cache'];
  log: WorkerDependencies['log'];
};

const defaults: PreorderDependencies = {
  nowMs: Date.now, providerFetch: (input, init) => fetch(input, init), timeoutMs: 45_000,
  verifyIdentity: verifyRequestIdentity, prepare: preparePreorderTransaction, authorize: authorizePreorderTransaction,
  probe: probePreorderTransaction, send: sendPreorderTransaction, blockhashValid: isPreorderBlockhashValid,
  verifyEthereumSession: verifyMiNoteSession, eligibility: loadMiNoteEligibility, cache: null, log: (entry) => console.log(entry),
};

function collectionConfig(preorderId: string): PreorderConfig {
  const config = getPreorderConfig(preorderId);
  if (!config) {
    throw new ProfileReadError('failed-precondition', 409, 'Preorders are not available for this collection.');
  }
  return config;
}

function enabledConfig(preorderId: string): PreorderConfig {
  const config = collectionConfig(preorderId);
  if (!config.enabled) {
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
  if (outcome.status === 'confirmed') {
    const confirmed = await store.confirm(order, outcome.slot, dependencies.nowMs());
    if (order.confirmedSlot == null && confirmed.status === 'submitted' && confirmed.confirmedSlot != null) {
      console.log({ event: 'preorder_confirmed', orderId: order.orderId, preorderId: order.preorderId, slot: confirmed.confirmedSlot });
    }
    return confirmed;
  }
  if (outcome.status !== 'pending') {
    const finished = await store.finish(order, outcome.status === 'finalized' ? 'succeeded' : outcome.status,
      dependencies.nowMs(), outcome.status === 'finalized' ? outcome.slot : undefined);
    if (finished.status !== 'submitted') {
      console.log({ event: finished.status === 'succeeded' ? 'preorder_finalized'
        : finished.confirmedSlot != null ? 'preorder_optimistic_rollback' : 'preorder_resolved',
        orderId: order.orderId, preorderId: order.preorderId, status: finished.status, confirmedSlot: finished.confirmedSlot ?? null });
    }
    return finished;
  }
  if (options.rebroadcast) {
    await broadcastOrder(order, args, dependencies);
  }
  await store.defer(order, dependencies.nowMs());
  return (await store.get(order.orderId))!;
}

function assertRequestMatches(order: StoredPreorder, ids: number[], ethereumAddress: string): void {
  if (order.ethereumAddress !== ethereumAddress) {
    throw new ProfileReadError('permission-denied', 403, 'This preorder belongs to another verified Ethereum wallet.');
  }
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
  defer?: DeferredWork,
) {
  const dependencies = { ...defaults, ...overrides };
  const path = new URL(request.url).pathname;
  const availabilityRequest = path === '/preorders/availability';
  const expectedMethods = availabilityRequest ? ['GET', 'POST'] : ['POST'];
  if (!expectedMethods.includes(request.method)) {
    await request.body?.cancel().catch(() => undefined);
    return { response: jsonResponse({ error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405,
      { headers: { Allow: `${expectedMethods.join(', ')}, OPTIONS` } }), metrics: { upstreamCalls: 0, providerDurationMs: 0 }, authOutcome: 'rejected' as const };
  }
  const deferred: Promise<unknown>[] = [];
  const result = await withAuthenticatedRequest(request, { authContext, opsDb: env.OPS_DB, dependencies,
    timeoutMessage: 'Preorder request timed out.' }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    const deps = { ...dependencies, providerFetch: trackedFetch };
    let authenticated = false;
    try {
      const raw = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams)
        : await readBoundedRequestJson(request, { maxBytes: 4096, signal: deadline.signal,
          createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid preorder request.') });
      const schema = availabilityRequest ? availabilitySchema : path.endsWith('/prepare') ? prepareSchema : path.endsWith('/submit') ? submitSchema
        : path.endsWith('/cancel') ? orderSchema : statusSchema;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid preorder request.');
      const body = parsed.data;
      const includeRecoveries = path === '/preorders/status' && 'includeRecoveries' in body && body.includeRecoveries === true;
      const config = path === '/preorders/availability' ? collectionConfig(body.preorderId) : enabledConfig(body.preorderId);
      if ((await loadCommerceAuthorityControl(env.COMMERCE_DB)).state !== 'd1') {
        throw new ProfileReadError('unavailable', 503, 'Preorders are temporarily unavailable for maintenance.');
      }
      const store = new PreorderStore(env.COMMERCE_DB);
      if (config.enabled && !includeRecoveries) await store.expirePrepared(deps.nowMs());
      const eligibility = (address: string, buyer: string | null, fresh: boolean) => deps.eligibility({
        request, env, config, address, buyer, fresh, deadline, metrics,
        dependencies: { providerFetch: dependencies.providerFetch, cache: deps.cache, log: deps.log, now: deps.nowMs },
        defer: defer ?? ((work) => deferred.push(work)),
      });
      if (path === '/preorders/availability') {
        const session = await deps.verifyEthereumSession(request, env.OPS_DB, config.preorderId, deps.nowMs());
        let optionalBuyer: string | null = null;
        if (authContext.verifiedStaffIdentity || request.headers.has('Authorization') || request.headers.get('Cookie')?.trim()) {
          const identity = await authenticate();
          optionalBuyer = await resolveRequestWallet(identity, async (subject) => {
            const resolution = await resolveD1AuthWalletBinding(env.OPS_DB, subject, deadline.signal);
            return 'reason' in resolution ? null : resolution.wallet;
          });
        }
        authenticated = true;
        const owned = await eligibility(session.address, optionalBuyer, false);
        const claims = new Map((await store.claims(config.cluster, config.collection)).map((claim) => [claim.id, claim]));
        return { response: jsonResponse({ preorderId: config.preorderId, ethereumAddress: session.address,
          ownershipStatus: owned.ownershipStatus, requiresAdminSignIn: owned.requiresAdminSignIn,
          items: owned.cardIds.flatMap((id) => {
            const claim = claims.get(id);
            if (claim && claim.buyer !== optionalBuyer) return [];
            return [{ id, status: claim?.status ?? 'available' }];
          }) }, 200),
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
        const session = await deps.verifyEthereumSession(request, env.OPS_DB, config.preorderId, deps.nowMs());
        let existing = await store.request(config.preorderId, buyer, input.requestId);
        if (existing) {
          assertRequestMatches(existing, ids, session.address);
          existing = await reconcileOrder(existing, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
          return { response: jsonResponse(preparedResponse(existing), 200), metrics, authOutcome: 'accepted' as const };
        }
        await enforcePrepareLimit(env, request, buyer, requestIdentitySubject(identity));
        const active = await store.active(config.preorderId, buyer);
        if (active) {
          const current = await reconcileOrder(active, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
          if (current.status === 'prepared' || current.status === 'submitted' && current.confirmedSlot == null) {
            throw new ProfileReadError('failed-precondition', 409, 'Finish or cancel your current preorder first.', { order: publicPreorder(current) });
          }
        }
        const claims = await store.claims(config.cluster, config.collection);
        for (const orderId of new Set(claims.filter((claim) => ids.includes(claim.id) && claim.status === 'reserved').map((claim) => claim.orderId))) {
          const reserved = await store.get(orderId);
          if (reserved) await reconcileOrder(reserved, store, env, deps, deadline.signal, { checkPreparedBlockhash: true });
        }
        assertMiNoteEligibility(await eligibility(session.address, buyer, true), ids);
        const prepared = await deps.prepare({ ...rpcArgs(env, config, deps, deadline.signal), buyer, ids, cosignerSecret: env.COSIGNER_SECRET });
        const nowMs = deps.nowMs();
        const order = await store.reserve({ orderId: crypto.randomUUID(), preorderId: config.preorderId, buyer, ethereumAddress: session.address,
          cardIds: ids, assets: prepared.assets, status: 'prepared', expiresAtMs: nowMs + PREORDER_RESERVATION_TTL_MS,
          signature: null, cluster: config.cluster, collection: config.collection, requestId: input.requestId,
          preparedTransaction: prepared.transactionBase64, signedTransaction: null, blockhash: prepared.blockhash,
          blockhashContextSlot: prepared.blockhashContextSlot, lastValidBlockHeight: prepared.lastValidBlockHeight,
          createdAtMs: nowMs, revision: 1 });
        assertRequestMatches(order, ids, session.address);
        return { response: jsonResponse(preparedResponse(order), 200), metrics, authOutcome: 'accepted' as const };
      }
      if (includeRecoveries) {
        const cursor = 'recoveryCursor' in body && typeof body.recoveryCursor === 'string' ? body.recoveryCursor : undefined;
        const page = await store.recoveries(config.preorderId, buyer, cursor);
        return { response: jsonResponse({ order: page.foreground ? publicPreorder(page.foreground) : null,
          recoveries: page.orders.map(publicPreorder), nextRecoveryCursor: page.nextCursor }, 200),
          metrics, authOutcome: 'accepted' as const };
      }
      const orderId = 'orderId' in body && typeof body.orderId === 'string' ? body.orderId : undefined;
      let order = orderId ? await store.get(orderId) : await store.legacyActive(config.preorderId, buyer);
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
          if (!order.ethereumAddress) throw new ProfileReadError('failed-precondition', 409, 'Cancel this older preorder and select your verified cards again.');
          const session = await deps.verifyEthereumSession(request, env.OPS_DB, config.preorderId, deps.nowMs());
          assertRequestMatches(order, order.cardIds, session.address);
          assertMiNoteEligibility(await eligibility(session.address, buyer, true), order.cardIds);
          if (session.expiresAtMs <= deps.nowMs()) {
            throw new ProfileReadError('unauthenticated', 401, 'Verify your Ethereum wallet again before preordering.');
          }
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
        internalMessage: 'Preorder request failed.', mapDomainError: (error) => error instanceof MiNoteAuthError ? { error } : undefined });
      if (failure.unexpected) console.error({ event: 'preorder_request_failed', error: error instanceof Error ? error.name : 'UnknownError' });
      return { response: jsonResponse(apiErrorBody(failure.error), httpStatusForApiErrorCode(failure.error.code, 503)),
        metrics, authOutcome: failure.authOutcome };
    }
  });
  await Promise.all(deferred);
  return result;
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
