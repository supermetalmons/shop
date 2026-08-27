CREATE TABLE auth_wallet_bindings (
  auth_subject TEXT NOT NULL PRIMARY KEY CHECK (
    length(auth_subject) BETWEEN 1 AND 128
  ),
  wallet TEXT NOT NULL CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN 0 AND 253402300799999
  ),
  revision INTEGER NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  reconcile_lease_id TEXT CHECK (
    reconcile_lease_id IS NULL OR length(reconcile_lease_id) = 36
  ),
  reconcile_lease_expires_at_ms INTEGER CHECK (
    reconcile_lease_expires_at_ms IS NULL OR
    reconcile_lease_expires_at_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (
    (reconcile_lease_id IS NULL AND reconcile_lease_expires_at_ms IS NULL) OR
    (reconcile_lease_id IS NOT NULL AND reconcile_lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO auth_wallet_bindings (
  auth_subject,
  wallet,
  updated_at_ms,
  revision,
  reconcile_lease_id,
  reconcile_lease_expires_at_ms
)
SELECT
  auth_subject,
  wallet,
  updated_at_ms,
  wallet_revision,
  reconcile_lease_id,
  reconcile_lease_expires_at_ms
FROM wallet_sessions;

DROP TABLE wallet_sessions;
