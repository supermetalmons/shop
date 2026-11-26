# DMX mainnet v1

The DMX drop launched on **26 November 2026 (Asia/Yerevan)**. All **777 existing mainnet NFC links** are bound to the Ethereum mainnet collection and can authorize an initial card plus its NFC receipt. The links remain unchanged. Holders submit their own claim transactions and pay Ethereum gas.

| Deployment | Address | Creation transaction | Block |
| --- | --- | --- | --- |
| Collection | [`0xe7801065a91aa8e472dffe893dfb29d2c3d4798a`](https://etherscan.io/address/0xe7801065a91aa8e472dffe893dfb29d2c3d4798a#code) | [Transaction](https://etherscan.io/tx/0x94229501a52864aabae97ee9bc9898476b4c26f83a8e2ba450d81733969a9429) | 26494793 |
| Renderer | [`0x7ec5ec98b380558612c4d0b4c7a61063f2430233`](https://etherscan.io/address/0x7ec5ec98b380558612c4d0b4c7a61063f2430233#code) | [Transaction](https://etherscan.io/tx/0xe478ee2267e1cf4265e48b1ffb502a83205cee40a00d499bf51ef4dd8fdfa44d) | 26494784 |

The owner and deployer are `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`. The dedicated mainnet authorization signer is `0xef2dce4856be44b2061251c0286791d0e66331e9`. Minting is enabled; redemption remains paused. Sepolia stays active with its existing contract, signer, credentials, and saved scans.

Both contracts have exact Etherscan source matches. Sourcify independently confirms that the frozen sources and creation/runtime bytecode match. [Deployment and fee evidence](deployments.json) · [Source verification](source-verification.json)

Renderer deployment cost **0.000143049017071395 ETH**, below its **0.0003 ETH** cap. Collection deployment cost **0.000638946542937825 ETH**, below its **0.0012 ETH** cap. Total deployment cost was **0.00078199556000922 ETH**.

The active API version is `cf7c7986-b2f3-4fd7-b35b-c36544309770`. Acceptance verified all 777 credentials and all 777 unclaimed initial pairs, simulated four valid claim calls, checked mainnet wallet selection and cancellation recovery, and confirmed that public artwork remains accessible without claim credentials. Acceptance did not broadcast claim transactions. [Credential binding](credential-binding.json) · [API release](application-release.json) · [Live acceptance](live-acceptance.json) · [Browser acceptance](browser-acceptance.json)

Validation passed 93 contract tests, 88 deployment/source-verification tests, 32 mainnet credential tests, 231 Tarot/NFC frontend tests, nine gas benchmarks, both local E2E flows, all 2,341 media checks, the production build, and the strict browser credential-leak scan. [Validation](validation.json) · [Completion](completion-verification.json)

## Disable and resume

To stop issuing new claim authorizations, set `ETHEREUM_TAROT_MAINNET_ENABLED=false` in `cloud/workers/api/wrangler.jsonc`, release with `npm run deploy:api`, and verify the active API configuration and unavailable prepare response. Already issued signatures can remain valid for up to ten minutes. An immediate onchain stop requires the owner to call `setMintingPaused(true)` after simulation and transaction journaling, then verify the receipt and pause flag with three canonical confirmations.

To resume, retain this collection, bound credentials, and dedicated signer; restore minting if paused, set the mainnet API flag to true, release with `npm run deploy:api`, and repeat live and browser acceptance. Preserve frozen deployment evidence and signed transaction journals privately. If interrupted deployment or binding work is encountered, reconcile and resume the original journals and bound batch; do not generate replacement links or deploy another collection. See the [DMX operations guide](../../scripts/docs/tarot_cards.md#mainnet-release-preparation).

## Subsequent media update

The [26 November 2026 CDN migration](../dmx-cdn-v1/README.md) activated a new PNG
metadata renderer on this same collection and deployed the WebP storefront
assets. The original deployment evidence remains unchanged; the migration
record contains the current renderer, activation transaction and verification.
