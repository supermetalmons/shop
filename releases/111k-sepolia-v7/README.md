# 111K Sepolia v7

The fresh reliquary-capable collection is live at [mons.shop/111k_devnet](https://mons.shop/111k_devnet). It was deployed closed, verified at zero supply, and opened only after metadata, reveal provisioning, application cutover, and the scoped commerce reset completed. No live QA tokens were minted.

| Item | Value |
| --- | --- |
| Chain | Sepolia, 11155111 |
| Deployment ID | v7 |
| Collection | [0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec](https://sepolia.etherscan.io/address/0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec) |
| Creation block | 12029091 |
| Metadata | [v7 artwork #1](https://cdn.mons.shop/111k-sepolia/v7/1.json) |
| Source verification | [Sourcify](https://repo.sourcify.dev/11155111/0xc7571e9dc4b1cd646d092d51cfa89a76a6461fec) |
| Opening transaction | [0x2f66f5610b483469964349e9cd9c25da64a2858c1d3af173ad2ac1b5d7c38c8f](https://sepolia.etherscan.io/tx/0x2f66f5610b483469964349e9cd9c25da64a2858c1d3af173ad2ac1b5d7c38c8f) |
| Opening block | 12029271 |

All 344978 metadata objects were published and verified. The initial 111111 artwork and 222222 artwork-receipt objects match their placeholder templates. The new reveal pool started with all 111111 assets available and no reserved or frozen assignments. Reliquaries contain 111 crates, have a lifetime cap of 30, and initially cost 0.0088 test ETH. Their image URLs remain under the monuments directory.

The [zero-supply checkpoint](preopening-zero.json) records canonical block 12029225 with zero supply, issuance and proceeds, and no mint or purchase events. [Post-opening verification](deployment-open.json) observed total supply 0; public purchases after opening are permitted. [Browser acceptance](browser-acceptance.json) observed all three container selectors, 30 reliquaries available, and an enabled mint button without connecting a wallet or submitting a mint.

The previous collection 0x8b4044dbd10c05d84d067208980de58e9d5fe915 is paused onchain. Its reveal admission is paused while its immutable ledger and metadata remain intact. [Reset verification](reset-verification.json) confirms only the retired commerce scope was cleared after the drain and private backup. Shared profiles, addresses, authentication and unrelated drops were preserved.

The mainnet inventory before and after the release is identical: 344978 objects, checksum 5bb4e97aacdffe1d19dc6767186b17ebeae8d668a0a516d2a6deeb85821e4c72. Mainnet registry records are unchanged and no mainnet transactions were submitted. The [isolation tests](validation.json) cover old/new Sepolia and mainnet scopes with overlapping token and transaction IDs.

[Release summary](release.json), [frozen source manifest](source-manifest.json), [metadata verification](metadata-verification.json), [Sourcify verification](NFT111K.sourcify-verification.json), [application versions](application-release.json), and [cutover acceptance](cutover-acceptance.json) record the completed release.
