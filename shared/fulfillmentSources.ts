export const STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE = 'stripe_offchain' as const;
export const ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE = 'admin_irl_redeem' as const;

export type ReceiptClaimDeliveryOrderSource =
  | typeof STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE
  | typeof ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;

export function isStripeOffchainDeliveryOrderSource(
  source: unknown,
): source is typeof STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE {
  return source === STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE;
}

export function isAdminIrlRedeemDeliveryOrderSource(
  source: unknown,
): source is typeof ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE {
  return source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;
}

export function isReceiptClaimDeliveryOrderSource(
  source: unknown,
): source is ReceiptClaimDeliveryOrderSource {
  return (
    isStripeOffchainDeliveryOrderSource(source) ||
    isAdminIrlRedeemDeliveryOrderSource(source)
  );
}
