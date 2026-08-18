import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { dropIdFromDeliveryOrderPath } from './deliveryOrderSummaries.js';
import { stripeCheckoutOwnerId } from './stripeCheckout/contract.js';
import { WALLET_SESSION_COLLECTION, resolveWalletSessionBinding } from './walletSessions.js';

export const STRIPE_OWNER_MERGE_BATCH_SIZE = 450;

export class StripeOwnerMergeSessionChangedError extends Error {
  constructor(readonly reason: string) {
    super('The active wallet session changed during Stripe order reconciliation.');
    this.name = 'StripeOwnerMergeSessionChangedError';
  }
}

export class StripeOwnerMergeUnexpectedPathError extends Error {
  constructor(readonly path: string) {
    super('Stripe order reconciliation found an unexpected delivery order path.');
    this.name = 'StripeOwnerMergeUnexpectedPathError';
  }
}

export type StripeOwnerMergeErrorClassification =
  | { kind: 'session_changed'; reason: string }
  | { kind: 'unexpected_path'; path: string }
  | { kind: 'unknown' };

export function classifyStripeOwnerMergeError(error: unknown): StripeOwnerMergeErrorClassification {
  if (error instanceof StripeOwnerMergeSessionChangedError) {
    return { kind: 'session_changed', reason: error.reason };
  }
  if (error instanceof StripeOwnerMergeUnexpectedPathError) {
    return { kind: 'unexpected_path', path: error.path };
  }
  return { kind: 'unknown' };
}

function buildStripeOwnerMergeUpdate(uid: string, firebaseOwner: string, wallet: string): Record<string, unknown> {
  return {
    owner: wallet,
    mergedFirebaseUid: uid,
    previousOwner: firebaseOwner,
    ownerMergedAt: FieldValue.serverTimestamp(),
  };
}

export async function mergeFirebaseStripeDeliveryOrdersToWalletInDb(
  db: Pick<Firestore, 'collectionGroup' | 'doc' | 'runTransaction'>,
  uid: string,
  wallet: string,
): Promise<number> {
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  const probe = await db
    .collectionGroup('deliveryOrders')
    .where('owner', '==', firebaseOwner)
    .limit(1)
    .select()
    .get();
  if (probe.empty) return 0;

  const sessionRef = db.doc(`${WALLET_SESSION_COLLECTION}/${uid}`);
  const ordersQuery = db
    .collectionGroup('deliveryOrders')
    .where('owner', '==', firebaseOwner)
    .limit(STRIPE_OWNER_MERGE_BATCH_SIZE)
    .select();

  let mergedCount = 0;
  for (;;) {
    const batchCount = await db.runTransaction(async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      const resolution = resolveWalletSessionBinding({
        uid,
        sessionExists: sessionSnap.exists,
        sessionData: sessionSnap.exists ? sessionSnap.data() : null,
      });
      if ('reason' in resolution) {
        throw new StripeOwnerMergeSessionChangedError(resolution.reason);
      }
      if (resolution.wallet !== wallet) {
        throw new StripeOwnerMergeSessionChangedError('wallet_mismatch');
      }

      const snap = await tx.get(ordersQuery);
      for (const doc of snap.docs) {
        if (!dropIdFromDeliveryOrderPath(doc.ref.path)) {
          throw new StripeOwnerMergeUnexpectedPathError(doc.ref.path);
        }
      }

      const mergeUpdate = buildStripeOwnerMergeUpdate(uid, firebaseOwner, wallet);
      snap.docs.forEach((doc) => {
        tx.update(doc.ref, mergeUpdate);
      });
      return snap.size;
    });
    mergedCount += batchCount;
    if (batchCount < STRIPE_OWNER_MERGE_BATCH_SIZE) return mergedCount;
  }
}
