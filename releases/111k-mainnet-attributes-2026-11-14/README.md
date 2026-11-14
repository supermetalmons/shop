# 111K mainnet metadata recovery — November 14, 2026

Repaired 585 revealed mainnet artwork metadata objects. Verified all 28,980 published tokens in the final audit: 20,925 artworks have exactly one correct leading `collection block`, and 8,055 eggs remain valid. Every checked object matches its canonical ledger checksum and required metadata headers.

All 28,920 baseline token assignments, frozen metadata hashes and non-attribute fields were preserved. The 8,041 baseline egg objects and 20,294 previously enriched objects remained byte-identical. All 585 repairs matched complete source-derived traits and were independently checked on the public CDN. All traits were preserved in five large artworks, including 5,498 source attributes in the largest. The metadata bound is now 512 KiB.

New reveals include the catalog collection block before remote enrichment. Recoverable source failures retry durably with backoff capped at five minutes. Mainnet recovery uses the private maintenance entrypoint, pinned deployment revision, onchain identity preflight and conditional metadata writes.

API version `4df7ef45-81b5-4b12-97ff-c2728884fa24` serves the deployed repair code at commit `2e76defd585aa7d2a6e250337be7f095b387f5f2`; its downloaded module exactly matches the uploaded module. Resource bindings, the Sepolia storefront configuration and the frontend version were preserved. A successful scheduler invocation was observed after repair, and final checks occurred more than five minutes after the last repaired token. The full Commerce audit passed.

[Verification record](verification.json) contains actual counts, code and deployment identities, evidence checksums and details for the five large artworks. Full per-token evidence remains in the local maintenance directory.
