ALTER TABLE commerce_read_model_control
  ADD COLUMN queue_checked_at_ms INTEGER
  CHECK (queue_checked_at_ms IS NULL OR queue_checked_at_ms >= 0);

ALTER TABLE commerce_read_model_control
  ADD COLUMN queue_backlog_count INTEGER
  CHECK (queue_backlog_count IS NULL OR queue_backlog_count >= 0);

ALTER TABLE commerce_read_model_control
  ADD COLUMN dlq_backlog_count INTEGER
  CHECK (dlq_backlog_count IS NULL OR dlq_backlog_count >= 0);
