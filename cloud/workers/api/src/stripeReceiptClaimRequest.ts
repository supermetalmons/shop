import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { StripeReceiptClaimRequest } from '../../../../shared/contracts.js';
import { requireStripeReceiptClaimCode } from '../../../../shared/stripeReceiptClaims.js';
import { readBoundedRequestJson } from './boundedRequest.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';

export const STRIPE_RECEIPT_CLAIM_PATH = '/receipts/stripe/claim';

const REQUEST_MAX_BYTES = 1024;

const requestSchema = z.object({
  code: z.string().min(1).max(64),
  recipient: z.string().min(32).max(64),
}).strict();

export async function readRequestBody(request: Request, signal: AbortSignal): Promise<StripeReceiptClaimRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new StripeReceiptClaimError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Receipt claim request is too large.'
          : 'Invalid receipt claim request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim request.');
  }
  return parsed.data;
}

export function canonicalRecipient(value: string): { wallet: string; key: PublicKey } {
  try {
    const key = new PublicKey(value);
    const wallet = key.toBase58();
    if (wallet !== value) throw new Error('non-canonical');
    return { wallet, key };
  } catch {
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid recipient wallet.');
  }
}

export function normalizedCode(value: string): string {
  try {
    return requireStripeReceiptClaimCode(value);
  } catch {
    throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim code.');
  }
}
