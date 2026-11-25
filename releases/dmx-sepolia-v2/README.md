# divination machina x — Sepolia v2

Live on 25 November 2026. The API and storefront use the new DMX collection and
renderer. The superseded Tarot deployment is retired and its cleanup is verified.

Collection: [`0x4dc87245ef8e09305407c352e6c535ffa4e31e6c`](https://sepolia.etherscan.io/address/0x4dc87245ef8e09305407c352e6c535ffa4e31e6c#code),
deployed at block `12209336`.

Active renderer: [`0x7cf83245cea3defd3b1b0249951618dbfadf281f`](https://sepolia.etherscan.io/address/0x7cf83245cea3defd3b1b0249951618dbfadf281f#code),
deployed at block `12211225` and activated at block `12211233`. The
[DMX media update](../dmx-media-20261125/README.md) changes the media paths while
retaining this collection and its credentials.

Original renderer: [`0x4fd72d56cab36c926100ab54b73dc2f5df454810`](https://sepolia.etherscan.io/address/0x4fd72d56cab36c926100ab54b73dc2f5df454810#code),
deployed at block `12209330`.

The collection supports the 777 initial NFC claims, recipient minting, signed
multi-generation redemption, configurable fee payouts, and renderer replacement.
Initial cards use IDs 1–777 and their NFC receipts use IDs 1000000–1000776.
Redemptions start paused; no redemption UI or HTTP endpoints are introduced.

The existing 777 Sepolia NFC codes and URLs are retained and rebound to the new
contract. Credentials are verified against deployment-scoped hashes and the
aggregate release fingerprint. Old NFTs and pending transactions do not migrate.
Private credentials, encrypted signer material, resumable deployment journals,
and raw operational evidence remain under the ignored private operations directory.

DMX mainnet remains unconfigured and disabled. Its staged credentials and private
exports are preserved. The 111K deployments and shared artwork are unchanged.

All 777 initial pairs remained unclaimed through final verification. Live signed
claim simulations and browser checks passed without broadcasting claims. The
browser checks covered saved scans, reload recovery, old transaction isolation,
wallet cancellation, public artwork, and the original Basel placeholder.

The old signer was disabled onchain. Its 777 credential rows and all 1,555 static
metadata objects were removed behind an immutable database retirement fence.
Every former metadata URL returned 404. The old release/private trees, obsolete
caches and browser-QA snapshot, authorization keystore, and Keychain entry were
removed. Remote absence and replacement health were checked again after more
than five minutes. Git and immutable onchain history are preserved.

Evidence: [application release](application-release.json),
[live acceptance](live-acceptance.json), [browser acceptance](browser-acceptance.json),
[retirement](retirement.json), and [completion verification](completion-verification.json).
Both contracts have exact source matches on Etherscan and Sourcify. Required
deployment checks passed, including 3,822 API unit tests, 96 API runtime tests,
5,777 frontend tests, both local DMX E2Es, and strict credential scanning.
The optional repository-wide dead-code checks still report pre-existing 111K
export bookkeeping issues; see [validation](validation.json).

The subsequent [API retirement-enforcement update](retirement-api-update.json)
rejects retired Sepolia scopes before credential acceptance or signing. Its
3,824 API unit tests, 96 native runtime tests, and live claim simulations passed.
All 777 replacement credentials and mainnet staging were verified unchanged;
retired credential rows remain absent. The frontend did not require redeployment.

See the [operator guide](../../scripts/docs/tarot_cards.md) for the current
deployment, credential rebind, validation, and retirement procedure.
