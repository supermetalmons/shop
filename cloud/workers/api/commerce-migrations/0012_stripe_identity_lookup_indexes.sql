CREATE INDEX commerce_documents_stripe_payment_intent
  ON commerce_documents (
    json_extract(document_json, '$.stripePaymentIntentId')
  )
  WHERE document_kind IN ('stripe_checkout', 'delivery_order');

CREATE INDEX commerce_stripe_checkouts_session_id
  ON commerce_documents (document_id)
  WHERE document_kind = 'stripe_checkout';

CREATE INDEX commerce_stripe_delivery_orders_session_id
  ON commerce_documents (
    source,
    json_extract(document_json, '$.stripeCheckoutSessionId')
  )
  WHERE document_kind = 'delivery_order';

ANALYZE commerce_documents_stripe_payment_intent;
ANALYZE commerce_stripe_checkouts_session_id;
ANALYZE commerce_stripe_delivery_orders_session_id;
