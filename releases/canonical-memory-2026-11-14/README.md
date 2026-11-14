# Canonical metadata memory fix — November 14, 2026

Deployed code commit `c4250e738e559720d81ab5e0b8b6bd242e6e327d` as API version `4477d349-ac27-4bf7-a5fe-57c02aae7a39`. Ordinary canonical reads now measure UTF-8 payload sizes before loading assignment, mapping, and enrichment bodies, then process groups with a 1 MiB budget. Single oversized rows remain readable. Metadata contents, revisions, request order, duplicates, and owner precedence are preserved.

The budget bounds temporary input materialization. Returned records still accumulate, so the pre-existing total-result memory limit remains. Native regression tests cover 100-token ASCII mappings, Unicode mappings, and ordinary enrichment with exact full-record hash equality under a 128 MiB V8 old-space cap.

`npm run deploy:api` passed all required gates, including 3,748 unit tests, 91 native runtime tests, bundle validation, startup profiling, migrations, and bounded database readiness checks. The downloaded Worker module exactly matches the checked build. Frontend version `871b60fb-235f-4045-8f9d-b14763a38046`, resource bindings, and storefront configuration were preserved.

After the five-minute adoption window, a read-only audit and R2 verification passed for all 33,240 mainnet tokens: 23,979 artworks and 9,261 eggs. Every object remained byte-identical to the fresh predeployment baseline, with no immutable assignment changes or metadata discrepancies. All 585 previously repaired files and five large artworks also remained healthy on the public CDN. Thirteen reveal samples retained their assignments and provenance; both frontend API proxies retained the existing Sepolia storefront identity. A read-only on-chain check confirmed contract code and the expected mainnet base URI.

Post-adoption observation included a successful scheduled invocation and zero invocation errors. Publication remained caught up, with no overdue recovery jobs or pending/failed owner enrichment. No metadata repair writes or on-chain transactions were issued for this release.

[Verification record](verification.json) contains deployment identities, validation counts, metadata comparisons, scheduler evidence, and hashes of the detailed local evidence.
