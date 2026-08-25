import {
  verifyFirebaseIdToken,
  type FirebaseIdentity,
  type FirebaseIdTokenFetch,
} from './firebaseIdToken.js';
import { isStaffWalletAddress } from '../../../../shared/fulfillmentAccess.js';
import { canonicalWalletAddress } from '../../../../shared/walletLifecycle.js';

const INTERNAL_STAFF_AUTHORIZATION_PREFIX = 'Mons-Internal-Staff ';

export type RequestIdentity =
  | { kind: 'firebase'; uid: string }
  | { kind: 'staff-wallet'; wallet: string };

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
  return identity.kind === 'staff-wallet' ? identity.wallet : identity.uid;
}

export async function resolveRequestWallet(
  identity: RequestIdentity,
  resolveFirebaseWallet: (uid: string) => Promise<string>,
): Promise<string>;
export async function resolveRequestWallet(
  identity: RequestIdentity,
  resolveFirebaseWallet: (uid: string) => Promise<string | null>,
): Promise<string | null>;
export async function resolveRequestWallet(
  identity: RequestIdentity,
  resolveFirebaseWallet: (uid: string) => Promise<string | null>,
): Promise<string | null> {
  return identity.kind === 'staff-wallet'
    ? identity.wallet
    : resolveFirebaseWallet(identity.uid);
}

export async function verifyRequestIdentity(
  authorization: string | null,
  providerFetch: FirebaseIdTokenFetch,
  signal: AbortSignal,
  nowMs = Date.now(),
): Promise<RequestIdentity> {
  const normalized = String(authorization || '');
  if (normalized.startsWith(INTERNAL_STAFF_AUTHORIZATION_PREFIX)) {
    const wallet = canonicalWalletAddress(normalized.slice(INTERNAL_STAFF_AUTHORIZATION_PREFIX.length));
    if (!wallet || !isStaffWalletAddress(wallet)) throw new Error('Invalid internal staff identity');
    return { kind: 'staff-wallet', wallet };
  }
  const identity: FirebaseIdentity = await verifyFirebaseIdToken(
    authorization,
    providerFetch,
    signal,
    nowMs,
  );
  return { kind: 'firebase', uid: identity.uid };
}
