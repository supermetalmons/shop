# Mi Note preorder metadata upgrade

`scripts/upgrade-mi-note-preorders.ts` updates the existing Core assets identified
by succeeded preorder orders and permanent claims. Each `Preorder #N` becomes
`card N`, with URI `https://cdn.lil.org/nft/mi_note_cards/json/pre/fN.json`.
The target spelling matches the deployed card program: lowercase `card`, one
space, and no `#`.

This is a metadata-only Core `UpdateV1`. Asset addresses, current owners,
collection membership, collection policy, original orders and claims, and the
frozen public-inventory exclusions are preserved. It does not mint replacements,
transfer assets, issue receipts, reopen preorder checkout, or return excluded IDs
to public stock. A holder's signature is unnecessary; the existing collection
authority signs and pays transaction fees.

## Roll out compatibility first

Deploy the compatible API before the frontend, and verify both before any NFT
update. Keep the rollout evidence in `compatibility.json` beside the migration
manifest. That evidence should include the deployed versions, live inventory
checks for all original preorders, and contract tests for converted cards with
devnet visibility both enabled and disabled. After conversion, save the live
converted-card checks in `api-verification.json`.

New inventory clients send `supportsConvertedPreorders: true` with the existing
resolution flags. Converted proofs carry `{ id, slot, owned, kind: 'dude',
visible }`; ownership remains distinct from network filtering. Legacy clients
receive no converted IDs in their preorder-resolution arrays and may need a
refresh. Frontend recovery uses v4 storage, imports v3 records, and keeps
conversion markers separate from ownership. Normal refreshes rotate bounded
rechecks so cached old metadata or absence cannot permanently hide a conversion.

## Artifacts and scope

Use one migration directory per collection:

```text
releases/mi-note-cards-devnet/preorder-upgrade/
  compatibility.json
  manifest.json
  preview.json
  journal.json
  verification.json
  api-verification.json
  completion.json
```

The prepared manifest binds the cluster/genesis, existing authority, collection,
deployed public drop, program evidence, frozen inventory, target JSON hashes, and
every exact claimed card ID and asset address. Target JSON must retain the matching
card ID, artwork name, canonical PNG image, unredeemed card attributes, and public
site URL. Preparation creates the manifest exclusively; an existing reviewed
manifest is never overwritten. Later source or target JSON changes stop the run
until they are reviewed.

Use the permanent ledger as the scope. Collection indexing is supplementary:
the devnet index has returned only 18 of the 22 claimed preorders even though
direct finalized reads found all 22. All assets must match their exact original
metadata or exact target metadata. Missing/burned accounts, another program,
unexpected collection or metadata, and unexpected asset plugins stop the run.

The current devnet scope is 22 assets, processed in batches of at most four
updates: six transactions if none are already converted. Each batch is checked
against Solana's packet limit and simulated. Fees are capped at 100,000 lamports
per transaction; the tool reports simulated fees, compute usage, and rent deltas.
Shorter metadata can release account rent to the authority fee payer. That
protocol refund and transaction fees are permitted balance changes.

## Prepare and preview devnet

```sh
npm run upgrade-mi-note-preorders -- mi_note_cards_devnet --prepare releases/mi-note-cards-devnet/preorder-upgrade/manifest.json
npm run upgrade-mi-note-preorders -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/preorder-upgrade/manifest.json
```

Preparation reads Commerce and finalized Solana state and saves only the local
manifest. Preview revalidates the source and performs unsigned simulations for
remaining batches. Neither mode requests a signer or sends transactions.

The shared RPC resolver checks the selected cluster's genesis and uses finalized
slot floors. An explicit trusted endpoint may be configured through
`TWO_CONFIG_DEVNET_RPC_URL` or `TWO_CONFIG_MAINNET_RPC_URL`. Logs identify only the
RPC host; never put RPC credentials or private keys in release artifacts.

## Apply or resume

After reviewing the manifest, compatibility evidence, and simulation results:

```sh
npm run upgrade-mi-note-preorders -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/preorder-upgrade/manifest.json --write
```

The terminal requests the collection authority through the existing masked,
memory-only signer flow. `--yes` may be added to skip repeated confirmations
after approval; it does not bypass validation, simulation, or signer matching.
No key or seed belongs in chat, command arguments, environment files, or the
journal.

Each signed transaction is saved durably in the sibling `journal.json` before
broadcast. The command uses the deployment-registry mutation lock, checks for
changed local files, and revalidates source, ownership, collection policy, and
finalized state before signing. Already-converted assets are skipped.

If a run stops, preserve the same manifest and journal and rerun the same write
command. Recovery checks the recorded signature and account effects, resends
only the exact saved signed bytes when still pending, and permits replacement
only after a definitive failed or expired result. Do not delete the journal,
start a second manifest directory for the same assets, or run concurrent writers
to work around an unresolved transaction.

Successful application writes `verification.json`. Recheck without signing:

```sh
npm run upgrade-mi-note-preorders -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/preorder-upgrade/manifest.json --check
```

`--check` fails while any scoped asset still has original preorder metadata. It
revalidates final target identities, collection resources, the permanent source,
and public inventory conservation. It reads any existing journal without rewriting
it and reports recorded preservation checks separately from current metadata
completion. An unresolved saved attempt must be reconciled through the same
write command. A holder's legitimate later transfer does not erase an already
recorded preservation check. Inspect public inventory afterward with devnet
visibility on and off; converted cards must not reappear as preorder tiles.
Record the independent transaction, preservation, and frozen-manifest checks in
`completion.json`, retaining the execution report and journal unchanged.

## Future mainnet run

Use `mi_note_cards` and a separate
`releases/mi-note-cards/preorder-upgrade/` directory. The tool requires that
collection's matching deployed public drop, its own frozen inventory, and valid
program/deployment evidence. It cannot substitute the devnet manifest or run
against an undeployed mainnet drop.

Preparation, preview, and checking remain read-only on chain. Applying or resuming
mainnet additionally requires `--write --allow-mainnet`; add `--yes` only after
the mainnet scope and costs have been reviewed. The batch size and recovery rules
are identical, while the asset list and expected totals come from that mainnet
collection's authoritative ledger.
