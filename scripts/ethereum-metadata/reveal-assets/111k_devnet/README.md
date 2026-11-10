# 111k reveal asset catalog

[manifest.json](manifest.json) is the generated `111k-v7` reveal catalog for fresh
testnet and future mainnet deployments. [source.json](source.json) preserves the
supplied `111k.json` dimensions map. The catalog uses the media root
`https://cdn.lil.org/nft/111k/`; metadata JSONs still use the deployment's
`cdn.mons.shop` prefix. See the [reveal runbook](../../../docs/111k_reveal_ops.md)
for publication and registration.

## Current allocation

| Category | Allocated | Image | Animation/model | Ratio |
| --- | ---: | --- | --- | --- |
| Eggs | 60,504 | `eggs/{id}.png` | — | 1:1 |
| Paintings | 47,128 | `paintings/{id}.png` | — | Per ID |
| 3D | 3,000 | `3d/{id}.png` | `3d/{id}.glb` | 1:1 preview |
| Animated | 421 | `animated/{id}.png` | `animated/{id}.mp4` | Per ID, currently 466:503 |
| Videos | 58 | `videos/{id}.webp` | `videos/{id}.mp4` | Per ID |
| **Artwork total** | **111,111** | | | |

Category-local IDs are continuous integers beginning at 1. They are independent
of onchain token IDs. There are 76,700 available egg PNGs; the current allocation
uses IDs 1–60,504 and leaves IDs 60,505–76,700 unused. Every import recalculates
the egg allocation as `111111 - nonEggArtworkCount` and rejects an insufficient
egg inventory or more than 111,111 non-egg artworks.

Paintings 1–30,990 also have `paintings/alt/{id}.webp` variants. Paintings
30,991–47,128 have no alternative. Their paths
and exact ratios are preserved separately; they do not add artworks or replace
the PNG used by metadata. Video MP4/poster pairs also count as one artwork each.
The source map intentionally omits 3D GLBs and animated MP4s; those companions
follow the same category-local ID at the media paths above.

Videos are not uniformly 16:9: 53 have that ratio, four use 427:240, and one uses
54:31. Always render the stored per-asset ratio. Ratios describe media proportions,
not original pixel dimensions or model geometry.

The separately cataloged 85,556 receipts all use
`https://cdn.lil.org/nft/111k/placeholder.png` at 466:503. They are not part of the
artwork allocation or a per-category receipt metadata mapping. Unrevealed artwork
and every artwork, crate, and relic receipt metadata template use this same
placeholder. Crates use `crate.webp` at 4:3 and warehouses use `warehouse.webp` at
3:2 under the same CDN root. New relic publications use `relics/{id}.webp` for
IDs 1–18 under that root; existing publications retain their recorded image URLs.

## Import an updated dimensions map

The importer accepts a complete JSON object mapping relative media paths to
`[width, height]` integer pairs, in the same format as the preserved source.
Run it from the shop repository:

```sh
npm run ethereum:assets -- import --source /path/to/updated/111k.json --catalog-version 111k-v8
npm run check:ethereum-assets
```

The first imported revision is `111k-v4`. Use a higher explicit catalog version
whenever the source, allocation settings, or generated manifest changes. An
identical import at the same version is a no-op; changed content at the same
or an older version fails before any output is written. For additions to an existing
pool, use the [catalog expansion operation](../../../docs/111k_reveal_ops.md#adding-artworks-and-cutting-off-eggs)
instead of a standalone import. It freezes the old-to-new egg mapping, preserves
supported ancestor catalogs, and separates local promotion from live application.
Other incompatible catalog changes still require a fresh deployment.

`--source` defaults to the preserved source, and `--catalog-version` defaults
to the current revision. `--available-eggs` overrides the saved available egg
count when new egg inventory is supplied; it does not directly set the
allocated count. The source snapshot and settings are preserved with the
generated manifest. No command here uploads assets or changes a deployment.

If an import is interrupted, rerun the same command. Before validating the
catalog, the importer restores the previous files from its recovery journal
under `.cache/111k-assets/`, then retries. Keep that directory until recovery
finishes. Check mode reports pending recovery without changing files.

```sh
npm run ethereum:assets -- import --check
```

Check mode regenerates in memory and compares the source, manifest, compact
shared descriptor, and five reference JSONs without writing files. The API and
frontend check commands include this verification. Imports validate supported
paths, positive safe-integer dimensions, contiguous primary IDs, valid alternative IDs,
video/poster pairs, and supply before writing generated outputs.

## Manifest and metadata references

Storage format version 2 is distinct from the `111k-v7` catalog revision.
`source.sha256` hashes the exact source bytes. `importSettings` records the
available egg inventory and square egg ratio. The compact shared descriptor
pins the catalog version and SHA-256 of `JSON.stringify(manifest)`; browser
code imports that descriptor without importing the full dimensions catalog.

Each category records its count and primary `pathTemplate`. Receipts use a
fixed `placeholder.png` path shared by every receipt ID. Moving media also
records an `imagePathTemplate`. A category may override the global `baseUrl`. Ratios use either `aspectRatio: [width, height]` or
a reduced, sorted `aspectRatioPalette` with `aspectRatioIndexById`. Index
`id - 1` selects that asset's palette entry. Painting alternatives have their
own ratio data under `variants.alt`. Complete alternative coverage retains the
original representation. Partial coverage adds a sorted, unique `assetIds` list;
its ratio indexes correspond to positions in that list. IDs must reference primary
paintings. With no alternatives, `variants` is omitted. Existing v2 manifests and
their hashes remain unchanged.

The importer generates [egg](egg.template.json), [painting](painting.template.json),
[video](video.template.json), [3D](3d.template.json), and
[animated](animated.template.json) metadata references through the same media
resolver used by reveal. `{{tokenId}}` is the onchain ID and `{{assetId}}` is the
assigned category-local media ID. The references show asset 1's ratio; runtime
metadata uses the actual assigned asset's ratio. They are examples, not baseline
metadata or preassigned token identities. All 111,111 artwork baseline objects
still use the unrevealed artwork template until confirmed reveal.

Revealed eggs use `Egg #{{assetId}}` as their name, matching the assigned egg
image ID, and `a unrevealed gan egg. what will hatch from it?` as their description.
These values apply when egg metadata is first frozen; existing frozen metadata
is preserved. Other artwork categories retain the baseline name and description.

## Deployment verification

Before publishing a new release, verify public GET/HEAD responses, media content
types, and anonymous cross-origin access for first and last allocated assets in
each category, including PNG posters and GLB/MP4 companions. Check egg inventory
boundaries as well. The v4 preparation checked representative public media paths
and confirmed that eggs 1 and 76,700 are 1024 × 1024 PNGs. The v5 media update
uses a 1448 × 1086 crate WEBP, 1536 × 1024 warehouse WEBP, and 932 × 1006
placeholder PNG, preserving all existing artwork counts and source dimensions.
The v6 catalog added paintings 30,991–40,348 and reduced the egg allocation by
9,358. The v7 catalog adds paintings 40,349–47,128 and reduces the egg allocation
by another 6,780. The retained v5 and v6 catalogs remain available for existing
deployments until their explicit online catalog update activates.

Generate and validate the complete 344,984-object baseline revision, then follow
the reveal runbook for fresh-prefix publication, verification, contract
deployment, registration, provisioning, and activation. Historical release
records remain evidence for their original deployments; they are not destinations
for a new import.
