# 111K recovery release — October 30, 2026

The API now uses stable crate-owned recovery, preserves observed pending watches, and bounds inline verification to two seconds. Admission, receipt freshness, terminal cleanup, and candidate eligibility use shared rules while frozen artwork and publication state remain preserved.

- Source commit: `9a38821791a7af660186bac20238519178876d5c`.
- API version: `3591948b-06c6-4344-9d8a-0f0f9001c497`, serving 100% of traffic at `api.mons.shop`.
- Registry: `sepolia-8b4044db`, active, revision 3, with no reported error.
- The existing frontend and contract remain deployed. No historical reveal backfill was performed.

The release workflow passed 2,795 API tests, 41 native runtime tests, generated-schema/type/bundle/startup checks, and remote database integrity checks. All three remote D1 migration sets were already current. The deployed Worker reported its additive recovery migration ready, with all 220 existing frozen artworks published.

Live verification used an already-revealed unpack covering tokens 241–260. Transaction and token responses matched all 20 existing artworks; repeated reads preserved token 260 and its metadata checksum. Mixed frozen/unminted results, a non-unpack transaction, VVV CORS/preflight, and denied origins passed. Token 1 remained unrevealed.

[release.json](release.json) records the verified identities and live results. [local-load-test.json](local-load-test.json) records the local 200-request/4,000-artwork run; its timings are local measurements rather than production guarantees.

Rare recovery delays during deep reorgs combined with log-service outages are accepted. Correct immutable artwork, no premature disclosure, and reliable ordinary recovery remain the release criteria.
