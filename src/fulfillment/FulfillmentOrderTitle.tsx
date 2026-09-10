import type { FulfillmentOrder } from '../types';

const CHARGEBACK_HISTORY_DESCRIPTION = 'Stripe dispute history, including preliminary inquiries and resolved disputes.';

export function FulfillmentOrderTitle({
  order,
}: {
  order: Pick<FulfillmentOrder, 'deliveryId' | 'stripeChargeback'>;
}) {
  return (
    <div className="fulfillment-order-title">
      <div className="card__title">Order {order.deliveryId}</div>
      {order.stripeChargeback === true ? (
        <span
          className="fulfillment-chargeback"
          role="note"
          aria-label={`CHARGEBACK: ${CHARGEBACK_HISTORY_DESCRIPTION}`}
          title={CHARGEBACK_HISTORY_DESCRIPTION}
        >
          CHARGEBACK
        </span>
      ) : null}
    </div>
  );
}
