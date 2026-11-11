# 111K relic PNG metadata — 11 November 2026

Updated all eighteen relics in each live collection to `https://cdn.lil.org/nft/111k/relics/{id}.png`. The storefront uses the corresponding `relics/mid/{id}.webp` images with their measured dimensions. Future publications use the updated relic template.

| Collection | Deployment | Revision | Metadata prefix |
| --- | --- | --- | --- |
| Ethereum mainnet | `mainnet-v1` | 3 | `https://cdn.mons.shop/111k/` |
| Sepolia | `v17` | 12 | `https://cdn.mons.shop/111k-sepolia/v17/` |

The operation changed only the image URL in token JSONs `117172`–`117189`, preserving every other JSON byte. Each conditional write matched its prepared body and ETag. Receipts keep the shared placeholder; artwork assignments, catalogs, contracts, and database schemas were unchanged. No onchain transactions or marketplace refresh transactions were sent.

## Evidence

- [Image assets and unchanged-object baselines](preflight.json): all eighteen PNGs, all eighteen mid WebPs, and eight crate, warehouse, and receipt samples.
- [Application results](application.json): eighteen updates per collection, applied to Sepolia before mainnet.
- [Metadata delta](metadata-delta.json): exact scope, original revision, journal checksum, and before/after image URLs and checksums for all thirty-six objects.
- Initial verification of all eighteen objects through storage, public CDN, and metadata API: [Sepolia](v17.initial-verification.json), [mainnet](mainnet-v1.initial-verification.json).
- [Visual verification](visual-verification.json): all eighteen mid images loaded in the deployed selection grid; the same source components displayed portrait relic #1 and landscape relic #18 with correct proportions in the local fullscreen viewer checks.
- [Deployment and validation results](deployments.json): frontend `af0e53e5-3256-4620-b44b-30e71fea94ea`; API `792359a8-655d-48a5-9a25-53aaeeac91bc`. All 5,240 frontend tests, 3,320 API tests, and 70 runtime tests passed, along with required type, bundle, startup, and bounded readiness checks. No migrations were pending and no full Commerce audit was run.

[Follow-up verification](observation.json) passed after the five-minute observation interval: all thirty-six objects still matched their exact target bytes in storage, on the CDN, and through the API ([Sepolia](v17.final-verification.json), [mainnet](mainnet-v1.final-verification.json)). Both registrations remained healthy with their original revisions, and all eight unrelated metadata samples were unchanged ([health checks](health-verification.json)).

The first API runtime run encountered two existing timing-sensitive assertions while the frontend suite was running. Both passed independently and the complete API deployment gate then passed on retry without changes to those tests or production behavior.

Frozen operator journals remain in `.cache/111k-relic-images-2026-11-11/{v17,mainnet-v1}/`. The original publication snapshots and historical release records remain immutable; their relic hashes describe the pre-migration publication. Use the dedicated [live relic image maintenance procedure](../../scripts/docs/111k_metadata.md#updating-live-relic-images) and this delta for current verification.
