export const LEGACY_NOTIFICATION_FIELDS = [
  'buyerOrderReceivedEmailState', 'buyerOrderReceivedEmailJobId', 'buyerOrderReceivedEmailJob',
  'buyerOrderReceivedEmailIdempotencyKey', 'buyerOrderReceivedEmailQueuedAt',
  'shipperReadyToShipEmailState', 'shipperReadyToShipEmailJobId', 'shipperReadyToShipEmailJob',
  'shipperReadyToShipEmailIdempotencyKey', 'shipperReadyToShipEmailQueuedAt',
  'readyToShipNotificationRetryUntilMs', 'readyToShipNotificationPublishAttemptCount',
  'readyToShipNotificationPublishClaimId', 'readyToShipNotificationPublishClaimExpiresAtMs',
  'readyToShipNotificationFailedAt', 'readyToShipNotificationLastErrorCode',
  'stripeTerminalNotification', 'stripeTerminalNotificationState',
  'stripeTerminalNotificationNextAttemptAtMs', 'stripeTerminalNotificationQueuedAt',
  'stripeTerminalNotificationLastError', 'buyerOrderShippedEmailState',
  'buyerOrderShippedEmailJobId', 'buyerOrderShippedEmailIdempotencyKey', 'buyerOrderShippedEmailQueuedAt',
] as const;
