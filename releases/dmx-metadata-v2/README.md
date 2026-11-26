# DMX metadata cleanup

Completed 26 November 2026 (Asia/Yerevan). Updated all 777 card and 777 NFC receipt JSONs under `https://cdn.mons.shop/dmx/`, shared by Ethereum mainnet and Sepolia.

Cards are named `Card #<cardId>`; receipts are named `Receipt #<cardId>`. Descriptions are empty. The sole attribute is `type`, with value `card` or `receipt`. The former `Kind` and `Card ID` traits are removed. All image URLs and collection metadata are unchanged.

The update replaced exactly 1,554 objects with ETag-conditional writes against the [original publication manifest](../dmx-offchain-v1/metadata-manifest.json). All 1,555 objects, including unchanged `collection.json`, passed complete storage and public CDN byte/hash verification, JSON UTF-8, `no-store`, wildcard CORS and redirect checks. The 18 metadata tests and tools TypeScript check passed.

[Current publication manifest](metadata-manifest.json) · [Update and verification record](update.json) · [Metadata operations](../../scripts/docs/tarot_cards.md#metadata-and-deployment)

Use this manifest as the baseline for the next metadata update. Original deployment, activation and publication evidence retains its original hashes.
