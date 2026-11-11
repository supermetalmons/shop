# Mainnet admin relic claims — 11 November 2026

Completed the approved public-RPC sequence. Deployer `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` owns **Relic 8** (token **117179**) and **Relic 18** (token **117189**) on collection `0x08cded8258730bda384ff198001e47a1b50f7f9d`. Its reserved claim allowance is 2 and lifetime usage is 2.

## Final state

| Setting | Verified value |
| --- | --- |
| Sales | Closed |
| Crate price | 0.03 ETH |
| Warehouse price | 0.3 ETH |
| Discounted crate price | 0.015 ETH |
| Owner | Original deployer, unchanged |
| Reserved relic allocation | 12 |
| Claimed relics / token supply | 2 / 2 |
| Reserved crate allocation | 1,332 |
| Claimed-ID mask | 131200 (0x20080) |
| Other collection activity during operation | None observed |
| Total gas cost | 0.000137717484676828 ETH |

All six zero-value owner transactions succeeded with at least three canonical confirmations. Prices were first set to 1,000 ETH each. After that receipt succeeded, open, claim 8, claim 18, and close were submitted back-to-back through the existing RPC and all mined in **block 26,392,216**. Original prices were restored in the next block. No emergency replacement or extra restoration transaction was required.

## Confirmed transactions

| Action | Transaction | Block |
| --- | --- | ---: |
| raise-prices | [0x92c378ea553bff707417e8e6419027f58f5f2052c5b211d8547d63f7754e72d9](https://etherscan.io/tx/0x92c378ea553bff707417e8e6419027f58f5f2052c5b211d8547d63f7754e72d9) | 26392215 |
| open-sale | [0xda081acd08fc08c156ce33646b1b10a962f68b427df3aa1b2437cedcb01a8f58](https://etherscan.io/tx/0xda081acd08fc08c156ce33646b1b10a962f68b427df3aa1b2437cedcb01a8f58) | 26392216 |
| claim-relic-8 | [0x77d344cf84eccc599e705bf7e59f7accc24f9aafdd0864b7ac9f2d038314be0d](https://etherscan.io/tx/0x77d344cf84eccc599e705bf7e59f7accc24f9aafdd0864b7ac9f2d038314be0d) | 26392216 |
| claim-relic-18 | [0x06b66f0fc34e7faba6c2e16447d46064d5ef0f0320f6aa95eb06e1e4587db2d4](https://etherscan.io/tx/0x06b66f0fc34e7faba6c2e16447d46064d5ef0f0320f6aa95eb06e1e4587db2d4) | 26392216 |
| close-sale | [0x0a4831e5f6f35aa0b2633551d85037542dd682ecd57401f13520ad91ff2c414b](https://etherscan.io/tx/0x0a4831e5f6f35aa0b2633551d85037542dd682ecd57401f13520ad91ff2c414b) | 26392216 |
| restore-prices | [0xc4ea6d8b8e7e0bf4a450271a723e708976ec863f8e6ac882fdc98ac944e31d04](https://etherscan.io/tx/0xc4ea6d8b8e7e0bf4a450271a723e708976ec863f8e6ac882fdc98ac944e31d04) | 26392217 |

## Verification and evidence

The final pinned state is recorded at block **26392219**, hash `0xaeddef7837bf298d546d72c34447411628de13a5bc389d34be73a3a85826f02b`. A separate read-only verification at block 26,392,219 confirmed both token owners, claim usage, closed sales, restored prices, and all 26 watched wallets' allowance limits.

The deployer's ownership, all existing allowance limits, discount settings, public-relic configuration, and other watched settings were preserved. No other collection event was observed between the price increase and restoration, including no other mint or claim. The 22.3 ETH already credited as mint proceeds was not modified by these zero-value calls. Opening permanently marks the sale as having started; it is currently closed.

- [Frozen operation and recovery rules](operation.json)
- [Final onchain state and receipts](verification.json)
- [Fresh-fork simulation and failure scenarios](simulation.json)
- [Artifact checksums](checksums.json)

The simulation covered normal execution, an external free mint, another wallet taking ID 8 first, and close-transaction failure recovery. Those are simulated scenarios; the real operation claimed both intended relics without other activity. Signed raw transactions remain in the private execution journal. Temporary signing files were removed after execution.
