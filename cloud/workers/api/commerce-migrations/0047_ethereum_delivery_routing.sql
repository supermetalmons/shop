SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes)
  THEN 1 ELSE json('Archive and reset Ethereum delivery quotes before adding registered configurations') END;

ALTER TABLE ethereum_delivery_quotes ADD COLUMN config_id INTEGER NOT NULL
  CHECK (typeof(config_id) = 'integer' AND config_id BETWEEN 1 AND 32);

CREATE TRIGGER ethereum_delivery_quotes_config_immutable
BEFORE UPDATE OF config_id ON ethereum_delivery_quotes
WHEN NEW.config_id IS NOT OLD.config_id
BEGIN
  SELECT RAISE(ABORT, 'ethereum delivery configuration is immutable');
END;
