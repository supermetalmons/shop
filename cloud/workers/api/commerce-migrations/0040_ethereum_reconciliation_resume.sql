ALTER TABLE ethereum_reconciliation_cursor
ADD COLUMN scan_end_block INTEGER CHECK (scan_end_block IS NULL OR scan_end_block >= 0);
