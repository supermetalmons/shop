CREATE TABLE pack_status (
  drop_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version = 1),
  total_initial_supply INTEGER NOT NULL CHECK (total_initial_supply > 0),
  total_cards INTEGER NOT NULL CHECK (total_cards > 0),
  cards_per_pack INTEGER NOT NULL CHECK (cards_per_pack > 0),
  unsealed_online INTEGER NOT NULL DEFAULT 0 CHECK (unsealed_online >= 0),
  redeemed_irl_normal INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_irl_normal >= 0),
  redeemed_irl_stripe INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_irl_stripe >= 0),
  redeemed_unsealed_cards INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_unsealed_cards >= 0),
  rebuilt_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (total_cards = total_initial_supply * cards_per_pack)
);

CREATE TABLE pack_status_events (
  drop_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('onlineReveal', 'redeemedIrlNormal', 'redeemedIrlStripe')),
  event_key TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unsealed_online_delta INTEGER NOT NULL DEFAULT 0 CHECK (unsealed_online_delta >= 0),
  redeemed_irl_normal_delta INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_irl_normal_delta >= 0),
  redeemed_irl_stripe_delta INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_irl_stripe_delta >= 0),
  redeemed_unsealed_cards_delta INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_unsealed_cards_delta >= 0),
  delivery_id INTEGER CHECK (delivery_id IS NULL OR delivery_id > 0),
  checkout_session_id TEXT,
  box_asset_id TEXT,
  signature TEXT,
  apply_delta INTEGER NOT NULL CHECK (apply_delta IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (drop_id, event_type, event_key),
  FOREIGN KEY (drop_id) REFERENCES pack_status(drop_id) ON DELETE RESTRICT,
  CHECK (
    unsealed_online_delta +
    redeemed_irl_normal_delta +
    redeemed_irl_stripe_delta +
    redeemed_unsealed_cards_delta > 0
  )
);

CREATE TABLE pack_status_rollout (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  read_source TEXT NOT NULL CHECK (read_source IN ('firestore', 'd1')),
  cache_generation INTEGER NOT NULL DEFAULT 1 CHECK (cache_generation > 0),
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO pack_status_rollout (singleton, read_source, cache_generation, updated_at_ms)
VALUES (1, 'firestore', 1, 0);

CREATE TRIGGER pack_status_event_apply
AFTER INSERT ON pack_status_events
WHEN NEW.apply_delta = 1
BEGIN
  UPDATE pack_status
  SET
    unsealed_online = unsealed_online + NEW.unsealed_online_delta,
    redeemed_irl_normal = redeemed_irl_normal + NEW.redeemed_irl_normal_delta,
    redeemed_irl_stripe = redeemed_irl_stripe + NEW.redeemed_irl_stripe_delta,
    redeemed_unsealed_cards = redeemed_unsealed_cards + NEW.redeemed_unsealed_cards_delta,
    updated_at_ms = MAX(updated_at_ms, NEW.created_at_ms)
  WHERE drop_id = NEW.drop_id;
END;
