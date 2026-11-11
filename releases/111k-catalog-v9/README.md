# 111k mainnet catalog v9

Completed on 11 November 2026 for mainnet-v1 at contract
`0x08cded8258730bda384ff198001e47a1b50f7f9d`, retaining
`https://cdn.mons.shop/111k/` and the immutable v8 registration.

Added **16,651 paintings**, IDs **52,330–68,980**, to the upcoming mint pool.
The active catalog is v9, catalog revision 1, and registry revision 9.
The sale remains closed, no artworks are minted, and the two existing minted
relics are unchanged. The Sepolia pool remains on v8.

| Category | Slots |
| --- | ---: |
| Eggs | 38,652 |
| Paintings | 68,980 |
| Videos | 58 |
| 3D models | 3,000 |
| Animated artworks | 421 |
| Total | 111,111 |

## Empty-pool rebuild

The initial online expansion was canceled before activation, with its original
bundle and revision-3 journal retained. The completed operation is
`empty-e901c417e0aae78fcf18656cadbf6d5f`, using original paused revision 6.
Its [journal](mainnet-v1.empty-pool.journal.json) and
[request](empty-rebuild-request.json) are the authoritative rebuild evidence.

A persistent SQL fence blocked reveal writers during the drain and rebuild.
The empty-state proof found zero assignments, reservations, publications,
enrichment records, and pending recovery work. The new generation contains
direct v9 asset identities; future reveals use normal trait enrichment.
All 111,111 slots were verified before atomic activation. The five-minute
observation, obsolete-allocation cleanup, and fence release completed.

The supplied file is retained unchanged as [original-input.json](original-input.json).
The [normalized source](source.json) excludes only the 18 separately managed
relic image entries; [normalization evidence](source-normalization.json) records
both hashes and every exclusion. Existing artwork paths, dimensions, labels,
and alternate-image identities were preserved.

## Verification and release

- [Final rollout](rollout.json), [allocation verification](empty-rebuild-verification.json),
  and [public postflight](postflight.json) confirm the target catalog, closed sale,
  unchanged relics, 27 unchanged CDN samples, and 8 scoped API metadata samples.
- [Scheduler observation](scheduler-observation.json) records healthy inventory
  and zero errors, including a sample after the observation deadline.
- [Validation](deployment-validation.json) covers fencing, restart and concurrency
  recovery, direct-generation integrity, future expansions and reveals, native
  Worker SQLite, bounded metadata handling, local E2E, and bounded readiness.
- The final API version is `f5defc0a-4c19-4c1a-b65a-29ae4ae31dd9`;
  [deployment evidence](api-fence-fix-deployment.json) links the validated bundle
  and the corrected Cloudflare internal-table fence handling.
  The frontend remains at `31679b44-2a4d-46d1-a0a2-97457feda7f1` with
  [136 successful served-file checks](frontend-verification.json).
- The known large trait source for painting 64946 passes the consistent 256 KiB
  metadata bound with all traits preserved; see [targeted evidence](trait-limit-verification.json).

At the user's direction, the unrelated full Commerce audit, exhaustive repeated
artwork availability scan, and unrelated test reruns were omitted. Their partial
attempts remain recorded; they are not represented as successful full scans.
No onchain transaction was sent. Optional [refresh calldata](metadata-refresh-unsigned.json)
remains unsigned and is unnecessary for this empty-pool rebuild.

Use the [empty-pool runbook](../../scripts/docs/111k_reveal_ops.md#empty-mainnet-pool-rebuild)
for inspection and recovery. Do not resume the canceled ordinary catalog apply
or roll back to a Worker that predates the allocation-base support.
