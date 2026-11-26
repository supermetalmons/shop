# DMX collection metadata update

Completed 26 November 2026 (Asia/Yerevan). Updated [collection.json](https://cdn.mons.shop/dmx/collection.json), shared by Ethereum mainnet and Sepolia.

The collection image is now `https://cdn.lil.org/nft/dmx/receipts/7.png`. Both `description` and `external_link` are empty strings. The name `divination machina x` and symbol `DMX` are preserved.

The update replaced exactly one object with an ETag-conditional write against the [preceding publication manifest](../dmx-metadata-v2/metadata-manifest.json). All 777 card and 777 receipt JSONs are unchanged. All 1,555 objects passed complete storage and public CDN byte/hash verification, JSON UTF-8, `no-store`, wildcard CORS and redirect checks. The image returned HTTP 200 with PNG content type. The 18 metadata tests and tools TypeScript check passed.

Offchain deployment and activation tools now pin the image from the selected verified publication and accept its empty external link. Historical inline validation and exact publication hash checks remain in place. All 76 deployment and activation tests passed, followed by two targeted checks after the final frozen-image validation adjustment.

[Current publication manifest](metadata-manifest.json) · [Update and verification record](update.json) · [Metadata operations](../../scripts/docs/tarot_cards.md#metadata-and-deployment)

Use this manifest as the baseline for the next metadata update. Historical deployment, activation and publication evidence retains its original hashes.
