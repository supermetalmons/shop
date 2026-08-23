CREATE TRIGGER pack_status_event_type_guard
BEFORE INSERT ON pack_status_events
WHEN NOT (
  (
    NEW.event_type = 'onlineReveal' AND
    NEW.unsealed_online_delta > 0 AND
    NEW.redeemed_irl_normal_delta = 0 AND
    NEW.redeemed_irl_stripe_delta = 0 AND
    NEW.redeemed_unsealed_cards_delta = 0
  ) OR
  (
    NEW.event_type = 'redeemedIrlNormal' AND
    NEW.unsealed_online_delta = 0 AND
    NEW.redeemed_irl_stripe_delta = 0 AND
    NEW.redeemed_irl_normal_delta + NEW.redeemed_unsealed_cards_delta > 0
  ) OR
  (
    NEW.event_type = 'redeemedIrlStripe' AND
    NEW.unsealed_online_delta = 0 AND
    NEW.redeemed_irl_normal_delta = 0 AND
    NEW.redeemed_irl_stripe_delta > 0 AND
    NEW.redeemed_unsealed_cards_delta = 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid pack-status event deltas');
END;
