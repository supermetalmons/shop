# Mainnet URI migrations — completed 2026-08-05

This directory records the completed migrations from `assets.mons.link` metadata roots to `cdn.lil.org` for Little Swag Boxes, Poncho Drifella, and Card NFT 2.

The normalized reports bind the deployed programs, config setters, asset transaction evidence, application compatibility releases, and immutable burned records. The GitHub release with tag `mainnet-uri-migrations-2026-08-05` contains the raw pre-upgrade snapshots, deterministic releases, migration plans, complete signature lists, and post-run verification reports. Verify the downloaded release with its `SHA256SUMS` before using any rollback artifact.

Run `npm run verify:mainnet-uri-migrations` with `HELIUS_API_KEY` or a DAS-capable `MAINNET_RPC_URL` to verify the current finalized state. The command is read-only and rejects send or signing arguments.

Legacy aliases and the old host remain required for immutable burned records, deferred devnet deployments, and rollback. They are intentionally not removed by this closeout.
