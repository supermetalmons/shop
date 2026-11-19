# Mainnet duplicate painting correction

On November 19, 2026 at 08:36:50 UTC, mainnet exchanged **268 free painting slots for 268 distinct eggs**. All **111,111** slots were accounted for. The operation kept one available copy of each of the **113** affected compositions that nobody had revealed. Holders retained all **247** previously revealed paintings from the reviewed groups, including **47** extra copies already public.

| Collection block | Painting slots exchanged |
| --- | ---: |
| little swag | 212 |
| Drilady 2 | 50 |
| gpt pixel | 5 |
| dratini fanart | 1 |
| Paint Me Like Your Old Models | 0 |
| **Total** | **268** |

The mainnet collection retained catalog v10 and advanced from allocation revision 2 to 3. The registry advanced from revision 12 to 15 and released the operation lock. Sales, reveals, owner hatches and onchain unboxing remained enabled. The Worker change uses the existing contract and metadata prefix. [Allocation verification](allocation-verification.json) · [Frozen painting verification](frozen-painting-verification.json)

## Evidence

The [reviewed group input](duplicate-painting-groups.csv.gz) contains 628 painting IDs in 313 groups. Its uncompressed SHA-256 is `34c85b83b4e626f519ab5ee31f7cbdad80aa39bcebba109ed407c7b6ac6bf8c4`. Groups in the [definition](definition.json) are ordered by pixel area, then lowest ID for a tie. Revealed paintings and committed claims take precedence. The definition SHA-256 over compact JSON is `162459bc042c4454b1eacc5b3df19c1f6cbb74a83e45bad4eb5df2c6106d271b`.

The media audit checked checksums and decoded all 62,510 distinct published egg WebPs in the 76,700-ID library. It compared full and foreground-cropped images and froze 768 candidate IDs. Before application the CLI checked both the original PNG and WebP for every candidate, including checksums, byte ranges, MIME types and access from the three supported web origins. The ledger privately drew the replacements from the available candidates. [Visual audit](egg-visual-verification.json) · [Eligible media](eligible-egg-media.json)

Local verification included 3,791 API tests and 95 native runtime tests. A full-size rehearsal exercised live reservations, rollback, retries, restart, ordinary hatch backing and subsequent allocation updates. Production Worker `d9bcbabd-d355-4468-a7a0-9bf35c0a6a51` served 100% of traffic before application. The private operator journal retains original registry revision 12. Use the [online correction runbook](../../scripts/docs/111k_reveal_ops.md#online-mainnet-duplicate-painting-correction) for read-only verification or recovery.

The old and corrected resolvers agreed on all 28,574 paintings revealed through the cutover, including 374 owner hatches. No additional duplicate was revealed between preflight and activation. Both scheduled runs at 08:40 and 08:45 UTC succeeded. Across deployment and observation, all 141 public API checks passed. During local validation before deployment, 7 public probes timed out. Mainnet and Sepolia were active with zero publication conflicts at the final check. [Health and scheduler evidence](health-verification.json)
