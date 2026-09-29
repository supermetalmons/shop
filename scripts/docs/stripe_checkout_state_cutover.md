# Stripe checkout state cutover

Migration `0026_stripe_checkout_state.sql` adds the checkout state table in
inactive `legacy` mode. Lifecycle status, processing claims, attempt counts,
and retry timestamps move together. Metadata and checkout identity remain in
`commerce_documents`. Activation freezes the existing JSON lifecycle fields;
new checkouts store those fields only in the state table. Runtime reads require
table mode and matching parent versions.

Use one fixed, validated checkout. Complete `npm run check:api`,
`npm run typecheck:tools`, `npm test`, and `npm run check:dead-code` before
starting maintenance. Existing figure inventory and notification outbox
cutovers must already be complete. The maintenance commands do not call Stripe,
broadcast transactions, or send notifications.

## Pause and prepare

Apply the additive migration while the existing Worker still serves traffic,
inspect the source, and perform the existing coordinated pause:

```sh
npm run check:commerce-d1
npm run db:migrate:commerce
npm run stripe-checkout-state-control -- status
npm run commerce-authority-control -- status
npm run commerce-authority-control -- paused --expected-revision <CURRENT_REVISION> --write
```

The coordinator pauses Queue consumers, drains their work, pauses Commerce,
and drains in-flight requests and scheduled work. Preserve both drains and keep
the returned paused revision. Continue only after `paused_at_ms` is set.

```sh
npm run stripe-checkout-state-control -- status
npm run stripe-checkout-state-control -- prepare --expected-revision <PAUSED_REVISION> --write
npm run stripe-checkout-state-control -- status
npm run check:commerce-d1 -- --for-deployment
```

Preparation validates every legacy checkout before writes, holds the shared
renewable maintenance lease, and imports in pages of 25. Reruns retain identical
rows and continue missing work. Every state row and parent version must match
the source before preparation becomes ready. Source revision changes invalidate
readiness. Malformed states stop preparation and identify the checkout path;
resolve the underlying data before retrying.

Starting preparation blocks resumption until activation. A prepared database is
accepted by deployment validation only while fully paused and verified.

## Publish, activate, and resume

Publish the validated API while Commerce and Queues remain paused:

```sh
node_modules/.bin/wrangler deploy --strict --config cloud/workers/api/wrangler.jsonc --env-file cloud/workers/api/release.env
npm run stripe-checkout-state-control -- activate --expected-revision <PAUSED_REVISION> --worker-deployed --write
npm run stripe-checkout-state-control -- status
npm run check:commerce-d1 -- --for-deployment
npm run check:pack-status-d1
npm run check:ops-d1
npm run commerce-authority-control -- d1 --expected-revision <PAUSED_REVISION> --write
npm run check:queue-backlogs
npm run deploy
```

Use `--worker-deployed` only after compatible publication succeeds. Activation
rechecks the complete source snapshot, switches storage in one guarded update,
and rebuilds the Stripe notification due projection. The coordinator restores
Commerce before Queue consumers. Check fulfillment and notification logs,
expired processing claims, pending checkout age, and Queue backlogs after
resumption.
Publish the frontend with `npm run deploy` only after API activation and
resumption, so paginated delivery recovery is available before the new client.

## Recovery and ongoing operation

- Keep Commerce and Queues paused after uncertain preparation, publication, or
  activation. Inspect `status`, fix the cause, and rerun the command using the
  current paused revision. An active lease rejects overlapping maintenance;
  expired leases can be reacquired.
- Activation is one-way. Publish compatible fixes after activation. Preparing
  again validates current table state and never overwrites it with frozen JSON.
  Old Workers cannot write the frozen lifecycle fields or commit a checkout
  mutation without its matching state row.
- `status` reports storage mode, preparation/source revision, validation errors,
  state counts, oldest pending timestamps, and expired processing claims. Active
  row validation reads the parent and state together in bounded pages.
- Use the updated `wipe-drop` command. Its preview and mutation guards include
  checkout state counts; state is deleted through the parent foreign key and
  completion verification requires the target drop's state count to be zero.
- After activation, ordinary `deploy:api` applies migrations and verifies the
  authoritative state schema, versions, notification projection, and indexes.
