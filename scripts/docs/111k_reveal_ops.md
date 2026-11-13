# 111K reveal operations

This runbook covers Mons deployment and maintenance. Share the standalone [VVV integration guide](111k_reveal.md) with partners.

## Operator setup

New deployments use catalog version `111k-v9`: 38,652 eggs, 68,980 paintings,
58 videos, 3,000 3D models, and 421 animated artworks. The importer fills the
111,111-artwork supply from 76,700 available eggs after counting all non-egg
artworks. The runtime supports the current catalog and explicitly retained ancestor
catalogs. Unknown-catalog API requests return `409`, watchdog scans skip them, and
their alarms stop. Superseded testnet registrations
retain ownership records that prevent prefix reuse; their reveal ledgers and CDN
metadata can be deleted through the retirement procedure below. Registration and
initialization require the current default catalog. Never rewrite an existing
catalog identity; use the catalog expansion operation below for live pool changes.

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
the resulting catalog before registration. Ordinary reveal preserves confirmed
assignments; explicit catalog expansion can replace cutoff eggs with new artworks.

Each registered chain/contract has an independent 111111-asset pool and permanently owns one metadata prefix. The first mainnet deployment may register the clean `111k/` root using internal ID `mainnet-v1`; follow the [mainnet runbook](111k_mainnet.md). Other new prefixes are `111k-sepolia/<deploymentId>/` and `111k/<deploymentId>/`; retired identities continue to reserve their prefixes after testnet data is purged. Deployment IDs are globally unique across networks. A dedicated URI suffix must equal its deployment ID; the mainnet root retains its ID only in the registry and release manifest. Choose a new ID for each replacement and keep its identity in one manifest throughout registration, status checks, and activation. The [testnet guide](111k_testnet.md) records the current deployment. Never reuse a registered prefix for a replacement contract. Apply OPS migrations before publication or reveal operations.

The relic collection contains 344984 metadata objects, including relic tokens 117172–117189 and terminal relic receipts 3000001–3000018. Every relic receipt uses `https://cdn.lil.org/nft/111k/placeholder.png`. Publish the complete collection to each replacement prefix before deployment and registration; a selected-object preview cannot qualify. New relic publications use `https://cdn.lil.org/nft/111k/relics/1.png` through `18.png`. Registered live relics can migrate through the [dedicated image maintenance procedure](111k_metadata.md#updating-live-relic-images); frozen publication records retain their original image URLs. Owner allocation reserves relic crate supply before sales; claiming does not change the reserved supply. Opening a relic creates 111 ordinary crates, so the artwork reveal pool and receipt assignments retain their existing sizes and behavior.

For a fresh prefix, publish and verify the complete generated, validated placeholder collection. Set the deployment ID once and derive its prefix. Do not rerun an upload after that prefix is registered:

```sh
sepolia_deployment_id='<new-sepolia-deployment-id>'
sepolia_prefix="111k-sepolia/${sepolia_deployment_id}/"
metadata_dir='<generated-directory>'
npm run ethereum:metadata -- upload --network sepolia --prefix "$sepolia_prefix" --directory "$metadata_dir"
npm run ethereum:metadata -- verify --network sepolia --prefix "$sepolia_prefix" --directory "$metadata_dir"
```

For the first mainnet deployment, use the [clean-root bootstrap](111k_mainnet.md). Additional mainnet collections require another globally unique ID and `111k/<deploymentId>/` with `--network mainnet`. Each network needs its own deployment manifest.

Initialization creates missing objects with conditional writes and rejects differing contents. Resume with the same revision directory and exact prefix. Require each verification report to have `complete: true` and `objectCount: 344984`; selected-object verification never qualifies a prefix for registration. After any upload or restore that attempted writes, wait 65 seconds before another mutation or registration for that prefix, including after a failed command.

Deploy the contract with the exact deployment-specific `ETHEREUM_111K_METADATA_BASE_URI`, then record its address and deployment block from the receipt. Registration checks the chain, creation block, deployed code, and exact onchain `baseURI()` before permanent ownership is recorded. Provisioning repeats those checks before marking the deployment ready.

Fresh contracts deploy with `saleActive()` false. Keep the sale closed through publication, registration, provisioning, and application verification. The owner explicitly calls `setSaleActive(true)` at the approved opening step; reveal activation and storefront configuration do not change this onchain switch. Use the replacement manifest's deployment ID and metadata URI throughout the cutover.

Reveal registrations are independent of the API's global `ETHEREUM_111K_*` storefront configuration. Keep those variables on the current Sepolia or local collection when registering an additional deployment, including mainnet. Change the global contract, chain, metadata URL, and deployment block together only when replacing the supported storefront collection. Mainnet reveal registration does not enable a mainnet storefront configuration.

The shared URI builder derives each metadata address from the validated chain-specific base URI and decimal token ID. Storefront metadata reads and reveal publication do not call `tokenURI`, `previewTokenURI`, or `previewTokenURIs` to reconstruct that address. Inventory ownership, mint existence, receipt confirmation, and canonical block snapshots still require their existing chain checks. Metadata-only reads remain available during an RPC outage when the CDN is available; they do not establish that a token was minted.

The contract owner can change `baseURI()`, but the registered reveal prefix is immutable. Keep the onchain base URI, storefront configuration, and reveal registration aligned; do not change a registered contract's base URI independently. Registration and provisioning verify the initial match. A replacement deployment requires a new contract and a fresh prefix registered together. For Sepolia replacements, preserve the old ledger only through verified cutover, then immediately perform the required testnet retirement phase below in the same deployment task. Mainnet retention is unchanged.

## Adding artworks and cutting off eggs

**Hatch eggs from an updated `111k.json`.** An explicit hatch request authorizes this
flow through deployment, application, and verification; honor inspection/preparation-only
requests. Default to the current active Sepolia 111k storefront. Mainnet or another
deployment requires explicit scope. Do not reconfirm already-requested steps.

Use `npm run ethereum:catalog-update`. Preserve the contract, token IDs, ownership,
metadata prefix, and 111111-artwork supply. Hatching does not require replacement,
retirement, sales pauses, live test mints, or onchain transactions.

### 1. Discover the target and check for an existing batch

For the default storefront, read `https://api.mons.shop/ethereum/111k/config` with
`Origin: https://mons.shop` and a browser-like User-Agent. Resolve other explicit
targets from the registry and the requested chain/contract, then inspect:

```sh
hatch_deployment='<selected deploymentId>'
npm run ethereum-reveal-control -- status --deployment-id "$hatch_deployment"
```

Check the selected registration's chain, contract, metadata URI, deployment block,
expected state, both revisions, and pending `catalogUpdateId`. Match global config
only for the storefront target. Other targets use their scoped registry/API/CDN
identity while the global storefront identity stays unchanged. For a new batch, live
`effectiveCatalogVersion`/`effectiveCatalogSha256` must match the local predecessor.
If null, resolve the immutable origin `catalogVersion` through the catalog registry.
Never reuse historical deployment IDs, revisions, or hashes as current values.

Compare the source SHA-256 with retained bundles and deployment journals before
preparing. Resume ordinary interruptions with the exact bundle and original `expectedRevision`;
see Recovery for failed initial claims. For a batch completed on the selected deployment,
skip to verification below. First application of an existing bundle to another explicitly
requested deployment uses that deployment's current revision and must match the bundle's
frozen predecessor. Finish pending work first; never overwrite or rerandomize a bundle.

### 2. Inspect and freeze a new batch

Input is a complete relative-path-to-`[width, height, collectionBlock]` JSON object;
legacy `[width, height]` pairs remain supported for catalog construction. The
response lookup requires labels for every entry. Existing paths, dimensions, and
recorded block labels stay unchanged; primary IDs append without gaps. Alternatives add
no slots. No new primary artworks or incompatible input means no hatch: report the
validation result, without silently switching to a replacement deployment.

Media must already be published under `https://cdn.lil.org/nft/111k/`, including
required MP4/GLB companions and `{family}/json/v0/{assetId}.json` trait sources.
The manifest workflow does not upload or render missing media.

For a new batch, run from the repository root:

```sh
hatch_source='/absolute/path/to/111k.json'
npm run ethereum:catalog-update -- inspect --source "$hatch_source"
hatch_catalog='<targetVersion returned by inspect>'
hatch_bundle="releases/111k-catalog-${hatch_catalog#111k-}"
npm run ethereum:catalog-update -- prepare --source "$hatch_source" --catalog-version "$hatch_catalog" --bundle "$hatch_bundle"
npm run ethereum:catalog-update -- verify --bundle "$hatch_bundle"
```

Inspect derives the next version without writes/network access; review additions,
egg count, cutoff, and supply. Prepare freezes exact sources, catalogs, nonce, and
one cryptographically shuffled bijection before reading allocation states. It pairs
highest remaining egg IDs with new artworks equally across free, reserved, and
revealed eggs. Identical preparation is idempotent; changed inputs fail.

After freezing, capture both original revisions, contract identity, frozen evidence,
and fresh affected/unaffected samples using this batch's mapping. For the active Sepolia
storefront, call `inspectReplacement` through `withEthereumRevealMaintenance` in
`scripts/shared/ethereumRevealMaintenance.ts` before apply and after completion, with
no pending update. Postflight reuses preflight `frozenThroughMs` with the **current**
registry revision; catalog apply/verify retain the **original** operation revision.
Other explicit targets use registry/API/CDN snapshots; this helper is Sepolia-only.

### 3. Promote, validate, and deploy

Promote a new catalog below. For an older retained bundle, skip promotion and keep
the newer local default; require both exact catalog hashes in the local registry
and deployed Worker. Run the asset check in either case.

```sh
npm run ethereum:catalog-update -- promote --bundle "$hatch_bundle" --write
npm run ethereum:assets -- collection-blocks --source "$hatch_bundle/source.json"
npm run check:ethereum-assets
```

Promotion changes the local default and retains the exact predecessor; it does not
activate the live pool. Update current-catalog counts, boundary/ratio expectations,
supported-version assertions, and allocation docs. Preserve historical fixtures.
Generate the collection-block supplement against the promoted current catalog,
using the bundle's frozen labeled source. When resuming an older retained bundle with
a newer local default, keep the newer supplement and run its check instead of
regenerating from the older source. The asset check rejects missing current-catalog
bindings before deployment. This supplement changes reveal API responses only;
it does not change catalog hashes or publish metadata.

Immediately before deployment, re-read the live storefront config and require the
chain, contract, metadata URI, and deployment block in `cloud/workers/api/wrangler.jsonc`
to match it. Resolve drift before deploying; never repoint the storefront at a separate
hatch target.

```sh
npm run typecheck:tools
npm run test:ethereum:e2e
npm run deploy:api
npm run deploy
```

API deployment runs release gates and pending migrations, including OPS `0012`.
Require both exact catalog hashes in the deployed Worker and frontend revision/cache
support before activation; reload sessions predating that support. Existing pools
keep their effective catalog until explicit activation. Do not skip release gates.

Wait for the configured Durable Object code update delay after API deployment
(default [five minutes](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)).
Coordinators can retain old code meanwhile. On an early catalog-support rejection,
check the deployment and retry the same bundle after the delay; do not change hashes
or force a reset. This is separate from the postactivation observation period.

### 4. Apply and follow through to completion

Recheck live identity and predecessor before the first apply. For a new operation,
use its captured registry revision; for a resume, use the journal or recorded apply
request's original revision. Investigate unexpected state changes before continuing.

```sh
hatch_revision='<original expected registry revision for this operation>'
npm run ethereum:catalog-update -- apply --bundle "$hatch_bundle" --deployment-id "$hatch_deployment" --expected-revision "$hatch_revision" --write
```

Before remote mutation, apply checks every new image and companion with bounded
public requests, content types, and CORS. It stages all traits and allocation while
reads/reveals continue. Activation atomically installs the mapping and advances the
catalog revision; concurrent reveals resolve the same artwork. The coordinator is
authoritative immediately while its registry mirror catches up.

Metadata publishes at unchanged URLs with conditional writes and revisions blocking
stale eggs. API artwork can precede CDN/marketplace updates. Follow publication,
verification, a five-minute scheduler observation, re-verification, and obsolete
allocation/mapping-page cleanup. Only `phase: complete` finishes apply.

### 5. Verify and record the result

```sh
npm run ethereum:catalog-update -- verify --bundle "$hatch_bundle" --deployment-id "$hatch_deployment" --expected-revision "$hatch_revision"
npm run ethereum-reveal-control -- status --deployment-id "$hatch_deployment"
```

- Require complete verification through its final page, `published === frozen`,
  zero conflicts/retries, the selected registry in the intended state, and a cleared
  update pointer. Latest-batch completion requires its exact target hash and a catalog
  revision increase of one. For an older completed batch, verify its operation evidence
  with the original revision and accept a newer live catalog; do not promote or reapply it.
- Match global config to the registry for the storefront target; for other targets,
  verify their scoped API/CDN results and confirm the storefront identity stayed unchanged.
- Check the storefront and sampled public API/CDN results. Changed tokens must match
  the frozen mapping, media ratios, increased metadata revision, and unchanged crate
  and transaction provenance. Verify unaffected samples and original frozen evidence.
- API artwork carries base attributes; enriched CDN JSON contains `collection block`,
  base attributes, then source traits. Do not require those arrays to be identical.
  Use the existing attribute/metadata JSON helpers to preserve exact numeric literals.
- Retain the immutable bundle, journal, original apply request, deployment versions,
  validation results, before/after evidence, availability checks, and final summary.
  Report added artworks separately from `frozen` already-revealed eggs that hatched,
  remaining egg slots, and confirmed observation/cleanup completion.

Save marketplace-refresh calldata unsigned; submission is a separate explicit owner
action. The [v7 release](../../releases/111k-catalog-v7/README.md) illustrates evidence
formats, not values or cached scripts to reuse.

## Owner-authorized egg hatching

Owner hatching is a separate online operation. Keep the cutoff workflow above for
ordinary catalog expansion. The public owner-hatching supplement lists media and
source hashes; selected tokens, random assignments, and operation state stay only
in the backend. Do not export those assignments or use ordinary catalog promotion
to import grails. Partner request/response documentation is [owner_hatching_api.md](owner_hatching_api.md).

The first mainnet batch contains 175 DROWEE artworks (`animated/422`–`596`), with
PNG posters and GIF animations, and selects 350 already-minted eggs. The 175
ordinary hatches consume the shared non-egg inventory and replace those free
slots with previously unused egg artwork identities. Supply stays unchanged.
Future additions append immutable supplement batches; never rewrite an old batch.

Deploy the API and GIF-compatible existing media views before activation and wait
for the Durable Object code update delay. There is no sales or reveal pause.
Read the intended mainnet registry with `ethereum-reveal-control status`, choose a
stable batch ID, and preserve its original registry revision on every retry.
After a pause/reactivation, retry with that same revision once the deployment is
active again. New batches still require the current revision and catalog predecessor;
activated batches can finish after later registry or catalog updates.
There must be enough eligible minted eggs before selection. Choose the fresh egg
range from published, unused egg media; the backend rejects reused identities.

```sh
owner_hatch_deployment='<mainnet deploymentId>'
owner_hatch_batch='<stable batch id>'
owner_hatch_revision='<current registry revision>'
owner_hatch_fresh_start='<first unused egg artwork id>'
npm run ethereum-reveal-control -- status --deployment-id "$owner_hatch_deployment"
npm run ethereum:owner-hatching -- apply --deployment-id "$owner_hatch_deployment" --batch-id "$owner_hatch_batch" --expected-revision "$owner_hatch_revision" --source /absolute/path/to/111k.json --ready-count 350 --fresh-egg-start "$owner_hatch_fresh_start" --fresh-egg-count 175 --write
```

Apply checks the exact source hash, re-reads the mainnet registry, preflights all
PNG/GIF/trait and fresh-egg URLs with bounded HEAD requests, then resumes scanning,
staging, activation, and paged publication verification. Activation saves random
draws privately and checks at most 100 candidates per call against one canonical
activation snapshot. `activationChecked` and `activationSelected` show progress;
retries reuse saved draws, and current backend eligibility is checked before allocation.
Existing allocations never rerandomize. It waits through the
backend's five-minute scheduler observation, verifies again, and completes
temporary-state cleanup. Only `complete: true` finishes the operation. Errors
preserve its identity; inspect before retrying the same command. No onchain
transaction or marketplace-refresh transaction is sent.

```sh
npm run ethereum:owner-hatching -- inspect --deployment-id "$owner_hatch_deployment" --batch-id "$owner_hatch_batch" --expected-revision "$owner_hatch_revision"
npm run ethereum:owner-hatching -- verify --deployment-id "$owner_hatch_deployment" --batch-id "$owner_hatch_batch" --expected-revision "$owner_hatch_revision" --write
```

If a reorg interrupts an unfinished candidate scan, use `refresh-scan --write`
with the same deployment, batch ID, and original revision, then rerun `apply`.
It clears the incomplete candidate list and captures a new canonical scan snapshot.
It is rejected once scanning has finished or allocation has occurred.

If a reorg replaces the saved activation block, refresh the unallocated snapshot,
then rerun the original `apply` command. Saved draws and their order are preserved;
all validation results are cleared and checked again. Allocated batches cannot refresh.

```sh
npm run ethereum:owner-hatching -- refresh-scan --deployment-id "$owner_hatch_deployment" --batch-id "$owner_hatch_batch" --expected-revision "$owner_hatch_revision" --write
npm run ethereum:owner-hatching -- refresh-activation --deployment-id "$owner_hatch_deployment" --batch-id "$owner_hatch_batch" --expected-revision "$owner_hatch_revision" --write
```

`inspect` and `status` are read-only. `verify` also rechecks completed batches and
requires `--write` because it advances the backend audit cursor. It preserves the
completed phase and existing assignments. The CLI writes no local journal or assignment file and
prints only aggregate progress. Retain that sanitized completion result and
deployment versions. Publication conflicts require investigation before retrying.
`pendingEnrichment` and `failedEnrichment` report trait work for already-hatched
tokens. Verification requires both to be zero. Failed sources retry durably and
appear in health counts and throttled error logs; restore the source before retrying verification.

For a later cutoff hatch on a deployment with owner-hatching history, discover
eligible **egg artwork IDs** with `ethereum:catalog-update eligible-eggs`, using
the current registry revision and desired `--egg-cutoff`. Select exactly one
eligible ID per new ordinary artwork, all strictly above the cutoff, and pass
their JSON array to `prepare --egg-ids FILE --egg-cutoff N`. This freezes a v2
batch while preserving existing v1 bundles and hashes. Owner-ready and retired
eggs are excluded; a concurrent eligibility conflict aborts only that catalog
operation, without pausing normal reveals or owner hatching.

```sh
npm run ethereum:catalog-update -- eligible-eggs --deployment-id "$owner_hatch_deployment" --expected-revision '<current registry revision>' --egg-cutoff '<cutoff>'
npm run ethereum:catalog-update -- prepare --source /absolute/path/to/111k.json --bundle /absolute/path/to/catalog-bundle --egg-ids /absolute/path/to/selected-egg-ids.json --egg-cutoff '<cutoff>'
```

Ordinary imports exclude known grail media so they cannot be allocated twice.
New ordinary animated IDs beyond the excluded grail range currently fail closed:
that case requires sparse animated-catalog support before rollout. Other ordinary
artwork additions can use the explicit eligible-egg flow above.

### Empty mainnet pool rebuild

For an explicitly requested prelaunch mainnet rebuild, `ethereum:empty-pool`
can install the frozen target catalog directly when no artwork inventory has
been assigned or reserved. It preserves the contract, metadata prefix, immutable
origin registration, and existing relics. New artworks follow normal per-reveal
trait enrichment instead of retaining egg-migration mappings.

First inspect any existing catalog operation. Cancel only an unactivated operation
with its original revision and preserve its bundle and journal. Pause the selected
reveal deployment using its current registry revision. Freeze one new operation ID
of the form `empty-` followed by 32 hexadecimal characters and retain the paused
revision for every retry:

```sh
npm run ethereum:empty-pool -- apply --bundle "$hatch_bundle" --deployment-id "$hatch_deployment" --operation-id "$empty_operation" --expected-revision "$paused_revision" --write
npm run ethereum:empty-pool -- verify --bundle "$hatch_bundle" --deployment-id "$hatch_deployment" --operation-id "$empty_operation" --expected-revision "$paused_revision"
```

The private operation acquires a persistent SQL writer fence, drains for at least
65 seconds, and verifies zero assignments, reservations, publications, enrichment,
and pending recovery work. It also requires a closed onchain sale and zero minted
artworks. Existing work is never deleted to qualify. After exact 111111-slot
verification, activation atomically installs the new allocation base and releases
the fence; the registry resumes reveal availability. Five-minute observation and
bounded obsolete-generation cleanup must finish before `complete` is returned.

This path performs no exhaustive media availability scan. Keep the previously
verified media evidence or explicit operator waiver with the release. `inspect`
and `verify` are read-only. Retry interrupted `apply` with the same operation ID,
bundle, and original paused revision. Preactivation `cancel --write` preserves the
paused state and any newer administrative revision; an activated operation must
finish forward. Never use a reset or modify an immutable origin to recover it.
After activation, retain Worker support for the new allocation base; recover with
a forward fix rather than rolling back to code that predates empty-pool rebuilds.

### Recovery

Inspect and verify are read-only. After an interruption, inspect before retrying:

```sh
npm run ethereum:catalog-update -- inspect --bundle "$hatch_bundle" --deployment-id "$hatch_deployment" --expected-revision "$hatch_revision"
```

Resume ordinary interruptions with the same apply command, bundle, batch hash,
and original revision.
Never edit the journal or frozen files. Fix missing media/traits upstream before
resuming; investigate metadata conflicts without overwriting foreign bytes. Partial
publication does not stop unrelated reveals. After activation, finish the batch.

If a concurrent revision change invalidated the initial claim, confirm no activation
or registry ownership (`catalogUpdateId` is null), and preserve any concurrent pause:

- `inspect` reports `unstarted`: no server record exists; skip cancellation.
- An unactivated server record exists: cancel it with the original revision first.

Cancel only an existing record, for that recovery or an explicit preactivation cancellation:

```sh
npm run ethereum:catalog-update -- cancel --bundle "$hatch_bundle" --deployment-id "$hatch_deployment" --expected-revision "$hatch_revision" --write
```

For either failed-claim case, or to retry a cancellation, prepare from the frozen bundle:

```sh
npm run ethereum:catalog-update -- prepare --from-bundle "$hatch_bundle" --bundle '<new-attempt-directory>'
```

Keep the original bundle. The new attempt preserves the exact mapping/catalog
with a new nonce, including after promotion. Use the new bundle
directory and the deployment's current registry revision. Do not cancel ordinary
network interruptions or an activated batch.

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
  "catalogVersion": "111k-v9",
  "publicationDirectory": "./published-metadata"
}
```

Replace both deployment-ID placeholders with the chosen ID, and replace the address and zero deployment block with the actual receipt values. `publicationDirectory` is required for new registrations and is relative to the manifest. It must contain the complete generated and validated publication, including all seven templates and `templates/artwork.json`. Registration verifies all 344984 remote objects and public samples against that snapshot; an 18-relic-only publication is rejected before registration. An optional `templateFile` must match the snapshot exactly. Mainnet uses chain ID `1`, its own contract and globally unique ID, and either the first collection's `111k/` root or a fresh `111k/<deploymentId>/` prefix. Both manifests may reference the same generated revision.

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

All batches in a claim window share a 25-second deadline within the coordinator's 60-second publication lease; an expired read cannot start a new write. If R2 I/O stalls until the deadline, the stateless publisher resets itself so abandoned requests cannot accumulate alongside later batches. The allocation ledger remains intact, and its durable outbox retries through a fresh publisher instance. A remotely completed conditional write is reconciled against the same frozen bytes on retry. Bounded batches continue through alarms without requiring a browser to remain open. During this initial media publication, an existing object must match the approved placeholder or the exact frozen base metadata. Unexpected bytes are quarantined as a conflict.

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

## Artwork attributes and Sepolia backfill

A successful media publication enrolls each painting, video, 3D model and animated work in the deployment’s durable attribute queue. Alarms dispatch up to four concurrent enrichment jobs. A dedicated publisher fetches `{family}/json/v0/{assetId}.json` from the 111k media CDN using the assigned asset ID. As each job finishes, its slot can take another token while slower requests continue. The first attribute is the source’s `collection block`, followed by the frozen base attributes and the source attributes in their original order. Eggs keep their base traits.

The coordinator saves the enriched JSON and SHA-256 before a dedicated publisher conditionally replaces the exact base object in R2. A retry verifies the stored JSON content type, unencoded body and no-store cache policy on matching enriched bytes. It conditionally repairs incorrect headers before completing the job. Transient source and storage errors retry with backoff. The watchdog’s `enrichment` counts and `ethereum_reveal_enrichment_error` events distinguish source failures, invalid input, write failures and object conflicts. Retirement drains both publisher instances. Replacement verification preserves the frozen assignment fingerprint and checks the recorded enriched checksum when a sample advances.

For previously published artwork, run a read-only count against the intended active Sepolia deployment. The result includes its revision and counts for missing jobs, invalid trait sources and R2 conflicts. The `conflictRechecks` count tracks previously conflicted objects awaiting confirmation in R2, including rechecks delayed by storage errors.

```sh
target_manifest='<active-sepolia-reveal-manifest.json>'
npm run ethereum-reveal-control -- backfill-attributes --manifest "$target_manifest"
```

To enqueue the missing jobs, add `--expected-revision <revision>` and `--write` to that command. Each page uses the same queue as new media publications. First attempts for new reveals take priority over historical jobs. Rerunning after an interruption skips existing jobs. The command reports enrollment counts. Publication continues in the background.

After correcting a trait source or restoring a conflicted R2 object to the exact frozen base or staged enriched bytes, add `--retry-blocked` to preview recovery for the same deployment. Add `--expected-revision <revision>` and `--write` to requeue its eligible `invalid` and `conflict` jobs. The report’s `requeued` count covers those transitions. Invalid jobs without a staged target fetch the source again. Before retrying a staged write, the worker verifies the bytes against their stored SHA-256 and any prior acknowledgment. Inconsistent ledger evidence leaves the job in conflict and R2 untouched. Their conflict continues to block replacement verification through requeue and transient storage errors until the publisher confirms the exact enriched bytes. An object that still differs from both authorized versions is flagged again.

If an already enriched token needs repair, use `--recheck-token <tokenId>` on the same backfill command. The preview reports whether that token has an acknowledged v0 target. With the expected revision and `--write`, the publisher checks the recorded bytes and headers, restores the exact target over the frozen base, and flags foreign or missing content as a conflict. A write-mode checksum failure records a conflict and reports `conflict: 1`, preserving the stored target and acknowledgment for investigation. Replacement cleanup waits for confirmation. This single-token operation retains the original acknowledgment and checksum.

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
can continue normally. A known R2 conflict on any enriched artwork blocks
retirement. Planning and write runs checkpoint each sampled artwork’s enrichment
when its R2 and CDN bytes match, even if another request fails.
Old publication may finish while paused; its deletion
inventory is sealed only after retirement, draining, and verified storage purge.
Each deletion window is acknowledged before advancing, and a fresh listing must
prove the old prefix empty. The finalizer then verifies the replacement, prunes
owned old artifacts, and repeats the retirement checks after five minutes.
After the final artifact check, it rechecks the replacement ledger and sampled
metadata before recording `complete: true`.

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

The [cleanup record](../../releases/111k-testnet-cleanup-2026-11-08/README.md) records
the completed removal of deployments preceding v16, including its exact manifests,
verification evidence, and historical tooling revision. The fixed v16
`plan`/`apply`/`verify` commands and one-off artifact pruner have been retired from
the active tools. Use replacement finalization above for current releases.

The permanent deployment ownership records and retired-preview publication block
remain active. Retirement never frees a deployment ID or metadata prefix for reuse.

After purging, do not roll back to Worker or publication tooling that ignores `retired_at_ms`, including the historical catalog-only retirement implementation. Preserve the Commerce retirement fences and their recovery support as well. Older code could recreate removed prefixes or accept work for deleted ledgers. Use a forward fix that preserves the permanent marker and writer guards. Never reset the current collection or restore an older active ledger without reconciling every published immutable assignment.

## Local development

`npm run dev:ethereum:api` provisions local Anvil reveal inventory automatically. Local bindings use isolated SQLite and R2; public CDN baseline metadata reads remain read-only. Restarting the local API discards its local reveal state, so restart Anvil and redeploy the contract together. Local deployment uses the committed default metadata namespace; set `ETHEREUM_111K_LOCAL_METADATA_BASE_URI` only when selecting another complete published baseline. Custom local prefixes must be canonical and have published baseline metadata. Local artwork is checked against its local ledger even if another collection has already revealed the shared CDN metadata. Local contracts also start closed; use the Anvil owner to call `setSaleActive(true)` explicitly before test purchases.
