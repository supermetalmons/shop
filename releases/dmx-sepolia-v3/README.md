# divination machina x — Sepolia v3

Completed 26 November 2026. The API and storefront serve the fresh collection and renderer.
The superseded v2 collection is paused, its signer is disabled, and its scoped
backend and local cleanup is verified after at least five minutes of observation.

Collection: [`0xc465f98f824a9d4017d09ef219f3b546794e49ef`](https://sepolia.etherscan.io/address/0xc465f98f824a9d4017d09ef219f3b546794e49ef#code),
deployed at block `12211549`.

Renderer: [`0x1de4a011811b378f6a8eef079eac5014e9b5583e`](https://sepolia.etherscan.io/address/0x1de4a011811b378f6a8eef079eac5014e9b5583e#code),
deployed at block `12211542`.

The collection uses the reviewed gas optimizations from
[`a120a04d`](https://github.com/supermetalmons/shop/commit/a120a04d45f4dcd2a06d2a85b3273b6545998aa3):
compact permanent issuance, packed redemption records, and omitted default-zero
provenance writes. Public interfaces and signing formats are unchanged. Both
contracts and the dedicated authorization signer are fresh.

All 777 existing physical NFC codes and URLs were retained and rebound. All 777
initial pairs remained unclaimed through final verification. Signed claim and
recipient-claim simulations, saved-scan recovery, wallet cancellation, old
transaction isolation, current media and Basel checks passed. Acceptance sent
no claim transactions. Redemptions remain paused; token transfers remain enabled.

The old collection's credential rows, obsolete release trees, caches, signer
keystore and Keychain item were removed. The immutable retirement markers and
minimal prior cleanup record remain. Shared media, mainnet credentials and
unrelated deployments are preserved. Mainnet remains unconfigured and disabled.

The collection has an Etherscan Exact Match. Etherscan classifies the identical,
constructor-free renderer as a Similar Match to
`0x7cf83245cea3defd3b1b0249951618dbfadf281f`; its API returned Already Verified.
The renderer's published sources, compiler settings, ABI and constructor
arguments were compared with the frozen release. Sourcify reports `match` for
both contracts, with creation bytecode, runtime bytecode and frozen sources
independently verified. No Etherscan Exact Match is claimed for the renderer.

Both API rollout gates passed 3,826 unit and 96 runtime tests. The frontend gate
passed 5,780 tests; the recorded additional checks passed 5 Worker, 29 client,
1 common, 29 focused and 35 helper tests. Both local E2Es passed. The earlier
source review's 93 contract tests, 9 gas benchmarks and 88 deployment tests are
retained baseline evidence and were not rerun as part of this rollout.

Evidence: [application release](application-release.json), [validation](validation.json),
[live acceptance](live-acceptance.json), [browser acceptance](browser-acceptance.json),
[privacy verification](privacy-verification.json), [retirement](retirement.json),
[completion](completion-verification.json), and [prior retirement](prior-retirement-preservation.json).

Frozen deployment evidence: [collection](collection-deployment.json),
[renderer](renderer-deployment.json), [credential fingerprint](credential-set.json),
and [verified media](media-verification.json). Source verification and compiler
manifests remain alongside those records.

## Subsequent media update

The [26 November 2026 CDN migration](../dmx-cdn-v1/README.md) activated a new PNG
metadata renderer on this same collection and deployed the WebP storefront
assets. The original deployment evidence remains unchanged; the migration
record contains the current renderer, activation transaction and verification.
