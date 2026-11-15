import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { ADMIN_IRL_REDEEM_WALLET_ADDRESSES, walletHasAdminIrlRedeemAccess } from '../../../../shared/fulfillmentAccess.js';
import type { AdminIrlRedeemFinalizeRequest } from './adminIrlRedeemFinalizeTypes.js';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeOperationIdForWallet,
  canonicalSignature,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import type { FinalizeRequest } from './adminIrlRedeemRequestState.js';
import { readBoundedRequestJson } from './boundedRequest.js';
import { commerceKeys } from './commerceRepository.js';
import { requireCommerceKey } from './commerceTransactions.js';
import { dropAdminIrlRedeemRequestPath } from './dropPaths.js';
import { isStaffRequestIdentity, type RequestIdentity } from './requestIdentity.js';

export const ADMIN_IRL_REDEEM_FINALIZE_PATH = '/admin/irl-redeem/finalize';

const REQUEST_MAX_BYTES = 4096;

const ADMIN_IRL_REDEEM_WALLETS = new Set(ADMIN_IRL_REDEEM_WALLET_ADDRESSES.map((wallet) => new PublicKey(wallet).toBase58()));

export const requestSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  dropId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  transferSignature: z.string().min(64).max(128).regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
    .refine((value) => canonicalSignature(value) === value),
}).strict();

export async function readAdminIrlRedeemFinalizeRequest(request: Request, signal: AbortSignal): Promise<FinalizeRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new AdminIrlRedeemFinalizeError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Admin IRL redeem finalization request is too large.'
          : 'Invalid Admin IRL redeem finalization request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  return parsed.data;
}

export function canonicalWallet(value: unknown): string {
  try {
    const wallet = new PublicKey(String(value || '').trim()).toBase58();
    if (!walletHasAdminIrlRedeemAccess(wallet, ADMIN_IRL_REDEEM_WALLETS)) {
      throw new AdminIrlRedeemFinalizeError('permission-denied', 'Admins only.');
    }
    return wallet;
  } catch (error) {
    if (error instanceof AdminIrlRedeemFinalizeError) throw error;
    throw new AdminIrlRedeemFinalizeError('permission-denied', 'Admins only.');
  }
}

export function resolveAdminIrlRedeemFinalizeStaffWallet(identity: RequestIdentity): string {
  if (!isStaffRequestIdentity(identity)) {
    throw new AdminIrlRedeemFinalizeError('unauthenticated', 'Staff wallet authentication is required.');
  }
  return canonicalWallet(identity.wallet);
}

export async function adminIrlRedeemFinalizeOperationId(
  body: AdminIrlRedeemFinalizeRequest,
  staffWallet: string,
): Promise<string> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  return adminIrlRedeemFinalizeOperationIdForWallet(parsed.data, canonicalWallet(staffWallet));
}

export function requestKey(path: string) {
  const key = requireCommerceKey(path);
  if (key.kind !== 'admin_irl_redeem_request' || !key.dropId) throw new Error('Invalid commerce document path.');
  return commerceKeys.adminIrlRedeemRequest(key.dropId, key.documentId);
}

export function requestPath(body: FinalizeRequest): string {
  return dropAdminIrlRedeemRequestPath(body.dropId, body.requestId);
}
