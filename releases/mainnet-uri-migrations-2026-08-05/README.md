# Mainnet URI migrations — completed 2026-08-05

This directory records the completed migrations from `assets.mons.link` metadata roots to `cdn.lil.org` for Little Swag Boxes, Poncho Drifella, and Card NFT 2.

The normalized reports bind the deployed programs, config setters, asset transaction evidence, application compatibility releases, and immutable burned records. The GitHub release with tag `mainnet-uri-migrations-2026-08-05` contains the raw pre-upgrade snapshots, deterministic releases, migration plans, complete signature lists, and post-run verification reports. Verify the downloaded release with its `SHA256SUMS` before using any rollback artifact.

Run `npm run verify:mainnet-uri-migrations` with `HELIUS_API_KEY` or a DAS-capable `MAINNET_RPC_URL` to verify the current finalized state. The command is read-only and rejects send or signing arguments.

Legacy aliases and the old host remain required for immutable burned records, deferred devnet deployments, and rollback. They are intentionally not removed by this closeout.

## Historical tooling and recovery

The completed URI deployment, setter, and old-box simulation commands have been removed from active tooling. Their source, including the Poncho setter's rollback mode, remains in tag `mainnet-uri-migrations-2026-08-05`, pinned to commit `fd7a2508ac1d64835140eb53075a268d5fe31415`.

For historical recovery, create an isolated checkout of that commit so the scripts, npm commands, dependencies, and source remain matched:

```sh
git worktree add --detach ../shop-uri-recovery fd7a2508ac1d64835140eb53075a268d5fe31415
git -C ../shop-uri-recovery rev-parse HEAD
```

Use the recorded source tags and release binaries for the target program, and verify the release bundle against `SHA256SUMS` before using an artifact. The current shared-program source and generic upgrader are not compatible replacements for the legacy Little Swag Boxes and Poncho programs. Recovery still requires checking live program identity, authority, and config against the release records before any signing or submission.
