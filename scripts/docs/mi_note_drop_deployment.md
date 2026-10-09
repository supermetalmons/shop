# Mi Note public-drop deployment

Use the existing shared programs with two config PDAs for one logical drop.
This workflow never builds, deploys, or upgrades a program. Existing preorder
NFTs remain unchanged, and the collection is reused for packs, cards, and receipts.

| Role | Devnet identity | On-chain supply | On-chain items per box | Minting |
| --- | --- | ---: | ---: | --- |
| Mint | `mi_note_cards_devnet` | 704 | 0 | Start only after readiness checks |
| Operations | `mi_note_cards_devnet_operations` | 715 | 2 | Keep unstarted and unminted |

The logical drop retains `itemsPerBox: 2`. The operations role permits card IDs
through 1430, while the mint role enforces the real public pack count. Opening
must use the operations role from its first transaction: the pending record binds
that PDA. Initializing the mint role with zero items prevents incorrect opening
through it. Both PDAs must be collection UpdateDelegates; retain the existing admin.

The deployed initializer requires a nonzero discount root. Both deployment tools
automatically use the System Program stub, `11111111111111111111111111111111`,
when the discount CSV is omitted or empty and normal and discount prices are equal.
Its root is `66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925`.
This saved Mi Note recipe retains its explicit stub CSV so its recovery-journal
identity stays unchanged. A named missing file still fails; a lower discounted
price requires a real nonempty whitelist before deployment can begin.

Minting, prices, and supply statistics use the mint role. Opening, existing-asset
delivery, claims, and receipt issuance use the operations role. Supply-reserving
sales instructions belong to the mint role and are not enabled for this rehearsal.

## Sources and local compatibility gate

- Devnet recipe: [`../newDrops/mi_note_cards_devnet.ts`](../newDrops/mi_note_cards_devnet.ts).
- Devnet release: [`../../releases/mi-note-cards-devnet/README.md`](../../releases/mi-note-cards-devnet/README.md).
- Preorder inventory process: [mi_note_public_inventory.md](mi_note_public_inventory.md).
- Hosted metadata: [`../../releases/mi-note-cards-mainnet/README.md`](../../releases/mi-note-cards-mainnet/README.md).

The metadata base is `https://cdn.lil.org/nft/mi_note_cards/json/pre`.
Collection metadata continues to use the existing preorder collection URI.
Devnet pack and pack-receipt JSONs 628–704 may be missing; preserve their numeric
IDs and canonical URIs. All card IDs still use the original catalog numbering.

```sh
npm run prepare:mi-note-drop -- mi_note_cards_devnet --check releases/mi-note-cards-devnet/inventory.json
npm run verify:two-config-programs
npm run check
```

The binary gate fetches deployed programs through read-only RPC and executes
their exact bytes locally with real Metaplex dependencies. It does not rebuild
the box minter. Preserve its public attestation and successful gate result.
The deployment command rechecks source hashes, binary hashes, deployment slots,
and the current program identity; fetch-only output cannot authorize deployment.

The scripts prefer an explicit RPC override, then `HELIUS_API_KEY` from the
process environment or the project's `.env.local`/`.env` files. A managed Git
worktree can also use those files in its primary checkout. Public RPC is the
fallback when no credential is configured. Requests use bounded retries for
transient HTTP failures; diagnostics display the RPC hostname without credentials.

## Preview and initialize on devnet

```sh
npm run deploy-two-config-drop -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json
npm run deploy-two-config-drop -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json --write --yes
```

The first command is read-only. The second prints the reviewed plan, prompts for
the existing authority through the masked terminal flow, simulates each step,
and writes its signed public transaction journal before broadcast. `--yes` skips
repeated transaction confirmations; it does not skip simulation or signer checks.
Never put signer contents in command arguments, release records, or chat.

The workflow preserves collection metadata, royalties, authority, and existing
plugins; merges both delegates; initializes both configs unstarted; provisions
one receipt tree and a lookup table containing both PDAs; and verifies finalized
state before committing the single logical registry row. Tree settings are depth
14, buffer 64, canopy 0. No additional public drop row represents operations.

Recovery journals are in `.cache/two-config-deployments/<cluster>/`. Preserve
them after interruption and rerun the same command. It reconciles signed
transactions and account state before retrying; do not delete journals to bypass
an uncertain outcome. Final public deployment records live in the release folder.

## Initialize stock and publish the application

```sh
npm run db:migrate:commerce
npm run dude-inventory-control -- initialize-new --drop mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json
npm run dude-inventory-control -- initialize-new --drop mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json --write
npm run check:commerce-d1 -- --for-deployment
npm run deploy:api
npm run deploy
```

Scoped initialization keeps Commerce and its Queues active. It requires the exact
reviewed manifest and two unstarted configs, then creates the inventory atomically
under the existing coordination lease. It never replenishes an initialized pool.
The API must be published before the frontend. Existing single-config drops and
the mainnet Mi Note upcoming page retain their behavior.

## Activate and verify

```sh
npm run start-mint -- mi_note_cards_devnet --manifest releases/mi-note-cards-devnet/inventory.json --yes --smoke
```

Activation rechecks the manifest, binary gate, both roles, and complete unused
inventory. It signs only for the primary mint config and reuses the in-memory
authority for the controlled smoke test. `--yes` skips repeated confirmations;
the masked key prompt and transaction simulations remain. Never run `start_mint`
for the operations PDA: the deployed program has no stop-mint instruction.

The public activation journal is saved before broadcast. Rerun this command after
an uncertain activation; it reconciles the saved attempt before signing another
transaction and treats an already active mint as a verified no-op. An unfinished
smoke must use its recorded `--recover <runId>` command. See
[activation recovery](mi_note_public_inventory.md#activate-and-recover).

The standalone smoke preflight does not request a private key or submit a
transaction:

```sh
npm run smoke:mi-note-devnet -- --check
npm run smoke:mi-note-devnet -- --recover <runId> --yes
```

Recovery can start the original smoke only when it failed before funding and
the derived test wallet has no account, balance, or transaction history. A missing
legacy smoke file also requires its matching, validated activation record. Runs
that have sent transactions remain limited to recovery and cleanup, without
another purchase.

After activation, perform the controlled devnet smoke test, record its public
signatures and IDs, and confirm that revealed cards are in the eligible manifest,
both cards and receipts use the existing collection, and all 22 preorders remain
unchanged. Verify an ordinary wallet can mint, open, and recover a pending reveal
on `/mi_note_cards_devnet` while normal mainnet inventory stays independent of
devnet provider availability.

## Later mainnet launch

Before mainnet physical fulfillment, supply the measured per-card weight and the
intended USD declared value and review the customs entry. Mi Note currently has
no automatic customs defaults. Keep the devnet rehearsal limited to minting,
opening, and on-chain receipts, without physical shipping or email orders.

Prepare a separate manifest from `mi_note_cards` and require 627 packs from its
own permanent preorder claims. Do not copy the devnet exclusion list. Create a
reviewed mainnet recipe using existing program
`7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU` and the saved mainnet preorder
collection, with mint identity `mi_note_cards` and operations identity
`mi_note_cards_operations`. The latter remains 715 supply, two items, and unstarted.

Use the same gate, preview, initialization, publication, and verification sequence.
Mainnet writes require an additional explicit `--allow-mainnet` flag. Mainnet
metadata coverage must be complete for every public pack and receipt; the devnet
missing-file allowance must not carry over. No mainnet activation is part of the
devnet rehearsal.
