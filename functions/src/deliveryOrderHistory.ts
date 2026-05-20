import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { stripeCheckoutOwnerId } from './stripeCheckout/contract.js';

export const STRIPE_OWNER_MERGE_BATCH_SIZE = 450;

function buildStripeOwnerMergeUpdate(uid: string, firebaseOwner: string, wallet: string): Record<string, unknown> {
  return {
    owner: wallet,
    mergedFirebaseUid: uid,
    previousOwner: firebaseOwner,
    ownerMergedAt: FieldValue.serverTimestamp(),
  };
}

export async function mergeFirebaseStripeDeliveryOrdersToWalletInDb(
  db: Pick<Firestore, 'batch' | 'collectionGroup'>,
  uid: string,
  wallet: string,
): Promise<number> {
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  let merged = 0;

  for (;;) {
    const snap = await db
      .collectionGroup('deliveryOrders')
      .where('owner', '==', firebaseOwner)
      .limit(STRIPE_OWNER_MERGE_BATCH_SIZE)
      .select()
      .get();
    if (snap.empty) break;

    const batch = db.batch();
    const mergeUpdate = buildStripeOwnerMergeUpdate(uid, firebaseOwner, wallet);
    snap.docs.forEach((doc) => {
      batch.update(doc.ref, mergeUpdate);
    });
    await batch.commit();
    merged += snap.docs.length;

    if (snap.docs.length < STRIPE_OWNER_MERGE_BATCH_SIZE) break;
  }

  return merged;
}
