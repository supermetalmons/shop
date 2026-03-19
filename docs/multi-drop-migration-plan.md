# Multi-Drop Migration Plan (Firebase + Shop + Onchain)

Status: Draft v3 (decision-locked + deep risk patches)  
Last updated: 2026-03-19  
Scope: migrate from single-drop setup to multi-drop shop without risking current production data

## Why this document

The current system is built around one active drop. This document captures:

1. The highest-value findings from the codebase audit.
2. Risk-driven design decisions needed before implementation.
3. A phased migration plan with measurable go/no-go criteria.
4. Rollback strategy that keeps recovery fast and deterministic.

No implementation changes are included yet. This is a planning artifact for careful iteration.

## Locked Decisions (Resolved)

1. Onchain strategy: **new program per drop** (no shared multi-config program path).
2. `dudeId` uniqueness: **per-drop**, not global across all drops.
3. API/data scoping: **explicit drop scoping** for drop-sensitive flows.

## Audit Findings (Current State)

### 1) Onchain program is effectively single-drop

- Program config appears singleton-seeded (`b"config"`), with account constraints tied to one config.
- Global constraints like `MAX_DUDE_ID=999` and `DUDES_PER_BOX=3` are not modeled per drop.
- Representative references:
  - `onchain/programs/box_minter/src/lib.rs:22`
  - `onchain/programs/box_minter/src/lib.rs:1579`
  - `onchain/programs/box_minter/src/lib.rs:1667`

Impact: multiple independent mintable drops cannot be represented cleanly as-is.

### 2) Frontend and Cloud Functions bind to one deployed config

- Frontend uses a single deployed config object.
- Functions use one global `collectionMint`, `metadataBase`, `boxMinterProgramId`.
- Representative references:
  - `src/config/deployed.ts:29`
  - `functions/src/config/deployment.ts:37`
  - `functions/src/index.ts:213`
  - `functions/src/index.ts:216`
  - `functions/src/index.ts:222`

Impact: runtime behavior assumes one active drop context.

### 3) Firestore operational data is globally scoped (not drop-scoped)

- Collections like `boxAssignments`, `dudeAssignments`, `claimCodes`, `deliveryOrders` are global/non-namespaced.
- Representative references:
  - `functions/src/index.ts:1425`
  - `functions/src/index.ts:1700`
  - `functions/src/index.ts:2541`

Impact: collisions and ambiguous ownership once multiple drops exist.

### 4) Deploy tooling has destructive paths risky for production

- Deploy script includes wipe targets for global collections.
- Representative reference:
  - `scripts/deploy-all-onchain.ts:57`

Impact: accidental production data loss risk during migration activity.

### 5) Frontend cache/query keys and local storage are drop-agnostic

- Query keys and localStorage keys mostly key by wallet/session, not drop.
- Representative references:
  - `src/hooks/useInventory.ts:11`
  - `src/hooks/useMintProgress.ts:9`
  - `src/hooks/usePendingOpenBoxes.ts:11`
  - `src/App.tsx:36`
  - `src/App.tsx:62`
  - `src/App.tsx:98`

Impact: stale/cross-drop UI state and cache bleed in multi-drop mode.

### 6) Branding/media and behavior are hardcoded for one drop

- Drop-specific copy, links, assets, and fulfillment assumptions are embedded in components.
- Representative references:
  - `src/components/MintPanel.tsx:200`
  - `src/App.tsx:1955`
  - `src/FulfillmentApp.tsx:18`
- `MINTED_OUT_OVERRIDE = true` currently forces sold-out behavior:
  - `src/App.tsx:202`

Impact: multi-drop UX cannot be configured safely per drop.

## Risk Hardening (Deep Review)

This section resolves the key concerns found in the review.

### A) Onchain readiness gate (prevents offchain-only false confidence)

Problem:
- The plan previously allowed offchain migration to progress without a hard onchain launch gate.

Safe plan patch:
1. Introduce `dropCapability` on `drops/{dropId}`:
   - `catalog_only` (visible, not mintable)
   - `mintable` (requires validated onchain support)
2. Enforce **program-per-drop** launch contract for every `mintable` drop:
   - unique `programId` per `dropId`
   - unique `configPda` derived from that `programId`
   - immutable `dropId -> programId` mapping once drop is active
3. Add readiness gate for `mintable`:
   - onchain config exists and is decodable
   - decoded onchain config matches drop registry for `collectionMint` and `metadataBase`
   - `receiptsMerkleTree` and `deliveryLookupTable` match approved deployment manifest/runtime config for that drop
   - required tx-size helper state (`deliveryLookupTable`) is configured or explicitly disabled for that drop
   - configured `sales.dudeIdRange` is validated against deployed program limits and drop supply math
4. Keep migration work unblocked by allowing offchain multi-drop support first, but with explicit capability constraints.

Acceptance criteria:
- No drop can be set to `mintable` unless onchain checks pass.
- No two active drops share the same `programId`.
- Product/ops cannot accidentally activate unsupported mint flows.

### B) Dual-write consistency and failure handling

Problem:
- Dual-write was underspecified; partial writes could silently diverge sources.

Safe plan patch:
1. Define write modes:
   - `LEGACY_ONLY`
   - `DUAL_LEGACY_PRIMARY`
   - `DUAL_NAMESPACE_PRIMARY`
   - `NAMESPACE_ONLY`
2. During `DUAL_*` modes, write both documents in one Firestore transaction/batch unit when possible.
3. Attach deterministic `mutationId` and `updatedAt` on both records.
4. Emit a `migrationWriteAudit` event per mutation with `mode`, `dropId`, and result.
5. For flows with external side effects (onchain submission, fulfillment enqueue), use a transactional outbox:
   - write domain mutation + outbox item in one Firestore transaction
   - process outbox asynchronously with idempotency key = `mutationId`
   - mark side effect state (`pending|applied|failed`) with retries and dead-letter capture
6. On write failure, fail request (no silent partial success).

Acceptance criteria:
- No acknowledged mutation exists in only one store without an audit failure record.
- Retry is idempotent by `mutationId`.
- No external side effect is applied without a committed source mutation and audit trail.

### C) Read precedence conflict strategy

Problem:
- "namespaced first" can return stale data without conflict detection.

Safe plan patch:
1. Define an explicit default read authority flag:
   - `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT=legacy|namespace`
2. Add optional canary override for segmented rollout:
   - cohort routing (wallet allowlist hash) decides if request is canary
   - canary requests may use `drops/{dropId}/migrationFlags/CANARY_READ_AUTHORITY`
   - non-canary requests always use `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT`
3. In transition, each request reads from exactly one authority source.
4. Shadow-read the non-authority source asynchronously and record parity mismatches.
5. Cutover default authority only after mismatch rate is under threshold.

Acceptance criteria:
- No endpoint performs ambiguous precedence logic in production.
- Every authority switch is controlled by explicit flag changes and cohort rules.

### D) Claim code semantics (uniqueness + race-safety)

Problem:
- Claim code model was left ambiguous and vulnerable to wrong-drop or double-claim issues.

Safe plan patch:
1. Keep `claimCodes/{code}` global for code-only lookup compatibility.
2. Introduce versioned canonicalization (`codeCanonical`, `codeNormalizationVersion`) with fixed contracts:
   - `v1_numeric_legacy`: strip non-digits (compat with existing 10-digit codes)
   - `v2_text`: Unicode NFKC + trim + uppercase
3. Store both `codeRaw` and `codeCanonical`; keep `codeRaw` for display only.
4. Enforce canonical uniqueness with a lock document (`claimCodeCanonical/{codeCanonical}`) created transactionally.
5. Add immutable `dropId`, `codeVersion`, and `codeNormalizationVersion` fields.
6. Adopt a two-step redemption state machine compatible with user-signed claim transactions:
   - `available` -> `pending_redeem` (reservation in transaction during tx preparation)
   - `pending_redeem` -> `redeemed` (finalization after onchain confirmation)
   - `pending_redeem` -> `available` (reservation expiry or explicit rollback path)
7. Reservation transaction requirements:
   - current `status` must be `available`
   - request `dropId` must match code `dropId`
   - persist `reservationId`, `reservedByWallet`, `reservedAt`, `reservationExpiresAt`
8. Finalization requirements:
   - idempotent by `reservationId` and/or claim tx signature
   - verify expected onchain side effects before marking `redeemed`
   - persist `redeemedAt`, `redeemedByWallet`, and finalized tx reference
9. Add unique invariant: one code can transition to `redeemed` only once.
10. Compatibility semantics:
   - code-only lookup compatibility is preserved at storage/index level
   - drop-sensitive claim mutation endpoints require explicit `dropId`
   - temporary missing-`dropId` mutation fallback is allowed only when backend deterministically derives exactly one drop from immutable lookup data (for example claim code doc), never by implicit/default drop
   - fallback uses global compatibility router policy + client allowlist controls before deadline
   - after compatibility deadline (`COMPAT_DROPID_REQUIRED_AFTER_DEFAULT` or approved per-drop override), no claim mutation path can proceed without `dropId`
11. Define explicit claim mutation handshake:
   - `prepareClaimRedemption` reserves code and returns `reservationId`, `reservationExpiresAt`, and prepared tx
   - client submits tx, then calls `finalizeClaimRedemption(dropId, reservationId, signature)`
   - `finalize` is idempotent by `reservationId` and tx signature
   - sweeper verifies chain outcome for expired reservations before releasing back to `available`
12. Reservation operating defaults:
   - `CLAIM_RESERVATION_TTL_SECONDS = 900` (15 minutes)
   - reservation sweeper interval = 60 seconds
   - recovery SLA after expiry = 300 seconds

Acceptance criteria:
- Zero successful cross-drop redemptions.
- Zero double redemption for same code.
- Zero canonical collisions unresolved before cutover.
- Zero stale `pending_redeem` records beyond reservation TTL without recovery action.
- No reservation remains unresolved solely because client finalization callback was lost.
- No compatibility path can choose a default drop when `dropId` is absent.

### E) Canary/cutover metrics are measurable

Problem:
- Exit criteria were qualitative and hard to enforce under pressure.

Safe plan patch:
1. Define minimum cutover SLOs (rolling 24h unless noted):
   - Callable function error rate `< 0.5%`
   - Hard parity mismatches `= 0` (ownership, assignment, redemption)
   - Soft parity mismatches `< 0.1%`
   - Fulfillment enqueue mismatch `= 0`
   - p95 latency regression `< 20%` vs pre-migration baseline
2. Require minimum traffic sample before SLO evaluation (to avoid low-volume false confidence).
3. Add automatic rollback trigger if thresholds are breached for 15 continuous minutes.
4. Add anti-flap policy:
   - once rollback triggers, lock rollout for `ROLLBACK_COOLDOWN_MINUTES`
   - require explicit incident owner approval to resume

Acceptance criteria:
- Go/no-go decision is objective and logged.
- Rollback cannot oscillate repeatedly without human sign-off.

### F) Security model and authorization matrix

Problem:
- Rules/index section did not include explicit auth test coverage for drop-scoped behavior.

Safe plan patch:
1. Keep Firestore client rules deny-all (backend-only remains true).
2. Enforce drop authorization in callable functions:
   - caller can mutate only permitted wallet/profile data
   - `dropId` must exist and be active for requested action
   - admin flows require elevated auth context
3. Add auth matrix tests per endpoint (positive + negative cases).

Acceptance criteria:
- No endpoint accepts unknown/inactive `dropId`.
- No cross-wallet or cross-drop write is accepted.

### G) Compatibility sunset is mandatory

Problem:
- Omitted-`dropId` fallback had no removal deadline.

Safe plan patch:
1. Introduce global compatibility router policy (used before drop context is known):
   - `migration/global/COMPAT_DROPID_REQUIRED_AFTER_DEFAULT` (UTC timestamp)
   - `migration/global/ALLOW_LEGACY_DROPID_FALLBACK_DEFAULT` (`true|false`)
   - `migration/global/LEGACY_CLIENT_ALLOWLIST` (approved version/build policy)
2. Allow per-drop override at `drops/{dropId}/migrationFlags/COMPAT_DROPID_REQUIRED_AFTER` for exceptional rollout cases.
3. Require callable payload `clientInfo` on all drop-sensitive requests:
   - `clientInfo.version`
   - `clientInfo.build`
   - optional `clientInfo.platform`
4. For non-drop-sensitive endpoints, `clientInfo` is optional but recommended for telemetry.
5. Optionally mirror from headers for observability, but payload is authoritative.
6. Before deadline: missing `dropId` allowed only for approved legacy client versions and only where backend can deterministically derive one drop from immutable identifiers.
7. Add telemetry dashboard for missing `dropId` by client version and endpoint.
8. After deadline: missing `dropId` hard-fails with actionable error.
9. Keep read-only/code-only lookup compatibility if needed, but all drop-sensitive mutations remain `dropId`-required.
10. Compatibility exemption is fail-closed:
   - missing/invalid `clientInfo` is treated as unapproved client for mutation fallback decisions
   - unknown client versions are measured and explicitly allowlisted before any fallback is granted

Acceptance criteria:
- Compatibility mode cannot persist indefinitely.
- Cutoff is version-aware and does not blindside unknown client populations.
- Compatibility fallback never relies on implicit default-drop selection.

### H) Backfill ordering and prerequisites

Problem:
- Backfill could run before dual-write stabilization, creating blind spots.

Safe plan patch:
1. Backfill prerequisites:
   - `DUAL_LEGACY_PRIMARY` active
   - write audit stable for at least 7 days
   - parity mismatches within thresholds
2. Backfill runs with checkpointing and resumability.
3. Preserve application-level identifiers and timestamps (`createdAt`, `updatedAt`, business event times).
4. Explicitly do not rely on preserving Firestore system metadata (`createTime`, `updateTime`).
5. Backfill does not change authority source.

Acceptance criteria:
- Backfill completion does not change live-read behavior until cutover criteria pass.
- Timestamp semantics remain explicit and testable.

### I) Capacity and cost guardrails

Problem:
- Dual-write and shadow-read increase Firestore load and cost risk.

Safe plan patch:
1. Establish baseline for reads/writes/latency/cost before enabling migration flags.
2. Define headroom gate (for example, sustained peak load <= 60% of provisioned/observed safe capacity).
3. Ramp `ENABLE_SHADOW_READS` with sampling stages (`1% -> 10% -> 50% -> 100%`), not a single jump.
4. Add budget alerts and hard stop thresholds for abnormal spend.

Acceptance criteria:
- No phase advances without passing capacity and budget guardrails.

### J) Rollback boundary and irreversible checkpoint

Problem:
- Legacy cleanup can remove fast rollback options if done too early.

Safe plan patch:
1. Define explicit point-of-no-return (PONR) at start of final legacy code removal.
2. Before PONR, rollback is flag-based and immediate.
3. After PONR, rollback is restore-based (backup/snapshot recovery), slower by design.
4. Require written sign-off before crossing PONR.

Acceptance criteria:
- Rollback expectations are unambiguous in every phase.

### K) Drop-scoped assignment pool invariants (`dudePool`)

Problem:
- The assignment pool document used by runtime (`meta/dudePool`) was not represented in target schema/backfill.

Safe plan patch:
1. Add `drops/{dropId}/meta/dudePool` to target model.
2. Treat `dudePool` as **derived state**; canonical state is assignment docs.
3. During dual-write modes, keep pool updates and assignment writes in the same transaction when possible.
4. Add `rebuildDudePool(dropId)` job:
   - recompute from `dudeAssignments`
   - checkpoint progress
   - write audit summary (`expected`, `assigned`, `available`, `invalid`)
5. Add invariant checker:
   - no duplicate `dudeId` assignments inside a drop
   - assigned + available exactly covers configured per-drop range
   - no out-of-range IDs

Acceptance criteria:
- Every active drop has a valid `meta/dudePool`.
- Rebuild job is idempotent and can repair corruption without manual edits.

### L) Program-per-drop isolation contract

Problem:
- Seed collision risks were identified for multi-config-in-one-program paths.

Safe plan patch:
1. Lock architecture to **one program id per mintable drop**.
2. Enforce immutable mapping:
   - `drops/{dropId}.onchain.programId` cannot be changed after activation
   - one `programId` cannot be attached to multiple active drops
3. Require per-drop deployment manifest:
   - `programId`, `configPda`, `collectionMint`, `receiptsMerkleTree`, `deliveryLookupTable`, `metadataBase`
4. Add pre-launch verifier that checks manifest vs onchain account data.
5. If contract changes require a new program, create a new drop version instead of mutating active mapping.
6. Keep an explicit initializer/admin allowlist check in deployment tooling (current program initialization is signer-restricted).

Acceptance criteria:
- No shared `programId` across active mintable drops.
- Each mintable drop can be rolled back/disabled without affecting other drops.

### M) Strict drop scoping for identifiers and APIs

Problem:
- Several current flows rely on globally addressed docs/IDs (for example `deliveryId`-only references).

Safe plan patch:
1. Define canonical identity tuples for drop-sensitive resources:
   - delivery order: `(dropId, deliveryId)`
   - assignment: `(dropId, boxAssetId)` and `(dropId, dudeId)`
   - mutable claim operations: `(dropId, codeCanonical)`
2. Require explicit `dropId` on all drop-sensitive callable requests.
3. Namespace storage under `drops/{dropId}/...` for drop-scoped operational data.
4. Responses must echo `dropId` for downstream cache and UI consistency.
5. Admin/fulfillment list APIs are scoped by explicit `dropId`; cross-drop views require dedicated admin-only endpoints.
6. Replay/redeem checks must use drop-scoped keys (for example `(dropId, codeCanonical)` or expected receipt asset id), never global `dudeId` alone.

Acceptance criteria:
- No production mutation endpoint accepts implicit/default drop context.
- No collisions when two drops contain overlapping `deliveryId` or `dudeId` values.
- No false "already claimed/used" decisions caused by same `dudeId` existing in a different drop.

### N) Runtime cache keying and invalidation

Problem:
- Existing singleton caches can leak stale/wrong context after multi-drop enablement.

Safe plan patch:
1. Key all server-side runtime caches by `dropId` plus onchain tuple (`programId`, `collectionMint`, `receiptsMerkleTree`).
2. Key frontend query keys and localStorage keys by `dropId` in addition to wallet/session identifiers.
3. Introduce drop config revision (`dropConfigVersion`) and invalidate caches on revision bump.
4. Add canary assertion logs for cache key collisions or mixed-drop hits.

Acceptance criteria:
- Zero observed cross-drop cache hits in canary and full rollout windows.
- Cache invalidation is deterministic on drop config change.

### O) Destructive tooling guardrails (script-level)

Problem:
- Current deploy tooling still allows global destructive actions with lightweight confirmation.

Safe plan patch:
1. Require explicit env gates for any destructive command:
   - `ALLOW_DESTRUCTIVE=true`
   - `DESTRUCTIVE_PROJECT_ALLOWLIST` contains target project
2. Add production-specific second gate:
   - `ALLOW_PROD_DESTRUCTIVE=true` required for production project ids
3. Replace generic collection wipes with drop-targeted operations requiring explicit `dropId`.
4. Require typed confirmation phrase including project + drop (`DELETE <projectId> <dropId>`).
5. Default all destructive code paths to disabled in CI/non-interactive contexts unless gates are present.
6. During migration (mixed legacy + namespaced data), prohibit recursive collection deletion commands in production.
7. Require two-step destructive execution:
   - dry-run count by `dropId` (recorded in logs)
   - execute only if dry-run count matches expected approval window
8. Add deploy-manifest lock in tooling:
   - if `drops/{dropId}.status=active`, script must refuse `programId` replacement for that `dropId`
   - introducing a new program requires a new `dropId` (versioned drop) plus explicit activation workflow

Acceptance criteria:
- Production destructive paths cannot execute from default script invocation.
- Any destructive operation is explicit, auditable, and drop-scoped.
- No production command can recursively wipe mixed-era collections during migration phases.
- Active drop `programId` cannot be rotated by default deploy paths.

## Safety Invariants (Non-Negotiable)

1. No destructive operation on production without explicit, environment-validated opt-in.
2. Every mutation is idempotent and traceable (`mutationId`, timestamp, dropId).
3. One source of truth is active at any time (by explicit flag), never implicit precedence.
4. Rollback path must exist before enabling new write/read modes.
5. Client-direct Firestore access stays denied.
6. External side effects must be driven by idempotent outbox processing.
7. Irreversible cleanup requires explicit PONR sign-off.
8. Drop-sensitive mutation requests must carry explicit `dropId`, except time-boxed compatibility paths that deterministically derive a single drop from immutable identifiers (never implicit default drop).
9. Active mintable drops must use unique `programId` values.
10. `dudeId` uniqueness is enforced per-drop, never globally across drops.
11. Claim codes can be redeemed only through the reservation + finalization state machine.

## Target Data Model (Draft)

### Drop registry

- `drops/{dropId}`
  - `status` (`draft|active|ended|disabled`)
  - `dropCapability` (`catalog_only|mintable`)
  - `display` (title, subtitle, assets, links)
  - `onchain`
    - required for `mintable`: `programId`, `configPda`, `collectionMint`, `metadataBase`, `receiptsMerkleTree`
    - optional: `deliveryLookupTable` (explicitly nullable if disabled)
    - immutable after activation: `programId`
  - `sales`
    - pricing, windows, limits
    - `dudeIdRange` (per-drop uniqueness bounds; example `1..999`)
  - `fulfillment` (policy/version flags)

### Drop-scoped operational data

- `drops/{dropId}/boxAssignments/{boxAssetId}`
- `drops/{dropId}/dudeAssignments/{dudeId}`
- `drops/{dropId}/deliveryOrders/{deliveryId}`
- `drops/{dropId}/meta/dudePool`
- Optional: `drops/{dropId}/mintProgress/{wallet}`

### Claim codes

- `claimCodes/{code}` (global)
  - Global doc id is retained for lookup compatibility only; mutation APIs remain explicitly drop-scoped.
  - Required: `dropId`, `status`, `codeVersion`, `codeNormalizationVersion`, `createdAt`, `codeRaw`, `codeCanonical`
  - `status`: `available|pending_redeem|redeemed`
  - Reservation fields (for `pending_redeem`): `reservationId`, `reservedByWallet`, `reservedAt`, `reservationExpiresAt`
  - Finalization fields (for `redeemed`): `redeemedByWallet`, `redeemedAt`, `redeemTx`
  - Immutable: `dropId`, `codeVersion`, `codeNormalizationVersion`
- `claimCodeCanonical/{codeCanonical}` (uniqueness lock)
  - Required: `claimCodeRef`, `createdAt`

## Flag Model (Control Plane)

Compatibility router flags can be evaluated before `dropId` is resolved. Read/write authority flags are per-drop at `drops/{dropId}/migrationFlags/*`.

- Global compatibility router flags:
  - `COMPAT_DROPID_REQUIRED_AFTER_DEFAULT`: UTC timestamp
  - `ALLOW_LEGACY_DROPID_FALLBACK_DEFAULT`: `true|false`
  - `LEGACY_CLIENT_ALLOWLIST`: approved version/build policy
- Per-drop migration flags (`drops/{dropId}/migrationFlags/*`):
  - `WRITE_MODE`: `LEGACY_ONLY|DUAL_LEGACY_PRIMARY|DUAL_NAMESPACE_PRIMARY|NAMESPACE_ONLY`
  - `READ_AUTHORITY_DEFAULT`: `legacy|namespace`
  - `CANARY_ROUTING_MODE`: `off|wallet_allowlist`
  - `CANARY_READ_AUTHORITY`: `legacy|namespace`
  - `ALLOW_LEGACY_DROPID_FALLBACK_OVERRIDE`: optional `true|false`
  - `COMPAT_DROPID_REQUIRED_AFTER`: optional per-drop override timestamp
  - `CLAIM_RESERVATION_TTL_SECONDS`: integer (default `900`)
  - `ENABLE_SHADOW_READS`: `true|false`
  - `SHADOW_READ_SAMPLE_RATE`: `0..1`
  - `ROLLBACK_COOLDOWN_MINUTES`: integer (for anti-flap)
- Global (not per-drop): incident lock metadata

Rule:
- Only one write/read authority change per drop at a time.
- Each flag change requires monitoring confirmation before next change for that drop.
- Missing-`dropId` compatibility decisions use global router policy first.
- Per-drop read/write authority flags must be read from one consistent snapshot (single control document read or equivalent snapshot materialization), never from independently fetched flag docs in the same request.
- Per-drop flag updates must be atomic and revisioned (`migrationControlRevision`, `updatedAt`, `updatedBy`) to prevent mixed-state cutovers.
- Request authority resolution order (after `dropId` context is resolved):
  1. If canary routing is enabled and request is in canary cohort, use `CANARY_READ_AUTHORITY`.
  2. Otherwise use `READ_AUTHORITY_DEFAULT`.

## Migration Plan (Phased, Production-Safe)

### Phase 0: Safety rails first

1. Back up production Firestore (full export + metadata snapshot).
2. Perform restore drill in isolated project.
3. Guard/disable destructive wipe paths in deploy scripts for production.
4. Add destructive gates:
   - `ALLOW_DESTRUCTIVE=false` default
   - `DESTRUCTIVE_PROJECT_ALLOWLIST` match required
   - `ALLOW_PROD_DESTRUCTIVE=true` required for production project IDs
5. Require typed confirmation including project + drop (`DELETE <projectId> <dropId>`).
6. For mixed-era datasets, disable recursive whole-collection deletes; allow only drop-targeted cleanup jobs filtered by `dropId` with dry-run counts.
7. Add deploy-manifest lock check to scripts so active drop `programId` cannot be replaced without creating a new versioned `dropId`.

Exit criteria:

- Restorable backup exists and restore drill evidence is captured.
- Production deploy scripts cannot wipe data by default.
- Destructive commands are blocked in non-interactive/CI runs unless all gates are explicitly set.
- Legacy/global cleanup paths are disabled until data is fully drop-namespaced.
- Active drop `programId` mapping is tooling-enforced as immutable.

### Phase 1: Registry and schema contract

1. Create `drops/{dropId}` schema.
2. Seed current live drop as `legacyDropId`.
3. Add `dropCapability`, `status`, and `sales.dudeIdRange` constraints.
4. Add required `onchain` fields for `mintable` drops (`programId`, `configPda`, `collectionMint`, `metadataBase`, `receiptsMerkleTree`; optional `deliveryLookupTable`).
5. Define canonical `dropId` format and immutability policy (`dropId -> programId` immutable after activation).
6. Create namespaced operational paths including `drops/{dropId}/meta/dudePool`.

Exit criteria:

- Drop registry exists and validates all active drops.
- Schema validators enforce program-per-drop and per-drop `dudeId` range rules.
- `mintable` drops cannot pass validation unless `dudeIdRange` is compatible with deployed onchain constraints.

### Phase 2: Context plumbing and compatibility controls

1. Add backend `resolveDropContext(dropId)` with strict validation.
2. Add compatibility flags and read/write mode flags.
3. Require explicit `dropId` for all drop-sensitive endpoints (compat fallback only for approved legacy clients and only when backend can deterministically derive one drop from immutable identifiers).
4. Require request payload `clientInfo` (`version`, `build`, optional `platform`) and start telemetry by version.
5. Define canonical scoped identifiers for APIs (`dropId + resourceId`).
6. Define and set global `COMPAT_DROPID_REQUIRED_AFTER_DEFAULT` (plus any approved per-drop override) before leaving this phase.

Exit criteria:

- All drop-sensitive endpoints resolve context through one shared path.
- Compatibility sunset date is committed in config.
- Missing `dropId` and legacy traffic are measurable by client version.
- Drop-sensitive requests cannot proceed with implicit/default drop context.
- Missing `dropId` compatibility routing is deterministic and auditable.

### Phase 3: Dual-write foundation (legacy primary)

1. Enable `drops/{dropId}/migrationFlags/WRITE_MODE=DUAL_LEGACY_PRIMARY`.
2. Keep `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT=legacy`.
3. Add `mutationId`, `updatedAt`, and write-audit emission.
4. Add claim-code reservation/finalization flow (`available -> pending_redeem -> redeemed`) with TTL sweeper and explicit `prepareClaimRedemption` / `finalizeClaimRedemption` handshake.
5. Add transactional outbox for any external side effects.
6. Ensure write failures fail closed (no silent partial success).
7. Update assignment writes to keep `dudeAssignments` and `meta/dudePool` consistent inside transactional boundaries.
8. Key runtime caches by `dropId` + onchain tuple (no singleton cache keys).

Exit criteria:

- Dual-write success rate meets SLO.
- Idempotent retry behavior is verified.
- Outbox processing is idempotent and dead-letter monitoring is active.
- No stale claim reservations beyond configured TTL without automated recovery.
- Lost client finalize callbacks do not leave claims permanently stuck in `pending_redeem`.

### Phase 4: Backfill (idempotent, checkpointed)

Prerequisites:

- 7-day stable dual-write window.
- Parity mismatch within thresholds.

Execution:

1. Copy legacy documents into namespaced paths preserving IDs and application timestamps (`createdAt`, `updatedAt`, business event times).
2. Add missing `dropId` fields where required.
3. Rebuild `drops/{dropId}/meta/dudePool` from `dudeAssignments` and persist audit summary.
4. Run with checkpoint + resume support (per-drop checkpoints).
5. Run dry-run in staging clone first.
6. Do not attempt to preserve Firestore system metadata (`createTime`, `updateTime`).

Exit criteria:

- Backfill parity checks pass.
- No change to live authority source yet.
- Per-drop assignment invariants (`assigned + available = dudeIdRange`) pass.

### Phase 5: Shadow parity and security verification

1. Enable `drops/{dropId}/migrationFlags/ENABLE_SHADOW_READS=true` while keeping `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT=legacy`.
2. Ramp `drops/{dropId}/migrationFlags/SHADOW_READ_SAMPLE_RATE` (`1% -> 10% -> 50% -> 100%`) while observing quota/cost guardrails.
3. Compare authority vs mirror responses for critical flows (assignment, claim status, delivery status, fulfillment views).
4. Execute endpoint auth matrix tests (drop existence/status, wallet ownership, admin scope, scoped identifiers).
5. Run cache-segregation checks (no mixed-drop cache hits for backend/frontend keys).
6. Deploy necessary Firestore indexes/rules updates.

Exit criteria:

- Hard parity mismatches remain zero.
- Auth matrix passes for all critical endpoints.
- Capacity and budget guardrails remain within thresholds.
- Cross-drop cache-collision count remains zero.

### Phase 6: Frontend drop-awareness

1. Add active drop resolver in UI (URL/config/API).
2. Pass explicit `dropId` and `clientInfo` in all drop-sensitive requests.
3. Treat drop-sensitive entities as scoped tuples in state (`dropId + deliveryId`, etc.).
4. Add `dropId` to cache keys and localStorage keys.
5. Externalize hardcoded drop content into drop metadata.
6. Enforce client version reporting in released frontend builds.

Exit criteria:

- Multi-drop switching is consistent with no cache bleed.
- Missing `dropId` traffic is below migration threshold.
- Unknown client-version share is below migration threshold.
- No UI collisions for overlapping IDs across different drops.

### Phase 7: Canary and authority cutover

1. Enable canary cohort routing (`drops/{dropId}/migrationFlags/CANARY_ROUTING_MODE=wallet_allowlist`).
2. Keep `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT=legacy` and set `drops/{dropId}/migrationFlags/CANARY_READ_AUTHORITY=namespace`.
3. Run canary with internal wallet allowlist and evaluate SLOs at minimum sample volume.
4. If SLOs hold, flip `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT=namespace` for general traffic.
5. Enforce compatibility fallback disablement after deadline via global router default and/or `drops/{dropId}/migrationFlags/ALLOW_LEGACY_DROPID_FALLBACK_OVERRIDE=false`.
6. Permit `mintable` only for drops that pass program-manifest verifier checks.

Exit criteria:

- Canary and full rollout pass objective SLOs.

### Phase 8: Namespace-only burn-in (rollback still available)

1. Move to `drops/{dropId}/migrationFlags/WRITE_MODE=NAMESPACE_ONLY`.
2. Keep legacy read path and compatibility code present but disabled by flags.
3. Run burn-in window with rollback readiness checks and incident drills (including claim reservation expiry recovery and outbox replay).
4. Capture signed PONR readiness review.

Exit criteria:

- Namespace-only operation is stable for the agreed burn-in period.
- Rollback path remains verified and immediate.

### Phase 9: Final legacy retirement (post-PONR)

1. Cross PONR with explicit sign-off.
2. Remove legacy fallback reads/writes and migration-only compatibility flags.
3. Remove global-path assumptions (`deliveryId`-only, global assignment docs) from runtime and tooling.
4. Archive migration logs and publish final post-migration report.
5. Update rollback docs to restore-based recovery only.

Exit criteria:

- System is fully multi-drop-native with no legacy code dependency.

## Cutover SLOs and Rollback Triggers

Cutover SLOs:

- Callable function error rate `< 0.5%` (rolling 24h)
- Hard parity mismatches `= 0`
- Soft parity mismatches `< 0.1%`
- Fulfillment enqueue mismatch `= 0`
- p95 latency regression `< 20%`
- Cross-drop cache collisions `= 0`
- Expired claim reservations unrecovered beyond SLA (`300s`) `= 0`
- Minimum sample volume met before evaluating go/no-go (configured per endpoint)

Automatic rollback trigger:

- Any hard mismatch, or any SLO breach for 15 continuous minutes during canary/cutover.
- On rollback trigger, enforce `ROLLBACK_COOLDOWN_MINUTES` before any forward re-rollout.

Pre-PONR rollback actions (ordered):

1. Set `drops/{dropId}/migrationFlags/READ_AUTHORITY_DEFAULT=legacy` and `drops/{dropId}/migrationFlags/CANARY_ROUTING_MODE=off`.
2. Keep `drops/{dropId}/migrationFlags/WRITE_MODE=DUAL_LEGACY_PRIMARY`.
3. Re-enable temporary compatibility fallback for the affected `dropId` only, if required for client continuity.
4. Pause rollout and open incident report with mismatch sample IDs.

Post-PONR rollback actions (ordered):

1. Declare migration incident and freeze writes requiring namespace assumptions.
2. Execute restore-based recovery from verified backup/snapshot.
3. Reconcile events after snapshot point using `mutationId` audit trail.
4. Publish post-incident report with corrected cutover checklist.

Operational ownership:

- Assign an incident owner (on-call) for each rollout window.
- Only incident owner can approve leaving cooldown and resuming rollout.

## Authorization Test Matrix (Minimum)

1. Unknown `dropId` is rejected for every drop-sensitive endpoint.
2. Inactive/ended drop cannot receive new mint/claim operations.
3. Caller cannot mutate another wallet's profile/order.
4. Admin-only operations reject non-admin context.
5. Claim code reservation/finalization enforces matching `dropId` and single-use redemption.
6. Claim code lookup uses canonicalization and rejects ambiguous canonical collisions.
7. Missing `dropId` enforcement behaves as configured by compatibility deadline and client version.
8. Canary cohort routing is deterministic for same wallet/request identity.
9. Scoped identifiers are enforced (`dropId + deliveryId`, `dropId + dudeId`, `dropId + boxAssetId`).
10. `clientInfo.version` and `clientInfo.build` enforcement/telemetry works on all drop-sensitive callable endpoints.
11. Missing-`dropId` compatibility path succeeds only when backend can derive exactly one drop from immutable identifiers; otherwise request is rejected.
12. Claim replay checks are drop-scoped (no false "already claimed" from same `dudeId` in a different drop).

## Open Decisions (Still Blocking)

1. Final compatibility deadline policy for production (`COMPAT_DROPID_REQUIRED_AFTER_DEFAULT` value and whether drop-specific overrides are allowed).
2. Exact canary cohort size and timeline.
3. Minimum sample-volume thresholds required for cutover SLO evaluation.
4. Final values for capacity headroom gate and `ROLLBACK_COOLDOWN_MINUTES`.
5. Claim code namespace policy across normalization versions (`claimCodeCanonical` global lock behavior vs version-scoped lock key).

## Immediate Next Step

Convert this into a tracked execution checklist with:

1. file-level change list,
2. owner,
3. estimate,
4. test command,
5. rollback command,
6. observability panel link.
