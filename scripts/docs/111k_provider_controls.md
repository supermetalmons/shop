# 111k provider controls

The implementation is local until separately deployed. `npm run check:api`
validates and packages the Worker without publishing it. Do not use
`deploy:api`, remote migration commands or secret-update commands for local QA.

## Public reads

`ETHEREUM_PUBLIC_READ_CACHE` owns short-lived fills, independently of the reveal
coordinator. Anonymous stats and config share a two-second onchain snapshot;
wallet stats use one second. Inventory candidate IDs and cursors use two seconds,
but ownership, recent expected IDs and canonical block checks remain fresh.
Registry/readiness/catalog checks stay outside this cache. No expired results or
errors are served as successful cached reads.
These caches apply to collection-scoped public requests; legacy storefront
requests retain their direct reads.

`ETHEREUM_PUBLIC_READ_CACHE_ENABLED` defaults to enabled. Setting it to `false`
bypasses only these public-read caches; completed-reveal caching remains active.

Stats carry their expiry through the final registry check. An expired hit is
refetched within the request deadline; slow fresh fills do not extend the
stored cache entry's lifetime.

Concurrent identical misses share one fill. Each object holds at most 1,024
results and 64 fills. Wallet keys use sixteen deterministic shards. Capability
checks expire after ten minutes and are isolated by provider and deployment.
The current claimed-ID mask remains a live check on each statistics fill.
Statistics fills batch the live mask and statistics after checking the chain,
including `MAX_RELICS` when its capability check is due. RPC costs, cache
freshness windows and provider admission limits are unchanged.

Public provider admission uses a FIFO queue with at most 64 pending requests per
provider and one wake timer. The initial admission cutoff is one second from
the start of the operation, shared by primary and secondary attempts; switching
providers before any RPC dispatch does not restart it. After a provider has
dispatched, later RPCs and transport failover use bounded admission windows
within the original request deadline; they do not restart that overall deadline.
Queued requests receive exactly their call cost.
Cancellation removes waiting work, and exhaustion or an expired admission
cutoff remains a bounded capacity response rather than an unlimited wait.

Frontend reads make at most three attempts: the initial request and two retries,
with one-second and two-second backoff plus 0–250 ms jitter. Only HTTP 429, 502,
503 and 504, network failures and timeouts qualify. Use the greatest applicable
hint from `Retry-After` seconds, `Retry-After` dates and the response body's retry
delay, and do not retry before it. A hint above 30 seconds skips immediate
retries and gates automatic polling and focus refresh until that time. Keep
previous successful data visible. Writes are not retried by this policy, and
mi-note's existing partial-success HTTP 200 responses keep their semantics;
there is no mi-note frontend consumer added by this change.

## Outbound budgets

`ETHEREUM_PROVIDER_CONTROL_ENABLED=true` requires the
`ETHEREUM_PROVIDER_BUDGET` binding for remote calls. Local chain 31337 bypasses
external budgets. The binding is a permit coordinator, not a proxy for RPC
payloads. Budgets cover this Worker's Ethereum reads, reveal work and Alchemy NFT
inventory pages, including the existing pre111k and mi-note callers.

Request-scoped public RPC, Alchemy NFT and mi-note reads reuse their permit
client and normally reserve at most 100 CU per grant, leaving room for a separate
inventory-cache fill. A batch that costs more can request its full cost, while
queued grants reserve only that cost. Explicitly provided persistent clients
keep their existing grant quantum. Mi-note pagination reuses one client
throughout the lookup and waits within the request deadline for later-page
capacity instead of restarting completed pages.

| Policy | Alchemy | QuickNode |
| --- | ---: | ---: |
| Refill per second | 6,900 throughput CU | 22 RPC calls |
| Shared / active reveal / background | 4,400 / 2,000 / 500 | 6 / 12 / 4 |
| Shared / active reveal / background burst | 250 / 150 / 100 | 3 / 1 / 1 |
| Maximum permit grant | 250 CU | 4 calls |
| Permit lifetime | 1,000 ms | 1,000 ms |

Every batch member and hedge attempt consumes its own cost. Unused permits are
not refunded. Idle reserves can be borrowed after 500 ms without demand.
Accounting and cooldowns survive quota-object restarts. Local permit exhaustion
does not halve reveal concurrency or turn a short wait into a failed inspection.
Reveal permit refills stay in the collection coordinator's shared retry queue;
individual verifiers keep only their granted, expiring credits. Canceling a
verification also cancels its waiting permit requests.

QuickNode work accepts one-call grants and borrows larger grants when available,
so it can use reserved capacity while the shared pool is busy.

The one-second lifetime includes delivery through the budget object, collection
coordinator and verifier. Subleases preserve the original expiry; receipt does
not restart the clock. Shared refill rates leave room for this delivery allowance
while preserving active-reveal and background reserves.

The conservative dispatch envelope is `rate * (window + permit lifetime) + burst`:
76,400 Alchemy CU over ten seconds, and 49 QuickNode calls over one second.
This only controls callers in this Worker. Other apps in the Alchemy account,
including Big Wallet, still share the provider's account limit.

## QuickNode and correctness

`QUICKNODE_ETHEREUM_MAINNET_ENABLED` defaults to `false`. Enabling it also
requires the server-only `QUICKNODE_ETHEREUM_MAINNET_RPC_URL` secret. Keep local
credentials in an ignored file, not Worker vars or frontend environment files.

Alchemy remains primary. Mainnet operations can use QuickNode when Alchemy is
busy or fails transiently. An active reveal still pending after 300 ms, including
time waiting for a permit, can start
one secondary attempt; at most two attempts run. Each attempt uses one provider
and performs the full chain, receipt, log and canonicality validation. Only its
complete result is accepted, and the losing attempt is canceled. A valid pending
receipt is not treated as a provider failure. NFT indexer requests remain on
Alchemy.

The coordinator marks inspections that support coordinated permits. During a
rolling update, unmarked inspections retain the legacy validation callbacks and
use the ordinary shared budget client, without calling new coordinator methods.

Public reads can start the backup after 500 ms before their first RPC, leaving
time within the shared one-second admission cutoff. Background reads retain
their one-second before-first-RPC fallback timer. An initial capacity denial can
start the backup immediately. These reads do not hedge an RPC that is already
running; the active-reveal hedge remains 300 ms.

Snapshot state reads use EIP-1898 `{blockHash, requireCanonical: true}`. No
fallback changes those reads to `latest`. Completed reveal polling uses stored
results with no provider/budget calls. The two-second inline response window,
64 logical verifier slots and existing reorg rechecks remain in place.

Validate a new endpoint before enabling it, only as part of the separately
authorized QuickNode release described below. This is a live read-only probe,
not local QA. Discover the current registered mainnet contract, deployment block
and a known canonical receipt, and supply those values in the three verification
variables in the calling shell before running the command. `--env-file` loads
the endpoint secret into Node; it does not populate the shell expansions used
for these three arguments. The command prints a sanitized report:

```sh
node --env-file=/absolute/path/to/ignored.env --import tsx \
  scripts/ops/verifyEthereumProvider.ts \
  --contract "$ETHEREUM_PROVIDER_VERIFY_CONTRACT" \
  --transaction "$ETHEREUM_PROVIDER_VERIFY_TRANSACTION" \
  --deployment-block "$ETHEREUM_PROVIDER_VERIFY_DEPLOYMENT_BLOCK"
```

All checks must pass, especially canonical state, missing-block rejection and
batch support. A missing-block check accepts only recognized missing-block
errors; throttling, invalid parameters and unrelated provider failures fail the
check. Receipt evidence requires valid transaction and block hashes, a valid
block number, and the same hash and height from the canonical block lookup.
This command neither enables routing nor changes provider settings. QuickNode
plans have their own request and log-range limits; verify those before increasing
the local constants.

## Local validation and observation

```sh
node --import tsx scripts/benchmarkEthereumProvider.ts
npm run check:api
npm run test:ethereum:e2e
```

The synthetic benchmark uses local fixtures only, delays grant delivery after
issuance, reports warm/cold p50/p95/p99 and 100/1,000-inspection bursts, and
verifies the dispatch envelope. It also runs 20 simultaneous public RPC reads
and 10 initial NFT lookups through the real SQLite-backed public FIFO, requiring
all lookups to complete within one second and bounding broker requests to two
per lookup. It does not measure real network capacity. Native runtime tests
exercise the actual Durable Object bindings and cancellation behavior. Under
simultaneous provider exhaustion, reveal jobs remain pending and resume; no
finite provider budget can promise unchanged completion latency under unlimited
load.

`ethereum_provider_operation` logs contain provider names, method counts, budget
units/wait time, attempt outcomes and fallback/hedge cause. Cache logs aggregate
hits, coalesced reads and fills. Neither includes private endpoint URLs or wallet
data. Provider-capacity errors return a short `Retry-After` with HTTP 503; callers
should retain successful state and retry with jittered backoff.

## Staged rollout

Local implementation and successful tests do not authorize deployment, remote
readiness probes, secret changes or QuickNode activation. The first authorized
release deploys the frontend and the Alchemy-only API. QuickNode verification,
secret installation and activation require a separately authorized second
release.

1. Complete local validation before either release:

   ```sh
   node --import tsx --test tests/ethereumProviderVerification.test.ts
   npm run typecheck:tools
   npm run check:dead-code
   npm run check:api
   npm run check:frontend
   ```

   The production export baseline must match the reviewed exceptions. Correct
   specific stale entries; do not regenerate the whole allowlist to hide failures.
   Keep the exact reviewed source revision, successful checks and deployed
   version identifiers in the release record.

2. Deploy the compatible frontend retry behavior first with `npm run deploy`.
   Check ordinary collection reads immediately against the existing API. The
   client must preserve successful state through temporary capacity failures,
   honor cancellation and retry guidance, and avoid automatic retries of writes.

3. Deploy the API with `npm run deploy:api`, keeping
   `ETHEREUM_PROVIDER_CONTROL_ENABLED=true` and
   `ETHEREUM_PUBLIC_READ_CACHE_ENABLED=true`, with
   `QUICKNODE_ETHEREUM_MAINNET_ENABLED=false`. The additive
   `ethereum-provider-controls-v1` migration creates the SQLite
   `EthereumProviderBudgetObject` and `EthereumPublicReadCacheObject` classes.
   Keep their exports, bindings and migration tag together. This release does
   not change Commerce row semantics and uses the routine bounded readiness
   checks; it does not require `deploy:api:full`.

   Leave traffic, reveal admissions, alarms and scheduled work running. Use the
   default deferred Durable Object code update, including its 300-second window.
   Do not use `--durable-objects-code-update-mode immediate`, `wrangler tail`,
   or other live-tail instrumentation that can reset Durable Objects. The
   coordinator protocol marker and legacy callbacks support overlapping
   versions. Brief transient retries can occur while those versions drain.

4. Run read-only smoke checks immediately after the API release, then observe
   for at least ten minutes without adding load tests. Check config, anonymous
   and wallet stats, inventory pagination, a known canonical transaction, and
   existing completed reveal results using the [public API](111k_public_api.md).
   Confirm completed reveal reads remain provider-free and temporary capacity
   failures retain `Retry-After` and recover through the frontend retry path.

   Monitor existing persisted logs where permitted, existing GraphQL metrics,
   and bounded read-only API probes. A telemetry token without stored-log
   permission is not a reason to start a live tail; use the available GraphQL
   metrics and API probes. Review `ethereum_provider_operation`,
   `ethereum_public_read_cache`, cancellation failures, recovery/publication
   progress and provider throttling. Let the deferred update window finish and
   confirm at least one successful five-minute scheduler pass afterward. Do not
   advance while reads fail persistently, recovery stops progressing, or
   canonicality, scope or cancellation checks regress.

5. Only after separate authorization for release two, run the QuickNode
   readiness probe above against the intended endpoint. All checks must pass.
   Install `QUICKNODE_ETHEREUM_MAINNET_RPC_URL` through the server-side secret
   workflow while the routing flag remains false. Then set
   `QUICKNODE_ETHEREUM_MAINNET_ENABLED=true` and deploy with `npm run deploy:api`.
   Repeat immediate smoke checks and the ten-minute observation, using normal
   mainnet reads and any naturally occurring failover/hedge events. Do not force
   a production provider outage or submit transactions to manufacture a smoke
   result. Alchemy remains primary, NFT indexing remains on Alchemy, and
   Sepolia routing is unchanged.

## State-preserving rollback

Prepare a compatible forward rollback before release one. It must retain both
new Durable Object class exports, namespace bindings and the
`ethereum-provider-controls-v1` migration tag. Preserve provider-budget state,
reveal claims, frozen artwork, publication work and the existing deployment and
catalog identities. Do not delete objects, reset ledgers or depend on restoring
a pre-migration Worker bundle.

If QuickNode causes a regression, set its routing flag false and deploy the
compatible API through `npm run deploy:api`. For an API controls, cache or retry
regression, deploy a reviewed forward correction or compatible build that
restores the prior behavior while retaining the new classes and state. Keep the
frontend read-retry support in place unless it is itself the failing component.
The prepared fallback sets `ETHEREUM_PROVIDER_CONTROL_ENABLED=false`,
`ETHEREUM_PUBLIC_READ_CACHE_ENABLED=false` and
`QUICKNODE_ETHEREUM_MAINNET_ENABLED=false`, preserving completed-reveal caching,
bindings, protocol support and durable state. Validate this combination before
the release; it is not an instruction to change live settings during local QA.
Use the default deferred update mode for rollback as well, leave traffic and
schedulers running, and repeat the same smoke checks and ten-minute observation.
Do not switch budgets off or erase cache namespaces as an unreviewed shortcut.
