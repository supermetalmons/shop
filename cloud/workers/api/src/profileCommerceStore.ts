import { stripeCheckoutAnonymousOwnerId } from '../../../../shared/stripeCheckoutSession.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import { parseDropDeliveryOrderPath } from './dropPaths.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { ProfileReadError } from './dataAccess.js';
import {
  CommerceWriteConflict,
  commerceFieldValue,
  type CommerceDocumentRecord,
} from './commerceRepository.js';
import { runCommerceTransaction, type CommerceTransactionTarget } from './commerceTransactions.js';
import { deliveryOrderKey, updateDeliveryOrder } from './deliveryOrderStore.js';
import type { DeliveryOwnerMergeUpdate } from './deliveryOrderUpdates.js';

export const STRIPE_OWNER_MERGE_BATCH_SIZE = 450;

class StripeOwnerMergeUnexpectedPathError extends ProfileReadError {
  constructor() {
    super(
      'failed-precondition',
      409,
      'Stripe order reconciliation found invalid server data.',
      { reason: 'unexpected-delivery-order-path' },
    );
    this.name = 'StripeOwnerMergeUnexpectedPathError';
  }
}

function deliveryOrderPath(document: CommerceDocumentRecord): string {
  const path = document.key.path;
  const identity = parseDropDeliveryOrderPath(path);
  if (!identity) throw new StripeOwnerMergeUnexpectedPathError();
  const normalizedDropId = normalizeDropId(identity.dropId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedDropId)) throw new StripeOwnerMergeUnexpectedPathError();
  return path;
}

export async function mergeAnonymousStripeOwnerBatch(params: {
  common: CommerceTransactionTarget & { signal: AbortSignal };
  authSubject: string;
  wallet: string;
}): Promise<number> {
  try {
    return await runCommerceTransaction({
      nowMs: params.common.nowMs,
      repository: params.common.repository,
      signal: params.common.signal,
    }, async (unit) => {
      const documents = await unit.queryDeliveryOrdersByOwner({
        owner: stripeCheckoutAnonymousOwnerId(params.authSubject),
        limit: STRIPE_OWNER_MERGE_BATCH_SIZE,
      });
      if (documents.length > STRIPE_OWNER_MERGE_BATCH_SIZE) {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      }
      for (const document of documents) {
        deliveryOrderPath(document);
      }
      for (const document of documents) {
        await updateDeliveryOrder(unit, deliveryOrderKey(document.key.path), {
          mergedAuthSubject: params.authSubject,
          owner: params.wallet,
          ownerKind: 'wallet',
          ownerMergedAt: commerceFieldValue.serverTimestamp(),
          previousOwner: stripeCheckoutAnonymousOwnerId(params.authSubject),
        } satisfies DeliveryOwnerMergeUpdate);
      }
      return documents.length;
    });
  } catch (error) {
    if (isSignalCancellationError(params.common.signal, error)) throw params.common.signal.reason;
    if (error instanceof CommerceWriteConflict) {
      throw new ProfileReadError('aborted', 409, 'Stripe order reconciliation changed. Try again.');
    }
    throw error;
  }
}
