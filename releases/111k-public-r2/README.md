# Public R2 metadata migration

Completed on October 27, 2026. `cdn.mons.shop` now serves the existing `cdn-mons-shop` R2 bucket directly. The `mons-shop-cdn` Worker was deleted after the replacement API was verified and existing requests had drained.

The bucket remains in Eastern North America with 689,896 JSON objects. Both `/111k/` and `/111k-sepolia/` retain their existing contents and token URLs. Object sizes and ETags match the prior release inventory. Contracts and databases were unchanged, and no metadata-update or cache-purge automation was added.

## Serving configuration

- The custom domain and its TLS certificate are active; minimum TLS is 1.2. The separate `r2.dev` endpoint remains disabled.
- Public access is read-only. Bucket CORS allows all origins and request headers, GET/HEAD, and a 24-hour preflight lifetime. R2 handles OPTIONS automatically.
- Hostname response headers match `lil-org-cdn`, including exposed metadata headers, `Cross-Origin-Resource-Policy: cross-origin`, and `Timing-Allow-Origin: *`.
- JSON object metadata and the hostname response rule use `Cache-Control: no-store`. A separate hostname cache rule bypasses the edge cache.
- The API uses public HTTP metadata reads with URL validation, bounded bodies, timeouts, cancellation, and bounded concurrency. Its CDN service binding has been removed; other bindings are unchanged.

API version: `e7800a86-e9e1-4cef-9ebf-d90ec75b247c`, deployed at 100%.

## Verification

Public checks covered 24 token-boundary samples across both prefixes, matching JSON hashes, HEAD responses, arbitrary website origins, preflights, missing objects, denied write-method preflights, and repeated uncached reads. Live shop metadata and inventory checks passed after Worker deletion without transactions or data changes.

Local verification passed 2,630 API unit tests, 39 native runtime tests, 4,778 root tests, the Anvil end-to-end flow, typechecks, generated-file checks, bundle validation, startup profiling, and the existing dead-code baseline. Read-only production database checks passed with no pending migrations.

Wrangler deleted the Worker successfully but then failed its optional legacy KV cleanup check because the account token lacked KV-list permission. A subsequent read using the existing Wrangler login confirmed that no matching legacy KV namespaces remained; the Worker settings endpoint independently returned 404.

## Evidence

- [Migration and live infrastructure](migration.json)
- [Bucket CORS](cors.json) and [hostname rules](cloudflare-rules.json)
- [Unchanged bucket inventory](bucket-inventory-verification.json)
- [Public HTTP checks](http-verification.json) and [shop checks](shop-verification.json)
- [API deployment and drain](api-release.json) and [Worker deletion](worker-deletion.json)
- [Validation results](validation.json)

The [earlier offchain release](../111k-sepolia-offchain/README.md) remains historical evidence of the original Worker deployment and contract cutover.
