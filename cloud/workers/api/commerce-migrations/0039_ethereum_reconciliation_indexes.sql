CREATE INDEX ethereum_delivery_quotes_reconciliation
ON ethereum_delivery_quotes(chain_id, contract_address, updated_at_ms)
WHERE transaction_hash IS NOT NULL AND (
  status = 'pending' OR published_at_ms IS NULL OR
  verified_at_block IS NULL OR verified_at_block < block_number + 64
);

CREATE INDEX ethereum_crate_claims_reconciliation
ON ethereum_crate_claims(chain_id, contract_address, updated_at_ms)
WHERE transaction_hash IS NOT NULL AND (
  status IN ('pending', 'available') OR
  verified_at_block IS NULL OR verified_at_block < block_number + 64
);
