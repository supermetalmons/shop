DROP TRIGGER pack_status_event_conflict_guard;

CREATE TRIGGER pack_status_event_conflict_guard
BEFORE INSERT ON pack_status_events
WHEN EXISTS (
  SELECT 1
  FROM pack_status_events
  WHERE
    drop_id = NEW.drop_id AND
    event_type = NEW.event_type AND
    event_key = NEW.event_key AND
    NOT (
      quantity IS NEW.quantity AND
      unsealed_online_delta IS NEW.unsealed_online_delta AND
      redeemed_irl_normal_delta IS NEW.redeemed_irl_normal_delta AND
      redeemed_irl_stripe_delta IS NEW.redeemed_irl_stripe_delta AND
      redeemed_unsealed_cards_delta IS NEW.redeemed_unsealed_cards_delta AND
      delivery_id IS NEW.delivery_id AND
      checkout_session_id IS NEW.checkout_session_id AND
      box_asset_id IS NEW.box_asset_id AND
      signature IS NEW.signature
    )
)
BEGIN
  SELECT RAISE(ABORT, 'pack-status event payload conflict');
END;
