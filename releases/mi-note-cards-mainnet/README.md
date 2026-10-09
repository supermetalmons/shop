# Mi Note Cards public-drop metadata

The 4,114 item metadata JSONs for the upcoming public `mi_note_cards` family drop
are hosted on the CDN. Generated JSON copies are no longer stored in this
repository; this release record preserves their paths and source mapping.

Use this exact metadata base for the upcoming public drop:

`https://cdn.lil.org/nft/mi_note_cards/json/pre`

Append `/<filename>` to that base, preserving `/json/pre/`.
The naming convention matches Card NFT 2.

| Group | Count | Hosted filenames | Example |
| --- | ---: | --- | --- |
| Cards | 1,430 | `f1.json`–`f1430.json` | [f1.json](https://cdn.lil.org/nft/mi_note_cards/json/pre/f1.json) |
| Packs | 627 | `b1.json`–`b627.json` | [b1.json](https://cdn.lil.org/nft/mi_note_cards/json/pre/b1.json) |
| Card receipts | 1,430 | `rf1.json`–`rf1430.json` | [rf1.json](https://cdn.lil.org/nft/mi_note_cards/json/pre/rf1.json) |
| Pack receipts | 627 | `rb1.json`–`rb627.json` | [rb1.json](https://cdn.lil.org/nft/mi_note_cards/json/pre/rb1.json) |

Display names remain `Card #N`, `Pack #N`, `Card #N Receipt`, and
`Pack #N Receipt`, respectively.

## Card identity and preorder mapping

The source is [`mi_note_cards.json`](../../mi_note_cards.json). Each card's
`clean_card_id` is preserved as its numeric metadata `id`, filename suffix, and
image suffix. Artwork names are copied exactly into the `name` attribute.
The `mi note` attribute uses the lowercase source collection name, or `special`
for the eight standalone cards 1401–1408.

| Source | Card IDs | Count |
| --- | --- | ---: |
| Mi Note | 1–166 | 166 |
| Mi Note 2 | 167–1283 | 1,117 |
| Mi Note 3 | 1284–1400 and 1409–1430 | 139 |
| Specials | 1401–1408 | 8 |

For a later preorder NFT update, preserve the same numeric `N`:

- Existing preorder: `https://cdn.lil.org/nft/mi_note_cards/preorder/json/N.json`
- Public-drop card: `https://cdn.lil.org/nft/mi_note_cards/json/pre/fN.json`
- Card receipt: `https://cdn.lil.org/nft/mi_note_cards/json/pre/rfN.json`

The 1,422 preorder-eligible IDs retain their identities; specials have no
preorder mapping. Ethereum token IDs and catalog array positions must not be
used to renumber cards. Publishing the JSONs does not itself update preorder
NFTs or activate the public drop.

## Images and pack variants

All image paths below are relative to `https://cdn.lil.org/nft/mi_note_cards/`.

| Group | Image path | MIME type |
| --- | --- | --- |
| Cards | `clean/N.png` | `image/png` |
| Packs | `packs/V.webp` | `image/webp` |
| Card receipts | `receipts/cards/N.webp` | `image/webp` |
| Pack receipts | `receipts/packs/V.webp` | `image/webp` |

For each pack ID `N` from 1 through 627, `V = ((N - 1) % 9) + 1`. The pack and
its receipt share the same variant. Packs 1, 9, 10, and 627 use variants 1, 9, 1,
and 6 respectively. Variants 1–6 are used 70 times each; variants 7–9 are used
69 times each. All packs have type `2 card pack`.

Receipt images are pending publication. Their final URLs are already included
in both `image` and `properties.files[0].uri` of the hosted receipt metadata.
Receipt image availability is separate from metadata JSON availability.

All items use `https://mons.shop` as their external URL. Cards and packs have
`redeemed: false`; receipts have `redeemed: true` and description
`redeemed on mons dot shop`. Card receipts preserve their cards' artwork name
and collection traits in the same order. JSON files use UTF-8, two-space
indentation, and a trailing newline.

On October 9, 2026, all 4,114 hosted JSONs at the `/json/pre/` base above matched
the exact expected content and UTF-8 formatting reconstructed from the source
catalog and approved metadata schema. There were no missing files or mismatches.
The metadata review also validated filename ranges, image paths, and pack variant
counts. All 1,422 hosted preorders matched the source IDs, artwork names, and
collection traits. All 1,439 unique card and pack images were available with their
expected MIME types. Receipt image availability was not required.

## Release boundary

All 1,430 card records are included independently of the 1,254-card capacity of
627 two-card packs. Pack contents and preorder allocation are not assigned here.
Collection metadata, public-drop configuration, deployments, and NFT updates
remain separate rollout work.
