CREATE TABLE stripe_order_disputes (
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 9 AND 256),
  dispute_id TEXT NOT NULL CHECK (length(dispute_id) BETWEEN 4 AND 256),
  drop_id TEXT NOT NULL CHECK (length(drop_id) > 0),
  charge_id TEXT NOT NULL CHECK (length(charge_id) BETWEEN 4 AND 256),
  payment_intent_id TEXT NOT NULL CHECK (length(payment_intent_id) BETWEEN 4 AND 256),
  dispute_created_at INTEGER NOT NULL CHECK (dispute_created_at >= 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (livemode, session_id, dispute_id)
) STRICT;

CREATE INDEX stripe_order_disputes_drop_session
  ON stripe_order_disputes (drop_id, session_id);
