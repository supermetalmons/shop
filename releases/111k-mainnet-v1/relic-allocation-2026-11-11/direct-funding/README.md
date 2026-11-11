# Completed mainnet relic allocation — 11 November 2026

Allocated **12 relics**, reserved **1,332 crates**, and deposited **22.3 ETH** into collection `0x08cded8258730bda384ff198001e47a1b50f7f9d`. Ten buyers have one claim each; deployer/current owner `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` has two claims.

All three owner transactions succeeded with at least three canonical confirmations. Final verification was at block **26391697**, hash `0x483bff1beb8d2e4bfaa21e4774beaeb6fb46fea771272e5a04d381f7743667a6`. Total owner-transaction gas cost was **0.000048127984335256 ETH** (48127984335256 wei), within the 0.002 ETH ceiling.

## Confirmed transactions

The Safe first transferred 22.3 ETH to the deployer: [funding transaction](https://etherscan.io/tx/0x3f0565493ff503ef87359800e3f0d025190ad01f3bc87b51391212c743b3c0c8), block 26,391,672.

| Owner action | Transaction | Block |
| --- | --- | ---: |
| allocate-12-relics | [0x6030d8dd3d625cfa38dc4b470466fc2fd0d5ddd4f76dc18ed84ebb32b65300dc](https://etherscan.io/tx/0x6030d8dd3d625cfa38dc4b470466fc2fd0d5ddd4f76dc18ed84ebb32b65300dc) | 26391687 |
| grant-10-buyers | [0x52f70084d89cc2323356c2360ad4c112bf3ea10373c0ce0b7f862ea6109c19f9](https://etherscan.io/tx/0x52f70084d89cc2323356c2360ad4c112bf3ea10373c0ce0b7f862ea6109c19f9) | 26391692 |
| grant-2-deployer-relics | [0x3234ff77045950b33b3e31aedfa39fc39d409393d3f0303ed1267e39a42734c7](https://etherscan.io/tx/0x3234ff77045950b33b3e31aedfa39fc39d409393d3f0303ed1267e39a42734c7) | 26391695 |

## Confirmed claim allowances

| Wallet | Relic allowance |
| --- | ---: |
| `0x09ce5cb3313038043af9bbdf4c6b069aa4d72274` | 1 |
| `0x0c14b195dee48595368621390184d38a73d3041f` | 1 |
| `0x1d4b9b250b1bd41daa35d94bf9204ec1b0494ee3` | 1 |
| `0x2ad5c6af6c0977412beeedb7c08aa2d75c9a227e` | 1 |
| `0x57524efc73e194e4f19dc1606fb7a3e1dbf719b3` | 1 |
| `0x6f3f5ccfc70d49cf5786cb406498a952afd43826` | 1 |
| `0x8e2ad92d1986c37d4cc9618c13ae9950f4d3192b` | 1 |
| `0x906311f58e48b49c903b9dca8a905091298d6508` | 1 |
| `0xd1acbe05a739c855f2c54f42f0f1e3df662da56d` | 1 |
| `0xfc3c962fad2c1cc77f1a0d46e7b8a2de79a21774` | 1 |
| `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93` | 2 |
| **Total** | **12** |

## Result and preservation checks

The collection holds all **22.3 ETH**, credited to its immutable fourteen-recipient mint proceeds split. Payouts remain available through the existing release functions; this allocation did not distribute proceeds. [execution-verification.json](execution-verification.json) lists every recipient's releasable amount.

The deployer remains owner, pending owner is zero, sales remain closed, and token supply is zero. All fourteen previously configured wallets retain their **62 free-crate allowances**. Prices, discount configuration and usage, public-relic settings and allowances, quote signer, delivery configurations, metadata URIs, and contract runtime were verified unchanged. Relic usage is zero for all eleven recipients.

The 12-relic global reservation is permanent and cannot be repeated or increased. Allocation did not mint tokens or select IDs. Claiming requires sales to be enabled separately. The original Pre111K ledger remains the ten historical paid reservations; the deployer's two additional claims were granted directly in the final collection.

## Evidence

- [Operation and transactions](operation.json)
- [Final onchain verification](execution-verification.json)
- [Frozen execution inputs](execution-approved.json)
- [Safe funding verification](safe-transfer-status.json)
- [Original reservation/payment evidence](source-snapshot.json)
- [Pre-execution fork simulation](simulation.json)
- [Artifact SHA-256 checksums](checksums.json)

The numbered transaction JSON files are retained as execution evidence. **Do not resubmit them.** The earlier ownership-transfer route was superseded and its executable files removed from the public release directory.
