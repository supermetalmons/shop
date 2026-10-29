# 111K crate reveals — October 29, 2026

The `111k_devnet` collection is active in the deployment-scoped reveal service. The API and storefront are deployed; mainnet and replacement collections use independent registrations and fresh metadata prefixes.

- Initial API version: `5958be23-dfac-443d-bb1a-3f4e4ec3cbb0`.
- Initial frontend version: `5fc524f8-c7ee-4d7f-8617-1d61db08e681`.
- Registry: `sepolia-8b4044db`, active, revision 3, with all 111111 inventory slots provisioned.
- OPS migration: `0009_ethereum_reveal_deployments.sql`; remote OPS, commerce, and pack-status integrity checks passed.
- Contract: Sepolia `0x8b4044dbd10c05d84d067208980de58e9d5fe915`; its contract and metadata base URI are unchanged.

The [partner guide](../../scripts/docs/111k_reveal.md) documents both endpoints, media rendering, polling, and token recovery. The [operations runbook](../../scripts/docs/111k_reveal_ops.md) covers registration and maintenance. [release.json](release.json) records the deployed identities and frozen template checksum.

## Verification

Allocation tests exhaust all 111111 assets, including reorgs that reuse token IDs and require reclaiming private reservations. Every final token and asset remains unique. Native-runtime tests cover 200 concurrent unpack requests, private pending responses, metadata conflicts, publication retries, persisted state after restart, and partial token recovery followed by full transaction lookup. The [local load report](local-load-test.json) contains measured latency; these are local test measurements, not a production latency guarantee.

The real Anvil end-to-end run verified first-confirmation reveal, local R2 publication, immutable media after `evm_revert`, and recovery without a submitted hash. Frontend, API, tooling, Ethereum, generated-schema, bundle, startup, and dead-code checks passed, including targeted rechecks after final changes.

[Public API verification](public-api-smoke.json) used an unminted token and the collection deployment transaction, returning `unminted` and `not_unpack` with empty artwork arrays. VVV origins were accepted; an unrelated origin was rejected. Existing metadata samples remained placeholders before frontend rollout. No historical backfill was initiated. [Frontend verification](frontend-smoke.json) confirms that the live storefront serves the build containing both reveal methods.

The existing named R2 binding is deployed with automatic resource provisioning disabled. This avoids Wrangler's optional bucket-configuration lookup and uses the existing Worker edit permission; no credential change or browser sign-in was needed.

## Review fixes

[review-fixes.json](review-fixes.json) records the subsequent API/frontend rollout addressing all seven review findings. Regression coverage includes split-range progress, in-flight request upgrades, publication during stalled RPC, fair frontend polling, partial healing success, publication leases, and verified registration. The internal `recovery-cursors-v1` repair runs once per existing ledger and preserves artwork assignments. New registrations require the verified `publicationDirectory` described in the partner guide; existing registrations remain compatible.

[review-fixes-2.json](review-fixes-2.json) records the follow-up gallery and lease-drain fixes. Complete results update the matching open gallery without reopening dismissed results or replacing a newer gallery. Publication tooling retains the 65-second drain marker after attempted writes, including uncertain failures. Frontend and lease regressions passed; the frontend update was deployed and verified live.

[review-fixes-3.json](review-fixes-3.json) records hidden-tab polling behavior: initial submissions and active requests continue, repeat polls pause until visible, and cache eviction cannot restart hidden polling. Visibility/reconnect events preserve retry delays. All 255 frontend regressions passed; the frontend update was deployed and verified live.

[review-fixes-4.json](review-fixes-4.json) records complete cached transaction reads while paused and token-recovery focus/reconnect cooldowns. Paused reads do not broaden recovery admission. Both API and frontend updates were deployed; 11 backend and 263 frontend tests passed, with live checks confirming the rollout.

[review-fixes-5.json](review-fixes-5.json) records the shared token-recovery cooldown across remounts and changing inventories. Rate-limited batches stop new dispatch while preserving successful results; expired deadlines are not extended by late sibling responses. All 271 frontend tests passed; the frontend update was deployed and verified live.

[consolidated-review-fixes.json](consolidated-review-fixes.json) records six deduplicated findings: persistent replacement candidates, retirement after verified replacement coverage, published metadata flags, explicit browser-tracking dismissal, local metadata namespaces, and mainnet setup guidance. Internal ledger initialization replays older replacement searches once; frozen assignments remain intact. All 536 focused tests and the native concurrency/recovery test passed. API and frontend updates were deployed and verified live; no OPS migration was needed.

[reliability-spike-fixes.json](reliability-spike-fixes.json) records eight further deduplicated fixes: admitted crate scope, registration verification before permanent ownership, cross-tab tracking generations, replacement recovery above 15 crates, recent failed-receipt tracking, permissive admission, publication draining, and concurrent retirement fencing. The additive `tracking-scope-v2` ledger repair preserves frozen metadata and reconstructs recovery scope from retained evidence. Associations already erased without provenance cannot be inferred. Public endpoint shapes remain compatible.

API and frontend release gates passed, including 2,708 API unit tests, 41 native-runtime tests, and 4,975 application tests. Production database integrity passed with no pending D1 migrations. The API was deployed before the frontend; live VVV-origin requests, preflight, origin rejection, registry health, and the frontend bundle checksum were verified. The [spike report](reliability-spike-load-test.json) records 200 concurrent submissions plus 200 polls from one origin/IP without rate-limit rejection, with all 4,000 artwork JSONs published in about 11.6 seconds from the start of submissions in the local runtime.

The [VVV integration guide](../../scripts/docs/111k_reveal.md) is now self-contained and contains no deployment instructions. Internal setup, credentials, leases, migrations, publication handling, and recovery guidance are in the separate [operations runbook](../../scripts/docs/111k_reveal_ops.md).

[final-release.json](final-release.json) records the committed release after the remaining review fixes: creation-block verification, recovery of crates omitted by re-mined transactions, scheduler indexes, retained inventory media, reduced-motion handling, bounded unverified-hash retention, and gallery scoping for bundled transactions. API checks passed 2,730 unit and 41 native-runtime tests; frontend checks passed 4,997 application tests plus worker/client checks. Tooling, contract deployment-policy tests, builds, and production database integrity passed. All remote D1 migrations were already current.

The API was deployed before the frontend. Live checks verified VVV requests, preflight, origin rejection, an unminted token, registry health, and the frontend bundle checksum. The [final load report](final-load-test.json) verifies 200 legitimate unpack requests and 200 polls from one origin/IP while all 10,000 temporary tracking slots are occupied, with no rate-limit rejection and all 4,000 artwork files published. These are local runtime measurements, not production latency guarantees. No new contract deployment or historical reveal backfill was performed.
