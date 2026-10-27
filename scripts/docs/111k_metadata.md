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

## Source of truth

The JSON objects on `cdn.mons.shop` are the authoritative collection metadata. Local development and the deployed shop read those same objects. The repository contains no collection artwork/JSON generator, initial-upload pipeline, local metadata server, or generated-file fallback.

The `cdn-mons-shop` bucket contains 344948 JSON objects per network and remains in Eastern North America (`enam`). The published JSONs currently embed base64 SVG images. Historical release manifests record the initial publication's hashes and validation evidence; they describe that release and are not runtime inputs or definitions of future metadata.

## Serving and freshness

The `cdn-mons-shop` R2 bucket serves files directly through its public custom domain `cdn.mons.shop`. Every object is publicly readable by its key; public access does not allow writes. There is no metadata-serving Worker. R2's separate public development URL stays disabled.

Stored JSON objects use `Cache-Control: no-store` and `Content-Type: application/json; charset=utf-8`. A Cloudflare cache rule bypasses caching for `http.host eq "cdn.mons.shop"`, and a response-header rule for that hostname sets `Cache-Control: no-store`, including on missing-object and error responses. Response-header rules alone do not control Cloudflare's edge cache, so retain the separate cache-bypass rule.

The bucket CORS policy allows all origins and request headers, allows `GET` and `HEAD`, and sets `MaxAgeSeconds` to `86400`. R2 handles `OPTIONS` preflights automatically. This duration caches browser permission checks, not metadata. The hostname's response-header rule matches the public access policy used by `lil-org-cdn`:

| Header | Value |
| --- | --- |
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Headers` | `*` |
| `Access-Control-Allow-Methods` | `GET, HEAD, OPTIONS` |
| `Access-Control-Expose-Headers` | `Accept-Ranges, Cache-Control, CF-Cache-Status, Content-Disposition, Content-Encoding, Content-Length, Content-Range, Content-Type, Date, ETag, Last-Modified` |
| `Cross-Origin-Resource-Policy` | `cross-origin` |
| `Timing-Allow-Origin` | `*` |

Use the same exposed-header list in the bucket CORS policy. This permits anonymous browser reads and embedding from third-party sites. See [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/) and [response-header rules](https://developers.cloudflare.com/rules/transform/response-header-modification/).

The API fetches the contract's exact expected public URL over HTTP with `cache: 'no-store'`, rejects redirects, and applies a ten-second timeout. Metadata bodies are bounded to 128 KiB, with eight concurrent reads and cancellation. Ownership reads remain pinned to a canonical block snapshot. Fulfillment previews deduplicate only pending reads and fetch again on subsequent requests.

Freshness applies when a client requests metadata. An already rendered page or a marketplace's indexed copy does not refresh merely because the R2 object changes. Future updates should use the existing ERC-4906 refresh mechanism and any marketplace refresh tools as needed. This release implements no reveal workflow, update scheduler, or marketplace refresh automation. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) and [ERC-4906](https://eips.ethereum.org/EIPS/eip-4906).

## Local development and checks

Local deployment manifest version 7 records `metadataBaseURI`, defaulting to `https://cdn.mons.shop/111k-sepolia/` to match the deployed Sepolia shop. `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` accepts only the existing HTTPS CDN prefixes `/111k-sepolia/` and `/111k/`. The local API verifies that value against the renderer and fetches the CDN directly. Existing loopback metadata manifests require a fresh local deployment; matching CDN manifests remain valid. Local development requires network access and reports unavailable metadata rather than falling back to local files or generated output.

```sh
npm run check:api
npm run test:ethereum
npm run test:ethereum:e2e
```

Unit and native-runtime tests remain offline using small, explicitly synthetic HTTP responses. They cover URL/token mapping, ordering, batching, response bounds, redirects, failures, timeouts, and cancellation without reproducing collection artwork. The Anvil end-to-end test requires CDN connectivity and reads current JSONs; it verifies URLs and API compatibility without pinning original names, artwork geometry, or hashes.

Bucket custom domains and CORS require bucket-administration access; object-upload permissions alone are insufficient. Manage the hostname's CORS response headers and cache bypass in the `mons.shop` zone. Verify GET, HEAD, and OPTIONS from arbitrary origins against both collection prefixes, confirm `no-store`, and check that repeated responses are not cache hits. Changes to files do not require an application deployment.

Publish and verify all metadata before deploying a collection that references it. Use the existing [Sepolia maintenance and replacement procedure](111k_testnet.md#ethereum-maintenance-and-replacement) when replacing a collection. A metadata-hosting migration that preserves URLs and contents requires no contract deployment or database reset. Record the metadata manifest hashes, bucket/domain/CORS/cache configuration, application version, and HTTP and shop verification in the release directory. Preserve earlier Worker deployment records as historical evidence.
