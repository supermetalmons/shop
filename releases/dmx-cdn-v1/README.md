# DMX CDN media migration

Completed 26 November 2026 (Asia/Yerevan). Both existing collections now use CDN PNG images for card and receipt NFT metadata, and the storefront uses CDN WebP clean cards, receipts and layers. Collection imagery uses `cards/1.png`.

| Network | Existing collection | New renderer | Activation |
| --- | --- | --- | --- |
| Sepolia | [`0xc465f98f824a9d4017d09ef219f3b546794e49ef`](https://sepolia.etherscan.io/address/0xc465f98f824a9d4017d09ef219f3b546794e49ef) | [`0xc337f07ec00ab64f67bca19f67b7272bb3153b2a`](https://sepolia.etherscan.io/address/0xc337f07ec00ab64f67bca19f67b7272bb3153b2a#code) | [Transaction](https://sepolia.etherscan.io/tx/0xbd98955321d0d2344d54b4dc767ea91428772c76e05dd602454363963aa0806c) |
| Ethereum mainnet | [`0xe7801065a91aa8e472dffe893dfb29d2c3d4798a`](https://etherscan.io/address/0xe7801065a91aa8e472dffe893dfb29d2c3d4798a) | [`0xead755be25fd1504890aeb790e1798a7beb5b1b3`](https://etherscan.io/address/0xead755be25fd1504890aeb790e1798a7beb5b1b3#code) | [Transaction](https://etherscan.io/tx/0xd8787518ba223ab35f1f46488c62c7e3ed0921b6f7304c9c0f78ff030c94e975) |

The renderer swaps emitted `RendererUpdated`, `BatchMetadataUpdate(1, 2000775)` and `ContractURIUpdated`; each deployment and activation has at least three canonical confirmations. Etherscan and Sourcify source verification match the frozen releases.

All 3,118 media assets passed availability, MIME-type and nonempty-size checks. The frontend release is `4f4a33ba-db23-451c-bbad-ea8c7166c23f`. Live desktop/mobile checks verified public artwork, both networks' claim pages, saved-scan recovery, WebP loading and wallet cancellation without broadcasting claims. No active DMX WIP or heroes requests were observed.

Final confirmed issuance: mainnet 0 existing NFTs; Sepolia 0 existing NFTs. Metadata was checked for every NFT present at acceptance; token behavior is additionally covered by local E2Es. No test NFTs were minted on either live network.

Collection addresses, credentials, signers and pause controls are unchanged. Original deployment evidence is preserved; this release appends renderer deployment and activation proof. API and databases were unchanged. Mainnet deployment plus activation cost 0.000067523543805904 ETH, within the approved 0.0005 ETH combined cap.

[Complete migration, validation and acceptance evidence](migration.json). Use the current activation journal for read-only health verification; do not rerun original mainnet credential binding after this renderer swap. See [DMX operations](../../scripts/docs/tarot_cards.md#contract-operations).

## Subsequent offchain metadata update

The [offchain metadata migration](../dmx-offchain-v1/README.md) subsequently
replaced these renderers with `DMXOffchainRenderer` on both existing collections.
Use that release's activation journals for current health verification. Both
networks now share `https://cdn.mons.shop/dmx/<tokenId>.json` and
`collection.json`; this release's PNG and WebP media remain in use.
