# DMX offchain metadata migration

Completed 26 November 2026 (Asia/Yerevan). Both existing collections now return shared JSON URLs under `https://cdn.mons.shop/dmx/`. The publication contains 777 cards, 777 NFC receipts and collection metadata: 1,555 verified objects. Names, descriptions, traits and `cdn.lil.org` PNG images are unchanged.

| Network | Existing collection | New renderer | Activation |
| --- | --- | --- | --- |
| Sepolia | [`0xc465f98f824a9d4017d09ef219f3b546794e49ef`](https://sepolia.etherscan.io/address/0xc465f98f824a9d4017d09ef219f3b546794e49ef) | [`0x1ee12a393c15b9ecaeec6af8bcbeca6bda15f92f`](https://sepolia.etherscan.io/address/0x1ee12a393c15b9ecaeec6af8bcbeca6bda15f92f#code) | [Transaction](https://sepolia.etherscan.io/tx/0xf5be1121a8bad030dba784d435c2edad3ffcadeef313ebb3138657b967daf350) |
| Ethereum mainnet | [`0xe7801065a91aa8e472dffe893dfb29d2c3d4798a`](https://etherscan.io/address/0xe7801065a91aa8e472dffe893dfb29d2c3d4798a) | [`0xbf5c6c8cbf0fb2ce37f5315092148ab2fc95681c`](https://etherscan.io/address/0xbf5c6c8cbf0fb2ce37f5315092148ab2fc95681c#code) | [Transaction](https://etherscan.io/tx/0x8eb637ea58c0e9f7d7716581c71d454c5ab3382aa906ddecc1ece2614ae8955a) |

Cards use [1.json](https://cdn.mons.shop/dmx/1.json)–[777.json](https://cdn.mons.shop/dmx/777.json). NFC receipts use [1000000.json](https://cdn.mons.shop/dmx/1000000.json)–[1000776.json](https://cdn.mons.shop/dmx/1000776.json). Both collections return [collection.json](https://cdn.mons.shop/dmx/collection.json) from `contractURI()`. Every token kind uses its decimal ERC-721 token ID as the filename. Future card and redemption-receipt JSONs must be published before issuance; shared metadata does not automatically incorporate network-specific order or generation values.

All objects passed complete R2 and public CDN byte/hash checks, JSON content type, `no-store`, wildcard CORS and redirect checks. [Publication manifest](metadata-manifest.json). Each deployment and activation has at least three canonical confirmations. Etherscan and Sourcify sources match the frozen releases, and activation emitted `RendererUpdated`, `BatchMetadataUpdate(1, 2000775)` and `ContractURIUpdated`.

Validation passed 269 tests, both local network E2Es and API/tools/tests TypeScript checks. Live checks verified both renderers' initial and future token boundaries and collection metadata. Final issued NFTs: mainnet 0; Sepolia 0. No live test claims were sent.

Collection addresses, credential files, signers, signing domains and pause controls are unchanged. Minting remains enabled; redemptions remain paused. API, frontend and databases were unchanged. Mainnet deployment plus activation cost 0.000028082550626293 ETH, within the 0.0005 ETH combined ceiling. Original deployment and prior media-migration evidence remain intact.

[Complete verification evidence](migration.json). See [DMX metadata operations](../../scripts/docs/tarot_cards.md#metadata-and-deployment) for generation, publication, verification and recovery. Resume each interrupted transaction against its existing private journal; do not rebind original credentials after this renderer swap.
