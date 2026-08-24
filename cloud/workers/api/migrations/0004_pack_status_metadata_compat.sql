CREATE TABLE pack_status_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cache_generation INTEGER NOT NULL CHECK (cache_generation > 0),
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO pack_status_metadata (singleton, cache_generation, updated_at_ms)
SELECT singleton, cache_generation, updated_at_ms
FROM pack_status_rollout
WHERE singleton = 1 AND read_source = 'd1';

CREATE TRIGGER pack_status_rollout_metadata_sync
AFTER UPDATE OF cache_generation, updated_at_ms ON pack_status_rollout
WHEN
  NEW.singleton = 1 AND
  (
    NEW.cache_generation <> (SELECT cache_generation FROM pack_status_metadata WHERE singleton = 1) OR
    NEW.updated_at_ms <> (SELECT updated_at_ms FROM pack_status_metadata WHERE singleton = 1)
  )
BEGIN
  UPDATE pack_status_metadata
  SET
    cache_generation = NEW.cache_generation,
    updated_at_ms = NEW.updated_at_ms
  WHERE singleton = 1;
END;

CREATE TRIGGER pack_status_metadata_rollout_sync
AFTER UPDATE OF cache_generation, updated_at_ms ON pack_status_metadata
WHEN
  NEW.singleton = 1 AND
  (
    NEW.cache_generation <> (SELECT cache_generation FROM pack_status_rollout WHERE singleton = 1) OR
    NEW.updated_at_ms <> (SELECT updated_at_ms FROM pack_status_rollout WHERE singleton = 1)
  )
BEGIN
  UPDATE pack_status_rollout
  SET
    cache_generation = NEW.cache_generation,
    updated_at_ms = NEW.updated_at_ms
  WHERE singleton = 1 AND read_source = 'd1';
END;

DROP TRIGGER pack_status_event_delete_guard;

CREATE TRIGGER pack_status_event_delete_guard
BEFORE DELETE ON pack_status_events
BEGIN
  SELECT RAISE(ABORT, 'pack-status events are immutable');
END;
