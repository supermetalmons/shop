# Reconciled main deployment — November 14, 2026

Merged the metadata fixes with main's existing application refactors in `998b7f48`, then fixed the combined owner-metadata batching path in `50cbcdee`. Main was pushed and both applications were deployed from code commit `50cbcdee0fbad8eed1f79ff3dd4de49cb21c8fb8`.

API version: `9a878d01-3ff9-453d-b24c-c226ea56282b`. Frontend version: `871b60fb-235f-4045-8f9d-b14763a38046`. The downloaded API module exactly matches the checked build. All 138 HTML and asset comparisons across `mons.shop` and `www.mons.shop` matched the deployed frontend build. Resource bindings and storefront configuration were preserved.

The full project check and five SBF tests passed before the final memory fix. The final routine API release passed 3,747 unit and 90 native runtime tests; the frontend release passed 5,406 application tests plus its Worker/client checks. The new memory regression covers 100 large owner records in both ASCII and Unicode under a native Workerd 128 MiB V8 old-space cap, preserving the legacy metadata hashes.

After the five-minute adoption window, the read-only audit and R2 verification passed for 32,320 mainnet tokens: 23,319 artworks and 9,001 eggs. Every artwork has its correct leading collection block. All 32,260 predeployment objects remain byte-identical, with no immutable assignment changes. All 585 repaired metadata files, including five large artworks, also matched on the public CDN. Thirteen reveal samples retained their assignments and provenance. A read-only on-chain call confirmed the mainnet metadata base URI. No metadata repair writes or on-chain transactions were issued for this deployment.

Post-adoption observation included a successful scheduled invocation and zero invocation errors. Mainnet publication was caught up, with no overdue recovery jobs or pending/failed owner enrichment.

The live browser rendered the crate, warehouse, and relic views and switched crate/warehouse selections correctly. Both domains rendered successfully. Wallet-picker cancellation and live relic availability could not be fully verified after native browser input became unreliable; those manual checks are recorded as unverified. Both domains passed HTTP/API and asset checks.

[Verification record](verification.json) includes versions, counts, the browser limitation, scheduler evidence, and hashes of the detailed local evidence.
