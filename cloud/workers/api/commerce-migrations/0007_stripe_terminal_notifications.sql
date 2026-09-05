CREATE INDEX commerce_stripe_terminal_notifications_due
  ON commerce_documents (
    CAST(json_extract(document_json, '$.stripeTerminalNotificationNextAttemptAtMs') AS INTEGER),
    document_path
  )
  WHERE
    document_kind = 'stripe_checkout' AND
    (status = 'fulfilled' OR (status = 'fulfillment_failed' AND manual_refund_review_required = 1)) AND
    json_extract(document_json, '$.stripeTerminalNotificationState') = 'pending';
