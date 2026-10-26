# Receipt claim Workflow rollout — historical record

This records the September 23, 2026 cutover and later verification snapshots.
Deployment IDs and test counts describe their recorded revisions. Current start,
status, recovery, and maintenance behavior is documented in the
[receipt claim runbook](../../scripts/docs/receipt_claim_workflow.md).
The old synchronous-wait endpoint is no longer part of the current API.

## Verified rollout: 2026-09-23

- Applied `0017_receipt_claim_workflow.sql`; production deployment readiness checks passed.
- Deployed API version `ac39f11f-b24f-4027-8240-a395b36b5217` with admission disabled and waited more than four minutes before enabling it.
- Deployed frontend version `d0af6d4c-632c-48fe-a76d-de5259f579fc` with the polling client.
- Enabled admission in API version `a43e26f0-391b-4f5b-8406-cb80ced420b5`; the checked-in configuration matches the enabled setting.
- Passed API/frontend validation, 1,521 API tests, 18 runtime tests, and 46 schema-check tests. Live health, routing, authentication, and CORS checks passed; transaction behavior was verified with mocked chain providers.

### Review follow-up

Deployed API version `f7aecb48-4944-457a-8378-cc9701d2e513` with four recovery fixes: retryable journal deadlines, verified direct-receipt legacy recovery, transactional terminal-phase checks, and durable joining of concurrent retry IDs. Added regression tests; 1,533 API tests and 18 runtime tests passed. Claim admission remains enabled.

Deployed API version `8c57781c-187b-4b26-88fc-eda996ecce0c` to persist rejected legacy transaction evidence before completion. Regression tests cover replacement transfers, verified legacy completion, receiver-owned receipts, stale generations, replay, and lost acknowledgements. Validation passed: 1,539 API tests and 18 runtime tests.

Deployed frontend version `48fe9403-df5d-4aa0-bd8c-ea0b9548a2a5` to retry temporary credential-refresh failures within the existing claim polling deadline. Terminal claim failures still stop polling. The 15 receipt-client tests and complete frontend validation passed.

Deployed API version `08704ea9-1566-4421-b21f-5ee9b57e677c` to allow explicit recovery after signer configuration repair and return durable completion when active-workflow deferral loses a race. Recipient and persisted-target guards remain enforced. Validation passed: 1,547 API tests and 18 runtime tests; production had no blocked configuration claims requiring data repair.

Deployed API version `b06a20e1-92f1-4b0d-a673-f95f686d50f3` to keep missing receipt proofs retryable while preserving terminal identity-mismatch checks. Regression tests cover direct-card and openable-pack recovery after null and 404 proof responses. Validation passed: 1,555 API tests, 18 runtime tests, and live health and protected claim routing checks through the API and frontend proxy.

Deployed API version `6587e3da-c40a-49a0-b43e-062ea53cae1f` and frontend version `ff590f0a-166f-4d05-8f2e-c94cfa5c9bc8` to recover incomplete proofs, anonymous-session replacement, and temporary authentication or request-boundary outages. Stored terminal failures remain terminal. Validation passed: 1,564 API tests, 18 runtime tests, complete frontend checks, live routing checks, and deployed-client bundle verification on both domains. Production had no existing Workflow claims requiring data repair.

Deployed API version `0187e906-8300-4bfb-8c93-94a40b7103d8` and frontend version `0bb1cb89-d2df-44bc-b5bd-ebb259e371ec` to return the current execution after expiration races and retry anonymous-auth gateway or malformed-response failures. Invalid credentials remain terminal, and browser retries retain their existing deadline. Validation passed: 1,568 API tests, 18 runtime tests, complete frontend checks, live routing checks, and deployed-client bundle verification on both domains.

## Original cutover procedure

These steps describe the completed transition from the synchronous Worker. They
are retained as history and are not required for ordinary deployment.

1. Apply commerce migration `0017_receipt_claim_workflow.sql` before deploying the Worker. Run the commerce schema checks. The migration only adds indexes; existing claim documents remain readable.
2. Deploy the Worker with `wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env --var STRIPE_RECEIPT_CLAIM_ADMISSION_ENABLED:false`, then deploy the compatible frontend. Confirm the old synchronous Worker is no longer receiving new requests. Keep admission disabled for at least four minutes after the last old request was admitted, allowing its 180-second handler and cleanup to drain. Do not use the old 90-second database lease as proof that a handler has stopped.
3. Confirm that the receipt Workflow binding exists, start/status routes return the expected authenticated responses, and scheduled reconciliation runs successfully. The receipt Workflow runtime test uses mocked steps and does not transfer assets.
4. Deploy the API Worker with the checked-in admission value `true` after the drain. The normal deployment command preserves this enabled steady state; an explicit `false` override is required for future maintenance or another cutover.
5. Exercise a controlled claim, then repeat start with the same request header and recipient. Confirm the same operation is returned and one durable completion is published. Exercise page reload/status polling without changing the receiver address.


## Historical source

The complete pre-cleanup source is commit `abb1e8b84fadae8d59af363e6b4a8117343f2dba`. Recover historical
instructions and dependencies together in an isolated checkout:

```sh
git worktree add --detach ../shop-receipt-history abb1e8b84fadae8d59af363e6b4a8117343f2dba
```

Do not deploy the historical Worker against current Commerce state. Accepted
Workflow operations and persisted transaction evidence remain authoritative.
