import type { RequestAuthContext } from '../requestIdentity.js';
import type { WorkerDependencies, WorkerRequestMetrics } from '../publicRouteSupport.js';
import type { DeferredWork } from '../deferredWork.js';

type WorkerRouteCorsPolicy =
  | 'none'
  | 'public'
  | 'rpc'
  | 'profile'
  | 'staff-auth'
  | 'mi-note'
  | 'pack-status';

type WorkerRouteStaffPolicy = 'skip' | 'optional' | 'required';

type WorkerRouteUnexpectedErrorPolicy =
  | 'internal'
  | 'public'
  | 'rpc'
  | 'profile'
  | 'stripe-webhook';

type WorkerRoutePolicy = Readonly<{
  commerceMutation: boolean;
  cors: WorkerRouteCorsPolicy;
  profileOriginGate: boolean;
  publicMethods?: 'GET, OPTIONS' | 'POST, OPTIONS';
  staff: WorkerRouteStaffPolicy;
  unexpectedError: WorkerRouteUnexpectedErrorPolicy;
}>;

export type WorkerRouteContext = {
  authContext: RequestAuthContext;
  defer: DeferredWork;
  dependencies: WorkerDependencies;
  env: Env;
  metrics: WorkerRequestMetrics;
  request: Request;
};

export type WorkerRouteResult = {
  response: Response;
  logFields?: Record<string, unknown>;
};

export type MatchedWorkerRoute = WorkerRoutePolicy & Readonly<{
  baseLogFields?: (metrics: WorkerRequestMetrics) => Record<string, unknown>;
  dispatch: (context: WorkerRouteContext) => Promise<WorkerRouteResult>;
  logRoute: string;
  packStatusDropId?: string | null;
}>;

export type ExactWorkerRoute = MatchedWorkerRoute & Readonly<{ path: string }>;

export const INTERNAL_POLICY: WorkerRoutePolicy = Object.freeze({
  commerceMutation: false,
  cors: 'none',
  profileOriginGate: false,
  staff: 'optional',
  unexpectedError: 'internal',
});

export function profilePolicy(args: {
  commerceMutation?: boolean;
  profileOriginGate?: boolean;
  staff?: WorkerRouteStaffPolicy;
  cors?: 'profile' | 'staff-auth';
} = {}): WorkerRoutePolicy {
  return Object.freeze({
    commerceMutation: args.commerceMutation === true,
    cors: args.cors || 'profile',
    profileOriginGate: args.profileOriginGate !== false,
    staff: args.staff || 'optional',
    unexpectedError: 'profile',
  });
}

export function exactRoute(
  path: string,
  policy: WorkerRoutePolicy,
  dispatch: MatchedWorkerRoute['dispatch'],
  logRoute = path,
  baseLogFields?: MatchedWorkerRoute['baseLogFields'],
): ExactWorkerRoute {
  return Object.freeze({ ...policy, baseLogFields, dispatch, logRoute, path });
}

export function addMetrics(
  metrics: WorkerRequestMetrics,
  result: { metrics: { providerDurationMs: number; upstreamCalls: number } },
): void {
  metrics.providerDurationMs += result.metrics.providerDurationMs;
  metrics.upstreamCalls += result.metrics.upstreamCalls;
}
