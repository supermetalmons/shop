# 111k_devnet reveal asset catalog

[manifest.json](manifest.json) preserves the asset counts, CDN path templates, and
exact aspect ratios for the `/111k_devnet` asset catalog. The unpack reveal service
uses this catalog as `111k-v3`; see the [reveal guide](../../../docs/111k_reveal.md).
The 1,000 3D assets replace painting IDs 84,557–85,556, and the 102 animated assets
replace painting IDs 84,455–84,556, preserving 111,111 artworks.
Each new deployment initializes a fresh allocation pool. Previous catalog versions
are retired without changing their saved assignments or published metadata.

## Assets

The CDN base URL is `https://wip.lil.org/111k/`. IDs are category-local integers
from 1 through the category's `count`, inclusive, with no gaps or leading zeros.

| Category | Count | Relative path template | Aspect ratio |
| --- | ---: | --- | --- |
| Eggs | 22,222 | `eggs/{id}.webp` | 1:1 |
| Paintings | 84,454 | `paintings/{id}.webp` | Per ID, using the ratio palette |
| Videos | 3,333 | `videos/{id}.mp4` | 16:9 |
| 3D | 1,000 | `3d/{id}.glb` | 1:1 preview |
| Animated | 102 | `animated/{id}.mp4` | Per ID, currently 466:503 |
| Receipts | 85,556 | `receipts/{id}.webp` | 1:1 |

Video posters use `videos/{id}.webp` with the same category-local ID and 16:9 ratio.
3D previews use `3d/{id}.webp` with the same category-local ID and 1:1 ratio.
Animated posters use `animated/{id}.webp` with the same category-local ID and
per-asset ratio as the MP4. The first 102 assets are all 932 × 1006, stored as the
reduced ratio 466:503.

`artworkCount` is 111,111: eggs, paintings, videos, 3D, and animated assets combined. Receipts are
additional assets and are excluded from this total. This catalog defines no
assignment between category-local asset IDs and on-chain token IDs.

## Format version 1

- `version` identifies this storage format; `dropId` identifies its intended drop.
- `baseUrl` includes its trailing slash. A future asset URL can be formed by
  appending the category's `pathTemplate` with `{id}` replaced by its decimal ID.
- `categories` contains each category's `count`, `pathTemplate`, and ratio data.
- `imagePathTemplate`, when present, identifies the static preview for a category's
  media. For 3D assets, `aspectRatio` describes this preview, not the model's geometry.
- Every ratio is a reduced integer pair `[width, height]`. Original pixel
  resolutions are not retained; aspect ratios are preserved without rounding.
- Eggs, videos, and 3D previews use `aspectRatio` for every valid ID.
- Paintings and animated artworks use `aspectRatioPalette`, sorted by numerator
  then denominator, and `aspectRatioIndexById`, which contains exactly `count`
  zero-based palette indexes in ascending asset ID order. The ratio for ID `id` is
  `aspectRatioPalette[aspectRatioIndexById[id - 1]]`. The index array is wrapped
  at 100 entries per line for readability; line breaks have no meaning.
- Paintings have 84,454 indexes. Animated artworks have 102 indexes, initially
  all zero against the palette `[[466, 503]]`. Future animated assets can use
  additional palette entries without changing the metadata or API shape.

For example, painting 1 uses palette index 1, giving `[240, 259]`, and its path is
`paintings/1.webp`. Egg 22,222 uses `[1, 1]` and `eggs/22222.webp`.

## 3D metadata template

[3d.template.json](3d.template.json) documents the metadata shape for a revealed 3D NFT.
Replace `{{tokenId}}` with the on-chain token ID and `{{assetId}}` with the assigned
3D asset ID from 1 through 1,000. These IDs do not have to match.

OpenSea's [media and traits specification](https://docs.opensea.io/docs/media-and-traits)
uses `image` for the static WEBP preview and `animation_url` for the GLB model.
The `type` attribute identifies the new category. `aspectRatio`, `category`, and
`revealStatus` follow the shop's revealed-metadata shape; they are not required
OpenSea display fields. The name and empty description match the existing artwork
template. This reference file is not a baseline-generation input: the reveal
runtime combines the registered artwork template with the assigned model's media
and emits this shape after confirmation.

## Animated metadata template

[animated.template.json](animated.template.json) documents the metadata shape for
a revealed animated NFT. Replace `{{tokenId}}` with its onchain token ID and
`{{assetId}}` with the assigned animated ID from 1 through 102. Use the asset's
catalog ratio; the template shows the current uniform 466:503 ratio.

Animated metadata uses `image` for the WEBP poster, `animation_url` for the MP4,
and `animated` for both the category and type trait. Names and empty descriptions
match the registered artwork template. Like the 3D reference, this file is not a
baseline-generation input. The 102 asset-specific reference JSONs retain a
`{{tokenId}}` placeholder and do not establish token assignments. The full
deployment baseline remains unrevealed until confirmed unpacking publishes the
assigned metadata. Previously frozen ratios remain unchanged when future assets
are added to a new catalog.

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

On November 3, 2026, the user supplied 1,000 3D assets at
`https://wip.lil.org/111k/3d/{id}.glb` and matching square WEBP previews, with
category-local IDs 1–1,000, and requested replacing 1,000 paintings to retain
111,111 artworks. That v2 catalog retained painting IDs 1–84,556 with their original
aspect ratios and excluded IDs 84,557–85,556. The 3D assets are not
part of the original source manifest or its checksum.

Later on November 3, 2026, the user supplied 102 animated MP4s and matching WEBP
posters at `https://wip.lil.org/111k/animated/{id}` with category-local IDs 1–102
and 932 × 1006 dimensions. V3 replaces painting IDs 84,455–84,556 with these
assets; painting IDs 1–84,454 retain their original ratios. These animated assets
are not part of the original source manifest or its checksum. Receipt counts
remain unchanged.

The archive is self-contained and does not require the original Desktop file.
