# Mi Note public-drop deployment

Mainnet and devnet deployments are complete. Use the committed registry and
release records when inspecting them; do not rerun their initial setup or
replenish inventory. The reusable tooling supports two config PDAs for one logical
drop without rebuilding, deploying, or upgrading the shared program.

## Existing deployments

| Network | Mint config | Pack supply | Operations config | Operations items per box |
| --- | --- | ---: | --- | ---: |
| Mainnet | `mi_note_cards` | 627 | `mi_note_cards_operations` | 2 |
| Devnet | `mi_note_cards_devnet` | 704 | `mi_note_cards_devnet_operations` | 2 |

The mint role enforces public supply and has zero on-chain items per box. The
operations role has supply 715, allows card IDs through 1430, and handles opening,
existing-asset delivery, claims, and receipt issuance. The logical drop has two
cards per pack. Minting, prices, and supply statistics use the mint role.
**Never start the operations config:** the deployed program has no stop-mint
instruction. Pending opens bind the operations PDA from their first transaction.

Both PDAs remain approved collection UpdateDelegates alongside the existing
admin. Mainnet uses the existing `card_nft_2` program and splits mint proceeds
50/50 between the preorder recipients. Delivery/redemption fees go to the configured
delivery receiver. Prices, payment addresses, and metadata are authoritative in
`shared/deploymentRegistry.ts`.

| Reference | Source |
| --- | --- |
| Mainnet recipe and evidence | [Recipe](../newDrops/mi_note_cards.ts), [release](../../releases/mi-note-cards/README.md) |
| Devnet recipe and evidence | [Recipe](../newDrops/mi_note_cards_devnet.ts), [release](../../releases/mi-note-cards-devnet/README.md) |
| Frozen card allocation | [Inventory verification](mi_note_public_inventory.md) |
| Hosted metadata | [Metadata record](../../releases/mi-note-cards-mainnet/README.md) |

Mainnet metadata uses `https://cdn.lil.org/nft/mi_note_cards/json`; devnet uses
`https://cdn.lil.org/nft/mi_note_cards/json/pre`. The mainnet collection uses
`/json/collection.json` with `/square/166.jpg`; devnet retains
`/preorder/collection.json` and `/preorder/cover.jpg`. The
[collection update](../../releases/mi-note-cards/collection-metadata-update.json)
records the completed mainnet change. Original creation and conversion evidence
binds its original metadata and must remain unchanged.

Mainnet customs defaults are 0.2 oz and USD 14.67 per card, tariff code `4911.99`,
and SKU `mi-note-card`. The devnet rehearsal does not perform physical shipping
or send order email.

## Verification and recovery

Run these read-only checks from the repository root:

```sh
npm run prepare:mi-note-drop -- mi_note_cards --check releases/mi-note-cards/inventory.json
npm run prepare:mi-note-drop -- mi_note_cards_devnet --check releases/mi-note-cards-devnet/inventory.json
npm run dude-inventory-control -- status --drop mi_note_cards
npm run dude-inventory-control -- status --drop mi_note_cards_devnet
npm run verify:two-config-programs
```

Frozen-manifest verification retains permanent preorder exclusions, including
converted cards and verified burned assets. It does not require a launched
collection to resemble its prelaunch collection scan. The binary gate fetches
exact deployed bytes through read-only RPC and executes them locally with real
Metaplex dependencies; preserve its attestation and gate result.

Scripts prefer an explicit RPC override, then `HELIUS_API_KEY` from the process
or ignored project environment files, then public RPC. Managed worktrees can use
the primary checkout's environment files. Diagnostics print the RPC hostname
without credentials. No private key is needed for the read-only checks above.

Preserve interrupted deployment journals in
`.cache/two-config-deployments/<cluster>/`. Recover from the original command and
journal; the tool reconciles signatures and account state before retrying.
Activation similarly reconciles its saved public journal before signing another
transaction. An unfinished smoke uses its recorded run ID:

```sh
npm run smoke:mi-note-devnet -- --check
npm run smoke:mi-note-devnet -- --recover <runId> --yes
```

A run that has sent transactions is limited to recovery and cleanup, without
another purchase. See [activation recovery](mi_note_public_inventory.md#activate-and-recover)
for funding, verification, and retry rules.

## New deployment requirements

A new reviewed recipe and frozen manifest must establish permanent preorder
exclusions and exact eligible stock before initialization. Both configs start
unstarted and unminted; the authority, metadata, payments, delegates, receipt tree,
and lookup table must match the reviewed plan. A lower discounted price requires
a real nonempty whitelist; equal prices can use the System Program stub root.
A named missing whitelist file still fails.

The deployer simulates and journals signed transactions before broadcast, then
verifies finalized state before committing the logical registry entry. The binary
gate rechecks source hashes, binary hashes, deployment slots, and program identity.
Fetch-only output cannot authorize deployment. Authority input uses the masked
terminal prompt and is never placed in arguments or release records.

Initialize only a new drop's reviewed IDs with the scoped `initialize-new`
procedure in [inventory operations](mi_note_public_inventory.md#initialize-a-new-devnet-drop).
Publish the API before the frontend using the
[deployment runbook](cloudflare_deployment.md). Start only the primary mint config
after readiness checks. Existing pools are verified, never replenished.

The completed closed-sales setup and launch commands remain in the matched
pre-cleanup checkout `abb1e8b84fadae8d59af363e6b4a8117343f2dba` for historical
investigation. Their old route hold, metadata, and unused-inventory assumptions
are not current operational prerequisites. Completed preorder-conversion tooling
is recorded in its [release history](../../releases/mi-note-cards/preorder-upgrade/README.md#historical-tooling).
