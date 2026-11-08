# 111K reveal operations

This runbook covers Mons deployment and maintenance. Share the standalone [VVV integration guide](111k_reveal.md) with partners.

## Operator setup

New deployments use catalog version `111k-v5`: 76,642 eggs, 30,990 paintings,
58 videos, 3,000 3D models, and 421 animated artworks. The importer fills the
111,111-artwork supply from 76,700 available eggs after counting all non-egg
artworks. The runtime supports this catalog only. Retired-catalog API requests return `409`,
watchdog scans skip them, and their alarms stop. Superseded testnet registrations
retain ownership records that prevent prefix reuse; their reveal ledgers and CDN
metadata can be deleted through the retirement procedure below. Registration and
activation require the current catalog. Do not rewrite an old catalog version or
migrate an existing allocation pool to v5.

The media root is `https://cdn.lil.org/nft/111k/`. Eggs, paintings, 3D previews,
and animated previews use PNGs. 3D models use GLBs; animated artworks use original
MP4s; videos use MP4s with WEBP posters. Ratios are per asset, including videos.
Painting alts are variants, not additional allocation slots. The
[catalog guide](../ethereum-metadata/reveal-assets/111k_devnet/README.md) documents
the repeatable importer and source snapshot. Run `npm run check:ethereum-assets`
before preparing a deployment. Registration and initialization validate the
manifest and its compact shared descriptor before using the pool.

For each updated complete source JSON, import with a higher catalog version,
review the generated counts and references, and verify representative public
GET/HEAD responses, content types, and CORS for category boundaries and media
companions. Confirm the egg allocation fits the available inventory. Freeze
the resulting catalog before registration; confirmed assignments and their
metadata do not change afterward.

Each registered chain/contract has an independent 111111-asset pool and permanently owns one metadata prefix. New prefixes are `111k-sepolia/<deploymentId>/` and `111k/<deploymentId>/`; retired deployment identities continue to reserve their original prefixes even after testnet data is purged. Deployment IDs are globally unique across all networks, and each URI suffix must equal its deployment ID. Choose a new ID for each replacement and keep its identity in one manifest throughout registration, status checks, and activation. The [testnet guide](111k_testnet.md) records the current deployment. Never reuse a registered prefix for a replacement contract. Apply OPS migrations before publication or reveal operations.

The relic collection contains 344984 metadata objects, including relic tokens 117172–117189 and terminal relic receipts 3000001–3000018. Every relic receipt uses `https://cdn.lil.org/nft/111k/placeholder.png`. Publish the complete collection to each replacement prefix before deployment and registration; a selected-object preview cannot qualify. New relic publications use `https://cdn.lil.org/nft/111k/relics/1.webp` through `18.webp`; existing publications retain their recorded image URLs. Owner allocation reserves relic crate supply before sales; claiming does not change the reserved supply. Opening a relic creates 111 ordinary crates, so the artwork reveal pool and receipt assignments retain their existing sizes and behavior.

For a fresh prefix, publish and verify the complete generated, validated placeholder collection. Set the deployment ID once and derive its prefix. Do not rerun an upload after that prefix is registered:

```sh
sepolia_deployment_id='<new-sepolia-deployment-id>'
sepolia_prefix="111k-sepolia/${sepolia_deployment_id}/"
metadata_dir='<generated-directory>'
npm run ethereum:metadata -- upload --network sepolia --prefix "$sepolia_prefix" --directory "$metadata_dir"
npm run ethereum:metadata -- verify --network sepolia --prefix "$sepolia_prefix" --directory "$metadata_dir"
```

For a separate mainnet deployment, choose another globally unique ID and use `111k/<deploymentId>/` with `--network mainnet`. Each network needs its own deployment manifest.

Initialization creates missing objects with conditional writes and rejects differing contents. Resume with the same revision directory and exact prefix. Require each verification report to have `complete: true` and `objectCount: 344984`; selected-object verification never qualifies a prefix for registration. After any upload or restore that attempted writes, wait 65 seconds before another mutation or registration for that prefix, including after a failed command.

Deploy the contract with the exact deployment-specific `ETHEREUM_111K_METADATA_BASE_URI`, then record its address and deployment block from the receipt. Registration checks the chain, creation block, deployed code, and exact onchain `baseURI()` before permanent ownership is recorded. Provisioning repeats those checks before marking the deployment ready.

Fresh contracts deploy with `saleActive()` false. Keep the sale closed through publication, registration, provisioning, and application verification. The owner explicitly calls `setSaleActive(true)` at the approved opening step; reveal activation and storefront configuration do not change this onchain switch. Use the replacement manifest's deployment ID and metadata URI throughout the cutover.

Reveal registrations are independent of the API's global `ETHEREUM_111K_*` storefront configuration. Keep those variables on the current Sepolia or local collection when registering an additional deployment, including mainnet. Change the global contract, chain, metadata URL, and deployment block together only when replacing the supported storefront collection. Mainnet reveal registration does not enable a mainnet storefront configuration.

The shared URI builder derives each metadata address from the validated chain-specific base URI and decimal token ID. Storefront metadata reads and reveal publication do not call `tokenURI`, `previewTokenURI`, or `previewTokenURIs` to reconstruct that address. Inventory ownership, mint existence, receipt confirmation, and canonical block snapshots still require their existing chain checks. Metadata-only reads remain available during an RPC outage when the CDN is available; they do not establish that a token was minted.

The contract owner can change `baseURI()`, but the registered reveal prefix is immutable. Keep the onchain base URI, storefront configuration, and reveal registration aligned; do not change a registered contract's base URI independently. Registration and provisioning verify the initial match. A replacement deployment requires a new contract and a fresh prefix registered together. For Sepolia replacements, preserve the old ledger only through verified cutover, then immediately perform the required testnet retirement phase below in the same deployment task. Mainnet retention is unchanged.

## Registration and credentials

The operator needs the existing Cloudflare D1/R2 credentials for registry and publication access. New registration also needs `ALCHEMY_MI_NOTE_API_KEY` for read-only chain verification. The CLI resolves that key from the invoking environment, then repository-root `.env.local`, then `.env`. It selects the Alchemy network from the manifest's chain ID and does not change storefront configuration or print the key. Status, state transitions, and unchanged registrations do not require RPC credentials.

Create a private local manifest using the deployment ID and prefix chosen above:

```json
{
  "deploymentId": "<new-sepolia-deployment-id>",
  "dropId": "111k_devnet",
  "chainId": 11155111,
  "contractAddress": "<deployed contract address>",
  "metadataBaseUri": "https://cdn.mons.shop/111k-sepolia/<new-sepolia-deployment-id>/",
  "deploymentBlock": 0,
  "catalogVersion": "111k-v5",
  "publicationDirectory": "./published-metadata"
}
```

Replace both deployment-ID placeholders with the chosen ID, and replace the address and zero deployment block with the actual receipt values. `publicationDirectory` is required for new registrations and is relative to the manifest. It must contain the complete generated and validated publication, including all seven templates and `templates/artwork.json`. Registration verifies all 344984 remote objects and public samples against that snapshot; an 18-relic-only publication is rejected before registration. An optional `templateFile` must match the snapshot exactly. Mainnet uses chain ID `1`, its own contract and globally unique ID, and prefix `111k/<deploymentId>/`. Both manifests may reference the same generated revision.

```sh
new_manifest='<manifest.json>'
npm run ethereum-reveal-control -- register --manifest "$new_manifest"
npm run ethereum-reveal-control -- register --manifest "$new_manifest" --write
npm run ethereum-reveal-control -- status --manifest "$new_manifest"
npm run ethereum-reveal-control -- activate --manifest "$new_manifest" --expected-revision <revision> --write
```

Use the same manifest for every command above. Manifest-targeted status, activation, and pause verify the registered deployment ID, drop, chain, contract, metadata URI, creation block, and catalog version before returning a result or changing state. They do not read publication or template files and need no RPC credentials. A missing registration produces an empty status result and cannot be activated. Transitions still require the current revision from that manifest's status result. The CLI rejects mixed or duplicate target options; explicit `--deployment-id` remains available for deliberate administration of a known registration.

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

## Pausing and replacement

```sh
target_manifest='<manifest-for-the-collection-being-maintained.json>'
npm run ethereum-reveal-control -- status --manifest "$target_manifest"
npm run ethereum-reveal-control -- pause --manifest "$target_manifest" --expected-revision <revision> --write
npm run ethereum-reveal-control -- status --manifest "$target_manifest"
npm run ethereum-reveal-control -- activate --manifest "$target_manifest" --expected-revision <new-revision> --write
```

These commands pause and resume one collection for maintenance. During a replacement, pause the retired collection using its separate `old_manifest`; activate only the replacement's `new_manifest` from the registration steps above.

For the current catalog, pausing stops new admission while previously admitted recovery/publication continues and frozen results remain readable. Retiring a catalog version stops its API execution and background work. Commerce reset does not delete reveal state. Mainnet and the current collection retain their ledgers and metadata. Use a fresh contract and prefix for a replacement collection.

## Superseded testnet retirement

### Required after every replacement

Replacing the 111k testnet includes purging its superseded deployment. Begin
retirement as soon as the replacement is active and verified; do not accumulate
old deployments or leave cleanup for a later task. A replacement is complete
only after both cutover and retirement verification succeed.

1. Before cutover, apply OPS migration `0011_ethereum_reveal_retirement.sql` and
   Commerce migration `0048_ethereum_retirement_fence.sql`, then deploy the matching
   Worker. Prepare a fresh deployment ID with the release runner;
   it derives the predecessor from matching repository and live configuration.
   The finalizer binds both scopes to the frozen manifest, signed transactions,
   canonical chain evidence, registry, and live commerce configuration. Never
   change an immutable registration, bump the shared catalog solely to unlock
   deletion, or bypass current-deployment and mainnet protections.
   Update the shared metadata default in `shared/ethereum/config.ts` and the
   local fallback in `onchain/ethereum/script/Deploy111K.s.sol` with the API
   configuration. Finalization refuses to purge a namespace still selected by
   those supported runtime defaults.
2. Close the old sale/redemptions and clear its scoped commerce state through the
   guarded cutover procedure while commerce control still targets the old scope.
   Verify the new contract, storefront, commerce control, reveal registration,
   metadata, and live acceptance agree. Fence all old admission, recovery,
   publication, callbacks, and alarms; pausing alone leaves background work alive.
   The finalizer records an irreversible retirement timestamp and replacement ID,
   quiesces old writers, and waits at least 65 seconds before purging. This works
   even when the old and new deployments share a catalog. Pending storage
   operations must settle before metadata deletion.
3. Purge old reveal storage and alarms, exact old metadata prefixes, obsolete
   publication leases, and any remaining deployment-scoped backend records.
   Preserve permanent identity/prefix ownership records, the current collection,
   mainnet, pre111k, shared media, profiles, authentication, and unrelated drops.
   Never switch commerce control back to an old deployment just to prune it.
4. Verify old data is absent, old API access is rejected, and the replacement's
   complete expected metadata and frozen artwork remain healthy. Recheck retired
   storage, metadata, and alarms after at least one five-minute scheduler interval
   to prove that writers cannot recreate them.
5. Remove superseded release trees, generated metadata/render scratch, caches,
   and old backup files once backend verification passes. Move any still-required
   shared inputs out of old release folders first. Keep the current signed
   transaction journal intact, even when it records actions against the previous
   contract. Retain only required current evidence, Git history, and a compact
   cleanup record; do not create or retain a legacy archive. Delete any temporary
   safety snapshot required by the guarded commerce reset after verified cleanup.

If retirement fails, keep the replacement task open and resume its scoped journal
until cleanup and verification finish. Do not describe a successful cutover alone
as a completed replacement.

### Automatic finalization

`nft111k:deploy open` automatically runs replacement verification and cleanup
after the opening transaction is confirmed. It requires existing Cloudflare
operator access as well as the deployment RPC credentials. Opening remains
journaled if cleanup fails; retry the same directory without rebroadcasting:

```sh
npm --prefix onchain/ethereum run nft111k:deploy -- finalize --network sepolia --directory "$release_dir"
```

The reusable finalizer can also be invoked directly. Without `--write` it checks
the already-open replacement and prepares its bound cleanup plans without
retiring or deleting remote data:

```sh
npm run finalize:ethereum111k -- --release-directory "$release_dir"
npm run finalize:ethereum111k -- --release-directory "$release_dir" --write
```

`cleanup-finalization.json` and `cleanup-artifacts.json` live beside the frozen
release manifest. Keep them when resuming. The finalizer verifies complete new
metadata key coverage and a stable cutoff of frozen artworks, so newer reveals
can continue normally. Old publication may finish while paused; its deletion
inventory is sealed only after retirement, draining, and verified storage purge.
Each deletion window is acknowledged before advancing, and a fresh listing must
prove the old prefix empty. The finalizer then verifies the replacement, prunes
owned old artifacts, and repeats the retirement checks after five minutes.
It reports `complete: true` only after every stage succeeds.

After retirement commits, `finalize` can recover from a pause/resume of the same
replacement. It revalidates the replacement and frozen artwork before recording
fresh control revisions, while retaining the original retirement evidence.

Artifact cleanup uses deployment identity, publication journals, and matching
release evidence to recognize old files. It rejects symlinks, scope mismatches,
changed inventories, and references from current/shared inputs. Resolve such a
failure before retrying; do not bypass the guard or delete the current signed
journal. Mainnet, pre111k, shared assets, and unrelated data are protected.

Private release locations are indexed by deployment ID and frozen into the next
replacement manifest. For a pre-existing custom directory, pass
`--previous-directory PATH` to `prepare` or a recovery `finalize`. Custom release
directories must be dedicated to release outputs; keep signing keys elsewhere.
Mainnet/shared cache ownership includes publication reports, journals, and snapshots.
Shared caches are removed once every Sepolia owner is proven retired; current,
mainnet, and unknown owners continue to protect the cache.

A pending retirement fence blocks commerce scope changes until the OPS outcome
is resolved. Retry `finalize` first; `ethereum111k-control status` reports any
pending request. To abandon an attempt that has not committed retirement:

```sh
npm run cleanup:ethereum111k -- cancel --release-directory "$release_dir" --write
```

Cancellation invalidates the old revision before releasing the fence. It removes
only the unstarted finalization journal; signed release evidence and the artifact
plan remain. If retirement already committed, cancellation retains the journal
for `finalize` and never reactivates the old deployment.

### November 8 cleanup tooling

The [cleanup record](../../releases/111k-testnet-cleanup-2026-11-08/README.md) tracks the approved removal of deployments preceding v16. This operation creates no archive. It preserves the current collection, mainnet and pre111k data, shared media, and the deployment ownership records that permanently reserve retired IDs and prefixes.

The version-1 `plan`/`apply`/`verify` commands below remain specific to that
historical v16 cleanup. Use replacement finalization above for future releases;
changing a version-1 manifest does not retarget its fixed scope.

```sh
npm run cleanup:ethereum111k -- plan --manifest '<reviewed-retirement-manifest.json>'
npm run cleanup:ethereum111k -- apply --manifest '<reviewed-retirement-manifest.json>' --write
npm run cleanup:ethereum111k -- verify --manifest '<reviewed-retirement-manifest.json>'
```

Apply only the reviewed manifest after confirming its protected v16 identity and exact retired contracts and prefixes. Deployment and publication guards must be active before the maintenance service purges old Durable Object data. The private `EthereumRevealMaintenance.purgeRetired({ deploymentId, expectedRevision })` operation retains registry ownership records; retirement does not free an ID or prefix for reuse. Verification must show the retired data is absent and current v16 behavior is intact before local release trees, scratch files, and obsolete backups are pruned.

After purging, do not roll back to Worker or publication tooling that ignores `retired_at_ms`, including the historical catalog-only retirement implementation. Preserve the Commerce retirement fences and their recovery support as well. Older code could recreate removed prefixes or accept work for deleted ledgers. Use a forward fix that preserves the permanent marker and writer guards. Never reset the current collection or restore an older active ledger without reconciling every published immutable assignment.

## Local development

`npm run dev:ethereum:api` provisions local Anvil reveal inventory automatically. Local bindings use isolated SQLite and R2; public CDN baseline metadata reads remain read-only. Restarting the local API discards its local reveal state, so restart Anvil and redeploy the contract together. Local deployment uses the committed default metadata namespace; set `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` only when selecting another complete published baseline. Custom local prefixes must be canonical and have published baseline metadata. Local artwork is checked against its local ledger even if another collection has already revealed the shared CDN metadata. Local contracts also start closed; use the Anvil owner to call `setSaleActive(true)` explicitly before test purchases.
