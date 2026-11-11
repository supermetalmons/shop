# Terraforms discount expansion — 11 November 2026

Updated [111k mainnet](https://etherscan.io/address/0x08cded8258730bda384ff198001e47a1b50f7f9d#readContract) to include all Terraforms holders at finalized block **26391733** (2026-11-11T12:38:47.000Z), together with every address on the previous 1,343-address list.

| Addresses | Count |
| --- | ---: |
| Previous eligible addresses | 1343 |
| Terraforms holders | 1978 |
| Already present in the previous list | 79 |
| New eligible addresses | 1899 |
| Final unique eligible addresses | 3242 |

The complete outputs are [eligible-addresses.txt](eligible-addresses.txt) and [proofs.json](proofs.json). The proofs retain the existing `{root, proofs}` JSON format. The matching mainnet application artifact is `src/ethereum/discounts/111k-mainnet.json`.

Terraforms contract: `0x4e1f41613c9084fdb9e34e11fae9412427480e56`. Every one of its **9911** tokens was enumerated using `tokenByIndex` and resolved through `ownerOf` at the same finalized block. Direct owners, including contract addresses, are retained. A second RPC provider independently checked each holder's `balanceOf`: all 1978 balances matched the token snapshot and summed to 9911. The snapshot block hash was rechecked. This is a fixed holder snapshot; subsequent transfers do not automatically change eligibility.

Merkle root: `0xdc1265497dbb3e1b01056855020a1198853740d704e2e90b5681a2ceb68fb27b`. Every proof passed both OpenZeppelin verification and the shared contract-compatible verifier; an independent rebuild produced the same root.

The only owner call was `setDiscountConfig(root, 1)`, sending zero ETH. [Confirmed transaction](https://etherscan.io/tx/0xd722b19cf2e2c66b908d52da89e1a1ce4206123c9de8110d972361c13488d97c), block **26391822**, with at least three canonical confirmations. Final state verification: block **26391824**. Gas paid: **3804459793842 wei**.

The discount remains **one crate per eligible address at 0.015 ETH**, subject to the shared **500-crate lifetime cap**. At verification, zero discounted crates had been used and sales remained closed. Regular prices, all usage counters, 62 free-crate allowances, 12 reserved relics and their claims, 1,332 reserved crate allocations, proceeds, ownership, delivery configurations, public-relic settings, and metadata were preserved. Sepolia configuration and its proof list remain unchanged. No application deployment or storefront activation was performed.

Evidence: [snapshot source](terraforms-source.json), [token ownership](terraforms-token-owners.csv), [Terraforms holders](terraforms-holders.txt), [independent balance checks](holder-balance-verification.json), [merge counts and source hashes](merge-summary.json), [Merkle tree](merkle-tree.json), [operation](operation.json), [onchain verification](verification.json), and [file checksums](checksums.json).
