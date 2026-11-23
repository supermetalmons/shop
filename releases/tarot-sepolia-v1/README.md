# Tarot Cards — Sepolia v1

Activated on 22 November 2026. Current API version
`480190bd-43be-4138-aca9-1908b2d198e2`; storefront version
`9e3d63fe-0856-4751-b019-18a6e8b83e0a`.

The review fixes add bounded initial-validation retries, isolate NFC pages from
unrelated account errors, and serialize deployment operations with exclusive
release locks. The updated storefront was verified with injected HTTP 503,
HTTP 429, and network failures; each recovered without a reload or wallet
interaction. See [review-fixes.json](review-fixes.json).

The subsequent quota/snapshot fixes remove Origin from IP quota keys and reject
chain snapshots older than accepted or confirmed evidence, without suppressing
fresh canonical reorgs. The API was published before the updated frontend.
Regression tests and published frontend checks passed; production probes did
not reproduce HTTP 429 enforcement, so the native Cloudflare quota must not be
treated as a strict cap. See [quota-snapshot-fixes.json](quota-snapshot-fixes.json)
for validation and that limitation. The contract is unchanged.

The 23 November frontend update makes wallet waits cancellable, preserves
uncertain and late submissions safely, guards failed receipt replies against
newer chain observations, and checks private UUIDs case-insensitively during
bundle validation. See [wallet-recovery-fixes.json](wallet-recovery-fixes.json).

Pending intents now also survive SPA remounts when browser storage fails, using
a window-scoped fallback with the same identity and expiry guards. Published
browser checks verified both late confirmation and expiry/retry without a
second submission before expiry. See [storage-remount-fix.json](storage-remount-fix.json).

The access/release-gate update blocks claim eligibility after later 401/403
responses, makes the existing Claim button reflect retry cooldowns, and requires
the configured private manifest before deployment or release dry runs. Staff
test-route restrictions and three-confirmation settlement remain unchanged.
See [access-release-gate-fixes.json](access-release-gate-fixes.json).

Release scans now also require the private manifest to match the aggregate
[credential-set fingerprint](credential-set.json), recorded after verifying all
777 live database rows. The pin contains no codes or individual code hashes;
subsequent scans check it offline and reject alternate same-contract manifests.

The final reviewed release pins contract reads to canonical block hashes and
preserves credential denials when a concurrent request starts a cooldown. Both
application deployments passed their release gates, live API checks, and five
published-browser scenarios. No claim transactions were broadcast. See
[final-release.json](final-release.json).

The claimed-card view keeps the standard mons.shop title, logo, and wallet
controls above artwork sized to the remaining viewport without extra scrolling.
All 5,622 frontend tests passed. Published checks verified the full card fits on
desktop, short windows, mobile, and landscape, including resizing, wallet
interaction, and home navigation, using synthetic claim status without
broadcasting transactions.

Contract: [`0x63fef7c4867c558b91fda48899580a89d9f8cde1`](https://sepolia.etherscan.io/address/0x63fef7c4867c558b91fda48899580a89d9f8cde1#code).
Deployment block: `12190005`.
Transaction: [`0x5df93dd90f6e4b1d9a642affe1b87515495136bee8fa979423bdd0678b572742`](https://sepolia.etherscan.io/tx/0x5df93dd90f6e4b1d9a642affe1b87515495136bee8fa979423bdd0678b572742).

777 Tarot cards use IDs 1–777; their paired NFC receipts use IDs 778–1554.
One zero-price, backend-authorized claim mints both to the caller. Ethereum
mainnet is unavailable. This release uses the base artworks without mutation or
redemption functionality.

The NFC link format is `/nfc?code=<private-UUID>&tokenId=<card-ID>&testnet=true`.
The original `/nfc?code=basel` retains its video placeholder. Valid unclaimed
links use the existing two-NFT layout and Ethereum wallet picker; confirmed
links retain the standard shop header above one large card artwork.

The public [collection metadata](https://cdn.mons.shop/tarot-sepolia/v1/collection.json)
and all 1,554 token metadata records have been published and verified. All 1,554
artwork URLs were checked. Source publication on Etherscan and Sourcify was
verified against the frozen deployment's compiler input and constructor.

Initial live acceptance verified all **777 pairs unclaimed**, two backend-signed claim
simulations, the real wallet connect/prepare/cancel flow, rejected invalid codes
and mainnet requests, and HTTP 429 throttling with `Retry-After: 60`. No claim
transaction was broadcast. All 777 hashed credentials were verified after
activation, and the existing 111K deployment remained healthy and unchanged.
See [acceptance.json](acceptance.json) and [validation.json](validation.json).

This directory contains public deployment identity, source verification, and
aggregate metadata evidence. Private claim links, signer details, raw operational
evidence, and the resumable deployment journal are in the ignored
`.operations/tarot-sepolia-v1/` directory. No claim codes or backend authorization
signatures belong in this public release directory.

See the [operator guide](../../scripts/docs/tarot_cards.md) for provisioning,
deployment, validation, and signer rotation. The code manifest is retained after
claim so the same physical NFC link can continue displaying the card artwork.
