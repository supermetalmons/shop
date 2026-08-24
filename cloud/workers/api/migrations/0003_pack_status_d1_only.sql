UPDATE pack_status_rollout
SET
  read_source = 'd1',
  cache_generation = cache_generation + 1,
  updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE singleton = 1;

CREATE TRIGGER pack_status_event_immutable
BEFORE UPDATE ON pack_status_events
BEGIN
  SELECT RAISE(ABORT, 'pack-status events are immutable');
END;

CREATE TRIGGER pack_status_event_delete_guard
BEFORE DELETE ON pack_status_events
WHEN NOT (
  OLD.drop_id = '__mons_pack_status_trigger_probe__' AND
  OLD.event_type = 'onlineReveal' AND
  OLD.event_key = 'retirement'
)
BEGIN
  SELECT RAISE(ABORT, 'pack-status events are immutable');
END;

CREATE TRIGGER pack_status_rollout_d1_only_insert_guard
BEFORE INSERT ON pack_status_rollout
WHEN NEW.read_source <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'pack-status read source is permanently d1');
END;

CREATE TRIGGER pack_status_rollout_d1_only_update_guard
BEFORE UPDATE OF read_source ON pack_status_rollout
WHEN NEW.read_source <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'pack-status read source is permanently d1');
END;
