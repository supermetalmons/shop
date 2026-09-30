# Mi Note cards 1409–1413

Five new Mi Note 3 tokens are assigned card IDs 1409–1413. All original images,
thumbnails, and preorder images returned HTTP 200 with the expected image format.
All five preorder metadata JSONs are published and verified on the CDN. They
returned HTTP 200 with `Content-Type: application/json; charset=utf-8` and match
the retained copies in `json/` byte-for-byte.

| Card ID | Mi Note 3 token ID | Name | Metadata |
| --- | --- | --- | --- |
| 1409 | 130 | The Reaper in a Mimikyu Cloak | [1409.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1409.json) |
| 1410 | 131 | The Reaper in a Gengar Cloak | [1410.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1410.json) |
| 1411 | 132 | Blue Angel Rei | [1411.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1411.json) |
| 1412 | 133 | Blue Aura Dratini | [1412.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1412.json) |
| 1413 | 134 | Drifella of Death 888 | [1413.json](https://cdn.lil.org/nft/mi_note_cards/preorder/json/1413.json) |

The source export's token 131 name had a missing initial `T`; it is corrected
here. Leading and trailing name whitespace is trimmed, matching the catalog.
Existing token mappings and special cards 1401–1408 are preserved.

The JSONs are hosted at
`https://cdn.lil.org/nft/mi_note_cards/preorder/json/<card-id>.json` with
`Content-Type: application/json`. The files match the hosted metadata format for
card 1400, including the `Preorder #<card-id>` display name, card name trait,
and `mi note 3` collection trait.

Verified preorder images:

- [1409.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1409.webp)
- [1410.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1410.webp)
- [1411.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1411.webp)
- [1412.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1412.webp)
- [1413.webp](https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1413.webp)

Original images use `https://cdn.lil.org/player/mi_note_3/<token-id>.jpg` and
thumbnails use `https://cdn.lil.org/player/mi_note_3/mid/<token-id>.webp`, for
token IDs 130–134.

Release order:

1. Verify the five published metadata JSONs and their referenced images.
2. Run `npm run deploy:api`, which applies commerce migrations through
   `0028_preorder_card_range_1413.sql`, verifies readiness, and publishes the API.
3. Run `npm run deploy` to publish the frontend.

The new migration preserves existing claims, indexes, guards, and automatic
expiry release. Preorder IDs are 1–1400 and 1409–1413; reserved specials 1401–1408
remain ineligible. No new onchain collection is required.
