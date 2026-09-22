import { createRequestDeadline, type RequestDeadline } from './boundedRequest.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import type { ApiErrorLike } from './httpResponse.js';
import { RequestIdentityError, type RequestAuthContext, type RequestIdentity, type verifyRequestIdentity } from './requestIdentity.js';

export function requestIdentityErrorDetails(
  error: RequestIdentityError,
  timeout: { code: 'deadline-exceeded' | 'unavailable'; message: string },
): { code: 'unauthenticated' | 'deadline-exceeded' | 'unavailable'; message: string } {
  if (error.kind === 'invalid-token') {
    return { code: 'unauthenticated', message: 'Authentication is required.' };
  }
  if (error.kind === 'provider-timeout') return { ...timeout };
  return { code: 'unavailable', message: 'Authentication is temporarily unavailable.' };
}

type RequestFailureAuthOutcome = 'rejected' | 'provider-failure';

type MappedRequestError = {
  error: ApiErrorLike;
  authOutcome?: RequestFailureAuthOutcome;
};

type ClassifiedRequestError = {
  error: ApiErrorLike;
  authOutcome: RequestFailureAuthOutcome;
  unexpected: boolean;
};

const REJECTED_REQUEST_ERROR_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'invalid-argument', 'unauthenticated', 'permission-denied',
  'not-found', 'failed-precondition', 'resource-exhausted',
]);

export function classifyAuthenticatedRequestError(
  error: unknown,
  options: {
    authenticated: boolean;
    fallbackAuthOutcome?: RequestFailureAuthOutcome;
    timedOut: boolean;
    timeoutPrecedence: 'before-known-errors' | 'after-known-errors';
    timeoutMessage: string;
    internalMessage: string;
    mapDomainError: (error: unknown) => MappedRequestError | undefined;
  },
): ClassifiedRequestError {
  const defaultAuthOutcome = options.fallbackAuthOutcome ?? (options.authenticated ? 'provider-failure' : 'rejected');
  const timeout: ClassifiedRequestError = {
    error: { code: 'deadline-exceeded', message: options.timeoutMessage },
    authOutcome: defaultAuthOutcome,
    unexpected: false,
  };
  if (options.timedOut && options.timeoutPrecedence === 'before-known-errors') return timeout;

  const mapped = options.mapDomainError(error);
  if (mapped) {
    return {
      error: mapped.error,
      authOutcome: mapped.authOutcome ?? (
        REJECTED_REQUEST_ERROR_CODES.has(mapped.error.code) ? 'rejected' : defaultAuthOutcome
      ),
      unexpected: false,
    };
  }
  if (error instanceof RequestIdentityError) {
    return {
      error: requestIdentityErrorDetails(error, {
        code: 'deadline-exceeded',
        message: options.timeoutMessage,
      }),
      authOutcome: error.kind === 'invalid-token' ? 'rejected' : 'provider-failure',
      unexpected: false,
    };
  }
  if (error instanceof ProfileReadError) {
    return {
      error,
      authOutcome: REJECTED_REQUEST_ERROR_CODES.has(error.code) ? 'rejected' : defaultAuthOutcome,
      unexpected: false,
    };
  }
  if (options.timedOut) return timeout;
  return {
    error: { code: 'internal', message: options.internalMessage },
    authOutcome: defaultAuthOutcome,
    unexpected: true,
  };
}

type AuthenticatedRequestDependencies = {
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

type AuthenticatedRequestContext = {
  deadline: RequestDeadline;
  metrics: { upstreamCalls: number; providerDurationMs: number };
  trackedFetch: ProfileProviderFetch;
  authenticate(): Promise<RequestIdentity>;
};

export async function withAuthenticatedRequest<T>(
  request: Request,
  options: {
    authContext?: RequestAuthContext;
    opsDb: D1Database | undefined;
    timeoutMessage: string;
    dependencies: AuthenticatedRequestDependencies;
  },
  run: (context: AuthenticatedRequestContext) => Promise<T>,
): Promise<T> {
  const dependencies = options.dependencies;
  const metrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs,
    timeoutMessage: options.timeoutMessage,
  });
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await dependencies.providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  };
  try {
    return await run({
      deadline,
      metrics,
      trackedFetch,
      authenticate: () => dependencies.verifyIdentity(
        request,
        options.opsDb,
        deadline.signal,
        dependencies.nowMs(),
        options.authContext,
      ),
    });
  } finally {
    deadline.dispose();
  }
}
