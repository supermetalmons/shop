# DMX media URL update — 25 November 2026

The existing Sepolia collection
[`0x4dc87245ef8e09305407c352e6c535ffa4e31e6c`](https://sepolia.etherscan.io/address/0x4dc87245ef8e09305407c352e6c535ffa4e31e6c#code)
uses renderer
[`0x7cf83245cea3defd3b1b0249951618dbfadf281f`](https://sepolia.etherscan.io/address/0x7cf83245cea3defd3b1b0249951618dbfadf281f#code).
The renderer was deployed at block `12211225` and activated at block `12211233`.
The frontend is live on `mons.shop` and `www.mons.shop`, at version
`99ac966d-a4d6-4438-a322-77ddc53592e3` with 100% traffic.

Card NFT metadata uses `https://wip.lil.org/dmx/cards/<cardId>.webp`, and both
receipt kinds use `https://wip.lil.org/dmx/receipts/<sourceCardId>.webp`.
Collection metadata uses `cards/1.webp`. The NFC interface uses
`https://wip.lil.org/dmx/heroes/<cardId>.webp` with overlays from
`https://wip.lil.org/dmx/layers/<layerId>.webp`.

The owner, quote signer, pause flags, collection address, and credential binding
remain unchanged. The owner transaction emitted `RendererUpdated`, a full
`BatchMetadataUpdate`, and `ContractURIUpdated`. Mainnet and the API deployment
were not changed; no claim transactions were broadcast.

All 2,341 media URLs passed bounded HEAD checks: 777 cards, 777 heroes, 777
receipts, and 10 layers, each returning a nonempty WebP response. No tokens had
been minted at the live chain check, so token metadata for cards, NFC receipts,
and redemption receipts was exercised in both local E2Es. The live collection
image and active renderer were verified directly on Sepolia.

The original [Sepolia v2 deployment evidence](../dmx-sepolia-v2/README.md) and
private frozen bundles are preserved. New manifests pin the expected DMX
collection image; historical manifests verify against their original recorded
metadata. Original deployment records retain their historical URLs.

Evidence:

- [Renderer deployment](renderer-deployment.json)
- [Renderer activation and refresh events](renderer-activation.json)
- [Etherscan and Sourcify source verification](source-verification.json)
- [Media availability](media-verification.json)
- [Live chain verification](live-chain-verification.json)
- [Frontend deployment](frontend-release.json)
- [Live browser verification](browser-verification.json)
- [Validation](validation.json)
- [Completion verification](completion-verification.json)

Validation passed 5,777 frontend tests, 86 DMX contract tests, 74 deployment and
source-verification tests, both local E2Es, the relevant type checks, production
build, and strict credential scanning. Private signing journals, raw operational
logs, and browser captures remain under the ignored operations directory.

Live browser checks verified hero, receipt, and all three overlay images, saved
scan reloads, and the public artwork page. No old media requests or credential
referrers were observed. Mobile and desktop captures passed visual inspection.

The first frontend deployment attempt stopped before publishing because an
unrelated payment-routing test failed its asynchronous preparation-count
assertion. Its six focused tests passed on rerun, and the normal deployment
retry passed all 5,777 tests before publishing. No unrelated routing code changed.
