# Mainnet free-crate allowances — 11 November 2026

Configured the approved allowances on [111k mainnet](https://etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d#readContract): **14 wallets, 62 total free-crate allowances**.

The first two mint-proceeds recipients receive 25 each; the other twelve receive one each, substituting `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE` for `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d`. The substituted-out wallet retains zero free allowances. Mint-proceeds recipients and shares were not changed.

| Wallet | Free-crate limit |
| --- | ---: |
| `0x51Ec8729331E284c4B5e8EcA8e0D184FeD18632F` | 25 |
| `0x8B573abc736c82216D738Af3024F3a45fC3b18E3` | 25 |
| `0xE938eBB66B92692Ab01F76C99cFAc1928482e7b9` | 1 |
| `0x1B591f88d9bFcF7d057DF2c5a50b59Da2cBa349f` | 1 |
| `0x07d2d89b4A6E3fdA8858Da3510b76e2219eE6969` | 1 |
| `0x603C39B3D0E0f33772d79695A4F6819FCc987113` | 1 |
| `0xa07E7932f5C981aA769A1Cf9400B5c94AdB944c4` | 1 |
| `0x2236Fb6C35f78A092F0DdA655f3b49d0e8Bf6581` | 1 |
| `0x71d0318BB33d961f323C81a7a4Ca095b549F7E6E` | 1 |
| `0xc4275E6D4109e0288cDc9b064E32F3f54bcDA61F` | 1 |
| `0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE` | 1 |
| `0x0AdF7B78c952E038d4eA4B5bF84B9d3D22C60Ce9` | 1 |
| `0xB0B4EC16bE55af47109947F0dC84C4561A020A4B` | 1 |
| `0xd9488d6687d656a55B3F1a36998d149f9b1bE2Cc` | 1 |

## Transactions

- 25-crates: [0x0e90ec7f4cb5a50f4d97965ce3d8c8a0154c3930486e8cc7bff57cafd877c745](https://etherscan.io/tx/0x0e90ec7f4cb5a50f4d97965ce3d8c8a0154c3930486e8cc7bff57cafd877c745), block 26391148.
- 1-crate: [0x2262dda256830ac0f46a27f148f40c0650bf4ffab1929bf97f403d408a931152](https://etherscan.io/tx/0x2262dda256830ac0f46a27f148f40c0650bf4ffab1929bf97f403d408a931152), block 26391152.

Both owner calls sent zero ETH to the contract and received at least three canonical confirmations. Total gas cost: 48547797221829 wei.

All limits were read back at block 26391154. Minting remains closed; relic allocation and token supply are zero. Warehouse/relic limits and usage counters remain zero; public-relic allowances are unchanged. These are mint entitlements, not minted or reserved crates.

Use [config.json](config.json) for the approved groups and [verification.json](verification.json) for the onchain results. The chain/contract scope and exact calls are recorded in [operation.json](operation.json).

The original deployment reports remain historical records of its empty initial allowances. Its strict closed-deployment verifier intentionally rejects subsequent allowance changes; use this operation’s verification for the authorized update.
