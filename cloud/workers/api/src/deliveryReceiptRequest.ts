import { z } from 'zod';
import { MAX_U32 } from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { isSignalCancellationError, readBoundedRequestJson } from './boundedRequest.js';
import { ProfileReadError } from './dataAccess.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import { DELIVERY_RECOVERY_CURSOR_MAX_LENGTH } from '../../../../shared/deliveryRecoveryPagination.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';

const REQUEST_MAX_BYTES = 4096;

const CANONICAL_DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const deliveryIdSchema = z.number().int().min(1).max(MAX_U32);

const dropIdSchema = z.string().min(1).max(64).refine((value) =>
  CANONICAL_DROP_ID_PATTERN.test(value) && normalizeDropId(value) === value);

const issueSchema = z.object({
  owner: z.string().min(32).max(64),
  deliveryId: deliveryIdSchema,
  signature: z.string().min(64).max(128),
  dropId: dropIdSchema,
}).strict();

const recoverSchema = z.object({
  dropId: dropIdSchema.optional(),
  deliveryId: deliveryIdSchema.optional(),
  force: z.boolean().optional(),
  cursor: z.string().min(1).max(DELIVERY_RECOVERY_CURSOR_MAX_LENGTH).nullable().optional(),
}).strict();

export type IssueRequest = z.infer<typeof issueSchema>;

export type RecoverRequest = z.infer<typeof recoverSchema>;

export type DeliveryReceiptsEnv = Pick<
  Env,
  'COSIGNER_SECRET' | 'HELIUS_API_KEY' | 'NOTIFICATION_EMAIL_QUEUE' | 'OPS_DB'
> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;

export type CommerceContext = CommerceRepositoryContext & {
  providerFetch: ProfileProviderFetch;
  dataDb?: D1Database;
  [key: string]: unknown;
};

export async function readRequestBody(
  request: Request,
  signal: AbortSignal,
  kind: 'issue' | 'recover',
): Promise<IssueRequest | RecoverRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new DeliveryReceiptError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Delivery receipt request is too large.'
          : 'Invalid delivery receipt request.',
    ),
  });
  const parsed = kind === 'issue' ? issueSchema.safeParse(value) : recoverSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery receipt request.');
  }
  return parsed.data;
}

export async function loadBoundWallet(
  context: CommerceContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new DeliveryReceiptError('unavailable', 'Receipt data is temporarily unavailable.');
    const resolution = await resolveD1AuthWalletBinding(db, uid, context.signal);
    if ('reason' in resolution) {
      throw new DeliveryReceiptError('unauthenticated', 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) throw error;
    throw new DeliveryReceiptError('unavailable', 'Receipt data is temporarily unavailable.');
  }
}
