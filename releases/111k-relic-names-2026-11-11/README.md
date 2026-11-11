# 111K relic names — 11 November 2026

Renamed relics 1–18 on mainnet (`mainnet-v1`) and Sepolia (`v17`) using the exact ordered names in the [relic template](../../scripts/ethereum-metadata/templates/relic.json). The template also supplies these names to future metadata generation while historical snapshots retain their original names.

All 36 objects passed storage, CDN, and API verification. Only the top-level name bytes changed; image URLs and every other metadata byte were preserved. Receipt samples were unchanged. The [verification record](verification.json) includes the ordered names, deployment identities, and immutable journal hashes.

API version `90cb1108-9a75-4b34-81b0-b1e3a297d6a5` adds the narrow `--names` mode to the existing updater. Metadata tests (125), API tests (3,343), runtime tests (70), and tools typecheck passed. No frontend or onchain changes were made. Private snapshots and resumable journals remain under `.cache/111k-relic-names-2026-11-11/`.
