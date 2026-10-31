# 111K reveal operations

This runbook covers Mons deployment and maintenance. Share the standalone [VVV integration guide](111k_reveal.md) with partners.

## Operator setup

Each registered chain/contract has an independent 111111-asset pool and permanently owns one metadata prefix. New prefixes are `111k-sepolia/<deploymentId>/` and `111k/<deploymentId>/`. The monument replacement uses `v9` and `111k-sepolia/v9/`; retired collections retain their original prefixes. Deployment IDs are globally unique across all networks, and each URI suffix must equal its deployment ID. Never reuse a registered prefix for a replacement contract. Apply OPS migrations before publication or reveal operations.

The monument collection contains 344984 metadata objects, including monument tokens 117172–117189 and terminal monument receipts 3000001–3000018. Every monument receipt uses `https://wip.lil.org/111k/receipt_background.webp`. Publish the complete collection to each replacement prefix before deployment and registration; a selected-object preview cannot qualify. Monument images are fixed at `https://wip.lil.org/111k/monuments/1.webp` through `18.webp`. Opening a monument creates 111 ordinary crates, so the artwork reveal pool and receipt assignments retain their existing sizes and behavior.

For a fresh prefix, publish and verify the complete generated, validated placeholder collection. Do not rerun the v8 upload after its registration:

```sh
npm run ethereum:metadata -- upload --network sepolia --prefix 111k-sepolia/v9/ --directory <generated-directory>
npm run ethereum:metadata -- verify --network sepolia --prefix 111k-sepolia/v9/ --directory <generated-directory>
npm run ethereum:metadata -- upload --network mainnet --prefix 111k/mainnet-monuments-v1/ --directory <generated-directory>
npm run ethereum:metadata -- verify --network mainnet --prefix 111k/mainnet-monuments-v1/ --directory <generated-directory>
```

Initialization creates missing objects with conditional writes and rejects differing contents. Resume with the same revision directory and exact prefix. Require each verification report to have `complete: true` and `objectCount: 344984`; selected-object verification never qualifies a prefix for registration. After any upload or restore that attempted writes, wait 65 seconds before another mutation or registration for that prefix, including after a failed command.

Deploy the contract with the exact deployment-specific `ETHEREUM_111K_METADATA_BASE_URI`, then record its address and deployment block from the receipt. Registration checks the chain, creation block, deployed code, and exact onchain `baseURI()` before permanent ownership is recorded. Provisioning repeats those checks before marking the deployment ready.

Fresh contracts deploy with `saleActive()` false. Keep the sale closed through publication, registration, provisioning, and application verification. The owner explicitly calls `setSaleActive(true)` at the approved opening step; reveal activation and storefront configuration do not change this onchain switch. For Sepolia v9, use deployment ID `v9` and metadata URI `https://cdn.mons.shop/111k-sepolia/v9/` throughout the cutover.

Reveal registrations are independent of the API's global `ETHEREUM_111K_*` storefront configuration. Keep those variables on the current Sepolia or local collection when registering an additional deployment, including mainnet. Change the global contract, chain, metadata URL, and deployment block together only when replacing the supported storefront collection. Mainnet reveal registration does not enable a mainnet storefront configuration.

The shared URI builder derives each metadata address from the validated chain-specific base URI and decimal token ID. Storefront metadata reads and reveal publication do not call `tokenURI`, `previewTokenURI`, or `previewTokenURIs` to reconstruct that address. Inventory ownership, mint existence, receipt confirmation, and canonical block snapshots still require their existing chain checks. Metadata-only reads remain available during an RPC outage when the CDN is available; they do not establish that a token was minted.

The contract owner can change `baseURI()`, but the registered reveal prefix is immutable. Keep the onchain base URI, storefront configuration, and reveal registration aligned; do not change a registered contract's base URI independently. Registration and provisioning verify the initial match. A replacement deployment requires a new contract and a fresh prefix registered together, preserving the old prefix and ledger.

## Registration and credentials

The operator needs the existing Cloudflare D1/R2 credentials for registry and publication access. New registration also needs `ALCHEMY_MI_NOTE_API_KEY` for read-only chain verification. The CLI resolves that key from the invoking environment, then repository-root `.env.local`, then `.env`. It selects the Alchemy network from the manifest's chain ID and does not change storefront configuration or print the key. Status, state transitions, and unchanged registrations do not require RPC credentials.

Create a private local manifest:

```json
{
  "deploymentId": "v9",
  "dropId": "111k_devnet",
  "chainId": 11155111,
  "contractAddress": "<deployed contract address>",
  "metadataBaseUri": "https://cdn.mons.shop/111k-sepolia/v9/",
  "deploymentBlock": 12005467,
  "catalogVersion": "111k-v1",
  "publicationDirectory": "./published-metadata"
}
```

Replace the address and deployment block with the actual receipt values. `publicationDirectory` is required for new registrations and is relative to the manifest. It must contain the complete generated and validated publication, including all seven templates and `templates/artwork.json`. Registration verifies all 344984 remote objects and public samples against that snapshot; an 18-monument-only publication is rejected before registration. An optional `templateFile` must match the snapshot exactly. Mainnet uses chain ID `1`, its own contract, deployment ID `mainnet-monuments-v1`, and prefix `111k/mainnet-monuments-v1/`. Both manifests may reference the same generated revision.

```sh
npm run ethereum-reveal-control -- register --manifest <manifest.json>
npm run ethereum-reveal-control -- register --manifest <manifest.json> --write
npm run ethereum-reveal-control -- status --deployment-id v8
npm run ethereum-reveal-control -- activate --deployment-id v8 --expected-revision <revision> --write
```

The dry run verifies both publication and onchain identity without changing registry, leases, or remote metadata; publication verification can update its local report. The write path acquires a read-only publication lease, verifies publication and chain identity, then retires and atomically checks that exact lease owner when inserting the permanent record. Any validation failure leaves the prefix unregistered. An unchanged existing registration returns idempotently without requiring publication or RPC verification; changed immutable settings are rejected.

Registration transfers the entire prefix to the reveal publisher permanently. Generic metadata upload and restore subsequently refuse writes, including receipt files and paused deployments. Registration preserves the template and checksum. The scheduled watchdog starts provisioning within its five-minute cycle; Durable Object alarms continue it from `provisioning` to `ready`. There is no separate provision command. Activate only after status reports `ready`, using its current revision. Registration does not reveal historical tokens automatically; requests admit that work.

## Publication and recovery

Generic publishers renew OPS leases through bounded asynchronous queries. Every write and SDK retry checks the lease deadline; failed renewal aborts outstanding writes. A write lease retains a 65-second drain marker on close because an aborted storage request can still complete remotely. A crashed publisher's lease expires after two minutes, followed by the same drain period. Read-only registration verification transfers its lease without a write drain. Registry failures block publication.

Confirmed assignments and metadata bytes are frozen before publication. The `ETHEREUM_REVEAL_PUBLISHER` object performs R2 reads and conditional writes independently of the allocation ledger and receipt verifier. It accepts batches of at most eight and coalesces matching in-flight token writes. The coordinator claims up to 64 jobs at a time, executes them in batches of eight, and commits completed outcomes together in the ledger; undispatched claims are released. The larger claim window does not increase the eight-operation R2 concurrency limit.

All batches in a claim window share a 25-second deadline within the coordinator's 60-second publication lease; an expired read cannot start a new write. If R2 I/O stalls until the deadline, the stateless publisher resets itself so abandoned requests cannot accumulate alongside later batches. The allocation ledger remains intact, and its durable outbox retries through a fresh publisher instance. A remotely completed conditional write is reconciled against the same frozen bytes on retry. Bounded batches continue through alarms without requiring a browser to remain open. An existing object must match either the approved placeholder or the exact frozen metadata; other content is quarantined as a conflict.

Each publication run drains successive claim windows until five seconds or 512 jobs have been claimed, then schedules any remaining work. While active receipt inspections are running, publication batch starts are spaced by at least 100 ms to prioritize artwork availability while continuing metadata updates. Full publication throughput resumes when active inspections finish. There is no alarm delay between batches within a run. The ledger's one-time recovery repair rechecks previously admitted work and preserves frozen assignments and publication records; it reconstructs crate scope only from retained transaction-associated evidence.

The status command's `lastError` reports `publication-unavailable` while retryable writes remain, and clears after recovery. `metadata-conflict` requires investigation without overwriting the object or ledger. Logs contain deployment/token identities and retry counts, not private assignments or media URLs. API responses can show artwork before its CDN JSON or marketplace copy updates.

The Worker guardrails allow 10,000 new-work admissions and 120,000 total reveal requests per minute per origin/IP pair. Cloudflare applies approximate per-location counters. Keep `Retry-After` exposed through CORS; no partner key is required.

Complete transaction and token results are read from the ledger without chain RPC. Requests durably admit missing work before waiting for up to two seconds of inline verification, then return the available snapshot. This bounds the verification wait; end-to-end response time also includes request handling and network travel. Remaining work continues through durable jobs and alarms independently of the client connection. Requests keep associated jobs active for 30 seconds, with two-second checks while active; quiet work backs off progressively to five-minute checks.

Unresolved transaction watches whose crate scope is still unknown are capped at 10,000 per collection. This includes never-observed hashes, observed wrapped transactions, and recent failed receipts awaiting stable evidence. New admission at capacity returns HTTP 429 with `Retry-After`; it does not silently return `pending` for work that was not saved. Previously admitted work and available results remain accessible subject to the normal read rate limit.

Never-observed hashes are eligible for expiry after 15 minutes only when a fresh lookup finds neither their receipt nor their transaction. RPC errors preserve the watch. A validated matching transaction or receipt records chain presence before optional calldata, ownership, or canonical-block checks, so an observed wrapped transaction cannot disappear because later verification fails. Observed pending watches have no time-based expiry, even if a later lookup temporarily cannot find them. Recent failed receipts remain watched through 64 confirmations. Once an unpack's crate scope is established, its recovery belongs to the crate jobs rather than an independent permanent hash watch.

Each admitted crate has one durable recovery job keyed by the deployment and crate ID. Its associated transaction hashes, receipt candidates, and search progress stay with that job through replacements and reorgs. Transaction response records retain their complete unpack scope separately. Bounded receipt checks and indexed log discovery save progress before retrying failures; no artwork is published until canonical receipt evidence authorizes it. The additive ledger migration reconstructs crate jobs and their associations from retained evidence while preserving reservations, frozen metadata, and publication work.

Receipt inspections capture their start before RPC, including verification at capacity. Pending and confirmed results share one freshness rule: captured crate generations and evidence versions for known scope, or a strictly newer inspection start for newly discovered scope. Equal timestamps for newly discovered scope conservatively preserve the current watcher and leave verification queued. A superseded discovery scan can retain verified candidates for admitted crates or tokens, but cannot replace current cursors, provenance, or leases. Distinct unchecked evidence remains eligible for verification even when another hash is the current watcher; repeated identical evidence does not create a new crate evidence version.

Starting a receipt check does not consume its evidence. Confirmation or a terminal failure settles only the evidence captured by that check. Missing receipts, RPC errors, and failures below 64 confirmations retain eligibility and use the existing retry backoff.

Initial admission and foreground readmission after expiry use the same pause, rate-limit, and capacity checks. Both Worker-to-object calls share the request's two-second deadline. A pending response requires persisted continuation; rejected readmission returns the applicable explicit error.

Receipt verification uses the `ETHEREUM_REVEAL_VERIFIER` binding with durable permits and a hard ceiling of 64 concurrent inspections per collection. Normal jobs and capacity-overflow checks share this limit. At full capacity the scheduler prefers 48 active-request slots and 16 background slots; idle capacity can be borrowed without interrupting running work. Discovery keeps one slot for each priority, two total. Publication keeps its independent eight-write limit.

Provider throttling pauses new receipt and discovery dispatch for the cooldown period and halves receipt concurrency once per cooldown episode, down to a minimum of four. After cooldown, each 30 seconds without another throttle restores four slots, up to 64. Frozen-result reads and metadata publication remain available during this backoff. A foreground request can observe completion of its queued hash within the existing shared two-second inline budget; otherwise it receives the current snapshot while durable work continues. These limits bound load and do not promise equal latency for one unpack and hundreds of simultaneous unpacks.

Migration advances at most 128 evidence associations per turn, with frozen reads and publication available throughout. The watchdog's `ethereum_reveal_recovery_health` logs report migration progress, active/background due work, oldest due age, and watch-capacity usage at most once per minute per object.

The lifecycle upgrade uses the same resumable migration path to restore lost admission reservations, recompute receipt deadlines, and remove obsolete token interests in batches of at most 128 rows. Already accepted unresolved watches count toward capacity immediately, including before their rows are repaired. If corrected usage exceeds 10,000, existing work stays admitted and new admission waits for capacity. Crates without receipt candidates wait on their discovery schedule. An unminted result closes token-only receipt interests; independent transaction and crate recovery continue. Polling respects the two-second discovery retry floor, while saved split ranges remain eligible for immediate continuation.

## Pausing, replacement, and local development

```sh
npm run ethereum-reveal-control -- pause --deployment-id <id> --expected-revision <revision> --write
npm run ethereum-reveal-control -- activate --deployment-id <id> --expected-revision <new-revision> --write
```

Pausing stops new admission while previously admitted recovery/publication continues. Frozen results remain readable. Preserve retired deployment records, private reservations, frozen assignments, and metadata objects. Commerce reset does not delete reveal state. Never reset a production reveal object or restore an older ledger without reconciling every published immutable assignment. Use a fresh contract and prefix for a replacement collection.

`npm run dev:ethereum:api` provisions local Anvil reveal inventory automatically. Local bindings use isolated SQLite and R2; public CDN baseline metadata reads remain read-only. Restarting the local API discards its local reveal state, so restart Anvil and redeploy the contract together. Set `ETHEREUM_111K_LOCAL_METADATA_BASE_URI=https://cdn.mons.shop/111k-sepolia/v9/` for the complete v9 baseline. Custom local prefixes must be canonical and have published baseline metadata. Local artwork is checked against its local ledger even if another collection has already revealed the shared CDN metadata. Local contracts also start closed; use the Anvil owner to call `setSaleActive(true)` explicitly before test purchases.
