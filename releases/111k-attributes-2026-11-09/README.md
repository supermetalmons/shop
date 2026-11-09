# 111K attribute enrichment — November 9, 2026

Deployed commit `ecee7cfc18bed8e40b92552297ad6a99200891fa` to the API and frontend for the existing Sepolia v17 contract. Both Worker versions serve 100% of traffic.

Backfilled 2,149 previously revealed artworks. Every resulting JSON exactly matched its source-derived attributes, with `collection block` first. All 1,431 baseline eggs remained byte-identical, and every original non-attribute field was preserved. Verification covered all 3,580 baseline objects.

Twenty artworks were minted during rollout. Their twelve eligible artworks enriched automatically, and all twenty received separate metadata verification. The final ledger contains 2,161 published enrichment jobs and 3,600 published artwork metadata objects.

The final check, more than five minutes after the first complete snapshot, found zero pending jobs, missing enrollments, invalid sources, conflicts, conflict rechecks, or enrichment errors. Public metadata API checks covered all five categories. The HTML and 65 generated JavaScript/CSS assets matched the checked build on both custom domains.

[Verification record](verification.json) includes Worker versions, deployment checks, counts, source and metadata evidence hashes, and the final health snapshot. Detailed per-object checks are retained in `.cache/111k-attributes-2026-11-09/`.
