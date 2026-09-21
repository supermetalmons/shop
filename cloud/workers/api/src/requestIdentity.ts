import {
  AnonymousAuthError,
  verifyAnonymousSession,
} from './anonymousAuth.js';
import { raceWithSignal } from './boundedRequest.js';

export type RequestIdentity =
  | { kind: 'anonymous'; authSubject: string }
  | { kind: 'staff-wallet'; wallet: string };

export type RequestAuthContext = Readonly<{
  verifiedStaffIdentity?: Extract<RequestIdentity, { kind: 'staff-wallet' }>;
}>;

export class RequestIdentityError extends Error {
  constructor(readonly kind: 'invalid-token' | 'provider-timeout' | 'provider-unavailable') {
    super(kind);
    this.name = 'RequestIdentityError';
  }
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
  authContext: RequestAuthContext = {},
): Promise<RequestIdentity> {
  if (authContext.verifiedStaffIdentity) return authContext.verifiedStaffIdentity;
  const normalized = String(request.headers.get('Authorization') || '');
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
