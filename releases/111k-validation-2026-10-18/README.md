# 111K validation — October 18, 2026 snapshot

These recorded checks describe the October 18 implementation. Counts, contract
sizes, and benchmark results are historical. The source document is preserved
in the complete pre-cleanup checkout
`abb1e8b84fadae8d59af363e6b4a8117343f2dba`.
Use [111K setup and verification](../../scripts/docs/111k_testnet.md#api-and-verification)
for current commands.

## Recorded results

- 102 Solidity checks and 105 isolated gas benchmarks pass, including 256 fuzz cases, stateful invariants, full 5,555-crate/111,111-artwork coverage, and callback/reentrancy/rollback checks. Batch coverage includes 15 crates with the bonus crate in different positions, all sources burned before callbacks, exact aggregate events, repeated operations with cleared transient state, and maximum-sized reads. The extended invariant campaign passes 512 sequences of 128 calls (65,536 calls), with zero unexpected reverts, including 4,421 batch openings, 4,400 batch-read checks and 4,409 duplicate-batch rejection checks. Ten gas-check regressions reject missing or changed snapshots, skipped benchmarks, and missing or renamed measurements without rewriting baselines; intentional updates use `gas:update`.
- The full repository and API runs pass 3,943 and 2,418 tests respectively. Four focused native Worker runtime checks pass. Coverage includes 311-artwork recovery through delayed indexing and reload, batch transaction replacement, exact event commitments, 500/1,000-ID storage bounds, deployment-manifest rejection, read cardinality, bounded RPC concurrency, cancellation and snapshot reorgs.
- The Anvil end-to-end lifecycle passes with real deployed contracts, backend signatures, encrypted addresses, three-confirmation publication, transferred crate receipts and code claims. It also opens 15 crates including #5555, verifies all 311 artwork identities and the aggregate event, confirms them with 14 contract reads, and recovers every output through inventory. Existing stale-identity, replacement-delivery and unsorted mixed-delivery scenarios pass. Its report and five SVG previews are generated under `.cache/111k-e2e/`.
- Frontend, API and tools typechecks, generated schema and ABI/authorization fixtures, dead-code checks, production build and browser credential scan pass.
- The [batch benchmarks](../../onchain/ethereum/README.md#batch-operations-2026-10-18) measure 29.07% less gas for a real 15-crate opening after existing artwork: 1,219,236 versus 1,719,007 gas. The 30-item metadata read costs 18,989,148 gas in simulation and returns about 380 KB of RPC hex. Current runtime sizes are 17,206 bytes for the collection and 11,775 bytes for the renderer. Solidity 0.8.30, Prague, `via_ir = false` and 1000 optimizer runs remain configured. The [history index](../../onchain/ethereum/benchmarks/HISTORY.md) preserves earlier compiler comparisons without treating them as measurements of the current source.

Component tests cover the mobile controls, wallet/recovery flows and modal behavior; a live wallet/browser walkthrough was not performed for these changes. No public-network contract, Worker, database migration, funding request or production secret was deployed by this implementation.
