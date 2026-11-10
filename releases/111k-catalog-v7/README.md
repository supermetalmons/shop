# 111k catalog v7

Completed 2026-11-09T23:41:41.377Z on Sepolia deployment v17.

Added **6,780 paintings** (40,349–47,128), replacing egg asset IDs 60,505–67,284. **172 already-revealed eggs hatched** and their replacement metadata was published at the existing token URLs. The collection now contains 60,504 eggs and 47,128 paintings, with 111,111 total artwork slots.

The contract, token identities, and metadata prefix remain unchanged. Catalog revision is 2; final registry revision is 9. No unresolved conflicts or retries remain. The five-minute observation period and temporary-generation cleanup completed.

All new images and traits passed validation. API and frontend deployment gates, local E2E, changed-token provenance checks, and 1268 live availability probes passed. Eight changed tokens matched their frozen mappings; original frozen artwork evidence remained unchanged.

The first apply was rejected before activation while the coordinator still ran its previous code during Cloudflare's deferred code-update window. Retrying the same bundle and original revision after that window succeeded.

See [rollout.json](rollout.json), [verification.json](verification.json), [postflight.json](postflight.json), and [affected-samples-after.json](affected-samples-after.json) for evidence. Optional marketplace-refresh calldata is retained [unsigned](metadata-refresh-unsigned.json). Both catalog audit bundles and the v17 release evidence are retained.
