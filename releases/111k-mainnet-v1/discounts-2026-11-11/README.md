# Mainnet discount list and prices — 11 November 2026

Updated [111k mainnet](https://etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d#readContract) to use exactly the **1,343 unique addresses** in [final.txt](final.txt). This replaces the previous discount list; no other addresses were appended.

| Setting | Value |
| --- | ---: |
| Regular crate | 0.03 ETH |
| Warehouse | 0.3 ETH |
| Discounted crate | 0.015 ETH |
| Discount allowance | 1 crate per eligible wallet |
| Lifetime discounted-mint cap | 500 crates total |
| Discounted crates used at verification | 0 |

Merkle root: `0x82c0c6789afcb5823edc8914fc140a7da6bb582918857b7827d2dd1d838e13a6`. Source SHA-256: `232a97258c78e26b9e86effd476ba41c009dd1219cb355f794f48f091d00049a`. All 1,343 proofs passed both OpenZeppelin verification and the shared contract-compatible verifier, including a check against the final onchain root.

The full tree is saved in [merkle-tree.json](merkle-tree.json); [proofs.json](proofs.json) uses the existing `{root, proofs}` format. These are separate mainnet artifacts. The active Sepolia proof dataset and storefront configuration were preserved; no application deployment or storefront activation was performed.

## Transactions

- prices: [0x37f378e511e31cb12403c6273450dfd1a3808f25fd1a56664f151529226286d0](https://etherscan.io/tx/0x37f378e511e31cb12403c6273450dfd1a3808f25fd1a56664f151529226286d0), block 26391200.
- discount: [0x6013f16d3644150e05c9050601410a3b04447eee891bed56fe25aa5f3ae14673](https://etherscan.io/tx/0x6013f16d3644150e05c9050601410a3b04447eee891bed56fe25aa5f3ae14673), block 26391203.

Both owner calls sent zero ETH to the contract and received at least three canonical confirmations. Total gas cost: 6042628977417 wei.

The [final verification](verification.json) at block 26391205 confirms the exact prices/root/allowance, immutable cap 500, zero discounted usage, and preservation of all 62 free-crate allowances and their usage counters. Minting remains closed, relic allocation and NFT supply remain zero, and proceeds/public-relic settings were unchanged.

The cap is shared across the full list: eligibility does not reserve supply or guarantee that all 1,343 wallets can mint at the discounted price. Free-crate allowances are independent of discount-list membership.

The original deployment reports remain historical evidence of its initial settings. The approved calls, source checksums, and preserved application configuration hashes are in [operation.json](operation.json).
