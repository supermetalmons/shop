# 111K minimal metadata

Published and verified on October 28, 2026 (Europe/Istanbul). All 689,896 JSON objects were replaced at their existing URLs: 344,948 each under `111k-sepolia/` and `111k/`. Both networks now contain identical JSON bodies for each token ID.

Metadata uses minimal names, empty descriptions, the five supplied `wip.lil.org` image URLs, and one lowercase `type` attribute. Artwork names are decimal token IDs. Other names use their existing item numbers: `Warehouse #N`, `Crate #N`, `Crate Receipt #N`, and `Receipt #N`. Artwork has type `painting`; artwork receipts have type `receipt`. Physical-only receipts retain their existing numbering through `Receipt #222222`.

## Editing and publishing

The five editable JSON files are in [the templates directory](../../scripts/ethereum-metadata/templates). The [metadata guide](../../scripts/docs/111k_metadata.md) documents generation, validation, resumable publishing, complete verification, and restoration with `npm run ethereum:metadata`.

Use a new generated revision directory for each template change. Templates and source checksums are captured in its manifest. Existing generated revisions can be passed as `--prior-cache-root` to reuse verified local originals when taking the next rollback snapshot.

The API, storefront, checkout, and fulfillment readers now accept absolute HTTPS image URLs without embedded credentials. Legacy SVG metadata remains supported. Compatibility was deployed before CDN replacements; no contracts, base URIs, or databases changed.

## Verification

- Both complete R2 inventories match every expected filename, byte size, and MD5 checksum. Each network contains 71,168,605 metadata bytes.
- Public token-boundary samples match the generated JSON. HEAD, repeated GET, and preflight checks retain JSON content types, public CORS, and `Cache-Control: no-store`.
- All 60 tokens in the inspected production inventories use the new metadata and pass the actual frontend parser. The live-CDN Anvil test passed all 37 scenarios and all five metadata types.
- All five supplied images rendered in a browser and in a real 2000 × 2800 fulfillment PNG export using the synthetic code `PREVIEW-ONLY`.
- API checks passed 2,633 unit and 39 native runtime tests. Frontend checks passed 4,778 application and 34 supporting tests. The metadata tooling passed 43 tests. Typechecks, generated-file checks, bundle validation, startup profiling, and existing dead-code gates passed.

## Rollback

The original metadata is retained locally under `~/.mons-shop-backups/111k-metadata/2026-10-27-minimal`. Both complete archives passed gzip integrity, archive SHA-256, per-object MD5/SHA-256, identity coverage, and byte-total verification.

```sh
npm run ethereum:metadata -- restore \
  --directory "$HOME/.mons-shop-backups/111k-metadata/2026-10-27-minimal" \
  --network all
```

Configure the R2 credentials described in the metadata guide before publishing or restoring. The generated current revision remains in `.cache/111k-metadata/2026-10-27-minimal-final` for subsequent cache reuse.

## Evidence

- [Manifest](manifest.json) and [generation validation](generation-validation.json)
- [Publication](publication.json), [Sepolia audit](verification-sepolia.json), and [mainnet audit](verification-mainnet.json)
- [Application release](application-release.json) and [public HTTP checks](http-headers-verification.json)
- [Sample acceptance](sample-smoke.json), [production acceptance](public-smoke.json), and [end-to-end verification](e2e-verification.json)
- [Browser/export verification](browser-verification.json) and [rollback verification](rollback-verification.json)
