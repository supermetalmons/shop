# Six-egg reveal soft cap — 11 November 2026

Deployed API Worker version `4c3cdcd4-a5ca-4fea-b67a-becfc88ee0f1` at 100% traffic. New crate assignments use a soft cap of **six eggs** on Ethereum mainnet and Sepolia, including the final 31-artwork crate.

Existing private reservations and revealed artwork are preserved. When no free non-egg inventory remains, the allocator may exceed six eggs. Category weights, catalogs, schema, and public interfaces are unchanged.

## Verification

- 117 reveal-store tests passed, including the 19 focused egg-cap cases and complete inventory conservation.
- 3,297 API tests and 63 runtime tests passed; schema, catalog, type, bundle, and startup checks passed.
- No database migrations were pending. The existing Commerce readiness check passed after two earlier runs encountered transient network failures; the successful run retained all validation and performed 240 read requests.
- Downloaded the active Worker code and verified the six-egg constant and allocation filter, bracketed by checks that this version remained at 100% traffic.
- Observed successful new-version health events for both mainnet-v1 and v17, then verified that the five-minute Durable Object update window had elapsed.
- Mainnet remained ready/inactive with minting closed; Sepolia remained active. No contract transactions or activation changes were submitted.

The [deployed-code audit](deployed-code.json), [rollout verification](verification.json), and [contract-state snapshot](contract-state.json) record the evidence. The rollout observed [Cloudflare’s default 300-second update deferral](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/).
