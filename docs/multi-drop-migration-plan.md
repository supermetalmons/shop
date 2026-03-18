# Multi-Drop Migration Plan (Firebase + Shop + Onchain)

Status: Draft v2 (hardened after risk review)  
Last updated: 2026-03-18  
Scope: migrate from single-drop setup to multi-drop shop without risking current production data

## Why this document

The current system is built around one active drop. This document captures:

1. The highest-value findings from the codebase audit.
2. Risk-driven design decisions needed before implementation.
3. A phased migration plan with measurable go/no-go criteria.
4. Rollback strategy that keeps recovery fast and deterministic.

No implementation changes are included yet. This is a planning artifact for careful iteration.

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
2. Add launch gate: enabling a second `mintable` drop is blocked until onchain multi-config path is approved and tested.
3. Keep migration work unblocked by allowing offchain multi-drop support first, but with explicit capability constraints.

Acceptance criteria:
- No drop can be set to `mintable` unless onchain checks pass.
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
   - `READ_AUTHORITY_DEFAULT=legacy` or `namespace`
2. Add optional canary override for segmented rollout:
   - cohort routing (wallet allowlist hash) decides if request is canary
   - canary requests may use `CANARY_READ_AUTHORITY`
   - non-canary requests always use `READ_AUTHORITY_DEFAULT`
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
2. Introduce canonicalization (`codeCanonical`) with a fixed normalization contract:
   - Unicode NFKC
   - trim leading/trailing whitespace
   - uppercase
3. Store both `codeRaw` and `codeCanonical`; keep `codeRaw` for display only.
4. Enforce canonical uniqueness with a lock document (`claimCodeCanonical/{codeCanonical}`) created transactionally.
5. Add immutable `dropId` and `codeVersion` fields.
6. Enforce redemption in transaction:
   - `status` must be `available`
   - `dropId` must match request context
   - transition to `redeemed` with claimant identity + timestamp
7. Add unique invariant: one code can transition to redeemed only once.

Acceptance criteria:
- Zero successful cross-drop redemptions.
- Zero double redemption for same code.
- Zero canonical collisions unresolved before cutover.

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
1. Introduce `COMPAT_DROPID_REQUIRED_AFTER` (UTC timestamp).
2. Require client build/version identifier on all requests (`x-client-version` or equivalent).
3. Before deadline: missing `dropId` allowed only for approved legacy client versions.
4. Add telemetry dashboard for missing `dropId` by client version and endpoint.
5. After deadline: missing `dropId` hard-fails with actionable error.

Acceptance criteria:
- Compatibility mode cannot persist indefinitely.
- Cutoff is version-aware and does not blindside unknown client populations.

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

## Safety Invariants (Non-Negotiable)

1. No destructive operation on production without explicit, environment-validated opt-in.
2. Every mutation is idempotent and traceable (`mutationId`, timestamp, dropId).
3. One source of truth is active at any time (by explicit flag), never implicit precedence.
4. Rollback path must exist before enabling new write/read modes.
5. Client-direct Firestore access stays denied.
6. External side effects must be driven by idempotent outbox processing.
7. Irreversible cleanup requires explicit PONR sign-off.

## Target Data Model (Draft)

### Drop registry

- `drops/{dropId}`
  - `status` (`draft|active|ended|disabled`)
  - `dropCapability` (`catalog_only|mintable`)
  - `display` (title, subtitle, assets, links)
  - `onchain` (program id, config PDA, collection mint, metadata base)
  - `sales` (pricing, windows, limits)
  - `fulfillment` (policy/version flags)

### Drop-scoped operational data

- `drops/{dropId}/boxAssignments/{boxAssetId}`
- `drops/{dropId}/dudeAssignments/{dudeId}`
- `drops/{dropId}/deliveryOrders/{deliveryId}`
- Optional: `drops/{dropId}/mintProgress/{wallet}`

### Claim codes

- `claimCodes/{code}` (global)
  - Required: `dropId`, `status`, `codeVersion`, `createdAt`, `codeRaw`, `codeCanonical`
  - Immutable: `dropId`, `codeVersion`
- `claimCodeCanonical/{codeCanonical}` (uniqueness lock)
  - Required: `claimCodeRef`, `createdAt`

## Flag Model (Control Plane)

- `WRITE_MODE`: `LEGACY_ONLY|DUAL_LEGACY_PRIMARY|DUAL_NAMESPACE_PRIMARY|NAMESPACE_ONLY`
- `READ_AUTHORITY_DEFAULT`: `legacy|namespace`
- `CANARY_ROUTING_MODE`: `off|wallet_allowlist`
- `CANARY_READ_AUTHORITY`: `legacy|namespace`
- `ALLOW_LEGACY_DROPID_FALLBACK`: `true|false`
- `COMPAT_DROPID_REQUIRED_AFTER`: UTC timestamp
- `ENABLE_SHADOW_READS`: `true|false`
- `SHADOW_READ_SAMPLE_RATE`: `0..1`
- `ROLLBACK_COOLDOWN_MINUTES`: integer (for anti-flap)

Rule:
- Only one change to write/read authority at a time.
- Each flag change requires monitoring confirmation before next change.
- Request authority resolution order:
  1. If canary routing is enabled and request is in canary cohort, use `CANARY_READ_AUTHORITY`.
  2. Otherwise use `READ_AUTHORITY_DEFAULT`.

## Migration Plan (Phased, Production-Safe)

### Phase 0: Safety rails first

1. Back up production Firestore (full export + metadata snapshot).
2. Perform restore drill in isolated project.
3. Guard/disable destructive wipe paths in deploy scripts for production.
4. Add environment gate (`ALLOW_DESTRUCTIVE=false` default, explicit override required).

Exit criteria:

- Restorable backup exists and restore drill evidence is captured.
- Production deploy scripts cannot wipe data by default.

### Phase 1: Registry and schema contract

1. Create `drops/{dropId}` schema.
2. Seed current live drop as `legacyDropId`.
3. Add `dropCapability` and `status` constraints.
4. Define canonical `dropId` format and immutability policy.

Exit criteria:

- Drop registry exists and validates all active drops.

### Phase 2: Context plumbing and compatibility controls

1. Add backend `resolveDropContext(dropId)` with strict validation.
2. Add compatibility flags and read/write mode flags.
3. Require client version/build marker on requests and start telemetry by version.
4. Define and set `COMPAT_DROPID_REQUIRED_AFTER` before leaving this phase.

Exit criteria:

- All drop-sensitive endpoints resolve context through one shared path.
- Compatibility sunset date is committed in config.
- Missing `dropId` and legacy traffic are measurable by client version.

### Phase 3: Dual-write foundation (legacy primary)

1. Enable `WRITE_MODE=DUAL_LEGACY_PRIMARY`.
2. Keep `READ_AUTHORITY_DEFAULT=legacy`.
3. Add `mutationId`, `updatedAt`, and write-audit emission.
4. Add transactional outbox for any external side effects.
5. Ensure write failures fail closed (no silent partial success).

Exit criteria:

- Dual-write success rate meets SLO.
- Idempotent retry behavior is verified.
- Outbox processing is idempotent and dead-letter monitoring is active.

### Phase 4: Backfill (idempotent, checkpointed)

Prerequisites:

- 7-day stable dual-write window.
- Parity mismatch within thresholds.

Execution:

1. Copy legacy documents into namespaced paths preserving IDs and application timestamps (`createdAt`, `updatedAt`, business event times).
2. Add missing `dropId` fields where required.
3. Run with checkpoint + resume support.
4. Run dry-run in staging clone first.
5. Do not attempt to preserve Firestore system metadata (`createTime`, `updateTime`).

Exit criteria:

- Backfill parity checks pass.
- No change to live authority source yet.

### Phase 5: Shadow parity and security verification

1. Enable `ENABLE_SHADOW_READS=true` while keeping `READ_AUTHORITY_DEFAULT=legacy`.
2. Ramp `SHADOW_READ_SAMPLE_RATE` (`1% -> 10% -> 50% -> 100%`) while observing quota/cost guardrails.
3. Compare authority vs mirror responses for critical flows.
4. Execute endpoint auth matrix tests (drop existence, status, wallet ownership, admin scope).
5. Deploy necessary Firestore indexes/rules updates.

Exit criteria:

- Hard parity mismatches remain zero.
- Auth matrix passes for all critical endpoints.
- Capacity and budget guardrails remain within thresholds.

### Phase 6: Frontend drop-awareness

1. Add active drop resolver in UI (URL/config/API).
2. Pass explicit `dropId` in all drop-sensitive requests.
3. Add `dropId` to cache keys and localStorage keys.
4. Externalize hardcoded drop content into drop metadata.
5. Enforce client version reporting in released frontend builds.

Exit criteria:

- Multi-drop switching is consistent with no cache bleed.
- Missing `dropId` traffic is below migration threshold.
- Unknown client-version share is below migration threshold.

### Phase 7: Canary and authority cutover

1. Enable canary cohort routing (`CANARY_ROUTING_MODE=wallet_allowlist`).
2. Keep `READ_AUTHORITY_DEFAULT=legacy` and set `CANARY_READ_AUTHORITY=namespace`.
3. Run canary with internal wallet allowlist and evaluate SLOs at minimum sample volume.
4. If SLOs hold, flip `READ_AUTHORITY_DEFAULT=namespace` for general traffic.
5. Enforce `ALLOW_LEGACY_DROPID_FALLBACK=false` after compatibility deadline.

Exit criteria:

- Canary and full rollout pass objective SLOs.

### Phase 8: Namespace-only burn-in (rollback still available)

1. Move to `WRITE_MODE=NAMESPACE_ONLY`.
2. Keep legacy read path and compatibility code present but disabled by flags.
3. Run burn-in window with rollback readiness checks and incident drills.
4. Capture signed PONR readiness review.

Exit criteria:

- Namespace-only operation is stable for the agreed burn-in period.
- Rollback path remains verified and immediate.

### Phase 9: Final legacy retirement (post-PONR)

1. Cross PONR with explicit sign-off.
2. Remove legacy fallback reads/writes and migration-only compatibility flags.
3. Archive migration logs and publish final post-migration report.
4. Update rollback docs to restore-based recovery only.

Exit criteria:

- System is fully multi-drop-native with no legacy code dependency.

## Cutover SLOs and Rollback Triggers

Cutover SLOs:

- Callable function error rate `< 0.5%` (rolling 24h)
- Hard parity mismatches `= 0`
- Soft parity mismatches `< 0.1%`
- Fulfillment enqueue mismatch `= 0`
- p95 latency regression `< 20%`
- Minimum sample volume met before evaluating go/no-go (configured per endpoint)

Automatic rollback trigger:

- Any hard mismatch, or any SLO breach for 15 continuous minutes during canary/cutover.
- On rollback trigger, enforce `ROLLBACK_COOLDOWN_MINUTES` before any forward re-rollout.

Pre-PONR rollback actions (ordered):

1. Set `READ_AUTHORITY_DEFAULT=legacy` and `CANARY_ROUTING_MODE=off`.
2. Keep `WRITE_MODE=DUAL_LEGACY_PRIMARY`.
3. Re-enable temporary compatibility fallback if required for client continuity.
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
5. Claim code redemption enforces matching `dropId` and single-use transition.
6. Claim code lookup uses canonicalization and rejects ambiguous canonical collisions.
7. Missing `dropId` enforcement behaves as configured by compatibility deadline and client version.
8. Canary cohort routing is deterministic for same wallet/request identity.

## Open Decisions (Still Blocking)

1. Onchain path for truly independent mintable drops (upgrade vs new program strategy).
2. Final compatibility deadline value (`COMPAT_DROPID_REQUIRED_AFTER`) for production.
3. Exact canary cohort size and timeline.
4. Minimum sample-volume thresholds required for cutover SLO evaluation.
5. Final values for capacity headroom gate and `ROLLBACK_COOLDOWN_MINUTES`.

## Immediate Next Step

Convert this into a tracked execution checklist with:

1. file-level change list,
2. owner,
3. estimate,
4. test command,
5. rollback command,
6. observability panel link.
