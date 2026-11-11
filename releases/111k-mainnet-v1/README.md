# 111k mainnet deployment

Latest API update: [mainnet public APIs and reveal enabled](public-api-readiness-2026-11-11.json), with the onchain sale still closed and zero token supply. See the [VVV mainnet checklist](../../scripts/docs/111k_mainnet_vvv.md).

Latest discount update: [Terraforms holder expansion to 3,242 eligible addresses](discounts-terraforms-2026-11-11/README.md).

Post-deployment updates: [free-crate allowances](free-crates-2026-11-11/README.md), [discount list and mint prices](discounts-2026-11-11/README.md), [12-relic allocation with 22.3 ETH](relic-allocation-2026-11-11/README.md), and [admin claims for relics 8 and 18](admin-claims-2026-11-11/README.md), configured on 11 November 2026. The records below describe the original deployment configuration.

Deployed [111k](https://etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d#code) on Ethereum mainnet with minting closed, zero token supply, and zero relic allocation. Reveal provisioning reached ready at registry revision 2; reveal activation remains disabled. No sale-opening, relic-allocation, or mint transaction was sent.

| Setting | Value |
| --- | --- |
| Contract | `0x08cded8258730bda384ff198001e47a1b50f7f9d` |
| Deployment transaction | [0x6c949b4b008f78993438a8b46205111609b0a8c4ea0d29d4ef547ecc2e0f95d9](https://etherscan.io/tx/0x6c949b4b008f78993438a8b46205111609b0a8c4ea0d29d4ef547ecc2e0f95d9) |
| Deployment block | 26387160 |
| Internal deployment ID | mainnet-v1 |
| Owner and delivery receiver | `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` |
| Quote signer | `0x43c829cbb3648cc5eb8ebaa15fb7cfab21ecc2ea` |
| Gas used | 6423477 |
| Gas cost | 0.00120403946069289 ETH |
| Approved fee ceiling | 0.002 ETH |

## Metadata and configuration

All 344,984 token JSONs were published and verified at the clean root, including [artwork 1](https://cdn.mons.shop/111k/1.json), [crate 1](https://cdn.mons.shop/111k/111112.json), and [relic 1](https://cdn.mons.shop/111k/117172.json). The fixed [collection JSON](https://cdn.mons.shop/111k/collection.json) matches its canonical source. Token URLs retain their filenames as metadata is revealed.

The immutable configuration is the committed fourteen-recipient proceeds split and a lifetime cap of 500 discounted crates. Initial free allowances are empty. The current 318-wallet discount root has an allowance of one. Initial prices are 0.0001 ETH per crate, 0.0011 ETH per warehouse, and 0.00005 ETH per discounted crate. Public relic minting has zero quota and is disabled. See [configuration](configuration.json).

Catalog `111k-v8` is registered under internal ID `mainnet-v1`; the root belongs permanently to this contract. Existing deployment registry settings, including the active Sepolia storefront, were preserved. Storefront activation is outside this release.

## Verification

- The final [closed-state verification](deployment-closed.json) matches the complete runtime and mainnet EIP-712 values, constructor settings, metadata boundaries, zero issuance, and disabled minting.
- [Etherscan](etherscan-verification.json) and [Sourcify](sourcify-verification.json) match the frozen sources and deployed contract.
- [Metadata verification](metadata-verification.json) covers every token object and 17 public boundary URLs, including headers and exact bytes.
- [Reveal status](reveal-status.json) records successful scheduler provisioning with no activation or error.
- [Local validation](local-validation.json): 293 contract tests passed with four skipped; deployment, mainnet recovery, source verification, metadata bootstrap, lease, type, compiler, ABI, formatting, and dead-code checks passed.

## Recovery evidence

The private `.cache/111k-mainnet-v1-release/` directory retains the signed transaction journal, frozen compiler artifacts, generated publication, and sealed snapshot of all 344,948 original metadata objects. Resume against that same evidence. The temporary historical cache and temporary signer files were removed. The snapshot is bootstrap recovery evidence; generic restore cannot consume its smaller original inventory.

Follow the [mainnet runbook](../../scripts/docs/111k_mainnet.md) for the tooling. Future mint opening, relic reservation, pricing changes, and reveal activation require separate instructions.
