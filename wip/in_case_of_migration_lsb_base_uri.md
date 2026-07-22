# In case of migration: Little Swag Boxes base URI

> Status: WIP contingency note only. Snapshot: 2026-07-22. No migration is approved or running.
> Re-check every on-chain value and asset count immediately before any future execution.

## Goal

If we ever proceed, keep the existing mainnet program ID while:

1. changing the base used for future box, figure, and receipt metadata;
2. updating the collection URI and every live existing MPL Core NFT URI;
3. updating every live existing Bubblegum v2 cNFT receipt URI; and
4. preserving the legacy program behavior and URL layout.

Changing the config base does **not** rewrite existing asset URIs. The program upgrade/config update and the existing-asset migration are separate operations.

## Mainnet identifiers and current state

| Item | Value |
| --- | --- |
| Cluster | `mainnet-beta` |
| Drop ID | `little_swag_boxes` |
| Program | `22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep` |
| ProgramData | `2u35tdkjBJkT79tdT58XeNEw216B82BPVmMeD8WoEfa6` |
| Upgrade authority | `kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx` |
| Config admin/deployer | `kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx` |
| Observed collection UpdateDelegate | `kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx` |
| Legacy singleton config PDA | `iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc` |
| MPL Core collection | `7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr` |
| Bubblegum v2 receipts tree | `Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV` |
| Delivery lookup table | `F51Mj4JFGdVKJfdbYc4aT4de8Dbst7BmWr2P2Bwxa8Wz` |
| Treasury | `8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM` |
| Current base | `https://assets.mons.link/drops/lsb` |
| Path format | `legacy` |
| Config allocation | 289 bytes; singleton seed `[b"config"]`; bump `252` |
| Supply state | `max_supply = 333`, `minted = 333`, `started = true` |

The upgrade authority and config admin were both live and equal to `kPG2L…Qgx` at the audit. A future signer must derive to that exact public key. Re-check the program authority, config admin, and collection delegate immediately before work. Never paste or commit the deployer key.

Original deployment:

- Slot: `389566360`
- Time: `2025-12-27T18:59:58Z`
- Transaction: [5ag2aKg…Mthvz4h](https://explorer.solana.com/tx/5ag2aKgQVnfz1AWK1W3H5FpHFuLaxtHzh1tmvu3Z5kxbSNz1PZsFz7C8eQksBtkuvc8uL4UcM8mGB5YokMthvz4h)
- No later ProgramData transaction or upgrade was found.

Useful protocol IDs when building the migration client are in `functions/src/shared/solanaProgramAddresses.ts`:

| Program/account | Address |
| --- | --- |
| MPL Core | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| Bubblegum v2 | `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` |
| Account Compression | `mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW` |
| MPL Noop | `mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3` |
| MPL Core CPI signer | `CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk` |

## URI layout that must remain compatible

The program stores the drop root, not a JSON URL, and appends these exact legacy paths:

| Asset | Current URI pattern |
| --- | --- |
| Collection | `https://assets.mons.link/drops/lsb/collection.json` |
| Box | `https://assets.mons.link/drops/lsb/json/boxes/{id}.json` |
| Figure | `https://assets.mons.link/drops/lsb/json/figures/{id}.json` |
| Box receipt cNFT | `https://assets.mons.link/drops/lsb/json/receipts/boxes/{id}.json` |
| Figure receipt cNFT | `https://assets.mons.link/drops/lsb/json/receipts/figures/{id}.json` |

Keep `metadataPathFormat: 'legacy'`. Do not switch this deployment to the modern compact `/b`, `/f`, `/rb`, or `/rf` paths.

`<NEW_BASE>` should be the root only, with no trailing slash, query, fragment, terminal `.json`, or embedded `/json/boxes`, `/json/figures`, or `/json/receipts`. Its stored UTF-8 byte length must be at most 96. Prefer `https://…` or `ipfs://…`.

Publish and validate every new JSON/media target before changing anything on-chain, and keep the old host available throughout the migration and rollback window.

## Source and build findings

The high-confidence deployed source baseline is:

```text
02075c7723544cf5619257b27b97a3297b05b0b4  deploy mainnet
```

That commit was created 64 seconds after the only on-chain deployment and contains the live program ID and deployment addresses. Use a separate worktree/branch based on this commit, including its `onchain/Cargo.lock` and Cargo manifests.

Relevant historical source:

```text
git show 02075c7:onchain/programs/box_minter/src/lib.rs
git show 02075c7:onchain/programs/box_minter/Cargo.toml
git show 02075c7:onchain/Cargo.toml
git show 02075c7:onchain/Cargo.lock
git show 02075c7:onchain/Anchor.toml
```

Live binary evidence:

- Live ELF allocation/dump size: `432,776` bytes
- Live ELF SHA-256: `23a4ed77e8b0184bba3d9fd5cfcdc5cce9dc835ef5569acf74a7ca21703294bf`
- Historical source SHA-256: `b80c26529360bb2747351fecab35153d747453f3b068d2cc7f5549931b7d4193`
- Rebuilding `02075c7` with the 2026-07-22 toolchain produced `417,512` bytes and SHA-256 `b367939cfa9bc9a47a0148fc05049868bc47c1ea8652e2db6d8884b108cd7774`, so it did **not** byte-match the live ELF.
- The December 2025 Solana/platform-tools/Rust versions were not committed and no historical `.so` is tracked.

The source match is very strong, but byte-for-byte reproducibility remains unresolved. Recover and pin the original build environment/artifact if possible; otherwise require explicit risk acceptance plus exhaustive ABI, account-layout, and behavior regression tests.

### Do not use current deployment code as-is

- Do **not** deploy current `onchain/programs/box_minter/src/lib.rs` over this program. It uses scoped `[b"config", drop_seed]` PDAs and a different/larger account and instruction layout.
- Do **not** run `npm run upgrade-onchain -- little_swag_boxes` as-is. `scripts/upgrade-onchain.ts` temporarily changes `declare_id!` and then compiles current HEAD; it has no legacy-layout guard and also accepts raw private-key input.
- Do **not** use `scripts/deploy-all-onchain.ts`; it is the modern new/scoped-drop deployment flow.
- Do not trust current `onchain/Anchor.toml` to select this mainnet target. Use an explicit verified program ID and RPC.
- `little_swag_boxes_devnet` is a later, changed layout and is not an exact rehearsal target. Prefer a local clone of the mainnet accounts or a disposable deployment built from `02075c7`.

## Minimal program change

Start from `02075c7` and add only the smallest legacy-compatible patch:

1. Add an admin-only `set_uri_base(uri_base: String)` instruction.
2. Constrain the mutable config exactly like legacy `SetTreasury`: singleton `[b"config"]`, stored bump, `has_one = admin`, and `admin: Signer`.
3. Reuse/harden the existing base normalization and validation, then assign only `config.uri_base`.
4. Do not add fields or reallocate the 289-byte config. Preserve its discriminator, field order, `SPACE`, `MAX_URI_BASE = 96`, seed, all existing instruction signatures/discriminators, error numbering, URI suffixes, dependencies, and CPI behavior.
5. Continue generating every new box, figure, and receipt URI only from the current `config.uri_base`.
6. Update box validation in both `start_open_box` and `finalize_open_box` to accept either:
   - current `config.uri_base`; or
   - the hard-coded legacy base `https://assets.mons.link/drops/lsb`.

The dual-base check is required. Without it, flipping the config would immediately make unopened old-URI boxes and pending opens fail validation. It also makes an incremental asset migration recoverable.

The setter changes future generated URIs only. Existing NFTs, cNFT leaves, and the collection keep their full stored URIs until directly updated.

## Repository paths for the later migration

| Purpose | Path / note |
| --- | --- |
| Canonical drop registry row | `functions/src/shared/deploymentRegistry.ts` (`little_swag_boxes`) |
| Frontend/functions projections | `src/config/deployment.ts`, `functions/src/config/deployment.ts`; do not hand-edit generated/projected values |
| Legacy/compact path derivation | `functions/src/shared/deploymentCore.ts` |
| URI classification and ID parsing | `functions/src/shared/dropMetadataUri.ts` |
| Config decoder | `functions/src/shared/boxMinterConfigCodec.ts` |
| Read-only DAS inventory helper | `scripts/exportCollectionFiles.ts` |
| Metadata JSON conventions | `scripts/docs/drop_metadata.md` (preserve LSB legacy layout) |
| Existing unsafe generic upgrader | `scripts/upgrade-onchain.ts`; must be adapted to a historical worktree and secure signer |
| Current program source | `onchain/programs/box_minter/src/lib.rs`; incompatible with the legacy deployment |

The canonical registry currently contains the old base and `metadataPathFormat: 'legacy'`. Frontend and Functions project from it. Both also check that the registry base matches the live config, so the setter and registry/app rollout must be coordinated tightly or temporarily support old-or-new during rollout.

There is no existing bulk MPL Core/Bubblegum metadata updater. Build a purpose-specific tool that is dry-run-first, resumable, idempotent, simulation-gated, and writes a manifest/checkpoint with each asset, old URI, target URI, authority, proof/root where applicable, and confirmed signature.

`scripts/exportCollectionFiles.ts` can help discover collection assets, but its output is not sufficient for mutation. A later read-only inventory can start with:

```sh
npm run export_collection_files -- --cluster mainnet-beta --output <output-dir> 7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr
```

## Existing-asset snapshot and update rules

The audit found, at that time:

- 529 live MPL Core NFTs;
- 142 live Bubblegum v2 cNFT receipts; and
- 311 historical burned Core assets, which are not update targets.

These counts are not a migration manifest. Re-enumerate immediately before execution and save asset IDs, owners, authorities/delegates, current full URIs, parsed kind/numeric ID, tree, and fresh proofs.

For MPL Core assets:

- derive the new URI from the verified old URI kind and numeric ID, never from name alone;
- update the URI only, preserving owner, name, collection, plugins, and update authority;
- update the collection URI separately to `<NEW_BASE>/collection.json`;
- perform canaries first, then resumable batches; and
- account for possible per-asset realloc/rent if the new URI is longer.

For Bubblegum v2 receipt cNFTs:

- filter to the receipt tree `Bep28…VThV` and expected collection;
- use Bubblegum v2 metadata update with the current leaf metadata, owner/delegate accounts, Core collection, authorized collection authority signer, and a freshly fetched proof;
- change only the URI and preserve every other metadata field;
- do not use stale cached proofs or unsafe concurrency because each tree update changes the root; and
- confirm and re-fetch each result, retrying with a newly fetched proof when necessary.

## Suggested execution order if explicitly approved later

1. Choose `<NEW_BASE>`, validate its length/format, and publish all legacy-path JSON/media while keeping the old host live.
2. Re-audit program/config/collection authorities, raw account layouts, receipt tree, balances, and current DAS inventory. Stop on any mismatch.
3. Save a durable pre-migration manifest and dump/archive the live ELF, hash, config bytes, registry row, and asset state.
4. Prepare the minimal patch from `02075c7`; pin the build; test legacy instruction discriminators/account layouts and old/new box + pending-open flows on cloned state.
5. Build dedicated setter/Core/Bubblegum tools. Require dry-run manifests, simulation, idempotency, checkpoints, and explicit mainnet transaction review.
6. Deploy the patched ELF in place to the same program ID. Verify ProgramData authority, new deploy slot, and deployed hash.
7. Invoke `set_uri_base(<NEW_BASE>)` once and verify both raw and decoded config. From this point, future figure/receipt generation must use only the new base while old boxes remain accepted.
8. Coordinate the canonical registry update and frontend/Functions deployment so runtime base checks stay compatible. Keep `metadataPathFormat: 'legacy'`.
9. Update the collection URI separately.
10. Update a small Core NFT canary set, verify, then update remaining live Core NFTs.
11. Update a small cNFT canary set with fresh proofs, verify, then continue conservatively through the receipt tree.
12. Verify that zero live target assets remain on the old prefix, all new URLs resolve, config and registry agree, old and new boxes can open, pending opens finalize, and newly minted receipts use the new base. Allow for DAS/marketplace cache delay.

Stop immediately on an authority mismatch, unexpected layout/discriminator/hash, non-URI field change, unresolved target, persistent stale-proof failures, or registry/config mismatch.

## Rollback and cost notes

Keep the old host online and retain the complete old-to-new manifest. Partial migration is expected to be recoverable only because both bases are served, box validation accepts both bases, and all tools are idempotent.

The simplest program/config rollback is to call the patched setter with the old base and leave the dual-base program deployed. Asset URI rollback remains a separate reverse batch. If the original ELF must also be restored, restore the old config and box URIs first, then re-upgrade the archived old ELF; restoring an ELF does not restore config or asset data.

Previously estimated program-side costs:

- about `0.0022 SOL` in upgrade transaction fees;
- about `3.0133 SOL` temporary buffer working capital, normally recovered after a successful close;
- about `0.000005 SOL` for the setter transaction; and
- if the patched ELF exceeds current capacity, about `0.00696 SOL` permanent rent per additional KB.

Re-estimate asset-update costs at execution time from the final new-base length, fresh asset counts, representative simulated Core/cNFT transactions, required rent top-ups, current priority fees, and retry rate.
