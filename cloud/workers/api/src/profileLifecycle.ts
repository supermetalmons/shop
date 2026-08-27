import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { WALLET_SESSION_SUPERSEDED_ERROR_REASON } from '../../../../shared/apiErrorCode.js';
import {
  buildWalletDeliveryRecoveryState,
  preparedDeliveryRecoveryNextCheckMs,
  processingDeliveryRecoveryNextCheckMs,
} from '../../../../shared/deliveryRecovery.js';
import { isStaffWalletAddress } from '../../../../shared/fulfillmentAccess.js';
import { parseDropDeliveryOrderPath } from './dropPaths.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { stripeCheckoutAnonymousOwnerId } from '../../../../shared/stripeCheckoutSession.js';
import type {
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
} from '../../../../shared/contracts.js';
import {
  WalletLifecycleValidationError,
  canonicalWalletAddress,
  parseSolanaSignInMessage,
  validateSolanaSignInMessage,
} from '../../../../shared/walletLifecycle.js';
import {
  RequestIdentityError,
  isStaffRequestIdentity,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  readBoundedText,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import { ProfileReadError } from './dataAccess.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  type CommerceDocumentRecord,
} from './commerceRepository.js';
import { isProfileRequestOriginAllowed } from './profileReads.js';
import { ensureD1Profile } from './profileD1.js';
import {
  AuthWalletBindingD1BusyError,
  AuthWalletBindingD1SupersededError,
  acquireAuthWalletBindingReconcileLease,
  establishD1AuthWalletBinding,
  loadD1AuthWalletBinding,
  releaseAuthWalletBindingReconcileLease,
  resolveD1AuthWalletBinding,
} from './authWalletBindingD1.js';

export const SOLANA_AUTH_PATH = '/auth/solana';
export const PROFILE_RECONCILE_PATH = '/profile/reconcile';
export const PROFILE_LIFECYCLE_PATHS = new Set([SOLANA_AUTH_PATH, PROFILE_RECONCILE_PATH]);

export type ProfileLifecyclePath = typeof SOLANA_AUTH_PATH | typeof PROFILE_RECONCILE_PATH;

const AUTH_TIMEOUT_MS = 15_000;
const RECONCILE_TIMEOUT_MS = 55_000;
const MAX_REQUEST_BYTES = 4096;
const COMMERCE_TRANSACTION_ATTEMPTS = 5;
const STRIPE_OWNER_MERGE_BATCH_SIZE = 450;

const solanaAuthSchema = z.object({
  wallet: z.string().min(32).max(64),
  message: z.string().min(1).max(1024),
  signature: z.array(z.number().int().min(0).max(255)).length(64),
}).strict();

const reconcileSchema = z.object({
  mergeStripeDeliveryOrders: z.boolean().optional(),
  includeDeliveryRecovery: z.boolean().optional(),
}).strict();

type ProfileLifecycleRepository = Pick<D1CommerceRepository, 'query' | 'run'>;

type CommerceCommon = {
  nowMs: number;
  repository: ProfileLifecycleRepository;
  signal: AbortSignal;
};

type ProfileLifecycleMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type ProfileLifecycleResult = {
  response: Response;
  metrics: ProfileLifecycleMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  mergedStripeDeliveryOrders?: number;
};

type ProfileLifecycleDependencies = {
  acquireAuthWalletBindingReconcileLease: typeof acquireAuthWalletBindingReconcileLease;
  createCommerceRepository: (db: D1Database) => ProfileLifecycleRepository;
  establishD1AuthWalletBinding: typeof establishD1AuthWalletBinding;
  isStaffWallet: typeof isStaffWalletAddress;
  loadD1AuthWalletBinding: typeof loadD1AuthWalletBinding;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  upsertProfile: (
    db: D1Database | undefined,
    profile: Parameters<typeof ensureD1Profile>[1],
    signal: AbortSignal,
  ) => Promise<void>;
  releaseAuthWalletBindingReconcileLease: typeof releaseAuthWalletBindingReconcileLease;
  resolveD1AuthWalletBinding: typeof resolveD1AuthWalletBinding;
  verifyIdentity: typeof verifyRequestIdentity;
};

type ProfileLifecycleEnv = Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'OPS_DB'>>;

class AuthWalletBindingSupersededError extends ProfileReadError {
  constructor() {
    super(
      'failed-precondition',
      409,
      'A newer wallet sign-in superseded this request. Sign in again.',
      { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    );
    this.name = 'AuthWalletBindingSupersededError';
  }
}

class StripeOwnerMergeUnexpectedPathError extends ProfileReadError {
  constructor() {
    super(
      'failed-precondition',
      409,
      'Stripe order reconciliation found invalid server data.',
      { reason: 'unexpected-delivery-order-path' },
    );
    this.name = 'StripeOwnerMergeUnexpectedPathError';
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, error.status);
}

async function parseRequestBody(
  request: Request,
  path: ProfileLifecyclePath,
  signal: AbortSignal,
): Promise<z.infer<typeof solanaAuthSchema> | ReconcileProfileStateRequest> {
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  if (!request.body) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  let text: string;
  try {
    text = await readBoundedText(new Response(request.body), MAX_REQUEST_BYTES, signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const result = path === SOLANA_AUTH_PATH
    ? solanaAuthSchema.safeParse(value)
    : reconcileSchema.safeParse(value);
  if (!result.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  return result.data;
}

async function pauseForConflict(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const delay = Math.min(400, 25 * 2 ** attempt);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delay);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validateAuthWalletSignature(params: {
  identity: Extract<RequestIdentity, { kind: 'anonymous' }>;
  message: string;
  nowMs: number;
  originHostname: string;
  signature: number[];
  wallet: string;
}): void {
  const statement = parseSolanaSignInMessage(params.message);
  validateSolanaSignInMessage({
    message: statement,
    nowMs: params.nowMs,
    originHostname: params.originHostname,
    uid: params.identity.authSubject,
    wallet: params.wallet,
  });
  const signatureValid = nacl.sign.detached.verify(
    new TextEncoder().encode(params.message),
    Uint8Array.from(params.signature),
    bs58.decode(params.wallet),
  );
  if (!signatureValid) throw new ProfileReadError('unauthenticated', 401, 'Invalid signature');
}

function deliveryOrderPath(document: CommerceDocumentRecord): string {
  const path = document.key.path;
  const identity = parseDropDeliveryOrderPath(path);
  if (!identity) throw new StripeOwnerMergeUnexpectedPathError();
  const normalizedDropId = normalizeDropId(identity.dropId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedDropId)) throw new StripeOwnerMergeUnexpectedPathError();
  return path;
}

async function mergeStripeOwnerBatch(params: {
  common: CommerceCommon;
  authSubject: string;
  sourceOwner: string;
  wallet: string;
}): Promise<number> {
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await params.common.repository.run(params.common.nowMs, async (unit) => {
        const documents = await unit.query({
          filters: [{ field: 'owner', op: 'equal', value: params.sourceOwner }],
          kind: 'delivery_order',
          limit: STRIPE_OWNER_MERGE_BATCH_SIZE,
        });
        if (documents.length > STRIPE_OWNER_MERGE_BATCH_SIZE) {
          throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
        }
        for (const document of documents) {
          deliveryOrderPath(document);
          await unit.update(document.key, {
            mergedAuthSubject: params.authSubject,
            owner: params.wallet,
            ownerKind: 'wallet',
            ownerMergedAt: commerceFieldValue.serverTimestamp(),
            previousOwner: stripeCheckoutAnonymousOwnerId(params.authSubject),
          });
        }
        return documents.length;
      });
    } catch (error) {
      if (!(error instanceof CommerceWriteConflict)) throw error;
      if (attempt + 1 >= COMMERCE_TRANSACTION_ATTEMPTS) {
        throw new ProfileReadError('aborted', 409, 'Stripe order reconciliation changed. Try again.');
      }
      await pauseForConflict(params.common.signal, attempt);
    }
  }
  return 0;
}

async function mergeStripeOrders(params: {
  common: CommerceCommon;
  authSubject: string;
  wallet: string;
}): Promise<number> {
  let merged = 0;
  for (const sourceOwner of [stripeCheckoutAnonymousOwnerId(params.authSubject)]) {
    for (;;) {
      const batchCount = await mergeStripeOwnerBatch({ ...params, sourceOwner });
      merged += batchCount;
      if (batchCount < STRIPE_OWNER_MERGE_BATCH_SIZE) break;
    }
  }
  return merged;
}

async function loadDeliveryRecoveryState(common: CommerceCommon, wallet: string, nowMs: number) {
  const documents = await common.repository.query({
    filters: [
      { field: 'owner', op: 'equal', value: wallet },
      { field: 'status', op: 'in', value: ['processing', 'prepared'] },
    ],
    kind: 'delivery_order',
  });
  let remainingProcessing = 0;
  const nextCheckCandidates: Array<number | null> = [];
  for (const document of documents) {
    if (document.data.status === 'processing') {
      remainingProcessing += 1;
      nextCheckCandidates.push(processingDeliveryRecoveryNextCheckMs(document.data, nowMs));
    } else if (document.data.status === 'prepared') {
      nextCheckCandidates.push(preparedDeliveryRecoveryNextCheckMs(document.data, nowMs));
    }
  }
  return buildWalletDeliveryRecoveryState({ remainingProcessing, nextCheckCandidates });
}

async function reconcileProfileState(params: {
  body: ReconcileProfileStateRequest;
  common: CommerceCommon;
  db: D1Database | undefined;
  dependencies: Pick<ProfileLifecycleDependencies,
    | 'acquireAuthWalletBindingReconcileLease'
    | 'releaseAuthWalletBindingReconcileLease'
    | 'resolveD1AuthWalletBinding'
  >;
  identity: RequestIdentity;
  nowMs: number;
}): Promise<ReconcileProfileStateResponse> {
  let wallet: string;
  let mergedStripeDeliveryOrders = 0;
  if (!params.db) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  if (params.identity.kind === 'staff-wallet') {
    wallet = params.identity.wallet;
  } else if (params.body.mergeStripeDeliveryOrders === true) {
    let lease;
    try {
      lease = await params.dependencies.acquireAuthWalletBindingReconcileLease({
        db: params.db,
        authSubject: params.identity.authSubject,
        nowMs: params.nowMs,
        signal: params.common.signal,
      });
    } catch (error) {
      if (error instanceof AuthWalletBindingD1BusyError) {
        throw new ProfileReadError('aborted', 409, error.message);
      }
      throw error;
    }
    if (!lease) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    wallet = lease.wallet;
    try {
      mergedStripeDeliveryOrders = await mergeStripeOrders({
        authSubject: params.identity.authSubject,
        common: params.common,
        wallet,
      });
    } finally {
      await params.dependencies.releaseAuthWalletBindingReconcileLease(
        params.db,
        params.identity.authSubject,
        lease.id,
      ).catch((error) => console.error({
        event: 'auth_wallet_binding_reconcile_lease_release_failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  } else {
    const resolution = await params.dependencies.resolveD1AuthWalletBinding(
      params.db,
      params.identity.authSubject,
      params.common.signal,
    );
    if ('reason' in resolution) {
      throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    }
    wallet = resolution.wallet;
  }
  const recovery = params.body.includeDeliveryRecovery === false
    ? null
    : await loadDeliveryRecoveryState(params.common, wallet, params.nowMs);
  return {
    mergedStripeDeliveryOrders,
    ...(recovery?.nextCheckAt == null ? {} : { deliveryRecovery: { nextCheckAt: recovery.nextCheckAt } }),
  };
}


const defaultDependencies: ProfileLifecycleDependencies = {
  acquireAuthWalletBindingReconcileLease,
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  establishD1AuthWalletBinding,
  isStaffWallet: isStaffWalletAddress,
  loadD1AuthWalletBinding,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: AUTH_TIMEOUT_MS,
  upsertProfile: async (db, profile, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    await ensureD1Profile(db, profile, signal);
  },
  releaseAuthWalletBindingReconcileLease,
  resolveD1AuthWalletBinding,
  verifyIdentity: verifyRequestIdentity,
};

export async function handleProfileLifecycleRequest(
  request: Request,
  env: ProfileLifecycleEnv,
  path: ProfileLifecyclePath,
  overrides: Partial<ProfileLifecycleDependencies> = {},
): Promise<ProfileLifecycleResult> {
  const dependencies = {
    ...defaultDependencies,
    timeoutMs: path === PROFILE_RECONCILE_PATH ? RECONCILE_TIMEOUT_MS : AUTH_TIMEOUT_MS,
    ...overrides,
  };
  const metrics: ProfileLifecycleMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new ProfileReadError('invalid-argument', 405, 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response, metrics, authOutcome: 'rejected' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Profile lifecycle request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: RequestIdentity | undefined;
  try {
    const origin = request.headers.get('Origin') || '';
    if (path === SOLANA_AUTH_PATH && (!origin || !isProfileRequestOriginAllowed(request))) {
      throw new ProfileReadError('permission-denied', 403, 'Origin is not allowed.');
    }
    const body = await parseRequestBody(request, path, controller.signal);
    identity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      controller.signal,
      dependencies.nowMs(),
    );
    const nowMs = dependencies.nowMs();
    const common: CommerceCommon = {
      nowMs,
      repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
      signal: controller.signal,
    };
    if (path === SOLANA_AUTH_PATH) {
      if (isStaffRequestIdentity(identity)) {
        throw new ProfileReadError('permission-denied', 403, 'Staff wallets use staff authentication.');
      }
      const authBody = body as z.infer<typeof solanaAuthSchema>;
      const wallet = canonicalWalletAddress(authBody.wallet);
      if (!wallet) throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address');
      if (dependencies.isStaffWallet(wallet)) {
        throw new ProfileReadError('permission-denied', 403, 'Staff wallets use staff authentication.');
      }
      const originHostname = new URL(origin).hostname;
      if (!env.OPS_DB) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
      try {
        const baseline = await dependencies.loadD1AuthWalletBinding(
          env.OPS_DB,
          identity.authSubject,
          controller.signal,
        );
        validateAuthWalletSignature({
          identity,
          message: authBody.message,
          nowMs,
          originHostname,
          signature: authBody.signature,
          wallet,
        });
        await dependencies.establishD1AuthWalletBinding({
          authSubject: identity.authSubject,
          baseline,
          db: env.OPS_DB,
          nowMs,
          signal: controller.signal,
          wallet,
        });
      } catch (error) {
        if (error instanceof AuthWalletBindingD1SupersededError) throw new AuthWalletBindingSupersededError();
        if (error instanceof AuthWalletBindingD1BusyError) {
          throw new ProfileReadError('aborted', 409, error.message);
        }
        if (
          error instanceof ProfileReadError ||
          error instanceof WalletLifecycleValidationError ||
          controller.signal.aborted
        ) throw error;
        throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
      }
      try {
        await dependencies.upsertProfile(
          env.OPS_DB,
          { wallet, createdAtMs: nowMs, updatedAtMs: nowMs },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
      }
      return { response: jsonResponse({ wallet }, 200), metrics, authOutcome: 'accepted' };
    }
    let response: ReconcileProfileStateResponse;
    try {
      response = await reconcileProfileState({
        body: body as ReconcileProfileStateRequest,
        common,
        db: env.OPS_DB,
        dependencies,
        identity,
        nowMs,
      });
    } catch (error) {
      if (error instanceof ProfileReadError || controller.signal.aborted) throw error;
      throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
    }
    return {
      response: jsonResponse(response, 200),
      metrics,
      authOutcome: 'accepted',
      mergedStripeDeliveryOrders: response.mergedStripeDeliveryOrders,
    };
  } catch (error) {
    let profileError: ProfileReadError;
    let authOutcome: ProfileLifecycleResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (error instanceof ProfileReadError) {
      profileError = error;
      if ([
        'unauthenticated',
        'permission-denied',
        'invalid-argument',
        'not-found',
        'aborted',
        'failed-precondition',
      ].includes(error.code)) authOutcome = 'rejected';
    } else if (error instanceof WalletLifecycleValidationError) {
      const status = error.code === 'permission-denied' ? 403 : error.code === 'failed-precondition' ? 409 : 400;
      profileError = new ProfileReadError(error.code, status, error.message);
      authOutcome = 'rejected';
    } else if (error instanceof RequestIdentityError) {
      if (error.kind === 'invalid-token') {
        profileError = new ProfileReadError('unauthenticated', 401, 'Authentication is required.');
        authOutcome = 'rejected';
      } else if (error.kind === 'provider-timeout') {
        profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
      } else {
        profileError = new ProfileReadError('unavailable', 502, 'Authentication is temporarily unavailable.');
      }
    } else if (controller.signal.aborted) {
      profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
    } else {
      profileError = new ProfileReadError('internal', 500, 'Profile request failed.');
    }
    return { response: errorResponse(profileError), metrics, authOutcome };
  } finally {
    clearTimeout(timeout);
  }
}
