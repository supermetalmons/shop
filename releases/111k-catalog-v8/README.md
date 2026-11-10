# 111k catalog v8

Completed 2026-11-10T18:37:29.614Z on Sepolia deployment v17.

Added **5,201 paintings** (47,129–52,329), replacing egg asset IDs 55,304–60,504. **164 already-revealed eggs hatched** and their replacement metadata was published at the existing token URLs. The collection now contains 55,303 eggs and 52,329 paintings, with 111,111 total artwork slots.

The contract, ownership, token identities, and metadata prefix remain unchanged. Catalog revision is 3; final registry revision is 12. Publication equals the frozen hatch count, with zero unresolved conflicts or retries. The five-minute scheduler observation and temporary-generation cleanup completed.

All new media and traits passed validation. API and frontend deployment gates, local E2E, public storefront checks, and 8 changed-token samples passed. Changed samples matched their frozen mappings, collection blocks, metadata revisions, and original provenance. 8 unaffected samples and the original 5,080-artwork frozen evidence remained unchanged.

General availability monitoring recorded 10 transport failures out of 1,170 probes, in two five-URL rounds: 17:41:13Z before apply and 18:12:18Z during staging. Every endpoint recovered. 179 reveal endpoint probes recorded 0 failures. See the [availability evidence](availability-summary.json) for timestamps and per-endpoint results. The first frontend release gate caught stale collection-block fixture counts; those expectations were corrected and the complete gate passed before deployment.

See [rollout.json](rollout.json), [verification.json](verification.json), [postflight.json](postflight.json), [deployment validation](deployment-validation.json), and [affected samples](affected-samples-after.json) for evidence. Optional marketplace-refresh calldata remains [unsigned](metadata-refresh-unsigned.json). The immutable bundle, prior catalog bundles, and v17 deployment evidence are retained.
