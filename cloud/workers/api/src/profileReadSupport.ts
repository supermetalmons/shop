import {
  DEFAULT_SHIPMENT_PAGE_LIMIT, MAX_SHIPMENT_PAGE_LIMIT, isShipmentHistoryCursor,
  type ShipmentPageRequest, type ShipmentHistoryCursor,
} from '../../../../shared/shipmentHistory.js';
import {
  STRIPE_CHECKOUT_OPERATION_HEADER, STRIPE_CHECKOUT_RETRY_HEADER,
  type DeliveryOrderSummary,
} from '../../../../shared/contracts.js';
import { deliveryOrderSummarySortAt } from '../../../../shared/deliveryOrderSummary.js';
import { STRIPE_RECEIPT_CLAIM_REQUEST_HEADER } from '../../../../shared/stripeReceiptClaimWorkflow.js';
import { deliveryOrderSummaryFromDocument } from './deliveryOrderSummaries.js';
import type { D1CommerceRepository, CommerceDocumentRecord } from './commerceRepository.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  isRequestCancellationError, isSignalCancellationError, readBoundedRequestJson,
  type RequestDeadline,
} from './boundedRequest.js';
import { classifyAuthenticatedRequestError } from './authenticatedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import { loadD1Profile } from './profileD1.js';
import type { RequestIdentity, verifyRequestIdentity } from './requestIdentity.js';

const PROFILE_CORS_ALLOW_HEADERS = `Content-Type, Authorization, X-Mons-CSRF, ${STRIPE_CHECKOUT_OPERATION_HEADER}, ${STRIPE_RECEIPT_CLAIM_REQUEST_HEADER}`;
const PROFILE_CORS_ALLOW_METHODS = 'POST, OPTIONS';
const MAX_PROFILE_REQUEST_BYTES = 4096;
export const PROFILE_READ_TIMEOUT_MS = 15_000;

export type ReadRequestResult = {
  response: Response;
  metrics: { upstreamCalls: number; providerDurationMs: number };
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
};

export type ReadRequestDependencies = {
  loadProfileEmail: typeof loadProfileEmail;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

function isAllowedProfileOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.protocol === 'https:' && (url.hostname === 'mons.shop' || url.hostname === 'www.mons.shop')) return true;
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) return true;
  if (url.protocol !== 'https:') return false;
  const match = url.hostname.match(/^([^.]+)-mons-shop\.lil-org\.workers\.dev$/);
  return match?.[1] === 'candidate' || /^[0-9a-f]{8}$/i.test(match?.[1] || '');
}

function profileCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': PROFILE_CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': PROFILE_CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': STRIPE_CHECKOUT_RETRY_HEADER,
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

export function handleProfileCorsPreflight(
  request: Request,
  isAllowedOrigin: (origin: string) => boolean = isAllowedProfileOrigin,
): Response {
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin)) {
    return errorResponse(new ProfileReadError('permission-denied', 403, 'Origin is not allowed.'));
  }
  return new Response(null, {
    status: 204,
    headers: { ...profileCorsHeaders(origin), 'Cache-Control': 'no-store' },
  });
}

export function isProfileRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || isAllowedProfileOrigin(origin);
}

export function applyProfileCors(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  if (!isAllowedProfileOrigin(origin)) {
    return errorResponse(new ProfileReadError('permission-denied', 403, 'Origin is not allowed.'));
  }
  for (const [key, value] of Object.entries(profileCorsHeaders(origin))) response.headers.set(key, value);
  return response;
}

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse(apiErrorBody(error), error.status);
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

export async function readProfileRequestBody(
  request: Request,
  signal: AbortSignal,
  maxBytes = MAX_PROFILE_REQUEST_BYTES,
): Promise<Record<string, unknown>> {
  const parsed = await readBoundedRequestJson(request, {
    maxBytes,
    signal,
    createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid request.'),
  });
  if (!isRecord(parsed)) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  return parsed;
}

export function parseShipmentsPage(parsed: Record<string, unknown>): ShipmentPageRequest | undefined {
  if (!Object.hasOwn(parsed, 'shipmentsPage')) return undefined;
  const page = parsed.shipmentsPage;
  if (!isRecord(page) || !exactKeys(page, ['limit', 'cursor']) ||
    (page.limit !== undefined && (!Number.isInteger(page.limit) || Number(page.limit) < 1 || Number(page.limit) > MAX_SHIPMENT_PAGE_LIMIT)) ||
    (page.cursor !== undefined && page.cursor !== null && !isShipmentHistoryCursor(page.cursor))) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid shipment pagination.');
  }
  return { limit: Number(page.limit ?? DEFAULT_SHIPMENT_PAGE_LIMIT), cursor: page.cursor };
}

function deliveryHistoryFromDocuments(documents: readonly CommerceDocumentRecord[]): DeliveryOrderSummary[] {
  const orders = documents
    .map(deliveryOrderSummaryFromDocument)
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
  orders.sort((left, right) => deliveryOrderSummarySortAt(right) - deliveryOrderSummarySortAt(left));
  return orders;
}

async function loadDeliveryHistory(args: {
  owners: readonly string[];
  repository: Pick<D1CommerceRepository, 'queryDeliveryHistory'>;
}): Promise<DeliveryOrderSummary[]> {
  const documents = await args.repository.queryDeliveryHistory({ owners: args.owners });
  return deliveryHistoryFromDocuments(documents);
}

type ShipmentReadResult = { orders: DeliveryOrderSummary[]; nextCursor?: ShipmentHistoryCursor | null };

export async function loadShipments(args: {
  owner: string;
  shipmentsPage?: ShipmentPageRequest;
  repository: Pick<D1CommerceRepository, 'queryDeliveryHistory' | 'queryShipmentHistoryPage'>;
}): Promise<ShipmentReadResult> {
  if (!args.shipmentsPage) return { orders: await loadDeliveryHistory({ ...args, owners: [args.owner] }) };
  if (args.shipmentsPage.cursor && !isShipmentHistoryCursor(args.shipmentsPage.cursor, args.owner)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid shipment cursor owner.');
  }
  return args.repository.queryShipmentHistoryPage({
    owner: args.owner, limit: args.shipmentsPage.limit ?? DEFAULT_SHIPMENT_PAGE_LIMIT,
    ...(args.shipmentsPage.cursor ? { startAfter: args.shipmentsPage.cursor } : {}),
  });
}

export async function loadProfileEmail(args: {
  db: D1Database | undefined;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.db) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  let stored;
  try {
    stored = await loadD1Profile(args.db, args.ownerWallet, args.signal);
  } catch (error) {
    if (isSignalCancellationError(args.signal, error)) throw args.signal.reason;
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  return stored?.email;
}

export async function readMethodNotAllowed(request: Request): Promise<ReadRequestResult> {
  await request.body?.cancel().catch(() => undefined);
  const response = errorResponse(new ProfileReadError('invalid-argument', 405, 'Method not allowed.'));
  response.headers.set('Allow', PROFILE_CORS_ALLOW_METHODS);
  return { response, metrics: { upstreamCalls: 0, providerDurationMs: 0 }, authOutcome: 'rejected' };
}

export function profileReadFailure(
  error: unknown,
  request: Request,
  identity: RequestIdentity | undefined,
  deadline: RequestDeadline,
  metrics: ReadRequestResult['metrics'],
): ReadRequestResult {
  if (isRequestCancellationError(request, error)) throw error;
  const { error: classified, authOutcome } = classifyAuthenticatedRequestError(error, {
    authenticated: Boolean(identity),
    timedOut: deadline.timedOut(),
    timeoutPrecedence: 'after-known-errors',
    timeoutMessage: 'Profile request timed out.',
    internalMessage: 'Profile request failed.',
    mapDomainError: (failure) => failure instanceof ProfileReadError ? {
      error: failure,
      authOutcome: ['unauthenticated', 'permission-denied', 'invalid-argument'].includes(failure.code)
        ? 'rejected' : identity ? 'provider-failure' : 'rejected',
    } : undefined,
  });
  const profileError = classified instanceof ProfileReadError ? classified : new ProfileReadError(
    classified.code, httpStatusForApiErrorCode(classified.code, 502), classified.message, classified.details,
  );
  return { response: errorResponse(profileError), metrics, authOutcome };
}
