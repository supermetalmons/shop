import type { DeliveryOrderSummary } from '../types';
import { deliveryOrderSummaryEqual } from '../../shared/deliveryOrderSummary.js';
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
