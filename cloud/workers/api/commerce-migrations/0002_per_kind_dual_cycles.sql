ALTER TABLE commerce_read_model_control
  ADD COLUMN dual_started_delivery_cycle INTEGER
  CHECK (dual_started_delivery_cycle IS NULL OR dual_started_delivery_cycle >= 0);

ALTER TABLE commerce_read_model_control
  ADD COLUMN dual_started_checkout_cycle INTEGER
  CHECK (dual_started_checkout_cycle IS NULL OR dual_started_checkout_cycle >= 0);
