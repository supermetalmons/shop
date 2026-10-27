# 111K offchain metadata

The [minimal metadata release](../../releases/111k-minimal-metadata/README.md) records the current templates, publication, application compatibility, verification, and rollback evidence.

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

Digital opening keeps sequential ERC721A batch minting. Artwork `T` and receipt `1000000 + T` refer to the same artwork number. Physical-only artwork numbers start at 111112: crate `n` uses `111111 + 20 × (n − 1) + 1` onward. The final crate has 31 items and ends at artwork number 222222. The physical and digital receipt ranges cannot collide. A crate can only be digitally opened or physically redeemed, so at most 111111 artwork identities are issued across both paths.

`NFT111K` builds each CDN URL directly. `tokenURI` checks existence and uses the token ID as the filename; previews validate and map each kind/item number to its exact token filename before minting. There is no separate renderer in new deployments. Historical contracts retain their original renderers and numbering.

The owner can call `setBaseURI(string)` to update the prefix. Both construction and updates require the existing valid URL format. Every successful update emits `BaseURIUpdated` and ERC-4906 `BatchMetadataUpdate`; setting the same URL refreshes metadata after CDN edits. Coordinate a changed prefix with `ETHEREUM_111K_METADATA_BASE_URI` and the application’s allowed URL policy before reopening metadata-dependent flows.

## Source of truth

The JSON objects on `cdn.mons.shop` are the authoritative runtime metadata. Local development and the deployed shop read those same objects. The editable JSON files in [`scripts/ethereum-metadata/templates`](../ethereum-metadata/templates/) define the next generated publication. They are authoring inputs, not a runtime fallback or local metadata server.

The `cdn-mons-shop` bucket contains 344948 JSON objects per network, 689896 total, and remains in Eastern North America (`enam`). Both networks now use the same JSON contents; the network determines only the destination prefix. Historical release manifests describe their own publications and remain unchanged.

## Templates

Each template contains `name`, `description`, `image`, and `attributes`. The initial minimal format uses an empty description and one lowercase `type` trait:

| Template | Name | Image filename | Type value |
| --- | --- | --- | --- |
| `artwork.json` | `{{tokenId}}` | `artwork_placeholder.png` | `painting` |
| `warehouse.json` | `Warehouse #{{displayId}}` | `warehouse.webp` | `warehouse` |
| `crate.json` | `Crate #{{displayId}}` | `crate.jpg` | `crate` |
| `crate_receipt.json` | `Crate Receipt #{{displayId}}` | `crate_receipt.webp` | `crate receipt` |
| `artwork_receipt.json` | `Receipt #{{displayId}}` | `artwork_placeholder_receipt.webp` | `receipt` |

The image filenames above are rooted at `https://wip.lil.org/111k/`. Names are JSON strings, including artwork names such as `"1"`. The only substitutions are `{{tokenId}}` and `{{displayId}}`; unresolved placeholders and invalid expanded image URLs fail validation. Numbering comes from the existing protocol helpers, including the physical-only artwork receipt range.

The API, storefront, checkout, and fulfillment readers accept absolute HTTPS image URLs from any host, without embedded credentials. Existing SVG data images remain supported. A future image-host change requires updating the templates and publishing again; it does not require changing a host allowlist. Images used in fulfillment PNG exports must permit anonymous cross-origin reads. Check image responses and a real export before publishing a new host or media format.

## Generate and publish

Use the committed CLI through `npm run ethereum:metadata -- <command>`. `generate` and `validate` operate on one canonical collection without a network option. `upload`, `verify`, and `restore` require an explicit `--network sepolia|mainnet|all`. The default directory is `.cache/111k-metadata/current`; choose a new named revision directory for each publication. Generation refuses to overwrite a completed revision, preserving its manifest, journals, and rollback snapshot.

Generation and publishing share an owner-tracked lock that recovers interrupted processes on the same host. Legacy plain-file locks fail with recovery instructions; remove those only after confirming no operation is running.

After editing the five templates:

```sh
metadata_dir=.cache/111k-metadata/minimal-v1
npm run ethereum:metadata -- generate --directory "$metadata_dir"
npm run ethereum:metadata -- validate --directory "$metadata_dir"
```

Generation writes deterministic, formatted JSON with a trailing newline, a template snapshot, `objects.jsonl`, and `manifest.json`. The manifest records template hashes, object counts, total bytes, and object-list checksums. Validation checks all 344948 identities, safe numeric filenames, generated contents, sizes, and checksums. Each JSON must fit the readers' 128 KiB limit. Generated files, snapshots, and journals stay in ignored local storage; do not commit hundreds of thousands of JSON files.

Authenticate with `R2_ENDPOINT` or `CLOUDFLARE_ACCOUNT_ID`, and either `R2_ACCESS_KEY_ID` plus `R2_SECRET_ACCESS_KEY`, or `R2_ACCESS_KEY_ID`/`CLOUDFLARE_API_TOKEN_ID` plus `CLOUDFLARE_API_TOKEN`. The latter derives the S3 secret in memory using Cloudflare's documented SHA-256 conversion. Optional `R2_SESSION_TOKEN` supports temporary S3 credentials. The destination bucket is restricted to `cdn-mons-shop`; other `R2_BUCKET` values are rejected. Supply secrets through the environment, never command arguments, tracked files, or reports. See [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

Upload a representative Sepolia sample before the full publication:

```sh
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network sepolia --token-ids 1,111112,116667,1000001,1111112,2000001
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network sepolia --token-ids 1,111112,116667,1000001,1111112,2000001
```

Before the first replacement in each network, upload preserves a verified rollback snapshot of the entire existing collection. By default snapshots live under `<directory>/snapshots`; `--snapshot-directory PATH` selects a durable alternative. Each network has a compressed `objects.jsonl.gz` archive containing original bodies and checksums, plus its own manifest. `--prior-cache-root PATH` accepts either a previous canonical dataset or a legacy root with network directories. For each object, it checks `<root>/<network>/<tokenId>.json` first, then `<root>/<tokenId>.json`; only regular files with the exact remote size and MD5 checksum are reused. The default legacy root is `.cache/111k-metadata`. Missing or mismatching cached objects are downloaded from R2. A sample upload still requires the full snapshot and may take several minutes.

Version 2 snapshots record the publishing manifest's SHA-256. Reuse a snapshot directory only when resuming that publication; a different revision requires a fresh directory. Existing version 1 archives remain usable for restoration, but cannot be reused for a new upload.

After checking the sample through the live shop:

```sh
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network sepolia
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network sepolia
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network mainnet
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network mainnet
```

Use `--network all` to run either command for both networks. Remote work defaults to 32 concurrent requests; `--concurrency N` permits 1–256. The uploader replaces only manifest-listed collection objects, preserves JSON content type and `no-store`, and skips objects already matching the desired contents. It uses retries and journals tied to the manifest and destination; rerunning the same command resumes interrupted work. Use the same revision directory and snapshot directory when resuming. Never reuse a journal for a different manifest.

Journal headers are committed atomically. Resume truncates an incomplete final record without rewriting the validated header. Existing malformed or mismatched headers remain rejected for inspection.

Full verification checks the remote listing against every expected key, byte size, and checksum, then reads public samples through `cdn.mons.shop`. Sample verification does not mark a full publication complete. Store concise manifests and upload/verification reports in a new release directory, alongside the compatibility deployment IDs and browser/export evidence. Keep full generated artifacts and rollback snapshots locally until they are no longer needed.

For the next template revision, reuse the previous canonical dataset when building both networks' rollback snapshots:

```sh
previous_metadata_dir=.cache/111k-metadata/minimal-v1
metadata_dir=.cache/111k-metadata/minimal-v2
npm run ethereum:metadata -- generate --directory "$metadata_dir"
npm run ethereum:metadata -- validate --directory "$metadata_dir"
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network sepolia --token-ids 1,111112,116667,1000001,1111112,2000001 --prior-cache-root "$previous_metadata_dir"
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network sepolia --token-ids 1,111112,116667,1000001,1111112,2000001
```

After checking that sample, complete the publication with `upload --network all --prior-cache-root "$previous_metadata_dir"` and `verify --network all`, both using the new `--directory "$metadata_dir"`.

To restore the original contents saved by a publication:

```sh
npm run ethereum:metadata -- restore --directory "$metadata_dir/snapshots" --network all
```

Restoration rewrites every object from the validated backup, including missing or damaged files. It reapplies JSON content type and `no-store` even when bytes already match, then verifies the complete inventory and checksums. It does not regenerate from current templates. Preserve the snapshot directory separately before cleaning ignored build artifacts.

Deploy reader compatibility changes before publishing metadata that needs them. The minimal HTTPS-image release requires both API and frontend deployment because their prior validators accepted only embedded SVGs. Subsequent template-only edits within the accepted format require no application deployment. Neither publishing nor restoration changes contracts, base URIs, databases, or collection ownership.

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

Local deployment manifest version 8 records `metadataBaseURI`, defaulting to `https://cdn.mons.shop/111k-sepolia/` to match the deployed Sepolia shop. `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` accepts only the existing HTTPS CDN prefixes `/111k-sepolia/` and `/111k/`. The local API verifies that value against the collection’s `baseURI()` and fetches the CDN directly. Every manifest older than version 8 requires a fresh single-contract deployment, including manifests with matching CDN URLs. Local development requires network access and reports unavailable metadata rather than falling back to local files or generated output.

```sh
npm run check:api
npm run test:ethereum
npm run test:ethereum:e2e
```

Unit and native-runtime tests remain offline using small, explicitly synthetic HTTP responses. They cover URL/token mapping, ordering, batching, response bounds, redirects, failures, timeouts, and cancellation without reproducing collection artwork. The Anvil end-to-end test requires CDN connectivity and reads current JSONs; it verifies URLs and API compatibility without pinning original names, artwork geometry, or hashes.

Bucket custom domains and CORS require bucket-administration access; object-upload permissions alone are insufficient. Manage the hostname's CORS response headers and cache bypass in the `mons.shop` zone. Verify GET, HEAD, and OPTIONS from arbitrary origins against both collection prefixes, confirm `no-store`, and check that repeated responses are not cache hits. Template-only changes within the supported metadata format do not require an application deployment.

Publish and verify all metadata before deploying a collection that references it. Use the existing [Sepolia maintenance and replacement procedure](111k_testnet.md#ethereum-maintenance-and-replacement) when replacing a collection. A metadata-hosting migration that preserves URLs and contents requires no contract deployment or database reset. Record the metadata manifest hashes, bucket/domain/CORS/cache configuration, application version, and HTTP and shop verification in the release directory. Preserve earlier Worker deployment records as historical evidence.
