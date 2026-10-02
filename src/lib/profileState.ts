import type { DeliveryOrderSummary, GetProfileStateResponse, Profile } from '../types';
import { deliveryOrderSummaryEqual, deliveryOrderSummarySortAt } from '../../shared/deliveryOrderSummary.js';
import type { ShipmentHistoryCursor } from '../../shared/shipmentHistory';
import type { StripeCheckoutProfileRecoveryStatus } from './stripeCheckoutRecovery';

export type ProfileSnapshotState = {
  profile: Profile | null;
  shipments: DeliveryOrderSummary[];
  shipmentsNextCursor: ShipmentHistoryCursor | null;
  shipmentsRevision: number;
  sessionWallet: string | null;
  authenticated: boolean;
  loading: boolean;
  profileReady: boolean;
  shipmentsReady: boolean;
  profileError: string | null;
  shipmentsError: string | null;
};

function shipmentsInDisplayOrder(shipments: DeliveryOrderSummary[]): DeliveryOrderSummary[] {
  return [...shipments].sort((left, right) => {
    const leftAt = deliveryOrderSummarySortAt(left);
    const rightAt = deliveryOrderSummarySortAt(right);
    if (leftAt !== rightAt) return rightAt - leftAt;
    if (left.dropId !== right.dropId) return left.dropId < right.dropId ? -1 : 1;
    return left.deliveryId - right.deliveryId;
  });
}

export function mergeProfileState<T extends ProfileSnapshotState>(
  current: T,
  response: GetProfileStateResponse,
  wallet: string,
  emptyState: T,
): T {
  const base = current.sessionWallet === wallet
    ? current
    : { ...emptyState, sessionWallet: wallet, authenticated: true };
  const profileError = response.profile?.status === 'error' ? response.profile.error : null;
  const shipmentsError = response.shipments?.status === 'error' ? response.shipments.error : null;
  const nextShipments = response.shipments?.status === 'ready'
    ? response.nextCursor !== undefined
      ? response.shipments.value
      : shipmentsInDisplayOrder(response.shipments.value)
    : base.shipments;
  const next: T = {
    ...base,
    sessionWallet: wallet,
    authenticated: true,
    loading: false,
    profile: response.profile?.status === 'ready' ? response.profile.value : base.profile,
    profileReady: response.profile?.status === 'ready' ? true : base.profileReady,
    profileError: response.profile?.status === 'ready' ? null : profileError?.message || base.profileError,
    shipments: nextShipments,
    shipmentsNextCursor: response.shipments?.status === 'ready' ? response.nextCursor ?? null : base.shipmentsNextCursor,
    shipmentsRevision: response.shipments?.status === 'ready' ? base.shipmentsRevision + 1 : base.shipmentsRevision,
    shipmentsReady: response.shipments?.status === 'ready' ? true : base.shipmentsReady,
    shipmentsError: response.shipments?.status === 'ready' ? null : shipmentsError?.message || base.shipmentsError,
  };
  if (
    current.sessionWallet === next.sessionWallet &&
    current.authenticated === next.authenticated &&
    current.loading === next.loading &&
    current.profile === next.profile &&
    current.profileReady === next.profileReady &&
    current.profileError === next.profileError &&
    current.shipmentsReady === next.shipmentsReady &&
    current.shipmentsError === next.shipmentsError &&
    current.shipmentsRevision === next.shipmentsRevision &&
    deliveryOrderSummariesEqual(current.shipments, next.shipments)
  ) return current;
  return next;
}

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

export function stripeProfileRecoveryAfterRefresh(
  current: StripeProfileRecoveryStatus | null,
  recoveryKey: string,
  expectedSessionsPresent: boolean,
): StripeProfileRecoveryStatus | null {
  if (!expectedSessionsPresent) return current;
  if (current?.key === recoveryKey && current.phase === 'recovered') return current;
  return { key: recoveryKey, phase: 'recovered' };
}

export function authSubjectChangeInvalidatesSession(args: {
  previousSubject: string | null;
  nextSubject: string | null;
  signInActive: boolean;
  activeSignInSubject: string | null;
}): boolean {
  if (args.previousSubject === args.nextSubject) return false;
  if (!args.signInActive) return true;
  if (args.activeSignInSubject !== null) return args.nextSubject !== args.activeSignInSubject;
  return !(args.previousSubject === null && args.nextSubject !== null);
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

export function deliveryOrderSummariesEqual(
  left: readonly DeliveryOrderSummary[],
  right: readonly DeliveryOrderSummary[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((order, index) => {
    const other = right[index];
    return Boolean(other && deliveryOrderSummaryEqual(order, other));
  });
}
