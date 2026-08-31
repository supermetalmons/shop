import { summarizePayloadShape } from '../../shared/logSummaries.ts';
import {
  ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
  ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  STRIPE_CHECKOUT_RETRY_HEADER,
  STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  type AdminIrlRedeemFinalizeRecovery,
} from '../../shared/contracts.ts';
import { ensureAnonymousSession } from '../lib/anonymousSession';
import { AUTHENTICATED_API_ORIGIN } from '../lib/authenticatedApiOrigin';
import { ensureStaffWalletSession } from '../lib/staffWalletSession';

const DEBUG_API =
  import.meta.env?.DEV ||
  (typeof window !== 'undefined' && window.localStorage?.getItem('monsDebugApi') === '1');

function summarizeError(err: unknown) {
  const anyErr = err as any;
  if (anyErr && typeof anyErr === 'object') {
    return {
      name: anyErr.name,
      code: anyErr.code,
      message: anyErr.message,
      details: anyErr.details,
      stack: anyErr.stack,
    };
  }
  return { message: String(err) };
}
function makeCallId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type ProfileApiErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
  recovery?: AdminIrlRedeemFinalizeRecovery;
  retryAfterMs?: number;
  status?: number;
  retrySameOperation?: boolean;
};

export class ProfileApiError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly recovery?: AdminIrlRedeemFinalizeRecovery;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly retrySameOperation: boolean;

  constructor(payload: ProfileApiErrorPayload) {
    super(payload.message);
    this.name = 'ProfileApiError';
    this.code = payload.code;
    this.details = payload.details;
    this.recovery = payload.recovery;
    this.retryAfterMs = payload.retryAfterMs;
    this.status = payload.status;
    this.retrySameOperation = payload.retrySameOperation === true;
  }
}

function retrySameOperation(response: Response): boolean {
  return response.status === 499 ||
    response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER) === STRIPE_CHECKOUT_RETRY_SAME_OPERATION;
}

function replaySafeUnrecognizedResponse(
  response: Response,
  replaySafe: boolean,
): boolean {
  return replaySafe && response.status >= 500;
}

const PROFILE_API_MAX_RETRY_AFTER_MS = 60_000;

function responseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds)
    ? Math.min(milliseconds, PROFILE_API_MAX_RETRY_AFTER_MS)
    : PROFILE_API_MAX_RETRY_AFTER_MS;
}

function profileApiErrorPayload(
  value: unknown,
  response: Response,
  replaySafe: boolean,
): ProfileApiErrorPayload {
  const status = response.status;
  const retryAfterMs = responseRetryAfterMs(response);
  const responseMetadata = {
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    retrySameOperation: retrySameOperation(response),
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (error === 'commerce-maintenance' && status === 503) {
      return {
        code: 'commerce-maintenance',
        message: 'Commerce is temporarily unavailable.',
        ...responseMetadata,
        retrySameOperation: responseMetadata.retrySameOperation || replaySafe,
      };
    }
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code;
      const message = (error as Record<string, unknown>).message;
      const details = (error as Record<string, unknown>).details;
      const recovery = (error as Record<string, unknown>).recovery;
      if (typeof code === 'string' && code && typeof message === 'string' && message) {
        return {
          code,
          message,
          ...(details === undefined ? {} : { details }),
          ...(recovery === ADMIN_IRL_REDEEM_FINALIZE_RECOVERY ? { recovery } : {}),
          ...responseMetadata,
        };
      }
    }
  }
  return {
    code: status >= 500 ? 'unavailable' : `http-${status}`,
    message: 'Profile API request failed.',
    ...responseMetadata,
    retrySameOperation: responseMetadata.retrySameOperation ||
      replaySafeUnrecognizedResponse(response, replaySafe),
  };
}

type AuthenticatedUserCredential = {
  authSubject: string;
  token?: string;
};

async function authenticatedUserCredential(forceRefresh: boolean): Promise<AuthenticatedUserCredential> {
  const staffSession = await ensureStaffWalletSession(forceRefresh);
  if (staffSession) return { authSubject: staffSession.wallet, token: staffSession.token };
  const session = await ensureAnonymousSession(forceRefresh);
  return { authSubject: session.subject };
}

export type ProfileApiClientDependencies = {
  fetch: typeof fetch;
  getCredential: (forceRefresh: boolean) => Promise<AuthenticatedUserCredential>;
  origin: () => string;
  timeoutMs: number;
};

export type AuthenticatedApiPath =
  | '/auth/solana'
  | '/admin/irl-redeem/finalize'
  | typeof ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH
  | '/admin/irl-redeem/prepare'
  | '/boxes/reveal'
  | '/checkout/session'
  | '/claims/irl/prepare'
  | '/receipts/stripe/claim'
  | '/delivery/prepare'
  | '/delivery/receipts/issue'
  | '/delivery/receipts/recover'
  | '/receipts/transfer/prepare'
  | '/profile/reconcile'
  | '/profile/state'
  | '/profile/shipments'
  | '/profile/anonymous-stripe-delivery-history'
  | '/profile/addresses'
  | '/admin/profile'
  | '/admin/delivery-order-owners'
  | '/fulfillment/orders'
  | '/fulfillment/order-address'
  | '/fulfillment/order-status'
  | '/fulfillment/manual-review-checkouts'
  | '/fulfillment/shipstation-label'
  | '/fulfillment/shipstation-label-purchase'
  | '/fulfillment/shipstation-label-void'
  | '/fulfillment/shipstation-rates'
  | '/fulfillment/shipstation-shipment';

export type AuthenticatedApiCall = <Req>(
  pathname: AuthenticatedApiPath,
  data: Req,
  credentialCapture?: { authSubject?: string },
  options?: AuthenticatedApiCallOptions,
) => Promise<unknown>;

export type AuthenticatedApiCallOptions = {
  headers?: Readonly<Record<string, string>>;
  onCredential?: (authSubject: string) => void;
  onResponseStatus?: (status: number) => void;
  replaySafe?: boolean;
  timeoutMs?: number;
};

const defaultProfileApiDependencies: ProfileApiClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  getCredential: authenticatedUserCredential,
  origin: () => AUTHENTICATED_API_ORIGIN,
  timeoutMs: 20_000,
};

const STRIPE_CHECKOUT_SESSION_API_TIMEOUT_MS = 35_000;
const PROFILE_RECONCILE_API_TIMEOUT_MS = 65_000;
const IRL_CLAIM_PREPARE_API_TIMEOUT_MS = 65_000;
const ADMIN_IRL_REDEEM_PREPARE_API_TIMEOUT_MS = 65_000;
const REVEAL_DUDES_API_TIMEOUT_MS = 65_000;
const DELIVERY_PREPARE_API_TIMEOUT_MS = 65_000;
const DELIVERY_RECEIPTS_API_TIMEOUT_MS = 65_000;
const RECEIPT_TRANSFER_PREPARE_API_TIMEOUT_MS = 65_000;
const STRIPE_RECEIPT_CLAIM_API_TIMEOUT_MS = 190_000;
const PROFILE_D1_WRITE_API_TIMEOUT_MS = 80_000;
const SHIPSTATION_LABEL_API_TIMEOUT_MS = 50_000;
const SHIPSTATION_LABEL_PURCHASE_API_TIMEOUT_MS = 65_000;
const SHIPSTATION_LABEL_VOID_API_TIMEOUT_MS = 65_000;
const SHIPSTATION_RATES_API_TIMEOUT_MS = 65_000;
const SHIPSTATION_SHIPMENT_API_TIMEOUT_MS = 65_000;

export function profileApiTimeoutMs(pathname: AuthenticatedApiPath): number {
  if (pathname === '/auth/solana' || pathname === '/profile/addresses') return PROFILE_D1_WRITE_API_TIMEOUT_MS;
  if (pathname === '/profile/reconcile') return PROFILE_RECONCILE_API_TIMEOUT_MS;
  if (pathname === '/claims/irl/prepare') return IRL_CLAIM_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/admin/irl-redeem/prepare') return ADMIN_IRL_REDEEM_PREPARE_API_TIMEOUT_MS;
  if (
    pathname === '/admin/irl-redeem/finalize' ||
    pathname === ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH
  ) return ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS;
  if (pathname === '/boxes/reveal') return REVEAL_DUDES_API_TIMEOUT_MS;
  if (pathname === '/delivery/prepare') return DELIVERY_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/delivery/receipts/issue' || pathname === '/delivery/receipts/recover') {
    return DELIVERY_RECEIPTS_API_TIMEOUT_MS;
  }
  if (pathname === '/receipts/transfer/prepare') return RECEIPT_TRANSFER_PREPARE_API_TIMEOUT_MS;
  if (pathname === '/receipts/stripe/claim') return STRIPE_RECEIPT_CLAIM_API_TIMEOUT_MS;
  if (pathname === '/checkout/session') return STRIPE_CHECKOUT_SESSION_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-label') return SHIPSTATION_LABEL_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-label-purchase') return SHIPSTATION_LABEL_PURCHASE_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-label-void') return SHIPSTATION_LABEL_VOID_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-rates') return SHIPSTATION_RATES_API_TIMEOUT_MS;
  if (pathname === '/fulfillment/shipstation-shipment') return SHIPSTATION_SHIPMENT_API_TIMEOUT_MS;
  return defaultProfileApiDependencies.timeoutMs;
}

function profileApiDeadlineError(
  retrySameOperation = true,
  retryAfterMs?: number,
): ProfileApiError {
  return new ProfileApiError({
    code: 'deadline-exceeded',
    message: 'Profile API request timed out.',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    retrySameOperation,
  });
}

async function waitForProfileApiValue<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function requestProfileApi<Req>(
  pathname: AuthenticatedApiPath,
  data: Req,
  dependencies: ProfileApiClientDependencies,
  credentialCapture?: { authSubject?: string },
  options?: AuthenticatedApiCallOptions,
): Promise<unknown> {
  const startedAt = Date.now();
  const callId = DEBUG_API ? makeCallId() : undefined;
  const controller = new AbortController();
  const requestedTimeoutMs = options?.timeoutMs;
  const replaySafe = options?.replaySafe === true;
  const timeoutMs = typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
    ? Math.max(1, Math.min(dependencies.timeoutMs, Math.floor(requestedTimeoutMs)))
    : dependencies.timeoutMs;
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    timeoutMs,
  );
  let initialAuthSubject: string | undefined;
  let deadlineRetryAfterMs: number | undefined;
  let deadlineRetrySameOperation = replaySafe;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      deadlineRetryAfterMs = undefined;
      deadlineRetrySameOperation = replaySafe;
      try {
        const credential = await waitForProfileApiValue(dependencies.getCredential(attempt > 0), controller.signal);
        const token = credential.token;
        if (initialAuthSubject === undefined) initialAuthSubject = credential.authSubject;
        else if (credential.authSubject !== initialAuthSubject) {
          throw new ProfileApiError({
            code: 'auth-subject-changed',
            message: 'Authentication changed. Please retry.',
          });
        }
        if (credentialCapture) credentialCapture.authSubject = credential.authSubject;
        options?.onCredential?.(credential.authSubject);
        if (DEBUG_API) {
          console.info(`[mons/api] → ${pathname}`, { callId, payload: summarizePayloadShape(data) });
        }
        const response = await dependencies.fetch(`${dependencies.origin()}${pathname}`, {
          method: 'POST',
          headers: {
            ...options?.headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': 'application/json',
            'X-Mons-CSRF': '1',
          },
          body: JSON.stringify(data),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        options?.onResponseStatus?.(response.status);
        deadlineRetryAfterMs = responseRetryAfterMs(response);
        deadlineRetrySameOperation = (replaySafe && response.ok) ||
          retrySameOperation(response) ||
          replaySafeUnrecognizedResponse(response, replaySafe);
        let payload: unknown;
        try {
          payload = await waitForProfileApiValue(response.json(), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new ProfileApiError({
            code: 'unavailable',
            message: 'Profile API returned malformed JSON.',
            details: error,
            ...(deadlineRetryAfterMs === undefined ? {} : { retryAfterMs: deadlineRetryAfterMs }),
            status: response.status,
            retrySameOperation: (replaySafe && response.ok) ||
              retrySameOperation(response) ||
              replaySafeUnrecognizedResponse(response, replaySafe),
          });
        }
        if (response.status === 401 && attempt === 0) continue;
        if (!response.ok) throw new ProfileApiError(profileApiErrorPayload(payload, response, replaySafe));
        if (DEBUG_API) {
          console.info(`[mons/api] ← ${pathname}`, {
            callId,
            ms: Date.now() - startedAt,
            data: summarizePayloadShape(payload),
          });
        }
        return payload;
      } catch (error) {
        const normalizedError = controller.signal.aborted
          ? profileApiDeadlineError(deadlineRetrySameOperation, deadlineRetryAfterMs)
          : error;
        if (attempt === 0 && normalizedError instanceof ProfileApiError && normalizedError.code === 'unauthenticated') {
          continue;
        }
        console.error(`[mons/api] ✖ ${pathname}`, {
          ...(callId ? { callId } : {}),
          ms: Date.now() - startedAt,
          error: summarizeError(normalizedError),
        });
        throw normalizedError;
      }
    }
    throw new ProfileApiError({ code: 'unauthenticated', message: 'Authentication is required.' });
  } finally {
    clearTimeout(timeout);
  }
}

export async function callProfileApi<Req>(
  pathname: AuthenticatedApiPath,
  data: Req,
  credentialCapture?: { authSubject?: string },
  options?: AuthenticatedApiCallOptions,
): Promise<unknown> {
  return requestProfileApi(pathname, data, {
    ...defaultProfileApiDependencies,
    timeoutMs: profileApiTimeoutMs(pathname),
  }, credentialCapture, options);
}
