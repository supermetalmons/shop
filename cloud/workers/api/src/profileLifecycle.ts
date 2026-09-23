import { parseDeliveryRecoveryState } from './deliveryOrderReadModel.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { WALLET_SESSION_SUPERSEDED_ERROR_REASON } from '../../../../shared/apiErrorCode.js';
import {
  buildWalletDeliveryRecoveryState,
} from '../../../../shared/deliveryRecovery.js';
import { isStaffWalletAddress } from '../../../../shared/fulfillmentAccess.js';
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
  type RequestAuthContext,
  RequestIdentityError,
  isStaffRequestIdentity,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { classifyAuthenticatedRequestError, requestIdentityErrorDetails, withAuthenticatedRequest } from './authenticatedRequest.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import {
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import { ProfileReadError } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import {
  D1CommerceRepository,
} from './commerceRepository.js';
import { mergeAnonymousStripeOwnerBatch, STRIPE_OWNER_MERGE_BATCH_SIZE } from './profileCommerceStore.js';
import { isProfileRequestOriginAllowed } from './profileReadSupport.js';
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

const solanaAuthSchema = z.object({
  wallet: z.string().min(32).max(64),
  message: z.string().min(1).max(1024),
  signature: z.array(z.number().int().min(0).max(255)).length(64),
}).strict();

const reconcileSchema = z.object({
  mergeStripeDeliveryOrders: z.boolean().optional(),
  includeDeliveryRecovery: z.boolean().optional(),
}).strict();

type ProfileLifecycleRepository = Pick<D1CommerceRepository, 'queryDeliveryRecoveryOrders' | 'run'>;

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
  defer: DeferredWork;
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

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse(apiErrorBody(error), error.status);
}

async function parseRequestBody(
  request: Request,
  path: ProfileLifecyclePath,
  signal: AbortSignal,
): Promise<z.infer<typeof solanaAuthSchema> | ReconcileProfileStateRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: MAX_REQUEST_BYTES,
    signal,
    createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid request.'),
  });
  const result = path === SOLANA_AUTH_PATH
    ? solanaAuthSchema.safeParse(value)
    : reconcileSchema.safeParse(value);
  if (!result.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  return result.data;
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

async function mergeStripeOrders(params: {
  common: CommerceCommon;
  authSubject: string;
  wallet: string;
}): Promise<number> {
  let merged = 0;
  for (;;) {
    const batchCount = await mergeAnonymousStripeOwnerBatch(params);
    merged += batchCount;
    if (batchCount < STRIPE_OWNER_MERGE_BATCH_SIZE) break;
  }
  return merged;
}

async function loadDeliveryRecoveryState(common: CommerceCommon, wallet: string, nowMs: number) {
  const documents = await common.repository.queryDeliveryRecoveryOrders(wallet);
  let remainingProcessing = 0;
  const nextCheckCandidates: Array<number | null> = [];
  for (const document of documents) {
    const recovery = parseDeliveryRecoveryState(document.data);
    if (recovery.status === 'processing') {
      remainingProcessing += 1;
      nextCheckCandidates.push(recovery.processingNextCheckAt(nowMs));
    } else if (recovery.status === 'prepared') {
      nextCheckCandidates.push(recovery.preparedNextCheckAt(nowMs));
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
  const db = params.db;
  if (!db) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  if (params.identity.kind === 'staff-wallet') {
    wallet = params.identity.wallet;
  } else if (params.body.mergeStripeDeliveryOrders === true) {
    const authSubject = params.identity.authSubject;
    const leaseId = crypto.randomUUID();
    const releaseLease = async (id: string) => {
      try {
        await params.dependencies.releaseAuthWalletBindingReconcileLease(
          db,
          authSubject,
          id,
        );
      } catch (error) {
        console.error({
          event: 'auth_wallet_binding_reconcile_lease_release_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    let lease;
    try {
      lease = await params.dependencies.acquireAuthWalletBindingReconcileLease({
        db,
        authSubject,
        leaseId,
        nowMs: params.nowMs,
        signal: params.common.signal,
      });
    } catch (error) {
      await releaseLease(leaseId);
      if (isSignalCancellationError(params.common.signal, error)) throw params.common.signal.reason;
      if (error instanceof AuthWalletBindingD1BusyError) {
        throw new ProfileReadError('aborted', 409, error.message);
      }
      throw error;
    }
    if (!lease) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    wallet = lease.wallet;
    try {
      if (params.common.signal.aborted) throw params.common.signal.reason;
      mergedStripeDeliveryOrders = await mergeStripeOrders({
        authSubject,
        common: params.common,
        wallet,
      });
    } finally {
      await releaseLease(lease.id);
    }
  } else {
    const resolution = await params.dependencies.resolveD1AuthWalletBinding(
      db,
      params.identity.authSubject,
      params.common.signal,
    );
    if ('reason' in resolution) {
      throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    }
    wallet = resolution.wallet;
  }
  if (params.common.signal.aborted) throw params.common.signal.reason;
  const recovery = params.body.includeDeliveryRecovery === false
    ? null
    : await loadDeliveryRecoveryState(params.common, wallet, params.nowMs);
  if (params.common.signal.aborted) throw params.common.signal.reason;
  return {
    mergedStripeDeliveryOrders,
    ...(recovery?.nextCheckAt == null ? {} : { deliveryRecovery: { nextCheckAt: recovery.nextCheckAt } }),
  };
}


const defaultDependencies: ProfileLifecycleDependencies = {
  acquireAuthWalletBindingReconcileLease,
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  defer: () => undefined,
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
  authContext: RequestAuthContext = {},
  overrides: Partial<ProfileLifecycleDependencies> = {},
): Promise<ProfileLifecycleResult> {
  const dependencies = {
    ...defaultDependencies,
    timeoutMs: path === PROFILE_RECONCILE_PATH ? RECONCILE_TIMEOUT_MS : AUTH_TIMEOUT_MS,
    ...overrides,
  };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new ProfileReadError('invalid-argument', 405, 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response, metrics: { upstreamCalls: 0, providerDurationMs: 0 }, authOutcome: 'rejected' };
  }
  return withAuthenticatedRequest<ProfileLifecycleResult>(request, {
    authContext,
    opsDb: env.OPS_DB,
    timeoutMessage: 'Profile lifecycle request timed out',
    dependencies,
  }, async ({ deadline, metrics, authenticate }) => {
    let identity: RequestIdentity | undefined;
    try {
      const origin = request.headers.get('Origin') || '';
      if (path === SOLANA_AUTH_PATH && (!origin || !isProfileRequestOriginAllowed(request))) {
        throw new ProfileReadError('permission-denied', 403, 'Origin is not allowed.');
      }
      const body = await parseRequestBody(request, path, deadline.signal);
      const verifiedIdentity = await authenticate();
      identity = verifiedIdentity;
      const nowMs = dependencies.nowMs();
      const common: CommerceCommon = {
        nowMs,
        repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
        signal: deadline.signal,
      };
      if (path === SOLANA_AUTH_PATH) {
        if (isStaffRequestIdentity(verifiedIdentity)) {
          throw new ProfileReadError('permission-denied', 403, 'Staff wallets use staff authentication.');
        }
        const authBody = body as z.infer<typeof solanaAuthSchema>;
        const wallet = canonicalWalletAddress(authBody.wallet);
        if (!wallet) throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address');
        if (dependencies.isStaffWallet(wallet)) {
          throw new ProfileReadError('permission-denied', 403, 'Staff wallets use staff authentication.');
        }
        const originHostname = new URL(origin).hostname;
        const opsDb = env.OPS_DB;
        if (!opsDb) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
        try {
          const baseline = await raceReadWithSignal(
            dependencies.loadD1AuthWalletBinding(
              opsDb,
              verifiedIdentity.authSubject,
              deadline.signal,
            ),
            deadline.signal,
          );
          validateAuthWalletSignature({
            identity: verifiedIdentity,
            message: authBody.message,
            nowMs,
            originHostname,
            signature: authBody.signature,
            wallet,
          });
          await runCriticalRequestOperation(
            () => dependencies.establishD1AuthWalletBinding({
              authSubject: verifiedIdentity.authSubject,
              baseline,
              db: opsDb,
              nowMs,
              signal: deadline.signal,
              wallet,
            }),
            { deadline, defer: dependencies.defer },
          );
        } catch (error) {
          rethrowDeferredWorkRegistrationError(error);
          if (isSignalCancellationError(deadline.signal, error)) throw deadline.signal.reason;
          if (error instanceof AuthWalletBindingD1SupersededError) throw new AuthWalletBindingSupersededError();
          if (error instanceof AuthWalletBindingD1BusyError) {
            throw new ProfileReadError('aborted', 409, error.message);
          }
          if (
            error instanceof ProfileReadError ||
            error instanceof WalletLifecycleValidationError
          ) throw error;
          throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
        }
        try {
          await runCriticalRequestOperation(
            () => dependencies.upsertProfile(
              opsDb,
              { wallet, createdAtMs: nowMs, updatedAtMs: nowMs },
              deadline.signal,
            ),
            { deadline, defer: dependencies.defer },
          );
        } catch (error) {
          rethrowDeferredWorkRegistrationError(error);
          if (isSignalCancellationError(deadline.signal, error)) throw deadline.signal.reason;
          throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
        }
        return { response: jsonResponse({ wallet }, 200), metrics, authOutcome: 'accepted' };
      }
      let response: ReconcileProfileStateResponse;
      try {
        const reconciliation = () => reconcileProfileState({
          body: body as ReconcileProfileStateRequest,
          common,
          db: env.OPS_DB,
          dependencies,
          identity: verifiedIdentity,
          nowMs,
        });
        response = (body as ReconcileProfileStateRequest).mergeStripeDeliveryOrders === true
          ? await runCriticalRequestOperation(reconciliation, { deadline, defer: dependencies.defer })
          : await raceReadWithSignal(reconciliation(), deadline.signal);
      } catch (error) {
        rethrowDeferredWorkRegistrationError(error);
        if (isSignalCancellationError(deadline.signal, error)) throw deadline.signal.reason;
        if (error instanceof ProfileReadError) throw error;
        throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
      }
      return {
        response: jsonResponse(response, 200),
        metrics,
        authOutcome: 'accepted',
        mergedStripeDeliveryOrders: response.mergedStripeDeliveryOrders,
      };
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isRequestCancellationError(request, error)) throw error;
      const { error: classified, authOutcome } = classifyAuthenticatedRequestError(error, {
        authenticated: Boolean(identity),
        timedOut: deadline.timedOut(),
        timeoutPrecedence: 'after-known-errors',
        timeoutMessage: 'Profile request timed out.',
        internalMessage: 'Profile request failed.',
        mapDomainError: (failure) => {
          if (failure instanceof ProfileReadError) {
            return {
              error: failure,
              authOutcome: ['unauthenticated', 'permission-denied', 'invalid-argument', 'not-found', 'aborted', 'failed-precondition'].includes(failure.code)
                ? 'rejected' : identity ? 'provider-failure' : 'rejected',
            };
          }
          if (failure instanceof WalletLifecycleValidationError) return { error: failure, authOutcome: 'rejected' };
          if (failure instanceof RequestIdentityError) {
            return {
              error: requestIdentityErrorDetails(failure, { code: 'deadline-exceeded', message: 'Profile request timed out.' }),
              authOutcome: failure.kind === 'invalid-token' ? 'rejected' : identity ? 'provider-failure' : 'rejected',
            };
          }
          return undefined;
        },
      });
      const profileError = classified instanceof ProfileReadError ? classified : new ProfileReadError(
        classified.code, httpStatusForApiErrorCode(classified.code, 502), classified.message, classified.details,
      );
      return { response: errorResponse(profileError), metrics, authOutcome };
    }
  });
}
