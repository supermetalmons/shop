# 111K unminted token recovery

Mixed requests containing a frozen artwork and an unminted token could return `recovering` indefinitely when polled at the API's two-second retry interval. Each background scan correctly saved `unminted`, but the next request expired that two-second negative cache, admitted a fresh scan, and returned immediately because another requested token already had artwork. The response therefore repeatedly exposed the newly reset state instead of the completed verification.

Live checks reproduced the behavior for tokens `260` and `111111`: a mixed request returned `recovering`, a request shortly afterward returned `unminted`, and a mixed request after cache expiry returned `recovering` again. Requesting `111111` alone returned `unminted`. No assignment or chain-proof failure was involved.

The coordinator now uses the existing bounded inline wait when a mixed request refreshes a previously unminted result. It waits only for those refresh targets to become verified unminted or frozen, rather than stopping because an unrelated requested artwork already exists. The original request deadline, admission checks, and durable background continuation remain intact. First-time partial artwork responses stay immediate; slow or failed revalidation returns `recovering` rather than stale negative information.

Regression coverage includes polling at and beyond cache expiry, fresh cached reads without RPC, a later mint after an unminted result, slow and failed RPC, paused admission, and multiple refresh batches. A native Workerd regression repeats mixed requests beyond the expiry interval and requires `unminted` with `retryAfterMs: 0` while preserving the frozen artwork.

## Verified rollout

Commit `335cd49eb5bd34ce7ffc18c2dd3824f9554287b0` is deployed as API version `21c8d01b-7d58-4e4d-8809-b60b590b34a9`, serving 100% of traffic. All 2,873 API tests, 42 native-runtime tests, release checks, and production database integrity checks passed. No state migration, frontend deployment, or contract deployment was needed.

Three live mixed requests, each made more than 2.2 seconds after the preceding response, all returned token `111111` as `unminted` with `retryAfterMs: 0`; response times were 972, 809, and 401 ms. Singleton checks before and after expiry also returned `unminted` with no artwork. Token 260's artwork and metadata checksums, token 1's placeholder bytes, and CORS behavior remain unchanged. The prior rollout's recovery-loop warning is resolved. [release.json](release.json) contains the verification evidence.
