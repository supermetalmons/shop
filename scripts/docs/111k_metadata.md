# 111K offchain metadata

New 111K deployments return `https://cdn.mons.shop/111k-sepolia/{tokenId}.json` on Sepolia and `https://cdn.mons.shop/111k/{tokenId}.json` on Ethereum mainnet. Each decimal filename is the ERC-721 token ID. The current shop integration remains Sepolia/Anvil only; publishing the mainnet files does not enable mainnet sales.

## Identities

| Kind | Token IDs | Item number |
| --- | --- | --- |
| Digital artwork | 1–111111 | Token ID |
| Crate | 111112–116666 | 1–5555 |
| Warehouse | 116667–117171 | 1–505 |
| Digital artwork receipt | 1000001–1111111 | Token ID minus 1000000 |
| Physical-only artwork receipt | 1111112–1222222 | Token ID minus 1000000 |
| Crate receipt | 2000001–2005555 | Token ID minus 2000000 |

Digital opening keeps sequential ERC721A batch minting. Artwork `T` and receipt `1000000 + T` render the same flower. Physical-only artwork numbers start at 111112: crate `n` uses `111111 + 20 × (n − 1) + 1` onward. The final crate has 31 items and ends at artwork number 222222. The physical and digital receipt ranges cannot collide. A crate can only be digitally opened or physically redeemed, so at most 111111 artwork identities are issued across both paths.

`NFT111KUrlRenderer` maps each kind/item number to its exact token filename. The collection still checks existence in `tokenURI`; previews can address possible tokens before they are minted. The URL renderer must only be used with the new numbering contract. Historical contracts retain their original renderers and numbering.

## Generate and publish

The deterministic TypeScript generator preserves the original digital flowers and receipt frames. Physical-only flowers extend the center geometry into a second disjoint range. Images stay embedded as base64 SVGs in the JSON, so replacing a JSON also replaces its image without a separate image-cache dependency.

```sh
npm run ethereum:metadata -- generate --network all
npm run ethereum:metadata -- validate --network all
```

Each network directory under `.cache/111k-metadata/` contains 344948 JSONs, an ordered object manifest with hashes, a source manifest, and a validation report. Full generated metadata remains outside Git. Release records retain the compact manifests and validation evidence.

For uploads, set `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the process environment. The account's endpoint is `https://e25f90fc073ea309b54b8b5144bf28e0.r2.cloudflarestorage.com` and the bucket is `cdn-mons-shop`, created with the Eastern North America (`enam`) location hint. Keep credentials out of repository files, command arguments, and logs.

```sh
npm run ethereum:metadata -- upload --network sepolia --concurrency 128
npm run ethereum:metadata -- upload --network mainnet --concurrency 128
```

The uploader requires successful validation, checks local SHA-256 and remote Content-MD5/ETag, and uses conditional object creation. Identical existing objects reconcile safely; different existing content stops the upload. A manifest/destination-scoped journal records completed uploads. Reuse the journal after an interruption. Remove its lock only after confirming its owning process has exited. This initial-publication command intentionally does not overwrite later edited metadata.

Cloudflare documents deriving S3 credentials from an existing API token: its token ID is the access key ID, and the SHA-256 hash of its value is the secret access key. Bucket administration and object permissions differ, so a token may upload objects while being unable to list bucket configurations. See [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

## Serving and freshness

The private R2 bucket is bound to `mons-shop-cdn`. The Worker serves only valid collection JSON paths through `cdn.mons.shop`, allows GET/HEAD/OPTIONS with public CORS, and enforces `Cache-Control: no-store`, `CDN-Cache-Control: no-store`, and `Cloudflare-CDN-Cache-Control: no-store` on every response. It does not use the Cache API or retain object contents between requests. R2's public development URL stays disabled.

Uploads also set object cache metadata to `no-store`. The Worker overrides object headers, so a future manual replacement cannot accidentally enable caching. Missing objects and errors are not cached. Conditional client headers do not bypass the fresh R2 read.

The API resolves the contract's exact expected URL through its `ETHEREUM_METADATA_CDN` service binding. Metadata bodies are bounded to 128 KiB, with eight concurrent reads and cancellation. Ownership reads remain pinned to a canonical block snapshot. Fulfillment previews deduplicate only pending reads and fetch again on subsequent requests.

Freshness applies when a client requests metadata. An already rendered page or a marketplace's indexed copy does not refresh merely because the R2 object changes. Future updates should use the existing ERC-4906 refresh mechanism and any marketplace refresh tools as needed. This release implements no reveal workflow, update scheduler, or marketplace refresh automation. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) and [ERC-4906](https://eips.ethereum.org/EIPS/eip-4906).

## Local development and checks

Local deployment manifest version 7 records `metadataBaseURI`. `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` can use an HTTP loopback origin with the `/111k-sepolia/` or `/111k/` prefix. The local API verifies that value against the renderer and binds an isolated metadata fixture Worker using the same generator; it does not read the public CDN or remote R2.

```sh
npm run check:cdn
node --import tsx --test tests/ethereumMetadataGenerator.test.ts
npm run test:ethereum
npm run test:ethereum:e2e
```

The CDN uses the repository's pinned Wrangler-compatible date. Generate its binding types with `npm run types:cdn`. Its tests exercise real local R2 replacement, deletion, HEAD/CORS, exact range boundaries, missing objects, and oversized objects.

`npm run prepare:cdn` produces and validates the pinned Wrangler multipart payload without remote calls. `npm run deploy:cdn` runs the CDN checks and uploads that payload through the Cloudflare Workers API, verifies domain ownership, and disables workers.dev and preview URLs. This supports the existing token's Worker deployment permissions without requiring bucket-administration permission for Wrangler's bucket lookup. Deployment reports are stored under `.cache/111k-offchain/`; inspect an uncertain report before retrying.

Publish and verify all metadata before deploying a collection that references it. Use the existing [Sepolia maintenance and replacement procedure](111k_testnet.md#ethereum-maintenance-and-replacement) for the application cutover. Record the metadata manifest hashes, Worker version, contract source/creation evidence, HTTP freshness verification, and live acceptance results in the release directory.
