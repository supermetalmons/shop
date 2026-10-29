# 111k_devnet reveal asset catalog

[manifest.json](manifest.json) preserves the asset counts, CDN path templates, and
exact aspect ratios for upcoming `/111k_devnet` reveals. It is a dormant data
archive with no application, metadata generation, or publication integration.

## Assets

The CDN base URL is `https://wip.lil.org/111k/`. IDs are category-local integers
from 1 through the category's `count`, inclusive, with no gaps or leading zeros.

| Category | Count | Relative path template | Aspect ratio |
| --- | ---: | --- | --- |
| Eggs | 22,222 | `eggs/{id}.webp` | 1:1 |
| Paintings | 85,556 | `paintings/{id}.webp` | Per ID, using the ratio palette |
| Videos | 3,333 | `videos/{id}.mp4` | 16:9 |
| Receipts | 85,556 | `receipts/{id}.webp` | 1:1 |

`artworkCount` is 111,111: eggs, paintings, and videos combined. Receipts are
additional assets and are excluded from this total. This catalog defines no
assignment between category-local asset IDs and on-chain token IDs.

## Format version 1

- `version` identifies this storage format; `dropId` identifies its intended drop.
- `baseUrl` includes its trailing slash. A future asset URL can be formed by
  appending the category's `pathTemplate` with `{id}` replaced by its decimal ID.
- `categories` contains each category's `count`, `pathTemplate`, and ratio data.
- Every ratio is a reduced integer pair `[width, height]`. Original pixel
  resolutions are not retained; aspect ratios are preserved without rounding.
- Uniform categories use `aspectRatio` for every valid ID.
- Paintings use `aspectRatioPalette`, sorted by numerator then denominator, and
  `aspectRatioIndexById`, which contains exactly 85,556 zero-based palette indexes
  in ascending asset ID order. The ratio for painting ID `id` is
  `aspectRatioPalette[aspectRatioIndexById[id - 1]]`. The index array is wrapped
  at 100 entries per line for readability; line breaks have no meaning.

For example, painting 1 uses palette index 1, giving `[240, 259]`, and its path is
`paintings/1.webp`. Egg 22,222 uses `[1, 1]` and `eggs/22222.webp`.

## Provenance

The original `manifest.json` contained 111,111 entries with `w` and `h` pixel
dimensions for eggs, paintings, and videos. Its SHA-256, also recorded in
`source.sha256`, is:

```text
b5bcc136b5a3284180bd7d7397b5ea0b52109598306805c2dbe181ce47fc026a
```

The source contained no receipt entries. On October 29, 2026, the user confirmed
that receipts have IDs 1–85,556 and all have a 1:1 aspect ratio. The CDN base and
path templates were supplied by the user. These receipt values are not derived
from the source manifest or a full CDN audit.

The archive is self-contained and does not require the original Desktop file.
