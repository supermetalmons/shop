# 111K concurrency benchmark

The benchmark exercises the real HTTP routes, Durable Objects, SQLite ledger, alarms, and R2 publication in native workerd. It uses isolated temporary storage and a deterministic local Ethereum RPC fixture. It does not contact an Ethereum network or modify remote storage.

## Results

All 30 before/after scenarios completed with unique assignments, no premature artwork responses, and every metadata job published. Each nominal size ran three times. The table reports the median of the three per-run artwork-readiness p95 values; publication is the median time to publish the entire burst.

| Concurrent unpacks | Before readiness p95 | Updated readiness p95 | Speedup | Before all metadata | Updated all metadata |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.284 s | 0.292 s | Approximately unchanged | 0.287 s | 0.294 s |
| 100 | 9.667 s | 1.994 s | 4.85× | 9.934 s | 5.623 s |
| 200 | 33.964 s | 3.616 s | 9.39× | 34.867 s | 10.715 s |
| 500 | 78.417 s | 8.222 s | 9.54× | 87.506 s | 32.786 s |

The conservative gates also passed: the slowest updated 200-request p95 was **3.688 s**, at least **9.20×** faster than the fastest baseline run; the slowest updated 500-request p95 was **9.286 s**. The required gates were 6 seconds and 5× at 200, and 12 seconds at 500. See [comparison.json](comparison.json), [baseline-nominal.json](baseline-nominal.json), and [updated-nominal.json](updated-nominal.json). Recalculate the comparison with `node releases/111k-concurrency-2026-10-30/compare.mjs`.

The updated publisher spaces 8-job batch starts by 100 ms while active receipt work is running, then drains at full speed. This prioritizes API artwork availability while continuing metadata writes. An [exploratory unpaced implementation](diagnostics/unpaced-smoke.json) published 10,000 files in about 24 seconds but took about 23 seconds to make the 500-request artwork p95 available. The final implementation makes that artwork available much earlier; its median metadata completion is about 33 seconds, still substantially faster than the original 88 seconds. The exploratory result is diagnostic evidence, not a fourth nominal repetition.

The resilience profiles ran once per implementation with 100 requests:

| Profile | Before readiness p95 | Updated readiness p95 | Updated all metadata |
| --- | ---: | ---: | ---: |
| Slow RPC tails | 43.115 s | 3.203 s | 9.704 s |
| HTTP 429 | 10.217 s | 6.218 s | 6.861 s |
| Pending → confirmed | 12.863 s | 5.678 s | 9.492 s |

All 17 deterministic throttled hashes recovered in both runs. Pending responses remained empty before receipts became visible at 3 seconds; updated readiness p95 was **2.678 seconds after that visibility point**. The slow profile's last updated transaction took 8.405 seconds, reflecting its deliberately injected 5-second tail. See [baseline-resilience.json](baseline-resilience.json) and [updated-resilience.json](updated-resilience.json).

These are local native-runtime measurements with modeled RPC latency. The HTTP acknowledgment numbers in the JSON reports measure native service-binding responses, excluding external network and ingress latency. The API's two-second inline work budget is not an end-to-end response-time guarantee.

## Implementation and validation

The collection coordinator remains the sole owner of reservations, frozen assignments, recovery claims, and the publication outbox. Receipt inspection runs in transaction-scoped verifier objects with 64 durable permits, a reserved background share, and provider cooldown/backoff. A separate publisher performs conditional R2 writes eight at a time. Publication claim IDs fence stale results and allow undispatched work to be released safely. Neither executor owns or reallocates artwork.

Metadata URIs now come from the validated deployment prefix and decimal token ID. A real Anvil run confirmed that a 311-artwork transaction needs three contract reads rather than fourteen, while preserving ownership and canonical-block checks. It also verified private pending results, first-confirmation disclosure, immutable metadata after `evm_revert`, and recovery by token ID.

Validation passed 2,867 API unit tests, 42 native-runtime tests, 5,004 application tests, frontend worker/client checks, type/generated-schema checks, API dry-run/startup checks, browser bundle validation, and dead-code checks. [validation.json](validation.json) records the environments, the configuration-test recheck, and Anvil results. The full application checks use the workspace Node 26 runtime; the benchmark uses the same pinned Node 22 runtime for both implementations.

Wrangler and Miniflare are pinned together to support `durable_object_io_tasks_prevent_eviction`. The verifier and publisher namespace migrations are additive; existing collection ledgers and frozen metadata remain in place. The coordinator adds dispatch and publication-claim fields on initialization. No new D1 migration or contract change is required. These changes have been validated locally and have not been deployed.

## Reproduce

Run from the repository root with the installed lockfile dependencies and Node 22.23.1. Before and after runs must use the same Node, Wrangler, and Miniflare versions; each report records them. The commands below select that Node version without changing the project's dependencies.

Prepare the original implementation without changing the working checkout:

```sh
mkdir -p /tmp/111k-reveal-baseline-e6406378
git archive --format=tar e64063787649b81987cc9aa0a088af9f6a508019 | tar -x -C /tmp/111k-reveal-baseline-e6406378
```

Run the baseline and current implementation sequentially, with other builds and tests idle:

```sh
npm exec --yes --package=node@22.23.1 -- node --import tsx releases/111k-concurrency-2026-10-30/benchmark.ts --source /tmp/111k-reveal-baseline-e6406378 --isolation coordinator --counts 1,100,200,500 --repetitions 3 --profiles nominal --output releases/111k-concurrency-2026-10-30/baseline-nominal.json
npm exec --yes --package=node@22.23.1 -- node --import tsx releases/111k-concurrency-2026-10-30/benchmark.ts --source . --isolation transaction --counts 1,100,200,500 --repetitions 3 --profiles nominal --output releases/111k-concurrency-2026-10-30/updated-nominal.json
```

For the resilience runs, use `--counts 100 --repetitions 1 --profiles slow,throttle,pending` and distinct output files. A completed scenario is written immediately; rerunning the same command resumes unfinished scenarios. Resumption rejects different source hashes, runtime versions, or measurement settings.

## Fixture and measurements

- Every transaction unpacks one crate into 20 distinct token IDs. Receipts have complete mint, burn, and unpack evidence at one canonical confirmation.
- Nominal RPC header delays are 100 ms for 90% of deterministic operation/hash combinations, 300 ms for 9%, and 1 second for 1%. Slow runs use 250 ms, 1 second, and 5 seconds. Repetitions reuse the same delays.
- The provider runs in a separate worker thread so local runtime inspection cannot delay its network timers.
- A temporary source copy adds a transaction-hash HTTP header to the inspector fetches. The provider emulates six simultaneous external RPC requests waiting for headers per coordinator in the baseline, and per transaction verifier in the updated implementation. Discovery retains the coordinator context. Native R2 calls are not included in this fixture semaphore. No ledger mutation or confirmation logic is altered.
- A fixture Worker dispatches every transaction request concurrently with `Promise.all` through `SERVICE_BINDING.fetch` to the real public API entry point. Each call has its own POST request and the same VVV origin/IP. This avoids both local TCP listener failures and artificial client connection queues. The report records dispatch spread and admission latency. HTTP acknowledgment timings are measured inside native workerd and exclude external network and ingress latency. Service bindings retain their normal top-level invocation limits; verification and publication run in their configured Durable Objects.
- Acknowledgment latency measures each API HTTP response through the service binding, including pending responses. Artwork readiness observes each complete frozen transaction every 25 ms through a fixture-only HTTP route and read-only async Durable Object method. The method returns a JSON string; no synchronous Miniflare proxy or storage inspection runs while work is pending. These observations do not poll the public reveal API or drive recovery. Their scheduling delay is included in readiness latency.
- Drain time ends when every transaction's artwork is available. Publication time ends when every token's metadata job is published. R2 uses native local storage without injected network latency; its timings are not a production CDN guarantee.
- RPC counts include background receipt rechecks. The `retries` metric is the number of receipt checks beyond the first check per transaction, including these rechecks. Throttle responses and unexpected provider errors are reported separately.
- The throttle profile returns HTTP 429 with `Retry-After: 2` on the first receipt request for a deterministic subset of approximately 20% of hashes. The pending profile makes receipts visible three seconds after the burst begins.
- Every completed scenario verifies zero premature artwork responses, unique token/asset assignments, and complete metadata publication.

The fixture models network delay and connection isolation, not the account's actual Alchemy compute-unit budget. A production latency guarantee requires checking that budget and measuring the deployed system.

Optional `--wrapper /absolute/path/to/entry.ts` and `--disable-publication true` switches are diagnostic tools. Reports mark these changes explicitly. Publication-bypassed runs must not be used as before/after performance results.
