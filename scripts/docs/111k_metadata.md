# 111K offchain metadata

The [v8 monument collection](../../releases/111k-sepolia-v8/README.md) uses the Sepolia deployment ID `v8` and metadata prefix `https://cdn.mons.shop/111k-sepolia/v8/`. Its complete baseline contains 344966 objects, including monument tokens `117172.json`–`117189.json`. The preceding [v7 release](../../releases/111k-sepolia-v7/README.md) remains historical evidence; its registered prefix belongs to that original contract.

Deployment IDs are globally unique across networks. Later replacements must choose an unused ID. A future mainnet deployment can use a distinct ID such as `mainnet-monuments-v1`, with the same ID in its prefix suffix. Publish and verify the complete collection at each new prefix before deployment and registration. Existing reveal-managed prefixes remain associated with their original deployments.

111K metadata uses `https://cdn.mons.shop/111k-sepolia/` on Sepolia and `https://cdn.mons.shop/111k/` on Ethereum mainnet, followed by a decimal `{tokenId}.json` filename. Replacement deployments add a unique `<deploymentId>/` namespace beneath the network prefix. Each decimal filename is the ERC-721 token ID. The current shop integration remains Sepolia/Anvil only; publishing mainnet files does not enable mainnet sales.

## Identities

| Kind | Token IDs | Item number |
| --- | --- | --- |
| Digital artwork | 1–111111 | Token ID |
| Crate | 111112–116666 | 1–5555 |
| Warehouse | 116667–117171 | 1–505 |
| Monument | 117172–117189 | 1–18 |
| Digital artwork receipt | 1000001–1111111 | Token ID minus 1000000 |
| Physical-only artwork receipt | 1111112–1222222 | Token ID minus 1000000 |
| Crate receipt | 2000001–2005555 | Token ID minus 2000000 |

Digital opening keeps sequential ERC721A batch minting. Artwork `T` and receipt `1000000 + T` refer to the same artwork number. Physical-only artwork numbers start at 111112: crate `n` uses `111111 + 20 × (n − 1) + 1` onward. The final crate has 31 items and ends at artwork number 222222. The physical and digital receipt ranges cannot collide. A crate can only be digitally opened or physically redeemed, so at most 111111 artwork identities are issued across both paths.

Each monument reserves 111 crates from the same 5555-crate allocation pool as individual crates and warehouses. At most 18 monuments can ever be minted, and opening one burns it and mints its 111 reserved crates. Monument metadata exists for all 18 possible display IDs even when the remaining crate supply permits fewer monument mints.

`NFT111K` builds each CDN URL directly. `tokenURI` checks existence and uses the token ID as the filename; previews validate and map each kind/item number to its exact token filename before minting. There is no separate renderer in new deployments. Historical contracts retain their original renderers and numbering.

The owner can call `setBaseURI(string)` to update the prefix. Both construction and updates require the existing valid URL format. Every successful update emits `BaseURIUpdated` and ERC-4906 `BatchMetadataUpdate`; setting the same URL refreshes metadata after CDN edits. Coordinate a changed prefix with `ETHEREUM_111K_METADATA_BASE_URI` and the application’s allowed URL policy before reopening metadata-dependent flows.

## Source of truth

The JSON objects on `cdn.mons.shop` are the authoritative runtime metadata. Local development and the deployed shop read those same objects. The editable JSON files in [`scripts/ethereum-metadata/templates`](../ethereum-metadata/templates/) define the next generated publication. They are authoring inputs, not a runtime fallback or local metadata server.

The monument-ready generator produces 344966 JSON objects per deployment, including 18 monuments. Both networks use the same generated JSON contents; the network determines only the destination prefix. Historical publications retain their original identities and artwork assignments. The `cdn-mons-shop` bucket remains in Eastern North America (`enam`). Historical release manifests describe their own publications and remain unchanged.

The [111k_devnet reveal asset catalog](../ethereum-metadata/reveal-assets/111k_devnet/README.md) preserves counts, CDN path templates, and exact aspect ratios for upcoming reveals. The [unpack reveal service](111k_reveal.md) uses this catalog for private reservations and permanent, confirmation-gated artwork publication.

## Templates

Each template contains `name`, `description`, `image`, and `attributes`. The initial minimal format uses an empty description and one lowercase `type` trait:

| Template | Name | Image filename | Type value |
| --- | --- | --- | --- |
| `artwork.json` | `{{tokenId}}` | `artwork_placeholder.png` | `painting` |
| `warehouse.json` | `Warehouse #{{displayId}}` | `warehouse.webp` | `warehouse` |
| `monument.json` | `Monument #{{displayId}}` | `monuments/{{displayId}}.webp` | `monument` |
| `crate.json` | `Crate #{{displayId}}` | `crate.jpg` | `crate` |
| `crate_receipt.json` | `Crate Receipt #{{displayId}}` | `crate_receipt.webp` | `crate receipt` |
| `artwork_receipt.json` | `Receipt #{{displayId}}` | `artwork_placeholder_receipt.webp` | `receipt` |

The image filenames above are rooted at `https://wip.lil.org/111k/`. Names are JSON strings, including artwork names such as `"1"`. The only substitutions are `{{tokenId}}` and `{{displayId}}`; unresolved placeholders and invalid expanded image URLs fail validation. Numbering comes from the existing protocol helpers, including the physical-only artwork receipt range.

The API, storefront, checkout, and fulfillment readers accept absolute HTTPS image URLs from any host, without embedded credentials. Existing SVG data images remain supported. A future image-host change requires updating the templates and publishing again; it does not require changing a host allowlist. Images used in fulfillment PNG exports must permit anonymous cross-origin reads. Check image responses and a real export before publishing a new host or media format.

## Generate and publish

The commands below use the `v8` publication. Once it is registered, use a new globally unique deployment ID for later replacements; do not republish a registered prefix.

After a metadata prefix is registered using the [reveal operations runbook](111k_reveal_ops.md), the reveal publisher owns it permanently. Generic upload and restore refuse all mutations to that prefix. Use a fresh deployment prefix for replacement collections; never reset revealed JSONs to placeholders. Remote mutations require access to the OPS registry and its publication leases.

After upload or restore attempts any writes, its prefix remains locked for 65 seconds after the command exits, even on failure, to let outstanding storage requests drain. Wait for that interval before another upload, restore, or reveal registration for the same prefix. Read-only verification may run during the interval.

Use the committed CLI through `npm run ethereum:metadata -- <command>`. `generate` and `validate` operate on one canonical collection without a network option. Deployment publication and verification require an explicit network and its exact `--prefix`; run separate commands for Sepolia and mainnet because `--network all` cannot select deployment prefixes. Choose a new named revision directory for each template revision. Generation refuses to overwrite a completed revision, preserving its manifest and journals.

Generation and publishing share an owner-tracked lock that recovers interrupted processes on the same host. Legacy plain-file locks fail with recovery instructions; remove those only after confirming no operation is running.

After editing the templates, generate and validate a new revision:

```sh
metadata_dir=.cache/111k-metadata/monuments-v8
npm run ethereum:metadata -- generate --directory "$metadata_dir"
npm run ethereum:metadata -- validate --directory "$metadata_dir"
```

Generation writes deterministic, formatted JSON with a trailing newline, a template snapshot, `objects.jsonl`, and `manifest.json`. The manifest records template hashes, object counts, total bytes, and object-list checksums. Validation checks all 344966 identities, safe numeric filenames, generated contents, sizes, and checksums. Each JSON must fit the readers' 128 KiB limit. Generated files, snapshots, and journals stay in ignored local storage; do not commit hundreds of thousands of JSON files. Monument display IDs 1–18 generate files `117172.json`–`117189.json` with images `monuments/1.webp`–`monuments/18.webp`.

A completed `.cache/111k-metadata/monuments-v8` revision can be reused for both networks after validation. Do not rerun generation into a completed directory. A shared generated revision does not imply a shared deployment ID.

Authenticate with `R2_ENDPOINT` or `CLOUDFLARE_ACCOUNT_ID`, and either `R2_ACCESS_KEY_ID` plus `R2_SECRET_ACCESS_KEY`, or `R2_ACCESS_KEY_ID`/`CLOUDFLARE_API_TOKEN_ID` plus `CLOUDFLARE_API_TOKEN`. The latter derives the S3 secret in memory using Cloudflare's documented SHA-256 conversion. Optional `R2_SESSION_TOKEN` supports temporary S3 credentials. The destination bucket is restricted to `cdn-mons-shop`; other `R2_BUCKET` values are rejected. Supply secrets through the environment, never command arguments, tracked files, or reports. See [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

Choose a globally unique deployment ID for each network. The examples below use deployment-specific prefixes:

```sh
sepolia_prefix=111k-sepolia/v8/
mainnet_prefix=111k/mainnet-monuments-v1/
```

An optional representative sample includes all six kinds and both monument boundaries:

```sh
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network sepolia --prefix "$sepolia_prefix" --token-ids 1,111112,116667,117172,117189,1000001,1111112,2000001
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network sepolia --prefix "$sepolia_prefix" --token-ids 1,111112,116667,117172,117189,1000001,1111112,2000001
```

Sample reports have `complete: false`. Even a verified sample containing all 18 monuments cannot qualify for registration. Wait 65 seconds after a sample upload before the next upload to that prefix, then complete and verify each network without `--token-ids`:

```sh
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network sepolia --prefix "$sepolia_prefix"
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network sepolia --prefix "$sepolia_prefix"
npm run ethereum:metadata -- upload --directory "$metadata_dir" --network mainnet --prefix "$mainnet_prefix"
npm run ethereum:metadata -- verify --directory "$metadata_dir" --network mainnet --prefix "$mainnet_prefix"
```

Fresh-prefix initialization creates missing objects with conditional writes, skips matching objects, and rejects differing contents. It preserves JSON content type and `no-store`. There is no prior collection to snapshot at a fresh prefix. Retries and journals are tied to the manifest and destination; rerun the same command with the same revision directory and prefix to resume interrupted work. If the intended contents change, generate a new revision and choose a new deployment ID and prefix. Remote work defaults to 32 concurrent requests; `--concurrency N` permits 1–256.

Journal headers are committed atomically. Resume truncates an incomplete final record without rewriting the validated header. Existing malformed or mismatched headers remain rejected for inspection.

Full verification checks every direct token JSON against its expected key, byte size, and checksum, including all 18 monuments, then reads public boundary samples through `cdn.mons.shop`. Missing objects, including a single monument, fail verification. Require `complete: true` and `objectCount: 344966` in each network's report. Save those reports with the manifest hashes, unique deployment IDs and exact prefixes in the release directory. Keep the generated revision available for registration and resumption.

Registration repeats full verification from `publicationDirectory` rather than trusting a sample or a saved success report. It also verifies the onchain deployment and exact metadata URI. Wait 65 seconds after the last upload before registration. After registration, the reveal publisher permanently owns the prefix and generic upload or restore is blocked. Preparing or registering a collection does not activate the shop; storefront activation remains a separate launch step.

Snapshot restoration, when used for an unregistered destination, requires a complete 344966-object snapshot matching that destination and network. Historical five-kind backups are not supported by this baseline. Restoration rewrites the snapshot bytes and headers and verifies the complete inventory; it cannot reset a registered reveal prefix. New deployment recovery normally consists of resuming the validated fresh-prefix publication before registration.

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

Freshness applies when a client requests metadata. An already rendered page or a marketplace's indexed copy does not refresh merely because the R2 object changes. The [unpack reveal service](111k_reveal.md) returns confirmed artwork immediately and publishes frozen JSON through durable background jobs. Marketplaces maintain their own caches; use their refresh tools or the existing ERC-4906 refresh mechanism when necessary. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) and [ERC-4906](https://eips.ethereum.org/EIPS/eip-4906).

## Local development and checks

Local deployment manifest version 10 records `metadataBaseURI`. Local deployment and the end-to-end test default to the complete `https://cdn.mons.shop/111k-sepolia/v8/` publication. `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` overrides the local deployment namespace. The variable accepts HTTPS CDN collection prefixes, including deployment-specific namespaces. The local API verifies that value against the collection’s `baseURI()` and reads baseline metadata from the CDN. Reveal writes use isolated local R2 and the frontend displays the reveal API results. Every manifest older than version 10 requires a fresh deployment with monument support, including manifests with matching CDN URLs. Local baseline metadata reads still require network access, and monument metadata requires a namespace containing the new full collection.

Publish the baseline metadata for a custom namespace before using it locally. Local artwork media is verified against the local reveal ledger even if shared CDN metadata was already revealed by a different collection.

Fresh contracts start with sales closed. After local deployment, the Anvil owner must explicitly call `setSaleActive(true)` before testing purchases, as shown in the [local setup](111k_testnet.md#run-locally). Starting the local API or activating its reveal service does not open the contract sale.

```sh
npm run check:api
npm run test:ethereum
npm run test:ethereum:e2e
```

Unit and native-runtime tests remain offline using small, explicitly synthetic HTTP responses. They cover URL/token mapping, ordering, batching, response bounds, redirects, failures, timeouts, and cancellation without reproducing collection artwork. The Anvil end-to-end test requires CDN connectivity and reads current JSONs; it verifies URLs and API compatibility without pinning original names, artwork geometry, or hashes.

Before remote publication, exercise the monument collection in the Anvil test using the generated metadata directory:

```sh
ETHEREUM_111K_E2E_METADATA_DIRECTORY=.cache/111k-metadata/monuments-v8 npm run test:ethereum:e2e
```

That test adapter serves the selected generated metadata to the isolated test. Normal local development continues to read the configured CDN. After publication, `ETHEREUM_111K_E2E_METADATA_BASE_URI` selects the new live namespace for the end-to-end test.

Bucket custom domains and CORS require bucket-administration access; object-upload permissions alone are insufficient. Manage the hostname's CORS response headers and cache bypass in the `mons.shop` zone. Verify GET, HEAD, and OPTIONS from arbitrary origins against both collection prefixes, confirm `no-store`, and check that repeated responses are not cache hits. Template-only changes within the supported metadata format do not require an application deployment.

Publish and verify all metadata before deploying a collection that references it. Use the existing [Sepolia maintenance and replacement procedure](111k_testnet.md#ethereum-maintenance-and-replacement) when replacing a collection. A metadata-hosting migration that preserves URLs and contents requires no contract deployment or database reset. Record the metadata manifest hashes, bucket/domain/CORS/cache configuration, application version, and HTTP and shop verification in the release directory. Preserve earlier Worker deployment records as historical evidence.
