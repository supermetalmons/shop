ALTER TABLE ethereum_delivery_quotes
ADD COLUMN verified_at_block INTEGER CHECK (verified_at_block IS NULL OR verified_at_block >= 0);

ALTER TABLE ethereum_crate_claims
ADD COLUMN verified_at_block INTEGER CHECK (verified_at_block IS NULL OR verified_at_block >= 0);

ALTER TABLE commerce_commit_guards
ADD COLUMN ethereum_state_expectations_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(ethereum_state_expectations_json) AND json_type(ethereum_state_expectations_json) = 'array');

CREATE TRIGGER commerce_commit_guard_ethereum_state_validate
BEFORE INSERT ON commerce_commit_guards
WHEN json_array_length(NEW.ethereum_state_expectations_json) > 0
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.ethereum_state_expectations_json) AS expectation
    WHERE json_type(expectation.value, '$.chainId') IS NOT 'integer'
      OR json_type(expectation.value, '$.contractAddress') IS NOT 'text'
      OR json_type(expectation.value, '$.id') IS NOT 'text'
      OR json_type(expectation.value, '$.status') IS NOT 'text'
      OR COALESCE(json_type(expectation.value, '$.transactionHash'), '') NOT IN ('text', 'null')
      OR COALESCE(json_type(expectation.value, '$.blockNumber'), '') NOT IN ('integer', 'null')
      OR COALESCE(json_type(expectation.value, '$.blockHash'), '') NOT IN ('text', 'null')
      OR json_type(expectation.value, '$.updatedAtMs') IS NOT 'integer'
      OR CASE json_extract(expectation.value, '$.kind')
        WHEN 'delivery' THEN NOT EXISTS (
          SELECT 1 FROM ethereum_delivery_quotes AS quote
          WHERE quote.chain_id = json_extract(expectation.value, '$.chainId')
            AND quote.contract_address = json_extract(expectation.value, '$.contractAddress')
            AND quote.order_id = CAST(json_extract(expectation.value, '$.id') AS INTEGER)
            AND CAST(quote.order_id AS TEXT) = json_extract(expectation.value, '$.id')
            AND quote.status IS json_extract(expectation.value, '$.status')
            AND quote.transaction_hash IS json_extract(expectation.value, '$.transactionHash')
            AND quote.block_number IS json_extract(expectation.value, '$.blockNumber')
            AND quote.block_hash IS json_extract(expectation.value, '$.blockHash')
            AND quote.updated_at_ms IS json_extract(expectation.value, '$.updatedAtMs')
        )
        WHEN 'claim' THEN json_type(expectation.value, '$.orderId') IS NOT 'integer'
          OR json_type(expectation.value, '$.claimId') IS NOT 'text'
          OR NOT EXISTS (
            SELECT 1 FROM ethereum_crate_claims AS claim
            WHERE claim.chain_id = json_extract(expectation.value, '$.chainId')
              AND claim.contract_address = json_extract(expectation.value, '$.contractAddress')
              AND claim.receipt_id = json_extract(expectation.value, '$.id')
              AND claim.order_id IS json_extract(expectation.value, '$.orderId')
              AND claim.claim_id IS json_extract(expectation.value, '$.claimId')
              AND claim.status IS json_extract(expectation.value, '$.status')
              AND claim.transaction_hash IS json_extract(expectation.value, '$.transactionHash')
              AND claim.block_number IS json_extract(expectation.value, '$.blockNumber')
              AND claim.block_hash IS json_extract(expectation.value, '$.blockHash')
              AND claim.updated_at_ms IS json_extract(expectation.value, '$.updatedAtMs')
          )
        ELSE 1
      END
  ) THEN RAISE(ABORT, 'commerce transaction conflict: ethereum state changed') END);
END;
