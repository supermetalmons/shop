# 111K testnet retirement — November 8, 2026

**Completed and verified.**

The fixed v16 cleanup commands and one-off artifact pruner were retired from the
active tools on November 13, 2026. Their exact pre-removal source is preserved at
[`672e6da337c7f37f5370aecab69f9be438a53001`](https://github.com/supermetalmons/shop/tree/672e6da337c7f37f5370aecab69f9be438a53001):
[backend cleanup](https://github.com/supermetalmons/shop/blob/672e6da337c7f37f5370aecab69f9be438a53001/scripts/ops/cleanupEthereum111k.ts),
[local artifact pruner](https://github.com/supermetalmons/shop/blob/672e6da337c7f37f5370aecab69f9be438a53001/scripts/ops/pruneRetired111kArtifacts.mjs),
and [matching runbook](https://github.com/supermetalmons/shop/blob/672e6da337c7f37f5370aecab69f9be438a53001/scripts/docs/111k_reveal_ops.md#november-8-cleanup-tooling).
These tools describe this completed operation. Current replacements use the
[automatic finalizer](../../scripts/docs/111k_reveal_ops.md#automatic-finalization).
The manifests and verification records below remain unchanged, as do permanent
ownership tombstones, retirement guards, and the retired-preview publication block.

The cleanup retains Sepolia v16 at
`0x938b6a488951b2797b29284d6939dd70efe146a0`, metadata prefix
`111k-sepolia/v16/`, and catalog `111k-v5`. Earlier testnet metadata, reveal state,
release artifacts, and obsolete local backups were removed without creating a
new archive. Onchain contracts and transactions remain unchanged.

| Completed operation | Verified result |
| --- | --- |
| Retired R2 metadata | 3,449,810 objects, 712,144,812 bytes deleted; all 11 scoped prefixes empty |
| Retired reveal storage | 10 Durable Objects empty with alarms cleared |
| Current v16 metadata | All 344,984 expected keys and 20 frozen artwork hashes preserved |
| Local pruning | All 64 manifest targets removed: 345,701 files, 420,380,809 logical bytes |
| Local recheck | All 64 targets absent; no remaining files or bytes in that scope |

Backend verification succeeded at `2026-11-08T09:18:06Z`. Live acceptance passed
20 revealed artworks with no unresolved IDs, 35 current JSONs, and 26 media URLs.
All 10 retired reveal scopes returned HTTP 409; 13 retired CDN samples returned
404. Both sampled mainnet metadata URLs remained available.

The retirement guards were deployed as API version
`4fcff2b4-5689-4eb8-ad76-a100fad9cdae`. The
[retirement manifest](retirement-manifest.json) records the exact targets and
purge confirmations; [verification results](verification.json) record the
deployment, deletion totals, acceptance checks, and validation results.

Mainnet, pre111k, shared artwork media and rendering presets, the current v16
ledger and signed deployment evidence, and registry ownership records that
prevent retired prefix reuse were preserved. The mainnet metadata backup remains
present. Prior release evidence remains at the
[pre-cleanup Git revision](https://github.com/supermetalmons/shop/tree/8c3de5aea944c3c7d67f1f5c9800c78afb7d6340/releases).

The [local deletion manifest](local-artifacts.json) identifies the 22 obsolete
release trees, local scratch artifacts, and old testnet backups removed after
backend verification. The pruner checked identities, file inventories, guarded
checksums, and symlinks before deletion. Its JSON report is
`.cache/111k-cleanup-local-prune.json`; the repeated preview reports every target
absent. Post-prune verification passed both approved acrylic presets (10 assets),
the two source-lookup regressions, and the repository whitespace check. All 60
remaining tracked Markdown files were checked for links into deleted release
trees, and runtime source has no dependency on those trees.

The scheduler recheck at `2026-11-08T09:20:31Z`, 351 seconds after cleanup
completion, confirmed all 11 retired prefixes and 10 reveal stores remained
empty with no alarms. Permanent registrations remain intact. The expired
Sepolia preview lease was removed; its mainnet counterpart remains intact.
API validation passed 3,101 unit tests and 59 runtime tests; all 23 cleanup CLI
tests and the final dead-code/export checks passed.

The [operations guide](../../scripts/docs/111k_reveal_ops.md#superseded-testnet-retirement)
requires retirement guards to remain active: do not roll back to earlier code or
recreate a retired prefix.

## Reusable replacement workflow

The [automatic finalizer](../../scripts/docs/111k_reveal_ops.md#automatic-finalization)
now runs after the release runner's `open` action and resumes through `finalize`.
Preparation resolves the current predecessor; irreversible retirement markers
support replacements that share the same catalog. Completion requires verified
new metadata and media, old storage/metadata removal, owned artifact cleanup,
and a five-minute recheck.

OPS migration `0011_ethereum_reveal_retirement.sql` and API version
`242a151a-4a60-401c-b042-a2814e89e45a` are deployed. The
[tooling verification record](replacement-tooling.json) records passing API,
runtime, deployment, cleanup, and artifact tests. V16 remains active with its
revealed artwork intact; this rollout did not retire any live deployment or
submit onchain transactions.

The subsequent review fixes are deployed as API version
`c5ffa11a-f4c1-44ee-a7d4-bc23b10d0963`, with Commerce migration
`0048_ethereum_retirement_fence.sql`. They protect shared mainnet caches,
coordinate retirement with commerce transitions, check local publication health,
and handle custom release locations and safe journal writes. Regression checks
and live v16 verification passed; the tooling record includes the results.

API version `942ae084-785e-4eb9-a478-8ef01936947f` adds verified recovery after a
replacement pause/resume while preserving the original retirement evidence.
Local cleanup now checks permanent OPS retirement markers before pruning reused
caches whose owners have all retired. The follow-up checks passed and v16 remains
healthy; no live cleanup was performed for these fixes.
