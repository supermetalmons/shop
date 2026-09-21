import { createRequestDeadline, type RequestDeadline } from './boundedRequest.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import type { RequestAuthContext, RequestIdentity, RequestIdentityError, verifyRequestIdentity } from './requestIdentity.js';

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
