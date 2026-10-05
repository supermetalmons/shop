# Mi Note cards 1420–1430

Eleven Mi Note 3 tokens are assigned preorder card IDs 1420–1430.
All 11 published metadata JSONs match the prepared metadata byte-for-byte.
The 11 original JPEGs, 11 thumbnails, and 11 preorder WebPs returned HTTP 200
with the expected MIME types and file signatures on October 5, 2026.

| Card ID | Mi Note 3 token ID | Name |
| --- | --- | --- |
| 1420 | 142 | Drifella Employee 666 |
| 1421 | 143 | Stuck in the Buffer |
| 1422 | 144 | The Fallen Cat-Angel |
| 1423 | 145 | The Gentle Harvest of the Poliwhirl Reaper |
| 1424 | 146 | Dratini Niqab☆The Scream |
| 1425 | 147 | Pika Niqab☆The Scream |
| 1426 | 148 | Smiling Earth Silent Girl |
| 1427 | 149 | Mi Note Silent Magician I |
| 1428 | 150 | Mi Note Silent Magician II |
| 1429 | 151 | The Reaper in a Umbreon Cloak |
| 1430 | 152 | The Reaper in a Meowth Cloak |

Metadata uses `https://cdn.lil.org/nft/mi_note_cards/preorder/json/<card-id>.json`.
Both image fields use `https://cdn.lil.org/nft/mi_note_cards/preorder/v1/<card-id>.webp`.
Originals use `https://cdn.lil.org/player/mi_note_3/<token-id>.jpg`, and thumbnails
use `https://cdn.lil.org/player/mi_note_3/mid/<token-id>.webp`.

Token 148's surrounding name whitespace is trimmed; all other spelling and
capitalization are preserved. Existing catalog entries and reserved specials
1401–1408 remain unchanged.

Generated migration `0035_preorder_catalog.sql` inserts only the 11 new eligible
IDs. The complete preorder catalog contains 1422 cards: 1–1400 and 1409–1430.
Historical migrations and schema checkpoints are unchanged. Release the database
migration and API before the frontend. No new onchain collection is required.

Released to production on October 5, 2026:

- Migration `0035_preorder_catalog.sql` applied successfully.
- API version: `086c6bad-8ebd-4b70-b3d9-20cafec3fe0c`.
- Frontend version: `f21fd390-4388-4e3e-ae58-de97fe69cd94`.

Frontend checks, API type checks, all 2154 API unit tests, all 30 runtime tests,
the API deployment dry run, startup validation, and production database checks
passed. One existing API timing test exceeded its short deadline during parallel
checks; it passed alone and in the complete API suite with concurrency limited
to four test files.

After deployment, all 11 new IDs were present and unclaimed in the mainnet
preorder catalog. The storefront HTML, entry script, and gallery bundle matched
the validated local build byte-for-byte, including all 11 new artwork names.
Both direct API and storefront-proxied health endpoints returned `{"ok":true}`.
