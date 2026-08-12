import { PublicKey } from '@solana/web3.js';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
  type FirestoreError,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { firebaseApp } from './firebase';
import type { DeliveryOrderSummary, Profile, ProfileShipment } from '../types';
import { isPositiveSafeInteger } from '../../functions/src/shared/positiveInteger';
import type { StripeCheckoutProfileRecoveryStatus } from './stripeCheckoutRecovery';

export type SessionBinding = {
  wallet: string;
};

export type SnapshotUpdate<T> = {
  value: T;
  fromCache: boolean;
  hasPendingWrites: boolean;
};

type SnapshotHandlers<T> = {
  next: (update: SnapshotUpdate<T>) => void;
  error: (error: FirestoreError) => void;
};

export type ProfileShipmentDocument = ProfileShipment;

export type OwnProfileShipmentsEmptyState = 'loading' | 'error' | 'preparing' | 'empty';

export type StripeProfileRecoveryStatus = StripeCheckoutProfileRecoveryStatus;

export function ownProfileShipmentsEmptyState(args: {
  ready: boolean;
  error: string | null;
  checkoutRecoveryPending: boolean;
}): OwnProfileShipmentsEmptyState {
  if (args.error) return 'error';
  if (!args.ready) return 'loading';
  if (args.checkoutRecoveryPending) return 'preparing';
  return 'empty';
}

export function stripeProfileRecoveryAfterSnapshot(
  current: StripeProfileRecoveryStatus | null,
  recoveryKey: string,
  expectedSessionsPresent: boolean,
): StripeProfileRecoveryStatus | null {
  if (!expectedSessionsPresent) return current;
  if (current?.key === recoveryKey && current.phase === 'recovered') return current;
  return { key: recoveryKey, phase: 'recovered' };
}

export function profileListenerIsCurrent(args: {
  expectedWallet: string;
  expectedEpoch: number;
  currentWallet: string | null;
  currentEpoch: number;
  connectedWallet: string | null;
  allowDisconnected?: boolean;
}): boolean {
  return (
    args.currentEpoch === args.expectedEpoch &&
    args.currentWallet === args.expectedWallet &&
    (args.connectedWallet === args.expectedWallet ||
      (args.connectedWallet === null && args.allowDisconnected === true))
  );
}

export function firebaseAuthChangeInvalidatesSession(args: {
  previousUid: string | null;
  nextUid: string | null;
  signInActive: boolean;
  activeSignInUid: string | null;
}): boolean {
  if (args.previousUid === args.nextUid) return false;
  if (!args.signInActive) return true;
  if (args.activeSignInUid !== null) return args.nextUid !== args.activeSignInUid;
  return !(args.previousUid === null && args.nextUid !== null);
}

export function profileForAuthorizedView<T>(args: {
  ownProfile: T | null;
  adminProfile: T | null;
  canReadOwnProfile: boolean;
  canUseAdminViewer: boolean;
  isViewerMode: boolean;
}): T | null {
  if (args.canReadOwnProfile && !args.isViewerMode) return args.ownProfile;
  if (args.canUseAdminViewer && args.isViewerMode) return args.adminProfile;
  return null;
}

export function stripeMergeReconciliationOptions(deliveryRecoveryLoaded: boolean): {
  mergeStripeDeliveryOrders: true;
  includeDeliveryRecovery: boolean;
} {
  return {
    mergeStripeDeliveryOrders: true,
    includeDeliveryRecovery: !deliveryRecoveryLoaded,
  };
}

function normalizeWallet(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const wallet = new PublicKey(value).toBase58();
    return wallet === value ? wallet : null;
  } catch {
    return null;
  }
}

export function sessionBindingFromDocument(args: {
  uid?: string;
  exists: boolean;
  data?: DocumentData;
}): SessionBinding | null {
  const wallet = normalizeWallet(args.exists ? args.data?.wallet : args.uid);
  return wallet ? { wallet } : null;
}

export function firestoreErrorInvalidatesSession(error: unknown): boolean {
  const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined;
  return code === 'permission-denied' || code === 'unauthenticated';
}

export function firestoreListenerErrorIsRetryable(error: unknown): boolean {
  const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined;
  return (
    code === 'aborted' ||
    code === 'cancelled' ||
    code === 'deadline-exceeded' ||
    code === 'internal' ||
    code === 'resource-exhausted' ||
    code === 'unavailable' ||
    code === 'unknown' ||
    code === 'auth/internal-error' ||
    code === 'auth/network-request-failed' ||
    code === 'auth/too-many-requests'
  );
}

export function profileFromDocument(wallet: string, data?: DocumentData): Profile {
  const email = typeof data?.email === 'string' && data.email.trim() ? data.email.trim() : undefined;
  return {
    wallet,
    ...(email ? { email } : {}),
  };
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return isPositiveSafeInteger(value) ? value : undefined;
}

export function profileShipmentFromDocument(data: DocumentData): ProfileShipmentDocument | null {
  const dropId = typeof data.dropId === 'string' ? data.dropId.trim() : '';
  const deliveryId = optionalPositiveInteger(data.deliveryId);
  const sortAt = optionalFiniteNumber(data.sortAt);
  const status = typeof data.status === 'string' ? data.status : '';
  if (
    !dropId ||
    deliveryId === undefined ||
    sortAt === undefined ||
    (status !== 'processing' && status !== 'ready_to_ship')
  ) {
    return null;
  }

  const items = (Array.isArray(data.items) ? data.items : [])
    .map((item): DeliveryOrderSummary['items'][number] | null => {
      const kind = item?.kind;
      const refId = optionalPositiveInteger(item?.refId);
      if ((kind !== 'box' && kind !== 'dude') || refId === undefined) return null;
      return { kind, refId };
    })
    .filter((item): item is DeliveryOrderSummary['items'][number] => Boolean(item));

  const stripeCheckoutSessionId =
    typeof data.stripeCheckoutSessionId === 'string' && data.stripeCheckoutSessionId
      ? data.stripeCheckoutSessionId
      : undefined;
  const fulfillmentStatus =
    data.fulfillmentStatus === 'Preparing' || data.fulfillmentStatus === 'Shipped'
      ? data.fulfillmentStatus
      : undefined;
  const fulfillmentTrackingCode =
    typeof data.fulfillmentTrackingCode === 'string' && data.fulfillmentTrackingCode
      ? data.fulfillmentTrackingCode
      : undefined;
  const createdAt = optionalFiniteNumber(data.createdAt);
  const processingAt = optionalFiniteNumber(data.processingAt);
  const processedAt = optionalFiniteNumber(data.processedAt);
  const fulfillmentUpdatedAt = optionalFiniteNumber(data.fulfillmentUpdatedAt);

  return {
    dropId,
    deliveryId,
    status,
    items,
    sortAt,
    ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(processingAt !== undefined ? { processingAt } : {}),
    ...(processedAt !== undefined ? { processedAt } : {}),
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    ...(fulfillmentTrackingCode ? { fulfillmentTrackingCode } : {}),
    ...(fulfillmentUpdatedAt !== undefined ? { fulfillmentUpdatedAt } : {}),
  };
}

export function profileShipmentsFromDocuments(
  documents: readonly Pick<QueryDocumentSnapshot<DocumentData>, 'data'>[],
): DeliveryOrderSummary[] {
  return documents
    .map((snapshot) => profileShipmentFromDocument(snapshot.data()))
    .filter((shipment): shipment is ProfileShipmentDocument => Boolean(shipment))
    .sort((left, right) => right.sortAt - left.sortAt)
    .map(({ sortAt: _sortAt, ...shipment }) => shipment);
}

export function deliveryOrderSummariesEqual(
  left: readonly DeliveryOrderSummary[],
  right: readonly DeliveryOrderSummary[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((order, index) => {
    const other = right[index];
    return Boolean(
      other &&
      order.dropId === other.dropId &&
      order.deliveryId === other.deliveryId &&
      order.status === other.status &&
      order.stripeCheckoutSessionId === other.stripeCheckoutSessionId &&
      order.createdAt === other.createdAt &&
      order.processingAt === other.processingAt &&
      order.processedAt === other.processedAt &&
      order.fulfillmentStatus === other.fulfillmentStatus &&
      order.fulfillmentTrackingCode === other.fulfillmentTrackingCode &&
      order.fulfillmentUpdatedAt === other.fulfillmentUpdatedAt &&
      order.items.length === other.items.length &&
      order.items.every(
        (item, itemIndex) =>
          item.kind === other.items[itemIndex]?.kind &&
          item.refId === other.items[itemIndex]?.refId,
      )
    );
  });
}

function firestore() {
  if (!firebaseApp) throw new Error('Firebase client is not configured');
  return getFirestore(firebaseApp);
}

export function listenToSessionBinding(
  uid: string,
  handlers: SnapshotHandlers<SessionBinding | null>,
): Unsubscribe {
  return onSnapshot(
    doc(firestore(), 'authSessions', uid),
    { includeMetadataChanges: true },
    (snapshot) => {
      handlers.next({
        value: sessionBindingFromDocument({
          uid,
          exists: snapshot.exists(),
          data: snapshot.exists() ? snapshot.data() : undefined,
        }),
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
      });
    },
    handlers.error,
  );
}

export function listenToProfile(wallet: string, handlers: SnapshotHandlers<Profile>): Unsubscribe {
  return onSnapshot(
    doc(firestore(), 'profiles', wallet),
    { includeMetadataChanges: true },
    (snapshot) =>
      handlers.next({
        value: profileFromDocument(wallet, snapshot.exists() ? snapshot.data() : undefined),
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
      }),
    handlers.error,
  );
}

export function listenToProfileShipments(
  wallet: string,
  handlers: SnapshotHandlers<DeliveryOrderSummary[]>,
): Unsubscribe {
  const shipmentsQuery = query(
    collection(firestore(), 'profiles', wallet, 'shipments'),
    orderBy('sortAt', 'desc'),
  );
  return onSnapshot(
    shipmentsQuery,
    { includeMetadataChanges: true },
    (snapshot) =>
      handlers.next({
        value: profileShipmentsFromDocuments(snapshot.docs),
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
      }),
    handlers.error,
  );
}
