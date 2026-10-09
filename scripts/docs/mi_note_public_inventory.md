# Mi Note public inventory

`scripts/prepare-mi-note-drop.ts` prepares inventory from `mi_note_cards.json`
and the closed preorder collection on the selected Solana cluster. It reads
Commerce D1 and finalized Solana accounts; it never writes to either service.
The release manifest contains card IDs, hashes, counts, and verification metadata.
It does not contain buyers, Ethereum addresses, signatures, or signed transactions.

## Prepare and verify a snapshot

```sh
node --import tsx scripts/prepare-mi-note-drop.ts mi_note_cards_devnet --output releases/mi-note-cards-devnet/inventory.json
node --import tsx scripts/prepare-mi-note-drop.ts mi_note_cards_devnet --check releases/mi-note-cards-devnet/inventory.json
```

The output file is created exclusively: an existing reviewed manifest is never
overwritten. Use `--check` to revalidate it. Set `MI_NOTE_PREORDER_RPC_URL` to a
trusted HTTPS RPC for the selected cluster when the public RPC is insufficient.
The verifier checks its genesis hash and uses finalized commitment. Provider
configuration uses the shared RPC resolver, including the configured Helius
credential; logs and release files never contain RPC secrets.

New snapshots require complete prelaunch collection coverage. The verifier unions
the collection scan with every recorded succeeded asset address, directly reads
those accounts, and requires their distinct count to equal the stable onchain
collection size. Index lag never removes a permanent preorder exclusion.

Rechecking a frozen manifest after the matching public drop is registered instead
requires the unchanged catalog and D1 source fingerprint plus direct finalized
verification of every recorded preorder asset. It still rejects observed unknown
or malformed preorder identities. It does not equate Core account count with the
collection size: compressed receipt mints increase that size too. Before public
registration, rechecks retain the complete prelaunch coverage requirement.

After the [preorder metadata upgrade](mi_note_preorder_upgrade.md), frozen-manifest
verification also accepts each ledger-recorded asset's exact `card N` name and
`fN.json` URI under the matching registered drop. The original asset address and
card ID must still match the permanent claim. Conversion never changes this
inventory manifest or makes an excluded ID available for public assignment.

The committed devnet snapshot excludes 22 preordered cards, leaving 1,408 cards
for exactly 704 two-card packs. It preserves every `clean_card_id`, including
the eight specials 1401–1408 and high IDs through 1430. Succeeded orders remain
excluded even when their legacy `confirmed_slot` is null. Prepared or submitted
orders, missing permanent claims, duplicate identities, differing onchain assets,
and an odd remaining card count stop preparation.

Claims are scoped to the selected preorder collection and cluster. The same
read-only workflow supports `mi_note_cards` on mainnet; its snapshot must be
prepared independently. Snapshot preparation does not deploy or initialize a
mainnet drop. The collection scan distinguishes existing preorders from bounded
pack/card metadata belonging to the matching registered public drop. Public
assets do not change preorder exclusions; malformed or unknown assets and
changed claimed preorder addresses still stop verification.

## Initialize a new devnet drop

Deploy and register the two configurations on the existing shared devnet program:
the mint configuration has 704 supply and zero items per box; the operations
configuration has 715 supply and two items per box. Both use the same admin,
metadata base, and collection. Keep both configurations unstarted with zero
minted packs during initialization. The logical drop has two cards per pack.

The registry's `inventoryManifest` must contain the snapshot's `sha256` and
`eligibleCardIds` as `cardIds`. Apply Commerce migration
`0036_scoped_inventory_initialization.sql` before using the new initializer.

```sh
node --import tsx scripts/ops/dudeInventoryControl.ts initialize-new --drop mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json
node --import tsx scripts/ops/dudeInventoryControl.ts initialize-new --drop mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json --write
node --import tsx scripts/ops/dudeInventoryControl.ts status --drop mi_note_cards_devnet
```

The first command is read-only. The write command rechecks the snapshot, both
finalized configurations against their committed identity, mint, and payment
fields, pending opens, reveal submissions, and public commerce history. It takes
the existing coordination lease without pausing Commerce or
Queues. A single SQL statement creates the initialization record, inserts all
eligible IDs with stable positions, verifies the complete set, and marks the
inventory ready. Any failure rolls the entire statement back. Existing preorder
orders and claims are unchanged.

An uncertain response can be retried with the same manifest. A ready inventory
is verified without replenishing assigned cards. An exact ready retry may audit
an already active drop; a new initialization still requires both configurations
to be unstarted. Different manifests, missing cards, assigned/available overlap,
or IDs outside the committed manifest are rejected. Existing paused maintenance,
assignment, deletion, and wipe guards retain their requirements.

Empty-database bootstrap and the legacy paused range initializer deliberately
reject frozen-manifest drops before mutation. An empty database cannot establish
the original preorder claims or prior public assignments. Restore authoritative
Commerce data for an existing drop; `initialize-new` is for a new, unstarted drop
whose scoped preorder ledger and finalized assets can still be verified.

The status command and deployment audit verify that available and assigned IDs
together equal the committed manifest, using one database snapshot for the two
sets. Only after initialization and the remaining deployment checks should the
mint configuration be started. The operations configuration remains unstarted.

## Activate and recover

```sh
node --import tsx scripts/startMint.ts mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json --yes --smoke
```

`--yes` skips repeated confirmation questions; simulation and masked authority
key entry remain required for a fresh activation. The public `activation.json`
record is saved before broadcast and contains an append-only `attempts` history.
It stores signed transaction bytes and public identities, never private keys.

Rerun the same command after an uncertain activation. The tool validates that a
saved transaction is exactly `start_mint` for A, reconciles finalized state, and
resends only the same pending bytes. Failed or definitively expired attempts are
retained before fresh signing is allowed. Legacy version-1 records are migrated
without discarding their signed transaction. An already active A is a verified
no-op; B must still be unstarted and unminted, and allocated cards remain covered
by the inventory conservation check. A mainnet two-config activation separately
requires `--allow-mainnet`.

The optional smoke runs only after verified activation and reuses the in-memory
signer. A completed smoke is not repeated by an activation retry. If it fails,
use its recorded run ID with the standalone smoke command's `--recover <runId>`;
an activation retry cannot replace an unfinished smoke with another purchase.

A standalone recovery reports `recovered` after cleanup. That result alone does
not establish that minting, opening, delivery, and receipts all completed. Verify
the saved transaction signatures, revealed IDs, receipt metadata, unchanged
preorder fingerprints, and zero remaining buyer balance or assets. Preserve the
original smoke record, save the final verification, and reconcile only the
matching activation journal's smoke outcome using its expected-source write.
The [devnet verification record](../../releases/mi-note-cards-devnet/verification.json)
shows the completed release checks.
