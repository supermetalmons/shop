import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
  type FirebaseIdTokenFetch,
} from './firebaseIdToken.js';
import {
  AnonymousAuthError,
  firebaseFallbackEnabled,
  verifyAnonymousSession,
} from './anonymousAuth.js';
import { isStaffWalletAddress } from '../../../../shared/fulfillmentAccess.js';
import { canonicalWalletAddress } from '../../../../shared/walletLifecycle.js';

const INTERNAL_STAFF_AUTHORIZATION_PREFIX = 'Mons-Internal-Staff ';

export type RequestIdentity =
  | { kind: 'anonymous'; authSubject: string; source: 'firebase' | 'mons' }
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

export async function verifyRequestIdentity(
  authorization: string | null,
  providerFetch: FirebaseIdTokenFetch,
  signal: AbortSignal,
  nowMs = Date.now(),
  request?: Request,
  db?: D1Database,
): Promise<RequestIdentity> {
  const normalized = String(authorization || '');
  if (normalized.startsWith(INTERNAL_STAFF_AUTHORIZATION_PREFIX)) {
    const wallet = canonicalWalletAddress(normalized.slice(INTERNAL_STAFF_AUTHORIZATION_PREFIX.length));
    if (!wallet || !isStaffWalletAddress(wallet)) throw new Error('Invalid internal staff identity');
    return { kind: 'staff-wallet', wallet };
  }
  if (normalized) {
    try {
      if (!await firebaseFallbackEnabled(db)) throw new RequestIdentityError('invalid-token');
      const identity: FirebaseIdentity = await verifyFirebaseIdToken(
        authorization,
        providerFetch,
        signal,
        nowMs,
      );
      return { kind: 'anonymous', authSubject: identity.uid, source: 'firebase' };
    } catch (error) {
      if (error instanceof RequestIdentityError) throw error;
      if (error instanceof FirebaseIdTokenError) throw new RequestIdentityError(error.kind);
      if (error instanceof AnonymousAuthError) throw new RequestIdentityError(error.kind);
      throw error;
    }
  }
  if (!request) throw new RequestIdentityError('invalid-token');
  try {
    const session = await verifyAnonymousSession(request, db, nowMs);
    return { kind: 'anonymous', authSubject: session.authSubject, source: 'mons' };
  } catch (error) {
    if (error instanceof AnonymousAuthError) throw new RequestIdentityError(error.kind);
    throw error;
  }
}
