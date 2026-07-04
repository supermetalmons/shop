export type DeliveryReadyToShipStatusSnapshot = {
  status?: unknown;
  source?: unknown;
} | null | undefined;

export type ResendNotificationEmailKind = 'shipper_ready_to_ship' | 'stripe_checkout_manual_review';

export const RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED = true;
export const RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_DISABLED_REASON =
  'resend_non_checkout_error_notifications_disabled';

export function shouldSendResendNotificationEmail(kind: ResendNotificationEmailKind): boolean {
  if (kind === 'stripe_checkout_manual_review') return true;
  return RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED;
}

export function shouldNotifyShippersForDeliveryReadyToShipWrite(args: {
  before?: DeliveryReadyToShipStatusSnapshot;
  after?: DeliveryReadyToShipStatusSnapshot;
  ignoredSources?: readonly string[];
}): boolean {
  const source = typeof args.after?.source === 'string' ? args.after.source : '';
  if (source && args.ignoredSources?.includes(source)) return false;
  return args.after?.status === 'ready_to_ship' && args.before?.status !== 'ready_to_ship';
}
