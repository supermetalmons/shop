# pre111k Sepolia v1

The [Sepolia relic preorder](https://mons.shop/111k/relics_devnet) reserves one relic
per backend-authorized transaction for **0.0023 ETH**, with a lifetime cap of
**18**. The [mainnet page](https://mons.shop/111k/relics) has the new wallet UI and
2.3 ETH price but remains disabled until its own contract deployment.

| Item | Value |
| --- | --- |
| Contract | [`0x8dfde3c4a82ab6322ca5bd0306eb8cd2e75674b6`](https://sepolia.etherscan.io/address/0x8dfde3c4a82ab6322ca5bd0306eb8cd2e75674b6) |
| Deployment | [Transaction](https://sepolia.etherscan.io/tx/0x0ad640c079f02fc737d7b6b8c93db78d408cf8b500d6f48a4ee3a967d47c7312), block **12047599** |
| Treasury | `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d` |
| Signer administrator | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |
| Authorization signer | `0xcc4c8bfd93af9f36d46215a0206954bf6a14c3ca` |
| Verified sources | [Sourcify](https://repo.sourcify.dev/11155111/0x8dfde3c4a82ab6322ca5bd0306eb8cd2e75674b6), [Blockscout](https://eth-sepolia.blockscout.com/address/0x8dfde3c4a82ab6322ca5bd0306eb8cd2e75674b6?tab=contract) |
| Build | Solidity 0.8.38, optimizer 500 runs, Prague, 3,620-byte runtime |

[Deployment evidence](deployment.json) confirms the exact constructor values,
runtime, price, cap, ten-minute maximum authorization lifetime, zero initial
reservations, and zero balance. [Source hashes](source-manifest.json) and
[Sourcify verification](Pre111K.sourcify-verification.json) bind the compiled
sources to the deployed creation and runtime bytecode. The build intentionally
omits a metadata hash, so Sourcify labels the matching bytecode `match`.
[External verification](external-verification.json) also records Routescan and
Blockscout success; Sourcify's Etherscan submission reached its global daily quota.

Anyone can call `withdraw()`; it transfers the entire balance exclusively to the
fixed treasury. The [contract validation](contract-validation.json) includes a
mainnet fork at block **26326516**, where the actual Safe received all **41.4 ETH**
and the preorder contract was emptied. The same treasury address is deliberately
used on Sepolia, although no Safe is deployed there and received test ETH may not
be recoverable. No mainnet transaction was sent.

[Application validation](validation.json), [Worker versions](application-release.json),
and [live acceptance](live-acceptance.json) record the rollout. Live acceptance
verifies a real backend authorization and simulates its execution without
broadcasting a purchase, preserving all eighteen initial test slots. No new
dependencies or database migrations were introduced. NFT111K v12 and its relic
claim allowances were not changed.

See the [reservation operations guide](../../scripts/docs/pre111k.md) for API,
withdrawal, admission, and signer-rotation instructions, and the
[contract deployment guide](../../onchain/ethereum/PRE111K.md) for reproducible
build and deployment commands.

Browser acceptance verified the loaded artwork, wallet control, and 0.0023 ETH
reservation action on Sepolia, and the disabled 2.3 ETH action with “Reservations
are not open yet” on mainnet. Connected-wallet counts, account changes, and
confirmation/reload recovery are covered by the frontend tests.

![Live Sepolia preorder](browser-sepolia.jpg)

![Mainnet remains disabled](browser-mainnet.jpg)

[Review fixes](review-fixes.json) add current-fee validation before deployment
signing, source-verification status recovery without a local job receipt, and a
scrollable wallet chooser for short screens. The CSS update is deployed; the API
and contract are unchanged. Nine script tests and 28 frontend tests passed.

[Receipt and verification fixes](review-fixes-2.json) reject malformed RPC receipt
statuses and retry incomplete source verification. The API update is deployed;
203 API/routing tests and 12 script tests passed.
