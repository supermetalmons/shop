import {
  AnonymousAuthError,
  verifyAnonymousSession,
} from './anonymousAuth.js';
import { isStaffWalletAddress } from '../../../../shared/fulfillmentAccess.js';
import { canonicalWalletAddress } from '../../../../shared/walletLifecycle.js';
import { raceWithSignal } from './boundedRequest.js';

const INTERNAL_STAFF_AUTHORIZATION_PREFIX = 'Mons-Internal-Staff ';

export type RequestIdentity =
  | { kind: 'anonymous'; authSubject: string }
  | { kind: 'staff-wallet'; wallet: string };

export class RequestIdentityError extends Error {
  constructor(readonly kind: 'invalid-token' | 'provider-timeout' | 'provider-unavailable') {
    super(kind);
    this.name = 'RequestIdentityError';
  }
}

export function internalStaffAuthorization(wallet: string): string {
  return `${INTERNAL_STAFF_AUTHORIZATION_PREFIX}${wallet}`;
}

export function isInternalStaffAuthorization(authorization: string | null): boolean {
  return String(authorization || '').startsWith(INTERNAL_STAFF_AUTHORIZATION_PREFIX);
}

export function isStaffOnlyApiPath(pathname: string): boolean {
  return pathname.startsWith('/admin/') || pathname.startsWith('/fulfillment/');
}

export function isStaffRequestIdentity(
  identity: RequestIdentity,
): identity is Extract<RequestIdentity, { kind: 'staff-wallet' }> {
  return identity.kind === 'staff-wallet';
}

export function requestIdentitySubject(identity: RequestIdentity): string {
  return identity.kind === 'staff-wallet' ? identity.wallet : identity.authSubject;
}

export async function resolveRequestWallet(
  identity: RequestIdentity,
  resolveAnonymousWallet: (authSubject: string) => Promise<string>,
): Promise<string>;
export async function resolveRequestWallet(
  identity: RequestIdentity,
  resolveAnonymousWallet: (authSubject: string) => Promise<string | null>,
): Promise<string | null>;
export async function resolveRequestWallet(
  identity: RequestIdentity,
  resolveAnonymousWallet: (authSubject: string) => Promise<string | null>,
): Promise<string | null> {
  return identity.kind === 'staff-wallet'
    ? identity.wallet
    : resolveAnonymousWallet(identity.authSubject);
}

function requestAbortWon(request: Request, signal: AbortSignal): boolean {
  return request.signal.aborted && signal.reason === request.signal.reason;
}

function throwIfIdentitySignalAborted(request: Request, signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (requestAbortWon(request, signal)) throw signal.reason;
  throw new RequestIdentityError('provider-timeout');
}

export async function verifyRequestIdentity(
  request: Request,
  db: D1Database | undefined,
  signal: AbortSignal,
  nowMs = Date.now(),
): Promise<RequestIdentity> {
  const normalized = String(request.headers.get('Authorization') || '');
  if (normalized.startsWith(INTERNAL_STAFF_AUTHORIZATION_PREFIX)) {
    const wallet = canonicalWalletAddress(normalized.slice(INTERNAL_STAFF_AUTHORIZATION_PREFIX.length));
    if (!wallet || !isStaffWalletAddress(wallet)) throw new Error('Invalid internal staff identity');
    return { kind: 'staff-wallet', wallet };
  }
  if (normalized) throw new RequestIdentityError('invalid-token');
  throwIfIdentitySignalAborted(request, signal);
  try {
    const session = await raceWithSignal(
      verifyAnonymousSession(request, db, nowMs),
      signal,
    );
    throwIfIdentitySignalAborted(request, signal);
    return { kind: 'anonymous', authSubject: session.authSubject };
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      if (requestAbortWon(request, signal)) throw error;
      throw new RequestIdentityError('provider-timeout');
    }
    if (signal.aborted && !requestAbortWon(request, signal)) {
      throw new RequestIdentityError('provider-timeout');
    }
    if (error instanceof RequestIdentityError) throw error;
    if (error instanceof AnonymousAuthError) throw new RequestIdentityError(error.kind);
    throw error;
  }
}
