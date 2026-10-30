# 111K unminted token recovery

Mixed requests containing a frozen artwork and an unminted token could return `recovering` indefinitely when polled at the API's two-second retry interval. Each background scan correctly saved `unminted`, but the next request expired that two-second negative cache, admitted a fresh scan, and returned immediately because another requested token already had artwork. The response therefore repeatedly exposed the newly reset state instead of the completed verification.

Live checks reproduced the behavior for tokens `260` and `111111`: a mixed request returned `recovering`, a request shortly afterward returned `unminted`, and a mixed request after cache expiry returned `recovering` again. Requesting `111111` alone returned `unminted`. No assignment or chain-proof failure was involved.

The coordinator now uses the existing bounded inline wait when a mixed request refreshes a previously unminted result. It waits only for those refresh targets to become verified unminted or frozen, rather than stopping because an unrelated requested artwork already exists. The original request deadline, admission checks, and durable background continuation remain intact. First-time partial artwork responses stay immediate; slow or failed revalidation returns `recovering` rather than stale negative information.

Regression coverage includes polling at and beyond cache expiry, fresh cached reads without RPC, a later mint after an unminted result, slow and failed RPC, paused admission, and multiple refresh batches. A native Workerd regression repeats mixed requests beyond the expiry interval and requires `unminted` with `retryAfterMs: 0` while preserving the frozen artwork.
