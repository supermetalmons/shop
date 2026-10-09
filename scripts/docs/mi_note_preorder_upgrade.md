# Mi Note preorder metadata upgrade

`scripts/upgrade-mi-note-preorders.ts` updates the existing Core assets identified
by succeeded preorder orders and permanent claims. Each `Preorder #N` becomes
`card N`, with URI `https://cdn.lil.org/nft/mi_note_cards/json/fN.json` on mainnet
or `https://cdn.lil.org/nft/mi_note_cards/json/pre/fN.json` on devnet.
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

The mainnet drop already has this compatibility deployed. A change confined to
the upgrade script, tests, and documentation does not require another application
deployment; verify the current versions and behavior before updating any NFTs.

New inventory clients send `supportsConvertedPreorders: true` with the existing
resolution flags. Converted proofs carry `{ id, slot, owned, kind: 'dude',
visible }`; ownership remains distinct from network filtering. Legacy clients
receive no converted IDs in their preorder-resolution arrays and may need a
refresh. Frontend recovery uses v4 storage, imports v3 records, and keeps
conversion markers separate from ownership. Normal refreshes rotate bounded
rechecks so cached old metadata or absence cannot permanently hide a conversion.

## Artifacts and scope

Use one migration directory per collection. Mainnet uses
`releases/mi-note-cards/preorder-upgrade/`; the devnet layout is:

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
card ID, artwork name, unredeemed card attributes, and public site URL. Devnet
requires the canonical `clean/N.png` primary image and PNG file entry. Mainnet
requires the canonical `square/N.jpg` primary image and JPEG file entry, plus
the matching `clean/N.png` additional file. Hosted JSON names remain `Card #N`,
as they do for regularly minted cards; the on-chain name is `card N`.
Preparation creates the manifest exclusively; an existing reviewed
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
An RPC node that has not reached the required minimum slot is retried up to
three times, retaining the same slot floor and transaction bytes. Other failures
stop the run, and persistent lag never falls back to older account state.

## Apply or resume

After reviewing the manifest, compatibility evidence, and simulation results:

```sh
npm run upgrade-mi-note-preorders -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/preorder-upgrade/manifest.json --write
```

The terminal requests the collection authority through the existing masked,
memory-only signer flow. `--yes` may be added to skip repeated confirmations
after approval; it does not bypass validation, simulation, or signer matching.
Add `--auto-recover` with `--write --yes` for an unattended run. It retains the
signer in memory, retries temporary RPC and metadata availability errors with
backoff up to 30 seconds, reconciles pending signatures using the original signed
bytes, and prepares a fresh transaction after verified expiry. Completed assets
are skipped. Validation changes and failed on-chain instructions still stop the
run; automatic recovery never discards the journal or guesses an uncertain outcome.
No key or seed belongs in chat, command arguments, environment files, or the
journal.

Each signed transaction is saved durably in the sibling `journal.json` before
broadcast. The command uses the deployment-registry mutation lock, checks for
changed local files, and revalidates source, ownership, collection policy, and
finalized state before signing. Already-converted assets are skipped.
After the full source checks, it obtains a fresh blockhash and repeats the batch
simulation immediately before signing. Ownership and collection policy must
still match the earlier simulation, so slow source verification cannot consume
the validity window of the transaction that is actually sent.

If the process is interrupted, preserve the same manifest and journal and rerun the same write
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

## Mainnet conversion with pack sales closed

The Mi Note mainnet conversion is now complete and public pack sales have since
opened. The commands below document the original closed-sales migration phase;
they are not instructions to rerun the completed migration against the live drop.
See the [completion record](../../releases/mi-note-cards/preorder-upgrade/README.md)
and [launch record](../../releases/mi-note-cards/README.md) for the current state.

Use `mi_note_cards` and the separate
`releases/mi-note-cards/preorder-upgrade/` directory. The tool requires that
collection's matching deployed public drop, its own frozen inventory, and valid
program/deployment evidence. It cannot substitute the devnet manifest or run
against an undeployed mainnet drop.

The mainnet scope is 176 claimed preorder assets: 44 transactions with four
updates each when none are already converted. The existing 1,254-card public
pool and all permanent exclusions remain unchanged. Both config PDAs must
remain unstarted with zero mints, and `/mi_note_cards` must retain its Soon page.
Converted assets gain the existing ordinary-card redemption and shipping behavior;
this does not start pack sales or change shipping prices, payment recipients, or
customs settings. Do not redeem or ship assets as part of migration verification.

```sh
npm run upgrade-mi-note-preorders -- mi_note_cards --prepare releases/mi-note-cards/preorder-upgrade/manifest.json
npm run upgrade-mi-note-preorders -- mi_note_cards --manifest releases/mi-note-cards/preorder-upgrade/manifest.json
npm run upgrade-mi-note-preorders -- mi_note_cards --manifest releases/mi-note-cards/preorder-upgrade/manifest.json --write --allow-mainnet --yes --auto-recover
npm run upgrade-mi-note-preorders -- mi_note_cards --manifest releases/mi-note-cards/preorder-upgrade/manifest.json --check
```

Preparation, preview, and checking remain read-only on chain. Applying or resuming
mainnet additionally requires `--write --allow-mainnet`; add `--yes` only after
the mainnet scope and costs have been reviewed. The batch size and recovery rules
are identical, while the asset list and expected totals come from that mainnet
collection's authoritative ledger.

Record all 176 asset identities, current-owner preservation, exact target names
and URIs, finalized signatures, fees and rent changes, source and inventory
hashes, and the unchanged public pool generation. Verify converted cards remain
visible on mainnet with either devnet filter and never reappear as preorder tiles.
Retain the existing deployment and devnet migration evidence unchanged.
