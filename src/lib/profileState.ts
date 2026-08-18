import type { DeliveryOrderSummary } from '../types';
import { deliveryOrderSummaryEqual } from '../../functions/src/shared/deliveryOrderSummary.js';
import type { StripeCheckoutProfileRecoveryStatus } from './stripeCheckoutRecovery';

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
