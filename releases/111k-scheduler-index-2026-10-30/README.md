# 111K scheduler index — October 30, 2026

This API release adds a partial index for unresolved receipt work so scheduling queries skip retained terminal history. The existing opaque-watch index remains available for capacity checks. Existing ledgers add the index automatically without changing stored rows.

- Source commit: `7f77643ffe26edea43f92a2319273b0cb9dda0e8`.
- API version: `6aa97d33-259c-4fef-a88c-be3e24c3d643`, serving 100% of traffic at `api.mons.shop`.

The release passed 2,819 API tests, 42 native runtime tests, generated-schema/type/bundle/startup checks, and remote database integrity checks. Regression checks cover both receipt scheduling lanes, next-wake calculation, and repeated upgrades preserving stored rows. No remote D1 migrations were pending.

Live frozen-token and transaction responses matched their pre-deployment baselines. Token 260's metadata bytes remained unchanged, CORS checks passed, and the reveal registry remained active at revision 3 with no error. No frontend or contract deployment, or historical reveal backfill, was performed.

[release.json](release.json) records the verified deployment and live results.
