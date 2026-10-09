# Mi Note Cards mainnet deployment

Mainnet minting and unpacking are live. The [activation record](activation.json)
contains the finalized `start_mint` transaction
`35ocZGdLTAmK9cWuA83QPS9YmVKQ7VgxbQ9PX8jmqiRBCnBwyW9SMeBkBjcwR89n7naevZdxWTFz62oLF1NhUNdR`.
It activated mint configuration A at slot `455004277`. Operations configuration B
keeps its mint flag off and its two-card opening functionality enabled; starting
its separate mint would expose additional public supply and is not part of this drop.

The [launch verification](launch-verification.json) records a finalized snapshot
with 201 of 627 packs minted and a conserved inventory of 1,234 available plus
20 assigned cards. All 176 preorder IDs remain permanently excluded. Every
preorder was converted in 44 finalized batches; 174 remain live and two were
subsequently burned. See the [completed conversion](preorder-upgrade/README.md).

The public page offers packs at 0.5 SOL with a 15-pack transaction limit, the
latest committed interactive card/unpacking UI, and interaction sounds. API
version `cd590fcf-3304-4d5b-a328-da706334334e` and frontend version
`1d5cc7ce-0612-41c7-b814-143ab9396b4c` each serve 100% of traffic. The live frontend
bundle matches the local build. Mi Note customs use the Card NFT 2 defaults:
0.2 oz and USD 14.67 per card, tariff code `4911.99`, and SKU `mi-note-card`.
Existing shipping fees and payment recipients are unchanged.

Activation reads and simulations retry temporary minimum-slot lag while retaining
the same request and finalized floor. Simulations also require the context slot
of their blockhash. Known Core burn tombstones are accepted only when rechecking
an exactly registered frozen manifest; their card IDs remain excluded. Receipt
capacity checks allow legitimate preorder redemptions before pack sales begin.

## Initial deployment with sales closed

Status recorded on 2026-10-09: mainnet setup is finalized, inventory is initialized,
and the API and frontend are published with sales closed. Both configs remain
unstarted with zero minted packs, and all 176 preorder NFTs retain their original
identities and metadata. The live [mainnet page](https://mons.shop/mi_note_cards)
shows **Soon / Notify Me** without purchase controls.

| Phase | Verified state |
| --- | --- |
| On-chain setup | Five finalized transactions; both configs, tree, and lookup table ready |
| Inventory | 1,254 available cards, zero assignments, all 176 preorder IDs excluded |
| Minting | Both configs unstarted and unminted |
| Collection | Original metadata, authority, royalties, and non-delegate plugins preserved |
| Application | API published before frontend; live health, inventory, and page checks passed |
| Devnet | Existing purchase page still shows Mint 0.25 SOL |
| Checks | Full repository checks and exact deployed-program binary gate passed |

The [deployment record](deployment.json) preserves the five signed transactions
and final verification slot `454949509`. Independent
[transaction verification](transactions-verification.json) confirms only the
approved setup instructions ran, spending 173,451,520 lamports on account funding
and 25,000 lamports on transaction fees: **0.17347652 SOL** total.
The [chain verification](chain-verification.json) confirms both roles, all original
preorders, the unchanged collection data, the unused receipt tree, and the exact
lookup-table contents.

[Inventory initialization](inventory-initialization.json) created generation
`7433c586-999d-471e-90f0-f90bea35b3ef` without pausing Commerce. The
[post-deployment inventory check](inventory-verification.json) confirms the exact
manifest IDs and pool positions, unchanged permanent claims, and zero assignments.
The [readiness record](readiness.json) and [final verification](verification.json)
record the completed deployment with sales closed.

API version `37954d9f-ca0b-42c7-8ff2-ce1aba04e524` was published before frontend
version `82b45552-b557-4b69-b31e-84eca07e7156`. Both serve 100% of traffic.
Live inventory checks preserved mainnet preorders for both client capability
modes and both devnet filters. The browser loaded the verified frontend bundle,
showed the mainnet announcement, and retained the existing devnet mint controls.

The [preflight record](preflight.json) records the successful mainnet read-only
preview, unsigned delegate simulation, production database readiness checks,
and full repository checks. The [binary attestation](attestation.json) and
[gate result](gate-result.json) verify the exact deployed program bytes locally
with the mainnet price, metadata base, and payment recipients. No mainnet
transaction was signed or sent during preflight.

The public drop has 627 two-card packs at 0.5 SOL. Its independent
[inventory manifest](inventory.json) excludes 176 mainnet preorder IDs and contains
1,254 eligible original card IDs. No card is renumbered; the eight specials and
eligible IDs through 1430 remain available. Existing preorder claims remain
permanently excluded, including after a later metadata conversion.

| Role | Config ID | Config PDA | Supply | Items per box |
| --- | --- | --- | ---: | ---: |
| Mint | `mi_note_cards` | `5XNpnLR2Z8mSuPSB9yh9ozdSWbb2PDVA1L8UUjXMa3nF` | 627 | 0 |
| Operations | `mi_note_cards_operations` | `7Eivdi78jrvCtLQ4H9HmkdUDKnq4QhY1xfsJbTsDWfrY` | 715 | 2 |

At initial deployment both configs remained unstarted with zero minted packs.
Only mint configuration A was later activated. Operations capacity permits card
IDs through 1430; it does not represent additional public packs.
The registry exposes one logical drop with two cards per pack and a 15-pack
transaction limit. Stripe and discounted minting remain disabled.

The existing collection is `BtEknBg1b9ZLJHLTGJcadxeQhQwtdVsoPGDrc9cXwczG`.
Reuse program `7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU` through the
`card_nft_2` program source without building, deploying, or upgrading a program.
Authority `kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx` remains unchanged.
Append both config PDAs to the existing collection UpdateDelegate list while
preserving the authority delegate, metadata, royalties, and BubblegumV2 plugin.

| Payment | Recipient | Share |
| --- | --- | ---: |
| Mint proceeds | `BmV4TRHUfMZcaa6iZA4tSGf6ACGoLLsYEHcC55AEKAYf` | 50% |
| Mint proceeds | `8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM` | 50% |
| Shop delivery/redemption SOL fees | `8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM` | 100% |

Both normal and disabled-discount prices are 500,000,000 lamports. Each pack
purchase transfers 250,000,000 lamports to each mint recipient. Existing shipping
prices and the collection's 500-bps royalties are unchanged.

Item metadata uses `https://cdn.lil.org/nft/mi_note_cards/json` with `fN.json`,
`rfN.json`, `bN.json`, and `rbN.json`. The collection URI remains
`https://cdn.lil.org/nft/mi_note_cards/preorder/collection.json`.
The separate [metadata record](../mi-note-cards-mainnet/README.md) describes the
4,114 hosted JSONs. Devnet retains its `/json/pre` base and original frozen records.

The finalized receipt tree is `9kvQRquRALfWqFW6VCgXSWSqqQrzcksefxSEhfAVEDVY`,
with depth 14, buffer 64, and canopy 0. Its TreeConfig is
`4LJqUfUbTFHnB7mGxNy7pUgBHSTZykfiHoykzCzq8e7Y`. Lookup table
`AmGxiZNLys6jQDUQsxumnuVmjzD6MA7H6MAh5PXbLvgz` is active and includes both
configs and the delivery receiver.

Use the [mainnet deployment runbook](../../scripts/docs/mi_note_drop_deployment.md#mainnet-setup-with-sales-closed).
The initial deployment retained an explicit **Soon / Notify Me** route hold.
The subsequent launch removed that hold, enabled mint configuration A, and
published the approved physical customs settings. The original deployment
records above remain unchanged as historical evidence.

## Later preorder metadata conversion

The separate [preorder conversion](preorder-upgrade/README.md) tracks the
completed update of the 176 existing NFTs to their regular-card names and
mainnet metadata URIs. Conversion ran while both configs were stopped and
preserved this deployment evidence and every permanent public-inventory exclusion. Its manifest, execution
journal, and verification records live in `preorder-upgrade/`.
