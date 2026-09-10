import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  walletHasAdminAccess,
} from '../../../../shared/fulfillmentAccess.js';
import type { StripeChargebackBackfillRequest } from '../../../../shared/stripeChargebacks.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import {
  isRequestCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { ProfileReadError } from './dataAccess.js';
import {
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import { jsonResponse } from './httpResponse.js';
import {
  isStaffRequestIdentity,
  RequestIdentityError,
  verifyRequestIdentity,
} from './requestIdentity.js';
import {
  backfillStripeChargebacks,
  StripeChargebackError,
  type StripeChargebackEnv,
} from './stripeChargebacks.js';
import { stripeChargebackBackfillRequestSchema } from './stripeChargebackRequests.js';

export const STRIPE_CHARGEBACK_BACKFILL_PATH = '/admin/stripe-chargebacks/backfill';

const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);

type BackfillEnv = StripeChargebackEnv & Partial<Pick<Env, 'OPS_DB'>>;
type BackfillDependencies = {
  backfill: typeof backfillStripeChargebacks;
  defer: DeferredWork;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

const defaultDependencies: BackfillDependencies = {
  backfill: backfillStripeChargebacks,
  defer: () => undefined,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: 55_000,
  verifyIdentity: verifyRequestIdentity,
};

type BackfillRequestResult = {
  response: Response;
  metrics: { upstreamCalls: number; providerDurationMs: number };
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  mode?: StripeChargebackBackfillRequest['mode'];
  write?: boolean;
  failures?: number;
};

export async function handleStripeChargebackBackfill(
  request: Request,
  env: BackfillEnv,
  overrides: Partial<BackfillDependencies> = {},
): Promise<BackfillRequestResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return {
      response: jsonResponse({ ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405, {
        headers: { Allow: 'POST, OPTIONS' },
      }),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome: 'rejected',
    };
  }
  return withAuthenticatedRequest<BackfillRequestResult>(request, {
    opsDb: env.OPS_DB,
    timeoutMessage: 'Stripe chargeback backfill timed out.',
    dependencies,
  }, async ({ authenticate, deadline, metrics, trackedFetch }) => {
    let authenticated = false;
    try {
      const identity = await raceWithSignal(authenticate(), deadline.signal);
      if (!isStaffRequestIdentity(identity)) {
        throw new ProfileReadError('unauthenticated', 401, 'Staff wallet authentication is required.');
      }
      if (!walletHasAdminAccess(identity.wallet, ADMIN_WALLETS)) {
        throw new ProfileReadError('permission-denied', 403, 'Fulfillment administrator access is required.');
      }
      authenticated = true;
      const raw = await readBoundedRequestJson(request, {
        maxBytes: 2048,
        signal: deadline.signal,
        createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid chargeback backfill request.'),
      });
      const parsed = stripeChargebackBackfillRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ProfileReadError('invalid-argument', 400, 'Invalid chargeback backfill request.');
      }
      const body: StripeChargebackBackfillRequest = parsed.data;
      const result = await runCriticalRequestOperation(() => dependencies.backfill(body, env, {
        signal: deadline.signal,
        providerFetch: trackedFetch,
        nowMs: dependencies.nowMs,
      }), { deadline, defer: dependencies.defer, ignoreDeferredErrors: true });
      return {
        response: jsonResponse({ ok: true, ...result }, 200),
        metrics,
        authOutcome: 'accepted',
        mode: result.mode,
        write: result.write,
        failures: result.failures.length,
      };
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isRequestCancellationError(request, error)) throw error;
      let status = 503;
      let code = 'unavailable';
      let message = 'Stripe chargeback backfill is temporarily unavailable.';
      if (deadline.timedOut()) {
        status = 504;
        code = 'deadline-exceeded';
        message = 'Stripe chargeback backfill timed out.';
      } else if (error instanceof RequestIdentityError) {
        status = error.kind === 'invalid-token' ? 401 : 503;
        code = error.kind === 'invalid-token' ? 'unauthenticated' : 'unavailable';
        message = error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.';
      } else if (error instanceof ProfileReadError) {
        ({ status, code, message } = error);
      } else if (error instanceof StripeChargebackError) {
        ({ status, code } = error);
      }
      return {
        response: jsonResponse({ ok: false, error: { code, message } }, status),
        metrics,
        authOutcome: status < 500 ? 'rejected' : authenticated ? 'provider-failure' : 'rejected',
      };
    }
  });
}
