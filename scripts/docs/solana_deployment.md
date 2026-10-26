# Solana deployment and metadata compatibility

The mainnet Mi Note Cards collection is already deployed. Its current configuration
uses `https://cdn.lil.org/nft/mi_note_cards/json/collection.json` with image
`https://cdn.lil.org/nft/mi_note_cards/square/166.jpg`. The completed update and its
finalized transaction are recorded in
[`releases/mi-note-cards/collection-metadata-update.json`](../../releases/mi-note-cards/collection-metadata-update.json).
Future one-off Solana operations can use the reusable
[Worker transaction helper](worker_transactions.md), with their own
instructions and verification checks.

The original creation record and completed preorder-conversion manifests remain
historical evidence. Their exact configuration checks bind the original URI and
image; do not rewrite those records or rerun the original creation/conversion
checks as verification of the current collection metadata.

For a new collection, copy the typed `NEW_PREORDER_COLLECTION` configuration
and set its identity, expected authority public key, hosted
`collectionMetadataUri`, symbol, description, image URL, `sellerFeeBasisPoints`
(explicitly use `0` for no royalties), and royalty creators with address/share
entries totaling 100. Preserve existing configurations and deployment records
for verified reruns and recovery.
An optional `solanaRpcUrl` overrides the cluster's default RPC. Publish the
collection metadata JSON and image yourself first. Its name, symbol, description,
image, `external_url`, `seller_fee_basis_points`, and `properties.creators` must
match the configuration; the tool validates hosted metadata and does not upload it.

The deployed `mi_note_cards_devnet` collection retains
`https://cdn.lil.org/nft/mi_note_cards/preorder/collection.json` and its original
`preorder/cover.jpg` image. It shares the mainnet authority and royalty settings,
with the devnet RPC. Verify it with:

```bash
npm run deploy-preorder-collection -- mi_note_cards_devnet
```

Run in an interactive terminal. After validating the configuration, metadata,
and RPC cluster, the command uses the existing hidden private-key prompt
(base58 or JSON array), and checks the key against the expected authority. It
simulates collection creation, shows its details and estimated SOL cost, and
requires `y` before sending. Private keys stay in memory.

The command creates a mutable Metaplex Core collection with Royalties,
BubblegumV2, and UpdateDelegate plugins. The admin is its root update authority
and sole initial delegate. It creates no NFTs, receipt tree, custom program, or
active shop-drop registry entry. Royalties are collection resale settings;
future preorder checkout payment splits are configured separately.

After finalized verification, the public result is saved in
`scripts/preorderCollectionDeployments/<cluster>/<collectionId>.json`, and the
command prints a ready-to-copy `coreCollectionPubkey` assignment. Rerunning the
same command verifies and returns the existing collection instead of deploying
another. Public pending journals and per-collection locks live under
`.cache/preorder-collection-deployments`. Preserve pending journals during
interrupted or ambiguous submissions and rerun the command for recovery. Remove
a stale lock only after verifying that its owning process has stopped; keep the
pending journal. Do not delete pending journals to bypass a recovery block.

For a later drop, set its `coreCollectionPubkey` to the saved address and grant
that drop's config PDA permission through the collection's UpdateDelegate plugin
before ordinary drop deployment. The collection admin must match the future
drop's deployer/allowed initializer, or its authority must be transferred first.
`reuseProgramIdFromDropId` independently chooses the existing minting program;
it does not grant collection permissions. The preorder deployment command does
not add future drop delegates.

Provision a reusable cluster-scoped receipt pool:

```bash
npm run deploy-receipt-pool -- <poolId> <devnet|mainnet-beta>
```

Create a new drop configuration by following the
[typed example instructions](../newDrops/README.md), then deploy it from
`scripts/newDrops/<dropId>.ts`:

```bash
npm run deploy-all-onchain -- <dropId>
```

The deploy tool refuses already-registered drop IDs and updates only
`shared/deploymentRegistry.ts`. Historical launch recipes remain in Git; current
deployment records and compatibility tests use the canonical registry. The tool
accepts HTTPS,
`ipfs://`, or raw CID metadata bases and normalizes raw CIDs to canonical
`ipfs://CID` values.

Metadata URI history is part of live on-chain compatibility:

- Existing legacy `/json/...` drops must keep their recorded
  `metadataPathFormat`, base aliases, and program behavior.
- The first compact-metadata drop in a program lineage must use a fresh program
  (`reuseProgramId = false`) so it cannot change legacy URI behavior.
- Later compact drops may reuse that lineage with `reuseProgramId = true`; use
  `reuseProgramIdFromDropId` to pin the source drop explicitly.
- Do not delete URI migration records, legacy codecs, aliases, or compatibility
  tests merely because current drops use compact metadata.

Those records, compatibility helpers, and their verifier are retained
operational evidence, not obsolete deployment tooling.

The completed URI rollout commands have been retired. Historical recovery uses
the pinned source and artifacts described in the
[URI migration release record](../../releases/mainnet-uri-migrations-2026-08-05/README.md#historical-tooling-and-recovery).

Verify the historical mainnet URI migrations before changing URI logic:

```bash
npm run verify:mainnet-uri-migrations
```

Upgrade an existing program only through the canonical registered drop:

```bash
npm run upgrade-onchain -- <dropId> --dry-run
npm run upgrade-onchain -- <dropId>
```

Rehearse upgrades on the corresponding devnet drop first. Reused program drops
skip program build and deployment during ordinary `deploy-all-onchain`; an
intentional upgrade must use `upgrade-onchain`.

Stripe test Checkout performs a pre-payment availability check but does not
reserve on-chain supply. If supply sells out before webhook fulfillment, the
checkout is marked for manual refund review with its Stripe session identifier.

Completed preorder-conversion commands are available only in the
[recorded historical checkout](../../releases/mi-note-cards/preorder-upgrade/README.md#historical-tooling).
Their original closed-sales and metadata assumptions do not verify a live drop.
