# Receipt claim Workflow operations

Receipt claims run in `STRIPE_RECEIPT_CLAIM_WORKFLOW`
(`mons-shop-stripe-receipt-claim-v1`). Clients use
`POST /receipts/stripe/claim/start` and `/receipts/stripe/claim/status`.
`STRIPE_RECEIPT_CLAIM_ADMISSION_ENABLED="true"` is the normal setting; `false`
blocks new reservations while accepted operations, status, and recovery continue.

## Recovery and monitoring

The start endpoint requires `X-Mons-Receipt-Claim-Request`, a UUID generated once per explicit client invocation. Transport retries reuse it. A new explicit attempt may resume a retryable failure only after the previous Workflow instance is confirmed terminal. Status requires the claim code, recipient, and operation ID; operation IDs alone are not authorization.

If a failed instance has expired from Workflow retention, an explicit retry first recreates its original generation against the unchanged terminal D1 state. That instance exits without transferring anything. The API asks the client to retry the same invocation until it can verify termination, then advances the generation. An inspection outage never counts as a missing instance.

Watch `receipt_claim_workflow` stage/completion/failure logs and `receipt_claim_workflow_dispatch_pending`. Logs contain operation/generation references, durations and error codes, never claim codes or signed transactions. The five-minute scheduled handler repairs at most eight due operations per invocation. A failed dispatch retains a short lease and reuses the same instance ID on retry. Unknown/unavailable engine state never authorizes a new generation.

Operations retain a 15-minute automatic confirmation window. A terminal retryable outcome requires a new explicit invocation; cron never extends the window. An unresolved submission retains its receiver lock. Before any replacement transfer, the implementation reconciles persisted signatures and exact asset ownership. Never clear the receiver or submission journal merely because a lease or confirmation deadline expired.

Existing processing claims retain their original receiver and known submissions when adopted by a Workflow. Existing claimed results remain readable. Signed transaction bytes are stored in D1 and are not returned by Workflow steps or API responses.

## Failure emails

Receipt delivery still has a 15-minute automatic confirmation window. Expiration
and terminal failures require an explicit retry; notification detection does not
advance a Workflow generation, change its deadline, or clear transaction evidence.

`commerce_receipt_claim_failure_outbox` records failed Workflow generations
atomically with the claim update. The five-minute scheduled notification pass
also discovers overdue pending operations, terminal operations missing an intent,
and legacy processing claims without a Workflow after 15 minutes and lease expiry.
Legacy incidents use a hash of the claim identity and processing attempt. Repeated
scans and failure writes reuse the same incident; a new explicit generation can
produce a new failure email. Completed or superseded attempts are suppressed
before publication.

Emails use the existing notification queue and Resend consumer, from
`notifications@support.mons.shop` to `development@support.mons.shop`. They contain
the drop, item, delivery, receiver, operation, timestamps, safe error code summary,
and recorded transaction signature. Claim codes, credential-bearing document
paths, signed transactions, raw exceptions, and shipping details are excluded.

Publication retains the existing ten-minute lease, four attempts, and six-hour
retry window. The saved job and provider idempotency key are immutable across
retries. These are email publication retries, not additional receipt delivery
attempts. `queued` means Queue acceptance; `notification_email_sent` with a Resend
message ID confirms provider acceptance. Inspect Resend delivery events for final
mailbox delivery, and inspect the notification DLQ for exhausted queue retries.

`npm run check:commerce-d1` validates failure-outbox rows and reports their states.
Scheduled logs use `receiptClaimNotifications`; they never include claim codes.
Recover a legacy failure through the existing claim UI/API using its original
code and stored recipient, preserving its request UUID across transport retries.
Verify the final claim and order mirrors, transaction finalization, consumed pack
receipt, and each expected recipient-owned receipt before considering it resolved.

Receipt provider defaults wrap native `fetch` before passing it to provider
objects. Workerd requires the correct receiver for its native function; assigning
bare `fetch` as an object property caused reconciliation to fail before network
I/O. The runtime regression covers the default provider path, including legacy
completed-claim enrichment, without replacing native `fetch` with a Node mock.

## Disable or roll back

Deploy the compatible Worker with `--var STRIPE_RECEIPT_CLAIM_ADMISSION_ENABLED:false` first. Keep the Workflow class, binding, status routes, and scheduled recovery deployed until accepted operations settle. Do not roll back to code that resumes synchronous transfer execution for claims already owned by a Workflow. Retain the additive indexes and operation journals. Restore the compatible frontend or disable new starts while investigating; do not reset an operation's recipient or generation manually.

## Validation before deployment

Run `npm run check:api` and the frontend typecheck/client tests. `npm run dry-run:api` bundles and validates the Worker without deploying. Production deployment, admission changes, and real asset transfers are separate operational actions.


The [rollout record](../../releases/receipt-claim-workflow-2026-09-23/README.md)
preserves the completed cutover and deployment snapshots.
